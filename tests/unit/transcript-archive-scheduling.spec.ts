// API code uses Workers globals; excluded from the Node-only tools typecheck.
import { beforeEach, expect, it, vi } from 'vitest';
import type { Env } from '../../apps/api/src/env.js';
const calls = vi.hoisted(() => ({ control: vi.fn() }));
vi.mock('../../apps/api/src/scheduled.js', () => ({
  scheduleControlPlane: calls.control,
}));
import worker from '../../apps/api/src/index.js';
beforeEach(() => calls.control.mockReset());
it('cron enqueues bounded independent work with production deletion disabled', async () => {
  const messages: unknown[] = [],
    pending: Promise<unknown>[] = [];
  const environment = {
    DRIVE_EXPORT_ENABLED: 'true',
    DAILY_REPORTS_ENABLED: 'true',
    TRANSCRIPT_ARCHIVE_ENABLED: 'true',
    RETENTION_DELETION_ENABLED: 'false',
    BARTOSZ_QUEUE: {
      send: async (h: unknown) => {
        messages.push(h);
      },
    },
  } as unknown as Env;
  calls.control.mockResolvedValue({});
  worker.scheduled(
    { scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} },
    environment,
    {
      waitUntil(p: Promise<unknown>) {
        pending.push(p);
      },
    } as ExecutionContext,
  );
  await Promise.all(pending);
  expect(calls.control).toHaveBeenCalledOnce();
  expect(messages).toEqual([
    { kind: 'DRIVE_EXPORT' },
    { kind: 'DAILY_WORKFLOW' },
    { kind: 'DAILY_TRANSCRIPTS' },
    { kind: 'TRANSCRIPT_ARCHIVE' },
  ]);
});
it('a lost archive hint leaves maintenance independent and is recoverable on the next cron', async () => {
  const pending: Promise<unknown>[] = [],
    messages: unknown[] = [];
  calls.control.mockResolvedValue({});
  const environment = {
    TRANSCRIPT_ARCHIVE_ENABLED: 'true',
    BARTOSZ_QUEUE: {
      send: async () => {
        throw new Error('lost hint');
      },
    },
  } as unknown as Env;
  const controller = {
    scheduledTime: Date.now(),
    cron: '*/5 * * * *',
    noRetry() {},
  };
  worker.scheduled(controller, environment, {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
  } as ExecutionContext);
  expect(
    (await Promise.allSettled(pending)).filter((p) => p.status === 'rejected'),
  ).toHaveLength(1);
  environment.BARTOSZ_QUEUE = {
    send: async (h: unknown) => {
      messages.push(h);
    },
  } as unknown as Queue;
  pending.length = 0;
  worker.scheduled(controller, environment, {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
  } as ExecutionContext);
  await Promise.all(pending);
  expect(messages).toEqual([{ kind: 'TRANSCRIPT_ARCHIVE' }]);
});
