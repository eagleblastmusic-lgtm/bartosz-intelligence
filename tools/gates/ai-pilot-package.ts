import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { renderAnnotationSheet } from './ai-pilot-annotation.js';

const root = resolve('.local/ai-pilot');
const output = resolve(root, 'cp-3.13-selected');
const folders = ['cp-3.13', 'cp-3.13-supplement'];
const pool: {
  video_id: string;
  status: string;
  folder: string;
  source_hash?: string;
  manifest_hash?: string;
  authority_confidence?: string;
}[] = [];
for (const directory of folders) {
  const packageFile = JSON.parse(
    readFileSync(resolve(root, directory, 'package.json'), 'utf8'),
  ) as { films: { video_id: string }[] };
  for (const film of packageFile.films) {
    const folder = resolve(root, directory, film.video_id);
    const receipt = JSON.parse(
      readFileSync(resolve(folder, 'source-receipt.json'), 'utf8'),
    );
    pool.push({
      ...receipt,
      folder: relative(root, folder).replaceAll('\\', '/'),
    });
  }
}
const selected = pool
  .filter(
    (row) =>
      row.status === 'SOURCE_READY' && row.authority_confidence === 'CONFIRMED',
  )
  .slice(0, 12);
if (
  selected.length !== 12 ||
  new Set(selected.map((row) => row.video_id)).size !== 12
)
  throw new Error('TWELVE_VERIFIED_SOURCES_REQUIRED');
const films = [];
for (const film of selected) {
  const folder = resolve(root, film.folder),
    source = readFileSync(resolve(folder, 'source.txt'), 'utf8'),
    map = readFileSync(resolve(folder, 'manifest.json'), 'utf8');
  if (
    (await sha256(source)) !== film.source_hash ||
    (await sha256(map)) !== film.manifest_hash
  )
    throw new Error('SOURCE_HASH_MISMATCH');
  await renderAnnotationSheet({
    video_id: film.video_id,
    source_text: source,
    manifest: JSON.parse(map),
    manifest_hash: film.manifest_hash!,
  });
  films.push({
    video_id: film.video_id,
    source_hash: film.source_hash,
    manifest_hash: film.manifest_hash,
    private_folder: film.folder,
    annotation_status: 'AWAITING_OWNER_ANNOTATIONS',
    important_claims: 0,
  });
}
mkdirSync(output, { recursive: true });
const frozen = {
  version: 'cp3.13-review-package:1',
  frozen_at: new Date().toISOString(),
  source_selection_rule:
    'first 12 SOURCE_READY with actual CONFIRMED original authority, selected before pilot generation or human annotation',
  annotator_id: 'OWNER_A',
  independent_reviewer_id: null,
  independent_review: 'AWAITING_HUMAN_REVIEW',
  minimum_films: 12,
  minimum_human_claims: 40,
  suggested_claims_per_film: 4,
  actual_human_claims: 0,
  generation_requests: 0,
  films,
  source_candidates: pool.map((row) => ({
    video_id: row.video_id,
    status: row.status,
  })),
};
const body = JSON.stringify(frozen, null, 2) + '\n';
if (existsSync(resolve(output, 'corpus.json')))
  throw new Error('REVIEW_PACKAGE_ALREADY_FROZEN');
writeFileSync(resolve(output, 'corpus.json'), body, { flag: 'wx' });
const reviewTemplate = {
  version: 'human-review-preparation:1',
  is_completed_review: false,
  annotator_id: 'OWNER_A',
  independent_reviewer_id: null,
  status: 'AWAITING_HUMAN_REVIEW',
  critical_cases: [
    'NEGATION',
    'CONDITION',
    'NUMBER',
    'REPORTED_SPEECH',
    'STANCE_USAGE',
    'PREDICTION_HORIZON',
    'ENTITY_AMBIGUITY',
    'ASR_DIFFICULT',
  ],
  films: films.map((film) => ({
    video_id: film.video_id,
    source_hash: film.source_hash,
    manifest_hash: film.manifest_hash,
    annotations_file: null,
    annotations_hash: null,
    annotations_frozen_at: null,
    provider_response_file: null,
    canonical_file: null,
    important_claims: [],
    output_support_labels: [],
    cases: [],
    summary_coverage: null,
    stance_usage: null,
    prediction_qualifiers: null,
    entity_alias_ambiguity: null,
    independent_reviewed_at: null,
    disagreements_resolved: false,
  })),
};
writeFileSync(
  resolve(output, 'review-preparation.json'),
  JSON.stringify(reviewTemplate, null, 2) + '\n',
  { flag: 'wx' },
);
const html =
  '<!doctype html><html lang="pl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>CP-3.13 · OWNER_A</title><h1>Anotacje źródeł · OWNER_A</h1><p>12 zweryfikowanych źródeł. Zapisz co najmniej 40 ważnych twierdzeń łącznie; po 4 na film daje 48. Wpisz OWNER_A jako pseudonim. Treść twierdzeń, cytaty i oceny pochodzą od człowieka. Nie oglądaj odpowiedzi AI przed zamrożeniem anotacji.</p><ol>' +
  films
    .map(
      (f) =>
        '<li><a href="../' +
        f.private_folder +
        '/annotations.html">Film ' +
        f.video_id +
        '</a> · <a href="https://www.youtube.com/watch?v=' +
        f.video_id +
        '" target="_blank" rel="noopener noreferrer">Nagranie źródłowe</a></li>',
    )
    .join('') +
  '</ol><p>Niezależny recenzent: AWAITING_HUMAN_REVIEW. Liczba rzeczywistych anotacji w przygotowanym pakiecie: 0. Minimum 40 jest wymogiem, nie deklaracją gotowego wyniku.</p><p>Procedura i kryteria znajdują się w docs/verification/ai-pilot/HUMAN_REVIEW_PROCEDURE.md. Formularze nie wysyłają żadnych requestów Gemini.</p></html>';
writeFileSync(resolve(output, 'index.html'), html, { flag: 'wx' });
const receipt = {
  version: 'cp3.13-materials-receipt:1',
  recorded_at: new Date().toISOString(),
  package_sha256: await sha256(body),
  films: films.map(({ video_id, source_hash, manifest_hash }) => ({
    video_id,
    source_hash,
    manifest_hash,
  })),
  source_candidates: frozen.source_candidates,
  source_ready: true,
  actual_human_claims: 0,
  minimum_human_claims: 40,
  annotator_id: 'OWNER_A',
  independent_review: 'AWAITING_HUMAN_REVIEW',
  generation_requests: 0,
  quality_gate: 'NOT_ASSESSED',
  paid_services_enabled: false,
  secret_values_recorded: false,
};
writeFileSync(
  'docs/verification/ai-pilot/materials-2026-10-06.json',
  JSON.stringify(receipt, null, 2) + '\n',
  { flag: 'wx' },
);
process.stdout.write(
  JSON.stringify({
    result: 'TWELVE_SOURCE_MATERIALS_READY',
    private_package: output,
    actual_human_claims: 0,
    minimum_human_claims: 40,
    independent_review: 'AWAITING_HUMAN_REVIEW',
    generation_requests: 0,
  }) + '\n',
);
