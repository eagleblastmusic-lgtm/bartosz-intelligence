import type { Env } from './env.js';
import type { AccessContext } from '../../../packages/core/src/db/boundary.js';
import type {
  LeaseToken,
  TaskType,
} from '../../../packages/contracts/src/jobs.js';
import { JobStore } from '../../../packages/core/src/jobs/store.js';
import { retryDisposition } from '../../../packages/core/src/jobs/policy.js';
import { executeDiscoveryChunk } from '../../../packages/core/src/sources/youtube/executor.js';
import {
  YoutubeClient,
  YoutubeError,
} from '../../../packages/core/src/sources/youtube/client.js';

// Both trusted Queue execution and the scoped API use this same lease/acceptance path.
export async function controlTick(
  environment: Env,
  access: AccessContext,
  chunkSize = 4,
) {
  access.requireTask('DISCOVER');
  access.requireTask('RECONCILE');
  if (!environment.YOUTUBE_API_KEY)
    throw new Error('PROVIDER_CONFIGURATION_REQUIRED');
  const db = environment.DB,
    store = new JobStore(db, access),
    now = new Date();
  const running = await db
    .prepare(
      `SELECT job_id,task_type,lease_owner,lease_until,fencing_token FROM jobs WHERE owner_id=? AND lease_owner=? AND task_type IN ('DISCOVER','RECONCILE') AND state='RUNNING' AND lease_until>? ORDER BY priority DESC,arrival_origin_at LIMIT 1`,
    )
    .bind(access.ownerId, access.actorId, now.toISOString())
    .first<LeaseToken & { task_type: TaskType }>();
  let lease: LeaseToken, type: TaskType;
  if (running) {
    type = running.task_type;
    lease = await store.heartbeat(running, type, now, 'cloud');
  } else {
    const job = await db
      .prepare(
        `SELECT job_id,task_type,state FROM jobs WHERE owner_id=? AND (state='PENDING' OR (state='DEFERRED' AND reason_code='CONTINUATION')) AND due_at<=? AND task_type IN ('DISCOVER','RECONCILE') ORDER BY priority DESC,arrival_origin_at,job_id LIMIT 1`,
      )
      .bind(access.ownerId, now.toISOString())
      .first<{ job_id: string; task_type: TaskType; state: string }>();
    if (!job) return { status: 'IDLE' };
    type = job.task_type;
    if (job.state === 'DEFERRED') {
      await db
        .prepare(
          `UPDATE jobs SET state='PENDING',reason_code=NULL,updated_at=? WHERE owner_id=? AND job_id=? AND state='DEFERRED' AND reason_code='CONTINUATION' AND due_at<=? AND EXISTS(SELECT 1 FROM worker_identities WHERE owner_id=? AND worker_id=? AND credential_hash=? AND revoked_at IS NULL)`,
        )
        .bind(
          now.toISOString(),
          access.ownerId,
          job.job_id,
          now.toISOString(),
          access.ownerId,
          access.actorId,
          access.credentialHash!,
        )
        .run();
    }
    const acquired = await store.lease(job.job_id, type, now, 'cloud');
    if (!acquired) throw new Error('STALE_FENCE');
    lease = acquired;
    await store.start(lease, type, now);
  }
  try {
    return await executeDiscoveryChunk(
      db,
      access,
      lease,
      new YoutubeClient(environment.YOUTUBE_API_KEY, 3),
      now,
      type,
      () => new Date(),
      chunkSize,
    );
  } catch (error) {
    const failedAt = new Date();
    if (error instanceof Error && error.message === 'SOURCE_DISABLED') {
      await store.disposition(
        lease,
        type,
        'BLOCKED',
        'SOURCE_DISABLED',
        failedAt.toISOString(),
        failedAt,
      );
      return { status: 'BLOCKED', reason: 'SOURCE_DISABLED' };
    }
    if (!(error instanceof YoutubeError)) throw error;
    if (error.code === 'QUOTA' && !error.retryAt) {
      await store.disposition(
        lease,
        type,
        'BLOCKED',
        'QUOTA_RESET_UNKNOWN',
        failedAt.toISOString(),
        failedAt,
      );
      return {
        status: 'BLOCKED',
        reason: 'QUOTA_RESET_UNKNOWN',
        retry_at: null,
      };
    }
    const current = await store.get(lease.job_id),
      decision = retryDisposition(
        error.code === 'QUOTA'
          ? 'QUOTA'
          : error.code === 'AUTH'
            ? 'AUTH'
            : 'TRANSIENT',
        current!.attempt_count,
        failedAt,
        Math.random,
        error.retryAt ?? undefined,
      );
    await store.disposition(
      lease,
      type,
      decision.state,
      decision.reason,
      decision.due_at,
      failedAt,
    );
    return { status: decision.state, reason: decision.reason };
  }
}
