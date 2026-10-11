/** Presentation only: keep the ordered source-backed notes and their Evidence
 * unchanged. No shortening, paraphrase, inferred transitions or extra AI pass. */
export function summaryNarrative(
  notes: readonly { text_pl: string }[],
): string {
  return notes
    .map(({ text_pl }) => {
      if (
        typeof text_pl !== 'string' ||
        !text_pl.trim() ||
        /^(?:undefined|null|NaN|\[object Object\])$/u.test(text_pl.trim())
      )
        throw new Error('BROKEN_ANALYSIS_CONTENT');
      return text_pl.trim();
    })
    .join(' ')
    .replace(/\s+/gu, ' ');
}
