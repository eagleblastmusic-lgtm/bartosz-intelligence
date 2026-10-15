import type { Env } from './env.js';
import { AccessContext } from '../../../packages/core/src/db/boundary.js';
import { sha256 } from '../../../packages/core/src/auth/crypto.js';
import { runDriveExportTick } from '../../../packages/core/src/export/runtime.js';
import { refreshDriveAccess } from '../../../packages/core/src/drive/oauth.js';
import { importDriveWrappingKey } from '../../../packages/core/src/drive/credentials.js';
import { DriveClient } from '../../../packages/core/src/drive/client.js';
import { applicationOrigin } from './auth.js';
import { RetentionCleanup } from '../../../packages/core/src/retention/cleanup.js';
import { TranscriptDriveArchive } from '../../../packages/core/src/transcript/archive.js';
export async function runTranscriptArchiveTick(
  archive: TranscriptDriveArchive,
  input: Parameters<TranscriptDriveArchive['tick']>[0],
  now: Date,
  queue: Pick<Queue, 'send'>,
) {
  const result = await archive.tick(input, now);
  if ('metrics' in result)
    console.log(
      JSON.stringify({
        event: 'TRANSCRIPT_ARCHIVE_VERIFIED',
        item_id: result.item_id,
        ...result.metrics,
      }),
    );
  if (
    !['CONFIGURATION_HOLD', 'QUOTA_WAIT', 'LEASE_BUSY', 'IDLE'].includes(
      result.state,
    ) &&
    (await archive.hasReady(now))
  )
    await queue.send({ kind: 'TRANSCRIPT_ARCHIVE' });
  return result;
}

export async function scheduleTranscriptArchive(environment: Env, now: Date) {
  if (environment.TRANSCRIPT_ARCHIVE_ENABLED !== 'true')
    return { state: 'DISABLED' };
  if (
    !environment.DRIVE_EXPORT_WORKER_CREDENTIAL ||
    !environment.GOOGLE_DRIVE_CLIENT_ID ||
    !environment.GOOGLE_DRIVE_CLIENT_SECRET ||
    !environment.DRIVE_WRAPPING_KEY_ID ||
    !environment.DRIVE_WRAPPING_KEY ||
    environment.DRIVE_KEY_RECOVERY_READY !== 'true'
  )
    return { state: 'CONFIGURATION_HOLD' };
  const context = await AccessContext.worker(
    environment.DB,
    await sha256(environment.DRIVE_EXPORT_WORKER_CREDENTIAL),
  );
  const wrapping = await importDriveWrappingKey(
    environment.DRIVE_WRAPPING_KEY_ID,
    environment.DRIVE_WRAPPING_KEY,
  );
  const archive = new TranscriptDriveArchive(environment.DB, context);
  const result = await runTranscriptArchiveTick(
    archive,
    {
      client: async (connectionId) => {
        const grant = await refreshDriveAccess(
          environment.DB,
          context,
          {
            client_id: environment.GOOGLE_DRIVE_CLIENT_ID!,
            client_secret: environment.GOOGLE_DRIVE_CLIENT_SECRET!,
            app_origin: applicationOrigin(environment),
          },
          wrapping,
          connectionId,
          now,
        );
        return new DriveClient(grant.access_token);
      },
    },
    now,
    environment.BARTOSZ_QUEUE,
  );
  return result;
}

