import { gateCCriteria, type GateCInput } from '../../contracts/src/gate-c.js';
import { capacityMetrics } from './capacity.js';
export function evaluateGateC(
  input: GateCInput,
  productionEvidenceVerified = false,
) {
  if (
    input.version !== 'gate-c-input:1' ||
    !['REAL_PRODUCTION', 'SYNTHETIC'].includes(input.basis)
  )
    throw new Error('INVALID_GATE_C_INPUT');
  const measured = capacityMetrics(input.measurements);
  const registration = input.preregistration;
  if (
    !Number.isFinite(Date.parse(registration.arrival_end_at)) ||
    !Array.isArray(registration.source_ids) ||
    registration.source_ids.some(
      (id) => typeof id !== 'string' || !id || id.length > 128,
    ) ||
    new Set(registration.source_ids).size !== registration.source_ids.length ||
    [
      registration.trace_days,
      registration.calibration_days,
      registration.observation_days,
    ].some((days) => !Number.isSafeInteger(days) || days < 0)
  )
    throw new Error('INVALID_GATE_C_PREREGISTRATION');
  const lower = input.conservative_service_rate.value;
  if (lower !== null && (!Number.isFinite(lower) || lower < 0))
    throw new Error('INVALID_GATE_C_SERVICE_BOUND');
  const lambda = measured.snapshot.metrics.arrival_rate.value;
  const mu = measured.snapshot.metrics.service_rate.value;
  if (lower !== null && mu !== null && lower > mu)
    throw new Error('INVALID_GATE_C_SERVICE_BOUND');
  const maturity =
    registration.source_ids.length === 20 &&
    registration.trace_days >= 30 &&
    registration.calibration_days >= 7 &&
    registration.observation_days >= 28 &&
    Date.parse(input.measurements.sampled_at) -
      Date.parse(registration.arrival_end_at) >=
      86400000 &&
    !!registration.evidence_ref &&
    input.measurements.days.length >= 28 &&
    (Date.parse(input.measurements.end_date_exclusive + 'T12:00:00Z') -
      Date.parse(input.measurements.start_date + 'T12:00:00Z')) /
      86400000 >=
      28;
  const scorecard = gateCCriteria.map((criterion) => {
    const proof = input.proofs?.[criterion];
    if (!proof || !['PASS', 'FAIL', 'UNKNOWN'].includes(proof.status))
      throw new Error('INVALID_GATE_C_PROOF');
    let status = proof.status,
      reason: string | null = null;
    if (!proof.evidence_ref && status !== 'FAIL') {
      status = 'UNKNOWN';
      reason = 'EVIDENCE_REQUIRED';
    }
    if (criterion === 'sustainable_capacity') {
      if (
        lambda === null ||
        mu === null ||
        lower === null ||
        !input.conservative_service_rate.evidence_ref
      ) {
        status = 'UNKNOWN';
        reason = 'SATURATED_MEASUREMENT_AND_CONSERVATIVE_BOUND_REQUIRED';
      } else if (
        mu <= lambda ||
        lower <= lambda ||
        (lower - lambda) / lower < 0.2
      ) {
        status = 'FAIL';
        reason = 'INSUFFICIENT_SUSTAINABLE_HEADROOM';
      }
    }
    if (criterion === 'ordinary_24h_slo') {
      if (measured.unknown_eligibility || measured.slo.mature < 100) {
        status = 'UNKNOWN';
        reason = 'MATURE_CLASSIFIED_COHORT_REQUIRED';
      } else if (measured.slo.fraction! < 0.95) {
        status = 'FAIL';
        reason = 'ORDINARY_24H_SLO_MISSED';
      }
    }
    if (criterion === 'normal_backlog_trend') {
      const normal = input.measurements.days
        .filter((day) => day.phase === 'NORMAL')
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-14);
      const xs = normal.map(
          (day) => Date.parse(day.date + 'T12:00:00Z') / 86400000,
        ),
        ys = normal.map((day) => day.ordinary_open_new);
      const xMean = xs.reduce((a, b) => a + b, 0) / xs.length,
        yMean = ys.reduce<number>((a, b) => a + (b ?? 0), 0) / ys.length;
      const divisor = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
      const trend =
        divisor > 0
          ? xs.reduce(
              (sum, x, index) => sum + (x - xMean) * ((ys[index] ?? 0) - yMean),
              0,
            ) / divisor
          : null;
      if (
        normal.length < 14 ||
        trend === null ||
        normal.some(
          (day) => day.ordinary_open_new === null || !day.evidence_ref,
        )
      ) {
        status = 'UNKNOWN';
        reason = 'FOURTEEN_NORMAL_DAILY_CUTS_REQUIRED';
      } else if (
        trend > 0 ||
        normal.at(-1)!.ordinary_open_new! > normal[0]!.ordinary_open_new!
      ) {
        status = 'FAIL';
        reason = 'NORMAL_BACKLOG_GROWTH';
      }
    }
    if (proof.status === 'FAIL' && status !== 'FAIL') {
      status = 'FAIL';
      reason = 'RECORDED_FAILURE_REQUIRES_NEW_EVIDENCE';
    }
    return { criterion, status, reason, evidence_ref: proof.evidence_ref };
  });
  const hardFailure = scorecard.some((row) => row.status === 'FAIL');
  const decision = hardFailure
    ? 'FAIL'
    : !maturity
      ? 'NOT_YET_MATURE'
      : scorecard.every((row) => row.status === 'PASS') &&
          (input.basis === 'SYNTHETIC' || productionEvidenceVerified)
        ? 'PASS'
        : 'INCONCLUSIVE';
  return {
    version: 'GateCReport/1.0',
    basis: input.basis,
    config_hash: input.measurements.config_hash,
    sampled_at: input.measurements.sampled_at,
    status: input.basis === 'SYNTHETIC' ? 'NOT_RUN' : decision,
    synthetic_decision: input.basis === 'SYNTHETIC' ? decision : null,
    maturity,
    scorecard,
    metrics: measured,
  };
}
