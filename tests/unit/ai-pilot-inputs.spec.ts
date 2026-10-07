import { it, expect, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import { enrichEconomy } from '../../packages/core/src/ai/enrichment/canonical.js';
import { enrichSemantic } from '../../packages/core/src/ai/enrichment/canonical.js';
import registryBundle from '../../config/registry/master-bundle.json';
import {
  compileSemanticProfile,
  semanticModules,
  type SemanticProfile,
} from '../../packages/core/src/ai/semantic-profile.js';
import {
  verifyPilotFiles,
  canonicalPilotElements,
} from '../../tools/gates/ai-pilot-inputs.js';
import type {
  PilotFilm,
  PilotScope,
} from '../../tools/gates/ai-pilot-evaluation.js';
const base = resolve('.local/ai-pilot-tests');
const directories: string[] = [];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (
      !resolve(directory).startsWith(base + '\\') &&
      !resolve(directory).startsWith(base + '/')
    )
      throw new Error('INVALID_TEST_CLEANUP');
    rmSync(directory, { recursive: true, force: true });
  }
});
async function files(mode: SemanticProfile['mode'] = 'ECONOMY') {
  const config: SemanticProfile = {
    mode,
    modules: Object.fromEntries(
      semanticModules.map((key, index) => [
        key,
        mode === 'FULL' || (mode === 'CUSTOM' ? key === 'summary' : index < 7),
      ]),
    ) as SemanticProfile['modules'],
    translation: 'NONE',
    history: false,
    second_pass: null,
    validation_pass: null,
  };
  const profile = await compileSemanticProfile(config, registryBundle);
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'case-'));
  directories.push(directory);
  const write = (name: string, text: string) => {
    const path = join(directory, name + '.json');
    writeFileSync(path, text);
    return { path, hash: hash(text) };
  };
  const text = 'I did not adopt Tool X.',
    source = write('source', text);
  const normalized = await normalizeTranscript(
    source.hash,
    [
      {
        upstream_index: 0,
        text,
        start_ms: null,
        end_ms: null,
        speaker_label: null,
      },
    ],
    'NONE',
  );
  const manifest = write('manifest', JSON.stringify(normalized.manifest));
  const wire: Record<string, unknown> = {
    summary_pl: [
      { text_pl: 'Autor nie wdrożył narzędzia.', segment_refs: ['s1'] },
    ],
    key_points: [],
    entity_mentions: [],
    tools: [],
    claims: [],
    stance: [],
    predictions: [],
    source_issues: [],
  };
  if (mode === 'FULL')
    Object.assign(wire, {
      usage: [],
      recommendations: [],
      uncertainties: [],
      contradictions: [],
    });
  if (mode === 'CUSTOM')
    for (const key of Object.keys(wire))
      if (!['summary_pl', 'entity_mentions', 'source_issues'].includes(key))
        delete wire[key];
  if (mode === 'CUSTOM')
    wire.entity_mentions = [
      { label: 'Tool X', entity_type: 'TOOL', segment_refs: ['s1'] },
    ];
  const raw = JSON.stringify(wire);
  const candidate = write('candidate', raw);
  const input = {
    raw,
    completion: 'OK' as const,
    run_id: 'run',
    item_id: 'item',
    profile_id: 'gemini_free',
    profile_revision: '1',
    source: {
      owner_id: 'owner',
      source_artifact_id: 'source',
      source_text: text,
      manifest: normalized.manifest,
      manifest_hash: manifest.hash,
      video_url: 'https://www.youtube.com/watch?v=fixture0001',
    },
    approved_aliases: [],
  };
  const enriched =
    mode === 'ECONOMY'
      ? await enrichEconomy(input)
      : await enrichSemantic(input, profile);
  const canonical = write('canonical', JSON.stringify(enriched.canonical));
  const annotations = write(
    'annotations',
    JSON.stringify({
      source_hash: source.hash,
      manifest_hash: manifest.hash,
      frozen_at: '2026-10-05T00:00:00Z',
      important_claims: [
        {
          claim_id: 'c1',
          statement: 'The speaker did not adopt Tool X.',
          anchors: [
            {
              segment_ids: [normalized.manifest.anchors[0]!.segment_id],
              quote_hash: hash(text),
            },
          ],
        },
      ],
    }),
  );
  const response = write(
    'response',
    JSON.stringify({
      request_id: 'request',
      status: 'OK',
      actual_provider: 'gemini',
      actual_model: 'gemini-3.8-flash',
      raw_output: raw,
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      finish_reason: 'stop',
      retry_after: null,
    }),
  );
  const scope: PilotScope = {
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    prompt_hash: 'a'.repeat(64),
    wire_hash: profile.wire.hash,
    canonical_schema_hash: profile.canonical.hash,
    quality_scope: 'd'.repeat(64),
    enrichment_version: '1.0',
    normalizer_version: 'source-normalizer:1',
    ...(mode === 'ECONOMY' ? {} : { semantic_profile: config }),
  };
  const film: PilotFilm = {
    video_id: 'fixture0001',
    source_hash: source.hash,
    manifest_hash: manifest.hash,
    candidate_hash: candidate.hash,
    canonical_hash: canonical.hash,
    annotations_hash: annotations.hash,
    annotations_frozen_at: '2026-10-05T00:00:00Z',
    provider_started_at: '2026-10-06T00:00:00Z',
    cases: ['NEGATION'],
    canonical_element_ids: canonicalPilotElements(enriched.canonical),
    elements: canonicalPilotElements(enriched.canonical).map((element_id) => ({
      element_id,
      supported: true,
      anchor_valid: true,
      severe_hallucination: false,
    })),
    important_claims: [
      { claim_id: 'c1', matched_element_ids: ['summary_pl:0'] },
    ],
    human: {
      reviewer_id: 'a',
      independent_reviewer_id: 'b',
      reviewed_at: '2026-10-06T01:00:00Z',
      disagreements_resolved: true,
      summary_coverage: true,
      stance_usage: true,
      prediction_qualifiers: true,
      entity_alias_ambiguity: true,
    },
    provider: {
      provenance: 'FIXTURE',
      request_id: 'request',
      response_hash: response.hash,
      quota_snapshot_ids: ['rpm', 'rpd', 'tpm'],
      usage_logged: true,
      input_tokens: 100,
      output_tokens: 50,
      completion: 'OK',
      raw_json_valid: true,
      wire_valid: true,
      canonical_valid: true,
      source_complete: true,
      deterministic_repairs: [],
      ai_repairs: 0,
      latency_ms: 1000,
      cpu_ms: null,
    },
    files: {
      source: source.path,
      manifest: manifest.path,
      candidate: candidate.path,
      canonical: canonical.path,
      annotations: annotations.path,
      response: response.path,
    },
  };
  return { film, scope, enriched, write };
}
it('verifies actual byte hashes, output denominator and exact source anchors; rejects fabricated zero timestamp or changed files', async () => {
  const { film, scope, enriched, write } = await files();
  await expect(verifyPilotFiles(film, scope)).resolves.toBeUndefined();
  const row = enriched.canonical.evidence[0]!;
  row.start_ms = 0;
  const corrupted = write(
    'canonical-corrupted',
    JSON.stringify(enriched.canonical),
  );
  film.files!.canonical = corrupted.path;
  film.canonical_hash = corrupted.hash;
  await expect(verifyPilotFiles(film, scope)).rejects.toThrow(
    'PILOT_FABRICATED_TIME',
  );
  film.files!.source = write('changed-source', 'Edited original.').path;
  await expect(verifyPilotFiles(film, scope)).rejects.toThrow(
    'PILOT_FILE_HASH_MISMATCH',
  );
});
it('retains refusal with null candidate/canonical and frozen missed important claims rather than fabricating output', async () => {
  const { film, scope, write } = await files();
  const response = write(
    'refusal',
    JSON.stringify({
      request_id: 'request',
      status: 'REFUSED',
      actual_provider: 'gemini',
      actual_model: 'gemini-3.8-flash',
      raw_output: null,
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      finish_reason: 'refusal',
      retry_after: null,
    }),
  );
  film.candidate_hash = null;
  film.canonical_hash = null;
  film.files!.candidate = null;
  film.files!.canonical = null;
  film.files!.response = response.path;
  film.provider.response_hash = response.hash;
  film.provider.completion = 'REFUSED';
  film.provider.raw_json_valid = false;
  film.provider.wire_valid = false;
  film.provider.canonical_valid = false;
  film.canonical_element_ids = [];
  film.elements = [];
  film.important_claims[0]!.matched_element_ids = [];
  await expect(verifyPilotFiles(film, scope)).resolves.toBeUndefined();
  film.important_claims = [];
  await expect(verifyPilotFiles(film, scope)).rejects.toThrow(
    'PILOT_ANNOTATIONS_CHANGED',
  );
});
it.each(['FULL', 'CUSTOM'] as const)(
  'verifies %s with the captured materialized schema, not Economy validation',
  async (mode) => {
    const { film, scope } = await files(mode);
    await expect(verifyPilotFiles(film, scope)).resolves.toBeUndefined();
    const withoutScope = { ...scope };
    delete withoutScope.semantic_profile;
    await expect(verifyPilotFiles(film, withoutScope)).rejects.toThrow(
      'PILOT_SCHEMA_SCOPE_MISMATCH',
    );
    await expect(
      verifyPilotFiles(film, {
        ...scope,
        canonical_schema_hash: 'f'.repeat(64),
      }),
    ).rejects.toThrow('PILOT_SCHEMA_SCOPE_MISMATCH');
  },
);
it('rejects canonical modules outside Custom scope and additional passes without actual receipts', async () => {
  const { film, scope, enriched, write } = await files('CUSTOM');
  expect(scope.semantic_profile!.modules.entities).toBe(false);
  expect(enriched.canonical.entities).toHaveLength(1);
  await expect(verifyPilotFiles(film, scope)).resolves.toBeUndefined();
  enriched.canonical.key_points = enriched.canonical.summary_pl;
  const changed = write('foreign-module', JSON.stringify(enriched.canonical));
  film.files!.canonical = changed.path;
  film.canonical_hash = changed.hash;
  film.canonical_element_ids = canonicalPilotElements(enriched.canonical);
  await expect(verifyPilotFiles(film, scope)).rejects.toThrow(
    'PILOT_CANONICAL_SCOPE_MISMATCH',
  );
  scope.semantic_profile!.second_pass = { purpose: 'Additional reasoning' };
  await expect(verifyPilotFiles(film, scope)).rejects.toThrow(
    'PILOT_PASS_RECEIPTS_REQUIRED',
  );
});
it('requires canonical wire identity and enabled modules to match the frozen profile', async () => {
  const { film, scope, enriched, write } = await files('FULL');
  enriched.canonical.enabled_modules = ['summary'];
  const changed = write('changed-scope', JSON.stringify(enriched.canonical));
  film.files!.canonical = changed.path;
  film.canonical_hash = changed.hash;
  await expect(verifyPilotFiles(film, scope)).rejects.toThrow(
    'PILOT_CANONICAL_SCOPE_MISMATCH',
  );
});
it('does not certify a claimed repair chain or a successful response without actual model identity', async () => {
  const { film, scope, write } = await files();
  film.provider.ai_repairs = 1;
  await expect(verifyPilotFiles(film, scope)).rejects.toThrow(
    'PILOT_REPAIR_RECEIPTS_REQUIRED',
  );
  film.provider.ai_repairs = 0;
  const response = JSON.parse(readFileSync(film.files!.response, 'utf8'));
  response.actual_model = null;
  const changed = write('unknown-model', JSON.stringify(response));
  film.files!.response = changed.path;
  film.provider.response_hash = changed.hash;
  await expect(verifyPilotFiles(film, scope)).rejects.toThrow(
    'PILOT_RESPONSE_MISMATCH',
  );
});
