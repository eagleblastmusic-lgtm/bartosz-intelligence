import { fetchWithoutRedirect } from '../../http/no-redirect.js';
import { boundedText } from '../../http/bounded-text.js';
import { YoutubeError } from './client.js';
export class RssUnavailableError extends YoutubeError {
  constructor(readonly status: 404 | 410) {
    super('NOT_FOUND');
  }
}
export function parseAtomHints(xml: string) {
  if (
    new TextEncoder().encode(xml).byteLength > 64000 ||
    /<!DOCTYPE|<!ENTITY/i.test(xml)
  )
    throw new Error('RSS_UNSAFE_XML');
  const clean = xml
    .replace(/<!--(?:(?!-->)[\s\S])*-->/g, '')
    .replace(/^\s*<\?xml[^?]*\?>/, '');
  if (clean.includes('<!') || clean.includes('<?'))
    throw new Error('RSS_UNSAFE_XML');
  const stack: string[] = [],
    ids: string[] = [];
  let inEntry = false,
    videoText = '';
  for (const token of clean.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (!token.startsWith('<')) {
      if (inEntry && stack.at(-1) === 'yt:videoId') videoText += token;
      continue;
    }
    const closing = /^<\/([\w:.-]+)\s*>$/.exec(token);
    if (closing) {
      if (stack.pop() !== closing[1]) throw new Error('RSS_MALFORMED');
      if (closing[1] === 'entry') {
        if (!/^[\w-]{11}$/.test(videoText.trim()))
          throw new Error('RSS_MALFORMED');
        ids.push(videoText.trim());
        inEntry = false;
      }
      continue;
    }
    const opening = /^<([\w:.-]+)(?:\s[^<>]*)?\/?\s*>$/.exec(token);
    if (!opening) throw new Error('RSS_MALFORMED');
    if (opening[1] === 'entry') {
      if (inEntry) throw new Error('RSS_MALFORMED');
      inEntry = true;
      videoText = '';
    }
    if (!/\/\s*>$/.test(token)) stack.push(opening[1]!);
    if (stack.length > 32 || ids.length > 50) throw new Error('RSS_LIMIT');
  }
  if (
    stack.length ||
    inEntry ||
    !/<feed(?:\s|>)/.test(clean) ||
    !/xmlns:yt=["']http:\/\/www.youtube.com\/xml\/schemas\/2015["']/.test(clean)
  )
    throw new Error('RSS_MALFORMED');
  return [...new Set(ids)];
}
export async function pollRss(
  channelId: string,
  etag: string | null,
  modified: string | null,
  fetcher: typeof fetch = fetch,
) {
  if (!/^UC[\w-]{22}$/.test(channelId)) throw new Error('INVALID_CHANNEL');
  const headers = new Headers();
  if (etag) headers.set('If-None-Match', etag);
  if (modified) headers.set('If-Modified-Since', modified);
  const response = await fetchWithoutRedirect(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    { headers, signal: AbortSignal.timeout(10000) },
    fetcher,
  );
  if (response.status === 304)
    return {
      hint_ids: [],
      not_modified: true,
      coverage: 'UNKNOWN' as const,
      etag,
      modified,
    };
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404 || response.status === 410)
      throw new RssUnavailableError(response.status);
    const retry = response.headers.get('retry-after');
    const next =
      retry && /^\d+$/.test(retry)
        ? Date.now() + Number(retry) * 1000
        : Date.parse(retry ?? '');
    throw new YoutubeError(
      response.status === 429 ? 'QUOTA' : 'TRANSIENT',
      Number.isFinite(next)
        ? new Date(next).toISOString()
        : response.status === 429
          ? new Date(Date.now() + 60000).toISOString()
          : null,
    );
  }
  return {
    hint_ids: parseAtomHints(await boundedText(response, 64000)),
    not_modified: false,
    coverage: 'UNKNOWN' as const,
    etag: response.headers.get('ETag'),
    modified: response.headers.get('Last-Modified'),
  };
}
