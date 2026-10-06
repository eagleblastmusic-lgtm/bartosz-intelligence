import type {
  CapacityMeasurements,
  CapacityCase,
} from '../../contracts/src/capacity-observation.js';
import type {
  CapacitySnapshot,
  CapacityMetric,
} from '../../contracts/src/capacity.js';
import { unobservedCapacity } from '../../core/src/projections/capacity.js';
import { localDayRange } from '../../core/src/projections/dates.js';

const dayMs = 86400000;
function instant(value: string) {
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error('INVALID_CAPACITY_CLOCK');
  const parsed = Date.parse(value);
  if (
    new Date(parsed).toISOString() !== value.replace(/(?<!\.\d{3})Z$/, '.000Z')
  )
    throw new Error('INVALID_CAPACITY_CLOCK');
  return parsed;
}
export function nearestRank(values: number[], fraction: number) {
  if (!values.length) return null;
  if (
    fraction <= 0 ||
    fraction > 1 ||
    values.some((value) => !Number.isFinite(value))
  )
    throw new Error('INVALID_CAPACITY_QUANTILE');
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}
export function wilson95(successes: number, total: number) {
  if (
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(successes) ||
    total < 0 ||
    successes < 0 ||
    successes > total
  )
    throw new Error('INVALID_CAPACITY_DENOMINATOR');
  if (!total) return null;
  const z = 1.959963984540054,
    fraction = successes / total,
    denominator = 1 + (z * z) / total;
  const center = (fraction + (z * z) / (2 * total)) / denominator;
  const margin =
    (z *
      Math.sqrt(
        (fraction * (1 - fraction)) / total + (z * z) / (4 * total * total),
      )) /
    denominator;
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}
const completed = (row: CapacityCase, cutoff: number) =>
  row.accepted_complete_at !== null &&
  instant(row.accepted_complete_at) <= cutoff;
