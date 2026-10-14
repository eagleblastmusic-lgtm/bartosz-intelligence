import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  compareFullSource,
  qualifySource,
} from '../../tools/deployment/oracle/qualify-source.js';
import { YtdlpTranscriptProvider } from '../../apps/executor/src/providers/ytdlp.js';

it('Oracle qualification compares every repeated cue and timestamp against a complete reference', async () => {
  const segments = [0, 1, 2].map((index) => ({
    upstream_index: index,
    start_ms: index * 1000,
    end_ms: (index + 1) * 1000,
    text: 'Tak.',
    speaker_label: null,
  }));
  const raw = Buffer.from(JSON.stringify({ events: segments }));
  const track = {
    language_code: 'pl',
    track_kind: 'GENERATED',
    is_generated: true,
    is_translated: false,
    source_language: null,
    is_translatable: null,
    is_original: true,
    extension: 'json3',
  };
  const provider = new YtdlpTranscriptProvider(async () => ({
    status: 'OK',
    failure_code: null,
    python_version: '3.12.3',
    provider_version: '2026.8.19',
    tracks: [track],
    video_language: 'pl',
    selected: track,
    segments,
    raw_payload_base64: raw.toString('base64'),
    raw_payload_hash: createHash('sha256').update(raw).digest('hex'),
  }));
  const reference = {
    language_code: 'pl',
    track_kind: 'GENERATED' as const,
    segments,
  };
  const fetched = await qualifySource(
    provider,
    {
      item_id: 'youtube:fixture0001',
      namespace: 'youtube',
      external_id: 'fixture0001',
      duration_ms: 3000,
    },
    reference,
  );
  expect(compareFullSource(fetched, reference)).toBe(true);
  for (const result of [
    { ...fetched.result, status: 'PARTIAL' as const },
    { ...fetched.result, is_translated: true },
    { ...fetched.result, segments: segments.slice(0, 2) },
    { ...fetched.result, segments: [...segments, segments[0]!] },
    {
      ...fetched.result,
      segments: segments.map((cue) => ({ ...cue, start_ms: cue.start_ms + 1 })),
    },
    {
      ...fetched.result,
      segments: segments.map((cue) => ({ ...cue, text: '' })),
    },
  ])
    expect(compareFullSource({ ...fetched, result }, reference)).toBe(false);
  expect(
    compareFullSource({ ...fetched, raw_payload: new Uint8Array() }, reference),
  ).toBe(false);
});
it('Oracle qualification stops on access denial without another source attempt', async () => {
  let calls = 0;
  const provider = new YtdlpTranscriptProvider(async () => {
    calls++;
    return {
      status: 'IP_BLOCKED',
      failure_code: 'REQUEST_BLOCKED',
      tracks: [],
    };
  });
  await expect(
    qualifySource(
      provider,
      {
        item_id: 'youtube:fixture0001',
        namespace: 'youtube',
        external_id: 'fixture0001',
        duration_ms: 3000,
      },
      { language_code: 'pl', track_kind: 'GENERATED', segments: [] },
    ),
  ).rejects.toThrow('SOURCE_IP_BLOCKED');
  expect(calls).toBe(1);
});
