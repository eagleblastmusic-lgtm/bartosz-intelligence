import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  safePythonProcessFailure,
  PYTHON_MAX_OUTPUT_BYTES,
} from '../../tools/gates/adapters/python-process-evidence.js';
import {
  nextScheduledWindowAt,
  isCurrentScheduledWindow,
  retryEarliestAt,
  summarizeGate0Fidelity,
  summarizeGate0LiveObservations,
  upsertGate0Observation,
  type Gate0LiveObservation,
} from '../../tools/gates/transcript-bench-live.js';
import type { Gate0Manifest } from '../../tools/gates/transcript-bench.js';

const manifest = JSON.parse(
  readFileSync(
    new URL('../../docs/verification/gate-0/MANIFEST.json', import.meta.url),
    'utf8',
  ),
) as Gate0Manifest;

it('captures timeout and buffer diagnostics without exposing stderr, URLs or credentials', () => {
  const raw =
    'Authorization: fixture-secret https://example.invalid/signed?key=fixture';
  const result = safePythonProcessFailure({
    code: 'ETIMEDOUT',
    signal: 'SIGTERM',
    status: null,
    stderr: Buffer.from(raw),
    message: raw,
  });
  expect(result).toMatchObject({
    process_error_code: 'ETIMEDOUT',
    process_signal: 'SIGTERM',
    evidence_classification: 'INCONCLUSIVE',
    provider_failure: false,
  });
  expect(result['stderr_sha256']).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain('fixture-secret');
  expect(JSON.stringify(result)).not.toContain('signed');
});

