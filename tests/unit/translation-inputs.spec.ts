import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import { translationPlan } from '../../packages/core/src/ai/tasks/translation.js';
import { compileTranslation } from '../../packages/core/src/ai/tasks/compiler.js';
import type { PromptSnapshot } from '../../packages/core/src/registry/store.js';
import type {
  PipelineProfile,
  AIResponse,
} from '../../packages/contracts/src/ai.js';
import bundle from '../../config/registry/master-bundle.json';
import { verifyTranslationFiles } from '../../tools/gates/translation-inputs.js';
import type { TranslationTrial } from '../../tools/gates/translation-evaluation.js';
import type { LabVariant } from '../../packages/core/src/registry/lab.js';
async function fixture(directory: string) {
  const text = 'I did not use Tool X at 12%.';
  const normalized = await normalizeTranscript(
    await sha256(text),
    [
      {
        upstream_index: 0,
        text,
        start_ms: 1000,
        end_ms: 2000,
        speaker_label: null,
      },
    ],
    'CUE',
  );
  const source = {
    owner_id: 'fixture-owner',
    source_artifact_id: 'fixture-source',
    source_language: 'en',
    video_url: null,
    ...normalized,
  };
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
    generation: 0,
  };
  const profile: PipelineProfile = {
    profile_id: 'gemini_free',
    revision: 1,
    provider_id: 'gemini',
    model: 'gemini-3.8-flash',
    account_key: 'fixture-account',
    free_eligible: true,
    billing_enabled: false,
    purposes: ['professional_single_owner'],
    regions: ['PL'],
    task_types: ['TRANSLATE'],
    runtimes: ['local'],
    structured_output: true,
    context_tokens: 100000,
    output_tokens: 8192,
    rank: 1,
    quality_approvals: [],
    eligibility_expires_at: '2026-10-08T00:00:00Z',
  };
  const started_at = '2026-10-07T10:00:00Z';
  const compiled = await compileTranslation({
    prompt,
    profile,
    runtime: 'local',
    mode: 'QUALITY_TEST',
    purpose: 'professional_single_owner',
    region: 'PL',
    max_output_tokens: 1024,
    request_id: 'fixture-request',
    deadline: '2026-10-07T10:05:00Z',
    now: new Date(started_at),
    plan: await translationPlan(source, 'FULL'),
    glossary: [],
  });
  const response: AIResponse = {
    request_id: 'fixture-request',
    status: 'OK',
    raw_output: JSON.stringify({
      status: 'OK',
      translated_segments: [
        {
          segment_ref: 's1',
          text_pl: 'Nie używałem Tool X przy 12%.',
          issues: [],
        },
      ],
      limitations_pl: [],
    }),
    actual_provider: 'gemini',
    actual_model: profile.model,
    finish_reason: 'STOP',
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    retry_after: null,
  };
  const files = {
    source: join(directory, 'source.json'),
    request: join(directory, 'request.json'),
    response: join(directory, 'response.json'),
    annotations: join(directory, 'annotations.json'),
  };
  const write = async (path: string, value: unknown) => {
    const raw = JSON.stringify(value);
    writeFileSync(path, raw);
    return sha256(raw);
  };
  await write(files.source, source);
  const request_hash = await write(files.request, {
    request: compiled.request,
    prompt_snapshot: prompt,
    purpose: 'professional_single_owner',
    region: 'PL',
  });
  const response_hash = await write(files.response, response);
  const annotations_hash = await write(files.annotations, {
    source_hash: normalized.manifest.source_text_hash,
    response_hash,
    ratings: [],
  });
  const trial: TranslationTrial = {
    source_hash: normalized.manifest.source_text_hash,
    variant: 'A',
    repeat: 1,
    request_hash,
    response_hash,
    request_id: 'fixture-request',
    provenance: 'FIXTURE',
    started_at,
    latency_ms: 100,
    ai_repairs: 0,
    quota_snapshot_ids: ['rpm', 'rpd', 'tpm'],
    ratings: [],
    files,
    annotations_hash,
  };
  const variant: LabVariant = {
    id: 'A',
    provider: 'gemini',
    model: profile.model,
    model_revision: 1,
    prompt_hash: prompt.prompt_hash,
    wire_hash: prompt.wire.hash,
    canonical_hash: prompt.canonical.hash,
    reasoning: 'low',
    max_output_tokens: 1024,
    seed: null,
  };
  return { trial, variant, response, source, compiled, prompt, write };
}
it('recompiles exact source/template/profile request and measures actual mapped bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bi-translation-'));
  try {
    const { trial, variant } = await fixture(directory);
    expect(await verifyTranslationFiles(trial, variant)).toMatchObject({
      raw_valid: true,
      mapped_valid: true,
      complete: true,
      input_tokens: 100,
      output_tokens: 50,
      missing_segments: 0,
      duplicate_segments: false,
    });
    trial.ratings = [
      {
        reviewer_id: 'invented',
        blind_label: 'sample',
        reviewed_at: '2026-10-07T11:00:00Z',
        scores: [4, 4, 4, 4],
        critical_errors: [],
      },
    ];
    await expect(verifyTranslationFiles(trial, variant)).rejects.toThrow(
      'TRANSLATION_ANNOTATIONS_CHANGED',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it('rejects tampered source/request even when an attacker recomputes file hashes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bi-translation-'));
  try {
    const { trial, variant, compiled, prompt, write, source } =
      await fixture(directory);
    compiled.request.prompt += ' fabricated input';
    trial.request_hash = await write(trial.files.request, {
      request: compiled.request,
      prompt_snapshot: prompt,
      purpose: 'professional_single_owner',
      region: 'PL',
    });
    await expect(verifyTranslationFiles(trial, variant)).rejects.toThrow(
      'TRANSLATION_COMPILED_REQUEST_MISMATCH',
    );
    source.source_text += ' changed';
    await write(trial.files.source, source);
    await expect(verifyTranslationFiles(trial, variant)).rejects.toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it('retains invalid, duplicate, refusal and unknown-usage outputs as measured failures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bi-translation-'));
  try {
    const { trial, variant, response, write } = await fixture(directory);
    response.raw_output = JSON.stringify({
      status: 'OK',
      translated_segments: Array(2).fill({
        segment_ref: 's1',
        text_pl: 'x',
        issues: [],
      }),
      limitations_pl: [],
    });
    response.usage = {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
    };
    trial.response_hash = await write(trial.files.response, response);
    trial.annotations_hash = await write(trial.files.annotations, {
      source_hash: trial.source_hash,
      response_hash: trial.response_hash,
      ratings: [],
    });
    expect(await verifyTranslationFiles(trial, variant)).toMatchObject({
      raw_valid: true,
      mapped_valid: false,
      complete: false,
      duplicate_segments: true,
      input_tokens: null,
    });
    response.status = 'REFUSED';
    response.raw_output = null;
    trial.response_hash = await write(trial.files.response, response);
    trial.annotations_hash = await write(trial.files.annotations, {
      source_hash: trial.source_hash,
      response_hash: trial.response_hash,
      ratings: [],
    });
    expect(await verifyTranslationFiles(trial, variant)).toMatchObject({
      raw_valid: false,
      mapped_valid: false,
      wire_bytes: 0,
      canonical_bytes: null,
      missing_segments: null,
    });
    trial.ai_repairs = 1;
    await expect(verifyTranslationFiles(trial, variant)).rejects.toThrow(
      'TRANSLATION_REPAIR_RECEIPT_REQUIRED',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
