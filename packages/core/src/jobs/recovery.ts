import type { Database } from '../db/boundary.js';
import type {
  QueueSignal,
  JobRecord,
  TaskType,
} from '../../../contracts/src/jobs.js';
import { taskTypes } from '../../../contracts/src/jobs.js';
import { fairJobOrder, runtimeAdmissionPredicate } from './policy.js';
import { JobStore } from './store.js';
export function parseSignal(value: unknown): QueueSignal {
  if (!value || typeof value !== 'object') throw new Error('INVALID_SIGNAL');
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(',') !== 'fencing_hint,job_id,task_type' ||
    typeof row.job_id !== 'string' ||
    row.job_id.length > 128 ||
    !taskTypes.includes(row.task_type as QueueSignal['task_type']) ||
    !(
      row.fencing_hint === null ||
      (Number.isSafeInteger(row.fencing_hint) &&
        (row.fencing_hint as number) >= 0)
    )
  )
    throw new Error('INVALID_SIGNAL');
  return row as unknown as QueueSignal;
}
// Narrow administrative operations: only platform scheduler/Queue call these.
export async function sweep(
  db: Database,
  now: Date,
  availability: (job: JobRecord) => boolean,
  limit = 50,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new Error('INVALID_LIMIT');
  const expired = (
    await db
      .prepare(
        "SELECT owner_id,job_id,fencing_token FROM jobs WHERE state IN ('LEASED','RUNNING') AND lease_until<=? ORDER BY lease_until,job_id LIMIT ?",
      )
      .bind(now.toISOString(), limit)
      .all<{ owner_id: string; job_id: string; fencing_token: number }>()
  ).results;
  for (const row of expired)
    await db.batch([
      db
        .prepare(
          `UPDATE job_attempts SET finished_at=?,error_code='LEASE_EXPIRED' WHERE owner_id=? AND job_id=? AND fencing_token=? AND finished_at IS NULL
           AND EXISTS(SELECT 1 FROM jobs WHERE owner_id=? AND job_id=? AND fencing_token=? AND state IN ('LEASED','RUNNING') AND lease_until<=?)`,
        )
        .bind(
          now.toISOString(),
          row.owner_id,
          row.job_id,
          row.fencing_token,
          row.owner_id,
          row.job_id,
          row.fencing_token,
          now.toISOString(),
        ),
      db
        .prepare(
          `UPDATE jobs SET state='RETRY_WAIT',reason_code='LEASE_EXPIRED',due_at=?,updated_at=?,lease_owner=NULL,lease_until=NULL WHERE owner_id=? AND job_id=? AND fencing_token=? AND state IN ('LEASED','RUNNING') AND lease_until<=?`,
        )
        .bind(
          now.toISOString(),
          now.toISOString(),
          row.owner_id,
          row.job_id,
          row.fencing_token,
          now.toISOString(),
        ),
    ]);
  const due = (
    await db
      .prepare(
        "SELECT * FROM jobs WHERE state IN ('RETRY_WAIT','DEFERRED') AND due_at<=? ORDER BY due_at,job_id LIMIT ?",
      )
      .bind(now.toISOString(), limit)
      .all<JobRecord>()
  ).results;
  for (const job of due)
    if (availability(job))
      await db
        .prepare(
          "UPDATE jobs SET state='PENDING',reason_code=NULL,updated_at=? WHERE owner_id=? AND job_id=? AND state IN ('RETRY_WAIT','DEFERRED') AND due_at<=?",
        )
        .bind(now.toISOString(), job.owner_id, job.job_id, now.toISOString())
        .run();
  const pending = (
    await db
      .prepare(
        "SELECT owner_id,job_id,fencing_token,task_type FROM jobs WHERE state='PENDING' AND due_at<=? AND task_type NOT IN ('DISCOVER','RECONCILE') ORDER BY priority DESC,due_at,job_id LIMIT ?",
      )
      .bind(now.toISOString(), limit)
      .all<{
        owner_id: string;
        job_id: string;
        fencing_token: number;
        task_type: string;
      }>()
  ).results;
  for (const job of pending)
    await db
      .prepare(
        `INSERT INTO outbox(event_id,owner_id,event_key,job_id,payload_json,due_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,event_key) DO UPDATE SET delivered_at=NULL,due_at=excluded.due_at`,
      )
      .bind(
        crypto.randomUUID(),
        job.owner_id,
        `job:${job.job_id}:${job.fencing_token}`,
        job.job_id,
        JSON.stringify({
          job_id: job.job_id,
          fencing_hint: job.fencing_token,
          task_type: job.task_type,
        }),
        now.toISOString(),
      )
      .run();
  return {
    expired: expired.length,
    checked_due: due.length,
    pending: pending.length,
  };
}
export async function dispatchOutbox(
  db: Database,
  send: (signal: QueueSignal) => Promise<void>,
  now: Date,
  limit = 50,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new Error('INVALID_LIMIT');
  const events = (
    await db
      .prepare(
        `SELECT o.event_id,o.owner_id,o.payload_json FROM outbox o JOIN jobs j ON j.owner_id=o.owner_id AND j.job_id=o.job_id WHERE o.delivered_at IS NULL AND o.due_at<=? AND j.state='PENDING' ORDER BY o.due_at,o.event_id LIMIT ?`,
      )
      .bind(now.toISOString(), limit)
      .all<{ event_id: string; owner_id: string; payload_json: string }>()
  ).results;
  let delivered = 0;
  for (const event of events) {
    await db
      .prepare(
        'UPDATE outbox SET attempts=attempts+1 WHERE owner_id=? AND event_id=? AND delivered_at IS NULL',
      )
      .bind(event.owner_id, event.event_id)
      .run();
    try {
      await send(parseSignal(JSON.parse(event.payload_json)));
    } catch {
      await db
        .prepare(
          "UPDATE outbox SET last_error='TRANSPORT_AMBIGUOUS',due_at=? WHERE owner_id=? AND event_id=? AND delivered_at IS NULL",
        )
        .bind(
          new Date(now.getTime() + 60000).toISOString(),
          event.owner_id,
          event.event_id,
        )
        .run();
      continue;
    }
    // Crash here is safe: replaying the signal never repeats accepted effects.
    await db
      .prepare(
        'UPDATE outbox SET delivered_at=?,last_error=NULL WHERE owner_id=? AND event_id=? AND delivered_at IS NULL',
      )
      .bind(now.toISOString(), event.owner_id, event.event_id)
      .run();
    delivered++;
  }
  return { attempted: events.length, delivered };
}
export async function signalDisposition(
  db: Database,
  signal: QueueSignal,
): Promise<'ACK' | 'RETRY'> {
  const job = await db
    .prepare('SELECT state,task_type FROM jobs WHERE job_id=?')
    .bind(signal.job_id)
    .first<{ state: string; task_type: string }>();
  if (!job || job.task_type !== signal.task_type) return 'RETRY';
  // Hint never grants a lease or mutation permission.
  return ['SUCCEEDED', 'DEFERRED', 'RETRY_WAIT', 'BLOCKED', 'FAILED'].includes(
    job.state,
  )
    ? 'ACK'
    : 'RETRY';
}
export async function pull(
  store: JobStore,
  now: Date,
  runtime: 'local' | 'cloud',
  slots = 1,
  tasks?: readonly TaskType[],
  analysisMode?: 'PRODUCTION',
) {
  if (
    analysisMode !== undefined &&
    (analysisMode !== 'PRODUCTION' ||
      tasks?.length !== 1 ||
      tasks[0] !== 'ANALYZE')
  )
    throw new Error('INVALID_TASK');
  if (!Number.isInteger(slots) || slots < 1 || slots > 10)
    throw new Error('INVALID_SLOTS');
  for (const task of tasks ?? []) store.context.requireTask(task);
  const admittedTasks = taskTypes.filter(
    (task) =>
      store.context.scopes.includes(task) && (!tasks || tasks.includes(task)),
  );
  if (admittedTasks.length === 0) return [];
  const taskPredicate = `task_type IN (${admittedTasks.map(() => '?').join(',')})`;
  const groups = await Promise.all(
    [
      "task_type IN ('DISCOVER','RECONCILE','BACKUP')",
      "origin_kind='BACKFILL' AND task_type NOT IN ('DISCOVER','RECONCILE','BACKUP')",
      "origin_kind<>'BACKFILL' AND task_type NOT IN ('DISCOVER','RECONCILE','BACKUP')",
    ].map((predicate) =>
      store.db
        .prepare(
          `SELECT * FROM jobs WHERE owner_id=? AND state='PENDING' AND due_at<=? AND ${predicate} AND ${runtimeAdmissionPredicate} AND ${taskPredicate} ${analysisMode ? "AND json_extract(payload_json,'$.snapshot.settings.mode')='PRODUCTION'" : ''} ORDER BY priority DESC,arrival_origin_at,job_id LIMIT 20`,
        )
        .bind(
          store.context.ownerId,
          now.toISOString(),
          runtime,
          runtime,
          ...admittedTasks,
        )
        .all<JobRecord>(),
    ),
  );
  const rows = groups
    .flatMap((group) => group.results)
    .filter(
      (row) =>
        store.context.scopes.includes(row.task_type) &&
        (!tasks || tasks.includes(row.task_type)),
    );
  const selected = fairJobOrder(rows, slots, now),
    leases = [];
  for (const job of selected) {
    const token = await store.lease(job.job_id, job.task_type, now, runtime);
    if (token) leases.push({ token, job });
  }
  return leases;
}
