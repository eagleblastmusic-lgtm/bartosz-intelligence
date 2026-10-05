import { describe, expect, it } from 'vitest';
import {
  buildGate0DryRunRequestPlan,
  gate0ManifestHash,
  summarizeGate0Outcomes,
  validateGate0Manifest,
  type Gate0Entry,
  type Gate0Manifest,
  type Gate0VideoOutcome,
  type Gate0TranscriptStatus,
} from '../../tools/gates/transcript-bench.js';

function completeManifest(): Gate0Manifest {
  const now = Date.now();
  const targets = [
    ['en_manual', 8],
    ['en_generated', 10],
    ['pl_manual', 6],
    ['pl_generated', 8],
    ['other', 4],
    ['no_or_late_captions', 4],
  ] as const;
  const entries: Gate0Entry[] = [];
  let n = 0;
  for (const [stratum, count] of targets) {
    for (let index = 0; index < count; index++, n++) {
      const video_id = n.toString(36).padStart(11, '0');
      const language = stratum.startsWith('en')
        ? 'en'
        : stratum.startsWith('pl')
          ? 'pl'
          : 'es';
      const kind = stratum.endsWith('manual')
        ? 'manual'
        : stratum.endsWith('generated')
          ? 'generated'
          : 'unknown';
      entries.push({
        video_id,
        public_url: `https://www.youtube.com/watch?v=${video_id}`,
        channel_id: `channel-${n % 12}`,
        duration_seconds: n < 6 ? 4000 : 900,
        published_at: new Date(
          now - (n < 8 ? 24 * 3600_000 : 100 * 86400_000),
        ).toISOString(),
        checked_at: new Date(now).toISOString(),
        public_access: true,
        primary_stratum: stratum,
        tracks: stratum === 'no_or_late_captions' ? [] : [{ language, kind }],
        track_inventory_ref: `fixture://tracks/${video_id}`,
        short: n < 4,
        shorts_url: n < 4 ? `https://www.youtube.com/shorts/${video_id}` : null,
        ended_live: n >= 4 && n < 8,
        live_end_timestamp:
          n >= 4 && n < 8 ? new Date(now - 1000).toISOString() : null,
        verified_metadata_ref: `fixture://metadata/${video_id}`,
      });
    }
  }
  return {
    schema_version: 'gate0-corpus-1.0',
    as_of: new Date(now).toISOString(),
    status: 'DRAFT',
    frozen_at: null,
    sha256: null,
    source_evidence_sha256: 'f'.repeat(64),
    entry_criteria: {
      minimum_videos: 40,
      minimum_channels: 12,
      primary_strata: {
        en_manual: 8,
        en_generated: 10,
        pl_manual: 6,
        pl_generated: 8,
        other: 4,
        no_or_late_captions: 4,
      },
      crosscuts_minimum: {
        shorts: 4,
        ended_live: 4,
        over_60_minutes: 6,
        new_under_48_hours: 8,
        old_over_90_days: 8,
      },
      first_measurement_started: false,
    },
    retry_windows_local: ['09:00', '19:00'],
    retry_policy: 'bounded retry policy fixture',
    measurement_policy: {
      denominator: {
        full_corpus_videos: 40,
        eligible_video_rule: 'at_least_one_track_at_freeze',
        unit: 'unique_video_id',
        natural_no_captions_stratum: 'no_or_late_captions',
        failures_stay_in_denominator: true,
        attempts_do_not_increase_denominator: true,
      },
      success: {
        eligible_video_success_rate_minimum: 0.95,
        successful_status: 'OK',
        partial_counts_as_success: false,
      },
      timestamps: {
        precision_unit: 'integer_ms',
        source_reference_required: true,
        cue_boundary_match_tolerance_ms: 250,
        duration_end_tolerance_ms: 1000,
        synthetic_timestamps_allowed: false,
        overlapping_cues_allowed: true,
      },
      cpu: {
        edge_runtime: 'Cloudflare Workers Free',
        edge_invocation_cpu_limit_ms: 10,
        actual_platform_cpu_metrics_required: true,
        wall_clock_counts_as_cpu: false,
      },
    },
    error_boundaries: {
      no_captions_requires_public_access_and_empty_tracklist: true,
      ip_blocked_is_no_captions: false,
      preserve_video_row_after_failure: true,
      no_captions_retry_schedule: ['1h', '6h', '24h', '3d', '7d', 'weekly'],
      transient_retry: {
        maximum_attempts: 4,
        delays_minutes_full_jitter: [1, 5, 20, 60],
        statuses: ['TEMPORARY_FAILURE', 'RATE_LIMITED'],
      },
    },
    entries,
  };
}

