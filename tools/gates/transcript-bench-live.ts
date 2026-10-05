import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  safePythonProcessFailure,
  PYTHON_MAX_OUTPUT_BYTES,
} from './adapters/python-process-evidence.js';
import {
  buildGate0DryRunRequestPlan,
  gate0ManifestHash,
  validateGate0InventoryReferences,
  validateGate0Manifest,
  validateGate0PlayerTrackInventory,
  type Gate0Manifest,
  type Gate0PlayerTrackInventory,
  type Gate0TranscriptStatus,
} from './transcript-bench.js';

export type Gate0ProviderId =
  'DirectCaptionsEdge' | 'youtube-transcript-api' | 'yt-dlp captions-only';

export type Gate0LiveOperation =
  'list_and_fetch' | 'list_tracks' | 'fetch_track';

export interface Gate0LiveObservation {
  schema_version: 'gate0-live-observation-1.0';
  manifest_sha256: string;
  run_id: string;
  request_id: string;
  provider: Gate0ProviderId;
  runtime: 'Cloudflare Workers Free' | 'local Python 3.14.4';
  provider_version: string;
  window_date: string;
  window_local_time: string;
  video_id: string;
  primary_stratum: string;
  operation: Gate0LiveOperation | 'skipped';
  attempt_number: number;
  started_at: string;
  completed_at: string | null;
  status: Gate0TranscriptStatus | 'ATTEMPT_STARTED' | 'SKIPPED';
  reason_code: string | null;
  retry_earliest_at: string | null;
  request_bytes_sent: number | null;
  response_bytes_received: number | null;
  upstream_bytes_received: number | null;
  raw_response_sha256: string[];
  http_observations: Array<{
    http_status: number | null;
    content_type: string | null;
    retry_after?: string | null;
    date?: string | null;
    bytes_received?: number | null;
    response_sha256?: string | null;
  }>;
  cue_count: number | null;
  elapsed_wall_ms: number | null;
  skip_reason?: string;
  result?: Record<string, unknown>;
}

export interface Gate0LiveSummary {
  corpus_video_denominator: number;
  eligible_video_denominator: number;
  natural_no_caption_videos: number;
  eligible_successes: number;
  eligible_success_rate: number;
  eligible_failures: number;
  eligible_unmeasured: number;
  eligible_inconclusive: number;
  eligible_ip_blocked_videos: number;
  measured_unique_videos: number;
  total_recorded_attempts: number;
  statuses: Record<string, number>;
  errors: string[];
}

export interface Gate0FidelitySummary {
  provider: Gate0ProviderId;
  eligible_video_denominator: number;
  source_reference_available: number;
  provider_successes: number;
  compared_cases: number;
  uncompared_cases: number;
  selected_track_mismatches: number;
  timestamp_boundaries_compared: number;
  timestamp_boundaries_within_tolerance: number;
  timestamp_match_rate: number;
  text_hash_matches: number;
  text_hash_match_rate: number;
  maximum_boundary_delta_ms: number | null;
  p95_boundary_delta_ms: number | null;
  errors: string[];
}

export function gate0ObservationKey(row: Gate0LiveObservation): string {
  return [row.provider, row.video_id, row.operation, row.attempt_number].join(
    '|',
  );
}

export function upsertGate0Observation(
  existingRows: Gate0LiveObservation[],
  incoming: Gate0LiveObservation,
): { rows: Gate0LiveObservation[]; result: 'ADDED' | 'UPDATED' | 'DUPLICATE' } {
  const key = gate0ObservationKey(incoming);
  const index = existingRows.findIndex(
    (row) => gate0ObservationKey(row) === key,
  );
  if (index < 0) return { rows: [...existingRows, incoming], result: 'ADDED' };
  const existing = existingRows[index]!;
  if (stableJson(existing) === stableJson(incoming))
    return { rows: existingRows, result: 'DUPLICATE' };
  if (
    existing.status === 'ATTEMPT_STARTED' ||
    (existing.status === 'SKIPPED' && incoming.status !== 'SKIPPED')
  ) {
    const rows = [...existingRows];
    rows[index] = incoming;
    return { rows, result: 'UPDATED' };
  }
  throw new Error(`RESULT_KEY_CONFLICT:${key}`);
}

