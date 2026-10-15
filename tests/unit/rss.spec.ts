import { it, expect } from 'vitest';
import {
  parseAtomHints,
  pollRss,
  RssUnavailableError,
} from '../../packages/core/src/sources/youtube/rss.js';
import { YoutubeError } from '../../packages/core/src/sources/youtube/client.js';
const xml =
  '<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><entry><yt:videoId>abcdefghijk</yt:videoId></entry></feed>';
it('RSS gives hints only, rejects DTD/entity/depth and malformed XML', () => {
  expect(parseAtomHints(xml)).toEqual(['abcdefghijk']);
  expect(() =>
    parseAtomHints(
      '<!DOCTYPE feed [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + xml,
    ),
  ).toThrow('RSS_UNSAFE_XML');
  expect(() => parseAtomHints(xml.replace('</entry>', '</bad>'))).toThrow(
    'RSS_MALFORMED',
  );
  expect(() =>
    parseAtomHints(xml.replace('<entry>', '<entry>' + '<x>'.repeat(33))),
  ).toThrow('RSS_LIMIT');
});
it.each([404, 410] as const)(
  'only unavailable feed HTTP %i permits the uploads fallback',
  async (status) => {
    const failure = await pollRss(
      'UC' + 'a'.repeat(22),
      null,
      null,
      async () => new Response(null, { status }),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RssUnavailableError);
    expect(failure).toMatchObject({ code: 'NOT_FOUND', status });
  },
);
it('RSS 429 preserves a provider Retry-After date and is never unavailable-feed fallback', async () => {
  const retry = 'Thu, 15 Oct 2026 06:00:00 GMT';
  const failure = await pollRss(
    'UC' + 'a'.repeat(22),
    null,
    null,
    async () =>
      new Response(null, { status: 429, headers: { 'Retry-After': retry } }),
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(YoutubeError);
  expect(failure).not.toBeInstanceOf(RssUnavailableError);
  expect(failure).toMatchObject({
    code: 'QUOTA',
    retryAt: '2026-10-15T06:00:00.000Z',
  });
});
it('304 preserves validators and never claims window completeness', async () => {
  const fake: typeof fetch = async (_input, init) => {
    expect(new Headers(init?.headers).get('If-None-Match')).toBe(
      'fixture-etag',
    );
    return new Response(null, { status: 304 });
  };
  expect(
    await pollRss('UC' + 'a'.repeat(22), 'fixture-etag', null, fake),
  ).toEqual({
    hint_ids: [],
    not_modified: true,
    coverage: 'UNKNOWN',
    etag: 'fixture-etag',
    modified: null,
  });
});
