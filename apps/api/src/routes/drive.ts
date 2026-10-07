import { ownerRouter, body, queryFields, text } from './common.js';
import { applicationOrigin, cookieValue } from '../auth.js';
import type { Env } from '../env.js';
import type { DriveStatus } from '../../../../packages/contracts/src/drive.js';
import {
  beginDriveAuthorization,
  finishDriveAuthorization,
  DriveOAuthFailure,
  refreshDriveAccess,
} from '../../../../packages/core/src/drive/oauth.js';
import { importDriveWrappingKey } from '../../../../packages/core/src/drive/credentials.js';
import {
  DriveClient,
  DriveFailure,
} from '../../../../packages/core/src/drive/client.js';
import { previewDriveRoot } from '../../../../packages/core/src/drive/root.js';

export const driveApp = ownerRouter();
driveApp.post('/root/preview', async (c) => {
  const input = await body(c, [
    'connection_id',
    'root_id',
    'expected_revision',
  ]);
  const connectionId = text(input.connection_id, 128),
    rootId = text(input.root_id, 200);
  if (
    !Number.isSafeInteger(input.expected_revision) ||
    Number(input.expected_revision) < 1
  )
    throw new Error('INVALID_DRIVE_ROOT_PREVIEW');
  const access = c.get('access');
  const revision = await c.env.DB.prepare(
    'SELECT revision FROM drive_connections WHERE owner_id=? AND connection_id=?',
  )
    .bind(access.ownerId, connectionId)
    .first<number>('revision');
  if (revision === null) throw new Error('NOT_FOUND');
  if (revision !== input.expected_revision)
    throw new Error('REVISION_CONFLICT');
  const { config, wrapping } = await configuration(c.env);
  const now = new Date();
  const grant = await refreshDriveAccess(
    c.env.DB,
    access,
    config,
    wrapping,
    connectionId,
    now,
  );
  const renewedRevision = await c.env.DB.prepare(
    'SELECT revision FROM drive_connections WHERE owner_id=? AND connection_id=?',
  )
    .bind(access.ownerId, connectionId)
    .first<number>('revision');
  // Renewal advances exactly one revision. Another owner action invalidates
  // this preview rather than silently inspecting the changed connection.
  if (renewedRevision !== revision + 1) throw new Error('REVISION_CONFLICT');
  try {
    return c.json(
      await previewDriveRoot(
        c.env.DB,
        access,
        new DriveClient(grant.access_token),
        {
          connection_id: connectionId,
          root_id: rootId,
          expected_revision: renewedRevision,
        },
        now,
      ),
    );
  } catch (error) {
    if (error instanceof DriveFailure)
      throw new DriveOAuthFailure(
        error.category === 'AUTH' ? 'REFRESH_REJECTED' : 'ROOT_ACCESS',
      );
    throw error;
  }
});
async function configuration(env: Env) {
  if (
    !env.GOOGLE_DRIVE_CLIENT_ID ||
    !env.GOOGLE_DRIVE_CLIENT_SECRET ||
    !env.DRIVE_WRAPPING_KEY_ID ||
    !env.DRIVE_WRAPPING_KEY ||
    env.DRIVE_KEY_RECOVERY_READY !== 'true'
  )
    throw new Error('DRIVE_CONFIGURATION_REQUIRED');
  const wrapping = await importDriveWrappingKey(
    env.DRIVE_WRAPPING_KEY_ID,
    env.DRIVE_WRAPPING_KEY,
  ).catch(() => {
    throw new Error('DRIVE_CONFIGURATION_REQUIRED');
  });
  return {
    config: {
      client_id: env.GOOGLE_DRIVE_CLIENT_ID,
      client_secret: env.GOOGLE_DRIVE_CLIENT_SECRET,
      app_origin: applicationOrigin(env),
      ...(['TESTING', 'PRODUCTION', 'INTERNAL'].includes(
        env.GOOGLE_DRIVE_OAUTH_PUBLISHING_STATUS ?? '',
      )
        ? {
            publishing_status: env.GOOGLE_DRIVE_OAUTH_PUBLISHING_STATUS as
              'TESTING' | 'PRODUCTION' | 'INTERNAL',
          }
        : {}),
    },
    wrapping,
  };
}
driveApp.get('/status', async (c) => {
  queryFields(c, []);
  let configured = false;
  try {
    await configuration(c.env);
    configured = true;
  } catch {
    /* presence/readiness only */
  }
  const rows = (
    await c.env.DB.prepare(
      `SELECT c.connection_id,c.auth_state,c.root_id,c.root_state,c.scopes_json,c.publishing_state,c.revision,c.last_refresh_at,c.last_error,EXISTS(SELECT 1 FROM drive_credentials k WHERE k.owner_id=c.owner_id AND k.connection_id=c.connection_id) credential_present FROM drive_connections c WHERE c.owner_id=? ORDER BY c.updated_at DESC,c.connection_id LIMIT 51`,
    )
      .bind(c.get('access').ownerId)
      .all<{
        connection_id: string;
        auth_state: string;
        root_id: string | null;
        root_state: string;
        scopes_json: string;
        publishing_state: string;
        revision: number;
        last_refresh_at: string | null;
        last_error: string | null;
        credential_present: number;
      }>()
  ).results;
  const status: DriveStatus = {
    configured,
    export_capability: 'NOT_YET_VERIFIED',
    connections: rows
      .slice(0, 50)
      .map(({ scopes_json, credential_present, ...row }) => ({
        ...row,
        auth_state:
          !credential_present && row.auth_state === 'CONNECTED'
            ? 'REAUTH_REQUIRED'
            : row.auth_state,
        scopes: JSON.parse(scopes_json) as string[],
        offline_credential_present: credential_present === 1,
      })),
    truncated: rows.length > 50,
  };
  return c.json(status);
});
driveApp.post('/start', async (c) => {
  await body(c, []);
  const { config, wrapping } = await configuration(c.env);
  const start = await beginDriveAuthorization(
    c.env.DB,
    c.get('access'),
    config,
    wrapping,
    new Date(),
  );
  c.header('Set-Cookie', start.browser_cookie);
  return c.json({ authorization_url: start.url });
});
driveApp.post('/reconnect', async (c) => {
  const input = await body(c, ['connection_id']);
  const { config, wrapping } = await configuration(c.env);
  const start = await beginDriveAuthorization(
    c.env.DB,
    c.get('access'),
    config,
    wrapping,
    new Date(),
    text(input.connection_id, 128),
  );
  c.header('Set-Cookie', start.browser_cookie);
  return c.json({ authorization_url: start.url });
});
driveApp.get('/callback', async (c) => {
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Set-Cookie',
    '__Host-bi-drive=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
  );
  queryFields(c, [
    'state',
    'code',
    'scope',
    'authuser',
    'prompt',
    'error',
    'error_description',
    'iss',
  ]);
  if (c.req.query('error')) throw new DriveOAuthFailure('OWNER_ACCOUNT');
  if (
    c.req.query('iss') &&
    c.req.query('iss') !== 'https://accounts.google.com'
  )
    throw new DriveOAuthFailure('OWNER_ACCOUNT');
  const { config, wrapping } = await configuration(c.env);
  await finishDriveAuthorization(
    c.env.DB,
    c.get('access'),
    config,
    wrapping,
    {
      state: c.req.query('state') ?? '',
      code: c.req.query('code') ?? '',
      browser: cookieValue(c.req.raw, '__Host-bi-drive'),
    },
    new Date(),
  );
  return c.redirect(
    applicationOrigin(c.env) + '/system/connections?drive=connected',
    303,
  );
});
