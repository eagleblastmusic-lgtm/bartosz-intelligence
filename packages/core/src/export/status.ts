import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import type { DailyExportStatus } from '../../../contracts/src/drive.js';

const reasons = new Set([
  'NO_MATERIAL_CHANGE',
  'EXPORT_CONFLICT',
  'EXPORT_AMBIGUOUS',
  'EXPORT_RECOVERY_REQUIRED',
  'DRIVE_UNQUALIFIED_UPDATE',
  'DRIVE_AUTH',
  'DRIVE_QUOTA',
  'DRIVE_STORAGE',
  'DRIVE_TRANSIENT',
  'DRIVE_TRANSPORT',
  'DRIVE_NOT_FOUND',
  'DRIVE_CONFLICT',
]);
export async function exportStatus(
  db: Database,
  access: AccessContext,
  now: Date,
): Promise<DailyExportStatus> {
  assertContext(access);
  access.requireOwner();
  if (!Number.isFinite(now.getTime())) throw new Error('INVALID_EXPORT_CLOCK');
  const rows = (
    await db
      .prepare(
        `SELECT e.root_namespace root_id,e.publication_date date,e.connection_id,COALESCE(e.desired_mode,e.mode) desired_mode,e.mode remote_mode,e.settings_revision,e.desired_generation,e.exported_generation,e.dirty_seq,e.exported_seq,e.revision remote_revision,e.file_id,a.revision rendered_revision,a.source_change_seq rendered_cut,a.byte_count rendered_bytes,c.auth_state,c.root_state,e.lease_until,e.first_dirty_at,e.last_material_event_at,(SELECT MAX(p.updated_at) FROM drive_export_attempts p WHERE p.owner_id=e.owner_id AND p.reserved_remote_id=e.reserved_remote_id AND p.state='VERIFIED') last_verified_at,(SELECT p.reason FROM drive_export_attempts p WHERE p.owner_id=e.owner_id AND p.artifact_id=e.rendered_artifact_id) retry_reason FROM export_state e JOIN drive_connections c ON c.owner_id=e.owner_id AND c.connection_id=e.connection_id LEFT JOIN daily_export_artifacts a ON a.owner_id=e.owner_id AND a.artifact_id=e.rendered_artifact_id AND a.state='SEALED' WHERE e.owner_id=? AND e.destination_key GLOB 'drive:*' ORDER BY e.publication_date DESC,e.root_namespace LIMIT 51`,
      )
      .bind(access.ownerId)
      .all<
        DailyExportStatus['days'][number] & {
          lease_until: string | null;
          first_dirty_at: string | null;
          last_material_event_at: string | null;
        }
      >()
  ).results;
  return {
    automatic_updates_qualified: false,
    truncated: rows.length > 50,
    days: rows
      .slice(0, 50)
      .map(
        ({ lease_until, first_dirty_at, last_material_event_at, ...row }) => {
          const pending =
            row.remote_revision === 0 ||
            row.dirty_seq > row.exported_seq ||
            row.desired_generation > row.exported_generation;
          const due =
            pending && first_dirty_at && last_material_event_at
              ? Math.min(
                  Date.parse(first_dirty_at) + 1800000,
                  Date.parse(last_material_event_at) + 600000,
                )
              : null;
          const due_at =
            due !== null && Number.isFinite(due)
              ? new Date(due).toISOString()
              : null;
          const queue_state =
            row.auth_state !== 'CONNECTED'
              ? 'AUTH_REQUIRED'
              : row.root_state !== 'VERIFIED'
                ? 'ROOT_REQUIRED'
                : lease_until && lease_until > now.toISOString()
                  ? 'LEASED'
                  : !pending
                    ? 'CURRENT'
                    : due_at && due_at <= now.toISOString()
                      ? 'DUE'
                      : 'WAITING';
          return {
            ...row,
            retry_reason:
              row.retry_reason === null || reasons.has(row.retry_reason)
                ? row.retry_reason
                : 'EXPORT_RECOVERY_REQUIRED',
            queue_state,
            due_at,
          };
        },
      ),
  };
}
