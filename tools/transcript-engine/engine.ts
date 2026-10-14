/** Standalone R&D. No executor, RPC, database, environment credentials or retry. */
import { createHash } from 'node:crypto';
import { decodeOffline, publicVideoId } from '../probes/source-probe.js';
import type { TranscriptSegment } from '../../packages/contracts/src/transcript.js';

export const version = 'original-transcript-engine:1';
export const maxBytes = 4 * 1024 * 1024;
export const maxCues = 20000;
export const digest = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export type Category =
  | 'NONE'
  | 'BLOCKED_INPUT'
  | 'BLOCKED_AUTHORIZATION'
  | 'INVALID_INPUT'
  | 'SOURCE_REFUSED'
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'NO_CAPTIONS'
  | 'TRACKS_NOT_EXPOSED'
  | 'UPSTREAM_CHANGED'
  | 'PARSER_FAILURE'
  | 'EMPTY_RESPONSE'
  | 'PARTIAL_RESPONSE'
  | 'IDENTITY_MISMATCH'
  | 'ORIGINAL_UNCONFIRMED'
  | 'COMPLETENESS_UNCONFIRMED'
  | 'TOO_LARGE'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'MEMORY_LIMIT'
  | 'BROWSER_UNAVAILABLE'
  | 'TECHNICAL_FAILURE';
export class EngineFailure extends Error {
  constructor(
    readonly category: Category,
    readonly code: string,
  ) {
    super(code);
  }
}
export function fail(category: Category, code: string): never {
  throw new EngineFailure(category, code);
}
export function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('PARSER_FAILURE', 'OBJECT_REQUIRED');
  return value as Record<string, unknown>;
}
const lang = (v: unknown) =>
  typeof v === 'string' && /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{1,8})*$/.test(v)
    ? v
    : null;
const safeId = (v: unknown) =>
  typeof v === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(v) ? v : null;
