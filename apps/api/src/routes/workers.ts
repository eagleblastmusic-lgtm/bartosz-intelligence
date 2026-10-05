import { controlTick } from '../control.js';
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
import { YoutubeClient } from '../../../../packages/core/src/sources/youtube/client.js';
import { TranscriptRecovery } from '../../../../packages/core/src/transcript/recovery.js';
import { transcriptStatuses } from '../../../../packages/contracts/src/transcript.js';
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
workersApp.get('/transcript/admission', async (c) =>
  c.json(
    await new TranscriptRecovery(c.env.DB, c.get('access')).admission(
      new Date(),
      runtime(c.req.query('runtime')),
    ),
  ),
);
workersApp.post('/transcript/outcome', async (c) => {
  const input = await body(c, ['token', 'status', 'active_live']),
    access = c.get('access');
  if (
    !transcriptStatuses.some((status) => status === input.status) ||
    (input.active_live !== undefined && typeof input.active_live !== 'boolean')
  )
    throw new Error('INVALID_INPUT');
  const status = input.status as (typeof transcriptStatuses)[number];
  return c.json(
    await new TranscriptRecovery(c.env.DB, access).outcome(
      token(input.token, access.actorId),
      status,
      new Date(),
      input.active_live === true,
    ),
  );
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
  return c.json(await controlTick(c.env, c.get('access')));
});
