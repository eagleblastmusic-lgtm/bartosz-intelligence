import { sha256 } from '../../auth/crypto.js';
import type { normalizeTranscript } from '../../transcript/normalize.js';
import { validateEconomyCandidate } from '../repair/validate.js';
import { verifyChunkPlan, type ChunkPlan } from './plan.js';
type Manifest = Awaited<ReturnType<typeof normalizeTranscript>>['manifest'];
type Row = Record<string, unknown> & { segment_refs: string[] };
type WireModule =
  | 'summary_pl'
  | 'key_points'
  | 'entity_mentions'
  | 'tools'
  | 'claims'
  | 'stance'
  | 'predictions'
  | 'source_issues';
function exactIdentity(value: unknown): string {
  if (Array.isArray(value))
    return '[' + value.map(exactIdentity).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, row]) => JSON.stringify(key) + ':' + exactIdentity(row))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export async function mergeChunkOutputs(input: {
  plan: ChunkPlan;
  plan_hash: string;
  manifest: Manifest;
  manifest_hash: string;
  outputs: {
    chunk_index: number;
    raw: string;
    completion: 'OK' | 'REFUSED' | 'INCOMPLETE';
  }[];
}) {
  await verifyChunkPlan(
    input.plan,
    input.plan_hash,
    input.manifest,
    input.manifest_hash,
  );
  if (
    new Set(input.outputs.map((o) => o.chunk_index)).size !==
      input.outputs.length ||
    input.outputs.some((o) => !input.plan.chunks[o.chunk_index])
  )
    throw new Error('INVALID_CHUNK_DELIVERY');
  const merged: Record<WireModule, unknown[]> = {
    summary_pl: [],
    key_points: [],
    entity_mentions: [],
    tools: [],
    claims: [],
    stance: [],
    predictions: [],
    source_issues: [],
  };
  const globalEntities = new Map<string, number>();
  const accepted: number[] = [],
    missing: number[] = [],
    sectional: {
      chunk_index: number;
      summary_start: number;
      summary_end: number;
    }[] = [];
  const seen = new Map<string, Set<string>>();
  for (const chunk of input.plan.chunks) {
    const output = input.outputs.find(
      (o) => o.chunk_index === chunk.chunk_index,
    );
    if (!output) {
      missing.push(chunk.chunk_index);
      continue;
    }
    const aliases = new Map(
      chunk.aliases.map((a) => [a.alias, a.global_alias]),
    );
    const validated = await validateEconomyCandidate(
      output.raw,
      output.completion,
      new Set(aliases.keys()),
    );
    if (!validated.valid) throw new Error(validated.reason!);
    const wire = validated.value as Record<string, Row[]>;
    const remap = (row: Row) => ({
      ...row,
      segment_refs: row.segment_refs
        .map((a) => aliases.get(a)!)
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
    });
    const entityMap: number[] = [];
    for (const row of wire.entity_mentions!) {
      const mapped = remap(row),
        key = exactIdentity(mapped);
      let index = globalEntities.get(key);
      if (index === undefined) {
        index = merged.entity_mentions!.length;
        globalEntities.set(key, index);
        merged.entity_mentions!.push(mapped);
      }
      entityMap.push(index);
    }
    const indexRef = (ref: unknown) => {
      if (ref === null) return null;
      if (!Number.isSafeInteger(ref) || entityMap[ref as number] === undefined)
        throw new Error('FOREIGN_CHUNK_ENTITY_REF');
      return entityMap[ref as number]!;
    };
    const summaryStart = merged.summary_pl!.length;
    for (const module of [
      'summary_pl',
      'key_points',
      'tools',
      'claims',
      'stance',
      'predictions',
    ] as const) {
      const keys = seen.get(module) ?? new Set<string>();
      seen.set(module, keys);
      for (const row of wire[module]!) {
        const mapped: Record<string, unknown> = remap(row);
        if ('entity_refs' in mapped)
          mapped.entity_refs = (mapped.entity_refs as number[]).map(indexRef);
        for (const key of ['subject_ref', 'target_ref', 'entity_ref'])
          if (key in mapped) mapped[key] = indexRef(mapped[key]);
        const identity = exactIdentity(mapped);
        // Keep sectional summaries in source order. Dedup other rows only by
        // exact content, refs, attribution, qualifiers and type fields.
        if (module === 'summary_pl' || !keys.has(identity)) {
          merged[module]!.push(mapped);
          keys.add(identity);
        }
      }
    }
    sectional.push({
      chunk_index: chunk.chunk_index,
      summary_start: summaryStart,
      summary_end: merged.summary_pl!.length,
    });
    accepted.push(chunk.chunk_index);
  }
  const complete = missing.length === 0;
  if (complete) {
    const checked = await validateEconomyCandidate(
      JSON.stringify(merged),
      'OK',
      new Set(input.manifest.anchors.map((a) => a.alias)),
    );
    if (!checked.valid) throw new Error('MERGED_WIRE_INVALID');
  }
  return {
    wire: merged,
    wire_hash: await sha256(JSON.stringify(merged)),
    sectional_summaries: sectional,
    coverage: {
      plan_hash: input.plan_hash,
      expected: input.plan.chunks.length,
      accepted,
      missing,
      complete,
      accepted_primary_segment_ids: input.plan.chunks
        .filter((c) => accepted.includes(c.chunk_index))
        .flatMap((c) => c.primary_segment_ids),
    },
    status: complete ? ('COMPLETE' as const) : ('PARTIAL' as const),
    additional_model_requests: 0,
  };
}
