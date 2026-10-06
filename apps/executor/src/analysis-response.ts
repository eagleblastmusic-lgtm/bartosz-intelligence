import type { AIResponse } from '../../../packages/contracts/src/ai.js';
import { ArtifactClient } from './artifact-client.js';
import { WorkerRpc } from './worker-rpc.js';
import type { LeaseToken } from '../../../packages/contracts/src/jobs.js';
export async function retainAnalysisResponse(input: {
  origin: string;
  credential: string;
  token: LeaseToken;
  reservation_id: string;
  item_id: string;
  response: AIResponse;
  transport?: typeof fetch;
  task_type?: 'TRANSLATE' | 'HISTORICAL_COMPARE';
}) {
  const { raw_output, ...response } = input.response;
  const artifacts = new ArtifactClient(
    input.origin,
    input.credential,
    () => input.token,
    input.task_type ?? 'ANALYZE',
    input.transport ?? fetch,
    input.reservation_id,
  );
  const artifact = await artifacts.upload(raw_output ?? '', {
    item_id: input.item_id,
    kind: 'ANALYSIS_CANDIDATE',
    schema_version: 'provider-output:1',
    producer_version: 'gemini-response:1:' + input.reservation_id,
    original_ref: null,
    provenance: {
      reservation_id: input.reservation_id,
      response,
      raw_output_present: raw_output !== null,
    },
  });
  return new WorkerRpc(
    input.origin,
    input.credential,
    input.transport ?? fetch,
  ).request((input.task_type ? 'optional' : 'analysis') + '/response', {
    ...(input.task_type ? { task_type: input.task_type } : {}),
    token: input.token,
    reservation_id: input.reservation_id,
    artifact_id: artifact.artifact_id,
  });
}
