import { expect, it } from 'vitest';
import { LocalAnalysisWorker } from '../../apps/executor/src/analysis-worker.js';

const id = 'd06d2a72-b4c0-455f-b252-3cb4f28ac8ed';
it('a background worker refuses a quality experiment even if a server returns it', async () => {
  const routes: string[] = [];
  const worker = new LocalAnalysisWorker(
    'https://example.test',
    'a'.repeat(43),
    'synthetic',
    async (url) => {
      const path = new URL(String(url)).pathname;
      routes.push(path);
      if (path.endsWith('/analysis/schedule'))
        return Response.json({ next_cursor: null, provider_requests: 0 });
      if (path.endsWith('/lease'))
        return Response.json({
          leases: [
            {
              token: { job_id: id },
              job: {
                job_id: id,
                task_type: 'ANALYZE',
                payload_json: JSON.stringify({
                  snapshot: { settings: { mode: 'QUALITY_TEST' } },
                }),
              },
            },
          ],
        });
      return Response.json({});
    },
    async () => {
      throw new Error('NO_PROVIDER_REQUEST_ALLOWED');
    },
  );
  await expect(worker.cycle()).rejects.toThrow('INVALID_ANALYSIS_LEASE');
  expect(routes.some((path) => path.endsWith('/start'))).toBe(false);
});
it('advances bounded source planning pages and wraps for deferred sources without Gemini', async () => {
  const cursor = {
    accepted_at: '2026-10-08T14:00:00Z',
    run_id: 'transcript_fixture',
  };
  const seen: unknown[] = [];
  const worker = new LocalAnalysisWorker(
    'https://example.test',
    'a'.repeat(43),
    'synthetic',
    async (url, init) => {
      if (String(url).endsWith('/analysis/schedule')) {
        seen.push(JSON.parse(String(init?.body)).after);
        return Response.json({
          next_cursor: seen.length === 1 ? cursor : null,
          provider_requests: 0,
        });
      }
      return Response.json(
        String(url).endsWith('/lease') ? { leases: [] } : {},
      );
    },
    async () => {
      throw new Error('NO_PROVIDER_REQUEST_ALLOWED');
    },
  );
  await worker.cycle();
  await worker.cycle();
  await worker.cycle();
  expect(seen).toEqual([null, cursor, null]);
});
it('pins a bounded operator cycle to one job without changing default fair pull', async () => {
  for (const selected of [undefined, id]) {
    const requests: Record<string, unknown>[] = [];
    const worker = new LocalAnalysisWorker(
      'https://example.test',
      'a'.repeat(43),
      'synthetic',
      async (url, init) => {
        const input = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (String(url).endsWith('/analysis/schedule')) {
          expect(selected).toBeUndefined();
          return Response.json({ next_cursor: null, provider_requests: 0 });
        }
        if (String(url).endsWith('/lease')) {
          requests.push(input);
          return Response.json({ leases: [] });
        }
        expect(String(url)).toMatch(/\/heartbeat$/);
        return Response.json({});
      },
      async () => {
        throw new Error('NO_PROVIDER_REQUEST_ALLOWED');
      },
    );
    expect(await worker.cycle(selected)).toMatchObject({
      idle: true,
      accepted: false,
    });
    expect(requests).toEqual([
      {
        runtime: 'local',
        task_type: 'ANALYZE',
        ...(selected === undefined
          ? { analysis_mode: 'PRODUCTION' }
          : { job_id: id }),
      },
    ]);
  }
});
it('rejects malformed selected jobs before any HTTP', async () => {
  let calls = 0;
  const worker = new LocalAnalysisWorker(
    'https://example.test',
    'a'.repeat(43),
    'synthetic',
    async () => {
      calls++;
      throw new Error('NO_HTTP');
    },
  );
  await expect(worker.cycle('private-invalid-input')).rejects.toThrow(
    'INVALID_ANALYSIS_JOB_ID',
  );
  expect(calls).toBe(0);
});
it('does not start a different job returned by the selected-job lease', async () => {
  const routes: string[] = [];
  const other = '00000000-0000-4000-8000-000000000001';
  const worker = new LocalAnalysisWorker(
    'https://example.test',
    'a'.repeat(43),
    'synthetic',
    async (url) => {
      const route = new URL(String(url)).pathname;
      routes.push(route);
      return route.endsWith('/lease')
        ? Response.json({
            leases: [
              {
                token: { job_id: other },
                job: { job_id: other, task_type: 'ANALYZE' },
              },
            ],
          })
        : Response.json({});
    },
    async () => {
      throw new Error('NO_PROVIDER_REQUEST_ALLOWED');
    },
  );
  await expect(worker.cycle(id)).rejects.toThrow('INVALID_ANALYSIS_LEASE');
  expect(routes).toEqual([
    '/internal/workers/heartbeat',
    '/internal/workers/lease',
  ]);
});
