import Ajv2020 from 'ajv/dist/2020.js';
import standalone from 'ajv/dist/standalone/index.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import type { RegistryBundle } from '../../packages/core/src/registry/bundle.js';
const bundle: RegistryBundle = JSON.parse(
  readFileSync('config/registry/master-bundle.json', 'utf8'),
);
const ajv = new Ajv2020({
  strict: true,
  allowUnionTypes: true,
  allErrors: true,
  code: { source: true, esm: true },
});
const exports: Record<string, string> = {};
for (const row of bundle.schemas) {
  ajv.addSchema(row.schema);
  const key = row.id.split(':').slice(-2, -1)[0]!.replaceAll('-', '_');
  exports[key] = row.id;
}
const source = standalone(ajv, exports);
if (/\brequire\s*\(|new Function|eval\(/.test(source))
  throw new Error('NON_STANDALONE_VALIDATOR');
mkdirSync('packages/core/src/registry/generated', { recursive: true });
const path = 'packages/core/src/registry/generated/validators.ts',
  expected =
    '// @ts-nocheck\n// Generated from the exact Master bundle by tools/registry/generate-validators.ts.\n' +
    source +
    '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== expected)
    throw new Error('GENERATED_VALIDATOR_MISMATCH');
} else writeFileSync(path, expected);
console.log(
  JSON.stringify({
    result: 'PASS',
    validators: Object.keys(exports).length,
    bytes: Buffer.byteLength(source),
  }),
);
