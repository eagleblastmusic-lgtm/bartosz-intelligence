import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx/package.json'))('esbuild');
const out = resolve(process.argv[2] ?? '.local/transcript-engine');
await mkdir(out, { recursive: true });
const result = await build({
  entryPoints: {
    'transcript-engine': 'tools/transcript-engine/run.ts',
    'engine-check': 'tools/transcript-engine/check.ts',
    'browser-check': 'tools/transcript-engine/browser-check.ts',
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
  Object.keys(result.metafile.inputs).some((p) =>
    /\/db\/|workers\/|apps\/executor\/|oracle-runtime|local-worker/.test(p),
  )
)
  throw new Error('DIAGNOSTIC_BOUNDARY_VIOLATION');
const dom = 'tools/firefox-transcript-v0.4.2/candidate-v0.4.2/panel-reader.js';
await copyFile(dom, resolve(out, 'dom-reader.js'));
const hash = (b) => createHash('sha256').update(b).digest('hex');
const inputs = {},
  outputs = {};
for (const name of [...Object.keys(result.metafile.inputs), dom])
  inputs[name] = hash(await readFile(name));
for (const name of [
  ...Object.keys(result.metafile.outputs),
  resolve(out, 'dom-reader.js'),
])
  outputs[name] = hash(await readFile(name));
await writeFile(
  resolve(out, 'build-manifest.json'),
  JSON.stringify(
    {
      schema: 'ote-build:1',
      inputs,
      outputs,
      boundary: 'NO_D1_RPC_EXECUTOR_IMPORTS',
    },
    null,
    2,
  ) + '\n',
);
process.stdout.write(
  JSON.stringify({
    build: 'PASS',
    inputs: Object.keys(inputs).length,
    outputs,
  }) + '\n',
);
