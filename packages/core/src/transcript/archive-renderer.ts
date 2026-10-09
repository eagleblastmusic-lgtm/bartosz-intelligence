import { sha256 } from '../auth/crypto.js';
import type { normalizeTranscript } from './normalize.js';
import type { TranscriptSegment } from '../../../contracts/src/transcript.js';

export interface TranscriptArchiveDescriptor {
  video_id: string;
  title: string;
  channel: string;
  url: string;
  published_at: string | null;
  discovered_at: string;
  language_code: string;
  track_kind: 'MANUAL' | 'GENERATED';
  upstream_track_id: string;
  provider_id: string;
  provider_version: string;
  source_status: 'AVAILABLE_FULL' | 'PARTIAL' | 'UNKNOWN';
  original_language_confirmed: boolean;
  retrieved_at: string | null;
  timestamp_precision: string;
  missing_ranges: { start_ms: number | null; end_ms: number | null }[];
  warnings: string[];
}
type LegacyManifest = Awaited<
  ReturnType<typeof normalizeTranscript>
>['manifest'];
export type TranscriptArchiveManifest = Pick<
  LegacyManifest,
  'source_revision' | 'source_text_hash' | 'offset_unit' | 'join_separator'
> & {
  coverage: Pick<
    LegacyManifest['coverage'][number],
    'upstream_index' | 'raw_start' | 'raw_end' | 'start_ms' | 'end_ms'
  >[];
};
/** Captured before AI normalization; no normalized text or per-character maps. */
export function captionArchiveCoverage(
  hash: string,
  cues: readonly TranscriptSegment[],
) {
  if (!/^[a-f0-9]{64}$/.test(hash) || !cues.length)
    throw new Error('TRANSCRIPT_ARCHIVE_SOURCE_MISMATCH');
  let offset = 0;
  const coverage = cues.map((cue) => {
    const row = {
      upstream_index: cue.upstream_index,
      raw_start: offset,
      raw_end: offset + cue.text.length,
      start_ms: cue.start_ms,
      end_ms: cue.end_ms,
    };
    offset = row.raw_end + 1;
    return row;
  });
  return {
    version: 'caption-coverage:1',
    source_revision: hash,
    source_text_hash: hash,
    offset_unit: 'UTF16_CODE_UNIT' as const,
    join_separator: '\n',
    coverage,
  } satisfies TranscriptArchiveManifest & { version: string };
}
const label = (value: string) => JSON.stringify(value);
const timestamp = (value: number | null) => {
  if (value === null) return 'nieznany';
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('TRANSCRIPT_ARCHIVE_INVALID_COVERAGE');
  return `${Math.floor(value / 3600000)
    .toString()
    .padStart(
      2,
      '0',
    )}:${Math.floor(value / 60000) % 60 < 10 ? '0' : ''}${Math.floor(value / 60000) % 60}:${(Math.floor(value / 1000) % 60).toString().padStart(2, '0')}.${(value % 1000).toString().padStart(3, '0')}`;
};

/** No normalization, deduplication, truncation, translation or AI. Raw UTF-16
 * coverage slices reconstruct every acquired cue, including empty/duplicates. */