export async function scheduleRetentionCleanup(environment: Env, now: Date) {
  // The broad legacy cleanup is never enabled by a previous DB approval alone.
  if (environment.RETENTION_DELETION_ENABLED !== 'true')
    return { state: 'DELETION_DISABLED' };
  const approved = await environment.DB.prepare(
    'SELECT owner_id FROM retention_settings WHERE deletion_enabled=1 AND approval_reference IS NOT NULL LIMIT 1',
  ).first<{ owner_id: string }>();
  if (!approved) return { state: 'OBSERVATION_ONLY_OR_NOT_DUE' };
  const due = await environment.DB.prepare(
    "SELECT t.owner_id,t.item_id,c.connection_id FROM retention_items t JOIN drive_connections c ON c.owner_id=t.owner_id AND c.root_id=t.root_id WHERE t.owner_id=? AND t.phase!='COMPLETE' AND t.purge_after<=? AND t.hold_reason IS NULL ORDER BY t.updated_at,t.item_id LIMIT 1",
  )
    .bind(approved.owner_id, now.toISOString())
    .first<{ owner_id: string; item_id: string; connection_id: string }>();
  if (!due) return { state: 'OBSERVATION_ONLY_OR_NOT_DUE' };
  if (
    !environment.DRIVE_EXPORT_WORKER_CREDENTIAL ||
    !environment.GOOGLE_DRIVE_CLIENT_ID ||
    !environment.GOOGLE_DRIVE_CLIENT_SECRET ||
    !environment.DRIVE_WRAPPING_KEY_ID ||
    !environment.DRIVE_WRAPPING_KEY ||
    environment.DRIVE_KEY_RECOVERY_READY !== 'true'
  )
    return { state: 'DRIVE_CONFIGURATION_HOLD' };
  const context = await AccessContext.worker(
    environment.DB,
    await sha256(environment.DRIVE_EXPORT_WORKER_CREDENTIAL),
  );
  context.requireTask('DRIVE_EXPORT');
  if (context.ownerId !== due.owner_id) throw new Error('FORBIDDEN');
  const wrapping = await importDriveWrappingKey(
    environment.DRIVE_WRAPPING_KEY_ID,
    environment.DRIVE_WRAPPING_KEY,
  );
  const grant = await refreshDriveAccess(
    environment.DB,
    context,
    {
      client_id: environment.GOOGLE_DRIVE_CLIENT_ID,
      client_secret: environment.GOOGLE_DRIVE_CLIENT_SECRET,
      app_origin: applicationOrigin(environment),
    },
    wrapping,
    due.connection_id,
    now,
  );
  const cleanup = new RetentionCleanup(environment.DB, context),
    client = new DriveClient(grant.access_token);
  const receipts = [];
  // At most four atomic pages per tick; each page is independently fenced and
  // limited to 25 rows. This drains observed and peak working sets.
  for (let page = 0; page < 4; page++) {
    const result = await cleanup.step(due.item_id, client, now);
    receipts.push(result);
    if (
      result.state === 'HELD' ||
      ('checkpoint' in result && result.checkpoint?.phase === 'COMPLETE')
    )
      break;
  }
  const receipt = { state: 'BOUNDED_BATCH', pages: receipts };
  await environment.DB.prepare(
    'UPDATE retention_settings SET last_receipt_json=? WHERE owner_id=?',
  )
    .bind(
      JSON.stringify({ observed_at: now.toISOString(), ...receipt }),
      due.owner_id,
    )
    .run();
  return receipt;
}

export async function scheduleDriveExport(environment: Env, now: Date) {
  if (environment.DRIVE_EXPORT_ENABLED !== 'true')
    return { state: 'DISABLED' as const };
  if (
    !environment.DRIVE_EXPORT_WORKER_CREDENTIAL ||
    !environment.GOOGLE_DRIVE_CLIENT_ID ||
    !environment.GOOGLE_DRIVE_CLIENT_SECRET ||
    !environment.DRIVE_WRAPPING_KEY_ID ||
    !environment.DRIVE_WRAPPING_KEY ||
    environment.DRIVE_KEY_RECOVERY_READY !== 'true' ||
    !environment.SESSION_SIGNING_SECRET
  )
    throw new Error('DRIVE_EXPORT_CONFIGURATION_REQUIRED');
  const context = await AccessContext.worker(
    environment.DB,
    await sha256(environment.DRIVE_EXPORT_WORKER_CREDENTIAL),
  );
  context.requireTask('DRIVE_EXPORT');
  const wrapping = await importDriveWrappingKey(
    environment.DRIVE_WRAPPING_KEY_ID,
    environment.DRIVE_WRAPPING_KEY,
  );
  return runDriveExportTick(
    environment.DB,
    context,
    {
      app_origin: applicationOrigin(environment),
      cursor_secret: environment.SESSION_SIGNING_SECRET,
      client: async (connectionId) => {
        const grant = await refreshDriveAccess(
          environment.DB,
          context,
          {
            client_id: environment.GOOGLE_DRIVE_CLIENT_ID!,
            client_secret: environment.GOOGLE_DRIVE_CLIENT_SECRET!,
            app_origin: applicationOrigin(environment),
          },
          wrapping,
          connectionId,
          now,
        );
        return new DriveClient(grant.access_token);
      },
    },
    now,
  );
}