export function summarizeGate0LiveObservations(
  manifest: Gate0Manifest,
  observations: Gate0LiveObservation[],
  provider: Gate0ProviderId,
): Gate0LiveSummary {
  const errors: string[] = [];
  const entries = new Map(
    manifest.entries.map((entry) => [entry.video_id, entry]),
  );
  const latestByVideo = new Map<string, Gate0LiveObservation[]>();
  for (const row of observations) {
    if (row.provider !== provider) continue;
    if (!entries.has(row.video_id)) {
      errors.push(`UNKNOWN_VIDEO:${row.video_id}`);
      continue;
    }
    if (row.status === 'ATTEMPT_STARTED' || row.operation === 'skipped')
      continue;
    const rows = latestByVideo.get(row.video_id) ?? [];
    rows.push(row);
    latestByVideo.set(row.video_id, rows);
  }

  const finalStatusByVideo = new Map<string, string>();
  for (const [videoId, rows] of latestByVideo) {
    const entry = entries.get(videoId)!;
    const ordered = rows.sort((left, right) => {
      const operationOrder = (row: Gate0LiveObservation): number =>
        row.operation === 'list_and_fetch'
          ? 2
          : row.operation === 'fetch_track'
            ? 1
            : 0;
      return (
        operationOrder(left) - operationOrder(right) ||
        left.attempt_number - right.attempt_number ||
        left.completed_at!.localeCompare(right.completed_at!)
      );
    });
    const latestProbe = [...ordered]
      .reverse()
      .find((row) => row.operation === 'list_and_fetch');
    const latestFetch = [...ordered]
      .reverse()
      .find((row) => row.operation === 'fetch_track');
    const latestList = [...ordered]
      .reverse()
      .find((row) => row.operation === 'list_tracks');
    const finalRow = latestProbe ?? latestFetch ?? latestList;
    if (!finalRow) continue;
    let status: string = finalRow.status;
    if (finalRow.reason_code === 'LOCAL_ADAPTER_PROCESS_FAILED')
      status = 'INCONCLUSIVE';
    if (finalRow.reason_code === 'PLAYABILITY_LOGIN_REQUIRED')
      status = 'AUTH_REQUIRED';
    if (
      provider !== 'DirectCaptionsEdge' &&
      entry.primary_stratum !== 'no_or_late_captions' &&
      latestList?.status === 'OK' &&
      !latestFetch
    )
      status = 'INCOMPLETE';
    finalStatusByVideo.set(videoId, status);
  }

  const eligible = manifest.entries.filter(
    (entry) => entry.primary_stratum !== 'no_or_late_captions',
  );
  const naturalNoCaptions = manifest.entries.filter(
    (entry) => entry.primary_stratum === 'no_or_late_captions',
  );
  const successes = eligible.filter(
    (entry) => finalStatusByVideo.get(entry.video_id) === 'OK',
  ).length;
  const ipBlocked = eligible.filter(
    (entry) => finalStatusByVideo.get(entry.video_id) === 'IP_BLOCKED',
  ).length;
  const unmeasured = eligible.filter(
    (entry) => !finalStatusByVideo.has(entry.video_id),
  ).length;
  const inconclusive = eligible.filter((entry) =>
    ['INCONCLUSIVE', 'INCOMPLETE'].includes(
      finalStatusByVideo.get(entry.video_id) ?? '',
    ),
  ).length;
  const statuses: Record<string, number> = {};
  for (const status of finalStatusByVideo.values())
    statuses[status] = (statuses[status] ?? 0) + 1;
  const measuredUniqueVideos = finalStatusByVideo.size;
  const totalRecordedAttempts = observations.filter(
    (row) => row.provider === provider && row.status !== 'SKIPPED',
  ).length;
  if (measuredUniqueVideos > manifest.entries.length)
    errors.push('UNIQUE_VIDEO_DENOMINATOR_EXCEEDED');
  return {
    corpus_video_denominator: manifest.entries.length,
    eligible_video_denominator: eligible.length,
    natural_no_caption_videos: naturalNoCaptions.length,
    eligible_successes: successes,
    eligible_success_rate:
      eligible.length === 0 ? 0 : successes / eligible.length,
    eligible_failures: eligible.length - successes - unmeasured - inconclusive,
    eligible_unmeasured: unmeasured,
    eligible_inconclusive: inconclusive,
    eligible_ip_blocked_videos: ipBlocked,
    measured_unique_videos: measuredUniqueVideos,
    total_recorded_attempts: totalRecordedAttempts,
    statuses,
    errors,
  };
}

export function summarizeGate0Fidelity(
  manifest: Gate0Manifest,
  observations: Gate0LiveObservation[],
  provider: Exclude<Gate0ProviderId, 'DirectCaptionsEdge'>,
  toleranceMs = manifest.measurement_policy.timestamps
    .cue_boundary_match_tolerance_ms,
): Gate0FidelitySummary {
  const eligible = manifest.entries.filter(
    (entry) => entry.primary_stratum !== 'no_or_late_captions',
  );
  let sourceReferenceAvailable = 0;
  let providerSuccesses = 0;
  let comparedCases = 0;
  let selectedTrackMismatches = 0;
  let timestampBoundariesCompared = 0;
  let timestampBoundariesWithinTolerance = 0;
  let textHashMatches = 0;
  let textHashComparisons = 0;
  const deltas: number[] = [];
  const errors: string[] = [];

  for (const entry of eligible) {
    const source = latestCompletedRow(
      observations,
      'DirectCaptionsEdge',
      entry.video_id,
      'list_and_fetch',
    );
    const candidate = latestCompletedRow(
      observations,
      provider,
      entry.video_id,
      'fetch_track',
    );
    if (candidate?.status === 'OK') providerSuccesses += 1;
    if (
      source?.status !== 'OK' ||
      source.raw_response_sha256.length < 2 ||
      !isRecord(source.result)
    )
      continue;
    sourceReferenceAvailable += 1;
    if (candidate?.status !== 'OK' || !isRecord(candidate.result)) continue;

    const expectedTrack = entry.tracks[0];
    if (
      !expectedTrack ||
      !resultSelectsTrack(
        source.result,
        expectedTrack.language,
        expectedTrack.kind,
      ) ||
      !resultSelectsTrack(
        candidate.result,
        expectedTrack.language,
        expectedTrack.kind,
      )
    ) {
      selectedTrackMismatches += 1;
      errors.push(`SELECTED_TRACK_MISMATCH:${entry.video_id}`);
      continue;
    }
    const sourceCues = resultBoundaryCues(source.result);
    const candidateCues = resultBoundaryCues(candidate.result);
    if (!sourceCues || !candidateCues) {
      errors.push(`SOURCE_CUE_REFERENCE_MISSING:${entry.video_id}`);
      continue;
    }
    comparedCases += 1;
    for (let index = 0; index < sourceCues.length; index += 1) {
      const sourceCue = sourceCues[index]!;
      const candidateCue = candidateCues[index]!;
      for (const key of ['start_ms', 'end_ms'] as const) {
        const delta = Math.abs(sourceCue[key] - candidateCue[key]);
        deltas.push(delta);
        timestampBoundariesCompared += 1;
        if (delta <= toleranceMs) {
          timestampBoundariesWithinTolerance += 1;
        } else {
          errors.push(
            `TIMESTAMP_BOUNDARY_OUT_OF_TOLERANCE:${entry.video_id}:${index}:${key}`,
          );
        }
      }
      textHashComparisons += 1;
      if (sourceCue.text_sha256 === candidateCue.text_sha256)
        textHashMatches += 1;
    }
  }
  const sortedDeltas = [...deltas].sort((left, right) => left - right);
  const p95Index = Math.max(0, Math.ceil(sortedDeltas.length * 0.95) - 1);
  return {
    provider,
    eligible_video_denominator: eligible.length,
    source_reference_available: sourceReferenceAvailable,
    provider_successes: providerSuccesses,
    compared_cases: comparedCases,
    uncompared_cases: eligible.length - comparedCases,
    selected_track_mismatches: selectedTrackMismatches,
    timestamp_boundaries_compared: timestampBoundariesCompared,
    timestamp_boundaries_within_tolerance: timestampBoundariesWithinTolerance,
    timestamp_match_rate:
      timestampBoundariesCompared === 0
        ? 0
        : timestampBoundariesWithinTolerance / timestampBoundariesCompared,
    text_hash_matches: textHashMatches,
    text_hash_match_rate:
      textHashComparisons === 0 ? 0 : textHashMatches / textHashComparisons,
    maximum_boundary_delta_ms: sortedDeltas.at(-1) ?? null,
    p95_boundary_delta_ms: sortedDeltas[p95Index] ?? null,
    errors,
  };
}

