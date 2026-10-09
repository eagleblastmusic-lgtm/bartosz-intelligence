import type { AnalysisReadiness, AcceptedView } from './daily.js';
export interface CanonicalDescriptor {
  artifact_id: string;
  content_hash: string;
  byte_size: number;
  chunk_count: number;
  schema_version: string;
}
export interface ItemDetail {
  archive?: {
    file_id: string;
    remote_version: string;
    verified_at: string;
    phase: string;
  } | null;
  item_id: string;
  title: string;
  creator: string;
  canonical_url: string;
  published_at: string | null;
  analysis_status: AnalysisReadiness;
  processing_state: string | null;
  reason: string | null;
  selected_run_id: string | null;
  selection_revision: number | null;
  view: AcceptedView | null;
  canonical: CanonicalDescriptor | null;
  semantic_verification: 'NOT_ASSERTED';
}
export interface CanonicalPage {
  descriptor: CanonicalDescriptor;
  chunks: {
    chunk_index: number;
    byte_start: number;
    byte_size: number;
    byte_hash: string;
    body_base64: string;
  }[];
  next_index: number | null;
}
