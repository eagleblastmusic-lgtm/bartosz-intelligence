import { it, expect } from 'vitest';
import { strictJson } from '../../packages/core/src/ai/repair/strict-json.js';
import { parseWithDeterministicRepair } from '../../packages/core/src/ai/repair/deterministic.js';
import { validateEconomyCandidate } from '../../packages/core/src/ai/repair/validate.js';
it('exact wire and semantic refs are enforced after format repair', async () => {
  const wire = {
    summary_pl: [
      {
        text_pl: 'Autor mówi, że nie wdrożył narzędzia.',
        segment_refs: ['s1'],
      },
    ],
    key_points: [],
    entity_mentions: [],
    tools: [],
    claims: [],
    stance: [],
    predictions: [],
    source_issues: [],
  };
  expect(
    (
      await validateEconomyCandidate(
        JSON.stringify(wire),
        'OK',
        new Set(['s1']),
      )
    ).valid,
  ).toBe(true);
  expect(
    (await validateEconomyCandidate('{}', 'OK', new Set(['s1']))).reason,
  ).toBe('WIRE_SCHEMA_INVALID');
  expect(
    (
      await validateEconomyCandidate(
        JSON.stringify(wire),
        'OK',
        new Set(['s2']),
      )
    ).reason,
  ).toBe('FOREIGN_SOURCE_REF');
  expect(
    (
      await validateEconomyCandidate(
        JSON.stringify({ ...wire, source_issues: ['brak źródła'] }),
        'OK',
        new Set(['s1']),
      )
    ).reason,
  ).toBe('REVIEW_REQUIRED');
  await expect(
    validateEconomyCandidate('{}', 'INCOMPLETE', new Set()),
  ).rejects.toThrow('TRUNCATION_NOT_REPAIRABLE');
});
it('strict parser rejects duplicate decoded keys, malformed escapes/numbers and trailing roots', () => {
  for (const text of [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"x":"\\q"}',
    '{"x":01}',
    '{"x":1e999}',
    '{} {}',
    '{"x":1,}',
    '[1,]',
    '{"x":"unfinished',
  ])
    expect(() => strictJson(text)).toThrow();
  expect(strictJson('{"__proto__":{"polluted":true}}')).toHaveProperty(
    '__proto__',
  );
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(strictJson('{"n":-0.5e+2,"a":[null,true,false]}')).toEqual({
    n: -50,
    a: [null, true, false],
  });
});
it('DR only removes exact outer wrappers and preserves every string byte', async () => {
  const json = '{"text":"  JSON: ```json \\n \\uFEFF  ","a":[]}';
  for (const wrapper of [
    json,
    '\uFEFF' + json,
    '  ' + json + '\r\n',
    '```json\n' + json + '\n```',
    'Oto JSON:\n' + json,
  ]) {
    const parsed = await parseWithDeterministicRepair(wrapper);
    expect(parsed.value).toEqual(JSON.parse(json));
    expect(parsed.candidate).toBe(
      parsed.report.result === 'STRICT_PASS' ? wrapper : json,
    );
  }
  const composed = await parseWithDeterministicRepair(
    '\uFEFF ```json\n' + json + '\n``` ',
  );
  expect(composed.report.applied).toEqual(['DR1', 'DR2', 'DR3']);
  const wrapped = '\uFEFF ```json\n' + json + '\n``` ';
  const removed = composed.report.changes.flatMap(
    (change) => change.removed_spans,
  );
  expect(
    removed.reduce(
      (n, span) =>
        n +
        new TextEncoder().encode(wrapped.slice(span.start, span.end)).length,
      0,
    ),
  ).toBe(
    new TextEncoder().encode(wrapped).length -
      new TextEncoder().encode(json).length,
  );
  for (const text of [
    '```json\n{}\n``` prose',
    'JSON:\n{} trailing',
    'I refuse.\n{}',
    '```python\n{}\n```',
    '{"a":1,"a":2}',
    '```json\n{"a":\n```',
    'JSON:\n{}\n{}',
  ])
    await expect(parseWithDeterministicRepair(text)).rejects.toThrow();
});
