/** Bound decoded response bytes before allocating the full source payload. */
export async function boundedText(response: Response, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('INVALID_BODY_LIMIT');
  const declared = response.headers.get('Content-Length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    await response.body?.cancel();
    throw new Error('RESPONSE_BODY_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('RESPONSE_BODY_TOO_LARGE');
      }
      parts.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('RESPONSE_INVALID_UTF8');
  }
}
