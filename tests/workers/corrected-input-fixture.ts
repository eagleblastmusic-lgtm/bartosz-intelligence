import { expect } from 'vitest';
import bundle from '../../config/registry/master-bundle.json';
import {
  AccessContext,
  type Database,
} from '../../packages/core/src/db/boundary.js';
import { acceptedCorrectedSource } from '../../packages/core/src/transcript/corrected-authority.js';
import { AnalysisJobs } from '../../packages/core/src/ai/jobs.js';
import { SemanticProfiles } from '../../packages/core/src/registry/semantic-profiles.js';
import { semanticModules } from '../../packages/core/src/ai/semantic-profile.js';
import { ModelRegistry } from '../../packages/core/src/ai/models.js';
import { PromptRegistry } from '../../packages/core/src/registry/store.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { prepareAnalysis } from '../../apps/executor/src/analysis-preparation.js';
import { WorkerRpc } from '../../apps/executor/src/worker-rpc.js';
import { ArtifactClient } from '../../apps/executor/src/artifact-client.js';
import { enrichEconomy } from '../../packages/core/src/ai/enrichment/canonical.js';
import { IntelligenceLedger } from '../../packages/core/src/ai/enrichment/ledger.js';
import type { PipelineProfile } from '../../packages/contracts/src/ai.js';
import { QuotaSnapshots } from '../../packages/core/src/ai/quota-snapshots.js';
import { LocalAnalysisWorker } from '../../apps/executor/src/analysis-worker.js';
import { EvidenceProjection } from '../../packages/core/src/projections/evidence.js';
import { ArtifactRepository } from '../../packages/core/src/artifacts/store.js';

