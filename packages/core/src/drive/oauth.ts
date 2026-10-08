import { base64url, randomToken, sha256 } from '../auth/crypto.js';
import { verifyGoogleToken, type GoogleKey } from '../auth/oidc.js';
import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { fetchWithoutRedirect } from '../http/no-redirect.js';
import {
  encryptDriveRefreshToken,
  decryptDriveRefreshToken,
  type EncryptedDriveCredential,
  type DriveWrappingKey,
} from './credentials.js';

/** Server adapter only. Bearer credentials must never reach owner APIs, logs,
 * evidence or exports. Access tokens are not durably cached in Core. */
export async function refreshDriveAccess(
  db: Database,
  context: AccessContext,
  config: DriveOAuthConfig,
  wrapping: DriveWrappingKey,
  connectionId: string,
  now: Date,
  fetcher: typeof fetch = fetch,
) {
  assertContext(context);
  context.requireOwnerOrTask('DRIVE_EXPORT');
  configRedirect(config);
  if (
    !Number.isFinite(now.getTime()) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(connectionId)
  )
    failure('CONFIG');
  const current = await db
    .prepare(
      `SELECT c.account_subject,c.client_id,c.revision,c.scopes_json,k.envelope_json FROM drive_connections c JOIN drive_credentials k USING(owner_id,connection_id) WHERE c.owner_id=? AND c.connection_id=? AND c.auth_state='CONNECTED'`,
    )
    .bind(context.ownerId, connectionId)
    .first<{
      account_subject: string;
      client_id: string;
      revision: number;
      scopes_json: string;
      envelope_json: string;
    }>();
  if (!current) failure('REFRESH_REQUIRED');
  if (current.client_id !== config.client_id) failure('CONFIG');
  const binding = {
    owner_id: context.ownerId,
    connection_id: connectionId,
    account_subject: current.account_subject,
    client_id: current.client_id,
  };
  let refreshToken: string;
  try {
    refreshToken = await decryptDriveRefreshToken(
      JSON.parse(current.envelope_json) as EncryptedDriveCredential,
      binding,
      wrapping,
    );
  } catch {
    return failure('REFRESH_REQUIRED');
  }
  const response = await fetchWithoutRedirect(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      body: new URLSearchParams({
        client_id: config.client_id,
        client_secret: config.client_secret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    },
    fetcher,
  ).catch(() => failure('TOKEN_TRANSPORT'));
  if (!response.ok) {
    const rejected =
      response.status === 400 &&
      (await boundedJson(response)).error === 'invalid_grant';
    if (rejected) {
      await db
        .prepare(
          `UPDATE drive_connections SET auth_state='REAUTH_REQUIRED',last_error='REFRESH_REJECTED',updated_at=?,revision=revision+1 WHERE owner_id=? AND connection_id=? AND revision=?`,
        )
        .bind(
          now.toISOString(),
          context.ownerId,
          connectionId,
          current.revision,
        )
        .run();
      failure('REFRESH_REJECTED');
    }
    await response.body?.cancel();
    failure('TOKEN_EXCHANGE');
  }
  const grant = await boundedJson(response);
  if (
    grant.token_type !== 'Bearer' ||
    typeof grant.access_token !== 'string' ||
    !/^[\x21-\x7e]{1,8192}$/.test(grant.access_token) ||
    typeof grant.expires_in !== 'number' ||
    !Number.isSafeInteger(grant.expires_in) ||
    grant.expires_in < 1 ||
    grant.expires_in > 86400
  )
    failure('TOKEN_FORMAT');
  const originalScopes = JSON.parse(current.scopes_json) as string[];
  const scopes =
    grant.scope === undefined
      ? originalScopes
      : typeof grant.scope === 'string'
        ? [...new Set(grant.scope.split(/\s+/).filter(Boolean))].sort()
        : [];
  if (
    !scopes.includes(driveFileScope) ||
    !scopes.includes('openid') ||
    scopes.some((scope) => !['openid', driveFileScope].includes(scope))
  )
    failure('SCOPES');
  const envelope =
    grant.refresh_token === undefined
      ? current.envelope_json
      : JSON.stringify(
          await encryptDriveRefreshToken(
            typeof grant.refresh_token === 'string' ? grant.refresh_token : '',
            binding,
            wrapping,
          ),
        );
  const receipt = crypto.randomUUID();
  const saved = await db.batch([
    db
      .prepare(
        `UPDATE drive_connections SET last_refresh_at=?,last_refresh_receipt=?,last_error=NULL,updated_at=?,revision=revision+1 WHERE owner_id=? AND connection_id=? AND revision=? AND auth_state='CONNECTED' RETURNING revision`,
      )
      .bind(
        now.toISOString(),
        receipt,
        now.toISOString(),
        context.ownerId,
        connectionId,
        current.revision,
      ),
    db
      .prepare(
        `UPDATE drive_credentials SET envelope_json=?,updated_at=? WHERE owner_id=? AND connection_id=? AND EXISTS(SELECT 1 FROM drive_connections c WHERE c.owner_id=drive_credentials.owner_id AND c.connection_id=drive_credentials.connection_id AND c.last_refresh_receipt=?)`,
      )
      .bind(
        envelope,
        now.toISOString(),
        context.ownerId,
        connectionId,
        receipt,
      ),
  ]);
  if (!saved[0]?.results?.length || saved[1]?.meta.changes !== 1)
    failure('CONNECTION_CHANGED');
  return {
    access_token: grant.access_token,
    expires_at: new Date(now.getTime() + grant.expires_in * 1000).toISOString(),
    scopes,
  };
}

export const driveFileScope = 'https://www.googleapis.com/auth/drive.file';
export const driveCallbackPath = '/api/v1/connections/drive/callback';
export interface DriveOAuthConfig {
  client_id: string;
  client_secret: string;
  app_origin: string;
  publishing_status?: 'TESTING' | 'PRODUCTION' | 'INTERNAL';
}
export type DriveOAuthReason =
  | 'CONFIG'
  | 'STATE_OR_BROWSER'
  | 'TOKEN_TRANSPORT'
  | 'TOKEN_EXCHANGE'
  | 'TOKEN_FORMAT'
  | 'SCOPES'
  | 'OWNER_ACCOUNT'
  | 'REFRESH_REQUIRED'
  | 'REFRESH_REJECTED'
  | 'ROOT_ACCESS'
  | 'CONNECTION_CHANGED';
export class DriveOAuthFailure extends Error {
  constructor(readonly reason: DriveOAuthReason) {
    super('DRIVE_AUTH_DENIED');
  }
}
function failure(reason: DriveOAuthReason): never {
  throw new DriveOAuthFailure(reason);
}
function configRedirect(config: DriveOAuthConfig) {
  try {
    const origin = new URL(config.app_origin);
    if (
      origin.protocol !== 'https:' ||
      origin.origin !== config.app_origin ||
      !config.client_id ||
      config.client_id.length > 256 ||
      !config.client_secret ||
      config.client_secret.length > 4096 ||
      (config.publishing_status !== undefined &&
        !['TESTING', 'PRODUCTION', 'INTERNAL'].includes(
          config.publishing_status,
        ))
    )
      failure('CONFIG');
    return origin.origin + driveCallbackPath;
  } catch {
    return failure('CONFIG');
  }
}
async function boundedJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return failure('TOKEN_FORMAT');
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.length;
      if (total > 32768) {
        await reader.cancel();
        return failure('TOKEN_FORMAT');
      }
      parts.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    );
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return failure('TOKEN_FORMAT');
    return value as Record<string, unknown>;
  } catch {
    return failure('TOKEN_FORMAT');
  } finally {
    reader.releaseLock();
  }
}
export async function beginDriveAuthorization(
  db: Database,
  context: AccessContext,
  config: DriveOAuthConfig,
  wrapping: DriveWrappingKey,
  now: Date,
  connectionId?: string,
) {
  assertContext(context);
  context.requireOwner();
  const redirect = configRedirect(config);
  if (
    !Number.isFinite(now.getTime()) ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(wrapping.key_id)
  )
    failure('CONFIG');
  const id = connectionId ?? crypto.randomUUID();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) failure('CONFIG');
  const existing = await db
    .prepare(
      'SELECT revision,client_id FROM drive_connections WHERE owner_id=? AND connection_id=?',
    )
    .bind(context.ownerId, id)
    .first<{ revision: number; client_id: string }>();
  if (connectionId && (!existing || existing.client_id !== config.client_id))
    failure('CONNECTION_CHANGED');
  const state = randomToken(),
    nonce = randomToken(),
    browser = randomToken(),
    verifier = randomToken();
  await db
    .prepare(
      `INSERT INTO drive_oauth_intents(state_hash,owner_id,connection_id,expected_revision,client_id,redirect_uri,wrapping_key_id,nonce_hash,verifier,browser_hash,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      await sha256(state),
      context.ownerId,
      id,
      existing?.revision ?? 0,
      config.client_id,
      redirect,
      wrapping.key_id,
      await sha256(nonce),
      verifier,
      await sha256(browser),
      new Date(now.getTime() + 600000).toISOString(),
    )
    .run();
  const challenge = base64url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    ),
  );
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: config.client_id,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'openid ' + driveFileScope,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return {
    connection_id: id,
    url: url.href,
    browser_cookie: `__Host-bi-drive=${browser}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
  };
}

