import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx/package.json'))('esbuild');
const out = resolve('.local/chromium-sandbox');
await mkdir(out, { recursive: true });
const result = await build({
  entryPoints: ['tools/transcript-engine/sandbox/environment-check.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: resolve(out, 'environment-check.mjs'),
  metafile: true,
});
const hash = (body) => createHash('sha256').update(body).digest('hex');
const inputs = {};
for (const path of Object.keys(result.metafile.inputs)) {
  if (/apps\/|\/db\//.test(path)) throw new Error('SECURITY_CHECK_BOUNDARY');
  inputs[path] = hash(await readFile(path));
}
const receipt = {
  schema: 'ote-sandbox-check-build:1',
  inputs,
  bundle_sha256: hash(await readFile(resolve(out, 'environment-check.mjs'))),
};
await writeFile(
  resolve(out, 'environment-build.json'),
  JSON.stringify(receipt, null, 2) + '\n',
);
process.stdout.write(JSON.stringify(receipt) + '\n');
