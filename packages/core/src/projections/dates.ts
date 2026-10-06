const timezone = 'Europe/Warsaw';
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
export function requireLocalDate(date: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    date < '2000-01-01' ||
    date > '2099-12-31'
  )
    throw new Error('INVALID_DATE');
  const instant = new Date(date + 'T00:00:00.000Z');
  if (
    !Number.isFinite(instant.getTime()) ||
    instant.toISOString().slice(0, 10) !== date
  )
    throw new Error('INVALID_DATE');
  return instant.getTime();
}
export function publicationDate(instant: string) {
  if (!Number.isFinite(Date.parse(instant)))
    throw new Error('INVALID_PUBLICATION');
  const p = Object.fromEntries(
    formatter
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}
function midnight(target: number) {
  let guess = target;
  for (let index = 0; index < 4; index++) {
    const p = Object.fromEntries(
      formatter
        .formatToParts(new Date(guess))
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    );
    const delta =
      target -
      Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
    if (delta === 0) return new Date(guess).toISOString();
    guess += delta;
  }
  throw new Error('DATE_ZONE_RESOLUTION_FAILED');
}
export function localDayRange(date: string, zone: string = timezone) {
  if (zone !== timezone) throw new Error('INVALID_TIMEZONE');
  const target = requireLocalDate(date);
  return {
    date,
    timezone: timezone as 'Europe/Warsaw',
    start: midnight(target),
    end: midnight(target + 86400000),
  };
}
export function monthDays(month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('INVALID_MONTH');
  const start = requireLocalDate(month + '-01');
  const days: ReturnType<typeof localDayRange>[] = [];
  for (let index = 0; index < 31; index++) {
    const date = new Date(start + index * 86400000).toISOString().slice(0, 10);
    if (!date.startsWith(month + '-')) break;
    days.push(localDayRange(date));
  }
  return days;
}
