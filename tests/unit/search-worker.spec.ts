import { expect, it } from 'vitest';
import { LocalSearchWorker } from '../../apps/executor/src/search-worker.js';
it('bounds heartbeat frequency while draining search and reports actual projection completion', async () => {
  const paths: string[] = [];
  let now = 0;
  const worker = new LocalSearchWorker(
    'https://example.test',
    'a'.repeat(43),
    async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return Response.json(
        path.endsWith('/heartbeat')
          ? {}
          : {
              phase: 'COMPLETE',
              progressed: true,
              projection_completed: true,
            },
      );
    },
    () => now,
  );
  expect(await worker.cycle()).toEqual({ accepted: true, idle: false });
  now = 250;
  await worker.cycle();
  now = 59999;
  await worker.cycle();
  now = 60000;
  await worker.cycle();
  expect(paths.filter((path) => path.endsWith('/heartbeat'))).toHaveLength(2);
  expect(paths.filter((path) => path.endsWith('/search/step'))).toHaveLength(4);
});
it('does not attempt projection work after heartbeat authentication denial', async () => {
  let calls = 0;
  const worker = new LocalSearchWorker(
    'https://example.test',
    'a'.repeat(43),
    async () => {
      calls++;
      return Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
    },
  );
  await expect(worker.cycle()).rejects.toThrow('EXECUTOR_AUTH_DENIED');
  expect(calls).toBe(1);
});
it('retries failed heartbeat without marking it successfully published', async () => {
  let calls = 0;
  const worker = new LocalSearchWorker(
    'https://example.test',
    'a'.repeat(43),
    async (url) => {
      calls++;
      if (calls === 1) return new Response(null, { status: 503 });
      return Response.json(
        String(url).endsWith('/heartbeat')
          ? {}
          : { phase: 'COMPLETE', progressed: false },
      );
    },
    () => 0,
  );
  await expect(worker.cycle()).rejects.toThrow();
  expect(await worker.cycle()).toEqual({ accepted: false, idle: true });
  expect(calls).toBe(3);
});
