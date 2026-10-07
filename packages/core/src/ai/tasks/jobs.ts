import {
  assertContext,
  type AccessContext,
  type Database,
} from '../../db/boundary.js';
import { sha256 } from '../../auth/crypto.js';
import { JobStore } from '../../jobs/store.js';
import { leasePredicate } from '../../jobs/lease-guard.js';
import { RunRepository } from '../../jobs/acceptance.js';
import {
  ArtifactRepository,
  splitArtifactText,
  type ArtifactKind,
} from '../../artifacts/store.js';
import type { PromptSnapshot } from '../../registry/store.js';
import type {
  PipelineProfile,
  AIRequest,
  AIResponse,
} from '../../../../contracts/src/ai.js';
import type { LeaseToken } from '../../../../contracts/src/jobs.js';
import { ModelRegistry } from '../models.js';
import { QuotaAdmission } from '../admission.js';
import { currentGeminiBuckets } from '../quota-policy.js';
import { AnalysisResponses } from '../responses.js';
import { finalizeCandidateRun } from '../candidate-finalization.js';
import { compileTranslation, compileHistory } from './compiler.js';
import { mapTranslation, type TranslationPlan } from './translation.js';
import { mapHistory, historyPlan, type HistoryPlan } from './history.js';
import {
  composeTranslations,
  missingTranslationPlan,
} from './translation-recovery.js';
import {
  loadTranslationRecovery,
  type TranslationRecoveryRef,
} from './recovery-candidate.js';
export type OptionalTask = 'TRANSLATE' | 'HISTORICAL_COMPARE';
type TaskInput =
  | {
      task: 'TRANSLATE';
      plan: TranslationPlan;
      glossary: { source: string; target: string }[];
      selected_run_id: string | null;
      recovery?: TranslationRecoveryRef;
    }
  | { task: 'HISTORICAL_COMPARE'; plan: HistoryPlan };
export type OptionalTaskSnapshot = TaskInput & {
  version: 'optional-ai-job:1';
  item_id: string;
  prompt: PromptSnapshot;
  profile: PipelineProfile;
  settings: {
    runtime: 'local' | 'cloud';
    mode: 'PRODUCTION' | 'QUALITY_TEST';
    purpose: string;
    region: string;
    max_output_tokens: number;
  };
};

