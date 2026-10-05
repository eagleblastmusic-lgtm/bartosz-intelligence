import { apiRouter, body, text } from './common.js';
import { taskTypes } from '../../../../packages/contracts/src/jobs.js';
import type {
  LeaseToken,
  TaskType,
} from '../../../../packages/contracts/src/jobs.js';
import { JobStore } from '../../../../packages/core/src/jobs/store.js';
import { pull } from '../../../../packages/core/src/jobs/recovery.js';
import { retryDisposition } from '../../../../packages/core/src/jobs/policy.js';
import { executeDiscoveryChunk } from '../../../../packages/core/src/sources/youtube/executor.js';
import {
  YoutubeClient,
  YoutubeError,
} from '../../../../packages/core/src/sources/youtube/client.js';
export const workersApp = apiRouter();
workersApp.use('*', async (c, next) => {
  // Authenticate before reading payload or any domain row. Scope is checked again per action.
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
    c.req.header('Authorization') ?? '',
  );
  if (!match) throw new Error('UNAUTHENTICATED');
  const { AccessContext } =
    await import('../../../../packages/core/src/db/boundary.js');
  const { sha256 } =
    await import('../../../../packages/core/src/auth/crypto.js');
  c.set(
    'access',
    await AccessContext.worker(c.env.DB, await sha256(match[1]!)),
  );
  await next();
});
function task(value: unknown): TaskType {
  if (!taskTypes.some((entry) => entry === value))
    throw new Error('INVALID_TASK');
  return value as TaskType;
}
function runtime(value: unknown) {
  if (value !== 'local' && value !== 'cloud')
    throw new Error('INVALID_RUNTIME');
  return value;
}
function token(value: unknown, actor: string): LeaseToken {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_LEASE');
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some(
      (key) =>
        !['job_id', 'lease_owner', 'fencing_token', 'lease_until'].includes(
          key,
        ),
    ) ||
    row.lease_owner !== actor ||
    !Number.isSafeInteger(row.fencing_token) ||
    Number(row.fencing_token) < 1 ||
    typeof row.lease_until !== 'string' ||
    !Number.isFinite(Date.parse(row.lease_until))
  )
    throw new Error('INVALID_LEASE');
  return {
    job_id: text(row.job_id, 128),
    lease_owner: actor,
    fencing_token: Number(row.fencing_token),
    lease_until: row.lease_until,
  };
}
workersApp.post('/lease', async (c) => {
  const input = await body(c, ['runtime', 'task_type', 'job_id']),
    access = c.get('access'),
    location = runtime(input.runtime);
  const store = new JobStore(c.env.DB, access),
    now = new Date();
  if (input.job_id !== undefined) {
    const type = task(input.task_type);
    access.requireTask(type);
    const lease = await store.lease(
      text(input.job_id, 128),
      type,
      now,
      location,
    );
    if (!lease) throw new Error('STALE_FENCE');
    const job = await store.get(lease.job_id);
    return c.json({ leases: [{ token: lease, job }] });
  }
  if (input.task_type !== undefined) throw new Error('INVALID_INPUT');
  return c.json({ leases: await pull(store, now, location, 1) });
});
workersApp.post('/heartbeat', async (c) => {
  const input = await body(c, ['runtime', 'task_type', 'token']),
    access = c.get('access'),
    now = new Date(),
    location = runtime(input.runtime);
  let lease: LeaseToken | null = null;
  if (input.token !== undefined)
    lease = await new JobStore(c.env.DB, access).heartbeat(
      token(input.token, access.actorId),
      task(input.task_type),
      now,
      location,
    );
  else if (input.task_type !== undefined) throw new Error('INVALID_INPUT');
  await c.env.DB.prepare(
    `INSERT INTO worker_sessions(owner_id,worker_id,runtime,capabilities_json,heartbeat_at,online_until) SELECT owner_id,worker_id,?,scopes_json,?,? FROM worker_identities WHERE owner_id=? AND worker_id=? AND revoked_at IS NULL AND credential_hash=? ON CONFLICT(owner_id,worker_id) DO UPDATE SET runtime=excluded.runtime,capabilities_json=excluded.capabilities_json,heartbeat_at=excluded.heartbeat_at,online_until=excluded.online_until`,
  )
    .bind(
      location,
      now.toISOString(),
      new Date(now.getTime() + 180000).toISOString(),
      access.ownerId,
      access.actorId,
      access.credentialHash!,
    )
    .run();
  return c.json({ token: lease, server_time: now.toISOString() });
});
workersApp.post('/start', async (c) => {
  const input = await body(c, ['task_type', 'token']),
    access = c.get('access');
  await new JobStore(c.env.DB, access).start(
    token(input.token, access.actorId),
    task(input.task_type),
    new Date(),
  );
  return c.json({ state: 'RUNNING' });
});
workersApp.post('/retry', async (c) => {
  const input = await body(c, ['task_type', 'token', 'code', 'reset_at']),
    access = c.get('access'),
    type = task(input.task_type),
    lease = token(input.token, access.actorId),
    store = new JobStore(c.env.DB, access),
    now = new Date();
  access.requireTask(type);
  const code = input.code;
  if (
    code !== 'TRANSIENT' &&
    code !== 'QUOTA' &&
    code !== 'AUTH' &&
    code !== 'INVALID_INPUT'
  )
    throw new Error('INVALID_REASON');
  const job = await store.get(lease.job_id);
  if (!job) throw new Error('NOT_FOUND');
  const decision = retryDisposition(
    code,
    job.attempt_count,
    now,
    Math.random,
    input.reset_at === undefined ? undefined : text(input.reset_at, 64),
  );
  await store.disposition(
    lease,
    type,
    decision.state,
    decision.reason,
    decision.due_at,
    now,
  );
  return c.json(decision);
});
workersApp.post('/defer', async (c) => {
  const input = await body(c, ['task_type', 'token', 'reason', 'due_at']),
    access = c.get('access'),
    due = text(input.due_at, 64),
    reason = text(input.reason, 64),
    now = new Date();
  if (
    !['LOCAL_OFFLINE', 'PROVIDER_UNAVAILABLE', 'LIVE_ACTIVE'].includes(
      reason,
    ) ||
    !Number.isFinite(Date.parse(due)) ||
    Date.parse(due) <= now.getTime() ||
    Date.parse(due) > now.getTime() + 86400000
  )
    throw new Error('INVALID_DEFER');
  await new JobStore(c.env.DB, access).disposition(
    token(input.token, access.actorId),
    task(input.task_type),
    'DEFERRED',
    reason,
    new Date(due).toISOString(),
    now,
  );
  return c.json({ state: 'DEFERRED', due_at: due, reason });
});
workersApp.post('/complete', async (c) => {
  const input = await body(c, ['task_type', 'token']),
    access = c.get('access'),
    type = task(input.task_type),
    lease = token(input.token, access.actorId);
  access.requireTask(type);
  const job = await new JobStore(c.env.DB, access).get(lease.job_id);
  if (
    !job ||
    job.task_type !== type ||
    job.fencing_token !== lease.fencing_token
  )
    throw new Error('STALE_FENCE');
  if (job.state === 'SUCCEEDED') {
    const accepted = await c.env.DB.prepare(
      'SELECT attempt_id FROM job_attempts WHERE owner_id=? AND job_id=? AND fencing_token=? AND executor_id=? AND finished_at IS NOT NULL',
    )
      .bind(access.ownerId, lease.job_id, lease.fencing_token, access.actorId)
      .first();
    if (!accepted) throw new Error('STALE_FENCE');
    return c.json({ state: 'SUCCEEDED', already_completed: true });
  }
  if (
    job.state !== 'RUNNING' ||
    job.lease_owner !== access.actorId ||
    !job.lease_until ||
    job.lease_until <= new Date().toISOString()
  )
    throw new Error('STALE_FENCE');
  // Discovery validates/commits its own upstream data. Generic AI acceptance awaits Stage 03 validator.
  if (type !== 'DISCOVER' && type !== 'RECONCILE')
    throw new Error('CAPABILITY_NOT_AVAILABLE');
  if (!c.env.YOUTUBE_API_KEY)
    throw new Error('PROVIDER_CONFIGURATION_REQUIRED');
  return c.json(
    await executeDiscoveryChunk(
      c.env.DB,
      access,
      lease,
      new YoutubeClient(c.env.YOUTUBE_API_KEY, 3),
      new Date(),
      type,
      () => new Date(),
      4,
    ),
  );
});
workersApp.post('/control-tick', async (c) => {
  await body(c, []);
  if (
    !c.env.CONTROL_WORKER_CREDENTIAL ||
    c.req.header('Authorization') !==
      `Bearer ${c.env.CONTROL_WORKER_CREDENTIAL}`
  )
    throw new Error('FORBIDDEN');
  const access = c.get('access');
  access.requireTask('DISCOVER');
  access.requireTask('RECONCILE');
  if (!c.env.YOUTUBE_API_KEY)
    throw new Error('PROVIDER_CONFIGURATION_REQUIRED');
  const store = new JobStore(c.env.DB, access),
    now = new Date();
  const running = await c.env.DB.prepare(
    `SELECT job_id,task_type,lease_owner,lease_until,fencing_token FROM jobs WHERE owner_id=? AND lease_owner=? AND task_type IN ('DISCOVER','RECONCILE') AND state='RUNNING' AND lease_until>? ORDER BY priority DESC,arrival_origin_at LIMIT 1`,
  )
    .bind(access.ownerId, access.actorId, now.toISOString())
    .first<LeaseToken & { task_type: TaskType }>();
  let lease: LeaseToken, type: TaskType;
  if (running) {
    type = running.task_type;
    lease = await store.heartbeat(running, type, now, 'cloud');
  } else {
    const job = await c.env.DB.prepare(
      `SELECT job_id,task_type,state FROM jobs WHERE owner_id=? AND (state='PENDING' OR (state='DEFERRED' AND reason_code='CONTINUATION')) AND due_at<=? AND task_type IN ('DISCOVER','RECONCILE') ORDER BY priority DESC,arrival_origin_at,job_id LIMIT 1`,
    )
      .bind(access.ownerId, now.toISOString())
      .first<{ job_id: string; task_type: TaskType; state: string }>();
    if (!job) return c.json({ status: 'IDLE' });
    type = job.task_type;
    if (job.state === 'DEFERRED') {
      await c.env.DB.prepare(
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
    return c.json(
      await executeDiscoveryChunk(
        c.env.DB,
        access,
        lease,
        new YoutubeClient(c.env.YOUTUBE_API_KEY, 3),
        now,
        type,
        () => new Date(),
        4,
      ),
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'SOURCE_DISABLED') {
      await store.disposition(
        lease,
        type,
        'BLOCKED',
        'SOURCE_DISABLED',
        new Date().toISOString(),
        new Date(),
      );
      return c.json({ status: 'BLOCKED', reason: 'SOURCE_DISABLED' });
    }
    if (!(error instanceof YoutubeError)) throw error;
    if (error.code === 'QUOTA' && !error.retryAt) {
      await store.disposition(
        lease,
        type,
        'BLOCKED',
        'QUOTA_RESET_UNKNOWN',
        new Date().toISOString(),
        new Date(),
      );
      return c.json({
        status: 'BLOCKED',
        reason: 'QUOTA_RESET_UNKNOWN',
        retry_at: null,
      });
    }
    const current = await store.get(lease.job_id),
      decision = retryDisposition(
        error.code === 'QUOTA'
          ? 'QUOTA'
          : error.code === 'AUTH'
            ? 'AUTH'
            : 'TRANSIENT',
        current!.attempt_count,
        new Date(),
        Math.random,
        error.retryAt ?? undefined,
      );
    await store.disposition(
      lease,
      type,
      decision.state,
      decision.reason,
      decision.due_at,
      new Date(),
    );
    return c.json({ status: decision.state, reason: decision.reason });
  }
});
