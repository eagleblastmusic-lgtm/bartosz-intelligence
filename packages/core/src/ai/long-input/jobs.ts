import {
  assertContext,
  type AccessContext,
  type Database,
} from '../../db/boundary.js';
import { ArtifactRepository } from '../../artifacts/store.js';
import { sha256 } from '../../auth/crypto.js';
import { JobStore } from '../../jobs/store.js';
import { leasePredicate } from '../../jobs/lease-guard.js';
import type { LeaseToken } from '../../../../contracts/src/jobs.js';
import type { JobInput } from '../../../../contracts/src/jobs.js';
import { jobDedup } from '../../jobs/policy.js';
import { AnalysisJobs, type AnalysisJobSnapshot } from '../jobs.js';
import {
  analysisQualityScope,
  economyChunkContextHash,
  economyPromptOverhead,
} from '../compiler.js';
import { selectPipeline } from '../selector.js';
import { verifyChunkPlan, type ChunkPlan } from './plan.js';
import type { normalizeTranscript } from '../../transcript/normalize.js';
type Manifest = Awaited<ReturnType<typeof normalizeTranscript>>['manifest'];
interface Catalog {
  version: 'chunk-jobs:1';
  parent_snapshot_hash: string;
  plan_artifact_id: string;
  plan_hash: string;
  quality_scope: string;
  expected: { chunk_index: number; dedup_key: string }[];
}

