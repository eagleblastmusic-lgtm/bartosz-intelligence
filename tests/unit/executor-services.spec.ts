import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import {
  localServices,
  serviceEnvironment,
  superviseService,
} from '../../apps/executor/src/services.js';

it('isolates task credentials and excludes provider, account and control-plane secrets', () => {
  const input = {
    APP_ORIGIN: 'https://example.test',
    Path: 'runtime',
    LOCAL_WORKER_CREDENTIAL: 'a'.repeat(43),
    LOCAL_SEARCH_WORKER_CREDENTIAL: 'b'.repeat(43),
    LOCAL_CORRECTION_WORKER_CREDENTIAL: 'c'.repeat(43),
    GOOGLE_OIDC_CLIENT_SECRET: 'private',
    GEMINI_API_KEY: 'private',
    CLOUDFLARE_API_TOKEN: 'private',
    NODE_OPTIONS: '--inspect',
  };
  for (const service of localServices) {
    expect(serviceEnvironment(service, input)).toEqual({
      APP_ORIGIN: input.APP_ORIGIN,
      Path: 'runtime',
      [service.credential]: input[service.credential],
    });
  }
  expect(() =>
    serviceEnvironment(localServices[0], {
      ...input,
      APP_ORIGIN: 'https://user:secret@example.test',
    }),
  ).toThrow();
  expect(() =>
    serviceEnvironment(localServices[0], {
      ...input,
      LOCAL_WORKER_CREDENTIAL: 'invalid',
    }),
  ).toThrow();
});

it('restarts crashed children serially with bounded waits and stops revoked authentication', async () => {
  const waits: number[] = [],
    events: string[] = [];
  let runs = 0,
    active = 0;
  const code = await superviseService({
    signal: new AbortController().signal,
    run: async () => {
      expect(active++).toBe(0);
      runs++;
      active--;
      return { code: runs < 5 ? 1 : 78, signal: null };
    },
    emit: (event) => {
      events.push(event);
    },
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });
  expect(code).toBe(1);
  expect(runs).toBe(5);
  expect(waits).toEqual([30000, 60000, 120000, 120000]);
  expect(events.at(-1)).toBe('STOPPED');
});

it('shutdown during backoff prevents another child launch', async () => {
  const shutdown = new AbortController();
  let runs = 0;
  const code = await superviseService({
    signal: shutdown.signal,
    run: async () => {
      runs++;
      return { code: null, signal: 'SIGKILL' };
    },
    emit: () => {},
    wait: async () => {
      shutdown.abort();
      throw new Error('abort');
    },
  });
  expect(code).toBe(0);
  expect(runs).toBe(1);
});

it('actual service children stop after one denied RPC each and never restart or call providers', async () => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? '');
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end('{"code":"UNAUTHENTICATED"}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('LOCAL_HARNESS_ADDRESS');
  const environment = {
    ...serviceEnvironment(localServices[0], {
      ...process.env,
      APP_ORIGIN: 'http://127.0.0.1:' + address.port,
      LOCAL_WORKER_CREDENTIAL: 'a'.repeat(43),
    }),
    LOCAL_CORRECTION_WORKER_CREDENTIAL: 'b'.repeat(43),
    LOCAL_SEARCH_WORKER_CREDENTIAL: 'c'.repeat(43),
    GEMINI_API_KEY: 'synthetic-secret-canary',
  };
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', resolve('tools/executor/run-services.ts')],
    {
      cwd: process.cwd(),
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (data) => {
    stdout += data.toString();
  });
  child.stderr.on('data', (data) => {
    stderr += data.toString();
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    const code = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    expect(code).toBe(1);
    expect(paths.sort()).toEqual([
      '/internal/workers/heartbeat',
      '/internal/workers/heartbeat',
      '/internal/workers/search/step',
    ]);
    const events = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; code: number });
    expect(
      events.filter((event) => event.event === 'LOCAL_SERVICE_STOPPED'),
    ).toHaveLength(3);
    expect(
      events.filter((event) => event.event === 'LOCAL_SERVICE_RESTART'),
    ).toHaveLength(0);
    expect(stdout + stderr).not.toContain('synthetic-secret-canary');
    expect(stderr).toBe('');
  } finally {
    clearTimeout(timeout);
    child.kill('SIGKILL');
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
}, 15000);
