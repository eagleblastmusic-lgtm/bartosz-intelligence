import { env } from 'cloudflare:workers';
import { beforeEach, it, expect } from 'vitest';
import { resetCore } from './core-fixture.js';
import { beginLogin, finishLogin } from '../../packages/core/src/auth/oidc.js';
import { base64url } from '../../packages/core/src/auth/crypto.js';
const now = new Date('2026-10-05T17:30:00Z');
const config = {
  clientId: 'fixture-client',
  clientSecret: 'fixture-secret',
  redirectUri: 'https://bi.example/api/v1/auth/callback',
  ownerSubject: 'subject-a',
};
beforeEach(async () => {
  await resetCore();
});
it('workerd verifies a signed token with Google-shaped public JWK and consumes the browser intent once', async () => {
  const login = await beginLogin(env.DB, config, now),
    url = new URL(login.url);
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
  if (!('publicKey' in pair)) throw new Error('FIXTURE_RSA_KEY_PAIR_REQUIRED');
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  if (!('n' in exported) || !('e' in exported))
    throw new Error('FIXTURE_RSA_JWK_REQUIRED');
  const header = base64url(
    new TextEncoder().encode(
      JSON.stringify({ alg: 'RS256', kid: 'fixture-key' }),
    ),
  );
  const claims = base64url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: config.clientId,
        sub: config.ownerSubject,
        nonce: url.searchParams.get('nonce'),
        iat: now.getTime() / 1000,
        exp: now.getTime() / 1000 + 600,
      }),
    ),
  );
  const unsigned = header + '.' + claims;
  const signed =
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
  let calls = 0;
  const fetcher: typeof fetch = async (input) => {
    calls++;
    if (input === 'https://oauth2.googleapis.com/token')
      return Response.json({ id_token: signed });
    expect(input).toBe('https://www.googleapis.com/oauth2/v3/certs');
    return Response.json({
      keys: [
        {
          kid: 'fixture-key',
          kty: 'RSA',
          alg: 'RS256',
          use: 'sig',
          n: exported.n,
          e: exported.e,
        },
      ],
    });
  };
  const browser = login.browserCookie.split(';')[0]!.split('=')[1]!;
  expect(
    await finishLogin(
      env.DB,
      config,
      url.searchParams.get('state')!,
      'fixture-code',
      browser,
      now,
      fetcher,
    ),
  ).toEqual({
    issuer: 'https://accounts.google.com',
    subject: config.ownerSubject,
  });
  expect(calls).toBe(2);
  await expect(
    finishLogin(
      env.DB,
      config,
      url.searchParams.get('state')!,
      'fixture-code',
      browser,
      now,
      fetcher,
    ),
  ).rejects.toMatchObject({ reason: 'STATE_OR_BROWSER' });
  expect(calls).toBe(2);
});
it('login binds state/nonce/PKCE to the initiating browser, never requests Drive scopes', async () => {
  const login = await beginLogin(env.DB, config, now);
  const url = new URL(login.url);
  expect(url.searchParams.get('scope')).toBe('openid');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('code_challenge')).toHaveLength(43);
  const failFetch: typeof fetch = async () => {
    throw new Error('UNEXPECTED_FETCH');
  };
  await expect(
    finishLogin(
      env.DB,
      config,
      url.searchParams.get('state')!,
      'code',
      'wrong-browser',
      now,
      failFetch,
    ),
  ).rejects.toThrow('OIDC_DENIED');
  const browser = login.browserCookie.split(';')[0]!.split('=')[1]!;
  await expect(
    finishLogin(env.DB, config, 'wrong-state', 'code', browser, now, failFetch),
  ).rejects.toThrow('OIDC_DENIED');
  const fetcher: typeof fetch = async (_input, init) => {
    const body = new URLSearchParams(init?.body as URLSearchParams);
    expect(body.get('code_verifier')).toHaveLength(43);
    return new Response('{}', { status: 400 });
  };
  await expect(
    finishLogin(
      env.DB,
      config,
      url.searchParams.get('state')!,
      'code',
      browser,
      now,
      fetcher,
    ),
  ).rejects.toThrow('OIDC_EXCHANGE_FAILED');
  await expect(
    finishLogin(
      env.DB,
      config,
      url.searchParams.get('state')!,
      'code',
      browser,
      now,
      failFetch,
    ),
  ).rejects.toThrow('OIDC_DENIED');
});
it('expired state never reaches provider; incomplete config fails closed', async () => {
  await expect(
    beginLogin(env.DB, { ...config, clientId: '' }, now),
  ).rejects.toThrow('OIDC_CONFIG_REQUIRED');
  const login = await beginLogin(env.DB, config, now);
  const failFetch: typeof fetch = async () => {
    throw new Error('UNEXPECTED_FETCH');
  };
  await expect(
    finishLogin(
      env.DB,
      config,
      new URL(login.url).searchParams.get('state')!,
      'code',
      login.browserCookie.split(';')[0]!.split('=')[1]!,
      new Date(now.getTime() + 600001),
      failFetch,
    ),
  ).rejects.toThrow('OIDC_DENIED');
});
it.each([
  ['invalid_client', 'TOKEN_CLIENT_REJECTED'],
  ['invalid_grant', 'TOKEN_GRANT_REJECTED'],
  ['unknown-provider-error', 'TOKEN_EXCHANGE'],
])(
  'reports only a fixed category for provider %s without retaining raw diagnostics',
  async (providerError, reason) => {
    const login = await beginLogin(env.DB, config, now);
    const failure = await finishLogin(
      env.DB,
      config,
      new URL(login.url).searchParams.get('state')!,
      'fixture-code',
      login.browserCookie.split(';')[0]!.split('=')[1]!,
      now,
      async () =>
        new Response(
          JSON.stringify({
            error: providerError,
            error_description: 'fixture-sensitive-detail',
          }),
          { status: 400 },
        ),
    ).catch((error) => error);
    expect(failure).toMatchObject({ message: 'OIDC_EXCHANGE_FAILED', reason });
    expect(JSON.stringify(failure)).not.toContain('fixture-sensitive-detail');
    expect(JSON.stringify(failure)).not.toContain(config.clientSecret);
  },
);
