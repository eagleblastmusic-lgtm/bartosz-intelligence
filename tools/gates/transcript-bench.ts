import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Gate0Stratum =
  | 'en_manual'
  | 'en_generated'
  | 'pl_manual'
  | 'pl_generated'
  | 'other'
  | 'no_or_late_captions';

export type Gate0TrackKind = 'manual' | 'generated' | 'unknown';

export type Gate0TranscriptStatus =
  | 'OK'
  | 'PARTIAL'
  | 'NO_CAPTIONS'
  | 'IP_BLOCKED'
  | 'RATE_LIMITED'
  | 'AUTH_REQUIRED'
  | 'REGION_BLOCKED'
  | 'UNAVAILABLE'
  | 'PARSE_ERROR'
  | 'UPSTREAM_CHANGED'
  | 'TOO_LARGE'
  | 'TEMPORARY_FAILURE';

export interface Gate0Entry {
  video_id: string;
  public_url: string;
  channel_id: string;
  duration_seconds: number;
  published_at: string;
  checked_at: string;
  public_access: boolean;
  primary_stratum: Gate0Stratum;
  tracks: { language: string; kind: Gate0TrackKind }[];
  track_inventory_ref: string;
  short: boolean;
  shorts_url: string | null;
  ended_live: boolean;
  live_end_timestamp: string | null;
  verified_metadata_ref: string;
}

export interface Gate0MeasurementPolicy {
  denominator: {
    full_corpus_videos: 40;
    eligible_video_rule: 'at_least_one_track_at_freeze';
    unit: 'unique_video_id';
    natural_no_captions_stratum: 'no_or_late_captions';
    failures_stay_in_denominator: true;
    attempts_do_not_increase_denominator: true;
  };
  success: {
    eligible_video_success_rate_minimum: 0.95;
    successful_status: 'OK';
    partial_counts_as_success: false;
  };
  timestamps: {
    precision_unit: 'integer_ms';
    source_reference_required: true;
    cue_boundary_match_tolerance_ms: 250;
    duration_end_tolerance_ms: 1000;
    synthetic_timestamps_allowed: false;
    overlapping_cues_allowed: true;
  };
  cpu: {
    edge_runtime: 'Cloudflare Workers Free';
    edge_invocation_cpu_limit_ms: 10;
    actual_platform_cpu_metrics_required: true;
    wall_clock_counts_as_cpu: false;
  };
}

export interface Gate0ErrorBoundaries {
  no_captions_requires_public_access_and_empty_tracklist: true;
  ip_blocked_is_no_captions: false;
  preserve_video_row_after_failure: true;
  no_captions_retry_schedule: ['1h', '6h', '24h', '3d', '7d', 'weekly'];
  transient_retry: {
    maximum_attempts: 4;
    delays_minutes_full_jitter: [1, 5, 20, 60];
    statuses: ['TEMPORARY_FAILURE', 'RATE_LIMITED'];
  };
}

export interface Gate0Manifest {
  schema_version: string;
  as_of: string;
  status: 'DRAFT' | 'FROZEN';
  frozen_at: string | null;
  sha256: string | null;
  source_evidence_sha256: string | null;
  entry_criteria: {
    minimum_videos: number;
    minimum_channels: number;
    primary_strata: Record<Gate0Stratum, number>;
    crosscuts_minimum: Record<string, number>;
    first_measurement_started: boolean;
  };
  retry_windows_local: string[];
  retry_policy: string;
  measurement_policy: Gate0MeasurementPolicy;
  error_boundaries: Gate0ErrorBoundaries;
  entries: Gate0Entry[];
}

export interface Gate0PlayerTrackInventoryVideo {
  video_id: string;
  title: string;
  channel_id: string;
  duration_seconds: number;
  published_at: string;
  checked_at: string;
  public_url: string;
  public_access: boolean;
  shorts_surface_url: string | null;
  caption_track_count: number;
  selected_track_evidence: {
    language_code: string;
    kind: Gate0TrackKind;
    name: string;
    vss_id: string | null;
  } | null;
  live_end_timestamp: string | null;
}

export interface Gate0PlayerTrackInventory {
  schema_version: string;
  captured_at: string;
  collection_method: string;
  primary_stratum_by_video: Record<string, Gate0Stratum>;
  videos: Record<string, Gate0PlayerTrackInventoryVideo>;
}

export interface Gate0VideoOutcome {
  video_id: string;
  final_status: Gate0TranscriptStatus;
  attempts: Gate0TranscriptStatus[];
}

