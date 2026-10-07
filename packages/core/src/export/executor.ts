import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { DriveClient, DriveFailure, type DriveFile } from '../drive/client.js';
import { DriveExportIdentity, type ExportLease } from '../drive/identity.js';
import { DailyExportArtifacts } from './artifacts.js';
import { sha256 } from '../auth/crypto.js';
import { materialReport } from './material.js';

// Initial create/reconcile only. Updating existing different bytes remains
// fail-closed until the selected remote upload method has actual CAS proof.
export class DailyExportExecutor {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
    context.requireOwner();
  }
  async execute(
    lease: ExportLease,
    artifactId: string,
    client: DriveClient,
    now: Date,
  ) {
    const identity = new DriveExportIdentity(this.db, this.context);
    const artifact = await new DailyExportArtifacts(this.db, this.context).read(
      artifactId,
    );
    const manifest = artifact.manifest;
    if (
      manifest.root_id !== lease.root_id ||
      manifest.publication_date !== lease.date ||
      !Number.isFinite(now.getTime())
    )
      throw new Error('EXPORT_ARTIFACT_IDENTITY_MISMATCH');
    const guard = [
      this.context.ownerId,
      lease.root_id,
      lease.date,
      lease.lease_owner,
      lease.fencing_token,
      now.toISOString(),
      artifactId,
      manifest.mode,
    ];
    const guardSql = `owner_id=? AND root_namespace=? AND publication_date=? AND destination_key GLOB 'drive:*' AND lease_owner=? AND fencing_token=? AND lease_until>? AND rendered_artifact_id=? AND COALESCE(desired_mode,mode)=? AND EXISTS(SELECT 1 FROM drive_connections c WHERE c.owner_id=export_state.owner_id AND c.connection_id=export_state.connection_id AND c.root_id=export_state.root_namespace AND c.root_state='VERIFIED' AND c.auth_state='CONNECTED')`;
    const current = async () => {
      const row = await this.db
        .prepare(
          `SELECT reserved_remote_id,file_id,full_file_hash,revision FROM export_state WHERE ${guardSql}`,
        )
        .bind(...guard)
        .first<{
          reserved_remote_id: string | null;
          file_id: string | null;
          full_file_hash: string | null;
          revision: number;
        }>();
      if (!row) throw new Error('EXPORT_STALE_FENCE_OR_REVISION');
      return row;
    };
    let state = await current();
    if (!state.reserved_remote_id) {
      await identity.reserve(lease, await client.reserveId(), now);
      state = await current();
    }
    const remoteId = state.reserved_remote_id!;
    const properties = await identity.appProperties(lease.root_id, lease.date);
    await this.db
      .prepare(
        `INSERT INTO drive_export_attempts(owner_id,artifact_id,reserved_remote_id,fencing_token,updated_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM export_state WHERE ${guardSql}) ON CONFLICT(owner_id,artifact_id) DO UPDATE SET fencing_token=excluded.fencing_token,updated_at=excluded.updated_at WHERE drive_export_attempts.reserved_remote_id=excluded.reserved_remote_id AND drive_export_attempts.state!='CONFLICT'`,
      )
      .bind(
        this.context.ownerId,
        artifactId,
        remoteId,
        lease.fencing_token,
        now.toISOString(),
        ...guard,
      )
      .run();
    const attempt = await this.db
      .prepare(
        'SELECT state,reserved_remote_id FROM drive_export_attempts WHERE owner_id=? AND artifact_id=?',
      )
      .bind(this.context.ownerId, artifactId)
      .first<{ state: string; reserved_remote_id: string }>();
    if (!attempt || attempt.reserved_remote_id !== remoteId)
      throw new Error('EXPORT_STALE_FENCE_OR_REVISION');
    if (attempt.state === 'CONFLICT') throw new Error('EXPORT_CONFLICT');
    const record = async (reason: string, conflict = false) => {
      await this.db
        .prepare(
          `UPDATE drive_export_attempts SET reason=?,state=?,updated_at=? WHERE owner_id=? AND artifact_id=? AND fencing_token=? AND EXISTS(SELECT 1 FROM export_state WHERE ${guardSql})`,
        )
        .bind(
          reason,
          conflict ? 'CONFLICT' : 'PREPARED',
          now.toISOString(),
          this.context.ownerId,
          artifactId,
          lease.fencing_token,
          ...guard,
        )
        .run();
    };
    const metadata = (file: DriveFile) => {
      if (
        file.id !== remoteId ||
        file.mimeType !== 'text/markdown' ||
        file.trashed !== false ||
        !file.parents?.includes(lease.root_id) ||
        Object.entries(properties).some(
          ([key, value]) => file.appProperties?.[key] !== value,
        ) ||
        !file.version
      )
        throw new Error('EXPORT_CONFLICT');
    };
    let file: DriveFile;
    try {
      try {
        file = await client.getFile(remoteId);
      } catch (error) {
        if (!(error instanceof DriveFailure) || error.category !== 'NOT_FOUND')
          throw error;
        // A previously committed remote file going missing must be reviewed;
        // it is not recreated automatically in a changed/trash namespace.
        if (state.file_id) throw new Error('EXPORT_CONFLICT');
        await current();
        try {
          file = await client.createMarkdown({
            reserved_id: remoteId,
            root_id: lease.root_id,
            name: lease.date + '.md',
            markdown: new TextDecoder('utf-8', {
              fatal: true,
              ignoreBOM: true,
            }).decode(artifact.bytes),
            app_properties: properties,
          });
        } catch (createError) {
          if (
            !(createError instanceof DriveFailure) ||
            !['TRANSIENT', 'TRANSPORT', 'CONFLICT'].includes(
              createError.category,
            )
          )
            throw createError;
          await record('EXPORT_AMBIGUOUS');
          // One bounded reconciliation read, never another create in this call.
          try {
            file = await client.getFile(remoteId);
          } catch {
            throw new Error('EXPORT_AMBIGUOUS');
          }
        }
      }
      metadata(file);
      const remoteText = await client.readMarkdown(remoteId, 8 * 1024 * 1024);
      const remoteHash = await sha256(remoteText);
      const afterRead = await client.getFile(remoteId);
      metadata(afterRead);
      if (afterRead.version !== file.version)
        throw new Error('EXPORT_CONFLICT');
      if (remoteHash !== manifest.content_hash) {
        if (state.file_id && remoteHash === state.full_file_hash) {
          const previous = await this.db
            .prepare(
              `SELECT artifact_id FROM daily_export_artifacts WHERE owner_id=? AND root_id=? AND publication_date=? AND revision=? AND content_hash=? AND state='SEALED'`,
            )
            .bind(
              this.context.ownerId,
              lease.root_id,
              lease.date,
              state.revision,
              remoteHash,
            )
            .first<{ artifact_id: string }>();
          if (previous) {
            const bytes = new TextDecoder('utf-8', {
              fatal: true,
              ignoreBOM: true,
            });
            const old = await new DailyExportArtifacts(
              this.db,
              this.context,
            ).read(previous.artifact_id);
            if (
              materialReport(bytes.decode(old.bytes)) ===
              materialReport(bytes.decode(artifact.bytes))
            ) {
              // Readback above proves the original bytes/version still exist.
              // Acknowledge coverage without claiming this candidate was uploaded.
              const result = await this.db.batch([
                this.db
                  .prepare(
                    `UPDATE export_state SET exported_seq=MAX(exported_seq,?),exported_generation=desired_generation WHERE ${guardSql} AND revision=? AND full_file_hash=?`,
                  )
                  .bind(
                    manifest.source_change_seq,
                    ...guard,
                    state.revision,
                    remoteHash,
                  ),
                this.db
                  .prepare(
                    `UPDATE drive_export_attempts SET reason='NO_MATERIAL_CHANGE',remote_version=?,verified_hash=?,updated_at=? WHERE owner_id=? AND artifact_id=? AND fencing_token=? AND EXISTS(SELECT 1 FROM export_state WHERE ${guardSql} AND revision=? AND full_file_hash=? AND exported_seq>=?)`,
                  )
                  .bind(
                    afterRead.version!,
                    remoteHash,
                    now.toISOString(),
                    this.context.ownerId,
                    artifactId,
                    lease.fencing_token,
                    ...guard,
                    state.revision,
                    remoteHash,
                    manifest.source_change_seq,
                  ),
              ]);
              if (result.some((row) => row.meta.changes !== 1))
                throw new Error('EXPORT_STALE_FENCE_OR_REVISION');
              return {
                file_id: remoteId,
                revision: state.revision,
                content_hash: remoteHash,
                remote_version: afterRead.version,
                disposition: 'NO_MATERIAL_CHANGE' as const,
              };
            }
          }
          throw new DriveFailure('UNQUALIFIED_UPDATE');
        }
        throw new Error('EXPORT_CONFLICT');
      }
      await current();
      const result = await this.db.batch([
        this.db
          .prepare(
            `UPDATE export_state SET file_id=?,body_hash=?,full_file_hash=?,exported_seq=MAX(exported_seq,?),exported_generation=desired_generation,revision=?,mode=? WHERE ${guardSql}`,
          )
          .bind(
            remoteId,
            manifest.body_hash,
            manifest.content_hash,
            manifest.source_change_seq,
            manifest.revision,
            manifest.mode,
            ...guard,
          ),
        this.db
          .prepare(
            `UPDATE drive_export_attempts SET state='VERIFIED',reason=NULL,remote_version=?,verified_hash=?,updated_at=? WHERE owner_id=? AND artifact_id=? AND fencing_token=? AND EXISTS(SELECT 1 FROM export_state WHERE ${guardSql} AND file_id=? AND full_file_hash=? AND revision=?)`,
          )
          .bind(
            afterRead.version!,
            remoteHash,
            now.toISOString(),
            this.context.ownerId,
            artifactId,
            lease.fencing_token,
            ...guard,
            remoteId,
            manifest.content_hash,
            manifest.revision,
          ),
      ]);
      if (result.some((row) => row.meta.changes !== 1))
        throw new Error('EXPORT_STALE_FENCE_OR_REVISION');
      return {
        file_id: remoteId,
        revision: manifest.revision,
        content_hash: remoteHash,
        remote_version: afterRead.version,
      };
    } catch (error) {
      const conflict =
        error instanceof Error && error.message === 'EXPORT_CONFLICT';
      const reason = conflict
        ? 'EXPORT_CONFLICT'
        : error instanceof DriveFailure
          ? 'DRIVE_' + error.category
          : error instanceof Error && error.message === 'EXPORT_AMBIGUOUS'
            ? 'EXPORT_AMBIGUOUS'
            : 'EXPORT_RECOVERY_REQUIRED';
      await record(reason, conflict);
      throw error;
    }
  }
}
