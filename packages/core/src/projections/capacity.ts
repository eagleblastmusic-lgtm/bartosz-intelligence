import {
  capacityMetricNames,
  type CapacitySnapshot,
  type CapacityMetric,
} from '../../../contracts/src/capacity.js';
// Queue counters alone cannot establish ordinary eligibility or saturated capacity.
export function unobservedCapacity(sampledAt: string): CapacitySnapshot {
  return {
    version: 'capacity:1',
    sampled_at: sampledAt,
    gate_c_status: 'NOT_RUN',
    measurement_window: null,
    eligibility_status: 'UNKNOWN',
    completed: null,
    open: null,
    over_24h: null,
    metrics: Object.fromEntries(
      capacityMetricNames.map((name) => [
        name,
        {
          value: null,
          unit:
            name === 'capacity_headroom'
              ? 'FRACTION'
              : name === 'estimated_drain_time'
                ? 'DAYS'
                : name.endsWith('_age') || name.includes('time_to_analysis')
                  ? 'SECONDS'
                  : 'ITEMS_PER_DAY',
          status: 'UNKNOWN',
          reason:
            name === 'service_rate' ||
            name === 'capacity_headroom' ||
            name === 'estimated_drain_time'
              ? 'SATURATED_MEASUREMENT_REQUIRED'
              : 'OBSERVATION_WINDOW_REQUIRED',
          n: 0,
        } satisfies CapacityMetric,
      ]),
    ) as CapacitySnapshot['metrics'],
  };
}