export interface Gate0OutcomeSummary {
  corpus_video_denominator: number;
  eligible_video_denominator: number;
  natural_no_caption_videos: number;
  eligible_successes: number;
  eligible_success_rate: number;
  eligible_failures: number;
  eligible_ip_blocked_videos: number;
  total_attempts: number;
  errors: string[];
}

export interface Gate0DryRunRequestPlan {
  schema_version: 'gate0-request-plan-1.0';
  generated_at: string;
  mode: 'DRY_RUN_NO_NETWORK';
  live_requests_executed: false;
  paid_routes_allowed: false;
  manifest_sha256: string;
  source_evidence_sha256: string;
  windows: {
    timezone: 'Europe/Warsaw';
    daily_local_times: string[];
    assignment_policy: 'alternate_within_primary_stratum';
    video_assignments: Record<string, string>;
  };
  denominator: {
    corpus_videos: number;
    caption_eligible_videos: number;
    natural_no_caption_videos: number;
    denominator_unit: 'unique_video_id';
    attempts_count_as_videos: false;
  };
  candidate_adapters: {
    id: string;
    runtime: string;
    version: string;
    license: string;
    status: 'NOT_RUN';
    media_download: false;
  }[];
  request_policy: {
    first_operation: 'LIST_TRACKS';
    fetch_track_when_present: true;
    transient_maximum_attempts: number;
    transient_delays_minutes_full_jitter: number[];
    no_captions_retry_schedule: string[];
    ip_blocked_is_no_captions: false;
    same_ip_fallback_is_independent: false;
    retain_failed_video_rows: true;
  };
  timestamp_policy: Gate0MeasurementPolicy['timestamps'];
  cpu_policy: Gate0MeasurementPolicy['cpu'];
  videos: {
    video_id: string;
    primary_stratum: Gate0Stratum;
    scheduled_window_local_time: string;
    public_url: string;
    public_access_confirmed_at_freeze: true;
    baseline_track: Gate0Entry['tracks'][number] | null;
    track_inventory_ref: string;
    expected_baseline_class:
      | 'CAPTION_ELIGIBLE'
      | 'NATURAL_NO_CAPTIONS_OR_LATE';
    planned_operations: ('LIST_TRACKS' | 'FETCH_SELECTED_TRACK')[];
    failure_boundary:
      | 'provider/network/parser failures remain distinct from NO_CAPTIONS'
      | 'NO_CAPTIONS is only valid for public access with empty tracklist';
  }[];
}

const videoIdPattern = /^[\w-]{11}$/;
const strata = [
  'en_manual',
  'en_generated',
  'pl_manual',
  'pl_generated',
  'other',
  'no_or_late_captions',
] as const;
const inventoryRelativePath =
  'docs/verification/gate-0/player-track-inventory.json';

