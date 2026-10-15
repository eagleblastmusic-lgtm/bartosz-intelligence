import { AccessContext, type Database } from '../db/boundary.js';
import { TranscriptPayloadArchive } from '../transcript/payload-archive.js';
import {
  DriveClient,
  DriveFailure,
  DriveBudgetWait,
  requireDriveId,
} from '../drive/client.js';
import { sha256 } from '../auth/crypto.js';
import { ArtifactRepository } from '../artifacts/store.js';
import {
  renderTranscriptArchive,
  type TranscriptArchiveDescriptor,
  type TranscriptArchiveManifest,
} from '../transcript/archive-renderer.js';
import {
  localDayRange,
  publicationDate,
  requireLocalDate,
  monthDays,
} from '../projections/dates.js';
import {
  canonicalTranscriptRoot,
  canonicalReportRoot,
  type DailyManifest,
  type DailyReport,
  type DailyReportSnapshot,
} from '../../../contracts/src/daily-report.js';
import {
  manifestText,
  manifestHash,
  parseDailyReport,
  renderDailyReport,
  previousMaterialDate,
  closedDay,
} from './format.js';
import { DailyDriveStorage } from './drive.js';

type Settings = {
  connection_id: string;
  transcript_root_id: string;
  report_root_id: string;
  staging_folder_id: string | null;
  enabled: number;
  started_at: string;
  lease_until: string | null;
  fencing_token: number;
  inbox_scan_after_date: string | null;
  private_verified_at: string;
};
type Collection = {
  material_date: string;
  closed_at: string | null;
  state: string;
  manifest_json: string | null;
  manifest_hash: string | null;
};
type Material = {
  item_id: string;
  video_id: string;
  material_date: string;
  source_artifact_id: string;
  segment_map_artifact_id: string;
  source_hash: string;
  acquired_at: string;
  descriptor_json: string;
  reserved_file_id: string | null;
  verified_hash: string | null;
  state: string | null;
  archive_attempt_count: number;
};
type ReportRow = {
  report_json: string;
  status: string;
  file_id: string;
  manifest_hash: string;
  content_hash: string;
  verified_at: string;
  remote_version: string;
};
export class DailyTasksWorkflow {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    context.requireOwnerOrTask('DRIVE_EXPORT');
  }
  async settings() {
    return this.db
      .prepare('SELECT * FROM daily_workflow_settings WHERE owner_id=?')
      .bind(this.context.ownerId)
      .first<Settings>();
  }
  async audit(client: DriveClient, staging: string | null = null) {
    const receipts = [];
    for (const id of [
      canonicalTranscriptRoot,
      canonicalReportRoot,
      ...(staging ? [requireDriveId(staging)] : []),
    ]) {
      const file = await client.getFile(id);
      if (
        file.mimeType !== 'application/vnd.google-apps.folder' ||
        file.trashed !== false ||
        file.capabilities?.canAddChildren !== true
      )
        throw new Error('DAILY_DRIVE_PERMISSION_HOLD');
      await client.verifyPrivateFolder(id);
      receipts.push({
        folder_id: id,
        private_owner_only: true,
        writable: true,
      });
    }
    return receipts;
  }
  async configure(
    client: DriveClient,
    input: {
      connection_id: string;
      staging_folder_id: string | null;
      enabled: boolean;
    },
    now: Date,
  ) {
    this.context.requireOwner();
    requireDriveId(input.connection_id);
    if (
      typeof input.enabled !== 'boolean' ||
      !(
        input.staging_folder_id === null ||
        typeof input.staging_folder_id === 'string'
      )
    )
      throw new Error('INVALID_DAILY_SETTINGS');
    const connected = await this.db
      .prepare(
        "SELECT 1 FROM drive_connections WHERE owner_id=? AND connection_id=? AND auth_state='CONNECTED'",
      )
      .bind(this.context.ownerId, input.connection_id)
      .first();
    if (!connected) throw new Error('DAILY_CONNECTION_REQUIRED');
    const audit = await this.audit(client, input.staging_folder_id),
      old = await this.settings();
    if (
      old &&
      (old.connection_id !== input.connection_id ||
        old.staging_folder_id !== input.staging_folder_id)
    )
      throw new Error('DAILY_SETTINGS_CONFLICT');
    await this.db
      .prepare(
        `INSERT INTO daily_workflow_settings(owner_id,connection_id,transcript_root_id,report_root_id,staging_folder_id,enabled,started_at,private_verified_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(owner_id) DO UPDATE SET enabled=excluded.enabled,private_verified_at=excluded.private_verified_at,updated_at=excluded.updated_at,fencing_token=daily_workflow_settings.fencing_token+1,lease_owner=NULL,lease_until=NULL`,
      )
      .bind(
        this.context.ownerId,
        input.connection_id,
        canonicalTranscriptRoot,
        canonicalReportRoot,
        input.staging_folder_id,
        input.enabled ? 1 : 0,
        old?.started_at ?? now.toISOString(),
        now.toISOString(),
        now.toISOString(),
      )
      .run();
    return {
      enabled: input.enabled,
      audit,
      chatgpt_tasks_status: 'PENDING_OWNER_ACTION',
      remote_executor_status: 'PENDING_OWNER_ACTION',
    };
  }
  private async materials(date: string) {
    return (
      await this.db
        .prepare(
          `SELECT m.*,f.reserved_file_id,f.verified_hash,f.state FROM daily_materials m LEFT JOIN daily_drive_files f ON f.owner_id=m.owner_id AND f.object_key='transcript:'||m.video_id WHERE m.owner_id=? AND m.material_date=? ORDER BY m.video_id LIMIT 2001`,
        )
        .bind(this.context.ownerId, date)
        .all<Material>()
    ).results;
  }
  async close(
    date: string,
    now: Date,
    guard: () => Promise<void> = async () => {},
  ) {
    requireLocalDate(date);
    if (!closedDay(date, now)) throw new Error('DAILY_DAY_OPEN');
    const existing = await this.db
      .prepare(
        'SELECT * FROM daily_collections WHERE owner_id=? AND material_date=?',
      )
      .bind(this.context.ownerId, date)
      .first<Collection>();
    const report = await this.db
      .prepare(
        'SELECT status FROM daily_reports WHERE owner_id=? AND material_date=?',
      )
      .bind(this.context.ownerId, date)
      .first<{ status: string }>();
    if (report?.status === 'COMPLETE' && existing?.manifest_json)
      return JSON.parse(existing.manifest_json) as DailyManifest;
    const rows = await this.materials(date);
    if (rows.length > 2000) throw new Error('DAILY_COLLECTION_TOO_LARGE');
    const entries = rows.map((row) => {
      const d = JSON.parse(row.descriptor_json) as TranscriptArchiveDescriptor;
      const ready =
        row.state === 'VERIFIED' &&
        !!row.verified_hash &&
        !!row.reserved_file_id;
      return {
        video_id: row.video_id,
        title: d.title,
        youtube_url: d.url,
        transcript_file_id: ready ? row.reserved_file_id : null,
        transcript_sha256: ready ? row.verified_hash : null,
        source_sha256: row.source_hash,
        acquired_at: row.acquired_at,
        state: ready ? ('READY' as const) : ('PENDING' as const),
      };
    });
    const manifest: DailyManifest = {
      schema: 'bi-daily-manifest:1',
      material_date: date,
      timezone: 'Europe/Warsaw',
      closed_at: localDayRange(date).end,
      expected_count: entries.length,
      ready_count: entries.filter((e) => e.state === 'READY').length,
      entries,
    };
    const hash = await manifestHash(manifest);
    await guard();
    await this.db
      .prepare(
        `INSERT INTO daily_collections(owner_id,material_date,closed_at,state,manifest_json,manifest_hash,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(owner_id,material_date) DO UPDATE SET closed_at=excluded.closed_at,state=excluded.state,manifest_json=excluded.manifest_json,manifest_hash=excluded.manifest_hash,updated_at=excluded.updated_at`,
      )
      .bind(
        this.context.ownerId,
        date,
        manifest.closed_at,
        manifest.ready_count === manifest.expected_count
          ? 'READY'
          : 'WAITING_FILES',
        JSON.stringify(manifest),
        hash,
        now.toISOString(),
      )
      .run();
    return manifest;
  }
  async registerCandidate(fileId: string, date: string, now: Date) {
    this.context.requireOwner();
    requireDriveId(fileId);
    requireLocalDate(date);
    await this.db
      .prepare(
        "INSERT INTO daily_report_inbox(owner_id,file_id,material_date,state,due_at,updated_at) VALUES(?,?,?,'PENDING',?,?) ON CONFLICT(owner_id,file_id) DO UPDATE SET state='PENDING',attempt_count=0,reason=NULL,due_at=excluded.due_at,updated_at=excluded.updated_at WHERE daily_report_inbox.material_date=excluded.material_date",
      )
      .bind(
        this.context.ownerId,
        fileId,
        date,
        now.toISOString(),
        now.toISOString(),
      )
      .run();
    return { state: 'PENDING' };
  }
  private async importCandidate(
    fileId: string,
    date: string,
    storage: DailyDriveStorage,
    settings: Settings,
    now: Date,
    guard: () => Promise<void>,
  ) {
    const collection = await this.db
      .prepare(
        'SELECT * FROM daily_collections WHERE owner_id=? AND material_date=?',
      )
      .bind(this.context.ownerId, date)
      .first<Collection>();
    if (
      !collection?.closed_at ||
      !collection.manifest_json ||
      !collection.manifest_hash
    )
      throw new Error('DAILY_MANIFEST_NOT_READY');
    const manifestFile = await storage.read('manifest:' + date);
    if (
      manifestFile?.state !== 'VERIFIED' ||
      manifestFile.verified_hash !==
        (await sha256(
          manifestText(
            JSON.parse(collection.manifest_json) as DailyManifest,
            collection.manifest_hash,
          ),
        ))
    )
      throw new Error('DAILY_MANIFEST_NOT_READY');
    const manifest = JSON.parse(collection.manifest_json) as DailyManifest;
    const canonicalFolder = await storage.folder(
      settings.report_root_id,
      date,
      now,
    );
    const before = await storage.client.getFile(fileId);
    if (
      before.trashed !== false ||
      !before.version ||
      !before.parents?.some(
        (p) => p === canonicalFolder || p === settings.staging_folder_id,
      )
    )
      throw new Error('DAILY_CANDIDATE_LOCATION_HOLD');
    await storage.client.verifyPrivateFolder(fileId);
    const text = await storage.client.readDailyDocument(fileId),
      after = await storage.client.getFile(fileId);
    if (
      before.version !== after.version ||
      before.parents?.join(',') !== after.parents?.join(',') ||
      after.trashed !== false
    )
      throw new Error('DAILY_FILE_CONFLICT');
    const report = await parseDailyReport(
      text,
      manifest,
      collection.manifest_hash,
    );
    if (Date.parse(report.generated_at) > now.getTime() + 300000)
      throw new Error('INVALID_DAILY_REPORT');
    const direct =
      before.mimeType === 'text/markdown' &&
      before.name === date + '.md' &&
      before.parents?.includes(canonicalFolder);
    const markdown = direct ? text : renderDailyReport(report),
      hash = await sha256(markdown);
    const old = await this.db
      .prepare(
        'SELECT * FROM daily_reports WHERE owner_id=? AND material_date=?',
      )
      .bind(this.context.ownerId, date)
      .first<ReportRow>();
    if (old?.status === 'COMPLETE' && old.content_hash !== hash)
      throw new Error('DAILY_REPORT_CONFLICT');
    // Export to a genuine UTF-8 .md; the source Docs stays native and untouched.
    // No move permission is required, and no application-wide Drive scope is added.
    if (direct) {
      const prior = await storage.read('report:' + date);
      if (prior && prior.reserved_file_id !== fileId)
        throw new Error('DAILY_REPORT_CONFLICT');
      await guard();
      await this.db
        .prepare(
          `INSERT INTO daily_drive_files(owner_id,object_key,folder_id,name,reserved_file_id,content_hash,verified_hash,remote_version,verified_at,state,due_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'VERIFIED',?,?) ON CONFLICT(owner_id,object_key) DO UPDATE SET content_hash=excluded.content_hash,verified_hash=excluded.verified_hash,remote_version=excluded.remote_version,verified_at=excluded.verified_at,state='VERIFIED',reason=NULL,updated_at=excluded.updated_at WHERE daily_drive_files.reserved_file_id=excluded.reserved_file_id`,
        )
        .bind(
          this.context.ownerId,
          'report:' + date,
          canonicalFolder,
          date + '.md',
          fileId,
          hash,
          hash,
          after.version!,
          now.toISOString(),
          now.toISOString(),
          now.toISOString(),
        )
        .run();
    }
    const file = direct
      ? (await storage.read('report:' + date))!
      : await storage.publish(
          {
            key: 'report:' + date,
            folder: canonicalFolder,
            name: date + '.md',
            text: markdown,
            mutable: old?.status === 'PARTIAL',
          },
          now,
        );
    if (
      file.state !== 'VERIFIED' ||
      file.verified_hash !== hash ||
      !file.remote_version
    )
      throw new Error('DAILY_PUBLICATION_PENDING');
    await guard();
    await this.db
      .prepare(
        `INSERT INTO daily_reports(owner_id,material_date,manifest_hash,content_hash,report_json,file_id,source_file_id,remote_version,status,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(owner_id,material_date) DO UPDATE SET manifest_hash=excluded.manifest_hash,content_hash=excluded.content_hash,report_json=excluded.report_json,file_id=excluded.file_id,source_file_id=excluded.source_file_id,remote_version=excluded.remote_version,status=excluded.status,verified_at=excluded.verified_at
      WHERE daily_reports.status='PARTIAL' OR daily_reports.content_hash=excluded.content_hash`,
      )
      .bind(
        this.context.ownerId,
        date,
        collection.manifest_hash,
        hash,
        JSON.stringify(report),
        file.reserved_file_id,
        fileId,
        file.remote_version,
        report.skipped_count === 0 ? 'COMPLETE' : 'PARTIAL',
        now.toISOString(),
      )
      .run();
    await this.db
      .prepare(
        "UPDATE daily_report_inbox SET state='IMPORTED',reason=NULL,updated_at=? WHERE owner_id=? AND file_id=?",
      )
      .bind(now.toISOString(), this.context.ownerId, fileId)
      .run();
    return {
      state: report.skipped_count === 0 ? 'COMPLETE' : 'PARTIAL',
      file_id: file.reserved_file_id,
    };
  }
  async hasReadyTranscript(now: Date) {
    return Boolean(
      await this.db
        .prepare(
          `SELECT 1 FROM daily_materials m LEFT JOIN daily_drive_files f ON f.owner_id=m.owner_id AND f.object_key='transcript:'||m.video_id
      WHERE m.owner_id=? AND m.archive_attempt_count<8 AND (m.archive_due_at IS NULL OR m.archive_due_at<=?) AND (f.object_key IS NULL OR (f.state IN ('PENDING','RETRY_WAIT') AND f.due_at<=?)) AND NOT EXISTS(SELECT 1 FROM daily_materials blocked WHERE blocked.owner_id=m.owner_id AND blocked.archive_reason='DRIVE_QUOTA' AND blocked.archive_due_at>?) LIMIT 1`,
        )
        .bind(
          this.context.ownerId,
          now.toISOString(),
          now.toISOString(),
          now.toISOString(),
        )
        .first(),
    );
  }
  async tick(
    client: DriveClient,
    now: Date,
    mode: 'ALL' | 'TRANSCRIPT' | 'REPORTS' = 'ALL',
  ) {
    const settings = await this.settings();
    if (!settings?.enabled) return { state: 'DISABLED' };
    if (
      await this.db
        .prepare(
          "SELECT 1 FROM daily_materials WHERE owner_id=? AND archive_reason='DRIVE_QUOTA' AND archive_due_at>? LIMIT 1",
        )
        .bind(this.context.ownerId, now.toISOString())
        .first()
    )
      return { state: 'QUOTA_WAIT' };
    if (this.context.kind === 'worker')
      (
        await AccessContext.worker(this.db, this.context.credentialHash!)
      ).requireTask('DRIVE_EXPORT');
    const lease = await this.db
      .prepare(
        'UPDATE daily_workflow_settings SET lease_owner=?,lease_until=?,fencing_token=fencing_token+1 WHERE owner_id=? AND enabled=1 AND (lease_until IS NULL OR lease_until<=?) RETURNING fencing_token',
      )
      .bind(
        this.context.actorId,
        new Date(now.getTime() + 900000).toISOString(),
        this.context.ownerId,
        now.toISOString(),
      )
      .first<{ fencing_token: number }>();
    if (!lease) return { state: 'LEASE_BUSY' };
    const started = Date.now(),
      current = () =>
        new Date(
          now.getTime() + Math.max(0, Date.now() - started),
        ).toISOString();
    const guard = async () => {
      if (this.context.kind === 'worker')
        (
          await AccessContext.worker(this.db, this.context.credentialHash!)
        ).requireTask('DRIVE_EXPORT');
      if (
        !(await this.db
          .prepare(
            "SELECT 1 FROM daily_workflow_settings w JOIN drive_connections c USING(owner_id,connection_id) WHERE w.owner_id=? AND w.enabled=1 AND w.lease_owner=? AND w.fencing_token=? AND w.lease_until>? AND c.auth_state='CONNECTED'",
          )
          .bind(
            this.context.ownerId,
            this.context.actorId,
            lease.fencing_token,
            current(),
          )
          .first())
      )
        throw new Error('DAILY_STALE_FENCE');
    };
    const storage = new DailyDriveStorage(this.db, this.context, client, guard);
    const outcomes: Record<string, unknown> = {};
    try {
      try {
        await this.audit(client, settings.staging_folder_id);
      } catch (error) {
        const permissionHold =
          (error instanceof DriveFailure &&
            ['DENIED', 'NOT_FOUND', 'AUTH'].includes(error.category)) ||
          (error instanceof Error &&
            error.message === 'DAILY_DRIVE_PERMISSION_HOLD');
        if (!permissionHold) throw error;
        await guard();
        // Stop enrollment/publication when a previously private root loses its
        // access guarantee. Only an owner configuration with a fresh audit can
        // resume. Existing canonical bytes and receipts stay untouched.
        await this.db
          .prepare(
            'UPDATE daily_workflow_settings SET enabled=0,fencing_token=fencing_token+1,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE owner_id=? AND fencing_token=?',
          )
          .bind(current(), this.context.ownerId, lease.fencing_token)
          .run();
        return {
          state: 'PERMISSION_HOLD',
          reason: 'DAILY_DRIVE_PERMISSION_HOLD',
        };
      }
      const material =
        mode === 'REPORTS'
          ? null
          : await this.db
              .prepare(
                `SELECT m.* FROM daily_materials m LEFT JOIN daily_drive_files f ON f.owner_id=m.owner_id AND f.object_key='transcript:'||m.video_id WHERE m.owner_id=? AND m.archive_attempt_count<8 AND (m.archive_due_at IS NULL OR m.archive_due_at<=?) AND (f.object_key IS NULL OR (f.state IN ('PENDING','RETRY_WAIT') AND f.due_at<=?)) ORDER BY m.acquired_at,m.video_id LIMIT 1`,
              )
              .bind(this.context.ownerId, now.toISOString(), now.toISOString())
              .first<Material>();
      if (material) {
        try {
          const folder = await storage.folder(
            settings.transcript_root_id,
            material.material_date,
            now,
          );
          if (mode === 'TRANSCRIPT' && storage.createdFolders > 0) {
            return { state: 'TRANSCRIPT_PREPARED' };
          }
          const technical = await new TranscriptPayloadArchive(
            this.db,
            this.context,
          ).ensure(
            material.source_artifact_id,
            client,
            folder,
            settings.connection_id,
            now,
            guard,
          );
          if (mode === 'TRANSCRIPT' && technical && !technical.already_verified)
            return { state: 'TRANSCRIPT_PREPARED' };
          const artifacts = new ArtifactRepository(this.db, this.context),
            source = await artifacts.readTranscriptArchiveText(
              material.source_artifact_id,
              now,
            ),
            map = await artifacts.readTranscriptArchiveText(
              material.segment_map_artifact_id,
              now,
            );
          if (
            source.artifact.kind !== 'SOURCE_ORIGINAL' ||
            source.artifact.item_id !== material.item_id ||
            source.artifact.content_hash !== material.source_hash ||
            map.artifact.original_ref !== material.source_artifact_id ||
            map.artifact.kind !== 'SEGMENT_MAP' ||
            map.artifact.item_id !== material.item_id
          )
            throw new Error('DAILY_SOURCE_INTEGRITY_HOLD');
          const rendered = await renderTranscriptArchive({
            descriptor: JSON.parse(
              material.descriptor_json,
            ) as TranscriptArchiveDescriptor,
            source_text: source.text,
            source_hash: material.source_hash,
            manifest: JSON.parse(map.text) as TranscriptArchiveManifest,
          });
          outcomes.transcript = await storage
            .publish(
              {
                key: 'transcript:' + material.video_id,
                folder,
                name: material.video_id + '.md',
                text: rendered.markdown,
                mutable: false,
                transcript: true,
              },
              now,
            )
            .then((file) => ({
              state: file.state,
              video_id: material.video_id,
            }));
        } catch (error) {
          if (error instanceof DriveBudgetWait) throw error;
          await guard();
          const retry =
              error instanceof DriveFailure &&
              ['TRANSIENT', 'TRANSPORT', 'QUOTA'].includes(error.category),
            attempt = material.archive_attempt_count + 1;
          const reason =
            error instanceof DriveFailure
              ? error.message
              : 'DAILY_SOURCE_OR_FILE_HOLD';
          await this.db
            .prepare(
              'UPDATE daily_materials SET archive_attempt_count=?,archive_due_at=?,archive_reason=? WHERE owner_id=? AND item_id=?',
            )
            .bind(
              retry ? attempt : 8,
              new Date(
                now.getTime() +
                  Math.max(
                    Math.min(3600, 30 * 2 ** Math.min(attempt - 1, 7)) * 1000,
                    error instanceof DriveFailure
                      ? (error.retry_after_seconds ?? 0) * 1000
                      : 0,
                  ),
              ).toISOString(),
              reason,
              this.context.ownerId,
              material.item_id,
            )
            .run();
          outcomes.transcript = {
            state: retry && attempt < 8 ? 'RETRY_WAIT' : 'HELD',
            reason,
          };
        }
      }
      if (mode === 'TRANSCRIPT')
        return { state: 'TRANSCRIPT_TICK', ...outcomes };
      const previous = previousMaterialDate(now);
      if (previous >= publicationDate(settings.started_at)) {
        await guard();
        await this.db
          .prepare(
            'INSERT INTO daily_collections(owner_id,material_date,updated_at) VALUES(?,?,?) ON CONFLICT DO NOTHING',
          )
          .bind(this.context.ownerId, previous, now.toISOString())
          .run();
      }
      // Retry the oldest unsettled date; settled reports never monopolize closure.
      const due = await this.db
        .prepare(
          `SELECT c.material_date FROM daily_collections c LEFT JOIN daily_reports r ON r.owner_id=c.owner_id AND r.material_date=c.material_date LEFT JOIN daily_drive_files f ON f.owner_id=c.owner_id AND f.object_key='manifest:'||c.material_date WHERE c.owner_id=? AND c.material_date<? AND (c.state IN ('OPEN','WAITING_FILES') OR f.state IS NULL OR f.state IN ('PENDING','RETRY_WAIT')) AND (f.state IS NULL OR f.state!='RETRY_WAIT' OR f.due_at<=?) ORDER BY c.material_date LIMIT 1`,
        )
        .bind(
          this.context.ownerId,
          publicationDate(now.toISOString()),
          now.toISOString(),
        )
        .first<{ material_date: string }>();
      if (due) {
        try {
          const manifest = await this.close(due.material_date, now, guard),
            folder = await storage.folder(
              settings.transcript_root_id,
              due.material_date,
              now,
            );
          const file = await storage.publish(
            {
              key: 'manifest:' + due.material_date,
              folder,
              name: '_manifest.md',
              text: manifestText(manifest, await manifestHash(manifest)),
              mutable: true,
            },
            now,
          );
          outcomes.manifest = { state: file.state, date: due.material_date };
        } catch (error) {
          if (error instanceof DriveBudgetWait) throw error;
          outcomes.manifest = {
            state: 'HELD',
            reason:
              error instanceof DriveFailure
                ? error.message
                : 'DAILY_MANIFEST_HOLD',
          };
        }
      }
      // Discover only exact stable names in the explicitly approved inbox.
      {
        let wanted = await this.db
          .prepare(
            `SELECT c.material_date FROM daily_collections c LEFT JOIN daily_reports r ON r.owner_id=c.owner_id AND r.material_date=c.material_date WHERE c.owner_id=? AND c.closed_at IS NOT NULL AND (r.status IS NULL OR r.status='PARTIAL') AND c.material_date>? ORDER BY c.material_date LIMIT 1`,
          )
          .bind(this.context.ownerId, settings.inbox_scan_after_date ?? '')
          .first<{ material_date: string }>();
        if (!wanted)
          wanted = await this.db
            .prepare(
              `SELECT c.material_date FROM daily_collections c LEFT JOIN daily_reports r ON r.owner_id=c.owner_id AND r.material_date=c.material_date WHERE c.owner_id=? AND c.closed_at IS NOT NULL AND (r.status IS NULL OR r.status='PARTIAL') ORDER BY c.material_date LIMIT 1`,
            )
            .bind(this.context.ownerId)
            .first<{ material_date: string }>();
        if (wanted) {
          const target = await storage.folder(
              settings.report_root_id,
              wanted.material_date,
              now,
            ),
            owned = await storage.read('report:' + wanted.material_date);
          const matches = [
            ...(settings.staging_folder_id
              ? await client.findNamedChildren(
                  settings.staging_folder_id,
                  'BI-Daily-' + wanted.material_date,
                )
              : []),
            ...(await client.findNamedChildren(
              target,
              wanted.material_date + '.md',
            )),
            ...(await client.findNamedChildren(
              target,
              'BI-Daily-' + wanted.material_date,
            )),
          ];
          // A previously published application copy is not another inbox candidate.
          const candidates = matches.filter(
            (f) =>
              f.id !== owned?.reserved_file_id ||
              !(f.appProperties?.bi_daily === 'v1'),
          );
          if (candidates.length > 1) outcomes.inbox = { state: 'AMBIGUOUS' };
          else if (candidates[0]) {
            await guard();
            await this.db
              .prepare(
                "INSERT INTO daily_report_inbox(owner_id,file_id,material_date,state,observed_version,due_at,updated_at) VALUES(?,?,?,'PENDING',?,?,?) ON CONFLICT(owner_id,file_id) DO UPDATE SET state='PENDING',attempt_count=0,reason=NULL,observed_version=excluded.observed_version,due_at=excluded.due_at,updated_at=excluded.updated_at WHERE daily_report_inbox.observed_version IS NOT excluded.observed_version",
              )
              .bind(
                this.context.ownerId,
                candidates[0].id,
                wanted.material_date,
                candidates[0].version ?? null,
                now.toISOString(),
                now.toISOString(),
              )
              .run();
          }
          await guard();
          await this.db
            .prepare(
              'UPDATE daily_workflow_settings SET inbox_scan_after_date=? WHERE owner_id=? AND fencing_token=?',
            )
            .bind(
              wanted.material_date,
              this.context.ownerId,
              lease.fencing_token,
            )
            .run();
        }
      }
      const candidate = await this.db
        .prepare(
          "SELECT file_id,material_date,attempt_count FROM daily_report_inbox WHERE owner_id=? AND state IN ('PENDING','RETRY_WAIT') AND due_at<=? ORDER BY due_at,file_id LIMIT 1",
        )
        .bind(this.context.ownerId, now.toISOString())
        .first<{
          file_id: string;
          material_date: string;
          attempt_count: number;
        }>();
      if (candidate) {
        try {
          outcomes.report = await this.importCandidate(
            candidate.file_id,
            candidate.material_date,
            storage,
            settings,
            now,
            guard,
          );
        } catch (error) {
          if (error instanceof DriveBudgetWait) throw error;
          await guard();
          const retry =
            (error instanceof DriveFailure &&
              ['QUOTA', 'TRANSIENT', 'TRANSPORT'].includes(error.category)) ||
            (error instanceof Error &&
              [
                'DAILY_MANIFEST_NOT_READY',
                'DAILY_PUBLICATION_PENDING',
              ].includes(error.message));
          const attempt = candidate.attempt_count + 1;
          const reason =
            error instanceof DriveFailure
              ? error.message
              : error instanceof Error &&
                  /^(?:INVALID_DAILY_REPORT|DAILY_[A-Z_]+)$/.test(error.message)
                ? error.message
                : 'DAILY_IMPORT_HOLD';
          await this.db
            .prepare(
              'UPDATE daily_report_inbox SET state=?,attempt_count=?,reason=?,due_at=?,updated_at=? WHERE owner_id=? AND file_id=?',
            )
            .bind(
              retry && attempt < 8 ? 'RETRY_WAIT' : 'REJECTED',
              attempt,
              reason,
              new Date(
                now.getTime() +
                  Math.min(3600, 30 * 2 ** Math.min(attempt - 1, 7)) * 1000,
              ).toISOString(),
              now.toISOString(),
              this.context.ownerId,
              candidate.file_id,
            )
            .run();
          outcomes.report = {
            state: retry && attempt < 8 ? 'RETRY_WAIT' : 'HELD',
            reason,
          };
        }
      }
      // Detect edits/deletion/moves of cached canonical reports. Never expose the
      // cache as COMPLETE once the canonical version/permissions no longer match.
      const cached = await this.db
        .prepare(
          'SELECT material_date,file_id,remote_version FROM daily_reports WHERE owner_id=? ORDER BY verified_at LIMIT 1',
        )
        .bind(this.context.ownerId)
        .first<{
          material_date: string;
          file_id: string;
          remote_version: string;
        }>();
      if (cached) {
        try {
          await client.verifyPrivateFolder(cached.file_id);
          const meta = await client.getFile(cached.file_id),
            receipt = await storage.read('report:' + cached.material_date);
          if (
            meta.trashed !== false ||
            meta.version !== cached.remote_version ||
            !receipt ||
            !meta.parents?.includes(receipt.folder_id)
          )
            throw new Error('DAILY_FILE_CONFLICT');
          await guard();
          await this.db
            .prepare(
              'UPDATE daily_reports SET verified_at=? WHERE owner_id=? AND material_date=?',
            )
            .bind(now.toISOString(), this.context.ownerId, cached.material_date)
            .run();
        } catch (error) {
          if (error instanceof DriveBudgetWait) throw error;
          await guard();
          await this.db
            .prepare(
              "UPDATE daily_drive_files SET state='CONFLICT',reason='DAILY_CANONICAL_READBACK_HOLD' WHERE owner_id=? AND object_key=?",
            )
            .bind(this.context.ownerId, 'report:' + cached.material_date)
            .run();
        }
      }
      return { state: 'BOUNDED_TICK', ...outcomes };
    } catch (error) {
      if (error instanceof DriveBudgetWait)
        return { state: 'WAIT_NEXT_TICK', ...outcomes };
      throw error;
    } finally {
      await this.db
        .prepare(
          'UPDATE daily_workflow_settings SET lease_owner=NULL,lease_until=NULL WHERE owner_id=? AND lease_owner=? AND fencing_token=?',
        )
        .bind(this.context.ownerId, this.context.actorId, lease.fencing_token)
        .run();
    }
  }
  async day(date: string): Promise<DailyReportSnapshot> {
    this.context.requireOwner();
    requireLocalDate(date);
    const collection = await this.db
        .prepare(
          'SELECT * FROM daily_collections WHERE owner_id=? AND material_date=?',
        )
        .bind(this.context.ownerId, date)
        .first<Collection>(),
      rows = await this.materials(date),
      settings = await this.settings();
    const report = await this.db
      .prepare(
        'SELECT * FROM daily_reports WHERE owner_id=? AND material_date=?',
      )
      .bind(this.context.ownerId, date)
      .first<ReportRow>();
    const file = await this.db
      .prepare(
        'SELECT state FROM daily_drive_files WHERE owner_id=? AND object_key=?',
      )
      .bind(this.context.ownerId, 'report:' + date)
      .first<{ state: string }>();
    const manifestFile = await this.db
      .prepare(
        'SELECT reserved_file_id,verified_hash,state FROM daily_drive_files WHERE owner_id=? AND object_key=?',
      )
      .bind(this.context.ownerId, 'manifest:' + date)
      .first<{
        reserved_file_id: string;
        verified_hash: string;
        state: string;
      }>();
    const data = report
        ? (JSON.parse(report.report_json) as DailyReport)
        : null,
      pending = rows
        .filter((r) => r.state !== 'VERIFIED')
        .map((r) => r.video_id),
      processed = new Set(
        data?.videos
          .filter((v) => v.status === 'PROCESSED')
          .map((v) => v.video_id) ?? [],
      );
    const connected = await this.db
      .prepare(
        "SELECT 1 FROM drive_connections WHERE owner_id=? AND connection_id=? AND auth_state='CONNECTED'",
      )
      .bind(this.context.ownerId, settings?.connection_id ?? '')
      .first();
    return {
      material_date: date,
      timezone: 'Europe/Warsaw',
      state: report
        ? file?.state === 'VERIFIED' &&
          settings?.enabled === 1 &&
          connected &&
          report.verified_at >= settings.private_verified_at
          ? report.status === 'COMPLETE'
            ? 'COMPLETE'
            : 'PARTIAL'
          : 'INTEGRITY_HOLD'
        : !settings?.enabled
          ? 'DISABLED'
          : !collection?.closed_at
            ? 'OPEN'
            : collection.state === 'WAITING_FILES'
              ? 'WAITING_FILES'
              : 'MISSING',
      expected_count: rows.length,
      ready_count: rows.length - pending.length,
      processed_count: data?.processed_count ?? 0,
      skipped_count: data?.skipped_count ?? 0,
      manifest_sha256: collection?.manifest_hash ?? null,
      manifest_file_id:
        manifestFile?.state === 'VERIFIED' &&
        collection?.manifest_json &&
        collection.manifest_hash &&
        manifestFile.verified_hash ===
          (await sha256(
            manifestText(
              JSON.parse(collection.manifest_json) as DailyManifest,
              collection.manifest_hash,
            ),
          ))
          ? manifestFile.reserved_file_id
          : null,
      report_file_id: report?.file_id ?? null,
      verified_at: report?.verified_at ?? null,
      videos: data?.videos ?? [],
      missing_video_ids: rows
        .filter((r) => !processed.has(r.video_id))
        .map((r) => r.video_id),
      pending_video_ids: pending,
    };
  }
  async calendar(month: string) {
    this.context.requireOwner();
    const range = monthDays(month),
      settings = await this.settings(),
      connected = await this.db
        .prepare(
          "SELECT 1 FROM drive_connections WHERE owner_id=? AND connection_id=? AND auth_state='CONNECTED'",
        )
        .bind(this.context.ownerId, settings?.connection_id ?? '')
        .first(),
      records = (
        await this.db
          .prepare(
            `SELECT c.material_date,c.state,r.status,r.verified_at,f.state file_state,json_extract(c.manifest_json,'$.expected_count') expected,json_extract(c.manifest_json,'$.ready_count') ready FROM daily_collections c LEFT JOIN daily_reports r ON r.owner_id=c.owner_id AND r.material_date=c.material_date LEFT JOIN daily_drive_files f ON f.owner_id=c.owner_id AND f.object_key='report:'||c.material_date WHERE c.owner_id=? AND c.material_date>=? AND c.material_date<=?`,
          )
          .bind(this.context.ownerId, range[0]!.date, range.at(-1)!.date)
          .all<{
            material_date: string;
            state: string;
            status: string | null;
            verified_at: string | null;
            file_state: string | null;
            expected: number | null;
            ready: number | null;
          }>()
      ).results;
    const index = new Map(records.map((row) => [row.material_date, row])),
      days = [];
    for (const date of range) {
      const row = index.get(date.date);
      days.push({
        date: date.date,
        counts: {
          items: row?.expected ?? 0,
          ready: row?.ready ?? 0,
          pending: (row?.expected ?? 0) - (row?.ready ?? 0),
          blocked: 0,
          failed: 0,
        },
        discovery_complete: row?.state === 'READY',
        complete:
          row?.status === 'COMPLETE' &&
          row.file_state === 'VERIFIED' &&
          settings?.enabled === 1 &&
          !!connected &&
          !!row.verified_at &&
          row.verified_at >= settings.private_verified_at,
      });
    }
    return {
      month,
      timezone: 'Europe/Warsaw',
      cut_seq: 0,
      projection_revision: 'daily-reports:' + month,
      days,
      freshness: { sampled_at: new Date().toISOString(), status: 'CURRENT' },
    };
  }
}
