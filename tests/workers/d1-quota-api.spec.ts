import { expect, it } from 'vitest';
import { apiRouter } from '../../apps/api/src/routes/common.js';
import {
  WorkerRpc,
  WorkerRpcError,
} from '../../apps/executor/src/worker-rpc.js';
it('publishes a safe daily-limit code and reset delay to the executor, with no hidden retry', async () => {
  const router = apiRouter();
  router.post('/internal/workers/heartbeat', () => {
    throw new Error(
      "D1_ERROR: Your account has exceeded D1's free tier daily row read limit. private bound owner",
    );
  });
  let calls = 0;
  const transport: typeof fetch = async (input, init) => {
    calls++;
    return router.request(
      input instanceof Request ? input : new Request(String(input), init),
    );
  };
  const response = await transport(
    'https://example.test/internal/workers/heartbeat',
    { method: 'POST' },
  );
  expect(response.status).toBe(503);
  expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
  expect(await response.text()).not.toContain('private bound');
  const rpc = new WorkerRpc('https://example.test', 'a'.repeat(43), transport);
  try {
    await rpc.request('heartbeat', { runtime: 'local' });
    throw new Error('EXPECTED_FAILURE');
  } catch (error) {
    expect(error).toBeInstanceOf(WorkerRpcError);
    expect((error as WorkerRpcError).code).toBe('D1_DAILY_READ_LIMIT');
  }
  expect(calls).toBe(2);
});
