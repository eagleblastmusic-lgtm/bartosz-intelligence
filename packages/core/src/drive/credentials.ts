import { base64url, decode64 } from '../auth/crypto.js';

export interface DriveCredentialBinding {
  owner_id: string;
  connection_id: string;
  account_subject: string;
  client_id: string;
}
export interface EncryptedDriveCredential {
  version: 'drive-refresh-aes256gcm:1';
  key_id: string;
  iv: string;
  ciphertext: string;
}
export interface DriveWrappingKey {
  key_id: string;
  key: CryptoKey;
}
const version = 'drive-refresh-aes256gcm:1' as const;
const denied = () => new Error('DRIVE_CREDENTIAL_DENIED');
function associatedData(binding: DriveCredentialBinding) {
  const { owner_id, connection_id, account_subject, client_id } = binding;
  if (
    ![owner_id, connection_id, account_subject, client_id].every(
      (value) =>
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 256 &&
        !/[\u0000-\u0020\u007f]/.test(value),
    )
  )
    throw denied();
  return new TextEncoder().encode(
    JSON.stringify({
      purpose: 'drive-offline-refresh:1',
      owner_id,
      connection_id,
      account_subject,
      client_id,
    }),
  );
}
function checkKey(wrapping: DriveWrappingKey) {
  const key = wrapping.key;
  if (
    !/^[A-Za-z0-9_-]{1,80}$/.test(wrapping.key_id) ||
    !key ||
    key.type !== 'secret' ||
    key.extractable ||
    key.algorithm.name !== 'AES-GCM' ||
    (key.algorithm as { name: string; length?: number }).length !== 256 ||
    !key.usages.includes('encrypt') ||
    !key.usages.includes('decrypt')
  )
    throw denied();
}

/** The caller loads this from a private server secret/recovery medium outside
 * D1. This module never creates, persists, logs or includes key material in the
 * credential envelope. No fallback to the session/OIDC signing secret. */
export async function importDriveWrappingKey(
  keyId: string,
  secret: string,
): Promise<DriveWrappingKey> {
  try {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(keyId) || secret.length !== 43)
      throw denied();
    const raw = decode64(secret);
    if (raw.length !== 32 || base64url(raw) !== secret) throw denied();
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
    raw.fill(0);
    return Object.freeze({ key_id: keyId, key });
  } catch {
    throw denied();
  }
}

export async function encryptDriveRefreshToken(
  token: string,
  binding: DriveCredentialBinding,
  wrapping: DriveWrappingKey,
): Promise<EncryptedDriveCredential> {
  try {
    checkKey(wrapping);
    if (typeof token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(token))
      throw denied();
    const additionalData = associatedData(binding),
      iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(token);
    try {
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData, tagLength: 128 },
        wrapping.key,
        plaintext,
      );
      return Object.freeze({
        version,
        key_id: wrapping.key_id,
        iv: base64url(iv),
        ciphertext: base64url(new Uint8Array(ciphertext)),
      });
    } finally {
      plaintext.fill(0);
    }
  } catch {
    throw denied();
  }
}

export async function decryptDriveRefreshToken(
  envelope: EncryptedDriveCredential,
  binding: DriveCredentialBinding,
  wrapping: DriveWrappingKey,
): Promise<string> {
  try {
    checkKey(wrapping);
    const additionalData = associatedData(binding);
    const record = structuredClone(envelope);
    if (
      !record ||
      record.version !== version ||
      record.key_id !== wrapping.key_id ||
      Object.keys(record).sort().join(',') !== 'ciphertext,iv,key_id,version' ||
      typeof record.iv !== 'string' ||
      record.iv.length !== 16 ||
      typeof record.ciphertext !== 'string' ||
      record.ciphertext.length > 10944
    )
      throw denied();
    const iv = decode64(record.iv),
      ciphertext = decode64(record.ciphertext);
    if (
      iv.length !== 12 ||
      ciphertext.length < 17 ||
      ciphertext.length > 8208 ||
      base64url(iv) !== record.iv ||
      base64url(ciphertext) !== record.ciphertext
    )
      throw denied();
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData, tagLength: 128 },
        wrapping.key,
        ciphertext,
      ),
    );
    try {
      const token = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(plaintext);
      if (!/^[\x21-\x7e]{1,8192}$/.test(token)) throw denied();
      return token;
    } finally {
      plaintext.fill(0);
    }
  } catch {
    throw denied();
  }
}

export async function rotateDriveCredential(
  envelope: EncryptedDriveCredential,
  binding: DriveCredentialBinding,
  previous: DriveWrappingKey,
  next: DriveWrappingKey,
) {
  // The caller commits the new envelope before retiring the old recovery key.
  return encryptDriveRefreshToken(
    await decryptDriveRefreshToken(envelope, binding, previous),
    binding,
    next,
  );
}
