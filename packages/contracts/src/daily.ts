export type AnalysisReadiness =
  'READY' | 'PARTIAL' | 'PENDING' | 'BLOCKED' | 'FAILED' | 'REVIEW_REQUIRED';
export interface DailyCounts {
  items: number;
  ready: number;
  pending: number;
  blocked: number;
  failed: number;
}
export interface AcceptedView {
  version: 'accepted-view:1';
  status: string;
  enabled_modules: string[];
  coverage_complete: boolean;
  summary_pl: { text_pl: string; evidence_ids: string[] }[];
  key_points: { text_pl: string; evidence_ids: string[] }[];
  entities: { entity_id: string; label: string; entity_type: string }[];
  tools: { entity_ref: string; context_pl: string }[];
  typed_counts: Record<string, number>;
}
export interface DailyItemView {
  item_id: string;
  source_id: string;
  title: string;
  creator: string;
  canonical_url: string;
  published_at: string | null;
  publication_provenance: string;
  duration_seconds: number | null;
  metadata_revision: string;
  selected_run_id: string | null;
  selection_revision: number | null;
  analysis_status: AnalysisReadiness;
  reason: string | null;
  retry_at: string | null;
  processing_state: string | null;
  view: AcceptedView | null;
}
export interface SourceCoverage {
  source_id: string;
  title: string;
  enabled: boolean;
  window_start: string | null;
  last_complete_window_end: string | null;
  complete_windows: {
    window_start: string;
    window_end: string;
    completed_at: string;
  }[];
  incomplete_windows: {
    window_start: string;
    window_end: string;
    coverage: string;
    started_at: string;
  }[];
}
export interface DailySnapshot {
  date: string | null;
  timezone: 'Europe/Warsaw';
  cut_seq: number;
  projection_revision: string;
  counts: DailyCounts;
  discovery_complete: boolean;
  complete: boolean;
  partial: boolean;
  items: DailyItemView[];
  next_cursor: string | null;
  source_coverage: SourceCoverage[];
  freshness: { sampled_at: string; status: 'CURRENT' };
}
export interface CalendarSnapshot {
  month: string;
  timezone: 'Europe/Warsaw';
  cut_seq: number;
  projection_revision: string;
  days: {
    date: string;
    counts: DailyCounts;
    discovery_complete: boolean;
    complete: boolean;
  }[];
  freshness: { sampled_at: string; status: 'CURRENT' };
}
