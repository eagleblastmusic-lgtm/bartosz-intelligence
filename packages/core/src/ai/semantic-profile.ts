import { sha256 } from '../auth/crypto.js';
import {
  verifyRegistryBundle,
  type JsonSchema,
  type RegistryBundle,
} from '../registry/bundle.js';

export const semanticModules = [
  'summary',
  'key_points',
  'entities',
  'tools',
  'claims',
  'stance',
  'predictions',
  'usage',
  'recommendations',
  'uncertainties',
  'contradictions',
] as const;
export type SemanticModule = (typeof semanticModules)[number];
export type SemanticProfile = {
  mode: 'ECONOMY' | 'FULL' | 'CUSTOM';
  modules: Record<SemanticModule, boolean>;
  translation: 'NONE' | 'FULL' | 'IMPORTANT_SEGMENTS';
  history: boolean;
  second_pass: { purpose: string } | null;
  validation_pass: { purpose: string } | null;
};
const economyModules = new Set<SemanticModule>(semanticModules.slice(0, 7));
const typedModules = [
  'claims',
  'stance',
  'predictions',
  'usage',
  'recommendations',
  'uncertainties',
];
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value))
  )
    throw new Error('INVALID_SEMANTIC_PROFILE');
}
function pass(value: unknown): { purpose: string } | null {
  if (value === null) return null;
  if (!record(value)) throw new Error('INVALID_EXPLICIT_PASS');
  exact(value, ['purpose']);
  if (
    typeof value.purpose !== 'string' ||
    !value.purpose.trim() ||
    value.purpose.length > 500
  )
    throw new Error('INVALID_EXPLICIT_PASS');
  return { purpose: value.purpose.trim() };
}
/** Provider, execution route and resource policy are deliberately outside this contract. */
export function semanticProfile(value: unknown): SemanticProfile {
  if (!record(value)) throw new Error('INVALID_SEMANTIC_PROFILE');
  exact(value, [
    'mode',
    'modules',
    'translation',
    'history',
    'second_pass',
    'validation_pass',
  ]);
  if (
    !['ECONOMY', 'FULL', 'CUSTOM'].includes(String(value.mode)) ||
    !record(value.modules)
  )
    throw new Error('INVALID_SEMANTIC_PROFILE');
  exact(value.modules, semanticModules);
  const modules = Object.fromEntries(
    semanticModules.map((key) => {
      const enabled = (value.modules as Record<string, unknown>)[key];
      if (typeof enabled !== 'boolean')
        throw new Error('INVALID_SEMANTIC_MODULE');
      return [key, enabled];
    }),
  ) as Record<SemanticModule, boolean>;
  if (!Object.values(modules).some(Boolean))
    throw new Error('EMPTY_SEMANTIC_PROFILE');
  if (
    value.mode !== 'CUSTOM' &&
    semanticModules.some(
      (key) =>
        modules[key] !== (value.mode === 'FULL' || economyModules.has(key)),
    )
  )
    throw new Error('PRESET_MODULE_SCOPE_MISMATCH');
  if (
    !['NONE', 'FULL', 'IMPORTANT_SEGMENTS'].includes(
      String(value.translation),
    ) ||
    typeof value.history !== 'boolean'
  )
    throw new Error('INVALID_OPTIONAL_SCOPE');
  return {
    mode: value.mode as SemanticProfile['mode'],
    modules,
    translation: value.translation as SemanticProfile['translation'],
    history: value.history,
    second_pass: pass(value.second_pass),
    validation_pass: pass(value.validation_pass),
  };
}

function references(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) references(item, result);
  else if (record(value)) {
    if (typeof value.$ref === 'string') {
      if (!value.$ref.startsWith('#/$defs/'))
        throw new Error('UNSUPPORTED_SCHEMA_REFERENCE');
      result.add(value.$ref.slice(8));
    }
    for (const [key, child] of Object.entries(value))
      if (key !== '$defs') references(child, result);
  }
  return result;
}
function reachableDefinitions(schema: JsonSchema) {
  const definitions = schema.$defs as Record<string, JsonSchema>;
  const needed = references(schema);
  for (const name of needed) {
    if (!definitions[name]) throw new Error('MISSING_SCHEMA_DEFINITION');
    references(definitions[name], needed);
  }
  schema.$defs = Object.fromEntries(
    Object.entries(definitions).filter(([name]) => needed.has(name)),
  );
  if (!needed.size) delete schema.$defs;
}

/** Materializes the exact immutable provider schema before admission or any request. */
export async function compileSemanticProfile(
  value: unknown,
  bundle: RegistryBundle,
) {
  const config = semanticProfile(value);
  await verifyRegistryBundle(bundle);
  const base = bundle.schemas.find(
    (row) =>
      row.id ===
      `urn:bartosz:schema:${config.mode === 'ECONOMY' ? 'economy' : 'full'}-wire:1.0`,
  )!;
  const schema = structuredClone(base.schema);
  const selected = semanticModules.filter((key) => config.modules[key]);
  const scopeHash = await sha256(
    JSON.stringify({ base_hash: base.hash, modules: selected }),
  );
  if (config.mode === 'CUSTOM') {
    const properties = schema.properties as Record<string, JsonSchema>;
    const selectedProperties = new Set([
      'entity_mentions',
      'source_issues',
      ...selected.map((key) =>
        key === 'summary'
          ? 'summary_pl'
          : key === 'entities'
            ? 'entity_mentions'
            : key,
      ),
    ]);
    schema.properties = Object.fromEntries(
      Object.entries(properties).filter(([key]) => selectedProperties.has(key)),
    );
    schema.required = Object.keys(schema.properties as Record<string, unknown>);
    schema.additionalProperties = false;
    if (config.modules.contradictions) {
      const ends = typedModules.filter(
        (key) => config.modules[key as SemanticModule],
      );
      if (!ends.length)
        (schema.properties as Record<string, JsonSchema>).contradictions = {
          type: 'array',
          items: { type: 'null' },
          maxItems: 0,
        };
      else {
        const definition = (schema.$defs as Record<string, JsonSchema>)
          .contradiction!;
        const sides = definition.properties as Record<string, JsonSchema>;
        for (const side of ['left', 'right'])
          (sides[side]!.properties as Record<string, JsonSchema>).module!.enum =
            ends;
      }
    }
    reachableDefinitions(schema);
    schema.$id = `urn:bartosz:schema:custom-wire:${scopeHash}:1.0`;
  }
  const promptId =
    config.mode === 'ECONOMY'
      ? 'ECONOMY_ANALYSIS_V1'
      : config.mode === 'FULL'
        ? 'FULL_ANALYSIS_V1'
        : 'ADVANCED_ANALYSIS_V1';
  const prompt = bundle.prompts.find((row) => row.id === promptId)!;
  return {
    config,
    config_hash: await sha256(JSON.stringify(config)),
    module_scope_hash: scopeHash,
    wire: {
      id: schema.$id as string,
      hash: await sha256(JSON.stringify(schema)),
      schema,
    },
    base_wire_hash: base.hash,
    prompt: { ...prompt },
    canonical: bundle.schemas.find(
      (row) => row.id === 'urn:bartosz:schema:intelligence-canonical:1.2',
    )!,
    enrichment_version: '1.0' as const,
    request_estimate: {
      minimum:
        1 +
        Number(config.translation !== 'NONE') +
        Number(config.history) +
        Number(config.second_pass !== null) +
        Number(config.validation_pass !== null),
      exact: false as const,
      reason:
        'CHUNKING_REPAIR_AND_ADMISSION_DEPEND_ON_SOURCE_AND_QUOTA' as const,
    },
  };
}