export function capacityMetrics(input: CapacityMeasurements) {
  if (
    input.version !== 'capacity-measurements:1' ||
    input.timezone !== 'Europe/Warsaw' ||
    !/^[a-f0-9]{64}$/.test(input.config_hash)
  )
    throw new Error('INVALID_CAPACITY_CONFIG');
  const start = localDayRange(input.start_date).start,
    end = localDayRange(input.end_date_exclusive).start;
  const dayCount =
    (Date.parse(input.end_date_exclusive + 'T12:00:00Z') -
      Date.parse(input.start_date + 'T12:00:00Z')) /
    dayMs;
  const cutoff = instant(input.sampled_at),
    endMs = instant(end),
    startMs = instant(start);
  if (
    !Number.isSafeInteger(dayCount) ||
    dayCount < 1 ||
    dayCount > 366 ||
    cutoff < endMs
  )
    throw new Error('INVALID_CAPACITY_WINDOW');
  const identities = new Set<string>(),
    effects = new Set<string>();
  for (const row of input.cases) {
    if (
      ![
        'ORDINARY',
        'NO_CAPTIONS',
        'NATURAL_UNREACHABLE',
        'LIVE',
        'LONG_INPUT',
        'LOCAL_STT',
        'UNKNOWN',
      ].includes(row.eligibility) ||
      !['NEW', 'BACKFILL', 'PROBE'].includes(row.origin_kind) ||
      !row.work_item_id ||
      !row.item_id ||
      !row.source_id
    )
      throw new Error('INVALID_CAPACITY_CASE');
    if (identities.has(row.work_item_id))
      throw new Error('DUPLICATE_CAPACITY_WORK');
    identities.add(row.work_item_id);
    const origin = instant(row.arrival_origin_at);
    if (origin > cutoff) throw new Error('FUTURE_CAPACITY_ORIGIN');
    if (row.published_at !== null) instant(row.published_at);
    if (
      row.origin_kind === 'NEW' &&
      (row.published_at === null || origin !== instant(row.published_at))
    )
      throw new Error('INVALID_CAPACITY_ORIGIN');
    if (row.analysis_started_at !== null) {
      const analysis = instant(row.analysis_started_at);
      if (analysis < origin || analysis > cutoff)
        throw new Error('INVALID_CAPACITY_ANALYSIS_CLOCK');
    }
    if (row.eligibility !== 'UNKNOWN') {
      if (!row.eligibility_ref || row.eligibility_recorded_at === null)
        throw new Error('CAPACITY_ELIGIBILITY_PROOF_REQUIRED');
      const decision = instant(row.eligibility_recorded_at);
      if (
        decision > cutoff ||
        (row.analysis_started_at !== null &&
          decision > instant(row.analysis_started_at))
      )
        throw new Error('POSTHOC_CAPACITY_ELIGIBILITY');
    }
    if (row.accepted_complete_at !== null) {
      if (
        !row.accepted_effect_id ||
        row.analysis_started_at === null ||
        instant(row.accepted_complete_at) < instant(row.analysis_started_at) ||
        instant(row.accepted_complete_at) > cutoff
      )
        throw new Error('INVALID_CAPACITY_ACCEPTANCE');
      if (effects.has(row.accepted_effect_id))
        throw new Error('DUPLICATE_CAPACITY_EFFECT');
      effects.add(row.accepted_effect_id);
    }
  }
  const dates = new Set<string>();
  for (const day of input.days) {
    if (
      !['CALIBRATION', 'NORMAL', 'SATURATED', 'OUTAGE', 'RECOVERY'].includes(
        day.phase,
      )
    )
      throw new Error('INVALID_CAPACITY_DAY');
    const range = localDayRange(day.date);
    if (
      dates.has(day.date) ||
      day.config_hash !== input.config_hash ||
      instant(range.start) < startMs ||
      instant(range.end) > endMs
    )
      throw new Error('INVALID_CAPACITY_DAY');
    dates.add(day.date);
    for (const count of [day.ordinary_open_new, day.ordinary_open_backfill])
      if (count !== null && (!Number.isSafeInteger(count) || count < 0))
        throw new Error('INVALID_CAPACITY_COUNT');
  }
  if (
    input.excess_backlog !== null &&
    (!Number.isSafeInteger(input.excess_backlog) || input.excess_backlog < 0)
  )
    throw new Error('INVALID_CAPACITY_COUNT');
  const result: CapacitySnapshot = unobservedCapacity(input.sampled_at);
  result.gate_c_status = 'NOT_YET_MATURE';
  result.measurement_window = { start, end };
  const cohort = input.cases.filter(
    (row) =>
      row.origin_kind === 'NEW' &&
      instant(row.arrival_origin_at) >= startMs &&
      instant(row.arrival_origin_at) < endMs,
  );
  const unknown = cohort.filter((row) => row.eligibility === 'UNKNOWN').length;
  const unknownWorkload = input.cases.filter(
    (row) => row.eligibility === 'UNKNOWN',
  ).length;
  const ordinary = cohort.filter((row) => row.eligibility === 'ORDINARY');
  const finished = ordinary.filter((row) => completed(row, cutoff)),
    open = ordinary.filter((row) => !completed(row, cutoff));
  const set = (
    name: keyof CapacitySnapshot['metrics'],
    value: number,
    status: CapacityMetric['status'] = 'MEASURED',
    n = ordinary.length,
  ) => {
    Object.assign(result.metrics[name], { value, status, reason: null, n });
  };
  result.eligibility_status = unknown ? 'UNKNOWN' : 'CLASSIFIED';
  result.completed = finished.length;
  result.open = open.length;
  result.over_24h = ordinary.filter(
    (row) =>
      cutoff - instant(row.arrival_origin_at) >= dayMs &&
      (!completed(row, cutoff) ||
        instant(row.accepted_complete_at!) - instant(row.arrival_origin_at) >
          dayMs),
  ).length;
  const durations = finished.map(
    (row) =>
      (instant(row.accepted_complete_at!) - instant(row.arrival_origin_at)) /
      1000,
  );
  for (const [name, fraction] of [
    ['p50_time_to_analysis', 0.5],
    ['p95_time_to_analysis', 0.95],
  ] as const) {
    const value = nearestRank(durations, fraction);
    if (value !== null) set(name, value, 'MEASURED', durations.length);
  }
  const saturated = input.days
    .filter(
      (day) =>
        day.phase === 'SATURATED' &&
        day.evidence_ref &&
        day.continuous_representative_backlog &&
        day.actual_quota_windows_observed &&
        day.real_source_retrieval &&
        day.qualified_pipeline,
    )
    .sort((a, b) => a.date.localeCompare(b.date));
  const consecutive = saturated.every(
    (day, index) =>
      index === 0 ||
      Date.parse(day.date + 'T12:00:00Z') -
        Date.parse(saturated[index - 1]!.date + 'T12:00:00Z') ===
        dayMs,
  );
  const rates = saturated.map((day) => {
    const range = localDayRange(day.date);
    return input.cases.filter(
      (row) =>
        row.eligibility === 'ORDINARY' &&
        completed(row, cutoff) &&
        instant(row.accepted_complete_at!) >= instant(range.start) &&
        instant(row.accepted_complete_at!) < instant(range.end),
    ).length;
  });
  const saturationSourceProof = input.cases.every(
    (row) =>
      row.eligibility !== 'ORDINARY' ||
      !completed(row, cutoff) ||
      !saturated.some((day) => {
        const range = localDayRange(day.date);
        return (
          instant(row.accepted_complete_at!) >= instant(range.start) &&
          instant(row.accepted_complete_at!) < instant(range.end)
        );
      }) ||
      !!row.source_execution_ref,
  );
  const mu =
    !unknownWorkload &&
    saturationSourceProof &&
    saturated.length >= 7 &&
    consecutive
      ? rates.reduce((a, b) => a + b, 0) / rates.length
      : null;
  if (mu !== null)
    set(
      'service_rate',
      mu,
      'MEASURED',
      rates.reduce((a, b) => a + b, 0),
    );
  if (
    !unknown &&
    dates.size === dayCount &&
    input.days.every((day) => day.enumeration_complete && day.evidence_ref)
  ) {
    const lambda = ordinary.length / dayCount;
    set('arrival_rate', lambda);
    const allOpen = input.cases.filter(
      (row) =>
        row.origin_kind === 'NEW' &&
        row.eligibility === 'ORDINARY' &&
        instant(row.arrival_origin_at) <= cutoff &&
        !completed(row, cutoff),
    );
    if (allOpen.length)
      set(
        'oldest_eligible_job_age',
        (cutoff -
          Math.min(...allOpen.map((row) => instant(row.arrival_origin_at)))) /
          1000,
        'MEASURED',
        allOpen.length,
      );
    if (mu !== null && mu > 0) set('capacity_headroom', (mu - lambda) / mu);
    if (mu !== null && mu <= lambda)
      Object.assign(result.metrics.estimated_drain_time, {
        value: null,
        status: 'NOT_DRAINING',
        reason: 'SERVICE_NOT_ABOVE_ARRIVALS',
        n: saturated.length,
      });
    else if (mu !== null && input.excess_backlog !== null)
      set(
        'estimated_drain_time',
        input.excess_backlog / (mu - lambda),
        'MEASURED',
        saturated.length,
      );
    const normal = input.days
      .filter(
        (day) =>
          day.phase === 'NORMAL' &&
          day.ordinary_open_new !== null &&
          day.evidence_ref,
      )
      .sort((a, b) => a.date.localeCompare(b.date));
    if (normal.length >= 2) {
      const xs = normal.map(
          (day) =>
            (Date.parse(day.date + 'T12:00:00Z') -
              Date.parse(normal[0]!.date + 'T12:00:00Z')) /
            dayMs,
        ),
        ys = normal.map((day) => day.ordinary_open_new!);
      const xMean = xs.reduce((a, b) => a + b, 0) / xs.length,
        yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
      const slope =
        xs.reduce(
          (sum, x, index) => sum + (x - xMean) * (ys[index]! - yMean),
          0,
        ) / xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
      set('backlog_growth_rate', slope, 'MEASURED', normal.length);
    }
  }
  const mature = ordinary.filter(
    (row) => cutoff - instant(row.arrival_origin_at) >= dayMs,
  );
  const successes = mature.filter(
    (row) =>
      completed(row, cutoff) &&
      instant(row.accepted_complete_at!) - instant(row.arrival_origin_at) <=
        dayMs,
  ).length;
  const backfill = input.cases.filter(
    (row) => row.origin_kind === 'BACKFILL' && row.eligibility === 'ORDINARY',
  );
  const backfillOpen = backfill.filter((row) => !completed(row, cutoff));
  const backfillDurations = backfill
    .filter((row) => completed(row, cutoff))
    .map(
      (row) =>
        (instant(row.accepted_complete_at!) - instant(row.arrival_origin_at)) /
        1000,
    );
  return {
    snapshot: result,
    arrival_rate_all: cohort.length / dayCount,
    unknown_eligibility: unknown,
    unknown_workload_eligibility: unknownWorkload,
    conditional_quantiles: true,
    backfill: {
      completed: backfillDurations.length,
      open: backfillOpen.length,
      oldest_age_seconds: backfillOpen.length
        ? (cutoff -
            Math.min(
              ...backfillOpen.map((row) => instant(row.arrival_origin_at)),
            )) /
          1000
        : null,
      p50_seconds: nearestRank(backfillDurations, 0.5),
      p95_seconds: nearestRank(backfillDurations, 0.95),
    },
    slo: {
      mature: mature.length,
      successes,
      misses: mature.length - successes,
      censored: ordinary.length - mature.length,
      fraction: mature.length ? successes / mature.length : null,
      wilson_95: wilson95(successes, mature.length),
    },
    service_range:
      mu === null
        ? null
        : {
            lower: Math.min(...rates),
            upper: Math.max(...rates),
            method: 'DAILY_MIN_MAX_NOT_CONFIDENCE_INTERVAL',
          },
    saturated_days: saturated.length,
  };
}
