import type {
  SourceItemRef,
  TranscriptProvider,
  TranscriptRequestContext,
  TranscriptStatus,
  TrackRef,
  TranscriptSegment,
} from '../../../../contracts/src/transcript.js';
import { boundedText } from '../../http/bounded-text.js';
import { fetchWithoutRedirect } from '../../http/no-redirect.js';
import { sha256 } from '../../auth/crypto.js';
export const webCaptionProviderVersion = 'youtube-web-captions:1';
class WebCaptionFailure extends Error {
  constructor(
    readonly status: TranscriptStatus,
    readonly code: string,
  ) {
    super(code);
  }
}
/** Parse a complete player JSON object without eval, scripts or a DOM. */
export function playerFromWatchPage(html: string): Record<string, unknown> {
  const marker =
    /(?:var\s+ytInitialPlayerResponse\s*=|ytInitialPlayerResponse\s*=|"ytInitialPlayerResponse"\s*:)\s*\{/.exec(
      html,
    );
  if (!marker)
    throw new WebCaptionFailure('UPSTREAM_CHANGED', 'PLAYER_METADATA_MISSING');
  const start = marker.index + marker[0].length - 1;
  let level = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '{') level++;
    else if (c === '}' && --level === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1)) as Record<string, unknown>;
      } catch {
        throw new WebCaptionFailure('PARSE_ERROR', 'INVALID_PLAYER_JSON');
      }
    }
  }
  throw new WebCaptionFailure('PARTIAL', 'INCOMPLETE_PLAYER_JSON');
}
/** Preserve every source-bearing JSON3 event. No text normalization or prefix
 * recovery. Unknown timing/control events cannot masquerade as a full result. */
export function parseWebCaptionJson3(text: string): TranscriptSegment[] {
  if (!text.trim())
    throw new WebCaptionFailure('UPSTREAM_CHANGED', 'EMPTY_CAPTION_RESPONSE');
  let body: {
    events?: {
      tStartMs?: number;
      dDurationMs?: number;
      segs?: { utf8?: string }[];
    }[];
  };
  try {
    body = JSON.parse(text);
  } catch {
    throw new WebCaptionFailure('PARSE_ERROR', 'INVALID_CAPTION_JSON');
  }
  if (!Array.isArray(body.events) || body.events.length > 100000)
    throw new WebCaptionFailure('PARSE_ERROR', 'INVALID_CAPTION_EVENTS');
  const segments: TranscriptSegment[] = [];
  for (const [index, event] of body.events.entries()) {
    if (!event || typeof event !== 'object')
      throw new WebCaptionFailure('PARSE_ERROR', 'INVALID_CAPTION_EVENT');
    if (event.segs === undefined) continue; // non-text window/style control
    if (
      !Array.isArray(event.segs) ||
      event.segs.some((s) => !s || typeof s.utf8 !== 'string')
    )
      throw new WebCaptionFailure('PARTIAL', 'INVALID_CAPTION_SEGMENTS');
    const value = event.segs.map((s) => s.utf8).join('');
    if (!value.trim()) continue; // raw payload still preserves control/newline events
    if (
      !Number.isSafeInteger(event.tStartMs) ||
      event.tStartMs! < 0 ||
      !Number.isSafeInteger(event.dDurationMs) ||
      event.dDurationMs! < 0 ||
      !Number.isSafeInteger(event.tStartMs! + event.dDurationMs!)
    )
      throw new WebCaptionFailure('PARTIAL', 'INCOMPLETE_CAPTION_TIMING');
    segments.push({
      upstream_index: index,
      start_ms: event.tStartMs!,
      end_ms: event.tStartMs! + event.dDurationMs!,
      text: value,
      speaker_label: null,
    });
  }
  if (!segments.length)
    throw new WebCaptionFailure('UPSTREAM_CHANGED', 'EMPTY_CAPTION_RESPONSE');
  return segments;
}
/** Anonymous browser-published captions only. Requests stop on consent, login,
 * 403, 429, bot detection and geography restrictions. No alternate identities,
 * private cookies, proxies, attestation, translation or scraping services.
 * Experimental until an ACTUAL_CLOUDFLARE_FREE qualification is recorded. */
