import { sha256 } from '../auth/crypto.js';
import { DriveClient, DriveFailure, requireDriveId } from '../drive/client.js';

/** A separately approved editorial document, not a model qualification or a
 * promotion of the immutable QUALITY_TEST run. Caller persists its reserved ID
 * and the create intent before invoking the remote write. Existing Daily day
 * reports are never replaced by this exception path. */
export async function publishReviewedMarkdown(
  client: DriveClient,
  input: {
    file_id: string;
    root_id: string;
    name: string;
    markdown: string;
    content_hash: string;
    revision_hash: string;
    decision_reference: string;
    create_attempted: boolean;
    before_create: () => Promise<void>;
  },
) {
  requireDriveId(input.file_id);
  requireDriveId(input.root_id);
  if (
    !/^[a-f0-9]{64}$/.test(input.revision_hash) ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(input.decision_reference) ||
    (await sha256(input.markdown)) !== input.content_hash
  )
    throw new Error('OWNER_PUBLICATION_PIN_MISMATCH');
  await client.verifyPrivateFolder(input.root_id);
  let created = false;
  try {
    await client.getFile(input.file_id);
  } catch (error) {
    if (!(error instanceof DriveFailure) || error.category !== 'NOT_FOUND')
      throw error;
    if (input.create_attempted)
      throw new Error('OWNER_PUBLICATION_CREATE_UNRESOLVED');
    await input.before_create();
    try {
      await client.createMarkdown({
        reserved_id: input.file_id,
        root_id: input.root_id,
        name: input.name,
        markdown: input.markdown,
        app_properties: {
          bi_kind: 'owner_reviewed_summary',
          bi_revision: input.revision_hash,
          bi_decision: input.decision_reference,
          bi_content_hash: input.content_hash,
        },
      });
      created = true;
    } catch (error) {
      // A lost success response is recovered by this exact ID and full readback.
      // There is no second POST, random new ID, update or automatic fallback.
      if (!(error instanceof DriveFailure) || error.category !== 'TRANSPORT')
        throw error;
    }
  }
  const before = await client.getFile(input.file_id);
  const markdown = await client.readMarkdown(input.file_id, 2 * 1024 * 1024);
  const after = await client.getFile(input.file_id);
  for (const file of [before, after]) {
    if (
      file.id !== input.file_id ||
      file.name !== input.name ||
      file.mimeType !== 'text/markdown' ||
      file.trashed !== false ||
      !file.parents?.includes(input.root_id) ||
      file.appProperties?.bi_kind !== 'owner_reviewed_summary' ||
      file.appProperties.bi_revision !== input.revision_hash ||
      file.appProperties.bi_decision !== input.decision_reference ||
      file.appProperties.bi_content_hash !== input.content_hash ||
      !file.version
    )
      throw new Error('OWNER_PUBLICATION_CONFLICT');
  }
  if (
    before.version !== after.version ||
    markdown !== input.markdown ||
    (await sha256(markdown)) !== input.content_hash
  )
    throw new Error('OWNER_PUBLICATION_READBACK_MISMATCH');
  await client.verifyPrivateFolder(input.file_id);
  return {
    version: 'owner-reviewed-drive-publication:1' as const,
    state: 'VERIFIED' as const,
    file_id: input.file_id,
    file_version: after.version!,
    root_id: input.root_id,
    content_hash: input.content_hash,
    revision_hash: input.revision_hash,
    decision_reference: input.decision_reference,
    byte_count: new TextEncoder().encode(markdown).length,
    private_owner_only: true,
    created,
    model_qualification: false,
    original_run_promoted: false,
  };
}
