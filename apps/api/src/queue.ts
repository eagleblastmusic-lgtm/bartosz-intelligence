import {
  parseSignal,
  signalDisposition,
} from '../../../packages/core/src/jobs/recovery.js';
export async function consumeSignals(
  batch: MessageBatch<unknown>,
  db: D1Database,
) {
  for (const message of batch.messages) {
    try {
      const signal = parseSignal(message.body);
      if ((await signalDisposition(db, signal)) === 'ACK') message.ack();
      else message.retry({ delaySeconds: 60 });
    } catch {
      message.retry({ delaySeconds: 60 });
    }
  }
}
