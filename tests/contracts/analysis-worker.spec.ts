import { expect, it } from 'vitest';
import { LocalAnalysisWorker } from '../../apps/executor/src/analysis-worker.js';
import { resumeChunkPreparation } from '../../apps/executor/src/analysis-chunks.js';
import { loadAnalysisSource } from '../../apps/executor/src/analysis-preparation.js';
import type { ArtifactRow } from '../../packages/core/src/artifacts/store.js';
import type { AnalysisJobSnapshot } from '../../packages/core/src/ai/jobs.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import {
  WorkerRpc,
  WorkerRpcError,
} from '../../apps/executor/src/worker-rpc.js';

it('prepares legacy and archival source identities while rejecting a map from another acquisition', async () => {
  const token = {
    job_id: 'job',
    lease_owner: 'worker',
    fencing_token: 1,
    lease_until: '2026-10-10T00:15:00.000Z',
  };
  const snapshot = {
    version: 'analysis-job:1',
    settings: { runtime: 'local' },
    source: {
      item_id: 'item',
      source_artifact_id: 'source',
      source_hash: 'a'.repeat(64),
      segment_map_artifact_id: 'map',
      manifest_hash: 'b'.repeat(64),
    },
  } as AnalysisJobSnapshot;
  const rpc = new WorkerRpc(
    'https://fixture.invalid',
    'a'.repeat(43),
    async () =>
      Response.json({
        run_id: 'analysis_' + 'c'.repeat(64),
        snapshot,
        snapshot_hash: await sha256(JSON.stringify(snapshot)),
      }),
  );
  const header: ArtifactRow = {
    artifact_id: 'source',
    item_id: 'item',
    owner_id: 'owner',
    kind: 'SOURCE_ORIGINAL',
    content_hash: 'a'.repeat(64),
    byte_size: 1,
    chunk_count: 1,
    schema_version: 'source:1',
    producer_version: 'yt-dlp@2026.08.19+yt-dlp-ejs@0.8.0',
    original_ref: null,
    state: 'VERIFIED',
    manifest_hash: 'd'.repeat(64),
    provenance_json: '{}',
    created_at: '2026-10-10T00:00:00.000Z',
    verified_at: '2026-10-10T00:00:00.000Z',
  };
  for (const suffix of ['', ':archive-source:1:' + 'e'.repeat(64)]) {
    const source = {
      ...header,
      producer_version: header.producer_version + suffix,
    };
    const map = {
      ...header,
      artifact_id: 'map',
      kind: 'SEGMENT_MAP' as const,
      content_hash: 'b'.repeat(64),
      original_ref: 'source',
      producer_version: 'source-normalizer:1' + suffix,
    };
    const readText = async (id: string) => ({
      text: 'x',
      artifact: id === 'source' ? source : map,
    });
    await expect(
      loadAnalysisSource(rpc, { readText }, token, 'local'),
    ).resolves.toMatchObject({
      source: { artifact: source },
      map: { artifact: map },
    });
    map.producer_version =
      'source-normalizer:1:archive-source:1:' + 'f'.repeat(64);
    await expect(
      loadAnalysisSource(rpc, { readText }, token, 'local'),
    ).rejects.toThrow('ANALYSIS_SOURCE_ARTIFACT_MISMATCH');
  }
});

it('RPC retains only allowlisted quota categories and never a server body or credential', async () => {
  for (const [status, payload, expected] of [
    [503, { code: 'QUOTA_UNKNOWN_OR_STALE' }, 'QUOTA_UNKNOWN_OR_STALE'],
    [503, { code: 'QUOTA_ADMISSION_DENIED' }, 'QUOTA_ADMISSION_DENIED'],
    [
      503,
      { code: 'ANALYSIS_PROFILE_ACCOUNT_PURPOSE_REGION' },
      'ANALYSIS_PROFILE_ACCOUNT_PURPOSE_REGION',
    ],
    [
      503,
      { code: 'ANALYSIS_PROFILE_QUALITY_SCOPE' },
      'ANALYSIS_PROFILE_QUALITY_SCOPE',
    ],
    [503, { code: 'ANALYSIS_PROFILE_RUNTIME_BUDGET' }, null],
    [500, { code: 'ANALYSIS_PROFILE_ACCOUNT_PURPOSE_REGION' }, null],
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
it('expired pinned eligibility defers before provider HTTP and arbitrary input failures stay errors', async () => {
  for (const code of [
    'ANALYSIS_PROFILE_ACCOUNT_PURPOSE_REGION',
    'ANALYSIS_PROFILE_QUALITY_SCOPE',
    'INTERNAL_ERROR',
  ]) {
    const token = {
      job_id: 'job',
      lease_owner: 'worker',
      fencing_token: 4,
      lease_until: new Date(Date.now() + 60000).toISOString(),
    };
    const calls: { route: string; body: Record<string, unknown> }[] = [];
    let providerCalls = 0;
    const transport: typeof fetch = async (url, init) => {
      const route = new URL(String(url)).pathname.replace(
        '/internal/workers/',
        '',
      );
      const body = JSON.parse(String(init?.body));
      calls.push({ route, body });
      if (route === 'analysis/schedule')
        return Response.json({ next_cursor: null, provider_requests: 0 });
      if (route === 'analysis/input')
        return Response.json({ code }, { status: 503 });
      return Response.json(
        route === 'lease'
          ? {
              leases: [
                {
                  token,
                  job: {
                    job_id: 'job',
                    task_type: 'ANALYZE',
                    payload_json: JSON.stringify({
                      snapshot: { settings: { mode: 'PRODUCTION' } },
                    }),
                  },
                },
              ],
            }
          : {},
      );
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
    if (code === 'INTERNAL_ERROR') {
      await expect(worker.cycle()).rejects.toThrow('WORKER_RPC_FAILED');
      expect(calls.map((call) => call.route)).not.toContain('defer');
    } else {
      expect(await worker.cycle()).toEqual({
        accepted: false,
        idle: false,
        state: 'DEFERRED',
      });
      const deferred = calls.at(-1)!;
      expect(deferred.route).toBe('defer');
      expect(deferred.body).toMatchObject({
        task_type: 'ANALYZE',
        token,
        reason: 'MODEL_NOT_ELIGIBLE',
      });
      expect(Date.parse(String(deferred.body.due_at))).toBeGreaterThan(
        Date.now(),
      );
      expect(calls.map((call) => call.route)).toEqual([
        'heartbeat',
        'analysis/schedule',
        'lease',
        'start',
        'analysis/input',
        'defer',
      ]);
    }
    expect(providerCalls).toBe(0);
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
    return Response.json(
      route === 'lease'
        ? { leases: [] }
        : route === 'schedule'
          ? { next_cursor: null, provider_requests: 0 }
          : {},
    );
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
    { route: 'schedule', body: { after: null } },
    {
      route: 'lease',
      body: {
        runtime: 'local',
        task_type: 'ANALYZE',
        analysis_mode: 'PRODUCTION',
      },
    },
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
      return Response.json(
        route === 'lease'
          ? { leases: [invalid] }
          : route === 'schedule'
            ? { next_cursor: null, provider_requests: 0 }
            : {},
      );
    };
    await expect(
      new LocalAnalysisWorker(
        'https://fixture.invalid',
        'a'.repeat(43),
        'private-provider-key',
        transport,
      ).cycle(),
    ).rejects.toThrow('INVALID_ANALYSIS_LEASE');
    expect(routes).toEqual(['heartbeat', 'schedule', 'lease']);
  }
});
