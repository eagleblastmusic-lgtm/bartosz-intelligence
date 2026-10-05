import { decodeHTMLStrict } from 'entities';
import { sha256 } from '../auth/crypto.js';
import type {
  TranscriptSegment,
  TimestampPrecision,
} from '../../../contracts/src/transcript.js';

export const normalizerVersion = 'source-normalizer:1';
export interface OffsetSpan {
  normalized_start: number;
  normalized_end: number;
  raw_start: number;
  raw_end: number;
}
interface Unit {
  text: string;
  start: number;
  end: number;
}
export function normalizeCue(raw: string) {
  const units: Unit[] = [];
  // Strip only caption markup with known syntax. Encoded literal angle brackets
  // are decoded afterwards, so quoted markup is preserved as source content.
  const token =
    /<\/?(?:b|i|u|ruby|rt)(?:\s[^<>]*)?>|<\/?(?:c|v|lang)(?:[.\s][^<>]*)?>|<br\s*\/?\s*>|&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);|\r\n|[\s\S]/giy;
  let match: RegExpExecArray | null;
  while ((match = token.exec(raw))) {
    const value = match[0],
      start = match.index,
      end = start + value.length;
    if (value.startsWith('<') && value.length > 1) {
      if (/^<br/i.test(value)) units.push({ text: '\n', start, end });
      continue;
    }
    units.push({
      text: value.startsWith('&')
        ? decodeHTMLStrict(value)
        : value === '\r\n' || value === '\r'
          ? '\n'
          : value,
      start,
      end,
    });
  }
  const decoded = units.map((unit) => unit.text).join('');
  const offsets: { unit: Unit; from: number; to: number }[] = [];
  let cursor = 0;
  for (const unit of units) {
    offsets.push({ unit, from: cursor, to: cursor + unit.text.length });
    cursor += unit.text.length;
  }
  const normalized: Unit[] = [];
  let scan = 0;
  for (const grapheme of new Intl.Segmenter('und', {
    granularity: 'grapheme',
  }).segment(decoded)) {
    const start = grapheme.index,
      end = start + grapheme.segment.length;
    while (scan < offsets.length && offsets[scan]!.to <= start) scan++;
    let last = scan;
    while (last + 1 < offsets.length && offsets[last + 1]!.from < end) last++;
    const text = grapheme.segment.normalize('NFC');
    const mapped = {
      text,
      start: offsets[scan]!.unit.start,
      end: offsets[last]!.unit.end,
    };
    if (/^\s+$/u.test(text)) {
      mapped.text = text.includes('\n') ? '\n' : ' ';
      const previous = normalized.at(-1);
      if (previous && /^\s+$/.test(previous.text)) {
        previous.text =
          previous.text === '\n' || mapped.text === '\n' ? '\n' : ' ';
        previous.end = mapped.end;
        continue;
      }
    }
    normalized.push(mapped);
  }
  while (normalized.length && /^\s+$/.test(normalized[0]!.text))
    normalized.shift();
  while (normalized.length && /^\s+$/.test(normalized.at(-1)!.text))
    normalized.pop();
  const map: OffsetSpan[] = [];
  let length = 0;
  for (const unit of normalized) {
    map.push({
      normalized_start: length,
      normalized_end: length + unit.text.length,
      raw_start: unit.start,
      raw_end: unit.end,
    });
    length += unit.text.length;
  }
  return { text: normalized.map((unit) => unit.text).join(''), offsets: map };
}

