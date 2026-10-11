import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { decode64 } from '../auth/crypto.js';
import type { DailyExportStatus } from '../../../contracts/src/drive.js';

const reasons = new Set([
  'NO_MATERIAL_CHANGE',
  'EXPORT_CONFLICT',
  'EXPORT_AMBIGUOUS',
  'EXPORT_RECOVERY_REQUIRED',
  'ARCHIVED_REPORT_REQUIRES_RECOVERY',
  'DRIVE_UNQUALIFIED_UPDATE',
  'DRIVE_AUTH',
  'DRIVE_QUOTA',
  'DRIVE_STORAGE',
  'DRIVE_TRANSIENT',
  'DRIVE_TRANSPORT',
  'DRIVE_NOT_FOUND',
  'DRIVE_CONFLICT',
  'DRIVE_AUTHORIZATION',
]);
function reportMetrics(
  prefix: string | null,
  byteCount: number | null,
): DailyExportStatus['days'][number]['report_metrics'] {
  if (!prefix || byteCount === null || byteCount < 1) return null;
  try {
    const value = new TextDecoder().decode(decode64(prefix));
    const end = value.indexOf('\n---\n\n');
    if (!value.startsWith('---\n') || end < 0) return null;
    const header = value.slice(0, end);
    if (
      !header.includes('\nreport_schema_version: "1.1"\n') ||
      !/\nrenderer_version: "daily-renderer:1\.[123]"\n/.test(header)
    )
      return null;
    const field = (name: string) => {
      const matches = [
        ...header.matchAll(new RegExp('^' + name + ': (.+)$', 'gm')),
      ];
      if (matches.length !== 1) throw new Error('INVALID_REPORT_METRIC');
      return matches[0]![1]!;
    };
    const number = (name: string) => {
      const value = field(name),
        result = Number(value);
      if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(result))
        throw new Error('INVALID_REPORT_METRIC');
      return result;
    };
    const size = field('bridge_size_state'),
      coverage = field('discovery_coverage'),
      items = number('item_count'),
      ready = number('ready_count'),
      pending = number('pending_count'),
      level = number('compaction_level');
    if (
      !['WITHIN_ESTIMATE', 'OVERSIZE'].includes(size) ||
      !['complete', 'incomplete'].includes(coverage) ||
      items !== ready + pending ||
      level > 3
    )
      return null;
    return {
      estimated_tokens: Math.ceil(byteCount / 3),
      estimator_version: 'utf8-ceil-div3:1',
      compaction_level: level,
      size_state: size as 'WITHIN_ESTIMATE' | 'OVERSIZE',
      item_count: items,
      ready_count: ready,
      pending_count: pending,
      discovery_coverage: coverage as 'complete' | 'incomplete',
    };
  } catch {
    return null;
  }
}
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
        `SELECT e.root_namespace root_id,e.publication_date date,e.connection_id,COALESCE(e.desired_mode,e.mode) desired_mode,e.mode remote_mode,e.settings_revision,e.retry_count,e.next_retry_at,e.paused_reason,e.desired_generation,e.exported_generation,e.dirty_seq,e.exported_seq,e.revision remote_revision,e.file_id,a.revision rendered_revision,a.source_change_seq rendered_cut,a.byte_count rendered_bytes,(SELECT substr(k.data_base64,1,2048) FROM daily_export_chunks k WHERE k.owner_id=e.owner_id AND k.artifact_id=a.artifact_id AND k.ordinal=0) report_header_prefix,c.auth_state,c.root_state,c.root_id current_root_id,e.lease_until,e.first_dirty_at,e.last_material_event_at,(SELECT MAX(p.updated_at) FROM drive_export_attempts p WHERE p.owner_id=e.owner_id AND p.reserved_remote_id=e.reserved_remote_id AND p.state='VERIFIED') last_verified_at,COALESCE(e.last_failure_code,(SELECT p.reason FROM drive_export_attempts p WHERE p.owner_id=e.owner_id AND p.artifact_id=e.rendered_artifact_id)) retry_reason FROM export_state e JOIN drive_connections c ON c.owner_id=e.owner_id AND c.connection_id=e.connection_id LEFT JOIN daily_export_artifacts a ON a.owner_id=e.owner_id AND a.artifact_id=e.rendered_artifact_id AND a.state='SEALED' WHERE e.owner_id=? AND e.destination_key GLOB 'drive:*' ORDER BY e.publication_date DESC,e.root_namespace LIMIT 51`,
      )
      .bind(access.ownerId)
      .all<
        DailyExportStatus['days'][number] & {
          report_header_prefix: string | null;
          current_root_id: string | null;
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
        ({
          report_header_prefix,
          current_root_id,
          lease_until,
          first_dirty_at,
          last_material_event_at,
          ...row
        }) => {
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
              : row.root_state !== 'VERIFIED' || current_root_id !== row.root_id
                ? 'ROOT_REQUIRED'
                : row.paused_reason
                  ? 'PAUSED'
                  : row.next_retry_at && row.next_retry_at > now.toISOString()
                    ? 'RETRY_WAIT'
                    : lease_until && lease_until > now.toISOString()
                      ? 'LEASED'
                      : !pending
                        ? 'CURRENT'
                        : due_at && due_at <= now.toISOString()
                          ? 'DUE'
                          : 'WAITING';
          return {
            ...row,
            report_metrics: reportMetrics(
              report_header_prefix,
              row.rendered_bytes,
            ),
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
