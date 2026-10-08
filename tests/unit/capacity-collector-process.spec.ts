import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCapacityEvidence } from '../../tools/gates/capacity/store.js';

it('watch exits on denied telemetry auth and preserves one immutable partial observation', async () => {
  const directory = resolve('.local/tests/collector-process-' + randomUUID());
  const evidence = resolve(directory, 'evidence');
  const preload = resolve(directory, 'synthetic-transport.mjs');
  mkdirSync(evidence, { recursive: true });
  // Isolated child preload: no network call or production evidence directory.
  writeFileSync(
    preload,
    `let calls=0; globalThis.fetch=async()=>{ if(++calls>1) throw new Error('EXTRA_REQUEST'); return new Response('{"private":"synthetic-canary"}',{status:401}); };`,
  );
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      pathToFileURL(preload).href,
      resolve('tools/gates/capacity/collect.ts'),
      resolve('config/capacity-collector.json'),
      evidence,
      '--watch',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOCAL_TELEMETRY_WORKER_CREDENTIAL: 'a'.repeat(43),
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '',
    errors = '';
  child.stdout.on('data', (data) => {
    output += data.toString();
  });
  child.stderr.on('data', (data) => {
    errors += data.toString();
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    const code = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    expect(code).toBe(78);
    const records = readCapacityEvidence(evidence);
    expect(records).toHaveLength(2);
    expect(records[1]!.record.payload).toMatchObject({
      status: 'PARTIAL',
      reason: 'CAPACITY_HTTP_401',
      cases: [],
      qualification_status: 'NOT_ASSERTED',
    });
    expect(JSON.stringify(records) + output + errors).not.toContain(
      'synthetic-canary',
    );
    expect(errors).toBe('');
  } finally {
    clearTimeout(timeout);
    child.kill('SIGKILL');
    for (const name of readdirSync(evidence))
      unlinkSync(resolve(evidence, name));
    rmdirSync(evidence);
    unlinkSync(preload);
    rmdirSync(directory);
  }
}, 15000);
