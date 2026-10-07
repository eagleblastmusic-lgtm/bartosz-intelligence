import { expect, it } from 'vitest';
import { base64url } from '../../packages/core/src/auth/crypto.js';
import {
  importDriveWrappingKey,
  encryptDriveRefreshToken,
  decryptDriveRefreshToken,
  rotateDriveCredential,
  type DriveCredentialBinding,
} from '../../packages/core/src/drive/credentials.js';

const binding: DriveCredentialBinding = {
  owner_id: 'owner',
  connection_id: 'drive-1',
  account_subject: 'google-owner-subject',
  client_id: 'drive-client.apps.googleusercontent.com',
};
const secret = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
it('uses randomized authenticated encryption, a non-exportable external key and no plaintext in stored envelope', async () => {
  const key = await importDriveWrappingKey('wrapping-v1', secret()),
    token = 'synthetic-refresh-credential';
  const a = await encryptDriveRefreshToken(token, binding, key),
    b = await encryptDriveRefreshToken(token, binding, key);
  expect(a.iv).not.toBe(b.iv);
  expect(a.ciphertext).not.toBe(b.ciphertext);
  expect(JSON.stringify(a)).not.toContain(token);
  expect(await decryptDriveRefreshToken(a, binding, key)).toBe(token);
  expect(
    await decryptDriveRefreshToken(JSON.parse(JSON.stringify(b)), binding, key),
  ).toBe(token);
  await expect(crypto.subtle.exportKey('raw', key.key)).rejects.toThrow();
});
it('rejects cross-owner, connection, account and OAuth client swaps, wrong key, tampering and foreign envelope version', async () => {
  const key = await importDriveWrappingKey('wrapping-v1', secret());
  const envelope = await encryptDriveRefreshToken('synthetic', binding, key);
  for (const field of Object.keys(binding) as (keyof DriveCredentialBinding)[])
    await expect(
      decryptDriveRefreshToken(
        envelope,
        { ...binding, [field]: 'foreign' },
        key,
      ),
    ).rejects.toThrow('DRIVE_CREDENTIAL_DENIED');
  const other = await importDriveWrappingKey('wrapping-v1', secret());
  await expect(
    decryptDriveRefreshToken(envelope, binding, other),
  ).rejects.toThrow('DRIVE_CREDENTIAL_DENIED');
  for (const edit of [
    {
      ciphertext:
        (envelope.ciphertext[0] === 'A' ? 'B' : 'A') +
        envelope.ciphertext.slice(1),
    },
    { iv: 'AAAAAAAAAAAAAAAA' },
    { key_id: 'foreign' },
    { version: 'future' },
    { ciphertext: 'A'.repeat(10945) },
    { ciphertext: '' },
    { iv: 'bad' },
    { token: 'unexpected-plaintext-field' },
  ])
    await expect(
      decryptDriveRefreshToken(
        { ...envelope, ...edit } as typeof envelope,
        binding,
        key,
      ),
    ).rejects.toThrow('DRIVE_CREDENTIAL_DENIED');
});
it('rotates only with an authenticated old envelope and remains recoverable with the new external key', async () => {
  const previous = await importDriveWrappingKey('key-v1', secret()),
    next = await importDriveWrappingKey('key-v2', secret());
  const original = await encryptDriveRefreshToken(
    'synthetic',
    binding,
    previous,
  );
  const rotated = await rotateDriveCredential(
    original,
    binding,
    previous,
    next,
  );
  expect(rotated.key_id).toBe('key-v2');
  expect(rotated).not.toEqual(original);
  expect(await decryptDriveRefreshToken(rotated, binding, next)).toBe(
    'synthetic',
  );
  await expect(
    decryptDriveRefreshToken(rotated, binding, previous),
  ).rejects.toThrow('DRIVE_CREDENTIAL_DENIED');
  expect(await decryptDriveRefreshToken(original, binding, previous)).toBe(
    'synthetic',
  );
});
it('rejects missing/short wrapping material and unsafe oversized tokens using only fixed redacted errors', async () => {
  for (const material of ['', 'secret', 'A'.repeat(44), '*'.repeat(43)])
    await expect(importDriveWrappingKey('v1', material)).rejects.toThrow(
      'DRIVE_CREDENTIAL_DENIED',
    );
  const key = await importDriveWrappingKey('v1', secret());
  for (const token of ['', 'token\nprivate', 'x'.repeat(8193)])
    await expect(encryptDriveRefreshToken(token, binding, key)).rejects.toThrow(
      'DRIVE_CREDENTIAL_DENIED',
    );
  const maximum = 'x'.repeat(8192),
    encrypted = await encryptDriveRefreshToken(maximum, binding, key);
  expect(await decryptDriveRefreshToken(encrypted, binding, key)).toBe(maximum);
});
