import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import {
  verifyRegistryBundle,
  materializeProviderSchema,
  type RegistryBundle,
} from '../../packages/core/src/registry/bundle.js';
const bundle: RegistryBundle = JSON.parse(
  readFileSync('config/registry/master-bundle.json', 'utf8'),
);
const hash = await verifyRegistryBundle(bundle);
const ajv = new Ajv2020({
  strict: true,
  allowUnionTypes: true,
  allErrors: true,
});
for (const row of bundle.schemas) {
  ajv.compile(row.schema);
  ajv.compile(materializeProviderSchema(row.schema));
}
console.log(
  JSON.stringify({
    result: 'PASS',
    schemas: bundle.schemas.length,
    prompts: bundle.prompts.length,
    bundle_hash: hash,
  }),
);
