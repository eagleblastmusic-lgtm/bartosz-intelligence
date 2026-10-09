import {
  DriveClient,
  DriveFailure,
} from '../../packages/core/src/drive/client.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';

// The transport fault is injected only after an actual successful create.
// Recovery uses a separate client and the already persisted reserved identity.
export async function verifyReservedCreateRecovery(
  accessToken: string,
  scope: { reserved_id: string; root_id: string; trial_id: string },
  transport: typeof fetch = fetch,
) {
  const markdown =
    '# Bartosz Intelligence recovery verification\n\n' + scope.trial_id + '\n';
  const properties = { bi_recovery_trial: scope.trial_id };
  let creates = 0,
    responseLost = false,
    transportClassified = false;
  const client = new DriveClient(accessToken, async (url, options) => {
    if (options?.method !== 'POST')
      throw new Error('CREATE_PROBE_UNEXPECTED_HTTP');
    if (++creates !== 1) throw new Error('CREATE_PROBE_DUPLICATE_ATTEMPT');
    const response = await transport(url, options);
    if (!response.ok) return response;
    await response.body?.cancel();
    responseLost = true;
    throw new Error('INJECTED_LOST_CREATE_RESPONSE');
  });
  try {
    await client.createMarkdown({
      ...scope,
      name: 'BI recovery verification ' + scope.trial_id + '.md',
      markdown,
      app_properties: properties,
    });
  } catch (error) {
    if (
      !(error instanceof DriveFailure) ||
      error.category !== 'TRANSPORT' ||
      !responseLost
    )
      throw error;
    transportClassified = true;
  }
  if (!transportClassified)
    throw new Error('CREATE_PROBE_INJECTION_NOT_OBSERVED');
  const independent = new DriveClient(accessToken, transport);
  const metadata = await independent.getFile(scope.reserved_id);
  const readback = await independent.readMarkdown(scope.reserved_id, 4096);
  const expectedHash = await sha256(markdown),
    actualHash = await sha256(readback);
  if (
    creates !== 1 ||
    metadata.id !== scope.reserved_id ||
    metadata.mimeType !== 'text/markdown' ||
    metadata.trashed !== false ||
    !metadata.parents?.includes(scope.root_id) ||
    metadata.appProperties?.bi_recovery_trial !== scope.trial_id ||
    !metadata.version ||
    expectedHash !== actualHash
  )
    throw new Error('CREATE_PROBE_RECOVERY_MISMATCH');
  return {
    file_id: metadata.id,
    root_id: scope.root_id,
    create_attempts: creates,
    response_loss_injected_after_success: responseLost,
    transport_classified: transportClassified,
    independent_readback_sha256: actualHash,
    expected_sha256: expectedHash,
    bytes: new TextEncoder().encode(readback).length,
    same_reserved_identity: true,
    second_create_performed: false,
    existing_daily_files_modified: false,
  };
}
