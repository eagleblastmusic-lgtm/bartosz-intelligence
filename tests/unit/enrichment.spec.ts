import { it, expect } from 'vitest';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import { buildEvidence } from '../../packages/core/src/ai/enrichment/evidence.js';
import { resolveEntityMention } from '../../packages/core/src/ai/enrichment/entities.js';
import { enrichEconomy } from '../../packages/core/src/ai/enrichment/canonical.js';
async function source() {
  const cues = [
    {
      upstream_index: 0,
      text: 'I did not adopt Tool X.',
      start_ms: 0,
      end_ms: 2500,
      speaker_label: null,
    },
    {
      upstream_index: 1,
      text: 'Only a trial, not production.',
      start_ms: 2000,
      end_ms: 4000,
      speaker_label: null,
    },
    {
      upstream_index: 2,
      text: 'The speaker reports someone else’s opinion.',
      start_ms: 5000,
      end_ms: 6000,
      speaker_label: null,
    },
  ];
  const normalized = await normalizeTranscript(
    await sha256(cues.map((c) => c.text).join('\n')),
    cues,
    'CUE',
  );
  return {
    owner_id: 'a',
    source_artifact_id: 'source',
    source_text: normalized.source_text,
    manifest: normalized.manifest,
    manifest_hash: normalized.manifest_hash,
    video_url: 'https://www.youtube.com/watch?v=abcdefghijk',
    segment_refs: ['s1', 's2'],
  };
}
it('canonical typed projections are exactly the Observation rows, without manufactured usage or duplicate effects', async () => {
  const fullSource = await source();
  const { segment_refs: unused, ...pinnedSource } = fullSource;
  void unused;
  const claim = {
    text_pl: 'Autor nie wdrożył Tool X.',
    segment_refs: ['s1'],
    entity_refs: [0],
    subject_ref: null,
    attribution: 'SOURCE_SPEAKER',
    qualifiers: ['tylko próba'],
  };
  const wire = {
    summary_pl: [
      { text_pl: 'Autor opisuje próbę.', segment_refs: ['s1', 's2'] },
    ],
    key_points: [],
    entity_mentions: [
      { label: 'Tool X', entity_type: 'TOOL', segment_refs: ['s1'] },
    ],
    tools: [
      {
        entity_ref: 0,
        context_pl: 'Wzmianka o narzędziu.',
        segment_refs: ['s1'],
      },
    ],
    claims: [claim, claim],
    stance: [
      {
        ...claim,
        text_pl: 'Autor przytacza cudzą negatywną opinię.',
        segment_refs: ['s3'],
        attribution: 'REPORTED_OTHER',
        target_ref: 0,
        polarity: 'NEGATIVE',
      },
    ],
    predictions: [
      {
        ...claim,
        text_pl: 'Być może w przyszłym roku.',
        segment_refs: ['s2'],
        attribution: 'UNCLEAR',
        horizon: 'w przyszłym roku',
      },
    ],
    source_issues: [],
  };
  const input = {
    raw: JSON.stringify(wire),
    completion: 'OK' as const,
    run_id: 'run',
    item_id: 'item',
    profile_id: 'ECONOMY',
    profile_revision: '1',
    source: pinnedSource,
    approved_aliases: [],
  };
  const result = await enrichEconomy(input);
  expect(result.observation_rows).toHaveLength(3);
  expect(result.canonical.claims).toHaveLength(1);
  expect(result.observation_rows).toEqual([
    ...result.canonical.claims,
    ...result.canonical.stance,
    ...result.canonical.predictions,
  ]);
  expect(result.canonical.claims[0]).toMatchObject({
    kind: 'CLAIM',
    epistemic_status: 'SOURCE_STATEMENT',
    qualifiers: ['tylko próba'],
    target_ref: null,
    usage_stage: null,
    temporal_text: null,
    stance_polarity: null,
    prediction_horizon: null,
    relation_refs: [],
  });
  expect(result.canonical.stance[0]).toMatchObject({
    epistemic_status: 'SOURCE_REPORT',
    stance_polarity: 'NEGATIVE',
    target_ref: result.canonical.entities[0]!.entity_id,
  });
  expect(result.canonical.predictions[0]).toMatchObject({
    epistemic_status: 'UNRESOLVED',
    prediction_horizon: 'w przyszłym roku',
    temporal_text: 'w przyszłym roku',
    stance_polarity: null,
  });
  expect(result.canonical.usage).toEqual([]);
  expect(result.semantic_verification).toBe('NOT_ASSERTED');
  expect(await enrichEconomy(input)).toEqual(result);
  expect(result.canonical_hash).toBe(
    await sha256(JSON.stringify(result.canonical)),
  );
  const allEvidenceIds = new Set(
    result.canonical.evidence.map((e) => e.evidence_id),
  );
  expect(
    result.observation_rows.every((row) =>
      row.evidence_ids.every((id) => allEvidenceIds.has(id)),
    ),
  ).toBe(true);
  await expect(
    enrichEconomy({
      ...input,
      raw: JSON.stringify({ ...wire, source_issues: ['brak źródła'] }),
    }),
  ).rejects.toThrow('REVIEW_REQUIRED');
  await expect(
    enrichEconomy({
      ...input,
      raw: JSON.stringify({ ...wire, claims: [{ ...claim, subject_ref: 2 }] }),
    }),
  ).rejects.toThrow('FOREIGN_ENTITY_REF');
  await expect(
    enrichEconomy({ ...input, completion: 'REFUSED' }),
  ).rejects.toThrow('REFUSAL_NOT_REPAIRABLE');
});
it('evidence resolves exact continuous source ranges, splits omitted anchors, and never invents time', async () => {
  const input = await source();
  const continuous = await buildEvidence(input);
  expect(continuous).toHaveLength(1);
  expect(continuous[0]!.canonical.quote_original).toBe(
    'I did not adopt Tool X.\nOnly a trial, not production.',
  );
  expect(continuous[0]!.canonical.quote_hash).toBe(
    await sha256(continuous[0]!.canonical.quote_original),
  );
  expect(continuous[0]!.canonical).toMatchObject({
    start_ms: 0,
    end_ms: 4000,
    timestamp_precision: 'CUE',
    timestamp_url: 'https://www.youtube.com/watch?v=abcdefghijk&t=0s',
    quote_pl: null,
  });
  expect(await buildEvidence({ ...input, segment_refs: ['s2', 's1'] })).toEqual(
    continuous,
  );
  const split = await buildEvidence({ ...input, segment_refs: ['s1', 's3'] });
  expect(split).toHaveLength(2);
  expect(split[1]!.canonical.quote_original).toBe(
    'The speaker reports someone else’s opinion.',
  );
  expect(
    (await buildEvidence({ ...input, owner_id: 'b' }))[0]!.canonical
      .evidence_id,
  ).not.toBe(continuous[0]!.canonical.evidence_id);
  await expect(
    buildEvidence({ ...input, segment_refs: ['s4'] }),
  ).rejects.toThrow('FOREIGN_SOURCE_REF');
  await expect(
    buildEvidence({ ...input, source_text: input.source_text + ' changed' }),
  ).rejects.toThrow('EVIDENCE_SOURCE_MISMATCH');
  input.manifest.anchors[1]!.start_ms = null;
  input.manifest_hash = await sha256(JSON.stringify(input.manifest));
  expect((await buildEvidence(input))[0]!.canonical).toMatchObject({
    start_ms: null,
    end_ms: null,
    timestamp_precision: 'NONE',
    timestamp_url: null,
  });
});
it('large cue fragments retain parent times and NFC/entities never overwrite the declared source quote', async () => {
  const text = '  No &amp; e\u0301 😀 ' + 'long '.repeat(30);
  const normalized = await normalizeTranscript(
    await sha256(text),
    [
      {
        upstream_index: 0,
        text,
        start_ms: 2000,
        end_ms: 8000,
        speaker_label: null,
      },
    ],
    'CUE',
    32,
  );
  const input = {
    owner_id: 'a',
    source_artifact_id: 'original',
    ...normalized,
    video_url: null,
    segment_refs: normalized.manifest.anchors.map((a) => a.alias),
  };
  const evidence = await buildEvidence(input);
  expect(evidence).toHaveLength(1);
  expect(evidence[0]!.canonical.quote_original).toContain('&amp; e\u0301 😀');
  expect(evidence[0]!.canonical).toMatchObject({
    start_ms: 2000,
    end_ms: 8000,
    timestamp_precision: 'CUE',
    timestamp_url: null,
  });
});
it('Polish quote requires exact approved source/helper revisions and an unambiguous group mapping', async () => {
  const input = await source();
  const mappings = [
    {
      segment_ids: input.manifest.anchors.slice(0, 2).map((a) => a.segment_id),
      start: 0,
      end: 19,
    },
  ];
  const helper = {
    approved_mapping_id: 'owner-reviewed',
    source_hash: input.manifest.source_revision,
    helper_artifact_id: 'pl',
    text: 'Nie wdrożyłem tego.',
    helper_hash: await sha256('Nie wdrożyłem tego.'),
    mappings,
    mapping_hash: await sha256(JSON.stringify(mappings)),
  };
  helper.mappings[0]!.end = helper.text.length;
  helper.mapping_hash = await sha256(JSON.stringify(helper.mappings));
  expect(
    (await buildEvidence({ ...input, helper }))[0]!.canonical.quote_pl,
  ).toBe(helper.text);
  expect(
    (await buildEvidence({ ...input, helper, segment_refs: ['s1'] }))[0]!
      .canonical.quote_pl,
  ).toBeNull();
  await expect(
    buildEvidence({
      ...input,
      helper: { ...helper, source_hash: 'b'.repeat(64) },
    }),
  ).rejects.toThrow('INVALID_HELPER_REVISION');
  const duplicate = [...helper.mappings, ...helper.mappings];
  await expect(
    buildEvidence({
      ...input,
      helper: {
        ...helper,
        mappings: duplicate,
        mapping_hash: await sha256(JSON.stringify(duplicate)),
      },
    }),
  ).rejects.toThrow('AMBIGUOUS_HELPER_MAPPING');
});
it('entity mapping uses only unambiguous owner-approved aliases, preserving unresolved literals', async () => {
  const input = {
    owner_id: 'a',
    source_artifact_id: 'source',
    mention_index: 0,
    label: 'Apple',
    entity_type: 'ORG' as const,
    aliases: [
      {
        owner_id: 'b',
        entity_id: 'foreign',
        entity_type: 'ORG' as const,
        literal: 'Apple',
      },
    ],
  };
  const unresolved = await resolveEntityMention(input);
  expect(unresolved.resolution).toBe('UNRESOLVED_LITERAL');
  expect(unresolved.entity_id).not.toBe('foreign');
  const alias = { ...input.aliases[0]!, owner_id: 'a', entity_id: 'approved' };
  expect(
    await resolveEntityMention({ ...input, aliases: [alias] }),
  ).toMatchObject({ entity_id: 'approved', resolution: 'APPROVED_ALIAS' });
  const ambiguous = await resolveEntityMention({
    ...input,
    aliases: [alias, { ...alias, entity_id: 'another' }],
  });
  expect(ambiguous.resolution).toBe('AMBIGUOUS_LITERAL');
  expect(ambiguous.entity_id).not.toBe('approved');
  expect(
    (await resolveEntityMention({ ...input, mention_index: 1 })).entity_id,
  ).not.toBe(unresolved.entity_id);
  expect(
    (await resolveEntityMention({ ...input, entity_type: 'TOOL' })).entity_id,
  ).not.toBe(unresolved.entity_id);
});
