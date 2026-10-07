import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
import { DriveClient, DriveFailure, requireDriveId } from './client.js';

export interface DriveRootPreview {
  version: 'drive-root-preview:1';
  connection_id: string;
  connection_revision: number;
  current_root_id: string | null;
  requested_root_id: string;
  folder_name: string;
  root_changed: boolean;
  existing_mapping_count: number;
  mapping_action: 'PRESERVE_EXISTING';
  duplicate_risk: 'ROOT_CHANGE_REQUIRES_MAPPING_REVIEW' | 'UNCHANGED';
  folder_metadata_access: 'PASS';
  private_owner_only: true;
  child_create_read_update: 'NOT_RUN';
  export_ready: false;
  storage: { limit_bytes: string | null; usage_bytes: string | null };
  sampled_at: string;
  expires_at: string;
  preview_hash: string;
}

/** Metadata and impact preview only. A canAddChildren flag does not qualify
 * actual child create/read/update or atomic remote update semantics. */
export async function previewDriveRoot(
  db: Database,
  context: AccessContext,
  client: DriveClient,
  input: { connection_id: string; root_id: string; expected_revision: number },
  now: Date,
): Promise<DriveRootPreview> {
  assertContext(context);
  context.requireOwner();
  requireDriveId(input.root_id);
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.connection_id) ||
    !Number.isSafeInteger(input.expected_revision) ||
    input.expected_revision < 1 ||
    !Number.isFinite(now.getTime())
  )
    throw new Error('INVALID_DRIVE_ROOT_PREVIEW');
  const row = await db
    .prepare(
      `SELECT revision,root_id,auth_state FROM drive_connections WHERE owner_id=? AND connection_id=?`,
    )
    .bind(context.ownerId, input.connection_id)
    .first<{ revision: number; root_id: string | null; auth_state: string }>();
  if (!row) throw new Error('NOT_FOUND');
  if (row.revision !== input.expected_revision)
    throw new Error('REVISION_CONFLICT');
  if (row.auth_state !== 'CONNECTED') throw new DriveFailure('AUTH');
  const folder = await client.getFile(input.root_id);
  if (
    folder.mimeType !== 'application/vnd.google-apps.folder' ||
    folder.trashed !== false ||
    folder.capabilities?.canAddChildren !== true
  )
    throw new DriveFailure('DENIED');
  await client.verifyPrivateFolder(input.root_id);
  const storage = await client.storage();
  if (
    storage.limit_bytes !== null &&
    storage.usage_bytes !== null &&
    BigInt(storage.usage_bytes) >= BigInt(storage.limit_bytes)
  )
    throw new DriveFailure('QUOTA');
  const count = await db
    .prepare(
      'SELECT COUNT(*) n FROM export_state WHERE owner_id=? AND root_namespace=?',
    )
    .bind(context.ownerId, row.root_id ?? '')
    .first<number>('n');
  const final = await db
    .prepare(
      'SELECT revision FROM drive_connections WHERE owner_id=? AND connection_id=?',
    )
    .bind(context.ownerId, input.connection_id)
    .first<number>('revision');
  if (final !== row.revision) throw new Error('REVISION_CONFLICT');
  const changed = row.root_id !== null && row.root_id !== input.root_id;
  const preview = {
    version: 'drive-root-preview:1' as const,
    connection_id: input.connection_id,
    connection_revision: row.revision,
    current_root_id: row.root_id,
    requested_root_id: input.root_id,
    folder_name: folder.name,
    root_changed: changed,
    existing_mapping_count: Number(count ?? 0),
    mapping_action: 'PRESERVE_EXISTING' as const,
    duplicate_risk: changed
      ? ('ROOT_CHANGE_REQUIRES_MAPPING_REVIEW' as const)
      : ('UNCHANGED' as const),
    folder_metadata_access: 'PASS' as const,
    private_owner_only: true as const,
    child_create_read_update: 'NOT_RUN' as const,
    export_ready: false as const,
    storage,
    sampled_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 600000).toISOString(),
  };
  return {
    ...preview,
    preview_hash: await sha256(
      JSON.stringify({ owner_id: context.ownerId, ...preview }),
    ),
  };
}
