/** Owner-visible metadata only. No account subject or credential values. */
export interface DriveStatus {
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
