/** Owner-visible metadata only. No account subject or credential values. */
export interface DailyExportStatus {
  automatic_updates_qualified: false;
  truncated: boolean;
  days: {
    root_id: string;
    date: string;
    connection_id: string;
    desired_mode: 'COMPACT' | 'FULL';
    remote_mode: 'COMPACT' | 'FULL';
    settings_revision: number;
    desired_generation: number;
    exported_generation: number;
    dirty_seq: number;
    exported_seq: number;
    remote_revision: number;
    file_id: string | null;
    rendered_revision: number | null;
    rendered_cut: number | null;
    rendered_bytes: number | null;
    auth_state: string;
    root_state: string;
    last_verified_at: string | null;
    retry_reason: string | null;
    retry_count?: number;
    next_retry_at?: string | null;
    paused_reason?: string | null;
    queue_state:
      | 'AUTH_REQUIRED'
      | 'ROOT_REQUIRED'
      | 'LEASED'
      | 'WAITING'
      | 'DUE'
      | 'PAUSED'
      | 'RETRY_WAIT'
      | 'CURRENT';
    due_at: string | null;
  }[];
}
export interface DriveStatus {
  root_candidates?: {
    connection_id: string;
    name: string;
    folder_id: string;
    state: 'RESERVED' | 'CREATED';
  }[];
  root_candidates_truncated?: boolean;
  configured: boolean;
  export_capability: 'NOT_YET_VERIFIED';
  truncated: boolean;
  connections: {
    connection_id: string;
    auth_state: string;
    root_id: string | null;
    root_state: string;
    publishing_state: string;
    revision: number;
    last_refresh_at: string | null;
    last_error: string | null;
    scopes: string[];
    offline_credential_present: boolean;
  }[];
}
