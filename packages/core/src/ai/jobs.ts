import { assertContext, AccessContext, type Database } from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
import { JobStore } from '../jobs/store.js';
import { leasePredicate } from '../jobs/lease-guard.js';
import { PromptRegistry, type PromptSnapshot } from '../registry/store.js';
import { PromptUsage, promptUseGuard } from '../registry/usage.js';
import {
  SemanticProfiles,
  semanticPrompt,
  type SemanticProfileSnapshot,
} from '../registry/semantic-profiles.js';
import { ModelRegistry } from './models.js';
import { selectPipeline } from './selector.js';
import { analysisQualityScope, compileSemanticAnalysis } from './compiler.js';
import { QuotaAdmission } from './admission.js';
import { currentGeminiBuckets } from './quota-policy.js';
import type { compileEconomy } from './compiler.js';
type CompiledContext = Awaited<
  ReturnType<typeof compileEconomy>
>['run_context'];
import type { PipelineProfile } from '../../../contracts/src/ai.js';
import type { LeaseToken } from '../../../contracts/src/jobs.js';
import { ArtifactRepository } from '../artifacts/store.js';
import type { ChunkPlan } from './long-input/plan.js';
import {
  validateAdditionalPass,
  type AdditionalPassSnapshot,
} from './tasks/additional-pass.js';
import { parseWithDeterministicRepair } from './repair/deterministic.js';
import type { normalizeTranscript } from '../transcript/normalize.js';
import { acceptedCorrectedSource } from '../transcript/corrected-authority.js';

export interface AnalysisSettings {
  runtime: 'local' | 'cloud';
  mode: 'PRODUCTION' | 'QUALITY_TEST';
  purpose: string;
  region: string;
  max_output_tokens: number;
  limits: Record<string, number>;
}
interface SourceSnapshot {
  run_id: string;
  item_id: string;
  source_artifact_id: string;
  segment_map_artifact_id: string;
  source_hash: string;
  manifest_hash: string;
  language_code: string;
  correction?: {
    original_ref: string;
    original_hash: string;
    producer_version: 'owner-source-correction:1';
  };
}
export interface AnalysisJobSnapshot {
  version: 'analysis-job:1';
  workload?: 'PROMPT_LAB';
  lab_experiment_hash?: string;
  lab_case_index?: number;
  source: SourceSnapshot;
  prompt: PromptSnapshot;
  profile: PipelineProfile;
  semantic_profile?: SemanticProfileSnapshot;
  settings: AnalysisSettings;
  quality_scope: string;
  additional_pass?: AdditionalPassSnapshot;
  replaces_pending?: {
    job_id: string;
    snapshot_hash: string;
    fencing_token: number;
    reason: string;
  };
  semantic_context?: CompiledContext['semantic_context'];
  chunk?: {
    parent_job_id: string;
    parent_snapshot_hash: string;
    plan_artifact_id: string;
    plan_hash: string;
    chunk_index: number;
  };
}
export interface ExplicitAnalysisIntent {
  nonce: string;
  semantic_profile_id: string;
  semantic_profile_revision: number;
  pass: { mode: 'SECOND_PASS' | 'VALIDATE'; candidate_run_id: string } | null;
  test_prompt?: { prompt_id: string; version: number };
  published_prompt?: { prompt_id: string; version: number };
  test_model_revision?: number;
}

