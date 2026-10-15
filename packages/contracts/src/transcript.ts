export const transcriptStatuses = [
  'OK',
  'PARTIAL',
  'NO_CAPTIONS',
  'IP_BLOCKED',
  'RATE_LIMITED',
  'AUTH_REQUIRED',
  'REGION_BLOCKED',
  'UNAVAILABLE',
  'PARSE_ERROR',
  'UPSTREAM_CHANGED',
  'TOO_LARGE',
  'TEMPORARY_FAILURE',
] as const;
export type TranscriptStatus = (typeof transcriptStatuses)[number];
export type TrackKind =
  'MANUAL' | 'GENERATED' | 'TRANSLATED' | 'STT' | 'UNKNOWN';
export type TimestampPrecision = 'CUE' | 'WORD' | 'ESTIMATED' | 'NONE';
export interface SourceItemRef {
  detected_at?: string;
  /** Verified YouTube videos.snippet.defaultAudioLanguage, never title/defaultLanguage. */
  default_audio_language?: string | null;
  item_id: string;
  namespace: 'youtube';
  external_id: string;
  duration_ms: number | null;
}
export interface TranscriptRequestContext {
  job_id: string;
  item_id: string;
  runtime_id: 'local' | 'cloud';
  deadline: string;
  max_bytes: number;
  quota_reservation_id: string | null;
  provider_version: string;
  request_id: string;
}
export interface TranscriptCapabilities {
  provider_id: string;
  provider_version: string;
  runtime_id: 'local' | 'cloud';
  track_listing: boolean;
  manual_flags: boolean;
  generated_flags: boolean;
  languages: 'upstream';
  timestamps: readonly TimestampPrecision[];
  youtube_translation: boolean;
  stt: boolean;
  max_input_bytes: number;
  free_eligibility: boolean;
  paid_services_enabled: false;
}
export interface TrackRef {
  track_id: string;
  item_id: string;
  language_code: string;
  track_kind: TrackKind;
  is_generated: boolean | null;
  is_translated: boolean | null;
  source_language: string | null;
  translation_source_track_id: string | null;
  is_translatable: boolean | null;
  translation_languages: string[];
  is_original: boolean | null;
  extension: string;
  expires_at: string;
}
export interface TrackListResult {
  status: TranscriptStatus;
  failure_code: string | null;
  provider_id: string;
  provider_version: string;
  runtime_id: 'local' | 'cloud';
  tracks: TrackRef[];
  video_language: string | null;
  retrieved_at: string;
  request_id: string;
}
export interface TranscriptSegment {
  upstream_index: number;
  start_ms: number | null;
  end_ms: number | null;
  text: string;
  speaker_label: string | null;
}
export interface TranscriptResult {
  status: TranscriptStatus;
  provider_id: string;
  provider_version: string;
  runtime_id: 'local' | 'cloud';
  upstream_track_id: string | null;
  language_code: string | null;
  language_detection_method: string;
  track_kind: TrackKind;
  is_generated: boolean | null;
  is_translated: boolean | null;
  source_language: string | null;
  translation_source_track_id: string | null;
  is_translatable: boolean | null;
  translation_languages: string[];
  segments: TranscriptSegment[];
  raw_payload_hash: string | null;
  raw_artifact_id: string | null;
  retrieved_at: string;
  duration_covered_ms: number | null;
  timestamp_precision: TimestampPrecision;
  failure_code: string | null;
  retry_after: string | null;
  usage: { upstream_requests: number | null; bytes_received: number | null };
  warnings: string[];
  missing_ranges: { start_ms: number | null; end_ms: number | null }[];
  request_id: string;
}
export interface TranscriptFetch {
  result: TranscriptResult;
  raw_payload: Uint8Array | null;
}
export interface TranscriptProvider {
  capabilities(runtime: 'local' | 'cloud'): TranscriptCapabilities;
  list_tracks(
    item: SourceItemRef,
    context: TranscriptRequestContext,
  ): Promise<TrackListResult>;
  fetch(
    item: SourceItemRef,
    track: TrackRef,
    context: TranscriptRequestContext,
  ): Promise<TranscriptFetch>;
}
