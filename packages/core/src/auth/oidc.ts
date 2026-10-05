import { base64url, decode64, randomToken, sha256 } from './crypto.js';
import type { Database } from '../db/boundary.js';

export type OidcFailureReason =
  | 'INPUT'
  | 'STATE_OR_BROWSER'
  | 'TOKEN_FORMAT'
  | 'TOKEN_ALGORITHM'
  | 'SIGNING_KEY'
  | 'SIGNATURE'
  | 'CLAIMS'
  | 'NONCE'
  | 'TOKEN_EXCHANGE'
  | 'TOKEN_CLIENT_REJECTED'
  | 'TOKEN_GRANT_REJECTED'
  | 'TOKEN_TRANSPORT'
  | 'KEYS_UNAVAILABLE';
// A fixed diagnostic enum is safe to expose; provider bodies and credentials are not.
export class OidcFailure extends Error {
  constructor(
    code: string,
    readonly reason: OidcFailureReason,
  ) {
    super(code);
  }
}
function parseTokenJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    throw new OidcFailure('OIDC_DENIED', 'TOKEN_FORMAT');
  }
}

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
  bootstrap = false,
) {
  if (
    !config.clientId ||
    (!config.ownerSubject && !bootstrap) ||
    token.length > 16384
  )
    throw new OidcFailure('OIDC_DENIED', 'INPUT');
  const parts = token.split('.');
  if (parts.length !== 3) throw new OidcFailure('OIDC_DENIED', 'TOKEN_FORMAT');
  const header = parseTokenJson(new TextDecoder().decode(decode64(parts[0]!)));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string')
    throw new OidcFailure('OIDC_DENIED', 'TOKEN_ALGORITHM');
  const jwk = keys.find(
    (k) =>
      k.kid === header.kid && k.kty === 'RSA' && (!k.alg || k.alg === 'RS256'),
  );
  if (!jwk) throw new OidcFailure('OIDC_DENIED', 'SIGNING_KEY');
  const key = await crypto.subtle
    .importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    .catch(() => {
      throw new OidcFailure('OIDC_DENIED', 'SIGNING_KEY');
    });
  if (
    !(await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      decode64(parts[2]!),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    ))
  )
    throw new OidcFailure('OIDC_DENIED', 'SIGNATURE');
  const claims = parseTokenJson(new TextDecoder().decode(decode64(parts[1]!)));
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
    typeof claims.sub !== 'string' ||
    !claims.sub ||
    claims.sub.length > 256 ||
    (!bootstrap && claims.sub !== config.ownerSubject)
  )
    throw new OidcFailure('OIDC_DENIED', 'CLAIMS');
  if (
    typeof claims.nonce !== 'string' ||
    (await sha256(claims.nonce)) !== nonceHash
  )
    throw new OidcFailure('OIDC_DENIED', 'NONCE');
  return {
    issuer: 'https://accounts.google.com',
    subject: claims.sub as string,
  };
}

export async function beginLogin(
  db: Database,
  config: OidcConfig,
  now: Date,
  purpose: 'LOGIN' | 'BOOTSTRAP' = 'LOGIN',
) {
  if (
    !config.clientId ||
    !config.clientSecret ||
    (!config.ownerSubject && purpose !== 'BOOTSTRAP') ||
    new URL(config.redirectUri).protocol !== 'https:'
  )
    throw new Error('OIDC_CONFIG_REQUIRED');
  const state = randomToken(),
    nonce = randomToken(),
    verifier = randomToken(),
    browser = randomToken();
  await db
    .prepare(
      'INSERT INTO oidc_login_intents(state_hash,nonce_hash,verifier,browser_hash,expires_at,purpose) VALUES(?,?,?,?,?,?)',
    )
    .bind(
      await sha256(state),
      await sha256(nonce),
      verifier,
      await sha256(browser),
      new Date(now.getTime() + 600000).toISOString(),
      purpose,
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
  purpose: 'LOGIN' | 'BOOTSTRAP' = 'LOGIN',
) {
  if (
    !state ||
    !code ||
    !browser ||
    state.length > 128 ||
    code.length > 4096 ||
    browser.length > 128
  )
    throw new OidcFailure('OIDC_DENIED', 'INPUT');
  const intent = await db
    .prepare(
      `UPDATE oidc_login_intents SET consumed_at=?
    WHERE state_hash=? AND browser_hash=? AND consumed_at IS NULL AND expires_at>? AND purpose=?
    RETURNING nonce_hash,verifier`,
    )
    .bind(
      now.toISOString(),
      await sha256(state),
      await sha256(browser),
      now.toISOString(),
      purpose,
    )
    .first<{ nonce_hash: string; verifier: string }>();
  if (!intent) throw new OidcFailure('OIDC_DENIED', 'STATE_OR_BROWSER');
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
  }).catch(() => {
    throw new OidcFailure('OIDC_EXCHANGE_FAILED', 'TOKEN_TRANSPORT');
  });
  if (!response.ok) {
    // Consume at most a bounded error body and retain only known error categories.
    const raw = await response.text();
    let category: unknown;
    if (raw.length <= 32768) {
      try {
        category = JSON.parse(raw).error;
      } catch {
        /* unknown provider format */
      }
    }
    throw new OidcFailure(
      'OIDC_EXCHANGE_FAILED',
      category === 'invalid_client'
        ? 'TOKEN_CLIENT_REJECTED'
        : category === 'invalid_grant'
          ? 'TOKEN_GRANT_REJECTED'
          : 'TOKEN_EXCHANGE',
    );
  }
  const body = await response.text();
  if (body.length > 32768) throw new OidcFailure('OIDC_DENIED', 'TOKEN_FORMAT');
  const token: unknown = parseTokenJson(body)?.id_token;
  if (typeof token !== 'string')
    throw new OidcFailure('OIDC_DENIED', 'TOKEN_FORMAT');
  const keyResponse = await fetcher(
    'https://www.googleapis.com/oauth2/v3/certs',
    { redirect: 'error', signal: AbortSignal.timeout(10000) },
  ).catch(() => {
    throw new OidcFailure('OIDC_KEYS_UNAVAILABLE', 'KEYS_UNAVAILABLE');
  });
  if (!keyResponse.ok)
    throw new OidcFailure('OIDC_KEYS_UNAVAILABLE', 'KEYS_UNAVAILABLE');
  const keyBody = await keyResponse.text();
  if (keyBody.length > 32768)
    throw new OidcFailure('OIDC_DENIED', 'TOKEN_FORMAT');
  const keys = parseTokenJson(keyBody)?.keys;
  if (!Array.isArray(keys))
    throw new OidcFailure('OIDC_DENIED', 'TOKEN_FORMAT');
  return verifyGoogleToken(
    token,
    keys,
    config,
    intent.nonce_hash,
    now.getTime() / 1000,
    purpose === 'BOOTSTRAP',
  );
}
