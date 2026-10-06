import { sha256 } from '../../auth/crypto.js';
import {
  prepareEvidenceSource,
  type EvidenceInput,
} from '../enrichment/evidence.js';
import { parseWithDeterministicRepair } from '../repair/deterministic.js';
import {
  translation_wire,
  translation,
  validator_schema_hashes,
} from '../../registry/generated/validators.js';
import type { AIResponse } from '../../../../contracts/src/ai.js';

export type TranslationSource = Omit<
  EvidenceInput,
  'segment_refs' | 'helper'
> & { source_language: string };
export type TranslationScope = 'FULL' | 'SELECTED_SEGMENTS' | 'CHUNK';

/** The caller obtains selected IDs from accepted Evidence, never from another AI pass. */
export async function translationPlan(
  source: TranslationSource,
  scope: TranslationScope,
  selectedIds?: readonly string[],
) {
  const frozen = structuredClone(source);
  const evidence = await prepareEvidenceSource(frozen);
  if (!frozen.source_language.trim() || !frozen.manifest.anchors.length)
    throw new Error('INSUFFICIENT_TRANSLATION_SOURCE');
  if (scope === 'FULL' ? selectedIds !== undefined : !selectedIds?.length)
    throw new Error('INVALID_TRANSLATION_SCOPE');
  const ids = new Set(
    selectedIds ?? frozen.manifest.anchors.map((a) => a.segment_id),
  );
  if (selectedIds && ids.size !== selectedIds.length)
    throw new Error('DUPLICATE_TRANSLATION_SEGMENT');
  const anchors = frozen.manifest.anchors.filter((a) => ids.has(a.segment_id));
  if (anchors.length !== ids.size)
    throw new Error('FOREIGN_TRANSLATION_SEGMENT');
  // Verify every selected timestamp/offset using the existing source contract.
  for (const anchor of anchors) await evidence([anchor.alias]);
  const snapshot = {
    version: 'translation-plan:1' as const,
    source_artifact_id: frozen.source_artifact_id,
    source_hash: frozen.manifest.source_text_hash,
    manifest_hash: frozen.manifest_hash,
    source_language: frozen.source_language,
    scope,
    segments: anchors.map((a, i) => ({
      alias: `s${i + 1}`,
      source_segment_id: a.segment_id,
      text: a.text,
      source_start: a.source_start,
      source_end: a.source_end,
      start_ms: a.start_ms,
      end_ms: a.end_ms,
      timestamp_precision: a.timestamp_precision,
    })),
  };
  return { snapshot, hash: await sha256(JSON.stringify(snapshot)) };
}
export type TranslationPlan = Awaited<ReturnType<typeof translationPlan>>;

/** Partial output stays diagnostic. It cannot replace source or become a complete helper. */
export async function mapTranslation(
  plan: TranslationPlan,
  response: Pick<AIResponse, 'status' | 'raw_output'>,
) {
  if ((await sha256(JSON.stringify(plan.snapshot))) !== plan.hash)
    throw new Error('TRANSLATION_PLAN_MISMATCH');
  if (response.status !== 'OK' || response.raw_output === null)
    throw new Error('TRANSLATION_RESPONSE_NOT_COMPLETE');
  const parsed = await parseWithDeterministicRepair(response.raw_output);
  if (!translation_wire(parsed.value))
    throw new Error('INVALID_TRANSLATION_WIRE');
  const wire = parsed.value as {
    status: 'OK' | 'INSUFFICIENT_SOURCE' | 'REFUSED';
    translated_segments: {
      segment_ref: string;
      text_pl: string;
      issues: string[];
    }[];
    limitations_pl: string[];
  };
  const aliases = new Map(plan.snapshot.segments.map((s) => [s.alias, s]));
  const seen = new Set<string>();
  for (const row of wire.translated_segments) {
    if (!aliases.has(row.segment_ref))
      throw new Error('FOREIGN_TRANSLATION_REF');
    if (seen.has(row.segment_ref)) throw new Error('DUPLICATE_TRANSLATION_REF');
    if (!row.text_pl.trim()) throw new Error('EMPTY_TRANSLATION_SEGMENT');
    seen.add(row.segment_ref);
  }
  const ordered = plan.snapshot.segments.filter((s) => seen.has(s.alias));
  if (
    wire.translated_segments.some(
      (row, i) => row.segment_ref !== ordered[i]?.alias,
    )
  )
    throw new Error('TRANSLATION_ORDER_MISMATCH');
  if (wire.status !== 'OK' && wire.translated_segments.length)
    throw new Error('TRANSLATION_STATUS_MISMATCH');
  const missing = plan.snapshot.segments
    .filter((s) => !seen.has(s.alias))
    .map((s) => s.source_segment_id);
  const complete = wire.status === 'OK' && missing.length === 0;
  const canonical = {
    schema_version: '1.0' as const,
    status: wire.status,
    source_artifact_id: plan.snapshot.source_artifact_id,
    source_language: plan.snapshot.source_language,
    target_language: 'pl' as const,
    scope: plan.snapshot.scope,
    translated_segments: wire.translated_segments.map((row) => ({
      source_segment_id: aliases.get(row.segment_ref)!.source_segment_id,
      text_pl: row.text_pl,
      issues: row.issues,
    })),
    limitations_pl: wire.limitations_pl,
  };
  if (!translation(canonical)) throw new Error('INVALID_TRANSLATION_CANONICAL');
  // Times and coverage are independent runtime metadata, outside exact canonical 1.0.
  let offset = 0;
  const mappings = canonical.translated_segments.map((row) => {
    const source = plan.snapshot.segments.find(
      (s) => s.source_segment_id === row.source_segment_id,
    )!;
    const start = offset;
    offset += row.text_pl.length + 1;
    return {
      segment_ids: [row.source_segment_id],
      start,
      end: offset - 1,
      start_ms: source.start_ms,
      end_ms: source.end_ms,
      timestamp_precision: source.timestamp_precision,
    };
  });
  const helperText = canonical.translated_segments
    .map((s) => s.text_pl)
    .join('\n');
  return {
    canonical,
    canonical_hash: await sha256(JSON.stringify(canonical)),
    helper_text: helperText,
    helper_hash: await sha256(helperText),
    mappings,
    mapping_hash: await sha256(JSON.stringify(mappings)),
    source_hash: plan.snapshot.source_hash,
    plan_hash: plan.hash,
    coverage: {
      expected: plan.snapshot.segments.length,
      translated: canonical.translated_segments.length,
      missing_segment_ids: missing,
      complete,
    },
    state: complete ? ('COMPLETE' as const) : ('PARTIAL' as const),
    semantic_verification: 'NOT_ASSERTED' as const,
    repair_report: parsed.report,
    wire_schema_hash:
      validator_schema_hashes['urn:bartosz:schema:translation-wire:1.0'],
  };
}
