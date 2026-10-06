/** The query grammar is literal words or one quoted phrase. FTS operators,
 * punctuation and column selectors never become executable MATCH syntax. */
export function literalSearchQuery(value: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256)
    throw new Error('INVALID_SEARCH_QUERY');
  const trimmed = foldSearchText(value.trim());
  const phrase =
    trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 2;
  const words = trimmed.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (
    !words.length ||
    words.length > 16 ||
    words.some((word) => word.length > 64)
  )
    throw new Error('INVALID_SEARCH_QUERY');
  return phrase
    ? '"' + words.join(' ') + '"'
    : words.map((word) => '"' + word + '"').join(' AND ');
}
export function foldSearchText(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replaceAll('ł', 'l')
    .replaceAll('Ł', 'L');
}
