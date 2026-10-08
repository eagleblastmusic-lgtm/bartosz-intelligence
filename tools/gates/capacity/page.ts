/** Telemetry pages contain metadata only and have a fixed transport bound. */
export async function readCapacityPage(response: Response): Promise<unknown> {
  const limit = 256 * 1024;
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel();
    throw new Error('CAPACITY_PAGE_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('INVALID_CAPACITY_COLLECTION_PAGE');
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error('CAPACITY_PAGE_TOO_LARGE');
      }
      parts.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
    } catch {
      throw new Error('INVALID_CAPACITY_COLLECTION_PAGE');
    }
  } finally {
    reader.releaseLock();
  }
}
