import { AccessContext, type Database } from '../db/boundary.js';
import {
  DriveClient,
  DriveFailure,
  DriveBudgetWait,
  type DriveFile,
} from '../drive/client.js';
import { sha256 } from '../auth/crypto.js';
import { dailyFolderNames } from './format.js';

export type DailyFileRow = {
  object_key: string;
  folder_id: string;
  name: string;
  reserved_file_id: string;
  content_hash: string;
  verified_hash: string | null;
  remote_version: string | null;
  verified_at: string | null;
  state: string;
  attempt_count: number;
  due_at: string;
  reason: string | null;
};
/** One workflow lease serializes publication and folder creation. Persist IDs
 * before POST so timeout/restart always reconciles the same remote object. */
export class DailyDriveStorage {
  constructor(
    private db: Database,
    private context: AccessContext,
    readonly client: DriveClient,
    private guard: () => Promise<void>,
  ) {
    context.requireOwnerOrTask('DRIVE_EXPORT');
  }
  async folder(root: string, date: string, now: Date) {
    let parent = root;
    await this.client.verifyPrivateFolder(parent);
    for (const name of dailyFolderNames(date)) {
      await this.guard();
      let row = await this.db
        .prepare(
          'SELECT folder_id,verified_at FROM daily_drive_folders WHERE owner_id=? AND parent_id=? AND name=?',
        )
        .bind(this.context.ownerId, parent, name)
        .first<{ folder_id: string; verified_at: string | null }>();
      if (!row) {
        const matches = await this.client.findNamedChildren(parent, name);
        if (
          matches.length > 1 ||
          (matches[0] &&
            matches[0].mimeType !== 'application/vnd.google-apps.folder')
        )
          throw new Error('DAILY_FOLDER_CONFLICT');
        const id = matches[0]?.id ?? (await this.client.reserveId());
        await this.guard();
        await this.db
          .prepare(
            'INSERT INTO daily_drive_folders(owner_id,parent_id,name,folder_id) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
          )
          .bind(this.context.ownerId, parent, name, id)
          .run();
        row = await this.db
          .prepare(
            'SELECT folder_id,verified_at FROM daily_drive_folders WHERE owner_id=? AND parent_id=? AND name=?',
          )
          .bind(this.context.ownerId, parent, name)
          .first();
      }
      if (!row) throw new Error('DAILY_FOLDER_CONFLICT');
      let file: DriveFile;
      try {
        file = await this.client.getFile(row.folder_id);
      } catch (error) {
        if (
          !(error instanceof DriveFailure) ||
          error.category !== 'NOT_FOUND' ||
          row.verified_at
        )
          throw error;
        await this.guard();
        try {
          file = await this.client.createFolder({
            reserved_id: row.folder_id,
            name,
            parent_id: parent,
            app_properties: { bi_daily: 'v1' },
          });
        } catch (error) {
          if (
            !(error instanceof DriveFailure) ||
            !['TRANSIENT', 'TRANSPORT', 'CONFLICT'].includes(error.category)
          )
            throw error;
          try {
            file = await this.client.getFile(row.folder_id);
          } catch (readError) {
            if (
              readError instanceof DriveFailure &&
              readError.category === 'NOT_FOUND'
            )
              throw error;
            throw readError;
          }
        }
      }
      if (
        file.name !== name ||
        file.mimeType !== 'application/vnd.google-apps.folder' ||
        file.trashed !== false ||
        !file.parents?.includes(parent)
      )
        throw new Error('DAILY_FOLDER_CONFLICT');
      await this.client.verifyPrivateFolder(file.id);
      await this.guard();
      await this.db
        .prepare(
          'UPDATE daily_drive_folders SET verified_at=? WHERE owner_id=? AND parent_id=? AND name=? AND folder_id=?',
        )
        .bind(now.toISOString(), this.context.ownerId, parent, name, file.id)
        .run();
      parent = file.id;
    }
    return parent;
  }
  async read(key: string) {
    return this.db
      .prepare(
        'SELECT * FROM daily_drive_files WHERE owner_id=? AND object_key=?',
      )
      .bind(this.context.ownerId, key)
      .first<DailyFileRow>();
  }
  async publish(
    input: {
      key: string;
      folder: string;
      name: string;
      text: string;
      mutable: boolean;
      transcript?: boolean;
    },
    now: Date,
  ) {
    const hash = await sha256(input.text),
      at = now.toISOString();
    let row = await this.read(input.key);
    if (row && (row.folder_id !== input.folder || row.name !== input.name))
      throw new Error('DAILY_FILE_CONFLICT');
    if (row?.state === 'CONFLICT') throw new Error('DAILY_FILE_CONFLICT');
    if (row && row.state === 'RETRY_WAIT' && row.due_at > at) return row;
    if (!row) {
      await this.guard();
      await this.client.verifyPrivateFolder(input.folder);
      const matches = await this.client.findNamedChildren(
        input.folder,
        input.name,
      );
      // Never duplicate or adopt an unregistered same-name file without review.
      if (matches.length) throw new Error('DAILY_FILE_CONFLICT');
      const id = await this.client.reserveId();
      await this.guard();
      await this.db
        .prepare(
          "INSERT INTO daily_drive_files(owner_id,object_key,folder_id,name,reserved_file_id,content_hash,state,due_at,updated_at) VALUES(?,?,?,?,?,?,'PENDING',?,?) ON CONFLICT DO NOTHING",
        )
        .bind(
          this.context.ownerId,
          input.key,
          input.folder,
          input.name,
          id,
          hash,
          at,
          at,
        )
        .run();
      row = await this.read(input.key);
    }
    if (!row) throw new Error('DAILY_FILE_CONFLICT');
    if (row.content_hash !== hash && !input.mutable)
      throw new Error('DAILY_FILE_CONFLICT');
    if (row.state === 'VERIFIED' && row.verified_hash === hash) {
      // Metadata checks detect remote edits without rereading every transcript
      // on every cron. Full SHA readback is mandatory on every actual write.
      const file = await this.client.getFile(row.reserved_file_id);
      await this.client.verifyPrivateFolder(row.reserved_file_id);
      if (
        file.version === row.remote_version &&
        file.parents?.includes(input.folder) &&
        file.trashed === false
      )
        return row;
    }
    const properties = {
      bi_daily: 'v1',
      bi_owner: await sha256(this.context.ownerId),
      bi_object: await sha256(input.key),
    };
    const identity = (file: DriveFile) => {
      if (
        file.id !== row!.reserved_file_id ||
        file.name !== input.name ||
        file.mimeType !== 'text/markdown' ||
        file.trashed !== false ||
        !file.version ||
        !file.parents?.includes(input.folder) ||
        Object.entries(properties).some(
          ([k, v]) => file.appProperties?.[k] !== v,
        )
      )
        throw new Error('DAILY_FILE_CONFLICT');
    };
    try {
      await this.guard();
      await this.client.verifyPrivateFolder(input.folder);
      await this.db
        .prepare(
          "UPDATE daily_drive_files SET state='PENDING',content_hash=?,attempt_count=attempt_count+1,updated_at=? WHERE owner_id=? AND object_key=?",
        )
        .bind(hash, at, this.context.ownerId, input.key)
        .run();
      let before: DriveFile;
      try {
        before = await this.client.getFile(row.reserved_file_id);
      } catch (error) {
        if (
          !(error instanceof DriveFailure) ||
          error.category !== 'NOT_FOUND' ||
          row.verified_hash
        )
          throw error;
        await this.guard();
        try {
          const create = input.transcript
            ? this.client.createTranscriptMarkdown.bind(this.client)
            : this.client.createMarkdown.bind(this.client);
          before = await create({
            reserved_id: row.reserved_file_id,
            root_id: input.folder,
            name: input.name,
            markdown: input.text,
            app_properties: properties,
          });
        } catch (error) {
          if (
            !(error instanceof DriveFailure) ||
            !['TRANSIENT', 'TRANSPORT', 'CONFLICT'].includes(error.category)
          )
            throw error;
          try {
            before = await this.client.getFile(row.reserved_file_id);
          } catch (readError) {
            if (
              readError instanceof DriveFailure &&
              readError.category === 'NOT_FOUND'
            )
              throw error;
            throw readError;
          }
        }
      }
      identity(before);
      await this.client.verifyPrivateFolder(row.reserved_file_id);
      const read = () =>
        input.transcript
          ? this.client.readTranscriptMarkdown(row!.reserved_file_id)
          : this.client.readMarkdown(row!.reserved_file_id, 1048576);
      let actual = await sha256(await read()),
        after = await this.client.getFile(row.reserved_file_id);
      identity(after);
      if (before.version !== after.version)
        throw new Error('DAILY_FILE_CONFLICT');
      if (actual !== hash) {
        // Only a previously verified revision can be replaced. An external edit
        // or a corrupt first write is held, never silently overwritten.
        if (!input.mutable || actual !== row.verified_hash)
          throw new Error('DAILY_FILE_CONFLICT');
        await this.guard();
        await this.client.updateMarkdown({
          id: row.reserved_file_id,
          root_id: input.folder,
          app_properties: properties,
          expected_hash: actual,
          markdown: input.text,
          before_write: this.guard,
        });
        before = await this.client.getFile(row.reserved_file_id);
        actual = await sha256(await read());
        after = await this.client.getFile(row.reserved_file_id);
        identity(after);
        if (before.version !== after.version || actual !== hash)
          throw new Error('DAILY_FILE_CONFLICT');
      }
      await this.guard();
      await this.db
        .prepare(
          "UPDATE daily_drive_files SET state='VERIFIED',content_hash=?,verified_hash=?,remote_version=?,verified_at=?,attempt_count=0,reason=NULL,due_at=?,updated_at=? WHERE owner_id=? AND object_key=? AND reserved_file_id=?",
        )
        .bind(
          hash,
          hash,
          after.version!,
          at,
          at,
          at,
          this.context.ownerId,
          input.key,
          row.reserved_file_id,
        )
        .run();
      return (await this.read(input.key))!;
    } catch (error) {
      if (error instanceof DriveBudgetWait) throw error;
      await this.guard();
      const retry =
        error instanceof DriveFailure &&
        ['TRANSIENT', 'TRANSPORT', 'QUOTA'].includes(error.category);
      const attempts = row.attempt_count + 1,
        state = retry && attempts < 8 ? 'RETRY_WAIT' : 'CONFLICT';
      const seconds = Math.min(
        3600,
        Math.max(
          30 * 2 ** Math.min(attempts - 1, 7),
          error instanceof DriveFailure ? (error.retry_after_seconds ?? 0) : 0,
        ),
      );
      const reason =
        error instanceof DriveFailure ? error.message : 'DAILY_FILE_CONFLICT';
      await this.db
        .prepare(
          'UPDATE daily_drive_files SET state=?,reason=?,due_at=?,updated_at=? WHERE owner_id=? AND object_key=?',
        )
        .bind(
          state,
          reason,
          new Date(now.getTime() + seconds * 1000).toISOString(),
          at,
          this.context.ownerId,
          input.key,
        )
        .run();
      throw error;
    }
  }
}
