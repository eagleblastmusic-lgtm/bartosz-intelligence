/** Exercise the real CDP launch path with a harmless executable, no browser. */
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { captureNative, type NativeDiagnostics } from '../browser.js';

assert.equal(process.platform, 'linux');
const directory = await mkdtemp(join(tmpdir(), 'ote-env-contract-'));
const executable = join(directory, 'environment-only.py');
const receiptPath = join(directory, 'environment.json');
const keys = ['LD_LIBRARY_PATH', 'LD_PRELOAD', 'PYTHONPATH', 'NODE_OPTIONS'];
const original = keys.map((key) => process.env[key]);
const diagnostics: NativeDiagnostics = {};
try {
  await writeFile(
    executable,
    '#!/usr/bin/python3 -I\nimport json,os,pathlib\n' +
      `pathlib.Path(${JSON.stringify(receiptPath)}).write_text(json.dumps({k:k in os.environ for k in ${JSON.stringify(keys)}}))\n`,
  );
  await chmod(executable, 0o700);
  for (const key of keys) process.env[key] = '/tmp/ote-synthetic-environment';
  await assert.rejects(
    captureNative({
      executable,
      video: 'aircAruvnKk',
      timeoutMs: 2000,
      domReaderPath: join(directory, 'unused-dom-reader.js'),
      diagnostics,
      replayOrigin: 'http://127.0.0.1:9',
    }),
  );
  const observed: Record<string, boolean> = JSON.parse(
    await readFile(receiptPath, 'utf8'),
  );
  for (const key of keys) assert.equal(observed[key], false, key);
  assert.equal(diagnostics.profile_removed, true);
  assert.equal(diagnostics.sandbox, true);
  process.stdout.write(
    JSON.stringify({
      test: 'actual_captureNative_environment',
      status: 'PASS',
      observed,
      browser_executions: 0,
      harmless_fixture_executions: 1,
      network_requests: diagnostics.requests,
      profile_removed: true,
      accepted: false,
    }) + '\n',
  );
} finally {
  keys.forEach((key, i) => {
    if (original[i] === undefined) delete process.env[key];
    else process.env[key] = original[i];
  });
  await rm(directory, { recursive: true, force: true });
}
