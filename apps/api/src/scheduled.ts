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
  const sources = await scheduleSources(db, now, 5);
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
  return { sources, reconciliation, metadata_refresh, recovery, transport };
}
