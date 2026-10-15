import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { WorkerRpc } from './worker-rpc.js';

export const oracleVersions = Object.freeze({
  node: '24.21.0',
  pnpm: '12.9.1',
  deno: '2.9.7',
  python: '3.12',
  ffmpeg: '6.1.1',
});
export interface OracleConfiguration {
  origin: string;
  credential: string;
  workerId: string;
  python: string;
  deno: string;
  ffmpeg: string;
  stateDirectory: string;
  sourceQualified: boolean;
  captionSocket?: string;
  representation?: 'COMPACT' | 'LEGACY';
}
export function oracleConfiguration(
  env: NodeJS.ProcessEnv,
): OracleConfiguration {
  const origin = env.APP_ORIGIN ?? '',
    credential = env.LOCAL_WORKER_CREDENTIAL ?? '';
  try {
    new WorkerRpc(origin, credential);
    const url = new URL(origin);
    if (
      url.protocol !== 'https:' &&
      !(
        env.BARTOSZ_NONPRODUCTION === 'true' &&
        url.protocol === 'http:' &&
        url.hostname === '127.0.0.1'
      )
    )
      throw new Error();
  } catch {
    throw new Error('ORACLE_CONNECTION_CONFIGURATION_REQUIRED');
  }
  const workerId = env.BARTOSZ_WORKER_ID ?? '';
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(workerId) ||
    env.BARTOSZ_CONCURRENCY !== '1'
  )
    throw new Error('ORACLE_WORKER_CONFIGURATION_REQUIRED');
  const paths = [
    'BARTOSZ_PYTHON',
    'BARTOSZ_DENO',
    'BARTOSZ_FFMPEG',
    'BARTOSZ_STATE_DIRECTORY',
  ] as const;
  for (const key of paths)
    if (!env[key] || !isAbsolute(env[key]!) || /[\0\r\n]/.test(env[key]!))
      throw new Error('ORACLE_RUNTIME_PATH_REQUIRED');
  if (!['false', 'true'].includes(env.BARTOSZ_SOURCE_QUALIFIED ?? ''))
    throw new Error('ORACLE_SOURCE_CONFIGURATION_REQUIRED');
  const captionSocket = env.BARTOSZ_CAPTION_SOCKET;
  const representation = env.BARTOSZ_TRANSCRIPT_REPRESENTATION ?? 'COMPACT';
  if (representation !== 'COMPACT' && representation !== 'LEGACY')
    throw new Error('ORACLE_SOURCE_CONFIGURATION_REQUIRED');
  if (
    captionSocket &&
    (!isAbsolute(captionSocket) || /[\r\n\0]/.test(captionSocket))
  )
    throw new Error('ORACLE_CAPTION_SOCKET_REQUIRED');
  return {
    origin,
    credential,
    workerId,
    python: env.BARTOSZ_PYTHON!,
    deno: env.BARTOSZ_DENO!,
    ffmpeg: env.BARTOSZ_FFMPEG!,
    stateDirectory: env.BARTOSZ_STATE_DIRECTORY!,
    sourceQualified: env.BARTOSZ_SOURCE_QUALIFIED === 'true',
    representation,
    ...(captionSocket ? { captionSocket } : {}),
  };
}
export type RuntimeProbe = (program: string, args: string[]) => Promise<string>;
export const probeRuntime: RuntimeProbe = (program, args) =>
  new Promise((done, fail) => {
    execFile(
      program,
      args,
      {
        timeout: 15000,
        maxBuffer: 65536,
        windowsHide: true,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) =>
            [
              'PATH',
              'SYSTEMROOT',
              'WINDIR',
              'HOME',
              'TEMP',
              'TMP',
              'TMPDIR',
              'DENO_DIR',
            ].includes(key.toUpperCase()),
          ),
        ),
      },
      (error, stdout) => {
        if (error) fail(new Error('ORACLE_RUNTIME_UNAVAILABLE'));
        else done(stdout);
      },
    );
  });
export async function verifyOracleRuntime(
  config: OracleConfiguration,
  probe: RuntimeProbe = probeRuntime,
  host = {
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    uid: process.getuid?.(),
  },
) {
  if (
    host.platform !== 'linux' ||
    host.arch !== 'arm64' ||
    host.uid === undefined ||
    host.uid === 0
  )
    throw new Error('ORACLE_HOST_REQUIRED');
  if (host.node !== oracleVersions.node)
    throw new Error('ORACLE_NODE_VERSION_MISMATCH');
  const python = JSON.parse(
    await probe(config.python, [
      '-B',
      resolve('tools/deployment/oracle/runtime-probe.py'),
    ]),
  ) as { ok: boolean; python: string };
  if (python.ok !== true || !/^3\.12\.\d+$/.test(python.python))
    throw new Error('ORACLE_PYTHON_DEPENDENCY_MISMATCH');
  const deno = await probe(config.deno, ['--version']);
  if (
    !/^deno 2\.9\.7(?: |\r?\n)/.test(deno) ||
    !deno.includes('aarch64-unknown-linux-gnu')
  )
    throw new Error('ORACLE_DENO_VERSION_MISMATCH');
  if (
    !/^ffmpeg version 6\.1\.1(?:-| )/.test(
      await probe(config.ffmpeg, ['-version']),
    )
  )
    throw new Error('ORACLE_FFMPEG_VERSION_MISMATCH');
  await access(
    config.stateDirectory,
    constants.R_OK | constants.W_OK | constants.X_OK,
  );
}
