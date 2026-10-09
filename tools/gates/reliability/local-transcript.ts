import { randomUUID } from 'node:crypto';
import {
  AccessContext,
  type Database,
} from '../../../packages/core/src/db/boundary.js';
import { sha256, randomToken } from '../../../packages/core/src/auth/crypto.js';
import { JobStore } from '../../../packages/core/src/jobs/store.js';
import { TranscriptRecovery } from '../../../packages/core/src/transcript/recovery.js';
import { sweep } from '../../../packages/core/src/jobs/recovery.js';

// Actual durable transitions; injected statuses and clock, zero provider calls.
export async function drillTranscript(
  db: Database,
  owner: AccessContext,
  now: Date,
) {
  const id = 'transcript-' + randomUUID();
  const credential = await sha256(randomToken());
  await db
    .prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      id,
      owner.ownerId,
      credential,
      '["FETCH_TRANSCRIPT"]',
      now.toISOString(),
    )
    .run();
  const context = await AccessContext.worker(db, credential);
  const store = new JobStore(db, context);
  const job = (await new JobStore(db, owner).enqueue(
    {
      item_id: null,
      source_id: null,
      task_type: 'FETCH_TRANSCRIPT',
      input_revision: id,
      profile_revision: 'local',
      routing_policy_version: 'local-primary-1',
      prompt_snapshot_id: null,
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: '',
      arrival_origin_at: now.toISOString(),
      origin_kind: 'BACKFILL',
      payload: {},
      priority: 20,
      due_at: now.toISOString(),
    },
    now.toISOString(),
  ))!;
  const first = (await store.lease(
    job.job_id,
    'FETCH_TRANSCRIPT',
    now,
    'local',
  ))!;
  await store.start(first, 'FETCH_TRANSCRIPT', now);
  const recovery = new TranscriptRecovery(db, context);
  const failed = await recovery.outcome(first, 'PARSE_ERROR', now);
  const circuit = await recovery.admission(now, 'local');
  const premature = await store.lease(
    job.job_id,
    'FETCH_TRANSCRIPT',
    now,
    'local',
  );
  const later = new Date(Date.parse(failed.due_at) + 1);
  await sweep(db, later, () => true);
  const restarted = new JobStore(
    db,
    await AccessContext.worker(db, credential),
  );
  const resumed = (await restarted.lease(
    job.job_id,
    'FETCH_TRANSCRIPT',
    later,
    'local',
  ))!;
  await restarted.start(resumed, 'FETCH_TRANSCRIPT', later);
  let staleRejected = false;
  try {
    await recovery.outcome(first, 'UNAVAILABLE', later);
  } catch (error) {
    staleRejected = error instanceof Error && error.message === 'STALE_FENCE';
  }
  const available = await recovery.admission(later, 'local');
  const noCaptions = await recovery.outcome(resumed, 'NO_CAPTIONS', later);
  const final = (await restarted.get(job.job_id))!;
  const accepted = await db
    .prepare(
      "SELECT COUNT(*) n FROM analysis_runs WHERE job_id=? AND state='ACCEPTED'",
    )
    .bind(job.job_id)
    .first<number>('n');
  const observations = {
    parser_state: failed.state,
    parser_reason: failed.reason,
    circuit_open: !circuit.available,
    premature_lease_denied: premature === null,
    circuit_recovers: available.available,
    restart_fence: resumed.fencing_token,
    stale_fence_rejected: staleRejected,
    final_state: final.state,
    final_reason: final.reason_code,
    accepted_effects: accepted,
    origin_preserved:
      final.arrival_origin_at === job.arrival_origin_at &&
      final.origin_kind === job.origin_kind,
    provider_requests: 0,
    injected_statuses: true,
    logical_clock: true,
    source_recovery: 'RETRY_ADMISSION_ONLY_NO_SUCCESSFUL_SOURCE',
  };
  return {
    pass:
      failed.state === 'DEFERRED' &&
      !circuit.available &&
      premature === null &&
      available.available &&
      staleRejected &&
      noCaptions.state === 'DEFERRED' &&
      final.state === 'DEFERRED' &&
      accepted === 0 &&
      observations.origin_preserved,
    observations,
  };
}
