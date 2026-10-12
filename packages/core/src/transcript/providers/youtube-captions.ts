import type {
  SourceItemRef,
  TranscriptProvider,
  TranscriptRequestContext,
  TranscriptStatus,
  TrackRef,
  TranscriptSegment,
} from '../../../../contracts/src/transcript.js';
import { sha256 } from '../../auth/crypto.js';
import { boundedText } from '../../http/bounded-text.js';
import { fetchWithoutRedirect } from '../../http/no-redirect.js';
export const youtubeCaptionProviderVersion = 'youtube-captions-api:v3:1';
class CaptionFailure extends Error {
  constructor(readonly status: TranscriptStatus) {
    super(status);
  }
}
/** Full SRT parsing: malformed or unconsumed blocks fail; never return a prefix. */
export function parseCaptionSrt(source: string): TranscriptSegment[] {
  const blocks = source
    .replace(/^\uFEFF/, '')
    .replaceAll('\r\n', '\n')
    .trimEnd()
    .split(/\n\n+/);
  if (!blocks.length || blocks.length > 100000)
    throw new CaptionFailure('PARSE_ERROR');
  const time = (value: string) => {
    const match = /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/.exec(value);
    if (!match) throw new CaptionFailure('PARSE_ERROR');
    const ms =
      Number(match[1]) * 3600000 +
      Number(match[2]) * 60000 +
      Number(match[3]) * 1000 +
      Number(match[4]);
    if (!Number.isSafeInteger(ms)) throw new CaptionFailure('PARSE_ERROR');
    return ms;
  };
  return blocks.map((block, index) => {
    const match =
      /^\d+\n(\d{2,}:[0-5]\d:[0-5]\d,\d{3}) --> (\d{2,}:[0-5]\d:[0-5]\d,\d{3})\n([\s\S]+)$/.exec(
        block,
      );
    if (!match) throw new CaptionFailure('PARSE_ERROR');
    const start = time(match[1]!),
      end = time(match[2]!);
    if (end < start) throw new CaptionFailure('PARSE_ERROR');
    return {
      upstream_index: index,
      start_ms: start,
      end_ms: end,
      text: match[3]!,
      speaker_label: null,
    };
  });
}
/** Supported Google REST API only. Google enforces permission to edit a video.
 * This cannot retrieve arbitrary third-party captions. No cookies, scraping,
 * proxies, STT or model fallback. Native fetch/WebCrypto, compatible with Workers;
 * actual Free source/CPU qualification and an authorized OAuth grant are separate. */
