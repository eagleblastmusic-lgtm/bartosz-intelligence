import { base64url, decode64 } from '../auth/crypto.js';

export interface EncryptedCanonicalBackup {
  version: 'canonical-backup-aes256gcm:1';
  key_id: string;
  backup_id: string;
  plaintext_sha256: string;
  iv: string;
  ciphertext: string;
}
const version = 'canonical-backup-aes256gcm:1' as const;
const maximum = 64 * 1024 * 1024;
const denied = () => new Error('BACKUP_ENCRYPTION_DENIED');
function aad(
  input: Pick<
    EncryptedCanonicalBackup,
    'key_id' | 'backup_id' | 'plaintext_sha256'
  >,
) {
  if (
    !/^[A-Za-z0-9_-]{1,80}$/.test(input.key_id) ||
    !/^[a-f0-9-]{36}$/.test(input.backup_id) ||
    !/^[a-f0-9]{64}$/.test(input.plaintext_sha256)
  )
    throw denied();
  return new TextEncoder().encode(JSON.stringify({ version, ...input }));
}
function checkKey(key: CryptoKey) {
  if (
    key.type !== 'secret' ||
    key.extractable ||
    key.algorithm.name !== 'AES-GCM' ||
    (key.algorithm as { name: string; length?: number }).length !== 256 ||
    !key.usages.includes('encrypt') ||
    !key.usages.includes('decrypt')
  )
    throw denied();
}
async function digest(bytes: Uint8Array) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', bytes as BufferSource),
    ),
  ]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
/** The caller loads the dedicated recovery key outside Drive, D1 and checkout.
 * This envelope never includes that key or falls back to application secrets. */
export async function encryptCanonicalBackup(
  bytes: Uint8Array,
  backupId: string,
  keyId: string,
  key: CryptoKey,
): Promise<EncryptedCanonicalBackup> {
  checkKey(key);
  if (!bytes.length || bytes.length > maximum) throw denied();
  const metadata = {
    key_id: keyId,
    backup_id: backupId,
    plaintext_sha256: await digest(bytes),
  };
  const additionalData = aad(metadata),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData, tagLength: 128 },
    key,
    bytes as BufferSource,
  );
  return {
    version,
    ...metadata,
    iv: base64url(iv),
    ciphertext: base64url(new Uint8Array(encrypted)),
  };
}
export async function decryptCanonicalBackup(
  envelope: EncryptedCanonicalBackup,
  key: CryptoKey,
): Promise<Uint8Array> {
  try {
    checkKey(key);
    if (
      envelope.version !== version ||
      Object.keys(envelope).sort().join(',') !==
        'backup_id,ciphertext,iv,key_id,plaintext_sha256,version' ||
      typeof envelope.ciphertext !== 'string' ||
      envelope.ciphertext.length > Math.ceil(((maximum + 16) * 4) / 3) ||
      !/^[A-Za-z0-9_-]+$/.test(envelope.ciphertext) ||
      !/^[A-Za-z0-9_-]{16}$/.test(envelope.iv)
    )
      throw denied();
    const { key_id, backup_id, plaintext_sha256 } = envelope;
    const additionalData = aad({ key_id, backup_id, plaintext_sha256 }),
      iv = decode64(envelope.iv),
      ciphertext = decode64(envelope.ciphertext);
    if (
      ciphertext.length <= 16 ||
      ciphertext.length > maximum + 16 ||
      base64url(ciphertext) !== envelope.ciphertext
    )
      throw denied();
    const bytes = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData, tagLength: 128 },
        key,
        ciphertext,
      ),
    );
    if ((await digest(bytes)) !== plaintext_sha256) throw denied();
    return bytes;
  } catch {
    throw denied();
  }
}
