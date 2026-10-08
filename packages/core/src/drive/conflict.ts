import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
import { requireLocalDate } from '../projections/dates.js';
import {
  DriveClient,
  DriveFailure,
  requireDriveId,
  type DriveFile,
} from './client.js';
import { DriveExportIdentity } from './identity.js';

export interface DriveConflictPreview {
  version: 'drive-conflict-preview:1';
  connection_id: string;
  connection_revision: number;
  root_id: string;
  date: string;
  file_id: string;
  artifact_id: string | null;
  settings_revision: number;
  fencing_token: number;
  remote_version: string;
  remote_hash: string;
  remote_bytes: number;
  action: 'KEEP_MANUAL';
  sampled_at: string;
  expires_at: string;
  preview_hash: string;
}

export async function previewDriveConflict(
  db: Database,
  context: AccessContext,
  client: DriveClient,
  input: {
    connection_id: string;
    connection_revision: number;
    root_id: string;
    date: string;
    expected_settings_revision: number;
  },
  now: Date,
): Promise<DriveConflictPreview> {
  assertContext(context);
  context.requireOwner();
  requireDriveId(input.root_id);
  requireLocalDate(input.date);
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isSafeInteger(input.expected_settings_revision) ||
    input.expected_settings_revision < 1
  )
    throw new Error('INVALID_EXPORT_SETTINGS');
  const state = await db
    .prepare(
      `SELECT e.settings_revision,e.fencing_token,COALESCE(e.file_id,e.reserved_remote_id) file_id,e.rendered_artifact_id artifact_id FROM export_state e JOIN drive_connections c USING(owner_id,connection_id) WHERE e.owner_id=? AND e.connection_id=? AND e.root_namespace=? AND e.publication_date=? AND e.destination_key GLOB 'drive:*' AND c.auth_state='CONNECTED' AND c.root_state='VERIFIED' AND c.root_id=e.root_namespace AND c.revision=? AND (e.paused_reason IN ('EXPORT_CONFLICT','DRIVE_CONFLICT') OR EXISTS(SELECT 1 FROM drive_export_attempts p WHERE p.owner_id=e.owner_id AND p.artifact_id=e.rendered_artifact_id AND p.state='CONFLICT'))`,
    )
    .bind(
      context.ownerId,
      input.connection_id,
      input.root_id,
      input.date,
      input.connection_revision,
    )
    .first<{
      settings_revision: number;
      fencing_token: number;
      file_id: string | null;
      artifact_id: string | null;
    }>();
  if (!state || !state.file_id) throw new Error('NOT_FOUND');
  if (state.settings_revision !== input.expected_settings_revision)
    throw new Error('REVISION_CONFLICT');
  const properties = await new DriveExportIdentity(db, context).appProperties(
    input.root_id,
    input.date,
  );
  const check = (file: DriveFile) => {
    if (
      file.id !== state.file_id ||
      file.mimeType !== 'text/markdown' ||
      file.trashed !== false ||
      !file.parents?.includes(input.root_id) ||
      !file.version ||
      Object.entries(properties).some(
        ([key, value]) => file.appProperties?.[key] !== value,
      )
    )
      throw new DriveFailure('CONFLICT');
  };
  await client.verifyPrivateFolder(input.root_id);
  const before = await client.getFile(state.file_id);
  check(before);
  const markdown = await client.readMarkdown(state.file_id, 8 * 1024 * 1024);
  const after = await client.getFile(state.file_id);
  check(after);
  if (after.version !== before.version) throw new Error('REVISION_CONFLICT');
  const preview = {
    version: 'drive-conflict-preview:1' as const,
    connection_id: input.connection_id,
    connection_revision: input.connection_revision,
    root_id: input.root_id,
    date: input.date,
    file_id: state.file_id,
    artifact_id: state.artifact_id,
    settings_revision: state.settings_revision,
    fencing_token: state.fencing_token,
    remote_version: after.version!,
    remote_hash: await sha256(markdown),
    remote_bytes: new TextEncoder().encode(markdown).length,
    action: 'KEEP_MANUAL' as const,
    sampled_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 600000).toISOString(),
  };
  const result = {
    ...preview,
    preview_hash: await sha256(
      JSON.stringify({ owner_id: context.ownerId, ...preview }),
    ),
  };
  const payload = JSON.stringify(result);
  await db
    .prepare(
      'INSERT INTO config_versions VALUES(?,?,1,?,?,?) ON CONFLICT(owner_id,config_id,revision) DO NOTHING',
    )
    .bind(
      'drive-conflict-preview:' + result.preview_hash,
      context.ownerId,
      payload,
      await sha256(payload),
      now.toISOString(),
    )
    .run();
  return result;
}

