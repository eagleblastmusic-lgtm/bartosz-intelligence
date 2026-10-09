import { randomUUID } from 'node:crypto';
import {
  AccessContext,
  type Database,
} from '../../../packages/core/src/db/boundary.js';
import { sha256, randomToken } from '../../../packages/core/src/auth/crypto.js';
import { JobStore } from '../../../packages/core/src/jobs/store.js';
import { RunRepository } from '../../../packages/core/src/jobs/acceptance.js';
import { sweep } from '../../../packages/core/src/jobs/recovery.js';
import {
  QuotaAdmission,
  type AdmissionBucket,
} from '../../../packages/core/src/ai/admission.js';

// Actual isolated D1 transitions. Time and output are synthetic; no AI call.
export async function drillOffline(
  db: Database,
  owner: AccessContext,
  now: Date,
) {
  const id = 'offline-' + randomUUID(),
    credential = await sha256(randomToken());
  await db
    .prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(id, owner.ownerId, credential, '["ANALYZE"]', now.toISOString())
    .run();
  const context = await AccessContext.worker(db, credential);
  const store = new JobStore(db, context);
  const job = (await new JobStore(db, owner).enqueue(
    {
      item_id: null,
      source_id: null,
      task_type: 'ANALYZE',
      input_revision: id,
      profile_revision: 'isolated-offline',
      routing_policy_version: 'local-primary-1',
      prompt_snapshot_id: null,
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: '',
      arrival_origin_at: now.toISOString(),
      origin_kind: 'MANUAL',
      payload: { synthetic_drill: true },
      priority: 20,
      due_at: now.toISOString(),
    },
    now.toISOString(),
  ))!;
  const cloudDenied =
    (await store.lease(job.job_id, 'ANALYZE', now, 'cloud')) === null;
  const token = (await store.lease(job.job_id, 'ANALYZE', now, 'local'))!;
  await store.start(token, 'ANALYZE', now);
  const buckets: AdmissionBucket[] = ['RPM', 'RPD', 'INPUT_TPM'].map(
    (bucket) => ({
      bucket: bucket as AdmissionBucket['bucket'],
      snapshot_id: id + bucket,
      window_start: now.toISOString(),
      sampled_at: now.toISOString(),
      reset_at: new Date(now.getTime() + 60000).toISOString(),
      expires_at: new Date(now.getTime() + 60000).toISOString(),
      remaining: null,
      reserve: 0,
    }),
  );
  let quotaDenied = false;
  try {
    await new QuotaAdmission(db, context).reserve(
      {
        request_id: id,
        account_key: 'isolated',
        model: 'gemini-3.8-flash',
        input_tokens: 100,
        buckets,
        paid_services_enabled: false,
      },
      token,
      now,
    );
  } catch (error) {
    quotaDenied =
      error instanceof Error && error.message === 'QUOTA_UNKNOWN_OR_STALE';
  }
  const reservationCount = await db
    .prepare('SELECT COUNT(*) n FROM quota_reservations WHERE job_id=?')
    .bind(job.job_id)
    .first<number>('n');
  await store.disposition(
    token,
    'ANALYZE',
    'DEFERRED',
    'QUOTA_UNKNOWN_OR_STALE',
    new Date(now.getTime() + 60000).toISOString(),
    now,
  );
  const later = new Date(now.getTime() + 26 * 3600000);
  await sweep(db, later, () => false);
  const offlineState = (await store.get(job.job_id))!.state;
  await sweep(db, later, () => true);
  // New repository instance represents restart; durable job identity survives.
  const restarted = new JobStore(
    db,
    await AccessContext.worker(db, credential),
  );
  const resumed = (await restarted.lease(
    job.job_id,
    'ANALYZE',
    later,
    'local',
  ))!;
  await restarted.start(resumed, 'ANALYZE', later);
  let staleRejected = false;
  try {
    await store.disposition(
      token,
      'ANALYZE',
      'BLOCKED',
      'STALE_TEST',
      later.toISOString(),
      later,
    );
  } catch (error) {
    staleRejected = error instanceof Error && error.message === 'STALE_FENCE';
  }
  const runs = new RunRepository(db, context),
    runId = id + '-result';
  const outcome = { version: 'isolated-offline-result:1', synthetic: true },
    hash = await sha256(JSON.stringify(outcome));
  await runs.prepare(runId, job.job_id, later.toISOString());
  const accepted = await runs.complete(
    resumed,
    'ANALYZE',
    runId,
    hash,
    outcome,
    null,
    later,
  );
  const duplicate = await runs.complete(
    resumed,
    'ANALYZE',
    runId,
    hash,
    outcome,
    null,
    later,
  );
  const final = (await restarted.get(job.job_id))!;
  const acceptedCount = await db
    .prepare(
      "SELECT COUNT(*) n FROM analysis_runs WHERE job_id=? AND state='ACCEPTED'",
    )
    .bind(job.job_id)
    .first<number>('n');
  await db
    .prepare('UPDATE worker_identities SET revoked_at=? WHERE worker_id=?')
    .bind(later.toISOString(), id)
    .run();
  const observations = {
    cloud_denied: cloudDenied,
    unknown_quota_denied: quotaDenied,
    quota_reservations: reservationCount,
    offline_state: offlineState,
    old_fence_rejected: staleRejected,
    accepted_effects: acceptedCount,
    duplicate_idempotent: duplicate.duplicate,
    origin_preserved:
      final.arrival_origin_at === job.arrival_origin_at &&
      final.origin_kind === job.origin_kind,
    final_state: final.state,
    provider_requests: 0,
    logical_offline_hours: 26,
    synthetic_result: true,
  };
  return {
    pass:
      cloudDenied &&
      quotaDenied &&
      reservationCount === 0 &&
      offlineState === 'DEFERRED' &&
      staleRejected &&
      accepted.accepted &&
      duplicate.duplicate &&
      acceptedCount === 1 &&
      observations.origin_preserved &&
      final.state === 'SUCCEEDED',
    observations,
  };
}
