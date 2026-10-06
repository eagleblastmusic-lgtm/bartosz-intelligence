import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { expect, it } from 'vitest';
import {
  compileSemanticProfile,
  semanticModules,
  semanticProfile,
  type SemanticProfile,
} from '../../packages/core/src/ai/semantic-profile.js';
import type { RegistryBundle } from '../../packages/core/src/registry/bundle.js';
import { materializeProviderSchema } from '../../packages/core/src/registry/bundle.js';

const bundle = JSON.parse(
  readFileSync('config/registry/master-bundle.json', 'utf8'),
) as RegistryBundle;
const profile = (mask: number): SemanticProfile => ({
  mode: 'CUSTOM',
  modules: Object.fromEntries(
    semanticModules.map((key, index) => [key, Boolean(mask & (1 << index))]),
  ) as SemanticProfile['modules'],
  translation: 'NONE',
  history: false,
  second_pass: null,
  validation_pass: null,
});
it('exhaustively materializes all 2047 nonempty Custom scopes with legal schemas and exact required properties', async () => {
  const ajv = new Ajv2020({ strict: true });
  const ids = new Set<string>();
  for (let mask = 1; mask < 2048; mask++) {
    const input = profile(mask);
    const compiled = await compileSemanticProfile(input, bundle);
    const schema = compiled.wire.schema;
    const expected = new Set([
      'entity_mentions',
      'source_issues',
      ...semanticModules
        .filter((key) => input.modules[key])
        .map((key) =>
          key === 'summary'
            ? 'summary_pl'
            : key === 'entities'
              ? 'entity_mentions'
              : key,
        ),
    ]);
    expect(new Set(Object.keys(schema.properties as object))).toEqual(expected);
    expect(new Set(schema.required as string[])).toEqual(expected);
    expect(schema.additionalProperties).toBe(false);
    expect(ids.has(compiled.wire.id)).toBe(false);
    ids.add(compiled.wire.id);
    const validate = ajv.compile(schema);
    const providerSchema = materializeProviderSchema(schema);
    expect(JSON.stringify(providerSchema)).not.toContain('"$ref"');
    expect(providerSchema.required).toEqual(schema.required);
    expect(providerSchema.additionalProperties).toBe(false);
    const empty = Object.fromEntries([...expected].map((key) => [key, []]));
    expect(validate(empty), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...empty, unselected: [] })).toBe(false);
    for (const key of expected) {
      const missing = { ...empty };
      delete missing[key];
      expect(validate(missing)).toBe(false);
    }
    ajv.removeSchema(compiled.wire.id);
  }
  expect(() => semanticProfile(profile(0))).toThrow('EMPTY_SEMANTIC_PROFILE');
}, 120000);

it('keeps contradiction ends inside selected typed arrays, including the exact no-typed schema', async () => {
  const only = await compileSemanticProfile(profile(1 << 10), bundle);
  expect(
    (only.wire.schema.properties as Record<string, unknown>).contradictions,
  ).toEqual({ type: 'array', items: { type: 'null' }, maxItems: 0 });
  expect(Object.keys(only.wire.schema.$defs as object)).toEqual([
    'entity_mention',
  ]);
  const claims = await compileSemanticProfile(
    profile((1 << 4) | (1 << 10)),
    bundle,
  );
  const ajv = new Ajv2020({ strict: true });
  const validate = ajv.compile(claims.wire.schema);
  const value = {
    entity_mentions: [],
    source_issues: [],
    claims: [],
    contradictions: [
      {
        left: { module: 'claims', index: 0 },
        right: { module: 'claims', index: 1 },
        explanation_pl: 'Porównanie',
        qualifiers: [],
      },
    ],
  };
  expect(validate(value)).toBe(true);
  value.contradictions[0]!.right.module = 'stance';
  expect(validate(value)).toBe(false);
  // Distinct-record existence is checked by the typed mapper, not invented by the schema compiler.
});

it('preserves preset schemas and separates explicit optional passes from wire scope', async () => {
  for (const [mode, mask] of [
    ['ECONOMY', 127],
    ['FULL', 2047],
  ] as const) {
    const compiled = await compileSemanticProfile(
      { ...profile(mask), mode },
      bundle,
    );
    const original = bundle.schemas.find((row) => row.id === compiled.wire.id)!;
    expect(compiled.wire.hash).toBe(original.hash);
    expect(compiled.wire.schema).toEqual(original.schema);
    expect(compiled.prompt.version).toBe(2);
  }
  const original = profile(1);
  const a = await compileSemanticProfile(original, bundle);
  const b = await compileSemanticProfile(
    {
      ...original,
      translation: 'FULL',
      history: true,
      second_pass: { purpose: 'Ponowna ocena źródła' },
      validation_pass: { purpose: 'Porównanie kandydata ze źródłem' },
    },
    bundle,
  );
  expect(b.wire.hash).toBe(a.wire.hash);
  expect(b.config_hash).not.toBe(a.config_hash);
  expect(b.request_estimate).toMatchObject({ minimum: 5, exact: false });
  expect(a.config).toEqual(original);
  const reordered = {
    ...original,
    modules: Object.fromEntries(Object.entries(original.modules).reverse()),
  };
  expect((await compileSemanticProfile(reordered, bundle)).config_hash).toBe(
    a.config_hash,
  );
});

it('rejects implicit scope, conflicting translation, unknown modules and provider or paid routing', () => {
  const valid = profile(1);
  for (const invalid of [
    { ...valid, mode: 'FULL' },
    { ...valid, translation: ['FULL', 'IMPORTANT_SEGMENTS'] },
    { ...valid, second_pass: true },
    { ...valid, validation_pass: { purpose: ' ' } },
    { ...valid, modules: { ...valid.modules, observations: true } },
    { ...valid, paid_services_enabled: true },
    { ...valid, runtime: 'cloud' },
    { ...valid, provider: 'gemini_paid' },
    { ...valid, history: 1 },
  ])
    expect(() => semanticProfile(invalid)).toThrow();
});
