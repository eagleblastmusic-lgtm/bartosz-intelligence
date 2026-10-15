import {
  sweep,
  dispatchOutbox,
} from '../../../packages/core/src/jobs/recovery.js';
import { repairMissingIntents } from '../../../packages/core/src/sources/youtube/reconcile.js';
import {
  startMonitoringCycles,
  refreshMonitoringProgress,
  wakeMonitoring,
  wakeSourceRecovery,
} from '../../../packages/core/src/sources/youtube/cycles.js';
import { scheduleMetadataRefresh } from '../../../packages/core/src/sources/youtube/refresh.js';
import { observeRetention } from '../../../packages/core/src/retention/cleanup.js';
export async function recoverJobs(
  db: D1Database,
  queue: Queue,
  now: Date,
  automaticAiEnabled = false,
) {
  // Five jobs/events per invocation; continuation remains durable for next tick.
  const recovery = await sweep(
    db,
    now,
    (job) => job.reason_code !== 'WORKER_OFFLINE',
    5,
    automaticAiEnabled,
  );
  const transport = await dispatchOutbox(
    db,
    async (signal) => {
      await queue.send(signal);
    },
    now,
    5,
    automaticAiEnabled,
  );
  return { recovery, transport };
}
export async function scheduleControlPlane(
  db: D1Database,
  queue: Queue,
  now: Date,
  slots?: string,
  automaticAiEnabled = false,
  occurrenceAt = now,
) {
  // A delayed Cron occurrence selects its original Warsaw slots. Operational
  // maintenance and completion receipts must use the actual execution time.
  const sources = await startMonitoringCycles(db, occurrenceAt, slots);
  const reconciliation = await repairMissingIntents(db, now, 1);
  const metadata_refresh = await scheduleMetadataRefresh(db, now);
  const retention = await observeRetention(db, now);
  const recovery = await sweep(
    db,
    now,
    (job) => job.reason_code !== 'WORKER_OFFLINE',
    1,
    automaticAiEnabled,
  );
  const transport = await dispatchOutbox(
    db,
    async (signal) => {
      await queue.send(signal);
    },
    now,
    1,
    automaticAiEnabled,
  );
  await refreshMonitoringProgress(db, now);
  await wakeMonitoring(db, queue, now);
  await wakeSourceRecovery(db, queue, now);
  return {
    sources,
    reconciliation,
    metadata_refresh,
    retention,
    recovery,
    transport,
  };
}
