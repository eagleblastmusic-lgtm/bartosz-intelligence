import { ownerRouter, body, queryFields, text } from './common.js';
import type { ApiEnvironment } from './common.js';
import type { Context } from 'hono';
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
import {
  previewDriveRoot,
  confirmDriveRoot,
} from '../../../../packages/core/src/drive/root.js';
import { createDriveRootCandidate } from '../../../../packages/core/src/drive/root-create.js';
import { exportStatus } from '../../../../packages/core/src/export/status.js';
import { ExportSettings } from '../../../../packages/core/src/export/settings.js';
import {
  previewDriveConflict,
  preserveManualDriveConflict,
} from '../../../../packages/core/src/drive/conflict.js';

export const driveApp = ownerRouter();
driveApp.post('/exports/conflict/preview', async (c) => {
  const input = await body(c, [
    'connection_id',
    'root_id',
    'date',
    'expected_connection_revision',
    'expected_settings_revision',
  ]);
  const connectionId = text(input.connection_id, 128);
  const { access, client, now, renewedRevision } = await rootClient(
    c,
    connectionId,
    input.expected_connection_revision,
  );
  try {
    return c.json(
      await previewDriveConflict(
        c.env.DB,
        access,
        client,
        {
          connection_id: connectionId,
          connection_revision: renewedRevision,
          root_id: text(input.root_id, 200),
          date: text(input.date, 10),
          expected_settings_revision:
            input.expected_settings_revision as number,
        },
        now,
      ),
    );
  } catch (error) {
    return rootFailure(error);
  }
});
driveApp.post('/exports/conflict/confirm', async (c) => {
  const input = await body(c, [
    'connection_id',
    'preview_hash',
    'expected_connection_revision',
    'action',
  ]);
  if (input.action !== 'KEEP_MANUAL')
    throw new Error('INVALID_EXPORT_SETTINGS');
  const connectionId = text(input.connection_id, 128);
  const { access, client, now, renewedRevision } = await rootClient(
    c,
    connectionId,
    input.expected_connection_revision,
  );
  try {
    return c.json(
      await preserveManualDriveConflict(
        c.env.DB,
        access,
        client,
        {
          connection_id: connectionId,
          connection_revision: renewedRevision,
          preview_hash: text(input.preview_hash, 64),
          action: input.action,
        },
        now,
      ),
    );
  } catch (error) {
    return rootFailure(error);
  }
});
driveApp.post('/root/confirm', async (c) => {
  const input = await body(c, [
    'connection_id',
    'preview_hash',
    'expected_revision',
    'acknowledge_mapping_review',
  ]);
  if (typeof input.acknowledge_mapping_review !== 'boolean')
    throw new Error('INVALID_DRIVE_ROOT_PREVIEW');
  const connectionId = text(input.connection_id, 128);
  const { access, client, now, renewedRevision } = await rootClient(
    c,
    connectionId,
    input.expected_revision,
  );
  try {
    return c.json(
      await confirmDriveRoot(
        c.env.DB,
        access,
        client,
        {
          connection_id: connectionId,
          preview_hash: text(input.preview_hash, 64),
          expected_revision: renewedRevision,
          acknowledge_mapping_review: input.acknowledge_mapping_review,
        },
        now,
      ),
    );
  } catch (error) {
    return rootFailure(error);
  }
});
driveApp.get('/exports/status', async (c) => {
  queryFields(c, []);
  return c.json(await exportStatus(c.env.DB, c.get('access'), new Date()));
});
driveApp.post('/exports/mode', async (c) => {
  const input = await body(c, ['root_id', 'date', 'mode', 'expected_revision']);
  if (
    (input.mode !== 'COMPACT' && input.mode !== 'FULL') ||
    !Number.isSafeInteger(input.expected_revision)
  )
    throw new Error('INVALID_EXPORT_SETTINGS');
  return c.json(
    await new ExportSettings(c.env.DB, c.get('access')).mode(
      text(input.root_id, 200),
      text(input.date, 10),
      input.mode,
      input.expected_revision as number,
      new Date(),
    ),
  );
});
driveApp.post('/exports/retry', async (c) => {
  const input = await body(c, ['root_id', 'date', 'expected_revision']);
  return c.json(
    await new ExportSettings(c.env.DB, c.get('access')).retry(
      text(input.root_id, 200),
      text(input.date, 10),
      input.expected_revision as number,
    ),
  );
});
driveApp.post('/root/preview', async (c) => {
  const input = await body(c, [
    'connection_id',
    'root_id',
    'expected_revision',
  ]);
  const connectionId = text(input.connection_id, 128),
    rootId = text(input.root_id, 200);
  const { access, client, now, renewedRevision } = await rootClient(
    c,
    connectionId,
    input.expected_revision,
  );
  try {
    return c.json(
      await previewDriveRoot(
        c.env.DB,
        access,
        client,
        {
          connection_id: connectionId,
          root_id: rootId,
          expected_revision: renewedRevision,
        },
        now,
      ),
    );
  } catch (error) {
    return rootFailure(error);
  }
});
driveApp.post('/root/create', async (c) => {
  const input = await body(c, ['connection_id', 'name', 'expected_revision']);
  const connectionId = text(input.connection_id, 128),
    name = text(input.name, 256);
  if (
    name !== name.trim() ||
    /[\u0000-\u001f\u007f]/.test(name) ||
    new TextEncoder().encode(name).length > 256
  )
    throw new Error('INVALID_DRIVE_ROOT_CANDIDATE');
  const { access, client, now, renewedRevision } = await rootClient(
    c,
    connectionId,
    input.expected_revision,
  );
  try {
    return c.json(
      await createDriveRootCandidate(
        c.env.DB,
        access,
        client,
        {
          connection_id: connectionId,
          name,
          expected_revision: renewedRevision,
        },
        now,
      ),
    );
  } catch (error) {
    return rootFailure(error);
  }
});
function rootFailure(error: unknown): never {
  if (error instanceof DriveFailure)
    throw new DriveOAuthFailure(
      error.category === 'AUTH' ? 'REFRESH_REJECTED' : 'ROOT_ACCESS',
    );
  throw error;
}
async function rootClient(
  c: Context<ApiEnvironment>,
  connectionId: string,
  expectedRevision: unknown,
) {
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1)
    throw new Error('INVALID_DRIVE_ROOT_PREVIEW');
  const access = c.get('access');
  const revision = await c.env.DB.prepare(
    'SELECT revision FROM drive_connections WHERE owner_id=? AND connection_id=?',
  )
    .bind(access.ownerId, connectionId)
    .first<number>('revision');
  if (revision === null) throw new Error('NOT_FOUND');
  if (revision !== expectedRevision) throw new Error('REVISION_CONFLICT');
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
  return {
    access,
    client: new DriveClient(grant.access_token),
    now,
    renewedRevision,
  };
}
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
  const candidates = (
    await c.env.DB.prepare(
      'SELECT connection_id,candidate_name name,reserved_folder_id folder_id,state FROM drive_root_candidates WHERE owner_id=? ORDER BY created_at DESC,reserved_folder_id LIMIT 101',
    )
      .bind(c.get('access').ownerId)
      .all<{
        connection_id: string;
        name: string;
        folder_id: string;
        state: 'RESERVED' | 'CREATED';
      }>()
  ).results;
  const status: DriveStatus = {
    root_candidates: candidates.slice(0, 100),
    root_candidates_truncated: candidates.length > 100,
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
