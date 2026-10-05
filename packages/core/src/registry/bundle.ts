import { sha256 } from '../auth/crypto.js';
export type JsonSchema = { [key: string]: unknown };
export interface RegistryBundle {
  format_version: number;
  master_sha256: string;
  enrichment_version: string;
  schemas: { id: string; version: string; hash: string; schema: JsonSchema }[];
  prompts: { id: string; version: number; hash: string; text: string }[];
}
export const familySchemas: Readonly<
  Record<string, readonly [string, string]>
> = Object.freeze({
  ECONOMY_ANALYSIS_V1: ['economy-wire:1.0', 'intelligence-canonical:1.2'],
  FULL_ANALYSIS_V1: ['full-wire:1.0', 'intelligence-canonical:1.2'],
  ADVANCED_ANALYSIS_V1: ['full-wire:1.0', 'intelligence-canonical:1.2'],
  HISTORICAL_COMPARE_V1: ['history-wire:1.0', 'historical:1.0'],
  FULL_TRANSLATION_V1: ['translation-wire:1.0', 'translation:1.0'],
  JSON_REPAIR_V1: ['repair-wire:1.0', 'repair-envelope:1.1'],
});
export async function verifyRegistryBundle(bundle: RegistryBundle) {
  if (
    bundle.format_version !== 1 ||
    bundle.enrichment_version !== '1.0' ||
    bundle.schemas.length !== 9 ||
    bundle.prompts.length !== 6 ||
    !/^[a-f0-9]{64}$/.test(bundle.master_sha256)
  )
    throw new Error('INCOMPATIBLE_BUNDLE');
  const ids = new Set<string>();
  for (const row of bundle.schemas) {
    if (
      ids.has(row.id) ||
      row.schema.$id !== row.id ||
      row.schema.$schema !== 'https://json-schema.org/draft/2020-12/schema' ||
      row.version !== row.id.split(':').at(-1) ||
      (await sha256(JSON.stringify(row.schema))) !== row.hash
    )
      throw new Error('SCHEMA_HASH_MISMATCH');
    ids.add(row.id);
  }
  const families = new Set<string>();
  for (const row of bundle.prompts) {
    if (
      families.has(row.id) ||
      !familySchemas[row.id] ||
      row.version !== 2 ||
      (await sha256(row.text)) !== row.hash
    )
      throw new Error('PROMPT_HASH_MISMATCH');
    for (const suffix of familySchemas[row.id]!)
      if (!ids.has('urn:bartosz:schema:' + suffix))
        throw new Error('MISSING_COMPATIBLE_SCHEMA');
    families.add(row.id);
  }
  const economy = bundle.schemas.find(
    (row) => row.id === 'urn:bartosz:schema:economy-wire:1.0',
  )!.schema;
  const expected = [
    'summary_pl',
    'key_points',
    'entity_mentions',
    'tools',
    'claims',
    'stance',
    'predictions',
    'source_issues',
  ];
  if (
    JSON.stringify(Object.keys(economy.properties as object)) !==
      JSON.stringify(expected) ||
    JSON.stringify(economy.required) !== JSON.stringify(expected) ||
    economy.additionalProperties !== false
  )
    throw new Error('INVALID_ECONOMY_CONTRACT');
  return sha256(JSON.stringify(bundle));
}

export function materializeProviderSchema(schema: JsonSchema): JsonSchema {
  const resolve = (value: unknown, trail: readonly string[] = []): unknown => {
    if (Array.isArray(value))
      return value.map((entry) => resolve(entry, trail));
    if (!value || typeof value !== 'object') return value;
    const object = value as JsonSchema;
    if (object.$ref !== undefined) {
      const ref = object.$ref;
      if (
        typeof ref !== 'string' ||
        !ref.startsWith('#/$defs/') ||
        trail.includes(ref) ||
        Object.keys(object).length !== 1
      )
        throw new Error('UNSUPPORTED_SCHEMA_REF');
      const definition = (schema.$defs as JsonSchema | undefined)?.[
        ref.slice(8)
      ];
      if (!definition) throw new Error('MISSING_SCHEMA_REF');
      return resolve(definition, [...trail, ref]);
    }
    const result: JsonSchema = {};
    for (const [key, entry] of Object.entries(object)) {
      if (['$id', '$schema', '$defs', 'title', 'description'].includes(key))
        continue;
      if (key === 'const') {
        result.enum = [entry];
        continue;
      }
      result[key] =
        key === 'properties'
          ? Object.fromEntries(
              Object.entries(entry as JsonSchema).map(([name, field]) => [
                name,
                resolve(field, trail),
              ]),
            )
          : resolve(entry, trail);
    }
    return result;
  };
  return resolve(schema) as JsonSchema;
}
export function renderPrompt(
  template: string,
  bindings: Readonly<Record<string, string>>,
) {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_match, name: string) => {
    if (!Object.hasOwn(bindings, name))
      throw new Error('MISSING_PROMPT_BINDING');
    return bindings[name]!;
  });
}
