import type {
  AIProvider,
  AIRequest,
  AIResponse,
} from '../../../packages/contracts/src/ai.js';
import {
  compileStructuralRepair,
  validateStructuralRepair,
} from '../../../packages/core/src/ai/repair/structural.js';
export interface AnalysisLifecycle {
  reserve(
    request: AIRequest,
  ): Promise<{ reservation_id: string; request_id: string }>;
  heartbeat(): Promise<void>;
  retainCandidate(response: AIResponse): Promise<void>;
  reconcile(reservationId: string, response: AIResponse): Promise<void>;
  diagnostic(code: string): Promise<void>;
}
export async function executeAnalysis(
  request: AIRequest,
  provider: AIProvider,
  lifecycle: AnalysisLifecycle,
  heartbeatMs = 60000,
) {
  if (heartbeatMs < 10 || heartbeatMs > 60000)
    throw new Error('INVALID_HEARTBEAT_INTERVAL');
  const permit = await lifecycle.reserve(request);
  let lost = false,
    pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending
      .then(() => lifecycle.heartbeat())
      .catch(() => {
        lost = true;
      });
  }, heartbeatMs);
  let response: AIResponse;
  try {
    response = await provider.run(request, permit);
  } finally {
    clearInterval(timer);
    await pending;
  }
  try {
    await lifecycle.heartbeat();
  } catch {
    lost = true;
  }
  // Diagnostic candidate/usage survive a late response; no active selection or
  // accepted effect is committed by this transport runner.
  await lifecycle.retainCandidate(response);
  await lifecycle.reconcile(permit.reservation_id, response);
  if (lost) {
    await lifecycle.diagnostic('STALE_LEASE_RESPONSE');
    return { response, eligible_for_validation: false };
  }
  return { response, eligible_for_validation: response.status === 'OK' };
}
export async function executeRepair(
  input: Parameters<typeof compileStructuralRepair>[0],
  provider: AIProvider,
  lifecycle: AnalysisLifecycle & {
    claimRepair(
      admission: Awaited<
        ReturnType<typeof compileStructuralRepair>
      >['admission'],
      requestId: string,
    ): Promise<boolean>;
  },
) {
  const compiled = await compileStructuralRepair(input);
  const result = await executeAnalysis(compiled.request, provider, {
    ...lifecycle,
    reserve: async (request) => {
      const permit = await lifecycle.reserve(request);
      if (
        !(await lifecycle.claimRepair(compiled.admission, request.request_id))
      )
        throw new Error('REPAIR_ALREADY_CONSUMED_OR_STALE');
      return permit;
    },
  });
  if (!result.eligible_for_validation) return { ...result, validated: null };
  // No recursive repair: repair wire and the repaired analysis must both pass.
  return {
    ...result,
    validated: await validateStructuralRepair(
      result.response,
      compiled.reference,
      input.aliases,
      input.semantic_profile,
    ),
  };
}
