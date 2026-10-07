import { sha256 } from '../auth/crypto.js';
import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { validateLabControls, type LabControls } from './lab.js';
import { AnalysisJobs, type AnalysisJobSnapshot } from '../ai/jobs.js';
import { OptionalTaskPreparation } from '../ai/tasks/preparation.js';
import type { OptionalTaskSnapshot } from '../ai/tasks/jobs.js';
import { LabQuotaPolicies } from './lab-quota.js';
import { PromptTests } from './test.js';
type PreviewRef = { kind: 'ANALYSIS' | 'OPTIONAL'; hash: string };
type Receipt = {
  version: string;
  prepared_at: string;
  snapshot: AnalysisJobSnapshot | OptionalTaskSnapshot;
  chunk_policy?: unknown;
};
export class PromptLab {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  private async read(key: string) {
    this.context.requireOwner();
    const row = await this.db
      .prepare(
        'SELECT payload_json,content_hash,created_at FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
      )
      .bind(this.context.ownerId, key)
      .first<{
        payload_json: string;
        content_hash: string;
        created_at: string;
      }>();
    if (!row) throw new Error('NOT_FOUND');
    if ((await sha256(row.payload_json)) !== row.content_hash)
      throw new Error('REGISTRY_HASH_MISMATCH');
    return { ...row, value: JSON.parse(row.payload_json) };
  }
  async preparePair(
    input: Parameters<PromptTests['preview']>[0] & {
      comparison_version: number;
      repeats: 1 | 3;
      reason: string;
    },
    now: Date,
  ) {
    this.context.requireOwner();
    if (
      input.version === input.comparison_version ||
      ![1, 3].includes(input.repeats)
    )
      throw new Error('INVALID_LAB_EXPERIMENT');
    const tests = new PromptTests(this.db, this.context);
    const a = await tests.preview(input, now),
      b = await tests.preview(
        { ...input, version: input.comparison_version },
        now,
      );
    const kind = a.kind;
    if (kind !== b.kind) throw new Error('LAB_CONTROL_MISMATCH');
    const prefix =
      kind === 'ANALYSIS' ? 'analysis-preview-' : 'optional-preview-';
    const first = (await this.read(prefix + a.preview_hash)).value as Receipt,
      second = (await this.read(prefix + b.preview_hash)).value as Receipt;
    const source =
      'source' in first.snapshot
        ? first.snapshot.source.source_hash
        : first.snapshot.task === 'TRANSLATE'
          ? first.snapshot.plan.snapshot.source_hash
          : first.snapshot.plan.hash;
    const variant = (id: 'A' | 'B', receipt: Receipt) => ({
      id,
      provider: receipt.snapshot.profile.provider_id,
      model: receipt.snapshot.profile.model,
      model_revision: receipt.snapshot.profile.revision,
      prompt_hash: receipt.snapshot.prompt.prompt_hash,
      wire_hash: receipt.snapshot.prompt.wire.hash,
      canonical_hash: receipt.snapshot.prompt.canonical.hash,
      reasoning: 'low',
      max_output_tokens: input.max_output_tokens,
      seed: null,
    });
    return this.create(
      {
        controls: {
          version: 'lab-controls:1',
          mode: 'PROMPT_AB',
          source_hashes: [source],
          repeats: input.repeats,
          variants: [variant('A', first), variant('B', second)],
          confounders: ['SEED_UNAVAILABLE', 'PROVIDER_NONDETERMINISM'],
        },
        pairs: Array.from({ length: input.repeats }, (_, index) => ({
          source_hash: source,
          repeat: index + 1,
          a: { kind, hash: a.preview_hash },
          b: { kind, hash: b.preview_hash },
        })),
        reason: input.reason,
      },
      now,
    );
  }
  async create(
    input: {
      controls: LabControls;
      pairs: {
        source_hash: string;
        repeat: number;
        a: PreviewRef;
        b: PreviewRef;
      }[];
      reason: string;
    },
    now: Date,
  ) {
    this.context.requireOwner();
    const controls = validateLabControls(input.controls);
    if (
      !Number.isFinite(now.getTime()) ||
      typeof input.reason !== 'string' ||
      !input.reason.trim() ||
      input.reason.length > 1000 ||
      !Array.isArray(input.pairs) ||
      input.pairs.length !== controls.source_hashes.length * controls.repeats
    )
      throw new Error('INVALID_LAB_EXPERIMENT');
    const policy = await new LabQuotaPolicies(this.db, this.context).current();
    if (!policy) throw new Error('QUOTA_LAB_POLICY_NOT_CONFIGURED');
    const seen = new Set<string>(),
      receipts: Receipt[] = [];
    for (const pair of input.pairs) {
      const key = pair.source_hash + ':' + pair.repeat;
      if (
        !pair ||
        !pair.a ||
        !pair.b ||
        !controls.source_hashes.includes(pair.source_hash) ||
        !Number.isSafeInteger(pair.repeat) ||
        pair.repeat < 1 ||
        pair.repeat > controls.repeats ||
        seen.has(key) ||
        pair.a.kind !== pair.b.kind
      )
        throw new Error('INVALID_LAB_PAIR');
      seen.add(key);
      const pairReceipts: Receipt[] = [];
      for (const [index, ref] of [pair.a, pair.b].entries()) {
        if (
          !['ANALYSIS', 'OPTIONAL'].includes(ref.kind) ||
          !/^[a-f0-9]{64}$/.test(ref.hash)
        )
          throw new Error('INVALID_LAB_PREVIEW');
        const stored = await this.read(
            (ref.kind === 'ANALYSIS'
              ? 'analysis-preview-'
              : 'optional-preview-') + ref.hash,
          ),
          value = stored.value as Receipt;
        const s = value.snapshot,
          variant = controls.variants[index]!;
        if (
          value.prepared_at !== stored.created_at ||
          !Number.isFinite(Date.parse(value.prepared_at)) ||
          Date.parse(value.prepared_at) > now.getTime() ||
          now.getTime() - Date.parse(value.prepared_at) > 900000 ||
          value.version !==
            (ref.kind === 'ANALYSIS'
              ? 'explicit-analysis-preview:1'
              : 'optional-preview:1') ||
          value.chunk_policy ||
          s.settings.mode !== 'QUALITY_TEST' ||
          s.settings.runtime !== 'local' ||
          s.profile.profile_id !== 'gemini_free' ||
          !s.profile.free_eligible ||
          s.profile.billing_enabled ||
          s.profile.account_key !== policy.policy.account_key ||
          s.profile.model !== policy.policy.model ||
          s.profile.provider_id !== variant.provider ||
          s.profile.model !== variant.model ||
          s.profile.revision !== variant.model_revision ||
          s.prompt.prompt_hash !== variant.prompt_hash ||
          s.prompt.wire.hash !== variant.wire_hash ||
          s.prompt.canonical.hash !== variant.canonical_hash ||
          s.settings.max_output_tokens !== variant.max_output_tokens ||
          variant.reasoning !== 'low'
        )
          throw new Error('LAB_PREVIEW_CONTROL_MISMATCH');
        const actualSource =
          'source' in s
            ? s.source.source_hash
            : s.task === 'TRANSLATE'
              ? s.plan.snapshot.source_hash
              : s.plan.hash;
        if (
          actualSource !== pair.source_hash ||
          ('additional_pass' in s && s.additional_pass) ||
          ('recovery' in s && s.recovery)
        )
          throw new Error('LAB_SOURCE_CONTROL_MISMATCH');
        pairReceipts.push(value);
      }
      const comparable = (value: Receipt) => {
        const s = value.snapshot;
        return 'source' in s
          ? {
              source: s.source,
              settings: s.settings,
              semantic_profile: s.semantic_profile,
              semantic_context: s.semantic_context,
            }
          : {
              item_id: s.item_id,
              task: s.task,
              settings: s.settings,
              plan: s.plan,
              ...(s.task === 'TRANSLATE'
                ? { glossary: s.glossary, selected_run_id: s.selected_run_id }
                : {}),
            };
      };
      if (
        JSON.stringify(comparable(pairReceipts[0]!)) !==
        JSON.stringify(comparable(pairReceipts[1]!))
      )
        throw new Error('LAB_INPUT_SNAPSHOT_MISMATCH');
      receipts.push(...pairReceipts);
    }
    const definition = {
      version: 'prompt-lab:1',
      controls,
      pairs: input.pairs,
      reason: input.reason.trim(),
      created_by: this.context.actorId,
    };
    const hash = await sha256(JSON.stringify(definition)),
      statements = [];
    const cases = [];
    for (const [index, receipt] of receipts.entries()) {
      const pair = input.pairs[Math.floor(index / 2)]!,
        variant = index % 2 === 0 ? 'A' : 'B',
        ref = variant === 'A' ? pair.a : pair.b;
      const marked = {
        ...receipt,
        snapshot: {
          ...receipt.snapshot,
          workload: 'PROMPT_LAB',
          lab_experiment_hash: hash,
          lab_case_index: index,
        },
      };
      const serialized = JSON.stringify(marked),
        previewHash = await sha256(serialized);
      statements.push(
        this.db
          .prepare(
            'INSERT INTO config_versions VALUES(?,?,1,?,?,?) ON CONFLICT DO NOTHING',
          )
          .bind(
            (ref.kind === 'ANALYSIS'
              ? 'analysis-preview-'
              : 'optional-preview-') + previewHash,
            this.context.ownerId,
            serialized,
            previewHash,
            receipt.prepared_at,
          ),
      );
      cases.push({
        source_hash: pair.source_hash,
        repeat: pair.repeat,
        variant,
        kind: ref.kind,
        preview_hash: previewHash,
      });
    }
    const value = { ...definition, cases },
      serialized = JSON.stringify(value),
      contentHash = await sha256(serialized);
    statements.push(
      this.db
        .prepare(
          'INSERT INTO config_versions VALUES(?,?,1,?,?,?) ON CONFLICT DO NOTHING',
        )
        .bind(
          'prompt-lab-' + hash,
          this.context.ownerId,
          serialized,
          contentHash,
          now.toISOString(),
        ),
    );
    statements.push(
      this.db
        .prepare(
          "INSERT INTO audit_events SELECT ?,?,?,'PROMPT_LAB_CREATED',?,?,? WHERE changes()=1 ON CONFLICT DO NOTHING",
        )
        .bind(
          'prompt-lab-created-' + this.context.ownerId + '-' + hash,
          this.context.ownerId,
          this.context.actorId,
          hash,
          contentHash,
          now.toISOString(),
        ),
    );
    await this.db.batch(statements);
    return { experiment_hash: hash, ...value };
  }
  async list(before: string | null = null) {
    this.context.requireOwner();
    let cut: { created_at: string; config_id: string } | null = null;
    if (before !== null) {
      if (!/^[a-f0-9]{64}$/.test(before)) throw new Error('INVALID_LAB_CURSOR');
      cut = await this.db
        .prepare(
          'SELECT created_at,config_id FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
        )
        .bind(this.context.ownerId, 'prompt-lab-' + before)
        .first<{ created_at: string; config_id: string }>();
      if (!cut) throw new Error('INVALID_LAB_CURSOR');
    }
    const rows = await this.db
      .prepare(
        "SELECT config_id,payload_json,content_hash,created_at FROM config_versions WHERE owner_id=? AND revision=1 AND config_id LIKE 'prompt-lab-%' AND json_extract(payload_json,'$.version')='prompt-lab:1' AND (? IS NULL OR created_at<? OR (created_at=? AND config_id<?)) ORDER BY created_at DESC,config_id DESC LIMIT 21",
      )
      .bind(
        this.context.ownerId,
        cut?.created_at ?? null,
        cut?.created_at ?? null,
        cut?.created_at ?? null,
        cut?.config_id ?? null,
      )
      .all<{
        config_id: string;
        payload_json: string;
        content_hash: string;
        created_at: string;
      }>();
    const items = [];
    for (const row of rows.results.slice(0, 20)) {
      if ((await sha256(row.payload_json)) !== row.content_hash)
        throw new Error('REGISTRY_HASH_MISMATCH');
      const value = JSON.parse(row.payload_json) as Awaited<
        ReturnType<PromptLab['create']>
      >;
      items.push({
        experiment_hash: row.config_id.slice('prompt-lab-'.length),
        created_at: row.created_at,
        reason: value.reason,
        mode: value.controls.mode,
        source_count: value.controls.source_hashes.length,
        case_count: value.cases.length,
      });
    }
    return {
      items,
      next_before:
        rows.results.length > 20 ? items.at(-1)!.experiment_hash : null,
    };
  }
  async get(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('INVALID_LAB_EXPERIMENT');
    const row = await this.read('prompt-lab-' + hash);
    const { cases, ...definition } = row.value;
    if (
      (await sha256(JSON.stringify(definition))) !== hash ||
      definition.version !== 'prompt-lab:1' ||
      !Array.isArray(cases)
    )
      throw new Error('REGISTRY_HASH_MISMATCH');
    const jobs = await this.db
      .prepare(
        "SELECT j.job_id,j.state,j.reason_code,json_extract(j.payload_json,'$.snapshot.lab_case_index') case_index,r.run_id,r.state run_state,r.validation_outcome,r.candidate_hash FROM jobs j LEFT JOIN analysis_runs r ON r.owner_id=j.owner_id AND r.job_id=j.job_id WHERE j.owner_id=? AND json_extract(j.payload_json,'$.snapshot.lab_experiment_hash')=? AND json_extract(j.payload_json,'$.snapshot.workload')='PROMPT_LAB' ORDER BY j.created_at,j.job_id,r.run_id LIMIT 301",
      )
      .bind(this.context.ownerId, hash)
      .all<{
        job_id: string;
        state: string;
        reason_code: string | null;
        case_index: number;
        run_id: string | null;
        run_state: string | null;
        validation_outcome: string | null;
        candidate_hash: string | null;
      }>();
    const cancelled = await this.db
      .prepare(
        'SELECT content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
      )
      .bind(this.context.ownerId, 'prompt-lab-cancel-' + hash)
      .first<string>('content_hash');
    return {
      experiment_hash: hash,
      definition: row.value as Omit<
        Awaited<ReturnType<PromptLab['create']>>,
        'experiment_hash'
      >,
      cancelled: cancelled !== null,
      jobs: jobs.results,
      history_truncated: jobs.results.length > 300,
    };
  }
  async submit(hash: string, index: number, now: Date) {
    const experiment = await this.get(hash);
    if (experiment.cancelled) throw new Error('LAB_EXPERIMENT_CANCELLED');
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      !experiment.definition.cases[index]
    )
      throw new Error('INVALID_LAB_CASE');
    const trial = experiment.definition.cases[index]!;
    // A deterministic UUID makes lost acknowledgements/retries refer to the same job.
    const nonceHash = await sha256(hash + ':' + index),
      nonce = `${nonceHash.slice(0, 8)}-${nonceHash.slice(8, 12)}-4${nonceHash.slice(13, 16)}-8${nonceHash.slice(17, 20)}-${nonceHash.slice(20, 32)}`;
    const existing = await this.db
      .prepare(
        "SELECT job_id,state FROM jobs WHERE owner_id=? AND explicit_run_nonce=? AND json_extract(payload_json,'$.snapshot.lab_experiment_hash')=? AND json_extract(payload_json,'$.snapshot.lab_case_index')=?",
      )
      .bind(this.context.ownerId, nonce, hash, index)
      .first<{ job_id: string; state: string }>();
    if (existing) return { ...existing, already_queued: true };
    return trial.kind === 'ANALYSIS'
      ? new AnalysisJobs(this.db, this.context).confirmExplicit(
          trial.preview_hash,
          nonce,
          now,
        )
      : new OptionalTaskPreparation(this.db, this.context).confirm(
          trial.preview_hash,
          nonce,
          now,
        );
  }
  async cancel(hash: string, reason: string, now: Date) {
    await this.get(hash);
    if (
      typeof reason !== 'string' ||
      !reason.trim() ||
      reason.length > 1000 ||
      !Number.isFinite(now.getTime())
    )
      throw new Error('INVALID_LAB_CANCELLATION');
    const value = {
        experiment_hash: hash,
        reason: reason.trim(),
        created_by: this.context.actorId,
        created_at: now.toISOString(),
      },
      serialized = JSON.stringify(value),
      contentHash = await sha256(serialized);
    await this.db.batch([
      this.db
        .prepare(
          'INSERT INTO config_versions VALUES(?,?,1,?,?,?) ON CONFLICT DO NOTHING',
        )
        .bind(
          'prompt-lab-cancel-' + hash,
          this.context.ownerId,
          serialized,
          contentHash,
          now.toISOString(),
        ),
      this.db
        .prepare(
          "INSERT INTO audit_events SELECT ?,?,?,'PROMPT_LAB_CANCELLED',?,?,? WHERE changes()=1 ON CONFLICT DO NOTHING",
        )
        .bind(
          'prompt-lab-cancelled-' + this.context.ownerId + '-' + hash,
          this.context.ownerId,
          this.context.actorId,
          hash,
          contentHash,
          now.toISOString(),
        ),
    ]);
    return this.get(hash);
  }
}
