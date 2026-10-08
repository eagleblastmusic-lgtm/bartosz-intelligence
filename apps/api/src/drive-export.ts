import type { Env } from './env.js';
import { AccessContext } from '../../../packages/core/src/db/boundary.js';
import { sha256 } from '../../../packages/core/src/auth/crypto.js';
import { runDriveExportTick } from '../../../packages/core/src/export/runtime.js';
import { refreshDriveAccess } from '../../../packages/core/src/drive/oauth.js';
import { importDriveWrappingKey } from '../../../packages/core/src/drive/credentials.js';
import { DriveClient } from '../../../packages/core/src/drive/client.js';
import { applicationOrigin } from './auth.js';

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
