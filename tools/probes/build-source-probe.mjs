import { createRequire } from 'node:module';
// Wykorzystaj istniejący esbuild zależności tsx, bez instalowania nowego pakietu.
const taskRequire = createRequire(import.meta.url);
const { build } = createRequire(taskRequire.resolve('tsx/package.json'))(
  'esbuild',
);
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const out = resolve(process.argv[2] ?? '.local/source-probe-20261013');
await mkdir(out, { recursive: true });
const result = await build({
  entryPoints: {
    'source-probe': 'tools/probes/run-source-probe.ts',
    'source-probe-check': 'tools/probes/source-probe-check.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outdir: out,
  outExtension: { '.js': '.mjs' },
  metafile: true,
});
if (
  Object.keys(result.metafile.inputs).some((name) =>
    /\/db\/|workers\/|transcript-runner|local-worker|oracle-runtime/.test(name),
  )
)
  throw new Error('DIAGNOSTIC_BOUNDARY_VIOLATION');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inputs = {};
for (const name of Object.keys(result.metafile.inputs))
  inputs[name] = sha(await readFile(name));
const files = {};
for (const name of Object.keys(result.metafile.outputs))
  files[name] = sha(await readFile(name));
await writeFile(
  resolve(out, 'build-manifest.json'),
  JSON.stringify(
    {
      schema: 'source-probe-build:1',
      esbuild: result.metafile,
      inputs,
      files,
      boundary: 'NO_D1_RPC_EXECUTOR_IMPORTS',
    },
    null,
    2,
  ) + '\n',
);
process.stdout.write(
  JSON.stringify({ build: 'PASS', inputs: Object.keys(inputs).length, files }) +
    '\n',
);
