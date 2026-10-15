import {
  parseSignal,
  signalDisposition,
} from '../../../packages/core/src/jobs/recovery.js';
import type { Env } from './env.js';
import { AccessContext } from '../../../packages/core/src/db/boundary.js';
import { sha256 } from '../../../packages/core/src/auth/crypto.js';
import { controlTick } from './control.js';
import { scheduleControlPlane } from './scheduled.js';
import {
  scheduleTranscriptArchive,
  scheduleDriveExport,
  scheduleRetentionCleanup,
} from './drive-export.js';
import { scheduleDailyReports } from './daily-workflow.js';
import {
  enrollMonitoringBatch,
  refreshMonitoringProgress,
  wakeMonitoring,
  nextControlSignal,
  wakeSourceRecovery,
} from '../../../packages/core/src/sources/youtube/cycles.js';
import { scheduleSources } from '../../../packages/core/src/sources/youtube/reconcile.js';
export async function consumeSignals(
  batch: MessageBatch<unknown>,
  db: D1Database,
  environment?: Env,
) {
  for (const message of batch.messages) {
    try {
      const body = message.body as Record<string, unknown> | null;
      if (body?.kind === 'CONTROL_MAINTENANCE') {
        if (
          !environment?.CONTROL_WORKER_CREDENTIAL ||
          Object.keys(body).sort().join(',') !== 'kind,scheduled_at' ||
          typeof body.scheduled_at !== 'string'
        )
          throw new Error('INVALID_SIGNAL');
        const scheduledAt = new Date(body.scheduled_at);
        if (
          !Number.isFinite(scheduledAt.getTime()) ||
          scheduledAt.toISOString() !== body.scheduled_at ||
          scheduledAt.getTime() > Date.now()
        )
          throw new Error('INVALID_SIGNAL');
        const access = await AccessContext.worker(
          db,
          await sha256(environment.CONTROL_WORKER_CREDENTIAL),
        );
        access.requireTask('DISCOVER');
        access.requireTask('RECONCILE');
        // Preserve the original Warsaw slot across Queue delay/retry while
        // leases, recovery and completion receipts use the execution clock.
        await scheduleControlPlane(
          db,
          environment.BARTOSZ_QUEUE,
          new Date(),
          environment.MONITORING_SLOTS,
          environment.AUTOMATIC_AI_ENABLED === 'true',
          scheduledAt,
        );
        message.ack();
        continue;
      }
      if (body?.kind === 'SOURCE_RECOVERY') {
        if (
          !environment?.CONTROL_WORKER_CREDENTIAL ||
          Object.keys(body).join(',') !== 'kind'
        )
          throw new Error('INVALID_SIGNAL');
        const access = await AccessContext.worker(
          db,
          await sha256(environment.CONTROL_WORKER_CREDENTIAL),
        );
        access.requireTask('RECONCILE');
        await scheduleSources(
          db,
          new Date(),
          5,
          Math.random,
          true,
          access.ownerId,
        );
        await wakeSourceRecovery(
          db,
          environment.BARTOSZ_QUEUE,
          new Date(),
          access.ownerId,
        );
        const next = await nextControlSignal(db, new Date(), access.ownerId);
        if (next) await environment.BARTOSZ_QUEUE.send(next);
        message.ack();
        continue;
      }
      if (
        body?.kind === 'TRANSCRIPT_ARCHIVE' ||
        body?.kind === 'DAILY_WORKFLOW' ||
        body?.kind === 'DAILY_TRANSCRIPTS' ||
        body?.kind === 'DRIVE_EXPORT' ||
        body?.kind === 'LEGACY_RETENTION'
      ) {
        if (!environment || Object.keys(body).join(',') !== 'kind')
          throw new Error('INVALID_SIGNAL');
        if (body.kind === 'TRANSCRIPT_ARCHIVE')
          await scheduleTranscriptArchive(environment, new Date());
        else if (body.kind === 'DRIVE_EXPORT')
          await scheduleDriveExport(environment, new Date());
        else if (body.kind === 'LEGACY_RETENTION')
          await scheduleRetentionCleanup(environment, new Date());
        else
          await scheduleDailyReports(
            environment,
            new Date(),
            body.kind === 'DAILY_TRANSCRIPTS' ? 'TRANSCRIPT' : 'REPORTS',
          );
        message.ack();
        continue;
      }
      if (body?.kind === 'SOURCE_CYCLE') {
        if (
          !environment?.CONTROL_WORKER_CREDENTIAL ||
          typeof body.cycle_id !== 'string' ||
          Object.keys(body).sort().join(',') !== 'cycle_id,kind'
        )
          throw new Error('INVALID_SIGNAL');
        const access = await AccessContext.worker(
          db,
          await sha256(environment.CONTROL_WORKER_CREDENTIAL),
        );
        access.requireTask('DISCOVER');
        const cycle = await db
          .prepare('SELECT owner_id FROM monitoring_cycles WHERE cycle_id=?')
          .bind(body.cycle_id)
          .first<{ owner_id: string }>();
        if (!cycle || cycle.owner_id !== access.ownerId)
          throw new Error('FORBIDDEN');
        await enrollMonitoringBatch(db, new Date(), body.cycle_id);
        await wakeMonitoring(db, environment.BARTOSZ_QUEUE, new Date());
        message.ack();
        continue;
      }
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
        await controlTick(environment, access, 3);
        await refreshMonitoringProgress(db, new Date(), access.ownerId);
        // Partial pages were durably committed before sending another hint.
        // A send failure retries this hint; cron also resumes from D1 alone.
        const next = await nextControlSignal(db, new Date(), access.ownerId);
        if (next) await environment.BARTOSZ_QUEUE.send(next);
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