/** Optional accepted results never request an Intelligence selection or insert Ledger rows. */
export class OptionalAIJobs {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  private compile(snapshot: OptionalTaskSnapshot, runId: string, now: Date) {
    const common = {
      ...snapshot.settings,
      prompt: snapshot.prompt,
      profile: snapshot.profile,
      request_id: runId,
      deadline: new Date(now.getTime() + 300000).toISOString(),
      now,
    };
    return snapshot.task === 'TRANSLATE'
      ? compileTranslation({
          ...common,
          plan: snapshot.plan,
          glossary: snapshot.glossary,
        })
      : compileHistory({ ...common, plan: snapshot.plan });
  }
  private async references(snapshot: OptionalTaskSnapshot) {
    const permitted = async (itemId: string) => {
      if (
        !(await this.db
          .prepare(
            `SELECT 1 FROM items i JOIN sources s ON s.owner_id=i.owner_id AND s.source_id=i.source_id WHERE i.owner_id=? AND i.item_id=? AND i.availability='PUBLIC' AND s.access_state='PUBLIC' AND s.ai_processing_allowed=1`,
          )
          .bind(this.context.ownerId, itemId)
          .first())
      )
        throw new Error('ANALYSIS_SOURCE_PROCESSING_DENIED');
    };
    await permitted(snapshot.item_id);
    if (snapshot.task === 'TRANSLATE') {
      if (snapshot.recovery) {
        const parent = await loadTranslationRecovery(
          this.db,
          this.context,
          snapshot.recovery.parent_run_id,
        );
        if (
          parent.outcome_hash !== snapshot.recovery.parent_outcome_hash ||
          snapshot.recovery.generation !== parent.generation + 1 ||
          snapshot.recovery.generation > 3 ||
          snapshot.item_id !== parent.snapshot.item_id ||
          snapshot.selected_run_id !== parent.snapshot.selected_run_id ||
          JSON.stringify(snapshot.glossary) !==
            JSON.stringify(parent.snapshot.glossary) ||
          (await missingTranslationPlan(parent.plan, parent.mapped)).hash !==
            snapshot.plan.hash
        )
          throw new Error('OPTIONAL_SNAPSHOT_MISMATCH');
      }
      const plan = snapshot.plan.snapshot;
      const pair = await this.db
        .prepare(
          `SELECT m.artifact_id,m.content_hash FROM artifacts a JOIN artifacts m ON m.owner_id=a.owner_id AND m.item_id=a.item_id AND m.original_ref=a.artifact_id WHERE a.owner_id=? AND a.item_id=? AND a.artifact_id=? AND a.kind='SOURCE_ORIGINAL' AND a.state='VERIFIED' AND a.content_hash=? AND m.kind='SEGMENT_MAP' AND m.state='VERIFIED' AND m.content_hash=? AND EXISTS(SELECT 1 FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=a.owner_id AND r.item_id=a.item_id AND r.state='ACCEPTED' AND j.task_type='FETCH_TRANSCRIPT' AND json_extract(r.outcome_json,'$.source_artifact_id')=a.artifact_id AND json_extract(r.outcome_json,'$.segment_map_artifact_id')=m.artifact_id AND json_extract(r.outcome_json,'$.authority.authority_confidence')='CONFIRMED' AND json_extract(r.outcome_json,'$.authority.language_code')=?)`,
        )
        .bind(
          this.context.ownerId,
          snapshot.item_id,
          plan.source_artifact_id,
          plan.source_hash,
          plan.manifest_hash,
          plan.source_language,
        )
        .first<{ artifact_id: string; content_hash: string }>();
      if (!pair) throw new Error('OPTIONAL_SOURCE_NOT_ACCEPTED');
      // Manifest bytes are pinned by their verified artifact and compared exactly.
      const chunks = await this.db
        .prepare(
          'SELECT body_base64 FROM artifact_chunks WHERE owner_id=? AND artifact_id=? ORDER BY chunk_index',
        )
        .bind(this.context.ownerId, pair.artifact_id)
        .all<{ body_base64: string }>();
      const parts = chunks.results.map((c) =>
        Uint8Array.from(
          atob(c.body_base64.replaceAll('-', '+').replaceAll('_', '/')),
          (c) => c.charCodeAt(0),
        ),
      );
      const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      const text = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: false,
      }).decode(bytes);
      if ((await sha256(text)) !== pair.content_hash)
        throw new Error('OPTIONAL_MANIFEST_MISMATCH');
      const manifest = JSON.parse(text) as {
        source_text_hash: string;
        complete: boolean;
        anchors: {
          segment_id: string;
          text: string;
          source_start: number;
          source_end: number;
          start_ms: number | null;
          end_ms: number | null;
          timestamp_precision: string;
        }[];
      };
      if (
        !manifest.complete ||
        manifest.source_text_hash !== plan.source_hash ||
        (plan.scope === 'FULL' &&
          manifest.anchors.length !== plan.segments.length)
      )
        throw new Error('OPTIONAL_MANIFEST_MISMATCH');
      let last = -1;
      for (const [i, segment] of plan.segments.entries()) {
        const index = manifest.anchors.findIndex(
            (a) => a.segment_id === segment.source_segment_id,
          ),
          anchor = manifest.anchors[index];
        if (
          !anchor ||
          index <= last ||
          segment.alias !== `s${i + 1}` ||
          JSON.stringify({
            text: anchor.text,
            source_start: anchor.source_start,
            source_end: anchor.source_end,
            start_ms: anchor.start_ms,
            end_ms: anchor.end_ms,
            timestamp_precision: anchor.timestamp_precision,
          }) !==
            JSON.stringify({
              text: segment.text,
              source_start: segment.source_start,
              source_end: segment.source_end,
              start_ms: segment.start_ms,
              end_ms: segment.end_ms,
              timestamp_precision: segment.timestamp_precision,
            })
        )
          throw new Error('OPTIONAL_MANIFEST_MISMATCH');
        last = index;
      }
      if (
        plan.scope === 'SELECTED_SEGMENTS' ||
        (snapshot.recovery && snapshot.selected_run_id !== null)
      ) {
        if (!snapshot.selected_run_id)
          throw new Error('SELECTED_EVIDENCE_REQUIRED');
        const rows = await this.db
          .prepare(
            `SELECT e.segment_ids_json FROM analysis_evidence x JOIN evidence e ON e.owner_id=x.owner_id AND e.evidence_id=x.evidence_id JOIN analysis_runs r ON r.owner_id=x.owner_id AND r.run_id=x.run_id WHERE x.owner_id=? AND x.run_id=? AND r.item_id=? AND r.state='ACCEPTED' AND e.source_artifact_id=?`,
          )
          .bind(
            this.context.ownerId,
            snapshot.selected_run_id,
            snapshot.item_id,
            plan.source_artifact_id,
          )
          .all<{ segment_ids_json: string }>();
        const selected = new Set(
          rows.results.flatMap(
            (r) => JSON.parse(r.segment_ids_json) as string[],
          ),
        );
        if (plan.segments.some((s) => !selected.has(s.source_segment_id)))
          throw new Error('SELECTED_EVIDENCE_REQUIRED');
      } else if (snapshot.selected_run_id !== null)
        throw new Error('INVALID_TRANSLATION_SCOPE');
    } else {
      const plan = snapshot.plan.snapshot;
      if (
        plan.owner_id !== this.context.ownerId ||
        plan.current_item_id !== snapshot.item_id
      )
        throw new Error('HISTORY_RECORD_MISMATCH');
      const rebuilt = await historyPlan({
        owner_id: plan.owner_id,
        current_item_id: plan.current_item_id,
        current_run_id: plan.current_run_id,
        cut: plan.cut,
        scope_note_pl: plan.scope_note_pl,
        current: plan.current.observations.map((record) => {
          const input = { ...record };
          Reflect.deleteProperty(input, 'alias');
          return input;
        }),
        prior: plan.prior.observations.map((record) => {
          const input = { ...record };
          Reflect.deleteProperty(input, 'alias');
          return input;
        }),
      });
      if (rebuilt.hash !== snapshot.plan.hash)
        throw new Error('HISTORY_PLAN_MISMATCH');
      for (const record of [
        ...plan.current.observations,
        ...plan.prior.observations,
      ]) {
        await permitted(record.item_id);
        const actual = await this.db
          .prepare(
            `SELECT o.row_hash,r.accepted_at,i.published_at FROM observations o JOIN analysis_runs r ON r.owner_id=o.owner_id AND r.run_id=o.run_id JOIN items i ON i.owner_id=r.owner_id AND i.item_id=r.item_id WHERE o.owner_id=? AND o.observation_id=? AND o.run_id=? AND r.item_id=? AND r.state='ACCEPTED'`,
          )
          .bind(
            this.context.ownerId,
            record.row.observation_id,
            record.run_id,
            record.item_id,
          )
          .first<{
            row_hash: string;
            accepted_at: string;
            published_at: string | null;
          }>();
        if (
          !actual ||
          actual.row_hash !== record.row_hash ||
          actual.accepted_at !== record.accepted_at ||
          actual.published_at !== record.published_at
        )
          throw new Error('HISTORY_RECORD_MISMATCH');
        for (const evidence of record.evidence) {
          if (
            !(await this.db
              .prepare(
                `SELECT 1 FROM evidence e JOIN observation_evidence x ON x.owner_id=e.owner_id AND x.evidence_id=e.evidence_id JOIN analysis_evidence a ON a.owner_id=e.owner_id AND a.evidence_id=e.evidence_id WHERE e.owner_id=? AND x.observation_id=? AND a.run_id=? AND e.evidence_id=? AND e.source_artifact_id=? AND e.source_hash=? AND e.quote_hash=? AND e.segment_ids_json=?`,
              )
              .bind(
                this.context.ownerId,
                record.row.observation_id,
                record.run_id,
                evidence.evidence_id,
                evidence.source_artifact_id,
                evidence.source_hash,
                evidence.quote_hash,
                JSON.stringify(evidence.segment_ids),
              )
              .first())
          )
            throw new Error('HISTORY_EVIDENCE_MISMATCH');
        }
      }
    }
  }
  private async pins(snapshot: OptionalTaskSnapshot) {
    const model = await new ModelRegistry(
      this.db,
      this.context,
      snapshot.task,
    ).load(snapshot.profile.profile_id, snapshot.profile.revision);
    const prompt = await this.db
      .prepare(
        'SELECT prompt_hash,prompt_text,status FROM prompt_versions WHERE owner_id=? AND prompt_id=? AND version=?',
      )
      .bind(
        this.context.ownerId,
        snapshot.prompt.prompt_id,
        snapshot.prompt.version,
      )
      .first<{ prompt_hash: string; prompt_text: string; status: string }>();
    if (
      JSON.stringify(model) !== JSON.stringify(snapshot.profile) ||
      !prompt ||
      prompt.prompt_hash !== snapshot.prompt.prompt_hash ||
      prompt.prompt_text !== snapshot.prompt.text ||
      (snapshot.settings.mode === 'PRODUCTION' && prompt.status !== 'PUBLISHED')
    )
      throw new Error('OPTIONAL_SNAPSHOT_MISMATCH');
  }
  async enqueue(snapshot: OptionalTaskSnapshot, nonce: string, now: Date) {
    this.context.requireOwner();
    if (
      snapshot.version !== 'optional-ai-job:1' ||
      !/^[a-f0-9-]{36}$/.test(nonce) ||
      !['TRANSLATE', 'HISTORICAL_COMPARE'].includes(snapshot.task) ||
      new TextEncoder().encode(JSON.stringify(snapshot)).length > 160000
    )
      throw new Error('INVALID_OPTIONAL_JOB');
    await this.references(snapshot);
    await this.pins(snapshot);
    const preview = await this.compile(snapshot, 'preview', now);
    const hash = await sha256(JSON.stringify(snapshot));
    await this.db
      .prepare(
        'INSERT INTO config_versions(config_id,owner_id,revision,payload_json,content_hash,created_at) VALUES(?,?,1,?,?,?) ON CONFLICT DO NOTHING',
      )
      .bind(
        'optional-action-' + nonce,
        this.context.ownerId,
        JSON.stringify(snapshot),
        hash,
        now.toISOString(),
      )
      .run();
    const intent = await this.db
      .prepare(
        'SELECT content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
      )
      .bind(this.context.ownerId, 'optional-action-' + nonce)
      .first<{ content_hash: string }>();
    if (intent?.content_hash !== hash) throw new Error('IDEMPOTENCY_CONFLICT');
    const job = await new JobStore(this.db, this.context).enqueue(
      {
        item_id: snapshot.item_id,
        source_id: null,
        task_type: snapshot.task,
        input_revision: snapshot.plan.hash,
        profile_revision: hash,
        prompt_snapshot_id: snapshot.prompt.prompt_hash,
        routing_policy_version: 'optional-selector:1',
        wire_schema_version: snapshot.prompt.wire.id.replace(
          'urn:bartosz:schema:',
          '',
        ),
        canonical_schema_version: snapshot.prompt.canonical.id.replace(
          'urn:bartosz:schema:',
          '',
        ),
        enrichment_version: '1.0',
        explicit_run_nonce: nonce,
        arrival_origin_at: now.toISOString(),
        origin_kind: 'MANUAL',
        payload: { snapshot },
        priority: 20,
        due_at: now.toISOString(),
      },
      now.toISOString(),
    );
    return {
      ...job,
      token_estimate: preview.token_estimate,
      selection_effect: 'NONE' as const,
    };
  }
  async prepare(token: LeaseToken, task: OptionalTask, now: Date) {
    this.context.requireTask(task);
    const guard = leasePredicate(this.context, token, now.toISOString(), task);
    const row = await this.db
      .prepare(
        `SELECT payload_json,profile_revision FROM jobs WHERE owner_id=? AND job_id=? AND ${guard.predicate}`,
      )
      .bind(this.context.ownerId, token.job_id, ...guard.bindings)
      .first<{ payload_json: string; profile_revision: string }>();
    if (!row) throw new Error('STALE_FENCE');
    const snapshot = (
      JSON.parse(row.payload_json) as { snapshot: OptionalTaskSnapshot }
    ).snapshot;
    if (
      !snapshot ||
      snapshot.version !== 'optional-ai-job:1' ||
      snapshot.task !== task ||
      (await sha256(JSON.stringify(snapshot))) !== row.profile_revision
    )
      throw new Error('OPTIONAL_SNAPSHOT_MISMATCH');
    await this.references(snapshot);
    await this.pins(snapshot);
    const runId =
      'optional_' +
      (await sha256(
        JSON.stringify({
          owner: this.context.ownerId,
          job: token.job_id,
          fence: token.fencing_token,
          snapshot_hash: row.profile_revision,
        }),
      ));
    const compiled = await this.compile(snapshot, runId, now);
    const recovery =
      snapshot.task === 'TRANSLATE' && snapshot.recovery
        ? await loadTranslationRecovery(
            this.db,
            this.context,
            snapshot.recovery.parent_run_id,
          )
        : null;
    const resultPlan = recovery?.plan ?? snapshot.plan;
    await this.db
      .prepare(
        `INSERT INTO analysis_runs(run_id,owner_id,item_id,job_id,input_snapshot_json,profile_snapshot_json,prompt_snapshot_json,wire_schema_version,canonical_schema_version,enrichment_version,routing_snapshot_json,state,created_at) SELECT ?,owner_id,item_id,job_id,?,?,?,wire_schema_version,canonical_schema_version,'1.0',?,'CANDIDATE',? FROM jobs WHERE owner_id=? AND job_id=? AND ${guard.predicate} ON CONFLICT(run_id) DO NOTHING`,
      )
      .bind(
        runId,
        JSON.stringify(resultPlan),
        JSON.stringify(snapshot.profile),
        JSON.stringify(snapshot.prompt),
        JSON.stringify({
          settings: snapshot.settings,
          quality_scope: compiled.request.quality_scope,
          snapshot_hash: row.profile_revision,
          request_plan_hash: snapshot.plan.hash,
          ...(snapshot.task === 'TRANSLATE' && snapshot.recovery
            ? { recovery: snapshot.recovery }
            : {}),
        }),
        now.toISOString(),
        this.context.ownerId,
        token.job_id,
        ...guard.bindings,
      )
      .run();
    const requestJson = JSON.stringify(compiled.request);
    await this.db
      .prepare(
        `INSERT INTO config_versions(config_id,owner_id,revision,payload_json,content_hash,created_at) SELECT ?,?,1,?,?,? WHERE ${guard.predicate} ON CONFLICT DO NOTHING`,
      )
      .bind(
        'optional-request-' + runId,
        this.context.ownerId,
        requestJson,
        await sha256(requestJson),
        now.toISOString(),
        ...guard.bindings,
      )
      .run();
    const saved = await this.db
      .prepare(
        'SELECT payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
      )
      .bind(this.context.ownerId, 'optional-request-' + runId)
      .first<{ payload_json: string; content_hash: string }>();
    if (!saved || (await sha256(saved.payload_json)) !== saved.content_hash)
      throw new Error('OPTIONAL_REQUEST_MISMATCH');
    const request = JSON.parse(saved.payload_json) as AIRequest;
    const stored = { ...request },
      fresh = { ...compiled.request };
    Reflect.deleteProperty(stored, 'deadline');
    Reflect.deleteProperty(fresh, 'deadline');
    if (
      JSON.stringify(stored) !== JSON.stringify(fresh) ||
      Date.parse(request.deadline) <= now.getTime()
    )
      throw new Error('OPTIONAL_REQUEST_MISMATCH');
    return { run_id: runId, snapshot, request };
  }
  async reserve(token: LeaseToken, task: OptionalTask, now: Date) {
    const prepared = await this.prepare(token, task, now);
    const buckets = await currentGeminiBuckets(
      this.db,
      this.context,
      prepared.request.profile,
      now,
    );
    return new QuotaAdmission(this.db, this.context, task).reserve(
      {
        request_id: prepared.run_id,
        account_key: prepared.request.profile.account_key,
        model: prepared.request.profile.model,
        input_tokens: prepared.request.estimated_input_tokens,
        buckets,
        paid_services_enabled: false,
      },
      token,
      now,
    );
  }
  async submit(
    token: LeaseToken,
    task: OptionalTask,
    reservationId: string,
    now: Date,
  ) {
    const prepared = await this.prepare(token, task, now);
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
      reservation?.request_id !== prepared.run_id ||
      reservation.input_tokens !== prepared.request.estimated_input_tokens
    )
      throw new Error('INVALID_AI_REQUEST_SCOPE');
    return new QuotaAdmission(this.db, this.context, task).submit(
      reservationId,
      token,
      now,
    );
  }
  async complete(
    token: LeaseToken,
    task: OptionalTask,
    reservationId: string,
    candidateId: string,
    now: Date,
    secret: string,
  ) {
    const started = Date.now(),
      current = () => new Date(now.getTime() + Date.now() - started);
    this.context.requireTask(task);
    if (token.lease_owner !== this.context.actorId)
      throw new Error('STALE_FENCE');
    const replay = await this.db
      .prepare(
        `SELECT r.run_id,r.outcome_json,r.candidate_hash,r.state,j.state AS job_state FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id JOIN quota_reservations q ON q.owner_id=r.owner_id AND q.request_id=r.run_id WHERE r.owner_id=? AND r.job_id=? AND j.task_type=? AND (r.state='ACCEPTED' OR (r.state='CANDIDATE' AND ((r.validation_outcome='DETERMINISTIC_CORE_CANDIDATE' AND j.state='SUCCEEDED' AND j.reason_code IN ('QUALITY_TEST_COMPLETE','OPTIONAL_PARTIAL_COMPLETE')) OR (r.validation_outcome='DETERMINISTIC_CORE_INVALID' AND j.state='FAILED' AND j.reason_code='OPTIONAL_INVALID_COMPLETE')))) AND q.reservation_id=? AND q.fencing_token=? AND EXISTS(SELECT 1 FROM worker_identities w WHERE w.owner_id=r.owner_id AND w.worker_id=? AND w.credential_hash=? AND w.revoked_at IS NULL)`,
      )
      .bind(
        this.context.ownerId,
        token.job_id,
        task,
        reservationId,
        token.fencing_token,
        this.context.actorId,
        this.context.credentialHash!,
      )
      .first<{
        run_id: string;
        outcome_json: string;
        candidate_hash: string;
        state: string;
        job_state: string;
      }>();
    if (replay) {
      if (
        (await sha256(replay.outcome_json)) !== replay.candidate_hash ||
        (JSON.parse(replay.outcome_json) as { response_artifact_id: string })
          .response_artifact_id !== candidateId
      )
        throw new Error('INVALID_OPTIONAL_CANDIDATE');
      return {
        accepted: replay.state === 'ACCEPTED',
        state: replay.job_state,
        ...(replay.state === 'CANDIDATE'
          ? {
              candidate_status:
                replay.job_state === 'FAILED' ? 'INVALID' : 'VALIDATED',
            }
          : {}),
        active: false,
        duplicate: true,
        run_id: replay.run_id,
      };
    }
    const prepared = await this.prepare(token, task, current()),
      { snapshot, run_id: runId } = prepared;
    await new AnalysisResponses(this.db, this.context, task).record(
      token,
      reservationId,
      candidateId,
      current(),
    );
    const repo = new ArtifactRepository(this.db, this.context);
    const candidate = await repo.readVerifiedText(
      candidateId,
      2 * 1024 * 1024,
      token,
      task,
      current(),
    );
    const provenance = JSON.parse(candidate.artifact.provenance_json) as {
      response: { request_id: string; status: AIResponse['status'] };
      raw_output_present: boolean;
    };
    if (
      candidate.artifact.item_id !== snapshot.item_id ||
      provenance.response.request_id !== runId ||
      !provenance.raw_output_present
    )
      throw new Error('INVALID_OPTIONAL_CANDIDATE');
    const response = {
      status: provenance.response.status,
      raw_output: candidate.text,
    };
    let mapped:
      | Awaited<ReturnType<typeof mapTranslation>>
      | Awaited<ReturnType<typeof mapHistory>>
      | Awaited<ReturnType<typeof composeTranslations>>;
    try {
      mapped =
        snapshot.task === 'TRANSLATE'
          ? await mapTranslation(snapshot.plan, response)
          : await mapHistory(snapshot.plan, response);
      if (snapshot.task === 'TRANSLATE' && snapshot.recovery) {
        const parent = await loadTranslationRecovery(
          this.db,
          this.context,
          snapshot.recovery.parent_run_id,
        );
        mapped = await composeTranslations(parent.plan, [
          { plan: parent.plan, mapped: parent.mapped },
          {
            plan: snapshot.plan,
            mapped: mapped as Awaited<ReturnType<typeof mapTranslation>>,
          },
        ]);
      }
    } catch (error) {
      // Only deterministic output failures are terminal. Internal plan/hash failures
      // must retain their original error for recovery instead of concealing a bug.
      const reasons = new Set([
        'NON_OUTER_REPAIR',
        'INVALID_ANALYSIS_ROOT',
        'DUPLICATE_JSON_KEY',
        'JSON_TOO_LARGE',
        'JSON_COMPLEXITY_LIMIT',
        'INVALID_JSON_STRING',
        'TRUNCATED_JSON',
        'INVALID_JSON_OBJECT',
        'INVALID_JSON_ARRAY',
        'INVALID_JSON_NUMBER',
        'INVALID_JSON_TOKEN',
        'TRAILING_JSON_CONTENT',
        'INVALID_TRANSLATION_WIRE',
        'TRANSLATION_RESPONSE_NOT_COMPLETE',
        'FOREIGN_TRANSLATION_REF',
        'DUPLICATE_TRANSLATION_REF',
        'EMPTY_TRANSLATION_SEGMENT',
        'TRANSLATION_ORDER_MISMATCH',
        'TRANSLATION_STATUS_MISMATCH',
        'INVALID_HISTORY_WIRE',
        'HISTORY_STATUS_MISMATCH',
        'MISSING_HISTORY_SIDE',
        'FOREIGN_HISTORY_OBSERVATION',
        'FOREIGN_HISTORY_EVIDENCE',
        'MISSING_HISTORY_OBSERVATION_EVIDENCE',
        'EMPTY_HISTORY_EXPLANATION',
      ]);
      const reason =
        error instanceof SyntaxError
          ? 'INVALID_JSON'
          : error instanceof Error && reasons.has(error.message)
            ? error.message
            : null;
      if (reason === null) throw error;
      return finalizeCandidateRun(
        this.db,
        this.context,
        token,
        runId,
        {
          version: 'optional-invalid:1',
          task,
          response_artifact_id: candidateId,
          plan_hash: snapshot.plan.hash,
          reason,
        },
        'OPTIONAL_INVALID_COMPLETE',
        current(),
        task,
      );
    }
    if (
      snapshot.settings.mode === 'QUALITY_TEST' ||
      ('coverage' in mapped && !mapped.coverage.complete) ||
      mapped.canonical.status === 'REFUSED'
    )
      return finalizeCandidateRun(
        this.db,
        this.context,
        token,
        runId,
        {
          version: 'optional-candidate:1',
          task,
          mapped,
          response_artifact_id: candidateId,
        },
        snapshot.settings.mode === 'QUALITY_TEST'
          ? 'QUALITY_TEST_COMPLETE'
          : 'OPTIONAL_PARTIAL_COMPLETE',
        current(),
        task,
      );
    const write = async (
      text: string,
      kind: ArtifactKind,
      schema: string,
      original: string | null,
    ) => {
      const parts = splitArtifactText(text),
        hash = await sha256(text);
      const artifact = await repo.begin(
        {
          item_id: snapshot.item_id,
          kind,
          content_hash: hash,
          byte_size: new TextEncoder().encode(text).length,
          chunk_count: parts.length,
          schema_version: schema,
          producer_version:
            'optional-source-mapper:1:' + runId + ':' + candidateId,
          original_ref: original,
          provenance: {
            run_id: runId,
            plan_hash: mapped.plan_hash,
            request_plan_hash: snapshot.plan.hash,
            ...(snapshot.task === 'TRANSLATE' && snapshot.recovery
              ? { recovery: snapshot.recovery }
              : {}),
            response_artifact_id: candidateId,
            semantic_verification: 'NOT_ASSERTED',
          },
        },
        token,
        task,
        current(),
      );
      if (artifact.state !== 'VERIFIED') {
        let offset = 0;
        for (const [i, part] of parts.entries()) {
          await repo.writeChunk(
            artifact.artifact_id,
            i,
            offset,
            part,
            token,
            task,
            current(),
          );
          offset += part.length;
        }
        let proof: string | undefined;
        for (;;) {
          const step = await repo.verifyStep(
            artifact.artifact_id,
            token,
            task,
            current(),
            secret,
            proof,
          );
          if (step.complete) break;
          proof = step.proof!;
        }
      }
      return artifact.artifact_id;
    };
    const source =
      snapshot.task === 'TRANSLATE'
        ? snapshot.plan.snapshot.source_artifact_id
        : null;
    const canonicalId = await write(
      JSON.stringify(mapped.canonical),
      'ANALYSIS_CANDIDATE',
      snapshot.prompt.canonical.id.replace('urn:bartosz:schema:', ''),
      source,
    );
    const translated = 'helper_text' in mapped ? mapped : null;
    const helperId = translated
      ? await write(
          translated.helper_text,
          'PL_HELPER',
          'translation-helper:1',
          source,
        )
      : null;
    const mappingId = translated
      ? await write(
          JSON.stringify(translated.mappings),
          'OFFSET_MAP',
          'translation-mapping:1',
          source,
        )
      : null;
    const outcome = {
      version: 'optional-accepted:1',
      response_artifact_id: candidateId,
      task,
      plan_hash: translated?.plan_hash ?? snapshot.plan.hash,
      request_plan_hash: snapshot.plan.hash,
      canonical_artifact_id: canonicalId,
      canonical_hash: mapped.canonical_hash,
      helper_artifact_id: helperId,
      mapping_artifact_id: mappingId,
      source_artifact_id: source,
      source_hash: translated?.source_hash ?? null,
      coverage: translated?.coverage ?? {
        current:
          snapshot.task === 'HISTORICAL_COMPARE'
            ? snapshot.plan.snapshot.current.observations.length
            : 0,
        prior:
          snapshot.task === 'HISTORICAL_COMPARE'
            ? snapshot.plan.snapshot.prior.observations.length
            : 0,
      },
      semantic_verification: 'NOT_ASSERTED',
    };
    return new RunRepository(this.db, this.context).complete(
      token,
      task,
      runId,
      await sha256(JSON.stringify(outcome)),
      outcome,
      null,
      current(),
      (guard, bindings) => [
        this.db
          .prepare(
            `INSERT INTO optional_ai_results(owner_id,item_id,run_id,task_type,plan_hash,canonical_artifact_id,canonical_hash,helper_artifact_id,mapping_artifact_id,source_artifact_id,source_hash,coverage_json,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT DO NOTHING`,
          )
          .bind(
            this.context.ownerId,
            snapshot.item_id,
            runId,
            task,
            outcome.plan_hash,
            canonicalId,
            mapped.canonical_hash,
            helperId,
            mappingId,
            source,
            translated?.source_hash ?? null,
            JSON.stringify(outcome.coverage),
            current().toISOString(),
            ...bindings,
          ),
      ],
      {
        // Recheck all contributing sources inside the acceptance transaction. A
        // successful prepare is insufficient if privacy changes while artifacts
        // are being retained or verified.
        predicate: `NOT EXISTS(SELECT 1 FROM json_each(?) requested WHERE NOT EXISTS(SELECT 1 FROM items i JOIN sources s ON s.owner_id=i.owner_id AND s.source_id=i.source_id WHERE i.owner_id=? AND i.item_id=requested.value AND i.availability='PUBLIC' AND s.access_state='PUBLIC' AND s.ai_processing_allowed=1))`,
        bindings: [
          JSON.stringify(
            snapshot.task === 'TRANSLATE'
              ? [snapshot.item_id]
              : [
                  ...new Set([
                    snapshot.item_id,
                    ...snapshot.plan.snapshot.current.observations.map(
                      (r) => r.item_id,
                    ),
                    ...snapshot.plan.snapshot.prior.observations.map(
                      (r) => r.item_id,
                    ),
                  ]),
                ],
          ),
          this.context.ownerId,
        ],
      },
    );
  }
}
