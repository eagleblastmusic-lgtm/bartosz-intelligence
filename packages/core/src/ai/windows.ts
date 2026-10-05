export function dailyQuotaWindow(
  now: Date,
  zone: 'America/Los_Angeles' | 'UTC',
) {
  if (!Number.isFinite(now.getTime())) throw new Error('INVALID_WINDOW_TIME');
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = (instant: number) =>
    Object.fromEntries(
      formatter
        .formatToParts(new Date(instant))
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    );
  const local = parts(now.getTime());
  const midnight = (target: number) => {
    let guess = target;
    for (let index = 0; index < 4; index++) {
      const p = parts(guess),
        projected = Date.UTC(
          p.year!,
          p.month! - 1,
          p.day!,
          p.hour!,
          p.minute!,
          p.second!,
        );
      const delta = target - projected;
      if (delta === 0) return new Date(guess).toISOString();
      guess += delta;
    }
    throw new Error('WINDOW_ZONE_RESOLUTION_FAILED');
  };
  const date = Date.UTC(local.year!, local.month! - 1, local.day!);
  return {
    window_start: midnight(date),
    reset_at: midnight(date + 86400000),
    reset_zone: zone,
  };
}
