import { sha256 } from '../../auth/crypto.js';
import type {
  SourceAnchor,
  normalizeTranscript,
} from '../../transcript/normalize.js';
type Manifest = Awaited<ReturnType<typeof normalizeTranscript>>['manifest'];
export interface MappedHelper {
  approved_mapping_id: string;
  source_hash: string;
  helper_artifact_id: string;
  helper_hash: string;
  text: string;
  mapping_hash: string;
  mappings: { segment_ids: string[]; start: number; end: number }[];
}
export interface EvidenceInput {
  owner_id: string;
  source_language?: string | null;
  source_artifact_id: string;
  source_text: string;
  manifest: Manifest;
  manifest_hash: string;
  video_url: string | null;
  segment_refs: readonly string[];
  helper?: MappedHelper;
}
function timestampUrl(locator: string | null, start: number | null) {
  if (locator === null || start === null) return null;
  const url = new URL(locator);
  if (
    url.origin !== 'https://www.youtube.com' ||
    url.pathname !== '/watch' ||
    !/^[a-zA-Z0-9_-]{11}$/.test(url.searchParams.get('v') ?? '') ||
    [...url.searchParams.keys()].some((key) => key !== 'v')
  )
    throw new Error('INVALID_EVIDENCE_LOCATOR');
  url.searchParams.set('t', `${Math.floor(start / 1000)}s`);
  return url.href;
}
export async function prepareEvidenceSource(
  source: Omit<EvidenceInput, 'segment_refs'>,
) {
  // Private snapshot: a caller cannot mutate verified anchors while asynchronous
  // quote hashes are being computed. Proofs live only for this enrichment run.
  const input = structuredClone(source),
    { manifest } = input;
  const sourceHash = await sha256(input.source_text);
  if (
    !input.owner_id ||
    !input.source_artifact_id ||
    manifest.source_revision !== sourceHash ||
    manifest.source_text_hash !== sourceHash ||
    manifest.source_text_version !== 'decoded-cue-text:1' ||
    manifest.offset_unit !== 'UTF16_CODE_UNIT' ||
    manifest.normalizer_version !== 'source-normalizer:1' ||
    !manifest.complete ||
    (await sha256(JSON.stringify(manifest))) !== input.manifest_hash
  )
    throw new Error('EVIDENCE_SOURCE_MISMATCH');
  const aliases = new Map(
    manifest.anchors.map((anchor, index) => [anchor.alias, { anchor, index }]),
  );
  if (
    aliases.size !== manifest.anchors.length ||
    new Set(manifest.anchors.map((anchor) => anchor.segment_id)).size !==
      manifest.anchors.length
  )
    throw new Error('INVALID_EVIDENCE_MANIFEST');
  return (segment_refs: readonly string[]) =>
    buildPreparedEvidence({ ...input, segment_refs }, aliases, sourceHash);
}
export async function buildEvidence(input: EvidenceInput) {
  const { segment_refs, ...source } = input;
  return (await prepareEvidenceSource(source))(segment_refs);
}
async function buildPreparedEvidence(
  input: EvidenceInput,
  aliases: Map<string, { anchor: SourceAnchor; index: number }>,
  sourceHash: string,
) {
  const { manifest } = input;
  if (
    !input.segment_refs.length ||
    new Set(input.segment_refs).size !== input.segment_refs.length
  )
    throw new Error('INVALID_EVIDENCE_REFS');
  const selected = input.segment_refs
    .map((alias) => {
      const entry = aliases.get(alias);
      if (!entry) throw new Error('FOREIGN_SOURCE_REF');
      const a = entry.anchor;
      if (
        !Number.isSafeInteger(a.source_start) ||
        !Number.isSafeInteger(a.source_end) ||
        a.source_start < 0 ||
        a.source_end <= a.source_start ||
        a.source_end > input.source_text.length ||
        !['NONE', 'CUE', 'WORD', 'ESTIMATED'].includes(a.timestamp_precision) ||
        (a.start_ms !== null &&
          (!Number.isSafeInteger(a.start_ms) || a.start_ms < 0)) ||
        (a.end_ms !== null &&
          (!Number.isSafeInteger(a.end_ms) || a.end_ms < 0)) ||
        (a.start_ms !== null && a.end_ms !== null && a.end_ms < a.start_ms)
      )
        throw new Error('INVALID_EVIDENCE_ANCHOR');
      return entry;
    })
    .sort((a, b) => a.index - b.index);
  const groups: SourceAnchor[][] = [];
  let previousIndex = -2;
  for (const entry of selected) {
    if (entry.index !== previousIndex + 1) groups.push([]);
    groups.at(-1)!.push(entry.anchor);
    previousIndex = entry.index;
  }
  const helper = input.helper;
  if (
    helper &&
    (!helper.approved_mapping_id ||
      helper.source_hash !== sourceHash ||
      (await sha256(helper.text)) !== helper.helper_hash ||
      (await sha256(JSON.stringify(helper.mappings))) !== helper.mapping_hash)
  )
    throw new Error('INVALID_HELPER_REVISION');
  const evidence = [];
  for (const anchors of groups) {
    const start = Math.min(...anchors.map((a) => a.source_start));
    const end = Math.max(...anchors.map((a) => a.source_end));
    const quote = input.source_text.slice(start, end);
    const quoteHash = await sha256(quote);
    const segmentIds = anchors.map((a) => a.segment_id);
    const timed = anchors.every(
      (a) =>
        a.start_ms !== null &&
        a.end_ms !== null &&
        a.timestamp_precision !== 'NONE',
    );
    const startMs = timed ? Math.min(...anchors.map((a) => a.start_ms!)) : null;
    const endMs = timed ? Math.max(...anchors.map((a) => a.end_ms!)) : null;
    const precision = !timed
      ? 'NONE'
      : anchors.some((a) => a.timestamp_precision === 'ESTIMATED')
        ? 'ESTIMATED'
        : anchors.some((a) => a.timestamp_precision === 'CUE')
          ? 'CUE'
          : 'WORD';
    let quotePl: string | null = null;
    let helperSpan: { start: number; end: number } | null = null;
    if (helper) {
      const mappings = helper.mappings.filter(
        (row) =>
          row.segment_ids.length === segmentIds.length &&
          row.segment_ids.every((id, index) => id === segmentIds[index]),
      );
      if (mappings.length > 1) throw new Error('AMBIGUOUS_HELPER_MAPPING');
      const mapping = mappings[0];
      if (mapping) {
        if (
          !Number.isSafeInteger(mapping.start) ||
          !Number.isSafeInteger(mapping.end) ||
          mapping.start < 0 ||
          mapping.end <= mapping.start ||
          mapping.end > helper.text.length
        )
          throw new Error('INVALID_HELPER_RANGE');
        quotePl = helper.text.slice(mapping.start, mapping.end);
        helperSpan = { start: mapping.start, end: mapping.end };
      }
    }
    const anchorSnapshot = {
      source_text_version: manifest.source_text_version,
      offset_unit: manifest.offset_unit,
      source_start: start,
      source_end: end,
      manifest_hash: input.manifest_hash,
      segments: anchors.map((a) => ({
        segment_id: a.segment_id,
        parent_id: a.parent_id,
        source_start: a.source_start,
        source_end: a.source_end,
      })),
      helper: helperSpan
        ? {
            approved_mapping_id: helper!.approved_mapping_id,
            helper_artifact_id: helper!.helper_artifact_id,
            helper_hash: helper!.helper_hash,
            mapping_hash: helper!.mapping_hash,
            ...helperSpan,
          }
        : null,
    };
    const evidenceId =
      'ev_' +
      (await sha256(
        JSON.stringify({
          owner: input.owner_id,
          artifact: input.source_artifact_id,
          source: sourceHash,
          quote: quoteHash,
          anchors: anchorSnapshot,
        }),
      ));
    evidence.push({
      canonical: {
        evidence_id: evidenceId,
        source_artifact_id: input.source_artifact_id,
        source_hash: sourceHash,
        segment_ids: segmentIds,
        quote_original: quote,
        quote_pl: quotePl,
        start_ms: startMs,
        end_ms: endMs,
        timestamp_precision: precision,
        timestamp_url: timestampUrl(input.video_url, startMs),
        quote_hash: quoteHash,
      },
      anchor_snapshot: anchorSnapshot,
    });
  }
  return evidence;
}
