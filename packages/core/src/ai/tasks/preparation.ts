import {
  assertContext,
  type AccessContext,
  type Database,
} from '../../db/boundary.js';
import { sha256 } from '../../auth/crypto.js';
import { ArtifactRepository } from '../../artifacts/store.js';
import { AnalysisJobs } from '../jobs.js';
import { ModelRegistry } from '../models.js';
import { PromptRegistry } from '../../registry/store.js';
import { translationPlan, type TranslationScope } from './translation.js';
import { historyPlan, type HistoryRecord } from './history.js';
import type { normalizeTranscript } from '../../transcript/normalize.js';
import type { enrichEconomy } from '../enrichment/canonical.js';
import { validateCanonical } from '../repair/validate.js';
import { compileHistory, compileTranslation } from './compiler.js';
import { loadTranslationRecovery } from './recovery-candidate.js';
import { missingTranslationPlan } from './translation-recovery.js';
import {
  planTranslationChunks,
  type TranslationChunkPolicy,
} from './translation-chunks.js';
import {
  OptionalAIJobs,
  type OptionalTaskSnapshot,
  type OptionalTask,
} from './jobs.js';

export class OptionalTaskPreparation {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async previewForItem(
    itemId: string,
    task: OptionalTask,
    scope: 'FULL' | 'SELECTED_SEGMENTS' | null,
    now: Date,
  ) {
    this.context.requireOwner();
    const profile = await new ModelRegistry(this.db, this.context).latest(
      'gemini_free',
    );
    if (!profile) throw new Error('MODEL_NOT_CONFIGURED');
    let prepared:
      | Awaited<ReturnType<OptionalTaskPreparation['translation']>>
      | Awaited<ReturnType<OptionalTaskPreparation['history']>>;
    if (task === 'TRANSLATE') {
      if (scope !== 'FULL' && scope !== 'SELECTED_SEGMENTS')
        throw new Error('INVALID_TRANSLATION_SCOPE');
      const source = await this.db
        .prepare(
          "SELECT r.run_id FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=? AND r.item_id=? AND r.state='ACCEPTED' AND j.task_type='FETCH_TRANSCRIPT' AND j.state='SUCCEEDED' ORDER BY r.accepted_at DESC,r.run_id LIMIT 1",
        )
        .bind(this.context.ownerId, itemId)
        .first<{ run_id: string }>();
      if (!source) throw new Error('OPTIONAL_SOURCE_NOT_ACCEPTED');
      prepared = await this.translation(source.run_id, scope, now);
    } else {
      if (scope !== null) throw new Error('INVALID_HISTORY_SCOPE');
      prepared = await this.history(itemId, now);
    }
    return this.preview(
      prepared,
      {
        runtime: 'local',
        mode: 'PRODUCTION',
        purpose: profile.purposes[0] ?? '',
        region: 'PL',
        max_output_tokens: Math.min(8000, profile.output_tokens),
      },
      now,
    );
  }
  async recovery(runId: string, now: Date) {
    this.context.requireOwner();
    const parent = await loadTranslationRecovery(this.db, this.context, runId);
    if (parent.generation >= 3)
      throw new Error('TRANSLATION_RECOVERY_EXHAUSTED');
    return {
      item_id: parent.snapshot.item_id,
      task: 'TRANSLATE' as const,
      plan: await missingTranslationPlan(parent.plan, parent.mapped),
      glossary: parent.snapshot.glossary,
      selected_run_id: parent.snapshot.selected_run_id,
      ...(parent.snapshot.chunk ? { chunk: parent.snapshot.chunk } : {}),
      recovery: {
        parent_run_id: runId,
        parent_outcome_hash: parent.outcome_hash,
        generation: parent.generation + 1,
      },
      prepared_at: now.toISOString(),
    };
  }
  async previewRecovery(runId: string, now: Date) {
    const parent = await loadTranslationRecovery(this.db, this.context, runId);
    if (parent.snapshot.settings.mode !== 'PRODUCTION')
      throw new Error('TRANSLATION_RECOVERY_NOT_AVAILABLE');
    return this.preview(
      await this.recovery(runId, now),
      parent.snapshot.settings,
      now,
      parent.snapshot.chunk ? parent.snapshot.profile : undefined,
    );
  }
  async translation(
    sourceRunId: string,
    scope: Exclude<TranslationScope, 'CHUNK'>,
    now: Date,
  ) {
    this.context.requireOwner();
    const source = await new AnalysisJobs(this.db, this.context).sourceForOwner(
      sourceRunId,
    );
    const repo = new ArtifactRepository(this.db, this.context);
    const original = await repo.readVerifiedText(
      source.source_artifact_id,
      32 * 1024 * 1024,
    );
    const manifest = await repo.readVerifiedText(
      source.segment_map_artifact_id,
      32 * 1024 * 1024,
    );
    if (
      original.artifact.content_hash !== source.source_hash ||
      manifest.artifact.content_hash !== source.manifest_hash
    )
      throw new Error('OPTIONAL_SOURCE_NOT_ACCEPTED');
    let selectedRun: string | null = null,
      ids: string[] | undefined;
    if (scope === 'SELECTED_SEGMENTS') {
      const selection = await this.db
        .prepare(
          'SELECT accepted_run_id FROM active_analysis_selections WHERE owner_id=? AND item_id=?',
        )
        .bind(this.context.ownerId, source.item_id)
        .first<{ accepted_run_id: string | null }>();
      if (!selection?.accepted_run_id)
        throw new Error('SELECTED_EVIDENCE_REQUIRED');
      selectedRun = selection.accepted_run_id;
      const refs = await this.db
        .prepare(
          `SELECT e.segment_ids_json FROM analysis_evidence a JOIN evidence e ON e.owner_id=a.owner_id AND e.evidence_id=a.evidence_id JOIN analysis_runs r ON r.owner_id=a.owner_id AND r.run_id=a.run_id WHERE a.owner_id=? AND a.run_id=? AND r.state='ACCEPTED' AND e.source_artifact_id=?`,
        )
        .bind(this.context.ownerId, selectedRun, source.source_artifact_id)
        .all<{ segment_ids_json: string }>();
      ids = [
        ...new Set(
          refs.results.flatMap(
            (r) => JSON.parse(r.segment_ids_json) as string[],
          ),
        ),
      ];
      if (!ids.length) throw new Error('SELECTED_EVIDENCE_REQUIRED');
    }
    const plan = await translationPlan(
      {
        owner_id: this.context.ownerId,
        source_artifact_id: source.source_artifact_id,
        source_text: original.text,
        source_language: source.language_code,
        manifest: JSON.parse(manifest.text) as Awaited<
          ReturnType<typeof normalizeTranscript>
        >['manifest'],
        manifest_hash: source.manifest_hash,
        video_url: null,
      },
      scope,
      ids,
    );
    return {
      item_id: source.item_id,
      task: 'TRANSLATE' as const,
      plan,
      glossary: [],
      selected_run_id: selectedRun,
      prepared_at: now.toISOString(),
    };
  }
  async history(itemId: string, now: Date) {
    this.context.requireOwner();
    const current = await this.db
      .prepare(
        `SELECT o.observation_id,o.run_id,o.row_hash,r.accepted_at,i.item_id,i.published_at FROM active_analysis_selections s JOIN observations o ON o.owner_id=s.owner_id AND o.run_id=s.accepted_run_id JOIN analysis_runs r ON r.owner_id=o.owner_id AND r.run_id=o.run_id JOIN items i ON i.owner_id=r.owner_id AND i.item_id=r.item_id WHERE s.owner_id=? AND s.item_id=? AND r.state='ACCEPTED' AND r.accepted_at<=? AND o.kind!='CONTRADICTION' ORDER BY o.observation_id LIMIT 20`,
      )
      .bind(this.context.ownerId, itemId, now.toISOString())
      .all<HistoryRecordMeta>();
    if (!current.results.length) throw new Error('HISTORY_CURRENT_REQUIRED');
    // Deterministic bounded same-source history. Publication remains unknown when unavailable.
    const prior = await this.db
      .prepare(
        `SELECT o.observation_id,o.run_id,o.row_hash,r.accepted_at,i.item_id,i.published_at FROM items current JOIN items i ON i.owner_id=current.owner_id AND i.source_id=current.source_id JOIN active_analysis_selections s ON s.owner_id=i.owner_id AND s.item_id=i.item_id JOIN observations o ON o.owner_id=s.owner_id AND o.run_id=s.accepted_run_id JOIN analysis_runs r ON r.owner_id=o.owner_id AND r.run_id=o.run_id WHERE current.owner_id=? AND current.item_id=? AND i.item_id!=current.item_id AND r.state='ACCEPTED' AND r.accepted_at<=? AND (current.published_at IS NULL OR i.published_at IS NULL OR i.published_at<current.published_at) AND o.kind!='CONTRADICTION' ORDER BY i.published_at DESC NULLS LAST,o.recorded_at DESC,o.observation_id LIMIT 40`,
      )
      .bind(this.context.ownerId, itemId, now.toISOString())
      .all<HistoryRecordMeta>();
    const cache = new Map<
      string,
      Promise<Awaited<ReturnType<typeof enrichEconomy>>['canonical']>
    >();
    const records = async (
      rows: HistoryRecordMeta[],
    ): Promise<HistoryRecord[]> => {
      const result: HistoryRecord[] = [];
      for (const meta of rows) {
        let cached = cache.get(meta.run_id);
        if (!cached) {
          cached = (async () => {
            const run = await this.db
              .prepare(
                "SELECT outcome_json,candidate_hash FROM analysis_runs WHERE owner_id=? AND run_id=? AND state='ACCEPTED'",
              )
              .bind(this.context.ownerId, meta.run_id)
              .first<{ outcome_json: string; candidate_hash: string }>();
            if (!run || (await sha256(run.outcome_json)) !== run.candidate_hash)
              throw new Error('HISTORY_RECORD_MISMATCH');
            const outcome = JSON.parse(run.outcome_json) as {
              version: string;
              canonical_artifact_id: string;
              canonical_hash: string;
            };
            if (outcome.version !== 'intelligence-accepted:1')
              throw new Error('HISTORY_RECORD_MISMATCH');
            const artifact = await new ArtifactRepository(
              this.db,
              this.context,
            ).readVerifiedText(outcome.canonical_artifact_id, 8 * 1024 * 1024);
            const value = JSON.parse(artifact.text) as Awaited<
              ReturnType<typeof enrichEconomy>
            >['canonical'];
            if (
              artifact.artifact.content_hash !== outcome.canonical_hash ||
              !validateCanonical(value) ||
              value.item_id !== meta.item_id
            )
              throw new Error('HISTORY_RECORD_MISMATCH');
            return value;
          })();
          cache.set(meta.run_id, cached);
        }
        const canonical = await cached;
        const row = [
          canonical.claims,
          canonical.stance,
          canonical.predictions,
          canonical.usage,
          canonical.recommendations,
          canonical.uncertainties,
        ]
          .flat()
          .find((r) => r.observation_id === meta.observation_id);
        if (!row || (await sha256(JSON.stringify(row))) !== meta.row_hash)
          throw new Error('HISTORY_RECORD_MISMATCH');
        result.push({
          owner_id: this.context.ownerId,
          item_id: meta.item_id,
          run_id: meta.run_id,
          accepted_at: meta.accepted_at,
          published_at: meta.published_at,
          row,
          row_hash: meta.row_hash,
          evidence: canonical.evidence.filter((e) =>
            row.evidence_ids.includes(e.evidence_id),
          ),
        });
      }
      return result;
    };
    const plan = await historyPlan({
      owner_id: this.context.ownerId,
      current_item_id: itemId,
      current_run_id: current.results[0]!.run_id,
      cut: now.toISOString(),
      scope_note_pl:
        'Ograniczony wycinek przyjętych wypowiedzi z tego samego kanału: do 20 bieżących i 40 wcześniejszych rekordów. Daty publikacji mogą być nieznane. To nie jest cała historia.',
      current: await records(current.results),
      prior: await records(prior.results),
    });
    return {
      item_id: itemId,
      task: 'HISTORICAL_COMPARE' as const,
      plan,
      prepared_at: now.toISOString(),
    };
  }
  async preview(
    prepared:
      | Awaited<ReturnType<OptionalTaskPreparation['translation']>>
      | Awaited<ReturnType<OptionalTaskPreparation['recovery']>>
      | Awaited<ReturnType<OptionalTaskPreparation['history']>>,
    settings: OptionalTaskSnapshot['settings'],
    now: Date,
    pinnedProfile?: OptionalTaskSnapshot['profile'],
  ) {
    this.context.requireOwner();
    const profile =
      pinnedProfile ??
      (await new ModelRegistry(this.db, this.context).latest('gemini_free'));
    if (!profile) throw new Error('MODEL_NOT_CONFIGURED');
    const family =
      prepared.task === 'TRANSLATE'
        ? 'FULL_TRANSLATION_V1'
        : 'HISTORICAL_COMPARE_V1';
    // Production preview uses a genuinely published template. Draft testing belongs to Lab.
    const prompt = await new PromptRegistry(this.db, this.context).load(
      family,
      2,
      1,
    );
    const scope = { ...prepared };
    Reflect.deleteProperty(scope, 'prepared_at');
    const snapshot: OptionalTaskSnapshot = {
      ...scope,
      version: 'optional-ai-job:1',
      profile,
      prompt,
      settings,
    };
    const common = {
      ...settings,
      profile,
      prompt,
      request_id: 'preview',
      now,
      deadline: new Date(now.getTime() + 300000).toISOString(),
    };
    const chunkPolicy: TranslationChunkPolicy = {
      version: 'translation-chunk-policy:1',
      max_source_bytes: Math.max(
        1,
        Math.min(
          16000,
          Math.floor(settings.max_output_tokens / 2),
          Math.floor(profile.context_tokens / 2),
        ),
      ),
      max_segments: Math.max(
        1,
        Math.min(100, Math.floor(settings.max_output_tokens / 128)),
      ),
      max_plan_bytes: 120000,
      max_parts: 128,
    };
    const chunks =
      snapshot.task === 'TRANSLATE' &&
      !snapshot.recovery &&
      !snapshot.chunk &&
      settings.mode === 'PRODUCTION'
        ? await planTranslationChunks(snapshot.plan, chunkPolicy)
        : null;
    const multipart = chunks && chunks.parts.length > 1 ? chunks : null;
    const compiled =
      snapshot.task === 'TRANSLATE'
        ? await compileTranslation({
            ...common,
            plan: multipart?.parts[0] ?? snapshot.plan,
            glossary: snapshot.glossary,
          })
        : await compileHistory({ ...common, plan: snapshot.plan });
    let inputTokens = compiled.token_estimate.input_tokens;
    if (multipart && snapshot.task === 'TRANSLATE') {
      for (const plan of multipart.parts.slice(1)) {
        const part = await compileTranslation({
          ...common,
          plan,
          glossary: snapshot.glossary,
        });
        inputTokens += part.token_estimate.input_tokens;
      }
    }
    const receipt = {
      version: 'optional-preview:1',
      prepared_at: now.toISOString(),
      snapshot,
      ...(multipart
        ? { chunk_policy: chunkPolicy, chunk_manifest_hash: multipart.hash }
        : {}),
    };
    const serialized = JSON.stringify(receipt);
    if (new TextEncoder().encode(serialized).length > 1500000)
      throw new Error('TRANSLATION_GROUP_EXCEEDS_BUDGET');
    const hash = await sha256(serialized);
    await this.db
      .prepare(
        'INSERT INTO config_versions(config_id,owner_id,revision,payload_json,content_hash,created_at) VALUES(?,?,1,?,?,?) ON CONFLICT DO NOTHING',
      )
      .bind(
        'optional-preview-' + hash,
        this.context.ownerId,
        serialized,
        hash,
        now.toISOString(),
      )
      .run();
    return {
      preview_hash: hash,
      task: snapshot.task,
      item_id: snapshot.item_id,
      profile_id: profile.profile_id,
      token_estimate: {
        ...compiled.token_estimate,
        input_tokens: inputTokens,
        output_tokens:
          compiled.token_estimate.output_tokens *
          (multipart?.parts.length ?? 1),
      },
      quota_remaining: null,
      quota_status: 'UNKNOWN' as const,
      additional_model_requests: multipart?.parts.length ?? 1,
      selection_effect: 'NONE' as const,
      source_scope:
        snapshot.task === 'TRANSLATE'
          ? snapshot.plan.snapshot.scope
          : 'BOUNDED_SAME_SOURCE',
      scope_count:
        snapshot.task === 'TRANSLATE'
          ? snapshot.plan.snapshot.segments.length
          : snapshot.plan.snapshot.prior.observations.length,
    };
  }
  async confirm(previewHash: string, nonce: string, now: Date) {
    this.context.requireOwner();
    const receipt = await this.db
      .prepare(
        'SELECT payload_json,content_hash,created_at FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
      )
      .bind(this.context.ownerId, 'optional-preview-' + previewHash)
      .first<{
        payload_json: string;
        content_hash: string;
        created_at: string;
      }>();
    if (
      !receipt ||
      receipt.content_hash !== previewHash ||
      (await sha256(receipt.payload_json)) !== previewHash ||
      now.getTime() - Date.parse(receipt.created_at) > 900000 ||
      Date.parse(receipt.created_at) > now.getTime()
    )
      throw new Error('READ_SNAPSHOT_CHANGED');
    const value = JSON.parse(receipt.payload_json) as {
      version: string;
      prepared_at: string;
      snapshot: OptionalTaskSnapshot;
      chunk_policy?: TranslationChunkPolicy;
      chunk_manifest_hash?: string;
    };
    if (
      value.version !== 'optional-preview:1' ||
      value.prepared_at !== receipt.created_at
    )
      throw new Error('READ_SNAPSHOT_CHANGED');
    if (value.chunk_policy) {
      if (
        value.snapshot.task !== 'TRANSLATE' ||
        (await planTranslationChunks(value.snapshot.plan, value.chunk_policy))
          .hash !== value.chunk_manifest_hash
      )
        throw new Error('READ_SNAPSHOT_CHANGED');
      return new OptionalAIJobs(this.db, this.context).enqueueChunked(
        value.snapshot,
        value.chunk_policy,
        nonce,
        now,
      );
    }
    return new OptionalAIJobs(this.db, this.context).enqueue(
      value.snapshot,
      nonce,
      now,
    );
  }
}
interface HistoryRecordMeta {
  observation_id: string;
  run_id: string;
  row_hash: string;
  accepted_at: string;
  item_id: string;
  published_at: string | null;
}
export type OptionalPreparationTask = OptionalTask;
