import { base64url, decode64, randomToken, sha256 } from './crypto.js';
import type { Database } from '../db/boundary.js';

export interface OidcConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  ownerSubject: string;
}
export interface GoogleKey {
  kid: string;
  kty: string;
  alg?: string;
  n?: string;
  e?: string;
  use?: string;
}
export async function verifyGoogleToken(
  token: string,
  keys: GoogleKey[],
  config: OidcConfig,
  nonceHash: string,
  now: number,
) {
  if (!config.clientId || !config.ownerSubject || token.length > 16384)
    throw new Error('OIDC_DENIED');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('OIDC_DENIED');
  const header = JSON.parse(new TextDecoder().decode(decode64(parts[0]!)));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string')
    throw new Error('OIDC_DENIED');
  const jwk = keys.find(
    (k) =>
      k.kid === header.kid && k.kty === 'RSA' && (!k.alg || k.alg === 'RS256'),
  );
  if (!jwk) throw new Error('OIDC_DENIED');
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  if (
    !(await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      decode64(parts[2]!),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    ))
  )
    throw new Error('OIDC_DENIED');
  const claims = JSON.parse(new TextDecoder().decode(decode64(parts[1]!)));
  if (
    !['https://accounts.google.com', 'accounts.google.com'].includes(
      claims.iss,
    ) ||
    claims.aud !== config.clientId ||
    (claims.azp !== undefined && claims.azp !== config.clientId) ||
    typeof claims.exp !== 'number' ||
    claims.exp <= now ||
    typeof claims.iat !== 'number' ||
    claims.iat > now + 60 ||
    claims.iat > claims.exp ||
    claims.sub !== config.ownerSubject ||
    typeof claims.nonce !== 'string' ||
    (await sha256(claims.nonce)) !== nonceHash
  )
    throw new Error('OIDC_DENIED');
  return {
    issuer: 'https://accounts.google.com',
    subject: claims.sub as string,
  };
}

export async function beginLogin(db: Database, config: OidcConfig, now: Date) {
  if (
    !config.clientId ||
    !config.clientSecret ||
    !config.ownerSubject ||
    new URL(config.redirectUri).protocol !== 'https:'
  )
    throw new Error('OIDC_CONFIG_REQUIRED');
  const state = randomToken(),
    nonce = randomToken(),
    verifier = randomToken(),
    browser = randomToken();
  await db
    .prepare(
      'INSERT INTO oidc_login_intents(state_hash,nonce_hash,verifier,browser_hash,expires_at) VALUES(?,?,?,?,?)',
    )
    .bind(
      await sha256(state),
      await sha256(nonce),
      verifier,
      await sha256(browser),
      new Date(now.getTime() + 600000).toISOString(),
    )
    .run();
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid',
    state,
    nonce,
    code_challenge: base64url(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(verifier),
        ),
      ),
    ),
    code_challenge_method: 'S256',
  }).toString();
  return {
    url: url.toString(),
    browserCookie: `__Host-bi-login=${browser}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
  };
}

export async function finishLogin(
  db: Database,
  config: OidcConfig,
  state: string,
  code: string,
  browser: string,
  now: Date,
  fetcher: typeof fetch = fetch,
) {
  if (
    !state ||
    !code ||
    !browser ||
    state.length > 128 ||
    code.length > 4096 ||
    browser.length > 128
  )
    throw new Error('OIDC_DENIED');
  const intent = await db
    .prepare(
      `UPDATE oidc_login_intents SET consumed_at=?
    WHERE state_hash=? AND browser_hash=? AND consumed_at IS NULL AND expires_at>?
    RETURNING nonce_hash,verifier`,
    )
    .bind(
      now.toISOString(),
      await sha256(state),
      await sha256(browser),
      now.toISOString(),
    )
    .first<{ nonce_hash: string; verifier: string }>();
  if (!intent) throw new Error('OIDC_DENIED');
  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: intent.verifier,
    }),
  });
  if (!response.ok) throw new Error('OIDC_EXCHANGE_FAILED');
  const body = await response.text();
  if (body.length > 32768) throw new Error('OIDC_DENIED');
  const token: unknown = JSON.parse(body).id_token;
  if (typeof token !== 'string') throw new Error('OIDC_DENIED');
  const keyResponse = await fetcher(
    'https://www.googleapis.com/oauth2/v3/certs',
    { redirect: 'error', signal: AbortSignal.timeout(10000) },
  );
  if (!keyResponse.ok) throw new Error('OIDC_KEYS_UNAVAILABLE');
  const keyBody = await keyResponse.text();
  if (keyBody.length > 32768) throw new Error('OIDC_DENIED');
  const keys = JSON.parse(keyBody).keys;
  if (!Array.isArray(keys)) throw new Error('OIDC_DENIED');
  return verifyGoogleToken(
    token,
    keys,
    config,
    intent.nonce_hash,
    now.getTime() / 1000,
  );
}
