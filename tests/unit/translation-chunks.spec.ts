import { it, expect } from 'vitest';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import {
  planTranslationChunks,
  type TranslationChunkPolicy,
} from '../../packages/core/src/ai/tasks/translation-chunks.js';
import {
  mapTranslation,
  type TranslationPlan,
} from '../../packages/core/src/ai/tasks/translation.js';
import { composeTranslations } from '../../packages/core/src/ai/tasks/translation-recovery.js';
const policy: TranslationChunkPolicy = {
  version: 'translation-chunk-policy:1',
  max_source_bytes: 200,
  max_segments: 3,
  max_plan_bytes: 2000,
  max_parts: 128,
};
async function parent(count = 20): Promise<TranslationPlan> {
  const snapshot: TranslationPlan['snapshot'] = {
    version: 'translation-plan:1',
    source_artifact_id: 'original',
    source_hash: 'a'.repeat(64),
    manifest_hash: 'b'.repeat(64),
    source_language: 'en',
    scope: 'FULL',
    segments: Array.from({ length: count }, (_, i) => ({
      alias: `s${i + 1}`,
      source_segment_id: `segment-${i}`,
      text: `Not 12% — ź😀 ${i}`,
      source_start: i * 30,
      source_end: i * 30 + 20,
      start_ms: i % 2 ? null : i * 1000,
      end_ms: i % 2 ? null : i * 1000 + 500,
      timestamp_precision: i % 2 ? 'NONE' : 'CUE',
    })),
  };
  return { snapshot, hash: await sha256(JSON.stringify(snapshot)) };
}
it('partitions exact immutable segments once, resets local aliases and composes all parts in original order', async () => {
  const plan = await parent(),
    before = structuredClone(plan),
    chunks = await planTranslationChunks(plan, policy);
  expect(chunks.parts.length).toBeGreaterThan(1);
  expect(
    chunks.parts.flatMap((p) =>
      p.snapshot.segments.map((s) => s.source_segment_id),
    ),
  ).toEqual(plan.snapshot.segments.map((s) => s.source_segment_id));
  for (const part of chunks.parts) {
    expect(part.snapshot.segments.map((s) => s.alias)).toEqual(
      part.snapshot.segments.map((_, i) => `s${i + 1}`),
    );
    expect(
      new TextEncoder().encode(JSON.stringify(part.snapshot)).length,
    ).toBeLessThanOrEqual(policy.max_plan_bytes);
    expect(part.snapshot.segments.length).toBeLessThanOrEqual(
      policy.max_segments,
    );
    expect(
      new TextEncoder().encode(
        JSON.stringify(
          part.snapshot.segments.map((s) => ({
            segment_ref: s.alias,
            text: s.text,
          })),
        ),
      ).length,
    ).toBeLessThanOrEqual(policy.max_source_bytes);
  }
  const translated = await Promise.all(
    chunks.parts.map(async (part) => ({
      plan: part,
      mapped: await mapTranslation(part, {
        status: 'OK',
        raw_output: JSON.stringify({
          status: 'OK',
          translated_segments: part.snapshot.segments.map((s) => ({
            segment_ref: s.alias,
            text_pl: `Nie 12%: ${s.source_segment_id}`,
            issues: [],
          })),
          limitations_pl: [],
        }),
      }),
    })),
  );
  const result = await composeTranslations(plan, translated.reverse());
  expect(result.coverage).toMatchObject({
    expected: 20,
    translated: 20,
    complete: true,
  });
  expect(result.canonical.scope).toBe('FULL');
  expect(result.mappings.map((m) => [m.start_ms, m.end_ms])).toEqual(
    plan.snapshot.segments.map((s) => [s.start_ms, s.end_ms]),
  );
  expect(plan).toEqual(before);
  expect((await planTranslationChunks(plan, policy)).hash).toBe(chunks.hash);
});
it('refuses oversize indivisible cues, incomplete budgets and excess parts rather than truncating source', async () => {
  const plan = await parent();
  await expect(
    planTranslationChunks(plan, { ...policy, max_source_bytes: 1 }),
  ).rejects.toThrow('TRANSLATION_SEGMENT_EXCEEDS_BUDGET');
  await expect(
    planTranslationChunks(plan, { ...policy, max_parts: 1 }),
  ).rejects.toThrow('TRANSLATION_CHUNK_LIMIT');
  await expect(
    planTranslationChunks(plan, { ...policy, max_segments: 0 }),
  ).rejects.toThrow('INVALID_TRANSLATION_CHUNK_POLICY');
  const corrupt = structuredClone(plan);
  corrupt.snapshot.segments[0]!.text = 'changed';
  await expect(planTranslationChunks(corrupt, policy)).rejects.toThrow(
    'INVALID_TRANSLATION_PARENT_PLAN',
  );
});
