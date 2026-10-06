import { expect } from 'vitest';
import bundle from '../../config/registry/master-bundle.json';
import {
  AccessContext,
  type Database,
} from '../../packages/core/src/db/boundary.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import {
  OptionalAIJobs,
  type OptionalTaskSnapshot,
} from '../../packages/core/src/ai/tasks/jobs.js';
import { historyPlan } from '../../packages/core/src/ai/tasks/history.js';
import { compileHistory } from '../../packages/core/src/ai/tasks/compiler.js';
import {
  PromptRegistry,
  type PromptSnapshot,
} from '../../packages/core/src/registry/store.js';
import { ModelRegistry } from '../../packages/core/src/ai/models.js';
import { QuotaSnapshots } from '../../packages/core/src/ai/quota-snapshots.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { ArtifactRepository } from '../../packages/core/src/artifacts/store.js';
import { OptionalResultProjection } from '../../packages/core/src/projections/optional.js';
import type { PipelineProfile } from '../../packages/contracts/src/ai.js';
import type { enrichEconomy } from '../../packages/core/src/ai/enrichment/canonical.js';
import { fixtureNow, fixtureSecret, fixtureOwner } from './core-fixture.js';
export async function verifyOptionalHistory(
  db: Database,
  owner: AccessContext,
  itemId: string,
  canonical: Awaited<ReturnType<typeof enrichEconomy>>['canonical'],
) {
  const meta = await db
    .prepare(
      'SELECT o.run_id,o.row_hash,o.row_json,r.accepted_at,i.published_at FROM observations o JOIN analysis_runs r ON r.owner_id=o.owner_id AND r.run_id=o.run_id JOIN items i ON i.owner_id=r.owner_id AND i.item_id=r.item_id WHERE o.owner_id=? AND r.item_id=? ORDER BY o.observation_id LIMIT 1',
    )
    .bind(owner.ownerId, itemId)
    .first<{
      run_id: string;
      row_hash: string;
      row_json: string;
      accepted_at: string;
      published_at: string | null;
    }>();
  const row = JSON.parse(meta!.row_json) as (typeof canonical.claims)[number];
  const plan = await historyPlan({
    owner_id: owner.ownerId,
    current_item_id: itemId,
    current_run_id: meta!.run_id,
    cut: fixtureNow.toISOString(),
    scope_note_pl: 'Ograniczony kontekst bez wcześniejszych wypowiedzi.',
    current: [
      {
        owner_id: owner.ownerId,
        item_id: itemId,
        run_id: meta!.run_id,
        accepted_at: meta!.accepted_at,
        published_at: meta!.published_at,
        row_hash: meta!.row_hash,
        row,
        evidence: canonical.evidence.filter((e) =>
          row.evidence_ids.includes(e.evidence_id),
        ),
      },
    ],
    prior: [],
  });
  await new PromptRegistry(db, owner).importBundle(bundle, fixtureNow);
  const template = bundle.prompts.find(
    (p) => p.id === 'HISTORICAL_COMPARE_V1',
  )!;
  const prompt: PromptSnapshot = {
    prompt_id: template.id,
    version: 2,
    prompt_hash: template.hash,
    text: template.text,
    wire: bundle.schemas.find(
      (s) => s.id === 'urn:bartosz:schema:history-wire:1.0',
    )!,
    canonical: bundle.schemas.find(
      (s) => s.id === 'urn:bartosz:schema:historical:1.0',
    )!,
    enrichment_version: '1.0',
    generation: 1,
  };
  const settings = {
    runtime: 'local' as const,
    mode: 'PRODUCTION' as const,
    purpose: 'personal',
    region: 'PL',
    max_output_tokens: 1000,
  };
  let profile: PipelineProfile = {
    profile_id: 'gemini_free',
    revision: 1,
    provider_id: 'gemini',
    model: 'gemini-3.8-flash',
    account_key: 'history-fixture',
    free_eligible: true,
    billing_enabled: false,
    purposes: ['personal'],
    regions: ['PL'],
    task_types: ['HISTORICAL_COMPARE'],
    runtimes: ['local'],
    structured_output: true,
    context_tokens: 100000,
    output_tokens: 8192,
    rank: 0,
    quality_approvals: [],
    eligibility_expires_at: new Date(
      fixtureNow.getTime() + 3600000,
    ).toISOString(),
  };
  const compiled = await compileHistory({
    ...settings,
    mode: 'QUALITY_TEST',
    plan,
    prompt,
    profile,
    request_id: 'scope',
    now: fixtureNow,
    deadline: new Date(fixtureNow.getTime() + 300000).toISOString(),
  });
  profile = { ...profile, quality_approvals: [compiled.request.quality_scope] };
  await new ModelRegistry(db, owner).publish(profile, fixtureNow);
  await db
    .prepare(
      "UPDATE prompt_versions SET status='PUBLISHED' WHERE owner_id=? AND prompt_id=? AND version=2",
    )
    .bind(owner.ownerId, prompt.prompt_id)
    .run();
  const snapshot: OptionalTaskSnapshot = {
    version: 'optional-ai-job:1',
    item_id: itemId,
    task: 'HISTORICAL_COMPARE',
    plan,
    prompt,
    profile,
    settings,
  };
  const job = await new OptionalAIJobs(db, owner).enqueue(
      snapshot,
      crypto.randomUUID(),
      fixtureNow,
    ),
    credential = await sha256('history-fixture');
  await db
    .prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'history-worker',
      owner.ownerId,
      credential,
      '["HISTORICAL_COMPARE"]',
      fixtureNow.toISOString(),
    )
    .run();
  const access = await AccessContext.worker(db, credential),
    store = new JobStore(db, access),
    worker = new OptionalAIJobs(db, access);
  const token = (await store.lease(
    job.job_id!,
    'HISTORICAL_COMPARE',
    fixtureNow,
    'local',
  ))!;
  await store.start(token, 'HISTORICAL_COMPARE', fixtureNow);
  const prepared = await worker.prepare(
    token,
    'HISTORICAL_COMPARE',
    fixtureNow,
  );
  await new QuotaSnapshots(db, owner).record(
    {
      version: 'gemini-quota-observation:1',
      project: profile.account_key,
      model: profile.model,
      tier: 'FREE',
      source: 'GOOGLE_CLOUD_QUOTA_CURRENT',
      sampled_at: fixtureNow.toISOString(),
      buckets: [
        { bucket: 'RPM', limit: 5, used: 0 },
        { bucket: 'RPD', limit: 20, used: 0 },
        { bucket: 'INPUT_TPM', limit: 250000, used: 0 },
      ],
    },
    fixtureNow,
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
      fixtureNow.toISOString(),
    )
    .run();
  const permit = await worker.reserve(token, 'HISTORICAL_COMPARE', fixtureNow);
  await worker.submit(
    token,
    'HISTORICAL_COMPARE',
    permit.reservation_id,
    fixtureNow,
  );
  const repo = new ArtifactRepository(db, access, permit.reservation_id),
    raw = JSON.stringify({
      status: 'INSUFFICIENT_CONTEXT',
      relations: [],
      limitations_pl: ['Brak wcześniejszego kontekstu.'],
    });
  const candidate = await repo.begin(
    {
      item_id: itemId,
      kind: 'ANALYSIS_CANDIDATE',
      content_hash: await sha256(raw),
      byte_size: new TextEncoder().encode(raw).length,
      chunk_count: 1,
      schema_version: 'provider-output:1',
      producer_version: 'gemini-response:1:' + permit.reservation_id,
      original_ref: null,
      provenance: {
        reservation_id: permit.reservation_id,
        raw_output_present: true,
        response: {
          request_id: prepared.run_id,
          status: 'OK',
          actual_provider: 'gemini',
          actual_model: profile.model,
          finish_reason: 'completed',
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          retry_after: null,
        },
      },
    },
    token,
    'HISTORICAL_COMPARE',
    fixtureNow,
  );
  await repo.writeChunk(
    candidate.artifact_id,
    0,
    0,
    new TextEncoder().encode(raw),
    token,
    'HISTORICAL_COMPARE',
    fixtureNow,
  );
  await repo.verifyLocal(
    candidate.artifact_id,
    token,
    'HISTORICAL_COMPARE',
    fixtureNow,
    'local',
  );
  const before = await db
    .prepare('SELECT * FROM active_analysis_selections')
    .all();
  expect(
    await worker.complete(
      token,
      'HISTORICAL_COMPARE',
      permit.reservation_id,
      candidate.artifact_id,
      fixtureNow,
      fixtureSecret,
    ),
  ).toMatchObject({ accepted: true, active: false });
  expect(
    (await db.prepare('SELECT * FROM active_analysis_selections').all())
      .results,
  ).toEqual(before.results);
  const page = await new OptionalResultProjection(db, owner).page(
    prepared.run_id,
    0,
  );
  expect(page.context.task).toBe('HISTORICAL_COMPARE');
  expect(page.item_id).toBe(itemId);
  await db
    .prepare('INSERT INTO owner_users VALUES(?,?,?,?,?)')
    .bind(
      'b',
      'https://accounts.google.com',
      'subject-b',
      1,
      fixtureNow.toISOString(),
    )
    .run();
  await expect(
    new OptionalResultProjection(db, await fixtureOwner('b')).page(
      prepared.run_id,
      0,
    ),
  ).rejects.toThrow('NOT_FOUND');
}