describe('Gate 0 corpus preregistration', () => {
  it('balances each primary stratum across the two scheduled request windows', () => {
    const manifest = completeManifest();
    manifest.status = 'FROZEN';
    manifest.frozen_at = manifest.as_of;
    manifest.sha256 = gate0ManifestHash(manifest);
    const plan = buildGate0DryRunRequestPlan(manifest, '2026-10-04T20:00:00Z');
    const perStratumCounts = new Map<string, Map<string, number>>();
    for (const video of plan.videos) {
      const slots =
        perStratumCounts.get(video.primary_stratum) ??
        new Map<string, number>();
      slots.set(
        video.scheduled_window_local_time,
        (slots.get(video.scheduled_window_local_time) ?? 0) + 1,
      );
      perStratumCounts.set(video.primary_stratum, slots);
    }
    expect(plan.mode).toBe('DRY_RUN_NO_NETWORK');
    expect(plan.live_requests_executed).toBe(false);
    expect(plan.denominator).toMatchObject({
      corpus_videos: 40,
      caption_eligible_videos: 36,
      natural_no_caption_videos: 4,
    });
    const stratumCounts = new Map<string, number>();
    for (const entry of manifest.entries)
      stratumCounts.set(
        entry.primary_stratum,
        (stratumCounts.get(entry.primary_stratum) ?? 0) + 1,
      );
    for (const [stratum, slots] of perStratumCounts) {
      const counts = [...slots.values()].sort((left, right) => left - right);
      const expected = (stratumCounts.get(stratum) ?? 0) / 2;
      expect(counts).toEqual([expected, expected]);
    }
  });

  it('accepts a complete verified 40-video fixture with required strata and crosscuts', () => {
    expect(validateGate0Manifest(completeManifest())).toEqual([]);
  });

  it('rejects insufficient videos, channels, strata and crosscuts', () => {
    const manifest = completeManifest();
    manifest.entries = manifest.entries.slice(0, 20);
    const errors = validateGate0Manifest(manifest);
    expect(errors).toContain('VIDEO_COUNT_BELOW_MINIMUM');
    expect(errors).toContain('STRATUM_BELOW_MINIMUM:pl_manual');
    expect(errors).toContain('STRATUM_BELOW_MINIMUM:no_or_late_captions');
  });

  it('rejects a post-preregistration stratum imbalance', () => {
    const manifest = completeManifest();
    manifest.entries[0]!.primary_stratum = 'en_generated';
    const errors = validateGate0Manifest(manifest);
    expect(errors).toContain('STRATUM_ABOVE_PREREGISTERED:en_generated');
    expect(errors).toContain('STRATUM_BELOW_MINIMUM:en_manual');
  });

  it('counts unique eligible videos, keeps IP_BLOCKED as failure, and separates natural no captions', () => {
    const manifest = completeManifest();
    const outcomes: Gate0VideoOutcome[] = manifest.entries.map((entry) => {
      const final_status: Gate0TranscriptStatus =
        entry.primary_stratum === 'no_or_late_captions' ? 'NO_CAPTIONS' : 'OK';
      return {
        video_id: entry.video_id,
        final_status,
        attempts: [final_status],
      };
    });
    const blockedIndex = outcomes.findIndex(
      (outcome) => outcome.final_status === 'OK',
    );
    const blocked = outcomes[blockedIndex]!;
    outcomes[blockedIndex] = {
      ...blocked,
      final_status: 'IP_BLOCKED',
      attempts: ['TEMPORARY_FAILURE', 'IP_BLOCKED'],
    };

    const summary = summarizeGate0Outcomes(manifest, outcomes);
    expect(summary.errors).toEqual([]);
    expect(summary.corpus_video_denominator).toBe(40);
    expect(summary.eligible_video_denominator).toBe(36);
    expect(summary.natural_no_caption_videos).toBe(4);
    expect(summary.eligible_successes).toBe(35);
    expect(summary.eligible_ip_blocked_videos).toBe(1);
    expect(summary.total_attempts).toBe(41);
  });

  it('rejects frozen manifest mutation and measurements before freeze', () => {
    const manifest = completeManifest();
    manifest.status = 'FROZEN';
    manifest.frozen_at = new Date().toISOString();
    manifest.sha256 = gate0ManifestHash(manifest);
    expect(validateGate0Manifest(manifest)).toEqual([]);
    manifest.entries[0]!.video_id = 'mutated0000';
    expect(validateGate0Manifest(manifest)).toContain('FROZEN_HASH_MISMATCH');
    manifest.status = 'DRAFT';
    manifest.entry_criteria.first_measurement_started = true;
    expect(validateGate0Manifest(manifest)).toContain(
      'MEASUREMENT_BEFORE_FREEZE',
    );
  });
});
