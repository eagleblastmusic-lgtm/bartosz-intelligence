import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import type { Database } from '../../packages/core/src/db/boundary.js';
import {
  issueSession,
  authenticateSession,
} from '../../packages/core/src/auth/session.js';
import { sha256, randomToken } from '../../packages/core/src/auth/crypto.js';
import {
  importDriveWrappingKey,
  encryptDriveRefreshToken,
} from '../../packages/core/src/drive/credentials.js';
import {
  refreshDriveAccess,
  DriveOAuthFailure,
  driveFileScope,
} from '../../packages/core/src/drive/oauth.js';
import application from '../../config/application.json';

// One real OAuth request with an intentionally invalid diagnostic token.
// All state/credentials/session are disposable local D1 fixtures. No real grant
// is revoked, replaced, refreshed or read, no consent/scopes or Drive writes.
if (
  process.argv.slice(2).join(' ') !== '--live-diagnostic --once' ||
  !process.env.GOOGLE_DRIVE_CLIENT_ID ||
  !process.env.GOOGLE_DRIVE_CLIENT_SECRET
)
  throw new Error('EXPLICIT_DIAGNOSTIC_OAUTH_REQUEST_REQUIRED');
const id = randomUUID(),
  secret = randomToken(),
  keyBytes = randomToken(),
  ownerId = 'diagnostic-owner';
const config = {
  client_id: process.env.GOOGLE_DRIVE_CLIENT_ID,
  client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET,
  app_origin: application.app_origin,
};
mkdirSync('docs/verification/drive', { recursive: true });
writeFileSync(
  'docs/verification/drive/oauth-negative-' + id + '-intent.json',
  JSON.stringify({
    registered_at: new Date().toISOString(),
    fault: 'INVALID_DIAGNOSTIC_REFRESH_TOKEN',
    maximum_oauth_requests: 1,
    real_grant_mutations: 0,
    production_d1_requests: 0,
    paid_services_enabled: false,
  }) + '\n',
  { flag: 'wx' },
);
const require = createRequire(import.meta.url),
  wrangler = createRequire(require.resolve('wrangler/package.json'));
const runtime = wrangler('miniflare') as {
  convertV4MiniflareOptions(
    options: Record<string, unknown>,
  ): Record<string, unknown>;
  Miniflare: new (options: Record<string, unknown>) => {
    ready: Promise<URL>;
    getD1Database(name: string): Promise<Database>;
    dispatchFetch(url: string, init?: RequestInit): Promise<Response>;
    dispose(): Promise<void>;
  };
};
const mf = new runtime.Miniflare(
  runtime.convertV4MiniflareOptions({
    modules: true,
    script: readFileSync('apps/api/dist/index.js', 'utf8'),
    compatibilityDate: '2026-10-01',
    d1Databases: ['DB'],
    queueProducers: { BARTOSZ_QUEUE: 'isolated-oauth' },
    bindings: {
      APP_ORIGIN: application.app_origin,
      SESSION_SIGNING_SECRET: secret,
      GOOGLE_OIDC_CLIENT_ID: 'diagnostic',
      GOOGLE_OIDC_CLIENT_SECRET: 'diagnostic',
      GOOGLE_OIDC_OWNER_SUBJECT: 'diagnostic-subject',
      GOOGLE_DRIVE_CLIENT_ID: config.client_id,
      GOOGLE_DRIVE_CLIENT_SECRET: config.client_secret,
      DRIVE_WRAPPING_KEY_ID: 'diagnostic',
      DRIVE_WRAPPING_KEY: keyBytes,
      DRIVE_KEY_RECOVERY_READY: 'true',
    },
    outboundService: () =>
      new Response('DIAGNOSTIC_RUNTIME_OUTBOUND_DENIED', { status: 503 }),
    serviceBindings: {
      ASSETS: () => new Response('LOCAL_DIAGNOSTIC', { status: 200 }),
    },
  }),
);
let receipt: Record<string, unknown> = {},
  requests = 0,
  providerStatus: number | null = null;
