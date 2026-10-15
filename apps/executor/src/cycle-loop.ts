import { setTimeout as delay } from 'node:timers/promises';
import { WorkerRpcError } from './worker-rpc.js';
import { nextD1Reset } from '../../../packages/core/src/db/d1-quota.js';

/** One serial cycle at a time; durable jobs remain on the control plane. */
export async function runExecutorLoop(input: {
  cycle: () => Promise<{
    idle: boolean;
    accepted: boolean;
    retry_after_ms?: number;
    metrics?: Record<string, number | string | null>;
  }>;
  once: boolean;
  search: boolean;
  signal: AbortSignal;
  emit: (event: Record<string, unknown>, failure: boolean) => void;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  clock?: () => Date;
}): Promise<number> {
  const wait =
    input.wait ??
    ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  let failures = 0;
  while (!input.signal.aborted) {
    let interval = 30000;
    try {
      const result = await input.cycle();
      failures = 0;
      if (!result.idle) interval = input.search ? 250 : 0;
      interval = Math.max(interval, result.retry_after_ms ?? 0);
      input.emit(
        {
          event: 'LOCAL_EXECUTOR_CYCLE',
          accepted: result.accepted,
          idle: result.idle,
          ...(result.metrics ? { metrics: result.metrics } : {}),
        },
        false,
      );
    } catch (error) {
      const denied =
        error instanceof Error && error.message === 'EXECUTOR_AUTH_DENIED';
      input.emit(
        {
          event: denied
            ? 'LOCAL_EXECUTOR_AUTH_DENIED'
            : 'LOCAL_EXECUTOR_CYCLE_FAILED',
          ...(error instanceof WorkerRpcError
            ? {
                route: error.route,
                status: error.status,
                ...(error.code ? { code: error.code } : {}),
              }
            : {}),
        },
        true,
      );
      if (denied || input.once) return 1;
      failures = Math.min(failures + 1, 3);
      interval = Math.min(120000, 30000 * 2 ** (failures - 1));
      if (error instanceof WorkerRpcError)
        interval = Math.max(interval, error.retry_after_ms ?? 0);
      if (
        error instanceof WorkerRpcError &&
        (error.code === 'D1_DAILY_READ_LIMIT' ||
          error.code === 'D1_DAILY_WRITE_LIMIT')
      ) {
        const now = (input.clock ?? (() => new Date()))();
        interval = Math.max(
          1000,
          nextD1Reset(now).getTime() - now.getTime() + 5000,
        );
      }
    }
    if (input.once || input.signal.aborted) return 0;
    try {
      if (interval > 0) await wait(interval, input.signal);
    } catch (error) {
      if (input.signal.aborted) return 0;
      throw error;
    }
  }
  return 0;
}
