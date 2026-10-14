import { afterEach, expect, it, vi } from 'vitest';
import { ArtifactClient } from '../../apps/executor/src/artifact-client.js';
import { WorkerRpcError } from '../../apps/executor/src/worker-rpc.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';

afterEach(() => vi.useRealTimers());
const token = {
  job_id: 'job',
  lease_owner: 'worker',
  fencing_token: 1,
  lease_until: '2099-01-01T00:00:00.000Z',
};
const descriptor = {
  item_id: 'item',
  kind: 'RAW' as const,
  schema_version: 'fixture:1',
  producer_version: 'fixture',
  provenance: {},
  original_ref: null,
};
const body = 'source caption';

async function fixture(
  failures: { status: number; code?: string }[],
  failRoute = 'write',
) {
  const hash = await sha256(body),
    writes: RequestInit[] = [],
    routes: string[] = [];
  let firstWriteStarted!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    firstWriteStarted = resolve;
  });
  const fetcher: typeof fetch = async (input, init) => {
    const route = String(input).split('/').at(-1)!;
    routes.push(route);
    if (route === 'write') {
      writes.push(init!);
      firstWriteStarted();
    }
    if (route === failRoute && failures.length) {
      const failure = failures.shift()!;
      return Response.json(
        { code: failure.code ?? 'TRANSIENT' },
        { status: failure.status },
      );
    }
    const artifact = {
      ...descriptor,
      artifact_id: 'artifact',
      content_hash: hash,
      byte_size: body.length,
      chunk_count: 1,
      state: route === 'begin' ? 'UPLOADING' : 'VERIFIED',
    };
    return Response.json(
      route === 'begin'
        ? artifact
        : route === 'write'
          ? {}
          : { complete: true, artifact, proof: null, next_index: null },
    );
  };
  const client = new ArtifactClient(
    'https://executor.test',
    'x'.repeat(43),
    () => token,
    'FETCH_TRANSCRIPT',
    fetcher,
  );
  return { client, routes, writes, firstWrite };
}

it('retries an idempotent chunk at 500/1500 ms with identical payload and bounded attempts', async () => {
  vi.useFakeTimers();
  const { client, routes, writes, firstWrite } = await fixture([
    { status: 503 },
    { status: 502 },
  ]);
  const result = client.upload(body, descriptor);
  await firstWrite;
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(499);
  expect(writes).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(writes).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1500);
  expect((await result).state).toBe('VERIFIED');
  expect(routes).toEqual(['begin', 'write', 'write', 'write', 'verify-step']);
  expect(new Set(writes.map((row) => row.body)).size).toBe(1);
  expect(
    writes.every(
      (row) => row.signal instanceof AbortSignal && row.redirect === 'manual',
    ),
  ).toBe(true);
});

it('stops after three transient chunk failures and preserves the mapped error code', async () => {
  vi.useFakeTimers();
  const { client, routes, firstWrite } = await fixture([
    { status: 503 },
    { status: 504 },
    { status: 503, code: 'BACKUP_BUSY' },
  ]);
  const result = client.upload(body, descriptor);
  const failure = expect(result).rejects.toMatchObject({
    message: 'ARTIFACT_RPC_FAILED',
    route: 'artifacts/write',
    status: 503,
    code: 'BACKUP_BUSY',
  });
  await firstWrite;
  await vi.advanceTimersByTimeAsync(0);
  await vi.runAllTimersAsync();
  await failure;
  expect(routes).toEqual(['begin', 'write', 'write', 'write']);
});

it.each([
  'D1_DAILY_READ_LIMIT',
  'D1_DAILY_WRITE_LIMIT',
  'QUOTA_ADMISSION_DENIED',
])(
  'does not retry explicit %s and preserves it for disposition',
  async (code) => {
    const { client, routes } = await fixture([{ status: 503, code }]);
    await expect(client.upload(body, descriptor)).rejects.toMatchObject({
      message: 'ARTIFACT_RPC_FAILED',
      code,
    });
    expect(routes).toEqual(['begin', 'write']);
  },
);

it.each([401, 403, 409])(
  'does not retry auth/fence status %s',
  async (status) => {
    const { client, routes } = await fixture([{ status }]);
    await expect(client.upload(body, descriptor)).rejects.toBeInstanceOf(
      WorkerRpcError,
    );
    expect(routes).toEqual(['begin', 'write']);
  },
);

it('does not retry begin mutations or thrown transport aborts', async () => {
  const { client, routes } = await fixture([{ status: 503 }], 'begin');
  await expect(client.upload(body, descriptor)).rejects.toThrow(
    'ARTIFACT_RPC_FAILED',
  );
  expect(routes).toEqual(['begin']);
  const transport = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new DOMException('Aborted', 'AbortError'));
  const aborted = new ArtifactClient(
    'https://executor.test',
    'x'.repeat(43),
    () => token,
    'FETCH_TRANSCRIPT',
    transport,
  );
  await expect(aborted.upload(body, descriptor)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(transport).toHaveBeenCalledTimes(1);
});
