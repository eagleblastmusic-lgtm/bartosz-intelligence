import { expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  const section = readFileSync(
    'tests/fixtures/registry/master-prompt-pack-v1.1.1.md',
    'utf8',
  ).replaceAll('\r\n', '\n');
  expect(bundle.master_sha256).toBe(
    '587d082647ffdc4ba9fd9d23f4163f428746d2bf7b4bc9544e7916f6d38823ed',
  );
  // Public, source-derived golden bytes are required on every runner. The
  // owner's full Plan stays private; when present it must agree as well.
  expect(createHash('sha256').update(section).digest('hex')).toBe(
    'f37e621be98cd85293fded035294299b93e21239c40de93075bfc1a9f574a103',
  );
  const privateMaster =
    'Plan/BARTOSZ_INTELLIGENCE_MASTER_ARCHITECTURE_2026_v1.1.1.md';
  if (existsSync(privateMaster)) {
    const master = readFileSync(privateMaster, 'utf8').replaceAll('\r\n', '\n');
    expect(
      master.slice(
        master.indexOf('## 24. Prompt Pack'),
        master.indexOf('## 25. UX/UI'),
      ),
    ).toBe(section);
  }
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