export async function verifyCorrectedInput(
  db: Database,
  owner: AccessContext,
  foreignOwner: AccessContext,
  correctionJobId: string,
  transport: typeof fetch,
) {
  const row = await db
    .prepare(
      "SELECT run_id FROM analysis_runs WHERE owner_id=? AND job_id=? AND state='ACCEPTED'",
    )
    .bind(owner.ownerId, correctionJobId)
    .first<{ run_id: string }>();
  const source = await acceptedCorrectedSource(db, owner, row!.run_id),
    now = new Date();
  await expect(
    acceptedCorrectedSource(db, foreignOwner, row!.run_id),
  ).rejects.toThrow('ANALYSIS_SOURCE_NOT_ACCEPTED');
  const analysis = new AnalysisJobs(db, owner),
    settings = {
      runtime: 'local' as const,
      mode: 'QUALITY_TEST' as const,
      purpose: 'personal',
      region: 'PL',
      max_output_tokens: 1000,
      limits: { claims: 20 },
    };
  await expect(analysis.enqueue(source.run_id, settings, now)).rejects.toThrow(
    'EXPLICIT_CORRECTED_SOURCE_REQUIRED',
  );
  await new PromptRegistry(db, owner).importBundle(bundle, now);
  await new SemanticProfiles(db, owner).save(
    {
      profile_id: 'corrected-input',
      revision: 1,
      name: 'Economy',
      reason: 'Explicit fixture',
      config: {
        mode: 'ECONOMY',
        modules: Object.fromEntries(semanticModules.map((k, i) => [k, i < 7])),
        translation: 'NONE',
        history: false,
        second_pass: null,
        validation_pass: null,
      },
    },
    bundle,
    now,
  );
  const profile: PipelineProfile = {
    profile_id: 'gemini_free',
    revision: 1,
    provider_id: 'gemini',
    model: 'gemini-3.8-flash',
    account_key: 'corrected-fixture',
    free_eligible: true,
    billing_enabled: false,
    purposes: ['personal'],
    regions: ['PL'],
    task_types: ['ECONOMY'],
    runtimes: ['local'],
    structured_output: true,
    context_tokens: 100000,
    output_tokens: 8192,
    rank: 0,
    quality_approvals: [],
    eligibility_expires_at: new Date(now.getTime() + 3600000).toISOString(),
  };
  await new ModelRegistry(db, owner).publish(profile, now);
  const preview = await analysis.previewExplicit(
    source.run_id,
    settings,
    {
      semantic_profile_id: 'corrected-input',
      semantic_profile_revision: 1,
      pass: null,
    },
    now,
  );
  const job = await analysis.confirmExplicit(
    preview.preview_hash,
    crypto.randomUUID(),
    now,
  );
  const credential = 'k'.repeat(43),
    credentialHash = await sha256(credential);
  await db
    .prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'corrected-input-worker',
      owner.ownerId,
      credentialHash,
      '["ANALYZE"]',
      now.toISOString(),
    )
    .run();
  const access = await AccessContext.worker(db, credentialHash),
    store = new JobStore(db, access),
    token = (await store.lease(job.job_id!, 'ANALYZE', now, 'local'))!;
  await store.start(token, 'ANALYZE', now);
  const prepared = await prepareAnalysis(
    new WorkerRpc('https://fixture.invalid', credential, transport),
    new ArtifactClient(
      'https://fixture.invalid',
      credential,
      () => token,
      'ANALYZE',
      transport,
    ),
    token,
    'local',
    now,
  );
  expect(prepared.snapshot.source).toEqual(source);
  expect(prepared.source_text).toBe('Corrected original.');
  const raw = JSON.stringify({
    summary_pl: [
      { text_pl: 'Poprawiona reprezentacja.', segment_refs: ['s1'] },
    ],
    key_points: [],
    entity_mentions: [],
    tools: [],
    claims: [],
    stance: [],
    predictions: [],
    source_issues: [],
  });
  const enriched = await enrichEconomy({
    raw,
    completion: 'OK',
    run_id: prepared.run_id,
    item_id: source.item_id,
    profile_id: 'gemini_free',
    profile_revision: prepared.snapshot_hash,
    approved_aliases: [],
    source: {
      owner_id: owner.ownerId,
      source_artifact_id: source.source_artifact_id,
      source_text: prepared.source_text,
      manifest: prepared.manifest,
      manifest_hash: source.manifest_hash,
      video_url: null,
    },
  });
  expect(enriched.canonical.evidence[0]).toMatchObject({
    quote_original: 'Corrected original.',
    source_artifact_id: source.source_artifact_id,
    start_ms: 250,
    end_ms: 70250,
  });
  expect(
    (
      await new IntelligenceLedger(db, access).prepare(
        enriched,
        prepared.run_id,
        token,
        now,
      )
    ).length,
  ).toBeGreaterThan(0);
  // Fixture-only qualification verifies production mechanics, never provider quality.
  await new ModelRegistry(db, owner).publish(
    {
      ...profile,
      revision: 2,
      quality_approvals: [prepared.request.quality_scope],
    },
    new Date(),
  );
  const production = { ...settings, mode: 'PRODUCTION' as const };
  const productionPreview = await analysis.previewExplicit(
    source.run_id,
    production,
    {
      semantic_profile_id: 'corrected-input',
      semantic_profile_revision: 1,
      pass: null,
    },
    new Date(),
  );
  const productionJob = await analysis.confirmExplicit(
    productionPreview.preview_hash,
    crypto.randomUUID(),
    new Date(),
  );
  const sampled = new Date();
  await new QuotaSnapshots(db, owner).record(
    {
      version: 'gemini-quota-observation:1',
      project: profile.account_key,
      model: profile.model,
      tier: 'FREE',
      source: 'GOOGLE_CLOUD_QUOTA_CURRENT',
      sampled_at: sampled.toISOString(),
      buckets: [
        { bucket: 'RPM', limit: 5, used: 0 },
        { bucket: 'RPD', limit: 20, used: 0 },
        { bucket: 'INPUT_TPM', limit: 250000, used: 0 },
      ],
    },
    sampled,
  );
  const policy = JSON.stringify({ RPM: 0, RPD: 0, INPUT_TPM: 0 });
  await db
    .prepare('INSERT INTO config_versions VALUES(?,?,?,?,?,?)')
    .bind(
      'quota-reserve-gemini_free',
      owner.ownerId,
      1,
      policy,
      await sha256(policy),
      sampled.toISOString(),
    )
    .run();
  let providerCalls = 0;
  const local = new LocalAnalysisWorker(
    'https://fixture.invalid',
    credential,
    'fixture-key',
    transport,
    async () => {
      providerCalls++;
      return Response.json({
        status: 'completed',
        model: profile.model,
        steps: [
          { type: 'model_output', content: [{ type: 'text', text: raw }] },
        ],
        usage: {
          total_input_tokens: 100,
          total_output_tokens: 50,
          total_tokens: 150,
        },
      });
    },
  );
  expect(await local.cycle()).toMatchObject({
    accepted: true,
    state: 'SUCCEEDED',
  });
  expect(providerCalls).toBe(1);
  const accepted = await db
    .prepare(
      "SELECT r.run_id,e.evidence_id FROM analysis_runs r JOIN analysis_evidence e ON e.owner_id=r.owner_id AND e.run_id=r.run_id WHERE r.owner_id=? AND r.job_id=? AND r.state='ACCEPTED'",
    )
    .bind(owner.ownerId, productionJob.job_id!)
    .first<{ run_id: string; evidence_id: string }>();
  const read = await new EvidenceProjection(db, owner).read(
    accepted!.evidence_id,
    accepted!.run_id,
  );
  expect(read).toMatchObject({
    quote_original: 'Corrected original.',
    start_ms: 250,
    end_ms: 70250,
    provenance: {
      source_role: 'CORRECTED_SOURCE',
      original_ref: source.correction.original_ref,
      original_hash: source.correction.original_hash,
    },
  });
  expect(
    (
      await new ArtifactRepository(db, owner).readVerifiedText(
        source.correction.original_ref,
        2 * 1024 * 1024,
      )
    ).text,
  ).toBe('Exact original.');
}
