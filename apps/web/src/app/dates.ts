export function shiftDay(date: string, days: number) {
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function shiftMonth(month: string, delta: number) {
  const value = new Date(month + '-01T12:00:00Z');
  value.setUTCMonth(value.getUTCMonth() + delta);
  return value.toISOString().slice(0, 7);
}
export function dayLabel(date: string) {
  return new Intl.DateTimeFormat('pl-PL', {
    dateStyle: 'full',
    timeZone: 'UTC',
  }).format(new Date(date + 'T12:00:00Z'));
}
