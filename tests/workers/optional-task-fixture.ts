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
import {
  translationPlan,
  type TranslationSource,
} from '../../packages/core/src/ai/tasks/translation.js';
import { compileTranslation } from '../../packages/core/src/ai/tasks/compiler.js';
import { OptionalTaskPreparation } from '../../packages/core/src/ai/tasks/preparation.js';
import { ModelRegistry } from '../../packages/core/src/ai/models.js';
import { QuotaSnapshots } from '../../packages/core/src/ai/quota-snapshots.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import {
  ArtifactRepository,
  splitArtifactText,
} from '../../packages/core/src/artifacts/store.js';
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

export async function verifyOptionalTranslation(
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
  const profile = {
    ...originalProfile,
    revision: 3,
    task_types: ['TRANSLATE'],
  };
  const models = new ModelRegistry(db, owner);
  await models.publish(profile, fixtureNow);
  const plan = await translationPlan(source, 'FULL');
  const ownerJobs = new OptionalAIJobs(db, owner);
  let snapshot: Extract<OptionalTaskSnapshot, { task: 'TRANSLATE' }> = {
    version: 'optional-ai-job:1',
    item_id: itemId,
    task: 'TRANSLATE',
    plan,
    glossary: [],
    selected_run_id: null,
    profile,
    prompt,
    settings: {
      runtime: 'local',
      mode: 'QUALITY_TEST',
      purpose: 'personal',
      region: 'PL',
      max_output_tokens: 1000,
    },
  };
  const credentialHash = await sha256('optional-fixture');
  await db
    .prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'optional-worker',
      'a',
      credentialHash,
      '["TRANSLATE"]',
      fixtureNow.toISOString(),
    )
    .run();
  const access = await AccessContext.worker(db, credentialHash),
    worker = new OptionalAIJobs(db, access),
    store = new JobStore(db, access);
  const selections = await db
    .prepare('SELECT * FROM active_analysis_selections')
    .all();
  let partialRunId = '';
  let invalidRunId = '';
  let truncatedRunId = '';
  let requestIndex = 0;
  for (const mode of [
    'QUALITY_TEST',
    'PRODUCTION',
    'INVALID',
    'TRUNCATED',
    'PARTIAL',
    'RECOVERY',
    'INVALID_RECOVERY',
    'TRUNCATED_RECOVERY',
  ] as const) {
    // Each synthetic request uses a separate minute; preserve the real 5 RPM admission rule.
    const requestNow = new Date(fixtureNow.getTime() + requestIndex++ * 60000);
    if (
      mode === 'RECOVERY' ||
      mode === 'INVALID_RECOVERY' ||
      mode === 'TRUNCATED_RECOVERY'
    ) {
      const parentRunId =
        mode === 'RECOVERY'
          ? partialRunId
          : mode === 'INVALID_RECOVERY'
            ? invalidRunId
            : truncatedRunId;
      const preparation = new OptionalTaskPreparation(db, owner);
      await expect(
        new OptionalTaskPreparation(db, await fixtureOwner('b')).recovery(
          parentRunId,
          requestNow,
        ),
      ).rejects.toThrow('TRANSLATION_RECOVERY_NOT_AVAILABLE');
      const recovery = await preparation.recovery(parentRunId, requestNow);
      expect(recovery.plan.snapshot.scope).toBe('CHUNK');
      expect(
        recovery.plan.snapshot.segments.map((s) => s.source_segment_id),
      ).toEqual(plan.snapshot.segments.map((s) => s.source_segment_id));
      const compiled = await compileTranslation({
        ...snapshot.settings,
        mode: 'QUALITY_TEST',
        profile: snapshot.profile,
        prompt,
        plan: recovery.plan,
        glossary: [],
        request_id: 'recovery-scope',
        now: requestNow,
        deadline: new Date(requestNow.getTime() + 300000).toISOString(),
      });
      const approved = {
        ...snapshot.profile,
        revision: mode === 'RECOVERY' ? 5 : mode === 'INVALID_RECOVERY' ? 6 : 7,
        quality_approvals: [
          ...snapshot.profile.quality_approvals,
          compiled.request.quality_scope,
        ],
      };
      await models.publish(approved, requestNow);
      const preview = await preparation.previewRecovery(
        parentRunId,
        requestNow,
      );
      expect(preview).toMatchObject({
        source_scope: 'CHUNK',
        additional_model_requests: 1,
        quota_status: 'UNKNOWN',
        selection_effect: 'NONE',
      });
      const confirmed = await preparation.confirm(
        preview.preview_hash,
        crypto.randomUUID(),
        requestNow,
      );
      const queued = await db
        .prepare('SELECT payload_json FROM jobs WHERE job_id=?')
        .bind(confirmed.job_id!)
        .first<{ payload_json: string }>();
      const recovered = (
        JSON.parse(queued!.payload_json) as { snapshot: OptionalTaskSnapshot }
      ).snapshot;
      if (recovered.task !== 'TRANSLATE')
        throw new Error('FIXTURE_TASK_MISMATCH');
      snapshot = recovered;
      await expect(
        ownerJobs.enqueue(
          { ...snapshot, recovery: { ...snapshot.recovery!, generation: 4 } },
          crypto.randomUUID(),
          requestNow,
        ),
      ).rejects.toThrow('OPTIONAL_SNAPSHOT_MISMATCH');
    }
    if (mode === 'PRODUCTION') {
      const compiled = await compileTranslation({
        ...snapshot.settings,
        mode: 'QUALITY_TEST',
        profile: snapshot.profile,
        prompt,
        plan,
        glossary: [],
        request_id: 'scope',
        now: requestNow,
        deadline: new Date(requestNow.getTime() + 300000).toISOString(),
      });
      const approved = {
        ...profile,
        revision: 4,
        quality_approvals: [compiled.request.quality_scope],
      };
      await models.publish(approved, requestNow);
      // Fixture-only lifecycle/quality approval, never a real provider qualification.
      await db
        .prepare(
          "UPDATE prompt_versions SET status='PUBLISHED' WHERE owner_id='a' AND prompt_id='FULL_TRANSLATION_V1' AND version=2",
        )
        .run();
      snapshot = {
        ...snapshot,
        profile: approved,
        settings: { ...snapshot.settings, mode },
      };
      const preparation = new OptionalTaskPreparation(db, owner),
        preparedSource = {
          item_id: itemId,
          task: 'TRANSLATE' as const,
          plan,
          glossary: [],
          selected_run_id: null,
          prepared_at: requestNow.toISOString(),
        };
      const preview = await preparation.preview(
        preparedSource,
        snapshot.settings,
        requestNow,
      );
      const later = new Date(requestNow.getTime() + 900001);
      await expect(
        preparation.confirm(preview.preview_hash, crypto.randomUUID(), later),
      ).rejects.toThrow('READ_SNAPSHOT_CHANGED');
      const refreshed = await preparation.preview(
        preparedSource,
        snapshot.settings,
        later,
      );
      expect(refreshed.preview_hash).not.toBe(preview.preview_hash);
      const confirmedNonce = crypto.randomUUID(),
        confirmed = await preparation.confirm(
          refreshed.preview_hash,
          confirmedNonce,
          later,
        );
      expect(
        (
          await preparation.confirm(
            refreshed.preview_hash,
            confirmedNonce,
            later,
          )
        ).job_id,
      ).toBe(confirmed.job_id);
    }
    const nonce = crypto.randomUUID(),
      job = await ownerJobs.enqueue(snapshot, nonce, requestNow);
    expect((await ownerJobs.enqueue(snapshot, nonce, requestNow)).job_id).toBe(
      job.job_id,
    );
    if (mode === 'QUALITY_TEST')
      await expect(
        ownerJobs.enqueue(
          { ...snapshot, glossary: [{ source: 'Literal', target: 'Literal' }] },
          nonce,
          requestNow,
        ),
      ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await expect(
      new OptionalAIJobs(db, await fixtureOwner('b')).enqueue(
        snapshot,
        crypto.randomUUID(),
        requestNow,
      ),
    ).rejects.toThrow();
    const changed = structuredClone(snapshot);
    changed.plan.snapshot.segments[0]!.text = 'Changed source';
    changed.plan.hash = await sha256(JSON.stringify(changed.plan.snapshot));
    await expect(
      ownerJobs.enqueue(changed, crypto.randomUUID(), requestNow),
    ).rejects.toThrow(
      mode === 'RECOVERY' ||
        mode === 'INVALID_RECOVERY' ||
        mode === 'TRUNCATED_RECOVERY'
        ? 'OPTIONAL_SNAPSHOT_MISMATCH'
        : 'OPTIONAL_MANIFEST_MISMATCH',
    );
    const token = (await store.lease(
      job.job_id!,
      'TRANSLATE',
      requestNow,
      'local',
    ))!;
    await store.start(token, 'TRANSLATE', requestNow);
    await expect(
      worker.prepare(token, 'HISTORICAL_COMPARE', requestNow),
    ).rejects.toThrow('FORBIDDEN');
    const prepared = await worker.prepare(token, 'TRANSLATE', requestNow);
    expect(
      (
        await worker.prepare(
          token,
          'TRANSLATE',
          new Date(requestNow.getTime() + 1000),
        )
      ).request,
    ).toEqual(prepared.request);
    if (mode === 'QUALITY_TEST')
      await expect(
        worker.reserve(token, 'TRANSLATE', requestNow),
      ).rejects.toThrow('QUOTA_UNKNOWN_OR_STALE');
    await new QuotaSnapshots(db, owner).record(
      {
        version: 'gemini-quota-observation:1',
        project: profile.account_key,
        model: profile.model,
        tier: 'FREE',
        source: 'GOOGLE_CLOUD_QUOTA_CURRENT',
        sampled_at: requestNow.toISOString(),
        buckets: [
          { bucket: 'RPM', limit: 5, used: 0 },
          { bucket: 'RPD', limit: 20, used: 0 },
          { bucket: 'INPUT_TPM', limit: 250000, used: 0 },
        ],
      },
      requestNow,
    );
    const policy = JSON.stringify({ RPM: 0, RPD: 0, INPUT_TPM: 0 });
    await db
      .prepare(
        'INSERT INTO config_versions VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',
      )
      .bind(
        'quota-reserve-gemini_free',
        'a',
        1,
        policy,
        await sha256(policy),
        requestNow.toISOString(),
      )
      .run();
    const permit = await worker.reserve(token, 'TRANSLATE', requestNow);
    await worker.submit(token, 'TRANSLATE', permit.reservation_id, requestNow);
    const raw =
      mode === 'TRUNCATED'
        ? '{"status":"OK","translated_segments":['
        : JSON.stringify({
            status: 'OK',
            translated_segments: (mode === 'PARTIAL'
              ? []
              : snapshot.plan.snapshot.segments
            ).map((s) => ({
              segment_ref: mode === 'INVALID' ? 'foreign' : s.alias,
              text_pl: 'Oryginalna wypowiedź.',
              issues: [],
            })),
            limitations_pl: [],
          });
    const repo = new ArtifactRepository(db, access, permit.reservation_id),
      parts = splitArtifactText(raw);
    const candidate = await repo.begin(
      {
        item_id: itemId,
        kind: 'ANALYSIS_CANDIDATE',
        content_hash: await sha256(raw),
        byte_size: new TextEncoder().encode(raw).length,
        chunk_count: parts.length,
        schema_version: 'provider-output:1',
        producer_version: 'gemini-response:1:' + permit.reservation_id,
        original_ref: null,
        provenance: {
          reservation_id: permit.reservation_id,
          raw_output_present: true,
          response: {
            request_id: prepared.run_id,
            status: mode === 'TRUNCATED' ? 'INCOMPLETE' : 'OK',
            actual_provider: 'gemini',
            actual_model: profile.model,
            finish_reason:
              mode === 'TRUNCATED' ? 'max_output_tokens' : 'completed',
            usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200 },
            retry_after: null,
          },
        },
      },
      token,
      'TRANSLATE',
      requestNow,
    );
    let offset = 0;
    for (const [i, part] of parts.entries()) {
      await repo.writeChunk(
        candidate.artifact_id,
        i,
        offset,
        part,
        token,
        'TRANSLATE',
        requestNow,
      );
      offset += part.length;
    }
    await repo.verifyLocal(
      candidate.artifact_id,
      token,
      'TRANSLATE',
      requestNow,
      'local',
    );
    await expect(
      worker.complete(
        { ...token, fencing_token: token.fencing_token + 1 },
        'TRANSLATE',
        permit.reservation_id,
        candidate.artifact_id,
        requestNow,
        fixtureSecret,
      ),
    ).rejects.toThrow('STALE_FENCE');
    const result = await worker.complete(
      token,
      'TRANSLATE',
      permit.reservation_id,
      candidate.artifact_id,
      requestNow,
      fixtureSecret,
    );
    expect(result.accepted).toBe(
      mode === 'PRODUCTION' ||
        mode === 'RECOVERY' ||
        mode === 'INVALID_RECOVERY' ||
        mode === 'TRUNCATED_RECOVERY',
    );
    if (mode === 'PARTIAL') partialRunId = prepared.run_id;
    if (
      mode === 'RECOVERY' ||
      mode === 'INVALID_RECOVERY' ||
      mode === 'TRUNCATED_RECOVERY'
    ) {
      const accepted = await db
        .prepare(
          'SELECT outcome_json,input_snapshot_json FROM analysis_runs WHERE run_id=?',
        )
        .bind(prepared.run_id)
        .first<{ outcome_json: string; input_snapshot_json: string }>();
      expect(JSON.parse(accepted!.input_snapshot_json).hash).toBe(plan.hash);
      expect(JSON.parse(accepted!.outcome_json)).toMatchObject({
        plan_hash: plan.hash,
        request_plan_hash: snapshot.plan.hash,
        coverage: { complete: true },
      });
      const originalPartial = await db
        .prepare('SELECT state FROM analysis_runs WHERE run_id=?')
        .bind(partialRunId)
        .first('state');
      expect(originalPartial).toBe('CANDIDATE');
    }
    if (mode === 'INVALID' || mode === 'TRUNCATED') {
      if (mode === 'INVALID') invalidRunId = prepared.run_id;
      else truncatedRunId = prepared.run_id;
      expect(result).toMatchObject({
        state: 'FAILED',
        candidate_status: 'INVALID',
      });
      const diagnostic = await db
        .prepare(
          'SELECT outcome_json FROM analysis_runs WHERE owner_id=? AND run_id=?',
        )
        .bind(owner.ownerId, prepared.run_id)
        .first<{ outcome_json: string }>();
      expect(JSON.parse(diagnostic!.outcome_json)).toMatchObject({
        version: 'optional-invalid:1',
        reason:
          mode === 'INVALID'
            ? 'FOREIGN_TRANSLATION_REF'
            : 'TRANSLATION_RESPONSE_NOT_COMPLETE',
        response_artifact_id: candidate.artifact_id,
      });
    }
    if (mode === 'PARTIAL')
      expect(result).toMatchObject({
        state: 'SUCCEEDED',
        candidate_status: 'VALIDATED',
      });
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM optional_ai_results')
        .first('n'),
    ).toBe(
      mode === 'QUALITY_TEST'
        ? 0
        : mode === 'RECOVERY'
          ? 2
          : mode === 'INVALID_RECOVERY'
            ? 3
            : mode === 'TRUNCATED_RECOVERY'
              ? 4
              : 1,
    );
    expect(
      await worker.complete(
        token,
        'TRANSLATE',
        permit.reservation_id,
        candidate.artifact_id,
        requestNow,
        fixtureSecret,
      ),
    ).toMatchObject({
      accepted: result.accepted,
      duplicate: true,
      active: false,
    });
    expect(
      (await db.prepare('SELECT * FROM active_analysis_selections').all())
        .results,
    ).toEqual(selections.results);
    expect(
      await db.prepare('SELECT count(*) AS n FROM observations').first('n'),
    ).toBe(0);
  }
  const rows = await db.prepare('SELECT * FROM optional_ai_results').all();
  await expect(
    db.prepare('DELETE FROM optional_ai_results').run(),
  ).rejects.toThrow('IMMUTABLE_OPTIONAL_RESULT');
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
  const portable = { manifest: await backup.complete(start.backup_id), chunks };
  await resetSchema();
  await restoreCanonical(db, portable, 'subject-a');
  expect(
    (await db.prepare('SELECT * FROM optional_ai_results').all()).results,
  ).toEqual(rows.results);
}