it('captures large valid metadata JSON within an explicit bound instead of the default 1MiB buffer', () => {
  const args = [
    '-e',
    'process.stdout.write(JSON.stringify({metadata:"x".repeat(1200000)}))',
  ];
  expect(() =>
    execFileSync(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
  ).toThrow();
  const stdout = execFileSync(process.execPath, args, {
    encoding: 'utf8',
    maxBuffer: PYTHON_MAX_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  expect((JSON.parse(stdout) as { metadata: string }).metadata.length).toBe(
    1200000,
  );
  expect(PYTHON_MAX_OUTPUT_BYTES).toBe(8 * 1024 * 1024);
});

it('does not call unmeasured cases or harness failures provider failures', () => {
  const entry = manifest.entries.find((e) => e.tracks.length > 0)!;
  const failed = row(
    entry.video_id,
    entry.primary_stratum,
    'list_tracks',
    1,
    'TEMPORARY_FAILURE',
  );
  failed.reason_code = 'LOCAL_ADAPTER_PROCESS_FAILED';
  const summary = summarizeGate0LiveObservations(
    manifest,
    [failed],
    'youtube-transcript-api',
  );
  expect(summary.eligible_failures).toBe(0);
  expect(summary.eligible_inconclusive).toBe(1);
  expect(summary.eligible_unmeasured).toBe(35);
  expect(summary.eligible_video_denominator).toBe(36);
});

function row(
  videoId: string,
  stratum: string,
  operation: Gate0LiveObservation['operation'],
  attempt: number,
  status: Gate0LiveObservation['status'],
): Gate0LiveObservation {
  const at = '2026-10-05T07:00:00.000Z';
  return {
    schema_version: 'gate0-live-observation-1.0',
    manifest_sha256: manifest.sha256!,
    run_id: 'fixture-run',
    request_id: `${videoId}-${operation}-${attempt}`,
    provider: 'youtube-transcript-api',
    runtime: 'local Python 3.14.4',
    provider_version: 'youtube-transcript-api@1.2.4',
    window_date: '2026-10-05',
    window_local_time: '09:00',
    video_id: videoId,
    primary_stratum: stratum,
    operation,
    attempt_number: attempt,
    started_at: at,
    completed_at: at,
    status,
    reason_code: null,
    retry_earliest_at: null,
    request_bytes_sent: null,
    response_bytes_received: 0,
    upstream_bytes_received: 0,
    raw_response_sha256: [],
    http_observations: [],
    cue_count: null,
    elapsed_wall_ms: 0,
  };
}

describe('Gate 0 live runner accounting', () => {
  it('replaces an in-progress row once and rejects conflicting completed evidence', () => {
    const started = row(
      manifest.entries[0]!.video_id,
      manifest.entries[0]!.primary_stratum,
      'list_tracks',
      1,
      'ATTEMPT_STARTED',
    );
    const completed = { ...started, status: 'OK' as const };
    const pending = upsertGate0Observation([], started);
    expect(pending.result).toBe('ADDED');
    const captured = upsertGate0Observation(pending.rows, completed);
    expect(captured.result).toBe('UPDATED');
    expect(upsertGate0Observation(captured.rows, completed).result).toBe(
      'DUPLICATE',
    );
    expect(() =>
      upsertGate0Observation(captured.rows, {
        ...completed,
        reason_code: 'conflicting-result',
      }),
    ).toThrow('RESULT_KEY_CONFLICT');
  });

  it('counts one result per eligible video and keeps blocked cases in the denominator', () => {
    const rows: Gate0LiveObservation[] = [];
    for (const entry of manifest.entries) {
      rows.push(
        row(
          entry.video_id,
          entry.primary_stratum,
          'list_tracks',
          1,
          entry.tracks.length === 0 ? 'NO_CAPTIONS' : 'OK',
        ),
      );
      if (entry.tracks.length > 0)
        rows.push(
          row(entry.video_id, entry.primary_stratum, 'fetch_track', 1, 'OK'),
        );
    }
    const blocked = manifest.entries.find((entry) => entry.tracks.length > 0)!;
    rows.push(
      row(
        blocked.video_id,
        blocked.primary_stratum,
        'fetch_track',
        2,
        'IP_BLOCKED',
      ),
    );

    const summary = summarizeGate0LiveObservations(
      manifest,
      rows,
      'youtube-transcript-api',
    );
    expect(summary.errors).toEqual([]);
    expect(summary.corpus_video_denominator).toBe(40);
    expect(summary.eligible_video_denominator).toBe(36);
    expect(summary.eligible_successes).toBe(35);
    expect(summary.eligible_failures).toBe(1);
    expect(summary.eligible_ip_blocked_videos).toBe(1);
    expect(summary.measured_unique_videos).toBe(40);
    expect(summary.total_recorded_attempts).toBe(77);
  });

  it('bounds full-jitter retries, honors Retry-After, and selects scheduled windows', () => {
    const now = new Date('2026-10-05T07:00:00.000Z');
    expect(retryEarliestAt('TEMPORARY_FAILURE', 1, [], now, () => 0.5)).toBe(
      '2026-10-05T07:00:30.000Z',
    );
    expect(retryEarliestAt('RATE_LIMITED', 1, ['120'], now, () => 0)).toBe(
      '2026-10-05T07:02:00.000Z',
    );
    expect(
      retryEarliestAt('TEMPORARY_FAILURE', 4, [], now, () => 0),
    ).toBeNull();
    expect(nextScheduledWindowAt(now, ['09:00', '19:00']).toISOString()).toBe(
      '2026-10-05T17:00:00.000Z',
    );
    expect(
      nextScheduledWindowAt(new Date('2026-10-05T18:00:00.000Z'), [
        '09:00',
        '19:00',
      ]).toISOString(),
    ).toBe('2026-10-06T07:00:00.000Z');
    expect(
      isCurrentScheduledWindow(
        '2026-10-05/09:00',
        new Date('2026-10-05T07:30:00.000Z'),
      ),
    ).toBe(true);
    expect(
      isCurrentScheduledWindow(
        '2026-10-05/19:00',
        new Date('2026-10-05T07:30:00.000Z'),
      ),
    ).toBe(false);
  });

  it('compares first, middle, and last cue boundaries against a captured source response', () => {
    const entry = manifest.entries.find(
      (candidate) => candidate.tracks.length > 0,
    )!;
    const track = entry.tracks[0]!;
    const cue = (start_ms: number, end_ms: number, text_sha256: string) => ({
      start_ms,
      end_ms,
      text_sha256,
    });
    const sourceCues = {
      first_cue: cue(100, 900, 'a'.repeat(64)),
      middle_cue: cue(5000, 5600, 'b'.repeat(64)),
      last_cue: cue(9000, 9800, 'c'.repeat(64)),
    };
    const source = {
      ...row(entry.video_id, entry.primary_stratum, 'list_and_fetch', 1, 'OK'),
      provider: 'DirectCaptionsEdge' as const,
      runtime: 'Cloudflare Workers Free' as const,
      raw_response_sha256: ['d'.repeat(64), 'e'.repeat(64)],
      result: {
        selected_track: { language_code: track.language, kind: track.kind },
        is_translated_track: false,
        ...sourceCues,
      },
    };
    const candidate = {
      ...row(entry.video_id, entry.primary_stratum, 'fetch_track', 1, 'OK'),
      result: {
        selected_track: { language_code: track.language, kind: track.kind },
        is_translated_track: false,
        first_cue: cue(150, 920, 'a'.repeat(64)),
        middle_cue: cue(5100, 5700, 'b'.repeat(64)),
        last_cue: cue(9260, 10000, 'f'.repeat(64)),
      },
    };

    const summary = summarizeGate0Fidelity(
      manifest,
      [source, candidate],
      'youtube-transcript-api',
    );
    expect(summary.source_reference_available).toBe(1);
    expect(summary.provider_successes).toBe(1);
    expect(summary.compared_cases).toBe(1);
    expect(summary.timestamp_boundaries_compared).toBe(6);
    expect(summary.timestamp_boundaries_within_tolerance).toBe(5);
    expect(summary.timestamp_match_rate).toBeCloseTo(5 / 6);
    expect(summary.text_hash_matches).toBe(2);
    expect(summary.maximum_boundary_delta_ms).toBe(260);
    expect(summary.p95_boundary_delta_ms).toBe(260);
    expect(summary.errors).toContain(
      `TIMESTAMP_BOUNDARY_OUT_OF_TOLERANCE:${entry.video_id}:2:start_ms`,
    );
  });
});

describe('preregistered minute-level measurement windows', () => {
  it('accepts the adjusted start, excludes earlier and end times, and uses configured backoff windows', () => {
    const label = '2026-10-05/12:25';
    expect(
      isCurrentScheduledWindow(label, new Date('2026-10-05T10:24:59Z')),
    ).toBe(false);
    expect(
      isCurrentScheduledWindow(label, new Date('2026-10-05T10:25:00Z')),
    ).toBe(true);
    expect(
      isCurrentScheduledWindow(label, new Date('2026-10-05T11:24:59Z')),
    ).toBe(true);
    expect(
      isCurrentScheduledWindow(label, new Date('2026-10-05T11:25:00Z')),
    ).toBe(false);
    expect(
      nextScheduledWindowAt(new Date('2026-10-05T10:26:00Z'), [
        '12:25',
        '18:25',
      ]).toISOString(),
    ).toBe('2026-10-05T16:25:00.000Z');
  });
});