function sourceText(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 65536)
    fail('PARTIAL_RESPONSE', 'SOURCE_TEXT_INVALID');
  return v;
}
function textObject(value: unknown) {
  const o = obj(value);
  if (typeof o.simpleText === 'string') return sourceText(o.simpleText);
  if (!Array.isArray(o.runs)) fail('PARTIAL_RESPONSE', 'TEXT_RUNS_MISSING');
  return sourceText(
    o.runs
      .map((r) => {
        const t = obj(r).text;
        if (typeof t !== 'string') fail('PARTIAL_RESPONSE', 'TEXT_RUN_INVALID');
        return t;
      })
      .join(''),
  );
}
export function parseJson(body: string): unknown {
  if (Buffer.byteLength(body) > maxBytes) fail('TOO_LARGE', 'BODY_LIMIT');
  if (!body.trim()) fail('EMPTY_RESPONSE', 'EMPTY_UPSTREAM_BODY');
  try {
    return JSON.parse(body);
  } catch {
    return fail('PARSER_FAILURE', 'INVALID_JSON');
  }
}
/** Iterative, bounded traversal, used only on the already bounded response. */
function findNodes(root: unknown, key: string): unknown[] {
  const found: unknown[] = [],
    queue: [unknown, number][] = [[root, 0]];
  let count = 0;
  while (queue.length) {
    const [value, depth] = queue.pop()!;
    if (++count > 150000 || depth > 48)
      fail('TOO_LARGE', 'JSON_COMPLEXITY_LIMIT');
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (const child of value) queue.push([child, depth + 1]);
    } else {
      for (const [name, child] of Object.entries(value)) {
        if (name === key) found.push(child);
        queue.push([child, depth + 1]);
      }
    }
  }
  return found.reverse();
}
export type Track = {
  vss_id: string | null;
  language_code: string;
  kind: 'MANUAL' | 'GENERATED' | 'UNKNOWN';
  name: string;
  is_translated: boolean | null;
};
export type Snapshot = {
  video_id: string;
  playability_status: string | null;
  tracks_explicit: boolean;
  original_language: string | null;
  tracks: Track[];
};
/** Allowlisted source projection. URLs, visitor data and player tokens never persist. */
export function snapshotProjection(value: unknown, video: string): Snapshot {
  const o = obj(value);
  if (o.video_id !== video) fail('IDENTITY_MISMATCH', 'PLAYER_VIDEO_MISMATCH');
  if (o.tracks_explicit !== true && o.tracks_explicit !== false)
    fail('PARSER_FAILURE', 'LISTING_PRESENCE_MISSING');
  if (!Array.isArray(o.tracks) || o.tracks.length > 512)
    fail('PARSER_FAILURE', 'TRACK_LIST_INVALID');
  const tracks = o.tracks.map((value) => {
    const t = obj(value),
      language = lang(t.language_code);
    if (
      !language ||
      !['MANUAL', 'GENERATED', 'UNKNOWN'].includes(String(t.kind))
    )
      fail('PARSER_FAILURE', 'TRACK_METADATA_INVALID');
    if (t.is_translated !== null && typeof t.is_translated !== 'boolean')
      fail('PARSER_FAILURE', 'TRANSLATION_METADATA_INVALID');
    return {
      vss_id: safeId(t.vss_id),
      language_code: language,
      kind: t.kind as Track['kind'],
      name: sourceText(t.name),
      is_translated: t.is_translated as boolean | null,
    };
  });
  return {
    video_id: video,
    playability_status: safeId(o.playability_status),
    tracks_explicit: o.tracks_explicit,
    original_language: lang(o.original_language),
    tracks,
  };
}
export function listingFailure(s: Snapshot): EngineFailure | null {
  if (s.playability_status === 'LOGIN_REQUIRED')
    return new EngineFailure('AUTH_REQUIRED', 'PLAYER_LOGIN_REQUIRED');
  if (s.playability_status && s.playability_status !== 'OK')
    return new EngineFailure('SOURCE_REFUSED', 'PLAYER_NOT_PLAYABLE');
  if (!s.tracks_explicit)
    return new EngineFailure('TRACKS_NOT_EXPOSED', 'CAPTION_LIST_NOT_EXPOSED');
  if (!s.tracks.length && s.playability_status === 'OK')
    return new EngineFailure('NO_CAPTIONS', 'EXPLICIT_EMPTY_CAPTION_LIST');
  return null;
}
function validateCues(cues: TranscriptSegment[]) {
  if (!cues.length) fail('EMPTY_RESPONSE', 'NO_SOURCE_SEGMENTS');
  if (cues.length > maxCues) fail('TOO_LARGE', 'CUE_LIMIT');
  for (const [i, c] of cues.entries()) {
    sourceText(c.text);
    if (
      c.upstream_index !== i ||
      c.start_ms === null ||
      !Number.isSafeInteger(c.start_ms) ||
      c.start_ms < 0 ||
      (c.end_ms !== null &&
        (!Number.isSafeInteger(c.end_ms) || c.end_ms < c.start_ms)) ||
      (i && c.start_ms < cues[i - 1]!.start_ms!)
    )
      fail('PARTIAL_RESPONSE', 'CUE_SEQUENCE_OR_TIMING_INVALID');
  }
}
function panelPayload(body: string) {
  const root = parseJson(body);
  const error = obj(root).error;
  if (error) {
    const e = obj(error),
      status = safeId(e.status);
    if (e.code === 429) fail('RATE_LIMITED', 'PANEL_RATE_LIMITED');
    if (e.code === 401) fail('AUTH_REQUIRED', 'PANEL_AUTH_REQUIRED');
    fail(
      'SOURCE_REFUSED',
      status === 'FAILED_PRECONDITION'
        ? 'PANEL_FAILED_PRECONDITION'
        : 'PANEL_ERROR_RESPONSE',
    );
  }
  const lists = findNodes(root, 'transcriptSegmentListRenderer');
  if (lists.length !== 1)
    fail('UPSTREAM_CHANGED', 'SINGLE_TRANSCRIPT_LIST_REQUIRED');
  const list = obj(lists[0]);
  // Never mistake language-menu reload tokens for pagination of this list.
  if (
    findNodes(list, 'continuationItemRenderer').length ||
    findNodes(list, 'continuations').length
  )
    fail('PARTIAL_RESPONSE', 'TRANSCRIPT_CONTINUATION_UNCONSUMED');
  if (
    !Array.isArray(list.initialSegments) ||
    list.initialSegments.length > maxCues
  )
    fail('UPSTREAM_CHANGED', 'PANEL_INITIAL_SEGMENTS_INVALID');
  const segments: Record<string, unknown>[] = [];
  for (const entry of list.initialSegments) {
    const e = obj(entry),
      keys = Object.keys(e);
    if (keys.length !== 1) fail('UPSTREAM_CHANGED', 'AMBIGUOUS_PANEL_ENTRY');
    if (keys[0] === 'transcriptSectionHeaderRenderer') continue;
    if (keys[0] !== 'transcriptSegmentRenderer')
      fail('UPSTREAM_CHANGED', 'UNKNOWN_SOURCE_BEARING_PANEL_ENTRY');
    const cue = obj(e.transcriptSegmentRenderer);
    // Only exact fields needed to reproduce text and timing are saved.
    segments.push({
      startMs: cue.startMs,
      endMs: cue.endMs,
      snippet: { simpleText: textObject(cue.snippet) },
    });
  }
  const selected = findNodes(root, 'subMenuItems').flatMap((v) =>
    Array.isArray(v) ? v.filter((x) => obj(x).selected === true) : [],
  );
  const label =
    selected.length === 1 ? sourceText(obj(selected[0]).title) : null;
  const projection = { segments, selected_label: label, list_terminal: true };
  return {
    cues: decodeOffline('panel-segments', JSON.stringify(projection)),
    projection,
    selectedLabel: label,
  };
}
export type Reference = {
  schema: 'ote-reference:1';
  video_id: string;
  language_code: string | null;
  track_kind: Track['kind'];
  vss_id: string | null;
  independent: boolean;
  complete: boolean;
  original: boolean;
  provenance: string;
  raw_sha256: string;
  segments: TranscriptSegment[];
};
export function referenceProjection(value: unknown, video: string): Reference {
  const r = obj(value);
  if (r.schema !== 'ote-reference:1' || r.video_id !== video)
    fail('IDENTITY_MISMATCH', 'REFERENCE_VIDEO_OR_SCHEMA_MISMATCH');
  if (!Array.isArray(r.segments) || r.segments.length > maxCues)
    fail('PARSER_FAILURE', 'REFERENCE_SEGMENTS_INVALID');
  for (const name of ['independent', 'complete', 'original'])
    if (typeof r[name] !== 'boolean')
      fail('INVALID_INPUT', 'REFERENCE_CLAIMS_REQUIRED');
  if (
    !['MANUAL', 'GENERATED', 'UNKNOWN'].includes(String(r.track_kind)) ||
    typeof r.raw_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(r.raw_sha256)
  )
    fail('INVALID_INPUT', 'REFERENCE_PROVENANCE_INVALID');
  const segments = r.segments.map((v, i) => {
    const c = obj(v);
    if (c.upstream_index !== i)
      fail('PARTIAL_RESPONSE', 'REFERENCE_INDEX_INVALID');
    return {
      upstream_index: i,
      start_ms: c.start_ms as number | null,
      end_ms: c.end_ms as number | null,
      text: sourceText(c.text),
      speaker_label: null,
    };
  });
  validateCues(segments);
  return {
    schema: 'ote-reference:1',
    video_id: video,
    language_code: lang(r.language_code),
    track_kind: r.track_kind as Track['kind'],
    vss_id: safeId(r.vss_id),
    independent: r.independent as boolean,
    complete: r.complete as boolean,
    original: r.original as boolean,
    provenance: sourceText(r.provenance),
    raw_sha256: r.raw_sha256,
    segments,
  };
}
export type Input = {
  video: string;
  format: 'panel' | 'json3' | 'recorded-en' | 'recorded-dom';
  body: string;
  snapshot: unknown;
  reference?: unknown;
  live: boolean;
  transportComplete: boolean;
  expectedTrackId?: string;
};
export function analyze(input: Input) {
  const video = publicVideoId(input.video);
  const snapshot = snapshotProjection(input.snapshot, video);
  const unavailable = listingFailure(snapshot);
  if (unavailable) throw unavailable;
  if (!input.transportComplete)
    fail('PARTIAL_RESPONSE', 'TRANSPORT_NOT_FINISHED');
  if (Buffer.byteLength(input.body) > maxBytes) fail('TOO_LARGE', 'BODY_LIMIT');
  if (!input.body.trim()) fail('EMPTY_RESPONSE', 'EMPTY_UPSTREAM_BODY');
  let cues: TranscriptSegment[],
    projection: unknown,
    selectedLabel: string | null = null;
  try {
    if (input.format === 'panel') {
      const p = panelPayload(input.body);
      cues = p.cues;
      projection = p.projection;
      selectedLabel = p.selectedLabel;
    } else {
      if (!['json3', 'recorded-en', 'recorded-dom'].includes(input.format))
        fail('INVALID_INPUT', 'FORMAT_NOT_SUPPORTED');
      if (input.format !== 'json3') {
        const recorded = obj(parseJson(input.body));
        if ((recorded.video_id ?? recorded.videoId) !== video)
          fail('IDENTITY_MISMATCH', 'RECORDED_VIDEO_MISMATCH');
      }
      cues = decodeOffline(input.format, input.body);
      projection = { segments: cues };
    }
  } catch (e) {
    if (e instanceof EngineFailure) throw e;
    // Preserve the existing decoders' explicit partial-data category.
    if (
      e instanceof Error &&
      (e.message === 'PARTIAL_RESPONSE' ||
        ('status' in e && e.status === 'PARTIAL'))
    )
      fail('PARTIAL_RESPONSE', 'SOURCE_TIMING_OR_CONTENT_INCOMPLETE');
    fail('PARSER_FAILURE', 'SOURCE_DECODER_REJECTED');
  }
  // JSON3 source indices may include control events. Preserve that evidence in
  // projection, but use contiguous source-bearing indices in the engine contract.
  const originalIndices = cues.map((c) => c.upstream_index);
  cues = cues.map((c, i) => ({ ...c, upstream_index: i }));
  validateCues(cues);
  const available =
    selectedLabel === null
      ? input.format === 'panel'
        ? []
        : snapshot.tracks
      : snapshot.tracks.filter((t) => t.name === selectedLabel);
  const track = available.length === 1 ? available[0]! : null;
  if (input.expectedTrackId && track?.vss_id !== input.expectedTrackId)
    fail('IDENTITY_MISMATCH', 'REQUESTED_TRACK_NOT_RETURNED');
  const reference =
    input.reference === undefined
      ? null
      : referenceProjection(input.reference, video);
  if (
    reference &&
    track &&
    ((reference.language_code &&
      reference.language_code !== track.language_code) ||
      (reference.track_kind !== 'UNKNOWN' &&
        reference.track_kind !== track.kind) ||
      (reference.vss_id && reference.vss_id !== track.vss_id))
  )
    fail('IDENTITY_MISMATCH', 'REFERENCE_TRACK_MISMATCH');
  const differences = reference
    ? cues.reduce(
        (n, c, i) => {
          const r = reference.segments[i];
          return (
            n +
            (!r ||
            c.text !== r.text ||
            c.start_ms !== r.start_ms ||
            c.end_ms !== r.end_ms
              ? 1
              : 0)
          );
        },
        Math.max(0, reference.segments.length - cues.length),
      )
    : null;
  const fullTiming = cues.every((c) => c.end_ms !== null);
  const same = differences === 0;
  const original =
    track?.is_translated === false &&
    track.kind !== 'UNKNOWN' &&
    ((snapshot.original_language !== null &&
      track.language_code === snapshot.original_language) ||
      (same &&
        reference?.independent === true &&
        reference.original &&
        reference.language_code === track.language_code &&
        reference.vss_id !== null &&
        reference.vss_id === track.vss_id &&
        reference.track_kind === track.kind));
  const independentlyComplete =
    same &&
    fullTiming &&
    reference?.independent === true &&
    reference.complete &&
    reference.language_code === track?.language_code &&
    reference.vss_id !== null &&
    reference.vss_id === track?.vss_id &&
    reference.track_kind === track?.kind;
  const accepted = input.live && original && independentlyComplete;
  const category: Category =
    !fullTiming || (reference && !same)
      ? 'PARTIAL_RESPONSE'
      : !original
        ? 'ORIGINAL_UNCONFIRMED'
        : !independentlyComplete
          ? 'COMPLETENESS_UNCONFIRMED'
          : 'NONE';
  const result = {
    schema: version,
    video_id: video,
    status: accepted
      ? 'OK'
      : category === 'PARTIAL_RESPONSE'
        ? 'PARTIAL'
        : 'UNVERIFIED',
    category,
    accepted,
    acquisition: input.live ? 'NATIVE_BROWSER' : 'OFFLINE_REPLAY',
    language_code: track?.language_code ?? null,
    track_kind: track?.kind ?? 'UNKNOWN',
    is_generated:
      track && track.kind !== 'UNKNOWN' ? track.kind === 'GENERATED' : null,
    is_translated: track?.is_translated ?? null,
    vss_id: track?.vss_id ?? null,
    track_identity_sha256: track
      ? digest(
          JSON.stringify([
            video,
            track.vss_id,
            track.language_code,
            track.kind,
            track.is_translated,
          ]),
        )
      : null,
    is_original: original ? true : null,
    provenance: {
      source: 'youtube',
      method: input.format,
      selected_label: selectedLabel,
      raw_sha256: digest(input.body),
      raw_bytes: Buffer.byteLength(input.body),
      persistence: 'ALLOWLISTED_SOURCE_PROJECTION_NO_TOKENS',
      original_indices: originalIndices,
    },
    completeness: {
      transport_complete: input.transportComplete,
      full_timing: fullTiming,
      reference_matches: reference ? same : null,
      different_cues: differences,
      reference_provenance: reference?.provenance ?? null,
      independently_confirmed_complete: independentlyComplete,
      original_language_basis: snapshot.original_language
        ? 'EXPLICIT_SOURCE_ORIGINAL_LANGUAGE'
        : original
          ? 'INDEPENDENT_REFERENCE_EXACT_TRACK'
          : null,
    },
    cue_count: cues.length,
    first_start_ms: cues[0]!.start_ms,
    last_end_ms: cues[cues.length - 1]!.end_ms,
    full_text: cues.map((c) => c.text).join('\n'),
    segments: cues,
  };
  return { result, sourceProjection: projection, snapshot };
}

/** Refusal is terminal across methods of one upstream. No failover by library name. */
export async function runSourcePlan<
  T extends { category: Category; accepted: boolean },
>(sources: readonly { domain: string; run: () => Promise<T> }[]): Promise<T[]> {
  if (
    sources.length > 3 ||
    new Set(sources.map((s) => s.domain)).size !== sources.length
  )
    fail('INVALID_INPUT', 'SOURCES_MUST_HAVE_INDEPENDENT_DOMAINS');
  const results: T[] = [];
  for (const source of sources) {
    const result = await source.run();
    results.push(result);
    if (
      result.accepted ||
      [
        'SOURCE_REFUSED',
        'AUTH_REQUIRED',
        'RATE_LIMITED',
        'BLOCKED_AUTHORIZATION',
        'CANCELLED',
      ].includes(result.category)
    )
      break;
  }
  return results;
}
