import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
import { DriveClient, DriveFailure, type DriveFile } from './client.js';
import { previewDriveRoot } from './root.js';

// Explicit owner action only. An app-created private folder is accessible with
// drive.file and avoids asking for a broader scope merely to browse all Drive.
export async function createDriveRootCandidate(
  db: Database,
  context: AccessContext,
  client: DriveClient,
  input: { connection_id: string; name: string; expected_revision: number },
  now: Date,
) {
  assertContext(context);
  context.requireOwner();
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.connection_id) ||
    input.name !== input.name.trim() ||
    !input.name ||
    /[\u0000-\u001f\u007f]/.test(input.name) ||
    new TextEncoder().encode(input.name).length > 256 ||
    !Number.isSafeInteger(input.expected_revision) ||
    input.expected_revision < 1 ||
    !Number.isFinite(now.getTime())
  )
    throw new Error('INVALID_DRIVE_ROOT_CANDIDATE');
  const binding = [context.ownerId, input.connection_id];
  const revision = await db
    .prepare(
      "SELECT revision FROM drive_connections WHERE owner_id=? AND connection_id=? AND auth_state='CONNECTED'",
    )
    .bind(...binding)
    .first<number>('revision');
  if (revision === null) throw new Error('NOT_FOUND');
  if (revision !== input.expected_revision)
    throw new Error('REVISION_CONFLICT');
  const find = () =>
    db
      .prepare(
        'SELECT reserved_folder_id,state FROM drive_root_candidates WHERE owner_id=? AND connection_id=? AND candidate_name=?',
      )
      .bind(...binding, input.name)
      .first<{ reserved_folder_id: string; state: string }>();
  let candidate = await find();
  let id = candidate?.reserved_folder_id;
  if (!id) {
    const reserved = await client.reserveId();
    await db
      .prepare(
        `INSERT INTO drive_root_candidates(owner_id,connection_id,candidate_name,reserved_folder_id,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM drive_connections WHERE owner_id=? AND connection_id=? AND revision=? AND auth_state='CONNECTED') ON CONFLICT(owner_id,connection_id,candidate_name) DO NOTHING`,
      )
      .bind(
        ...binding,
        input.name,
        reserved,
        now.toISOString(),
        ...binding,
        input.expected_revision,
      )
      .run();
    candidate = await find();
    id = candidate?.reserved_folder_id;
    if (!id) throw new Error('REVISION_CONFLICT');
  }
  const properties = {
    bi_owner: await sha256(context.ownerId),
    bi_root_candidate: await sha256(JSON.stringify([...binding, input.name])),
  };
  let file: DriveFile;
  try {
    file = await client.getFile(id);
  } catch (error) {
    if (!(error instanceof DriveFailure) || error.category !== 'NOT_FOUND')
      throw error;
    if (candidate?.state === 'CREATED')
      throw new Error('DRIVE_ROOT_IDENTITY_CONFLICT');
    const current = await db
      .prepare(
        "SELECT revision FROM drive_connections WHERE owner_id=? AND connection_id=? AND auth_state='CONNECTED'",
      )
      .bind(...binding)
      .first<number>('revision');
    if (current !== input.expected_revision)
      throw new Error('REVISION_CONFLICT');
    try {
      file = await client.createFolder({
        reserved_id: id,
        name: input.name,
        app_properties: properties,
      });
    } catch (error) {
      if (
        !(error instanceof DriveFailure) ||
        !['TRANSIENT', 'TRANSPORT', 'CONFLICT'].includes(error.category)
      )
        throw error;
      try {
        file = await client.getFile(id);
      } catch {
        throw new Error('DRIVE_ROOT_CREATE_AMBIGUOUS');
      }
    }
  }
  if (
    file.mimeType !== 'application/vnd.google-apps.folder' ||
    file.trashed !== false ||
    Object.entries(properties).some(
      ([key, value]) => file.appProperties?.[key] !== value,
    )
  )
    throw new Error('DRIVE_ROOT_IDENTITY_CONFLICT');
  await client.verifyPrivateFolder(id);
  const preview = await previewDriveRoot(
    db,
    context,
    client,
    {
      connection_id: input.connection_id,
      root_id: id,
      expected_revision: input.expected_revision,
    },
    now,
  );
  await db
    .prepare(
      "UPDATE drive_root_candidates SET state='CREATED' WHERE owner_id=? AND connection_id=? AND candidate_name=? AND reserved_folder_id=?",
    )
    .bind(...binding, input.name, id)
    .run();
  // Creating the candidate is not selecting/qualifying the connection root.
  return {
    ...preview,
    private_owner_only: true as const,
    created_candidate: true as const,
  };
}