// Cloud stores the same durable Job contracts for every part. Creating parts
// never accepts canonical knowledge or makes an additional synthesis request.
export class LongInputJobs {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async create(token: LeaseToken, planArtifactId: string, now: Date) {
    const started = Date.now(),
      current = () => new Date(now.getTime() + Date.now() - started);
    const prepared = await new AnalysisJobs(this.db, this.context).load(
      token,
      current(),
    );
    const snapshot = prepared.snapshot;
    if (snapshot.chunk) throw new Error('CHUNK_CANNOT_CREATE_CHILDREN');
    const artifacts = new ArtifactRepository(this.db, this.context);
    const stored = await artifacts.readVerifiedText(
      planArtifactId,
      32 * 1024 * 1024,
      token,
      'ANALYZE',
      current(),
    );
    if (
      stored.artifact.kind !== 'NORMALIZED' ||
      stored.artifact.schema_version !== 'chunk-plan:1' ||
      stored.artifact.producer_version !== 'chunk-planner:1' ||
      stored.artifact.original_ref !== snapshot.source.source_artifact_id
    )
      throw new Error('INVALID_CHUNK_PLAN_ARTIFACT');
    const plan = JSON.parse(stored.text) as ChunkPlan;
    const map = await artifacts.readVerifiedText(
      snapshot.source.segment_map_artifact_id,
      32 * 1024 * 1024,
      token,
      'ANALYZE',
      current(),
    );
    if (map.artifact.content_hash !== snapshot.source.manifest_hash)
      throw new Error('CHUNK_SOURCE_MISMATCH');
    await verifyChunkPlan(
      plan,
      stored.artifact.content_hash,
      JSON.parse(map.text) as Manifest,
      map.artifact.content_hash,
    );
    const semantic = snapshot.semantic_context ?? {
      title: null,
      author: null,
      published_at: null,
      source_language: snapshot.source.language_code,
    };
    if (
      plan.chunks.length > 128 ||
      plan.prompt_overhead_tokens !==
        economyPromptOverhead({
          semantic_profile: snapshot.semantic_profile?.compiled,
          prompt: snapshot.prompt,
          semantic_context: semantic,
          limits: snapshot.settings.limits,
        }) ||
      plan.context_tokens !== snapshot.profile.context_tokens ||
      plan.output_tokens !== snapshot.settings.max_output_tokens ||
      plan.context_hash !==
        (await economyChunkContextHash({
          manifest_hash: snapshot.source.manifest_hash,
          prompt: snapshot.prompt,
          profile: snapshot.profile,
          profile_revision: prepared.snapshot_hash,
          max_output_tokens: snapshot.settings.max_output_tokens,
          limits: snapshot.settings.limits,
          semantic_context: snapshot.semantic_context ?? {
            title: null,
            author: null,
            published_at: null,
            source_language: snapshot.source.language_code,
          },
        }))
    )
      throw new Error('CHUNK_CONTEXT_MISMATCH');
    const scope = await analysisQualityScope(
      snapshot.prompt,
      snapshot.profile,
      {
        limits: snapshot.settings.limits,
        max_output_tokens: snapshot.settings.max_output_tokens,
        source_language: snapshot.source.language_code,
        analysis_mode: 'CHUNK',
      },
    );
    const selected = selectPipeline([snapshot.profile], {
      profile_id: 'gemini_free',
      purpose: snapshot.settings.purpose,
      region: snapshot.settings.region,
      task_type: snapshot.semantic_profile?.compiled.config.mode ?? 'ECONOMY',
      runtime: snapshot.settings.runtime,
      mode: snapshot.settings.mode,
      quality_scope: scope,
      input_tokens: 0,
      output_tokens: snapshot.settings.max_output_tokens,
      now: current(),
      paid_services_enabled: false,
    });
    if (!selected.profile) throw new Error('CHUNK_PROFILE_' + selected.reason);
    const store = new JobStore(this.db, this.context);
    const inputs: JobInput[] = [],
      expected: Catalog['expected'] = [];
    for (const part of plan.chunks) {
      const child: AnalysisJobSnapshot = {
        ...snapshot,
        quality_scope: scope,
        chunk: {
          parent_job_id: token.job_id,
          parent_snapshot_hash: prepared.snapshot_hash,
          plan_artifact_id: planArtifactId,
          plan_hash: stored.artifact.content_hash,
          chunk_index: part.chunk_index,
        },
      };
      const input: JobInput = {
        item_id: snapshot.source.item_id,
        source_id: null,
        task_type: 'ANALYZE',
        input_revision: snapshot.source.source_hash,
        profile_revision: await sha256(JSON.stringify(child)),
        prompt_snapshot_id: snapshot.prompt.prompt_hash,
        routing_policy_version: 'pipeline-selector:1',
        wire_schema_version: 'economy-wire:1.0',
        canonical_schema_version: 'intelligence-canonical:1.2',
        enrichment_version: '1.0',
        explicit_run_nonce:
          'chunk:' +
          token.job_id +
          ':' +
          stored.artifact.content_hash +
          ':' +
          part.chunk_index,
        payload: { snapshot: child },
        origin_kind: 'MANUAL',
        arrival_origin_at: current().toISOString(),
        due_at: current().toISOString(),
        priority: snapshot.settings.mode === 'QUALITY_TEST' ? 20 : 60,
      };
      expected.push({
        chunk_index: part.chunk_index,
        dedup_key: await jobDedup(this.context.ownerId, input),
      });
      inputs.push(input);
    }
    const catalog: Catalog = {
      version: 'chunk-jobs:1',
      parent_snapshot_hash: prepared.snapshot_hash,
      plan_artifact_id: planArtifactId,
      plan_hash: stored.artifact.content_hash,
      quality_scope: scope,
      expected,
    };
    const payload = JSON.stringify(catalog),
      hash = await sha256(payload),
      key = 'analysis-chunks-' + token.job_id;
    let guard: {
      predicate: string;
      bindings: readonly (string | number | null)[];
    } = leasePredicate(this.context, token, current().toISOString(), 'ANALYZE');
    const prior = await this.db
      .prepare(
        'SELECT content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
      )
      .bind(this.context.ownerId, key)
      .first<{ content_hash: string }>();
    if (prior && prior.content_hash !== hash)
      throw new Error('IMMUTABLE_CHUNK_PLAN_CONFLICT');
    if (!prior) {
      await this.db
        .prepare(
          `INSERT INTO config_versions(config_id,owner_id,revision,payload_json,content_hash,created_at) SELECT ?,?,1,?,?,? WHERE ${guard.predicate} ON CONFLICT DO NOTHING`,
        )
        .bind(
          key,
          this.context.ownerId,
          payload,
          hash,
          current().toISOString(),
          ...guard.bindings,
        )
        .run();
      const saved = await this.db
        .prepare(
          'SELECT content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
        )
        .bind(this.context.ownerId, key)
        .first<{ content_hash: string }>();
      if (!saved) throw new Error('STALE_FENCE');
      if (saved.content_hash !== hash)
        throw new Error('IMMUTABLE_CHUNK_PLAN_CONFLICT');
    }
    // Missing pages survive a process crash. Enqueue at most eight parts in
    // one invocation; each part repeats the lease guard and owns an outbox row.
    const existing = await this.db
      .prepare(
        `SELECT dedup_key FROM jobs WHERE owner_id=? AND dedup_key IN (SELECT value FROM json_each(?))`,
      )
      .bind(
        this.context.ownerId,
        JSON.stringify(expected.map((part) => part.dedup_key)),
      )
      .all<{ dedup_key: string }>();
    const found = new Set(existing.results.map((row) => row.dedup_key));
    const missing = expected.filter((part) => !found.has(part.dedup_key));
    const page = missing.slice(0, 8);
    const finished = missing.length <= 8;
    const at = current().toISOString(),
      due = new Date(current().getTime() + 60000).toISOString();
    const lease = leasePredicate(this.context, token, at, 'ANALYZE');
    guard = {
      predicate:
        lease.predicate +
        " AND ?>? AND EXISTS(SELECT 1 FROM items i JOIN sources s ON s.owner_id=i.owner_id AND s.source_id=i.source_id WHERE i.owner_id=? AND i.item_id=? AND s.ai_processing_allowed=1 AND s.access_state='PUBLIC' AND i.availability='PUBLIC')",
      bindings: [
        ...lease.bindings,
        snapshot.profile.eligibility_expires_at,
        at,
        this.context.ownerId,
        snapshot.source.item_id,
      ],
    };
    const statements = [];
    for (const part of page)
      statements.push(
        ...(await store.prepareEnqueue(inputs[part.chunk_index]!, at, guard))
          .statements,
      );
    // The immutable catalog is initialized before any page. Each page is
    // atomic. The parent remains RUNNING until every child has a durable
    // outbox row; replay resumes only missing parts.
    const result = await this.db.batch([
      ...statements,
      ...(finished
        ? [
            this.db
              .prepare(
                `UPDATE job_attempts SET finished_at=?,error_code='CHUNKS_PENDING' WHERE owner_id=? AND job_id=? AND fencing_token=? AND ${guard.predicate}`,
              )
              .bind(
                at,
                this.context.ownerId,
                token.job_id,
                token.fencing_token,
                ...guard.bindings,
              ),
            this.db
              .prepare(
                `UPDATE jobs SET state='DEFERRED',reason_code='CHUNKS_PENDING',due_at=?,updated_at=?,lease_owner=NULL,lease_until=NULL WHERE owner_id=? AND job_id=? AND ${guard.predicate}`,
              )
              .bind(
                due,
                at,
                this.context.ownerId,
                token.job_id,
                ...guard.bindings,
              ),
          ]
        : []),
      this.db
        .prepare(
          `SELECT 1 AS live WHERE ${finished ? "EXISTS(SELECT 1 FROM jobs WHERE owner_id=? AND job_id=? AND state='DEFERRED' AND reason_code='CHUNKS_PENDING' AND fencing_token=?)" : guard.predicate}`,
        )
        .bind(
          ...(finished
            ? [this.context.ownerId, token.job_id, token.fencing_token]
            : guard.bindings),
        ),
    ]);
    if ((result.at(-1)?.results?.[0] as { live?: number })?.live !== 1)
      throw new Error('STALE_FENCE');
    return {
      plan_hash: catalog.plan_hash,
      expected_chunks: expected.length,
      state: finished ? ('DEFERRED' as const) : ('RUNNING' as const),
      children_created: expected.length - missing.length + page.length,
      preparation_complete: finished,
      complete: false,
      due_at: due,
    };
  }
  async status(parentJobId: string) {
    if (this.context.kind === 'owner') this.context.requireOwner();
    else this.context.requireTask('ANALYZE');
    const row = await this.db
      .prepare(
        'SELECT payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
      )
      .bind(this.context.ownerId, 'analysis-chunks-' + parentJobId)
      .first<{ payload_json: string; content_hash: string }>();
    if (!row || (await sha256(row.payload_json)) !== row.content_hash)
      throw new Error('CHUNK_CATALOG_REQUIRED');
    const catalog = JSON.parse(row.payload_json) as Catalog;
    const states = new Map<
      string,
      { job_id: string; state: string; reason_code: string | null }
    >();
    for (let offset = 0; offset < catalog.expected.length; offset += 16) {
      const keys = catalog.expected
        .slice(offset, offset + 16)
        .map((x) => x.dedup_key);
      const result = await this.db
        .prepare(
          `SELECT job_id,dedup_key,state,reason_code FROM jobs WHERE owner_id=? AND dedup_key IN (${keys.map(() => '?').join(',')})`,
        )
        .bind(this.context.ownerId, ...keys)
        .all<{
          job_id: string;
          dedup_key: string;
          state: string;
          reason_code: string | null;
        }>();
      for (const item of result.results) states.set(item.dedup_key, item);
    }
    const parts = catalog.expected.map((part) => ({
      chunk_index: part.chunk_index,
      job_id: states.get(part.dedup_key)?.job_id ?? null,
      state: states.get(part.dedup_key)?.state ?? 'MISSING',
      completed:
        states.get(part.dedup_key)?.state === 'SUCCEEDED' &&
        states.get(part.dedup_key)?.reason_code === 'CHUNK_CANDIDATE_COMPLETE',
    }));
    return {
      plan_hash: catalog.plan_hash,
      plan_artifact_id: catalog.plan_artifact_id,
      parent_snapshot_hash: catalog.parent_snapshot_hash,
      expected: parts.length,
      parts,
      missing: parts.filter((x) => !x.completed).map((x) => x.chunk_index),
      complete: parts.every((x) => x.completed),
      accepted: false as const,
    };
  }
}
