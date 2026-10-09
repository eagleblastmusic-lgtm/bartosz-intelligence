import { sha256 as hash } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base64url, decode64 } from '../auth/crypto.js';
import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import type { ExportLease } from '../drive/identity.js';
import type { DailyReport } from './renderer.js';
import { requireDriveId } from '../drive/client.js';
import { requireLocalDate } from '../projections/dates.js';

const chunkBytes = 32768;
const maxBytes = 8 * 1024 * 1024;
interface Manifest {
  artifact_id: string;
  root_id: string;
  publication_date: string;
  revision: number;
  source_change_seq: number;
  mode: 'COMPACT' | 'FULL';
  content_hash: string;
  body_hash: string;
  byte_count: number;
  chunk_count: number;
  state: 'STAGING' | 'SEALED';
}
const leaseGuard = `EXISTS(SELECT 1 FROM export_state e WHERE e.owner_id=? AND e.root_namespace=? AND e.publication_date=? AND e.destination_key GLOB 'drive:*' AND e.lease_owner=? AND e.fencing_token=? AND e.lease_until>?)`;

// Derived Daily bytes have their own identity; they are never attached to an
// arbitrary Item or represented as transcript/AI source artifacts.
export class DailyExportArtifacts {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
    context.requireOwnerOrTask('DRIVE_EXPORT');
  }
  private guard(lease: ExportLease, now: Date) {
    requireDriveId(lease.root_id);
    requireLocalDate(lease.date);
    if (
      !Number.isFinite(now.getTime()) ||
      !Number.isSafeInteger(lease.fencing_token) ||
      lease.fencing_token < 1
    )
      throw new Error('INVALID_EXPORT_LEASE');
    return [
      this.context.ownerId,
      lease.root_id,
      lease.date,
      lease.lease_owner,
      lease.fencing_token,
      now.toISOString(),
    ];
  }
  private async manifest(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('INVALID_EXPORT_ARTIFACT');
    const manifest = await this.db
      .prepare(
        `SELECT artifact_id,root_id,publication_date,revision,source_change_seq,mode,content_hash,body_hash,byte_count,chunk_count,state FROM daily_export_artifacts WHERE owner_id=? AND artifact_id=?`,
      )
      .bind(this.context.ownerId, id)
      .first<Manifest>();
    if (!manifest) throw new Error('NOT_FOUND');
    return manifest;
  }
  private async verifiedBytes(manifest: Manifest) {
    const chunks = (
      await this.db
        .prepare(
          `SELECT ordinal,byte_count,content_hash,data_base64 FROM daily_export_chunks WHERE owner_id=? AND artifact_id=? ORDER BY ordinal`,
        )
        .bind(this.context.ownerId, manifest.artifact_id)
        .all<{
          ordinal: number;
          byte_count: number;
          content_hash: string;
          data_base64: string;
        }>()
    ).results;
    if (
      chunks.length !== manifest.chunk_count ||
      manifest.byte_count > maxBytes
    )
      throw new Error('EXPORT_ARTIFACT_INTEGRITY');
    const result = new Uint8Array(manifest.byte_count);
    const digest = hash.create();
    let offset = 0;
    for (const [ordinal, chunk] of chunks.entries()) {
      const bytes = decode64(chunk.data_base64);
      if (
        chunk.ordinal !== ordinal ||
        bytes.length !== chunk.byte_count ||
        bytes.length !== Math.min(chunkBytes, manifest.byte_count - offset) ||
        base64url(bytes) !== chunk.data_base64 ||
        bytesToHex(hash(bytes)) !== chunk.content_hash
      )
        throw new Error('EXPORT_ARTIFACT_INTEGRITY');
      result.set(bytes, offset);
      digest.update(bytes);
      offset += bytes.length;
    }
    if (
      offset !== manifest.byte_count ||
      bytesToHex(digest.digest()) !== manifest.content_hash
    )
      throw new Error('EXPORT_ARTIFACT_INTEGRITY');
    return result;
  }
  async read(id: string) {
    const manifest = await this.manifest(id);
    if (manifest.state !== 'SEALED')
      throw new Error('EXPORT_ARTIFACT_NOT_VERIFIED');
    return { manifest, bytes: await this.verifiedBytes(manifest) };
  }
  async save(lease: ExportLease, report: DailyReport, now: Date) {
    const guard = this.guard(lease, now);
    const bytes = new TextEncoder().encode(report.markdown);
    const bodyStart = report.markdown.indexOf('\n---\n\n') + 6;
    const footerStart = report.markdown.lastIndexOf('END_REPORT date=');
    if (
      report.date !== lease.date ||
      !Number.isSafeInteger(report.revision) ||
      report.revision < 1 ||
      !Number.isSafeInteger(report.source_change_seq) ||
      report.source_change_seq < 0 ||
      !['COMPACT', 'FULL'].includes(report.export_mode) ||
      !/^[a-f0-9]{64}$/.test(report.body_sha256) ||
      bytes.length < 1 ||
      bytes.length > maxBytes ||
      bytes.length !== report.byte_count ||
      bytesToHex(hash(bytes)) !== report.content_hash ||
      bodyStart < 6 ||
      footerStart <= bodyStart ||
      bytesToHex(
        hash(
          new TextEncoder().encode(
            report.markdown.slice(bodyStart, footerStart),
          ),
        ),
      ) !== report.body_sha256
    )
      throw new Error('INVALID_EXPORT_REPORT');
    if (
      !(await this.db
        .prepare(`SELECT 1 WHERE ${leaseGuard}`)
        .bind(...guard)
        .first())
    )
      throw new Error('EXPORT_STALE_FENCE_OR_REVISION');
    const id = bytesToHex(
      hash(
        new TextEncoder().encode(
          JSON.stringify([
            this.context.ownerId,
            lease.root_id,
            lease.date,
            report.revision,
          ]),
        ),
      ),
    );
    const count = Math.ceil(bytes.length / chunkBytes);
    await this.db
      .prepare(
        `INSERT INTO daily_export_artifacts(owner_id,artifact_id,root_id,publication_date,revision,source_change_seq,mode,content_hash,body_hash,byte_count,chunk_count) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${leaseGuard} ON CONFLICT(owner_id,artifact_id) DO NOTHING`,
      )
      .bind(
        this.context.ownerId,
        id,
        lease.root_id,
        lease.date,
        report.revision,
        report.source_change_seq,
        report.export_mode,
        report.content_hash,
        report.body_sha256,
        bytes.length,
        count,
        ...guard,
      )
      .run();
    const manifest = await this.manifest(id);
    if (
      manifest.content_hash !== report.content_hash ||
      manifest.mode !== report.export_mode ||
      manifest.source_change_seq !== report.source_change_seq ||
      manifest.body_hash !== report.body_sha256 ||
      manifest.byte_count !== bytes.length ||
      manifest.chunk_count !== count
    )
      throw new Error('EXPORT_REVISION_CONTENT_CONFLICT');
    if (manifest.state === 'STAGING') {
      // Small transactional batches allow a crash to resume without large D1
      // statements. Conflict rows stay immutable and are verified before seal.
      for (let start = 0; start < count; start += 16) {
        const statements = [];
        for (
          let ordinal = start;
          ordinal < Math.min(count, start + 16);
          ordinal++
        ) {
          const part = bytes.subarray(
            ordinal * chunkBytes,
            Math.min(bytes.length, (ordinal + 1) * chunkBytes),
          );
          statements.push(
            this.db
              .prepare(
                `INSERT INTO daily_export_chunks(owner_id,artifact_id,ordinal,byte_count,content_hash,data_base64) SELECT ?,?,?,?,?,? WHERE ${leaseGuard} AND EXISTS(SELECT 1 FROM daily_export_artifacts WHERE owner_id=? AND artifact_id=? AND state='STAGING') ON CONFLICT(owner_id,artifact_id,ordinal) DO NOTHING`,
              )
              .bind(
                this.context.ownerId,
                id,
                ordinal,
                part.length,
                bytesToHex(hash(part)),
                base64url(part),
                ...guard,
                this.context.ownerId,
                id,
              ),
          );
        }
        await this.db.batch(statements);
      }
      await this.verifiedBytes(manifest);
      await this.db
        .prepare(
          `UPDATE daily_export_artifacts SET state='SEALED' WHERE owner_id=? AND artifact_id=? AND state='STAGING' AND ${leaseGuard}`,
        )
        .bind(this.context.ownerId, id, ...guard)
        .run();
    }
    const attached = await this.db
      .prepare(
        `UPDATE export_state SET rendered_artifact_id=? WHERE owner_id=? AND root_namespace=? AND publication_date=? AND destination_key GLOB 'drive:*' AND lease_owner=? AND fencing_token=? AND lease_until>? AND (rendered_artifact_id IS NULL OR rendered_artifact_id=? OR EXISTS(SELECT 1 FROM daily_export_artifacts a WHERE a.owner_id=export_state.owner_id AND a.artifact_id=export_state.rendered_artifact_id AND a.revision<?)) AND EXISTS(SELECT 1 FROM daily_export_artifacts a WHERE a.owner_id=export_state.owner_id AND a.artifact_id=? AND a.state='SEALED')`,
      )
      .bind(id, ...guard, id, report.revision, id)
      .run();
    if (attached.meta.changes !== 1)
      throw new Error('EXPORT_STALE_FENCE_OR_REVISION');
    // Completion belongs to each film. Other pending films or an open discovery
    // window do not invalidate a complete FULL summary in this report.
    if (report.export_mode === 'FULL' && report.omitted_detail_units === 0) {
      for (
        let start = 0;
        start < (report.archive_members?.length ?? 0);
        start += 16
      ) {
        await this.db.batch(
          report
            .archive_members!.slice(start, start + 16)
            .map((member) =>
              this.db
                .prepare(
                  `INSERT INTO daily_export_members(owner_id,artifact_id,item_id,run_id,canonical_hash) SELECT ?,?,?,?,? WHERE ${leaseGuard} AND EXISTS(SELECT 1 FROM active_analysis_selections s JOIN analysis_runs r ON r.owner_id=s.owner_id AND r.run_id=s.accepted_run_id WHERE s.owner_id=? AND s.item_id=? AND s.accepted_run_id=? AND r.state='ACCEPTED' AND json_extract(r.outcome_json,'$.version')='intelligence-accepted:1' AND json_extract(r.outcome_json,'$.view.status')='OK' AND json_extract(r.outcome_json,'$.view.coverage_complete')=1 AND json_extract(r.outcome_json,'$.canonical_hash')=?) ON CONFLICT(owner_id,artifact_id,item_id) DO NOTHING`,
                )
                .bind(
                  this.context.ownerId,
                  id,
                  member.item_id,
                  member.run_id,
                  member.canonical_hash,
                  ...guard,
                  this.context.ownerId,
                  member.item_id,
                  member.run_id,
                  member.canonical_hash,
                ),
            ),
        );
      }
    }
    return id;
  }
}
