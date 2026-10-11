import type { SourceAnchor } from '../transcript/normalize.js';
import { analysisQualityPolicy } from '../registry/analysis-quality.js';

interface Row {
  text_pl?: string;
  context_pl?: string;
  label?: string;
  explanation_pl?: string;
  segment_refs?: string[];
  attribution?: string;
  qualifiers?: string[];
  horizon?: string | null;
}
export interface QualityFinding {
  code: string;
  module: string;
  index: number;
}
const uncertainSource =
  /\b(?:i\s+(?:i\s+)?think|maybe|might|perhaps|possibly)\b|\b(?:approximately|around|about)\s+\d|\b(?:sądzę|uważam|może|około|prawdopodobnie)\b/iu;
const uncertainPolish =
  /\b(?:sądzi|uważa|przypuszcza|ocenia|potencjał|może|mogą|mogł|jeśli|około|prawdopodob|według|zdaniem)|I\s+(?:I\s+)?think/iu;
export function assessAnalysisQuality(
  wire: Record<string, Row[]>,
  anchors: readonly SourceAnchor[],
  options: { coverage?: boolean } = {},
) {
  const findings: QualityFinding[] = [];
  const byAlias = new Map(anchors.map((a) => [a.alias, a]));
  const add = (code: string, module: string, index: number) =>
    findings.push({ code, module, index });
  for (const [module, rows] of Object.entries(wire)) {
    if (module === 'source_issues') continue;
    for (const [index, row] of rows.entries()) {
      const text =
        row.text_pl ?? row.context_pl ?? row.label ?? row.explanation_pl;
      if (
        typeof text !== 'string' ||
        !text.trim() ||
        /^(?:undefined|null|NaN|\[object Object\])$/u.test(text.trim())
      )
        add('BROKEN_CONTENT', module, index);
      if (!row.segment_refs) continue; // relations have validated typed ends
      if (row.segment_refs.some((ref) => !byAlias.has(ref))) {
        add('FOREIGN_SOURCE_REF', module, index);
        continue;
      }
      const quote = row.segment_refs
        .map((ref) => byAlias.get(ref)!.text)
        .join(' ');
      if (row.attribution === 'UNCLEAR')
        add('UNRESOLVED_ATTRIBUTION', module, index);
      const output = [
        text ?? '',
        ...(row.qualifiers ?? []),
        row.horizon ?? '',
      ].join(' ');
      // Conservative detectors, not a claim of general semantic verification.
      if (module !== 'entity_mentions' && module !== 'tools') {
        if (uncertainSource.test(quote) && !uncertainPolish.test(output))
          add('SOURCE_QUALIFIER_LOST', module, index);
        if (
          row.attribution &&
          /\bif\b|\bjeśli\b/iu.test(quote) &&
          !/\b(?:jeśli|gdy|przy|warunk|zależy)/iu.test(output)
        )
          add('SOURCE_CONDITION_LOST', module, index);
        for (const match of (text ?? '').matchAll(
          /\bprzed\s+(?:rokiem\s+)?((?:19|20|21)\d{2})\b/giu,
        )) {
          const before = new RegExp(
            `(?:before|prior to|przed)\\s+(?:the year\\s+|rokiem\\s+)?${match[1]}`,
            'iu',
          );
          if (!before.test(quote)) add('DEADLINE_STRENGTHENED', module, index);
        }
      }
    }
  }
  const narrative = [...(wire.summary_pl ?? []), ...(wire.key_points ?? [])];
  const substantive = anchors.filter((a) => a.text.trim().length > 8);
  const start = substantive[0]?.source_start ?? 0;
  const end = substantive.at(-1)?.source_end ?? start;
  const windows: { index: number; covered: boolean }[] = [];
  // Text-position windows also work for captions without trustworthy timestamps.
  // Sparse windows (outro/music) do not force fabricated summary content.
  if (
    options.coverage !== false &&
    narrative.length &&
    substantive.length >= 20 &&
    end - start >= 4000
  ) {
    const bins = Array.from({ length: 8 }, () => ({
      chars: 0,
      covered: false,
    }));
    const bin = (a: SourceAnchor) =>
      Math.min(7, Math.floor((8 * (a.source_start - start)) / (end - start)));
    for (const anchor of substantive)
      bins[bin(anchor)]!.chars += anchor.text.length;
    for (const row of narrative)
      for (const ref of row.segment_refs ?? []) {
        const anchor = byAlias.get(ref);
        if (anchor && anchor.source_start >= start && anchor.source_start < end)
          bins[bin(anchor)]!.covered = true;
      }
    bins.forEach((value, index) => {
      if (value.chars < 200) return;
      windows.push({ index, covered: value.covered });
      if (!value.covered) add('NARRATIVE_COVERAGE_GAP', 'summary_pl', index);
    });
  }
  return {
    version: analysisQualityPolicy.version,
    status: findings.length ? ('REVIEW_REQUIRED' as const) : ('PASS' as const),
    findings,
    coverage_windows: windows,
    semantic_verification: 'NOT_ASSERTED' as const,
  };
}
