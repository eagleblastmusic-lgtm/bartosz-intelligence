import {
  parseSignal,
  signalDisposition,
} from '../../../packages/core/src/jobs/recovery.js';
import type { Env } from './env.js';
import { AccessContext } from '../../../packages/core/src/db/boundary.js';
import { sha256 } from '../../../packages/core/src/auth/crypto.js';
import { controlTick } from './control.js';
export async function consumeSignals(
  batch: MessageBatch<unknown>,
  db: D1Database,
  environment?: Env,
) {
  for (const message of batch.messages) {
    try {
      const signal = parseSignal(message.body);
      if (
        environment?.CONTROL_WORKER_CREDENTIAL &&
        (signal.task_type === 'DISCOVER' || signal.task_type === 'RECONCILE')
      ) {
        // A platform Queue hint grants no authority. Resolve the current scoped
        // credential, then acquire the canonical D1 lease in the shared service.
        const access = await AccessContext.worker(
          db,
          await sha256(environment.CONTROL_WORKER_CREDENTIAL),
        );
        const outcome = await controlTick(environment, access, 3);
        // Partial pages were durably committed before sending another hint.
        // A send failure retries this hint; cron also resumes from D1 alone.
        if ('continuation' in outcome && outcome.continuation)
          await environment.BARTOSZ_QUEUE.send(signal);
        message.ack();
        continue;
      }
      if ((await signalDisposition(db, signal)) === 'ACK') message.ack();
      else message.retry({ delaySeconds: 60 });
    } catch {
      message.retry({ delaySeconds: 60 });
    }
  }
}
