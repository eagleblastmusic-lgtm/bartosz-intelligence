import { expect, it } from 'vitest';
import fixture from '../fixtures/gate0/production-caption-sample.json';
import {
  normalizeCue,
  normalizeTranscript,
} from '../../packages/core/src/transcript/normalize.js';
it('reconstructs an exact quote from the recorded real caption sample', async () => {
  const result = await normalizeTranscript(
    fixture.raw_payload_hash,
    fixture.segments,
    'CUE',
  );
  const anchor = result.manifest.anchors[0]!;
  expect(result.source_text.slice(anchor.source_start, anchor.source_end)).toBe(
    fixture.segments[0]!.text,
  );
  expect(anchor.text).toBe('حسنًا، لقد سمعنا الكثير\nعن الذكاء الاصطناعي.');
  expect([anchor.start_ms, anchor.end_ms]).toEqual([3833, 7712]);
});
it('normalizes entities/markup/NFC/newlines with explicit raw UTF16 spans', () => {
  const raw =
    '<b>e\u0301</b>  &amp; &#x1F642;\r\n&lt;literal&gt; &NotEqualTilde;';
  const value = normalizeCue(raw);
  expect(value.text).toBe('é & 🙂\n<literal> ≂̸');
  let end = 0;
  for (const span of value.offsets) {
    expect(span.normalized_start).toBe(end);
    expect(span.raw_end).toBeGreaterThan(span.raw_start);
    expect(span.raw_end).toBeLessThanOrEqual(raw.length);
    end = span.normalized_end;
  }
  expect(end).toBe(value.text.length);
  expect(
    raw.slice(value.offsets[0]!.raw_start, value.offsets[0]!.raw_end),
  ).toBe('e\u0301');
  expect(normalizeCue('a <literal> b').text).toBe('a <literal> b');
});
it('splits long cue without surrogate cuts or invented word timing and replays stable anchors', async () => {
  const cues = [
    {
      upstream_index: 0,
      text: 'e\u0301🙂 '.repeat(40),
      start_ms: 250,
      end_ms: 3500,
      speaker_label: null,
    },
  ];
  const first = await normalizeTranscript('a'.repeat(64), cues, 'CUE', 32);
  expect(first.manifest.anchors.length).toBeGreaterThan(1);
  expect(first.source_text).toBe(cues[0]!.text);
  expect(
    (await normalizeTranscript('a'.repeat(64), cues, 'CUE', 32)).manifest_hash,
  ).toBe(first.manifest_hash);
  for (const anchor of first.manifest.anchors) {
    expect(new TextEncoder().encode(anchor.text).length).toBeLessThanOrEqual(
      32,
    );
    expect([
      anchor.start_ms,
      anchor.end_ms,
      anchor.timestamp_precision,
    ]).toEqual([250, 3500, 'CUE']);
    expect(
      new TextDecoder().decode(new TextEncoder().encode(anchor.text)),
    ).toBe(anchor.text);
    expect(
      first.source_text.slice(anchor.source_start, anchor.source_end),
    ).not.toBe('');
  }
  expect(first.manifest.anchors.map((anchor) => anchor.text).join('')).toBe(
    normalizeCue(cues[0]!.text).text,
  );
});
it('keeps repeated text at other times, missing timing and empty cue in complete source coverage', async () => {
  const cues = [
    {
      upstream_index: 0,
      text: 'same',
      start_ms: 1,
      end_ms: 100,
      speaker_label: null,
    },
    {
      upstream_index: 1,
      text: 'same',
      start_ms: 1,
      end_ms: 100,
      speaker_label: null,
    },
    {
      upstream_index: 2,
      text: 'same',
      start_ms: 50,
      end_ms: 200,
      speaker_label: null,
    },
    {
      upstream_index: 3,
      text: 'unknown',
      start_ms: null,
      end_ms: 300,
      speaker_label: null,
    },
    {
      upstream_index: 4,
      text: '<b> </b>',
      start_ms: null,
      end_ms: null,
      speaker_label: null,
    },
  ];
  const result = await normalizeTranscript('b'.repeat(64), cues, 'CUE');
  expect(result.manifest.anchors.map((anchor) => anchor.alias)).toEqual([
    's1',
    's2',
    's3',
  ]);
  expect(result.manifest.coverage).toHaveLength(5);
  expect(result.manifest.coverage[1]!.duplicate_of).toBe(0);
  expect(result.manifest.coverage[4]!.empty).toBe(true);
  expect(result.manifest.anchors[2]!.timestamp_precision).toBe('NONE');
  expect(result.source_text).toBe(cues.map((cue) => cue.text).join('\n'));
  await expect(
    normalizeTranscript('b'.repeat(64), [cues[0]!, cues[0]!], 'CUE'),
  ).rejects.toThrow('INVALID_SOURCE_CUE');
});
