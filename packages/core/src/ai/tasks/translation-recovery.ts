import { sha256 } from '../../auth/crypto.js';
import { translation } from '../../registry/generated/validators.js';
import { mapTranslation, type TranslationPlan } from './translation.js';
type Mapped = Pick<
  Awaited<ReturnType<typeof mapTranslation>>,
  'canonical' | 'canonical_hash' | 'source_hash' | 'plan_hash'
> & { repair_report: unknown };
export interface TranslationPart {
  plan: TranslationPlan;
  mapped: Mapped;
}

export async function verifyTranslationPart(
  parent: TranslationPlan,
  part: TranslationPart,
) {
  const plan = part.plan.snapshot,
    canonical = part.mapped.canonical;
  if (
    (await sha256(JSON.stringify(part.plan.snapshot))) !== part.plan.hash ||
    !translation(canonical) ||
    canonical.status !== 'OK' ||
    (await sha256(JSON.stringify(canonical))) !== part.mapped.canonical_hash ||
    part.mapped.plan_hash !== part.plan.hash ||
    part.mapped.source_hash !== parent.snapshot.source_hash ||
    plan.source_artifact_id !== parent.snapshot.source_artifact_id ||
    plan.source_hash !== parent.snapshot.source_hash ||
    plan.manifest_hash !== parent.snapshot.manifest_hash ||
    plan.source_language !== parent.snapshot.source_language ||
    canonical.source_artifact_id !== plan.source_artifact_id ||
    canonical.source_language !== plan.source_language ||
    canonical.scope !== plan.scope
  )
    throw new Error('TRANSLATION_RECOVERY_PART_MISMATCH');
  let previous = -1;
  for (const [index, segment] of plan.segments.entries()) {
    const at = parent.snapshot.segments.findIndex(
        (s) => s.source_segment_id === segment.source_segment_id,
      ),
      original = parent.snapshot.segments[at];
    if (
      !original ||
      at <= previous ||
      segment.alias !== `s${index + 1}` ||
      JSON.stringify({ ...original, alias: segment.alias }) !==
        JSON.stringify(segment)
    )
      throw new Error('TRANSLATION_RECOVERY_PART_MISMATCH');
    previous = at;
  }
  const ids = new Set(plan.segments.map((s) => s.source_segment_id)),
    seen = new Set<string>();
  for (const row of canonical.translated_segments) {
    if (
      !ids.has(row.source_segment_id) ||
      seen.has(row.source_segment_id) ||
      !row.text_pl.trim()
    )
      throw new Error('TRANSLATION_RECOVERY_PART_MISMATCH');
    seen.add(row.source_segment_id);
  }
}

/** The retry changes the request scope, never the source text, timestamps or parent scope. */
export async function missingTranslationPlan(
  parent: TranslationPlan,
  previous: Mapped,
) {
  if ((await sha256(JSON.stringify(parent.snapshot))) !== parent.hash)
    throw new Error('TRANSLATION_PLAN_MISMATCH');
  await verifyTranslationPart(parent, { plan: parent, mapped: previous });
  const present = new Set(
    previous.canonical.translated_segments.map((s) => s.source_segment_id),
  );
  const missing = parent.snapshot.segments.filter(
    (s) => !present.has(s.source_segment_id),
  );
  if (!missing.length) throw new Error('TRANSLATION_RECOVERY_NOT_NEEDED');
  const snapshot = {
    ...structuredClone(parent.snapshot),
    scope: 'CHUNK' as const,
    segments: missing.map((s, index) => ({ ...s, alias: `s${index + 1}` })),
  };
  return { snapshot, hash: await sha256(JSON.stringify(snapshot)) };
}

/** A deterministic composition of validated translations; it performs no model call. */
export async function composeTranslations(
  parent: TranslationPlan,
  parts: readonly TranslationPart[],
) {
  if ((await sha256(JSON.stringify(parent.snapshot))) !== parent.hash)
    throw new Error('TRANSLATION_PLAN_MISMATCH');
  if (!parts.length || parts.length > 128)
    throw new Error('INVALID_TRANSLATION_PART_COUNT');
  const rows = new Map<
      string,
      Mapped['canonical']['translated_segments'][number]
    >(),
    limitations = new Set<string>();
  for (const part of parts) {
    await verifyTranslationPart(parent, part);
    for (const row of part.mapped.canonical.translated_segments) {
      if (rows.has(row.source_segment_id))
        throw new Error('DUPLICATE_TRANSLATION_RECOVERY_SEGMENT');
      rows.set(row.source_segment_id, row);
    }
    for (const limitation of part.mapped.canonical.limitations_pl)
      limitations.add(limitation);
  }
  const mapped = await mapTranslation(parent, {
    status: 'OK',
    raw_output: JSON.stringify({
      status: 'OK',
      translated_segments: parent.snapshot.segments.flatMap((s) => {
        const row = rows.get(s.source_segment_id);
        return row
          ? [{ segment_ref: s.alias, text_pl: row.text_pl, issues: row.issues }]
          : [];
      }),
      limitations_pl: [...limitations].sort(),
    }),
  });
  return {
    ...mapped,
    repair_report: {
      result: 'DETERMINISTIC_TRANSLATION_MERGE' as const,
      parts: [...parts]
        .sort((a, b) =>
          a.mapped.canonical_hash < b.mapped.canonical_hash
            ? -1
            : a.mapped.canonical_hash > b.mapped.canonical_hash
              ? 1
              : 0,
        )
        .map((p) => ({
          plan_hash: p.plan.hash,
          canonical_hash: p.mapped.canonical_hash,
          repair_report: p.mapped.repair_report,
        })),
    },
  };
}
