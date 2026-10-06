import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
import { ArtifactRepository } from '../artifacts/store.js';
import type { EvidenceRead } from '../../../contracts/src/evidence-read.js';
export class EvidenceProjection {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
    context.requireOwner();
  }
  async read(evidenceId: string, runId: string): Promise<EvidenceRead> {
    const row = await this.db
      .prepare(
        `SELECT e.*,a.content_hash,a.provenance_json,a.state artifact_state,a.kind artifact_kind,r.outcome_json,r.candidate_hash,i.canonical_url FROM evidence e JOIN analysis_evidence x ON x.owner_id=e.owner_id AND x.evidence_id=e.evidence_id JOIN analysis_runs r ON r.owner_id=x.owner_id AND r.run_id=x.run_id AND r.state='ACCEPTED' JOIN artifacts a ON a.owner_id=e.owner_id AND a.item_id=e.item_id AND a.artifact_id=e.source_artifact_id JOIN items i ON i.owner_id=e.owner_id AND i.item_id=e.item_id WHERE e.owner_id=? AND e.evidence_id=? AND r.run_id=?`,
      )
      .bind(this.context.ownerId, evidenceId, runId)
      .first<
        EvidenceRead & {
          outcome_json: string;
          candidate_hash: string;
          content_hash: string;
          provenance_json: string;
          artifact_state: string;
          artifact_kind: string;
          canonical_url: string;
          segment_ids_json: string;
          anchor_snapshot_json: string;
        }
      >();
    if (!row) throw new Error('NOT_FOUND');
    const outcome = JSON.parse(row.outcome_json) as {
      version: string;
      source_artifact_id: string;
      canonical_artifact_id: string;
      canonical_hash: string;
    };
    if (
      outcome.version !== 'intelligence-accepted:1' ||
      (await sha256(row.outcome_json)) !== row.candidate_hash ||
      outcome.source_artifact_id !== row.source_artifact_id ||
      row.source_hash !== row.content_hash ||
      row.artifact_state !== 'VERIFIED' ||
      row.artifact_kind !== 'SOURCE_ORIGINAL'
    )
      throw new Error('NOT_FOUND');
    const anchor = JSON.parse(row.anchor_snapshot_json) as {
      offset_unit: string;
      source_start: number;
      source_end: number;
      helper: unknown;
    };
    if (
      anchor.offset_unit !== 'UTF16_CODE_UNIT' ||
      anchor.source_start !== row.source_start ||
      anchor.source_end !== row.source_end ||
      anchor.helper !== null
    )
      throw new Error('INVALID_EVIDENCE_ANCHOR');
    const source = new URL(row.canonical_url);
    if (
      source.origin !== 'https://www.youtube.com' ||
      source.pathname !== '/watch' ||
      !/^[\w-]{11}$/.test(source.searchParams.get('v') ?? '') ||
      [...source.searchParams.keys()].some((key) => key !== 'v')
    )
      throw new Error('INVALID_EVIDENCE_LOCATOR');
    if (row.timestamp_url !== null) {
      const timed = new URL(row.timestamp_url);
      if (
        row.start_ms === null ||
        row.timestamp_precision === 'NONE' ||
        timed.origin !== source.origin ||
        timed.pathname !== source.pathname ||
        timed.searchParams.get('v') !== source.searchParams.get('v') ||
        timed.searchParams.get('t') !== Math.floor(row.start_ms / 1000) + 's' ||
        [...timed.searchParams.keys()].some((key) => key !== 'v' && key !== 't')
      )
        throw new Error('INVALID_EVIDENCE_LOCATOR');
    }
    const artifacts = new ArtifactRepository(this.db, this.context),
      canonical = await artifacts.get(outcome.canonical_artifact_id);
    if (
      canonical.state !== 'VERIFIED' ||
      canonical.kind !== 'ANALYSIS_CANDIDATE' ||
      canonical.schema_version !== 'intelligence-canonical:1.2' ||
      canonical.content_hash !== outcome.canonical_hash ||
      canonical.item_id !== row.item_id ||
      canonical.original_ref !== row.source_artifact_id
    )
      throw new Error('VERIFIED_ARTIFACT_REQUIRED');
    let quote: string | null = null;
    if (canonical.byte_size <= 32768 && canonical.chunk_count === 1) {
      const document = JSON.parse(
        (await artifacts.readVerifiedText(canonical.artifact_id, 32768)).text,
      ) as {
        item_id: string;
        evidence: {
          evidence_id: string;
          quote_original: string;
          quote_pl: null;
          quote_hash: string;
        }[];
      };
      const selected = document.evidence.find(
        (value) => value.evidence_id === evidenceId,
      );
      if (
        document.item_id !== row.item_id ||
        !selected ||
        selected.quote_pl !== null ||
        selected.quote_hash !== row.quote_hash ||
        (await sha256(selected.quote_original)) !== row.quote_hash ||
        selected.quote_original.length !== row.source_end - row.source_start
      )
        throw new Error('INVALID_EVIDENCE_QUOTE');
      quote = selected.quote_original;
    }
    return {
      evidence_id: row.evidence_id,
      run_id: runId,
      item_id: row.item_id,
      source_artifact_id: row.source_artifact_id,
      source_hash: row.source_hash,
      quote_hash: row.quote_hash,
      quote_original: quote,
      quote_pl: null,
      quote_transport: quote === null ? 'PAGED_CANONICAL' : 'INLINE_CANONICAL',
      canonical_reference: {
        artifact_id: canonical.artifact_id,
        content_hash: canonical.content_hash,
        first_page:
          '/api/v1/items/' +
          encodeURIComponent(row.item_id) +
          '/canonical?' +
          new URLSearchParams({ run_id: runId, start: '0' }),
      },
      source_start: row.source_start,
      source_end: row.source_end,
      offset_unit: 'UTF16_CODE_UNIT',
      segment_ids: JSON.parse(row.segment_ids_json) as string[],
      start_ms: row.start_ms,
      end_ms: row.end_ms,
      timestamp_precision: row.timestamp_precision,
      timestamp_url: row.timestamp_url,
      source_url: source.href,
      provenance: Object.fromEntries(
        Object.entries(
          JSON.parse(row.provenance_json) as Record<string, unknown>,
        ).filter(
          ([key, value]) =>
            [
              'provider_id',
              'upstream_track_id',
              'language',
              'language_code',
              'track_kind',
              'is_generated',
              'is_original',
              'is_translated',
              'adapter_version',
              'source_timestamp_fidelity',
            ].includes(key) &&
            (typeof value === 'string' || typeof value === 'boolean'),
        ),
      ),
      helper_available: false,
    };
  }
}
