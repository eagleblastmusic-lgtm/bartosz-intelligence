/** One local browser-check; retain bounded startup stderr and launch timing. */
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const [root, executable, out] = process.argv.slice(2);
const launch = [];
const real = cp.spawn;
cp.spawn = (...args) => {
  const started = performance.now();
  const p = real(...args);
  const row = {
    pid: p.pid,
    executable: args[0],
    argv: args[1],
    pipe_fds: [3, 4],
    stderr: '',
  };
  launch.push(row);
  p.stderr?.on('data', (b) => {
    row.stderr = (row.stderr + b.toString()).slice(-65536);
    process.stderr.write(b);
  });
  p.stdio[4]?.once('data', () => {
    row.first_cdp_bytes_ms = Math.round(performance.now() - started);
  });
  return p;
};
syncBuiltinESMExports();
try {
  const { browserChecks } = await import('./browser-check.mjs');
  const result = await browserChecks(
    resolve(root),
    executable,
    resolve(out),
    false,
    true,
  );
  process.stdout.write(
    JSON.stringify({
      status: result.status,
      test_count: result.test_count,
      accepted: false,
    }) + '\n',
  );
} finally {
  await writeFile(
    resolve(out, 'launch.json'),
    JSON.stringify(launch, null, 2) + '\n',
  );
  cp.spawn = real;
  syncBuiltinESMExports();
}
