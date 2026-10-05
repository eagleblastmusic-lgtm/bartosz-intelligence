import { it, expect, beforeAll } from 'vitest';
import { verifyGoogleToken } from '../../packages/core/src/auth/oidc.js';
import type { GoogleKey } from '../../packages/core/src/auth/oidc.js';
import { base64url, sha256 } from '../../packages/core/src/auth/crypto.js';
let privateKey: CryptoKey, publicKey: GoogleKey;
beforeAll(async () => {
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
  privateKey = pair.privateKey;
  publicKey = {
    ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    kty: 'RSA',
    kid: 'fixture',
  };
});
const config = {
  clientId: 'fixture-client',
  clientSecret: 'fixture-only',
  redirectUri: 'https://bi.example/callback',
  ownerSubject: 'owner-subject',
};
const claims = {
  iss: 'https://accounts.google.com',
  aud: 'fixture-client',
  sub: 'owner-subject',
  nonce: 'nonce',
  exp: 2000,
  iat: 900,
};
it('unbound subject is denied by default; bootstrap still verifies signature, nonce and audience', async () => {
  const value = await token(claims),
    unbound = { ...config, ownerSubject: '' },
    nonce = await sha256('nonce');
  await expect(
    verifyGoogleToken(value, [publicKey], unbound, nonce, 1000),
  ).rejects.toThrow('OIDC_DENIED');
  expect(
    await verifyGoogleToken(value, [publicKey], unbound, nonce, 1000, true),
  ).toMatchObject({ subject: 'owner-subject' });
  await expect(
    verifyGoogleToken(
      await token({ ...claims, aud: 'wrong' }),
      [publicKey],
      unbound,
      nonce,
      1000,
      true,
    ),
  ).rejects.toThrow('OIDC_DENIED');
  await expect(
    verifyGoogleToken(
      await token({ ...claims, sub: '' }),
      [publicKey],
      unbound,
      nonce,
      1000,
      true,
    ),
  ).rejects.toThrow('OIDC_DENIED');
});
async function token(payload: object, algorithm = 'RS256') {
  const encode = (value: object) =>
    base64url(new TextEncoder().encode(JSON.stringify(value)));
  const body = `${encode({ alg: algorithm, kid: 'fixture' })}.${encode(payload)}`;
  return `${body}.${base64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(body))))}`;
}
it('verifies signature and canonicalizes Google issuer', async () => {
  expect(
    await verifyGoogleToken(
      await token(claims),
      [publicKey],
      config,
      await sha256('nonce'),
      1000,
    ),
  ).toEqual({
    issuer: 'https://accounts.google.com',
    subject: 'owner-subject',
  });
});
it.each([
  { iss: 'https://evil.example' },
  { aud: 'other' },
  { exp: 999 },
  { nonce: 'other' },
  { sub: 'unknown' },
  { iat: 1200 },
  { azp: 'other' },
])('rejects altered OIDC claim %j', async (delta) => {
  await expect(
    verifyGoogleToken(
      await token({ ...claims, ...delta }),
      [publicKey],
      config,
      await sha256('nonce'),
      1000,
    ),
  ).rejects.toThrow('OIDC_DENIED');
});
it('rejects unsupported alg, unknown signing key and altered signature', async () => {
  await expect(
    verifyGoogleToken(
      await token(claims, 'none'),
      [publicKey],
      config,
      await sha256('nonce'),
      1000,
    ),
  ).rejects.toThrow('OIDC_DENIED');
  await expect(
    verifyGoogleToken(
      await token(claims),
      [],
      config,
      await sha256('nonce'),
      1000,
    ),
  ).rejects.toThrow('OIDC_DENIED');
  const signed = await token(claims);
  const pieces = signed.split('.');
  pieces[2] = (pieces[2]![0] === 'A' ? 'B' : 'A') + pieces[2]!.slice(1);
  await expect(
    verifyGoogleToken(
      pieces.join('.'),
      [publicKey],
      config,
      await sha256('nonce'),
      1000,
    ),
  ).rejects.toThrow('OIDC_DENIED');
});
