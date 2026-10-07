import { it, expect, vi } from 'vitest';
import { LocalOptionalAIWorker } from '../../apps/executor/src/optional-worker.js';
import { executePreparedAnalysis } from '../../apps/executor/src/analysis-transport.js';
vi.mock('../../apps/executor/src/analysis-transport.js', () => ({
  executePreparedAnalysis: vi.fn(),
}));
it.each([
  {
    task: 'TRANSLATE',
    status: 'INCOMPLETE',
    raw: '{"status":"OK",',
    artifact: 'retained-partial',
    route: 'optional/complete',
  },
  {
    task: 'TRANSLATE',
    status: 'INCOMPLETE',
    raw: null,
    artifact: null,
    route: 'retry',
  },
  {
    task: 'HISTORICAL_COMPARE',
    status: 'INCOMPLETE',
    raw: '{"status":"OK",',
    artifact: 'retained-partial',
    route: 'retry',
  },
] as const)(
  'routes $task/$raw truncation to $route without treating it as accepted output',
  async ({ task, status, raw, artifact, route }) => {
    const token = {
        job_id: 'job',
        lease_owner: 'worker',
        fencing_token: 1,
        lease_until: '2026-10-07T12:00:00Z',
      },
      calls: string[] = [];
    vi.mocked(executePreparedAnalysis).mockReset();
    vi.mocked(executePreparedAnalysis).mockResolvedValueOnce({
      eligible_for_validation: false,
      response: { status, raw_output: raw },
      response_artifact_id: artifact,
      reservation_id: 'reservation',
      token,
      diagnostics: [],
    } as unknown as Awaited<ReturnType<typeof executePreparedAnalysis>>);
    const transport = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname.replace(
        '/internal/workers/',
        '',
      );
      calls.push(path);
      const value =
        path === 'lease'
          ? { leases: [{ job: { job_id: 'job', task_type: task }, token }] }
          : path === 'optional/input'
            ? { request: { request_id: 'run' }, snapshot: { item_id: 'item' } }
            : path === 'optional/complete'
              ? { accepted: false, state: 'FAILED' }
              : { state: 'RETRY_WAIT' };
      return Response.json(value);
    });
    const result = await new LocalOptionalAIWorker(
      task,
      'https://fixture.invalid',
      'x'.repeat(43),
      'fixture-key',
      transport,
    ).cycle();
    expect(result.accepted).toBe(false);
    expect(calls).toContain(route);
    expect(calls).not.toContain(
      route === 'retry' ? 'optional/complete' : 'retry',
    );
    expect(result.state).toBe(route === 'retry' ? 'RETRY_WAIT' : 'FAILED');
  },
);
