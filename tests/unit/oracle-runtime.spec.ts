import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import {
  oracleConfiguration,
  verifyOracleRuntime,
  probeRuntime,
  type RuntimeProbe,
} from '../../apps/executor/src/oracle-runtime.js';
import { captionProcessRunner } from '../../apps/executor/src/providers/ytdlp.js';

afterEach(() => vi.unstubAllEnvs());
const env = {
  APP_ORIGIN: 'https://control.example',
  LOCAL_WORKER_CREDENTIAL: 'a'.repeat(43),
  BARTOSZ_WORKER_ID: 'oracle-transcript-test',
  BARTOSZ_CONCURRENCY: '1',
  BARTOSZ_PYTHON: resolve('test-python'),
  BARTOSZ_DENO: resolve('test-deno'),
  BARTOSZ_FFMPEG: resolve('test-ffmpeg'),
  BARTOSZ_STATE_DIRECTORY: resolve('.local'),
  BARTOSZ_SOURCE_QUALIFIED: 'false',
};
it('requires scoped credential, a production origin, explicit paths and exactly one worker', () => {
  expect(oracleConfiguration(env).sourceQualified).toBe(false);
  expect(oracleConfiguration(env).representation).toBe('COMPACT');
  expect(
    oracleConfiguration({ ...env, BARTOSZ_TRANSCRIPT_REPRESENTATION: 'LEGACY' })
      .representation,
  ).toBe('LEGACY');
  for (const change of [
    { LOCAL_WORKER_CREDENTIAL: '' },
    { LOCAL_WORKER_CREDENTIAL: 'private bad secret' },
    { APP_ORIGIN: 'http://127.0.0.1:8787' },
    { APP_ORIGIN: 'https://user:private@control.example' },
    { BARTOSZ_CONCURRENCY: '2' },
    { BARTOSZ_WORKER_ID: '' },
    { BARTOSZ_PYTHON: 'python' },
    { BARTOSZ_SOURCE_QUALIFIED: '' },
    { BARTOSZ_TRANSCRIPT_REPRESENTATION: 'OTHER' },
  ])
    expect(() => oracleConfiguration({ ...env, ...change })).toThrow(
      /^ORACLE_/,
    );
  expect(() => captionProcessRunner({ python: 'python' })).toThrow(
    'LOCAL_CAPTION_CONFIGURATION_REQUIRED',
  );
});
it('allows HTTP loopback only for an explicitly declared nonproduction control plane', () => {
  expect(
    oracleConfiguration({
      ...env,
      APP_ORIGIN: 'http://127.0.0.1:8787',
      BARTOSZ_NONPRODUCTION: 'true',
      BARTOSZ_CAPTION_SOCKET: resolve('caption.sock'),
    }),
  ).toMatchObject({
    origin: 'http://127.0.0.1:8787',
    captionSocket: resolve('caption.sock'),
  });
  for (const change of [
    { APP_ORIGIN: 'http://127.0.0.1:8787' },
    { APP_ORIGIN: 'http://127.0.0.1:8787', BARTOSZ_NONPRODUCTION: 'false' },
    { APP_ORIGIN: 'http://localhost:8787', BARTOSZ_NONPRODUCTION: 'true' },
    { APP_ORIGIN: 'http://192.0.2.1:8787', BARTOSZ_NONPRODUCTION: 'true' },
  ])
    expect(() => oracleConfiguration({ ...env, ...change })).toThrow(
      'ORACLE_CONNECTION_CONFIGURATION_REQUIRED',
    );
  for (const captionSocket of ['relative.sock', resolve('caption.sock') + '\n'])
    expect(() =>
      oracleConfiguration({ ...env, BARTOSZ_CAPTION_SOCKET: captionSocket }),
    ).toThrow('ORACLE_CAPTION_SOCKET_REQUIRED');
});
it('checks exact runtime versions and missing executable without a source or control-plane request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oracle-runtime-'));
  const config = oracleConfiguration({
    ...env,
    BARTOSZ_STATE_DIRECTORY: directory,
  });
  // Host injection is a unit fixture, never an ARM64 integration receipt.
  const host = {
    platform: 'linux' as NodeJS.Platform,
    arch: 'arm64' as NodeJS.Architecture,
    node: '24.21.0',
    uid: 997,
  };
  const probe: RuntimeProbe = async (program) =>
    program === config.python
      ? '{"ok":true,"python":"3.12.3"}'
      : program === config.deno
        ? 'deno 2.9.7 (stable, release, aarch64-unknown-linux-gnu)\n'
        : 'ffmpeg version 6.1.1-3ubuntu5\n';
  try {
    await verifyOracleRuntime(config, probe, host);
    for (const change of [
      { node: '24.19.0' },
      { uid: 0 },
      { arch: 'x64' as NodeJS.Architecture },
    ])
      await expect(
        verifyOracleRuntime(config, probe, { ...host, ...change }),
      ).rejects.toThrow(/^ORACLE_/);
    for (const bad of [
      '{"ok":false,"python":"3.12.3"}',
      '{"ok":true,"python":"3.14.4"}',
    ])
      await expect(
        verifyOracleRuntime(
          config,
          async (program, args) =>
            program === config.python ? bad : probe(program, args),
          host,
        ),
      ).rejects.toThrow('ORACLE_PYTHON_DEPENDENCY_MISMATCH');
    await expect(
      verifyOracleRuntime(
        config,
        async (program, args) =>
          program === config.deno ? 'deno 2.8.0\n' : probe(program, args),
        host,
      ),
    ).rejects.toThrow('ORACLE_DENO_VERSION_MISMATCH');
    await expect(
      verifyOracleRuntime(
        config,
        async (program, args) =>
          program === config.ffmpeg
            ? 'ffmpeg version 7.0\n'
            : probe(program, args),
        host,
      ),
    ).rejects.toThrow('ORACLE_FFMPEG_VERSION_MISMATCH');
    await expect(
      probeRuntime(resolve('missing-runtime'), ['--version']),
    ).rejects.toThrow('ORACLE_RUNTIME_UNAVAILABLE');
  } finally {
    await rm(directory, { recursive: true });
  }
});
it('real provider process honors absolute paths, sanitizes errors, times out and cancels', async () => {
  const python =
    process.env.BARTOSZ_TEST_PYTHON ??
    (process.platform === 'win32'
      ? 'C:/Python314/python.exe'
      : '/usr/bin/python3');
  vi.stubEnv('LOCAL_WORKER_CREDENTIAL', 'synthetic-scoped-secret');
  vi.stubEnv('GEMINI_API_KEY', 'synthetic-ai-secret');
  const runner = captionProcessRunner({
    python,
    script: resolve('tests/fixtures/oracle-caption-process.py'),
    deno: resolve('deno'),
    ffmpeg: resolve('ffmpeg'),
  });
  const input = {
    operation: 'list' as const,
    item_id: '00000000-0000-4000-8000-000000000001',
    video_id: 'fixture0001',
    max_bytes: 4096,
  };
  expect(await runner(input, 2000)).toEqual({
    ok: true,
    deno: resolve('deno'),
    ffmpeg: resolve('ffmpeg'),
    credential_present: false,
    ai_secret_present: false,
  });
  for (const video_id of ['failure0001', 'badjson0001']) {
    await expect(runner({ ...input, video_id }, 2000)).rejects.toThrow(
      /^LOCAL_CAPTION_PROCESS_/,
    );
  }
  await expect(runner({ ...input, operation: 'fetch' }, 100)).rejects.toThrow(
    'LOCAL_CAPTION_PROCESS_FAILURE',
  );
  await expect(
    runner({ ...input, operation: 'fetch' }, 5000, AbortSignal.timeout(100)),
  ).rejects.toThrow('LOCAL_CAPTION_PROCESS_FAILURE');
}, 10000);
it('real Oracle entrypoint rejects missing credentials with exit 78 and no secret-bearing stack', async () => {
  const result = await new Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>((done) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'tools/executor/run-oracle.ts', '--check'],
      {
        timeout: 10000,
        windowsHide: true,
        env: {
          ...process.env,
          LOCAL_WORKER_CREDENTIAL: '',
          APP_ORIGIN: 'https://control.example',
          GEMINI_API_KEY: 'synthetic-secret-canary',
        },
      },
      (error, stdout, stderr) =>
        done({ code: Number(error?.code), stdout, stderr }),
    );
  });
  expect(result.code).toBe(78);
  expect(result.stdout).toBe('');
  expect(JSON.parse(result.stderr)).toEqual({
    event: 'ORACLE_CONFIGURATION_REJECTED',
    code: 'ORACLE_CONNECTION_CONFIGURATION_REQUIRED',
  });
  expect(result.stderr).not.toContain('synthetic-secret-canary');
}, 15000);
it('existing executor starts with a local test control plane and completes one idle cycle', async () => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? '');
    if (request.headers.authorization !== 'Bearer ' + 'a'.repeat(43))
      throw new Error('TEST_CREDENTIAL_NOT_SENT');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify(
        request.url?.startsWith('/internal/workers/transcript/admission')
          ? { available: true, reason: null }
          : request.url === '/internal/workers/lease'
            ? { leases: [] }
            : { token: null },
      ),
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('TEST_SERVER_ADDRESS');
  try {
    const result = await new Promise<{
      code: number;
      stdout: string;
      stderr: string;
    }>((done) =>
      execFile(
        process.execPath,
        ['--import', 'tsx', 'tools/executor/run-local.ts', '--once'],
        {
          timeout: 10000,
          windowsHide: true,
          env: {
            ...process.env,
            APP_ORIGIN: 'http://127.0.0.1:' + address.port,
            LOCAL_WORKER_CREDENTIAL: 'a'.repeat(43),
          },
        },
        (error, stdout, stderr) =>
          done({ code: error ? Number(error.code) : 0, stdout, stderr }),
      ),
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      event: 'LOCAL_EXECUTOR_CYCLE',
      accepted: false,
      idle: true,
    });
    expect(paths).toEqual([
      '/internal/workers/heartbeat',
      '/internal/workers/transcript/admission?runtime=local',
      '/internal/workers/lease',
    ]);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}, 15000);