export async function finishDriveAuthorization(
  db: Database,
  context: AccessContext,
  config: DriveOAuthConfig,
  wrapping: DriveWrappingKey,
  input: { state: string; code: string; browser: string },
  now: Date,
  fetcher: typeof fetch = fetch,
) {
  assertContext(context);
  context.requireOwner();
  const redirect = configRedirect(config);
  if (
    !Number.isFinite(now.getTime()) ||
    !input.state ||
    input.state.length > 128 ||
    !input.browser ||
    input.browser.length > 128 ||
    !input.code ||
    input.code.length > 4096
  )
    failure('STATE_OR_BROWSER');
  const intent = await db
    .prepare(
      `UPDATE drive_oauth_intents SET consumed_at=? WHERE state_hash=? AND owner_id=? AND browser_hash=? AND client_id=? AND redirect_uri=? AND wrapping_key_id=? AND consumed_at IS NULL AND expires_at>? RETURNING connection_id,expected_revision,nonce_hash,verifier`,
    )
    .bind(
      now.toISOString(),
      await sha256(input.state),
      context.ownerId,
      await sha256(input.browser),
      config.client_id,
      redirect,
      wrapping.key_id,
      now.toISOString(),
    )
    .first<{
      connection_id: string;
      expected_revision: number;
      nonce_hash: string;
      verifier: string;
    }>();
  if (!intent) failure('STATE_OR_BROWSER');
  const owner = await db
    .prepare(
      'SELECT subject FROM owner_users WHERE owner_id=? AND allowlisted=1',
    )
    .bind(context.ownerId)
    .first<{ subject: string }>();
  if (!owner) failure('OWNER_ACCOUNT');
  const response = await fetchWithoutRedirect(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      body: new URLSearchParams({
        client_id: config.client_id,
        client_secret: config.client_secret,
        redirect_uri: redirect,
        grant_type: 'authorization_code',
        code: input.code,
        code_verifier: intent.verifier,
      }),
    },
    fetcher,
  ).catch(() => failure('TOKEN_TRANSPORT'));
  if (!response.ok) {
    await response.body?.cancel();
    failure('TOKEN_EXCHANGE');
  }
  const token = await boundedJson(response);
  if (
    typeof token.id_token !== 'string' ||
    typeof token.refresh_token !== 'string' ||
    !token.refresh_token
  )
    failure('REFRESH_REQUIRED');
  if (
    token.token_type !== 'Bearer' ||
    typeof token.scope !== 'string' ||
    typeof token.access_token !== 'string' ||
    !/^[\x21-\x7e]{1,8192}$/.test(token.access_token) ||
    typeof token.expires_in !== 'number' ||
    !Number.isSafeInteger(token.expires_in) ||
    token.expires_in < 1 ||
    token.expires_in > 86400
  )
    failure('TOKEN_FORMAT');
  const scopes = [...new Set(token.scope.split(/\s+/).filter(Boolean))].sort();
  if (
    !scopes.includes(driveFileScope) ||
    !scopes.includes('openid') ||
    scopes.some((scope) => !['openid', driveFileScope].includes(scope))
  )
    failure('SCOPES');
  const keysResponse = await fetchWithoutRedirect(
    'https://www.googleapis.com/oauth2/v3/certs',
    { signal: AbortSignal.timeout(10000) },
    fetcher,
  ).catch(() => failure('TOKEN_TRANSPORT'));
  if (!keysResponse.ok) {
    await keysResponse.body?.cancel();
    failure('TOKEN_EXCHANGE');
  }
  const keys = (await boundedJson(keysResponse)).keys;
  if (!Array.isArray(keys)) failure('TOKEN_FORMAT');
  const account = await verifyGoogleToken(
    token.id_token,
    keys as GoogleKey[],
    {
      clientId: config.client_id,
      clientSecret: config.client_secret,
      redirectUri: redirect,
      ownerSubject: owner.subject,
    },
    intent.nonce_hash,
    now.getTime() / 1000,
  ).catch(() => failure('OWNER_ACCOUNT'));
  const envelope = await encryptDriveRefreshToken(
    token.refresh_token,
    {
      owner_id: context.ownerId,
      connection_id: intent.connection_id,
      account_subject: account.subject,
      client_id: config.client_id,
    },
    wrapping,
  );
  const stateHash = await sha256(input.state);
  const persisted = await db.batch([
    db
      .prepare(
        `INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,publishing_state,revision,last_intent_hash,created_at,updated_at) SELECT ?,?,?,?,?,'CONNECTED',?,1,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM drive_connections WHERE owner_id=? AND connection_id=? AND revision=?)
      ON CONFLICT(owner_id,connection_id) DO UPDATE SET scopes_json=excluded.scopes_json,auth_state='CONNECTED',publishing_state=CASE WHEN excluded.publishing_state='UNKNOWN' THEN drive_connections.publishing_state ELSE excluded.publishing_state END,root_state=CASE WHEN drive_connections.root_id IS NULL THEN 'UNSELECTED' ELSE 'VERIFY_REQUIRED' END,revision=drive_connections.revision+1,last_intent_hash=excluded.last_intent_hash,updated_at=excluded.updated_at,last_error=NULL
      WHERE drive_connections.revision=? AND drive_connections.account_subject=excluded.account_subject AND drive_connections.client_id=excluded.client_id RETURNING revision`,
      )
      .bind(
        context.ownerId,
        intent.connection_id,
        account.subject,
        config.client_id,
        JSON.stringify(scopes),
        config.publishing_status ?? 'UNKNOWN',
        stateHash,
        now.toISOString(),
        now.toISOString(),
        intent.expected_revision,
        context.ownerId,
        intent.connection_id,
        intent.expected_revision,
        intent.expected_revision,
      ),
    db
      .prepare(
        `INSERT INTO drive_credentials(owner_id,connection_id,envelope_json,updated_at) SELECT owner_id,connection_id,?,? FROM drive_connections WHERE owner_id=? AND connection_id=? AND last_intent_hash=?
      ON CONFLICT(owner_id,connection_id) DO UPDATE SET envelope_json=excluded.envelope_json,updated_at=excluded.updated_at`,
      )
      .bind(
        JSON.stringify(envelope),
        now.toISOString(),
        context.ownerId,
        intent.connection_id,
        stateHash,
      ),
  ]);
  if (!persisted[0]?.results?.length || persisted[1]?.meta.changes !== 1)
    failure('CONNECTION_CHANGED');
  // Token transport results, ciphertext and account subject never reach the UI.
  return {
    connection_id: intent.connection_id,
    auth_state: 'CONNECTED' as const,
    scopes,
    offline_credential_present: true,
  };
}