export class YouTubeWebCaptionProvider implements TranscriptProvider {
  private tracks = new Map<string, string>();
  lastResponse: {
    http_status: number;
    byte_count: number;
    content_type: string | null;
    format: string;
  } | null = null;
  sourceMetadata: {
    video_id: string;
    youtube_url: string;
    title: string;
    original_language: string | null;
  } | null = null;
  constructor(private transport: typeof fetch = fetch) {}
  capabilities(runtime: 'local' | 'cloud') {
    return {
      provider_id: 'youtube_public_web',
      provider_version: webCaptionProviderVersion,
      runtime_id: runtime,
      track_listing: true,
      manual_flags: true,
      generated_flags: true,
      languages: 'upstream' as const,
      timestamps: ['CUE'] as const,
      youtube_translation: false,
      stt: false,
      max_input_bytes: 4 * 1024 * 1024,
      free_eligibility: false,
      paid_services_enabled: false as const,
    };
  }
  private validate(item: SourceItemRef, context: TranscriptRequestContext) {
    if (
      item.namespace !== 'youtube' ||
      !/^[A-Za-z0-9_-]{11}$/.test(item.external_id) ||
      context.item_id !== item.item_id ||
      context.provider_version !== webCaptionProviderVersion ||
      !Number.isSafeInteger(context.max_bytes) ||
      context.max_bytes < 1 ||
      context.max_bytes > 4 * 1024 * 1024 ||
      !Number.isFinite(Date.parse(context.deadline)) ||
      Date.parse(context.deadline) <= Date.now()
    )
      throw new WebCaptionFailure('PARSE_ERROR', 'INVALID_PROVIDER_INPUT');
  }
  private async request(
    url: string,
    maximum: number,
    context: TranscriptRequestContext,
  ) {
    const target = new URL(url);
    if (
      target.origin !== 'https://www.youtube.com' ||
      !['/watch', '/api/timedtext'].includes(target.pathname) ||
      target.username ||
      target.password ||
      target.searchParams.has('tlang')
    )
      throw new WebCaptionFailure('PARSE_ERROR', 'UNSUPPORTED_CAPTION_ORIGIN');
    const response = await fetchWithoutRedirect(
      url,
      {
        signal: AbortSignal.timeout(
          Math.max(
            1,
            Math.min(30000, Date.parse(context.deadline) - Date.now()),
          ),
        ),
      },
      this.transport,
    ).catch(() => {
      throw new WebCaptionFailure(
        'TEMPORARY_FAILURE',
        'NETWORK_OR_REDIRECT_HOLD',
      );
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new WebCaptionFailure(
        response.status === 429
          ? 'RATE_LIMITED'
          : response.status === 403
            ? 'IP_BLOCKED'
            : response.status === 404
              ? 'UNAVAILABLE'
              : response.status >= 500
                ? 'TEMPORARY_FAILURE'
                : 'AUTH_REQUIRED',
        'HTTP_' + response.status,
      );
    }
    try {
      const text = await boundedText(response, maximum);
      this.lastResponse = {
        http_status: response.status,
        byte_count: new TextEncoder().encode(text).length,
        content_type: response.headers.get('Content-Type'),
        format: !text.trim()
          ? 'EMPTY'
          : text.trimStart().startsWith('{')
            ? 'JSON'
            : text.trimStart().startsWith('<')
              ? 'MARKUP'
              : 'OTHER',
      };
      return text;
    } catch (error) {
      throw new WebCaptionFailure(
        error instanceof Error && error.message === 'RESPONSE_BODY_TOO_LARGE'
          ? 'TOO_LARGE'
          : 'PARSE_ERROR',
        'CAPTION_BODY_HOLD',
      );
    }
  }
  async list_tracks(item: SourceItemRef, context: TranscriptRequestContext) {
    const base = {
      provider_id: 'youtube_public_web',
      provider_version: webCaptionProviderVersion,
      runtime_id: context.runtime_id,
      retrieved_at: new Date().toISOString(),
      request_id: context.request_id,
    };
    this.tracks.clear();
    this.sourceMetadata = null;
    try {
      this.validate(item, context);
      const html = await this.request(
        'https://www.youtube.com/watch?v=' + item.external_id,
        2 * 1024 * 1024,
        context,
      );
      if (/(?:g-recaptcha|\/sorry\/index|unusual traffic)/i.test(html))
        throw new WebCaptionFailure('IP_BLOCKED', 'BOT_DETECTION');
      if (html.includes('https://consent.youtube.com/s'))
        throw new WebCaptionFailure('AUTH_REQUIRED', 'CONSENT_REQUIRED');
      const player = playerFromWatchPage(html) as {
        playabilityStatus?: { status?: string; reason?: string };
        videoDetails?: {
          videoId?: string;
          title?: string;
          defaultAudioLanguage?: string;
        };
        captions?: {
          playerCaptionsTracklistRenderer?: {
            captionTracks?: {
              baseUrl?: string;
              vssId?: string;
              languageCode?: string;
              kind?: string;
            }[];
          };
        };
      };
      const status = player.playabilityStatus;
      if (!status?.status)
        throw new WebCaptionFailure('UPSTREAM_CHANGED', 'PLAYABILITY_UNKNOWN');
      if (status.status !== 'OK') {
        if (/confirm.*not a bot/i.test(status.reason ?? ''))
          throw new WebCaptionFailure('IP_BLOCKED', 'REQUEST_BLOCKED');
        throw new WebCaptionFailure(
          status.status === 'LOGIN_REQUIRED'
            ? 'AUTH_REQUIRED'
            : /country|region/i.test(status.reason ?? '')
              ? 'REGION_BLOCKED'
              : 'UNAVAILABLE',
          'PLAYABILITY_' + status.status.replace(/[^A-Z_]/g, '').slice(0, 30),
        );
      }
      if (player.videoDetails?.videoId !== item.external_id)
        throw new WebCaptionFailure('UPSTREAM_CHANGED', 'VIDEO_ID_MISMATCH');
      const language = player.videoDetails.defaultAudioLanguage ?? null;
      if (
        language !== null &&
        !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{1,8})*$/.test(language)
      )
        throw new WebCaptionFailure('PARSE_ERROR', 'INVALID_ORIGINAL_LANGUAGE');
      this.sourceMetadata = {
        video_id: item.external_id,
        youtube_url: 'https://www.youtube.com/watch?v=' + item.external_id,
        title: player.videoDetails.title ?? '',
        original_language: language,
      };
      const available =
        player.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (
        available === undefined ||
        (Array.isArray(available) && !available.length)
      )
        return {
          ...base,
          status: 'NO_CAPTIONS' as const,
          failure_code: 'NO_PUBLISHED_CAPTION_TRACKS',
          tracks: [],
          video_language: language,
        };
      if (!Array.isArray(available))
        throw new WebCaptionFailure('PARSE_ERROR', 'INVALID_TRACK_LIST');
      const tracks: TrackRef[] = available.map((t, index) => {
        if (
          typeof t.baseUrl !== 'string' ||
          !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{1,8})*$/.test(t.languageCode ?? '') ||
          (t.kind !== undefined && t.kind !== 'asr')
        )
          throw new WebCaptionFailure('PARSE_ERROR', 'INVALID_TRACK');
        const u = new URL(t.baseUrl);
        if (
          u.origin !== 'https://www.youtube.com' ||
          u.pathname !== '/api/timedtext' ||
          u.searchParams.has('tlang') ||
          u.searchParams.get('v') !== item.external_id
        )
          throw new WebCaptionFailure(
            'PARSE_ERROR',
            'UNSUPPORTED_CAPTION_ORIGIN',
          );
        u.searchParams.set('fmt', 'json3');
        const id = 'web:' + item.external_id + ':' + index;
        this.tracks.set(id, u.toString());
        return {
          track_id: id,
          item_id: item.item_id,
          language_code: t.languageCode!,
          track_kind: t.kind === 'asr' ? 'GENERATED' : 'MANUAL',
          is_generated: t.kind === 'asr',
          is_translated: false,
          source_language: t.languageCode!,
          translation_source_track_id: null,
          is_translatable: false,
          translation_languages: [],
          is_original: language
            ? t.languageCode!.toLowerCase().split('-')[0] ===
              language.toLowerCase().split('-')[0]
            : null,
          extension: 'json3',
          expires_at: context.deadline,
        };
      });
      return {
        ...base,
        status: 'OK' as const,
        failure_code: null,
        tracks,
        video_language: language,
      };
    } catch (error) {
      const failure =
        error instanceof WebCaptionFailure
          ? error
          : new WebCaptionFailure('PARSE_ERROR', 'INVALID_PROVIDER_RESPONSE');
      return {
        ...base,
        status: failure.status,
        failure_code: failure.code,
        tracks: [],
        video_language: null,
      };
    }
  }
  async fetch(
    item: SourceItemRef,
    track: TrackRef,
    context: TranscriptRequestContext,
  ) {
    const base = {
      provider_id: 'youtube_public_web',
      provider_version: webCaptionProviderVersion,
      runtime_id: context.runtime_id,
      upstream_track_id: track.track_id,
      language_code: track.language_code,
      language_detection_method: 'PUBLISHED_CAPTION_METADATA',
      track_kind: track.track_kind,
      is_generated: track.is_generated,
      is_translated: false,
      source_language: track.language_code,
      translation_source_track_id: null,
      is_translatable: false,
      translation_languages: [],
      raw_artifact_id: null,
      retrieved_at: new Date().toISOString(),
      timestamp_precision: 'CUE' as const,
      request_id: context.request_id,
      warnings: [],
      missing_ranges: [],
      retry_after: null,
    };
    try {
      this.validate(item, context);
      const url = this.tracks.get(track.track_id);
      if (
        !url ||
        track.item_id !== item.item_id ||
        track.is_translated !== false ||
        Date.parse(track.expires_at) <= Date.now()
      )
        throw new WebCaptionFailure(
          'UPSTREAM_CHANGED',
          'TRACK_EXPIRED_OR_UNKNOWN',
        );
      if (new URL(url).searchParams.get('exp') === 'xpe')
        throw new WebCaptionFailure(
          'AUTH_REQUIRED',
          'PROOF_OF_ORIGIN_REQUIRED',
        );
      const text = await this.request(url, context.max_bytes, context),
        segments = parseWebCaptionJson3(text);
      return {
        raw_payload: new TextEncoder().encode(text),
        result: {
          ...base,
          status: 'OK' as const,
          failure_code: null,
          segments,
          raw_payload_hash: await sha256(text),
          duration_covered_ms: segments.reduce(
            (last, s) => Math.max(last, s.end_ms!),
            0,
          ),
          usage: {
            upstream_requests: 1,
            bytes_received: new TextEncoder().encode(text).length,
          },
        },
      };
    } catch (error) {
      const failure =
        error instanceof WebCaptionFailure
          ? error
          : new WebCaptionFailure('PARSE_ERROR', 'INVALID_PROVIDER_RESPONSE');
      return {
        raw_payload: null,
        result: {
          ...base,
          status: failure.status,
          failure_code: failure.code,
          segments: [],
          raw_payload_hash: null,
          duration_covered_ms: null,
          usage: { upstream_requests: 1, bytes_received: null },
        },
      };
    }
  }
}
