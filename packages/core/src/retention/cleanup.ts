import {
  type Database,
  type AccessContext,
  assertContext,
} from '../db/boundary.js';
import { AccessContext as Access } from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
import type { DriveClient } from '../drive/client.js';
import { capacityItemSelect } from '../projections/capacity-collection.js';

export const retentionDays = 7;
export interface RetainedItem {
  owner_id: string;
  item_id: string;
  accepted_run_id: string;
  canonical_hash: string;
  root_id: string;
  publication_date: string;
  artifact_id: string;
  file_id: string;
  remote_version: string;
  export_revision: number;
  file_hash: string;
  verified_at: string;
  purge_after: string;
  phase: 'WAITING' | 'PRUNING' | 'COMPLETE';
  step: number;
  cursor: number;
  deleted_rows: number;
  deleted_bytes: number;
  hold_reason: string | null;
  last_block_reason: string | null;
}
// Aliases in this predicate are stable: t is the owner-scoped retention receipt.
const eligible = `t.hold_reason IS NULL AND t.purge_after<=? AND
 EXISTS(SELECT 1 FROM export_state e JOIN drive_connections c ON c.owner_id=e.owner_id AND c.connection_id=e.connection_id
 JOIN drive_export_attempts a ON a.owner_id=e.owner_id AND a.artifact_id=t.artifact_id
 WHERE e.owner_id=t.owner_id AND e.root_namespace=t.root_id AND e.publication_date=t.publication_date
 AND e.file_id=t.file_id AND e.full_file_hash=t.file_hash AND e.revision=t.export_revision
 AND e.dirty_seq<=e.exported_seq AND e.desired_generation<=e.exported_generation
 AND e.paused_reason IS NULL AND (e.lease_until IS NULL OR e.lease_until<=?)
 AND c.auth_state='CONNECTED' AND c.root_state='VERIFIED' AND c.root_id=t.root_id
 AND a.state='VERIFIED' AND a.verified_hash=t.file_hash AND a.remote_version=t.remote_version)
 AND EXISTS(SELECT 1 FROM analysis_runs r JOIN active_analysis_selections s ON s.owner_id=r.owner_id AND s.item_id=r.item_id AND s.accepted_run_id=r.run_id
 WHERE r.owner_id=t.owner_id AND r.item_id=t.item_id AND r.run_id=t.accepted_run_id AND r.state='ACCEPTED'
 AND (t.phase='PRUNING' OR (json_extract(r.outcome_json,'$.version')='intelligence-accepted:1'
 AND json_extract(r.outcome_json,'$.view.coverage_complete')=1 AND json_extract(r.outcome_json,'$.view.status')='OK')))
 AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.owner_id=t.owner_id AND j.state!='SUCCEEDED' AND
 (j.item_id=t.item_id OR j.task_type IN ('HISTORICAL_COMPARE','REPROCESS','TRANSLATE','PROJECT')))
 AND NOT EXISTS(SELECT 1 FROM observations o JOIN analysis_runs r ON r.owner_id=o.owner_id AND r.run_id=o.run_id
 JOIN correction_overlays c ON c.owner_id=o.owner_id AND c.target_kind='OBSERVATION_TEXT' AND c.target_id=o.observation_id WHERE r.owner_id=t.owner_id AND r.item_id=t.item_id)
 AND NOT EXISTS(SELECT 1 FROM insights n WHERE n.owner_id=t.owner_id AND n.item_id=t.item_id AND n.active=1)
 AND NOT EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

type Stage = { table: string; where: string; bytes: string; redact?: string };
const itemRuns =
  'SELECT run_id FROM analysis_runs WHERE owner_id=? AND item_id=?';
const observations = `SELECT o.observation_id FROM observations o JOIN analysis_runs r ON r.owner_id=o.owner_id AND r.run_id=o.run_id WHERE r.owner_id=? AND r.item_id=?`;
export const cleanupStages: readonly Stage[] = [
  {
    table: 'artifact_chunks',
    where: 'owner_id=? AND item_id=?',
    bytes: 'byte_size',
  },
  {
    table: 'transcript_representations',
    where: 'owner_id=? AND item_id=?',
    bytes: 'length(CAST(flags_json AS BLOB))',
  },
  {
    table: 'candidate_repair_attempts',
    where: 'owner_id=? AND item_id=?',
    bytes: '0',
  },
  {
    table: 'optional_ai_results',
    where: 'owner_id=? AND item_id=?',
    bytes: '0',
  },
  {
    table: 'insight_observations',
    where: `owner_id=? AND observation_id IN (${observations})`,
    bytes: '0',
  },
  {
    table: 'observation_evidence',
    where: `owner_id=? AND observation_id IN (${observations})`,
    bytes: '0',
  },
  {
    table: 'observation_entities',
    where: `owner_id=? AND observation_id IN (${observations})`,
    bytes: '0',
  },
  {
    table: 'analysis_evidence',
    where: `owner_id=? AND run_id IN (${itemRuns})`,
    bytes: '0',
  },
  {
    table: 'observations',
    where: `owner_id=? AND run_id IN (${itemRuns})`,
    bytes: 'length(CAST(row_json AS BLOB))',
  },
  {
    table: 'evidence',
    where: 'owner_id=? AND item_id=?',
    bytes:
      'length(CAST(anchor_snapshot_json AS BLOB))+length(CAST(segment_ids_json AS BLOB))',
  },
  {
    table: 'search_documents',
    where: 'owner_id=? AND item_id=?',
    bytes: 'length(CAST(text AS BLOB))+length(CAST(search_text AS BLOB))',
  },
  {
    table: 'analysis_runs',
    where:
      "owner_id=? AND item_id=? AND COALESCE(json_extract(outcome_json,'$.version'),'')!='intelligence-archived:1'",
    bytes:
      'length(CAST(input_snapshot_json AS BLOB))+length(CAST(profile_snapshot_json AS BLOB))+COALESCE(length(CAST(prompt_snapshot_json AS BLOB)),0)+length(CAST(routing_snapshot_json AS BLOB))+COALESCE(length(CAST(outcome_json AS BLOB)),0)',
    redact: `input_snapshot_json='{}',profile_snapshot_json='{}',prompt_snapshot_json=NULL,routing_snapshot_json='{}',outcome_json='{"version":"intelligence-archived:1"}'`,
  },
  {
    table: 'jobs',
    where:
      "owner_id=? AND item_id=? AND state='SUCCEEDED' AND payload_json!='{}'",
    bytes: 'length(CAST(payload_json AS BLOB))-2',
    redact: "payload_json='{}'",
  },
  {
    table: 'artifacts',
    where:
      'owner_id=? AND item_id=? AND NOT EXISTS(SELECT 1 FROM artifacts child WHERE child.owner_id=artifacts.owner_id AND child.original_ref=artifacts.artifact_id)',
    bytes: 'length(CAST(provenance_json AS BLOB))',
  },
  {
    table: 'daily_export_chunks',
    where: `owner_id=? AND artifact_id IN (SELECT a.artifact_id FROM daily_export_artifacts a JOIN retention_items t ON t.owner_id=a.owner_id AND t.root_id=a.root_id AND t.publication_date=a.publication_date WHERE t.owner_id=? AND t.item_id=? AND NOT EXISTS(SELECT 1 FROM daily_export_members m LEFT JOIN retention_items other ON other.owner_id=m.owner_id AND other.item_id=m.item_id WHERE m.owner_id=t.owner_id AND m.artifact_id=t.artifact_id AND (other.phase IS NULL OR other.phase='WAITING')))`,
    bytes: 'byte_count',
  },
  {
    table: 'item_revisions',
    where:
      'owner_id=? AND item_id=? AND revision_id NOT IN (SELECT current_revision_id FROM items WHERE owner_id=item_revisions.owner_id AND item_id=item_revisions.item_id)',
    bytes: 'length(CAST(metadata_json AS BLOB))',
  },
];
function bindings(stage: Stage, owner: string, item: string) {
  return (stage.where.match(/\?/g)?.length ?? 0) === 3
    ? [owner, owner, item]
    : [owner, item];
}
function clock(now: Date) {
  if (!Number.isFinite(now.getTime()))
    throw new Error('INVALID_RETENTION_CLOCK');
  return now.toISOString();
}
export class RetentionCleanup {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
    context.requireOwnerOrTask('DRIVE_EXPORT');
  }
  async status() {
    const owner = this.context.ownerId;
    return {
      policy: 'DRIVE_ONLY_VERIFIED_PLUS_7_DAYS',
      settings: await this.db
        .prepare(
          'SELECT deletion_enabled,approval_reference,next_check_at,last_receipt_json FROM retention_settings WHERE owner_id=?',
        )
        .bind(owner)
        .first(),
      items: (
        await this.db
          .prepare(
            "SELECT item_id,file_id,phase,step,purge_after,deleted_rows,deleted_bytes,hold_reason,last_block_reason FROM retention_items WHERE owner_id=? AND phase!='COMPLETE' ORDER BY purge_after,item_id LIMIT 50",
          )
          .bind(owner)
          .all()
      ).results,
    };
  }
  async hold(item: string, reason: string | null, now: Date) {
    this.context.requireOwner();
    if (reason !== null && !/^[A-Z][A-Z0-9_]{1,119}$/.test(reason))
      throw new Error('INVALID_RETENTION_HOLD');
    const result = await this.db
      .prepare(
        "UPDATE retention_items SET hold_reason=?,updated_at=? WHERE owner_id=? AND item_id=? AND phase!='COMPLETE'",
      )
      .bind(reason, clock(now), this.context.ownerId, item)
      .run();
    if (result.meta.changes !== 1) throw new Error('RETENTION_ITEM_NOT_FOUND');
    return { item_id: item, hold_reason: reason };
  }
  async dryRun(now: Date) {
    const at = clock(now),
      owner = this.context.ownerId;
    const rows = (
      await this.db
        .prepare(
          `SELECT t.*,CASE WHEN ${eligible} THEN 1 ELSE 0 END eligible FROM retention_items t WHERE t.owner_id=? AND t.phase!='COMPLETE' ORDER BY t.purge_after,t.item_id LIMIT 5`,
        )
        .bind(at, at, owner)
        .all<RetainedItem & { eligible: number }>()
    ).results;
    const items = [];
    for (const row of rows) {
      const bytes = await this.db
        .prepare(
          'SELECT COALESCE(SUM(byte_size),0) bytes,COUNT(*) chunks FROM artifact_chunks WHERE owner_id=? AND item_id=?',
        )
        .bind(owner, row.item_id)
        .first<{ bytes: number; chunks: number }>();
      items.push({
        item_id: row.item_id,
        eligible_from_database: row.eligible === 1,
        destructive_ready: false,
        fresh_drive_check: 'REQUIRED_BEFORE_DELETION',
        hold:
          row.hold_reason ??
          (row.purge_after > at
            ? 'RETENTION_NOT_DUE'
            : row.eligible
              ? 'AWAITING_OWNER_ACTIVATION'
              : 'DEPENDENCY_OR_EXPORT_HOLD'),
        logical_source_bytes: bytes?.bytes ?? 0,
        chunks: bytes?.chunks ?? 0,
      });
    }
    return {
      mode: 'DRY_RUN',
      observed_at: at,
      items,
      deleted_rows: 0,
      deleted_bytes: 0,
    };
  }
  async step(
    item: string,
    client: Pick<DriveClient, 'getFile' | 'readMarkdown'>,
    now: Date,
  ) {
    if (this.context.kind === 'worker') {
      const active = await Access.worker(this.db, this.context.credentialHash!);
      active.requireTask('DRIVE_EXPORT');
      if (active.ownerId !== this.context.ownerId) throw new Error('FORBIDDEN');
    }
    const at = clock(now),
      owner = this.context.ownerId;
    const enabled = await this.db
      .prepare(
        'SELECT deletion_enabled,approval_reference FROM retention_settings WHERE owner_id=?',
      )
      .bind(owner)
      .first<{ deletion_enabled: number; approval_reference: string | null }>();
    if (!enabled?.deletion_enabled || !enabled.approval_reference)
      throw new Error('RETENTION_DELETION_NOT_APPROVED');
    const row = await this.db
      .prepare(
        `SELECT t.* FROM retention_items t WHERE t.owner_id=? AND t.item_id=? AND t.phase!='COMPLETE' AND ${eligible}`,
      )
      .bind(owner, item, at, at)
      .first<RetainedItem>();
    if (!row) {
      await this.db
        .prepare(
          "UPDATE retention_items SET last_block_reason='DEPENDENCY_OR_EXPORT_HOLD',updated_at=? WHERE owner_id=? AND item_id=? AND phase!='COMPLETE'",
        )
        .bind(at, owner, item)
        .run();
      return { state: 'HELD', deleted_rows: 0 };
    }
    // A resumed checkpoint checks the immutable remote version again. First
    // deletion additionally verifies full bytes after a stable version read.
    try {
      const before = await client.getFile(row.file_id);
      if (
        before.id !== row.file_id ||
        before.version !== row.remote_version ||
        before.trashed !== false ||
        before.mimeType !== 'text/markdown' ||
        !before.parents?.includes(row.root_id)
      )
        throw new Error('RETENTION_DRIVE_MISMATCH');
      if (
        row.phase === 'WAITING' ||
        row.last_block_reason === 'RESTORE_REVERIFY_REQUIRED'
      ) {
        const hash = await sha256(
          await client.readMarkdown(row.file_id, 8 * 1024 * 1024),
        );
        const after = await client.getFile(row.file_id);
        if (
          hash !== row.file_hash ||
          after.id !== before.id ||
          after.version !== before.version ||
          after.trashed !== false ||
          !after.parents?.includes(row.root_id)
        )
          throw new Error('RETENTION_DRIVE_MISMATCH');
      }
    } catch {
      await this.db
        .prepare(
          'UPDATE retention_items SET last_block_reason=?,updated_at=? WHERE owner_id=? AND item_id=?',
        )
        .bind('DRIVE_READBACK_HOLD', at, owner, item)
        .run();
      return { state: 'HELD', reason: 'DRIVE_READBACK_HOLD', deleted_rows: 0 };
    }
    const stage = cleanupStages[row.step];
    if (!stage) throw new Error('RETENTION_CHECKPOINT_INVALID');
    // Freeze only measurement metadata before removing any source bytes. This
    // preserves Gate C latency/provenance without retaining summary history.
    const operational =
      row.phase === 'WAITING'
        ? JSON.stringify(
            await this.db
              .prepare(
                capacityItemSelect + ' WHERE i.owner_id=? AND i.item_id=?',
              )
              .bind(owner, item)
              .first(),
          )
        : null;
    const token = crypto.randomUUID(),
      params = bindings(stage, owner, item);
    const page = `SELECT rowid FROM ${stage.table} WHERE ${stage.where} ORDER BY rowid LIMIT 25`;
    const permit =
      'EXISTS(SELECT 1 FROM retention_items WHERE owner_id=? AND item_id=? AND permit_token=?)';
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE retention_items AS t SET phase='PRUNING',permit_token=?,operational_json=COALESCE(operational_json,?),last_block_reason=NULL,step_bytes=(SELECT COALESCE(SUM(${stage.bytes}),0) FROM ${stage.table} WHERE rowid IN (${page})),cursor=COALESCE((SELECT MAX(rowid) FROM (${page})),0) WHERE t.owner_id=? AND t.item_id=? AND t.phase=? AND t.step=? AND ${eligible} AND EXISTS(SELECT 1 FROM retention_settings s WHERE s.owner_id=t.owner_id AND s.deletion_enabled=1 AND s.approval_reference IS NOT NULL)`,
        )
        .bind(
          token,
          operational,
          ...params,
          ...params,
          owner,
          item,
          row.phase,
          row.step,
          at,
          at,
        ),
      this.db
        .prepare(
          `${stage.redact ? `UPDATE ${stage.table} SET ${stage.redact}` : `DELETE FROM ${stage.table}`} WHERE rowid IN (${page}) AND ${permit}`,
        )
        .bind(...params, owner, item, token),
      this.db
        .prepare(
          `UPDATE retention_items SET deleted_rows=deleted_rows+changes(),deleted_bytes=deleted_bytes+step_bytes,step=step+CASE WHEN NOT EXISTS(SELECT 1 FROM ${stage.table} WHERE ${stage.where}) THEN 1 ELSE 0 END,permit_token=NULL,updated_at=? WHERE owner_id=? AND item_id=? AND permit_token=?`,
        )
        .bind(...params, at, owner, item, token),
      this.db
        .prepare(
          `UPDATE retention_items SET phase='COMPLETE',updated_at=? WHERE owner_id=? AND item_id=? AND step=? AND phase='PRUNING' AND permit_token IS NULL`,
        )
        .bind(at, owner, item, cleanupStages.length),
    ]);
    if (results[0]?.meta.changes !== 1)
      return { state: 'HELD', deleted_rows: 0 };
    const checkpoint = await this.db
      .prepare(
        'SELECT phase,step,cursor,deleted_rows,deleted_bytes FROM retention_items WHERE owner_id=? AND item_id=?',
      )
      .bind(owner, item)
      .first();
    return {
      state: 'PROGRESSED',
      table: stage.table,
      deleted_rows: results[1]?.meta.changes ?? 0,
      checkpoint,
    };
  }
}

