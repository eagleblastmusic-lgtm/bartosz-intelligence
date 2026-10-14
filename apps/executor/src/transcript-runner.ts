import type {
  SourceItemRef,
  TranscriptProvider,
  TranscriptRequestContext,
  TranscriptStatus,
} from '../../../packages/contracts/src/transcript.js';
import {
  selectTranscriptLanguage,
  type LanguageSelection,
} from '../../../packages/core/src/transcript/language.js';
import { normalizeTranscript } from '../../../packages/core/src/transcript/normalize.js';
import { sha256 } from '../../../packages/core/src/auth/crypto.js';
import { captionArchiveCoverage } from '../../../packages/core/src/transcript/archive-renderer.js';
import {
  freeTranscriptAdmission,
  type FreeTranscriptObservation,
} from '../../../packages/core/src/transcript/free-budget.js';
import type { ArtifactClient } from './artifact-client.js';
export interface TranscriptLifecycle {
  admission(): Promise<{ available: boolean; reason: string | null }>;
  heartbeat(): Promise<void>;
  outcome(status: TranscriptStatus): Promise<void>;
  diagnostic(code: string): Promise<void>;
  accept(source: {
    raw_artifact_id: string;
    source_artifact_id: string;
    normalized_artifact_id: string;
    segment_map_artifact_id: string;
    offset_map_artifact_id: string;
    selection: LanguageSelection;
    warnings: string[];
  }): Promise<void>;
}
export async function executeTranscript(
  item: SourceItemRef,
  context: TranscriptRequestContext & { signal?: AbortSignal },
  provider: TranscriptProvider,
  artifacts: Pick<ArtifactClient, 'upload'>,
  lifecycle: TranscriptLifecycle,
  heartbeatMs = 60000,
  cloudObservation: FreeTranscriptObservation | null = null,
) {
  if (
    !['local', 'cloud'].includes(context.runtime_id) ||
    heartbeatMs < 10 ||
    heartbeatMs > 60000
  )
    throw new Error('INVALID_TRANSCRIPT_RUNTIME');
  const capabilities = provider.capabilities(context.runtime_id);
  if (
    !capabilities.free_eligibility ||
    capabilities.paid_services_enabled !== false ||
    !capabilities.track_listing ||
    capabilities.provider_version !== context.provider_version ||
    capabilities.runtime_id !== context.runtime_id ||
    context.max_bytes > capabilities.max_input_bytes
  )
    throw new Error('TRANSCRIPT_PROVIDER_NOT_QUALIFIED');
  if (context.runtime_id === 'cloud') {
    const budget = freeTranscriptAdmission(cloudObservation, new Date());
    if (!budget.available) return { accepted: false, reason: budget.reason };
  }
  const admitted = await lifecycle.admission();
  if (!admitted.available) return { accepted: false, reason: admitted.reason };
  let lost = false,
    pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending
      .then(() => lifecycle.heartbeat())
      .catch(() => {
        lost = true;
      });
  }, heartbeatMs);
  const requireLease = async () => {
    context.signal?.throwIfAborted();
    await pending;
    if (lost) throw new Error('STALE_TRANSCRIPT_LEASE');
    try {
      await lifecycle.heartbeat();
    } catch {
      lost = true;
      throw new Error('STALE_TRANSCRIPT_LEASE');
    }
  };
  try {
    const list = await provider.list_tracks(item, context);
    if (list.status !== 'OK') {
      await lifecycle.outcome(list.status);
      return { accepted: false, reason: list.failure_code ?? list.status };
    }
    const selected = selectTranscriptLanguage(list, '0'.repeat(64));
    if (selected.status !== 'SELECTED') {
      await lifecycle.diagnostic('UNKNOWN_SOURCE_AUTHORITY');
      return { accepted: false, reason: 'UNKNOWN_SOURCE_AUTHORITY' };
    }
    const fetched = await provider.fetch(item, selected.source!, context),
      result = fetched.result;
    context.signal?.throwIfAborted();
    const partial =
      result.status === 'PARTIAL' || result.missing_ranges.length > 0;
    if (result.status !== 'OK' && result.status !== 'PARTIAL') {
      await lifecycle.outcome(result.status);
      return { accepted: false, reason: result.failure_code ?? result.status };
    }
    if (
      !fetched.raw_payload ||
      !fetched.raw_payload.length ||
      result.upstream_track_id !== selected.source!.track_id ||
      result.language_code !== selected.source!.language_code ||
      result.is_translated !== false ||
      result.track_kind !== selected.source!.track_kind ||
      result.is_generated !== selected.source!.is_generated ||
      !result.segments.length ||
      result.segments.some((cue) => !cue.text.trim())
    )
      throw new Error('INVALID_TRANSCRIPT_AUTHORITY');
    const rawText = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(fetched.raw_payload);
    if ((await sha256(rawText)) !== result.raw_payload_hash)
      throw new Error('RAW_TRANSCRIPT_HASH_MISMATCH');
    const sourceText = result.segments.map((cue) => cue.text).join('\n');
    const hash = await sha256(sourceText),
      selection = selectTranscriptLanguage(list, hash);
    const provenance = {
      provider_id: result.provider_id,
      provider_version: result.provider_version,
      raw_payload_hash: result.raw_payload_hash,
      upstream_track_id: result.upstream_track_id,
      language_code: result.language_code,
      track_kind: result.track_kind,
      is_generated: result.is_generated,
      is_translated: result.is_translated,
      is_original: selection.source!.is_original,
      video_language: list.video_language,
      original_language:
        selection.authority_basis === 'EXPLICIT_ORIGINAL'
          ? (list.tracks.find((track) => track.is_original === true)
              ?.language_code ?? null)
          : null,
      archive_source_status: partial ? 'PARTIAL' : 'AVAILABLE_FULL',
      missing_ranges: result.missing_ranges,
      timestamp_precision: result.timestamp_precision,
      warnings: [...result.warnings].sort(),
    };
    // Source status is immutable provenance. Acquisition time must not change
    // deduplication; a changed status needs its own descriptor identity even
    // when the decoded caption bytes are identical to an earlier acquisition.
    const archiveIdentity =
      ':archive-source:1:' + (await sha256(JSON.stringify(provenance)));
    await requireLease();
    const raw = await artifacts.upload(rawText, {
      item_id: item.item_id,
      kind: 'RAW',
      schema_version: 'caption-payload:1',
      producer_version: result.provider_version + archiveIdentity,
      provenance,
      original_ref: null,
    });
    const source = await artifacts.upload(sourceText, {
      item_id: item.item_id,
      kind: 'SOURCE_ORIGINAL',
      schema_version: 'decoded-cue-text:1',
      producer_version: result.provider_version + archiveIdentity,
      provenance,
      original_ref: null,
    });
    await artifacts.upload(
      JSON.stringify(captionArchiveCoverage(hash, result.segments)),
      {
        item_id: item.item_id,
        kind: 'SEGMENT_MAP',
        schema_version: 'caption-coverage:1',
        producer_version: 'caption-coverage:1' + archiveIdentity,
        provenance: { ...provenance, source_revision: hash },
        original_ref: source.artifact_id,
      },
    );
    await requireLease();
    // Archive captured original cues even when partial or AI normalization fails.
    if (partial) {
      await lifecycle.diagnostic('INCOMPLETE_SOURCE');
      return { accepted: false, reason: 'INCOMPLETE_SOURCE' };
    }
    const normalized = await normalizeTranscript(
      hash,
      result.segments,
      result.timestamp_precision,
    );
    const descriptor = {
      item_id: item.item_id,
      producer_version:
        normalized.manifest.normalizer_version + archiveIdentity,
      provenance: { ...provenance, source_revision: hash },
      original_ref: source.artifact_id,
    };
    const text = await artifacts.upload(
      normalized.manifest.anchors.map((a) => a.text).join('\n'),
      {
        ...descriptor,
        kind: 'NORMALIZED',
        schema_version: 'normalized-source:1',
      },
    );
    const map = await artifacts.upload(JSON.stringify(normalized.manifest), {
      ...descriptor,
      kind: 'SEGMENT_MAP',
      schema_version: 'segment-map:1',
    });
    const offsets = await artifacts.upload(
      JSON.stringify(
        normalized.manifest.anchors.map((a) => ({
          segment_id: a.segment_id,
          offsets: a.offsets,
        })),
      ),
      { ...descriptor, kind: 'OFFSET_MAP', schema_version: 'offset-map:1' },
    );
    await requireLease();
    await lifecycle.accept({
      raw_artifact_id: raw.artifact_id,
      source_artifact_id: source.artifact_id,
      normalized_artifact_id: text.artifact_id,
      segment_map_artifact_id: map.artifact_id,
      offset_map_artifact_id: offsets.artifact_id,
      selection,
      warnings: [...result.warnings],
    });
    return { accepted: true, reason: null };
  } catch (error) {
    if (context.signal?.aborted) throw error;
    if (lost) {
      await lifecycle.diagnostic('STALE_TRANSCRIPT_LEASE');
      return { accepted: false, reason: 'STALE_TRANSCRIPT_LEASE' };
    }
    throw error;
  } finally {
    clearInterval(timer);
    await pending;
  }
}
