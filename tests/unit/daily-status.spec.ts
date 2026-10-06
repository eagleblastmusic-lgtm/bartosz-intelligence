import { it, expect } from 'vitest';
import { jobStates } from '../../packages/contracts/src/jobs.js';
import { capacityMetricNames } from '../../packages/contracts/src/capacity.js';
import { statusLabel, reasonLabel } from '../../apps/web/src/app/status.js';
import { unobservedCapacity } from '../../packages/core/src/projections/capacity.js';
it('covers every backend state and preserves review/source/quota distinctions without exposing arbitrary messages', () => {
  for (const state of [...jobStates, 'READY', 'PARTIAL', 'REVIEW_REQUIRED'])
    expect(statusLabel(state)).not.toBe('Stan nieznany');
  expect(statusLabel('UNKNOWN')).toBe('Stan nieznany');
  expect(reasonLabel('NO_CAPTIONS')).toContain('nie udostępnia napisów');
  expect(reasonLabel('QUOTA_UNKNOWN_OR_STALE')).toContain(
    'nie został potwierdzony',
  );
  expect(reasonLabel('<img src=x>')).not.toContain('<img');
});
it('unobserved capacity never derives a service rate, green headroom or drain time from queue counters', () => {
  const snapshot = unobservedCapacity('2026-10-06T12:00:00Z');
  expect(Object.keys(snapshot.metrics)).toEqual([...capacityMetricNames]);
  expect(snapshot.measurement_window).toBeNull();
  expect(snapshot.gate_c_status).toBe('NOT_RUN');
  expect(snapshot.completed).toBeNull();
  expect(snapshot.open).toBeNull();
  for (const metric of Object.values(snapshot.metrics)) {
    expect(metric.value).toBeNull();
    expect(metric.status).toBe('UNKNOWN');
  }
});
