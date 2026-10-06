import { expect, it } from 'vitest';
import { LocalAnalysisWorker } from '../../apps/executor/src/analysis-worker.js';
import { resumeChunkPreparation } from '../../apps/executor/src/analysis-chunks.js';
import {
  WorkerRpc,
  WorkerRpcError,
} from '../../apps/executor/src/worker-rpc.js';

it('RPC retains only allowlisted quota categories and never a server body or credential', async () => {
  for (const [status, payload, expected] of [
    [503, { code: 'QUOTA_UNKNOWN_OR_STALE' }, 'QUOTA_UNKNOWN_OR_STALE'],
    [503, { code: 'QUOTA_ADMISSION_DENIED' }, 'QUOTA_ADMISSION_DENIED'],
    [500, { code: 'QUOTA_UNKNOWN_OR_STALE' }, null],
    [503, { code: 'INTERNAL_ERROR', message: 'private-secret' }, null],
    [503, { code: 'QUOTA_POLICY_NOT_CONFIGURED' }, null],
    [503, { code: 'QUOTA_UNKNOWN_OR_STALE', message: 'x'.repeat(5000) }, null],
  ] as const) {
    const rpc = new WorkerRpc(
      'https://fixture.invalid',
      'a'.repeat(43),
      async () => Response.json(payload, { status }),
    );
    try {
      await rpc.request('analysis/reserve', {});
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerRpcError);
      expect((error as WorkerRpcError).code).toBe(expected);
      expect(JSON.stringify(error)).not.toContain('private-secret');
    }
  }
});
it('interrupted chunk enqueue resumes through bounded control pages and stops on a stale response', async () => {
  const token = {
    job_id: 'parent',
    lease_owner: 'worker',
    fencing_token: 7,
    lease_until: '2026-10-06T20:00:00Z',
  };
  const calls: string[] = [];
  const rpc = {
    request: async (route: string, input: Record<string, unknown>) => {
      calls.push(route);
      expect(input).toEqual({ token, plan_artifact_id: 'plan' });
      return {
        plan_hash: 'a'.repeat(64),
        state: calls.length === 2 ? 'DEFERRED' : 'RUNNING',
        preparation_complete: calls.length === 2,
      };
    },
  };
  expect(
    await resumeChunkPreparation(rpc, token, 'plan', 'a'.repeat(64)),
  ).toEqual({
    accepted: false,
    idle: false,
    state: 'DEFERRED',
    generation_requests: 0,
  });
  expect(calls).toEqual(['analysis/chunks/create', 'analysis/chunks/create']);
  let attempts = 0;
  await expect(
    resumeChunkPreparation(
      {
        request: async () => {
          attempts++;
          throw new WorkerRpcError(
            'EXECUTOR_RPC_FAILED',
            'analysis/chunks/create',
            403,
          );
        },
      },
      token,
      'plan',
      'a'.repeat(64),
    ),
  ).rejects.toThrow('EXECUTOR_RPC_FAILED');
  expect(attempts).toBe(1);
});

it('local analysis polling requests only its capability and idle never reaches Gemini', async () => {
  const calls: { route: string; body: Record<string, unknown> }[] = [];
  let providerCalls = 0;
  const transport: typeof fetch = async (url, init) => {
    const route = new URL(String(url)).pathname.split('/').at(-1)!;
    const body = JSON.parse(String(init?.body));
    calls.push({ route, body });
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer ' + 'a'.repeat(43),
    });
    expect(JSON.stringify(body)).not.toContain('private-provider-key');
    return Response.json(route === 'lease' ? { leases: [] } : {});
  };
  const worker = new LocalAnalysisWorker(
    'https://fixture.invalid',
    'a'.repeat(43),
    'private-provider-key',
    transport,
    async () => {
      providerCalls++;
      throw new Error('unexpected provider HTTP');
    },
  );
  expect(await worker.cycle()).toEqual({
    accepted: false,
    idle: true,
    state: null,
  });
  expect(calls).toEqual([
    { route: 'heartbeat', body: { runtime: 'local' } },
    { route: 'lease', body: { runtime: 'local', task_type: 'ANALYZE' } },
  ]);
  expect(providerCalls).toBe(0);
});
it('a mismatched or unsupported analysis lease cannot start or call the provider', async () => {
  for (const invalid of [
    {
      job: { job_id: 'job', task_type: 'FETCH_TRANSCRIPT' },
      token: { job_id: 'job' },
    },
    {
      job: { job_id: 'job', task_type: 'ANALYZE' },
      token: { job_id: 'other' },
    },
  ]) {
    const routes: string[] = [];
    const transport: typeof fetch = async (url) => {
      const route = new URL(String(url)).pathname.split('/').at(-1)!;
      routes.push(route);
      return Response.json(route === 'lease' ? { leases: [invalid] } : {});
    };
    await expect(
      new LocalAnalysisWorker(
        'https://fixture.invalid',
        'a'.repeat(43),
        'private-provider-key',
        transport,
      ).cycle(),
    ).rejects.toThrow('INVALID_ANALYSIS_LEASE');
    expect(routes).toEqual(['heartbeat', 'lease']);
  }
});
