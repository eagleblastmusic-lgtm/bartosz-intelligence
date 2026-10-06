import { sha256 } from '../../auth/crypto.js';
import type { normalizeTranscript } from '../../transcript/normalize.js';
type Manifest = Awaited<ReturnType<typeof normalizeTranscript>>['manifest'];
export interface ChunkPlan {
  version: 'chunk-plan:1';
  source_revision: string;
  manifest_hash: string;
  context_hash: string;
  context_tokens: number;
  output_tokens: number;
  prompt_overhead_tokens: number;
  estimate_method: 'utf8-byte-upper-bound:1';
  chunks: {
    chunk_index: number;
    primary_start: number;
    primary_end: number;
    overlap_start: number;
    primary_segment_ids: string[];
    overlap_segment_ids: string[];
    aliases: { alias: string; segment_id: string; global_alias: string }[];
    estimated_input_tokens: number;
    source_start: number;
    source_end: number;
  }[];
}
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
export async function createChunkPlan(input: {
  manifest: Manifest;
  manifest_hash: string;
  context_hash: string;
  context_tokens: number;
  output_tokens: number;
  prompt_overhead_tokens: number;
  maximum_overlap_segments?: number;
}) {
  const m = input.manifest,
    overlap = input.maximum_overlap_segments ?? 1;
  if (
    !m.complete ||
    !m.anchors.length ||
    (await sha256(JSON.stringify(m))) !== input.manifest_hash ||
    !/^[a-f0-9]{64}$/.test(input.context_hash) ||
    ![
      input.context_tokens,
      input.output_tokens,
      input.prompt_overhead_tokens,
      overlap,
    ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    input.output_tokens < 1 ||
    overlap > 32 ||
    input.context_tokens <= input.output_tokens + input.prompt_overhead_tokens
  )
    throw new Error('INVALID_CHUNK_PLAN_INPUT');
  if (
    new Set(m.anchors.map((a) => a.segment_id)).size !== m.anchors.length ||
    m.anchors.some((a, index) => a.alias !== `s${index + 1}`)
  )
    throw new Error('INVALID_CHUNK_SOURCE');
  const plan: ChunkPlan = {
    version: 'chunk-plan:1',
    source_revision: m.source_revision,
    manifest_hash: input.manifest_hash,
    context_hash: input.context_hash,
    context_tokens: input.context_tokens,
    output_tokens: input.output_tokens,
    prompt_overhead_tokens: input.prompt_overhead_tokens,
    estimate_method: 'utf8-byte-upper-bound:1',
    chunks: [],
  };
  // Prefix byte counts preserve the exact JSON estimate without repeatedly
  // serializing every growing prefix of a large source (quadratic work).
  const rowBytes = [0],
    aliasBytes = [0];
  for (const [index, anchor] of m.anchors.entries()) {
    rowBytes.push(
      rowBytes[index]! + bytes({ segment_ref: 's1', text: anchor.text }),
    );
    aliasBytes.push(aliasBytes[index]! + String(index + 1).length - 1);
  }
  const estimate = (start: number, end: number) => {
    const count = end - start;
    return (
      input.prompt_overhead_tokens +
      2 +
      rowBytes[end]! -
      rowBytes[start]! +
      Math.max(0, count - 1) +
      aliasBytes[count]!
    );
  };
  let cursor = 0;
  while (cursor < m.anchors.length) {
    let start = Math.max(0, cursor - overlap);
    while (
      start < cursor &&
      estimate(start, cursor + 1) + input.output_tokens > input.context_tokens
    )
      start++;
    if (
      estimate(start, cursor + 1) + input.output_tokens >
      input.context_tokens
    )
      throw new Error('SOURCE_FRAGMENT_EXCEEDS_CONTEXT');
    let end = cursor + 1;
    while (
      end < m.anchors.length &&
      estimate(start, end + 1) + input.output_tokens <= input.context_tokens
    )
      end++;
    const assigned = m.anchors.slice(start, end);
    plan.chunks.push({
      chunk_index: plan.chunks.length,
      primary_start: cursor,
      primary_end: end,
      overlap_start: start,
      primary_segment_ids: m.anchors
        .slice(cursor, end)
        .map((a) => a.segment_id),
      overlap_segment_ids: m.anchors
        .slice(start, cursor)
        .map((a) => a.segment_id),
      aliases: assigned.map((a, i) => ({
        alias: `s${i + 1}`,
        segment_id: a.segment_id,
        global_alias: a.alias,
      })),
      estimated_input_tokens: estimate(start, end),
      source_start: Math.min(...assigned.map((a) => a.source_start)),
      source_end: Math.max(...assigned.map((a) => a.source_end)),
    });
    cursor = end;
  }
  const primary = plan.chunks.flatMap((c) => c.primary_segment_ids);
  if (
    JSON.stringify(primary) !==
    JSON.stringify(m.anchors.map((a) => a.segment_id))
  )
    throw new Error('CHUNK_COVERAGE_GAP');
  return { plan, plan_hash: await sha256(JSON.stringify(plan)) };
}
export async function verifyChunkPlan(
  plan: ChunkPlan,
  hash: string,
  manifest: Manifest,
  manifestHash: string,
) {
  if (
    (await sha256(JSON.stringify(plan))) !== hash ||
    plan.manifest_hash !== manifestHash ||
    plan.source_revision !== manifest.source_revision ||
    (await sha256(JSON.stringify(manifest))) !== manifestHash ||
    plan.version !== 'chunk-plan:1' ||
    plan.estimate_method !== 'utf8-byte-upper-bound:1' ||
    ![
      plan.context_tokens,
      plan.output_tokens,
      plan.prompt_overhead_tokens,
    ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    plan.output_tokens < 1 ||
    !manifest.complete
  )
    throw new Error('CHUNK_PLAN_MISMATCH');
  let cursor = 0;
  for (const chunk of plan.chunks) {
    const index = plan.chunks.indexOf(chunk);
    if (
      chunk.chunk_index !== index ||
      chunk.primary_start !== cursor ||
      chunk.primary_end <= cursor ||
      chunk.primary_end > manifest.anchors.length ||
      chunk.overlap_start < 0 ||
      chunk.overlap_start > cursor ||
      chunk.estimated_input_tokens + plan.output_tokens > plan.context_tokens
    )
      throw new Error('CHUNK_COVERAGE_GAP');
    const expected = manifest.anchors
      .slice(chunk.overlap_start, chunk.primary_end)
      .map((a, i) => ({
        alias: `s${i + 1}`,
        segment_id: a.segment_id,
        global_alias: a.alias,
      }));
    const assigned = manifest.anchors.slice(
      chunk.overlap_start,
      chunk.primary_end,
    );
    if (
      chunk.estimated_input_tokens !==
        plan.prompt_overhead_tokens +
          bytes(
            assigned.map((a, i) => ({
              segment_ref: `s${i + 1}`,
              text: a.text,
            })),
          ) ||
      chunk.source_start !== Math.min(...assigned.map((a) => a.source_start)) ||
      chunk.source_end !== Math.max(...assigned.map((a) => a.source_end))
    )
      throw new Error('INVALID_CHUNK_BUDGET');
    if (
      JSON.stringify(expected) !== JSON.stringify(chunk.aliases) ||
      JSON.stringify(chunk.primary_segment_ids) !==
        JSON.stringify(
          manifest.anchors
            .slice(cursor, chunk.primary_end)
            .map((a) => a.segment_id),
        ) ||
      JSON.stringify(chunk.overlap_segment_ids) !==
        JSON.stringify(
          manifest.anchors
            .slice(chunk.overlap_start, cursor)
            .map((a) => a.segment_id),
        )
    )
      throw new Error('INVALID_CHUNK_ALIAS_MAP');
    cursor = chunk.primary_end;
  }
  if (cursor !== manifest.anchors.length) throw new Error('CHUNK_COVERAGE_GAP');
}
