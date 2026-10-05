import { env } from 'cloudflare:workers';
import { beforeEach, it, expect } from 'vitest';
import { resetCore } from './core-fixture.js';
import { beginLogin, finishLogin } from '../../packages/core/src/auth/oidc.js';
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
