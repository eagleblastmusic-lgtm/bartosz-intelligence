export type GateStatus = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'NOT_RUN';
export function evaluateStage01(input: {
  activeGates: Record<string, GateStatus>;
  evidenceComplete: boolean;
  cleanVerification: GateStatus;
  architectureChangeRequired: boolean;
  inactiveConditions: string[];
}): 'GO' | 'GO-WITH-CONDITIONS' | 'NO-GO' {
  if (
    !input.evidenceComplete ||
    Object.keys(input.activeGates).length === 0 ||
    Object.values(input.activeGates).some((status) => status !== 'PASS') ||
    input.cleanVerification !== 'PASS' ||
    input.architectureChangeRequired
  )
    return 'NO-GO';
  return input.inactiveConditions.length ? 'GO-WITH-CONDITIONS' : 'GO';
}
