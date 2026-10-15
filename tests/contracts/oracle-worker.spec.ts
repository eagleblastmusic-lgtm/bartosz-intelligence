import { expect, it } from 'vitest';
import { LocalTranscriptWorker } from '../../apps/executor/src/local-worker.js';
import {
  YtdlpTranscriptProvider,
  ytdlpProviderVersion,
} from '../../apps/executor/src/providers/ytdlp.js';

function controlPlane() {
  const calls: { route: string; input: Record<string, unknown> }[] = [];
  const token = {
    job_id: 'fixture-job',
    lease_owner: 'oracle-transcript-test',
    fencing_token: 7,
    lease_until: new Date(Date.now() + 900000).toISOString(),
  };
  const transport: typeof fetch = async (url, init) => {
    init?.signal?.throwIfAborted();
    const route = new URL(String(url)).pathname.split('/internal/workers/')[1]!;
    const input = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ route, input });
    const value =
      route === 'lease'
        ? { leases: [{ token, job: { task_type: 'FETCH_TRANSCRIPT' } }] }
        : route === 'heartbeat'
          ? { token: input.token ? token : null }
          : route === 'transcript/admission'
            ? { available: true, reason: null }
            : route === 'transcript/input'
              ? {
                  item_id: 'youtube:fixture0001',
                  namespace: 'youtube',
                  external_id: 'fixture0001',
                  duration_ms: 10000,
                }
              : {};
    return Response.json(value);
  };
  return { calls, token, transport };
}
it('Oracle worker uses the existing local API contract and emits no success for an empty source', async () => {
  const cp = controlPlane();
  const worker = new LocalTranscriptWorker(
    'https://control.example',
    'a'.repeat(43),
    new YtdlpTranscriptProvider(async () => ({
      status: 'NO_CAPTIONS',
      failure_code: 'EMPTY_PUBLIC_TRACKLIST',
      tracks: [],
    })),
    cp.transport,
    ytdlpProviderVersion,
    cp.token.lease_owner,
  );
  expect(await worker.cycle()).toMatchObject({
    accepted: false,
    reason: 'EMPTY_PUBLIC_TRACKLIST',
    idle: false,
  });
  expect(cp.calls.map((call) => call.route)).toEqual([
    'heartbeat',
    'transcript/admission',
    'lease',
    'start',
    'transcript/input',
    'transcript/admission',
    'transcript/outcome',
  ]);
  expect(cp.calls.find((call) => call.route === 'lease')!.input).toEqual({
    runtime: 'local',
    task_type: 'FETCH_TRANSCRIPT',
  });
  expect(cp.calls.at(-1)!.input).toEqual({
    token: cp.token,
    status: 'NO_CAPTIONS',
  });
});
it('cancelled active cycle releases into existing retry and the next cycle can run', async () => {
  const cp = controlPlane(),
    controller = new AbortController();
  let ready!: () => void;
  const entered = new Promise<void>((done) => {
    ready = done;
  });
  const provider = new YtdlpTranscriptProvider(
    async (_input, _timeout, signal) => {
      ready();
      await new Promise<void>((_done, fail) => {
        if (signal?.aborted) fail(new Error('cancelled'));
        signal?.addEventListener('abort', () => fail(new Error('cancelled')), {
          once: true,
        });
      });
      throw new Error('unreachable');
    },
  );
  const worker = new LocalTranscriptWorker(
    'https://control.example',
    'a'.repeat(43),
    provider,
    cp.transport,
  );
  const first = worker.cycle(controller.signal);
  await entered;
  controller.abort();
  await expect(first).rejects.toThrow();
  expect(cp.calls.at(-1)).toEqual({
    route: 'retry',
    input: {
      token: cp.token,
      task_type: 'FETCH_TRANSCRIPT',
      code: 'TRANSIENT',
    },
  });
  expect(cp.calls.some((call) => call.route === 'transcript/accept')).toBe(
    false,
  );
  const next = new LocalTranscriptWorker(
    'https://control.example',
    'a'.repeat(43),
    new YtdlpTranscriptProvider(async () => ({
      status: 'NO_CAPTIONS',
      failure_code: 'EMPTY_PUBLIC_TRACKLIST',
      tracks: [],
    })),
    cp.transport,
  );
  expect((await next.cycle()).accepted).toBe(false);
  expect(cp.calls.filter((call) => call.route === 'lease')).toHaveLength(2);
});
it('configured worker identity must agree with the D1 lease owner', async () => {
  const cp = controlPlane();
  const worker = new LocalTranscriptWorker(
    'https://control.example',
    'a'.repeat(43),
    undefined,
    cp.transport,
    ytdlpProviderVersion,
    'wrong-worker',
  );
  await expect(worker.cycle()).rejects.toThrow('EXECUTOR_AUTH_DENIED');
  expect(cp.calls.some((call) => call.route === 'start')).toBe(false);
});
