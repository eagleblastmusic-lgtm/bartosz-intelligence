import { assertContext, AccessContext, type Database } from '../db/boundary.js';
import { ArtifactRepository } from '../artifacts/store.js';
import { sha256 } from '../auth/crypto.js';
import { TranscriptPayloadArchive } from './payload-archive.js';
import { DriveClient, DriveFailure, type DriveFile } from '../drive/client.js';
import {
  renderTranscriptArchive,
  type TranscriptArchiveDescriptor,
  type TranscriptArchiveManifest,
} from './archive-renderer.js';

type Row = {
  item_id: string;
  source_artifact_id: string;
  segment_map_artifact_id: string;
  source_hash: string;
  descriptor_json: string;
  folder_id: string;
  reserved_file_id: string | null;
  content_hash: string | null;
  verified_hash: string | null;
  verified_source_artifact_id: string | null;
  remote_version: string | null;
  state: string;
  attempt_count: number;
  fencing_token: number;
};
/** One acquired source and one file attempt per tick. Source storage remains in
 * existing artifacts; the receipt carries only identity, hashes and retry state. */
export class TranscriptDriveArchive {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
    context.requireOwnerOrTask('DRIVE_EXPORT');
  }
  async hasReady(now: Date) {
    const check = async () =>
      Boolean(
        await this.db
          .prepare(
            "SELECT 1 FROM transcript_archives WHERE owner_id=? AND state IN ('PENDING','RETRY_WAIT') AND due_at<=? AND (lease_until IS NULL OR lease_until<=?) AND NOT EXISTS(SELECT 1 FROM transcript_archives q WHERE q.owner_id=? AND q.state='RETRY_WAIT' AND q.last_reason='DRIVE_QUOTA' AND q.due_at>?) LIMIT 1",
          )
          .bind(
            this.context.ownerId,
            now.toISOString(),
            now.toISOString(),
            this.context.ownerId,
            now.toISOString(),
          )
          .first(),
      );
    if (await check()) return true;
    await this.reconcile(now);
    return check();
  }
  async refreshVerifiedReadback(
    itemId: string,
    client: DriveClient,
    now: Date,
  ) {
    if (!Number.isFinite(now.getTime()))
      throw new Error('INVALID_TRANSCRIPT_ARCHIVE_CLOCK');
    if (this.context.kind === 'worker')
      (
        await AccessContext.worker(this.db, this.context.credentialHash!)
      ).requireTask('DRIVE_EXPORT');
    const row = await this.db
      .prepare(
        "SELECT * FROM transcript_archives WHERE owner_id=? AND item_id=? AND state='VERIFIED' AND verified_hash=content_hash AND verified_source_artifact_id=source_artifact_id",
      )
      .bind(this.context.ownerId, itemId)
      .first<Row>();
    if (!row?.reserved_file_id || !row.remote_version || !row.verified_hash)
      throw new Error('TRANSCRIPT_ARCHIVE_NOT_VERIFIED');
    await client.verifyPrivateFolder(row.folder_id);
    await client.verifyPrivateFolder(row.reserved_file_id);
    const before = await client.getFile(row.reserved_file_id);
    const markdown = await client.readTranscriptMarkdown(row.reserved_file_id);
    const after = await client.getFile(row.reserved_file_id);
    if (
      !after.version ||
      before.version !== after.version ||
      after.trashed !== false ||
      after.mimeType !== 'text/markdown' ||
      !after.parents?.includes(row.folder_id) ||
      after.appProperties?.bi_owner !== (await sha256(this.context.ownerId)) ||
      after.appProperties?.bi_transcript !== (await sha256(itemId)) ||
      (await sha256(markdown)) !== row.verified_hash
    )
      throw new Error('TRANSCRIPT_ARCHIVE_CONFLICT');
    if (after.version !== row.remote_version) {
      if (this.context.kind === 'worker')
        (
          await AccessContext.worker(this.db, this.context.credentialHash!)
        ).requireTask('DRIVE_EXPORT');
      const saved = await this.db
        .prepare(
          "UPDATE transcript_archives SET remote_version=?,updated_at=? WHERE owner_id=? AND item_id=? AND state='VERIFIED' AND fencing_token=? AND remote_version=? AND verified_hash=? AND content_hash=verified_hash AND source_artifact_id=? AND verified_source_artifact_id=source_artifact_id AND (lease_until IS NULL OR lease_until<=?) AND NOT EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=transcript_archives.owner_id AND t.item_id=transcript_archives.item_id AND t.phase IN ('PRUNING','COMPLETE'))",
        )
        .bind(
          after.version,
          now.toISOString(),
          this.context.ownerId,
          itemId,
          row.fencing_token,
          row.remote_version,
          row.verified_hash,
          row.source_artifact_id,
          now.toISOString(),
        )
        .run();
      if (saved.meta.changes !== 1)
        throw new Error('TRANSCRIPT_ARCHIVE_STALE_FENCE');
    }
    // Identical bytes keep the original verification/retention date. Only the
    // independently verified provider metadata version advances; no Drive write.
    return {
      file_id: row.reserved_file_id,
      remote_version: after.version,
      sha256: row.verified_hash,
      byte_count: new TextEncoder().encode(markdown).length,
    };
  }
  async reconcile(now: Date, itemId?: string) {
    const source = await this.db
      .prepare(
        `SELECT a.artifact_id,a.item_id,a.content_hash,a.provenance_json,a.producer_version,i.external_id,i.canonical_url,i.published_at,i.discovered_at,m.metadata_json,c.title channel,
 (SELECT b.artifact_id FROM artifacts b WHERE b.owner_id=a.owner_id AND b.item_id=a.item_id AND b.original_ref=a.artifact_id AND b.kind='SEGMENT_MAP' AND b.state='VERIFIED' AND json_extract(b.provenance_json,'$.source_revision')=a.content_hash ORDER BY CASE WHEN b.schema_version='caption-coverage:1' THEN 0 ELSE 1 END,b.created_at DESC,b.artifact_id DESC LIMIT 1) map_id,
 EXISTS(SELECT 1 FROM analysis_runs r WHERE r.owner_id=a.owner_id AND r.item_id=a.item_id AND r.state='ACCEPTED' AND json_extract(r.outcome_json,'$.version')='transcript-source:1' AND json_extract(r.outcome_json,'$.source_artifact_id')=a.artifact_id) legacy_complete
 FROM artifacts a JOIN items i ON i.owner_id=a.owner_id AND i.item_id=a.item_id
 JOIN item_revisions m ON m.owner_id=i.owner_id AND m.item_id=i.item_id AND m.revision_id=i.current_revision_id
 LEFT JOIN channels c ON c.owner_id=i.owner_id AND c.source_id=i.source_id
 LEFT JOIN transcript_archives t ON t.owner_id=a.owner_id AND t.item_id=a.item_id
 WHERE a.owner_id=? AND a.kind='SOURCE_ORIGINAL' AND a.state='VERIFIED'
 AND NOT EXISTS(SELECT 1 FROM daily_materials d WHERE d.owner_id=a.owner_id AND d.item_id=a.item_id)
 AND (? IS NULL OR a.item_id=?)
 AND (t.item_id IS NULL OR (t.source_artifact_id!=a.artifact_id AND t.state='VERIFIED' AND (t.lease_until IS NULL OR t.lease_until<=?)))
 AND NOT EXISTS(SELECT 1 FROM retention_items p WHERE p.owner_id=a.owner_id AND p.item_id=a.item_id AND p.phase IN ('PRUNING','COMPLETE'))
 AND NOT EXISTS(SELECT 1 FROM artifacts n WHERE n.owner_id=a.owner_id AND n.item_id=a.item_id AND n.kind='SOURCE_ORIGINAL' AND n.state='VERIFIED' AND (n.created_at>a.created_at OR (n.created_at=a.created_at AND n.artifact_id>a.artifact_id)))
 AND EXISTS(SELECT 1 FROM artifacts b WHERE b.owner_id=a.owner_id AND b.item_id=a.item_id AND b.original_ref=a.artifact_id AND b.kind='SEGMENT_MAP' AND b.state='VERIFIED' AND json_extract(b.provenance_json,'$.source_revision')=a.content_hash)
 ORDER BY a.created_at,a.artifact_id LIMIT 1`,
      )
      .bind(
        this.context.ownerId,
        itemId ?? null,
        itemId ?? null,
        now.toISOString(),
      )
      .first<{
        artifact_id: string;
        item_id: string;
        content_hash: string;
        provenance_json: string;
        producer_version: string;
        external_id: string;
        canonical_url: string;
        published_at: string | null;
        discovered_at: string;
        metadata_json: string;
        channel: string | null;
        map_id: string | null;
        legacy_complete: number;
      }>();
    if (!source?.map_id) return { registered: false };
    const folder = await this.db
      .prepare(
        'SELECT folder_id FROM transcript_archive_folders WHERE owner_id=? AND private_verified_at IS NOT NULL',
      )
      .bind(this.context.ownerId)
      .first<string>('folder_id');
    if (!folder) return { registered: false };
    const p = JSON.parse(source.provenance_json),
      metadata = JSON.parse(source.metadata_json);
    if (
      p.provider_id !== 'local_ytdlp' ||
      p.is_translated !== false ||
      !['MANUAL', 'GENERATED'].includes(p.track_kind) ||
      p.is_generated !== (p.track_kind === 'GENERATED') ||
      p.is_original === false ||
      typeof p.language_code !== 'string' ||
      typeof p.upstream_track_id !== 'string'
    )
      throw new Error('TRANSCRIPT_ARCHIVE_AUTHORITY_MISMATCH');
    const descriptor: TranscriptArchiveDescriptor = {
      video_id: source.external_id,
      title: metadata.title ?? '',
      channel: source.channel ?? '',
      url: source.canonical_url,
      published_at: source.published_at,
      discovered_at: source.discovered_at,
      language_code: p.language_code,
      track_kind: p.track_kind,
      upstream_track_id: p.upstream_track_id,
      provider_id: p.provider_id,
      provider_version: p.provider_version ?? source.producer_version,
      source_status:
        p.archive_source_status === 'PARTIAL'
          ? 'PARTIAL'
          : p.archive_source_status === 'AVAILABLE_FULL' ||
              source.legacy_complete === 1
            ? 'AVAILABLE_FULL'
            : 'UNKNOWN',
      original_language_confirmed:
        p.is_original === true ||
        (typeof p.video_language === 'string' &&
          p.video_language.toLowerCase().split('-')[0] ===
            p.language_code.toLowerCase().split('-')[0]),
      retrieved_at: typeof p.retrieved_at === 'string' ? p.retrieved_at : null,
      timestamp_precision: p.timestamp_precision ?? 'UNKNOWN',
      missing_ranges: p.missing_ranges ?? [],
      warnings: p.warnings ?? [],
    };
    const json = JSON.stringify(descriptor);
    if (new TextEncoder().encode(json).length > 8192)
      throw new Error('TRANSCRIPT_ARCHIVE_DESCRIPTOR_TOO_LARGE');
    await this.db
      .prepare(
        `INSERT INTO transcript_archives(owner_id,item_id,source_artifact_id,segment_map_artifact_id,source_hash,descriptor_json,folder_id,due_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
 ON CONFLICT(owner_id,item_id) DO UPDATE SET source_artifact_id=excluded.source_artifact_id,segment_map_artifact_id=excluded.segment_map_artifact_id,source_hash=excluded.source_hash,descriptor_json=excluded.descriptor_json,state='PENDING',content_hash=NULL,due_at=excluded.due_at,updated_at=excluded.updated_at,attempt_count=0,lease_owner=NULL,lease_until=NULL,fencing_token=transcript_archives.fencing_token+1
 WHERE transcript_archives.folder_id=excluded.folder_id AND transcript_archives.state='VERIFIED' AND transcript_archives.source_artifact_id!=excluded.source_artifact_id AND (transcript_archives.lease_until IS NULL OR transcript_archives.lease_until<=excluded.updated_at)`,
      )
      .bind(
        this.context.ownerId,
        source.item_id,
        source.artifact_id,
        source.map_id,
        source.content_hash,
        json,
        folder,
        now.toISOString(),
        now.toISOString(),
      )
      .run();
    return { registered: true };
  }
  async tick(
    input: {
      client: (connectionId: string) => Promise<DriveClient>;
      item_id?: string;
    },
    now: Date,
  ) {
    if (!Number.isFinite(now.getTime()))
      throw new Error('INVALID_TRANSCRIPT_ARCHIVE_CLOCK');
    if (this.context.kind === 'worker') {
      const active = await AccessContext.worker(
        this.db,
        this.context.credentialHash!,
      );
      active.requireTask('DRIVE_EXPORT');
      if (active.ownerId !== this.context.ownerId) throw new Error('FORBIDDEN');
    }
    const folder = await this.db
      .prepare(
        `SELECT f.folder_id,f.parent_id,f.connection_id FROM transcript_archive_folders f JOIN drive_connections c ON c.owner_id=f.owner_id AND c.connection_id=f.connection_id WHERE f.owner_id=? AND f.private_verified_at IS NOT NULL AND c.auth_state='CONNECTED'`,
      )
      .bind(this.context.ownerId)
      .first<{ folder_id: string; parent_id: string; connection_id: string }>();
    if (!folder) return { state: 'CONFIGURATION_HOLD' };
    if (
      await this.db
        .prepare(
          "SELECT 1 FROM transcript_archives WHERE owner_id=? AND state='RETRY_WAIT' AND last_reason='DRIVE_QUOTA' AND due_at>? LIMIT 1",
        )
        .bind(this.context.ownerId, now.toISOString())
        .first()
    )
      return { state: 'QUOTA_WAIT' };
    const ready = () =>
      this.db
        .prepare(
          "SELECT item_id FROM transcript_archives WHERE owner_id=? AND (? IS NULL OR item_id=?) AND state IN ('PENDING','RETRY_WAIT') AND due_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY due_at,item_id LIMIT 1",
        )
        .bind(
          this.context.ownerId,
          input.item_id ?? null,
          input.item_id ?? null,
          now.toISOString(),
          now.toISOString(),
        )
        .first<string>('item_id');
    let due = await ready();
    if (!due) {
      await this.reconcile(now, input.item_id);
      due = await ready();
    }
    if (!due) return { state: 'IDLE' };
    const claimed = await this.db
      .prepare(
        `UPDATE transcript_archives SET lease_owner=?,lease_until=?,fencing_token=fencing_token+1,attempt_count=attempt_count+1 WHERE owner_id=? AND item_id=? AND state IN ('PENDING','RETRY_WAIT') AND due_at<=? AND (lease_until IS NULL OR lease_until<=?) RETURNING *`,
      )
      .bind(
        this.context.actorId,
        new Date(now.getTime() + 15 * 60000).toISOString(),
        this.context.ownerId,
        due,
        now.toISOString(),
        now.toISOString(),
      )
      .first<Row>();
    if (!claimed) return { state: 'LEASE_BUSY' };
    const started = Date.now(),
      currentTime = () =>
        new Date(
          now.getTime() + Math.max(0, Date.now() - started),
        ).toISOString();
    const guard =
      "owner_id=? AND item_id=? AND lease_owner=? AND fencing_token=? AND lease_until>? AND EXISTS(SELECT 1 FROM transcript_archive_folders f JOIN drive_connections c ON c.owner_id=f.owner_id AND c.connection_id=f.connection_id WHERE f.owner_id=transcript_archives.owner_id AND f.folder_id=transcript_archives.folder_id AND f.private_verified_at IS NOT NULL AND c.auth_state='CONNECTED')";
    const bind = () => [
      this.context.ownerId,
      due,
      this.context.actorId,
      claimed.fencing_token,
      currentTime(),
    ];
    const current = async () => {
      if (this.context.kind === 'worker')
        (
          await AccessContext.worker(this.db, this.context.credentialHash!)
        ).requireTask('DRIVE_EXPORT');
      if (
        !(await this.db
          .prepare(`SELECT 1 FROM transcript_archives WHERE ${guard}`)
          .bind(...bind())
          .first())
      )
        throw new Error('TRANSCRIPT_ARCHIVE_STALE_FENCE');
    };
    try {
      const client = await input.client(folder.connection_id);
      const metadata = await client.getFile(folder.folder_id);
      if (
        metadata.mimeType !== 'application/vnd.google-apps.folder' ||
        metadata.trashed !== false ||
        !metadata.parents?.includes(folder.parent_id)
      )
        throw new Error('TRANSCRIPT_ARCHIVE_CONFLICT');
      await client.verifyPrivateFolder(folder.folder_id);
      const repository = new ArtifactRepository(this.db, this.context);
      const source = await repository.readTranscriptArchiveText(
        claimed.source_artifact_id,
        new Date(currentTime()),
      );
      const map = await repository.readTranscriptArchiveText(
        claimed.segment_map_artifact_id,
        new Date(currentTime()),
      );
      if (
        source.artifact.content_hash !== claimed.source_hash ||
        source.artifact.kind !== 'SOURCE_ORIGINAL' ||
        source.artifact.item_id !== due ||
        map.artifact.item_id !== due ||
        map.artifact.kind !== 'SEGMENT_MAP' ||
        map.artifact.original_ref !== source.artifact.artifact_id
      )
        throw new Error('TRANSCRIPT_ARCHIVE_SOURCE_MISMATCH');
      const descriptor = JSON.parse(
        claimed.descriptor_json,
      ) as TranscriptArchiveDescriptor;
      const report = await renderTranscriptArchive({
        descriptor,
        source_text: source.text,
        source_hash: claimed.source_hash,
        manifest: JSON.parse(map.text) as TranscriptArchiveManifest,
      });
      if (claimed.content_hash && claimed.content_hash !== report.content_hash)
        throw new Error('TRANSCRIPT_ARCHIVE_CONFLICT');
      const reserved = claimed.reserved_file_id ?? (await client.reserveId());
      const pinned = await this.db
        .prepare(
          `UPDATE transcript_archives SET reserved_file_id=COALESCE(reserved_file_id,?),content_hash=COALESCE(content_hash,?) WHERE ${guard}`,
        )
        .bind(reserved, report.content_hash, ...bind())
        .run();
      if (pinned.meta.changes !== 1)
        throw new Error('TRANSCRIPT_ARCHIVE_STALE_FENCE');
      const properties = {
        bi_owner: await sha256(this.context.ownerId),
        bi_transcript: await sha256(due),
      };
      const identity = (file: DriveFile) => {
        if (
          file.id !== reserved ||
          file.mimeType !== 'text/markdown' ||
          file.trashed !== false ||
          !file.parents?.includes(folder.folder_id) ||
          !file.version ||
          Object.entries(properties).some(
            ([key, value]) => file.appProperties?.[key] !== value,
          )
        )
          throw new Error('TRANSCRIPT_ARCHIVE_CONFLICT');
      };
      const uploadStarted = Date.now();
      let file: DriveFile;
      try {
        file = await client.getFile(reserved);
      } catch (error) {
        if (!(error instanceof DriveFailure) || error.category !== 'NOT_FOUND')
          throw error;
        if (claimed.verified_hash)
          throw new Error('TRANSCRIPT_ARCHIVE_CONFLICT');
        await current();
        try {
          file = await client.createTranscriptMarkdown({
            reserved_id: reserved,
            root_id: folder.folder_id,
            name: descriptor.video_id + '.md',
            markdown: report.markdown,
            app_properties: properties,
          });
        } catch (error) {
          if (
            !(error instanceof DriveFailure) ||
            !['TRANSIENT', 'TRANSPORT', 'CONFLICT'].includes(error.category)
          )
            throw error;
          // A crash/timeout after create reuses the durable reserved ID. One
          // reconciliation read in this tick, never a second create.
          file = await client.getFile(reserved);
        }
      }
      identity(file);
      const verifyStarted = Date.now();
      let text = await client.readTranscriptMarkdown(reserved),
        hash = await sha256(text),
        after = await client.getFile(reserved);
      identity(after);
      if (file.version !== after.version)
        throw new Error('TRANSCRIPT_ARCHIVE_CONFLICT');
      if (hash !== report.content_hash) {
        if (!claimed.verified_hash || hash !== claimed.verified_hash)
          throw new Error('TRANSCRIPT_ARCHIVE_CONFLICT');
        await current();
        await client.updateTranscriptMarkdown({
          id: reserved,
          root_id: folder.folder_id,
          app_properties: properties,
          expected_hash: hash,
          markdown: report.markdown,
          before_write: current,
        });
        const before = await client.getFile(reserved);
        identity(before);
        text = await client.readTranscriptMarkdown(reserved);
        hash = await sha256(text);
        after = await client.getFile(reserved);
        identity(after);
        if (before.version !== after.version || hash !== report.content_hash)
          throw new Error('TRANSCRIPT_ARCHIVE_CONFLICT');
      }
      await client.verifyPrivateFolder(reserved);
      await current();
      await new TranscriptPayloadArchive(this.db, this.context).ensure(
        claimed.source_artifact_id,
        client,
        folder.folder_id,
        folder.connection_id,
        new Date(currentTime()),
        current,
      );
      const at = currentTime();
      const committed = await this.db.batch([
        this.db
          .prepare(
            `UPDATE transcript_archives SET state='VERIFIED',verified_hash=?,verified_source_artifact_id=source_artifact_id,remote_version=?,verified_at=?,lease_owner=NULL,lease_until=NULL,last_reason=NULL,updated_at=? WHERE ${guard}`,
          )
          .bind(hash, after.version!, at, at, ...bind()),
        this.db
          .prepare(
            `INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) SELECT owner_id,'items',item_id,'TRANSCRIPT_ARCHIVED',? FROM transcript_archives WHERE owner_id=? AND item_id=? AND state='VERIFIED' AND fencing_token=? AND verified_hash=?`,
          )
          .bind(at, this.context.ownerId, due, claimed.fencing_token, hash),
        this.db
          .prepare(
            `UPDATE retention_items SET purge_after=MAX(purge_after,?),updated_at=? WHERE owner_id=? AND item_id=? AND phase='WAITING' AND EXISTS(SELECT 1 FROM transcript_archives x WHERE x.owner_id=retention_items.owner_id AND x.item_id=retention_items.item_id AND x.state='VERIFIED' AND x.fencing_token=? AND x.verified_hash=?)`,
          )
          .bind(
            new Date(Date.parse(at) + 7 * 86400000).toISOString(),
            at,
            this.context.ownerId,
            due,
            claimed.fencing_token,
            hash,
          ),
      ]);
      if (committed.slice(0, 2).some((row) => row.meta.changes !== 1))
        throw new Error('TRANSCRIPT_ARCHIVE_STALE_FENCE');
      return {
        state: 'VERIFIED',
        item_id: due,
        file_id: reserved,
        content_hash: hash,
        remote_version: after.version,
        metrics: {
          drive_upload_ms: verifyStarted - uploadStarted,
          drive_verify_ms: Date.now() - verifyStarted,
          archive_total_ms: Date.now() - started,
          archive_wait_ms: Math.max(
            0,
            now.getTime() -
              Date.parse(source.artifact.verified_at ?? now.toISOString()),
          ),
          detected_to_verified_ms: Math.max(
            0,
            Date.parse(at) - Date.parse(descriptor.discovered_at),
          ),
        },
      };
    } catch (error) {
      const conflict =
        (error instanceof Error &&
          /^(TRANSCRIPT_ARCHIVE_(?:CONFLICT|SOURCE_MISMATCH|INVALID_COVERAGE|TOO_LARGE)|ARTIFACT_|PAYLOAD_ARCHIVE_)/.test(
            error.message,
          )) ||
        (error instanceof DriveFailure && error.category === 'CONFLICT');
      const reason =
        error instanceof DriveFailure
          ? 'DRIVE_' + error.category
          : error instanceof Error &&
              [
                'TRANSCRIPT_ARCHIVE_STALE_FENCE',
                'TRANSCRIPT_ARCHIVE_CONFLICT',
                'TRANSCRIPT_ARCHIVE_SOURCE_MISMATCH',
                'TRANSCRIPT_ARCHIVE_INVALID_COVERAGE',
                'TRANSCRIPT_ARCHIVE_TOO_LARGE',
                'ARTIFACT_CONTENT_HASH_MISMATCH',
                'ARTIFACT_CHUNK_ORDER_INVALID',
                'ARTIFACT_CHUNK_MISSING',
                'ARTIFACT_CHUNK_CORRUPT',
              ].includes(error.message)
            ? error.message
            : 'TRANSCRIPT_ARCHIVE_RECOVERY_REQUIRED';
      const seconds = Math.max(
        error instanceof DriveFailure ? (error.retry_after_seconds ?? 0) : 0,
        Math.min(6 * 3600, 60 * 2 ** Math.min(claimed.attempt_count, 8)),
      );
      await this.db
        .prepare(
          `UPDATE transcript_archives SET state=?,last_reason=?,due_at=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE ${guard}`,
        )
        .bind(
          conflict ? 'CONFLICT' : 'RETRY_WAIT',
          reason,
          new Date(Date.parse(currentTime()) + seconds * 1000).toISOString(),
          currentTime(),
          ...bind(),
        )
        .run();
      return {
        state: conflict ? 'CONFLICT' : 'RETRY_WAIT',
        item_id: due,
        reason,
      };
    }
  }
}