export function gate0ManifestHash(manifest: Gate0Manifest): string {
  const content = { ...manifest, sha256: null };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

export function gate0PlayerTrackInventoryHash(
  inventory: Gate0PlayerTrackInventory,
): string {
  return createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
}

export function validateGate0Manifest(manifest: Gate0Manifest): string[] {
  const errors: string[] = [];
  if (manifest.schema_version !== 'gate0-corpus-1.0')
    errors.push('SCHEMA_VERSION_INVALID');
  if (!Array.isArray(manifest.entries)) return ['ENTRIES_INVALID'];

  const entries = manifest.entries;
  const expectedCount = Object.values(
    manifest.entry_criteria.primary_strata,
  ).reduce((sum, count) => sum + count, 0);
  if (entries.length < manifest.entry_criteria.minimum_videos)
    errors.push('VIDEO_COUNT_BELOW_MINIMUM');
  if (entries.length !== expectedCount)
    errors.push('VIDEO_COUNT_NOT_EXACTLY_PREREGISTERED');
  if (
    new Set(entries.map((entry) => entry.channel_id)).size <
    manifest.entry_criteria.minimum_channels
  )
    errors.push('CHANNEL_COUNT_BELOW_MINIMUM');
  if (new Set(entries.map((entry) => entry.video_id)).size !== entries.length)
    errors.push('DUPLICATE_VIDEO_ID');
  if (
    !manifest.source_evidence_sha256 ||
    !/^[a-f0-9]{64}$/.test(manifest.source_evidence_sha256)
  )
    errors.push('SOURCE_EVIDENCE_HASH_MISSING');

  const asOf = Date.parse(manifest.as_of);
  if (!Number.isFinite(asOf)) errors.push('AS_OF_INVALID');
  for (const entry of entries) {
    if (!videoIdPattern.test(entry.video_id))
      errors.push(`VIDEO_ID_INVALID:${entry.video_id}`);
    if (
      entry.public_url !==
      `https://www.youtube.com/watch?v=${entry.video_id}`
    )
      errors.push(`PUBLIC_URL_INVALID:${entry.video_id}`);
    if (!entry.public_access)
      errors.push(`PUBLIC_ACCESS_UNVERIFIED:${entry.video_id}`);
    if (
      !entry.channel_id ||
      !Number.isFinite(entry.duration_seconds) ||
      entry.duration_seconds <= 0
    )
      errors.push(`VIDEO_METADATA_INCOMPLETE:${entry.video_id}`);
    const publishedAt = Date.parse(entry.published_at);
    const checkedAt = Date.parse(entry.checked_at);
    if (!Number.isFinite(publishedAt) || !Number.isFinite(checkedAt))
      errors.push(`VIDEO_DATES_INVALID:${entry.video_id}`);
    else if (Number.isFinite(asOf) && (publishedAt > asOf || checkedAt > asOf))
      errors.push(`VIDEO_AFTER_AS_OF:${entry.video_id}`);
    if (!entry.track_inventory_ref || !entry.verified_metadata_ref)
      errors.push(`EVIDENCE_REFERENCE_MISSING:${entry.video_id}`);
    if (entry.short) {
      if (entry.shorts_url !== `https://www.youtube.com/shorts/${entry.video_id}`)
        errors.push(`SHORTS_EVIDENCE_MISSING:${entry.video_id}`);
    } else if (entry.shorts_url !== null) {
      errors.push(`SHORTS_EVIDENCE_UNEXPECTED:${entry.video_id}`);
    }
    if (entry.ended_live !== (entry.live_end_timestamp !== null))
      errors.push(`ENDED_LIVE_EVIDENCE_MISMATCH:${entry.video_id}`);
    if (entry.live_end_timestamp !== null) {
      const end = Date.parse(entry.live_end_timestamp);
      if (!Number.isFinite(end) || (Number.isFinite(asOf) && end > asOf))
        errors.push(`LIVE_END_TIMESTAMP_INVALID:${entry.video_id}`);
    }
    const expectedStratum = stratumFor(entry);
    if (!expectedStratum || entry.primary_stratum !== expectedStratum)
      errors.push(`STRATUM_MISMATCH:${entry.video_id}`);
  }

  for (const stratum of strata) {
    const target = manifest.entry_criteria.primary_strata[stratum];
    const actual = entries.filter(
      (entry) => entry.primary_stratum === stratum,
    ).length;
    if (actual < target) errors.push(`STRATUM_BELOW_MINIMUM:${stratum}`);
    if (actual > target) errors.push(`STRATUM_ABOVE_PREREGISTERED:${stratum}`);
  }

  const crosscuts = {
    shorts: entries.filter((entry) => entry.short).length,
    ended_live: entries.filter((entry) => entry.ended_live).length,
    over_60_minutes: entries.filter((entry) => entry.duration_seconds > 3600)
      .length,
    new_under_48_hours: entries.filter(
      (entry) => Number.isFinite(asOf) && asOf - Date.parse(entry.published_at) < 48 * 3600_000,
    ).length,
    old_over_90_days: entries.filter(
      (entry) => Number.isFinite(asOf) && asOf - Date.parse(entry.published_at) > 90 * 86400_000,
    ).length,
  };
  for (const [key, minimum] of Object.entries(
    manifest.entry_criteria.crosscuts_minimum,
  ))
    if ((crosscuts[key as keyof typeof crosscuts] ?? 0) < minimum)
      errors.push(`CROSSCUT_BELOW_MINIMUM:${key}`);

  errors.push(...validateMeasurementPolicy(manifest));
  if (
    manifest.entry_criteria.first_measurement_started &&
    manifest.status !== 'FROZEN'
  )
    errors.push('MEASUREMENT_BEFORE_FREEZE');

  if (manifest.status === 'FROZEN') {
    if (!manifest.frozen_at || !manifest.sha256)
      errors.push('FREEZE_METADATA_MISSING');
    else {
      const frozenAt = Date.parse(manifest.frozen_at);
      if (!Number.isFinite(frozenAt) || (Number.isFinite(asOf) && frozenAt < asOf))
        errors.push('FROZEN_AT_INVALID');
      if (manifest.sha256 !== gate0ManifestHash(manifest))
        errors.push('FROZEN_HASH_MISMATCH');
    }
    if (entries.length !== 40) errors.push('FROZEN_CORPUS_INCOMPLETE');
  }
  return [...new Set(errors)];
}

export function prepareGate0Manifest(
  manifest: Gate0Manifest,
  inventory: Gate0PlayerTrackInventory,
): Gate0Manifest {
  const entries = Object.entries(inventory.videos).map(([key, video]) => {
    const primaryStratum = inventory.primary_stratum_by_video[key];
    if (!primaryStratum)
      throw new Error(`Missing primary stratum for ${key}`);
    const selectedTrack = video.selected_track_evidence;
    const tracks = selectedTrack
      ? [{ language: selectedTrack.language_code, kind: selectedTrack.kind }]
      : [];
    return {
      video_id: video.video_id,
      public_url: video.public_url,
      channel_id: video.channel_id,
      duration_seconds: video.duration_seconds,
      published_at: video.published_at,
      checked_at: video.checked_at,
      public_access: video.public_access,
      primary_stratum: primaryStratum,
      tracks,
      track_inventory_ref: selectedTrack
        ? `${inventoryRelativePath}#/videos/${key}/selected_track_evidence`
        : `${inventoryRelativePath}#/videos/${key}/caption_track_count`,
      short: video.shorts_surface_url !== null,
      shorts_url: video.shorts_surface_url,
      ended_live: video.live_end_timestamp !== null,
      live_end_timestamp: video.live_end_timestamp,
      verified_metadata_ref: `${inventoryRelativePath}#/videos/${key}`,
    } satisfies Gate0Entry;
  });
  return {
    ...manifest,
    status: 'DRAFT',
    frozen_at: null,
    sha256: null,
    source_evidence_sha256: gate0PlayerTrackInventoryHash(inventory),
    entries,
  };
}

export function validateGate0PlayerTrackInventory(
  inventory: Gate0PlayerTrackInventory,
  asOf: string,
): string[] {
  const errors: string[] = [];
  if (inventory.schema_version !== 'gate0-youtube-player-track-inventory-1.0')
    errors.push('INVENTORY_SCHEMA_VERSION_INVALID');
  if (!Number.isFinite(Date.parse(inventory.captured_at)))
    errors.push('INVENTORY_CAPTURED_AT_INVALID');
  if (!inventory.collection_method)
    errors.push('INVENTORY_COLLECTION_METHOD_MISSING');
  const videoIds = Object.keys(inventory.videos);
  const strataIds = Object.keys(inventory.primary_stratum_by_video);
  if (videoIds.length !== 40) errors.push('INVENTORY_VIDEO_COUNT_NOT_40');
  if (
    videoIds.length !== strataIds.length ||
    videoIds.some((id) => !Object.hasOwn(inventory.primary_stratum_by_video, id))
  )
    errors.push('INVENTORY_STRATUM_MAP_MISMATCH');
  const now = Date.parse(asOf);
  for (const [key, video] of Object.entries(inventory.videos)) {
    const stratum = inventory.primary_stratum_by_video[key];
    if (!stratum || !strata.includes(stratum)) {
      errors.push(`INVENTORY_STRATUM_INVALID:${key}`);
      continue;
    }
    if (video.video_id !== key || !videoIdPattern.test(video.video_id))
      errors.push(`INVENTORY_VIDEO_ID_INVALID:${key}`);
    if (video.public_url !== `https://www.youtube.com/watch?v=${key}`)
      errors.push(`INVENTORY_PUBLIC_URL_INVALID:${key}`);
    if (!video.public_access || !video.channel_id || !video.title)
      errors.push(`INVENTORY_PUBLIC_METADATA_MISSING:${key}`);
    if (
      !Number.isFinite(video.duration_seconds) ||
      video.duration_seconds <= 0 ||
      !Number.isFinite(Date.parse(video.published_at)) ||
      !Number.isFinite(Date.parse(video.checked_at))
    )
      errors.push(`INVENTORY_METADATA_INVALID:${key}`);
    if (
      Number.isFinite(now) &&
      (Date.parse(video.published_at) > now || Date.parse(video.checked_at) > now)
    )
      errors.push(`INVENTORY_METADATA_AFTER_AS_OF:${key}`);
    if (!Number.isInteger(video.caption_track_count) || video.caption_track_count < 0)
      errors.push(`INVENTORY_TRACK_COUNT_INVALID:${key}`);
    if (
      (video.caption_track_count === 0) !==
      (video.selected_track_evidence === null)
    )
      errors.push(`INVENTORY_SELECTED_TRACK_MISMATCH:${key}`);
    if (video.shorts_surface_url !== null &&
      video.shorts_surface_url !== `https://www.youtube.com/shorts/${key}`)
      errors.push(`INVENTORY_SHORTS_URL_INVALID:${key}`);
    if (video.live_end_timestamp !== null &&
      !Number.isFinite(Date.parse(video.live_end_timestamp)))
      errors.push(`INVENTORY_LIVE_END_INVALID:${key}`);
    if (
      stratum === 'no_or_late_captions' &&
      video.caption_track_count !== 0
    )
      errors.push(`INVENTORY_NO_CAPTIONS_NOT_EMPTY:${key}`);
    if (
      stratum !== 'no_or_late_captions' &&
      video.caption_track_count === 0
    )
      errors.push(`INVENTORY_ELIGIBLE_TRACK_MISSING:${key}`);
    if (video.selected_track_evidence) {
      const track = video.selected_track_evidence;
      if (!track.language_code || !track.name || !track.kind)
        errors.push(`INVENTORY_TRACK_IDENTITY_INCOMPLETE:${key}`);
      const entry: Gate0Entry = {
        video_id: key,
        public_url: video.public_url,
        channel_id: video.channel_id,
        duration_seconds: video.duration_seconds,
        published_at: video.published_at,
        checked_at: video.checked_at,
        public_access: video.public_access,
        primary_stratum: stratum,
        tracks: [{ language: track.language_code, kind: track.kind }],
        track_inventory_ref: 'inventory-fixture',
        short: video.shorts_surface_url !== null,
        shorts_url: video.shorts_surface_url,
        ended_live: video.live_end_timestamp !== null,
        live_end_timestamp: video.live_end_timestamp,
        verified_metadata_ref: 'inventory-fixture',
      };
      if (stratum && stratumFor(entry) !== stratum)
        errors.push(`INVENTORY_TRACK_DOES_NOT_MATCH_STRATUM:${key}`);
    }
  }
  return [...new Set(errors)];
}

export function validateGate0InventoryReferences(
  manifest: Gate0Manifest,
  inventory: Gate0PlayerTrackInventory,
): string[] {
  const errors: string[] = [];
  if (manifest.source_evidence_sha256 !== gate0PlayerTrackInventoryHash(inventory))
    errors.push('PLAYER_TRACK_EVIDENCE_HASH_MISMATCH');
  for (const entry of manifest.entries) {
    const evidence = inventory.videos[entry.video_id];
    if (!evidence) {
      errors.push(`INVENTORY_REFERENCE_NOT_FOUND:${entry.video_id}`);
      continue;
    }
    if (
      evidence.public_url !== entry.public_url ||
      evidence.channel_id !== entry.channel_id ||
      (entry.tracks.length === 0
        ? evidence.caption_track_count !== 0
        : evidence.caption_track_count === 0) ||
      evidence.live_end_timestamp !== entry.live_end_timestamp
    )
      errors.push(`INVENTORY_REFERENCE_MISMATCH:${entry.video_id}`);
  }
  return [...new Set(errors)];
}

export function summarizeGate0Outcomes(
  manifest: Gate0Manifest,
  outcomes: Gate0VideoOutcome[],
): Gate0OutcomeSummary {
  const errors: string[] = [];
  const entryIds = new Set(manifest.entries.map((entry) => entry.video_id));
  const outcomeIds = new Set<string>();
  const byVideo = new Map<string, Gate0VideoOutcome>();
  for (const outcome of outcomes) {
    if (!entryIds.has(outcome.video_id))
      errors.push(`OUTCOME_UNKNOWN_VIDEO:${outcome.video_id}`);
    if (outcomeIds.has(outcome.video_id))
      errors.push(`OUTCOME_DUPLICATE_VIDEO:${outcome.video_id}`);
    outcomeIds.add(outcome.video_id);
    byVideo.set(outcome.video_id, outcome);
    if (outcome.attempts.length === 0)
      errors.push(`OUTCOME_ATTEMPTS_MISSING:${outcome.video_id}`);
  }
  for (const id of entryIds)
    if (!outcomeIds.has(id)) errors.push(`OUTCOME_MISSING_VIDEO:${id}`);

  const naturalNoCaptionIds = new Set(
    manifest.entries
      .filter((entry) => entry.primary_stratum === 'no_or_late_captions')
      .map((entry) => entry.video_id),
  );
  const eligibleIds = manifest.entries
    .filter((entry) => entry.primary_stratum !== 'no_or_late_captions')
    .map((entry) => entry.video_id);
  const eligibleSuccesses = eligibleIds.filter(
    (id) => byVideo.get(id)?.final_status === 'OK',
  ).length;
  const eligibleIpBlocked = eligibleIds.filter(
    (id) => byVideo.get(id)?.final_status === 'IP_BLOCKED',
  ).length;
  const totalAttempts = outcomes.reduce(
    (sum, outcome) => sum + outcome.attempts.length,
    0,
  );
  return {
    corpus_video_denominator: manifest.entries.length,
    eligible_video_denominator: eligibleIds.length,
    natural_no_caption_videos: naturalNoCaptionIds.size,
    eligible_successes: eligibleSuccesses,
    eligible_success_rate:
      eligibleIds.length === 0 ? 0 : eligibleSuccesses / eligibleIds.length,
    eligible_failures: eligibleIds.length - eligibleSuccesses,
    eligible_ip_blocked_videos: eligibleIpBlocked,
    total_attempts: totalAttempts,
    errors: [...new Set(errors)],
  };
}

export function buildGate0DryRunRequestPlan(
  manifest: Gate0Manifest,
  generatedAt = new Date().toISOString(),
): Gate0DryRunRequestPlan {
  if (manifest.status !== 'FROZEN' || !manifest.sha256)
    throw new Error('DRY_RUN_REQUIRES_FROZEN_MANIFEST');
  const noCaptionStratum = manifest.entries.filter(
    (entry) => entry.primary_stratum === 'no_or_late_captions',
  );
  const eligible = manifest.entries.filter(
    (entry) => entry.primary_stratum !== 'no_or_late_captions',
  );
  const perStratumIndex = new Map<Gate0Stratum, number>();
  const videoAssignments = new Map<string, string>();
  for (const entry of manifest.entries) {
    const index = perStratumIndex.get(entry.primary_stratum) ?? 0;
    videoAssignments.set(
      entry.video_id,
      manifest.retry_windows_local[index % 2] ?? manifest.retry_windows_local[0]!,
    );
    perStratumIndex.set(entry.primary_stratum, index + 1);
  }
  return {
    schema_version: 'gate0-request-plan-1.0',
    generated_at: generatedAt,
    mode: 'DRY_RUN_NO_NETWORK',
    live_requests_executed: false,
    paid_routes_allowed: false,
    manifest_sha256: gate0ManifestHash(manifest),
    source_evidence_sha256: manifest.source_evidence_sha256 ?? '',
    windows: {
      timezone: 'Europe/Warsaw',
      daily_local_times: manifest.retry_windows_local,
      assignment_policy: 'alternate_within_primary_stratum',
      video_assignments: Object.fromEntries(videoAssignments),
    },
    denominator: {
      corpus_videos: manifest.entries.length,
      caption_eligible_videos: eligible.length,
      natural_no_caption_videos: noCaptionStratum.length,
      denominator_unit: 'unique_video_id',
      attempts_count_as_videos: false,
    },
    candidate_adapters: [
      {
        id: 'DirectCaptionsEdge',
        runtime: 'Cloudflare Workers Free; measure platform CPU and egress',
        version: 'repository source hash captured with CP-1.6 results',
        license: 'project code; no Ptyktos code reused',
        status: 'NOT_RUN',
        media_download: false,
      },
      {
        id: 'youtube-transcript-api',
        runtime: 'local Python 3.14.4; Node.js 24.21.0 available for the run harness',
        version: 'youtube-transcript-api 1.2.4; pinned transitive lock in requirements-gate0.lock.txt',
        license: 'MIT',
        status: 'NOT_RUN',
        media_download: false,
      },
      {
        id: 'yt-dlp captions-only',
        runtime: 'Python 3.14.4 + Node.js 24.21.0 + yt-dlp-ejs 0.8.0',
        version: 'yt-dlp 2026.08.19; pinned transitive lock in requirements-gate0.lock.txt',
        license: 'Unlicense source package; no bundled executable used',
        status: 'NOT_RUN',
        media_download: false,
      },
    ],
    request_policy: {
      first_operation: 'LIST_TRACKS',
      fetch_track_when_present: true,
      transient_maximum_attempts:
        manifest.error_boundaries.transient_retry.maximum_attempts,
      transient_delays_minutes_full_jitter:
        manifest.error_boundaries.transient_retry.delays_minutes_full_jitter,
      no_captions_retry_schedule:
        manifest.error_boundaries.no_captions_retry_schedule,
      ip_blocked_is_no_captions:
        manifest.error_boundaries.ip_blocked_is_no_captions,
      same_ip_fallback_is_independent: false,
      retain_failed_video_rows:
        manifest.error_boundaries.preserve_video_row_after_failure,
    },
    timestamp_policy: manifest.measurement_policy.timestamps,
    cpu_policy: manifest.measurement_policy.cpu,
    videos: manifest.entries.map((entry) => {
      const noCaptions =
        entry.primary_stratum === 'no_or_late_captions';
      return {
        video_id: entry.video_id,
        primary_stratum: entry.primary_stratum,
        scheduled_window_local_time:
          videoAssignments.get(entry.video_id) ?? manifest.retry_windows_local[0]!,
        public_url: entry.public_url,
        public_access_confirmed_at_freeze: true,
        baseline_track: entry.tracks[0] ?? null,
        track_inventory_ref: entry.track_inventory_ref,
        expected_baseline_class: noCaptions
          ? 'NATURAL_NO_CAPTIONS_OR_LATE'
          : 'CAPTION_ELIGIBLE',
        planned_operations: noCaptions
          ? ['LIST_TRACKS']
          : ['LIST_TRACKS', 'FETCH_SELECTED_TRACK'],
        failure_boundary: noCaptions
          ? 'NO_CAPTIONS is only valid for public access with empty tracklist'
          : 'provider/network/parser failures remain distinct from NO_CAPTIONS',
      };
    }),
  };
}

function validateMeasurementPolicy(manifest: Gate0Manifest): string[] {
  const policy = manifest.measurement_policy;
  const boundaries = manifest.error_boundaries;
  const errors: string[] = [];
  if (!policy || !boundaries) return ['MEASUREMENT_POLICY_MISSING'];
  if (
    policy.denominator.full_corpus_videos !== 40 ||
    policy.denominator.eligible_video_rule !== 'at_least_one_track_at_freeze' ||
    policy.denominator.unit !== 'unique_video_id' ||
    policy.denominator.natural_no_captions_stratum !== 'no_or_late_captions' ||
    policy.denominator.failures_stay_in_denominator !== true ||
    policy.denominator.attempts_do_not_increase_denominator !== true
  )
    errors.push('DENOMINATOR_POLICY_INVALID');
  if (
    policy.success.eligible_video_success_rate_minimum < 0.95 ||
    policy.success.successful_status !== 'OK' ||
    policy.success.partial_counts_as_success !== false
  )
    errors.push('SUCCESS_POLICY_INVALID');
  if (
    policy.timestamps.precision_unit !== 'integer_ms' ||
    policy.timestamps.source_reference_required !== true ||
    policy.timestamps.cue_boundary_match_tolerance_ms < 0 ||
    policy.timestamps.duration_end_tolerance_ms < 0 ||
    policy.timestamps.synthetic_timestamps_allowed !== false
  )
    errors.push('TIMESTAMP_POLICY_INVALID');
  if (
    policy.cpu.edge_runtime !== 'Cloudflare Workers Free' ||
    policy.cpu.edge_invocation_cpu_limit_ms !== 10 ||
    policy.cpu.actual_platform_cpu_metrics_required !== true ||
    policy.cpu.wall_clock_counts_as_cpu !== false
  )
    errors.push('CPU_POLICY_INVALID');
  if (
    boundaries.no_captions_requires_public_access_and_empty_tracklist !== true ||
    boundaries.ip_blocked_is_no_captions !== false ||
    boundaries.preserve_video_row_after_failure !== true ||
    boundaries.transient_retry.maximum_attempts !== 4 ||
    boundaries.transient_retry.delays_minutes_full_jitter.join(',') !==
      '1,5,20,60'
  )
    errors.push('ERROR_BOUNDARIES_INVALID');
  if (
    manifest.retry_windows_local.length !== 2 ||
    manifest.retry_policy.length === 0
  )
    errors.push('RETRY_WINDOWS_POLICY_INVALID');
  return errors;
}

function stratumFor(entry: Gate0Entry): Gate0Stratum | null {
  if (entry.primary_stratum === 'no_or_late_captions')
    return entry.tracks.length === 0 ? 'no_or_late_captions' : null;
  if (entry.primary_stratum === 'other')
    return entry.tracks.some((track) => {
      const language = track.language.split('-')[0];
      return (
        language !== undefined && !['en', 'pl'].includes(language.toLowerCase())
      );
    })
      ? 'other'
      : null;
  const [language, kind] = entry.primary_stratum.split('_');
  return entry.tracks.some((track) => {
    const trackLanguage = track.language.split('-')[0];
    return (
      trackLanguage !== undefined &&
      trackLanguage.toLowerCase() === language &&
      track.kind === kind
    );
  })
    ? entry.primary_stratum
    : null;
}

function readJson<T>(path: string): T {
  const source = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(source) as T;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function report(result: string, manifest: Gate0Manifest, errors: string[]): void {
  console.log(
    JSON.stringify({
      result,
      status: manifest.status,
      video_count: manifest.entries.length,
      channel_count: new Set(manifest.entries.map((entry) => entry.channel_id))
        .size,
      hash: manifest.status === 'FROZEN' ? gate0ManifestHash(manifest) : null,
      errors,
    }),
  );
}

function runCli(): void {
  const [command = 'validate', manifestArg, inventoryArg] =
    process.argv.slice(2);
  const manifestPath = resolve(
    manifestArg ?? 'docs/verification/gate-0/MANIFEST.json',
  );
  const inventoryPath = resolve(
    inventoryArg ?? inventoryRelativePath,
  );
  let manifest = readJson<Gate0Manifest>(manifestPath);

  if (command === 'prepare') {
    const inventory = readJson<Gate0PlayerTrackInventory>(inventoryPath);
    const inventoryErrors = validateGate0PlayerTrackInventory(
      inventory,
      manifest.as_of,
    );
    if (manifest.status !== 'DRAFT') inventoryErrors.push('PREPARE_REQUIRES_DRAFT');
    if (manifest.entry_criteria.first_measurement_started)
      inventoryErrors.push('MEASUREMENT_ALREADY_STARTED');
    manifest = prepareGate0Manifest(manifest, inventory);
    const errors = [
      ...inventoryErrors,
      ...validateGate0Manifest(manifest),
      ...validateGate0InventoryReferences(manifest, inventory),
    ];
    if (errors.length) {
      report('NOT_READY', manifest, errors);
      process.exitCode = 2;
      return;
    }
    writeJson(manifestPath, manifest);
    report('PREPARED', manifest, []);
    return;
  }

  if (command === 'freeze') {
    const inventory = readJson<Gate0PlayerTrackInventory>(inventoryPath);
    const errors = [
      ...validateGate0PlayerTrackInventory(inventory, manifest.as_of),
      ...validateGate0InventoryReferences(manifest, inventory),
      ...validateGate0Manifest(manifest),
    ];
    if (manifest.status !== 'DRAFT') errors.push('FREEZE_REQUIRES_DRAFT');
    if (manifest.entry_criteria.first_measurement_started)
      errors.push('MEASUREMENT_ALREADY_STARTED');
    if (errors.length) {
      report('NOT_READY', manifest, errors);
      process.exitCode = 2;
      return;
    }
    manifest.status = 'FROZEN';
    manifest.frozen_at = new Date().toISOString();
    manifest.sha256 = null;
    manifest.sha256 = gate0ManifestHash(manifest);
    const freezeErrors = validateGate0Manifest(manifest);
    if (freezeErrors.length) {
      report('NOT_READY', manifest, freezeErrors);
      process.exitCode = 2;
      return;
    }
    writeJson(manifestPath, manifest);
    report('PASS', manifest, []);
    return;
  }

  if (command === 'plan') {
    const inventory = readJson<Gate0PlayerTrackInventory>(inventoryPath);
    const errors = [
      ...validateGate0PlayerTrackInventory(inventory, manifest.as_of),
      ...validateGate0InventoryReferences(manifest, inventory),
      ...validateGate0Manifest(manifest),
    ];
    if (manifest.status !== 'FROZEN') errors.push('DRY_RUN_REQUIRES_FROZEN_MANIFEST');
    if (errors.length) {
      report('NOT_READY', manifest, errors);
      process.exitCode = 2;
      return;
    }
    const plan = buildGate0DryRunRequestPlan(manifest);
    writeJson(resolve('docs/verification/gate-0/REQUEST_PLAN.json'), plan);
    report('DRY_RUN_READY', manifest, []);
    return;
  }

  if (command === 'validate') {
    const inventory = readJson<Gate0PlayerTrackInventory>(inventoryPath);
    const errors = [
      ...validateGate0PlayerTrackInventory(inventory, manifest.as_of),
      ...validateGate0InventoryReferences(manifest, inventory),
      ...validateGate0Manifest(manifest),
    ];
    const result =
      errors.length > 0
        ? 'NOT_READY'
        : manifest.status === 'FROZEN'
          ? 'PASS'
          : 'READY_FOR_FREEZE';
    report(result, manifest, errors);
    if (errors.length || manifest.status !== 'FROZEN') process.exitCode = 2;
    return;
  }

  console.error('Usage: transcript-bench.ts <prepare|freeze|plan|validate> [manifest-path] [inventory-path]');
  process.exitCode = 2;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/transcript-bench.ts'))
  runCli();
