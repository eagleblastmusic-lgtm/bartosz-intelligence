export const dailyCategories = [
  'Nauka',
  'AI i Robotyka',
  'Polityka',
  'Pozostałe',
] as const;
export type DailyCategory = (typeof dailyCategories)[number];
export const canonicalTranscriptRoot = '12dfjXGqDL7hFKsGvTxp_3CVi78V8YdSP';
export const canonicalReportRoot = '1dpd-8GV-S675Jhv4zWdlldaIiJOy5XDt';
export interface DailyManifestEntry {
  video_id: string;
  title: string;
  youtube_url: string;
  transcript_file_id: string | null;
  transcript_sha256: string | null;
  source_sha256: string;
  acquired_at: string;
  state: 'READY' | 'PENDING';
}
export interface DailyManifest {
  schema: 'bi-daily-manifest:1';
  material_date: string;
  timezone: 'Europe/Warsaw';
  closed_at: string;
  expected_count: number;
  ready_count: number;
  entries: DailyManifestEntry[];
}
export interface DailyReportVideo {
  video_id: string;
  title: string;
  category: DailyCategory;
  youtube_url: string;
  transcript_file_id: string | null;
  material_date: string;
  status: 'PROCESSED' | 'UNPROCESSED';
  reason: string | null;
  summary: string;
}
export interface DailyReport {
  schema: 'bi-daily-report:1';
  material_date: string;
  generated_at: string;
  timezone: 'Europe/Warsaw';
  manifest_sha256: string;
  expected_count: number;
  processed_count: number;
  skipped_count: number;
  videos: DailyReportVideo[];
}
export interface DailyReportSnapshot {
  material_date: string;
  timezone: 'Europe/Warsaw';
  state:
    | 'DISABLED'
    | 'OPEN'
    | 'WAITING_FILES'
    | 'MISSING'
    | 'PARTIAL'
    | 'COMPLETE'
    | 'INTEGRITY_HOLD';
  expected_count: number;
  ready_count: number;
  processed_count: number;
  skipped_count: number;
  manifest_sha256: string | null;
  manifest_file_id: string | null;
  report_file_id: string | null;
  verified_at: string | null;
  videos: DailyReportVideo[];
  missing_video_ids: string[];
  pending_video_ids: string[];
}
