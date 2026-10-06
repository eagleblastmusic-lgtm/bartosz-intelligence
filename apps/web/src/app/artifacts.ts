import type {
  CanonicalDescriptor,
  CanonicalPage,
} from '../../../../packages/contracts/src/item-detail.js';
const decode = (value: string) =>
  Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  );
async function hash(bytes: Uint8Array) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
    ),
  ]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
export async function readPinnedJSON(
  descriptor: CanonicalDescriptor,
  pageAt: (index: number, signal: AbortSignal) => Promise<CanonicalPage>,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    !Number.isSafeInteger(descriptor.byte_size) ||
    descriptor.byte_size < 1 ||
    descriptor.byte_size > 8 * 1024 * 1024 ||
    !Number.isSafeInteger(descriptor.chunk_count) ||
    descriptor.chunk_count < 1 ||
    descriptor.chunk_count > 1024
  )
    throw new Error('CANONICAL_DESCRIPTOR_INVALID');
  const bytes = new Uint8Array(descriptor.byte_size);
  let index = 0,
    offset = 0;
  do {
    const page = await pageAt(index, signal);
    if (
      page.descriptor.artifact_id !== descriptor.artifact_id ||
      page.descriptor.content_hash !== descriptor.content_hash ||
      page.descriptor.byte_size !== descriptor.byte_size ||
      page.descriptor.chunk_count !== descriptor.chunk_count ||
      !page.chunks.length ||
      page.chunks.length > 4
    )
      throw new Error('CANONICAL_DESCRIPTOR_CHANGED');
    for (const chunk of page.chunks) {
      const part = decode(chunk.body_base64);
      if (
        chunk.chunk_index !== index ||
        chunk.byte_start !== offset ||
        chunk.byte_size !== part.length ||
        part.length > 32768 ||
        offset + part.length > bytes.length ||
        (await hash(part)) !== chunk.byte_hash
      )
        throw new Error('CANONICAL_CONTENT_INVALID');
      bytes.set(part, offset);
      offset += part.length;
      index++;
    }
    if (page.next_index !== (index < descriptor.chunk_count ? index : null))
      throw new Error('CANONICAL_PAGE_INVALID');
  } while (index < descriptor.chunk_count);
  if (
    offset !== bytes.length ||
    (await hash(bytes)) !== descriptor.content_hash
  )
    throw new Error('CANONICAL_CONTENT_INVALID');
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
  );
}
