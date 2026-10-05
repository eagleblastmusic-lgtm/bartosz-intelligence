import { it, expect } from 'vitest';
import {
  transcriptDisposition,
  transcriptRuntime,
} from '../../packages/core/src/transcript/recovery.js';
const now = new Date('2026-10-06T00:00:00Z');
it('delayed captions use an independent 1h/6h/24h/3d/7d/weekly schedule', () => {
  expect(
    Array.from(
      { length: 7 },
      (_, no_captions) =>
        Date.parse(
          transcriptDisposition(
            'NO_CAPTIONS',
            { no_captions, transient: 99 },
            now,
          ).due_at,
        ) - now.getTime(),
    ),
  ).toEqual([
    3600000, 21600000, 86400000, 259200000, 604800000, 604800000, 604800000,
  ]);
  expect(
    transcriptDisposition(
      'NO_CAPTIONS',
      { no_captions: 8, transient: 0 },
      now,
      true,
    ).reason,
  ).toBe('LIVE_ACTIVE');
});
it('keeps denied, unavailable, parser and IP outcomes distinct with no unqualified fallback', () => {
  for (const status of [
    'AUTH_REQUIRED',
    'REGION_BLOCKED',
    'UNAVAILABLE',
    'TOO_LARGE',
  ] as const)
    expect(
      transcriptDisposition(status, { no_captions: 0, transient: 0 }, now)
        .state,
    ).toBe('BLOCKED');
  expect(
    transcriptDisposition('IP_BLOCKED', { no_captions: 0, transient: 0 }, now)
      .reason,
  ).toBe('LOCAL_YTDLP_IP_BLOCKED');
  expect(
    transcriptDisposition('PARSE_ERROR', { no_captions: 0, transient: 0 }, now)
      .reason,
  ).toBe('LOCAL_YTDLP_PARSER_CHANGED');
  expect(
    transcriptDisposition(
      'TEMPORARY_FAILURE',
      { no_captions: 50, transient: 0 },
      now,
      false,
      () => 0.5,
    ).state,
  ).toBe('RETRY_WAIT');
  expect(
    transcriptDisposition(
      'TEMPORARY_FAILURE',
      { no_captions: 0, transient: 4 },
      now,
      false,
      () => 0.5,
    ).state,
  ).toBe('DEFERRED');
  expect(() =>
    transcriptDisposition('OK', { no_captions: 0, transient: 0 }, now),
  ).toThrow('SOURCE_ACCEPTANCE_REQUIRED');
  expect(transcriptRuntime.paid_services_enabled).toBe(false);
  expect(transcriptRuntime.cloud_caption_enabled).toBe(false);
  expect(transcriptRuntime.stt_enabled).toBe(false);
});
