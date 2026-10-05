import { YoutubeClient, record, string, YoutubeError } from './client.js';
import type { SourceIdentity } from '../../../../contracts/src/discovery.js';
export function normalizeLocator(input: string): {
  kind: 'channel' | 'handle' | 'video';
  value: string;
  requires_confirmation: boolean;
} {
  if (typeof input !== 'string' || input.length > 2048)
    throw new Error('INVALID_LOCATOR');
  const value = input.trim();
  if (/^UC[\w-]{22}$/.test(value))
    return { kind: 'channel', value, requires_confirmation: false };
  if (/^@[\p{L}\p{N}_.-]{3,30}$/u.test(value))
    return { kind: 'handle', value, requires_confirmation: false };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('INVALID_LOCATOR');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(
      url.hostname,
    ) ||
    url.hash
  )
    throw new Error('INVALID_LOCATOR');
  if (url.hostname === 'youtu.be' && /^\/[\w-]{11}$/.test(url.pathname))
    return {
      kind: 'video',
      value: url.pathname.slice(1),
      requires_confirmation: true,
    };
  const channel = /^\/channel\/(UC[\w-]{22})\/?$/.exec(url.pathname);
  if (channel)
    return {
      kind: 'channel',
      value: channel[1]!,
      requires_confirmation: false,
    };
  const handle =
    /^\/(@[\p{L}\p{N}_.-]{3,30})(?:\/(?:videos|shorts|streams))?\/?$/u.exec(
      decodeURIComponent(url.pathname),
    );
  if (handle)
    return { kind: 'handle', value: handle[1]!, requires_confirmation: false };
  const pathVideo = /^\/(?:shorts|live)\/([\w-]{11})\/?$/.exec(url.pathname);
  const video =
    url.pathname === '/watch' ? url.searchParams.get('v') : pathVideo?.[1];
  if (video && /^[\w-]{11}$/.test(video))
    return { kind: 'video', value: video, requires_confirmation: true };
  throw new Error('INVALID_LOCATOR');
}
export async function resolveSource(
  client: YoutubeClient,
  locator: string,
): Promise<SourceIdentity & { requires_confirmation: boolean }> {
  const normalized = normalizeLocator(locator);
  let channelId: string | undefined;
  if (normalized.kind === 'video') {
    const video = await client.get('videos', {
      part: 'snippet',
      id: normalized.value,
    });
    if (!(video.items as unknown[]).length) throw new YoutubeError('NOT_FOUND');
    channelId = string(
      record(record((video.items as unknown[])[0]).snippet).channelId,
    );
  }
  const response = await client.get('channels', {
    part: 'snippet,contentDetails',
    ...(normalized.kind === 'handle'
      ? { forHandle: normalized.value }
      : { id: channelId ?? normalized.value }),
  });
  if ((response.items as unknown[]).length !== 1)
    throw new YoutubeError('NOT_FOUND');
  const channel = record((response.items as unknown[])[0]),
    snippet = record(channel.snippet),
    id = string(channel.id);
  if (!/^UC[\w-]{22}$/.test(id)) throw new YoutubeError('PARSER');
  const uploads = string(
    record(record(channel.contentDetails).relatedPlaylists).uploads,
  );
  if (!/^UU[\w-]{22}$/.test(uploads)) throw new YoutubeError('PARSER');
  return {
    namespace: 'youtube',
    external_id: id,
    canonical_locator: `https://www.youtube.com/channel/${id}`,
    title: string(snippet.title),
    uploads_playlist_id: uploads,
    handle: typeof snippet.customUrl === 'string' ? snippet.customUrl : null,
    requires_confirmation: normalized.requires_confirmation,
  };
}
