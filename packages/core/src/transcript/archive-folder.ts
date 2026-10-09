import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { DriveClient, DriveFailure } from '../drive/client.js';
import { sha256 } from '../auth/crypto.js';

/** Explicit owner-approved setup only. Persist the reserved folder ID before
 * creating, never select it as Daily root and never change an existing ACL. */
export async function provisionTranscriptFolder(
  db: Database,
  context: AccessContext,
  client: DriveClient,
  input: { connection_id: string; parent_id: string },
  now: Date,
) {
  assertContext(context);
  context.requireOwnerOrTask('DRIVE_EXPORT');
  const parent = await client.getFile(input.parent_id);
  if (
    parent.mimeType !== 'application/vnd.google-apps.folder' ||
    parent.trashed !== false
  )
    throw new Error('TRANSCRIPT_PARENT_CONFLICT');
  // Parent sharing is left intact. The newly created child disables inheritance
  // and must independently pass effective owner-only permission verification.
  const connection = await db
    .prepare(
      "SELECT 1 FROM drive_connections WHERE owner_id=? AND connection_id=? AND auth_state='CONNECTED'",
    )
    .bind(context.ownerId, input.connection_id)
    .first();
  if (!connection) throw new Error('TRANSCRIPT_CONNECTION_REQUIRED');
  let row = await db
    .prepare(
      'SELECT connection_id,parent_id,folder_id,private_verified_at FROM transcript_archive_folders WHERE owner_id=?',
    )
    .bind(context.ownerId)
    .first<{
      connection_id: string;
      parent_id: string;
      folder_id: string;
      private_verified_at: string | null;
    }>();
  if (
    row &&
    (row.parent_id !== input.parent_id ||
      row.connection_id !== input.connection_id)
  )
    throw new Error('TRANSCRIPT_FOLDER_MAPPING_CONFLICT');
  const properties = {
    bi_owner: await sha256(context.ownerId),
    bi_archive: 'transcripts_v1',
  };
  if (!row) {
    const matches = await client.findChildFolders(
      input.parent_id,
      'Transkrypcje',
    );
    if (matches.length > 1) throw new Error('TRANSCRIPT_FOLDER_AMBIGUOUS');
    const id = matches[0]?.id ?? (await client.reserveId());
    // An existing matching folder is accepted only when it has the application's
    // exact private identity; arbitrary same-name folders require review.
    if (
      matches[0] &&
      Object.entries(properties).some(
        ([key, value]) => matches[0]!.appProperties?.[key] !== value,
      )
    )
      throw new Error('TRANSCRIPT_FOLDER_MAPPING_CONFLICT');
    await db
      .prepare(
        `INSERT INTO transcript_archive_folders(owner_id,connection_id,parent_id,folder_id) VALUES(?,?,?,?) ON CONFLICT(owner_id) DO NOTHING`,
      )
      .bind(context.ownerId, input.connection_id, input.parent_id, id)
      .run();
    row = await db
      .prepare(
        'SELECT connection_id,parent_id,folder_id,private_verified_at FROM transcript_archive_folders WHERE owner_id=?',
      )
      .bind(context.ownerId)
      .first();
  }
  if (
    !row ||
    row.parent_id !== input.parent_id ||
    row.connection_id !== input.connection_id
  )
    throw new Error('TRANSCRIPT_FOLDER_MAPPING_CONFLICT');
  let file;
  try {
    file = await client.getFile(row.folder_id);
  } catch (error) {
    if (!(error instanceof DriveFailure) || error.category !== 'NOT_FOUND')
      throw error;
    if (row.private_verified_at)
      throw new Error('TRANSCRIPT_FOLDER_MAPPING_CONFLICT');
    try {
      file = await client.createFolder({
        reserved_id: row.folder_id,
        name: 'Transkrypcje',
        parent_id: input.parent_id,
        limited_access: true,
        app_properties: properties,
      });
    } catch (error) {
      if (
        !(error instanceof DriveFailure) ||
        !['TRANSIENT', 'TRANSPORT', 'CONFLICT'].includes(error.category)
      )
        throw error;
      file = await client.getFile(row.folder_id);
    }
  }
  if (
    file.id !== row.folder_id ||
    file.name !== 'Transkrypcje' ||
    file.mimeType !== 'application/vnd.google-apps.folder' ||
    file.inheritedPermissionsDisabled !== true ||
    file.trashed !== false ||
    !file.parents?.includes(input.parent_id) ||
    Object.entries(properties).some(
      ([key, value]) => file.appProperties?.[key] !== value,
    )
  )
    throw new Error('TRANSCRIPT_FOLDER_MAPPING_CONFLICT');
  await client.verifyPrivateFolder(row.folder_id);
  await db
    .prepare(
      'UPDATE transcript_archive_folders SET private_verified_at=? WHERE owner_id=? AND folder_id=? AND parent_id=?',
    )
    .bind(now.toISOString(), context.ownerId, row.folder_id, input.parent_id)
    .run();
  return {
    folder_id: row.folder_id,
    parent_id: input.parent_id,
    name: 'Transkrypcje',
    private_owner_only: true,
  };
}
