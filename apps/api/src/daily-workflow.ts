import type { Env } from './env.js';
import type { AccessContext } from '../../../packages/core/src/db/boundary.js';
import { AccessContext as Context } from '../../../packages/core/src/db/boundary.js';
import { sha256 } from '../../../packages/core/src/auth/crypto.js';
import { importDriveWrappingKey } from '../../../packages/core/src/drive/credentials.js';
import { refreshDriveAccess } from '../../../packages/core/src/drive/oauth.js';
import { DriveClient } from '../../../packages/core/src/drive/client.js';
import { DailyTasksWorkflow } from '../../../packages/core/src/daily/workflow.js';
import { applicationOrigin } from './auth.js';
export async function dailyDriveClient(
  environment: Env,
  access: AccessContext,
  connectionId: string,
  now: Date,
) {
  if (
    !environment.GOOGLE_DRIVE_CLIENT_ID ||
    !environment.GOOGLE_DRIVE_CLIENT_SECRET ||
    !environment.DRIVE_WRAPPING_KEY_ID ||
    !environment.DRIVE_WRAPPING_KEY ||
    environment.DRIVE_KEY_RECOVERY_READY !== 'true'
  )
    throw new Error('DRIVE_CONFIGURATION_REQUIRED');
  const wrapping = await importDriveWrappingKey(
    environment.DRIVE_WRAPPING_KEY_ID,
    environment.DRIVE_WRAPPING_KEY,
  );
  const grant = await refreshDriveAccess(
    environment.DB,
    access,
    {
      client_id: environment.GOOGLE_DRIVE_CLIENT_ID,
      client_secret: environment.GOOGLE_DRIVE_CLIENT_SECRET,
      app_origin: applicationOrigin(environment),
    },
    wrapping,
    connectionId,
    now,
  );
  return new DriveClient(grant.access_token, fetch, 35);
}
export async function scheduleDailyReports(environment: Env, now: Date) {
  if (environment.DAILY_REPORTS_ENABLED !== 'true')
    return { state: 'DISABLED' };
  if (!environment.DRIVE_EXPORT_WORKER_CREDENTIAL)
    return { state: 'CONFIGURATION_HOLD' };
  const access = await Context.worker(
    environment.DB,
    await sha256(environment.DRIVE_EXPORT_WORKER_CREDENTIAL),
  );
  const workflow = new DailyTasksWorkflow(environment.DB, access),
    settings = await workflow.settings();
  if (!settings?.enabled) return { state: 'DISABLED' };
  return workflow.tick(
    await dailyDriveClient(environment, access, settings.connection_id, now),
    now,
  );
}
