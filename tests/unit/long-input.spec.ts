import { it, expect } from 'vitest';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import {
  createChunkPlan,
  verifyChunkPlan,
} from '../../packages/core/src/ai/long-input/plan.js';
import { mergeChunkOutputs } from '../../packages/core/src/ai/long-input/merge.js';
async function fixture() {
  const cues = Array.from({ length: 12 }, (_, i) => ({
    upstream_index: i,
    text: `Statement ${i}: I did not adopt Tool X; it was only a trial.`,
    start_ms: i * 1000,
    end_ms: i * 1000 + 1500,
    speaker_label: null,
  }));
  const source = await normalizeTranscript(
    await sha256(cues.map((c) => c.text).join('\n')),
    cues,
    'CUE',
  );
  const built = await createChunkPlan({
    ...source,
    context_hash: 'a'.repeat(64),
    context_tokens: 480,
    output_tokens: 80,
    prompt_overhead_tokens: 100,
    maximum_overlap_segments: 1,
  });
  return { ...source, ...built };
}
it('immutable bounded chunk plan covers every primary segment exactly once with explicit overlap', async () => {
  const input = await fixture();
  expect(input.plan.chunks.length).toBeGreaterThan(1);
  expect(input.plan.chunks.flatMap((c) => c.primary_segment_ids)).toEqual(
    input.manifest.anchors.map((a) => a.segment_id),
  );
  expect(
    input.plan.chunks.every(
      (c) =>
        c.estimated_input_tokens + input.plan.output_tokens <=
        input.plan.context_tokens,
    ),
  ).toBe(true);
  expect(
    input.plan.chunks.slice(1).every((c) => c.overlap_segment_ids.length === 1),
  ).toBe(true);
  await verifyChunkPlan(
    input.plan,
    input.plan_hash,
    input.manifest,
    input.manifest_hash,
  );
  const changed = structuredClone(input.plan);
  changed.chunks[1]!.primary_start++;
  await expect(
    verifyChunkPlan(
      changed,
      await sha256(JSON.stringify(changed)),
      input.manifest,
      input.manifest_hash,
    ),
  ).rejects.toThrow('CHUNK_COVERAGE_GAP');
  await expect(
    verifyChunkPlan(
      input.plan,
      'b'.repeat(64),
      input.manifest,
      input.manifest_hash,
    ),
  ).rejects.toThrow('CHUNK_PLAN_MISMATCH');
});
it('huge single cue is fully fragmented with inherited times or fails admission explicitly', async () => {
  const text = '😀 Negation remains: not adopted. '.repeat(200);
  const source = await normalizeTranscript(
    await sha256(text),
    [
      {
        upstream_index: 0,
        text,
        start_ms: 123,
        end_ms: 9999,
        speaker_label: null,
      },
    ],
    'CUE',
    96,
  );
  const plan = await createChunkPlan({
    ...source,
    context_hash: 'a'.repeat(64),
    context_tokens: 400,
    output_tokens: 50,
    prompt_overhead_tokens: 100,
  });
  expect(plan.plan.chunks.flatMap((c) => c.primary_segment_ids)).toEqual(
    source.manifest.anchors.map((a) => a.segment_id),
  );
  expect(
    source.manifest.anchors.every(
      (a) => a.start_ms === 123 && a.end_ms === 9999,
    ),
  ).toBe(true);
  await expect(
    createChunkPlan({
      ...source,
      context_hash: 'a'.repeat(64),
      context_tokens: 170,
      output_tokens: 50,
      prompt_overhead_tokens: 100,
    }),
  ).rejects.toThrow('SOURCE_FRAGMENT_EXCEEDS_CONTEXT');
});
it('missing delivery stays partial; source-order merge remaps local entity indices without synthesis', async () => {
  const input = await fixture();
  const outputs = input.plan.chunks.map((chunk) => {
    const alias = chunk.aliases.find(
      (a) => a.segment_id === chunk.primary_segment_ids[0],
    )!.alias;
    const row = {
      text_pl: `Nie wdrożono, część ${chunk.chunk_index}.`,
      segment_refs: [alias],
      entity_refs: [0],
      subject_ref: null,
      attribution: 'SOURCE_SPEAKER',
      qualifiers: ['tylko próba'],
    };
    const wire = {
      summary_pl: [
        { text_pl: `Sekcja ${chunk.chunk_index}`, segment_refs: [alias] },
      ],
      key_points: [],
      entity_mentions: [
        { label: 'Tool X', entity_type: 'TOOL', segment_refs: [alias] },
      ],
      tools: [],
      claims: [row],
      stance: [],
      predictions: [],
      source_issues: [],
    };
    return {
      chunk_index: chunk.chunk_index,
      raw: JSON.stringify(wire),
      completion: 'OK' as const,
    };
  });
  const complete = await mergeChunkOutputs({
    ...input,
    outputs: [...outputs].reverse(),
  });
  expect(complete.coverage.complete).toBe(true);
  expect(complete.coverage.accepted_primary_segment_ids).toEqual(
    input.manifest.anchors.map((a) => a.segment_id),
  );
  expect(complete.additional_model_requests).toBe(0);
  expect(
    complete.wire.summary_pl.map((row) => (row as { text_pl: string }).text_pl),
  ).toEqual(outputs.map((o) => `Sekcja ${o.chunk_index}`));
  expect(
    complete.wire.claims.map(
      (row) => (row as { entity_refs: number[] }).entity_refs,
    ),
  ).toEqual(outputs.map((o) => [o.chunk_index]));
  const partial = await mergeChunkOutputs({
    ...input,
    outputs: outputs.slice(1),
  });
  expect(partial.status).toBe('PARTIAL');
  expect(partial.coverage.missing).toEqual([0]);
  expect(await mergeChunkOutputs({ ...input, outputs })).toEqual(complete);
  await expect(
    mergeChunkOutputs({ ...input, outputs: [outputs[0]!, outputs[0]!] }),
  ).rejects.toThrow('INVALID_CHUNK_DELIVERY');
  const foreign = JSON.parse(outputs[0]!.raw);
  foreign.claims[0].entity_refs = [1];
  await expect(
    mergeChunkOutputs({
      ...input,
      outputs: [{ ...outputs[0]!, raw: JSON.stringify(foreign) }],
    }),
  ).rejects.toThrow('FOREIGN_ENTITY_REF');
});
it('overlap dedup removes only exact equivalents, preserving a similar statement with different qualifiers', async () => {
  const input = await fixture();
  const shared = input.plan.chunks[1]!.overlap_segment_ids[0]!;
  const outputs = input.plan.chunks.slice(0, 2).map((chunk) => {
    const alias = chunk.aliases.find((a) => a.segment_id === shared)!.alias;
    const record = {
      text_pl: 'Nie wdrożył narzędzia.',
      segment_refs: [alias],
      entity_refs: [0],
      subject_ref: null,
      attribution: 'SOURCE_SPEAKER',
      qualifiers: ['tylko próba'],
    };
    return {
      chunk_index: chunk.chunk_index,
      completion: 'OK' as const,
      raw: JSON.stringify({
        summary_pl: [{ text_pl: 'Sekcja', segment_refs: [alias] }],
        key_points: [],
        entity_mentions: [
          { label: 'Tool X', entity_type: 'TOOL', segment_refs: [alias] },
        ],
        tools: [],
        claims:
          chunk.chunk_index === 0
            ? [record]
            : [
                {
                  qualifiers: record.qualifiers,
                  attribution: record.attribution,
                  subject_ref: null,
                  entity_refs: [0],
                  segment_refs: [alias],
                  text_pl: record.text_pl,
                },
                { ...record, qualifiers: ['próba przerwana'] },
              ],
        stance: [],
        predictions: [],
        source_issues: [],
      }),
    };
  });
  const merged = await mergeChunkOutputs({ ...input, outputs });
  expect(merged.wire.entity_mentions).toHaveLength(1);
  expect(merged.wire.claims).toHaveLength(2);
  expect(merged.wire.summary_pl).toHaveLength(2);
  expect(merged.coverage.complete).toBe(false);
});
