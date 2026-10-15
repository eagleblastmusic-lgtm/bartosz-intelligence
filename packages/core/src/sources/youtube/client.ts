import { fetchWithoutRedirect } from '../../http/no-redirect.js';
import { boundedText } from '../../http/bounded-text.js';
type JsonRecord = Record<string, unknown>;
export class YoutubeError extends Error {
  constructor(
    readonly code:
      | 'QUOTA'
      | 'AUTH'
      | 'NOT_FOUND'
      | 'TRANSIENT'
      | 'INVALID_CURSOR'
      | 'PARSER',
    readonly retryAt: string | null = null,
  ) {
    super(code);
  }
}
export class YoutubeClient {
  private used = 0;
  constructor(
    private key: string,
    private budget = 20,
    private fetcher: typeof fetch = fetch,
  ) {
    if (!key || !Number.isInteger(budget) || budget < 1 || budget > 100)
      throw new Error('YOUTUBE_CONFIG_REQUIRED');
  }
  get usage() {
    return {
      requests: this.used,
      estimated_quota_units: this.used,
      remaining_account_quota: null,
    };
  }
  async defaultAudioLanguage(videoId: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new YoutubeError('PARSER');
    const response = await this.get('videos', { part: 'snippet', id: videoId });
    const items = response.items as unknown[];
    if (!items.length) return null;
    if (items.length !== 1) throw new YoutubeError('PARSER');
    const video = record(items[0]);
    if (video.id !== videoId) throw new YoutubeError('PARSER');
    const language = record(video.snippet).defaultAudioLanguage;
    if (language === undefined) return null;
    if (
      typeof language !== 'string' ||
      language.length > 64 ||
      !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language)
    )
      throw new YoutubeError('PARSER');
    return language;
  }
  async get(
    resource: 'channels' | 'videos' | 'playlistItems',
    params: Record<string, string>,
  ): Promise<JsonRecord> {
    if (this.used >= this.budget) throw new YoutubeError('QUOTA');
    const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    url.search = new URLSearchParams(params).toString();
    this.used++;
    let response: Response;
    try {
      response = await fetchWithoutRedirect(
        url.href,
        {
          headers: { 'x-goog-api-key': this.key },
          signal: AbortSignal.timeout(10000),
        },
        this.fetcher,
      );
    } catch {
      throw new YoutubeError('TRANSIENT');
    }
    let raw: string;
    try {
      raw = await boundedText(response, 512000);
    } catch (error) {
      throw new YoutubeError(
        error instanceof Error &&
          ['RESPONSE_BODY_TOO_LARGE', 'RESPONSE_INVALID_UTF8'].includes(
            error.message,
          )
          ? 'PARSER'
          : 'TRANSIENT',
      );
    }
    let body: JsonRecord;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new YoutubeError('PARSER');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new YoutubeError('PARSER');
    if (!response.ok) {
      const error = body.error as
        { errors?: { reason?: string }[] } | undefined;
      const reason = error?.errors?.[0]?.reason;
      if (reason === 'invalidPageToken')
        throw new YoutubeError('INVALID_CURSOR');
      if (
        response.status === 429 ||
        reason === 'quotaExceeded' ||
        reason === 'dailyLimitExceeded'
      ) {
        const after = response.headers.get('Retry-After');
        const seconds = after && /^\d+$/.test(after) ? Number(after) : null;
        throw new YoutubeError(
          'QUOTA',
          seconds !== null
            ? new Date(Date.now() + seconds * 1000).toISOString()
            : null,
        );
      }
      if (response.status === 401 || response.status === 403)
        throw new YoutubeError('AUTH');
      if (response.status === 404) throw new YoutubeError('NOT_FOUND');
      throw new YoutubeError('TRANSIENT');
    }
    if (!Array.isArray(body.items)) throw new YoutubeError('PARSER');
    return body;
  }
}
export function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new YoutubeError('PARSER');
  return value as JsonRecord;
}
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new YoutubeError('PARSER');
  return value;
}
