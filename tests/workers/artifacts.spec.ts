import { env } from 'cloudflare:workers';
import { QuotaSnapshots } from '../../packages/core/src/ai/quota-snapshots.js';
import { verifyOptionalTranslation } from './optional-task-fixture.js';
import { verifyMultipartTranslation } from './optional-translation-chunks-fixture.js';
import { verifyOptionalHistory } from './optional-history-fixture.js';
import { PromptDrafts } from '../../packages/core/src/registry/draft.js';
import { PromptTests } from '../../packages/core/src/registry/test.js';
import { PromptUsage } from '../../packages/core/src/registry/usage.js';
import { PromptLab } from '../../packages/core/src/registry/lab-store.js';
import { LabQuotaPolicies } from '../../packages/core/src/registry/lab-quota.js';
import { verifyCorrectedInput } from './corrected-input-fixture.js';
import {
  analysisQualityScope,
  compileEconomy,
  compileSemanticAnalysis,
  economyPromptOverhead,
  economyChunkContextHash,
} from '../../packages/core/src/ai/compiler.js';
import { AnalysisValidation } from '../../packages/core/src/ai/validation.js';
import { analysisQualitySnapshot } from '../../packages/core/src/registry/analysis-quality.js';
import { createExecutionContext } from 'cloudflare:test';
import worker from '../../apps/api/src/index.js';
import { ArtifactClient } from '../../apps/executor/src/artifact-client.js';
import { LocalTranscriptWorker } from '../../apps/executor/src/local-worker.js';
import { LocalSourceCorrectionWorker } from '../../apps/executor/src/source-correction-worker.js';
import { SourceCorrectionJobs } from '../../packages/core/src/transcript/correction-jobs.js';
import { YtdlpTranscriptProvider } from '../../apps/executor/src/providers/ytdlp.js';
import { beforeEach, it, expect } from 'vitest';
import {
  fixtureNow,
  fixtureOwner,
  resetCore,
  fixtureSecret,
} from './core-fixture.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { ItemRepository } from '../../packages/core/src/db/items.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import type { Database } from '../../packages/core/src/db/boundary.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import {
  ArtifactRepository,
  splitArtifactText,
  artifactChunkBytes,
} from '../../packages/core/src/artifacts/store.js';
import type { ArtifactDescriptor } from '../../packages/core/src/artifacts/store.js';
import {
  CoreBackup,
  backupTables,
} from '../../packages/core/src/backup/snapshot.js';
import type { BackupChunk } from '../../packages/core/src/backup/snapshot.js';
import { restoreCanonical } from '../../packages/core/src/backup/restore.js';
import { resetSchema } from './core-fixture.js';
import { RepresentationRepository } from '../../packages/core/src/transcript/representations.js';
import { selectTranscriptLanguage } from '../../packages/core/src/transcript/language.js';
import { TranscriptRecovery } from '../../packages/core/src/transcript/recovery.js';
import { DailyProjection } from '../../packages/core/src/projections/daily.js';
import { EvidenceProjection } from '../../packages/core/src/projections/evidence.js';
import { CapacityCollection } from '../../packages/core/src/projections/capacity-collection.js';
import { ObservationLedger } from '../../packages/core/src/knowledge/ledger.js';
import { sweep } from '../../packages/core/src/jobs/recovery.js';
import {
  QuotaAdmission,
  type AdmissionBucket,
} from '../../packages/core/src/ai/admission.js';
import type { TaskType } from '../../packages/contracts/src/jobs.js';
import { CandidateRepairAttempts } from '../../packages/core/src/ai/repair/attempts.js';
import {
  enrichEconomy,
  enrichSemantic,
} from '../../packages/core/src/ai/enrichment/canonical.js';
import { compileSemanticProfile } from '../../packages/core/src/ai/semantic-profile.js';
import { IntelligenceLedger } from '../../packages/core/src/ai/enrichment/ledger.js';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import { RunRepository } from '../../packages/core/src/jobs/acceptance.js';
import { AnalysisJobs } from '../../packages/core/src/ai/jobs.js';
import {
  SemanticProfiles,
  semanticPrompt,
} from '../../packages/core/src/registry/semantic-profiles.js';
import {
  semanticModules,
  type SemanticProfile,
} from '../../packages/core/src/ai/semantic-profile.js';
import { LongInputJobs } from '../../packages/core/src/ai/long-input/jobs.js';
import { LongInputCompletion } from '../../packages/core/src/ai/long-input/completion.js';
import { createChunkPlan } from '../../packages/core/src/ai/long-input/plan.js';
import { ModelRegistry } from '../../packages/core/src/ai/models.js';
import { PromptRegistry } from '../../packages/core/src/registry/store.js';
import bundle from '../../config/registry/master-bundle.json';
import type { PipelineProfile } from '../../packages/contracts/src/ai.js';
import { dailyQuotaWindow } from '../../packages/core/src/ai/windows.js';
import { WorkerRpc } from '../../apps/executor/src/worker-rpc.js';
import { prepareAnalysis } from '../../apps/executor/src/analysis-preparation.js';
import { AnalysisResponses } from '../../packages/core/src/ai/responses.js';
import { retainAnalysisResponse } from '../../apps/executor/src/analysis-response.js';
import {
  TranscriptAcceptance,
  type TranscriptSourceCompletion,
} from '../../packages/core/src/transcript/acceptance.js';
import { dailyFixture } from './daily-workflow-fixture.js';
beforeEach(resetCore);
it('late submitted AI response can retain only diagnostic candidate bytes after lease expiry, never source or accepted effects', async () => {
  const { access, token, item } = await setup('ANALYZE');
  const reservation = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO quota_reservations(reservation_id,owner_id,job_id,fencing_token,request_id,provider,model,account_key,snapshots_json,input_tokens,charged_input_tokens,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'RESERVED',?,?)",
  )
    .bind(
      reservation,
      'a',
      token.job_id,
      token.fencing_token,
      'late-request',
      'gemini',
      'gemini-3.8-flash',
      'project',
      '[]',
      100,
      100,
      fixtureNow.toISOString(),
      new Date(fixtureNow.getTime() + 300000).toISOString(),
    )
    .run();
  const text = 'Late response ' + '😀 diagnostic. '.repeat(3000);
  const chunks = splitArtifactText(text);
  const descriptor: ArtifactDescriptor = {
    item_id: item.item_id,
    kind: 'ANALYSIS_CANDIDATE',
    content_hash: await sha256(text),
    byte_size: new TextEncoder().encode(text).length,
    chunk_count: chunks.length,
    schema_version: 'provider-output:1',
    producer_version: 'gemini-response:1:' + reservation,
    provenance: {
      reservation_id: reservation,
      raw_output_present: true,
      response: {
        request_id: 'late-request',
        status: 'OK',
        actual_provider: 'gemini',
        actual_model: 'gemini-3.8-flash',
        finish_reason: 'completed',
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        retry_after: null,
      },
    },
    original_ref: null,
  };
  const late = new Date(fixtureNow.getTime() + 900001);
  const diagnostics = new ArtifactRepository(env.DB, access, reservation);
  await expect(
    diagnostics.begin(descriptor, token, 'ANALYZE', late),
  ).rejects.toThrow('STALE_FENCE');
  await env.DB.prepare(
    "UPDATE quota_reservations SET state='SUBMITTED' WHERE reservation_id=?",
  )
    .bind(reservation)
    .run();
  await sweep(env.DB, late, () => true);
  await expect(
    new ArtifactRepository(env.DB, access).begin(
      descriptor,
      token,
      'ANALYZE',
      late,
    ),
  ).rejects.toThrow('STALE_FENCE');
  await expect(
    diagnostics.begin(
      { ...descriptor, kind: 'SOURCE_ORIGINAL' },
      token,
      'ANALYZE',
      late,
    ),
  ).rejects.toThrow('INVALID_DIAGNOSTIC_ARTIFACT');
  const artifact = await diagnostics.begin(descriptor, token, 'ANALYZE', late);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    await diagnostics.writeChunk(
      artifact.artifact_id,
      i,
      offset,
      chunks[i]!,
      token,
      'ANALYZE',
      late,
    );
    offset += chunks[i]!.length;
  }
  expect(
    (
      await diagnostics.verifyLocal(
        artifact.artifact_id,
        token,
        'ANALYZE',
        late,
        'local',
        () => late,
      )
    ).state,
  ).toBe('VERIFIED');
  const receipts = new AnalysisResponses(env.DB, access);
  expect(
    await receipts.record(token, reservation, artifact.artifact_id, late),
  ).toMatchObject({ diagnostic_only: true, status: 'OK' });
  expect(
    await env.DB.prepare(
      'SELECT state FROM quota_reservations WHERE reservation_id=?',
    )
      .bind(reservation)
      .first('state'),
  ).toBe('SETTLED');
  expect(
    await receipts.record(token, reservation, artifact.artifact_id, late),
  ).toMatchObject({ diagnostic_only: true });
  expect(
    await env.DB.prepare('SELECT count(*) AS n FROM observations').first('n'),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM analysis_runs WHERE state='ACCEPTED'",
    ).first('n'),
  ).toBe(0);
  await env.DB.prepare(
    'UPDATE worker_identities SET revoked_at=? WHERE worker_id=?',
  )
    .bind(late.toISOString(), access.actorId)
    .run();
  await expect(
    diagnostics.get(artifact.artifact_id, token, 'ANALYZE', late),
  ).rejects.toThrow('NOT_FOUND');
});
it('bounded response RPC retains a null failure output and unknown usage after lease expiry, with immutable retry identity', async () => {
  const { token, item } = await setup('ANALYZE');
  const credential = 'n'.repeat(43);
  await env.DB.prepare(
    'UPDATE worker_identities SET credential_hash=? WHERE worker_id=?',
  )
    .bind(await sha256(credential), 'artifact-worker')
    .run();
  const reservation = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO quota_reservations(reservation_id,owner_id,job_id,fencing_token,request_id,provider,model,account_key,snapshots_json,input_tokens,charged_input_tokens,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'SUBMITTED',?,?)",
  )
    .bind(
      reservation,
      'a',
      token.job_id,
      token.fencing_token,
      'null-response',
      'gemini',
      'gemini-3.8-flash',
      'project',
      '[]',
      100,
      100,
      fixtureNow.toISOString(),
      new Date(fixtureNow.getTime() + 300000).toISOString(),
    )
    .run();
  const response = {
    request_id: 'null-response',
    status: 'TEMPORARY_FAILURE' as const,
    actual_provider: 'gemini',
    actual_model: null,
    finish_reason: 'transport_unknown',
    usage: { input_tokens: null, output_tokens: null, total_tokens: null },
    retry_after: null,
    raw_output: null,
  };
  const transport: typeof fetch = async (input, init) =>
    worker.fetch(
      new Request(input, init),
      { ...env, SESSION_SIGNING_SECRET: fixtureSecret },
      createExecutionContext(),
    );
  const input = {
    origin: 'https://fixture.invalid',
    credential,
    token,
    reservation_id: reservation,
    item_id: item.item_id,
    response,
    transport,
  };
  expect(await retainAnalysisResponse(input)).toMatchObject({
    diagnostic_only: true,
    status: 'TEMPORARY_FAILURE',
  });
  expect(await retainAnalysisResponse(input)).toMatchObject({
    diagnostic_only: true,
  });
  const row = await env.DB.prepare(
    'SELECT state,charged_input_tokens FROM quota_reservations WHERE reservation_id=?',
  )
    .bind(reservation)
    .first();
  expect(row).toMatchObject({ state: 'UNKNOWN', charged_input_tokens: 100 });
  expect(
    await env.DB.prepare('SELECT count(*) AS n FROM usage_records').first('n'),
  ).toBe(1);
  expect(
    await env.DB.prepare('SELECT count(*) AS n FROM observations').first('n'),
  ).toBe(0);
  await expect(
    retainAnalysisResponse({
      ...input,
      response: { ...response, finish_reason: 'different-result' },
    }),
  ).rejects.toThrow();
  const mismatch = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO quota_reservations(reservation_id,owner_id,job_id,fencing_token,request_id,provider,model,account_key,snapshots_json,input_tokens,charged_input_tokens,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'SUBMITTED',?,?)",
  )
    .bind(
      mismatch,
      'a',
      token.job_id,
      token.fencing_token,
      'mismatched-model',
      'gemini',
      'gemini-3.8-flash',
      'project',
      '[]',
      100,
      100,
      fixtureNow.toISOString(),
      new Date(fixtureNow.getTime() + 300000).toISOString(),
    )
    .run();
  await retainAnalysisResponse({
    ...input,
    reservation_id: mismatch,
    response: {
      ...response,
      request_id: 'mismatched-model',
      actual_model: 'unexpected-model',
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    },
  });
  expect(
    await env.DB.prepare(
      'SELECT state,charged_input_tokens FROM quota_reservations WHERE reservation_id=?',
    )
      .bind(mismatch)
      .first(),
  ).toMatchObject({ state: 'UNKNOWN', charged_input_tokens: 100 });
  const detailed = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO quota_reservations(reservation_id,owner_id,job_id,fencing_token,request_id,provider,model,account_key,snapshots_json,input_tokens,charged_input_tokens,state,created_at,expires_at) SELECT ?,owner_id,job_id,fencing_token,?,provider,model,account_key,snapshots_json,input_tokens,charged_input_tokens,'SUBMITTED',created_at,expires_at FROM quota_reservations WHERE reservation_id=?",
  )
    .bind(detailed, 'detailed-accounting', mismatch)
    .run();
  const detailedInput = {
    ...input,
    reservation_id: detailed,
    response: {
      ...response,
      request_id: 'detailed-accounting',
      status: 'OK' as const,
      raw_output: '{}',
      actual_model: 'gemini-3.8-flash',
      usage: { input_tokens: 19, output_tokens: 9, total_tokens: 28 },
      token_usage_numeric_fields: {
        total_input_tokens: 19,
        raw_prompt_token: 100,
        total_thought_tokens: 0,
      },
    },
  };
  const detailedReceipt = (await retainAnalysisResponse(detailedInput)) as {
    artifact_id: string;
  };
  expect(
    await env.DB.prepare(
      'SELECT state,charged_input_tokens FROM quota_reservations WHERE reservation_id=?',
    )
      .bind(detailed)
      .first(),
  ).toMatchObject({ state: 'SETTLED', charged_input_tokens: 100 });
  const provenance = await env.DB.prepare(
    'SELECT provenance_json FROM artifacts WHERE artifact_id=?',
  )
    .bind(detailedReceipt.artifact_id)
    .first<string>('provenance_json');
  expect(JSON.parse(provenance!).response.token_usage_numeric_fields).toEqual(
    detailedInput.response.token_usage_numeric_fields,
  );
  await expect(
    retainAnalysisResponse({
      ...detailedInput,
      response: {
        ...detailedInput.response,
        token_usage_numeric_fields: { raw_prompt_token: 101 },
      },
    }),
  ).rejects.toThrow();
});
it.each([false, true])(
  'local poller consumes durable caption backlog through the real Worker API (daily workflow enabled: %s)',
  async (dailyEnabled) => {
    if (dailyEnabled) {
      await dailyFixture();
      await env.DB.prepare(
        "UPDATE daily_workflow_settings SET started_at=? WHERE owner_id='a'",
      )
        .bind(fixtureNow.toISOString())
        .run();
    }
    const { token, item } = await setup();
    const credential = 'e'.repeat(43);
    await env.DB.prepare(
      'UPDATE worker_identities SET credential_hash=? WHERE worker_id=?',
    )
      .bind(await sha256(credential), 'artifact-worker')
      .run();
    await sweep(env.DB, new Date(), () => true);
    const raw =
      '{"events":[{"tStartMs":250,"dDurationMs":70000,"segs":[{"utf8":"Exact original."}]}]}';
    const track = {
      language_code: 'en',
      track_kind: 'MANUAL',
      is_generated: false,
      is_translated: false,
      source_language: null,
      is_translatable: false,
      is_original: null,
      extension: 'json3',
    };
    let providerCalls = 0;
    const provider = new YtdlpTranscriptProvider(async () => {
      providerCalls++;
      return {
        status: 'OK',
        failure_code: null,
        provider_version: '2026.8.19',
        python_version: '3.14.4',
        tracks: [
          track,
          {
            ...track,
            track_kind: 'GENERATED',
            is_generated: true,
            is_original: true,
          },
        ],
        video_language: 'en',
        selected: track,
        segments: [
          {
            upstream_index: 0,
            start_ms: 250,
            end_ms: 70250,
            text: 'Exact original.',
            speaker_label: null,
          },
        ],
        raw_payload_base64: btoa(raw),
        raw_payload_hash: await sha256(raw),
        upstream_requests: 1,
        bytes_received: raw.length,
      };
    });
    const transport: typeof fetch = async (input, init) =>
      worker.fetch(
        new Request(input, init),
        { ...env, SESSION_SIGNING_SECRET: fixtureSecret },
        createExecutionContext(),
      );
    const local = new LocalTranscriptWorker(
      'https://executor-fixture.invalid',
      credential,
      provider,
      transport,
      undefined,
      undefined,
      dailyEnabled ? 'COMPACT' : 'LEGACY',
    );
    expect(await local.cycle()).toMatchObject({
      accepted: true,
      reason: null,
      idle: false,
    });
    expect(providerCalls).toBe(2);
    const representation = await env.DB.prepare(
      'SELECT flags_json FROM transcript_representations',
    ).first<{ flags_json: string }>();
    expect(JSON.parse(representation!.flags_json)).toMatchObject({
      selection: {
        authority_basis: 'EXPLICIT_ORIGINAL',
        source: { is_original: null, track_kind: 'MANUAL' },
      },
    });
    expect(
      await env.DB.prepare('SELECT state FROM jobs WHERE job_id=?')
        .bind(token.job_id)
        .first('state'),
    ).toBe('SUCCEEDED');
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM artifacts WHERE state='VERIFIED'",
      ).first('n'),
    ).toBe(dailyEnabled ? 3 : 6);
    const run = await env.DB.prepare(
      "SELECT outcome_json FROM analysis_runs WHERE job_id=? AND state='ACCEPTED'",
    )
      .bind(token.job_id)
      .first<{ outcome_json: string }>();
    expect(JSON.parse(run!.outcome_json).warnings).toEqual([
      'SOURCE_DURATION_OVERRUN',
    ]);
    expect(
      await env.DB.prepare('SELECT count(*) AS n FROM observations').first('n'),
    ).toBe(0);
    expect(await local.cycle()).toEqual({
      accepted: false,
      reason: null,
      idle: true,
    });
    expect(providerCalls).toBe(2);
    const sourceRun = await env.DB.prepare(
      "SELECT run_id,outcome_json FROM analysis_runs WHERE job_id=? AND state='ACCEPTED'",
    )
      .bind(token.job_id)
      .first<{ run_id: string; outcome_json: string }>();
    const before = sourceRun!.outcome_json;
    if (dailyEnabled) {
      const materials = (
        await env.DB.prepare(
          "SELECT item_id,video_id,source_artifact_id,source_hash,material_date,acquired_at FROM daily_materials WHERE owner_id='a'",
        ).all<{
          item_id: string;
          video_id: string;
          source_artifact_id: string;
          source_hash: string;
          material_date: string;
          acquired_at: string;
        }>()
      ).results;
      expect(materials).toHaveLength(1);
      expect(materials[0]).toMatchObject({
        item_id: item.item_id,
        video_id: 'artifact001',
        source_artifact_id: JSON.parse(before).source_artifact_id,
        source_hash: await sha256('Exact original.'),
      });
      expect(materials[0]!.material_date).toBe(
        new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Europe/Warsaw',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date(materials[0]!.acquired_at)),
      );
      // The source approval and enrollment occurred through the actual RPC,
      // scoped artifact uploads, integrity checks and fenced acceptance batch.
      return;
    }
    const owner = await fixtureOwner();
    expect(
      await new AnalysisJobs(env.DB, owner).sourceForOwner(sourceRun!.run_id),
    ).toMatchObject({
      source_artifact_id: JSON.parse(before).source_artifact_id,
    });
    const corrections = new SourceCorrectionJobs(env.DB, owner);
    const nonce = crypto.randomUUID();
    const patches = [
      {
        source_start: 0,
        source_end: 5,
        old_value: 'Exact',
        new_value: 'Corrected',
      },
    ];
    const correctedJob = await corrections.enqueue(
      sourceRun!.run_id,
      patches,
      'Owner corrected transcription',
      nonce,
      new Date(),
    );
    expect(
      (await corrections.enqueue(
        sourceRun!.run_id,
        patches,
        'Owner corrected transcription',
        nonce,
        new Date(),
      ))!.job_id,
    ).toBe(correctedJob!.job_id);
    await expect(
      corrections.enqueue(
        sourceRun!.run_id,
        patches,
        'Changed reason',
        nonce,
        new Date(),
      ),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await expect(
      new SourceCorrectionJobs(env.DB, await fixtureOwner('b')).enqueue(
        sourceRun!.run_id,
        patches,
        'Cross-owner',
        crypto.randomUUID(),
        new Date(),
      ),
    ).rejects.toThrow('ANALYSIS_SOURCE_NOT_ACCEPTED');
    expect(
      await env.DB.prepare('SELECT state FROM jobs WHERE job_id=?')
        .bind(correctedJob!.job_id)
        .first('state'),
    ).toBe('PENDING');
    const correctionCredential = 'c'.repeat(43);
    await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
      .bind(
        'correction-worker',
        'a',
        await sha256(correctionCredential),
        '["NORMALIZE"]',
        new Date().toISOString(),
      )
      .run();
    const correctionWorker = new LocalSourceCorrectionWorker(
      'https://executor-fixture.invalid',
      correctionCredential,
      transport,
    );
    const correctionAccess = await AccessContext.worker(
      env.DB,
      await sha256(correctionCredential),
    );
    expect(
      await new JobStore(env.DB, correctionAccess).lease(
        correctedJob!.job_id,
        'NORMALIZE',
        new Date(),
        'cloud',
      ),
    ).toBeNull();
    expect(await correctionWorker.cycle()).toMatchObject({
      accepted: true,
      idle: false,
    });
    const correctionRun = await env.DB.prepare(
      "SELECT outcome_json FROM analysis_runs WHERE job_id=? AND state='ACCEPTED'",
    )
      .bind(correctedJob!.job_id)
      .first<string>('outcome_json');
    const outcome = JSON.parse(correctionRun!);
    expect(outcome).toMatchObject({
      kind: 'CORRECTED_SOURCE',
      original_hash: JSON.parse(before).source_hash,
      authored_by: 'a',
    });
    const correctedMap = await new ArtifactRepository(
      env.DB,
      owner,
    ).readVerifiedText(outcome.segment_map_artifact_id, 1024 * 1024);
    expect(JSON.parse(correctedMap.text).coverage[0]).toMatchObject({
      start_ms: 250,
      end_ms: 70250,
    });
    expect(
      await env.DB.prepare(
        'SELECT outcome_json FROM analysis_runs WHERE run_id=?',
      )
        .bind(sourceRun!.run_id)
        .first('outcome_json'),
    ).toBe(before);
    expect(
      await env.DB.prepare('SELECT COUNT(*) n FROM observations').first('n'),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) n FROM active_analysis_selections',
      ).first('n'),
    ).toBe(0);
    expect(await correctionWorker.cycle()).toMatchObject({
      accepted: false,
      idle: true,
    });
    await verifyCorrectedInput(
      env.DB,
      owner,
      await fixtureOwner('b'),
      correctedJob!.job_id,
      transport,
    );
    const badJob = await corrections.enqueue(
      sourceRun!.run_id,
      [{ ...patches[0]!, old_value: 'Wrong' }],
      'Wrong source fragment',
      crypto.randomUUID(),
      new Date(),
    );
    expect(await correctionWorker.cycle()).toMatchObject({
      accepted: false,
      idle: false,
      state: 'BLOCKED',
    });
    expect(
      await env.DB.prepare('SELECT state FROM jobs WHERE job_id=?')
        .bind(badJob!.job_id)
        .first('state'),
    ).toBe('BLOCKED');
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM analysis_runs WHERE job_id=? AND state='ACCEPTED'",
      )
        .bind(badJob!.job_id)
        .first('n'),
    ).toBe(0);
    const completedAttempt = await env.DB.prepare(
      'SELECT fencing_token,executor_id FROM job_attempts WHERE job_id=? AND finished_at IS NOT NULL',
    )
      .bind(correctedJob!.job_id)
      .first<{ fencing_token: number; executor_id: string }>();
    const completedToken = {
      job_id: correctedJob!.job_id,
      lease_owner: completedAttempt!.executor_id,
      fencing_token: completedAttempt!.fencing_token,
      lease_until: new Date().toISOString(),
    };
    const workerCorrections = new SourceCorrectionJobs(
      env.DB,
      correctionAccess,
    );
    expect(
      await workerCorrections.complete(
        completedToken,
        outcome.source_artifact_id,
        outcome.segment_map_artifact_id,
        new Date(),
      ),
    ).toMatchObject({ accepted: true, duplicate: true });
    await expect(
      workerCorrections.complete(
        completedToken,
        'wrong-artifact',
        outcome.segment_map_artifact_id,
        new Date(),
      ),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    const acceptedAnalysis = await env.DB.prepare(
      "SELECT r.run_id,e.evidence_id FROM analysis_runs r JOIN analysis_evidence e ON e.owner_id=r.owner_id AND e.run_id=r.run_id WHERE r.owner_id=? AND r.state='ACCEPTED' AND json_extract(r.outcome_json,'$.source_artifact_id')=?",
    )
      .bind(owner.ownerId, outcome.source_artifact_id)
      .first<{ run_id: string; evidence_id: string }>();
    const readBeforeRestore = await new EvidenceProjection(env.DB, owner).read(
      acceptedAnalysis!.evidence_id,
      acceptedAnalysis!.run_id,
    );
    const backup = new CoreBackup(env.DB, owner),
      backupStart = await backup.begin(),
      chunks: BackupChunk[] = [];
    for (const table of backupTables) {
      let cursor: number | null = 0;
      do {
        const chunk = await backup.chunk(backupStart.backup_id, table, cursor);
        chunks.push(chunk);
        cursor = chunk.next_cursor;
      } while (cursor !== null);
    }
    const portable = {
      manifest: await backup.complete(backupStart.backup_id),
      chunks,
    };
    await resetSchema();
    await restoreCanonical(env.DB, portable, 'subject-a');
    expect(
      await new EvidenceProjection(env.DB, await fixtureOwner()).read(
        acceptedAnalysis!.evidence_id,
        acceptedAnalysis!.run_id,
      ),
    ).toEqual(readBeforeRestore);
    expect(
      await env.DB.prepare(
        'SELECT outcome_json FROM analysis_runs WHERE run_id=?',
      )
        .bind(sourceRun!.run_id)
        .first('outcome_json'),
    ).toBe(before);
    // This compound functional scenario includes both local workers, correction
    // provenance, accepted Evidence and portable backup/restore. Wall-clock timeout
    // is a harness bound, not a CPU/performance acceptance criterion.
  },
  15000,
);
it.each([
  'QUALITY_TEST',
  'CHUNKED',
  'CHUNK_LARGE',
  'CHUNK_COMPLETE',
  'CHUNK_PRODUCTION',
  'CHUNK_FULL_PRODUCTION',
  'OPTIONAL_TRANSLATION',
  'MULTIPART_TRANSLATION',
  'CUSTOM_PRODUCTION',
  'PRODUCTION',
  'AUTOMATIC',
  'RATE_LIMITED',
  'TEMPORARY_FAILURE',
  'REFUSED',
  'MALFORMED',
  'QUALITY_REVIEW',
  'QUALITY_NARRATIVE',
] as const)(
  'verified source acceptance and %s analysis preserve source authority and fenced knowledge effects',
  async (scenario) => {
    const qualityReview =
      scenario === 'QUALITY_REVIEW' || scenario === 'QUALITY_NARRATIVE';
    const semanticMode =
      scenario === 'CHUNK_FULL_PRODUCTION'
        ? ('FULL' as const)
        : scenario === 'CUSTOM_PRODUCTION'
          ? ('CUSTOM' as const)
          : ('ECONOMY' as const);
    const chunkProduction =
      scenario === 'CHUNK_PRODUCTION' || scenario === 'CHUNK_FULL_PRODUCTION';
    const mode: 'PRODUCTION' | 'QUALITY_TEST' =
      scenario === 'PRODUCTION' ||
      qualityReview ||
      scenario === 'AUTOMATIC' ||
      scenario === 'CUSTOM_PRODUCTION' ||
      chunkProduction
        ? 'PRODUCTION'
        : 'QUALITY_TEST';
    const { item, token, access, repository, owner } = await setup();
    const sourceText =
        scenario === 'MULTIPART_TRANSLATION'
          ? Array.from(
              { length: 10 },
              (_, i) => `Original statement ${i}.`,
            ).join('\n')
          : scenario === 'CHUNK_LARGE'
            ? 'Original statement. '.repeat(8000).trim()
            : scenario === 'CHUNKED'
              ? 'Original statement. '.repeat(40).trim()
              : 'Original statement.',
      revision = await sha256(sourceText);
    const track = {
      track_id: 'native-en',
      item_id: item.item_id,
      language_code: 'en',
      track_kind: 'MANUAL' as const,
      is_generated: false,
      is_translated: false,
      source_language: null,
      translation_source_track_id: null,
      is_translatable: false,
      translation_languages: [],
      is_original: true,
      extension: 'json3',
      expires_at: new Date(fixtureNow.getTime() + 600000).toISOString(),
    };
    const selection = selectTranscriptLanguage(
      {
        status: 'OK',
        failure_code: null,
        provider_id: 'local_ytdlp',
        provider_version: 'yt-dlp@2026.08.19+yt-dlp-ejs@0.8.0',
        runtime_id: 'local',
        tracks: [track],
        video_language: 'en',
        retrieved_at: fixtureNow.toISOString(),
        request_id: 'source-test',
      },
      revision,
    );
    const provenance = {
      provider_id: 'local_ytdlp',
      upstream_track_id: track.track_id,
      language_code: 'en',
      track_kind: 'MANUAL',
      is_generated: false,
      is_translated: false,
      is_original: true,
      video_language: 'en',
      original_language: 'en',
    };
    const upload = async (
      kind: ArtifactDescriptor['kind'],
      text: string,
      original: string | null,
    ) => {
      const chunks = splitArtifactText(text);
      const artifact = await repository.begin(
        {
          item_id: item.item_id,
          kind,
          content_hash: await sha256(text),
          byte_size: new TextEncoder().encode(text).length,
          chunk_count: chunks.length,
          schema_version: 'fixture:1',
          producer_version: original
            ? 'source-normalizer:1'
            : 'yt-dlp@2026.08.19+yt-dlp-ejs@0.8.0',
          provenance: original
            ? { ...provenance, source_revision: revision }
            : provenance,
          original_ref: original,
        },
        token,
        'FETCH_TRANSCRIPT',
        fixtureNow,
      );
      let offset = 0;
      for (const [index, chunk] of chunks.entries()) {
        await repository.writeChunk(
          artifact.artifact_id,
          index,
          offset,
          chunk,
          token,
          'FETCH_TRANSCRIPT',
          fixtureNow,
        );
        offset += chunk.length;
      }
      return repository.verifyLocal(
        artifact.artifact_id,
        token,
        'FETCH_TRANSCRIPT',
        fixtureNow,
        'local',
      );
    };
    const raw = await upload('RAW', '{"events":[]}', null),
      source = await upload('SOURCE_ORIGINAL', sourceText, null);
    const sourceNormalized = await normalizeTranscript(
      revision,
      scenario === 'MULTIPART_TRANSLATION'
        ? sourceText.split('\n').map((text, i) => ({
            upstream_index: i,
            text,
            start_ms: i * 2000,
            end_ms: i * 2000 + 1500,
            speaker_label: null,
          }))
        : [
            {
              upstream_index: 0,
              text: sourceText,
              start_ms: 0,
              end_ms: 1500,
              speaker_label: null,
            },
          ],
      'CUE',
      scenario === 'CHUNKED' ? 8 : 8192,
    );
    const normalized = await upload(
        'NORMALIZED',
        sourceText,
        source.artifact_id,
      ),
      map = await upload(
        'SEGMENT_MAP',
        JSON.stringify(sourceNormalized.manifest),
        source.artifact_id,
      ),
      offsets = await upload('OFFSET_MAP', '[]', source.artifact_id);
    const input: TranscriptSourceCompletion = {
      raw_artifact_id: raw.artifact_id,
      source_artifact_id: source.artifact_id,
      normalized_artifact_id: normalized.artifact_id,
      segment_map_artifact_id: map.artifact_id,
      offset_map_artifact_id: offsets.artifact_id,
      selection,
      warnings: ['SOURCE_DURATION_OVERRUN', 'NO_TIMESTAMP'],
    };
    const acceptance = new TranscriptAcceptance(env.DB, access);
    await expect(
      acceptance.accept(
        { ...input, warnings: ['UNKNOWN_SOURCE_WARNING'] },
        token,
        fixtureNow,
      ),
    ).rejects.toThrow('INVALID_SOURCE_COMPLETION');
    await expect(
      acceptance.accept(
        { ...input, selection: { ...selection, authority_confidence: 'LOW' } },
        token,
        fixtureNow,
      ),
    ).rejects.toThrow('INVALID_SOURCE_COMPLETION');
    await expect(
      acceptance.accept(
        { ...input, offset_map_artifact_id: map.artifact_id },
        token,
        fixtureNow,
      ),
    ).rejects.toThrow('INVALID_SOURCE_ARTIFACT_SET');
    await expect(
      acceptance.accept(
        input,
        { ...token, fencing_token: token.fencing_token + 1 },
        fixtureNow,
      ),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM analysis_runs WHERE state='ACCEPTED'",
      ).first('n'),
    ).toBe(0);
    const accepted = await acceptance.accept(input, token, fixtureNow);
    expect(accepted.accepted).toBe(true);
    expect(await acceptance.accept(input, token, fixtureNow)).toMatchObject({
      accepted: true,
      duplicate: true,
      run_id: accepted.run_id,
    });
    expect(
      await env.DB.prepare('SELECT state FROM jobs WHERE job_id=?')
        .bind(token.job_id)
        .first('state'),
    ).toBe('SUCCEEDED');
    expect(
      await env.DB.prepare('SELECT count(*) AS n FROM observations').first('n'),
    ).toBe(0);
    const registry = new PromptRegistry(env.DB, owner);
    await registry.importBundle(bundle, fixtureNow);
    await registry.activate('ECONOMY_ANALYSIS_V1', 2, 0, fixtureNow);
    const profile: PipelineProfile = {
      profile_id: 'gemini_free',
      revision: 1,
      provider_id: 'gemini',
      model: 'gemini-3.8-flash',
      account_key: 'actual-registry-account',
      free_eligible: true,
      billing_enabled: false,
      purposes: ['personal'],
      regions: [scenario === 'AUTOMATIC' ? 'PL/EEA' : 'PL'],
      task_types: [semanticMode],
      runtimes: ['local'],
      structured_output: true,
      context_tokens:
        scenario === 'CHUNKED' || scenario === 'CHUNK_LARGE'
          ? economyPromptOverhead({
              prompt: await registry.current(),
              semantic_context: {
                title: null,
                author: null,
                published_at: null,
                source_language: 'en',
              },
              limits: { claims: 20 },
            }) +
            3000 +
            (scenario === 'CHUNK_LARGE' ? 8500 : 128)
          : 100000,
      output_tokens: 8000,
      rank: 0,
      quality_approvals: [],
      eligibility_expires_at: new Date(Date.now() + 3600000).toISOString(),
    };
    const models = new ModelRegistry(env.DB, owner);
    await models.publish(profile, fixtureNow);
    if (
      scenario === 'OPTIONAL_TRANSLATION' ||
      scenario === 'MULTIPART_TRANSLATION'
    ) {
      await (
        scenario === 'MULTIPART_TRANSLATION'
          ? verifyMultipartTranslation
          : verifyOptionalTranslation
      )(
        env.DB,
        owner,
        item.item_id,
        {
          owner_id: 'a',
          source_artifact_id: source.artifact_id,
          ...sourceNormalized,
          source_language: 'en',
          video_url: null,
        },
        profile,
      );
      return;
    }
    const settings = {
      runtime: 'local' as const,
      mode,
      purpose: 'personal',
      region: scenario === 'AUTOMATIC' ? 'PL/EEA' : 'PL',
      max_output_tokens: 4000,
      limits: { claims: scenario === 'AUTOMATIC' ? 40 : 20 },
    };
    const analysis = new AnalysisJobs(env.DB, owner);
    const semanticRegistry = new SemanticProfiles(env.DB, owner);
    const semanticConfig: SemanticProfile = {
      mode: semanticMode,
      modules: Object.fromEntries(
        semanticModules.map((key, i) => [
          key,
          semanticMode === 'FULL' || i < 7,
        ]),
      ) as SemanticProfile['modules'],
      translation: 'NONE',
      history: false,
      second_pass: null,
      validation_pass: null,
    };
    const semanticSnapshot = await semanticRegistry.save(
      {
        profile_id: 'monitor',
        revision: 1,
        name: 'Monitor',
        config: semanticConfig,
        reason: 'First scope',
      },
      bundle,
      fixtureNow,
    );
    await semanticRegistry.assign(
      {
        profile_id: 'monitor',
        revision: 1,
        source_id: null,
        effective_from: fixtureNow.toISOString(),
        apply_to_pending: true,
        reason: 'Explicit pending scope',
      },
      0,
      fixtureNow,
    );
    if (semanticMode !== 'ECONOMY') {
      await expect(
        analysis.enqueue(
          accepted.run_id,
          { ...settings, mode: 'PRODUCTION' },
          fixtureNow,
        ),
      ).rejects.toThrow('PROMPT_NOT_CONFIGURED');
      // Fixture-only published baseline. It supplies no real quality approval.
      await env.DB.prepare(
        "UPDATE prompt_versions SET status='PUBLISHED' WHERE owner_id='a' AND prompt_id=? AND version=2",
      )
        .bind(semanticSnapshot.compiled.prompt.id)
        .run();
    }
    await expect(
      analysis.enqueue(
        accepted.run_id,
        { ...settings, mode: 'PRODUCTION' },
        fixtureNow,
      ),
    ).rejects.toThrow('ANALYSIS_PROFILE_QUALITY_SCOPE');
    if (scenario === 'AUTOMATIC') {
      const credential = await sha256('automatic-scoped-fixture');
      await env.DB.prepare(
        'INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)',
      )
        .bind(
          'automatic-worker',
          'a',
          credential,
          '["ANALYZE"]',
          fixtureNow.toISOString(),
        )
        .run();
      const automatic = new AnalysisJobs(
        env.DB,
        await AccessContext.worker(env.DB, credential),
      );
      const waiting = await automatic.scheduleAutomatic(fixtureNow);
      expect(waiting).toMatchObject({
        created: 0,
        deferred: ['ANALYSIS_PROFILE_QUALITY_SCOPE'],
        provider_requests: 0,
      });
      expect(waiting.next_cursor?.run_id).toBe(accepted.run_id);
      expect(
        await automatic.scheduleAutomatic(fixtureNow, waiting.next_cursor),
      ).toMatchObject({ created: 0, next_cursor: null });
      expect(
        await env.DB.prepare(
          "SELECT count(*) n FROM jobs WHERE task_type='ANALYZE'",
        ).first('n'),
      ).toBe(0);
    }
    if (mode === 'PRODUCTION') {
      profile.quality_approvals = [
        await analysisQualityScope(
          {
            ...semanticPrompt(semanticSnapshot),
            quality_policy: await analysisQualitySnapshot(),
          },
          profile,
          {
            limits: settings.limits,
            max_output_tokens: settings.max_output_tokens,
            source_language: selection.source!.language_code,
            analysis_mode: 'ORDINARY',
          },
        ),
      ];
      if (chunkProduction) {
        for (const analysis_mode of ['ORDINARY', 'CHUNK'] as const)
          profile.quality_approvals.push(
            await analysisQualityScope(
              {
                ...semanticPrompt(semanticSnapshot),
                quality_policy: await analysisQualitySnapshot(),
              },
              profile,
              {
                limits: settings.limits,
                max_output_tokens: 3000,
                source_language: selection.source!.language_code,
                analysis_mode,
              },
            ),
          );
      }
      profile.revision = 2;
      await models.publish(profile, fixtureNow);
    }
    await expect(
      new AnalysisJobs(env.DB, await fixtureOwner('b')).enqueue(
        accepted.run_id,
        settings,
        fixtureNow,
      ),
    ).rejects.toThrow('ANALYSIS_SOURCE_NOT_ACCEPTED');
    await expect(
      new AnalysisJobs(env.DB, access).enqueue(
        accepted.run_id,
        settings,
        fixtureNow,
      ),
    ).rejects.toThrow('FORBIDDEN');
    if (scenario === 'AUTOMATIC') {
      const credential = await sha256('automatic-scoped-fixture');
      const scoped = await AccessContext.worker(env.DB, credential);
      const automatic = new AnalysisJobs(env.DB, scoped);
      await expect(
        new AnalysisJobs(env.DB, access).enqueueAutomatic(
          accepted.run_id,
          settings,
          fixtureNow,
        ),
      ).rejects.toThrow('FORBIDDEN');
      await expect(
        automatic.enqueueAutomatic(
          accepted.run_id,
          { ...settings, mode: 'QUALITY_TEST' },
          fixtureNow,
        ),
      ).rejects.toThrow('FORBIDDEN');
      const planned = await automatic.scheduleAutomatic(fixtureNow);
      expect(planned).toMatchObject({
        created: 1,
        deferred: [],
        provider_requests: 0,
      });
      const queryPlan = await env.DB.prepare(
        "EXPLAIN QUERY PLAN SELECT 1 FROM jobs WHERE owner_id=? AND task_type='ANALYZE' AND json_extract(payload_json,'$.snapshot.source.run_id')=? AND json_extract(payload_json,'$.snapshot.settings.mode')='PRODUCTION'",
      )
        .bind(owner.ownerId, accepted.run_id)
        .all<{ detail: string }>();
      expect(
        queryPlan.results.some((row) =>
          row.detail.includes('automatic_analysis_source'),
        ),
      ).toBe(true);
      expect(await automatic.scheduleAutomatic(fixtureNow)).toMatchObject({
        created: 0,
        provider_requests: 0,
        next_cursor: null,
      });
      const job = await automatic.enqueueAutomatic(
        accepted.run_id,
        settings,
        fixtureNow,
      );
      expect(
        JSON.parse(
          (await env.DB.prepare('SELECT payload_json FROM jobs WHERE job_id=?')
            .bind(job.job_id)
            .first<string>('payload_json'))!,
        ),
      ).toMatchObject({
        snapshot: { settings: { runtime: 'local', mode: 'PRODUCTION' } },
      });
      expect(job.arrival_origin_at).toBe(
        (await new JobStore(env.DB, access).get(token.job_id))!
          .arrival_origin_at,
      );
      expect(
        await env.DB.prepare('SELECT count(*) n FROM outbox WHERE job_id=?')
          .bind(job.job_id)
          .first('n'),
      ).toBe(1);
      await env.DB.prepare(
        'UPDATE sources SET ai_processing_allowed=0 WHERE owner_id=?',
      )
        .bind(owner.ownerId)
        .run();
      await expect(
        automatic.enqueueAutomatic(accepted.run_id, settings, fixtureNow),
      ).rejects.toThrow('ANALYSIS_SOURCE_PROCESSING_DENIED');
      await env.DB.prepare(
        "UPDATE worker_identities SET revoked_at=? WHERE worker_id='automatic-worker'",
      )
        .bind(fixtureNow.toISOString())
        .run();
      await expect(automatic.scheduleAutomatic(fixtureNow)).rejects.toThrow(
        'UNAUTHENTICATED',
      );
      return;
    }
    const aiJob = (await analysis.enqueue(
      accepted.run_id,
      settings,
      fixtureNow,
    ))!;
    let draftTestPreviewHash = '';
    if (
      scenario === 'PRODUCTION' ||
      scenario === 'CUSTOM_PRODUCTION' ||
      qualityReview
    ) {
      const before = await env.DB.prepare('SELECT count(*) n FROM jobs').first(
        'n',
      );
      const application = await new PromptTests(env.DB, owner).preview(
        {
          prompt_id: semanticSnapshot.compiled.prompt.id,
          version: 2,
          source_run_id: accepted.run_id,
          semantic_profile_id: 'monitor',
          semantic_profile_revision: 1,
          model_revision: profile.revision,
          max_output_tokens: settings.max_output_tokens,
          purpose: settings.purpose,
          region: settings.region,
          limits: settings.limits,
        },
        fixtureNow,
        'PRODUCTION',
      );
      expect(application).toMatchObject({
        kind: 'ANALYSIS',
        prompt_version: 2,
        model_revision: profile.revision,
        additional_model_requests: 1,
        selection_effect: 'NONE_UNTIL_EXPLICIT_SELECTION',
      });
      expect(
        await env.DB.prepare('SELECT count(*) n FROM jobs').first('n'),
      ).toBe(before);
    }
    if (scenario === 'QUALITY_TEST') {
      const family = semanticSnapshot.compiled.prompt.id;
      const draft = await new PromptDrafts(env.DB, owner).create(
        {
          prompt_id: family,
          base_version: 2,
          expected_latest_version: 2,
          text:
            semanticSnapshot.compiled.prompt.text +
            '\nDraft quality test instruction.',
          reason: 'Synthetic test target',
        },
        fixtureNow,
      );
      const jobsBefore = await env.DB.prepare(
        'SELECT count(*) n FROM jobs',
      ).first('n');
      const preview = await new PromptTests(env.DB, owner).preview(
        {
          prompt_id: family,
          version: draft.version,
          source_run_id: accepted.run_id,
          semantic_profile_id: 'monitor',
          semantic_profile_revision: 1,
          model_revision: profile.revision,
          max_output_tokens: settings.max_output_tokens,
          purpose: settings.purpose,
          region: settings.region,
          limits: settings.limits,
        },
        fixtureNow,
      );
      expect(preview).toMatchObject({
        kind: 'ANALYSIS',
        prompt_version: 3,
        prompt_hash: draft.prompt_hash,
        model_revision: profile.revision,
        additional_model_requests: 1,
        quota_status: 'UNKNOWN',
      });
      draftTestPreviewHash = preview.preview_hash;
      await expect(
        new PromptTests(env.DB, owner).preview(
          {
            prompt_id: family,
            version: 3,
            source_run_id: accepted.run_id,
            semantic_profile_id: 'monitor',
            semantic_profile_revision: 1,
            model_revision: profile.revision,
            max_output_tokens: settings.max_output_tokens,
            purpose: settings.purpose,
            region: settings.region,
            limits: settings.limits,
          },
          fixtureNow,
          'PRODUCTION',
        ),
      ).rejects.toThrow('INVALID_UNPUBLISHED_PROMPT');
      expect(
        await env.DB.prepare('SELECT count(*) n FROM jobs').first('n'),
      ).toBe(jobsBefore);
      await expect(
        analysis.previewExplicit(
          accepted.run_id,
          { ...settings, mode: 'PRODUCTION' },
          {
            semantic_profile_id: 'monitor',
            semantic_profile_revision: 1,
            pass: null,
            test_prompt: { prompt_id: family, version: 3 },
          },
          fixtureNow,
        ),
      ).rejects.toThrow('INVALID_PROMPT_TEST');
    }
    await semanticRegistry.save(
      {
        profile_id: 'monitor',
        revision: 2,
        name: 'Monitor updated',
        config: semanticConfig,
        reason: 'New immutable scope revision',
      },
      bundle,
      fixtureNow,
    );
    await semanticRegistry.assign(
      {
        profile_id: 'monitor',
        revision: 2,
        source_id: null,
        effective_from: fixtureNow.toISOString(),
        apply_to_pending: true,
        reason: 'New material scope',
      },
      1,
      fixtureNow,
    );
    expect(
      (await analysis.enqueue(accepted.run_id, settings, fixtureNow))!.job_id,
    ).toBe(aiJob.job_id);
    const longParent =
      scenario === 'QUALITY_TEST' || scenario.startsWith('CHUNK')
        ? await analysis.enqueue(
            accepted.run_id,
            { ...settings, max_output_tokens: 3000 },
            fixtureNow,
          )
        : null;
    await models.publish(
      { ...profile, revision: profile.revision + 1, model: 'different-model' },
      fixtureNow,
    );
    await registry.activate('ECONOMY_ANALYSIS_V1', 2, 1, fixtureNow);
    const aiCredential = await sha256('q'.repeat(43));
    await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
      .bind(
        'analysis-worker',
        'a',
        aiCredential,
        '["ANALYZE"]',
        fixtureNow.toISOString(),
      )
      .run();
    const aiAccess = await AccessContext.worker(env.DB, aiCredential),
      aiStore = new JobStore(env.DB, aiAccess);
    const aiToken = (await aiStore.lease(
      aiJob.job_id,
      'ANALYZE',
      fixtureNow,
      'local',
    ))!;
    await aiStore.start(aiToken, 'ANALYZE', fixtureNow);
    const workerJobs = new AnalysisJobs(env.DB, aiAccess);
    const prepared = await workerJobs.prepareRun(aiToken, fixtureNow);
    expect(prepared.snapshot.semantic_profile?.revision).toBe(1);
    expect(prepared.snapshot.profile.account_key).toBe(
      'actual-registry-account',
    );
    expect(prepared.snapshot.profile.revision).toBe(profile.revision);
    expect(prepared.snapshot.prompt.generation).toBe(
      semanticMode === 'ECONOMY' ? 1 : 0,
    );
    expect(prepared.snapshot.source.source_artifact_id).toBe(
      source.artifact_id,
    );
    expect((await workerJobs.prepareRun(aiToken, fixtureNow)).run_id).toBe(
      prepared.run_id,
    );
    await expect(
      env.DB.prepare(
        "UPDATE analysis_runs SET prompt_snapshot_json='{}' WHERE run_id=?",
      )
        .bind(prepared.run_id)
        .run(),
    ).rejects.toThrow('IMMUTABLE_RUN_SNAPSHOT');
    expect((await workerJobs.prepareRun(aiToken, fixtureNow)).run_id).toBe(
      prepared.run_id,
    );
    await expect(
      workerJobs.prepareRun(
        { ...aiToken, fencing_token: aiToken.fencing_token + 1 },
        fixtureNow,
      ),
    ).rejects.toThrow('STALE_FENCE');
    expect(
      await env.DB.prepare('SELECT state FROM analysis_runs WHERE run_id=?')
        .bind(prepared.run_id)
        .first('state'),
    ).toBe('CANDIDATE');
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS n FROM quota_reservations',
      ).first('n'),
    ).toBe(0);
    if (longParent) {
      const parentToken = (await aiStore.lease(
        longParent.job_id,
        'ANALYZE',
        fixtureNow,
        'local',
      ))!;
      await aiStore.start(parentToken, 'ANALYZE', fixtureNow);
      const parent = await workerJobs.load(parentToken, fixtureNow);
      const snapshot = parent.snapshot;
      const plan = await createChunkPlan({
        manifest: sourceNormalized.manifest,
        manifest_hash: map.content_hash!,
        context_hash: await economyChunkContextHash({
          manifest_hash: map.content_hash!,
          prompt: snapshot.prompt,
          profile: snapshot.profile,
          profile_revision: parent.snapshot_hash,
          max_output_tokens: snapshot.settings.max_output_tokens,
          limits: snapshot.settings.limits,
          semantic_context: snapshot.semantic_context!,
        }),
        context_tokens: snapshot.profile.context_tokens,
        output_tokens: snapshot.settings.max_output_tokens,
        prompt_overhead_tokens: economyPromptOverhead({
          semantic_profile: snapshot.semantic_profile?.compiled,
          prompt: snapshot.prompt,
          limits: snapshot.settings.limits,
          semantic_context: snapshot.semantic_context!,
        }),
      });
      const partsRepo = new ArtifactRepository(env.DB, aiAccess);
      const text = JSON.stringify(plan.plan),
        bytes = splitArtifactText(text);
      const artifact = await partsRepo.begin(
        {
          item_id: item.item_id,
          kind: 'NORMALIZED',
          schema_version: 'chunk-plan:1',
          producer_version: 'chunk-planner:1',
          original_ref: source.artifact_id,
          provenance: { parent_job_id: longParent.job_id },
          content_hash: plan.plan_hash,
          byte_size: new TextEncoder().encode(text).length,
          chunk_count: bytes.length,
        },
        parentToken,
        'ANALYZE',
        fixtureNow,
      );
      let offset = 0;
      for (const [index, data] of bytes.entries()) {
        await partsRepo.writeChunk(
          artifact.artifact_id,
          index,
          offset,
          data,
          parentToken,
          'ANALYZE',
          fixtureNow,
        );
        offset += data.length;
      }
      await partsRepo.verifyLocal(
        artifact.artifact_id,
        parentToken,
        'ANALYZE',
        fixtureNow,
        'local',
      );
      const batchSizes: number[] = [];
      const long = new LongInputJobs(
        {
          prepare: env.DB.prepare.bind(env.DB),
          batch: (statements) => {
            batchSizes.push(statements.length);
            return (env.DB as Database).batch(statements);
          },
        },
        aiAccess,
      );
      await expect(
        long.create(
          { ...parentToken, fencing_token: parentToken.fencing_token + 1 },
          artifact.artifact_id,
          fixtureNow,
        ),
      ).rejects.toThrow('STALE_FENCE');
      expect(
        await env.DB.prepare(
          "SELECT count(*) AS n FROM config_versions WHERE config_id LIKE 'analysis-chunks-%'",
        ).first('n'),
      ).toBe(0);
      let created = await long.create(
        parentToken,
        artifact.artifact_id,
        fixtureNow,
      );
      if (scenario === 'CHUNKED' || scenario === 'CHUNK_LARGE') {
        expect(plan.plan.chunks.length).toBeGreaterThan(8);
        expect(created).toMatchObject({
          state: 'RUNNING',
          children_created: 8,
          preparation_complete: false,
        });
        const partial = await long.status(parentToken.job_id);
        expect(partial.parts.filter((p) => p.state !== 'MISSING')).toHaveLength(
          8,
        );
        expect(partial.complete).toBe(false);
        while (!created.preparation_complete)
          created = await long.create(
            parentToken,
            artifact.artifact_id,
            fixtureNow,
          );
        expect(Math.max(...batchSizes)).toBeLessThanOrEqual(19);
      }
      expect(created).toMatchObject({
        state: 'DEFERRED',
        expected_chunks: plan.plan.chunks.length,
        preparation_complete: true,
        children_created: plan.plan.chunks.length,
        complete: false,
      });
      const status = await long.status(parentToken.job_id);
      expect(status).toMatchObject({
        complete: false,
        accepted: false,
        missing: plan.plan.chunks.map((c) => c.chunk_index),
      });
      const childNow = new Date(created.due_at);
      const childIndex =
        scenario === 'CHUNKED' || scenario === 'CHUNK_LARGE' ? 1 : 0;
      const childToken = (await aiStore.lease(
        status.parts[childIndex]!.job_id!,
        'ANALYZE',
        childNow,
        'local',
      ))!;
      await aiStore.start(childToken, 'ANALYZE', childNow);
      const child = await workerJobs.prepareRun(childToken, childNow);
      expect(child.snapshot.chunk).toMatchObject({
        parent_job_id: parentToken.job_id,
        plan_hash: plan.plan_hash,
        chunk_index: childIndex,
        parent_snapshot_hash: parent.snapshot_hash,
      });
      expect(child.snapshot.quality_scope).not.toBe(snapshot.quality_scope);
      const compileChild =
        semanticMode === 'FULL'
          ? (input: Parameters<typeof compileEconomy>[0]) =>
              compileSemanticAnalysis({
                ...input,
                semantic_profile: child.snapshot.semantic_profile!.compiled,
              })
          : compileEconomy;
      const compiledChild = await compileChild({
        source_artifact_id: source.artifact_id,
        source_text: sourceText,
        manifest: sourceNormalized.manifest,
        manifest_hash: map.content_hash!,
        prompt: child.snapshot.prompt,
        profile: child.snapshot.profile,
        profile_revision: child.snapshot_hash,
        semantic_context: child.snapshot.semantic_context!,
        runtime: 'local',
        request_id: child.run_id,
        deadline: new Date(fixtureNow.getTime() + 300000).toISOString(),
        mode: child.snapshot.settings.mode,
        max_output_tokens: child.snapshot.settings.max_output_tokens,
        limits: child.snapshot.settings.limits,
        chunk: {
          plan: plan.plan,
          plan_hash: plan.plan_hash,
          chunk_index: childIndex,
          parent_snapshot_hash: parent.snapshot_hash,
        },
      });
      expect(compiledChild.run_context.generation_settings.analysis_mode).toBe(
        'CHUNK',
      );
      await workerJobs.bindContext(
        childToken,
        compiledChild.run_context,
        compiledChild.context_hash,
        await sha256(compiledChild.request.prompt),
        childNow,
      );
      await expect(
        long.create(parentToken, artifact.artifact_id, fixtureNow),
      ).rejects.toThrow('STALE_FENCE');
      expect(
        await env.DB.prepare(
          'SELECT count(*) AS n FROM quota_reservations',
        ).first('n'),
      ).toBe(0);
      if (scenario.startsWith('CHUNK')) {
        const daily = dailyQuotaWindow(childNow, 'America/Los_Angeles');
        for (const bucket of ['RPM', 'RPD', 'INPUT_TPM'] as const) {
          const available = bucket === 'INPUT_TPM' ? 50000 : 5;
          await env.DB.prepare(
            'INSERT INTO quota_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          )
            .bind(
              'chunk-' + bucket,
              'a',
              'gemini',
              profile.model,
              bucket,
              'tokens-or-requests',
              available,
              0,
              available,
              bucket === 'RPD'
                ? daily.reset_at
                : new Date(childNow.getTime() + 60000).toISOString(),
              'America/Los_Angeles',
              'dashboard',
              childNow.toISOString(),
              new Date(childNow.getTime() + 60000).toISOString(),
              'actual',
            )
            .run();
        }
        const policy = JSON.stringify({ RPM: 1, RPD: 1, INPUT_TPM: 100 });
        await env.DB.prepare('INSERT INTO config_versions VALUES(?,?,?,?,?,?)')
          .bind(
            'quota-reserve-gemini_free',
            'a',
            1,
            policy,
            await sha256(policy),
            childNow.toISOString(),
          )
          .run();
        const permit = await workerJobs.reserve(
          childToken,
          {
            request_id: child.run_id,
            input_tokens: compiledChild.request.estimated_input_tokens,
          },
          childNow,
        );
        await workerJobs.submit(
          childToken,
          permit.reservation_id,
          await sha256(compiledChild.request.prompt),
          childNow,
        );
        const raw = JSON.stringify({
          summary_pl: [{ text_pl: 'Sekcja źródła.', segment_refs: ['s1'] }],
          key_points: [],
          entity_mentions: [],
          tools: [],
          claims: [
            {
              text_pl: 'Wypowiedź źródłowa.',
              segment_refs: ['s1'],
              entity_refs: [],
              subject_ref: null,
              attribution: 'SOURCE_SPEAKER',
              qualifiers: [],
            },
          ],
          stance: [],
          predictions: [],
          source_issues: [],
          ...(semanticMode === 'FULL'
            ? {
                usage: [],
                recommendations: [],
                uncertainties: [],
                contradictions: [],
              }
            : {}),
        });
        const responseArtifact = await partsRepo.begin(
          {
            item_id: item.item_id,
            kind: 'ANALYSIS_CANDIDATE',
            schema_version: 'provider-output:1',
            producer_version: 'gemini-response:1:' + permit.reservation_id,
            original_ref: null,
            provenance: {
              reservation_id: permit.reservation_id,
              raw_output_present: true,
              response: {
                request_id: child.run_id,
                status: 'OK',
                actual_provider: 'gemini',
                actual_model: profile.model,
                finish_reason: 'completed',
                usage: {
                  input_tokens: compiledChild.request.estimated_input_tokens,
                  output_tokens: 50,
                  total_tokens:
                    compiledChild.request.estimated_input_tokens + 50,
                },
                retry_after: null,
              },
            },
            content_hash: await sha256(raw),
            byte_size: new TextEncoder().encode(raw).length,
            chunk_count: 1,
          },
          childToken,
          'ANALYZE',
          childNow,
        );
        await partsRepo.writeChunk(
          responseArtifact.artifact_id,
          0,
          0,
          new TextEncoder().encode(raw),
          childToken,
          'ANALYZE',
          childNow,
        );
        await partsRepo.verifyLocal(
          responseArtifact.artifact_id,
          childToken,
          'ANALYZE',
          childNow,
          'local',
        );
        const validator = new AnalysisValidation(env.DB, aiAccess);
        const result = await validator.evaluate(
          childToken,
          permit.reservation_id,
          responseArtifact.artifact_id,
          childNow,
          fixtureSecret,
        );
        expect(result).toMatchObject({
          status: 'VALIDATED',
          accepted: false,
          chunk: { plan_hash: plan.plan_hash, chunk_index: childIndex },
        });
        const canonical = JSON.parse(
          (
            await partsRepo.readVerifiedText(
              result.canonical_artifact_id!,
              2 * 1024 * 1024,
              childToken,
              'ANALYZE',
              childNow,
            )
          ).text,
        );
        const assignedId = plan.plan.chunks[childIndex]!.aliases[0]!.segment_id;
        const assigned = sourceNormalized.manifest.anchors.find(
          (a) => a.segment_id === assignedId,
        )!;
        expect(canonical.evidence[0]).toMatchObject({
          segment_ids: [assignedId],
          quote_original: sourceText.slice(
            assigned.source_start,
            assigned.source_end,
          ),
        });
        await expect(
          validator.finishQualityTest(
            childToken,
            permit.reservation_id,
            responseArtifact.artifact_id,
            childNow,
            fixtureSecret,
          ),
        ).rejects.toThrow('QUALITY_TEST_NOT_FINISHABLE');
        if (chunkProduction)
          await expect(
            validator.complete(
              childToken,
              permit.reservation_id,
              responseArtifact.artifact_id,
              childNow,
              fixtureSecret,
            ),
          ).rejects.toThrow('CHUNK_NOT_ACCEPTABLE');
        await validator.finishChunk(
          childToken,
          permit.reservation_id,
          responseArtifact.artifact_id,
          childNow,
          fixtureSecret,
        );
        await validator.finishChunk(
          childToken,
          permit.reservation_id,
          responseArtifact.artifact_id,
          childNow,
          fixtureSecret,
        );
        const current = await long.status(parentToken.job_id);
        expect(current.complete).toBe(
          scenario !== 'CHUNKED' && scenario !== 'CHUNK_LARGE',
        );
        expect(current.missing).not.toContain(childIndex);
        expect(current.parts[childIndex]!.completed).toBe(true);
        expect(
          await env.DB.prepare('SELECT count(*) AS n FROM observations').first(
            'n',
          ),
        ).toBe(0);
        expect(
          await env.DB.prepare(
            "SELECT count(*) AS n FROM analysis_runs WHERE state='ACCEPTED' AND job_id IN (SELECT job_id FROM jobs WHERE task_type='ANALYZE')",
          ).first('n'),
        ).toBe(0);
        const parentNow = new Date(childNow.getTime() + 60000);
        await sweep(env.DB, parentNow, () => true);
        const resumeToken = (await aiStore.lease(
          parentToken.job_id,
          'ANALYZE',
          parentNow,
          'local',
        ))!;
        await aiStore.start(resumeToken, 'ANALYZE', parentNow);
        const merger = new LongInputCompletion(env.DB, aiAccess);
        await expect(
          merger.complete(
            { ...resumeToken, fencing_token: resumeToken.fencing_token + 1 },
            parentNow,
            fixtureSecret,
          ),
        ).rejects.toThrow('STALE_FENCE');
        if (chunkProduction) {
          const pending = await workerJobs.prepareRun(resumeToken, parentNow);
          await new RunRepository(env.DB, owner).requestSelection(
            pending.run_id,
            item.item_id,
          );
        }
        const merged = await merger.complete(
          resumeToken,
          parentNow,
          fixtureSecret,
        );
        expect(merged).toMatchObject({
          accepted: chunkProduction,
          state:
            scenario === 'CHUNKED' || scenario === 'CHUNK_LARGE'
              ? 'DEFERRED'
              : 'SUCCEEDED',
        });
        if (scenario !== 'CHUNKED' && scenario !== 'CHUNK_LARGE') {
          const parentRun = await env.DB.prepare(
            'SELECT run_id,outcome_json FROM analysis_runs WHERE job_id=? ORDER BY created_at DESC,run_id DESC LIMIT 1',
          )
            .bind(resumeToken.job_id)
            .first<{ run_id: string; outcome_json: string }>();
          const parentOutcome = JSON.parse(parentRun!.outcome_json) as {
            merged_wire_artifact_id: string;
            merged_wire_hash: string;
            context_hash: string;
            additional_synthesis_requests: number;
          };
          const wireArtifact = await new ArtifactRepository(
            env.DB,
            owner,
          ).readVerifiedText(
            parentOutcome.merged_wire_artifact_id,
            2 * 1024 * 1024,
          );
          expect(wireArtifact.artifact.content_hash).toBe(
            parentOutcome.merged_wire_hash,
          );
          expect(wireArtifact.artifact.schema_version).toBe(
            'semantic-wire-merge:1',
          );
          expect(
            JSON.parse(wireArtifact.artifact.provenance_json),
          ).toMatchObject({
            context_hash: parentOutcome.context_hash,
            source_hash: source.content_hash,
          });
          expect(parentOutcome.additional_synthesis_requests).toBe(0);
          if (scenario === 'CHUNK_FULL_PRODUCTION') {
            await models.publish(
              {
                ...profile,
                revision: 4,
                task_types: [...profile.task_types, 'CUSTOM'],
              },
              parentNow,
            );
            await semanticRegistry.save(
              {
                profile_id: 'monitor',
                revision: 3,
                name: 'Validate merged Full',
                config: {
                  ...semanticConfig,
                  mode: 'CUSTOM',
                  validation_pass: {
                    purpose: 'Sprawdź połączone odwołania źródłowe.',
                  },
                },
                reason: 'Explicit post-merge validation',
              },
              bundle,
              parentNow,
            );
            const preview = await analysis.previewExplicit(
              accepted.run_id,
              { ...settings, mode: 'QUALITY_TEST' },
              {
                semantic_profile_id: 'monitor',
                semantic_profile_revision: 3,
                pass: { mode: 'VALIDATE', candidate_run_id: parentRun!.run_id },
              },
              parentNow,
            );
            expect(preview).toMatchObject({
              pass: 'VALIDATE',
              candidate_run_id: parentRun!.run_id,
              additional_model_requests: 1,
              selection_effect: 'NONE_UNTIL_EXPLICIT_SELECTION',
            });
            const count = await env.DB.prepare(
              'SELECT count(*) AS n FROM observations',
            ).first('n');
            const passJob = await analysis.confirmExplicit(
              preview.preview_hash,
              crypto.randomUUID(),
              parentNow,
            );
            const passSnapshot = JSON.parse(
              (await env.DB.prepare(
                'SELECT payload_json FROM jobs WHERE job_id=?',
              )
                .bind(passJob.job_id)
                .first('payload_json')) as string,
            ).snapshot;
            expect(passSnapshot.additional_pass.candidate_hash).toBe(
              parentOutcome.merged_wire_hash,
            );
            expect(passSnapshot.additional_pass.candidate_wire).toEqual(
              JSON.parse(wireArtifact.text),
            );
            expect(
              await env.DB.prepare(
                'SELECT count(*) AS n FROM observations',
              ).first('n'),
            ).toBe(count);
            await semanticRegistry.save(
              {
                profile_id: 'monitor',
                revision: 4,
                name: 'Incompatible subset',
                config: {
                  ...semanticConfig,
                  mode: 'CUSTOM',
                  modules: Object.fromEntries(
                    semanticModules.map((key) => [key, key === 'summary']),
                  ) as SemanticProfile['modules'],
                  validation_pass: {
                    purpose: 'Nie odrzucaj po cichu modułów kandydata.',
                  },
                },
                reason: 'Reject foreign candidate scope',
              },
              bundle,
              parentNow,
            );
            await expect(
              analysis.previewExplicit(
                accepted.run_id,
                { ...settings, mode: 'QUALITY_TEST' },
                {
                  semantic_profile_id: 'monitor',
                  semantic_profile_revision: 4,
                  pass: {
                    mode: 'VALIDATE',
                    candidate_run_id: parentRun!.run_id,
                  },
                },
                parentNow,
              ),
            ).rejects.toThrow('INVALID_ADDITIONAL_PASS_CANDIDATE');
          }
          const replay = await merger.complete(
            resumeToken,
            parentNow,
            fixtureSecret,
          );
          expect(replay).toMatchObject({
            accepted: chunkProduction,
            duplicate: true,
            state: 'SUCCEEDED',
          });
          expect(
            await env.DB.prepare(
              'SELECT count(*) AS n FROM observations',
            ).first('n'),
          ).toBe(chunkProduction ? 1 : 0);
        }
        return;
      }
    }
    if (scenario.startsWith('CHUNK'))
      throw new Error('CHUNK_FIXTURE_PARENT_REQUIRED');
    await expect(
      workerJobs.reserve(
        aiToken,
        { request_id: prepared.run_id, input_tokens: 100 },
        fixtureNow,
      ),
    ).rejects.toThrow('ANALYSIS_CONTEXT_REQUIRED');
    const compileCurrent =
      semanticMode !== 'ECONOMY'
        ? (input: Parameters<typeof compileEconomy>[0]) =>
            compileSemanticAnalysis({
              ...input,
              semantic_profile: prepared.snapshot.semantic_profile!.compiled,
            })
        : compileEconomy;
    const compiled = await compileCurrent({
      source_artifact_id: source.artifact_id,
      source_text: sourceText,
      manifest: sourceNormalized.manifest,
      manifest_hash: map.content_hash!,
      prompt: prepared.snapshot.prompt,
      profile: prepared.snapshot.profile,
      profile_revision: prepared.snapshot_hash,
      semantic_context: prepared.snapshot.semantic_context!,
      runtime: 'local',
      request_id: prepared.run_id,
      deadline: new Date(fixtureNow.getTime() + 300000).toISOString(),
      mode: settings.mode,
      max_output_tokens: settings.max_output_tokens,
      limits: settings.limits,
    });
    const estimate = compiled.request.estimated_input_tokens;
    const contextReceipt = await workerJobs.bindContext(
      aiToken,
      compiled.run_context,
      compiled.context_hash,
      await sha256(compiled.request.prompt),
      fixtureNow,
    );
    expect(
      await workerJobs.bindContext(
        aiToken,
        compiled.run_context,
        compiled.context_hash,
        await sha256(compiled.request.prompt),
        fixtureNow,
      ),
    ).toEqual(contextReceipt);
    await expect(
      workerJobs.bindContext(
        aiToken,
        { ...compiled.run_context, runtime: 'cloud' },
        compiled.context_hash,
        await sha256(compiled.request.prompt),
        fixtureNow,
      ),
    ).rejects.toThrow('INVALID_AI_CONTEXT');
    await expect(
      workerJobs.bindContext(
        aiToken,
        compiled.run_context,
        compiled.context_hash,
        await sha256('changed prompt'),
        fixtureNow,
      ),
    ).rejects.toThrow('ANALYSIS_CONTEXT_CONFLICT');
    await expect(
      workerJobs.reserve(
        aiToken,
        { request_id: prepared.run_id, input_tokens: estimate - 1 },
        fixtureNow,
      ),
    ).rejects.toThrow('INVALID_AI_TOKEN_ESTIMATE');
    await expect(
      workerJobs.reserve(
        aiToken,
        { request_id: prepared.run_id, input_tokens: estimate },
        fixtureNow,
      ),
    ).rejects.toThrow('QUOTA_UNKNOWN_OR_STALE');
    const daily = dailyQuotaWindow(fixtureNow, 'America/Los_Angeles');
    for (const bucket of ['RPM', 'RPD', 'INPUT_TPM'] as const) {
      const remaining = bucket === 'INPUT_TPM' ? 50000 : 2;
      await env.DB.prepare(
        'INSERT INTO quota_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
        .bind(
          'actual-' + bucket,
          'a',
          'gemini',
          profile.model,
          bucket,
          'tokens-or-requests',
          remaining,
          0,
          remaining,
          bucket === 'RPD'
            ? daily.reset_at
            : new Date(fixtureNow.getTime() + 60000).toISOString(),
          'America/Los_Angeles',
          'dashboard',
          fixtureNow.toISOString(),
          new Date(fixtureNow.getTime() + 60000).toISOString(),
          'actual',
        )
        .run();
    }
    const reservePolicy = JSON.stringify({ RPM: 1, RPD: 1, INPUT_TPM: 100 });
    await env.DB.prepare('INSERT INTO config_versions VALUES(?,?,?,?,?,?)')
      .bind(
        'quota-reserve-gemini_free',
        'a',
        1,
        reservePolicy,
        await sha256(reservePolicy),
        fixtureNow.toISOString(),
      )
      .run();
    const permit = await workerJobs.reserve(
      aiToken,
      { request_id: prepared.run_id, input_tokens: estimate },
      fixtureNow,
    );
    expect(
      await env.DB.prepare(
        'SELECT account_key FROM quota_reservations WHERE reservation_id=?',
      )
        .bind(permit.reservation_id)
        .first('account_key'),
    ).toBe(profile.account_key);
    await expect(
      workerJobs.submit(
        aiToken,
        permit.reservation_id,
        await sha256('changed prompt'),
        fixtureNow,
      ),
    ).rejects.toThrow('INVALID_AI_REQUEST_SCOPE');
    expect(
      await workerJobs.submit(
        aiToken,
        permit.reservation_id,
        await sha256(compiled.request.prompt),
        fixtureNow,
      ),
    ).toEqual({ reservation_id: permit.reservation_id });
    await expect(
      workerJobs.submit(
        aiToken,
        permit.reservation_id,
        await sha256(compiled.request.prompt),
        fixtureNow,
      ),
    ).rejects.toThrow('RESERVATION_NOT_SUBMITTABLE');
    await expect(
      workerJobs.reserve(
        aiToken,
        { request_id: 'next-request', input_tokens: 100 },
        fixtureNow,
      ),
    ).rejects.toThrow('INVALID_AI_REQUEST_SCOPE');
    const observationTime = new Date(fixtureNow.getTime() + 1000);
    await new QuotaSnapshots(env.DB, owner).record(
      {
        version: 'gemini-quota-observation:1',
        project: 'different-google-project',
        model: profile.model,
        tier: 'FREE',
        source: 'GOOGLE_CLOUD_QUOTA_CURRENT',
        sampled_at: observationTime.toISOString(),
        buckets: [
          { bucket: 'RPM', limit: 5, used: 0.5 },
          { bucket: 'RPD', limit: 20, used: 0 },
          { bucket: 'INPUT_TPM', limit: 250000, used: 0 },
        ],
      },
      observationTime,
    );
    await expect(
      workerJobs.reserve(
        aiToken,
        { request_id: prepared.run_id, input_tokens: estimate },
        observationTime,
      ),
    ).rejects.toThrow('QUOTA_ACCOUNT_MISMATCH');
    expect(
      await env.DB.prepare(
        "SELECT used_value,remaining FROM quota_snapshots WHERE owner_id=? AND bucket='RPM' ORDER BY sampled_at DESC LIMIT 1",
      )
        .bind('a')
        .first(),
    ).toMatchObject({ used_value: 0.5, remaining: 4 });
    await env.DB.prepare(
      'UPDATE sources SET ai_processing_allowed=0 WHERE owner_id=?',
    )
      .bind('a')
      .run();
    await expect(workerJobs.load(aiToken, fixtureNow)).rejects.toThrow(
      'ANALYSIS_SOURCE_PROCESSING_DENIED',
    );
    await env.DB.prepare(
      'UPDATE sources SET ai_processing_allowed=1 WHERE owner_id=?',
    )
      .bind('a')
      .run();
    const rpcResponse = await worker.fetch(
      new Request('https://fixture.invalid/internal/workers/analysis/input', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + 'z'.repeat(43),
        },
        body: JSON.stringify({ token: aiToken }),
      }),
      { ...env, SESSION_SIGNING_SECRET: fixtureSecret },
      createExecutionContext(),
    );
    expect(rpcResponse.status).toBe(401);
    await env.DB.prepare('UPDATE jobs SET lease_until=? WHERE job_id=?')
      .bind(new Date(Date.now() + 900000).toISOString(), aiToken.job_id)
      .run();
    const callInput = (input: unknown) =>
      worker.fetch(
        new Request('https://fixture.invalid/internal/workers/analysis/input', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + 'q'.repeat(43),
          },
          body: JSON.stringify(input),
        }),
        { ...env, SESSION_SIGNING_SECRET: fixtureSecret },
        createExecutionContext(),
      );
    const inputResponse = await callInput({ token: aiToken });
    expect(inputResponse.status).toBe(200);
    expect(
      (
        (await inputResponse.json()) as {
          snapshot: { profile: PipelineProfile };
        }
      ).snapshot.profile.revision,
    ).toBe(profile.revision);
    expect(
      (await callInput({ token: aiToken, account_key: 'arbitrary-account' }))
        .status,
    ).toBe(422);
    const analysisTransport: typeof fetch = async (input, init) =>
      worker.fetch(
        new Request(input, init),
        { ...env, SESSION_SIGNING_SECRET: fixtureSecret },
        createExecutionContext(),
      );
    const localPrepared = await prepareAnalysis(
      new WorkerRpc(
        'https://fixture.invalid',
        'q'.repeat(43),
        analysisTransport,
      ),
      new ArtifactClient(
        'https://fixture.invalid',
        'q'.repeat(43),
        () => aiToken,
        'ANALYZE',
        analysisTransport,
      ),
      aiToken,
      'local',
      new Date(),
    );
    expect(localPrepared.request.prompt).toContain(sourceText);
    expect(localPrepared.request.prompt).not.toContain(profile.account_key);
    expect(localPrepared.request.request_id).toBe(prepared.run_id);
    expect(localPrepared.manifest.anchors).toHaveLength(1);
    expect(localPrepared.run_context.source_manifest_hash).toBe(
      map.content_hash,
    );
    if (
      scenario !== 'QUALITY_TEST' &&
      scenario !== 'PRODUCTION' &&
      scenario !== 'CUSTOM_PRODUCTION' &&
      scenario !== 'MALFORMED' &&
      !qualityReview
    ) {
      const retained = (await retainAnalysisResponse({
        origin: 'https://fixture.invalid',
        credential: 'q'.repeat(43),
        token: aiToken,
        reservation_id: permit.reservation_id,
        item_id: item.item_id,
        response: {
          request_id: prepared.run_id,
          status: scenario as 'RATE_LIMITED' | 'TEMPORARY_FAILURE' | 'REFUSED',
          raw_output: null,
          actual_provider: 'gemini',
          actual_model: null,
          finish_reason: 'fixture',
          usage: {
            input_tokens: null,
            output_tokens: null,
            total_tokens: null,
          },
          retry_after:
            scenario === 'TEMPORARY_FAILURE'
              ? new Date(Date.now() + 3600000).toISOString()
              : null,
        },
        transport: analysisTransport,
      })) as { artifact_id: string };
      const receipt = (await new WorkerRpc(
        'https://fixture.invalid',
        'q'.repeat(43),
        analysisTransport,
      ).request('analysis/disposition', {
        token: aiToken,
        reservation_id: permit.reservation_id,
        artifact_id: retained.artifact_id,
      })) as { state: string; reason: string; due_at: string };
      const expectedState =
        scenario === 'RATE_LIMITED'
          ? 'DEFERRED'
          : scenario === 'TEMPORARY_FAILURE'
            ? 'RETRY_WAIT'
            : 'BLOCKED';
      expect(receipt).toMatchObject({ accepted: false, state: expectedState });
      if (scenario === 'TEMPORARY_FAILURE')
        expect(Date.parse(receipt.due_at)).toBeGreaterThan(
          Date.now() + 3500000,
        );
      expect(
        await env.DB.prepare('SELECT state FROM jobs WHERE job_id=?')
          .bind(aiToken.job_id)
          .first('state'),
      ).toBe(expectedState);
      expect(
        await env.DB.prepare('SELECT state FROM analysis_runs WHERE run_id=?')
          .bind(prepared.run_id)
          .first('state'),
      ).toBe('CANDIDATE');
      expect(
        await env.DB.prepare('SELECT COUNT(*) n FROM observations').first('n'),
      ).toBe(0);
      expect(
        await env.DB.prepare(
          'SELECT state FROM quota_reservations WHERE reservation_id=?',
        )
          .bind(permit.reservation_id)
          .first('state'),
      ).toBe('UNKNOWN');
      if (scenario === 'RATE_LIMITED') {
        expect(receipt.reason).toBe('AI_RATE_LIMITED');
        expect(Date.parse(receipt.due_at) - Date.now()).toBeGreaterThan(890000);
      }
      return;
    }
    const responseReceipt = (await retainAnalysisResponse({
      origin: 'https://fixture.invalid',
      credential: 'q'.repeat(43),
      token: aiToken,
      reservation_id: permit.reservation_id,
      item_id: item.item_id,
      response: {
        request_id: prepared.run_id,
        status: 'OK',
        raw_output:
          scenario === 'MALFORMED'
            ? '{"summary_pl":'
            : JSON.stringify({
                summary_pl: [
                  {
                    text_pl:
                      scenario === 'QUALITY_REVIEW'
                        ? 'undefined'
                        : scenario === 'QUALITY_NARRATIVE'
                          ? '- Autor przedstawia wypowiedź.'
                          : 'Autor przedstawia wypowiedź.',
                    segment_refs: ['s1'],
                  },
                ],
                key_points: [],
                entity_mentions: [],
                tools: [],
                claims: [
                  {
                    text_pl: 'Autor przedstawia wypowiedź.',
                    segment_refs: ['s1'],
                    entity_refs: [],
                    subject_ref: null,
                    attribution: 'SOURCE_SPEAKER',
                    qualifiers: [],
                  },
                ],
                stance: [],
                predictions: [],
                source_issues: [],
              }),
        actual_provider: 'gemini',
        actual_model: profile.model,
        finish_reason: 'completed',
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        retry_after: null,
      },
      transport: analysisTransport,
    })) as { artifact_id: string };
    const validation = new AnalysisValidation(env.DB, aiAccess);
    if (scenario === 'QUALITY_NARRATIVE') {
      const requestReceipt = await env.DB.prepare(
        'SELECT payload_json FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
      )
        .bind(owner.ownerId, 'analysis-request-' + prepared.run_id)
        .first<{ payload_json: string }>();
      const previousValidatorCache = JSON.stringify({
        version: 'analysis-validation:1',
        run_id: prepared.run_id,
        response_artifact_id: responseReceipt.artifact_id,
        context_hash: JSON.parse(requestReceipt!.payload_json).context_hash,
        mode,
        status: 'VALIDATED',
        reason: null,
        canonical_artifact_id: null,
        canonical_hash: null,
        semantic_verification: 'NOT_ASSERTED',
        accepted: false,
        chunk: null,
      });
      // An old validator's cached structural PASS must not stand in for the
      // current radio checks. This synthetic receipt stays immutable in D1.
      await env.DB.prepare('INSERT INTO config_versions VALUES(?,?,?,?,?,?)')
        .bind(
          'analysis-validation-quality3-' +
            prepared.run_id +
            '-' +
            responseReceipt.artifact_id,
          owner.ownerId,
          1,
          previousValidatorCache,
          await sha256(previousValidatorCache),
          new Date().toISOString(),
        )
        .run();
    }
    const validated = await validation.evaluate(
      aiToken,
      permit.reservation_id,
      responseReceipt.artifact_id,
      new Date(),
      fixtureSecret,
    );
    if (scenario === 'MALFORMED' || qualityReview) {
      expect(validated).toMatchObject({
        status: qualityReview ? 'REVIEW_REQUIRED' : 'INVALID',
        accepted: false,
      });
      if (qualityReview) {
        expect(validated.quality?.findings).toContainEqual({
          code:
            scenario === 'QUALITY_NARRATIVE'
              ? 'NARRATIVE_FORMAT'
              : 'BROKEN_CONTENT',
          module: 'summary_pl',
          index: 0,
        });
        await expect(
          validation.complete(
            aiToken,
            permit.reservation_id,
            responseReceipt.artifact_id,
            new Date(),
            fixtureSecret,
          ),
        ).rejects.toThrow('ANALYSIS_NOT_ACCEPTABLE');
      }
      const rpc = new WorkerRpc(
        'https://fixture.invalid',
        'q'.repeat(43),
        analysisTransport,
      );
      expect(
        await rpc.request('analysis/disposition', {
          token: aiToken,
          reservation_id: permit.reservation_id,
          artifact_id: responseReceipt.artifact_id,
        }),
      ).toMatchObject({
        accepted: false,
        state: 'BLOCKED',
        reason: 'AI_OUTPUT_REVIEW_REQUIRED',
      });
      expect(
        await env.DB.prepare('SELECT COUNT(*) n FROM observations').first('n'),
      ).toBe(0);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) n FROM analysis_runs WHERE job_id=? AND state='ACCEPTED'",
        )
          .bind(aiToken.job_id)
          .first('n'),
      ).toBe(0);
      expect(
        await env.DB.prepare(
          'SELECT state FROM quota_reservations WHERE reservation_id=?',
        )
          .bind(permit.reservation_id)
          .first('state'),
      ).toBe('SETTLED');
      expect(
        await env.DB.prepare('SELECT state FROM analysis_runs WHERE run_id=?')
          .bind(prepared.run_id)
          .first('state'),
      ).toBe('CANDIDATE');
      return;
    }
    expect(validated).toMatchObject({
      status: 'VALIDATED',
      mode,
      accepted: false,
      semantic_verification: 'NOT_ASSERTED',
    });
    expect(
      await new WorkerRpc(
        'https://fixture.invalid',
        'q'.repeat(43),
        analysisTransport,
      ).request('analysis/validate', {
        token: aiToken,
        reservation_id: permit.reservation_id,
        artifact_id: responseReceipt.artifact_id,
      }),
    ).toEqual(validated);
    expect(
      await validation.evaluate(
        aiToken,
        permit.reservation_id,
        responseReceipt.artifact_id,
        new Date(),
        fixtureSecret,
      ),
    ).toEqual(validated);
    expect(
      (
        await new ArtifactClient(
          'https://fixture.invalid',
          'q'.repeat(43),
          () => aiToken,
          'ANALYZE',
          analysisTransport,
        ).readText(validated.canonical_artifact_id!)
      ).artifact.state,
    ).toBe('VERIFIED');
    const canonicalCandidate = await new ArtifactClient(
      'https://fixture.invalid',
      'q'.repeat(43),
      () => aiToken,
      'ANALYZE',
      analysisTransport,
    ).readText(validated.canonical_artifact_id!);
    expect(JSON.parse(canonicalCandidate.text).evidence[0]).toMatchObject({
      quote_original: sourceText,
      start_ms: 0,
      end_ms: 1500,
      timestamp_precision: 'CUE',
    });
    expect(
      await env.DB.prepare('SELECT state FROM analysis_runs WHERE run_id=?')
        .bind(prepared.run_id)
        .first('state'),
    ).toBe('CANDIDATE');
    expect(
      await env.DB.prepare('SELECT COUNT(*) n FROM observations').first('n'),
    ).toBe(0);
    for (const [raw_output, expected] of [
      [
        JSON.stringify({
          summary_pl: [{ text_pl: 'Wypowiedź.', segment_refs: ['s1'] }],
          key_points: [],
          entity_mentions: [],
          tools: [],
          claims: [],
          stance: [],
          predictions: [],
          source_issues: ['unclear speech'],
        }),
        'REVIEW_REQUIRED',
      ],
      ['{"summary_pl":[],"summary_pl":[]}', 'DUPLICATE_JSON_KEY'],
    ]) {
      const retained = (await retainAnalysisResponse({
        origin: 'https://fixture.invalid',
        credential: 'q'.repeat(43),
        token: aiToken,
        reservation_id: permit.reservation_id,
        item_id: item.item_id,
        response: {
          request_id: prepared.run_id,
          status: 'OK',
          raw_output: raw_output!,
          actual_provider: 'gemini',
          actual_model: profile.model,
          finish_reason: 'completed',
          usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
          retry_after: null,
        },
        transport: analysisTransport,
      })) as { artifact_id: string };
      expect(
        await validation.evaluate(
          aiToken,
          permit.reservation_id,
          retained.artifact_id,
          new Date(),
          fixtureSecret,
        ),
      ).toMatchObject({
        accepted: false,
        canonical_artifact_id: null,
        reason: expected,
      });
      if (mode === 'PRODUCTION')
        await expect(
          validation.complete(
            aiToken,
            permit.reservation_id,
            retained.artifact_id,
            new Date(),
            fixtureSecret,
          ),
        ).rejects.toThrow('ANALYSIS_NOT_ACCEPTABLE');
    }
    await expect(
      prepareAnalysis(
        new WorkerRpc(
          'https://fixture.invalid',
          'q'.repeat(43),
          analysisTransport,
        ),
        new ArtifactClient(
          'https://fixture.invalid',
          'q'.repeat(43),
          () => aiToken,
          'ANALYZE',
          analysisTransport,
        ),
        aiToken,
        'cloud',
        new Date(),
      ),
    ).rejects.toThrow('ANALYSIS_JOB_SNAPSHOT_MISMATCH');
    if (mode === 'QUALITY_TEST') {
      await expect(
        validation.complete(
          aiToken,
          permit.reservation_id,
          responseReceipt.artifact_id,
          new Date(),
          fixtureSecret,
        ),
      ).rejects.toThrow('QUALITY_TEST_NOT_ACCEPTABLE');
      const finished = await validation.finishQualityTest(
        aiToken,
        permit.reservation_id,
        responseReceipt.artifact_id,
        new Date(),
        fixtureSecret,
      );
      expect(finished).toMatchObject({ accepted: false, state: 'SUCCEEDED' });
      if (draftTestPreviewHash) {
        await new LabQuotaPolicies(env.DB, owner).save(
          {
            version: 'lab-quota:1',
            account_key: profile.account_key,
            model: profile.model,
            daily_requests: 1,
            normal_headroom: { RPM: 1, RPD: 1, INPUT_TPM: 100 },
          },
          0,
          'Synthetic Lab admission',
          fixtureNow,
        );
        const baseline = await new PromptTests(env.DB, owner).preview(
          {
            prompt_id: semanticSnapshot.compiled.prompt.id,
            version: 2,
            source_run_id: accepted.run_id,
            semantic_profile_id: 'monitor',
            semantic_profile_revision: 1,
            model_revision: profile.revision,
            max_output_tokens: settings.max_output_tokens,
            purpose: settings.purpose,
            region: settings.region,
            limits: settings.limits,
          },
          fixtureNow,
        );
        const draftReceipt = JSON.parse(
          (await env.DB.prepare(
            'SELECT payload_json FROM config_versions WHERE owner_id=? AND config_id=?',
          )
            .bind(owner.ownerId, 'analysis-preview-' + draftTestPreviewHash)
            .first<string>('payload_json'))!,
        ).snapshot;
        const baselineReceipt = JSON.parse(
          (await env.DB.prepare(
            'SELECT payload_json FROM config_versions WHERE owner_id=? AND config_id=?',
          )
            .bind(owner.ownerId, 'analysis-preview-' + baseline.preview_hash)
            .first<string>('payload_json'))!,
        ).snapshot;
        const variant = (id: 'A' | 'B', snapshot: typeof draftReceipt) => ({
          id,
          provider: profile.provider_id,
          model: profile.model,
          model_revision: profile.revision,
          prompt_hash: snapshot.prompt.prompt_hash,
          wire_hash: snapshot.prompt.wire.hash,
          canonical_hash: snapshot.prompt.canonical.hash,
          reasoning: 'low',
          max_output_tokens: settings.max_output_tokens,
          seed: null,
        });
        const lab = new PromptLab(env.DB, owner),
          experiment = await lab.create(
            {
              controls: {
                version: 'lab-controls:1',
                mode: 'PROMPT_AB',
                source_hashes: [draftReceipt.source.source_hash],
                repeats: 1,
                variants: [
                  variant('A', baselineReceipt),
                  variant('B', draftReceipt),
                ],
                confounders: ['SEED_UNAVAILABLE', 'PROVIDER_NONDETERMINISM'],
              },
              pairs: [
                {
                  source_hash: draftReceipt.source.source_hash,
                  repeat: 1,
                  a: { kind: 'ANALYSIS', hash: baseline.preview_hash },
                  b: { kind: 'ANALYSIS', hash: draftTestPreviewHash },
                },
              ],
              reason: 'Actual compiler fixtures, no provider approval',
            },
            fixtureNow,
          );
        const preparedPair = await lab.preparePair(
          {
            prompt_id: semanticSnapshot.compiled.prompt.id,
            version: 2,
            comparison_version: 3,
            source_run_id: accepted.run_id,
            semantic_profile_id: 'monitor',
            semantic_profile_revision: 1,
            model_revision: profile.revision,
            max_output_tokens: settings.max_output_tokens,
            purpose: settings.purpose,
            region: settings.region,
            limits: settings.limits,
            repeats: 3,
            reason: 'Synthetic convenience preparation',
          },
          fixtureNow,
        );
        expect(preparedPair.cases).toHaveLength(6);
        expect(
          preparedPair.controls.variants.map((row) => row.prompt_hash),
        ).toEqual([
          baselineReceipt.prompt.prompt_hash,
          draftReceipt.prompt.prompt_hash,
        ]);
        const labJob = await lab.submit(
          experiment.experiment_hash,
          0,
          fixtureNow,
        );
        expect(
          (
            await lab.submit(
              experiment.experiment_hash,
              0,
              new Date(fixtureNow.getTime() + 900001),
            )
          ).job_id,
        ).toBe(labJob.job_id);
        expect((await lab.get(experiment.experiment_hash)).jobs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              job_id: labJob.job_id,
              case_index: 0,
              state: 'PENDING',
            }),
          ]),
        );
        const labToken = (await aiStore.lease(
          labJob.job_id,
          'ANALYZE',
          fixtureNow,
          'local',
        ))!;
        await aiStore.start(labToken, 'ANALYZE', fixtureNow);
        expect(
          (await new AnalysisJobs(env.DB, aiAccess).load(labToken, fixtureNow))
            .snapshot,
        ).toMatchObject({
          workload: 'PROMPT_LAB',
          lab_experiment_hash: experiment.experiment_hash,
          lab_case_index: 0,
          settings: { mode: 'QUALITY_TEST' },
        });
        await lab.cancel(
          experiment.experiment_hash,
          'Synthetic cancellation without provider calls',
          fixtureNow,
        );
        const queued = await analysis.confirmExplicit(
          draftTestPreviewHash,
          crypto.randomUUID(),
          fixtureNow,
        );
        const draftToken = (await aiStore.lease(
          queued.job_id,
          'ANALYZE',
          fixtureNow,
          'local',
        ))!;
        await aiStore.start(draftToken, 'ANALYZE', fixtureNow);
        const pinned = await new AnalysisJobs(env.DB, aiAccess).load(
          draftToken,
          fixtureNow,
        );
        expect(pinned.snapshot.prompt.version).toBe(3);
        expect(pinned.snapshot.settings.mode).toBe('QUALITY_TEST');
        expect(pinned.snapshot.profile.revision).toBe(profile.revision);
        await new PromptUsage(env.DB, owner).deprecate(
          pinned.snapshot.prompt.prompt_id,
          3,
          pinned.snapshot.prompt.prompt_hash,
          'Fixture withdrawal',
          fixtureNow,
        );
        expect(
          (
            await new AnalysisJobs(env.DB, aiAccess).load(
              draftToken,
              fixtureNow,
            )
          ).snapshot.prompt.prompt_hash,
        ).toBe(pinned.snapshot.prompt.prompt_hash);
        await expect(
          analysis.confirmExplicit(
            draftTestPreviewHash,
            crypto.randomUUID(),
            fixtureNow,
          ),
        ).rejects.toThrow('PROMPT_DEPRECATED');
      }
      expect(
        await validation.finishQualityTest(
          aiToken,
          permit.reservation_id,
          responseReceipt.artifact_id,
          new Date(),
          fixtureSecret,
        ),
      ).toEqual(finished);
      expect(
        await env.DB.prepare('SELECT state FROM analysis_runs WHERE run_id=?')
          .bind(prepared.run_id)
          .first('state'),
      ).toBe('CANDIDATE');
      expect(
        await env.DB.prepare('SELECT COUNT(*) n FROM observations').first('n'),
      ).toBe(0);
    } else {
      await new RunRepository(env.DB, owner).requestSelection(
        prepared.run_id,
        item.item_id,
      );
      await expect(
        validation.complete(
          { ...aiToken, fencing_token: aiToken.fencing_token + 1 },
          permit.reservation_id,
          responseReceipt.artifact_id,
          new Date(),
          fixtureSecret,
        ),
      ).rejects.toThrow();
      let revokedAtCommit = false;
      const raced = new AnalysisValidation(
        {
          prepare: (sql) => env.DB.prepare(sql),
          batch: async (statements) => {
            if (statements.length > 6) {
              revokedAtCommit = true;
              await env.DB.prepare(
                "UPDATE sources SET ai_processing_allowed=0 WHERE owner_id=? AND source_id=(SELECT source_id FROM items WHERE owner_id='a' AND item_id=?)",
              )
                .bind('a', item.item_id)
                .run();
            }
            return env.DB.batch(statements as D1PreparedStatement[]);
          },
        },
        aiAccess,
      );
      await expect(
        raced.complete(
          aiToken,
          permit.reservation_id,
          responseReceipt.artifact_id,
          new Date(),
          fixtureSecret,
        ),
      ).rejects.toThrow('STALE_FENCE');
      expect(revokedAtCommit).toBe(true);
      expect(
        await env.DB.prepare('SELECT state FROM analysis_runs WHERE run_id=?')
          .bind(prepared.run_id)
          .first('state'),
      ).toBe('CANDIDATE');
      expect(
        await env.DB.prepare('SELECT COUNT(*) n FROM observations').first('n'),
      ).toBe(0);
      await env.DB.prepare(
        "UPDATE sources SET ai_processing_allowed=1 WHERE owner_id=? AND source_id=(SELECT source_id FROM items WHERE owner_id='a' AND item_id=?)",
      )
        .bind('a', item.item_id)
        .run();
      expect(
        await validation.complete(
          aiToken,
          permit.reservation_id,
          responseReceipt.artifact_id,
          new Date(),
          fixtureSecret,
        ),
      ).toMatchObject({ accepted: true, active: true, duplicate: false });
      expect(
        await validation.complete(
          aiToken,
          permit.reservation_id,
          responseReceipt.artifact_id,
          new Date(),
          fixtureSecret,
        ),
      ).toMatchObject({ accepted: true, duplicate: true });
      expect(
        await env.DB.prepare('SELECT state FROM jobs WHERE job_id=?')
          .bind(aiToken.job_id)
          .first('state'),
      ).toBe('SUCCEEDED');
      expect(
        await env.DB.prepare(
          'SELECT accepted_run_id FROM active_analysis_selections WHERE owner_id=? AND item_id=?',
        )
          .bind('a', item.item_id)
          .first('accepted_run_id'),
      ).toBe(prepared.run_id);
      const detail = await new DailyProjection(env.DB, owner).detail(
        item.item_id,
      );
      expect(detail.selected_run_id).toBe(prepared.run_id);
      expect(detail.analysis_status).toBe('READY');
      expect(detail.canonical?.content_hash).toBe(validated.canonical_hash);
      const ownerPage = await new ArtifactRepository(
        env.DB,
        owner,
      ).readOwnerPage(detail.canonical!.artifact_id, 0);
      expect(ownerPage.chunks.length).toBeLessThanOrEqual(4);
      expect(ownerPage.next_index).toBeNull();
      const beforeRead = await env.DB.prepare(
        'SELECT (SELECT COUNT(*) FROM jobs) jobs,(SELECT COUNT(*) FROM usage_records) usage,(SELECT COUNT(*) FROM change_log) changes',
      ).first();
      const evidenceRead = await new EvidenceProjection(env.DB, owner).read(
        JSON.parse(canonicalCandidate.text).evidence[0].evidence_id,
        prepared.run_id,
      );
      expect(evidenceRead.quote_hash).toBe(await sha256(sourceText));
      expect(evidenceRead.quote_original).toBe(sourceText);
      expect(evidenceRead.quote_transport).toBe('INLINE_CANONICAL');
      expect(evidenceRead.timestamp_precision).toBe('CUE');
      expect(evidenceRead.helper_available).toBe(false);
      const ledger = new ObservationLedger(env.DB, owner);
      const ledgerPage = await ledger.page({}, 50, fixtureSecret, new Date());
      const canonical = JSON.parse(canonicalCandidate.text);
      expect(ledgerPage.observations.map((row) => row.observation)).toEqual(
        canonical.claims,
      );
      expect(ledgerPage.observations[0]!.run_id).toBe(prepared.run_id);
      expect(
        (await ledger.page({ kind: 'STANCE' }, 50, fixtureSecret, new Date()))
          .observations,
      ).toHaveLength(0);
      expect(
        (
          await ledger.page(
            { source_id: 'foreign-source' },
            50,
            fixtureSecret,
            new Date(),
          )
        ).observations,
      ).toHaveLength(0);
      expect(
        (
          await new ObservationLedger(env.DB, await fixtureOwner('b')).page(
            {},
            50,
            fixtureSecret,
            new Date(),
          )
        ).observations,
      ).toHaveLength(0);
      await expect(
        ledger.page({ kind: 'VERIFIED_FACT' }, 50, fixtureSecret, new Date()),
      ).rejects.toThrow('INVALID_LEDGER_KIND');
      const measurement = await new CapacityCollection(env.DB, owner).page(
        50,
        fixtureSecret,
        new Date(),
      );
      expect(
        measurement.cases.find((row) => row.item_id === item.item_id),
      ).toMatchObject({
        accepted_effect_id: prepared.run_id,
        source_run_id: accepted.run_id,
        source_hash: await sha256(sourceText),
        source_authority: 'CONFIRMED',
      });
      expect(
        measurement.cases.find((row) => row.item_id === item.item_id)!
          .accepted_complete_at,
      ).not.toBeNull();
      expect(
        await env.DB.prepare(
          'SELECT (SELECT COUNT(*) FROM jobs) jobs,(SELECT COUNT(*) FROM usage_records) usage,(SELECT COUNT(*) FROM change_log) changes',
        ).first(),
      ).toEqual(beforeRead);
      await expect(
        new EvidenceProjection(env.DB, await fixtureOwner('b')).read(
          evidenceRead.evidence_id,
          prepared.run_id,
        ),
      ).rejects.toThrow('NOT_FOUND');
      await expect(
        new DailyProjection(env.DB, await fixtureOwner('b')).detail(
          item.item_id,
        ),
      ).rejects.toThrow('NOT_FOUND');
      expect(
        await env.DB.prepare(
          'SELECT COUNT(*) n FROM analysis_evidence WHERE run_id=?',
        )
          .bind(prepared.run_id)
          .first('n'),
      ).toBe(1);
      expect(
        await env.DB.prepare('SELECT COUNT(*) n FROM observations').first('n'),
      ).toBe(1);
    }
    if (scenario === 'CUSTOM_PRODUCTION') {
      await semanticRegistry.save(
        {
          profile_id: 'monitor',
          revision: 3,
          name: 'Explicit passes',
          config: {
            ...semanticConfig,
            second_pass: { purpose: 'Zbadaj negację.' },
            validation_pass: { purpose: 'Sprawdź źródłowe odwołania.' },
          },
          reason: 'Independent pass request',
        },
        bundle,
        fixtureNow,
      );
      const before = (
        await env.DB.prepare('SELECT * FROM active_analysis_selections').all()
      ).results;
      const pendingIntent = {
        nonce: crypto.randomUUID(),
        semantic_profile_id: 'monitor',
        semantic_profile_revision: 1,
        pass: null,
      };
      const pending = await analysis.enqueue(
        accepted.run_id,
        { ...settings, mode: 'QUALITY_TEST' },
        fixtureNow,
        pendingIntent,
      );
      const pendingPayload = await env.DB.prepare(
        'SELECT payload_json FROM jobs WHERE job_id=?',
      )
        .bind(pending.job_id)
        .first('payload_json');
      const replacementPreview = await analysis.previewReplacement(
        pending.job_id,
        'monitor',
        3,
        'Explicit pending profile update',
        fixtureNow,
      );
      expect(replacementPreview).toMatchObject({
        replaces_job_id: pending.job_id,
        semantic_profile_revision: 3,
        quota_status: 'UNKNOWN',
      });
      await expect(
        new AnalysisJobs(env.DB, await fixtureOwner('b')).previewReplacement(
          pending.job_id,
          'monitor',
          3,
          'Foreign owner',
          fixtureNow,
        ),
      ).rejects.toThrow('PENDING_JOB_NOT_REPLACEABLE');
      const replacementNonce = crypto.randomUUID(),
        replacement = await analysis.confirmExplicit(
          replacementPreview.preview_hash,
          replacementNonce,
          fixtureNow,
        );
      expect(replacement.job_id).not.toBe(pending.job_id);
      expect(
        (
          await analysis.confirmExplicit(
            replacementPreview.preview_hash,
            replacementNonce,
            fixtureNow,
          )
        ).job_id,
      ).toBe(replacement.job_id);
      const superseded = await env.DB.prepare(
        'SELECT state,reason_code,payload_json,fencing_token FROM jobs WHERE job_id=?',
      )
        .bind(pending.job_id)
        .first<{
          state: string;
          reason_code: string;
          payload_json: string;
          fencing_token: number;
        }>();
      expect(superseded).toMatchObject({
        state: 'FAILED',
        reason_code: 'PROFILE_SUPERSEDED',
        payload_json: pendingPayload,
        fencing_token: pending.fencing_token + 1,
      });
      expect(
        await new JobStore(env.DB, aiAccess).lease(
          pending.job_id,
          'ANALYZE',
          fixtureNow,
          'local',
        ),
      ).toBeNull();
      await expect(
        new JobStore(env.DB, owner).replay(
          pending.job_id,
          fixtureNow.toISOString(),
          'superseded-replay-denied',
        ),
      ).rejects.toThrow('REPLAY_DENIED');
      expect(
        await env.DB.prepare('SELECT state FROM jobs WHERE job_id=?')
          .bind(pending.job_id)
          .first('state'),
      ).toBe('FAILED');
      await expect(
        env.DB.prepare("UPDATE jobs SET state='PENDING' WHERE job_id=?")
          .bind(pending.job_id)
          .run(),
      ).rejects.toThrow('ILLEGAL_JOB_TRANSITION');
      const race = await analysis.enqueue(
        accepted.run_id,
        { ...settings, mode: 'QUALITY_TEST' },
        fixtureNow,
        { ...pendingIntent, nonce: crypto.randomUUID() },
      );
      const racePreview = await analysis.previewReplacement(
        race.job_id,
        'monitor',
        3,
        'Race test',
        fixtureNow,
      );
      const raceToken = await new JobStore(env.DB, aiAccess).lease(
        race.job_id,
        'ANALYZE',
        fixtureNow,
        'local',
      );
      expect(raceToken).not.toBeNull();
      await expect(
        analysis.confirmExplicit(
          racePreview.preview_hash,
          crypto.randomUUID(),
          fixtureNow,
        ),
      ).rejects.toThrow('PENDING_JOB_CHANGED');
      expect(
        await env.DB.prepare('SELECT state FROM jobs WHERE job_id=?')
          .bind(race.job_id)
          .first('state'),
      ).toBe('LEASED');
      await expect(
        analysis.previewReplacement(
          race.job_id,
          'monitor',
          3,
          'Already leased',
          fixtureNow,
        ),
      ).rejects.toThrow('PENDING_JOB_NOT_REPLACEABLE');
      for (const passMode of ['SECOND_PASS', 'VALIDATE'] as const) {
        const intent = {
          nonce: crypto.randomUUID(),
          semantic_profile_id: 'monitor',
          semantic_profile_revision: 3,
          pass: { mode: passMode, candidate_run_id: prepared.run_id },
        };
        const quality = { ...settings, mode: 'QUALITY_TEST' as const };
        const countBefore = await env.DB.prepare(
          'SELECT count(*) AS n FROM jobs',
        ).first('n');
        const preview = await analysis.previewExplicit(
          accepted.run_id,
          quality,
          intent,
          fixtureNow,
        );
        expect(preview).toMatchObject({
          pass: passMode,
          quota_status: 'UNKNOWN',
          quota_remaining: null,
          selection_effect: 'NONE_UNTIL_EXPLICIT_SELECTION',
        });
        expect(
          await env.DB.prepare('SELECT count(*) AS n FROM jobs').first('n'),
        ).toBe(countBefore);
        await expect(
          new AnalysisJobs(env.DB, await fixtureOwner('b')).confirmExplicit(
            preview.preview_hash,
            intent.nonce,
            fixtureNow,
          ),
        ).rejects.toThrow('READ_SNAPSHOT_CHANGED');
        await expect(
          analysis.confirmExplicit(
            preview.preview_hash,
            intent.nonce,
            new Date(fixtureNow.getTime() + 900001),
          ),
        ).rejects.toThrow('READ_SNAPSHOT_CHANGED');
        const passJob = await analysis.confirmExplicit(
          preview.preview_hash,
          intent.nonce,
          fixtureNow,
        );
        expect(
          (await analysis.enqueue(accepted.run_id, quality, fixtureNow, intent))
            .job_id,
        ).toBe(passJob.job_id);
        await expect(
          analysis.enqueue(
            accepted.run_id,
            { ...quality, max_output_tokens: quality.max_output_tokens + 1 },
            fixtureNow,
            intent,
          ),
        ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
        const passToken = (await new JobStore(env.DB, aiAccess).lease(
          passJob.job_id!,
          'ANALYZE',
          fixtureNow,
          'local',
        ))!;
        await new JobStore(env.DB, aiAccess).start(
          passToken,
          'ANALYZE',
          fixtureNow,
        );
        const passPrepared = await workerJobs.prepareRun(passToken, fixtureNow);
        const passCompiled = await compileSemanticAnalysis({
          source_artifact_id: source.artifact_id,
          source_text: sourceText,
          manifest: sourceNormalized.manifest,
          manifest_hash: map.content_hash!,
          prompt: passPrepared.snapshot.prompt,
          profile: passPrepared.snapshot.profile,
          profile_revision: passPrepared.snapshot_hash,
          semantic_context: passPrepared.snapshot.semantic_context!,
          runtime: 'local',
          request_id: passPrepared.run_id,
          deadline: new Date(fixtureNow.getTime() + 300000).toISOString(),
          mode: 'QUALITY_TEST',
          max_output_tokens: quality.max_output_tokens,
          limits: quality.limits,
          semantic_profile: passPrepared.snapshot.semantic_profile!.compiled,
          additional_pass: passPrepared.snapshot.additional_pass!,
        });
        expect(passCompiled.request.quality_scope).toBe(
          passPrepared.snapshot.quality_scope,
        );
        expect(
          await workerJobs.bindContext(
            passToken,
            passCompiled.run_context,
            passCompiled.context_hash,
            await sha256(passCompiled.request.prompt),
            fixtureNow,
          ),
        ).toMatchObject({ run_id: passPrepared.run_id });
        expect(
          (
            await env.DB.prepare(
              'SELECT * FROM active_analysis_selections',
            ).all()
          ).results,
        ).toEqual(before);
        expect(
          await env.DB.prepare('SELECT count(*) AS n FROM observations').first(
            'n',
          ),
        ).toBe(1);
      }
    }
    await env.DB.prepare(
      'UPDATE worker_identities SET revoked_at=? WHERE worker_id=?',
    )
      .bind(fixtureNow.toISOString(), 'analysis-worker')
      .run();
    await expect(
      mode === 'PRODUCTION'
        ? validation.complete(
            aiToken,
            permit.reservation_id,
            responseReceipt.artifact_id,
            new Date(),
            fixtureSecret,
          )
        : validation.finishQualityTest(
            aiToken,
            permit.reservation_id,
            responseReceipt.artifact_id,
            new Date(),
            fixtureSecret,
          ),
    ).rejects.toThrow('STALE_FENCE');
    await expect(workerJobs.load(aiToken, fixtureNow)).rejects.toThrow(
      'STALE_FENCE',
    );
    if (scenario === 'CUSTOM_PRODUCTION') {
      const replacementRows = (
        await env.DB.prepare(
          "SELECT job_id,state,reason_code,fencing_token,payload_json FROM jobs WHERE reason_code='PROFILE_SUPERSEDED' OR json_type(payload_json,'$.snapshot.replaces_pending') IS NOT NULL ORDER BY job_id",
        ).all()
      ).results;
      const backup = new CoreBackup(env.DB, owner),
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
      await restoreCanonical(env.DB, portable, 'subject-a');
      expect(
        (
          await env.DB.prepare(
            "SELECT job_id,state,reason_code,fencing_token,payload_json FROM jobs WHERE reason_code='PROFILE_SUPERSEDED' OR json_type(payload_json,'$.snapshot.replaces_pending') IS NOT NULL ORDER BY job_id",
          ).all()
        ).results,
      ).toEqual(replacementRows);
      for (const old of replacementRows.filter(
        (r) => r.reason_code === 'PROFILE_SUPERSEDED',
      ))
        await expect(
          env.DB.prepare("UPDATE jobs SET state='PENDING' WHERE job_id=?")
            .bind(old.job_id)
            .run(),
        ).rejects.toThrow('ILLEGAL_JOB_TRANSITION');
    }
  },
  // Includes fenced provider tasks, deterministic recovery and a complete backup/restore.
  15000,
);
it('artifact RPC/client resumes interrupted upload, verifies bounded chunks and restores literal UTF-8 including BOM', async () => {
  const { item, token } = await setup();
  const credential = 'c'.repeat(43);
  await env.DB.prepare(
    'UPDATE worker_identities SET credential_hash=? WHERE worker_id=?',
  )
    .bind(await sha256(credential), 'artifact-worker')
    .run();
  await env.DB.prepare('UPDATE jobs SET lease_until=? WHERE job_id=?')
    .bind(new Date(Date.now() + 900000).toISOString(), token.job_id)
    .run();
  let writes = 0,
    verificationCalls = 0;
  const transport: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    if (new URL(req.url).pathname.endsWith('/write')) {
      writes++;
      if (writes >= 2 && writes <= 4) {
        return new Response('{}', { status: 503 });
      }
    }
    if (new URL(req.url).pathname.endsWith('/verify-step')) verificationCalls++;
    return worker.fetch(
      req,
      { ...env, SESSION_SIGNING_SECRET: fixtureSecret },
      createExecutionContext(),
    );
  };
  const client = new ArtifactClient(
    'https://executor-fixture.invalid',
    credential,
    () => token,
    'FETCH_TRANSCRIPT',
    transport,
    null,
    async () => {},
  );
  const text = '\uFEFF' + 'Raw 😀 e\u0301 literal text.\n'.repeat(4000);
  const descriptor = {
    item_id: item.item_id,
    kind: 'SOURCE_ORIGINAL' as const,
    schema_version: 'source-text:1',
    producer_version: 'fixture',
    provenance: { provider_id: 'fixture', upstream_track_id: 'track' },
    original_ref: null,
  };
  await expect(client.upload(text, descriptor)).rejects.toThrow(
    'ARTIFACT_RPC_FAILED',
  );
  expect(
    await env.DB.prepare('SELECT state FROM artifacts WHERE item_id=?')
      .bind(item.item_id)
      .first('state'),
  ).toBe('UPLOADING');
  const artifact = await client.upload(text, descriptor);
  expect(artifact.state).toBe('VERIFIED');
  expect(verificationCalls).toBe(splitArtifactText(text).length);
  expect(await client.readText(artifact.artifact_id)).toEqual({
    artifact,
    text,
  });
  const ownerPages = new ArtifactRepository(env.DB, await fixtureOwner());
  expect(
    (await ownerPages.readOwnerPage(artifact.artifact_id, 0)).chunks,
  ).toHaveLength(4);
  const pageOne = await ownerPages.readOwnerPage(artifact.artifact_id, 0, 2);
  expect(pageOne.chunks).toHaveLength(2);
  expect(pageOne.next_index).toBe(2);
  expect(
    (await ownerPages.readOwnerPage(artifact.artifact_id, 2, 2)).next_index,
  ).toBeNull();
  await expect(
    ownerPages.readOwnerPage(artifact.artifact_id, 0, 5),
  ).rejects.toThrow('INVALID_ARTIFACT_READ_LIMIT');
  const scoped = new ArtifactRepository(
    env.DB,
    await AccessContext.worker(env.DB, await sha256(credential)),
  );
  expect(
    await scoped.readVerifiedText(
      artifact.artifact_id,
      32 * 1024 * 1024,
      token,
      'FETCH_TRANSCRIPT',
      new Date(),
    ),
  ).toEqual({ artifact, text });
  await expect(
    scoped.readVerifiedText(
      artifact.artifact_id,
      10,
      token,
      'FETCH_TRANSCRIPT',
      new Date(),
    ),
  ).rejects.toThrow('VERIFIED_ARTIFACT_REQUIRED');
  await expect(
    scoped.readVerifiedText(
      artifact.artifact_id,
      0,
      token,
      'FETCH_TRANSCRIPT',
      new Date(),
    ),
  ).rejects.toThrow('INVALID_ARTIFACT_READ_LIMIT');
  await expect(
    scoped.readVerifiedText(
      artifact.artifact_id,
      32 * 1024 * 1024,
      { ...token, fencing_token: token.fencing_token + 1 },
      'FETCH_TRANSCRIPT',
      new Date(),
    ),
  ).rejects.toThrow('NOT_FOUND');
  expect((await client.upload(text, descriptor)).artifact_id).toBe(
    artifact.artifact_id,
  );
  const stale = new ArtifactClient(
    'https://executor-fixture.invalid',
    credential,
    () => ({ ...token, fencing_token: token.fencing_token + 1 }),
    'FETCH_TRANSCRIPT',
    transport,
  );
  await expect(stale.readText(artifact.artifact_id)).rejects.toThrow(
    'ARTIFACT_RPC_FAILED',
  );
  const denied = new ArtifactClient(
    'https://executor-fixture.invalid',
    'd'.repeat(43),
    () => token,
    'FETCH_TRANSCRIPT',
    transport,
  );
  await expect(denied.readText(artifact.artifact_id)).rejects.toThrow(
    'EXECUTOR_AUTH_DENIED',
  );
});
it('bounded server verification resumes with authenticated SHA state and rejects tampering or another fence', async () => {
  const { item, token, repository } = await setup();
  const text = 'e\u0301😀 Raw source.\n'.repeat(5000),
    chunks = splitArtifactText(text);
  const artifact = await repository.begin(
    {
      item_id: item.item_id,
      kind: 'SOURCE_ORIGINAL',
      content_hash: await sha256(text),
      byte_size: new TextEncoder().encode(text).length,
      chunk_count: chunks.length,
      schema_version: 'source:1',
      producer_version: 'fixture',
      provenance: { fixture: true },
      original_ref: null,
    },
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
  );
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    await repository.writeChunk(
      artifact.artifact_id,
      i,
      offset,
      chunks[i]!,
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
    );
    offset += chunks[i]!.length;
  }
  const first = await repository.verifyStep(
    artifact.artifact_id,
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
    fixtureSecret,
  );
  expect(first.complete).toBe(false);
  expect(first.next_index).toBe(1);
  const proof = first.proof!;
  await expect(
    repository.verifyStep(
      artifact.artifact_id,
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
      fixtureSecret,
      proof.slice(0, -2) + 'xx',
    ),
  ).rejects.toThrow('UNAUTHENTICATED');
  await expect(
    repository.verifyStep(
      artifact.artifact_id,
      { ...token, fencing_token: token.fencing_token + 1 },
      'FETCH_TRANSCRIPT',
      fixtureNow,
      fixtureSecret,
      proof,
    ),
  ).rejects.toThrow();
  await expect(
    repository.verifyStep(
      artifact.artifact_id,
      token,
      'FETCH_TRANSCRIPT',
      new Date(fixtureNow.getTime() + 16 * 60000),
      fixtureSecret,
      proof,
    ),
  ).rejects.toThrow();
  expect(
    (
      await repository.get(
        artifact.artifact_id,
        token,
        'FETCH_TRANSCRIPT',
        fixtureNow,
      )
    ).state,
  ).toBe('UPLOADING');
  let state = first;
  while (!state.complete)
    state = await repository.verifyStep(
      artifact.artifact_id,
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
      fixtureSecret,
      state.proof!,
    );
  expect(state.artifact!.state).toBe('VERIFIED');
  const local = await repository.verifyLocal(
    artifact.artifact_id,
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
    'local',
  );
  expect(state.artifact!.manifest_hash).toBe(local.manifest_hash);
  // Retrying the same first step is deterministic; no signed state can mark
  // a different content hash or omit a chunk.
  const replay = await repository.verifyStep(
    artifact.artifact_id,
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
    fixtureSecret,
    proof,
  );
  expect(replay.complete).toBe(chunks.length === 2);
});
it.each(['ECONOMY', 'FULL'] as const)(
  'canonical %s Ledger effects share the fenced acceptance batch, rollback on SQL failure and deduplicate redelivery',
  async (semanticMode) => {
    const { owner, access, token, item, repository } = await setup('ANALYZE');
    const text = 'I did not adopt Tool X.';
    const hash = await sha256(text);
    const artifact = await repository.begin(
      {
        item_id: item.item_id,
        kind: 'SOURCE_ORIGINAL',
        content_hash: hash,
        byte_size: new TextEncoder().encode(text).length,
        chunk_count: 1,
        schema_version: 'source-text:1',
        producer_version: 'fixture',
        provenance: { fixture: true },
        original_ref: null,
      },
      token,
      'ANALYZE',
      fixtureNow,
    );
    await repository.writeChunk(
      artifact.artifact_id,
      0,
      0,
      new TextEncoder().encode(text),
      token,
      'ANALYZE',
      fixtureNow,
    );
    await repository.verifyLocal(
      artifact.artifact_id,
      token,
      'ANALYZE',
      fixtureNow,
      'local',
    );
    const normalized = await normalizeTranscript(
      hash,
      [
        {
          upstream_index: 0,
          text,
          start_ms: 0,
          end_ms: 2000,
          speaker_label: null,
        },
      ],
      'CUE',
    );
    const mapText = JSON.stringify(normalized.manifest);
    const mapArtifact = await repository.begin(
      {
        item_id: item.item_id,
        kind: 'SEGMENT_MAP',
        content_hash: normalized.manifest_hash,
        byte_size: new TextEncoder().encode(mapText).length,
        chunk_count: 1,
        schema_version: 'segment-map:1',
        producer_version: 'source-normalizer:1',
        provenance: { fixture: true },
        original_ref: artifact.artifact_id,
      },
      token,
      'ANALYZE',
      fixtureNow,
    );
    await repository.writeChunk(
      mapArtifact.artifact_id,
      0,
      0,
      new TextEncoder().encode(mapText),
      token,
      'ANALYZE',
      fixtureNow,
    );
    await repository.verifyLocal(
      mapArtifact.artifact_id,
      token,
      'ANALYZE',
      fixtureNow,
      'local',
    );
    const ledger = new IntelligenceLedger(env.DB, access);
    const aliases = await ledger.aliases(token, fixtureNow);
    const claim = {
      text_pl: 'Autor nie wdrożył narzędzia.',
      segment_refs: ['s1'],
      subject_ref: null,
      entity_refs: [0],
      attribution: 'SOURCE_SPEAKER',
      qualifiers: ['negacja'],
    };
    const enrichedInput = {
      raw: JSON.stringify({
        summary_pl: [{ text_pl: 'Próba narzędzia.', segment_refs: ['s1'] }],
        key_points: [],
        entity_mentions: [
          { label: 'Tool X', entity_type: 'TOOL', segment_refs: ['s1'] },
        ],
        tools: [],
        claims: [claim, claim],
        stance: [],
        predictions: [],
        source_issues: [],
        ...(semanticMode === 'FULL'
          ? {
              usage: [{ ...claim, target_ref: 0, stage: 'REJECTED' }],
              recommendations: [],
              uncertainties: [],
              contradictions: [
                {
                  left: { module: 'claims', index: 0 },
                  right: { module: 'usage', index: 0 },
                  explanation_pl: 'Możliwa różnica zakresu wypowiedzi.',
                  qualifiers: ['negacja'],
                },
              ],
            }
          : {}),
      }),
      completion: 'OK' as const,
      run_id: 'ledger-run',
      item_id: item.item_id,
      profile_id: 'ECONOMY',
      profile_revision: 'fixture',
      source: {
        owner_id: 'a',
        source_artifact_id: artifact.artifact_id,
        ...normalized,
        video_url: null,
      },
      approved_aliases: aliases,
    };
    const enriched =
      semanticMode === 'ECONOMY'
        ? await enrichEconomy(enrichedInput)
        : await enrichSemantic(
            enrichedInput,
            await compileSemanticProfile(
              {
                mode: 'FULL',
                modules: Object.fromEntries(
                  semanticModules.map((key) => [key, true]),
                ),
                translation: 'NONE',
                history: false,
                second_pass: null,
                validation_pass: null,
              },
              bundle,
            ),
          );
    const runs = new RunRepository(env.DB, access);
    await runs.prepare('ledger-run', token.job_id, fixtureNow.toISOString());
    const selection = await new RunRepository(env.DB, owner).requestSelection(
      'ledger-run',
      item.item_id,
    );
    if (semanticMode === 'FULL') {
      const malformed = structuredClone(enriched);
      malformed.canonical.contradictions[0]!.relation_refs[0] =
        'foreign-observation';
      malformed.canonical_hash = await sha256(
        JSON.stringify(malformed.canonical),
      );
      await expect(
        ledger.prepare(malformed, 'ledger-run', token, fixtureNow),
      ).rejects.toThrow('INVALID_RELATION_PROJECTION');
    }
    const effects = await ledger.prepare(
      enriched,
      'ledger-run',
      token,
      fixtureNow,
    );
    await expect(
      runs.complete(
        { ...token, fencing_token: token.fencing_token + 1 },
        'ANALYZE',
        'ledger-run',
        enriched.canonical_hash,
        enriched.canonical,
        selection,
        fixtureNow,
        effects,
      ),
    ).rejects.toThrow('STALE_FENCE');
    expect(
      await env.DB.prepare('SELECT COUNT(*) FROM observations').first(
        'COUNT(*)',
      ),
    ).toBe(0);
    await expect(
      runs.complete(
        token,
        'ANALYZE',
        'ledger-run',
        enriched.canonical_hash,
        enriched.canonical,
        selection,
        fixtureNow,
        (guard, bindings) => [
          ...effects(guard, bindings),
          env.DB.prepare('INSERT INTO deliberately_missing_table VALUES(1)'),
        ],
      ),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare('SELECT COUNT(*) FROM observations').first(
        'COUNT(*)',
      ),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT state FROM analysis_runs WHERE run_id='ledger-run'",
      ).first('state'),
    ).toBe('CANDIDATE');
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) FROM outbox WHERE event_key='accepted:ledger-run'",
      ).first('COUNT(*)'),
    ).toBe(0);
    expect(
      await runs.complete(
        token,
        'ANALYZE',
        'ledger-run',
        enriched.canonical_hash,
        enriched.canonical,
        selection,
        fixtureNow,
        effects,
      ),
    ).toMatchObject({ accepted: true, active: true, duplicate: false });
    expect(
      await runs.complete(
        token,
        'ANALYZE',
        'ledger-run',
        enriched.canonical_hash,
        enriched.canonical,
        selection,
        fixtureNow,
        effects,
      ),
    ).toMatchObject({ accepted: true, duplicate: true });
    const rows = await new IntelligenceLedger(env.DB, owner).read('ledger-run');
    expect(rows).toHaveLength(enriched.observation_rows.length);
    const expectedRow = [...enriched.observation_rows].sort((a, b) =>
      a.observation_id.localeCompare(b.observation_id),
    )[0]!;
    expect(JSON.parse(String(rows[0]!.row_json))).toEqual(expectedRow);
    expect(rows[0]!.row_hash).toBe(await sha256(JSON.stringify(expectedRow)));
    expect(
      await new IntelligenceLedger(env.DB, await fixtureOwner('b')).read(
        'ledger-run',
      ),
    ).toEqual([]);
    expect(
      await env.DB.prepare('SELECT COUNT(*) FROM observation_evidence').first(
        'COUNT(*)',
      ),
    ).toBe(enriched.observation_rows.length);
    expect(
      await env.DB.prepare('SELECT COUNT(*) FROM observation_entities').first(
        'COUNT(*)',
      ),
    ).toBe(
      enriched.observation_rows.reduce(
        (total, row) =>
          total +
          row.entity_refs.length +
          Number(row.subject_ref !== null) +
          Number(row.target_ref !== null),
        0,
      ),
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) FROM outbox WHERE event_key='accepted:ledger-run'",
      ).first('COUNT(*)'),
    ).toBe(1);
    await expect(env.DB.prepare('DELETE FROM evidence').run()).rejects.toThrow(
      'IMMUTABLE_EVIDENCE',
    );
    await expect(
      env.DB.prepare('INSERT INTO observation_entities VALUES(?,?,?,?)')
        .bind(
          'b',
          enriched.observation_rows[0]!.observation_id,
          enriched.entity_resolutions[0]!.entity_id,
          'SUBJECT',
        )
        .run(),
    ).rejects.toThrow();
    const backup = new CoreBackup(env.DB, owner),
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
    await restoreCanonical(env.DB, portable, 'subject-a');
    const restoredOwner = await fixtureOwner();
    expect(
      await new IntelligenceLedger(env.DB, restoredOwner).read('ledger-run'),
    ).toEqual(rows);
    await verifyOptionalHistory(
      env.DB,
      restoredOwner,
      item.item_id,
      enriched.canonical,
    );
    const evidenceRow = await env.DB.prepare(
      'SELECT source_hash,quote_hash,source_start,source_end FROM evidence WHERE owner_id=? AND evidence_id=?',
    )
      .bind('a', enriched.canonical.evidence[0]!.evidence_id)
      .first<{
        source_hash: string;
        quote_hash: string;
        source_start: number;
        source_end: number;
      }>();
    const restoredSource = await new ArtifactRepository(
      env.DB,
      restoredOwner,
    ).chunk(artifact.artifact_id, 0);
    const restoredText = new TextDecoder().decode(
      Uint8Array.from(
        atob(
          restoredSource.body_base64.replaceAll('-', '+').replaceAll('_', '/'),
        ),
        (char) => char.charCodeAt(0),
      ),
    );
    expect(await sha256(restoredText)).toBe(evidenceRow!.source_hash);
    expect(
      await sha256(
        restoredText.slice(evidenceRow!.source_start, evidenceRow!.source_end),
      ),
    ).toBe(evidenceRow!.quote_hash);
  },
);
it('repair is admitted once per immutable candidate, never for unknown estimates or stale fences', async () => {
  const { owner, access, token, item, repository } = await setup('ANALYZE');
  const raw = '{"fixture":true,}';
  const artifact = await repository.begin(
    {
      item_id: item.item_id,
      kind: 'ANALYSIS_CANDIDATE',
      content_hash: await sha256(raw),
      byte_size: new TextEncoder().encode(raw).length,
      chunk_count: 1,
      schema_version: 'economy-wire:1.0',
      producer_version: 'fixture',
      provenance: {},
      original_ref: null,
    },
    token,
    'ANALYZE',
    fixtureNow,
  );
  await repository.writeChunk(
    artifact.artifact_id,
    0,
    0,
    new TextEncoder().encode(raw),
    token,
    'ANALYZE',
    fixtureNow,
  );
  await repository.verifyLocal(
    artifact.artifact_id,
    token,
    'ANALYZE',
    fixtureNow,
    'local',
  );
  const attempts = new CandidateRepairAttempts(env.DB, access);
  const input = {
    candidate_artifact_id: artifact.artifact_id,
    request_id: 'repair',
    estimated_repair_tokens: 35,
    estimated_full_retry_tokens: 100,
    error_class: 'FIXTURE_STRUCTURAL',
    measurement_hash: 'a'.repeat(64),
  };
  expect(
    await attempts.claim(
      { ...input, estimated_repair_tokens: null },
      token,
      fixtureNow,
    ),
  ).toBe(false);
  expect(
    await attempts.claim(
      { ...input, estimated_repair_tokens: 36 },
      token,
      fixtureNow,
    ),
  ).toBe(false);
  expect(
    await attempts.claim(
      input,
      { ...token, fencing_token: token.fencing_token + 1 },
      fixtureNow,
    ),
  ).toBe(false);
  const claims = await Promise.all([
    attempts.claim(input, token, fixtureNow),
    attempts.claim({ ...input, request_id: 'redelivery' }, token, fixtureNow),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(
    await attempts.claim({ ...input, request_id: 'third' }, token, fixtureNow),
  ).toBe(false);
  await expect(
    env.DB.prepare('DELETE FROM candidate_repair_attempts').run(),
  ).rejects.toThrow('IMMUTABLE_REPAIR_ATTEMPT');
  const backup = new CoreBackup(env.DB, owner);
  const start = await backup.begin();
  const chunks: BackupChunk[] = [];
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
  await restoreCanonical(env.DB, portable, 'subject-a');
  expect(
    await env.DB.prepare(
      'SELECT COUNT(*) FROM candidate_repair_attempts WHERE candidate_artifact_id=?',
    )
      .bind(artifact.artifact_id)
      .first('COUNT(*)'),
  ).toBe(1);
  // Restore revokes the executor and fences the old attempt; it cannot consume another repair.
  expect(
    await attempts.claim(
      { ...input, request_id: 'after-restore' },
      token,
      new Date(),
    ),
  ).toBe(false);
});
it('caption recovery persists independent counters and derives a durable shared circuit', async () => {
  const { access, token } = await setup(),
    recovery = new TranscriptRecovery(env.DB, access);
  const first = await recovery.outcome(token, 'NO_CAPTIONS', fixtureNow);
  expect(Date.parse(first.due_at) - fixtureNow.getTime()).toBe(3600000);
  await expect(
    recovery.outcome(token, 'NO_CAPTIONS', fixtureNow),
  ).rejects.toThrow('STALE_FENCE');
  const next = new Date(Date.parse(first.due_at));
  await sweep(env.DB, next, () => true);
  const store = new JobStore(env.DB, access),
    token2 = (await store.lease(
      token.job_id,
      'FETCH_TRANSCRIPT',
      next,
      'local',
    ))!;
  await store.start(token2, 'FETCH_TRANSCRIPT', next);
  const second = await recovery.outcome(token2, 'NO_CAPTIONS', next);
  expect(Date.parse(second.due_at) - fixtureNow.getTime()).toBe(36000000);
  await env.DB.prepare(
    'INSERT INTO job_attempts(attempt_id,owner_id,job_id,fencing_token,executor_id,started_at,finished_at,error_code) VALUES(?,?,?,?,?,?,?,?)',
  )
    .bind(
      'parser',
      'a',
      token.job_id,
      999,
      'artifact-worker',
      fixtureNow.toISOString(),
      fixtureNow.toISOString(),
      'LOCAL_YTDLP_PARSER_CHANGED',
    )
    .run();
  await env.DB.prepare(
    'INSERT INTO job_attempts(attempt_id,owner_id,job_id,fencing_token,executor_id,started_at,finished_at,error_code) VALUES(?,?,?,?,?,?,?,?)',
  )
    .bind(
      'ip',
      'a',
      token.job_id,
      1000,
      'artifact-worker',
      next.toISOString(),
      next.toISOString(),
      'LOCAL_YTDLP_IP_BLOCKED',
    )
    .run();
  const later = new Date(next.getTime() + 3600000);
  expect((await recovery.admission(later, 'local')).reason).toBe(
    'LOCAL_YTDLP_PARSER_CHANGED',
  );
  expect(
    (
      await recovery.admission(
        new Date(fixtureNow.getTime() + 21600000),
        'local',
      )
    ).available,
  ).toBe(true);
  expect((await recovery.admission(later, 'cloud')).reason).toBe(
    'LOCAL_EXECUTOR_REQUIRED',
  );
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM job_attempts WHERE error_code='LOCAL_YTDLP_NO_CAPTIONS'",
    ).first('n'),
  ).toBe(2);
});
async function setup(taskType: TaskType = 'FETCH_TRANSCRIPT') {
  const owner = await fixtureOwner(),
    source = (await new SourceRepository(env.DB, owner).upsert(
      {
        namespace: 'youtube',
        external_id: 'UC-fixture',
        canonical_locator: 'https://www.youtube.com/channel/fixture',
        title: 'Fixture',
        uploads_playlist_id: 'UU-fixture',
        handle: null,
      },
      fixtureNow.toISOString(),
    ))!;
  const item = (await new ItemRepository(env.DB, owner).upsert(
    source.source_id,
    {
      namespace: 'youtube',
      external_id: 'artifact001',
      canonical_url: 'https://www.youtube.com/watch?v=artifact001',
      title: 'Fixture',
      item_type: 'video',
      published_at: null,
      publication_provenance: 'unknown',
      availability: 'PUBLIC',
      duration_seconds: 60,
    },
    fixtureNow.toISOString(),
  ))!;
  const credential = await sha256('artifact-worker-fixture');
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'artifact-worker',
      'a',
      credential,
      JSON.stringify([taskType]),
      fixtureNow.toISOString(),
    )
    .run();
  const job = (await new JobStore(env.DB, owner).enqueue(
    {
      item_id: item.item_id,
      source_id: source.source_id,
      task_type: taskType,
      input_revision: 'fixture',
      profile_revision: 'fixture',
      prompt_snapshot_id: null,
      routing_policy_version: 'local-1',
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: '',
      arrival_origin_at: fixtureNow.toISOString(),
      origin_kind: 'NEW',
      payload: {},
      priority: 80,
      due_at: fixtureNow.toISOString(),
    },
    fixtureNow.toISOString(),
  ))!;
  const access = await AccessContext.worker(env.DB, credential),
    store = new JobStore(env.DB, access),
    token = (await store.lease(job.job_id, taskType, fixtureNow, 'local'))!;
  await store.start(token, taskType, fixtureNow);
  return {
    owner,
    access,
    item,
    token,
    repository: new ArtifactRepository(env.DB, access),
  };
}
it('atomic AI reservation has one winner for the last request and cannot resubmit or use stale lease', async () => {
  const { access, token } = await setup('ANALYZE'),
    quota = new QuotaAdmission(env.DB, access);
  const buckets: AdmissionBucket[] = [];
  for (const bucket of ['RPM', 'RPD', 'INPUT_TPM'] as const) {
    const row = {
      snapshot_id: bucket,
      bucket,
      window_start: fixtureNow.toISOString(),
      reset_at: new Date(fixtureNow.getTime() + 3600000).toISOString(),
      remaining: bucket === 'INPUT_TPM' ? 1000 : 1,
      sampled_at: fixtureNow.toISOString(),
      expires_at: new Date(fixtureNow.getTime() + 60000).toISOString(),
      reserve: 0,
    };
    buckets.push(row);
    await env.DB.prepare(
      'INSERT INTO quota_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
      .bind(
        bucket,
        'a',
        'gemini',
        'gemini-3.8-flash',
        bucket,
        bucket === 'INPUT_TPM' ? 'tokens' : 'requests',
        row.remaining,
        0,
        row.remaining,
        row.reset_at,
        'America/Los_Angeles',
        'dashboard',
        row.sampled_at,
        row.expires_at,
        'actual',
      )
      .run();
  }
  const input = {
    account_key: 'fixture-project',
    model: 'gemini-3.8-flash',
    input_tokens: 100,
    buckets,
    paid_services_enabled: false,
  };
  const results = await Promise.allSettled(
    ['first', 'second'].map((request_id) =>
      quota.reserve({ ...input, request_id }, token, fixtureNow),
    ),
  );
  expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
  expect(
    await env.DB.prepare('SELECT COUNT(*) AS n FROM quota_reservations').first(
      'n',
    ),
  ).toBe(1);
  const winner = results.find((row) => row.status === 'fulfilled')!;
  if (winner.status !== 'fulfilled') throw new Error('FIXTURE');
  await quota.submit(winner.value.reservation_id, token, fixtureNow);
  await expect(
    quota.submit(winner.value.reservation_id, token, fixtureNow),
  ).rejects.toThrow('RESERVATION_NOT_SUBMITTABLE');
  await expect(
    quota.reserve(
      { ...input, request_id: 'stale' },
      { ...token, fencing_token: token.fencing_token + 1 },
      fixtureNow,
    ),
  ).rejects.toThrow('QUOTA_ADMISSION_DENIED');
  await expect(
    quota.reserve(
      { ...input, request_id: 'paid', paid_services_enabled: true },
      token,
      fixtureNow,
    ),
  ).rejects.toThrow('PAID_SERVICES_DISABLED_REQUIRED');
  const response = {
    request_id: winner.value.request_id,
    status: 'TEMPORARY_FAILURE' as const,
    raw_output: null,
    actual_provider: 'gemini',
    actual_model: null,
    finish_reason: 'TRANSPORT_FAILURE',
    usage: { input_tokens: null, output_tokens: null, total_tokens: null },
    retry_after: null,
  };
  await quota.reconcile(winner.value.reservation_id, response, fixtureNow);
  await quota.reconcile(winner.value.reservation_id, response, fixtureNow);
  expect(
    await env.DB.prepare(
      'SELECT state FROM quota_reservations WHERE reservation_id=?',
    )
      .bind(winner.value.reservation_id)
      .first('state'),
  ).toBe('UNKNOWN');
  expect(
    await env.DB.prepare(
      'SELECT charged_input_tokens FROM quota_reservations WHERE reservation_id=?',
    )
      .bind(winner.value.reservation_id)
      .first('charged_input_tokens'),
  ).toBe(100);
  await expect(
    quota.reserve({ ...input, request_id: 'after-timeout' }, token, fixtureNow),
  ).rejects.toThrow('QUOTA_ADMISSION_DENIED');
  await expect(
    quota.reconcile(
      winner.value.reservation_id,
      {
        ...response,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
      fixtureNow,
    ),
  ).rejects.toThrow('USAGE_RECONCILIATION_CONFLICT');
});
it('representation binds verified source, immutable selection and current fence', async () => {
  const { access, item, token, repository } = await setup();
  const text = 'Original source',
    bytes = new TextEncoder().encode(text),
    hash = await sha256(text);
  const selection = selectTranscriptLanguage(
    {
      status: 'OK',
      failure_code: null,
      provider_id: 'fixture',
      provider_version: 'fixture-1',
      runtime_id: 'local',
      video_language: 'en',
      retrieved_at: fixtureNow.toISOString(),
      request_id: 'fixture',
      tracks: [
        {
          track_id: 'track',
          item_id: item.item_id,
          language_code: 'en',
          track_kind: 'MANUAL',
          is_generated: false,
          is_translated: false,
          source_language: null,
          translation_source_track_id: null,
          is_translatable: null,
          translation_languages: [],
          is_original: null,
          extension: 'json3',
          expires_at: fixtureNow.toISOString(),
        },
      ],
    },
    hash,
  );
  const artifact = await repository.begin(
    {
      item_id: item.item_id,
      kind: 'SOURCE_ORIGINAL',
      content_hash: hash,
      byte_size: bytes.length,
      chunk_count: 1,
      schema_version: 'source-1',
      producer_version: 'fixture-1',
      provenance: { provider_id: 'fixture', upstream_track_id: 'track' },
      original_ref: null,
    },
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
  );
  const representations = new RepresentationRepository(env.DB, access);
  await expect(
    representations.record(
      artifact.artifact_id,
      selection,
      'SOURCE_AUTHORITY',
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
    ),
  ).rejects.toThrow('INVALID_REPRESENTATION_SOURCE');
  await repository.writeChunk(
    artifact.artifact_id,
    0,
    0,
    bytes,
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
  );
  await repository.verifyLocal(
    artifact.artifact_id,
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
    'local',
  );
  const id = await representations.record(
    artifact.artifact_id,
    selection,
    'SOURCE_AUTHORITY',
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
  );
  expect(
    await representations.record(
      artifact.artifact_id,
      selection,
      'SOURCE_AUTHORITY',
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
    ),
  ).toBe(id);
  expect(
    await representations.record(
      artifact.artifact_id,
      {
        ...selection,
        source: {
          ...selection.source!,
          expires_at: new Date(fixtureNow.getTime() + 600000).toISOString(),
        },
      },
      'SOURCE_AUTHORITY',
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
    ),
  ).toBe(id);
  await expect(
    representations.record(
      artifact.artifact_id,
      { ...selection, source_revision: 'b'.repeat(64) },
      'SOURCE_AUTHORITY',
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
    ),
  ).rejects.toThrow('REPRESENTATION_REVISION_MISMATCH');
  await expect(
    representations.record(
      artifact.artifact_id,
      { ...selection, authority_basis: 'EXPLICIT_ORIGINAL' },
      'SOURCE_AUTHORITY',
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
    ),
  ).rejects.toThrow('REPRESENTATION_CONFLICT');
  await expect(
    representations.record(
      artifact.artifact_id,
      selection,
      'SOURCE_AUTHORITY',
      { ...token, fencing_token: token.fencing_token + 1 },
      'FETCH_TRANSCRIPT',
      fixtureNow,
    ),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM transcript_representations',
    ).first('n'),
  ).toBe(1);
});
it('large Unicode cue is resumable, ordered/hash verified, immutable and portable through canonical restore', async () => {
  const { owner, item, token, repository } = await setup(),
    text = 'e\u0301🦋\n'.repeat(13000),
    chunks = splitArtifactText(text);
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(chunk.byteLength).toBeLessThanOrEqual(artifactChunkBytes);
    expect(() =>
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(chunk),
    ).not.toThrow();
  }
  const descriptor: ArtifactDescriptor = {
    item_id: item.item_id,
    kind: 'SOURCE_ORIGINAL',
    content_hash: await sha256(text),
    byte_size: new TextEncoder().encode(text).byteLength,
    chunk_count: chunks.length,
    schema_version: 'source-text-1',
    producer_version: 'fixture-1',
    provenance: { provider: 'fixture', language: 'unknown' },
    original_ref: null,
  };
  const artifact = await repository.begin(
    descriptor,
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
  );
  await expect(
    repository.verifyLocal(
      artifact.artifact_id,
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
      'local',
    ),
  ).rejects.toThrow('ARTIFACT_CHUNK_MISSING');
  expect(
    (
      await repository.get(
        artifact.artifact_id,
        token,
        'FETCH_TRANSCRIPT',
        fixtureNow,
      )
    ).state,
  ).toBe('UPLOADING');
  let offset = 0;
  for (let index = 0; index < chunks.length; index++) {
    await repository.writeChunk(
      artifact.artifact_id,
      index,
      offset,
      chunks[index]!,
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
    );
    offset += chunks[index]!.length;
  }
  expect(
    (await repository.begin(descriptor, token, 'FETCH_TRANSCRIPT', fixtureNow))
      .artifact_id,
  ).toBe(artifact.artifact_id);
  await expect(
    repository.writeChunk(
      artifact.artifact_id,
      0,
      0,
      new TextEncoder().encode('changed'),
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
    ),
  ).rejects.toThrow('ARTIFACT_CHUNK_CONFLICT');
  const verified = await repository.verifyLocal(
    artifact.artifact_id,
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
    'local',
  );
  expect(verified.state).toBe('VERIFIED');
  expect(verified.manifest_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(
    (
      await repository.verifyLocal(
        artifact.artifact_id,
        token,
        'FETCH_TRANSCRIPT',
        fixtureNow,
        'local',
      )
    ).manifest_hash,
  ).toBe(verified.manifest_hash);
  await expect(
    env.DB.prepare('UPDATE artifacts SET content_hash=? WHERE artifact_id=?')
      .bind('0'.repeat(64), artifact.artifact_id)
      .run(),
  ).rejects.toThrow('IMMUTABLE_ARTIFACT');
  await expect(
    new ArtifactRepository(env.DB, await fixtureOwner('b')).get(
      artifact.artifact_id,
    ),
  ).rejects.toThrow('NOT_FOUND');
  await expect(
    repository.get(
      artifact.artifact_id,
      { ...token, fencing_token: 0 },
      'FETCH_TRANSCRIPT',
      fixtureNow,
    ),
  ).rejects.toThrow('NOT_FOUND');
  const backup = new CoreBackup(env.DB, owner),
    start = await backup.begin(),
    portableChunks: BackupChunk[] = [];
  for (const table of backupTables) {
    let cursor: number | null = 0;
    do {
      const chunk = await backup.chunk(start.backup_id, table, cursor);
      portableChunks.push(chunk);
      cursor = chunk.next_cursor;
    } while (cursor !== null);
  }
  const portable = {
    manifest: await backup.complete(start.backup_id),
    chunks: portableChunks,
  };
  await resetSchema();
  await restoreCanonical(env.DB, portable, 'subject-a');
  const restored = new ArtifactRepository(env.DB, await fixtureOwner());
  expect((await restored.get(artifact.artifact_id)).manifest_hash).toBe(
    verified.manifest_hash,
  );
  let restoredText = '';
  for (let index = 0; index < chunks.length; index++) {
    const row = await restored.chunk(artifact.artifact_id, index);
    restoredText += new TextDecoder().decode(
      Uint8Array.from(
        atob(row.body_base64.replaceAll('-', '+').replaceAll('_', '/')),
        (char) => char.charCodeAt(0),
      ),
    );
  }
  expect(restoredText).toBe(text);
  expect(await sha256(restoredText)).toBe(descriptor.content_hash);
  // Inject physical corruption only in the disposable fixture, bypassing its immutability trigger.
  await env.DB.prepare('DROP TRIGGER artifact_chunks_no_update').run();
  await env.DB.prepare(
    "UPDATE artifact_chunks SET body_base64='YQ' WHERE chunk_index=0",
  ).run();
  await expect(restored.chunk(artifact.artifact_id, 0)).rejects.toThrow(
    'ARTIFACT_CHUNK_CORRUPT',
  );
});
it('empty payload is valid but oversized chunk, bad range, wrong total hash and unverified parent cannot become VERIFIED', async () => {
  const { item, token, repository } = await setup();
  const descriptor: ArtifactDescriptor = {
    item_id: item.item_id,
    kind: 'RAW',
    content_hash: await sha256(''),
    byte_size: 0,
    chunk_count: 1,
    schema_version: 'raw-1',
    producer_version: 'fixture-1',
    provenance: {},
    original_ref: null,
  };
  const empty = await repository.begin(
    descriptor,
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
  );
  await expect(
    repository.begin(
      { ...descriptor, kind: 'NORMALIZED', original_ref: empty.artifact_id },
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
    ),
  ).rejects.toThrow('ARTIFACT_PARENT_NOT_VERIFIED');
  await expect(
    repository.writeChunk(
      empty.artifact_id,
      0,
      0,
      new Uint8Array(artifactChunkBytes + 1),
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
    ),
  ).rejects.toThrow('INVALID_ARTIFACT_CHUNK');
  await repository.writeChunk(
    empty.artifact_id,
    0,
    0,
    new Uint8Array(),
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
  );
  let clockReads = 0;
  await expect(
    repository.verifyLocal(
      empty.artifact_id,
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
      'local',
      () =>
        new Date(fixtureNow.getTime() + (clockReads++ === 0 ? 0 : 16 * 60000)),
    ),
  ).rejects.toThrow('NOT_FOUND');
  expect(
    (
      await repository.get(
        empty.artifact_id,
        token,
        'FETCH_TRANSCRIPT',
        fixtureNow,
      )
    ).state,
  ).toBe('UPLOADING');
  expect(
    (
      await repository.verifyLocal(
        empty.artifact_id,
        token,
        'FETCH_TRANSCRIPT',
        fixtureNow,
        'local',
      )
    ).state,
  ).toBe('VERIFIED');
  const bad = await repository.begin(
    { ...descriptor, byte_size: 1, content_hash: '0'.repeat(64) },
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
  );
  await repository.writeChunk(
    bad.artifact_id,
    0,
    0,
    new Uint8Array([97]),
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
  );
  await expect(
    repository.verifyLocal(
      bad.artifact_id,
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
      'local',
    ),
  ).rejects.toThrow('ARTIFACT_CONTENT_MISMATCH');
});
