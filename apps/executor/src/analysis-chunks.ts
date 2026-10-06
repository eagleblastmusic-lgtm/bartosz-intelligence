import { ArtifactClient } from './artifact-client.js';
import { WorkerRpc } from './worker-rpc.js';
import { loadAnalysisSource } from './analysis-preparation.js';
import { createChunkPlan } from '../../../packages/core/src/ai/long-input/plan.js';
import {
  economyChunkContextHash,
  economyPromptOverhead,
} from '../../../packages/core/src/ai/compiler.js';
import type { LeaseToken } from '../../../packages/contracts/src/jobs.js';

// The caller reaches this only after complete ordinary compilation rejects its
// input budget. No provider request is made by planning or child enqueue.
export async function prepareLongAnalysis(input: {
  origin: string;
  credential: string;
  token: LeaseToken;
  transport?: typeof fetch;
}) {
  const rpc = new WorkerRpc(input.origin, input.credential, input.transport),
    artifacts = new ArtifactClient(
      input.origin,
      input.credential,
      () => input.token,
      'ANALYZE',
      input.transport,
    );
  const { prepared, snapshot, map } = await loadAnalysisSource(
    rpc,
    artifacts,
    input.token,
    'local',
  );
  if (snapshot.chunk) throw new Error('CHUNK_CANNOT_CREATE_CHILDREN');
  const semantic = snapshot.semantic_context ?? {
    title: null,
    author: null,
    published_at: null,
    source_language: snapshot.source.language_code,
  };
  const built = await createChunkPlan({
    manifest: JSON.parse(map.text),
    manifest_hash: snapshot.source.manifest_hash,
    context_hash: await economyChunkContextHash({
      manifest_hash: snapshot.source.manifest_hash,
      prompt: snapshot.prompt,
      profile: snapshot.profile,
      profile_revision: prepared.snapshot_hash,
      max_output_tokens: snapshot.settings.max_output_tokens,
      limits: snapshot.settings.limits,
      semantic_context: semantic,
    }),
    context_tokens: snapshot.profile.context_tokens,
    output_tokens: snapshot.settings.max_output_tokens,
    prompt_overhead_tokens: economyPromptOverhead({
      prompt: snapshot.prompt,
      semantic_context: semantic,
      limits: snapshot.settings.limits,
    }),
  });
  const artifact = await artifacts.upload(JSON.stringify(built.plan), {
    item_id: snapshot.source.item_id,
    kind: 'NORMALIZED',
    schema_version: 'chunk-plan:1',
    producer_version: 'chunk-planner:1',
    original_ref: snapshot.source.source_artifact_id,
    provenance: {
      parent_job_id: input.token.job_id,
      parent_snapshot_hash: prepared.snapshot_hash,
    },
  });
  return resumeChunkPreparation(
    rpc,
    input.token,
    artifact.artifact_id,
    built.plan_hash,
  );
}
export async function resumeChunkPreparation(
  rpc: Pick<WorkerRpc, 'request'>,
  token: LeaseToken,
  artifactId: string,
  planHash: string,
) {
  for (let page = 0; page < 16; page++) {
    const result = (await rpc.request('analysis/chunks/create', {
      token,
      plan_artifact_id: artifactId,
    })) as {
      preparation_complete: boolean;
      state: 'RUNNING' | 'DEFERRED';
      plan_hash: string;
    };
    if (result.plan_hash !== planHash) throw new Error('CHUNK_PLAN_MISMATCH');
    if (result.preparation_complete)
      return {
        accepted: false,
        idle: false,
        state: result.state,
        generation_requests: 0,
      };
  }
  throw new Error('CHUNK_PREPARATION_PAGE_LIMIT');
}
