import type {
  AIRequest,
  AIResponse,
} from '../../../packages/contracts/src/ai.js';
import type { LeaseToken } from '../../../packages/contracts/src/jobs.js';
import { GeminiFreeProvider } from '../../../packages/core/src/ai/gemini.js';
import { sha256 } from '../../../packages/core/src/auth/crypto.js';
import { ArtifactClient } from './artifact-client.js';
import { executeAnalysis } from './analysis-runner.js';
import { prepareAnalysis } from './analysis-preparation.js';
import { retainAnalysisResponse } from './analysis-response.js';
import { WorkerRpc } from './worker-rpc.js';

export async function executePreparedAnalysis(input: {
  request: AIRequest;
  token: LeaseToken;
  key: string;
  rpc: Pick<WorkerRpc, 'request'>;
  retain: (
    reservationId: string,
    token: LeaseToken,
    response: AIResponse,
  ) => Promise<unknown>;
  providerTransport?: typeof fetch;
  // Explicit comparison only; default production transport remains interactions.
  diagnosticEndpoint?: 'generateContent';
  clock?: () => Date;
  task_type?: 'TRANSLATE' | 'HISTORICAL_COMPARE';
}) {
  if (input.request.runtime !== 'local')
    throw new Error('INVALID_EXECUTION_RUNTIME');
  let token = input.token;
  const task = input.task_type ?? 'ANALYZE',
    prefix = input.task_type ? 'optional' : 'analysis';
  const taskFields = input.task_type ? { task_type: input.task_type } : {};
  let permit: { reservation_id: string; request_id: string } | null = null;
  let submissionAttempted = false,
    retained = false;
  let responseArtifactId: string | null = null;
  const diagnostics: string[] = [];
  const provider = new GeminiFreeProvider(
    input.key,
    async (submitted) => {
      if (
        !permit ||
        submissionAttempted ||
        submitted.reservation_id !== permit.reservation_id ||
        submitted.request_id !== input.request.request_id
      )
        throw new Error('INVALID_AI_REQUEST_SCOPE');
      // An ambiguous control-plane submit is never retried in this invocation.
      submissionAttempted = true;
      const result = (await input.rpc.request(prefix + '/submit', {
        ...taskFields,
        token,
        reservation_id: permit.reservation_id,
        request_prompt_hash: await sha256(input.request.prompt),
      })) as { reservation_id: string };
      if (result.reservation_id !== permit.reservation_id)
        throw new Error('INVALID_AI_SUBMISSION_RECEIPT');
    },
    input.providerTransport ?? fetch,
    input.clock ?? (() => new Date()),
    input.diagnosticEndpoint ?? 'interactions',
  );
  const result = await executeAnalysis(input.request, provider, {
    reserve: async (request) => {
      const response = (await input.rpc.request(prefix + '/reserve', {
        ...taskFields,
        token,
        request_id: request.request_id,
        input_tokens: request.estimated_input_tokens,
      })) as { reservation_id: string; request_id: string };
      if (
        response.request_id !== request.request_id ||
        !/^[a-f0-9-]{36}$/.test(response.reservation_id)
      )
        throw new Error('INVALID_AI_RESERVATION_RECEIPT');
      permit = response;
      return response;
    },
    heartbeat: async () => {
      const response = (await input.rpc.request('heartbeat', {
        runtime: 'local',
        task_type: task,
        token,
      })) as { token: LeaseToken | null };
      if (
        !response.token ||
        response.token.job_id !== token.job_id ||
        response.token.fencing_token !== token.fencing_token ||
        response.token.lease_owner !== token.lease_owner ||
        !Number.isFinite(Date.parse(response.token.lease_until))
      )
        throw new Error('STALE_FENCE');
      token = response.token;
    },
    retainCandidate: async (response) => {
      if (!permit || response.request_id !== input.request.request_id)
        throw new Error('INVALID_AI_RESPONSE_RECEIPT');
      const receipt = (await input.retain(
        permit.reservation_id,
        token,
        response,
      )) as {
        request_id: string;
        diagnostic_only: boolean;
        artifact_id: string;
      };
      if (
        receipt.request_id !== response.request_id ||
        receipt.diagnostic_only !== true ||
        typeof receipt.artifact_id !== 'string' ||
        !receipt.artifact_id ||
        receipt.artifact_id.length > 128
      )
        throw new Error('INVALID_AI_RESPONSE_RECEIPT');
      retained = true;
      responseArtifactId = receipt.artifact_id;
    },
    reconcile: async (reservationId) => {
      // Retention's existing server endpoint settles from immutable artifact
      // metadata. No second worker assertion or raw provider body is submitted.
      if (!retained || reservationId !== permit?.reservation_id)
        throw new Error('AI_RESPONSE_NOT_DURABLE');
    },
    diagnostic: async (code) => {
      diagnostics.push(code);
    },
  });
  return {
    ...result,
    reservation_id: permit!.reservation_id,
    token,
    diagnostics,
    // Assignment occurs inside the awaited retention callback; retain its declared union.
    response_artifact_id: responseArtifactId as string | null,
  };
}

// Source preparation and control RPC use the app origin; only the qualified
// provider receives the API key. Only qualified production requests may commit.
export async function executeLocalAnalysis(input: {
  origin: string;
  credential: string;
  key: string;
  token: LeaseToken;
  controlTransport?: typeof fetch;
  providerTransport?: typeof fetch;
}) {
  const transport = input.controlTransport ?? fetch;
  const rpc = new WorkerRpc(input.origin, input.credential, transport);
  const artifacts = new ArtifactClient(
    input.origin,
    input.credential,
    () => input.token,
    'ANALYZE',
    transport,
  );
  const prepared = await prepareAnalysis(
    rpc,
    artifacts,
    input.token,
    'local',
    new Date(),
  );
  const result = await executePreparedAnalysis({
    request: prepared.request,
    token: input.token,
    key: input.key,
    rpc,
    providerTransport: input.providerTransport,
    retain: (reservation_id, token, response) =>
      retainAnalysisResponse({
        ...input,
        token,
        reservation_id,
        item_id: prepared.snapshot.source.item_id,
        response,
        transport,
      }),
  });
  const validation = result.eligible_for_validation
    ? await rpc.request('analysis/validate', {
        token: result.token,
        reservation_id: result.reservation_id,
        artifact_id: result.response_artifact_id,
      })
    : null;
  const completion =
    validation &&
    typeof validation === 'object' &&
    'status' in validation &&
    validation.status === 'VALIDATED'
      ? await rpc.request(
          prepared.snapshot.chunk
            ? 'analysis/chunk-finish'
            : prepared.snapshot.settings.mode === 'PRODUCTION'
              ? 'analysis/complete'
              : 'analysis/quality-finish',
          {
            token: result.token,
            reservation_id: result.reservation_id,
            artifact_id: result.response_artifact_id,
          },
        )
      : null;
  const disposition =
    !completion && !result.diagnostics.includes('STALE_LEASE_RESPONSE')
      ? await rpc.request('analysis/disposition', {
          token: result.token,
          reservation_id: result.reservation_id,
          artifact_id: result.response_artifact_id,
        })
      : null;
  return { ...prepared, ...result, validation, completion, disposition };
}