try {
  await mf.ready;
  const db = await mf.getD1Database('DB'),
    now = new Date();
  for (const migration of await readD1Migrations('db/migrations'))
    for (const sql of migration.queries) await db.prepare(sql).run();
  await db
    .prepare('INSERT INTO owner_users VALUES(?,?,?,?,?)')
    .bind(
      ownerId,
      'https://accounts.google.com',
      'diagnostic-subject',
      1,
      now.toISOString(),
    )
    .run();
  const session = await issueSession(
    db,
    { issuer: 'https://accounts.google.com', subject: 'diagnostic-subject' },
    secret,
    now,
  );
  const cookie = session.cookie.split(';')[0]!;
  const owner = await authenticateSession(
    db,
    cookie.split('=')[1]!,
    secret,
    now,
  );
  await db
    .prepare(
      `INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,publishing_state,revision,last_intent_hash,created_at,updated_at)
    VALUES(?,?,?,?,?,'CONNECTED','PRODUCTION',1,?,?,?)`,
    )
    .bind(
      ownerId,
      id,
      'diagnostic-subject',
      config.client_id,
      JSON.stringify([driveFileScope, 'openid']),
      await sha256(id),
      now.toISOString(),
      now.toISOString(),
    )
    .run();
  const wrapping = await importDriveWrappingKey('diagnostic', keyBytes);
  const envelope = await encryptDriveRefreshToken(
    'diagnostic-invalid-' + id,
    {
      owner_id: ownerId,
      connection_id: id,
      account_subject: 'diagnostic-subject',
      client_id: config.client_id,
    },
    wrapping,
  );
  await db
    .prepare('INSERT INTO drive_credentials VALUES(?,?,?,?)')
    .bind(ownerId, id, JSON.stringify(envelope), now.toISOString())
    .run();
  let reason: string | null = null;
  try {
    await refreshDriveAccess(
      db,
      owner,
      config,
      wrapping,
      id,
      new Date(),
      async (target, init) => {
        if (target !== 'https://oauth2.googleapis.com/token' || requests !== 0)
          throw new Error('DIAGNOSTIC_REQUEST_BOUNDARY');
        requests++;
        const response = await fetch(target, init);
        providerStatus = response.status;
        return response;
      },
    );
  } catch (error) {
    reason =
      error instanceof DriveOAuthFailure ? error.reason : 'DIAGNOSTIC_FAILURE';
  }
  const visible = await mf.dispatchFetch(
    application.app_origin + '/api/v1/connections/drive/status',
    { headers: { Cookie: cookie } },
  );
  const status = (await visible.json()) as {
    connections?: {
      connection_id: string;
      auth_state: string;
      last_error: string | null;
    }[];
  };
  const connection = status.connections?.find(
    (row) => row.connection_id === id,
  );
  const pass =
    reason === 'REFRESH_REJECTED' &&
    requests === 1 &&
    providerStatus === 400 &&
    visible.status === 200 &&
    connection?.auth_state === 'REAUTH_REQUIRED' &&
    connection.last_error === 'REFRESH_REJECTED';
  receipt = {
    status: pass ? 'PASS' : 'FAIL',
    scope: 'ACTUAL_GOOGLE_INVALID_GRANT_LOCAL_OWNER_API_VISIBILITY',
    diagnostic_token: true,
    provider_http_status: providerStatus,
    oauth_requests: requests,
    reason,
    owner_status_http: visible.status,
    auth_state: connection?.auth_state ?? null,
    last_error: connection?.last_error ?? null,
    real_owner_grant_untouched: true,
    production_d1_requests: 0,
    drive_file_writes: 0,
    gemini_requests: 0,
    paid_services_enabled: false,
    full_d_export_status: 'UNCHANGED_REQUIRES_REPORT_BOUND_EVIDENCE',
  };
  if (!pass) process.exitCode = 2;
} catch (error) {
  const code = error instanceof Error ? error.message : '';
  receipt = {
    status: 'FAIL',
    reason: /^[A-Z_0-9]+$/.test(code) ? code : 'DIAGNOSTIC_FAILURE_REDACTED',
    oauth_requests: requests,
    production_d1_requests: 0,
    paid_services_enabled: false,
  };
  process.exitCode = 2;
} finally {
  await mf.dispose();
  writeFileSync(
    'docs/verification/drive/oauth-negative-' + id + '.json',
    JSON.stringify(
      {
        version: 'DriveOAuthNegative/1.0',
        observed_at: new Date().toISOString(),
        ...receipt,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  console.log(JSON.stringify(receipt));
}
