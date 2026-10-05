export type Gate0SourceStatus =
  | 'OK'
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

export type Gate0TrackKind = 'manual' | 'generated';

export interface PublicCaptionTrack {
  language_code: string;
  kind: Gate0TrackKind;
  name: string;
  is_translatable: boolean;
  vss_id: string | null;
  /** Kept only in memory; never include this field in evidence or logs. */
  base_url: string;
}

export interface Gate0CueSummary {
  start_ms: number;
  end_ms: number;
  text_sha256: string;
}

export interface DirectCaptionsProbeResult {
  schema_version: 'gate0-direct-edge-result-1.0';
  request_id: string;
  video_id: string;
  status: Gate0SourceStatus;
  reason_code: string | null;
  watch_http_status: number | null;
  watch_content_type: string | null;
  watch_retry_after: string | null;
  caption_http_status: number | null;
  caption_content_type: string | null;
  caption_retry_after: string | null;
  player_response_shape: string[];
  track_count: number | null;
  available_tracks: Omit<PublicCaptionTrack, 'base_url'>[];
  selected_track: Omit<PublicCaptionTrack, 'base_url'> | null;
  is_translated_track: boolean | null;
  cue_count: number | null;
  first_cue: Gate0CueSummary | null;
  middle_cue: Gate0CueSummary | null;
  last_cue: Gate0CueSummary | null;
  within_duration: boolean | null;
  watch_response_sha256: string | null;
  caption_response_sha256: string | null;
  upstream_bytes_received: number;
  elapsed_wall_ms: number;
}

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: unknown;
    };
  };
  [key: string]: unknown;
}

interface Json3Event {
  tStartMs?: unknown;
  dDurationMs?: unknown;
  segs?: unknown;
}

const MAX_WATCH_BYTES = 5 * 1024 * 1024;
const MAX_CAPTION_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const WATCH_URL = 'https://www.youtube.com/watch';
const MARKERS = [
  'ytInitialPlayerResponse =',
  'ytInitialPlayerResponse=',
  'window["ytInitialPlayerResponse"] =',
  "window['ytInitialPlayerResponse'] =",
];

export function extractPlayerResponse(html: string): PlayerResponse | null {
  for (const marker of MARKERS) {
    let offset = 0;
    while (offset < html.length) {
      const markerAt = html.indexOf(marker, offset);
      if (markerAt < 0) break;
      const objectAt = html.indexOf('{', markerAt + marker.length);
      if (objectAt < 0) break;
      const objectEnd = findBalancedJsonObjectEnd(html, objectAt);
      if (objectEnd < 0) {
        offset = objectAt + 1;
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(html.slice(objectAt, objectEnd + 1));
        if (isObject(parsed)) return parsed as PlayerResponse;
      } catch {
        offset = objectAt + 1;
      }
    }
  }
  return null;
}

function findBalancedJsonObjectEnd(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return index;
  }
  return -1;
}

export function listPublicCaptionTracks(
  player: PlayerResponse,
): PublicCaptionTrack[] | null {
  const rawTracks =
    player.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (rawTracks === undefined) return [];
  if (!Array.isArray(rawTracks)) return null;
  const tracks: PublicCaptionTrack[] = [];
  for (const raw of rawTracks) {
    if (!isObject(raw)) return null;
    const languageCode = nonEmptyString(raw.languageCode);
    const baseUrl = nonEmptyString(raw.baseUrl);
    const vssId = nonEmptyString(raw.vssId);
    if (!languageCode || !baseUrl) return null;
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      return null;
    }
    if (
      url.protocol !== 'https:' ||
      !['youtube.com', 'www.youtube.com'].includes(url.hostname)
    )
      return null;
    const kind: Gate0TrackKind = raw.kind === 'asr' ? 'generated' : 'manual';
    tracks.push({
      language_code: languageCode,
      kind,
      name: displayText(raw.name),
      is_translatable: raw.isTranslatable === true,
      vss_id: vssId,
      base_url: baseUrl,
    });
  }
  return tracks;
}

