import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { RegistryBundle } from '../../packages/core/src/registry/bundle.js';
import {
  compileSemanticProfile,
  semanticModules,
  type SemanticProfile,
} from '../../packages/core/src/ai/semantic-profile.js';
import { enrichSemantic } from '../../packages/core/src/ai/enrichment/canonical.js';
import { validateSemanticCandidate } from '../../packages/core/src/ai/repair/validate.js';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
const bundle = JSON.parse(
  readFileSync('config/registry/master-bundle.json', 'utf8'),
) as RegistryBundle;
async function compiled(selected?: string[]) {
  return compileSemanticProfile(
    {
      mode: selected ? 'CUSTOM' : 'FULL',
      modules: Object.fromEntries(
        semanticModules.map((key) => [
          key,
          !selected || selected.includes(key),
        ]),
      ) as SemanticProfile['modules'],
      translation: 'NONE',
      history: false,
      second_pass: null,
      validation_pass: null,
    },
    bundle,
  );
}
const claim = {
  text_pl: 'Autor tylko wypróbował narzędzie.',
  segment_refs: ['s1'],
  entity_refs: [0],
  subject_ref: null,
  attribution: 'SOURCE_SPEAKER',
  qualifiers: ['tylko próba'],
};
function wire() {
  return {
    summary_pl: [
      {
        text_pl: 'Próba narzędzia z zastrzeżeniami.',
        segment_refs: ['s1', 's2'],
      },
    ],
    key_points: [],
    entity_mentions: [
      { label: 'Tool X', entity_type: 'TOOL', segment_refs: ['s1'] },
    ],
    tools: [
      {
        entity_ref: 0,
        context_pl: 'Wzmianka o narzędziu',
        segment_refs: ['s1'],
      },
    ],
    claims: [{ ...claim }],
    stance: [
      {
        ...claim,
        text_pl: 'Autor przytacza negatywną opinię.',
        attribution: 'REPORTED_OTHER',
        segment_refs: ['s2'],
        polarity: 'NEGATIVE',
        target_ref: 0,
      },
    ],
    predictions: [
      {
        ...claim,
        text_pl: 'Być może w przyszłym roku.',
        attribution: 'UNCLEAR',
        horizon: 'w przyszłym roku',
      },
    ],
    usage: [{ ...claim, target_ref: 0, stage: 'TRIED' }],
    recommendations: [
      { ...claim, text_pl: 'Rekomenduje tylko próbę.', target_ref: 0 },
    ],
    uncertainties: [
      {
        ...claim,
        text_pl: 'Nie wiadomo, czy przyjmie się w produkcji.',
        attribution: 'UNCLEAR',
      },
    ],
    contradictions: [
      {
        left: { module: 'claims', index: 0 },
        right: { module: 'stance', index: 0 },
        explanation_pl: 'Możliwa różnica przytoczonych wypowiedzi.',
        qualifiers: ['tylko próba', 'niepewna interpretacja'],
      },
    ],
    source_issues: [],
  };
}
async function input(value: unknown) {
  const cues = [
    {
      upstream_index: 0,
      text: 'I only tried Tool X.',
      start_ms: 0,
      end_ms: 2000,
      speaker_label: null,
    },
    {
      upstream_index: 1,
      text: 'They said it was bad. I may recommend a trial next year.',
      start_ms: null,
      end_ms: null,
      speaker_label: null,
    },
  ];
  const normalized = await normalizeTranscript(
    await sha256(cues.map((cue) => cue.text).join('\n')),
    cues,
    'CUE',
  );
  return {
    raw: JSON.stringify(value),
    completion: 'OK' as const,
    run_id: 'full-run',
    item_id: 'item',
    profile_id: 'semantic-full',
    profile_revision: 'revision-pinned',
    approved_aliases: [],
    source: {
      owner_id: 'owner',
      source_artifact_id: 'source',
      source_text: normalized.source_text,
      manifest: normalized.manifest,
      manifest_hash: normalized.manifest_hash,
      video_url: 'https://www.youtube.com/watch?v=abcdefghijk',
    },
  };
}
it('maps all Full typed records once with kind-specific nulls, attribution and independent usage', async () => {
  const result = await enrichSemantic(await input(wire()), await compiled());
  expect(result.observation_rows).toEqual([
    ...result.canonical.claims,
    ...result.canonical.stance,
    ...result.canonical.predictions,
    ...result.canonical.usage,
    ...result.canonical.recommendations,
    ...result.canonical.uncertainties,
    ...result.canonical.contradictions,
  ]);
  expect(result.observation_rows).toHaveLength(7);
  expect(result.canonical.usage[0]).toMatchObject({
    kind: 'USAGE',
    usage_stage: 'TRIED',
    stance_polarity: null,
    prediction_horizon: null,
  });
  expect(result.canonical.stance[0]).toMatchObject({
    kind: 'STANCE',
    epistemic_status: 'SOURCE_REPORT',
    attribution: 'REPORTED_OTHER',
    stance_polarity: 'NEGATIVE',
    usage_stage: null,
  });
  expect(result.canonical.predictions[0]).toMatchObject({
    epistemic_status: 'UNRESOLVED',
    temporal_text: 'w przyszłym roku',
    prediction_horizon: 'w przyszłym roku',
  });
  expect(result.canonical.uncertainties[0]).toMatchObject({
    kind: 'UNCERTAINTY',
    target_ref: null,
    usage_stage: null,
    epistemic_status: 'UNRESOLVED',
  });
  expect(result.semantic_verification).toBe('NOT_ASSERTED');
  expect(result.canonical_hash).toBe(
    await sha256(JSON.stringify(result.canonical)),
  );
});
it('creates relation inference from two existing rows with exact evidence/qualifier unions, never speaker attribution', async () => {
  const data = await input(wire()),
    profile = await compiled();
  const result = await enrichSemantic(data, profile),
    relation = result.canonical.contradictions[0]!;
  expect(relation).toMatchObject({
    kind: 'CONTRADICTION',
    content_pl: wire().contradictions[0]!.explanation_pl,
    epistemic_status: 'SOURCE_INFERENCE',
    attribution: 'UNCLEAR',
    subject_ref: null,
    target_ref: null,
    temporal_text: null,
    stance_polarity: null,
    usage_stage: null,
    prediction_horizon: null,
  });
  expect(relation.relation_refs).toEqual([
    result.canonical.claims[0]!.observation_id,
    result.canonical.stance[0]!.observation_id,
  ]);
  expect(relation.evidence_ids).toEqual([
    ...new Set([
      ...result.canonical.claims[0]!.evidence_ids,
      ...result.canonical.stance[0]!.evidence_ids,
    ]),
  ]);
  expect(relation.qualifiers).toEqual([
    'tylko próba',
    'niepewna interpretacja',
  ]);
  expect(relation.entity_refs).toEqual([
    result.canonical.entities[0]!.entity_id,
  ]);
  expect(
    result.canonical.evidence.some(
      (row) =>
        row.quote_original === data.source.manifest.anchors[1]!.text &&
        row.timestamp_url === null,
    ),
  ).toBe(true);
  expect(await enrichSemantic(data, profile)).toEqual(result);
});
it('Custom without summary accepts only selected arrays while retaining structural entity refs and exact wire ID', async () => {
  const original = wire(),
    value = {
      entity_mentions: original.entity_mentions,
      source_issues: [],
      usage: original.usage,
    };
  const profile = await compiled(['usage']),
    result = await enrichSemantic(await input(value), profile);
  expect(result.canonical.enabled_modules).toEqual(['usage']);
  expect(result.canonical.summary_pl).toEqual([]);
  expect(result.canonical.claims).toEqual([]);
  expect(result.canonical.entities).toHaveLength(1);
  expect(result.observation_rows).toHaveLength(1);
  expect(result.canonical.wire_schema_id).toBe(profile.wire.id);
  await expect(
    enrichSemantic(await input({ ...value, claims: original.claims }), profile),
  ).rejects.toThrow('WIRE_SCOPE_INVALID');
});
it('allows two distinct records of one selected typed module, and gives each candidate position a stable identity', async () => {
  const value = {
    entity_mentions: wire().entity_mentions,
    source_issues: [],
    claims: [
      claim,
      {
        ...claim,
        text_pl: 'Autor nie wdrożył narzędzia.',
        segment_refs: ['s2'],
      },
    ],
    contradictions: [
      {
        left: { module: 'claims', index: 0 },
        right: { module: 'claims', index: 1 },
        explanation_pl: 'Możliwa różnica.',
        qualifiers: [],
      },
    ],
  };
  const result = await enrichSemantic(
    await input(value),
    await compiled(['claims', 'contradictions']),
  );
  expect(result.canonical.claims[0]!.observation_id).not.toBe(
    result.canonical.claims[1]!.observation_id,
  );
  expect(result.canonical.contradictions[0]!.relation_refs).toEqual(
    result.canonical.claims.map((row) => row.observation_id),
  );
  const duplicated = await enrichSemantic(
    await input({ ...value, claims: [claim, claim], contradictions: [] }),
    await compiled(['claims', 'contradictions']),
  );
  expect(duplicated.canonical.claims).toHaveLength(2);
  expect(
    new Set(duplicated.canonical.claims.map((row) => row.observation_id)).size,
  ).toBe(2);
});
it('retains a verified source pin even when a legal selected module finds no records or evidence', async () => {
  const profile = await compiled(['contradictions']);
  const data = await input({
    entity_mentions: [],
    source_issues: [],
    contradictions: [],
  });
  const result = await enrichSemantic(data, profile);
  expect(result.canonical.enabled_modules).toEqual(['contradictions']);
  expect(result.canonical.evidence).toEqual([]);
  expect(result.observation_rows).toEqual([]);
  expect(result.source_pin).toEqual({
    artifact_id: data.source.source_artifact_id,
    source_hash: data.source.manifest.source_text_hash,
    manifest_hash: data.source.manifest_hash,
  });
});
it('rejects missing, self, foreign, cyclic and identical relation sides without inventing observations', async () => {
  const profile = await compiled();
  for (const [left, right, reason] of [
    [
      { module: 'claims', index: 0 },
      { module: 'claims', index: 0 },
      'SELF_RELATION_REF',
    ],
    [
      { module: 'claims', index: 0 },
      { module: 'usage', index: 99 },
      'FOREIGN_RELATION_REF',
    ],
    [
      { module: 'contradictions', index: 0 },
      { module: 'claims', index: 0 },
      'WIRE_SCHEMA_INVALID',
    ],
    [
      { module: 'foreign', index: 0 },
      { module: 'claims', index: 0 },
      'WIRE_SCHEMA_INVALID',
    ],
  ] as const) {
    const value = wire();
    value.contradictions = [{ ...value.contradictions[0]!, left, right }];
    await expect(enrichSemantic(await input(value), profile)).rejects.toThrow(
      reason,
    );
  }
  const value = wire();
  value.claims = [claim, claim];
  value.contradictions[0]!.right = { module: 'claims', index: 1 };
  await expect(enrichSemantic(await input(value), profile)).rejects.toThrow(
    'DUPLICATE_RELATION_SIDES',
  );
});
it('rejects foreign evidence/entities, mention-as-usage, null arrays, diagnostics and incomplete output', async () => {
  const profile = await compiled(),
    aliases = new Set(['s1', 's2']);
  const value = wire();
  for (const [patch, reason] of [
    [
      { usage: [{ ...value.usage[0], stage: 'MENTIONED' }] },
      'WIRE_SCHEMA_INVALID',
    ],
    [{ usage: null }, 'WIRE_SCHEMA_INVALID'],
    [
      {
        uncertainties: [
          { ...value.uncertainties[0], segment_refs: ['foreign'] },
        ],
      },
      'FOREIGN_SOURCE_REF',
    ],
    [
      { recommendations: [{ ...value.recommendations[0], target_ref: 99 }] },
      'FOREIGN_ENTITY_REF',
    ],
    [{ source_issues: ['Brak wystarczającego źródła'] }, 'REVIEW_REQUIRED'],
  ] as const)
    expect(
      (
        await validateSemanticCandidate(
          JSON.stringify({ ...value, ...patch }),
          'OK',
          aliases,
          profile,
        )
      ).reason,
    ).toBe(reason);
  await expect(
    validateSemanticCandidate(
      JSON.stringify(value),
      'INCOMPLETE',
      aliases,
      profile,
    ),
  ).rejects.toThrow('TRUNCATION_NOT_REPAIRABLE');
});
