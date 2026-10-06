export interface EvidenceRead {
  evidence_id: string;
  run_id: string;
  item_id: string;
  source_artifact_id: string;
  source_hash: string;
  quote_hash: string;
  quote_original: string | null;
  quote_pl: null;
  quote_transport: 'INLINE_CANONICAL' | 'PAGED_CANONICAL';
  canonical_reference: {
    artifact_id: string;
    content_hash: string;
    first_page: string;
  };
  source_start: number;
  source_end: number;
  offset_unit: 'UTF16_CODE_UNIT';
  segment_ids: string[];
  start_ms: number | null;
  end_ms: number | null;
  timestamp_precision: 'CUE' | 'WORD' | 'ESTIMATED' | 'NONE';
  timestamp_url: string | null;
  source_url: string;
  provenance: Record<string, unknown>;
  helper_available: false;
}
