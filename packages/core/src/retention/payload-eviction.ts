import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import type { DriveClient } from '../drive/client.js';
import {
  TranscriptPayloadArchive,
  type PayloadArchiveReceipt,
} from '../transcript/payload-archive.js';
import { sha256 } from '../auth/crypto.js';

const eligible = `p.state='VERIFIED' AND p.remote_version IS NOT NULL AND p.verified_at IS NOT NULL
 AND EXISTS(SELECT 1 FROM drive_connections c WHERE c.owner_id=p.owner_id AND c.connection_id=p.connection_id AND c.auth_state='CONNECTED')
 AND EXISTS(SELECT 1 FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=p.owner_id AND r.item_id=p.item_id AND r.state='ACCEPTED' AND j.state='SUCCEEDED' AND j.task_type='FETCH_TRANSCRIPT' AND json_extract(r.outcome_json,'$.version')='transcript-source:2' AND json_extract(r.outcome_json,'$.source_artifact_id')=p.source_artifact_id)
 AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.owner_id=p.owner_id AND j.item_id=p.item_id AND j.state IN ('PENDING','LEASED','RUNNING','DEFERRED','RETRY_WAIT'))
 AND NOT EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
/** Never invoked automatically. Explicit local experiments may set dry_run=false
 * AND the existing owner approval; production keeps both deletion gates OFF. */
export class PayloadEviction {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
    context.requireOwnerOrTask('DRIVE_EXPORT');
  }
  async step(
    sourceId: string,
    client: DriveClient,
    now: Date,
    options: { dry_run?: boolean } = {},
  ) {
    const receipt = await this.db
      .prepare(
        `SELECT p.* FROM transcript_payload_archives p WHERE owner_id=? AND source_artifact_id=? AND ${eligible}`,
      )
      .bind(this.context.ownerId, sourceId)
      .first<PayloadArchiveReceipt>();
    if (!receipt) return { state: 'HELD', reason: 'ARCHIVE_OR_CONSUMER_HOLD' };
    const archive = new TranscriptPayloadArchive(this.db, this.context);
    // Fresh full technical readback before each bounded delete page, never a
    // cached verification. Any provider error aborts before a permit is granted.
    await archive.verify(receipt, client);
    const md = await this.db
      .prepare(
        `SELECT reserved_file_id file_id,verified_hash hash,remote_version,folder_id FROM transcript_archives WHERE owner_id=? AND source_artifact_id=? AND verified_source_artifact_id=source_artifact_id AND state='VERIFIED' AND verified_hash=content_hash
      UNION ALL SELECT f.reserved_file_id,f.verified_hash,f.remote_version,f.folder_id FROM daily_materials m JOIN daily_drive_files f ON f.owner_id=m.owner_id AND f.object_key='transcript:'||m.video_id WHERE m.owner_id=? AND m.source_artifact_id=? AND f.state='VERIFIED' AND f.verified_hash=f.content_hash LIMIT 1`,
      )
      .bind(this.context.ownerId, sourceId, this.context.ownerId, sourceId)
      .first<{
        file_id: string;
        hash: string;
        remote_version: string;
        folder_id: string;
      }>();
    if (!md) return { state: 'HELD', reason: 'READABLE_ARCHIVE_NOT_VERIFIED' };
    const before = await client.getFile(md.file_id);
    await client.verifyPrivateFolder(md.folder_id);
    await client.verifyPrivateFolder(md.file_id);
    const text = await client.readTranscriptMarkdown(md.file_id),
      after = await client.getFile(md.file_id);
    if (
      before.version !== after.version ||
      after.version !== md.remote_version ||
      after.trashed !== false ||
      after.mimeType !== 'text/markdown' ||
      !after.parents?.includes(md.folder_id) ||
      (await sha256(text)) !== md.hash
    )
      throw new Error('PAYLOAD_EVICTION_READBACK_FAILED');
    const candidates = (
      await this.db
        .prepare(
          'SELECT artifact_id,COUNT(*) chunks,SUM(byte_size) bytes FROM artifact_chunks WHERE owner_id=? AND artifact_id IN (SELECT value FROM json_each(?)) GROUP BY artifact_id',
        )
        .bind(this.context.ownerId, receipt.artifact_ids_json)
        .all<{ artifact_id: string; chunks: number; bytes: number }>()
    ).results;
    if (options.dry_run !== false)
      return { state: 'DRY_RUN', candidates, deletion_enabled: false };
    const permit = crypto.randomUUID(),
      until = new Date(Date.now() + 60000).toISOString();
    const approved = await this.db
      .prepare(
        'SELECT 1 FROM retention_settings WHERE owner_id=? AND deletion_enabled=1 AND approval_reference IS NOT NULL',
      )
      .bind(this.context.ownerId)
      .first();
    if (!approved) return { state: 'DELETION_DISABLED', candidates };
    const result = await this.db.batch([
      this.db
        .prepare(
          `UPDATE transcript_payload_archives AS p SET permit_token=?,permit_until=? WHERE owner_id=? AND source_artifact_id=? AND content_hash=? AND remote_version=? AND ${eligible} AND EXISTS(SELECT 1 FROM retention_settings r WHERE r.owner_id=p.owner_id AND r.deletion_enabled=1 AND r.approval_reference IS NOT NULL)`,
        )
        .bind(
          permit,
          until,
          this.context.ownerId,
          sourceId,
          receipt.content_hash,
          receipt.remote_version,
        ),
      this.db
        .prepare(
          `DELETE FROM artifact_chunks WHERE rowid IN (SELECT c.rowid FROM artifact_chunks c JOIN transcript_payload_archives p ON p.owner_id=c.owner_id AND c.item_id=p.item_id WHERE p.owner_id=? AND p.source_artifact_id=? AND p.permit_token=? AND c.artifact_id IN (SELECT value FROM json_each(p.artifact_ids_json)) ORDER BY c.rowid LIMIT 25)`,
        )
        .bind(this.context.ownerId, sourceId, permit),
      this.db
        .prepare(
          'UPDATE transcript_payload_archives SET permit_token=NULL,permit_until=NULL,evicted_at=CASE WHEN NOT EXISTS(SELECT 1 FROM artifact_chunks c WHERE c.owner_id=transcript_payload_archives.owner_id AND c.artifact_id IN (SELECT value FROM json_each(transcript_payload_archives.artifact_ids_json))) THEN ? ELSE evicted_at END WHERE owner_id=? AND source_artifact_id=? AND permit_token=?',
        )
        .bind(now.toISOString(), this.context.ownerId, sourceId, permit),
    ]);
    if (result[0]!.meta.changes !== 1)
      return { state: 'HELD', reason: 'ARCHIVE_OR_CONSUMER_CHANGED' };
    return { state: 'EVICTED_PAGE', deleted_chunks: result[1]!.meta.changes };
  }
  async restore(sourceId: string, client: DriveClient) {
    this.context.requireOwner();
    const receipt = await this.db
      .prepare(
        "SELECT * FROM transcript_payload_archives WHERE owner_id=? AND source_artifact_id=? AND state='VERIFIED'",
      )
      .bind(this.context.ownerId, sourceId)
      .first<PayloadArchiveReceipt>();
    if (!receipt) throw new Error('PAYLOAD_ARCHIVE_NOT_VERIFIED');
    const payload = await new TranscriptPayloadArchive(
      this.db,
      this.context,
    ).verify(receipt, client);
    let restored = 0;
    for (const { header, chunks } of payload.artifacts) {
      const local = await this.db
        .prepare('SELECT * FROM artifacts WHERE owner_id=? AND artifact_id=?')
        .bind(this.context.ownerId, header.artifact_id)
        .first();
      if (JSON.stringify(local) !== JSON.stringify(header))
        throw new Error('PAYLOAD_ARCHIVE_DESCRIPTOR_MISMATCH');
      for (let start = 0; start < chunks.length; start += 25) {
        const result = await this.db.batch(
          chunks
            .slice(start, start + 25)
            .map((c) =>
              this.db
                .prepare(
                  'INSERT INTO artifact_chunks(owner_id,item_id,artifact_id,chunk_index,byte_start,byte_size,byte_hash,storage_ref,body_base64) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
                )
                .bind(
                  c.owner_id,
                  c.item_id,
                  c.artifact_id,
                  c.chunk_index,
                  c.byte_start,
                  c.byte_size,
                  c.byte_hash,
                  c.storage_ref,
                  c.body_base64,
                ),
            ),
        );
        restored += result.reduce((n, r) => n + r.meta.changes, 0);
      }
    }
    return { state: 'RESTORED', restored_chunks: restored };
  }
}
