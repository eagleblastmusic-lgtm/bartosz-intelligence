import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('installer parses, validates pins offline and leaves plan without installation', async () => {
  const bash =
    process.env.BARTOSZ_TEST_BASH ??
    (process.platform === 'win32'
      ? 'C:/Program Files/Git/bin/bash.exe'
      : '/bin/bash');
  const python =
    process.env.BARTOSZ_TEST_PYTHON ??
    (process.platform === 'win32'
      ? 'C:/Python314/python.exe'
      : '/usr/bin/python3');
  const run = (args: string[]) =>
    new Promise<{ code: number; out: string }>((done) =>
      execFile(
        bash,
        args,
        {
          timeout: 15000,
          windowsHide: true,
          env: {
            ...process.env,
            BARTOSZ_INSTALL_PYTHON: python.replaceAll('\\', '/'),
          },
        },
        (error, stdout, stderr) =>
          done({
            code: error ? Number(error.code) || 1 : 0,
            out: stdout + stderr,
          }),
      ),
    );
  const script = resolve('tools/deployment/oracle/prepare.sh').replaceAll(
    '\\',
    '/',
  );
  expect(await run(['-n', script])).toEqual({ code: 0, out: '' });
  const plan = await run([script, '--plan']);
  expect(plan.code).toBe(0);
  expect(plan.out).toContain('"locks": "PASS"');
  expect(plan.out).toContain('PLAN_ONLY');
  expect((await run([script, '--unsupported'])).code).toBe(78);
  if (process.arch !== 'arm64') {
    const applied = await run([script, '--apply']);
    expect(applied).toEqual({ code: 78, out: 'ORACLE_ARM64_REQUIRED\n' });
  }
}, 30000);
it('service matches stop/restart and unprivileged resource contracts without activation', () => {
  const unit = readFileSync(
    'tools/deployment/oracle/bartosz-executor.service',
    'utf8',
  );
  for (const setting of [
    'Type=exec',
    'RestartPreventExitStatus=78',
    'KillMode=mixed',
    'TimeoutStopSec=240s',
    'User=bartosz-executor',
    'NoNewPrivileges=true',
    'MemoryMax=384M',
    'MemorySwapMax=0',
    'CPUQuota=50%',
    'WantedBy=multi-user.target',
  ])
    expect(unit).toContain(setting);
  expect(unit).not.toContain('WatchdogSec');
  expect(unit).not.toContain('ExecStartPre=');
});

it('offline test invocation leaves an out-of-sync release untouched and installation still rejects its lockfile', async () => {
  const pnpm =
    process.env.BARTOSZ_TEST_PNPM ??
    (process.platform === 'win32'
      ? resolve('.tools/node_modules/@pnpm/exe.win32-x64/pnpm.exe')
      : '/opt/bartosz-intelligence/runtime/pnpm-12.9.1/pnpm');
  const temporary = mkdtempSync(join(tmpdir(), 'bartosz-offline-pnpm-'));
  const release = join(temporary, 'release');
  mkdirSync(release);
  // No registry packages or network access: the intentionally missing local
  // dependency makes the default auto-install observably unsafe for a release.
  writeFileSync(
    join(release, 'package.json'),
    JSON.stringify({
      private: true,
      dependencies: { 'missing-offline-fixture': 'file:./not-installed' },
    }),
  );
  writeFileSync(join(release, 'pnpm-workspace.yaml'), 'packages: []\n');
  writeFileSync(
    join(release, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
  );
  writeFileSync(
    join(release, 'check.cjs'),
    'process.stdout.write("OFFLINE_COMMAND_EXECUTED\\n");\n',
  );
  const snapshot = () =>
    ['.', ...readdirSync(release, { recursive: true })]
      .map(String)
      .sort()
      .map((name) => {
        const path = join(release, name);
        const stat = lstatSync(path);
        return {
          name,
          mode: stat.mode,
          mtime: stat.mtimeMs,
          size: stat.size,
          sha256: stat.isFile()
            ? createHash('sha256').update(readFileSync(path)).digest('hex')
            : null,
        };
      });
  const run = (args: string[]) =>
    new Promise<{ code: number; out: string }>((done) =>
      execFile(
        pnpm,
        [
          '--config.offline=true',
          '--store-dir',
          join(temporary, 'store'),
          ...args,
        ],
        { cwd: release, timeout: 15000, windowsHide: true },
        (error, stdout, stderr) =>
          done({
            code: error ? Number(error.code) || 1 : 0,
            out: stdout + stderr,
          }),
      ),
    );
  try {
    expect((await run(['--version'])).out.trim()).toBe('12.9.1');
    const workflow = readFileSync(
      'tools/deployment/oracle/verify-arm64.sh',
      'utf8',
    );
    const setting = workflow.match(
      /^pnpm (--config\.verifyDepsBeforeRun=false) exec vitest /m,
    )?.[1];
    expect(setting).toBeDefined();
    const before = snapshot();
    const executed = await run([
      setting!,
      'exec',
      process.execPath,
      'check.cjs',
    ]);
    expect(executed).toEqual({ code: 0, out: 'OFFLINE_COMMAND_EXECUTED\n' });
    expect(snapshot()).toEqual(before);

    // The run-only switch is not inherited by installation. Even offline,
    // installation must reject a manifest/lockfile mismatch rather than repair it.
    const installed = await run(['install', '--frozen-lockfile']);
    expect(installed.code).not.toBe(0);
    expect(installed.out).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
    expect(readFileSync(join(release, 'pnpm-lock.yaml'), 'utf8')).toBe(
      "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
    );
    const installer = readFileSync(
      'tools/deployment/oracle/prepare.sh',
      'utf8',
    );
    expect(installer).toContain('install --frozen-lockfile');
    expect(installer).toContain(
      '--require-hashes --only-binary=:all: --no-deps',
    );
    expect(installer).toContain('sha256sum -c -');
    expect(installer).not.toMatch(
      /verifyDepsBeforeRun|verifyStoreIntegrity=false/,
    );
    expect(readFileSync('pnpm-workspace.yaml', 'utf8')).not.toMatch(
      /verifyDepsBeforeRun|verifyStoreIntegrity/,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}, 30000);
