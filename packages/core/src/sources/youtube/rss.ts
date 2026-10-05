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
    if (stack.length > 32 || ids.length > 200) throw new Error('RSS_LIMIT');
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
  const response = await fetcher(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    { headers, redirect: 'error', signal: AbortSignal.timeout(10000) },
  );
  if (response.status === 304)
    return {
      hint_ids: [],
      not_modified: true,
      coverage: 'UNKNOWN' as const,
      etag,
      modified,
    };
  if (!response.ok)
    throw new Error(response.status === 429 ? 'RSS_QUOTA' : 'RSS_TRANSIENT');
  return {
    hint_ids: parseAtomHints(await response.text()),
    not_modified: false,
    coverage: 'UNKNOWN' as const,
    etag: response.headers.get('ETag'),
    modified: response.headers.get('Last-Modified'),
  };
}
