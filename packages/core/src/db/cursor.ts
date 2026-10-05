import { base64url, decode64, sign, verifySigned } from '../auth/crypto.js';
export interface KeysetCursor {
  owner: string;
  kind: string;
  snapshot: string;
  time: string;
  id: string;
}
export async function encodeCursor(cursor: KeysetCursor, secret: string) {
  const value = base64url(new TextEncoder().encode(JSON.stringify(cursor)));
  return `${value}.${await sign(value, secret)}`;
}
export async function decodeCursor(
  value: string,
  owner: string,
  kind: string,
  secret: string,
): Promise<KeysetCursor> {
  if (value.length > 2048) throw new Error('INVALID_CURSOR');
  try {
    const cursor = JSON.parse(
      new TextDecoder().decode(decode64(await verifySigned(value, secret))),
    );
    if (
      cursor.owner !== owner ||
      cursor.kind !== kind ||
      typeof cursor.snapshot !== 'string' ||
      typeof cursor.time !== 'string' ||
      typeof cursor.id !== 'string'
    )
      throw new Error('INVALID_CURSOR');
    return cursor;
  } catch {
    throw new Error('INVALID_CURSOR');
  }
}
export function pageLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new Error('INVALID_LIMIT');
  return limit;
}
