import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  oracleConfiguration,
  verifyOracleRuntime,
} from '../../../apps/executor/src/oracle-runtime.js';
import {
  captionProcessRunner,
  YtdlpTranscriptProvider,
  ytdlpProviderVersion,
} from '../../../apps/executor/src/providers/ytdlp.js';
import { selectTranscriptLanguage } from '../../../packages/core/src/transcript/language.js';
import type {
  TranscriptFetch,
  TranscriptProvider,
  SourceItemRef,
  TranscriptSegment,
} from '../../../packages/contracts/src/transcript.js';

const hash = (body: Uint8Array | string) =>
  createHash('sha256').update(body).digest('hex');
interface Reference {
  language_code: string;
  track_kind: 'MANUAL' | 'GENERATED';
  segments: TranscriptSegment[];
}
/** Dokładne porównanie wszystkich wypowiedzi i timingów; bez deduplikacji tekstu. */
export function compareFullSource(
  fetched: TranscriptFetch,
  reference: Reference,
) {
  const result = fetched.result;
  if (
    result.status !== 'OK' ||
    result.is_translated !== false ||
    result.missing_ranges.length ||
    !fetched.raw_payload?.length ||
    hash(fetched.raw_payload) !== result.raw_payload_hash ||
    result.language_code !== reference.language_code ||
    result.track_kind !== reference.track_kind ||
    !reference.segments.length ||
    result.segments.length !== reference.segments.length
  )
    return false;
  return result.segments.every((cue, index) => {
    const expected = reference.segments[index]!;
    return (
      cue.upstream_index === index &&
      expected.upstream_index === index &&
      cue.start_ms !== null &&
      cue.end_ms !== null &&
      cue.text.trim().length > 0 &&
      cue.start_ms === expected.start_ms &&
      cue.end_ms === expected.end_ms &&
      cue.text === expected.text &&
      cue.speaker_label === expected.speaker_label
    );
  });
}
export async function qualifySource(
  provider: TranscriptProvider,
  item: SourceItemRef,
  reference: Reference,
) {
  const context = {
    job_id: 'source-qualification',
    item_id: item.item_id,
    runtime_id: 'local' as const,
    deadline: new Date(Date.now() + 180000).toISOString(),
    max_bytes: 4 * 1024 * 1024,
    quota_reservation_id: null,
    provider_version: ytdlpProviderVersion,
    request_id: crypto.randomUUID(),
    signal: AbortSignal.timeout(180000),
  };
  const listed = await provider.list_tracks(item, context);
  if (listed.status !== 'OK') throw new Error('SOURCE_' + listed.status);
  const selection = selectTranscriptLanguage(listed, '0'.repeat(64));
  if (
    selection.status !== 'SELECTED' ||
    selection.authority_confidence !== 'CONFIRMED'
  )
    throw new Error('SOURCE_AUTHORITY_UNCONFIRMED');
  const fetched = await provider.fetch(item, selection.source!, context);
  if (!compareFullSource(fetched, reference))
    throw new Error('SOURCE_REFERENCE_MISMATCH');
  return fetched;
}
async function main() {
  if (
    process.argv.length !== 4 ||
    process.platform !== 'linux' ||
    process.arch !== 'arm64'
  )
    throw new Error('SOURCE_ORACLE_ARGUMENT_REQUIRED');
  const config = oracleConfiguration(process.env);
  await verifyOracleRuntime(config);
  const inputPath = resolve(process.argv[2]!),
    outputPath = resolve(process.argv[3]!);
  const input = JSON.parse(await readFile(inputPath, 'utf8')) as {
    cases: {
      video_id: string;
      duration_ms: number;
      access_basis: string;
      reference_complete: boolean;
      reference_path: string;
      reference_sha256: string;
    }[];
  };
  if (
    !Array.isArray(input.cases) ||
    input.cases.length !== 3 ||
    new Set(input.cases.map((row) => row.video_id)).size !== 3
  )
    throw new Error('SOURCE_THREE_DISTINCT_CASES_REQUIRED');
  // Sprawdź wszystkie zgody i referencje zanim wykonasz pierwszy request.
  const cases = await Promise.all(
    input.cases.map(async (row) => {
      if (
        !/^[A-Za-z0-9_-]{11}$/.test(row.video_id) ||
        typeof row.access_basis !== 'string' ||
        !row.access_basis.trim() ||
        row.reference_complete !== true ||
        !isAbsolute(row.reference_path) ||
        !/^[a-f0-9]{64}$/.test(row.reference_sha256) ||
        !Number.isSafeInteger(row.duration_ms) ||
        row.duration_ms <= 0
      )
        throw new Error('SOURCE_AUTHORIZED_REFERENCE_REQUIRED');
      const bytes = await readFile(row.reference_path);
      if (
        bytes.length > 4 * 1024 * 1024 ||
        hash(bytes) !== row.reference_sha256
      )
        throw new Error('SOURCE_REFERENCE_HASH_MISMATCH');
      const reference = JSON.parse(bytes.toString('utf8')) as Reference;
      if (
        !['MANUAL', 'GENERATED'].includes(reference.track_kind) ||
        !Array.isArray(reference.segments) ||
        !reference.segments.length
      )
        throw new Error('SOURCE_REFERENCE_INVALID');
      return { row, reference };
    }),
  );
  const provider = new YtdlpTranscriptProvider(captionProcessRunner(config));
  await mkdir(outputPath, { mode: 0o700 }); // Istniejący katalog: odmowa, bez nadpisywania dowodów.
  const receipts = [];
  for (const { row, reference } of cases) {
    const fetched = await qualifySource(
      provider,
      {
        item_id: 'youtube:' + row.video_id,
        namespace: 'youtube',
        external_id: row.video_id,
        duration_ms: row.duration_ms,
      },
      reference,
    );
    const json = JSON.stringify(fetched.result, null, 2) + '\n',
      text = fetched.result.segments.map((cue) => cue.text).join('\n');
    await writeFile(
      join(outputPath, row.video_id + '.raw'),
      fetched.raw_payload!,
      { mode: 0o600, flag: 'wx' },
    );
    await writeFile(join(outputPath, row.video_id + '.json'), json, {
      mode: 0o600,
      flag: 'wx',
    });
    await writeFile(join(outputPath, row.video_id + '.txt'), text, {
      mode: 0o600,
      flag: 'wx',
    });
    receipts.push({
      video_id: row.video_id,
      access_basis_sha256: hash(row.access_basis),
      reference_sha256: row.reference_sha256,
      raw_sha256: fetched.result.raw_payload_hash,
      json_sha256: hash(json),
      text_sha256: hash(text),
      segment_count: fetched.result.segments.length,
      language: fetched.result.language_code,
      provider_version: fetched.result.provider_version,
      status: 'PASS',
    });
  }
  const receipt = {
    schema: 'oracle-source-qualification:1',
    observed_utc: new Date().toISOString(),
    worker_id: config.workerId,
    architecture: process.arch,
    execution_platform: process.platform,
    source_qualified: true,
    cases: receipts,
  };
  await writeFile(
    join(outputPath, 'receipt.json'),
    JSON.stringify(receipt, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  process.stdout.write(
    JSON.stringify({ event: 'ORACLE_SOURCE_QUALIFIED', cases: 3 }) + '\n',
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const code =
      error instanceof Error && /^SOURCE_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'SOURCE_QUALIFICATION_FAILED';
    process.stderr.write(
      JSON.stringify({ event: 'ORACLE_SOURCE_NOT_QUALIFIED', code }) + '\n',
    );
    process.exitCode = 78;
  });
}
