export function base64url(bytes: Uint8Array) {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768)
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(parts.join(''))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
export function decode64(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('INVALID_ENCODING');
  return Uint8Array.from(
    atob(
      value.replaceAll('-', '+').replaceAll('_', '/') +
        '='.repeat((4 - (value.length % 4)) % 4),
    ),
    (c) => c.charCodeAt(0),
  );
}
export function randomToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
export async function sha256(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
    (n) => n.toString(16).padStart(2, '0'),
  ).join('');
}
export async function sign(value: string, secret: string) {
  if (secret.length < 32) throw new Error('SESSION_SECRET_REQUIRED');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64url(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)),
    ),
  );
}
export async function verifySigned(value: string, secret: string) {
  const parts = value.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1] || secret.length < 32)
    throw new Error('UNAUTHENTICATED');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  if (
    !(await crypto.subtle.verify(
      'HMAC',
      key,
      decode64(parts[1]),
      new TextEncoder().encode(parts[0]),
    ))
  )
    throw new Error('UNAUTHENTICATED');
  return parts[0];
}
