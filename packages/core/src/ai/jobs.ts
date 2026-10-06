import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
import { JobStore } from '../jobs/store.js';
import { leasePredicate } from '../jobs/lease-guard.js';
import { PromptRegistry, type PromptSnapshot } from '../registry/store.js';
import {
  SemanticProfiles,
  semanticPrompt,
  type SemanticProfileSnapshot,
} from '../registry/semantic-profiles.js';
import { ModelRegistry } from './models.js';
import { selectPipeline } from './selector.js';
import { analysisQualityScope } from './compiler.js';
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
}
export interface AnalysisJobSnapshot {
  version: 'analysis-job:1';
  source: SourceSnapshot;
  prompt: PromptSnapshot;
  profile: PipelineProfile;
  semantic_profile?: SemanticProfileSnapshot;
  settings: AnalysisSettings;
  quality_scope: string;
  semantic_context?: CompiledContext['semantic_context'];
  chunk?: {
    parent_job_id: string;
    parent_snapshot_hash: string;
    plan_artifact_id: string;
    plan_hash: string;
    chunk_index: number;
  };
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
    if (!row || (await sha256(row.outcome_json)) !== row.candidate_hash)
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
  async enqueue(sourceRunId: string, settings: AnalysisSettings, now: Date) {
    this.context.requireOwner();
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
    await this.requireSourceProcessing(source.item_id);
    const semanticProfile = await new SemanticProfiles(
      this.db,
      this.context,
    ).forItem(source.item_id, now);
    const prompt = semanticProfile
      ? semanticPrompt(semanticProfile)
      : await new PromptRegistry(this.db, this.context).current();
    if (
      semanticProfile &&
      (semanticProfile.compiled.config.translation !== 'NONE' ||
        semanticProfile.compiled.config.history ||
        semanticProfile.compiled.config.second_pass ||
        semanticProfile.compiled.config.validation_pass ||
        semanticProfile.compiled.prompt.hash !== prompt.prompt_hash ||
        semanticProfile.compiled.wire.hash !== prompt.wire.hash)
    )
      throw new Error('CAPABILITY_NOT_AVAILABLE');
    const profile = await new ModelRegistry(this.db, this.context).latest(
      'gemini_free',
    );
    if (!profile) throw new Error('MODEL_NOT_CONFIGURED');
    const normalized = {
      ...settings,
      limits: Object.fromEntries(
        Object.entries(settings.limits).sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
    const scope = await analysisQualityScope(prompt, profile, {
      limits: normalized.limits,
      max_output_tokens: settings.max_output_tokens,
      source_language: source.language_code,
      analysis_mode: 'ORDINARY',
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
      semantic_context: await this.semanticContext(source),
    };
    const hash = await sha256(JSON.stringify(snapshot));
    return new JobStore(this.db, this.context).enqueue(
      {
        item_id: source.item_id,
        source_id: null,
        task_type: 'ANALYZE',
        input_revision: source.source_hash,
        profile_revision: hash,
        prompt_snapshot_id: prompt.prompt_hash,
        routing_policy_version: 'pipeline-selector:1',
        wire_schema_version: prompt.wire.id.replace('urn:bartosz:schema:', ''),
        canonical_schema_version: 'intelligence-canonical:1.2',
        enrichment_version: '1.0',
        explicit_run_nonce: '',
        arrival_origin_at: now.toISOString(),
        origin_kind: 'MANUAL',
        payload: { snapshot },
        priority: settings.mode === 'QUALITY_TEST' ? 20 : 60,
        due_at: now.toISOString(),
      },
      now.toISOString(),
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
      if (
        !semantic ||
        JSON.stringify(semanticPrompt(semantic)) !==
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