// The durable job captures registry snapshots before any provider request. Workers
// receive references to source bytes, never caller-supplied account/model routing.
export class AnalysisJobs {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  private async requireSourceProcessing(itemId: string) {
    const permitted = await this.db
      .prepare(
        `SELECT 1 FROM items i JOIN sources s ON s.owner_id=i.owner_id AND s.source_id=i.source_id WHERE i.owner_id=? AND i.item_id=? AND s.ai_processing_allowed=1 AND s.access_state='PUBLIC' AND i.availability='PUBLIC'`,
      )
      .bind(this.context.ownerId, itemId)
      .first();
    if (!permitted) throw new Error('ANALYSIS_SOURCE_PROCESSING_DENIED');
  }
  private async source(runId: string): Promise<SourceSnapshot> {
    const row = await this.db
      .prepare(
        `SELECT r.item_id,r.outcome_json,r.candidate_hash FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=? AND r.run_id=? AND r.state='ACCEPTED' AND j.task_type='FETCH_TRANSCRIPT' AND j.state='SUCCEEDED'`,
      )
      .bind(this.context.ownerId, runId)
      .first<{
        item_id: string;
        outcome_json: string;
        candidate_hash: string;
      }>();
    if (!row) return acceptedCorrectedSource(this.db, this.context, runId);
    if ((await sha256(row.outcome_json)) !== row.candidate_hash)
      throw new Error('ANALYSIS_SOURCE_NOT_ACCEPTED');
    const outcome = JSON.parse(row.outcome_json) as {
      version: string;
      source_artifact_id: string;
      segment_map_artifact_id: string;
      source_hash: string;
      authority: { language_code: string; authority_confidence: string };
    };
    if (
      outcome.version !== 'transcript-source:1' ||
      outcome.authority?.authority_confidence !== 'CONFIRMED'
    )
      throw new Error('ANALYSIS_SOURCE_AUTHORITY_REQUIRED');
    const pair = await this.db
      .prepare(
        `SELECT m.content_hash AS manifest_hash FROM artifacts s JOIN artifacts m ON m.owner_id=s.owner_id AND m.item_id=s.item_id AND m.original_ref=s.artifact_id WHERE s.owner_id=? AND s.item_id=? AND s.artifact_id=? AND s.kind='SOURCE_ORIGINAL' AND s.state='VERIFIED' AND s.content_hash=? AND m.artifact_id=? AND m.kind='SEGMENT_MAP' AND m.state='VERIFIED' AND m.producer_version='source-normalizer:1'`,
      )
      .bind(
        this.context.ownerId,
        row.item_id,
        outcome.source_artifact_id,
        outcome.source_hash,
        outcome.segment_map_artifact_id,
      )
      .first<{ manifest_hash: string }>();
    if (!pair) throw new Error('ANALYSIS_SOURCE_ARTIFACT_MISMATCH');
    return {
      run_id: runId,
      item_id: row.item_id,
      source_artifact_id: outcome.source_artifact_id,
      segment_map_artifact_id: outcome.segment_map_artifact_id,
      source_hash: outcome.source_hash,
      manifest_hash: pair.manifest_hash,
      language_code: outcome.authority.language_code,
    };
  }
  async sourceForOwner(runId: string) {
    this.context.requireOwner();
    const source = await this.source(runId);
    await this.requireSourceProcessing(source.item_id);
    return source;
  }
  private async buildSnapshot(
    sourceRunId: string,
    settings: AnalysisSettings,
    now: Date,
    intent?: ExplicitAnalysisIntent,
    automatic = false,
  ) {
    if (automatic) {
      this.context.requireTask('ANALYZE');
      if (intent || settings.mode !== 'PRODUCTION')
        throw new Error('FORBIDDEN');
    } else this.context.requireOwner();
    if (
      !['local', 'cloud'].includes(settings.runtime) ||
      !['PRODUCTION', 'QUALITY_TEST'].includes(settings.mode) ||
      !settings.purpose ||
      !settings.region ||
      !Number.isSafeInteger(settings.max_output_tokens) ||
      settings.max_output_tokens < 1 ||
      !settings.limits ||
      typeof settings.limits !== 'object' ||
      Array.isArray(settings.limits) ||
      Object.keys(settings.limits).length > 64 ||
      Object.values(settings.limits).some(
        (v) => !Number.isSafeInteger(v) || v < 0,
      )
    )
      throw new Error('INVALID_ANALYSIS_SETTINGS');
    const source = await this.source(sourceRunId);
    if (source.correction && !intent)
      throw new Error('EXPLICIT_CORRECTED_SOURCE_REQUIRED');
    await this.requireSourceProcessing(source.item_id);
    const profiles = new SemanticProfiles(this.db, this.context);
    if (
      intent &&
      (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        intent.nonce,
      ) ||
        !Number.isSafeInteger(intent.semantic_profile_revision) ||
        intent.semantic_profile_revision < 1)
    )
      throw new Error('INVALID_EXPLICIT_ANALYSIS');
    const semanticProfile = intent
      ? await profiles.load(
          intent.semantic_profile_id,
          intent.semantic_profile_revision,
        )
      : await profiles.forItem(source.item_id, now);
    if (intent && !semanticProfile) throw new Error('NOT_FOUND');
    const registry = new PromptRegistry(this.db, this.context);
    let prompt: PromptSnapshot;
    if (intent?.published_prompt) {
      if (
        settings.mode !== 'PRODUCTION' ||
        !semanticProfile ||
        intent.pass ||
        intent.test_prompt
      )
        throw new Error('INVALID_PROMPT_APPLICATION');
      prompt = semanticPrompt(
        semanticProfile,
        await registry.load(
          intent.published_prompt.prompt_id,
          intent.published_prompt.version,
          0,
        ),
      );
    } else if (intent?.test_prompt) {
      if (settings.mode !== 'QUALITY_TEST' || !semanticProfile || intent.pass)
        throw new Error('INVALID_PROMPT_TEST');
      prompt = semanticPrompt(
        semanticProfile,
        await registry.load(
          intent.test_prompt.prompt_id,
          intent.test_prompt.version,
          0,
          'QUALITY_TEST',
        ),
      );
    } else if (semanticProfile) {
      try {
        prompt = semanticPrompt(
          semanticProfile,
          await registry.currentFamily(semanticProfile.compiled.prompt.id),
        );
      } catch (error) {
        // A quality experiment may intentionally target the immutable draft
        // stored in its chosen semantic profile. Production requires publication.
        if (
          settings.mode !== 'QUALITY_TEST' ||
          !(error instanceof Error) ||
          error.message !== 'PROMPT_NOT_CONFIGURED'
        )
          throw error;
        prompt = semanticPrompt(semanticProfile);
      }
    } else prompt = await registry.current();
    await new PromptUsage(this.db, this.context).requireNewUse(
      prompt.prompt_id,
      prompt.version,
    );
    if (
      semanticProfile &&
      (semanticProfile.compiled.config.translation !== 'NONE' ||
        semanticProfile.compiled.config.history ||
        (!intent && semanticProfile.compiled.config.second_pass) ||
        (!intent && semanticProfile.compiled.config.validation_pass) ||
        semanticProfile.compiled.wire.hash !== prompt.wire.hash)
    )
      throw new Error('CAPABILITY_NOT_AVAILABLE');
    const models = new ModelRegistry(this.db, this.context);
    if (
      intent?.test_model_revision !== undefined &&
      ((settings.mode !== 'QUALITY_TEST' && !intent.published_prompt) ||
        !Number.isSafeInteger(intent.test_model_revision) ||
        intent.test_model_revision < 1)
    )
      throw new Error('INVALID_PROMPT_TEST');
    const profile =
      intent?.test_model_revision === undefined
        ? await models.latest('gemini_free')
        : await models.load('gemini_free', intent.test_model_revision);
    if (!profile) throw new Error('MODEL_NOT_CONFIGURED');
    const normalized = {
      ...settings,
      limits: Object.fromEntries(
        Object.entries(settings.limits).sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
    const additionalPass =
      intent?.pass && semanticProfile
        ? await this.additionalPass(source, semanticProfile, intent.pass)
        : undefined;
    const scope = await analysisQualityScope(prompt, profile, {
      limits: normalized.limits,
      max_output_tokens: settings.max_output_tokens,
      source_language: source.language_code,
      analysis_mode: 'ORDINARY',
      ...(source.correction
        ? { source_role: 'CORRECTED_SOURCE' as const }
        : {}),
      ...(additionalPass
        ? {
            additional_pass: {
              mode: additionalPass.mode,
              purpose: additionalPass.purpose,
            },
          }
        : {}),
    });
    const selected = selectPipeline([profile], {
      profile_id: 'gemini_free',
      purpose: settings.purpose,
      region: settings.region,
      task_type: semanticProfile?.compiled.config.mode ?? 'ECONOMY',
      runtime: settings.runtime,
      mode: settings.mode,
      quality_scope: scope,
      input_tokens: 0,
      output_tokens: settings.max_output_tokens,
      now,
      paid_services_enabled: false,
    });
    if (!selected.profile)
      throw new Error('ANALYSIS_PROFILE_' + selected.reason);
    const snapshot: AnalysisJobSnapshot = {
      version: 'analysis-job:1',
      source,
      prompt,
      profile: selected.profile,
      ...(semanticProfile ? { semantic_profile: semanticProfile } : {}),
      settings: normalized,
      quality_scope: scope,
      ...(additionalPass ? { additional_pass: additionalPass } : {}),
      semantic_context: await this.semanticContext(source),
    };
    return snapshot;
  }
  async enqueue(
    sourceRunId: string,
    settings: AnalysisSettings,
    now: Date,
    intent?: ExplicitAnalysisIntent,
  ) {
    this.context.requireOwner();
    const snapshot = await this.buildSnapshot(
      sourceRunId,
      settings,
      now,
      intent,
    );
    return this.queueSnapshot(snapshot, intent?.nonce ?? '', now);
  }
  /** Scoped preparation only: no source bytes or provider request are sent here. */
  async enqueueAutomatic(
    sourceRunId: string,
    settings: AnalysisSettings,
    now: Date,
  ) {
    this.context.requireTask('ANALYZE');
    (
      await AccessContext.worker(this.db, this.context.credentialHash!)
    ).requireTask('ANALYZE');
    if (settings.mode !== 'PRODUCTION') throw new Error('FORBIDDEN');
    const source = await this.db
      .prepare(
        `SELECT j.arrival_origin_at,j.origin_kind FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=? AND r.run_id=? AND r.state='ACCEPTED' AND j.task_type='FETCH_TRANSCRIPT' AND j.state='SUCCEEDED'`,
      )
      .bind(this.context.ownerId, sourceRunId)
      .first<{
        arrival_origin_at: string;
        origin_kind: 'NEW' | 'BACKFILL' | 'MANUAL' | 'INTEGRITY';
      }>();
    if (!source) throw new Error('ANALYSIS_SOURCE_NOT_ACCEPTED');
    const configId = 'automatic-analysis:' + sourceRunId;
    const frozen = await this.db
      .prepare(
        `SELECT payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1`,
      )
      .bind(this.context.ownerId, configId)
      .first<{ payload_json: string; content_hash: string }>();
    let snapshot: AnalysisJobSnapshot;
    if (frozen) {
      if ((await sha256(frozen.payload_json)) !== frozen.content_hash)
        throw new Error('AUTOMATIC_SNAPSHOT_HASH_MISMATCH');
      snapshot = JSON.parse(frozen.payload_json) as AnalysisJobSnapshot;
      if (
        snapshot.version !== 'analysis-job:1' ||
        snapshot.source.run_id !== sourceRunId ||
        snapshot.settings.mode !== 'PRODUCTION' ||
        snapshot.additional_pass ||
        snapshot.source.correction
      )
        throw new Error('INVALID_AUTOMATIC_SNAPSHOT');
    } else
      snapshot = await this.buildSnapshot(
        sourceRunId,
        settings,
        now,
        undefined,
        true,
      );
    await this.requireSourceProcessing(snapshot.source.item_id);
    const job = await this.queueSnapshot(snapshot, '', now, {
      configId,
      ...source,
    });
    (
      await AccessContext.worker(this.db, this.context.credentialHash!)
    ).requireTask('ANALYZE');
    return job;
  }
  async scheduleAutomatic(
    now: Date,
    after: { accepted_at: string; run_id: string } | null = null,
  ) {
    this.context.requireTask('ANALYZE');
    (
      await AccessContext.worker(this.db, this.context.credentialHash!)
    ).requireTask('ANALYZE');
    if (
      after &&
      (!Number.isFinite(Date.parse(after.accepted_at)) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(after.run_id))
    )
      throw new Error('INVALID_AUTOMATIC_CURSOR');
    const rows = (
      await this.db
        .prepare(
          `SELECT r.run_id,r.accepted_at FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id JOIN items i ON i.owner_id=r.owner_id AND i.item_id=r.item_id JOIN sources s ON s.owner_id=i.owner_id AND s.source_id=i.source_id WHERE r.owner_id=? AND r.state='ACCEPTED' AND j.task_type='FETCH_TRANSCRIPT' AND j.state='SUCCEEDED' AND s.ai_processing_allowed=1 AND s.access_state='PUBLIC' AND i.availability='PUBLIC' AND json_extract(r.outcome_json,'$.authority.authority_confidence')='CONFIRMED' AND (r.accepted_at>? OR (r.accepted_at=? AND r.run_id>?)) AND NOT EXISTS(SELECT 1 FROM jobs a WHERE a.owner_id=r.owner_id AND a.task_type='ANALYZE' AND json_extract(a.payload_json,'$.snapshot.source.run_id')=r.run_id AND json_extract(a.payload_json,'$.snapshot.settings.mode')='PRODUCTION') ORDER BY r.accepted_at,r.run_id LIMIT 1`,
        )
        .bind(
          this.context.ownerId,
          after?.accepted_at ?? '',
          after?.accepted_at ?? '',
          after?.run_id ?? '',
        )
        .all<{ run_id: string; accepted_at: string }>()
    ).results;
    const model = await new ModelRegistry(this.db, this.context).latest(
      'gemini_free',
    );
    let created = 0;
    const deferred: string[] = [];
    for (const row of rows) {
      if (!model) {
        deferred.push('MODEL_NOT_CONFIGURED');
        continue;
      }
      try {
        await this.enqueueAutomatic(
          row.run_id,
          {
            runtime: 'local',
            mode: 'PRODUCTION',
            purpose: model.purposes[0] ?? '',
            region: model.regions[0] ?? '',
            max_output_tokens: Math.min(4000, model.output_tokens),
            limits: { claims: 40 },
          },
          now,
        );
        created++;
      } catch (error) {
        const reason = error instanceof Error ? error.message : '';
        if (
          !/^(ANALYSIS_PROFILE_[A-Z_]+|MODEL_NOT_CONFIGURED|PROMPT_NOT_CONFIGURED|PROMPT_DEPRECATED|CAPABILITY_NOT_AVAILABLE|ANALYSIS_SOURCE_PROCESSING_DENIED|AUTOMATIC_ANALYSIS_ALREADY_PLANNED_OR_REVOKED)$/.test(
            reason,
          )
        )
          throw error;
        deferred.push(reason);
      }
    }
    const last = rows.at(-1);
    return {
      created,
      deferred,
      next_cursor: last
        ? { accepted_at: last.accepted_at, run_id: last.run_id }
        : null,
      provider_requests: 0 as const,
    };
  }
  async previewExplicit(
    sourceRunId: string,
    settings: AnalysisSettings,
    intent: Omit<ExplicitAnalysisIntent, 'nonce'>,
    now: Date,
    replacement?: AnalysisJobSnapshot['replaces_pending'],
  ) {
    const snapshot = await this.buildSnapshot(sourceRunId, settings, now, {
      ...intent,
      nonce: crypto.randomUUID(),
    });
    if (replacement) snapshot.replaces_pending = replacement;
    const repo = new ArtifactRepository(this.db, this.context),
      original = await repo.readVerifiedText(
        snapshot.source.source_artifact_id,
        32 * 1024 * 1024,
      ),
      map = await repo.readVerifiedText(
        snapshot.source.segment_map_artifact_id,
        32 * 1024 * 1024,
      );
    if (
      original.artifact.content_hash !== snapshot.source.source_hash ||
      map.artifact.content_hash !== snapshot.source.manifest_hash
    )
      throw new Error('ANALYSIS_SOURCE_ARTIFACT_MISMATCH');
    const compiled = await compileSemanticAnalysis({
      source_artifact_id: snapshot.source.source_artifact_id,
      source_text: original.text,
      ...(snapshot.source.correction
        ? { source_role: 'CORRECTED_SOURCE' as const }
        : {}),
      manifest: JSON.parse(map.text) as Awaited<
        ReturnType<typeof normalizeTranscript>
      >['manifest'],
      manifest_hash: snapshot.source.manifest_hash,
      prompt: snapshot.prompt,
      profile: snapshot.profile,
      profile_revision: await sha256(JSON.stringify(snapshot)),
      semantic_context: snapshot.semantic_context!,
      runtime: settings.runtime,
      request_id: 'preview',
      deadline: new Date(now.getTime() + 300000).toISOString(),
      mode: settings.mode,
      max_output_tokens: settings.max_output_tokens,
      limits: settings.limits,
      semantic_profile: snapshot.semantic_profile!.compiled,
      ...(snapshot.additional_pass
        ? { additional_pass: snapshot.additional_pass }
        : {}),
    });
    if (compiled.request.quality_scope !== snapshot.quality_scope)
      throw new Error('ANALYSIS_QUALITY_SCOPE_MISMATCH');
    const value = {
        version: 'explicit-analysis-preview:1',
        prepared_at: now.toISOString(),
        snapshot,
      },
      serialized = JSON.stringify(value),
      hash = await sha256(serialized);
    await this.db
      .prepare(
        'INSERT INTO config_versions(config_id,owner_id,revision,payload_json,content_hash,created_at) VALUES(?,?,1,?,?,?) ON CONFLICT DO NOTHING',
      )
      .bind(
        'analysis-preview-' + hash,
        this.context.ownerId,
        serialized,
        hash,
        now.toISOString(),
      )
      .run();
    return {
      preview_hash: hash,
      item_id: snapshot.source.item_id,
      source_hash: snapshot.source.source_hash,
      prompt_id: snapshot.prompt.prompt_id,
      prompt_version: snapshot.prompt.version,
      prompt_hash: snapshot.prompt.prompt_hash,
      model_revision: snapshot.profile.revision,
      wire_schema_id: snapshot.prompt.wire.id,
      wire_schema_hash: snapshot.prompt.wire.hash,
      quality_scope: snapshot.quality_scope,
      semantic_profile_id: snapshot.semantic_profile!.profile_id,
      semantic_profile_revision: snapshot.semantic_profile!.revision,
      pass: snapshot.additional_pass?.mode ?? 'REPROCESS',
      candidate_run_id: snapshot.additional_pass?.candidate_run_id ?? null,
      replaces_job_id: snapshot.replaces_pending?.job_id ?? null,
      token_estimate: compiled.run_context.token_estimate,
      quota_status: 'UNKNOWN' as const,
      quota_remaining: null,
      additional_model_requests: 1,
      selection_effect: 'NONE_UNTIL_EXPLICIT_SELECTION' as const,
    };
  }
  async previewReplacement(
    jobId: string,
    profileId: string,
    revision: number,
    reason: string,
    now: Date,
  ) {
    this.context.requireOwner();
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000)
      throw new Error('INVALID_REPLACEMENT_REASON');
    const row = await this.db
      .prepare(
        "SELECT payload_json,profile_revision,fencing_token FROM jobs j WHERE owner_id=? AND job_id=? AND task_type='ANALYZE' AND state IN ('PENDING','DEFERRED','RETRY_WAIT') AND lease_owner IS NULL AND NOT EXISTS(SELECT 1 FROM job_attempts a WHERE a.owner_id=j.owner_id AND a.job_id=j.job_id)",
      )
      .bind(this.context.ownerId, jobId)
      .first<{
        payload_json: string;
        profile_revision: string;
        fencing_token: number;
      }>();
    if (!row) throw new Error('PENDING_JOB_NOT_REPLACEABLE');
    const snapshot = (
      JSON.parse(row.payload_json) as { snapshot: AnalysisJobSnapshot }
    ).snapshot;
    if ((await sha256(JSON.stringify(snapshot))) !== row.profile_revision)
      throw new Error('ANALYSIS_SNAPSHOT_HASH_MISMATCH');
    if (snapshot.chunk || snapshot.additional_pass)
      throw new Error('PENDING_JOB_NOT_REPLACEABLE');
    return this.previewExplicit(
      snapshot.source.run_id,
      snapshot.settings,
      {
        semantic_profile_id: profileId,
        semantic_profile_revision: revision,
        pass: null,
      },
      now,
      {
        job_id: jobId,
        snapshot_hash: row.profile_revision,
        fencing_token: row.fencing_token,
        reason: reason.trim(),
      },
    );
  }
  async confirmExplicit(previewHash: string, nonce: string, now: Date) {
    this.context.requireOwner();
    if (
      !/^[0-9a-f]{64}$/.test(previewHash) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        nonce,
      )
    )
      throw new Error('INVALID_EXPLICIT_ANALYSIS');
    const receipt = await this.db
      .prepare(
        'SELECT payload_json,content_hash,created_at FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
      )
      .bind(this.context.ownerId, 'analysis-preview-' + previewHash)
      .first<{
        payload_json: string;
        content_hash: string;
        created_at: string;
      }>();
    if (
      !receipt ||
      receipt.content_hash !== previewHash ||
      (await sha256(receipt.payload_json)) !== previewHash ||
      Date.parse(receipt.created_at) > now.getTime() ||
      now.getTime() - Date.parse(receipt.created_at) > 900000
    )
      throw new Error('READ_SNAPSHOT_CHANGED');
    const value = JSON.parse(receipt.payload_json) as {
        version: string;
        prepared_at: string;
        snapshot: AnalysisJobSnapshot;
      },
      snapshot = value.snapshot;
    if (
      value.version !== 'explicit-analysis-preview:1' ||
      value.prepared_at !== receipt.created_at ||
      !snapshot.semantic_profile
    )
      throw new Error('READ_SNAPSHOT_CHANGED');
    const source = await this.sourceForOwner(snapshot.source.run_id),
      profile = await new ModelRegistry(this.db, this.context).load(
        snapshot.profile.profile_id,
        snapshot.profile.revision,
      ),
      semantic = await new SemanticProfiles(this.db, this.context).load(
        snapshot.semantic_profile.profile_id,
        snapshot.semantic_profile.revision,
      );
    if (
      JSON.stringify(source) !== JSON.stringify(snapshot.source) ||
      JSON.stringify(profile) !== JSON.stringify(snapshot.profile) ||
      JSON.stringify(semantic) !== JSON.stringify(snapshot.semantic_profile)
    )
      throw new Error('READ_SNAPSHOT_CHANGED');
    if (
      snapshot.additional_pass &&
      JSON.stringify(
        await this.additionalPass(
          source,
          snapshot.semantic_profile,
          snapshot.additional_pass,
        ),
      ) !== JSON.stringify(snapshot.additional_pass)
    )
      throw new Error('READ_SNAPSHOT_CHANGED');
    const selected = selectPipeline([snapshot.profile], {
      profile_id: 'gemini_free',
      purpose: snapshot.settings.purpose,
      region: snapshot.settings.region,
      task_type: snapshot.semantic_profile.compiled.config.mode,
      runtime: snapshot.settings.runtime,
      mode: snapshot.settings.mode,
      quality_scope: snapshot.quality_scope,
      input_tokens: 0,
      output_tokens: snapshot.settings.max_output_tokens,
      now,
      paid_services_enabled: false,
    });
    if (!selected.profile)
      throw new Error('ANALYSIS_PROFILE_' + selected.reason);
    return this.queueSnapshot(snapshot, nonce, now);
  }
  private async queueSnapshot(
    snapshot: AnalysisJobSnapshot,
    nonce: string,
    now: Date,
    automatic?: {
      configId: string;
      arrival_origin_at: string;
      origin_kind: 'NEW' | 'BACKFILL' | 'MANUAL' | 'INTEGRITY';
    },
  ) {
    if (automatic) {
      this.context.requireTask('ANALYZE');
      if (
        nonce ||
        snapshot.settings.mode !== 'PRODUCTION' ||
        snapshot.replaces_pending ||
        snapshot.additional_pass ||
        snapshot.source.correction
      )
        throw new Error('FORBIDDEN');
    } else this.context.requireOwner();
    const {
      source,
      prompt,
      settings,
      additional_pass: additionalPass,
    } = snapshot;
    const hash = await sha256(JSON.stringify(snapshot));
    if (nonce) {
      await this.db
        .prepare(
          'INSERT INTO config_versions(config_id,owner_id,revision,payload_json,content_hash,created_at) VALUES(?,?,1,?,?,?) ON CONFLICT DO NOTHING',
        )
        .bind(
          'explicit-analysis-' + nonce,
          this.context.ownerId,
          JSON.stringify(snapshot),
          hash,
          now.toISOString(),
        )
        .run();
      const prior = await this.db
        .prepare(
          'SELECT content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
        )
        .bind(this.context.ownerId, 'explicit-analysis-' + nonce)
        .first<{ content_hash: string }>();
      if (prior?.content_hash !== hash) throw new Error('IDEMPOTENCY_CONFLICT');
    }
    const input = {
      item_id: source.item_id,
      source_id: null,
      task_type: 'ANALYZE' as const,
      input_revision: source.source_hash,
      profile_revision: hash,
      prompt_snapshot_id: prompt.prompt_hash,
      routing_policy_version: 'pipeline-selector:1',
      wire_schema_version: prompt.wire.id.replace('urn:bartosz:schema:', ''),
      canonical_schema_version: 'intelligence-canonical:1.2',
      enrichment_version: '1.0',
      explicit_run_nonce: nonce,
      arrival_origin_at: automatic?.arrival_origin_at ?? now.toISOString(),
      origin_kind: automatic?.origin_kind ?? ('MANUAL' as const),
      payload: { snapshot },
      priority: settings.mode === 'QUALITY_TEST' || additionalPass ? 20 : 60,
      due_at: now.toISOString(),
    };
    const store = new JobStore(this.db, this.context);
    let job;
    if (automatic) {
      const worker = {
        predicate:
          "EXISTS(SELECT 1 FROM worker_identities WHERE owner_id=? AND worker_id=? AND credential_hash=? AND revoked_at IS NULL) AND EXISTS(SELECT 1 FROM items i JOIN sources s ON s.owner_id=i.owner_id AND s.source_id=i.source_id WHERE i.owner_id=? AND i.item_id=? AND s.ai_processing_allowed=1 AND s.access_state='PUBLIC' AND i.availability='PUBLIC')",
        bindings: [
          this.context.ownerId,
          this.context.actorId,
          this.context.credentialHash!,
          this.context.ownerId,
          source.item_id,
        ],
      };
      const usage = promptUseGuard(
        this.context.ownerId,
        prompt.prompt_id,
        prompt.version,
      );
      const guard = {
        predicate:
          worker.predicate +
          ' AND ' +
          usage.predicate +
          ' AND EXISTS(SELECT 1 FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1 AND content_hash=?)',
        bindings: [
          ...worker.bindings,
          ...usage.bindings,
          this.context.ownerId,
          automatic.configId,
          hash,
        ],
      };
      const prepared = await store.prepareEnqueue(
        input,
        now.toISOString(),
        guard,
      );
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO config_versions(config_id,owner_id,revision,payload_json,content_hash,created_at) SELECT ?,?,1,?,?,? WHERE ${worker.predicate} AND ${usage.predicate} AND NOT EXISTS(SELECT 1 FROM jobs WHERE owner_id=? AND task_type='ANALYZE' AND json_extract(payload_json,'$.snapshot.source.run_id')=? AND json_extract(payload_json,'$.snapshot.settings.mode')='PRODUCTION') ON CONFLICT DO NOTHING`,
          )
          .bind(
            automatic.configId,
            this.context.ownerId,
            JSON.stringify(snapshot),
            hash,
            now.toISOString(),
            ...worker.bindings,
            ...usage.bindings,
            this.context.ownerId,
            source.run_id,
          ),
        ...prepared.statements,
      ]);
      job = await this.db
        .prepare('SELECT * FROM jobs WHERE owner_id=? AND dedup_key=?')
        .bind(this.context.ownerId, prepared.dedup_key)
        .first<import('../../../contracts/src/jobs.js').JobRecord>();
      if (!job)
        throw new Error('AUTOMATIC_ANALYSIS_ALREADY_PLANNED_OR_REVOKED');
    } else if (!snapshot.replaces_pending)
      job = await store.enqueue(
        input,
        now.toISOString(),
        promptUseGuard(this.context.ownerId, prompt.prompt_id, prompt.version),
      );
    else {
      const replacement = snapshot.replaces_pending;
      if (!nonce || snapshot.chunk || snapshot.additional_pass)
        throw new Error('PENDING_JOB_NOT_REPLACEABLE');
      const guard = {
        predicate:
          "EXISTS(SELECT 1 FROM jobs old WHERE old.owner_id=? AND old.job_id=? AND old.task_type='ANALYZE' AND old.state IN ('PENDING','DEFERRED','RETRY_WAIT') AND old.lease_owner IS NULL AND old.profile_revision=? AND old.fencing_token=? AND NOT EXISTS(SELECT 1 FROM job_attempts a WHERE a.owner_id=old.owner_id AND a.job_id=old.job_id))",
        bindings: [
          this.context.ownerId,
          replacement.job_id,
          replacement.snapshot_hash,
          replacement.fencing_token,
        ],
      };
      const usage = promptUseGuard(
        this.context.ownerId,
        prompt.prompt_id,
        prompt.version,
      );
      guard.predicate += ' AND ' + usage.predicate;
      guard.bindings.push(...usage.bindings);
      const prepared = await store.prepareEnqueue(
        input,
        now.toISOString(),
        guard,
      );
      job = await this.db
        .prepare('SELECT * FROM jobs WHERE owner_id=? AND dedup_key=?')
        .bind(this.context.ownerId, prepared.dedup_key)
        .first<import('../../../contracts/src/jobs.js').JobRecord>();
      if (!job) {
        await this.db.batch([
          ...prepared.statements,
          this.db
            .prepare(
              `INSERT INTO audit_events(event_id,owner_id,actor_id,event_type,target_id,correlation_id,created_at) SELECT ?,?,?,'PENDING_ANALYSIS_REPLACED',?,?,? WHERE ${guard.predicate} AND EXISTS(SELECT 1 FROM jobs newer WHERE newer.owner_id=? AND newer.dedup_key=?) ON CONFLICT DO NOTHING`,
            )
            .bind(
              nonce,
              this.context.ownerId,
              this.context.actorId,
              replacement.job_id,
              prepared.dedup_key,
              now.toISOString(),
              ...guard.bindings,
              this.context.ownerId,
              prepared.dedup_key,
            ),
          this.db
            .prepare(
              `UPDATE jobs SET state='FAILED',reason_code='PROFILE_SUPERSEDED',fencing_token=fencing_token+1,updated_at=? WHERE owner_id=? AND job_id=? AND ${guard.predicate} AND EXISTS(SELECT 1 FROM jobs newer WHERE newer.owner_id=? AND newer.dedup_key=? AND newer.state='PENDING')`,
            )
            .bind(
              now.toISOString(),
              this.context.ownerId,
              replacement.job_id,
              ...guard.bindings,
              this.context.ownerId,
              prepared.dedup_key,
            ),
        ]);
        job = await this.db
          .prepare('SELECT * FROM jobs WHERE owner_id=? AND dedup_key=?')
          .bind(this.context.ownerId, prepared.dedup_key)
          .first<import('../../../contracts/src/jobs.js').JobRecord>();
        if (!job) throw new Error('PENDING_JOB_CHANGED');
      }
    }
    if (!job) {
      await new PromptUsage(this.db, this.context).requireNewUse(
        prompt.prompt_id,
        prompt.version,
      );
      throw new Error('NOT_FOUND');
    }
    return job;
  }
  private async additionalPass(
    source: SourceSnapshot,
    semantic: SemanticProfileSnapshot,
    input: NonNullable<ExplicitAnalysisIntent['pass']>,
  ) {
    if (!['SECOND_PASS', 'VALIDATE'].includes(input.mode))
      throw new Error('INVALID_ADDITIONAL_PASS');
    const row = await this.db
      .prepare(
        "SELECT r.outcome_json,r.candidate_hash,json_extract(r.prompt_snapshot_json,'$.wire.hash') AS candidate_wire_hash FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=? AND r.run_id=? AND r.item_id=? AND r.state='ACCEPTED' AND j.task_type='ANALYZE' AND json_extract(r.input_snapshot_json,'$.source_artifact_id')=? AND json_extract(r.input_snapshot_json,'$.manifest_hash')=?",
      )
      .bind(
        this.context.ownerId,
        input.candidate_run_id,
        source.item_id,
        source.source_artifact_id,
        source.manifest_hash,
      )
      .first<{
        outcome_json: string;
        candidate_hash: string;
        candidate_wire_hash: string;
      }>();
    if (!row || (await sha256(row.outcome_json)) !== row.candidate_hash)
      throw new Error('ADDITIONAL_PASS_CANDIDATE_MISMATCH');
    const outcome = JSON.parse(row.outcome_json) as {
      version: string;
      response_artifact_id?: string;
      kind?: string;
      merged_wire_artifact_id?: string;
      merged_wire_hash?: string;
      context_hash?: string;
    };
    const candidateArtifactId =
      outcome.kind === 'CHUNK_MERGE'
        ? outcome.merged_wire_artifact_id
        : outcome.response_artifact_id;
    if (
      outcome.kind !== 'CHUNK_MERGE' &&
      row.candidate_wire_hash !== semantic.compiled.wire.hash
    )
      throw new Error('ADDITIONAL_PASS_CANDIDATE_MISMATCH');
    if (outcome.version !== 'intelligence-accepted:1' || !candidateArtifactId)
      throw new Error('ADDITIONAL_PASS_CANDIDATE_MISMATCH');
    const repo = new ArtifactRepository(this.db, this.context),
      raw = await repo.readVerifiedText(candidateArtifactId, 2 * 1024 * 1024),
      manifest = await repo.readVerifiedText(
        source.segment_map_artifact_id,
        32 * 1024 * 1024,
      );
    if (
      raw.artifact.item_id !== source.item_id ||
      raw.artifact.kind !== 'ANALYSIS_CANDIDATE' ||
      manifest.artifact.content_hash !== source.manifest_hash
    )
      throw new Error('ADDITIONAL_PASS_CANDIDATE_MISMATCH');
    if (outcome.kind === 'CHUNK_MERGE') {
      const provenance = JSON.parse(raw.artifact.provenance_json) as {
        context_hash?: string;
        source_hash?: string;
        wire_schema_hash?: string;
      };
      if (
        raw.artifact.content_hash !== outcome.merged_wire_hash ||
        raw.artifact.schema_version !== 'semantic-wire-merge:1' ||
        raw.artifact.producer_version !==
          'core-chunk-wire:1:' + input.candidate_run_id ||
        raw.artifact.original_ref !== source.source_artifact_id ||
        provenance.context_hash !== outcome.context_hash ||
        provenance.source_hash !== source.source_hash ||
        provenance.wire_schema_hash !== row.candidate_wire_hash
      )
        throw new Error('ADDITIONAL_PASS_CANDIDATE_MISMATCH');
    }
    const parsed = await parseWithDeterministicRepair(raw.text),
      value = parsed.value as Record<string, unknown>;
    const purpose =
      input.mode === 'SECOND_PASS'
        ? semantic.compiled.config.second_pass?.purpose
        : semantic.compiled.config.validation_pass?.purpose;
    if (!purpose) throw new Error('ADDITIONAL_PASS_PURPOSE_MISMATCH');
    const pass: AdditionalPassSnapshot = {
      mode: input.mode,
      purpose,
      candidate_run_id: input.candidate_run_id,
      candidate_hash: await sha256(JSON.stringify(value)),
      candidate_wire: value,
    };
    const map = JSON.parse(manifest.text) as Awaited<
      ReturnType<typeof normalizeTranscript>
    >['manifest'];
    return validateAdditionalPass(
      pass,
      semantic.compiled,
      new Set(map.anchors.map((a) => a.alias)),
    );
  }
  private async semanticContext(source: SourceSnapshot) {
    const row = await this.db
      .prepare(
        'SELECT r.metadata_json,r.metadata_hash,c.title AS author FROM items i LEFT JOIN item_revisions r ON r.owner_id=i.owner_id AND r.item_id=i.item_id AND r.revision_id=i.current_revision_id LEFT JOIN channels c ON c.owner_id=i.owner_id AND c.source_id=i.source_id WHERE i.owner_id=? AND i.item_id=?',
      )
      .bind(this.context.ownerId, source.item_id)
      .first<{
        metadata_json: string | null;
        metadata_hash: string | null;
        author: string | null;
      }>();
    if (!row) throw new Error('NOT_FOUND');
    if (
      row.metadata_json &&
      (await sha256(row.metadata_json)) !== row.metadata_hash
    )
      throw new Error('ANALYSIS_METADATA_HASH_MISMATCH');
    const metadata = row.metadata_json
      ? (JSON.parse(row.metadata_json) as {
          title: string;
          published_at: string | null;
        })
      : null;
    return {
      title: metadata?.title ?? null,
      author: row.author,
      published_at: metadata?.published_at ?? null,
      source_language: source.language_code,
    };
  }
  async bindContext(
    token: LeaseToken,
    context: CompiledContext,
    contextHash: string,
    promptHash: string,
    now: Date,
  ) {
    const prepared = await this.prepareRun(token, now),
      snapshot = prepared.snapshot;
    if (
      !context ||
      typeof context !== 'object' ||
      Array.isArray(context) ||
      !context.token_estimate ||
      !Number.isSafeInteger(context.token_estimate.input) ||
      context.token_estimate.input < 1 ||
      context.token_estimate.input + snapshot.settings.max_output_tokens >
        snapshot.profile.context_tokens ||
      !/^[a-f0-9]{64}$/.test(promptHash)
    )
      throw new Error('INVALID_AI_CONTEXT');
    let chunk: CompiledContext['chunk'] = null;
    if (snapshot.chunk) {
      const stored = await new ArtifactRepository(
        this.db,
        this.context,
      ).readVerifiedText(
        snapshot.chunk.plan_artifact_id,
        32 * 1024 * 1024,
        token,
        'ANALYZE',
        now,
      );
      if (stored.artifact.content_hash !== snapshot.chunk.plan_hash)
        throw new Error('CHUNK_PLAN_MISMATCH');
      const part = (JSON.parse(stored.text) as ChunkPlan).chunks[
        snapshot.chunk.chunk_index
      ];
      if (!part) throw new Error('CHUNK_PLAN_MISMATCH');
      chunk = {
        plan_hash: snapshot.chunk.plan_hash,
        chunk_index: snapshot.chunk.chunk_index,
        assigned_aliases: part.aliases,
        primary_segment_ids: part.primary_segment_ids,
      };
    }
    const expected: CompiledContext = {
      ...(snapshot.additional_pass
        ? { additional_pass: snapshot.additional_pass }
        : {}),
      semantic_context: snapshot.semantic_context ?? {
        title: null,
        author: null,
        published_at: null,
        source_language: snapshot.source.language_code,
      },
      source_artifact_id: snapshot.source.source_artifact_id,
      chunk,
      source_revision: snapshot.source.source_hash,
      source_manifest_hash: snapshot.source.manifest_hash,
      source_text_version: 'decoded-cue-text:1',
      prompt_snapshot: snapshot.prompt,
      profile_snapshot: snapshot.profile,
      profile_revision: prepared.snapshot_hash,
      runtime: snapshot.settings.runtime,
      quality_scope: snapshot.quality_scope,
      token_estimate: {
        method: 'utf8-byte-upper-bound:1',
        input: context.token_estimate.input,
      },
      generation_settings: {
        limits: snapshot.settings.limits,
        max_output_tokens: snapshot.settings.max_output_tokens,
        source_language: snapshot.source.language_code,
        analysis_mode: snapshot.chunk ? 'CHUNK' : 'ORDINARY',
        ...(snapshot.source.correction
          ? { source_role: 'CORRECTED_SOURCE' as const }
          : {}),
        ...(snapshot.additional_pass
          ? {
              additional_pass: {
                mode: snapshot.additional_pass.mode,
                purpose: snapshot.additional_pass.purpose,
              },
            }
          : {}),
        thinking_level: 'low',
      },
      request_id: prepared.run_id,
    };
    const encoded = JSON.stringify(context),
      hash = await sha256(encoded);
    if (hash !== contextHash || encoded !== JSON.stringify(expected))
      throw new Error('INVALID_AI_CONTEXT');
    const payload = JSON.stringify({
        context,
        context_hash: contextHash,
        request_prompt_hash: promptHash,
      }),
      payloadHash = await sha256(payload);
    const guard = leasePredicate(
      this.context,
      token,
      now.toISOString(),
      'ANALYZE',
    );
    await this.db
      .prepare(
        `INSERT INTO config_versions(config_id,owner_id,revision,payload_json,content_hash,created_at) SELECT ?,?,1,?,?,? WHERE ${guard.predicate} ON CONFLICT DO NOTHING`,
      )
      .bind(
        'analysis-request-' + prepared.run_id,
        this.context.ownerId,
        payload,
        payloadHash,
        now.toISOString(),
        ...guard.bindings,
      )
      .run();
    const stored = await this.db
      .prepare(
        'SELECT content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
      )
      .bind(this.context.ownerId, 'analysis-request-' + prepared.run_id)
      .first<{ content_hash: string }>();
    if (stored?.content_hash !== payloadHash)
      throw new Error('ANALYSIS_CONTEXT_CONFLICT');
    return {
      run_id: prepared.run_id,
      context_hash: contextHash,
      request_prompt_hash: promptHash,
    };
  }
  async load(token: LeaseToken, now: Date) {
    const guard = leasePredicate(
      this.context,
      token,
      now.toISOString(),
      'ANALYZE',
    );
    const row = await this.db
      .prepare(
        `SELECT payload_json,profile_revision FROM jobs WHERE owner_id=? AND job_id=? AND ${guard.predicate}`,
      )
      .bind(this.context.ownerId, token.job_id, ...guard.bindings)
      .first<{ payload_json: string; profile_revision: string }>();
    if (!row) throw new Error('STALE_FENCE');
    const snapshot = (
      JSON.parse(row.payload_json) as { snapshot: AnalysisJobSnapshot }
    ).snapshot;
    if (
      !snapshot ||
      snapshot.version !== 'analysis-job:1' ||
      (await sha256(JSON.stringify(snapshot))) !== row.profile_revision
    )
      throw new Error('ANALYSIS_JOB_SNAPSHOT_MISMATCH');
    if (
      JSON.stringify(await this.source(snapshot.source.run_id)) !==
      JSON.stringify(snapshot.source)
    )
      throw new Error('ANALYSIS_SOURCE_ARTIFACT_MISMATCH');
    await this.requireSourceProcessing(snapshot.source.item_id);
    const model = await new ModelRegistry(this.db, this.context).load(
      snapshot.profile.profile_id,
      snapshot.profile.revision,
    );
    if (JSON.stringify(model) !== JSON.stringify(snapshot.profile))
      throw new Error('ANALYSIS_MODEL_SNAPSHOT_MISMATCH');
    if (snapshot.semantic_profile) {
      const semantic = await new SemanticProfiles(this.db, this.context).load(
        snapshot.semantic_profile.profile_id,
        snapshot.semantic_profile.revision,
      );
      if (
        JSON.stringify(semantic) !== JSON.stringify(snapshot.semantic_profile)
      )
        throw new Error('SEMANTIC_PROFILE_SNAPSHOT_HASH_MISMATCH');
      let registered: PromptSnapshot | undefined;
      try {
        registered = await new PromptRegistry(this.db, this.context).load(
          snapshot.prompt.prompt_id,
          snapshot.prompt.version,
          snapshot.prompt.generation,
          snapshot.settings.mode,
        );
      } catch (error) {
        if (
          snapshot.settings.mode !== 'QUALITY_TEST' ||
          snapshot.prompt.prompt_hash !== semantic?.compiled.prompt.hash ||
          !(error instanceof Error) ||
          error.message !== 'PROMPT_NOT_AVAILABLE'
        )
          throw error;
      }
      if (
        !semantic ||
        JSON.stringify(semanticPrompt(semantic, registered ?? undefined)) !==
          JSON.stringify(snapshot.prompt)
      )
        throw new Error('INCOMPATIBLE_PROMPT_SNAPSHOT');
    }
    const selected = selectPipeline([snapshot.profile], {
      profile_id: 'gemini_free',
      purpose: snapshot.settings.purpose,
      region: snapshot.settings.region,
      task_type: snapshot.semantic_profile?.compiled.config.mode ?? 'ECONOMY',
      runtime: snapshot.settings.runtime,
      mode: snapshot.settings.mode,
      quality_scope: snapshot.quality_scope,
      input_tokens: 0,
      output_tokens: snapshot.settings.max_output_tokens,
      now,
      paid_services_enabled: false,
    });
    if (!selected.profile)
      throw new Error('ANALYSIS_PROFILE_' + selected.reason);
    return { snapshot, snapshot_hash: row.profile_revision };
  }
  async submit(
    token: LeaseToken,
    reservationId: string,
    requestPromptHash: string,
    now: Date,
  ) {
    const { run_id } = await this.prepareRun(token, now);
    const receipt = await this.db
      .prepare(
        'SELECT payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
      )
      .bind(this.context.ownerId, 'analysis-request-' + run_id)
      .first<{ payload_json: string; content_hash: string }>();
    if (
      !receipt ||
      (await sha256(receipt.payload_json)) !== receipt.content_hash
    )
      throw new Error('ANALYSIS_CONTEXT_REQUIRED');
    const context = JSON.parse(receipt.payload_json) as {
      request_prompt_hash: string;
      context: CompiledContext;
    };
    if (context.request_prompt_hash !== requestPromptHash)
      throw new Error('INVALID_AI_REQUEST_SCOPE');
    const reservation = await this.db
      .prepare(
        'SELECT request_id,input_tokens FROM quota_reservations WHERE owner_id=? AND reservation_id=? AND job_id=? AND fencing_token=?',
      )
      .bind(
        this.context.ownerId,
        reservationId,
        token.job_id,
        token.fencing_token,
      )
      .first<{ request_id: string; input_tokens: number }>();
    if (
      reservation?.request_id !== run_id ||
      reservation.input_tokens !== context.context.token_estimate.input
    )
      throw new Error('INVALID_AI_REQUEST_SCOPE');
    return new QuotaAdmission(this.db, this.context).submit(
      reservationId,
      token,
      now,
    );
  }
  async reserve(
    token: LeaseToken,
    input: { request_id: string; input_tokens: number },
    now: Date,
  ) {
    const { snapshot, run_id } = await this.prepareRun(token, now);
    if (input.request_id !== run_id)
      throw new Error('INVALID_AI_REQUEST_SCOPE');
    const contextReceipt = await this.db
      .prepare(
        'SELECT payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
      )
      .bind(this.context.ownerId, 'analysis-request-' + run_id)
      .first<{ payload_json: string; content_hash: string }>();
    if (
      !contextReceipt ||
      (await sha256(contextReceipt.payload_json)) !==
        contextReceipt.content_hash
    )
      throw new Error('ANALYSIS_CONTEXT_REQUIRED');
    if (
      (JSON.parse(contextReceipt.payload_json) as { context: CompiledContext })
        .context.token_estimate.input !== input.input_tokens
    )
      throw new Error('INVALID_AI_TOKEN_ESTIMATE');
    if (
      !input.request_id ||
      input.request_id.length > 128 ||
      !Number.isSafeInteger(input.input_tokens) ||
      input.input_tokens < 1 ||
      input.input_tokens + snapshot.settings.max_output_tokens >
        snapshot.profile.context_tokens
    )
      throw new Error('INVALID_RESERVATION');
    const buckets = await currentGeminiBuckets(
      this.db,
      this.context,
      snapshot.profile,
      now,
    );
    return new QuotaAdmission(this.db, this.context).reserve(
      {
        request_id: input.request_id,
        account_key: snapshot.profile.account_key,
        model: snapshot.profile.model,
        input_tokens: input.input_tokens,
        buckets,
        paid_services_enabled: false,
      },
      token,
      now,
    );
  }
  async prepareRun(token: LeaseToken, now: Date) {
    const { snapshot, snapshot_hash } = await this.load(token, now);
    const guard = leasePredicate(
      this.context,
      token,
      now.toISOString(),
      'ANALYZE',
    );
    const runId =
      'analysis_' +
      (await sha256(
        JSON.stringify({
          owner: this.context.ownerId,
          job: token.job_id,
          fence: token.fencing_token,
          snapshot_hash,
        }),
      ));
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO analysis_runs(run_id,owner_id,item_id,job_id,input_snapshot_json,profile_snapshot_json,prompt_snapshot_json,wire_schema_version,canonical_schema_version,enrichment_version,routing_snapshot_json,state,created_at) SELECT ?,owner_id,item_id,job_id,json_extract(payload_json,'$.snapshot.source'),json_extract(payload_json,'$.snapshot.profile'),json_extract(payload_json,'$.snapshot.prompt'),wire_schema_version,'intelligence-canonical:1.2','1.0',?,'CANDIDATE',? FROM jobs WHERE owner_id=? AND job_id=? AND ${guard.predicate} ON CONFLICT(run_id) DO NOTHING`,
        )
        .bind(
          runId,
          JSON.stringify({
            settings: snapshot.settings,
            quality_scope: snapshot.quality_scope,
            snapshot_hash,
            ...(snapshot.semantic_profile
              ? { semantic_profile: snapshot.semantic_profile }
              : {}),
          }),
          now.toISOString(),
          this.context.ownerId,
          token.job_id,
          ...guard.bindings,
        ),
      this.db
        .prepare(
          `SELECT (r.input_snapshot_json=json_extract(q.payload_json,'$.snapshot.source') AND r.profile_snapshot_json=json_extract(q.payload_json,'$.snapshot.profile') AND r.prompt_snapshot_json=json_extract(q.payload_json,'$.snapshot.prompt')) AS matches, EXISTS(SELECT 1 FROM config_versions c WHERE c.owner_id=q.owner_id AND c.config_id='analysis-chunks-'||q.job_id AND c.revision=1) AS chunks_ready FROM analysis_runs r JOIN jobs q ON q.owner_id=r.owner_id AND q.job_id=r.job_id WHERE r.owner_id=? AND r.job_id=? AND r.run_id=? AND ${guard.predicate}`,
        )
        .bind(this.context.ownerId, token.job_id, runId, ...guard.bindings),
    ]);
    const run = results[1]?.results?.[0] as
      | {
          matches: number;
          chunks_ready: number;
        }
      | undefined;
    if (run?.matches !== 1) throw new Error('ANALYSIS_RUN_SNAPSHOT_MISMATCH');
    return {
      run_id: runId,
      snapshot,
      snapshot_hash,
      chunk_plan_available: run?.chunks_ready === 1,
    };
  }
}
