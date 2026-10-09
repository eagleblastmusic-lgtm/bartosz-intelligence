import { randomUUID } from 'node:crypto';
import {
  AccessContext,
  type Database,
} from '../../../packages/core/src/db/boundary.js';
import { sha256, randomToken } from '../../../packages/core/src/auth/crypto.js';
import { JobStore } from '../../../packages/core/src/jobs/store.js';
import {
  AnalysisJobs,
  type AnalysisJobSnapshot,
} from '../../../packages/core/src/ai/jobs.js';
import { ModelRegistry } from '../../../packages/core/src/ai/models.js';
import {
  compileEconomy,
  compileSemanticAnalysis,
} from '../../../packages/core/src/ai/compiler.js';
import {
  QuotaAdmission,
  type AdmissionBucket,
} from '../../../packages/core/src/ai/admission.js';
import { AnalysisDisposition } from '../../../packages/core/src/ai/disposition.js';
import { ArtifactRepository } from '../../../packages/core/src/artifacts/store.js';

// Uses restored pending analysis and its genuine source. Quota/response are
// injected into isolated D1; no provider admission or live generation is claimed.
export async function drillMalformed(
  db: Database,
  owner: AccessContext,
  now: Date,
) {
  const existing = await db
    .prepare(
      "SELECT job_id FROM jobs WHERE owner_id=? AND task_type='ANALYZE' AND state='PENDING' AND json_extract(payload_json,'$.snapshot.version')='analysis-job:1' ORDER BY job_id LIMIT 1",
    )
    .bind(owner.ownerId)
    .first<{ job_id: string }>();
  if (!existing) throw new Error('RESTORED_ANALYSIS_DRILL_REQUIRED');
  const payload = await db
    .prepare('SELECT payload_json FROM jobs WHERE job_id=?')
    .bind(existing.job_id)
    .first<string>('payload_json');
  const restored = (JSON.parse(payload!) as { snapshot: AnalysisJobSnapshot })
    .snapshot;
  const models = new ModelRegistry(db, owner);
  const latest = await models.latest('gemini_free');
  // Fresh synthetic eligibility is isolated; historical snapshots stay immutable.
  await models.publish(
    {
      ...restored.profile,
      revision: latest!.revision + 1,
      eligibility_expires_at: new Date(now.getTime() + 3600000).toISOString(),
      quality_approvals: [],
    },
    now,
  );
  const queued = (await new AnalysisJobs(db, owner).enqueue(
    restored.source.run_id,
    { ...restored.settings, mode: 'QUALITY_TEST' },
    now,
  ))!;
  const id = 'malformed-' + randomUUID(),
    credential = await sha256(randomToken());
  await db
    .prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(id, owner.ownerId, credential, '["ANALYZE"]', now.toISOString())
    .run();
  const context = await AccessContext.worker(db, credential),
    store = new JobStore(db, context);
  const original = (await store.get(queued.job_id))!;
  const token = (await store.lease(queued.job_id, 'ANALYZE', now, 'local'))!;
  await store.start(token, 'ANALYZE', now);
  const jobs = new AnalysisJobs(db, context),
    prepared = await jobs.prepareRun(token, now),
    snapshot = prepared.snapshot;
  const repo = new ArtifactRepository(db, context);
  const source = await repo.readVerifiedText(
    snapshot.source.source_artifact_id,
    32 * 1024 * 1024,
    token,
    'ANALYZE',
    now,
  );
  const map = await repo.readVerifiedText(
    snapshot.source.segment_map_artifact_id,
    32 * 1024 * 1024,
    token,
    'ANALYZE',
    now,
  );
  const input = {
    source_artifact_id: source.artifact.artifact_id,
    source_text: source.text,
    manifest: JSON.parse(map.text),
    manifest_hash: map.artifact.content_hash,
    prompt: snapshot.prompt,
    profile: snapshot.profile,
    profile_revision: prepared.snapshot_hash,
    semantic_context: snapshot.semantic_context ?? {
      title: null,
      author: null,
      published_at: null,
      source_language: snapshot.source.language_code,
    },
    runtime: 'local' as const,
    request_id: prepared.run_id,
    deadline: new Date(now.getTime() + 300000).toISOString(),
    mode: snapshot.settings.mode,
    max_output_tokens: snapshot.settings.max_output_tokens,
    limits: snapshot.settings.limits,
  };
  const compiled = snapshot.semantic_profile
    ? await compileSemanticAnalysis({
        ...input,
        semantic_profile: snapshot.semantic_profile.compiled,
      })
    : await compileEconomy(input);
  await jobs.bindContext(
    token,
    compiled.run_context,
    compiled.context_hash,
    await sha256(compiled.request.prompt),
    now,
  );
  const buckets: AdmissionBucket[] = ['RPM', 'RPD', 'INPUT_TPM'].map(
    (bucket) => ({
      bucket: bucket as AdmissionBucket['bucket'],
      snapshot_id: id + bucket,
      window_start: now.toISOString(),
      sampled_at: now.toISOString(),
      reset_at: new Date(now.getTime() + 60000).toISOString(),
      expires_at: new Date(now.getTime() + 60000).toISOString(),
      remaining: bucket === 'INPUT_TPM' ? 10000000 : 10,
      reserve: 0,
    }),
  );
  const quota = new QuotaAdmission(db, context);
  for (const bucket of buckets) {
    await db
      .prepare(
        'INSERT INTO quota_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        bucket.snapshot_id,
        owner.ownerId,
        'gemini',
        snapshot.profile.model,
        bucket.bucket,
        'tokens-or-requests',
        bucket.remaining,
        0,
        bucket.remaining,
        bucket.reset_at,
        'America/Los_Angeles',
        'dashboard',
        bucket.sampled_at,
        bucket.expires_at,
        'INJECTED_ISOLATED_DRILL',
      )
      .run();
  }
  const permit = await quota.reserve(
    {
      request_id: prepared.run_id,
      account_key: snapshot.profile.account_key,
      model: snapshot.profile.model,
      input_tokens: compiled.request.estimated_input_tokens,
      buckets,
      paid_services_enabled: false,
    },
    token,
    now,
  );
  await quota.submit(permit.reservation_id, token, now);
  const text = '{"summary_pl":',
    bytes = new TextEncoder().encode(text),
    hash = await sha256(text);
  const artifact = await repo.begin(
    {
      item_id: snapshot.source.item_id,
      kind: 'ANALYSIS_CANDIDATE',
      content_hash: hash,
      byte_size: bytes.length,
      chunk_count: 1,
      schema_version: 'provider-output:1',
      producer_version: 'gemini-response:1:' + permit.reservation_id,
      original_ref: null,
      provenance: {
        reservation_id: permit.reservation_id,
        raw_output_present: true,
        response: {
          request_id: prepared.run_id,
          status: 'OK',
          actual_provider: 'gemini',
          actual_model: snapshot.profile.model,
          finish_reason: 'INJECTED_MALFORMED_DRILL',
          usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
          retry_after: null,
        },
      },
    },
    token,
    'ANALYZE',
    now,
  );
  await repo.writeChunk(
    artifact.artifact_id,
    0,
    0,
    bytes,
    token,
    'ANALYZE',
    now,
  );
  await repo.verifyLocal(artifact.artifact_id, token, 'ANALYZE', now, 'local');
  const before = await db
    .prepare('SELECT COUNT(*) n FROM observations WHERE owner_id=?')
    .bind(owner.ownerId)
    .first<number>('n');
  const result = await new AnalysisDisposition(db, context).apply(
    token,
    permit.reservation_id,
    artifact.artifact_id,
    now,
    randomToken(),
  );
  const final = (await store.get(token.job_id))!;
  const accepted = await db
    .prepare(
      "SELECT COUNT(*) n FROM analysis_runs WHERE job_id=? AND state='ACCEPTED'",
    )
    .bind(token.job_id)
    .first<number>('n');
  const after = await db
    .prepare('SELECT COUNT(*) n FROM observations WHERE owner_id=?')
    .bind(owner.ownerId)
    .first<number>('n');
  const retained = await new ArtifactRepository(db, owner).readVerifiedText(
    artifact.artifact_id,
    1024,
  );
  const observations = {
    final_state: final.state,
    reason: result.reason,
    accepted_effects: accepted,
    observations_unchanged: before === after,
    candidate_bytes_retained: retained.text === text,
    origin_preserved:
      original.arrival_origin_at === final.arrival_origin_at &&
      original.origin_kind === final.origin_kind,
    provider_requests: 0,
    injected_response: true,
    synthetic_quota: true,
    genuine_restored_source: true,
  };
  return {
    pass:
      final.state === 'BLOCKED' &&
      result.reason === 'AI_OUTPUT_REVIEW_REQUIRED' &&
      accepted === 0 &&
      observations.observations_unchanged &&
      observations.candidate_bytes_retained &&
      observations.origin_preserved,
    observations,
  };
}
