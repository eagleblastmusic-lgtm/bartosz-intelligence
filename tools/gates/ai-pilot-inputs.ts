import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { PilotFilm, PilotScope } from './ai-pilot-evaluation.js';
import type { AIResponse } from '../../packages/contracts/src/ai.js';
import { strictJson } from '../../packages/core/src/ai/repair/strict-json.js';
import {
  validateCanonical,
  validateSemanticCandidate,
} from '../../packages/core/src/ai/repair/validate.js';
import registryBundle from '../../config/registry/master-bundle.json';
import {
  compileSemanticProfile,
  semanticModules,
} from '../../packages/core/src/ai/semantic-profile.js';
import type { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
type Manifest = Awaited<ReturnType<typeof normalizeTranscript>>['manifest'];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export function canonicalPilotElements(canonical: Record<string, unknown>) {
  return [
    'summary_pl',
    'key_points',
    'entities',
    'tools',
    'claims',
    'stance',
    'usage',
    'predictions',
    'recommendations',
    'uncertainties',
    'contradictions',
  ].flatMap((module) => {
    const rows = canonical[module];
    return Array.isArray(rows)
      ? rows.map((_, index) => module + ':' + index)
      : [];
  });
}
export async function verifyPilotFiles(film: PilotFilm, scope: PilotScope) {
  if (!film.files) throw new Error('REAL_PILOT_FILES_REQUIRED');
  // Legacy Stage 03 materials are Economy; other modes must capture their scope.
  const profile = await compileSemanticProfile(
    scope.semantic_profile ?? {
      mode: 'ECONOMY',
      modules: Object.fromEntries(
        semanticModules.map((key, index) => [key, index < 7]),
      ),
      translation: 'NONE',
      history: false,
      second_pass: null,
      validation_pass: null,
    },
    registryBundle,
  );
  if (
    scope.wire_hash !== profile.wire.hash ||
    scope.canonical_schema_hash !== profile.canonical.hash ||
    scope.enrichment_version !== profile.enrichment_version
  )
    throw new Error('PILOT_SCHEMA_SCOPE_MISMATCH');
  if (profile.config.second_pass || profile.config.validation_pass)
    throw new Error('PILOT_PASS_RECEIPTS_REQUIRED');
  if (film.provider.ai_repairs !== 0)
    throw new Error('PILOT_REPAIR_RECEIPTS_REQUIRED');
  const read = (
    kind: keyof NonNullable<PilotFilm['files']>,
    expected: string | null,
  ) => {
    const path = film.files![kind];
    if (expected === null) {
      if (path !== null) throw new Error('PILOT_UNEXPECTED_OUTPUT_FILE');
      return null;
    }
    if (!path) throw new Error('PILOT_OUTPUT_FILE_REQUIRED');
    if (statSync(path).size > 8 * 1024 * 1024)
      throw new Error('PILOT_FILE_TOO_LARGE');
    const text = readFileSync(path, 'utf8');
    if (hash(text) !== expected) throw new Error('PILOT_FILE_HASH_MISMATCH');
    return text;
  };
  const source = read('source', film.source_hash)!,
    manifest = strictJson(
      read('manifest', film.manifest_hash)!,
    ) as unknown as Manifest;
  const candidate = read('candidate', film.candidate_hash),
    canonicalText = read('canonical', film.canonical_hash);
  const annotations = strictJson(
    read('annotations', film.annotations_hash)!,
  ) as {
    important_claims: {
      claim_id: string;
      statement: string;
      anchors: { segment_ids: string[]; quote_hash: string }[];
    }[];
    frozen_at: string;
    source_hash: string;
    manifest_hash: string;
  };
  const response = strictJson(
    read('response', film.provider.response_hash)!,
  ) as unknown as AIResponse;
  if (
    annotations.source_hash !== film.source_hash ||
    annotations.manifest_hash !== film.manifest_hash ||
    annotations.frozen_at !== film.annotations_frozen_at ||
    JSON.stringify(
      annotations.important_claims.map(({ claim_id }) => claim_id),
    ) !== JSON.stringify(film.important_claims.map(({ claim_id }) => claim_id))
  )
    throw new Error('PILOT_ANNOTATIONS_CHANGED');
  if (
    response.request_id !== film.provider.request_id ||
    response.actual_provider !== scope.provider ||
    (response.status === 'OK' && response.actual_model === null) ||
    (response.actual_model !== null && response.actual_model !== scope.model) ||
    response.raw_output !== candidate ||
    response.status !== film.provider.completion ||
    response.usage.input_tokens !== film.provider.input_tokens ||
    response.usage.output_tokens !== film.provider.output_tokens
  )
    throw new Error('PILOT_RESPONSE_MISMATCH');
  if (
    !manifest.complete ||
    manifest.source_text_hash !== hash(source) ||
    manifest.source_revision !== hash(source) ||
    manifest.normalizer_version !== scope.normalizer_version
  )
    throw new Error('INVALID_PILOT_SOURCE');
  for (const claim of annotations.important_claims) {
    if (
      typeof claim.statement !== 'string' ||
      !claim.statement.trim() ||
      !Array.isArray(claim.anchors) ||
      !claim.anchors.length
    )
      throw new Error('PILOT_UNGROUNDED_HUMAN_CLAIM');
    for (const anchor of claim.anchors) {
      const indices = anchor.segment_ids.map((id) =>
        manifest.anchors.findIndex((segment) => segment.segment_id === id),
      );
      if (
        !indices.length ||
        indices.some(
          (index, i) => index < 0 || (i > 0 && index !== indices[i - 1]! + 1),
        )
      )
        throw new Error('PILOT_UNGROUNDED_HUMAN_CLAIM');
      if (
        hash(
          source.slice(
            manifest.anchors[indices[0]!]!.source_start,
            manifest.anchors[indices.at(-1)!]!.source_end,
          ),
        ) !== anchor.quote_hash
      )
        throw new Error('PILOT_UNGROUNDED_HUMAN_CLAIM');
    }
  }
  let rawValid = false,
    wireValid = false,
    repairs: string[] = [];
  if (candidate !== null) {
    try {
      strictJson(candidate);
      rawValid = true;
    } catch {
      /* Invalid actual output stays in the failure denominator. */
    }
    try {
      const validated = await validateSemanticCandidate(
        candidate,
        response.status === 'REFUSED'
          ? 'REFUSED'
          : response.status === 'OK'
            ? 'OK'
            : 'INCOMPLETE',
        new Set(manifest.anchors.map((anchor) => anchor.alias)),
        profile,
      );
      wireValid = validated.valid;
      repairs = validated.report.applied;
    } catch {
      /* Refusal/truncation/parse failure is preserved, not replaced by a fixture. */
    }
  }
  if (
    film.provider.raw_json_valid !== rawValid ||
    film.provider.wire_valid !== wireValid ||
    JSON.stringify(film.provider.deterministic_repairs) !==
      JSON.stringify(repairs) ||
    film.provider.source_complete !== manifest.complete
  )
    throw new Error('PILOT_VALIDATION_REPORT_MISMATCH');
  const canonical =
    canonicalText === null
      ? null
      : (strictJson(canonicalText) as Record<string, unknown>);
  if (
    film.provider.canonical_valid !==
    (canonical !== null && validateCanonical(canonical))
  )
    throw new Error('PILOT_CANONICAL_VALIDATION_MISMATCH');
  if (
    JSON.stringify(canonical ? canonicalPilotElements(canonical) : []) !==
    JSON.stringify(film.canonical_element_ids)
  )
    throw new Error('PILOT_OUTPUT_DENOMINATOR_CHANGED');
  if (!canonical || !validateCanonical(canonical)) return;
  for (const module of semanticModules) {
    const key = module === 'summary' ? 'summary_pl' : module;
    if (!profile.config.modules[module] && (canonical[key] as unknown[]).length)
      throw new Error('PILOT_CANONICAL_SCOPE_MISMATCH');
  }
  const anchors = new Map(
    manifest.anchors.map((anchor) => [anchor.segment_id, anchor]),
  );
  for (const row of canonical.evidence as {
    source_hash: string;
    segment_ids: string[];
    quote_original: string;
    quote_hash: string;
    start_ms: number | null;
    end_ms: number | null;
    timestamp_precision: string;
    timestamp_url: string | null;
  }[]) {
    const selected = row.segment_ids.map((id) => anchors.get(id));
    if (!selected.length || selected.some((anchor) => !anchor))
      throw new Error('PILOT_FOREIGN_ANCHOR');
    const first = selected[0]!,
      last = selected.at(-1)!;
    if (
      row.source_hash !== film.source_hash ||
      row.quote_original !==
        source.slice(first.source_start, last.source_end) ||
      hash(row.quote_original) !== row.quote_hash
    )
      throw new Error('PILOT_QUOTE_HASH_MISMATCH');
    const indices = selected.map((anchor) => manifest.anchors.indexOf(anchor!));
    if (indices.some((index, i) => i > 0 && index !== indices[i - 1]! + 1))
      throw new Error('PILOT_DISCONTIGUOUS_EVIDENCE');
    const timed = selected.every(
      (anchor) =>
        anchor!.start_ms !== null &&
        anchor!.end_ms !== null &&
        anchor!.timestamp_precision !== 'NONE',
    );
    const start = timed
        ? Math.min(...selected.map((anchor) => anchor!.start_ms!))
        : null,
      end = timed
        ? Math.max(...selected.map((anchor) => anchor!.end_ms!))
        : null;
    const precision = !timed
      ? 'NONE'
      : selected.some((anchor) => anchor!.timestamp_precision === 'ESTIMATED')
        ? 'ESTIMATED'
        : selected.some((anchor) => anchor!.timestamp_precision === 'CUE')
          ? 'CUE'
          : 'WORD';
    const url =
      start === null
        ? null
        : 'https://www.youtube.com/watch?v=' +
          film.video_id +
          '&t=' +
          Math.floor(start / 1000) +
          's';
    if (
      row.start_ms !== start ||
      row.end_ms !== end ||
      row.timestamp_precision !== precision ||
      row.timestamp_url !== url
    )
      throw new Error('PILOT_FABRICATED_TIME');
  }
}
