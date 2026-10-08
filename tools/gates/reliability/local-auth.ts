import { randomUUID } from 'node:crypto';
import {
  AccessContext,
  type Database,
} from '../../../packages/core/src/db/boundary.js';
import { sha256, randomToken } from '../../../packages/core/src/auth/crypto.js';
import { JobStore } from '../../../packages/core/src/jobs/store.js';
import { RunRepository } from '../../../packages/core/src/jobs/acceptance.js';
import { sweep } from '../../../packages/core/src/jobs/recovery.js';

export async function drillAuth(
  db: Database,
  owner: AccessContext,
  session: string,
  now: Date,
) {
  const worker = async (at: Date) => {
    const credential = await sha256(randomToken()),
      id = 'auth-drill-' + randomUUID();
    await db
      .prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
      .bind(
        id,
        owner.ownerId,
        credential,
        '["FETCH_TRANSCRIPT"]',
        at.toISOString(),
      )
      .run();
    return {
      credential,
      id,
      context: await AccessContext.worker(db, credential),
    };
  };
  const job = (await new JobStore(db, owner).enqueue(
    {
      item_id: null,
      source_id: null,
      task_type: 'FETCH_TRANSCRIPT',
      input_revision: randomUUID(),
      profile_revision: 'local',
      routing_policy_version: 'local-primary-1',
      prompt_snapshot_id: null,
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: '',
      arrival_origin_at: now.toISOString(),
      origin_kind: 'INTEGRITY',
      payload: {},
      priority: 20,
      due_at: now.toISOString(),
    },
    now.toISOString(),
  ))!;
  const revoked = await worker(now);
  const store = new JobStore(db, revoked.context);
  const token = (await store.lease(
    job.job_id,
    'FETCH_TRANSCRIPT',
    now,
    'local',
  ))!;
  await store.start(token, 'FETCH_TRANSCRIPT', now);
  const runs = new RunRepository(db, revoked.context);
  const runId = 'auth-drill-' + randomUUID();
  await runs.prepare(runId, job.job_id, now.toISOString());
  await db
    .prepare('UPDATE worker_identities SET revoked_at=? WHERE worker_id=?')
    .bind(now.toISOString(), revoked.id)
    .run();
  let credentialRejected = false,
    completionRejected = false,
    ownerRejected = false;
  try {
    await AccessContext.worker(db, revoked.credential);
  } catch (error) {
    credentialRejected =
      error instanceof Error && error.message === 'UNAUTHENTICATED';
  }
  const outcome = { version: 'isolated-auth-drill:1' },
    hash = await sha256(JSON.stringify(outcome));
  try {
    await runs.complete(
      token,
      'FETCH_TRANSCRIPT',
      runId,
      hash,
      outcome,
      null,
      now,
    );
  } catch (error) {
    completionRejected =
      error instanceof Error && error.message === 'STALE_FENCE';
  }
  const unaccepted = await db
    .prepare('SELECT state FROM analysis_runs WHERE run_id=?')
    .bind(runId)
    .first<string>('state');
  await db
    .prepare('UPDATE owner_sessions SET revoked_at=? WHERE session_hash=?')
    .bind(now.toISOString(), session)
    .run();
  try {
    await AccessContext.owner(db, session, now.toISOString());
  } catch (error) {
    ownerRejected =
      error instanceof Error && error.message === 'UNAUTHENTICATED';
  }
  const later = new Date(now.getTime() + 16 * 60000);
  const replacement = await worker(later);
  const replacementSession = await sha256(randomToken());
  await db
    .prepare(
      'INSERT INTO owner_sessions(session_hash,owner_id,csrf_hash,created_at,expires_at) VALUES(?,?,?,?,?)',
    )
    .bind(
      replacementSession,
      owner.ownerId,
      await sha256(randomToken()),
      later.toISOString(),
      new Date(later.getTime() + 900000).toISOString(),
    )
    .run();
  const freshOwner = await AccessContext.owner(
    db,
    replacementSession,
    later.toISOString(),
  );
  await sweep(db, later, () => true);
  const replacementStore = new JobStore(db, replacement.context);
  const resumed = (await replacementStore.lease(
    job.job_id,
    'FETCH_TRANSCRIPT',
    later,
    'local',
  ))!;
  await replacementStore.start(resumed, 'FETCH_TRANSCRIPT', later);
  const replacementRuns = new RunRepository(db, replacement.context);
  const recoveredId = 'auth-recovered-' + randomUUID();
  await replacementRuns.prepare(recoveredId, job.job_id, later.toISOString());
  const completed = await replacementRuns.complete(
    resumed,
    'FETCH_TRANSCRIPT',
    recoveredId,
    hash,
    outcome,
    null,
    later,
  );
  const final = (await replacementStore.get(job.job_id))!;
  const count = await db
    .prepare(
      "SELECT COUNT(*) n FROM analysis_runs WHERE job_id=? AND state='ACCEPTED'",
    )
    .bind(job.job_id)
    .first<number>('n');
  await db
    .prepare('UPDATE worker_identities SET revoked_at=? WHERE worker_id=?')
    .bind(later.toISOString(), replacement.id)
    .run();
  await db
    .prepare('UPDATE owner_sessions SET revoked_at=? WHERE session_hash=?')
    .bind(later.toISOString(), replacementSession)
    .run();
  return {
    pass:
      credentialRejected &&
      completionRejected &&
      ownerRejected &&
      unaccepted === 'CANDIDATE' &&
      freshOwner.ownerId === owner.ownerId &&
      completed.accepted &&
      count === 1 &&
      final.state === 'SUCCEEDED' &&
      final.arrival_origin_at === job.arrival_origin_at &&
      final.origin_kind === job.origin_kind,
    observations: {
      worker_auth_rejected: credentialRejected,
      old_completion_rejected: completionRejected,
      owner_session_rejected: ownerRejected,
      replacement_accepted: completed.accepted,
      accepted_effects: count,
      origin_preserved:
        final.arrival_origin_at === job.arrival_origin_at &&
        final.origin_kind === job.origin_kind,
    },
  };
}
