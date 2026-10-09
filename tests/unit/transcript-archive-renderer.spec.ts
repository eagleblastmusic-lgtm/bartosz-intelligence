import { it, expect } from 'vitest';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import {
  renderTranscriptArchive,
  captionArchiveCoverage,
  type TranscriptArchiveDescriptor,
} from '../../packages/core/src/transcript/archive-renderer.js';
const descriptor: TranscriptArchiveDescriptor = {
  video_id: 'abcdefghijk',
  title: 'Film',
  channel: 'Kanał',
  url: 'https://www.youtube.com/watch?v=abcdefghijk',
  published_at: null,
  discovered_at: '2026-10-09T12:00:00Z',
  language_code: 'en',
  track_kind: 'MANUAL',
  upstream_track_id: 'track',
  provider_id: 'local_ytdlp',
  provider_version: 'fixture',
  source_status: 'AVAILABLE_FULL',
  original_language_confirmed: true,
  retrieved_at: null,
  timestamp_precision: 'CUE',
  missing_ranges: [],
  warnings: [],
};
it('preserves all exact acquired cues, Unicode, markup, repetitions, blanks and unknown timestamps', async () => {
  const texts = [
    '<b>Hello</b> &amp;   😀\r\nraw',
    '',
    'repeat',
    'repeat',
    '```\n# caption\n````',
  ];
  const source = texts.join('\n'),
    hash = await sha256(source);
  const normalized = await normalizeTranscript(
    hash,
    texts.map((text, index) => ({
      upstream_index: index,
      text,
      start_ms: index === 0 ? null : 1234,
      end_ms: index === 0 ? null : 4567,
      speaker_label: null,
    })),
    'CUE',
  );
  const report = await renderTranscriptArchive({
    descriptor,
    source_text: source,
    source_hash: hash,
    manifest: normalized.manifest,
  });
  const compact = captionArchiveCoverage(
    hash,
    texts.map((text, index) => ({
      upstream_index: index,
      text,
      start_ms: index === 0 ? null : 1234,
      end_ms: index === 0 ? null : 4567,
      speaker_label: null,
    })),
  );
  const compactReport = await renderTranscriptArchive({
    descriptor,
    source_text: source,
    source_hash: hash,
    manifest: compact,
  });
  expect(compactReport).toEqual(report);
  expect(JSON.stringify(compact)).not.toContain('anchors');
  expect(JSON.stringify(compact).length).toBeLessThan(
    JSON.stringify(normalized.manifest).length,
  );
  for (const text of texts) expect(report.markdown).toContain(text);
  expect(report.markdown.match(/\nrepeat\n/g)).toHaveLength(2);
  expect(report.markdown).toContain('[nieznany → nieznany]');
  expect(report.markdown).toContain('[00:00:01.234 → 00:00:04.567]');
  expect(report.markdown).toContain('`````text\n```\n# caption\n````\n`````');
  expect(report.content_hash).toBe(await sha256(report.markdown));
  expect(report.byte_count).toBe(Buffer.byteLength(report.markdown));
  const partial = await renderTranscriptArchive({
    descriptor: {
      ...descriptor,
      track_kind: 'GENERATED',
      source_status: 'PARTIAL',
      missing_ranges: [{ start_ms: 5000, end_ms: null }],
    },
    source_text: source,
    source_hash: hash,
    manifest: normalized.manifest,
  });
  expect(partial.markdown).toContain('NIEPEŁNA');
  expect(partial.markdown).toContain('automatyczne');
  expect(partial.markdown).not.toContain('Status: Pełny dostępny');
});
it('rejects missing/overlapping coverage or wrong source hash rather than shortening the transcript', async () => {
  const source = 'first\nlast',
    hash = await sha256(source),
    n = await normalizeTranscript(
      hash,
      [
        {
          upstream_index: 0,
          text: 'first',
          start_ms: 0,
          end_ms: 1,
          speaker_label: null,
        },
        {
          upstream_index: 1,
          text: 'last',
          start_ms: 2,
          end_ms: 3,
          speaker_label: null,
        },
      ],
      'CUE',
    );
  const input = {
    descriptor,
    source_text: source,
    source_hash: hash,
    manifest: n.manifest,
  };
  await expect(
    renderTranscriptArchive({ ...input, source_hash: '0'.repeat(64) }),
  ).rejects.toThrow('SOURCE_MISMATCH');
  const missing = structuredClone(n.manifest);
  missing.coverage.pop();
  await expect(
    renderTranscriptArchive({ ...input, manifest: missing }),
  ).rejects.toThrow('INVALID_COVERAGE');
  const overlap = structuredClone(n.manifest);
  overlap.coverage[1]!.raw_start--;
  await expect(
    renderTranscriptArchive({ ...input, manifest: overlap }),
  ).rejects.toThrow('INVALID_COVERAGE');
});