export function retryEarliestAt(
  status: string,
  attemptNumber: number,
  retryAfterValues: Array<string | null | undefined>,
  now: Date,
  random: () => number = Math.random,
): string | null {
  if (attemptNumber >= 4) return null;
  if (status === 'RATE_LIMITED') {
    const retryAfter = retryAfterValues.find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    const minimum = now.getTime() + 60_000;
    if (retryAfter) {
      const asSeconds = Number(retryAfter);
      const parsed = Number.isFinite(asSeconds)
        ? now.getTime() + Math.max(0, asSeconds) * 1000
        : Date.parse(retryAfter);
      if (Number.isFinite(parsed))
        return new Date(Math.max(minimum, parsed)).toISOString();
    }
    return nextScheduledWindowAt(now).toISOString();
  }
  if (status !== 'TEMPORARY_FAILURE') return null;
  const delayCapsMinutes = [1, 5, 20] as const;
  const cap = delayCapsMinutes[attemptNumber - 1];
  if (cap === undefined) return null;
  const boundedRandom = Math.max(0, Math.min(0.999999999, random()));
  const delayMs = Math.max(1000, Math.floor(boundedRandom * cap * 60_000));
  return new Date(now.getTime() + delayMs).toISOString();
}

export function nextScheduledWindowAt(
  now: Date,
  windows: string[] = readJson<Gate0Manifest>(
    'docs/verification/gate-0/MANIFEST.json',
  ).retry_windows_local,
): Date {
  const local = localDateParts(now);
  const candidates = windows
    .map((time) => zonedLocalToUtc(local.date, time))
    .filter((candidate) => candidate.getTime() > now.getTime())
    .sort((left, right) => left.getTime() - right.getTime());
  if (candidates[0]) return candidates[0];
  const tomorrow = addCalendarDays(local.date, 1);
  return zonedLocalToUtc(tomorrow, [...windows].sort()[0]!);
}

export function isCurrentScheduledWindow(
  windowLabel: string,
  now: Date,
): boolean {
  const [date, time] = windowLabel.split('/');
  const local = localDateParts(now);
  return (
    local.date === date &&
    typeof time === 'string' &&
    now.getTime() >= zonedLocalToUtc(date!, time).getTime() &&
    now.getTime() < zonedLocalToUtc(date!, time).getTime() + 60 * 60_000
  );
}

export function loadGate0Observations(path: string): Gate0LiveObservation[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  const rows: Gate0LiveObservation[] = [];
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`RESULTS_JSONL_INVALID_LINE:${index + 1}`);
    }
    if (!isObservation(parsed))
      throw new Error(`RESULTS_SCHEMA_INVALID_LINE:${index + 1}`);
    rows.push(parsed);
  }
  return rows;
}

export function saveGate0Observations(
  path: string,
  rows: Gate0LiveObservation[],
): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const contents = rows.map((row) => JSON.stringify(row)).join('\n');
  writeFileSync(temporaryPath, contents ? `${contents}\n` : '', {
    encoding: 'utf8',
    flag: 'wx',
  });
  renameSync(temporaryPath, path);
}

function localDateParts(date: Date): {
  date: string;
  hour: string;
  minute: string;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: get('hour'),
    minute: get('minute'),
  };
}

function zonedLocalToUtc(date: string, time: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const desiredUtcLike = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  const offsetAtGuess = timezoneOffsetMs(new Date(desiredUtcLike));
  return new Date(desiredUtcLike - offsetAtGuess);
}

function timezoneOffsetMs(date: Date): number {
  const local = localDateParts(date);
  const [year, month, day] = local.date.split('-').map(Number);
  return (
    Date.UTC(
      year!,
      month! - 1,
      day!,
      Number(local.hour),
      Number(local.minute),
    ) - date.getTime()
  );
}

