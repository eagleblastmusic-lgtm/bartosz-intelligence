import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import {
  YtdlpTranscriptProvider,
  ytdlpProviderVersion,
} from '../../apps/executor/src/providers/ytdlp.js';
import { selectTranscriptLanguage } from '../../packages/core/src/transcript/language.js';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { renderAnnotationSheet } from './ai-pilot-annotation.js';
import type {
  SourceItemRef,
  TranscriptRequestContext,
} from '../../packages/contracts/src/transcript.js';

const output = resolve(process.argv[2] ?? '.local/ai-pilot/cp-3.13');
if (!output.startsWith(resolve('.local/ai-pilot') + sep))
  throw new Error('PRIVATE_PILOT_DIRECTORY_REQUIRED');
if (
  JSON.parse(readFileSync('config/defaults.json', 'utf8'))
    .paid_services_enabled !== false
)
  throw new Error('PAID_POLICY_DENIED');
type Entry = {
  video_id: string;
  channel_id: string;
  primary_stratum: string;
  public_url: string;
  duration_seconds: number | null;
  public_access: boolean | string;
};
const corpus = JSON.parse(
  readFileSync('docs/verification/gate-0/MANIFEST.json', 'utf8'),
) as { sha256: string; entries: Entry[] };
const packagePath = resolve(output, 'package.json');
const supplementary = process.argv.includes('--supplement');
const candidateCount = supplementary ? 4 : 12;
if (!existsSync(packagePath)) {
  const initial = supplementary
    ? (JSON.parse(
        readFileSync(resolve('.local/ai-pilot/cp-3.13/package.json'), 'utf8'),
      ) as { films: Entry[] })
    : null;
  const films = supplementary
    ? corpus.entries
        .filter(
          (e) =>
            e.primary_stratum === 'en_generated' &&
            !initial!.films.some((f) => f.video_id === e.video_id),
        )
        .slice(0, candidateCount)
    : [
        ['en_manual', 4],
        ['pl_manual', 4],
        ['en_generated', 2],
        ['pl_generated', 2],
      ].flatMap(([stratum, count]) =>
        corpus.entries
          .filter((e) => e.primary_stratum === stratum)
          .slice(0, Number(count)),
      );
  if (
    films.length !== candidateCount ||
    new Set(films.map((f) => f.video_id)).size !== candidateCount
  )
    throw new Error('TWELVE_SOURCE_FILMS_REQUIRED');
  mkdirSync(output, { recursive: true });
  writeFileSync(
    packagePath,
    JSON.stringify(
      {
        version: 'ai-pilot-materials:1',
        created_at: new Date().toISOString(),
        source_corpus_hash: corpus.sha256,
        annotator_id: 'OWNER_A',
        independent_reviewer_id: null,
        independent_review: 'AWAITING_HUMAN_REVIEW',
        minimum_human_claims: 40,
        suggested_claims_per_film: 4,
        claim_slots_are_not_annotations: true,
        films,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
}
const prepared = JSON.parse(readFileSync(packagePath, 'utf8')) as {
  films: Entry[];
  source_corpus_hash: string;
};
if (
  prepared.source_corpus_hash !== corpus.sha256 ||
  prepared.films.length !== candidateCount
)
  throw new Error('IMMUTABLE_CORPUS_MISMATCH');
const provider = new YtdlpTranscriptProvider();
for (const [index, entry] of prepared.films.entries()) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(entry.video_id))
    throw new Error('INVALID_VIDEO_ID');
  const folder = resolve(output, entry.video_id),
    receiptPath = resolve(folder, 'source-receipt.json');
  if (existsSync(receiptPath)) continue; // No hidden retries or replacement of a failed row.
  mkdirSync(folder, { recursive: true });
  const intentPath = resolve(folder, 'source-attempt.json');
  if (existsSync(intentPath)) {
    writeFileSync(
      receiptPath,
      JSON.stringify(
        {
          video_id: entry.video_id,
          status: 'INTERRUPTED_SOURCE_ATTEMPT',
          generation_requests: 0,
          human_annotations: 'NOT_CREATED',
          independent_review: 'AWAITING_HUMAN_REVIEW',
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
    continue;
  }
  const item: SourceItemRef = {
    item_id: 'youtube:' + entry.video_id,
    namespace: 'youtube',
    external_id: entry.video_id,
    duration_ms:
      entry.duration_seconds === null
        ? null
        : Math.round(entry.duration_seconds * 1000),
  };
  const context: TranscriptRequestContext = {
    job_id: 'cp-3.13-materials',
    item_id: item.item_id,
    runtime_id: 'local',
    deadline: new Date(Date.now() + 60000).toISOString(),
    max_bytes: 4 * 1024 * 1024,
    quota_reservation_id: null,
    provider_version: ytdlpProviderVersion,
    request_id: crypto.randomUUID(),
  };
  const started = new Date().toISOString();
  writeFileSync(
    intentPath,
    JSON.stringify(
      {
        video_id: entry.video_id,
        started_at: started,
        operation: 'SOURCE_MATERIALS_ONLY',
        maximum_attempts: 1,
        generation_requests: 0,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  let receipt: Record<string, unknown> = {
    video_id: entry.video_id,
    started_at: started,
    provider: ytdlpProviderVersion,
    runtime: 'local',
    generation_requests: 0,
    hidden_retries: 0,
    annotator_id: 'OWNER_A',
    human_annotations: 'NOT_CREATED',
    independent_review: 'AWAITING_HUMAN_REVIEW',
    paid_services_enabled: false,
  };
  try {
    const list = await provider.list_tracks(item, context),
      selection = selectTranscriptLanguage(
        list,
        'pilot-track-list:' + context.request_id,
      );
    receipt = {
      ...receipt,
      list_status: list.status,
      selection_status: selection.status,
      authority_confidence: selection.authority_confidence,
      authority_basis: selection.authority_basis,
    };
    if (!selection.source || selection.authority_confidence !== 'CONFIRMED')
      receipt = {
        ...receipt,
        status: 'SOURCE_AUTHORITY_UNCONFIRMED',
        failure_code: list.failure_code,
      };
    else {
      const fetched = await provider.fetch(item, selection.source, {
        ...context,
        deadline: new Date(Date.now() + 60000).toISOString(),
      });
      receipt = {
        ...receipt,
        status: fetched.result.status,
        failure_code: fetched.result.failure_code,
        warnings: fetched.result.warnings,
        raw_hash: fetched.result.raw_payload_hash,
      };
      if (fetched.result.status === 'OK' && fetched.raw_payload) {
        const source = fetched.result.segments.map((c) => c.text).join('\n'),
          normalized = await normalizeTranscript(
            await sha256(source),
            fetched.result.segments,
            fetched.result.timestamp_precision,
          );
        const map = JSON.stringify(normalized.manifest);
        if (new TextEncoder().encode(map).length > 32 * 1024 * 1024)
          throw new Error('MANIFEST_SIZE_LIMIT');
        const sheet = await renderAnnotationSheet({
          video_id: entry.video_id,
          source_text: source,
          manifest: normalized.manifest,
          manifest_hash: normalized.manifest_hash,
        });
        writeFileSync(resolve(folder, 'raw.bin'), fetched.raw_payload, {
          flag: 'wx',
        });
        writeFileSync(resolve(folder, 'source.txt'), source, { flag: 'wx' });
        writeFileSync(resolve(folder, 'manifest.json'), map, { flag: 'wx' });
        writeFileSync(resolve(folder, 'annotations.html'), sheet, {
          flag: 'wx',
        });
        receipt = {
          ...receipt,
          status: 'SOURCE_READY',
          source_hash: await sha256(source),
          manifest_hash: normalized.manifest_hash,
          cue_count: fetched.result.segments.length,
          anchor_count: normalized.manifest.anchors.length,
        };
      }
    }
  } catch (error) {
    receipt = {
      ...receipt,
      status: 'SOURCE_PREPARATION_FAILED',
      failure_code:
        error instanceof Error && error.message === 'MANIFEST_SIZE_LIMIT'
          ? 'MANIFEST_SIZE_LIMIT'
          : 'BOUNDED_SOURCE_PREPARATION_FAILURE',
    };
  }
  writeFileSync(
    receiptPath,
    JSON.stringify(
      { ...receipt, finished_at: new Date().toISOString() },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  process.stdout.write(
    JSON.stringify({
      film: index + 1,
      video_id: entry.video_id,
      status: receipt.status,
      generation_requests: 0,
    }) + '\n',
  );
}
const rows = prepared.films.map(
  (entry) =>
    JSON.parse(
      readFileSync(
        resolve(output, entry.video_id, 'source-receipt.json'),
        'utf8',
      ),
    ) as {
      status: string;
      video_id: string;
      source_hash?: string;
      manifest_hash?: string;
    },
);
const indexHtml =
  '<!doctype html><html lang="pl"><meta charset="utf-8"><title>CP-3.13 · Anotacje OWNER_A</title><h1>CP-3.13 · materiały do ludzkiej oceny</h1><p>12 filmów, wymagane co najmniej 40 ważnych twierdzeń zapisanych przez OWNER_A. Zalecany rozkład: po 4 na film (48). Puste miejsca i propozycje maszynowe nie są ground truth. Niezależny przegląd: AWAITING_HUMAN_REVIEW.</p><ol>' +
  rows
    .map(
      (row) =>
        '<li>' +
        row.video_id +
        ': ' +
        (row.status === 'SOURCE_READY'
          ? '<a href="' +
            row.video_id +
            '/annotations.html">Anotuj dokładne źródło</a>'
          : row.status) +
        '</li>',
    )
    .join('') +
  '</ol><p>Nie ma żadnych wywołań Gemini ani automatycznej kwalifikacji wyników.</p></html>';
if (!existsSync(resolve(output, 'index.html')))
  writeFileSync(resolve(output, 'index.html'), indexHtml, { flag: 'wx' });
process.stdout.write(
  JSON.stringify({
    result: 'MATERIALS_COLLECTED',
    films: prepared.films.length,
    source_ready: rows.filter((r) => r.status === 'SOURCE_READY').length,
    actual_human_claims: 0,
    independent_review: 'AWAITING_HUMAN_REVIEW',
    output,
    generation_requests: 0,
  }) + '\n',
);
