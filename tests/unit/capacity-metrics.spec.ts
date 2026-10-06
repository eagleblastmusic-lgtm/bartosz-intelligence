import { expect, it } from 'vitest';
import {
  capacityMetrics,
  nearestRank,
  wilson95,
} from '../../packages/telemetry/src/capacity.js';
import type {
  CapacityMeasurements,
  CapacityCase,
} from '../../packages/contracts/src/capacity-observation.js';
import { localDayRange } from '../../packages/core/src/projections/dates.js';
const hash = 'a'.repeat(64);
it('rejects future origins and acceptance preceding analysis instead of producing negative ages', () => {
  const input = data();
  input.cases = [row('future', '2026-10-14T10:00:00.000Z')];
  expect(() => capacityMetrics(input)).toThrow('FUTURE_CAPACITY_ORIGIN');
  const accepted = row(
    'backwards',
    '2026-10-05T10:00:00.000Z',
    '2026-10-05T11:00:00.000Z',
  );
  accepted.analysis_started_at = '2026-10-05T12:00:00.000Z';
  input.cases = [accepted];
  expect(() => capacityMetrics(input)).toThrow('INVALID_CAPACITY_ACCEPTANCE');
});
function row(
  id: string,
  origin = '2026-10-05T10:00:00.000Z',
  accepted: string | null = null,
): CapacityCase {
  return {
    work_item_id: id,
    item_id: id,
    source_id: 'source-a',
    origin_kind: 'NEW',
    published_at: origin,
    arrival_origin_at: origin,
    eligibility: 'ORDINARY',
    eligibility_recorded_at: origin,
    eligibility_ref: 'reference-' + id,
    analysis_started_at: origin,
    accepted_complete_at: accepted,
    accepted_effect_id: accepted ? 'effect-' + id : null,
    source_execution_ref: 'retrieval-' + id,
  };
}
function data(): CapacityMeasurements {
  return {
    version: 'capacity-measurements:1',
    config_hash: hash,
    timezone: 'Europe/Warsaw',
    start_date: '2026-10-05',
    end_date_exclusive: '2026-10-12',
    sampled_at: '2026-10-13T10:00:00.000Z',
    cases: [],
    days: Array.from({ length: 7 }, (_, i) => ({
      date: '2026-10-' + String(5 + i).padStart(2, '0'),
      config_hash: hash,
      phase: 'NORMAL',
      ordinary_open_new: 7 - i,
      ordinary_open_backfill: 0,
      continuous_representative_backlog: false,
      actual_quota_windows_observed: false,
      real_source_retrieval: false,
      qualified_pipeline: false,
      evidence_ref: 'day-' + i,
      enumeration_complete: true,
    })),
    excess_backlog: 7,
  };
}
it('counts failed/open late cases in mature SLO and keeps completed quantiles conditional', () => {
  const input = data();
  input.cases = [
    row('on-time', '2026-10-05T10:00:00.000Z', '2026-10-05T11:00:00.000Z'),
    row('late', '2026-10-05T10:00:00.000Z', '2026-10-07T10:00:00.000Z'),
    row('failed'),
  ];
  const result = capacityMetrics(input);
  expect(result.slo).toMatchObject({
    mature: 3,
    successes: 1,
    misses: 2,
    censored: 0,
    fraction: 1 / 3,
  });
  expect(result.snapshot).toMatchObject({
    completed: 2,
    open: 1,
    over_24h: 2,
    gate_c_status: 'NOT_YET_MATURE',
  });
  expect(result.snapshot.metrics.p50_time_to_analysis.value).toBe(3600);
  expect(result.snapshot.metrics.p95_time_to_analysis.value).toBe(172800);
  expect(result.snapshot.metrics.oldest_eligible_job_age.value).toBe(8 * 86400);
  expect(result.snapshot.metrics.backlog_growth_rate.value).toBe(-1);
  expect(result.snapshot.metrics.service_rate.value).toBeNull();
  expect(result.snapshot.metrics.capacity_headroom.value).toBeNull();
});
it('unknown eligibility is retained and cannot improve arrival rate or saturated capacity', () => {
  const input = data();
  const unknown = row('unknown');
  unknown.eligibility = 'UNKNOWN';
  unknown.eligibility_recorded_at = null;
  unknown.eligibility_ref = null;
  input.cases = [row('ordinary'), unknown];
  input.days.forEach((day) =>
    Object.assign(day, {
      phase: 'SATURATED',
      continuous_representative_backlog: true,
      actual_quota_windows_observed: true,
      real_source_retrieval: true,
      qualified_pipeline: true,
    }),
  );
  const result = capacityMetrics(input);
  expect(result.arrival_rate_all).toBe(2 / 7);
  expect(result.unknown_eligibility).toBe(1);
  expect(result.snapshot.metrics.arrival_rate.value).toBeNull();
  expect(result.snapshot.metrics.service_rate.value).toBeNull();
});
it('seven real consecutive saturated days distinguish service from arrivals and produce non-draining when mu is not greater', () => {
  const input = data();
  input.days.forEach((day) =>
    Object.assign(day, {
      phase: 'SATURATED',
      continuous_representative_backlog: true,
      actual_quota_windows_observed: true,
      real_source_retrieval: true,
      qualified_pipeline: true,
    }),
  );
  input.cases = Array.from({ length: 7 }, (_, i) =>
    row(
      'arrive-' + i,
      '2026-10-' + String(5 + i).padStart(2, '0') + 'T10:00:00.000Z',
      '2026-10-' + String(5 + i).padStart(2, '0') + 'T11:00:00.000Z',
    ),
  );
  let result = capacityMetrics(input);
  expect(result.snapshot.metrics.service_rate.value).toBe(1);
  expect(result.snapshot.metrics.arrival_rate.value).toBe(1);
  expect(result.snapshot.metrics.estimated_drain_time).toMatchObject({
    value: null,
    status: 'NOT_DRAINING',
  });
  const probe = row(
    'probe',
    '2026-10-01T10:00:00.000Z',
    '2026-10-05T12:00:00.000Z',
  );
  probe.origin_kind = 'PROBE';
  input.cases.push(probe);
  result = capacityMetrics(input);
  expect(result.snapshot.metrics.arrival_rate.value).toBe(1);
  expect(result.snapshot.metrics.service_rate.value).toBe(8 / 7);
  expect(result.snapshot.metrics.estimated_drain_time.value).toBeCloseTo(49);
  input.days[0]!.real_source_retrieval = false;
  expect(capacityMetrics(input).snapshot.metrics.service_rate.value).toBeNull();
  input.days[0]!.real_source_retrieval = true;
  input.cases[0]!.source_execution_ref = null;
  expect(capacityMetrics(input).snapshot.metrics.service_rate.value).toBeNull();
});
it('does not count historical backfill in new-arrival SLO and uses enqueue origin for its own duration', () => {
  const input = data();
  const backfill = row(
    'old',
    '2026-10-05T10:00:00.000Z',
    '2026-10-05T11:00:00.000Z',
  );
  backfill.origin_kind = 'BACKFILL';
  backfill.published_at = '2020-01-01T10:00:00.000Z';
  input.cases = [backfill];
  const result = capacityMetrics(input);
  expect(result.slo.mature).toBe(0);
  expect(result.backfill).toMatchObject({ completed: 1, p50_seconds: 3600 });
  expect(result.snapshot.metrics.arrival_rate.value).toBe(0);
});
it('rejects duplicate work/effects, post-hoc classifications and exclusions for parser/quota/IP failures', () => {
  const input = data();
  input.cases = [row('a'), row('a')];
  expect(() => capacityMetrics(input)).toThrow('DUPLICATE_CAPACITY_WORK');
  input.cases = [
    row('a', '2026-10-05T10:00:00.000Z', '2026-10-05T11:00:00.000Z'),
    row('b', '2026-10-05T10:00:00.000Z', '2026-10-05T11:00:00.000Z'),
  ];
  input.cases[1]!.accepted_effect_id = 'effect-a';
  expect(() => capacityMetrics(input)).toThrow('DUPLICATE_CAPACITY_EFFECT');
  input.cases = [row('a')];
  input.cases[0]!.eligibility_recorded_at = '2026-10-05T11:00:00.000Z';
  expect(() => capacityMetrics(input)).toThrow('POSTHOC_CAPACITY_ELIGIBILITY');
  for (const eligibility of [
    'IP_BLOCKED',
    'PARSE_ERROR',
    'QUOTA',
    'POOR_QUALITY',
  ]) {
    input.cases = [{ ...row('a'), eligibility } as CapacityCase];
    expect(() => capacityMetrics(input)).toThrow('INVALID_CAPACITY_CASE');
  }
});
it('uses full Warsaw civil days across DST and refuses missing or changed daily cuts', () => {
  const input = data();
  input.start_date = '2026-10-24';
  input.end_date_exclusive = '2026-10-27';
  input.sampled_at = '2026-10-28T10:00:00.000Z';
  input.days = input.days
    .slice(0, 3)
    .map((day, i) => ({ ...day, date: '2026-10-' + (24 + i) }));
  input.cases = [
    row('a', '2026-10-24T10:00:00.000Z'),
    row('b', '2026-10-25T10:00:00.000Z'),
    row('c', '2026-10-26T10:00:00.000Z'),
  ];
  expect(
    Date.parse(localDayRange('2026-10-25').end) -
      Date.parse(localDayRange('2026-10-25').start),
  ).toBe(25 * 3600000);
  expect(capacityMetrics(input).snapshot.metrics.arrival_rate.value).toBe(1);
  input.days[0]!.enumeration_complete = false;
  expect(capacityMetrics(input).snapshot.metrics.arrival_rate.value).toBeNull();
  input.days[0]!.enumeration_complete = true;
  input.days.pop();
  expect(capacityMetrics(input).snapshot.metrics.arrival_rate.value).toBeNull();
  input.days[0]!.config_hash = 'b'.repeat(64);
  expect(() => capacityMetrics(input)).toThrow('INVALID_CAPACITY_DAY');
});
it('does not count young open cases as successes; Wilson and quantiles expose sample limits', () => {
  const input = data();
  input.sampled_at = '2026-10-11T22:00:00.000Z';
  input.cases = [row('young', '2026-10-11T21:59:00.000Z')];
  expect(capacityMetrics(input).slo).toMatchObject({
    mature: 0,
    successes: 0,
    censored: 1,
    fraction: null,
    wilson_95: null,
  });
  expect(nearestRank([], 0.95)).toBeNull();
  expect(wilson95(0, 0)).toBeNull();
  expect(wilson95(100, 100)!.lower).toBeLessThan(0.97);
});