export async function preserveManualDriveConflict(
  db: Database,
  context: AccessContext,
  client: DriveClient,
  input: {
    connection_id: string;
    connection_revision: number;
    preview_hash: string;
    action: 'KEEP_MANUAL';
  },
  now: Date,
) {
  assertContext(context);
  context.requireOwner();
  if (
    input.action !== 'KEEP_MANUAL' ||
    !/^[a-f0-9]{64}$/.test(input.preview_hash) ||
    !Number.isFinite(now.getTime())
  )
    throw new Error('INVALID_EXPORT_SETTINGS');
  const saved = await db
    .prepare(
      'SELECT payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
    )
    .bind(context.ownerId, 'drive-conflict-preview:' + input.preview_hash)
    .first<{ payload_json: string; content_hash: string }>();
  if (!saved || (await sha256(saved.payload_json)) !== saved.content_hash)
    throw new Error('INVALID_EXPORT_SETTINGS');
  const preview: DriveConflictPreview = JSON.parse(saved.payload_json);
  if (
    preview.connection_id !== input.connection_id ||
    preview.preview_hash !== input.preview_hash ||
    preview.connection_revision !== input.connection_revision - 1 ||
    Date.parse(preview.expires_at) <= now.getTime() ||
    Date.parse(preview.sampled_at) > now.getTime()
  )
    throw new Error('REVISION_CONFLICT');
  const fresh = await previewDriveConflict(
    db,
    context,
    client,
    {
      connection_id: input.connection_id,
      connection_revision: input.connection_revision,
      root_id: preview.root_id,
      date: preview.date,
      expected_settings_revision: preview.settings_revision,
    },
    now,
  ).catch((error) => {
    if (error instanceof Error && error.message === 'NOT_FOUND')
      throw new Error('REVISION_CONFLICT');
    throw error;
  });
  if (
    fresh.file_id !== preview.file_id ||
    fresh.artifact_id !== preview.artifact_id ||
    fresh.fencing_token !== preview.fencing_token ||
    fresh.remote_version !== preview.remote_version ||
    fresh.remote_hash !== preview.remote_hash
  )
    throw new Error('REVISION_CONFLICT');
  const result = await db
    .prepare(
      `UPDATE export_state SET paused_reason='OWNER_PRESERVED_MANUAL',last_failure_code=NULL,next_retry_at=NULL,lease_owner=NULL,lease_until=NULL,fencing_token=fencing_token+1,settings_revision=settings_revision+1 WHERE owner_id=? AND connection_id=? AND root_namespace=? AND publication_date=? AND destination_key GLOB 'drive:*' AND settings_revision=? AND fencing_token=? AND COALESCE(file_id,reserved_remote_id)=? AND rendered_artifact_id IS ? AND EXISTS(SELECT 1 FROM drive_connections c WHERE c.owner_id=export_state.owner_id AND c.connection_id=export_state.connection_id AND c.root_id=export_state.root_namespace AND c.auth_state='CONNECTED' AND c.root_state='VERIFIED' AND c.revision=?)`,
    )
    .bind(
      context.ownerId,
      input.connection_id,
      preview.root_id,
      preview.date,
      preview.settings_revision,
      preview.fencing_token,
      preview.file_id,
      preview.artifact_id,
      input.connection_revision,
    )
    .run();
  if (result.meta.changes !== 1) throw new Error('REVISION_CONFLICT');
  return {
    action: 'KEEP_MANUAL' as const,
    file_id: preview.file_id,
    paused_reason: 'OWNER_PRESERVED_MANUAL' as const,
    settings_revision: preview.settings_revision + 1,
    remote_write_performed: false as const,
  };
}
