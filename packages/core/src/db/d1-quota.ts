/** Recognize only explicit provider daily-limit messages, never generic 7500. */
export function d1DailyLimit(error: unknown) {
  if (!(error instanceof Error)) return null;
  const text = error.message.toLowerCase();
  if (
    !/d1|your account/.test(text) ||
    !/daily/.test(text) ||
    !/exceed|limit/.test(text)
  )
    return null;
  if (
    /daily.*(?:row )?read limit|read.*daily.*limit|d1_daily_read_limit/.test(
      text,
    )
  )
    return 'D1_DAILY_READ_LIMIT' as const;
  if (
    /daily.*(?:row )?write limit|write.*daily.*limit|d1_daily_write_limit/.test(
      text,
    )
  )
    return 'D1_DAILY_WRITE_LIMIT' as const;
  return null;
}
export function nextD1Reset(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error('INVALID_D1_CLOCK');
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
}
