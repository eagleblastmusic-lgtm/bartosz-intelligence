/** Bounded author-published captions, never a claim about an original YouTube track. */
import { parseCaptionSrt } from '../../packages/core/src/transcript/providers/youtube-captions.js';
import { publicVideoId } from '../probes/source-probe.js';
import { digest, fail, maxCues } from './engine.js';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const limit = 1024 * 1024;
function sourceUrl(value: unknown) {
  if (typeof value !== 'string')
    fail('INVALID_INPUT', 'PUBLISHER_URL_REQUIRED');
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return fail('INVALID_INPUT', 'PUBLISHER_URL_INVALID');
  }
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.port ||
    u.search ||
    u.hash ||
    !['raw.githubusercontent.com', 'ocw.mit.edu'].includes(u.hostname)
  )
    fail('INVALID_INPUT', 'PUBLISHER_URL_NOT_ALLOWED');
  return u;
}
async function download(url: URL, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15000);
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel();
      fail(
        response.status === 429
          ? 'RATE_LIMITED'
          : response.status === 401
            ? 'AUTH_REQUIRED'
            : 'SOURCE_REFUSED',
        'PUBLISHER_HTTP_' + response.status,
      );
    }
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      fail('TOO_LARGE', 'PUBLISHER_BODY_LIMIT');
    }
    const reader = response.body?.getReader();
    if (!reader) fail('EMPTY_RESPONSE', 'PUBLISHER_BODY_MISSING');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > limit) fail('TOO_LARGE', 'PUBLISHER_BODY_LIMIT');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = Buffer.concat(chunks);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return fail('PARSER_FAILURE', 'PUBLISHER_UTF8_INVALID');
    }
    return {
      url: url.href,
      bytes,
      text,
      sha256: digest(bytes),
      content_type: response.headers.get('content-type'),
      http_status: response.status,
    };
  } catch (error) {
    if (signal?.aborted) fail('CANCELLED', 'PUBLISHER_ABORTED');
    if (timeout.aborted) fail('TIMEOUT', 'PUBLISHER_GET_TIMEOUT');
    if (error instanceof Error && 'category' in error) throw error;
    return fail('TECHNICAL_FAILURE', 'PUBLISHER_GET_FAILED');
  }
}
function attr(tag: string, name: string) {
  return (
    new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(["\\\'])([\\s\\S]*?)\\1', 'i')
      .exec(tag)?.[2]
      ?.replaceAll('&amp;', '&') ?? ''
  );
}
export async function obtainPublisher(
  videoInput: string,
  config: Record<string, unknown>,
  signal?: AbortSignal,
  outputDirectory?: string,
) {
  const video = publicVideoId(videoInput),
    source = sourceUrl(config.source_url),
    association = sourceUrl(config.association_url);
  const format = config.format,
    language = config.language_code;
  if (
    !['srt', 'vtt', 'sentence-json'].includes(String(format)) ||
    typeof language !== 'string' ||
    !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{1,8})*$/.test(language) ||
    source.hostname !== association.hostname
  )
    fail('INVALID_INPUT', 'PUBLISHER_CONFIG_INVALID');
  if (
    source.hostname === 'raw.githubusercontent.com' &&
    (!association.pathname.endsWith('/video_url.txt') ||
      !source.pathname.startsWith(new URL('.', association).pathname))
  )
    fail('IDENTITY_MISMATCH', 'PUBLISHER_REPOSITORY_ASSOCIATION_INVALID');
  const fetched: Record<string, unknown> = {};
  async function preserve(
    name: 'association' | 'source',
    value: Awaited<ReturnType<typeof download>>,
  ) {
    if (!outputDirectory) return;
    await writeFile(
      resolve(outputDirectory, 'publisher-' + name + '.raw'),
      value.bytes,
      { mode: 0o600, flag: 'wx' },
    );
    fetched[name] = {
      url: value.url,
      sha256: value.sha256,
      byte_count: value.bytes.length,
      http_status: value.http_status,
      transport_complete: true,
    };
    await writeFile(
      resolve(outputDirectory, 'publisher-fetch.json'),
      JSON.stringify(fetched, null, 2) + '\n',
      { mode: 0o600 },
    );
  }
  const proof = await download(association, signal);
  await preserve('association', proof);
  if (source.hostname === 'raw.githubusercontent.com') {
    try {
      if (publicVideoId(proof.text.trim()) !== video) throw 0;
    } catch {
      fail('IDENTITY_MISMATCH', 'PUBLISHER_VIDEO_MISMATCH');
    }
  } else {
    const frames = [...proof.text.matchAll(/<iframe\b[^>]*>/gi)]
      .map((m) => attr(m[0], 'src'))
      .filter((u) => /youtube\.com\/embed\//.test(u));
    const tracks = [...proof.text.matchAll(/<track\b[^>]*>/gi)].filter(
      (m) => attr(m[0], 'kind') === 'captions',
    );
    let associated = false;
    try {
      associated =
        frames.length === 1 &&
        publicVideoId(frames[0]!) === video &&
        tracks.some(
          (m) =>
            new URL(attr(m[0], 'src'), association).href === source.href &&
            attr(m[0], 'srclang') === language,
        );
    } catch {
      /* An invalid embedded URL cannot establish association. */
    }
    if (!associated)
      fail('IDENTITY_MISMATCH', 'PUBLISHER_PAGE_ASSOCIATION_INVALID');
  }
  const raw = await download(source, signal);
  await preserve('source', raw);
  let segments: ReturnType<typeof parseCaptionSrt>;
  if (format === 'sentence-json') {
    let rows: unknown;
    try {
      rows = JSON.parse(raw.text);
    } catch {
      return fail('PARSER_FAILURE', 'PUBLISHER_SENTENCE_JSON_INVALID');
    }
    if (!Array.isArray(rows) || !rows.length || rows.length > maxCues)
      fail('PARSER_FAILURE', 'PUBLISHER_SENTENCE_ROWS_INVALID');
    segments = [];
    for (const [i, r] of rows.entries()) {
      if (
        !Array.isArray(r) ||
        r.length !== 3 ||
        typeof r[0] !== 'string' ||
        !r[0].trim() ||
        typeof r[1] !== 'number' ||
        typeof r[2] !== 'number' ||
        !Number.isFinite(r[1]) ||
        !Number.isFinite(r[2]) ||
        r[1] < 0 ||
        r[2] < r[1]
      ) {
        if (outputDirectory)
          await writeFile(
            resolve(outputDirectory, 'publisher-fetch.json'),
            JSON.stringify(
              {
                ...fetched,
                diagnostic: {
                  invalid_tuple: i + 1,
                  reason: 'TEXT_OR_TIMING_INVALID',
                  start: Array.isArray(r) ? r[1] : null,
                  end: Array.isArray(r) ? r[2] : null,
                },
              },
              null,
              2,
            ) + '\n',
            { mode: 0o600 },
          );
        fail('PARTIAL_RESPONSE', 'PUBLISHER_SENTENCE_TIMING_INVALID');
      }
      const start = Math.round(r[1] * 1000),
        end = Math.round(r[2] * 1000);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end))
        fail('PARTIAL_RESPONSE', 'PUBLISHER_SENTENCE_TIMING_INVALID');
      segments.push({
        upstream_index: i,
        start_ms: start,
        end_ms: end,
        text: r[0],
        speaker_label: null,
      });
    }
  } else {
    let normalized = raw.text.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
    const sourceCount = [
      ...normalized.matchAll(/^\d{2,}:[0-5]\d:[0-5]\d[.,]\d{3} --> /gm),
    ].length;
    if (!sourceCount || sourceCount > maxCues)
      fail('PARSER_FAILURE', 'PUBLISHER_CUE_COUNT_INVALID');
    if (format === 'vtt') {
      if (!normalized.startsWith('WEBVTT\n\n'))
        fail('PARSER_FAILURE', 'PUBLISHER_VTT_HEADER_UNSUPPORTED');
      normalized = normalized
        .slice('WEBVTT\n\n'.length)
        .replace(
          /^(\d{2,}:[0-5]\d:[0-5]\d)\.(\d{3}) --> (\d{2,}:[0-5]\d:[0-5]\d)\.(\d{3})$/gm,
          '$1,$2 --> $3,$4',
        );
      let index = 0;
      normalized = normalized.replace(
        /(^|\n\n)(?=\d{2,}:[0-5]\d:[0-5]\d,\d{3} --> )/g,
        (_, gap: string) => gap + ++index + '\n',
      );
    }
    normalized = normalized.replace(
      /\n(?=\d+\n\d{2,}:[0-5]\d:[0-5]\d,\d{3} --> )/g,
      '\n\n',
    );
    const reversed = [
      ...normalized.matchAll(
        /^(\d+)\n(\d{2}:[0-5]\d:[0-5]\d,\d{3}) --> (\d{2}:[0-5]\d:[0-5]\d,\d{3})$/gm,
      ),
    ].find((m) => m[3]! < m[2]!);
    if (reversed) {
      if (outputDirectory)
        await writeFile(
          resolve(outputDirectory, 'publisher-fetch.json'),
          JSON.stringify(
            {
              ...fetched,
              diagnostic: {
                invalid_cue: Number(reversed[1]),
                start: reversed[2],
                end: reversed[3],
                reason: 'END_BEFORE_START',
              },
            },
            null,
            2,
          ) + '\n',
          { mode: 0o600 },
        );
      fail('PARTIAL_RESPONSE', 'PUBLISHER_SOURCE_TIMING_REVERSED');
    }
    try {
      segments = parseCaptionSrt(normalized);
    } catch {
      return fail('PARSER_FAILURE', 'PUBLISHER_SRT_DECODER_REJECTED');
    }
    const indexedCount = [
      ...normalized.matchAll(/^\d+\n\d{2,}:[0-5]\d:[0-5]\d,\d{3} --> /gm),
    ].length;
    if (segments.length !== sourceCount || segments.length !== indexedCount)
      fail('PARTIAL_RESPONSE', 'PUBLISHER_CUE_COUNT_MISMATCH');
  }
  return {
    body: JSON.stringify({
      events: segments.map((s) => ({
        tStartMs: s.start_ms,
        dDurationMs: s.end_ms! - s.start_ms!,
        segs: [{ utf8: s.text }],
      })),
    }),
    snapshot: {
      video_id: video,
      playability_status: null,
      tracks_explicit: true,
      original_language: null,
      tracks: [
        {
          vss_id: null,
          language_code: language,
          kind: 'UNKNOWN',
          name: 'Published captions (' + language + ')',
          is_translated: null,
        },
      ],
    },
    source: raw,
    association: proof,
    cue_count: segments.length,
    provenance: {
      source: 'publisher',
      method: 'AUTHOR_PUBLISHED_CAPTIONS',
      source_format: format,
      source_url: source.href,
      association_url: association.href,
      raw_sha256: raw.sha256,
      raw_bytes: raw.bytes.length,
      association_sha256: proof.sha256,
      youtube_video_association: true,
      original_youtube_track: null,
      independently_confirmed_complete: false,
    },
  };
}
