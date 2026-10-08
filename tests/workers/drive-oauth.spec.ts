import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import {
  resetCore,
  fixtureOwner,
  fixtureNow,
  resetSchema,
} from './core-fixture.js';
import { base64url } from '../../packages/core/src/auth/crypto.js';
import {
  beginDriveAuthorization,
  finishDriveAuthorization,
  refreshDriveAccess,
  driveFileScope,
} from '../../packages/core/src/drive/oauth.js';
import {
  importDriveWrappingKey,
  decryptDriveRefreshToken,
  type EncryptedDriveCredential,
} from '../../packages/core/src/drive/credentials.js';
import {
  CoreBackup,
  backupTables,
  type BackupChunk,
} from '../../packages/core/src/backup/snapshot.js';
import { restoreCanonical } from '../../packages/core/src/backup/restore.js';

const config = {
  client_id: 'fixture-drive-client',
  client_secret: 'synthetic-client-secret',
  app_origin: 'https://bi.example',
};
beforeEach(resetCore);
it('Production configuration does not relabel an old Testing token; a new consent preserves the root and requires verification', async () => {
  const initial = await flow();
  const transport = await tokenTransport(initial.url);
  await finishDriveAuthorization(
    env.DB,
    initial.owner,
    { ...config, publishing_status: 'TESTING' },
    initial.wrapping,
    initial.input,
    fixtureNow,
    transport.fetcher,
  );
  await env.DB.prepare(
    "UPDATE drive_connections SET root_id='existing-private-root',root_state='VERIFIED'",
  ).run();
  await refreshDriveAccess(
    env.DB,
    initial.owner,
    { ...config, publishing_status: 'PRODUCTION' },
    initial.wrapping,
    initial.start.connection_id,
    fixtureNow,
    async () =>
      Response.json({
        token_type: 'Bearer',
        access_token: 'synthetic-access',
        expires_in: 3600,
      }),
  );
  expect(
    await env.DB.prepare(
      'SELECT publishing_state,root_state FROM drive_connections',
    ).first(),
  ).toEqual({ publishing_state: 'TESTING', root_state: 'VERIFIED' });
  const reconnect = await flow(initial.start.connection_id);
  const newGrant = await tokenTransport(reconnect.url);
  await finishDriveAuthorization(
    env.DB,
    reconnect.owner,
    { ...config, publishing_status: 'PRODUCTION' },
    reconnect.wrapping,
    reconnect.input,
    fixtureNow,
    newGrant.fetcher,
  );
  expect(
    await env.DB.prepare(
      'SELECT publishing_state,root_id,root_state FROM drive_connections',
    ).first(),
  ).toEqual({
    publishing_state: 'PRODUCTION',
    root_id: 'existing-private-root',
    root_state: 'VERIFY_REQUIRED',
  });
});
it('persists explicit Testing consent status without promoting an unknown or renewed grant to production', async () => {
  const f = await flow(),
    t = await tokenTransport(f.url);
  await finishDriveAuthorization(
    env.DB,
    f.owner,
    { ...config, publishing_status: 'TESTING' },
    f.wrapping,
    f.input,
    fixtureNow,
    t.fetcher,
  );
  expect(
    await env.DB.prepare(
      'SELECT publishing_state FROM drive_connections',
    ).first('publishing_state'),
  ).toBe('TESTING');
  const reconnect = await flow(f.start.connection_id),
    renewal = await tokenTransport(reconnect.url);
  await finishDriveAuthorization(
    env.DB,
    reconnect.owner,
    config,
    reconnect.wrapping,
    reconnect.input,
    fixtureNow,
    renewal.fetcher,
  );
  expect(
    await env.DB.prepare(
      'SELECT publishing_state FROM drive_connections',
    ).first('publishing_state'),
  ).toBe('TESTING');
});
it('renews an encrypted offline grant, preserves scopes when omitted and atomically stores a rotated refresh credential', async () => {
  const f = await flow(),
    t = await tokenTransport(f.url);
  await finishDriveAuthorization(
    env.DB,
    f.owner,
    config,
    f.wrapping,
    f.input,
    fixtureNow,
    t.fetcher,
  );
  const fetcher: typeof fetch = async (target, init) => {
    expect(target).toBe('https://oauth2.googleapis.com/token');
    expect(init?.redirect).toBe('manual');
    const body = init?.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('synthetic-refresh');
    expect(body.has('scope')).toBe(false);
    return Response.json({
      token_type: 'Bearer',
      access_token: 'synthetic-renewed-access',
      expires_in: 3600,
      refresh_token: 'synthetic-rotated-refresh',
    });
  };
  const access = await refreshDriveAccess(
    env.DB,
    f.owner,
    config,
    f.wrapping,
    f.start.connection_id,
    fixtureNow,
    fetcher,
  );
  expect(access.expires_at).toBe('2026-10-05T18:30:00.000Z');
  expect(access.scopes).toEqual([driveFileScope, 'openid']);
  const row = await env.DB.prepare(
    'SELECT envelope_json FROM drive_credentials',
  ).first<{ envelope_json: string }>();
  expect(
    await decryptDriveRefreshToken(
      JSON.parse(row!.envelope_json),
      {
        owner_id: 'a',
        connection_id: f.start.connection_id,
        account_subject: 'subject-a',
        client_id: config.client_id,
      },
      f.wrapping,
    ),
  ).toBe('synthetic-rotated-refresh');
  expect(
    JSON.stringify(
      await env.DB.prepare('SELECT * FROM drive_connections').first(),
    ),
  ).not.toContain(access.access_token);
});
it('invalid_grant pauses auth for explicit reconnect while transient 503 preserves connection and encrypted grant', async () => {
  const f = await flow(),
    t = await tokenTransport(f.url);
  await finishDriveAuthorization(
    env.DB,
    f.owner,
    config,
    f.wrapping,
    f.input,
    fixtureNow,
    t.fetcher,
  );
  const before = await env.DB.prepare(
    'SELECT envelope_json FROM drive_credentials',
  ).first();
  await expect(
    refreshDriveAccess(
      env.DB,
      f.owner,
      config,
      f.wrapping,
      f.start.connection_id,
      fixtureNow,
      async () => new Response('private transient details', { status: 503 }),
    ),
  ).rejects.toMatchObject({ reason: 'TOKEN_EXCHANGE' });
  expect(
    await env.DB.prepare('SELECT auth_state FROM drive_connections').first(),
  ).toEqual({ auth_state: 'CONNECTED' });
  await expect(
    refreshDriveAccess(
      env.DB,
      f.owner,
      config,
      f.wrapping,
      f.start.connection_id,
      fixtureNow,
      async () =>
        Response.json(
          { error: 'invalid_grant', error_description: 'private details' },
          { status: 400 },
        ),
    ),
  ).rejects.toMatchObject({ reason: 'REFRESH_REJECTED' });
  expect(
    await env.DB.prepare(
      'SELECT auth_state,last_error FROM drive_connections',
    ).first(),
  ).toEqual({ auth_state: 'REAUTH_REQUIRED', last_error: 'REFRESH_REJECTED' });
  expect(
    await env.DB.prepare('SELECT envelope_json FROM drive_credentials').first(),
  ).toEqual(before);
});
it('late renewal cannot replace encrypted credentials after a concurrent connection revision', async () => {
  const f = await flow(),
    t = await tokenTransport(f.url);
  await finishDriveAuthorization(
    env.DB,
    f.owner,
    config,
    f.wrapping,
    f.input,
    fixtureNow,
    t.fetcher,
  );
  const before = await env.DB.prepare(
    'SELECT envelope_json FROM drive_credentials',
  ).first();
  const fetcher: typeof fetch = async () => {
    await env.DB.prepare(
      "UPDATE drive_connections SET revision=revision+1 WHERE owner_id='a'",
    ).run();
    return Response.json({
      token_type: 'Bearer',
      access_token: 'synthetic-access',
      expires_in: 3600,
      refresh_token: 'synthetic-late-refresh',
    });
  };
  await expect(
    refreshDriveAccess(
      env.DB,
      f.owner,
      config,
      f.wrapping,
      f.start.connection_id,
      fixtureNow,
      fetcher,
    ),
  ).rejects.toMatchObject({ reason: 'CONNECTION_CHANGED' });
  expect(
    await env.DB.prepare('SELECT envelope_json FROM drive_credentials').first(),
  ).toEqual(before);
});
async function flow(connectionId?: string) {
  const owner = await fixtureOwner();
  const wrapping = await importDriveWrappingKey(
    'fixture-wrapping-v1',
    base64url(new Uint8Array(32).fill(7)),
  );
  const start = await beginDriveAuthorization(
    env.DB,
    owner,
    config,
    wrapping,
    fixtureNow,
    connectionId,
  );
  const url = new URL(start.url);
  const input = {
    state: url.searchParams.get('state')!,
    code: 'synthetic-code',
    browser: start.browser_cookie.split(';')[0]!.split('=')[1]!,
  };
  return { owner, wrapping, start, url, input };
}
async function tokenTransport(
  url: URL,
  subject = 'subject-a',
  options: Record<string, unknown> = {},
) {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ['sign', 'verify'],
  );
  if (!('publicKey' in pair)) throw new Error('FIXTURE_RSA_REQUIRED');
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const encode = (value: unknown) =>
    base64url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned =
    encode({ alg: 'RS256', kid: 'fixture-key' }) +
    '.' +
    encode({
      iss: 'https://accounts.google.com',
      aud: config.client_id,
      sub: subject,
      nonce: url.searchParams.get('nonce'),
      iat: fixtureNow.getTime() / 1000,
      exp: fixtureNow.getTime() / 1000 + 600,
    });
  const token =
    unsigned +
    '.' +
    base64url(
      new Uint8Array(
        await crypto.subtle.sign(
          'RSASSA-PKCS1-v1_5',
          pair.privateKey,
          new TextEncoder().encode(unsigned),
        ),
      ),
    );
  const calls: string[] = [];
  const fetcher: typeof fetch = async (target, init) => {
    calls.push(String(target));
    expect(init?.redirect).toBe('manual');
    if (target === 'https://oauth2.googleapis.com/token') {
      const body = init?.body as URLSearchParams;
      expect(body.get('client_secret')).toBe(config.client_secret);
      expect(body.get('redirect_uri')).toBe(
        config.app_origin + '/api/v1/connections/drive/callback',
      );
      expect(body.get('code_verifier')).toHaveLength(43);
      return Response.json({
        id_token: token,
        access_token: 'synthetic-access',
        refresh_token: 'synthetic-refresh',
        token_type: 'Bearer',
        scope: 'openid ' + driveFileScope,
        expires_in: 3600,
        ...options,
      });
    }
    expect(target).toBe('https://www.googleapis.com/oauth2/v3/certs');
    return Response.json({
      keys: [{ ...jwk, kid: 'fixture-key', alg: 'RS256' }],
    });
  };
  return { calls, fetcher };
}
it('separates offline Drive state/cookie/scopes from OIDC, seals refresh token and consumes signed owner grant once', async () => {
  const f = await flow(),
    t = await tokenTransport(f.url);
  expect(f.url.searchParams.get('scope')).toBe('openid ' + driveFileScope);
  expect(f.url.searchParams.get('include_granted_scopes')).toBe('false');
  expect(f.url.searchParams.get('access_type')).toBe('offline');
  expect(f.url.searchParams.get('prompt')).toBe('consent');
  expect(f.start.browser_cookie).toContain('__Host-bi-drive=');
  expect(f.start.browser_cookie).toContain('HttpOnly; Secure; SameSite=Lax');
  expect(
    await env.DB.prepare(
      'SELECT COUNT(*) n FROM oidc_login_intents',
    ).first<number>('n'),
  ).toBe(0);
  const result = await finishDriveAuthorization(
    env.DB,
    f.owner,
    config,
    f.wrapping,
    f.input,
    fixtureNow,
    t.fetcher,
  );
  expect(result.auth_state).toBe('CONNECTED');
  expect(JSON.stringify(result)).not.toContain('synthetic-refresh');
  const row = await env.DB.prepare(
    'SELECT envelope_json FROM drive_credentials',
  ).first<{ envelope_json: string }>();
  expect(row!.envelope_json).not.toContain('synthetic-refresh');
  expect(
    await decryptDriveRefreshToken(
      JSON.parse(row!.envelope_json) as EncryptedDriveCredential,
      {
        owner_id: 'a',
        connection_id: f.start.connection_id,
        account_subject: 'subject-a',
        client_id: config.client_id,
      },
      f.wrapping,
    ),
  ).toBe('synthetic-refresh');
  await expect(
    finishDriveAuthorization(
      env.DB,
      f.owner,
      config,
      f.wrapping,
      f.input,
      fixtureNow,
      t.fetcher,
    ),
  ).rejects.toMatchObject({ reason: 'STATE_OR_BROWSER' });
  expect(t.calls).toHaveLength(2);
  expect(
    await env.DB.prepare(
      'SELECT root_id,root_state,publishing_state FROM drive_connections',
    ).first(),
  ).toEqual({
    root_id: null,
    root_state: 'UNSELECTED',
    publishing_state: 'UNKNOWN',
  });
});
it('rejects foreign owner/browser, changed redirect and expiry before contacting Google', async () => {
  const f = await flow();
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    throw new Error('UNEXPECTED_TRANSPORT');
  };
  for (const input of [
    { ...f.input, browser: 'wrong' },
    { ...f.input, state: 'wrong' },
  ])
    await expect(
      finishDriveAuthorization(
        env.DB,
        f.owner,
        config,
        f.wrapping,
        input,
        fixtureNow,
        fetcher,
      ),
    ).rejects.toMatchObject({ reason: 'STATE_OR_BROWSER' });
  await expect(
    finishDriveAuthorization(
      env.DB,
      await fixtureOwner('b'),
      config,
      f.wrapping,
      f.input,
      fixtureNow,
      fetcher,
    ),
  ).rejects.toMatchObject({ reason: 'STATE_OR_BROWSER' });
  await expect(
    finishDriveAuthorization(
      env.DB,
      f.owner,
      { ...config, app_origin: 'https://other.example' },
      f.wrapping,
      f.input,
      fixtureNow,
      fetcher,
    ),
  ).rejects.toMatchObject({ reason: 'STATE_OR_BROWSER' });
  await expect(
    finishDriveAuthorization(
      env.DB,
      f.owner,
      config,
      f.wrapping,
      f.input,
      new Date(fixtureNow.getTime() + 600001),
      fetcher,
    ),
  ).rejects.toMatchObject({ reason: 'STATE_OR_BROWSER' });
  expect(calls).toBe(0);
});
it('rejects another Google account, widened/insufficient scopes or missing offline grant without storing credentials', async () => {
  for (const [subject, override, reason] of [
    ['foreign-account', {}, 'OWNER_ACCOUNT'],
    [
      'subject-a',
      { scope: 'openid https://www.googleapis.com/auth/drive' },
      'SCOPES',
    ],
    ['subject-a', { scope: 'openid' }, 'SCOPES'],
    ['subject-a', { refresh_token: null }, 'REFRESH_REQUIRED'],
  ] as const) {
    const f = await flow(),
      t = await tokenTransport(f.url, subject, override);
    await expect(
      finishDriveAuthorization(
        env.DB,
        f.owner,
        config,
        f.wrapping,
        f.input,
        fixtureNow,
        t.fetcher,
      ),
    ).rejects.toMatchObject({ reason });
  }
  expect(
    await env.DB.prepare(
      'SELECT COUNT(*) n FROM drive_connections',
    ).first<number>('n'),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      'SELECT COUNT(*) n FROM drive_credentials',
    ).first<number>('n'),
  ).toBe(0);
});
it('reconnect preserves root mapping and prevents a stale grant from overwriting a newer connection revision', async () => {
  const f = await flow(),
    t = await tokenTransport(f.url);
  await finishDriveAuthorization(
    env.DB,
    f.owner,
    config,
    f.wrapping,
    f.input,
    fixtureNow,
    t.fetcher,
  );
  await env.DB.prepare(
    "UPDATE drive_connections SET root_id='owner-chosen-root',root_state='VERIFIED' WHERE owner_id='a'",
  ).run();
  const a = await flow(f.start.connection_id),
    b = await flow(f.start.connection_id);
  const ta = await tokenTransport(a.url),
    tb = await tokenTransport(b.url, 'subject-a', {
      refresh_token: 'synthetic-newer',
    });
  await finishDriveAuthorization(
    env.DB,
    a.owner,
    config,
    a.wrapping,
    a.input,
    fixtureNow,
    ta.fetcher,
  );
  const before = await env.DB.prepare(
    'SELECT envelope_json FROM drive_credentials',
  ).first();
  await expect(
    finishDriveAuthorization(
      env.DB,
      b.owner,
      config,
      b.wrapping,
      b.input,
      fixtureNow,
      tb.fetcher,
    ),
  ).rejects.toMatchObject({ reason: 'CONNECTION_CHANGED' });
  expect(
    await env.DB.prepare('SELECT envelope_json FROM drive_credentials').first(),
  ).toEqual(before);
  expect(
    await env.DB.prepare(
      'SELECT root_id,root_state,revision FROM drive_connections',
    ).first(),
  ).toEqual({
    root_id: 'owner-chosen-root',
    root_state: 'VERIFY_REQUIRED',
    revision: 2,
  });
});
it('denies redirects and oversized token bodies with fixed errors, never leaking provider body or retrying the consumed code', async () => {
  for (const response of [
    new Response('private-provider-message', {
      status: 302,
      headers: { Location: 'https://evil.example' },
    }),
    new Response('secret'.repeat(6000)),
  ]) {
    const f = await flow();
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return response;
    };
    await expect(
      finishDriveAuthorization(
        env.DB,
        f.owner,
        config,
        f.wrapping,
        f.input,
        fixtureNow,
        fetcher,
      ),
    ).rejects.toThrow('DRIVE_AUTH_DENIED');
    await expect(
      finishDriveAuthorization(
        env.DB,
        f.owner,
        config,
        f.wrapping,
        f.input,
        fixtureNow,
        fetcher,
      ),
    ).rejects.toMatchObject({ reason: 'STATE_OR_BROWSER' });
    expect(calls).toBe(1);
  }
});
it('backs up only connection metadata and restores root mapping paused for separate private credential recovery', async () => {
  const f = await flow(),
    t = await tokenTransport(f.url);
  await finishDriveAuthorization(
    env.DB,
    f.owner,
    config,
    f.wrapping,
    f.input,
    fixtureNow,
    t.fetcher,
  );
  await env.DB.prepare(
    "UPDATE drive_connections SET root_id='owner-root',root_state='VERIFIED' WHERE owner_id='a'",
  ).run();
  await env.DB.prepare(
    `INSERT INTO export_state(owner_id,publication_date,timezone,destination_key,root_namespace,connection_id,reserved_remote_id,file_id,lease_owner,lease_until,fencing_token) VALUES('a','2026-10-05','Europe/Warsaw','drive:owner-root','owner-root',?,'reserved-daily','reserved-daily','old-export-worker',?,8)`,
  )
    .bind(f.start.connection_id, new Date(Date.now() + 900000).toISOString())
    .run();
  const backup = new CoreBackup(env.DB, f.owner),
    started = await backup.begin();
  await expect(
    env.DB.prepare(
      "UPDATE drive_connections SET root_id='other-root' WHERE owner_id='a'",
    ).run(),
  ).rejects.toThrow('BACKUP_MUTATION_PAUSED');
  const chunks: (BackupChunk & { index: number })[] = [];
  for (const table of backupTables) {
    let cursor = 0,
      index = 0;
    do {
      const chunk = await backup.chunk(started.backup_id, table, cursor);
      chunks.push({ ...chunk, index: index++ });
      if (chunk.next_cursor === null) break;
      cursor = chunk.next_cursor;
    } while (true);
  }
  const manifest = await backup.complete(started.backup_id);
  expect(JSON.stringify(chunks)).not.toContain('synthetic-refresh');
  expect(backupTables).not.toContain('drive_credentials');
  expect(backupTables).not.toContain('drive_oauth_intents');
  await resetSchema();
  await restoreCanonical(env.DB, { manifest, chunks }, 'subject-a');
  expect(
    await env.DB.prepare(
      'SELECT root_id,root_state,auth_state,last_error FROM drive_connections',
    ).first(),
  ).toEqual({
    root_id: 'owner-root',
    root_state: 'VERIFY_REQUIRED',
    auth_state: 'REAUTH_REQUIRED',
    last_error: 'PRIVATE_CREDENTIAL_RECOVERY_REQUIRED',
  });
  expect(
    await env.DB.prepare(
      'SELECT COUNT(*) n FROM drive_credentials',
    ).first<number>('n'),
  ).toBe(0);
  expect(await env.DB.prepare('PRAGMA foreign_key_check').all()).toMatchObject({
    results: [],
  });
  expect(
    await env.DB.prepare(
      'SELECT reserved_remote_id,file_id,lease_owner,lease_until,fencing_token FROM export_state',
    ).first(),
  ).toEqual({
    reserved_remote_id: 'reserved-daily',
    file_id: 'reserved-daily',
    lease_owner: null,
    lease_until: null,
    fencing_token: 9,
  });
});
