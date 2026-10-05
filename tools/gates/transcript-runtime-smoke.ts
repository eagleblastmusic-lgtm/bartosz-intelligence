import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import {
  YtdlpTranscriptProvider,
  ytdlpProviderVersion,
} from '../../apps/executor/src/providers/ytdlp.js';
import type {
  TranscriptRequestContext,
  SourceItemRef,
} from '../../packages/contracts/src/transcript.js';
import { selectTranscriptLanguage } from '../../packages/core/src/transcript/language.js';
const defaults = JSON.parse(readFileSync('config/defaults.json', 'utf8'));
if (defaults.paid_services_enabled !== false)
  throw new Error('PAID_SERVICES_DISABLED_REQUIRED');
const entry = JSON.parse(
  readFileSync('docs/verification/gate-0/MANIFEST.json', 'utf8'),
).entries[0];
const item: SourceItemRef = {
  item_id: 'youtube:' + entry.video_id,
  namespace: 'youtube',
  external_id: entry.video_id,
  duration_ms:
    typeof entry.duration_seconds === 'number'
      ? Math.round(entry.duration_seconds * 1000)
      : null,
};
const provider = new YtdlpTranscriptProvider(),
  requestId = randomUUID(),
  started = new Date();
const context: TranscriptRequestContext = {
  job_id: 'adapter-qualification',
  item_id: item.item_id,
  runtime_id: 'local',
  deadline: new Date(Date.now() + 60000).toISOString(),
  max_bytes: 4 * 1024 * 1024,
  quota_reservation_id: null,
  provider_version: ytdlpProviderVersion,
  request_id: requestId,
};
const list = await provider.list_tracks(item, context);
const selection = selectTranscriptLanguage(list, 'live-tracklist:' + requestId);
const selected = selection.source;
const metadataOnly = process.argv.includes('--list-only');
const fetched =
  selected && !metadataOnly
    ? await provider.fetch(item, selected, {
        ...context,
        deadline: new Date(Date.now() + 60000).toISOString(),
      })
    : null;
const report = {
  sampled_at: started.toISOString(),
  runtime: 'local',
  provider_version: ytdlpProviderVersion,
  video_id: item.external_id,
  list_status: list.status,
  track_count: list.tracks.length,
  video_language: list.video_language,
  authority_basis: selection.authority_basis,
  selection_status: selection.status,
  metadata_only: metadataOnly,
  selected: selected
    ? {
        language: selected.language_code,
        kind: selected.track_kind,
        is_translated: selected.is_translated,
        is_original: selected.is_original,
      }
    : null,
  fetch_status: fetched?.result.status ?? null,
  failure_code: fetched?.result.failure_code ?? list.failure_code,
  cue_count: fetched?.result.segments.length ?? null,
  raw_payload_hash: fetched?.result.raw_payload_hash ?? null,
  source_times: fetched
    ? {
        first: fetched.result.segments[0]?.start_ms ?? null,
        last: fetched.result.segments.at(-1)?.end_ms ?? null,
      }
    : null,
  warnings: fetched?.result.warnings ?? [],
  bytes: fetched?.raw_payload?.length ?? null,
  paid_services_enabled: false,
  model_generation_requests: 0,
  result:
    list.status === 'OK' &&
    selection.status === 'SELECTED' &&
    (metadataOnly || fetched?.result.status === 'OK')
      ? 'PASS'
      : 'FAIL',
};
mkdirSync('.local/transcript-smoke', { recursive: true });
writeFileSync(
  `.local/transcript-smoke/${requestId}.tracks.json`,
  JSON.stringify({ list, selection }),
  { mode: 0o600, flag: 'wx' },
);
if (fetched?.raw_payload) {
  mkdirSync('.local/transcript-smoke', { recursive: true });
  writeFileSync(
    `.local/transcript-smoke/${requestId}.raw`,
    fetched.raw_payload,
    { mode: 0o600, flag: 'wx' },
  );
  writeFileSync(
    `.local/transcript-smoke/${requestId}.json`,
    JSON.stringify(fetched.result),
    { mode: 0o600, flag: 'wx' },
  );
}
mkdirSync('docs/verification/transcript', { recursive: true });
const path = `docs/verification/transcript/runtime-${started.toISOString().replaceAll(':', '-')}.json`;
const evidence = {
  ...report,
  evidence_sha256: createHash('sha256')
    .update(JSON.stringify(report))
    .digest('hex'),
};
writeFileSync(path, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ evidence_ref: path, ...report }));
if (report.result !== 'PASS') process.exitCode = 1;
