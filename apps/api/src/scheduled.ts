import {
  sweep,
  dispatchOutbox,
} from '../../../packages/core/src/jobs/recovery.js';
import {
  scheduleSources,
  repairMissingIntents,
} from '../../../packages/core/src/sources/youtube/reconcile.js';
import { scheduleMetadataRefresh } from '../../../packages/core/src/sources/youtube/refresh.js';
export async function recoverJobs(db: D1Database, queue: Queue, now: Date) {
  // Five jobs/events per invocation; continuation remains durable for next tick.
  const recovery = await sweep(
    db,
    now,
    (job) => job.reason_code !== 'WORKER_OFFLINE',
    5,
  );
  const transport = await dispatchOutbox(
    db,
    async (signal) => {
      await queue.send(signal);
    },
    now,
    5,
  );
  return { recovery, transport };
}
export async function scheduleControlPlane(
  db: D1Database,
  queue: Queue,
  now: Date,
) {
  const sources = await scheduleSources(db, now, 1);
  const reconciliation = await repairMissingIntents(db, now, 1);
  const metadata_refresh = await scheduleMetadataRefresh(db, now);
  const recovery = await sweep(
    db,
    now,
    (job) => job.reason_code !== 'WORKER_OFFLINE',
    1,
  );
  const transport = await dispatchOutbox(
    db,
    async (signal) => {
      await queue.send(signal);
    },
    now,
    1,
  );
  // Queue transport can expire or a continuation send can fail. Rebuild one
  // bounded wake-up hint from durable state independently of delivery markers.
  const ready = await db
    .prepare(
      `SELECT job_id,task_type,fencing_token FROM jobs WHERE task_type IN ('DISCOVER','RECONCILE') AND ((state='PENDING' AND due_at<=?) OR (state='DEFERRED' AND reason_code='CONTINUATION' AND due_at<=?) OR (state='RUNNING' AND lease_until>?)) ORDER BY priority DESC,arrival_origin_at,job_id LIMIT 1`,
    )
    .bind(now.toISOString(), now.toISOString(), now.toISOString())
    .first<{
      job_id: string;
      task_type: 'DISCOVER' | 'RECONCILE';
      fencing_token: number;
    }>();
  if (ready)
    await queue.send({
      job_id: ready.job_id,
      task_type: ready.task_type,
      fencing_hint: ready.fencing_token,
    });
  return { sources, reconciliation, metadata_refresh, recovery, transport };
}