export async function renderTranscriptArchive(input: {
  descriptor: TranscriptArchiveDescriptor;
  source_text: string;
  source_hash: string;
  manifest: TranscriptArchiveManifest;
}) {
  const { descriptor: d, source_text: source, manifest: m } = input;
  if (
    (await sha256(source)) !== input.source_hash ||
    m.source_revision !== input.source_hash ||
    m.source_text_hash !== input.source_hash ||
    m.offset_unit !== 'UTF16_CODE_UNIT' ||
    m.join_separator !== '\n' ||
    !Array.isArray(m.coverage) ||
    !m.coverage.length ||
    !['MANUAL', 'GENERATED'].includes(d.track_kind) ||
    !['AVAILABLE_FULL', 'PARTIAL', 'UNKNOWN'].includes(d.source_status)
  )
    throw new Error('TRANSCRIPT_ARCHIVE_SOURCE_MISMATCH');
  const cues: string[] = [],
    blocks: string[] = [];
  let offset = 0;
  const indices = new Set<number>();
  for (const cue of m.coverage) {
    if (
      cue.raw_start !== offset ||
      !Number.isSafeInteger(cue.raw_end) ||
      cue.raw_end < cue.raw_start ||
      cue.raw_end > source.length ||
      !Number.isSafeInteger(cue.upstream_index) ||
      cue.upstream_index < 0 ||
      indices.has(cue.upstream_index) ||
      (cue.start_ms !== null &&
        cue.end_ms !== null &&
        cue.end_ms < cue.start_ms)
    )
      throw new Error('TRANSCRIPT_ARCHIVE_INVALID_COVERAGE');
    indices.add(cue.upstream_index);
    const text = source.slice(cue.raw_start, cue.raw_end);
    cues.push(text);
    // A longer fence escapes even a malicious caption containing Markdown
    // fences while preserving every source character within the code block.
    const longest = Math.max(
      2,
      ...[...text.matchAll(/`+/g)].map((row) => row[0].length),
    );
    const fence = '`'.repeat(longest + 1);
    blocks.push(
      `### [${timestamp(cue.start_ms)} → ${timestamp(cue.end_ms)}] — cue ${cue.upstream_index}\n\n${fence}text\n${text}\n${fence}`,
    );
    offset = cue.raw_end + 1;
  }
  if (cues.join('\n') !== source || offset !== source.length + 1)
    throw new Error('TRANSCRIPT_ARCHIVE_INVALID_COVERAGE');
  const status =
    d.source_status === 'PARTIAL' || d.missing_ranges.length
      ? 'NIEPEŁNA — zachowano cały pozyskany fragment; braków nie uzupełniono.'
      : d.source_status === 'AVAILABLE_FULL'
        ? 'Pełny dostępny materiał napisów. Nie jest to gwarancja, że napisy obejmują każdą wypowiedź w filmie.'
        : 'Kompletność źródła nieustalona; zachowano cały dostępny materiał.';
  const markdown = [
    '# Pełna dostępna transkrypcja',
    `Tytuł: ${label(d.title)}`,
    `Kanał: ${label(d.channel)}`,
    `Video ID: ${label(d.video_id)}`,
    `URL: ${label(d.url)}`,
    `Język źródła: ${label(d.language_code)}; oryginalny język potwierdzony: ${d.original_language_confirmed ? 'tak' : 'nieustalony'}.`,
    `Napisy: ${d.track_kind === 'MANUAL' ? 'ręczne' : 'automatyczne'}; track: ${label(d.upstream_track_id)}.`,
    `Dostawca: ${label(d.provider_id)}; wersja: ${label(d.provider_version)}.`,
    `Publikacja: ${label(d.published_at ?? 'nieustalona')}; wykrycie: ${label(d.discovered_at)}; pozyskanie: ${label(d.retrieved_at ?? 'nieustalone')}.`,
    `Status: ${status}`,
    `Precyzja timestampów: ${label(d.timestamp_precision)}; nieznane timestampy pozostają nieznane.`,
    `Brakujące zakresy źródła: ${JSON.stringify(d.missing_ranges)}.`,
    `Ostrzeżenia: ${JSON.stringify(d.warnings)}.`,
    `SHA-256 pozyskanego tekstu (kolejne cue połączone LF): ${input.source_hash}`,
    'Bez tłumaczenia, streszczania, parafrazy i usuwania powtórzeń. Oznaczenia/markup występujące w tekście źródłowym pozostają dosłowne.',
    '',
    ...blocks,
    '',
  ].join('\n\n');
  const byte_count = new TextEncoder().encode(markdown).length;
  if (byte_count > 32 * 1024 * 1024)
    throw new Error('TRANSCRIPT_ARCHIVE_TOO_LARGE');
  return { markdown, content_hash: await sha256(markdown), byte_count };
}
