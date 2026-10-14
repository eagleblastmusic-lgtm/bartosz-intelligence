/** Izolowana diagnostyka źródeł. Nie importuje executora, RPC, D1 ani sekretów aplikacji. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseCaptionSrt } from '../../packages/core/src/transcript/providers/youtube-captions.js';
import { parseWebCaptionJson3 } from '../../packages/core/src/transcript/providers/youtube-web.js';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import { boundedText } from '../../packages/core/src/http/bounded-text.js';
import type { TranscriptSegment } from '../../packages/contracts/src/transcript.js';

export const probeVersion = 'source-probe:1';
const LIMIT = 4 * 1024 * 1024;
const hash = (body: string | Uint8Array) =>
  createHash('sha256').update(body).digest('hex');
const formats = [
  'json3',
  'srt',
  'recorded-en',
  'recorded-dom',
  'panel-segments',
  'supadata-native',
] as const;
type Format = (typeof formats)[number];
type Category =
  | 'NONE'
  | 'INVALID_INPUT'
  | 'BLOCKED_INPUT'
  | 'NO_AUTHORIZED_ACCESS'
  | 'AUTH_REQUIRED'
  | 'SOURCE_REFUSED'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'NO_CAPTIONS'
  | 'EMPTY_RESPONSE'
  | 'PARTIAL_RESPONSE'
  | 'PARSER_FAILURE'
  | 'TECHNICAL_FAILURE'
  | 'CANCELLED'
  | 'TOO_LARGE';
export interface ProbeInput {
  video: string;
  operation: 'offline' | 'oembed' | 'supadata-native';
  format?: Format;
  access?: {
    confirmed: boolean;
    method: string;
    content: string;
    free_plan_confirmed?: boolean;
  };
}
export function publicVideoId(input: string) {
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.port)
      throw 0;
    let id: string | null = null;
    if (
      url.hostname === 'youtu.be' &&
      /^\/[A-Za-z0-9_-]{11}$/.test(url.pathname)
    )
      id = url.pathname.slice(1);
    if (
      ['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname)
    ) {
      if (
        url.pathname === '/watch' &&
        url.searchParams.getAll('v').length === 1
      )
        id = url.searchParams.get('v');
      else if (/^\/(shorts|embed)\/[A-Za-z0-9_-]{11}$/.test(url.pathname))
        id = url.pathname.split('/')[2]!;
    }
    if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return id;
  } catch {
    /* Public input only, never include it in an error. */
  }
  throw new Error('INVALID_INPUT');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('PARSER_FAILURE');
  return value as Record<string, unknown>;
}
function language(value: unknown) {
  return typeof value === 'string' &&
    /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{1,8})*$/.test(value)
    ? value
    : null;
}
const integer = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error('PARTIAL_RESPONSE');
  return value as number;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('PARTIAL_RESPONSE');
  return value;
};
function seconds(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('PARTIAL_RESPONSE');
  return integer(Math.round(value * 1000));
}
function millisecondsString(value: unknown) {
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new Error('PARTIAL_RESPONSE');
  return integer(Number(value));
}
function displayText(value: unknown) {
  const row = object(value);
  if (typeof row.simpleText === 'string') return text(row.simpleText);
  if (!Array.isArray(row.runs)) throw new Error('PARTIAL_RESPONSE');
  return text(
    row.runs
      .map((run) => {
        const fragment = object(run).text;
        if (typeof fragment !== 'string') throw new Error('PARTIAL_RESPONSE');
        return fragment;
      })
      .join(''),
  );
}
/** Nie uzupełnia end_ms dla DOM i nie usuwa powtórzeń. */
export function decodeOffline(
  format: Format,
  body: string,
): TranscriptSegment[] {
  if (!formats.includes(format)) throw new Error('INVALID_INPUT');
  if (!body.trim()) throw new Error('EMPTY_RESPONSE');
  if (format === 'json3') return parseWebCaptionJson3(body);
  if (format === 'srt') return parseCaptionSrt(body);
  const data = object(JSON.parse(body));
  const rows = format === 'supadata-native' ? data.content : data.segments;
  if (!Array.isArray(rows)) throw new Error('PARSER_FAILURE');
  if (!rows.length) throw new Error('EMPTY_RESPONSE');
  if (rows.length > 100000) throw new Error('TOO_LARGE');
  return rows.map((value, index) => {
    const row = object(value);
    let start: number, end: number | null, source: string;
    if (format === 'recorded-en') {
      start = seconds(row.start);
      // Dodawanie źródłowego duration, nigdy dystansu do następnego segmentu.
      if (typeof row.duration !== 'number' || row.duration < 0)
        throw new Error('PARTIAL_RESPONSE');
      end = seconds((row.start as number) + row.duration);
      source = text(row.text);
    } else if (format === 'recorded-dom') {
      const stamp =
        typeof row.timestamp === 'string' &&
        /^(?:(\d+):)?([0-5]?\d):([0-5]\d)$/.exec(row.timestamp);
      if (!stamp || integer(row.index) !== index)
        throw new Error('PARTIAL_RESPONSE');
      start = integer(
        ((Number(stamp[1] ?? 0) * 60 + Number(stamp[2])) * 60 +
          Number(stamp[3])) *
          1000,
      );
      end = null;
      source = text(row.text);
    } else if (format === 'panel-segments') {
      start = millisecondsString(row.startMs);
      end = millisecondsString(row.endMs);
      source = displayText(row.snippet);
    } else {
      start = integer(row.offset);
      end = integer(start + integer(row.duration));
      source = text(row.text);
    }
    return {
      upstream_index: index,
      start_ms: start,
      end_ms: end,
      text: source,
      speaker_label: null,
    };
  });
}
export async function validateSegments(
  cues: TranscriptSegment[],
  rawHash: string,
) {
  if (!cues.length) throw new Error('EMPTY_RESPONSE');
  for (let i = 0; i < cues.length; i++) {
    const row = cues[i]!;
    text(row.text);
    if (
      i &&
      (row.upstream_index <= cues[i - 1]!.upstream_index ||
        (row.start_ms !== null &&
          cues[i - 1]!.start_ms !== null &&
          row.start_ms < cues[i - 1]!.start_ms!))
    )
      throw new Error('PARTIAL_RESPONSE');
  }
  const normalized = await normalizeTranscript(
    rawHash,
    cues,
    cues.every((cue) => cue.end_ms !== null) ? 'CUE' : 'NONE',
  );
  const gaps = cues.slice(1).flatMap((cue, i) => {
    const before = cues[i]!;
    return before.end_ms !== null &&
      cue.start_ms !== null &&
      cue.start_ms > before.end_ms
      ? [{ start_ms: before.end_ms, end_ms: cue.start_ms }]
      : [];
  });
  return {
    structurally_valid: true,
    full_timing: cues.every(
      (cue) => cue.start_ms !== null && cue.end_ms !== null,
    ),
    source_text_sha256: hash(cues.map((cue) => cue.text).join('\n')),
    coverage_count: normalized.manifest.coverage.length,
    normalized_duplicate_count: normalized.manifest.coverage.filter(
      (row) => row.duplicate_of !== null,
    ).length,
    repeated_text_count:
      cues.length - new Set(cues.map((cue) => cue.text)).size,
    gap_count: cues.every((cue) => cue.start_ms !== null && cue.end_ms !== null)
      ? gaps.length
      : null,
    largest_gap_ms: cues.every(
      (cue) => cue.start_ms !== null && cue.end_ms !== null,
    )
      ? Math.max(0, ...gaps.map((gap) => gap.end_ms - gap.start_ms))
      : null,
    gap_interpretation: 'SILENCE_OR_MISSING_DATA_UNDETERMINED',
  };
}
export function matchesReference(
  cues: TranscriptSegment[],
  reference: TranscriptSegment[],
) {
  return (
    cues.length > 0 &&
    cues.length === reference.length &&
    cues.every((cue, index) => {
      const expected = reference[index]!;
      return (
        cue.text === expected.text &&
        cue.start_ms === expected.start_ms &&
        cue.end_ms === expected.end_ms &&
        cue.speaker_label === expected.speaker_label &&
        cue.upstream_index === expected.upstream_index
      );
    })
  );
}
export function httpCategory(status: number, code: unknown): Category {
  // Nie wnioskuj IP_BLOCKED z samego 403 ani NO_CAPTIONS z dowolnego 206.
  if (status === 206 && code === 'transcript-unavailable') return 'NO_CAPTIONS';
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403 || status === 451) return 'SOURCE_REFUSED';
  if (status === 429 || status === 420) return 'RATE_LIMITED';
  if (status === 404 || status === 410) return 'UNAVAILABLE';
  if (status === 206 || status === 202) return 'PARTIAL_RESPONSE';
  if (status < 200 || status >= 300) return 'TECHNICAL_FAILURE';
  return 'NONE';
}
function base(input: ProbeInput) {
  return {
    schema: probeVersion,
    provider:
      input.operation === 'oembed'
        ? 'youtube-oembed'
        : input.operation === 'supadata-native'
          ? 'supadata-native'
          : 'recorded-source',
    provider_version:
      input.operation === 'oembed'
        ? 'oembed:1.0'
        : input.operation === 'supadata-native'
          ? 'REST-v1; backend-version-unpublished'
          : (input.format ?? 'unknown'),
    runtime: process.version,
    system: process.platform,
    architecture: process.arch,
    operation: input.operation,
    video_id: publicVideoId(input.video),
    access_confirmed: input.access?.confirmed === true,
    access_basis_sha256: input.access
      ? hash(JSON.stringify(input.access))
      : null,
    metadata_obtained: false as boolean,
    caption_track_found: null as boolean | null,
    language: null as string | null,
    track_kind: 'UNKNOWN',
    original_language_confirmed: false,
    translation_status: 'UNKNOWN',
    http_status: null as number | null,
    category: 'NONE' as Category,
    segment_count: null as number | null,
    first_start_ms: null as number | null,
    last_start_ms: null as number | null,
    last_end_ms: null as number | null,
    validation: null as Awaited<ReturnType<typeof validateSegments>> | null,
    levels: {
      STRUCTURALLY_VALID: false,
      MATCHES_AVAILABLE_REFERENCE: null as boolean | null,
      INDEPENDENTLY_CONFIRMED_COMPLETE: false,
    },
    caption_accepted: false,
    raw_sha256: null as string | null,
    reference_sha256: null as string | null,
    metadata_identity_sha256: null as string | null,
    request_count: 0,
    elapsed_ms: 0,
  };
}
function category(error: unknown, signal?: AbortSignal): Category {
  if (signal?.aborted) return 'CANCELLED';
  const code = error instanceof Error ? error.message : '';
  if (code === 'RESPONSE_BODY_TOO_LARGE' || code === 'TOO_LARGE')
    return 'TOO_LARGE';
  if (['INVALID_INPUT', 'EMPTY_RESPONSE', 'PARTIAL_RESPONSE'].includes(code))
    return code as Category;
  if (code === 'INVALID_SOURCE_CUE') return 'PARTIAL_RESPONSE';
  if (
    error instanceof SyntaxError ||
    code === 'PARSER_FAILURE' ||
    code === 'PARSE_ERROR'
  )
    return 'PARSER_FAILURE';
  if (objectErrorStatus(error) === 'PARTIAL') return 'PARTIAL_RESPONSE';
  if (objectErrorStatus(error) === 'PARSE_ERROR') return 'PARSER_FAILURE';
  if (code === 'EMPTY_CAPTION_RESPONSE') return 'EMPTY_RESPONSE';
  return 'TECHNICAL_FAILURE';
}
function objectErrorStatus(error: unknown) {
  return error && typeof error === 'object' && 'status' in error
    ? error.status
    : null;
}
function assertMaterialIdentity(format: Format, body: string, videoId: string) {
  if (!formats.includes(format)) throw new Error('INVALID_INPUT');
  if (format === 'json3' || format === 'srt') return;
  const identity = object(JSON.parse(body));
  const video = identity.video_id ?? identity.videoId;
  if (video !== undefined && video !== videoId)
    throw new Error('INVALID_INPUT');
}
export async function offlineProbe(
  input: ProbeInput,
  body: string,
  reference?: { body: string; format: Format },
) {
  const started = performance.now(),
    result = base(input);
  result.raw_sha256 = hash(body);
  try {
    assertMaterialIdentity(input.format!, body, result.video_id);
    const cues = decodeOffline(input.format!, body);
    result.validation = await validateSegments(cues, result.raw_sha256);
    result.levels.STRUCTURALLY_VALID = true;
    result.caption_track_found = true;
    result.segment_count = cues.length;
    result.first_start_ms = cues[0]!.start_ms;
    result.last_start_ms = cues.at(-1)!.start_ms;
    result.last_end_ms = cues.at(-1)!.end_ms;
    if (!['json3', 'srt'].includes(input.format!)) {
      const parsed = object(JSON.parse(body));
      result.language = language(parsed.language ?? parsed.lang);
    }
    if (reference) {
      result.reference_sha256 = hash(reference.body);
      assertMaterialIdentity(reference.format, reference.body, result.video_id);
      const referenceCues = decodeOffline(reference.format, reference.body);
      await validateSegments(referenceCues, result.reference_sha256);
      result.levels.MATCHES_AVAILABLE_REFERENCE = matchesReference(
        cues,
        referenceCues,
      );
      if (!result.levels.MATCHES_AVAILABLE_REFERENCE)
        result.category = 'PARTIAL_RESPONSE';
    }
    // Offline diagnostyczne materiały nigdy nie uzyskują poziomu niezależnej pełności.
  } catch (error) {
    result.category = category(error);
  }
  result.elapsed_ms = Math.round(performance.now() - started);
  return result;
}
/** Dokładnie jedno żądanie; zero redirect/retry/polling. Raport tylko z allowlisty pól. */
export async function liveProbe(
  input: ProbeInput,
  options: { fetch?: typeof fetch; key?: string; signal?: AbortSignal } = {},
) {
  const started = performance.now(),
    result = base(input);
  if (input.operation === 'offline') throw new Error('INVALID_INPUT');
  if (
    input.operation === 'supadata-native' &&
    (!input.access?.confirmed ||
      !input.access.method?.trim() ||
      !input.access.content?.trim())
  ) {
    result.category = 'NO_AUTHORIZED_ACCESS';
    return result;
  }
  if (
    input.operation === 'supadata-native' &&
    (!options.key || input.access?.free_plan_confirmed !== true)
  ) {
    result.category = 'BLOCKED_INPUT';
    return result;
  }
  if (options.signal?.aborted) {
    result.category = 'CANCELLED';
    return result;
  }
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
    : AbortSignal.timeout(15000);
  const url = new URL(
    input.operation === 'oembed'
      ? 'https://www.youtube.com/oembed'
      : 'https://api.supadata.ai/v1/transcript',
  );
  url.searchParams.set(
    'url',
    'https://www.youtube.com/watch?v=' + result.video_id,
  );
  const headers: Record<string, string> = { accept: 'application/json' };
  if (input.operation === 'oembed') url.searchParams.set('format', 'json');
  else {
    url.searchParams.set('mode', 'native');
    url.searchParams.set('text', 'false');
    headers['x-api-key'] = options.key!;
  }
  try {
    result.request_count = 1;
    const response = await (options.fetch ?? fetch)(url, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      signal,
      headers,
    });
    result.http_status = response.status;
    const body = await boundedText(response, LIMIT);
    result.raw_sha256 = hash(body);
    if (!body.trim()) {
      result.category = httpCategory(response.status, null);
      if (result.category === 'NONE') result.category = 'EMPTY_RESPONSE';
    } else {
      let data: Record<string, unknown>;
      try {
        data = object(JSON.parse(body));
      } catch {
        result.category = response.ok
          ? 'PARSER_FAILURE'
          : httpCategory(response.status, null);
        return result;
      }
      result.category = httpCategory(response.status, data.error);
      if (result.category === 'NONE' && input.operation === 'oembed') {
        if (
          data.type !== 'video' ||
          data.provider_name !== 'YouTube' ||
          typeof data.title !== 'string' ||
          typeof data.author_name !== 'string'
        )
          result.category = 'PARSER_FAILURE';
        else {
          result.metadata_obtained = true;
          result.metadata_identity_sha256 = hash(
            JSON.stringify([data.title, data.author_name]),
          );
        }
      } else if (result.category === 'NONE') {
        const parsed = await offlineProbe(
          { ...input, operation: 'offline', format: 'supadata-native' },
          body,
        );
        Object.assign(result, {
          language: parsed.language,
          segment_count: parsed.segment_count,
          first_start_ms: parsed.first_start_ms,
          last_start_ms: parsed.last_start_ms,
          last_end_ms: parsed.last_end_ms,
          validation: parsed.validation,
          levels: parsed.levels,
          category: parsed.category,
        });
        result.caption_track_found =
          parsed.segment_count !== null && parsed.segment_count > 0;
        // Native nie potwierdza MANUAL/GENERATED, języka oryginalnego ani końców źródłowych cue.
      }
    }
  } catch (error) {
    result.category = category(error, signal);
  } finally {
    result.elapsed_ms = Math.round(performance.now() - started);
  }
  return result;
}
export async function main() {
  const [mode, path] = process.argv.slice(2);
  if (
    !['offline', 'oembed', 'supadata-native'].includes(mode ?? '') ||
    !path ||
    process.argv.length !== 4
  )
    throw new Error('INVALID_INPUT');
  const bytes = await readFile(path);
  if (bytes.length > LIMIT) throw new Error('TOO_LARGE');
  const manifest = object(JSON.parse(bytes.toString('utf8')));
  if (
    !Array.isArray(manifest.cases) ||
    !manifest.cases.length ||
    manifest.cases.length > 12 ||
    (mode !== 'offline' && manifest.cases.length !== 1)
  )
    throw new Error('INVALID_INPUT');
  const inputs = manifest.cases.map((value) => {
    const row = object(value);
    if (typeof row.video !== 'string') throw new Error('INVALID_INPUT');
    publicVideoId(row.video);
    return row;
  });
  const results = [];
  for (const row of inputs) {
    const input = {
      video: row.video as string,
      operation: mode,
      format: row.format,
      access: row.access,
    } as ProbeInput;
    if (mode === 'offline') {
      if (
        typeof row.path !== 'string' ||
        !formats.includes(row.format as Format)
      )
        throw new Error('INVALID_INPUT');
      const source = await readFile(resolve(dirname(path), row.path));
      if (source.length > LIMIT) throw new Error('TOO_LARGE');
      let reference;
      if (row.reference) {
        const ref = object(row.reference);
        if (typeof ref.path !== 'string' || typeof ref.format !== 'string')
          throw new Error('INVALID_INPUT');
        const refBytes = await readFile(resolve(dirname(path), ref.path));
        if (refBytes.length > LIMIT) throw new Error('TOO_LARGE');
        reference = {
          body: refBytes.toString('utf8'),
          format: ref.format as Format,
        };
      }
      results.push(
        await offlineProbe(input, source.toString('utf8'), reference),
      );
    } else
      results.push(
        await liveProbe(input, {
          key:
            mode === 'supadata-native'
              ? process.env.BARTOSZ_PROBE_SUPADATA_KEY
              : undefined,
        }),
      );
  }
  process.stdout.write(
    JSON.stringify(
      { schema: probeVersion, manifest_sha256: hash(bytes), results },
      null,
      2,
    ) + '\n',
  );
}
