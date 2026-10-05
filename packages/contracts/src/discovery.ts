export interface SourceIdentity {
  namespace: 'youtube';
  external_id: string;
  canonical_locator: string;
  title: string;
  uploads_playlist_id: string;
  handle: string | null;
}
export interface ItemMetadata {
  namespace: string;
  external_id: string;
  item_type: 'video' | 'short' | 'live' | 'unknown';
  canonical_url: string;
  title: string;
  published_at: string | null;
  publication_provenance: string;
  availability: 'PUBLIC' | 'PRIVATE' | 'DELETED' | 'UNKNOWN' | 'LIVE';
  duration_seconds: number | null;
}
export interface CoreItem extends ItemMetadata {
  item_id: string;
  source_id: string;
  current_revision_id: string;
  discovered_at: string;
}
