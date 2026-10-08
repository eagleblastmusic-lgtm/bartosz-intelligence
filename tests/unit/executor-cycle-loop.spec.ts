import { describe, expect, it } from 'vitest';
import { runExecutorLoop } from '../../apps/executor/src/cycle-loop.js';

describe('serial executor recovery loop', () => {
  it('bounds outage backoff and resets after recovery without exposing errors', async () => {
    const controller = new AbortController();
    const waits: number[] = [],
      events: Record<string, unknown>[] = [];
    let cycles = 0;
    const result = await runExecutorLoop({
      signal: controller.signal,
      once: false,
      search: false,
      cycle: async () => {
        cycles++;
        if (cycles <= 4 || cycles === 6)
          throw new Error('private token and source text');
        return { idle: false, accepted: true };
      },
      emit: (event) => {
        events.push(event);
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        if (cycles === 6) controller.abort();
      },
    });
    expect(result).toBe(0);
    expect(waits).toEqual([30000, 60000, 120000, 120000, 30000, 30000]);
    expect(JSON.stringify(events)).not.toContain('private');
    expect(events[4]).toEqual({
      event: 'LOCAL_EXECUTOR_CYCLE',
      accepted: true,
      idle: false,
    });
  });

  it('interrupts the actual idle timer on shutdown and does not pull again', async () => {
    const controller = new AbortController();
    let cycles = 0;
    const result = await runExecutorLoop({
      signal: controller.signal,
      once: false,
      search: false,
      cycle: async () => {
        cycles++;
        setTimeout(() => controller.abort(), 0);
        return { idle: true, accepted: false };
      },
      emit: () => {},
    });
    expect(result).toBe(0);
    expect(cycles).toBe(1);
  });

  it('fails closed on revoked authentication and on a failed single cycle', async () => {
    for (const once of [false, true]) {
      let waits = 0;
      expect(
        await runExecutorLoop({
          signal: new AbortController().signal,
          once,
          search: false,
          cycle: async () => {
            throw new Error(once ? 'private failure' : 'EXECUTOR_AUTH_DENIED');
          },
          emit: () => {},
          wait: async () => {
            waits++;
          },
        }),
      ).toBe(1);
      expect(waits).toBe(0);
    }
  });

  it('retains search progress pacing and normal idle pacing', async () => {
    const controller = new AbortController();
    let cycles = 0;
    const waits: number[] = [];
    await runExecutorLoop({
      signal: controller.signal,
      once: false,
      search: true,
      cycle: async () => ({ idle: ++cycles === 2, accepted: false }),
      emit: () => {},
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        if (cycles === 2) controller.abort();
      },
    });
    expect(waits).toEqual([250, 30000]);
  });
});
