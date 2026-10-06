import { expect, it } from 'vitest';
import {
  gateCCriteria,
  type GateCInput,
} from '../../packages/contracts/src/gate-c.js';
import { evaluateGateC } from '../../packages/telemetry/src/gate-c.js';
import { localDayRange } from '../../packages/core/src/projections/dates.js';
const hash = 'a'.repeat(64);
function fixture(): GateCInput {
  const dates = Array.from({ length: 35 }, (_, i) =>
    new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10),
  );
  const ordinary = Array.from({ length: 100 }, (_, i) => ({
    work_item_id: 'new-' + i,
    item_id: 'new-' + i,
    source_id: 'source-' + (i % 20),
    origin_kind: 'NEW' as const,
    published_at: '2026-09-20T10:00:00.000Z',
    arrival_origin_at: '2026-09-20T10:00:00.000Z',
    eligibility: 'ORDINARY' as const,
    eligibility_recorded_at: '2026-09-20T10:00:00.000Z',
    eligibility_ref: 'ref-' + i,
    analysis_started_at: '2026-09-20T10:00:00.000Z',
    accepted_complete_at: '2026-09-20T11:00:00.000Z',
    accepted_effect_id: 'accepted-new-' + i,
    source_execution_ref: 'retrieval-new-' + i,
  }));
  const probes = Array.from({ length: 70 }, (_, i) => ({
    ...ordinary[0]!,
    origin_kind: 'PROBE' as const,
    work_item_id: 'probe-' + i,
    item_id: 'probe-' + i,
    published_at: '2026-09-01T00:00:00.000Z',
    arrival_origin_at: '2026-09-01T00:00:00.000Z',
    eligibility_recorded_at: '2026-09-01T00:00:00.000Z',
    analysis_started_at: '2026-09-01T00:00:00.000Z',
    accepted_complete_at: dates[Math.floor(i / 10)] + 'T12:00:00.000Z',
    accepted_effect_id: 'effect-probe-' + i,
    source_execution_ref: 'retrieval-probe-' + i,
  }));
  return {
    version: 'gate-c-input:1',
    basis: 'SYNTHETIC',
    measurements: {
      version: 'capacity-measurements:1',
      config_hash: hash,
      timezone: 'Europe/Warsaw',
      start_date: dates[0]!,
      end_date_exclusive: '2026-10-06',
      sampled_at: '2026-10-07T12:00:00.000Z',
      cases: [...ordinary, ...probes],
      days: dates.map((date, i) => ({
        date,
        config_hash: hash,
        phase: i < 7 ? 'SATURATED' : 'NORMAL',
        ordinary_open_new: 100 - i,
        ordinary_open_backfill: 0,
        continuous_representative_backlog: i < 7,
        actual_quota_windows_observed: true,
        real_source_retrieval: true,
        qualified_pipeline: true,
        evidence_ref: 'day-' + i,
        enumeration_complete: true,
      })),
      excess_backlog: 65,
    },
    preregistration: {
      source_ids: Array.from({ length: 20 }, (_, i) => 'source-' + i),
      trace_days: 30,
      calibration_days: 7,
      observation_days: 28,
      arrival_end_at: localDayRange('2026-10-06').start,
      evidence_ref: 'f'.repeat(64),
    },
    conservative_service_rate: { value: 8, evidence_ref: 'e'.repeat(64) },
    proofs: Object.fromEntries(
      gateCCriteria.map((criterion, i) => [
        criterion,
        { status: 'PASS', evidence_ref: String(i).repeat(64) },
      ]),
    ) as GateCInput['proofs'],
  };
}
it('synthetic PASS fixtures never become production Gate C PASS and real production needs verified receipts', () => {
  const input = fixture();
  expect(evaluateGateC(input)).toMatchObject({
    version: 'GateCReport/1.0',
    status: 'NOT_RUN',
    synthetic_decision: 'PASS',
    maturity: true,
  });
  input.basis = 'REAL_PRODUCTION';
  expect(evaluateGateC(input).status).toBe('INCONCLUSIVE');
});
it('each of the eight missing proofs prevents a qualified decision', () => {
  for (const criterion of gateCCriteria) {
    const input = fixture();
    input.proofs[criterion].evidence_ref = null;
    const report = evaluateGateC(input);
    expect(report.synthetic_decision, criterion).not.toBe('PASS');
    expect(
      report.scorecard.find((row) => row.criterion === criterion)!.status,
    ).toBe('UNKNOWN');
  }
});
it('rejects optimistic throughput from idle/source-cache days or missing conservative range', () => {
  let input = fixture();
  input.measurements.days[0]!.real_source_retrieval = false;
  expect(evaluateGateC(input).synthetic_decision).not.toBe('PASS');
  input = fixture();
  input.conservative_service_rate.value = null;
  expect(evaluateGateC(input).synthetic_decision).not.toBe('PASS');
  input = fixture();
  input.conservative_service_rate.value = 2;
  expect(evaluateGateC(input).synthetic_decision).toBe('FAIL');
});
it('small/missing cohorts and observation windows cannot mature; open over-deadline cases are misses', () => {
  let input = fixture();
  input.measurements.cases = input.measurements.cases.filter(
    (row) => row.work_item_id !== 'new-0',
  );
  expect(evaluateGateC(input).synthetic_decision).not.toBe('PASS');
  input = fixture();
  input.preregistration.observation_days = 27;
  expect(evaluateGateC(input).synthetic_decision).toBe('NOT_YET_MATURE');
  input = fixture();
  input.preregistration.calibration_days = 6;
  expect(evaluateGateC(input).synthetic_decision).toBe('NOT_YET_MATURE');
  input = fixture();
  input.measurements.cases.slice(0, 6).forEach((row) => {
    row.accepted_complete_at = null;
    row.accepted_effect_id = null;
  });
  expect(evaluateGateC(input).synthetic_decision).toBe('FAIL');
});
it('audited paid/quality/CPU failures are retained even without a receipt, and cannot be hidden by time immaturity', () => {
  for (const criterion of [
    'zero_paid_audit',
    'quality_cpu_integrity',
  ] as const) {
    const input = fixture();
    input.proofs[criterion] = { status: 'FAIL', evidence_ref: null };
    input.preregistration.observation_days = 1;
    expect(evaluateGateC(input).synthetic_decision).toBe('FAIL');
  }
});
it('checks last fourteen normal days instead of allowing an earlier declining backlog to hide recent growth', () => {
  const input = fixture();
  input.measurements.days.slice(-14).forEach((day, i) => {
    day.ordinary_open_new = i;
  });
  const report = evaluateGateC(input);
  expect(report.synthetic_decision).toBe('FAIL');
  expect(
    report.scorecard.find((row) => row.criterion === 'normal_backlog_trend')!
      .reason,
  ).toBe('NORMAL_BACKLOG_GROWTH');
});
it('retains measured-criterion FAIL when missing observations would otherwise yield UNKNOWN', () => {
  for (const criterion of [
    'sustainable_capacity',
    'ordinary_24h_slo',
    'normal_backlog_trend',
  ] as const) {
    const input = fixture();
    input.proofs[criterion] = { status: 'FAIL', evidence_ref: null };
    input.conservative_service_rate.value = null;
    input.measurements.cases = [];
    input.measurements.days = [];
    expect(evaluateGateC(input).synthetic_decision).toBe('FAIL');
  }
});
