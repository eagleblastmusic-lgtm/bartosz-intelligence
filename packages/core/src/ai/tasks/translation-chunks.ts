import { sha256 } from '../../auth/crypto.js';
import type { TranslationPlan } from './translation.js';

export interface TranslationChunkPolicy {
  version: 'translation-chunk-policy:1';
  max_source_bytes: number;
  max_segments: number;
  max_plan_bytes: number;
  max_parts: number;
}
/** Parts assign every original segment exactly once. No synthetic overlap or split timestamps. */
export async function planTranslationChunks(
  parent: TranslationPlan,
  policy: TranslationChunkPolicy,
) {
  if (
    policy.version !== 'translation-chunk-policy:1' ||
    ![
      policy.max_source_bytes,
      policy.max_segments,
      policy.max_plan_bytes,
      policy.max_parts,
    ].every((n) => Number.isSafeInteger(n) && n > 0) ||
    policy.max_parts > 128 ||
    policy.max_plan_bytes > 120000 ||
    policy.max_segments > 1000 ||
    policy.max_source_bytes > 100000
  )
    throw new Error('INVALID_TRANSLATION_CHUNK_POLICY');
  if (
    parent.hash !== (await sha256(JSON.stringify(parent.snapshot))) ||
    !parent.snapshot.segments.length ||
    parent.snapshot.scope === 'CHUNK'
  )
    throw new Error('INVALID_TRANSLATION_PARENT_PLAN');
  const { segments, ...source } = parent.snapshot;
  if (
    new Set(segments.map((s) => s.source_segment_id)).size !==
      segments.length ||
    segments.some((s, i) => s.alias !== `s${i + 1}`)
  )
    throw new Error('INVALID_TRANSLATION_PARENT_PLAN');
  const bytes = (value: string) => new TextEncoder().encode(value).length;
  const parts: TranslationPlan[] = [];
  let at = 0;
  while (at < segments.length) {
    const snapshot = {
      ...source,
      scope: 'CHUNK' as const,
      segments: [] as TranslationPlan['snapshot']['segments'],
    };
    // Calculate exact serialized plan bytes incrementally; avoid quadratic prefix serialization.
    const emptyBytes = bytes(JSON.stringify(snapshot));
    let sourceBytes = 2,
      planBytes = emptyBytes;
    while (
      at < segments.length &&
      snapshot.segments.length < policy.max_segments
    ) {
      const original = segments[at]!,
        segment = { ...original, alias: `s${snapshot.segments.length + 1}` };
      const sourceRowBytes =
        bytes(
          JSON.stringify({ segment_ref: segment.alias, text: segment.text }),
        ) + (snapshot.segments.length ? 1 : 0);
      const planRowBytes =
        bytes(JSON.stringify(segment)) + (snapshot.segments.length ? 1 : 0);
      if (
        sourceBytes + sourceRowBytes > policy.max_source_bytes ||
        planBytes + planRowBytes > policy.max_plan_bytes
      )
        break;
      sourceBytes += sourceRowBytes;
      planBytes += planRowBytes;
      snapshot.segments.push(segment);
      at++;
    }
    if (!snapshot.segments.length)
      throw new Error('TRANSLATION_SEGMENT_EXCEEDS_BUDGET');
    parts.push({ snapshot, hash: await sha256(JSON.stringify(snapshot)) });
    if (parts.length > policy.max_parts)
      throw new Error('TRANSLATION_CHUNK_LIMIT');
  }
  const manifest = {
    version: 'translation-chunks:1' as const,
    parent_plan_hash: parent.hash,
    source_hash: parent.snapshot.source_hash,
    manifest_hash: parent.snapshot.manifest_hash,
    policy: structuredClone(policy),
    parts: parts.map((part, index) => ({
      index,
      plan_hash: part.hash,
      source_segment_ids: part.snapshot.segments.map(
        (s) => s.source_segment_id,
      ),
    })),
  };
  return { manifest, hash: await sha256(JSON.stringify(manifest)), parts };
}