export async function parseJson3CaptionCues(
  body: string,
): Promise<Gate0CueSummary[] | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObject(parsed) || !Array.isArray(parsed.events)) return null;
  const cues: Gate0CueSummary[] = [];
  for (const rawEvent of parsed.events as unknown[]) {
    if (!isObject(rawEvent)) return null;
    const event = rawEvent as Json3Event;
    if (!Array.isArray(event.segs)) continue;
    const text = event.segs
      .filter(isObject)
      .map((segment) => nonEmptyString(segment.utf8) ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    if (!isNonNegativeInteger(event.tStartMs)) return null;
    if (!isNonNegativeInteger(event.dDurationMs)) return null;
    const start = event.tStartMs;
    const end = start + event.dDurationMs;
    if (!Number.isSafeInteger(end)) return null;
    cues.push({
      start_ms: start,
      end_ms: end,
      text_sha256: await sha256Text(text),
    });
  }
  return cues;
}

export async function probeDirectCaptions(
  input: {
    video_id: string;
    request_id: string;
    language_code: string;
    kind: Gate0TrackKind;
    duration_seconds: number;
  },
  fetchImpl: typeof fetch = fetch,
  onPhase?: (name: string, event: 'start' | 'end') => void,
): Promise<DirectCaptionsProbeResult> {
  async function phase<T>(
    name: string,
    action: () => T | Promise<T>,
  ): Promise<T> {
    onPhase?.(name, 'start');
    try {
      return await action();
    } finally {
      onPhase?.(name, 'end');
    }
  }
  const startedAt = Date.now();
  const base = emptyResult(input.video_id, input.request_id, startedAt);
  if (!/^[\w-]{11}$/.test(input.video_id))
    return finish(base, startedAt, 'UNAVAILABLE', 'INVALID_VIDEO_ID');
  try {
    const watchUrl = new URL(WATCH_URL);
    watchUrl.searchParams.set('v', input.video_id);
    const watchResponse = await phase('watch_fetch_headers', () =>
      fetchImpl(watchUrl, {
        headers: { accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
      }),
    );
    base.watch_http_status = watchResponse.status;
    base.watch_content_type = contentType(watchResponse);
    base.watch_retry_after = safeResponseHeader(watchResponse, 'retry-after');
    const maxWatchBytes = watchResponse.ok ? MAX_WATCH_BYTES : MAX_ERROR_BYTES;
    const watchBytes = await phase('watch_stream_read_copy', () =>
      readLimited(watchResponse, maxWatchBytes),
    );
    base.upstream_bytes_received += watchBytes.byteLength;
    base.watch_response_sha256 = await phase('watch_sha256', () =>
      sha256Bytes(watchBytes),
    );
    if (!watchResponse.ok)
      return finish(
        base,
        startedAt,
        classifyHttp(watchResponse.status, decodeText(watchBytes)),
        reasonForHttp(watchResponse.status),
      );
    const watchText = await phase('watch_utf8_decode', () =>
      decodeText(watchBytes),
    );
    const player = await phase('watch_player_extract_json', () =>
      extractPlayerResponse(watchText),
    );
    if (!player)
      return finish(base, startedAt, 'PARSE_ERROR', 'PLAYER_RESPONSE_MISSING');
    base.player_response_shape = Object.keys(player).sort();
    const playability = player.playabilityStatus?.status;
    if (playability && playability !== 'OK') {
      const reason = player.playabilityStatus?.reason ?? playability;
      return finish(
        base,
        startedAt,
        classifyPlayability(playability, reason),
        `PLAYABILITY_${playability}`,
      );
    }
    const tracks = await phase('track_normalization', () =>
      listPublicCaptionTracks(player),
    );
    if (tracks === null)
      return finish(base, startedAt, 'UPSTREAM_CHANGED', 'CAPTION_TRACK_SHAPE');
    base.track_count = tracks.length;
    base.available_tracks = tracks.map(publicTrackEvidence);
    if (tracks.length === 0)
      return finish(base, startedAt, 'NO_CAPTIONS', 'EMPTY_PUBLIC_TRACKLIST');
    const selected = selectTrack(tracks, input.language_code, input.kind);
    if (!selected)
      return finish(
        base,
        startedAt,
        'UPSTREAM_CHANGED',
        'SELECTED_TRACK_MISSING',
      );
    base.selected_track = publicTrackEvidence(selected);
    base.is_translated_track = isTranslatedTrack(selected);
    const captionUrl = new URL(selected.base_url);
    captionUrl.searchParams.set('fmt', 'json3');
    const captionResponse = await phase('caption_fetch_headers', () =>
      fetchImpl(captionUrl, {
        headers: { accept: 'application/json,text/plain;q=0.9' },
        redirect: 'follow',
      }),
    );
    base.caption_http_status = captionResponse.status;
    base.caption_content_type = contentType(captionResponse);
    base.caption_retry_after = safeResponseHeader(
      captionResponse,
      'retry-after',
    );
    const captionBytes = await phase('caption_stream_read_copy', () =>
      readLimited(
        captionResponse,
        captionResponse.ok ? MAX_CAPTION_BYTES : MAX_ERROR_BYTES,
      ),
    );
    base.upstream_bytes_received += captionBytes.byteLength;
    base.caption_response_sha256 = await phase('caption_sha256', () =>
      sha256Bytes(captionBytes),
    );
    if (!captionResponse.ok)
      return finish(
        base,
        startedAt,
        classifyHttp(captionResponse.status, decodeText(captionBytes)),
        reasonForHttp(captionResponse.status),
      );
    const cues = await phase('caption_decode_parse_normalize_hash', () =>
      parseJson3CaptionCues(decodeText(captionBytes)),
    );
    if (!cues)
      return finish(base, startedAt, 'PARSE_ERROR', 'CAPTION_JSON3_INVALID');
    if (cues.length === 0)
      return finish(base, startedAt, 'PARSE_ERROR', 'CAPTION_CUES_EMPTY');
    const lastCue = cues.at(-1) ?? null;
    const durationMs = Math.round(input.duration_seconds * 1000);
    base.cue_count = cues.length;
    base.first_cue = cues[0] ?? null;
    base.middle_cue = cues[Math.floor((cues.length - 1) / 2)] ?? null;
    base.last_cue = lastCue;
    base.within_duration =
      lastCue !== null && lastCue.end_ms <= durationMs + 1000;
    if (!base.within_duration)
      return finish(
        base,
        startedAt,
        'PARSE_ERROR',
        'CUE_EXCEEDS_VIDEO_DURATION',
      );
    return finish(base, startedAt, 'OK', null);
  } catch (error) {
    if (error instanceof TooLargeBodyError)
      return finish(base, startedAt, 'TOO_LARGE', 'RESPONSE_SIZE_LIMIT');
    return finish(
      base,
      startedAt,
      'TEMPORARY_FAILURE',
      'NETWORK_OR_RUNTIME_ERROR',
    );
  }
}

function selectTrack(
  tracks: PublicCaptionTrack[],
  languageCode: string,
  kind: Gate0TrackKind,
): PublicCaptionTrack | null {
  const normalized = languageCode.toLowerCase();
  return (
    tracks.find(
      (track) =>
        track.language_code.toLowerCase() === normalized && track.kind === kind,
    ) ??
    tracks.find(
      (track) =>
        track.language_code.toLowerCase().startsWith(`${normalized}-`) &&
        track.kind === kind,
    ) ??
    null
  );
}

function isTranslatedTrack(track: PublicCaptionTrack): boolean {
  try {
    return new URL(track.base_url).searchParams.has('tlang');
  } catch {
    return false;
  }
}

function classifyPlayability(
  status: string,
  reason: string,
): Gate0SourceStatus {
  const normalized = reason.toLowerCase();
  if (status === 'LOGIN_REQUIRED') return 'AUTH_REQUIRED';
  if (normalized.includes('country') || normalized.includes('region'))
    return 'REGION_BLOCKED';
  if (normalized.includes('sign in') || normalized.includes('login'))
    return 'AUTH_REQUIRED';
  if (status === 'UNPLAYABLE' && normalized.includes('not available'))
    return 'UNAVAILABLE';
  return 'UNAVAILABLE';
}

function classifyHttp(status: number, body: string): Gate0SourceStatus {
  const normalized = body.toLowerCase();
  if (status === 429 || status === 420) return 'RATE_LIMITED';
  if (status === 451 || normalized.includes('not available in your country'))
    return 'REGION_BLOCKED';
  if (status === 401 || normalized.includes('sign in to confirm'))
    return 'AUTH_REQUIRED';
  if (status === 403) return 'IP_BLOCKED';
  if (status === 404 || status === 410) return 'UNAVAILABLE';
  if (status >= 500) return 'TEMPORARY_FAILURE';
  return 'UPSTREAM_CHANGED';
}

function reasonForHttp(status: number): string {
  if (status === 429 || status === 420) return 'UPSTREAM_RATE_LIMIT';
  if (status === 403) return 'UPSTREAM_FORBIDDEN';
  if (status === 401) return 'UPSTREAM_AUTH_REQUIRED';
  if (status === 451) return 'UPSTREAM_REGION_RESTRICTED';
  if (status === 404 || status === 410) return 'UPSTREAM_RESOURCE_UNAVAILABLE';
  if (status >= 500) return 'UPSTREAM_5XX';
  return 'UPSTREAM_HTTP_ERROR';
}

export async function readLimited(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes)
    throw new TooLargeBodyError();
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new TooLargeBodyError();
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new TooLargeBodyError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function emptyResult(
  videoId: string,
  requestId: string,
  startedAt: number,
): DirectCaptionsProbeResult {
  return {
    schema_version: 'gate0-direct-edge-result-1.0',
    request_id: requestId,
    video_id: videoId,
    status: 'TEMPORARY_FAILURE',
    reason_code: null,
    watch_http_status: null,
    watch_content_type: null,
    watch_retry_after: null,
    caption_http_status: null,
    caption_content_type: null,
    caption_retry_after: null,
    player_response_shape: [],
    track_count: null,
    available_tracks: [],
    selected_track: null,
    is_translated_track: null,
    cue_count: null,
    first_cue: null,
    middle_cue: null,
    last_cue: null,
    within_duration: null,
    watch_response_sha256: null,
    caption_response_sha256: null,
    upstream_bytes_received: 0,
    elapsed_wall_ms: Date.now() - startedAt,
  };
}

function finish(
  result: DirectCaptionsProbeResult,
  startedAt: number,
  status: Gate0SourceStatus,
  reason: string | null,
): DirectCaptionsProbeResult {
  result.status = status;
  result.reason_code = reason;
  result.elapsed_wall_ms = Math.max(0, Date.now() - startedAt);
  return result;
}

function publicTrackEvidence(
  track: PublicCaptionTrack,
): Omit<PublicCaptionTrack, 'base_url'> {
  const evidence: Partial<PublicCaptionTrack> = { ...track };
  delete evidence.base_url;
  return evidence as Omit<PublicCaptionTrack, 'base_url'>;
}

function displayText(value: unknown): string {
  if (isObject(value)) {
    if (typeof value.simpleText === 'string') return value.simpleText;
    if (Array.isArray(value.runs))
      return value.runs
        .filter(isObject)
        .map((run) => nonEmptyString(run.text) ?? '')
        .join('');
  }
  return '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function contentType(response: Response): string | null {
  return response.headers.get('content-type')?.split(';', 1)[0] ?? null;
}

function safeResponseHeader(response: Response, name: string): string | null {
  const value = response.headers.get(name);
  return value ? value.slice(0, 64) : null;
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  // Pass the exact view: no full-response copy, and no adjacent backing bytes.
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

class TooLargeBodyError extends Error {}
