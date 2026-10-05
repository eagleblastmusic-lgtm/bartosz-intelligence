import {
  sweep,
  dispatchOutbox,
} from '../../../packages/core/src/jobs/recovery.js';
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
