import { it, expect } from 'vitest';
import {
  transcriptDisposition,
  transcriptRuntime,
} from '../../packages/core/src/transcript/recovery.js';
const now = new Date('2026-10-06T00:00:00Z');
it('confirmed absences use absolute +1h and +10h, then stop after the third', () => {
  expect(
    Array.from(
      { length: 3 },
      (_, no_captions) =>
        Date.parse(
          transcriptDisposition(
            'NO_CAPTIONS',
            { no_captions, transient: 99 },
            now,
          ).due_at,
        ) - now.getTime(),
    ),
  ).toEqual([3600000, 36000000, 0]);
  expect(
    transcriptDisposition(
      'NO_CAPTIONS',
      { no_captions: 8, transient: 0 },
      now,
      true,
    ).reason,
  ).toBe('LIVE_ACTIVE');
  expect(
    transcriptDisposition('NO_CAPTIONS', { no_captions: 2, transient: 99 }, now)
      .state,
  ).toBe('FAILED');
  expect(
    transcriptDisposition(
      'NO_CAPTIONS',
      { no_captions: 0, transient: 99 },
      new Date(now.getTime() + 20 * 60000),
      false,
      Math.random,
      now,
    ).due_at,
  ).toBe(new Date(now.getTime() + 3600000).toISOString());
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