export interface SourceAnchor {
  segment_id: string;
  alias: string;
  upstream_index: number;
  parent_id: string;
  text: string;
  source_start: number;
  source_end: number;
  offsets: OffsetSpan[];
  start_ms: number | null;
  end_ms: number | null;
  timestamp_precision: TimestampPrecision;
}
export async function normalizeTranscript(
  artifactRevision: string,
  cues: readonly TranscriptSegment[],
  precision: TimestampPrecision,
  maximumBytes = 8192,
) {
  if (
    !/^[a-f0-9]{64}$/.test(artifactRevision) ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 8 ||
    maximumBytes > 32768
  )
    throw new Error('INVALID_NORMALIZATION_INPUT');
  const seen = new Set<number>(),
    anchors: SourceAnchor[] = [],
    coverage: {
      upstream_index: number;
      segment_ids: string[];
      empty: boolean;
      raw_start: number;
      raw_end: number;
      start_ms: number | null;
      end_ms: number | null;
      duplicate_of: number | null;
    }[] = [];
  const sourceText = cues.map((cue) => cue.text).join('\n');
  let sourceOffset = 0;
  let previous: {
    text: string;
    start: number | null;
    end: number | null;
    index: number;
    ids: string[];
  } | null = null;
  for (const cue of cues) {
    if (
      !Number.isSafeInteger(cue.upstream_index) ||
      cue.upstream_index < 0 ||
      seen.has(cue.upstream_index) ||
      typeof cue.text !== 'string' ||
      (cue.start_ms !== null &&
        (!Number.isSafeInteger(cue.start_ms) || cue.start_ms < 0)) ||
      (cue.end_ms !== null &&
        (!Number.isSafeInteger(cue.end_ms) || cue.end_ms < 0)) ||
      (cue.start_ms !== null &&
        cue.end_ms !== null &&
        cue.end_ms < cue.start_ms)
    )
      throw new Error('INVALID_SOURCE_CUE');
    seen.add(cue.upstream_index);
    const normalized = normalizeCue(cue.text),
      parent = await sha256(
        JSON.stringify([
          artifactRevision,
          cue.upstream_index,
          cue.text,
          cue.start_ms,
          cue.end_ms,
        ]),
      );
    // Only an identical adjacent cue with the exact same interval is collapsed.
    // Other rolling overlaps and repeated speaker text retain their own anchors.
    const duplicate =
      normalized.text.length > 0 &&
      previous &&
      previous.text === normalized.text &&
      cue.start_ms !== null &&
      cue.end_ms !== null &&
      previous.start === cue.start_ms &&
      previous.end === cue.end_ms;
    if (duplicate && previous) {
      coverage.push({
        upstream_index: cue.upstream_index,
        segment_ids: [...previous.ids],
        empty: false,
        raw_start: sourceOffset,
        raw_end: sourceOffset + cue.text.length,
        start_ms: cue.start_ms,
        end_ms: cue.end_ms,
        duplicate_of: previous.index,
      });
      sourceOffset += cue.text.length + 1;
      continue;
    }
    const ids: string[] = [];
    let first = 0;
    while (first < normalized.offsets.length) {
      let last = first,
        bytes = 0;
      while (last < normalized.offsets.length) {
        const span = normalized.offsets[last]!,
          count = new TextEncoder().encode(
            normalized.text.slice(span.normalized_start, span.normalized_end),
          ).length;
        if (count > maximumBytes) throw new Error('GRAPHEME_TOO_LARGE');
        if (bytes + count > maximumBytes) break;
        bytes += count;
        last++;
      }
      const begin = normalized.offsets[first]!,
        end = normalized.offsets[last - 1]!,
        text = normalized.text.slice(
          begin.normalized_start,
          end.normalized_end,
        );
      const id = await sha256(
        JSON.stringify([
          normalizerVersion,
          parent,
          begin.raw_start,
          end.raw_end,
        ]),
      );
      anchors.push({
        segment_id: id,
        alias: `s${anchors.length + 1}`,
        upstream_index: cue.upstream_index,
        parent_id: parent,
        text,
        source_start: sourceOffset + begin.raw_start,
        source_end: sourceOffset + end.raw_end,
        offsets: normalized.offsets
          .slice(first, last)
          .map((span) => ({
            normalized_start: span.normalized_start - begin.normalized_start,
            normalized_end: span.normalized_end - begin.normalized_start,
            raw_start: span.raw_start + sourceOffset,
            raw_end: span.raw_end + sourceOffset,
          })),
        start_ms: cue.start_ms,
        end_ms: cue.end_ms,
        timestamp_precision:
          cue.start_ms !== null && cue.end_ms !== null ? precision : 'NONE',
      });
      ids.push(id);
      first = last;
    }
    coverage.push({
      upstream_index: cue.upstream_index,
      segment_ids: ids,
      empty: normalized.text.length === 0,
      raw_start: sourceOffset,
      raw_end: sourceOffset + cue.text.length,
      start_ms: cue.start_ms,
      end_ms: cue.end_ms,
      duplicate_of: null,
    });
    previous = {
      text: normalized.text,
      start: cue.start_ms,
      end: cue.end_ms,
      index: cue.upstream_index,
      ids,
    };
    sourceOffset += cue.text.length + 1;
  }
  const manifest = {
    normalizer_version: normalizerVersion,
    source_revision: artifactRevision,
    source_text_hash: await sha256(sourceText),
    offset_unit: 'UTF16_CODE_UNIT' as const,
    source_text_version: 'decoded-cue-text:1',
    join_separator: '\n',
    anchors,
    coverage,
    complete: true,
  };
  return {
    source_text: sourceText,
    manifest,
    manifest_hash: await sha256(JSON.stringify(manifest)),
  };
}
