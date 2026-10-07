import { expect } from 'vitest';
import bundle from '../../config/registry/master-bundle.json';
import {
  AccessContext,
  type Database,
} from '../../packages/core/src/db/boundary.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import {
  translationPlan,
  type TranslationSource,
} from '../../packages/core/src/ai/tasks/translation.js';
import { compileTranslation } from '../../packages/core/src/ai/tasks/compiler.js';
import {
  OptionalAIJobs,
  type OptionalTaskSnapshot,
} from '../../packages/core/src/ai/tasks/jobs.js';
import { OptionalTaskPreparation } from '../../packages/core/src/ai/tasks/preparation.js';
import { ModelRegistry } from '../../packages/core/src/ai/models.js';
import { QuotaSnapshots } from '../../packages/core/src/ai/quota-snapshots.js';
import { ArtifactRepository } from '../../packages/core/src/artifacts/store.js';
import { OptionalResultProjection } from '../../packages/core/src/projections/optional.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import {
  CoreBackup,
  backupTables,
  type BackupChunk,
} from '../../packages/core/src/backup/snapshot.js';
import { restoreCanonical } from '../../packages/core/src/backup/restore.js';
import {
  fixtureNow,
  fixtureSecret,
  fixtureOwner,
  resetSchema,
} from './core-fixture.js';
import type { PipelineProfile } from '../../packages/contracts/src/ai.js';
import type { PromptSnapshot } from '../../packages/core/src/registry/store.js';