export class YouTubeCaptionProvider implements TranscriptProvider {
  constructor(
    private accessToken: () => Promise<string>,
    private transport: typeof fetch = fetch,
  ) {}
  capabilities(runtime: 'local' | 'cloud') {
    return {
      provider_id: 'youtube_data_api',
      provider_version: youtubeCaptionProviderVersion,
      runtime_id: runtime,
      track_listing: true,
      manual_flags: true,
      generated_flags: true,
      languages: 'upstream' as const,
      timestamps: ['CUE'] as const,
      youtube_translation: false,
      stt: false,
      max_input_bytes: 4 * 1024 * 1024,
      free_eligibility: true,
      paid_services_enabled: false as const,
    };
  }
  private validate(item: SourceItemRef, context: TranscriptRequestContext) {
    if (
      item.namespace !== 'youtube' ||
      !/^[A-Za-z0-9_-]{11}$/.test(item.external_id) ||
      context.item_id !== item.item_id ||
      context.provider_version !== youtubeCaptionProviderVersion ||
      !Number.isSafeInteger(context.max_bytes) ||
      context.max_bytes < 1 ||
      context.max_bytes > 4 * 1024 * 1024 ||
      !Number.isFinite(Date.parse(context.deadline)) ||
      Date.parse(context.deadline) <= Date.now()
    )
      throw new CaptionFailure('PARSE_ERROR');
  }
  private async request(
    path: string,
    limit: number,
    context: TranscriptRequestContext,
  ) {
    const token = await this.accessToken();
    if (!/^[\x21-\x7e]{1,8192}$/.test(token))
      throw new CaptionFailure('AUTH_REQUIRED');
    const response = await fetchWithoutRedirect(
      'https://www.googleapis.com/youtube/v3/' + path,
      {
        headers: { Authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(
          Math.max(
            1,
            Math.min(60000, Date.parse(context.deadline) - Date.now()),
          ),
        ),
      },
      this.transport,
    ).catch(() => {
      throw new CaptionFailure('TEMPORARY_FAILURE');
    });
    if (!response.ok) {
      const status = response.status;
      let quota = false;
      if (status === 403) {
        try {
          const body = JSON.parse(await boundedText(response, 32768));
          quota =
            body.error?.errors?.some((e: { reason?: string }) =>
              [
                'quotaExceeded',
                'rateLimitExceeded',
                'userRateLimitExceeded',
              ].includes(e.reason ?? ''),
            ) === true;
        } catch {
          /* fixed status only */
        }
      } else await response.body?.cancel();
      throw new CaptionFailure(
        status === 429 || quota
          ? 'RATE_LIMITED'
          : status === 401 || status === 403
            ? 'AUTH_REQUIRED'
            : status === 404
              ? 'UNAVAILABLE'
              : status >= 500
                ? 'TEMPORARY_FAILURE'
                : 'PARSE_ERROR',
      );
    }
    try {
      return await boundedText(response, limit);
    } catch (error) {
      throw new CaptionFailure(
        error instanceof Error && error.message === 'RESPONSE_BODY_TOO_LARGE'
          ? 'TOO_LARGE'
          : 'PARSE_ERROR',
      );
    }
  }
  async list_tracks(item: SourceItemRef, context: TranscriptRequestContext) {
    const base = {
      provider_id: 'youtube_data_api',
      provider_version: youtubeCaptionProviderVersion,
      runtime_id: context.runtime_id,
      retrieved_at: new Date().toISOString(),
      request_id: context.request_id,
    };
    try {
      this.validate(item, context);
      const details = JSON.parse(
        await this.request(
          'videos?part=snippet&id=' + item.external_id,
          65536,
          context,
        ),
      );
      if (
        !Array.isArray(details.items) ||
        details.items.length !== 1 ||
        details.items[0].id !== item.external_id
      )
        throw new CaptionFailure('UNAVAILABLE');
      const videoLanguage =
        details.items[0].snippet?.defaultAudioLanguage ?? null;
      if (
        videoLanguage !== null &&
        (typeof videoLanguage !== 'string' ||
          !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{1,8})*$/.test(videoLanguage))
      )
        throw new CaptionFailure('PARSE_ERROR');
      const listing = JSON.parse(
        await this.request(
          'captions?part=snippet&videoId=' + item.external_id,
          65536,
          context,
        ),
      );
      if (!Array.isArray(listing.items) || listing.nextPageToken)
        throw new CaptionFailure('PARSE_ERROR');
      const tracks: TrackRef[] = [];
      for (const entry of listing.items) {
        const s = entry.snippet;
        if (
          !s ||
          s.videoId !== item.external_id ||
          typeof entry.id !== 'string' ||
          !/^[A-Za-z0-9_-]{1,256}$/.test(entry.id) ||
          typeof s.language !== 'string' ||
          !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{1,8})*$/.test(s.language)
        )
          throw new CaptionFailure('PARSE_ERROR');
        if (
          s.isDraft ||
          s.status !== 'serving' ||
          !['standard', 'ASR'].includes(s.trackKind)
        )
          continue;
        tracks.push({
          track_id: entry.id,
          item_id: item.item_id,
          language_code: s.language,
          track_kind: s.trackKind === 'ASR' ? 'GENERATED' : 'MANUAL',
          is_generated: s.trackKind === 'ASR',
          is_translated: false,
          source_language: s.language,
          translation_source_track_id: null,
          is_translatable: false,
          translation_languages: [],
          is_original: videoLanguage
            ? s.language.toLowerCase().split('-')[0] ===
              videoLanguage.toLowerCase().split('-')[0]
              ? true
              : false
            : null,
          extension: 'srt',
          expires_at: context.deadline,
        });
      }
      return {
        ...base,
        status: tracks.length ? ('OK' as const) : ('NO_CAPTIONS' as const),
        failure_code: null,
        tracks,
        video_language: videoLanguage,
      };
    } catch (error) {
      const status =
        error instanceof CaptionFailure
          ? error.status
          : ('PARSE_ERROR' as const);
      return {
        ...base,
        status,
        failure_code: status,
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
      provider_id: 'youtube_data_api',
      provider_version: youtubeCaptionProviderVersion,
      runtime_id: context.runtime_id,
      upstream_track_id: track.track_id,
      language_code: track.language_code,
      language_detection_method: 'AUTHORIZED_TRACK_METADATA',
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
      if (
        track.item_id !== item.item_id ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(track.track_id) ||
        track.is_translated !== false ||
        track.is_original === false ||
        !['MANUAL', 'GENERATED'].includes(track.track_kind)
      )
        throw new CaptionFailure('PARSE_ERROR');
      const text = await this.request(
          'captions/' + encodeURIComponent(track.track_id) + '?tfmt=srt',
          context.max_bytes,
          context,
        ),
        segments = parseCaptionSrt(text);
      return {
        raw_payload: new TextEncoder().encode(text),
        result: {
          ...base,
          status: 'OK' as const,
          failure_code: null,
          segments,
          raw_payload_hash: await sha256(text),
          duration_covered_ms: segments.at(-1)!.end_ms,
          usage: {
            upstream_requests: 1,
            bytes_received: new TextEncoder().encode(text).length,
          },
        },
      };
    } catch (error) {
      const status =
        error instanceof CaptionFailure
          ? error.status
          : ('PARSE_ERROR' as const);
      return {
        raw_payload: null,
        result: {
          ...base,
          status,
          failure_code: status,
          segments: [],
          raw_payload_hash: null,
          duration_covered_ms: null,
          usage: { upstream_requests: null, bytes_received: null },
        },
      };
    }
  }
}
