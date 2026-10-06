import { expect, it } from 'vitest';
import { literalSearchQuery } from '../../packages/core/src/knowledge/search-query.js';
it('turns punctuation and FTS operators into bounded literal tokens', () => {
  expect(literalSearchQuery('zażółć gęślą')).toBe('"zazolc" AND "gesla"');
  expect(literalSearchQuery('name:foo OR bar*')).toBe(
    '"name" AND "foo" AND "OR" AND "bar"',
  );
  expect(literalSearchQuery('"quoted phrase"')).toBe('"quoted phrase"');
  expect(literalSearchQuery('" OR 1=1 --')).toBe('"OR" AND "1" AND "1"');
  for (const query of [
    '',
    '***',
    'word '.repeat(17),
    'a'.repeat(65),
    'ą'.repeat(257),
  ])
    expect(() => literalSearchQuery(query)).toThrow('INVALID_SEARCH_QUERY');
});
