import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import bundle from '../../config/registry/master-bundle.json';
import {
  verifyRegistryBundle,
  materializeProviderSchema,
  renderPrompt,
} from '../../packages/core/src/registry/bundle.js';
it('matches all exact Master schemas/templates and golden content hash', async () => {
  expect(await verifyRegistryBundle(bundle)).toBe(
    'dd1adb0ea34ccea46b080dd1ccffef1985682a37bbd16fcb7d73ae24bb4aa0eb',
  );
  const master = readFileSync(
    'Plan/BARTOSZ_INTELLIGENCE_MASTER_ARCHITECTURE_2026_v1.1.1.md',
    'utf8',
  ).replaceAll('\r\n', '\n');
  const section = master.slice(
    master.indexOf('## 24. Prompt Pack'),
    master.indexOf('## 25. UX/UI'),
  );
  const schemas = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
    (match) => JSON.parse(match[1]!),
  );
  expect(bundle.schemas.map((row) => row.schema)).toEqual(schemas);
  for (const row of bundle.prompts)
    expect(section).toContain('```text\n' + row.text + '\n```');
  const changed = structuredClone(bundle);
  changed.prompts[0]!.text += 'changed';
  await expect(verifyRegistryBundle(changed)).rejects.toThrow(
    'PROMPT_HASH_MISMATCH',
  );
});
it('validates full and materialized schemas without weakening the lean contract', () => {
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
  for (const row of bundle.schemas) {
    ajv.compile(row.schema);
    ajv.compile(materializeProviderSchema(row.schema));
  }
  const wire = bundle.schemas.find(
    (row) => row.id === 'urn:bartosz:schema:economy-wire:1.0',
  )!;
  const full = ajv.compile(wire.schema),
    subset = ajv.compile(materializeProviderSchema(wire.schema));
  const empty = Object.fromEntries(
    Object.keys(wire.schema.properties).map((key) => [key, []]),
  );
  for (const candidate of [
    empty,
    { ...empty, extra: true },
    {
      ...empty,
      claims: [
        {
          text_pl: 'a',
          segment_refs: ['s1'],
          entity_refs: [0],
          subject_ref: null,
          attribution: 'SOURCE_SPEAKER',
          qualifiers: [],
        },
      ],
    },
    {
      ...empty,
      tools: [{ entity_ref: '0', context_pl: 'a', segment_refs: ['s1'] }],
    },
    { ...empty, summary_pl: [{ text_pl: 'a', segment_refs: [] }] },
  ])
    expect(subset(candidate)).toBe(full(candidate));
  expect(full({ ...empty, extra: true })).toBe(false);
  const template = bundle.prompts[0]!.text;
  expect(() => renderPrompt(template, {})).toThrow('MISSING_PROMPT_BINDING');
  const bindings = Object.fromEntries(
    [...template.matchAll(/\{\{([a-z_]+)\}\}/g)].map((match) => [
      match[1]!,
      'null',
    ]),
  );
  expect(renderPrompt(template, bindings)).not.toContain('{{');
  expect(() =>
    materializeProviderSchema({ $ref: 'https://evil.invalid/schema' }),
  ).toThrow('UNSUPPORTED_SCHEMA_REF');
});
