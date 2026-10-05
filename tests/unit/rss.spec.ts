import { it, expect } from 'vitest';
import {
  parseAtomHints,
  pollRss,
} from '../../packages/core/src/sources/youtube/rss.js';
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
