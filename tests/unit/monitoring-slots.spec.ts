import { expect, it } from 'vitest';
import { monitoringSlots } from '../../packages/core/src/sources/youtube/cycles.js';
it.each([
  ['2026-03-29T12:59:00Z', []],
  ['2026-03-29T13:00:00Z', ['15:00']],
  ['2026-03-29T21:00:00Z', ['15:00', '23:00']],
  ['2026-10-25T13:59:00Z', []],
  ['2026-10-25T14:00:00Z', ['15:00']],
  ['2026-10-25T22:00:00Z', ['15:00', '23:00']],
])('Warsaw slots at %s', (at, expected) => {
  expect(monitoringSlots(new Date(at)).map((s) => s.slot)).toEqual(expected);
});
it('one slot is configurable without enabling it by default', () => {
  expect(monitoringSlots(new Date('2026-10-14T14:00:00Z'), '23:00')).toEqual(
    [],
  );
  expect(
    monitoringSlots(new Date('2026-10-14T21:00:00Z'), '23:00'),
  ).toHaveLength(1);
});
