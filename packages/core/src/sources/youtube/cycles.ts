import type { Database } from '../../db/boundary.js';
import { sha256 } from '../../auth/crypto.js';
import { discoveryWindow } from './reconcile.js';
import type { QueueSignal } from '../../../../contracts/src/jobs.js';

export const defaultMonitoringSlots = '15:00,23:00';
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
/** IANA clock handles DST. Replays today's missed slots; existing cycles resume
 * independently of the day/slot. Switching to 23:00 is configuration only. */
export function monitoringSlots(
  now: Date,
  configuration = defaultMonitoringSlots,
) {
  const slots = configuration.split(',');
  if (
    !slots.length ||
    slots.length > 2 ||
    new Set(slots).size !== slots.length ||
    slots.some((slot) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(slot))
  )
    throw new Error('INVALID_MONITORING_SLOTS');
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`,
    time = `${parts.hour}:${parts.minute}`;
  return slots
    .sort()
    .filter((slot) => slot <= time)
    .map((slot) => ({ date, slot }));
}
export interface MonitoringCycle {
  cycle_id: string;
  owner_id: string;
  members_json: string;
  cursor: number;
  total: number;
  state: string;
  started_at: string;
  completed: number;
  failed: number;
}
export async function startMonitoringCycles(
  db: Database,
  now: Date,
  slots?: string,
) {
  let scheduled = 0;
  for (const { date, slot } of monitoringSlots(now, slots)) {
    // One atomic snapshot per owner. Duplicate cron delivery does not resnapshot.
    const result = await db
      .prepare(
        `INSERT INTO monitoring_cycles(cycle_id,owner_id,local_date,slot,members_json,total,started_at,updated_at)
      SELECT 'monitor:'||owner_id||':'||?1||':'||?2,owner_id,?1,?2,json_group_array(source_id),COUNT(*),?3,?3
      FROM (SELECT owner_id,source_id FROM sources WHERE enabled=1 ORDER BY owner_id,source_id) GROUP BY owner_id
      ON CONFLICT(owner_id,local_date,slot) DO NOTHING`,
      )
      .bind(date, slot, now.toISOString())
      .run();
    scheduled += result.meta.changes;
  }
  return { scheduled };
}
/** Three set-based writes per five members, with a cursor CAS in the same D1
 * transaction. No unbounded loop of SQL operations or external channel calls. */
export async function enrollMonitoringBatch(
  db: Database,
  now: Date,
  cycleId?: string,
  limit = 5,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10)
    throw new Error('INVALID_LIMIT');
  const cycle = await db
    .prepare(
      "SELECT * FROM monitoring_cycles WHERE state='ENROLLING' AND (? IS NULL OR cycle_id=?) ORDER BY started_at,cycle_id LIMIT 1",
    )
    .bind(cycleId ?? null, cycleId ?? null)
    .first<MonitoringCycle>();
  if (!cycle) return { scheduled: 0, continuation: false };
  const ids = (JSON.parse(cycle.members_json) as string[]).slice(
    cycle.cursor,
    cycle.cursor + limit,
  );
  const sources = (
    await db
      .prepare(
        `SELECT s.source_id,s.window_start,s.activated_at,s.last_complete_window_end
    FROM json_each(?) x JOIN sources s ON s.owner_id=? AND s.source_id=x.value ORDER BY x.key`,
      )
      .bind(JSON.stringify(ids), cycle.owner_id)
      .all<{
        source_id: string;
        window_start: string | null;
        activated_at: string;
        last_complete_window_end: string | null;
      }>()
  ).results;
  if (sources.length !== ids.length)
    throw new Error('MONITORING_SNAPSHOT_SOURCE_MISSING');
  const at = now.toISOString();
  const rows = await Promise.all(
    sources.map(async (source) => {
      const window = discoveryWindow(
        now,
        source.window_start ?? source.activated_at,
        source.last_complete_window_end,
        'RSS',
      );
      const key = await sha256(`${cycle.cycle_id}:${source.source_id}`);
      return {
        source_id: source.source_id,
        job_id: `monitor_${key}`,
        scan_id: `scan_${key}`,
        dedup_key: key,
        ...window,
        payload_json: JSON.stringify({
          ...window,
          mode: 'RSS',
          monitoring_cycle_id: cycle.cycle_id,
        }),
      };
    }),
  );
  const json = JSON.stringify(rows),
    guard =
      "EXISTS(SELECT 1 FROM monitoring_cycles WHERE cycle_id=? AND cursor=? AND state='ENROLLING')";
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO jobs(job_id,owner_id,source_id,task_type,input_revision,profile_revision,routing_policy_version,explicit_run_nonce,dedup_key,state,due_at,priority,arrival_origin_at,origin_kind,payload_json,created_at,updated_at)
      SELECT json_extract(x.value,'$.job_id'),?,json_extract(x.value,'$.source_id'),'DISCOVER',?,'economy-1','control-plane-1','',json_extract(x.value,'$.dedup_key'),'PENDING',?,130,?,'INTEGRITY',json_extract(x.value,'$.payload_json'),?,? FROM json_each(?) x WHERE ${guard}
      ON CONFLICT(owner_id,dedup_key) DO NOTHING`,
      )
      .bind(
        cycle.owner_id,
        `RSS:${cycle.cycle_id}`,
        at,
        at,
        at,
        at,
        json,
        cycle.cycle_id,
        cycle.cursor,
      ),
    db
      .prepare(
        `INSERT INTO discovery_scans(scan_id,owner_id,source_id,job_id,window_start,window_end,coverage,started_at,monitoring_cycle_id)
      SELECT json_extract(value,'$.scan_id'),?,json_extract(value,'$.source_id'),json_extract(value,'$.job_id'),json_extract(value,'$.window_start'),json_extract(value,'$.window_end'),'PENDING',?,? FROM json_each(?) WHERE ${guard}
      ON CONFLICT(owner_id,job_id) DO NOTHING`,
      )
      .bind(
        cycle.owner_id,
        at,
        cycle.cycle_id,
        json,
        cycle.cycle_id,
        cycle.cursor,
      ),
    db
      .prepare(
        "UPDATE monitoring_cycles SET cursor=cursor+?,state=CASE WHEN cursor+?=total THEN 'RUNNING' ELSE 'ENROLLING' END,updated_at=? WHERE cycle_id=? AND cursor=? AND state='ENROLLING'",
      )
      .bind(ids.length, ids.length, at, cycle.cycle_id, cycle.cursor),
  ]);
  return {
    scheduled: results[0]!.meta.changes,
    continuation: cycle.cursor + ids.length < cycle.total,
    cycle_id: cycle.cycle_id,
  };
}
export async function refreshMonitoringProgress(
  db: Database,
  now: Date,
  ownerId?: string,
) {
  // Completion requires terminal jobs AND actual scan commit for successes.
  await db
    .prepare(
      `UPDATE monitoring_cycles SET
    completed=(SELECT COUNT(*) FROM discovery_scans s JOIN jobs j ON j.owner_id=s.owner_id AND j.job_id=s.job_id WHERE s.monitoring_cycle_id=monitoring_cycles.cycle_id AND j.state='SUCCEEDED' AND s.pages_committed>0),
    failed=(SELECT COUNT(*) FROM discovery_scans s JOIN jobs j ON j.owner_id=s.owner_id AND j.job_id=s.job_id WHERE s.monitoring_cycle_id=monitoring_cycles.cycle_id AND j.state IN ('FAILED','BLOCKED')),updated_at=?
    WHERE state='RUNNING' AND (? IS NULL OR owner_id=?)`,
    )
    .bind(now.toISOString(), ownerId ?? null, ownerId ?? null)
    .run();
  await db
    .prepare(
      "UPDATE monitoring_cycles SET state=CASE WHEN failed=0 THEN 'COMPLETE' ELSE 'FAILED' END,finished_at=?,updated_at=? WHERE state='RUNNING' AND cursor=total AND completed+failed=total AND (? IS NULL OR owner_id=?)",
    )
    .bind(
      now.toISOString(),
      now.toISOString(),
      ownerId ?? null,
      ownerId ?? null,
    )
    .run();
}
export async function nextControlSignal(
  db: Database,
  now: Date,
  ownerId?: string,
): Promise<QueueSignal | null> {
  const row = await db
    .prepare(
      `SELECT job_id,task_type,fencing_token FROM jobs WHERE (? IS NULL OR owner_id=?) AND task_type IN ('DISCOVER','RECONCILE')
    AND ((state='PENDING' AND due_at<=?) OR (state='DEFERRED' AND reason_code='CONTINUATION' AND due_at<=?) OR (state='RUNNING' AND lease_until>?))
    ORDER BY priority DESC,arrival_origin_at,job_id LIMIT 1`,
    )
    .bind(
      ownerId ?? null,
      ownerId ?? null,
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
    )
    .first<{
      job_id: string;
      task_type: 'DISCOVER' | 'RECONCILE';
      fencing_token: number;
    }>();
  return row
    ? {
        job_id: row.job_id,
        task_type: row.task_type,
        fencing_hint: row.fencing_token,
      }
    : null;
}
export async function wakeMonitoring(
  db: Database,
  queue: { send: (message: unknown) => Promise<unknown> },
  now: Date,
) {
  const cycle = await db
    .prepare(
      "SELECT cycle_id FROM monitoring_cycles WHERE state='ENROLLING' ORDER BY started_at,cycle_id LIMIT 1",
    )
    .first<{ cycle_id: string }>();
  if (cycle)
    await queue.send({ kind: 'SOURCE_CYCLE', cycle_id: cycle.cycle_id });
  else {
    const signal = await nextControlSignal(db, now);
    if (signal) await queue.send(signal);
  }
}
export async function wakeSourceRecovery(
  db: Database,
  queue: { send: (message: unknown) => Promise<unknown> },
  now: Date,
  ownerId: string | null = null,
) {
  const due = await db
    .prepare(
      `SELECT 1 FROM sources s WHERE s.enabled=1 AND (?2 IS NULL OR s.owner_id=?2) AND (s.full_due_at IS NULL OR s.full_due_at<=?1 OR s.weekly_due_at IS NULL OR s.weekly_due_at<=?1)
    AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.owner_id=s.owner_id AND j.source_id=s.source_id AND j.task_type IN ('DISCOVER','RECONCILE') AND COALESCE(json_extract(j.payload_json,'$.mode'),'FULL')='FULL' AND j.state IN ('PENDING','LEASED','RUNNING','DEFERRED','RETRY_WAIT')) LIMIT 1`,
    )
    .bind(now.toISOString(), ownerId)
    .first();
  if (due) await queue.send({ kind: 'SOURCE_RECOVERY' });
}
