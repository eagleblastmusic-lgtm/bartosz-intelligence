// Typechecked with the API's Workers globals, not the Node tool project.
import { beforeEach, expect, it, vi } from 'vitest';
import type { Env } from '../../apps/api/src/env.js';
const calls = vi.hoisted(() => ({
  daily: vi.fn(),
  transcript: vi.fn(),
  cleanup: vi.fn(),
  control: vi.fn(),
}));
vi.mock('../../apps/api/src/drive-export.js', () => ({
  scheduleDriveExport: calls.daily,
  scheduleTranscriptArchive: calls.transcript,
  scheduleRetentionCleanup: calls.cleanup,
}));
vi.mock('../../apps/api/src/scheduled.js', () => ({
  scheduleControlPlane: calls.control,
}));
import worker from '../../apps/api/src/index.js';
beforeEach(() => {
  for (const call of Object.values(calls)) call.mockReset();
});
it.each([false, true])(
  'settles P0 before transcript work and contains archive errors: daily failure %s',
  async (failure) => {
    let resolve!: () => void, reject!: (reason: Error) => void;
    const daily = new Promise<void>((ok, bad) => {
      resolve = ok;
      reject = bad;
    });
    calls.daily.mockReturnValue(daily);
    calls.control.mockResolvedValue(undefined);
    calls.transcript.mockRejectedValue(
      new Error('DRIVE_TRANSCRIPT_UNAVAILABLE'),
    );
    calls.cleanup.mockResolvedValue(undefined);
    const pending: Promise<unknown>[] = [];
    worker.scheduled(
      { scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} },
      {} as Env,
      {
        waitUntil(promise: Promise<unknown>) {
          pending.push(promise);
        },
      } as ExecutionContext,
    );
    expect(calls.daily).toHaveBeenCalledTimes(1);
    expect(calls.transcript).not.toHaveBeenCalled();
    if (failure) reject(new Error('DAILY_TRANSIENT_FAILURE'));
    else resolve();
    await Promise.all(pending);
    expect(calls.transcript).toHaveBeenCalledTimes(1);
    expect(calls.cleanup).toHaveBeenCalledTimes(1);
  },
);
