import { describe, expect, it } from 'vitest';
import { shiftDay, shiftMonth } from '../../apps/web/src/app/dates.js';
describe('publication-day navigation across civil calendar boundaries', () => {
  it('moves one Warsaw calendar day through DST, leap days and years', () => {
    expect(shiftDay('2026-03-29', -1)).toBe('2026-03-28');
    expect(shiftDay('2026-10-25', 1)).toBe('2026-10-26');
    expect(shiftDay('2024-03-01', -1)).toBe('2024-02-29');
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });
});
