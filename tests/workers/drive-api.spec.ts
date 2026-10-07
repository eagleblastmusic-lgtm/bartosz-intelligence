import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import worker from '../../apps/api/src/index.js';
import { resetCore, fixtureSecret } from './core-fixture.js';
import { issueSession } from '../../packages/core/src/auth/session.js';
import application from '../../config/application.json';
import type { Env } from '../../apps/api/src/env.js';
import { base64url } from '../../packages/core/src/auth/crypto.js';
import { fixtureOwner, fixtureNow } from './core-fixture.js';
import { DriveExportIdentity } from '../../packages/core/src/drive/identity.js';
import { exportStatus } from '../../packages/core/src/export/status.js';
beforeEach(resetCore);
it('export status is owner scoped and readonly; mode intent requires CSRF, integer revision and keeps remote state honest', async () => {
  const access = await fixtureOwner(),
    h = await headers();
  await env.DB.prepare(
    `INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,root_id,root_state,revision,last_intent_hash,created_at,updated_at) VALUES('a','export','private-subject','client','[]','CONNECTED','root','VERIFIED',1,'receipt',?,?)`,
  )
    .bind(fixtureNow.toISOString(), fixtureNow.toISOString())
    .run();
  await new DriveExportIdentity(env.DB, access).ensure(
    'export',
    'root',
    '2026-10-05',
    fixtureNow,
  );
  expect((await request('/exports/status')).status).toBe(401);
  const response = await request('/exports/status', h),
    status = (await response.json()) as Awaited<
      ReturnType<typeof exportStatus>
    >;
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(status).toMatchObject({
    automatic_updates_qualified: false,
    days: [
      {
        desired_mode: 'COMPACT',
        remote_revision: 0,
        rendered_revision: null,
        file_id: null,
        queue_state: 'DUE',
      },
    ],
  });
  expect(JSON.stringify(status)).not.toContain('private-subject');
  expect(
    (await exportStatus(env.DB, await fixtureOwner('b'), new Date())).days,
  ).toEqual([]);
  const input = {
    root_id: 'root',
    date: '2026-10-05',
    mode: 'FULL',
    expected_revision: 1,
  };
  expect((await request('/exports/mode', {}, input)).status).toBe(403);
  expect(
    (await request('/exports/mode', h, { ...input, expected_revision: '1' }))
      .status,
  ).toBe(422);
  expect((await request('/exports/mode', h, input)).status).toBe(200);
  expect((await request('/exports/mode', h, input)).status).toBe(409);
  expect(await (await request('/exports/status', h)).json()).toMatchObject({
    days: [
      {
        desired_mode: 'FULL',
        remote_mode: 'COMPACT',
        desired_generation: 1,
        exported_generation: 0,
        remote_revision: 0,
        file_id: null,
        queue_state: 'WAITING',
      },
    ],
  });
});
it('root create requires CSRF, owner connection and input revision before token renewal, and rejects malformed name', async () => {
  const h = await headers(),
    input = { connection_id: 'foreign', name: 'Daily', expected_revision: 1 };
  expect((await request('/root/create', {}, input)).status).toBe(403);
  expect((await request('/root/create', h, input)).status).toBe(404);
  expect(
    (await request('/root/create', h, { ...input, name: 'Daily\nFolder' }))
      .status,
  ).toBe(422);
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM drive_root_candidates').first(
      'n',
    ),
  ).toBe(0);
});
it('root preview requires CSRF, own connection and matching revision before renewal or remote inspection', async () => {
  const h = await headers(),
    input = {
      connection_id: 'foreign',
      root_id: 'explicit-root',
      expected_revision: 1,
    };
  expect((await request('/root/preview', {}, input)).status).toBe(403);
  const noCsrf: Record<string, string> = { ...h };
  delete noCsrf['X-CSRF-Token'];
  expect((await request('/root/preview', noCsrf, input)).status).toBe(403);
  expect((await request('/root/preview', h, input)).status).toBe(404);
  expect(
    (await request('/root/preview', h, { ...input, expected_revision: 0 }))
      .status,
  ).toBe(422);
  await env.DB.prepare(
    `INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,revision,last_intent_hash,created_at,updated_at) VALUES('a','own','subject-a','client','[]','CONNECTED',2,'receipt',?,?)`,
  )
    .bind(new Date().toISOString(), new Date().toISOString())
    .run();
  expect(
    (await request('/root/preview', h, { ...input, connection_id: 'own' }))
      .status,
  ).toBe(409);
});
const settings: Env = {
  ...env,
  GOOGLE_OIDC_CLIENT_ID: 'fixture-owner-client',
  GOOGLE_OIDC_CLIENT_SECRET: 'synthetic-owner-secret',
  GOOGLE_OIDC_OWNER_SUBJECT: 'subject-a',
  SESSION_SIGNING_SECRET: fixtureSecret,
};
async function headers(owner = 'a') {
  const session = await issueSession(
    env.DB,
    { issuer: 'https://accounts.google.com', subject: 'subject-' + owner },
    fixtureSecret,
    new Date(),
  );
  return {
    Cookie: session.cookie.split(';')[0]!,
    Origin: application.app_origin,
    'X-CSRF-Token': session.csrf,
    'Content-Type': 'application/json',
  };
}
function request(
  path: string,
  h: Record<string, string> = {},
  input?: unknown,
  configured = settings,
) {
  return worker.fetch(
    new Request(application.app_origin + '/api/v1/connections/drive' + path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: h,
      body: input === undefined ? undefined : JSON.stringify(input),
    }),
    configured,
    createExecutionContext(),
  );
}
it('status requires owner, reports missing configuration honestly, and never schedules or exports', async () => {
  expect((await request('/status')).status).toBe(401);
  const response = await request('/status', await headers());
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({
    configured: false,
    connections: [],
    truncated: false,
    export_capability: 'NOT_YET_VERIFIED',
  });
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM jobs').first<number>('n'),
  ).toBe(0);
});
it('start requires CSRF and private recovery readiness before any intent or outbound request', async () => {
  const h = await headers();
  const noCsrf: Record<string, string> = { ...h };
  delete noCsrf['X-CSRF-Token'];
  expect((await request('/start', noCsrf, {})).status).toBe(403);
  expect((await request('/start', h, {})).status).toBe(503);
  const config: Env = {
    ...settings,
    GOOGLE_DRIVE_CLIENT_ID: 'fixture-drive-client',
    GOOGLE_DRIVE_CLIENT_SECRET: 'synthetic-drive-secret',
    DRIVE_WRAPPING_KEY_ID: 'fixture-key',
    DRIVE_WRAPPING_KEY: base64url(new Uint8Array(32).fill(7)),
    DRIVE_KEY_RECOVERY_READY: 'false',
  };
  expect((await request('/start', h, {}, config)).status).toBe(503);
  expect(
    await env.DB.prepare(
      'SELECT COUNT(*) n FROM drive_oauth_intents',
    ).first<number>('n'),
  ).toBe(0);
});
it('configured start uses actual canonical callback, sets distinct secure cookie and rejects arbitrary client/scopes', async () => {
  const h = await headers();
  const config: Env = {
    ...settings,
    GOOGLE_DRIVE_CLIENT_ID: 'fixture-drive-client',
    GOOGLE_DRIVE_CLIENT_SECRET: 'synthetic-drive-secret',
    DRIVE_WRAPPING_KEY_ID: 'fixture-key',
    DRIVE_WRAPPING_KEY: base64url(new Uint8Array(32).fill(7)),
    DRIVE_KEY_RECOVERY_READY: 'true',
  };
  expect((await request('/start', h, { scope: 'drive' }, config)).status).toBe(
    422,
  );
  const response = await request('/start', h, {}, config);
  expect(response.status).toBe(200);
  const result = (await response.json()) as { authorization_url: string };
  expect(
    new URL(result.authorization_url).searchParams.get('redirect_uri'),
  ).toBe(application.app_origin + '/api/v1/connections/drive/callback');
  expect(response.headers.get('Set-Cookie')).toContain('__Host-bi-drive=');
  expect(response.headers.get('Set-Cookie')).toContain(
    'HttpOnly; Secure; SameSite=Lax',
  );
  expect(JSON.stringify(result)).not.toContain(
    config.GOOGLE_DRIVE_CLIENT_SECRET,
  );
  const invalid = await request('/callback', h, undefined, config);
  expect(invalid.status).toBe(403);
  expect(await invalid.json()).toMatchObject({
    code: 'FORBIDDEN',
    reason: 'STATE_OR_BROWSER',
  });
  expect(invalid.headers.get('Referrer-Policy')).toBe('no-referrer');
});
it('owner status never exposes subject or encrypted/plain credentials and missing recovered credentials requires reconnect', async () => {
  await env.DB.prepare(
    `INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,revision,last_intent_hash,created_at,updated_at) VALUES('a','fixture-connection','private-subject','client','[]','CONNECTED',1,'receipt',?,?)`,
  )
    .bind(new Date().toISOString(), new Date().toISOString())
    .run();
  const response = await request('/status', await headers());
  const result = (await response.json()) as {
    connections: { auth_state: string; offline_credential_present: boolean }[];
  };
  expect(result.connections[0]).toMatchObject({
    auth_state: 'REAUTH_REQUIRED',
    offline_credential_present: false,
  });
  expect(JSON.stringify(result)).not.toContain('private-subject');
  expect(JSON.stringify(result)).not.toContain('envelope');
  expect(
    await (await request('/status', await headers('b'))).json(),
  ).toMatchObject({ connections: [] });
});
