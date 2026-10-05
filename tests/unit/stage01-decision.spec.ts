import { expect, it } from 'vitest';
import { evaluateStage01 } from '../../tools/gates/stage01-decision.js';
const valid = {
  activeGates: {
    eligibility: 'PASS',
    source: 'PASS',
    runtime: 'PASS',
  } as const,
  evidenceComplete: true,
  cleanVerification: 'PASS' as const,
  architectureChangeRequired: false,
  inactiveConditions: [],
};
it('requires all active gates and evidence; a condition cannot hide failure', () => {
  expect(evaluateStage01(valid)).toBe('GO');
  for (const status of ['FAIL', 'INCONCLUSIVE', 'NOT_RUN'] as const) {
    expect(
      evaluateStage01({
        ...valid,
        activeGates: { source: status },
        inactiveConditions: ['cannot waive active gate'],
      }),
    ).toBe('NO-GO');
    expect(evaluateStage01({ ...valid, cleanVerification: status })).toBe(
      'NO-GO',
    );
  }
  expect(evaluateStage01({ ...valid, evidenceComplete: false })).toBe('NO-GO');
  expect(evaluateStage01({ ...valid, activeGates: {} })).toBe('NO-GO');
  expect(evaluateStage01({ ...valid, architectureChangeRequired: true })).toBe(
    'NO-GO',
  );
});
it('permits conditions only on inactive scope', () => {
  expect(
    evaluateStage01({
      ...valid,
      inactiveConditions: ['Edge disabled pending CPU PASS'],
    }),
  ).toBe('GO-WITH-CONDITIONS');
});