/** Trusted cron observation only: no reusable credential or owner session. */
export async function observeRetention(db: Database, now: Date) {
  const at = clock(now);
  const owner = await db
    .prepare(
      'SELECT u.owner_id FROM owner_users u LEFT JOIN retention_settings s ON s.owner_id=u.owner_id WHERE u.allowlisted=1 AND (s.next_check_at IS NULL OR s.next_check_at<=?) ORDER BY u.owner_id LIMIT 1',
    )
    .bind(at)
    .first<{ owner_id: string }>();
  if (!owner) return { state: 'NOT_DUE' };
  const counts = await db
    .prepare(
      "SELECT phase,COUNT(*) count,COALESCE(SUM(hold_reason IS NOT NULL),0) explicit_holds FROM retention_items WHERE owner_id=? AND phase!='COMPLETE' GROUP BY phase",
    )
    .bind(owner.owner_id)
    .all();
  const receipt = {
    mode: 'OBSERVATION_ONLY',
    observed_at: at,
    counts: counts.results,
    deleted_rows: 0,
    paid_services_enabled: false,
  };
  await db
    .prepare(
      'INSERT INTO retention_settings(owner_id,next_check_at,last_receipt_json) VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET next_check_at=excluded.next_check_at,last_receipt_json=excluded.last_receipt_json',
    )
    .bind(
      owner.owner_id,
      new Date(now.getTime() + 6 * 3600000).toISOString(),
      JSON.stringify(receipt),
    )
    .run();
  return receipt;
}
