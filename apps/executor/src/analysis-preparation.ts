import { WorkerRpc } from './worker-rpc.js';
import { ArtifactClient } from './artifact-client.js';
import type { LeaseToken } from '../../../packages/contracts/src/jobs.js';
import type { AnalysisJobSnapshot } from '../../../packages/core/src/ai/jobs.js';
import {
  compileEconomy,
  compileSemanticAnalysis,
} from '../../../packages/core/src/ai/compiler.js';
import { sha256 } from '../../../packages/core/src/auth/crypto.js';
import type { ChunkPlan } from '../../../packages/core/src/ai/long-input/plan.js';

// Preparation is local and has no provider transport. ArtifactClient verifies
// the complete source bytes; ordinary compilation cannot silently truncate them.
export async function loadAnalysisSource(
  rpc: WorkerRpc,
  artifacts: Pick<ArtifactClient, 'readText'>,
  token: LeaseToken,
  runtime: 'local' | 'cloud',
) {
  const prepared = (await rpc.request('analysis/input', { token })) as {
    run_id: string;
    snapshot: AnalysisJobSnapshot;
    snapshot_hash: string;
    chunk_plan_available?: boolean;
  };
  const snapshot = prepared.snapshot;
  if (
    !snapshot ||
    snapshot.version !== 'analysis-job:1' ||
    (await sha256(JSON.stringify(snapshot))) !== prepared.snapshot_hash ||
    snapshot.settings.runtime !== runtime ||
    !/^analysis_[a-f0-9]{64}$/.test(prepared.run_id)
  )
    throw new Error('ANALYSIS_JOB_SNAPSHOT_MISMATCH');
  if (prepared.chunk_plan_available && !snapshot.chunk)
    throw new Error('CHUNKS_WAITING');
  const source = await artifacts.readText(snapshot.source.source_artifact_id);
  const map = await artifacts.readText(snapshot.source.segment_map_artifact_id);
  if (
    source.artifact.kind !==
      (snapshot.source.correction ? 'NORMALIZED' : 'SOURCE_ORIGINAL') ||
    source.artifact.item_id !== snapshot.source.item_id ||
    source.artifact.content_hash !== snapshot.source.source_hash ||
    map.artifact.kind !== 'SEGMENT_MAP' ||
    map.artifact.item_id !== snapshot.source.item_id ||
    map.artifact.original_ref !==
      (snapshot.source.correction?.original_ref ??
        source.artifact.artifact_id) ||
    map.artifact.content_hash !== snapshot.source.manifest_hash ||
    map.artifact.producer_version !==
      (snapshot.source.correction?.producer_version ?? 'source-normalizer:1') ||
    (snapshot.source.correction &&
      (source.artifact.original_ref !==
        snapshot.source.correction.original_ref ||
        source.artifact.producer_version !==
          snapshot.source.correction.producer_version))
  )
    throw new Error('ANALYSIS_SOURCE_ARTIFACT_MISMATCH');
  return { prepared, snapshot, source, map };
}
export async function prepareAnalysis(
  rpc: WorkerRpc,
  artifacts: Pick<ArtifactClient, 'readText'>,
  token: LeaseToken,
  runtime: 'local' | 'cloud',
  now: Date,
) {
  const { prepared, snapshot, source, map } = await loadAnalysisSource(
    rpc,
    artifacts,
    token,
    runtime,
  );
  const chunkPlan = snapshot.chunk
    ? await artifacts.readText(snapshot.chunk.plan_artifact_id)
    : null;
  if (
    chunkPlan &&
    (chunkPlan.artifact.content_hash !== snapshot.chunk!.plan_hash ||
      chunkPlan.artifact.kind !== 'NORMALIZED' ||
      chunkPlan.artifact.schema_version !== 'chunk-plan:1' ||
      chunkPlan.artifact.original_ref !== snapshot.source.source_artifact_id)
  )
    throw new Error('CHUNK_PLAN_MISMATCH');
  const compilerInput = {
    source_artifact_id: source.artifact.artifact_id,
    ...(snapshot.source.correction
      ? { source_role: 'CORRECTED_SOURCE' as const }
      : {}),
    source_text: source.text,
    manifest: JSON.parse(map.text),
    manifest_hash: map.artifact.content_hash,
    prompt: snapshot.prompt,
    profile: snapshot.profile,
    profile_revision: prepared.snapshot_hash,
    semantic_context: snapshot.semantic_context ?? {
      title: null,
      author: null,
      published_at: null,
      source_language: snapshot.source.language_code,
    },
    runtime,
    request_id: prepared.run_id,
    deadline: new Date(now.getTime() + 300000).toISOString(),
    mode: snapshot.settings.mode,
    max_output_tokens: snapshot.settings.max_output_tokens,
    limits: snapshot.settings.limits,
    ...(snapshot.additional_pass
      ? { additional_pass: snapshot.additional_pass }
      : {}),
    chunk: chunkPlan
      ? {
          plan: JSON.parse(chunkPlan.text) as ChunkPlan,
          plan_hash: snapshot.chunk!.plan_hash,
          chunk_index: snapshot.chunk!.chunk_index,
          parent_snapshot_hash: snapshot.chunk!.parent_snapshot_hash,
        }
      : undefined,
  };
  const compiled = snapshot.semantic_profile
    ? await compileSemanticAnalysis({
        ...compilerInput,
        semantic_profile: snapshot.semantic_profile.compiled,
      })
    : await compileEconomy(compilerInput);
  if (compiled.request.quality_scope !== snapshot.quality_scope)
    throw new Error('ANALYSIS_QUALITY_SCOPE_MISMATCH');
  const receipt = (await rpc.request('analysis/context', {
    token,
    context: compiled.run_context,
    context_hash: compiled.context_hash,
    request_prompt_hash: await sha256(compiled.request.prompt),
  })) as { run_id: string; context_hash: string };
  if (
    receipt.run_id !== prepared.run_id ||
    receipt.context_hash !== compiled.context_hash
  )
    throw new Error('ANALYSIS_CONTEXT_CONFLICT');
  return {
    ...prepared,
    ...compiled,
    source_text: source.text,
    manifest: JSON.parse(map.text),
  };
}
