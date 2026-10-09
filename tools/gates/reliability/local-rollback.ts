import { randomUUID } from 'node:crypto';
import type {
  AccessContext,
  Database,
} from '../../../packages/core/src/db/boundary.js';
import { sha256 } from '../../../packages/core/src/auth/crypto.js';
import { PromptRegistry } from '../../../packages/core/src/registry/store.js';
import { PromptPublications } from '../../../packages/core/src/registry/publish.js';
import { ModelRegistry } from '../../../packages/core/src/ai/models.js';
import { JobStore } from '../../../packages/core/src/jobs/store.js';
import bundle from '../../../config/registry/master-bundle.json';
import type { PipelineProfile } from '../../../packages/contracts/src/ai.js';

// Fixture versions are provisioned only in isolated D1. No quality promotion.
export async function drillRollback(
  db: Database,
  owner: AccessContext,
  now: Date,
) {
  const registry = new PromptRegistry(db, owner);
  await registry.importBundle(bundle, now);
  let base: Awaited<ReturnType<PromptRegistry['current']>>;
  try {
    base = await registry.current();
  } catch (error) {
    if (!(error instanceof Error && error.message === 'PROMPT_NOT_CONFIGURED'))
      throw error;
    await registry.activate('ECONOMY_ANALYSIS_V1', 2, 0, now);
    base = await registry.current();
  }
  const max = await db
    .prepare(
      'SELECT MAX(version) n FROM prompt_versions WHERE owner_id=? AND prompt_id=?',
    )
    .bind(owner.ownerId, base.prompt_id)
    .first<number>('n');
  const originalText = await db
    .prepare(
      'SELECT prompt_text FROM prompt_versions WHERE owner_id=? AND prompt_id=? AND version=?',
    )
    .bind(owner.ownerId, base.prompt_id, base.version)
    .first<string>('prompt_text');
  if (!originalText) throw new Error('ROLLBACK_FIXTURE_SOURCE_MISSING');
  const version = max! + 1,
    text = originalText + '\nIsolated recovery fixture ' + randomUUID(),
    hash = await sha256(text);
  const compatibility = await db
    .prepare(
      'SELECT bundle_json FROM prompt_versions WHERE owner_id=? AND prompt_id=? AND version=?',
    )
    .bind(owner.ownerId, base.prompt_id, base.version)
    .first<string>('bundle_json');
  await db
    .prepare("INSERT INTO prompt_versions VALUES(?,?,?,?,?,?,'PUBLISHED',?)")
    .bind(
      base.prompt_id,
      owner.ownerId,
      version,
      hash,
      text,
      compatibility,
      now.toISOString(),
    )
    .run();
  await registry.activate(base.prompt_id, version, base.generation, now);
  const captured = await registry.current();
  const job = (await new JobStore(db, owner).enqueue(
    {
      item_id: null,
      source_id: null,
      task_type: 'ANALYZE',
      input_revision: randomUUID(),
      profile_revision: 'isolated',
      routing_policy_version: 'local-primary-1',
      prompt_snapshot_id: captured.prompt_hash,
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: '',
      arrival_origin_at: now.toISOString(),
      origin_kind: 'MANUAL',
      payload: { synthetic_drill: true, prompt: captured },
      priority: 20,
      due_at: now.toISOString(),
    },
    now.toISOString(),
  ))!;
  const publications = new PromptPublications(db, owner);
  const preview = await publications.preview(
    {
      action: 'ROLLBACK',
      prompt_id: base.prompt_id,
      version: base.version,
      report_hash: null,
      reason: 'Isolated compatible recovery drill',
    },
    now,
  );
  const nonce = randomUUID();
  const result = await publications.confirm(preview.preview_hash, nonce, now);
  const repeated = await publications.confirm(preview.preview_hash, nonce, now);
  const restored = await registry.current();
  const preserved = (await new JobStore(db, owner).get(job.job_id))!;
  const preservedPayload = await db
    .prepare('SELECT payload_json FROM jobs WHERE owner_id=? AND job_id=?')
    .bind(owner.ownerId, job.job_id)
    .first<string>('payload_json');
  const models = new ModelRegistry(db, owner);
  let profile = await models.latest('gemini_free');
  if (!profile) {
    profile = {
      profile_id: 'gemini_free',
      revision: 1,
      provider_id: 'gemini',
      model: 'gemini-3.8-flash',
      account_key: 'isolated',
      free_eligible: true,
      billing_enabled: false,
      purposes: ['professional_single_owner'],
      regions: ['PL'],
      task_types: ['ECONOMY'],
      runtimes: ['local'],
      structured_output: true,
      context_tokens: 1048576,
      output_tokens: 65536,
      rank: 1,
      quality_approvals: [],
      eligibility_expires_at: new Date(now.getTime() + 3600000).toISOString(),
    } satisfies PipelineProfile;
    await models.publish(profile, now);
  }
  let mutationDenied = false;
  try {
    await models.publish(
      { ...profile, model: 'gemini-isolated-unqualified' },
      now,
    );
  } catch (error) {
    mutationDenied =
      error instanceof Error && error.message === 'IMMUTABLE_MODEL_CONFLICT';
  }
  const replacement = {
    ...profile,
    revision: profile.revision + 1,
    quality_approvals: [],
  };
  await models.publish(replacement, now);
  const old = await models.load('gemini_free', profile.revision),
    latest = await models.latest('gemini_free');
  const observations = {
    rollback_version: restored.version,
    expected_version: base.version,
    pointer_generation_advanced:
      restored.generation === captured.generation + 1,
    rollback_hash_equal: restored.prompt_hash === base.prompt_hash,
    confirmation_idempotent:
      JSON.stringify(result) === JSON.stringify(repeated),
    queued_snapshot_unchanged:
      preserved.prompt_snapshot_id === captured.prompt_hash &&
      JSON.parse(preservedPayload!).prompt.prompt_hash === captured.prompt_hash,
    queued_job_state: preserved.state,
    origin_preserved: preserved.arrival_origin_at === job.arrival_origin_at,
    model_mutation_rejected: mutationDenied,
    old_model_hash_preserved: JSON.stringify(old) === JSON.stringify(profile),
    new_model_quality_approvals: latest!.quality_approvals.length,
    provider_requests: 0,
    synthetic_versions: true,
  };
  return {
    pass:
      observations.pointer_generation_advanced &&
      observations.rollback_hash_equal &&
      observations.confirmation_idempotent &&
      observations.queued_snapshot_unchanged &&
      preserved.state === 'PENDING' &&
      observations.origin_preserved &&
      mutationDenied &&
      observations.old_model_hash_preserved &&
      latest!.quality_approvals.length === 0,
    observations,
  };
}
