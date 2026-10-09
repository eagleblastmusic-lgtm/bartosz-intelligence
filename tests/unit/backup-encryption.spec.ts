import { expect, it } from 'vitest';
import {
  encryptCanonicalBackup,
  decryptCanonicalBackup,
} from '../../packages/core/src/backup/encryption.js';
const key = () =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
const id = '12345678-1234-1234-1234-123456789abc';
it('roundtrips a backup larger than the JavaScript argument limit', async () => {
  const recovery = await key(),
    bytes = new Uint8Array(1024 * 1024);
  bytes.fill(173);
  const envelope = await encryptCanonicalBackup(
    bytes,
    id,
    'recovery-v1',
    recovery,
  );
  // Compare every byte natively rather than constructing a million-element
  // matcher graph; equality still requires identical length and content.
  expect(
    Buffer.compare(await decryptCanonicalBackup(envelope, recovery), bytes),
  ).toBe(0);
});
it('roundtrips exact bytes with random IVs and no recovery key in envelope', async () => {
  const recovery = await key(),
    bytes = new TextEncoder().encode('{"canonical":"private źródło"}');
  const first = await encryptCanonicalBackup(
    bytes,
    id,
    'recovery-v1',
    recovery,
  );
  const second = await encryptCanonicalBackup(
    bytes,
    id,
    'recovery-v1',
    recovery,
  );
  expect(first.iv).not.toBe(second.iv);
  expect(first.ciphertext).not.toBe(second.ciphertext);
  expect(await decryptCanonicalBackup(first, recovery)).toEqual(bytes);
  expect(JSON.stringify(first)).not.toContain('private');
  expect(Object.keys(first)).not.toContain('key');
});
it('rejects wrong recovery key, modified ciphertext and substituted identity/hash', async () => {
  const recovery = await key(),
    envelope = await encryptCanonicalBackup(
      new TextEncoder().encode('private canonical'),
      id,
      'recovery-v1',
      recovery,
    );
  await expect(decryptCanonicalBackup(envelope, await key())).rejects.toThrow(
    'BACKUP_ENCRYPTION_DENIED',
  );
  for (const changed of [
    { ...envelope, key_id: 'recovery-v2' },
    { ...envelope, backup_id: 'abcdefab-1234-1234-1234-123456789abc' },
    { ...envelope, plaintext_sha256: '0'.repeat(64) },
    {
      ...envelope,
      ciphertext:
        (envelope.ciphertext[0] === 'A' ? 'B' : 'A') +
        envelope.ciphertext.slice(1),
    },
    { ...envelope, iv: 'bad' },
  ])
    await expect(decryptCanonicalBackup(changed, recovery)).rejects.toThrow(
      'BACKUP_ENCRYPTION_DENIED',
    );
});
it('rejects extractable keys and empty backup before encrypting', async () => {
  const extractable = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  await expect(
    encryptCanonicalBackup(new Uint8Array([1]), id, 'recovery-v1', extractable),
  ).rejects.toThrow('BACKUP_ENCRYPTION_DENIED');
  await expect(
    encryptCanonicalBackup(new Uint8Array(), id, 'recovery-v1', await key()),
  ).rejects.toThrow('BACKUP_ENCRYPTION_DENIED');
});
