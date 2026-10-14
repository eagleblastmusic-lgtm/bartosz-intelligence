import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  TranscriptProvider,
  TranscriptCapabilities,
  TranscriptRequestContext,
  SourceItemRef,
  TrackRef,
  TrackListResult,
  TranscriptResult,
  TranscriptFetch,
  TrackKind,
  TranscriptSegment,
  TranscriptStatus,
} from '../../../../packages/contracts/src/transcript.js';
import { transcriptStatuses } from '../../../../packages/contracts/src/transcript.js';
export const ytdlpProviderVersion = 'yt-dlp@2026.08.19+yt-dlp-ejs@0.8.0';
type ProcessInput = {
  operation: 'list' | 'fetch';
  item_id: string;
  video_id: string;
  max_bytes: number;
  language_code?: string;
  track_kind?: TrackKind;
  extension?: string;
};
export type CaptionProcessRunner = (
  input: ProcessInput,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<unknown>;
export { runner as runYtdlpProcess };
const digest = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export function captionProcessRunner(options: {
  python: string;
  pythonPath?: string;
  deno?: string;
  ffmpeg?: string;
  script?: string;
}): CaptionProcessRunner {
  for (const path of [
    options.python,
    options.pythonPath,
    options.deno,
    options.ffmpeg,
    options.script,
  ])
    if (path !== undefined && (!isAbsolute(path) || /[\r\n\0]/.test(path)))
      throw new Error('LOCAL_CAPTION_CONFIGURATION_REQUIRED');
  return async (input, timeoutMs, signal) => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || signal?.aborted)
      throw new Error('LOCAL_CAPTION_PROCESS_FAILURE');
    const inherited: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (
        typeof value === 'string' &&
        value &&
        [
          'PATH',
          'SYSTEMROOT',
          'TEMP',
          'TMP',
          'TMPDIR',
          'DENO_DIR',
          'HOME',
          'USERPROFILE',
          'LOCALAPPDATA',
          'APPDATA',
          'COMSPEC',
          'SYSTEMDRIVE',
          'WINDIR',
        ].includes(key.toUpperCase())
      )
        inherited[key] = value;
    const raw = await new Promise<string>((resolveOutput, reject) => {
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let failed = false,
        size = 0;
      const chunks: Buffer[] = [];
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform === 'linux' && child.pid)
            process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          /* Already exited. */
        }
      };
      const stop = () => {
        kill('SIGTERM');
        killTimer ??= setTimeout(() => kill('SIGKILL'), 2000);
      };
      const child = spawn(
        options.python,
        [
          '-B',
          options.script ?? resolve('apps/executor/python/transcript_ytdlp.py'),
        ],
        {
          windowsHide: true,
          detached: process.platform === 'linux',
          env: {
            ...inherited,
            ...(options.pythonPath ? { PYTHONPATH: options.pythonPath } : {}),
            ...(options.deno ? { BARTOSZ_DENO: options.deno } : {}),
            ...(options.ffmpeg ? { BARTOSZ_FFMPEG: options.ffmpeg } : {}),
            PYTHONNOUSERSITE: '1',
            PYTHONIOENCODING: 'utf-8',
          },
        },
      );
      const timeout = setTimeout(() => {
        failed = true;
        stop();
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        if (failed || signal?.aborted) kill('SIGKILL');
        signal?.removeEventListener('abort', stop);
      };
      child.once('error', () => {
        failed = true;
        cleanup();
        reject(new Error('LOCAL_CAPTION_PROCESS_FAILURE'));
      });
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) {
          failed = true;
          stop();
        } else chunks.push(chunk);
      });
      // Consume and bound stderr without retaining or exposing its content.
      child.stderr.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) {
          failed = true;
          stop();
        }
      });
      child.once('close', (code) => {
        cleanup();
        if (code !== 0 || failed || signal?.aborted)
          reject(new Error('LOCAL_CAPTION_PROCESS_FAILURE'));
        else resolveOutput(Buffer.concat(chunks).toString('utf8'));
      });
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      child.stdin?.on('error', () => {
        failed = true;
        stop();
      });
      child.stdin?.end(JSON.stringify(input));
    });
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('LOCAL_CAPTION_PROCESS_FORMAT');
    }
  };
}
const runner: CaptionProcessRunner = (input, timeoutMs, signal) =>
  captionProcessRunner({
    python: process.env.BARTOSZ_PYTHON ?? '',
    pythonPath: process.env.BARTOSZ_PYTHONPATH,
    deno: process.env.BARTOSZ_DENO,
    ffmpeg: process.env.BARTOSZ_FFMPEG,
  })(input, timeoutMs, signal);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('PARSE_ERROR');
  return value as Record<string, unknown>;
}
function safeString(value: unknown, max = 256) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\u0000-\u001f]/.test(value)
  )
    throw new Error('PARSE_ERROR');
  return value;
}
function nullableBoolean(value: unknown) {
  if (value === null || typeof value === 'boolean') return value;
  throw new Error('PARSE_ERROR');
}
const kinds: TrackKind[] = [
  'MANUAL',
  'GENERATED',
  'TRANSLATED',
  'STT',
  'UNKNOWN',
];
function track(value: unknown, item: SourceItemRef, now: Date): TrackRef {
  const row = object(value),
    language = safeString(row.language_code, 64),
    kind = row.track_kind as TrackKind,
    extension = safeString(row.extension, 16);
  if (!kinds.includes(kind)) throw new Error('PARSE_ERROR');
  const source =
    row.source_language === null ? null : safeString(row.source_language, 64);
  return {
    track_id: digest(
      JSON.stringify([item.item_id, language, kind, extension, source]),
    ),
    item_id: item.item_id,
    language_code: language,
    track_kind: kind,
    is_generated: nullableBoolean(row.is_generated),
    is_translated: nullableBoolean(row.is_translated),
    source_language: source,
    translation_source_track_id: null,
    is_translatable: nullableBoolean(row.is_translatable),
    translation_languages: [],
    is_original: nullableBoolean(row.is_original),
    extension,
    expires_at: new Date(now.getTime() + 10 * 60000).toISOString(),
  };
}
function segment(value: unknown): TranscriptSegment {
  const row = object(value);
  if (
    !Number.isSafeInteger(row.upstream_index) ||
    (row.upstream_index as number) < 0 ||
    typeof row.text !== 'string' ||
    !row.text.trim()
  )
    throw new Error('PARSE_ERROR');
  const start = row.start_ms,
    end = row.end_ms;
  if (
    (start !== null &&
      (!Number.isSafeInteger(start) || (start as number) < 0)) ||
    (end !== null && (!Number.isSafeInteger(end) || (end as number) < 0)) ||
    (start !== null && end !== null && (end as number) < (start as number))
  )
    throw new Error('PARSE_ERROR');
  return {
    upstream_index: row.upstream_index as number,
    start_ms: start as number | null,
    end_ms: end as number | null,
    text: row.text,
    speaker_label:
      row.speaker_label === null ? null : safeString(row.speaker_label, 128),
  };
}
export class YtdlpTranscriptProvider implements TranscriptProvider {
  private busy = false;
  constructor(
    private runProcess: CaptionProcessRunner = runner,
    private clock: () => Date = () => new Date(),
    private processLimitMs = 60000,
  ) {}
  capabilities(runtime: 'local' | 'cloud'): TranscriptCapabilities {
    return {
      provider_id: 'local_ytdlp',
      provider_version: ytdlpProviderVersion,
      runtime_id: runtime,
      track_listing: runtime === 'local',
      manual_flags: runtime === 'local',
      generated_flags: runtime === 'local',
      languages: 'upstream',
      timestamps: ['CUE', 'NONE'],
      youtube_translation: false,
      stt: false,
      max_input_bytes: 4 * 1024 * 1024,
      free_eligibility: runtime === 'local',
      paid_services_enabled: false,
    };
  }
  private async execute(
    item: SourceItemRef,
    context: TranscriptRequestContext & { signal?: AbortSignal },
    input: Omit<ProcessInput, 'video_id' | 'max_bytes' | 'item_id'>,
  ) {
    if (context.runtime_id !== 'local')
      return { status: 'UNAVAILABLE', failure_code: 'LOCAL_EXECUTOR_REQUIRED' };
    if (
      context.item_id !== item.item_id ||
      item.namespace !== 'youtube' ||
      !/^[\w-]{11}$/.test(item.external_id) ||
      context.provider_version !== ytdlpProviderVersion ||
      !Number.isSafeInteger(context.max_bytes) ||
      context.max_bytes < 1 ||
      context.max_bytes > this.capabilities('local').max_input_bytes
    )
      return {
        status: 'TEMPORARY_FAILURE',
        failure_code: 'INVALID_LOCAL_INPUT',
      };
    const deadline = Date.parse(context.deadline),
      remaining = deadline - this.clock().getTime();
    if (!Number.isFinite(deadline) || remaining <= 0)
      return { status: 'TEMPORARY_FAILURE', failure_code: 'DEADLINE_EXCEEDED' };
    if (this.busy)
      return {
        status: 'TEMPORARY_FAILURE',
        failure_code: 'LOCAL_EXECUTOR_BUSY',
      };
    this.busy = true;
    try {
      const response = object(
        await this.runProcess(
          {
            ...input,
            video_id: item.external_id,
            item_id: item.item_id,
            max_bytes: context.max_bytes,
          },
          Math.min(remaining, this.processLimitMs),
          context.signal,
        ),
      );
      if (this.clock().getTime() >= deadline)
        return {
          status: 'TEMPORARY_FAILURE',
          failure_code: 'DEADLINE_EXCEEDED',
        };
      if (!transcriptStatuses.includes(response.status as TranscriptStatus))
        throw new Error('PARSE_ERROR');
      if (
        response.status === 'OK' &&
        (response.provider_version !== '2026.8.19' ||
          !/^3\.(?:12|14)\.\d+$/.test(String(response.python_version)))
      )
        return {
          status: 'TEMPORARY_FAILURE',
          failure_code: 'DEPENDENCY_VERSION_MISMATCH',
        };
      return response;
    } catch {
      return {
        status: 'TEMPORARY_FAILURE',
        failure_code: 'LOCAL_HARNESS_FAILURE',
      };
    } finally {
      this.busy = false;
    }
  }
  async list_tracks(
    item: SourceItemRef,
    context: TranscriptRequestContext & { signal?: AbortSignal },
  ): Promise<TrackListResult> {
    const response = await this.execute(item, context, { operation: 'list' }),
      now = this.clock();
    const common = {
      provider_id: 'local_ytdlp',
      provider_version: ytdlpProviderVersion,
      runtime_id: 'local' as const,
      retrieved_at: now.toISOString(),
      request_id: context.request_id,
    };
    try {
      const status = response.status as TranscriptStatus;
      if (!Array.isArray(response.tracks) && status === 'OK')
        throw new Error('PARSE_ERROR');
      const tracks = Array.isArray(response.tracks)
        ? response.tracks.map((value) => track(value, item, now))
        : [];
      if (status === 'OK' && !tracks.length) throw new Error('PARSE_ERROR');
      return {
        ...common,
        status,
        failure_code:
          response.failure_code === null
            ? null
            : safeString(response.failure_code, 128),
        tracks,
        video_language:
          typeof response.video_language === 'string'
            ? safeString(response.video_language, 64)
            : null,
      };
    } catch {
      return {
        ...common,
        status: 'PARSE_ERROR',
        failure_code: 'TRACK_CONTRACT_INVALID',
        tracks: [],
        video_language: null,
      };
    }
  }
  async fetch(
    item: SourceItemRef,
    selected: TrackRef,
    context: TranscriptRequestContext & { signal?: AbortSignal },
  ): Promise<TranscriptFetch> {
    const empty: TranscriptResult = {
      status: 'UPSTREAM_CHANGED',
      provider_id: 'local_ytdlp',
      provider_version: ytdlpProviderVersion,
      runtime_id: 'local',
      upstream_track_id: selected.track_id,
      language_code: selected.language_code,
      language_detection_method: 'upstream_track_metadata',
      track_kind: selected.track_kind,
      is_generated: selected.is_generated,
      is_translated: selected.is_translated,
      source_language: selected.source_language,
      translation_source_track_id: selected.translation_source_track_id,
      is_translatable: selected.is_translatable,
      translation_languages: selected.translation_languages,
      segments: [],
      raw_payload_hash: null,
      raw_artifact_id: null,
      retrieved_at: this.clock().toISOString(),
      duration_covered_ms: null,
      timestamp_precision: 'NONE',
      failure_code: 'TRACK_REFERENCE_INVALID',
      retry_after: null,
      usage: { upstream_requests: null, bytes_received: null },
      warnings: [],
      missing_ranges: [],
      request_id: context.request_id,
    };
    if (
      selected.item_id !== item.item_id ||
      !Number.isFinite(Date.parse(selected.expires_at)) ||
      selected.expires_at <= this.clock().toISOString()
    )
      return { result: empty, raw_payload: null };
    const response = await this.execute(item, context, {
      operation: 'fetch',
      language_code: selected.language_code,
      track_kind: selected.track_kind,
      extension: selected.extension,
    });
    if (response.status !== 'OK')
      return {
        result: {
          ...empty,
          status: response.status as TranscriptStatus,
          raw_payload_hash:
            typeof response.raw_payload_hash === 'string' &&
            /^[a-f0-9]{64}$/.test(response.raw_payload_hash)
              ? response.raw_payload_hash
              : null,
          usage: {
            upstream_requests: Number.isSafeInteger(response.upstream_requests)
              ? (response.upstream_requests as number)
              : null,
            bytes_received:
              Number.isSafeInteger(response.bytes_received) &&
              Number(response.bytes_received) >= 0
                ? (response.bytes_received as number)
                : null,
          },
          failure_code:
            typeof response.failure_code === 'string' &&
            /^[A-Z0-9_]{1,128}$/.test(response.failure_code)
              ? response.failure_code
              : 'PROVIDER_FAILURE',
        },
        raw_payload: null,
      };
    try {
      if (
        !Array.isArray(response.segments) ||
        !response.segments.length ||
        typeof response.raw_payload_base64 !== 'string' ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(response.raw_payload_base64)
      )
        throw new Error('PARSE_ERROR');
      const raw = Buffer.from(response.raw_payload_base64, 'base64');
      if (raw.length > context.max_bytes)
        return {
          result: {
            ...empty,
            status: 'TOO_LARGE',
            failure_code: 'RESPONSE_SIZE_LIMIT',
          },
          raw_payload: null,
        };
      if (!raw.length || digest(raw) !== response.raw_payload_hash)
        throw new Error('PARSE_ERROR');
      const actual = track(response.selected, item, this.clock());
      if (actual.track_id !== selected.track_id) throw new Error('PARSE_ERROR');
      const segments = response.segments.map(segment);
      if (
        segments.some(
          (value, index) =>
            value.upstream_index !== index ||
            value.start_ms === null ||
            value.end_ms === null,
        )
      )
        throw new Error('PARSE_ERROR');
      const timed = segments.every(
          (value) => value.start_ms !== null && value.end_ms !== null,
        ),
        maxEnd = timed
          ? segments.reduce(
              (maximum, value) => Math.max(maximum, value.end_ms!),
              0,
            )
          : null;
      const warnings: string[] = [];
      if (
        maxEnd !== null &&
        item.duration_ms !== null &&
        maxEnd > item.duration_ms + 1000
      )
        warnings.push('SOURCE_DURATION_OVERRUN');
      if (!timed) warnings.push('NO_TIMESTAMP');
      return {
        result: {
          ...empty,
          status: 'OK',
          failure_code: null,
          segments,
          raw_payload_hash: digest(raw),
          retrieved_at: this.clock().toISOString(),
          timestamp_precision: timed ? 'CUE' : 'NONE',
          duration_covered_ms: maxEnd,
          usage: {
            upstream_requests: Number.isSafeInteger(response.upstream_requests)
              ? (response.upstream_requests as number)
              : null,
            bytes_received: raw.length,
          },
          warnings,
        },
        raw_payload: raw,
      };
    } catch {
      return {
        result: {
          ...empty,
          status: 'PARSE_ERROR',
          failure_code: 'TRANSCRIPT_CONTRACT_INVALID',
        },
        raw_payload: null,
      };
    }
  }
}