export async function verifyMultipartTranslation(
  db: Database,
  owner: AccessContext,
  itemId: string,
  source: TranslationSource,
  originalProfile: PipelineProfile,
) {
  const template = bundle.prompts.find((p) => p.id === 'FULL_TRANSLATION_V1')!;
  const prompt: PromptSnapshot = {
    prompt_id: template.id,
    version: 2,
    prompt_hash: template.hash,
    text: template.text,
    wire: bundle.schemas.find(
      (s) => s.id === 'urn:bartosz:schema:translation-wire:1.0',
    )!,
    canonical: bundle.schemas.find(
      (s) => s.id === 'urn:bartosz:schema:translation:1.0',
    )!,
    enrichment_version: '1.0',
    generation: 1,
  };
  const plan = await translationPlan(source, 'FULL');
  expect(plan.snapshot.segments).toHaveLength(10);
  const settings = {
    runtime: 'local' as const,
    mode: 'PRODUCTION' as const,
    purpose: 'personal',
    region: 'PL',
    max_output_tokens: 256,
  };
  const scopePlan = {
    snapshot: {
      ...plan.snapshot,
      scope: 'CHUNK' as const,
      segments: plan.snapshot.segments.slice(0, 2),
    },
    hash: '',
  };
  scopePlan.hash = await sha256(JSON.stringify(scopePlan.snapshot));
  let profile = { ...originalProfile, revision: 3, task_types: ['TRANSLATE'] };
  const scope = await compileTranslation({
    ...settings,
    mode: 'QUALITY_TEST',
    plan: scopePlan,
    profile,
    prompt,
    glossary: [],
    request_id: 'fixture-only',
    now: fixtureNow,
    deadline: new Date(fixtureNow.getTime() + 300000).toISOString(),
  });
  // Synthetic qualification only. This is never a live model approval.
  profile = { ...profile, quality_approvals: [scope.request.quality_scope] };
  await new ModelRegistry(db, owner).publish(profile, fixtureNow);
  await db
    .prepare(
      "UPDATE prompt_versions SET status='PUBLISHED' WHERE owner_id='a' AND prompt_id='FULL_TRANSLATION_V1' AND version=2",
    )
    .run();
  const preparation = new OptionalTaskPreparation(db, owner);
  const preview = await preparation.preview(
    {
      item_id: itemId,
      task: 'TRANSLATE',
      plan,
      glossary: [],
      selected_run_id: null,
      prepared_at: fixtureNow.toISOString(),
    },
    settings,
    fixtureNow,
  );
  expect(preview).toMatchObject({
    additional_model_requests: 5,
    source_scope: 'FULL',
    scope_count: 10,
    quota_status: 'UNKNOWN',
  });
  expect(preview.token_estimate.output_tokens).toBe(1280);
  const nonce = crypto.randomUUID(),
    first = await preparation.confirm(preview.preview_hash, nonce, fixtureNow);
  expect(
    (await preparation.confirm(preview.preview_hash, nonce, fixtureNow)).job_id,
  ).toBe(first.job_id);
  const credential = await sha256('multipart-worker');
  await db
    .prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'multipart-worker',
      'a',
      credential,
      '["TRANSLATE"]',
      fixtureNow.toISOString(),
    )
    .run();
  let access = await AccessContext.worker(db, credential);
  const config = JSON.stringify({ RPM: 0, RPD: 0, INPUT_TPM: 0 });
  await db
    .prepare('INSERT INTO config_versions VALUES(?,?,?,?,?,?)')
    .bind(
      'quota-reserve-gemini_free',
      'a',
      1,
      config,
      await sha256(config),
      fixtureNow.toISOString(),
    )
    .run();
  let jobId = first.job_id!,
    requests = 0,
    finalRun = '';
  const failed = new Set<number>();
  const selections = (
    await db.prepare('SELECT * FROM active_analysis_selections').all()
  ).results;
  for (;;) {
    const now = new Date(fixtureNow.getTime() + requests++ * 60000),
      store = new JobStore(db, access),
      worker = new OptionalAIJobs(db, access);
    const token = (await store.lease(jobId, 'TRANSLATE', now, 'local'))!;
    expect(token).toBeTruthy();
    await store.start(token, 'TRANSLATE', now);
    const prepared = await worker.prepare(token, 'TRANSLATE', now);
    const snapshot = prepared.snapshot as Extract<
      OptionalTaskSnapshot,
      { task: 'TRANSLATE' }
    >;
    expect(snapshot.chunk?.index).toBeGreaterThanOrEqual(0);
    expect(snapshot.plan.snapshot.segments.length).toBeLessThanOrEqual(2);
    // A different owner or a fabricated prefix cannot execute the group.
    if (requests === 1) {
      await expect(
        new OptionalAIJobs(db, await fixtureOwner('b')).enqueue(
          snapshot,
          crypto.randomUUID(),
          now,
        ),
      ).rejects.toThrow();
      await expect(
        new OptionalAIJobs(db, owner).enqueue(
          { ...snapshot, chunk: { ...snapshot.chunk!, index: 1 } },
          crypto.randomUUID(),
          now,
        ),
      ).rejects.toThrow('INVALID_TRANSLATION_GROUP');
    }
    await new QuotaSnapshots(db, owner).record(
      {
        version: 'gemini-quota-observation:1',
        project: profile.account_key,
        model: profile.model,
        tier: 'FREE',
        source: 'GOOGLE_CLOUD_QUOTA_CURRENT',
        sampled_at: now.toISOString(),
        buckets: [
          { bucket: 'RPM', limit: 5, used: 0 },
          { bucket: 'RPD', limit: 20, used: 0 },
          { bucket: 'INPUT_TPM', limit: 250000, used: 0 },
        ],
      },
      now,
    );
    const permit = await worker.reserve(token, 'TRANSLATE', now);
    await worker.submit(token, 'TRANSLATE', permit.reservation_id, now);
    const index = snapshot.chunk!.index;
    const fail = (index === 1 || index === 3) && !failed.has(index);
    if (fail) failed.add(index);
    const truncated = fail && index === 3;
    const raw = truncated
      ? '{"status":"OK","translated_segments":['
      : JSON.stringify({
          status: 'OK',
          translated_segments: (fail
            ? snapshot.plan.snapshot.segments.slice(0, 1)
            : snapshot.plan.snapshot.segments
          ).map((s) => ({
            segment_ref: s.alias,
            text_pl: 'Przekład ' + s.source_segment_id,
            issues: [],
          })),
          limitations_pl: [],
        });
    const repo = new ArtifactRepository(db, access, permit.reservation_id);
    const artifact = await repo.begin(
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
            status: truncated ? 'INCOMPLETE' : 'OK',
            actual_provider: 'gemini',
            actual_model: profile.model,
            finish_reason: truncated ? 'max_output_tokens' : 'completed',
            usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200 },
            retry_after: null,
          },
        },
      },
      token,
      'TRANSLATE',
      now,
    );
    await repo.writeChunk(
      artifact.artifact_id,
      0,
      0,
      new TextEncoder().encode(raw),
      token,
      'TRANSLATE',
      now,
    );
    await repo.verifyLocal(
      artifact.artifact_id,
      token,
      'TRANSLATE',
      now,
      'local',
    );
    const result = await worker.complete(
      token,
      'TRANSLATE',
      permit.reservation_id,
      artifact.artifact_id,
      now,
      fixtureSecret,
    );
    expect(
      await worker.complete(
        token,
        'TRANSLATE',
        permit.reservation_id,
        artifact.artifact_id,
        now,
        fixtureSecret,
      ),
    ).toMatchObject({ accepted: result.accepted, duplicate: true });
    if (fail) {
      expect(result.accepted).toBe(false);
      expect(
        await db
          .prepare(
            "SELECT count(*) n FROM jobs WHERE task_type='TRANSLATE' AND state='PENDING'",
          )
          .first('n'),
      ).toBe(0);
      expect(
        await db
          .prepare('SELECT count(*) n FROM optional_ai_results')
          .first('n'),
      ).toBe(0);
      const nextPreview = await preparation.previewRecovery(
        prepared.run_id,
        now,
      );
      expect(nextPreview.additional_model_requests).toBe(1);
      jobId = (
        await preparation.confirm(
          nextPreview.preview_hash,
          crypto.randomUUID(),
          now,
        )
      ).job_id!;
      continue;
    }
    if (index === 4) {
      expect(result.accepted).toBe(true);
      finalRun = prepared.run_id;
      break;
    }
    expect(result.accepted).toBe(false);
    expect(
      await db.prepare('SELECT count(*) n FROM optional_ai_results').first('n'),
    ).toBe(0);
    const next = await db
      .prepare(
        "SELECT job_id FROM jobs WHERE task_type='TRANSLATE' AND state='PENDING'",
      )
      .all<{ job_id: string }>();
    expect(next.results).toHaveLength(1);
    jobId = next.results[0]!.job_id;
    if (index === 0) {
      // Simulate shutdown/restore after atomically saving the next part.
      const backup = new CoreBackup(db, owner),
        start = await backup.begin(),
        chunks: BackupChunk[] = [];
      for (const table of backupTables) {
        let cursor: number | null = 0;
        do {
          const chunk = await backup.chunk(start.backup_id, table, cursor);
          chunks.push(chunk);
          cursor = chunk.next_cursor;
        } while (cursor !== null);
      }
      const portable = {
        manifest: await backup.complete(start.backup_id),
        chunks,
      };
      await resetSchema();
      await restoreCanonical(db, portable, 'subject-a');
      // Restore deliberately revokes reusable credentials; resume with a newly
      // provisioned scoped worker rather than resurrecting the old identity.
      await expect(AccessContext.worker(db, credential)).rejects.toThrow(
        'UNAUTHENTICATED',
      );
      const renewed = await sha256('multipart-worker-restored');
      await db
        .prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
        .bind(
          'multipart-worker-restored',
          'a',
          renewed,
          '["TRANSLATE"]',
          now.toISOString(),
        )
        .run();
      access = await AccessContext.worker(db, renewed);
    }
  }
  expect(requests).toBe(7);
  expect(
    await db.prepare('SELECT count(*) n FROM optional_ai_results').first('n'),
  ).toBe(1);
  const accepted = await db
    .prepare(
      'SELECT outcome_json,input_snapshot_json FROM analysis_runs WHERE run_id=?',
    )
    .bind(finalRun)
    .first<{ outcome_json: string; input_snapshot_json: string }>();
  const outcome = JSON.parse(accepted!.outcome_json);
  expect(outcome).toMatchObject({
    plan_hash: plan.hash,
    coverage: { complete: true, expected: 10, translated: 10 },
    additional_synthesis_requests: 0,
  });
  expect(JSON.parse(accepted!.input_snapshot_json).hash).toBe(plan.hash);
  const mappings = JSON.parse(
    (
      await new ArtifactRepository(db, owner).readVerifiedText(
        outcome.mapping_artifact_id,
        100000,
      )
    ).text,
  );
  expect(
    mappings.flatMap((m: { segment_ids: string[] }) => m.segment_ids),
  ).toEqual(plan.snapshot.segments.map((s) => s.source_segment_id));
  expect(
    await new OptionalResultProjection(db, owner).page(finalRun, 0),
  ).toMatchObject({
    context: {
      task: 'TRANSLATE',
      segments: plan.snapshot.segments.map(
        ({ source_segment_id, start_ms, end_ms, timestamp_precision }) => ({
          source_segment_id,
          start_ms,
          end_ms,
          timestamp_precision,
        }),
      ),
    },
  });
  expect(
    (await db.prepare('SELECT * FROM active_analysis_selections').all())
      .results,
  ).toEqual(selections);
  expect(
    await db.prepare('SELECT count(*) n FROM observations').first('n'),
  ).toBe(0);
}