function addCalendarDays(date: string, count: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year!, month! - 1, day! + count));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(',')}}`;
}

function isObservation(value: unknown): value is Gate0LiveObservation {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const row = value as Record<string, unknown>;
  return (
    row.schema_version === 'gate0-live-observation-1.0' &&
    typeof row.provider === 'string' &&
    typeof row.video_id === 'string' &&
    typeof row.operation === 'string' &&
    typeof row.attempt_number === 'number' &&
    typeof row.status === 'string'
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function runCli(): void {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'validate-results') {
    const manifest = readJson<Gate0Manifest>(
      'docs/verification/gate-0/MANIFEST.json',
    );
    const rows = loadGate0Observations(
      args[0] ?? 'docs/verification/gate-0/results.jsonl',
    );
    const summaries = (
      [
        'DirectCaptionsEdge',
        'youtube-transcript-api',
        'yt-dlp captions-only',
      ] as const
    ).map((provider) => ({
      provider,
      summary: summarizeGate0LiveObservations(manifest, rows, provider),
      fidelity:
        provider === 'DirectCaptionsEdge'
          ? null
          : summarizeGate0Fidelity(manifest, rows, provider),
    }));
    console.log(
      JSON.stringify({ result: 'PASS', rows: rows.length, summaries }),
    );
    return;
  }
  if (mode !== 'run') {
    console.error(
      'Usage: transcript-bench-live.ts run --window YYYY-MM-DD/HH:mm [--provider all|DirectCaptionsEdge|youtube-transcript-api|yt-dlp captions-only] [--edge-url http://127.0.0.1:8787] [--results path]',
    );
    process.exitCode = 2;
    return;
  }
  void runWindow(parseArgs(args)).catch((error: unknown) => {
    const code =
      error instanceof Error ? error.message.split(':', 1)[0] : 'RUN_FAILED';
    console.error(code);
    process.exitCode = 2;
  });
}

interface RunOptions {
  window: string;
  provider: 'all' | Gate0ProviderId;
  edgeUrl: string;
  edgeToken: string | null;
  resultsPath: string;
  attemptCap: number;
}

function parseArgs(args: string[]): RunOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key?.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    values.set(key.slice(2), value);
    index += 1;
  }
  const window = values.get('window');
  if (!window || !/^\d{4}-\d{2}-\d{2}\/([01]\d|2[0-3]):[0-5]\d$/.test(window))
    throw new Error('INVALID_WINDOW_LABEL');
  const provider = values.get('provider') ?? 'all';
  if (
    ![
      'all',
      'DirectCaptionsEdge',
      'youtube-transcript-api',
      'yt-dlp captions-only',
    ].includes(provider)
  )
    throw new Error('INVALID_PROVIDER');
  const edgeUrl = values.get('edge-url') ?? 'http://127.0.0.1:8787';
  let parsedEdgeUrl: URL;
  try {
    parsedEdgeUrl = new URL(edgeUrl);
  } catch {
    throw new Error('INVALID_EDGE_URL');
  }
  const loopbackHost = ['127.0.0.1', 'localhost', '[::1]'].includes(
    parsedEdgeUrl.hostname,
  );
  const cloudflarePreviewHost = parsedEdgeUrl.hostname
    .toLowerCase()
    .endsWith('.workers.dev');
  if (
    (!loopbackHost && !cloudflarePreviewHost) ||
    (loopbackHost && !['http:', 'https:'].includes(parsedEdgeUrl.protocol)) ||
    (cloudflarePreviewHost && parsedEdgeUrl.protocol !== 'https:') ||
    parsedEdgeUrl.username ||
    parsedEdgeUrl.password
  )
    throw new Error('EDGE_URL_NOT_ALLOWED');
  return {
    window,
    provider: provider as RunOptions['provider'],
    edgeUrl,
    edgeToken: process.env.GATE0_BENCH_TOKEN ?? null,
    resultsPath: resolve(
      values.get('results') ?? 'docs/verification/gate-0/results.jsonl',
    ),
    attemptCap: 4,
  };
}

async function runWindow(options: RunOptions): Promise<void> {
  const manifestPath = 'docs/verification/gate-0/MANIFEST.json';
  const inventoryPath = 'docs/verification/gate-0/player-track-inventory.json';
  const manifest = readJson<Gate0Manifest>(manifestPath);
  const inventory = readJson<Gate0PlayerTrackInventory>(inventoryPath);
  const requestPlan = readJson<Record<string, unknown>>(
    'docs/verification/gate-0/REQUEST_PLAN.json',
  );
  const errors = [
    ...validateGate0Manifest(manifest),
    ...validateGate0PlayerTrackInventory(inventory, manifest.as_of),
    ...validateGate0InventoryReferences(manifest, inventory),
  ];
  if (manifest.status !== 'FROZEN' || errors.length > 0)
    throw new Error(`MANIFEST_NOT_READY:${errors.join(',')}`);
  const manifestHash = gate0ManifestHash(manifest);
  const expectedPlan = buildGate0DryRunRequestPlan(
    manifest,
    typeof requestPlan['generated_at'] === 'string'
      ? requestPlan['generated_at']
      : 'invalid',
  );
  if (
    requestPlan['manifest_sha256'] !== manifestHash ||
    requestPlan['mode'] !== 'DRY_RUN_NO_NETWORK' ||
    requestPlan['live_requests_executed'] !== false ||
    requestPlan['paid_routes_allowed'] !== false ||
    requestPlan['source_evidence_sha256'] !== manifest.source_evidence_sha256 ||
    !isRecord(requestPlan['windows']) ||
    stableJson(
      (requestPlan['windows'] as Record<string, unknown>)['video_assignments'],
    ) !== stableJson(expectedPlan.windows.video_assignments)
  )
    throw new Error('REQUEST_PLAN_HASH_OR_MODE_MISMATCH');
  if (
    readJson<Record<string, unknown>>('config/defaults.json')
      .paid_services_enabled !== false
  )
    throw new Error('PAID_SERVICES_GUARD_FAILED');
  if (!manifest.retry_windows_local.includes(options.window.split('/')[1]!))
    throw new Error('WINDOW_NOT_PREREGISTERED');
  assertCurrentWindow(options.window, new Date());
  if (
    (options.provider === 'all' || options.provider === 'DirectCaptionsEdge') &&
    !options.edgeToken
  )
    throw new Error('EDGE_RUNNER_TOKEN_REQUIRED');
  const [windowDate, localTime] = options.window.split('/');
  const resultPath = resolve(options.resultsPath);
  const rows = loadGate0Observations(resultPath);
  const providers =
    options.provider === 'all'
      ? ([
          'DirectCaptionsEdge',
          'youtube-transcript-api',
          'yt-dlp captions-only',
        ] as const)
      : [options.provider];
  for (const provider of providers) {
    await runProviderWindow({
      manifest,
      inventory,
      manifestHash,
      rows,
      resultPath,
      provider,
      windowDate: windowDate!,
      localTime: localTime as string,
      edgeUrl: options.edgeUrl,
      edgeToken: options.edgeToken,
      attemptCap: options.attemptCap,
    });
    const localBlocked = rows.some(
      (row) =>
        row.runtime === 'local Python 3.14.4' &&
        row.status === 'IP_BLOCKED' &&
        row.provider !== 'DirectCaptionsEdge',
    );
    if (localBlocked && provider === 'youtube-transcript-api') {
      const skippedProvider = 'yt-dlp captions-only';
      for (const entry of assignedEntries(manifest, options.window)) {
        const attempt = nextAttempt(
          rows,
          skippedProvider,
          entry.video_id,
          'list_tracks',
        );
        const skipped = makeSkippedRow(
          manifestHash,
          windowDate!,
          localTime as string,
          skippedProvider,
          entry.video_id,
          entry.primary_stratum,
          attempt,
          'SHARED_LOCAL_IP_BLOCKED',
        );
        persistObservation(rows, resultPath, skipped);
      }
      break;
    }
  }
  console.log(
    JSON.stringify({
      result: 'WINDOW_RECORDED',
      manifest_sha256: manifestHash,
      window: options.window,
      observation_count: rows.length,
      providers: providers.map((provider) => ({
        provider,
        summary: summarizeGate0LiveObservations(manifest, rows, provider),
      })),
    }),
  );
}

interface ProviderRunArgs {
  manifest: Gate0Manifest;
  inventory: Gate0PlayerTrackInventory;
  manifestHash: string;
  rows: Gate0LiveObservation[];
  resultPath: string;
  provider: Gate0ProviderId;
  windowDate: string;
  localTime: string;
  edgeUrl: string;
  edgeToken: string | null;
  attemptCap: number;
}

async function runProviderWindow(args: ProviderRunArgs): Promise<void> {
  const local = args.provider !== 'DirectCaptionsEdge';
  const blockedLocal =
    local &&
    args.rows.some(
      (row) =>
        row.runtime === 'local Python 3.14.4' && row.status === 'IP_BLOCKED',
    );
  if (blockedLocal) {
    for (const entry of assignedEntries(
      args.manifest,
      `${args.windowDate}/${args.localTime}`,
    )) {
      const attempt = nextAttempt(
        args.rows,
        args.provider,
        entry.video_id,
        'list_tracks',
      );
      persistObservation(
        args.rows,
        args.resultPath,
        makeSkippedRow(
          args.manifestHash,
          args.windowDate,
          args.localTime,
          args.provider,
          entry.video_id,
          entry.primary_stratum,
          attempt,
          'SHARED_LOCAL_IP_BLOCKED',
        ),
      );
    }
    return;
  }
  const cooldown = latestRateLimitCooldown(args.rows, args.provider);
  if (cooldown && new Date(cooldown).getTime() > Date.now()) return;
  const initialEntries = assignedEntries(
    args.manifest,
    `${args.windowDate}/${args.localTime}`,
  );
  const retryEntries = args.manifest.entries.filter((entry) =>
    hasDueTransient(args.rows, args.provider, entry.video_id, Date.now()),
  );
  const work = new Map<string, Gate0Manifest['entries'][number]>();
  for (const entry of [...initialEntries, ...retryEntries])
    work.set(entry.video_id, entry);
  for (const entry of work.values()) {
    if (args.provider === 'DirectCaptionsEdge') {
      await runDirectEntry(args, entry);
      const latest = latestRow(
        args.rows,
        args.provider,
        entry.video_id,
        'list_and_fetch',
      );
      if (latest?.status === 'IP_BLOCKED') break;
      if (latest?.status === 'RATE_LIMITED') break;
      continue;
    }
    const listRow = await runPythonOperation(args, entry, 'list_tracks');
    if (listRow?.status === 'IP_BLOCKED' || listRow?.status === 'RATE_LIMITED')
      break;
    if (listRow?.status !== 'OK' || entry.tracks.length === 0) continue;
    const fetchRow = await runPythonOperation(args, entry, 'fetch_track');
    if (
      fetchRow?.status === 'IP_BLOCKED' ||
      fetchRow?.status === 'RATE_LIMITED'
    )
      break;
  }
}

async function runDirectEntry(
  args: ProviderRunArgs,
  entry: Gate0Manifest['entries'][number],
): Promise<void> {
  const edgeToken = args.edgeToken;
  if (!edgeToken) throw new Error('EDGE_RUNNER_TOKEN_REQUIRED');
  const operation: Gate0LiveOperation = 'list_and_fetch';
  const previous = latestRow(
    args.rows,
    args.provider,
    entry.video_id,
    operation,
  );
  const attempt = previous ? previous.attempt_number + 1 : 1;
  if (previous && !isDueRetry(previous, new Date())) return;
  if (attempt > args.attemptCap) return;
  const input = {
    manifest_sha256: args.manifestHash,
    request_id: requestId(args.provider, entry.video_id, operation, attempt),
    video_id: entry.video_id,
    gate0_runner_token: edgeToken,
    language_code:
      args.inventory.videos[entry.video_id]?.selected_track_evidence
        ?.language_code ??
      entry.tracks[0]?.language ??
      'en',
    kind: entry.tracks[0]?.kind === 'generated' ? 'generated' : 'manual',
    duration_seconds: entry.duration_seconds,
  };
  const start = makeStartedRow(
    args,
    entry,
    operation,
    attempt,
    input.request_id,
  );
  persistObservation(args.rows, args.resultPath, start);
  let raw: Record<string, unknown>;
  const requestBytes = Buffer.byteLength(JSON.stringify(input));
  let responseBytes: number | null = null;
  try {
    const response = await fetch(new URL('/probe', args.edgeUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30_000),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    responseBytes = bytes.byteLength;
    const responseText = new TextDecoder().decode(bytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      parsed = null;
    }
    raw = isRecord(parsed)
      ? parsed
      : { status: 'PARSE_ERROR', reason_code: 'EDGE_RESULT_SHAPE' };
    if (!response.ok) {
      raw = {
        ...raw,
        status: 'TEMPORARY_FAILURE',
        reason_code: `EDGE_HTTP_${response.status}`,
      };
    }
  } catch {
    raw = {
      status: 'TEMPORARY_FAILURE',
      reason_code: 'EDGE_RUNTIME_UNAVAILABLE',
    };
  }
  const completed = completeRow(start, raw, {
    requestBytes,
    responseBytes,
  });
  persistObservation(args.rows, args.resultPath, completed);
}

async function runPythonOperation(
  args: ProviderRunArgs,
  entry: Gate0Manifest['entries'][number],
  operation: 'list_tracks' | 'fetch_track',
): Promise<Gate0LiveObservation | null> {
  const actualProvider = args.provider;
  const previous = latestRow(
    args.rows,
    actualProvider,
    entry.video_id,
    operation,
  );
  const attempt = previous ? previous.attempt_number + 1 : 1;
  if (previous && !isDueRetry(previous, new Date())) return previous;
  if (attempt > args.attemptCap) return previous ?? null;
  const evidence =
    args.inventory.videos[entry.video_id]?.selected_track_evidence;
  const input = {
    provider:
      actualProvider === 'youtube-transcript-api' ? actualProvider : 'yt-dlp',
    operation: operation === 'list_tracks' ? 'list' : 'fetch',
    video_id: entry.video_id,
    request_id: requestId(actualProvider, entry.video_id, operation, attempt),
    language_code: evidence?.language_code ?? entry.tracks[0]?.language ?? 'en',
    kind: entry.tracks[0]?.kind === 'generated' ? 'generated' : 'manual',
    duration_seconds: entry.duration_seconds,
  };
  const start = makeStartedRow(
    args,
    entry,
    operation,
    attempt,
    input.request_id,
  );
  persistObservation(args.rows, args.resultPath, start);
  let raw: Record<string, unknown>;
  const pythonPath = resolve('.tools/gate0-python');
  const env = {
    ...process.env,
    PYTHONPATH: [pythonPath, process.env.PYTHONPATH].filter(Boolean).join(';'),
    PYTHONNOUSERSITE: '1',
    PYTHONIOENCODING: 'utf-8',
  };
  const pythonArgs = [
    'tools/gates/adapters/gate0_python_adapters.py',
    '--provider',
    input.provider,
    '--operation',
    input.operation,
    '--video-id',
    input.video_id,
    '--request-id',
    input.request_id,
    '--language-code',
    input.language_code,
    '--kind',
    input.kind,
    '--duration-seconds',
    String(input.duration_seconds),
  ];
  const requestBytes: number | null = null;
  let responseBytes: number | null = null;
  try {
    const stdout = execFileSync('python', pythonArgs, {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: PYTHON_MAX_OUTPUT_BYTES,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    raw = JSON.parse(stdout.trim()) as Record<string, unknown>;
    responseBytes = Buffer.byteLength(stdout);
  } catch (error) {
    raw = safePythonProcessFailure(error);
  }
  const completed = completeRow(start, raw, { requestBytes, responseBytes });
  persistObservation(args.rows, args.resultPath, completed);
  return completed;
}

function makeStartedRow(
  args: ProviderRunArgs,
  entry: Gate0Manifest['entries'][number],
  operation: Gate0LiveOperation,
  attempt: number,
  requestIdValue: string,
): Gate0LiveObservation {
  return {
    schema_version: 'gate0-live-observation-1.0',
    manifest_sha256: args.manifestHash,
    run_id: `${args.windowDate}-${args.localTime.replace(':', '')}-${args.manifestHash.slice(0, 12)}`,
    request_id: requestIdValue,
    provider: args.provider,
    runtime:
      args.provider === 'DirectCaptionsEdge'
        ? 'Cloudflare Workers Free'
        : 'local Python 3.14.4',
    provider_version: providerVersion(args.provider),
    window_date: args.windowDate,
    window_local_time: args.localTime,
    video_id: entry.video_id,
    primary_stratum: entry.primary_stratum,
    operation,
    attempt_number: attempt,
    started_at: new Date().toISOString(),
    completed_at: null,
    status: 'ATTEMPT_STARTED',
    reason_code: null,
    retry_earliest_at: null,
    request_bytes_sent: null,
    response_bytes_received: null,
    upstream_bytes_received: null,
    raw_response_sha256: [],
    http_observations: [],
    cue_count: null,
    elapsed_wall_ms: null,
  };
}

function completeRow(
  started: Gate0LiveObservation,
  raw: Record<string, unknown>,
  transfer: { requestBytes: number | null; responseBytes: number | null },
): Gate0LiveObservation {
  const completedAt = new Date().toISOString();
  const status = isTranscriptStatus(raw['status'])
    ? raw['status']
    : 'TEMPORARY_FAILURE';
  const rawObservations = Array.isArray(raw['http_observations'])
    ? raw['http_observations']
    : [];
  const httpObservations = rawObservations.filter(isRecord).map((item) => ({
    http_status:
      typeof item['http_status'] === 'number' ? item['http_status'] : null,
    content_type:
      typeof item['content_type'] === 'string' ? item['content_type'] : null,
    retry_after:
      typeof item['retry_after'] === 'string' ? item['retry_after'] : null,
    date: typeof item['date'] === 'string' ? item['date'] : null,
    bytes_received:
      typeof item['bytes_received'] === 'number'
        ? item['bytes_received']
        : null,
    response_sha256:
      typeof item['response_sha256'] === 'string'
        ? item['response_sha256']
        : null,
  }));
  const responseHashes = [
    raw['watch_response_sha256'],
    raw['caption_response_sha256'],
    ...httpObservations.map((item) => item.response_sha256),
  ].filter((hash): hash is string => typeof hash === 'string');
  const retryAfterValues: Array<string | null> = [
    asStringOrNull(raw['watch_retry_after']),
    asStringOrNull(raw['caption_retry_after']),
    ...httpObservations.map((item) => item.retry_after ?? null),
  ];
  const startMs = Date.parse(started.started_at);
  const completedMs = Date.parse(completedAt);
  return {
    ...started,
    completed_at: completedAt,
    status,
    reason_code:
      typeof raw['reason_code'] === 'string' ? raw['reason_code'] : null,
    retry_earliest_at: retryEarliestAt(
      status,
      started.attempt_number,
      retryAfterValues,
      new Date(completedAt),
    ),
    request_bytes_sent: transfer.requestBytes,
    response_bytes_received: transfer.responseBytes,
    upstream_bytes_received:
      typeof raw['upstream_bytes_received'] === 'number'
        ? raw['upstream_bytes_received']
        : httpObservations.reduce(
            (sum, item) => sum + (item.bytes_received ?? 0),
            0,
          ),
    raw_response_sha256: responseHashes,
    http_observations: httpObservations,
    cue_count: typeof raw['cue_count'] === 'number' ? raw['cue_count'] : null,
    elapsed_wall_ms:
      typeof raw['elapsed_wall_ms'] === 'number'
        ? raw['elapsed_wall_ms']
        : Math.max(0, completedMs - startMs),
    result: raw,
  };
}

function makeSkippedRow(
  manifestHash: string,
  windowDate: string,
  localTime: string,
  provider: Gate0ProviderId,
  videoId: string,
  stratum: string,
  attempt: number,
  reason: string,
): Gate0LiveObservation {
  const now = new Date().toISOString();
  return {
    schema_version: 'gate0-live-observation-1.0',
    manifest_sha256: manifestHash,
    run_id: `${windowDate}-${localTime.replace(':', '')}-${manifestHash.slice(0, 12)}`,
    request_id: requestId(provider, videoId, 'skipped', attempt),
    provider,
    runtime:
      provider === 'DirectCaptionsEdge'
        ? 'Cloudflare Workers Free'
        : 'local Python 3.14.4',
    provider_version: providerVersion(provider),
    window_date: windowDate,
    window_local_time: localTime,
    video_id: videoId,
    primary_stratum: stratum,
    operation: 'skipped',
    attempt_number: attempt,
    started_at: now,
    completed_at: now,
    status: 'SKIPPED',
    reason_code: reason,
    retry_earliest_at: null,
    request_bytes_sent: null,
    response_bytes_received: null,
    upstream_bytes_received: 0,
    raw_response_sha256: [],
    http_observations: [],
    cue_count: null,
    elapsed_wall_ms: 0,
    skip_reason: reason,
  };
}

function persistObservation(
  rows: Gate0LiveObservation[],
  path: string,
  incoming: Gate0LiveObservation,
): void {
  const updated = upsertGate0Observation(rows, incoming);
  if (updated.result === 'DUPLICATE') return;
  rows.splice(0, rows.length, ...updated.rows);
  saveGate0Observations(path, rows);
}

function assignedEntries(
  manifest: Gate0Manifest,
  windowLabel: string,
): Gate0Manifest['entries'] {
  const plan = readJson<{
    windows?: { video_assignments?: Record<string, string> };
  }>('docs/verification/gate-0/REQUEST_PLAN.json');
  const assignments = plan.windows?.video_assignments ?? {};
  const [, localTime] = windowLabel.split('/');
  return manifest.entries.filter(
    (entry) => assignments[entry.video_id] === localTime,
  );
}

function latestRow(
  rows: Gate0LiveObservation[],
  provider: Gate0ProviderId,
  videoId: string,
  operation: Gate0LiveOperation,
): Gate0LiveObservation | undefined {
  return rows
    .filter(
      (row) =>
        row.provider === provider &&
        row.video_id === videoId &&
        row.operation === operation &&
        row.status !== 'SKIPPED',
    )
    .sort((left, right) => left.attempt_number - right.attempt_number)
    .at(-1);
}

function latestCompletedRow(
  rows: Gate0LiveObservation[],
  provider: Gate0ProviderId,
  videoId: string,
  operation: Gate0LiveOperation,
): Gate0LiveObservation | undefined {
  return rows
    .filter(
      (row) =>
        row.provider === provider &&
        row.video_id === videoId &&
        row.operation === operation &&
        row.status !== 'SKIPPED' &&
        row.status !== 'ATTEMPT_STARTED',
    )
    .sort((left, right) => left.attempt_number - right.attempt_number)
    .at(-1);
}

function resultSelectsTrack(
  result: Record<string, unknown>,
  language: string,
  kind: string,
): boolean {
  const selected = result['selected_track'];
  if (!isRecord(selected)) return false;
  const selectedLanguage = selected['language_code'];
  const selectedKind = selected['kind'];
  if (typeof selectedLanguage !== 'string' || selectedKind !== kind)
    return false;
  const actual = selectedLanguage.toLowerCase();
  const expected = language.toLowerCase();
  if (!(
    actual === expected ||
    actual.startsWith(`${expected}-`) ||
    expected.startsWith(`${actual}-`)
  ))
    return false;
  return result['is_translated_track'] !== true;
}

function resultBoundaryCues(
  result: Record<string, unknown>,
): Array<{ start_ms: number; end_ms: number; text_sha256: string }> | null {
  const cues = ['first_cue', 'middle_cue', 'last_cue'].map(
    (key) => result[key],
  );
  const isCue = (
    value: unknown,
  ): value is { start_ms: number; end_ms: number; text_sha256: string } => {
    if (!isRecord(value)) return false;
    const start = value['start_ms'];
    const end = value['end_ms'];
    const textHash = value['text_sha256'];
    return (
      typeof start === 'number' &&
      Number.isSafeInteger(start) &&
      typeof end === 'number' &&
      Number.isSafeInteger(end) &&
      start >= 0 &&
      end >= start &&
      typeof textHash === 'string' &&
      /^[a-f0-9]{64}$/.test(textHash)
    );
  };
  return cues.every(isCue)
    ? (cues as Array<{
        start_ms: number;
        end_ms: number;
        text_sha256: string;
      }>)
    : null;
}

function nextAttempt(
  rows: Gate0LiveObservation[],
  provider: Gate0ProviderId,
  videoId: string,
  operation: Gate0LiveOperation,
): number {
  return (
    (latestRow(rows, provider, videoId, operation)?.attempt_number ?? 0) + 1
  );
}

function hasDueTransient(
  rows: Gate0LiveObservation[],
  provider: Gate0ProviderId,
  videoId: string,
  now: number,
): boolean {
  return (['list_and_fetch', 'list_tracks', 'fetch_track'] as const).some(
    (operation) => {
      const latest = latestRow(rows, provider, videoId, operation);
      return latest ? isDueRetry(latest, new Date(now)) : false;
    },
  );
}

function isDueRetry(row: Gate0LiveObservation, now: Date): boolean {
  return (
    (row.status === 'TEMPORARY_FAILURE' || row.status === 'RATE_LIMITED') &&
    row.retry_earliest_at !== null &&
    Date.parse(row.retry_earliest_at) <= now.getTime() &&
    row.attempt_number < 4
  );
}

function latestRateLimitCooldown(
  rows: Gate0LiveObservation[],
  provider: Gate0ProviderId,
): string | null {
  return (
    rows
      .filter(
        (row) =>
          row.provider === provider &&
          row.status === 'RATE_LIMITED' &&
          row.retry_earliest_at !== null,
      )
      .sort((left, right) =>
        (right.retry_earliest_at ?? '').localeCompare(
          left.retry_earliest_at ?? '',
        ),
      )[0]?.retry_earliest_at ?? null
  );
}

function requestId(
  provider: string,
  videoId: string,
  operation: string,
  attempt: number,
): string {
  return sha256(`${provider}|${videoId}|${operation}|${attempt}`).slice(0, 32);
}

function providerVersion(provider: Gate0ProviderId): string {
  if (provider === 'youtube-transcript-api')
    return 'youtube-transcript-api@1.2.4';
  if (provider === 'yt-dlp captions-only')
    return 'yt-dlp@2026.08.19+yt-dlp-ejs@0.8.0';
  const sourceHash = createHash('sha256')
    .update(readFileSync('tools/gates/adapters/direct-captions-core.ts'))
    .update(readFileSync('tools/gates/adapters/direct-captions-edge-worker.ts'))
    .digest('hex');
  return `direct-captions-edge@${sourceHash}`;
}

function assertCurrentWindow(windowLabel: string, now: Date): void {
  if (!isCurrentScheduledWindow(windowLabel, now))
    throw new Error('LIVE_OUTSIDE_SCHEDULED_WINDOW');
}

function isTranscriptStatus(value: unknown): value is Gate0TranscriptStatus {
  return [
    'OK',
    'PARTIAL',
    'NO_CAPTIONS',
    'IP_BLOCKED',
    'RATE_LIMITED',
    'AUTH_REQUIRED',
    'REGION_BLOCKED',
    'UNAVAILABLE',
    'PARSE_ERROR',
    'UPSTREAM_CHANGED',
    'TOO_LARGE',
    'TEMPORARY_FAILURE',
  ].includes(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as T;
}

if (
  process.argv[1]?.replaceAll('\\', '/').endsWith('/transcript-bench-live.ts')
)
  runCli();
