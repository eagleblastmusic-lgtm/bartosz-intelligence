// Offline replay only. Never reads credentials or calls any external service.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import {
  captionArchiveCoverage,
  renderTranscriptArchive,
} from '../../packages/core/src/transcript/archive-renderer.js';
import { splitArtifactText } from '../../packages/core/src/artifacts/store.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import type { TranscriptSegment } from '../../packages/contracts/src/transcript.js';
const date = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const directory = resolve(`docs/verification/performance/${date}`);
mkdirSync(directory, { recursive: true });
const evidence =
  'docs/verification/oracle/2026-10-14/persistent-auth/evidence/';
const profiles: {
  name: string;
  kind: 'CAPTURE_REPLAY' | 'SYNTHETIC';
  raw: string;
  cues: TranscriptSegment[];
}[] = [];
for (const name of ['ted', 'first']) {
  const raw = readFileSync(
    evidence + `success-${name}-caption.raw`,
    'utf8',
  ).replace(/\r?\n$/, '');
  const cues = (
    JSON.parse(
      readFileSync(evidence + `success-${name}-segments.json`, 'utf8'),
    ) as TranscriptSegment[]
  ).map((c, i) => ({ ...c, upstream_index: i }));
  profiles.push({ name, kind: 'CAPTURE_REPLAY', raw, cues });
}
const cues = Array.from({ length: 10800 }, (_, i) => ({
  upstream_index: i,
  start_ms: i * 1000 + 123,
  end_ms: i * 1000 + 987,
  text: `Exact caption ${i}: literal <b>markup</b>, &amp;, repeat 😀.`,
  speaker_label: null,
}));
profiles.push({
  name: '180min',
  kind: 'SYNTHETIC',
  raw: JSON.stringify({ events: cues }),
  cues,
});
const results = [];
for (const p of profiles) {
  const source = p.cues.map((c) => c.text).join('\n'),
    hash = await sha256(source),
    start = performance.now(),
    cpu = process.cpuUsage();
  const normalized = await normalizeTranscript(hash, p.cues, 'CUE');
  const legacy = [
    p.raw,
    source,
    JSON.stringify(captionArchiveCoverage(hash, p.cues)),
    normalized.manifest.anchors.map((a) => a.text).join('\n'),
    JSON.stringify(normalized.manifest),
    JSON.stringify(
      normalized.manifest.anchors.map((a) => ({
        segment_id: a.segment_id,
        offsets: a.offsets,
      })),
    ),
  ];
  const legacyMs = performance.now() - start,
    legacyCpu = process.cpuUsage(cpu);
  const compactStart = performance.now(),
    compactCpu = process.cpuUsage(),
    compact = [
      p.raw,
      source,
      JSON.stringify(captionArchiveCoverage(hash, p.cues)),
    ];
  const preparationMs = performance.now() - compactStart,
    preparationCpu = process.cpuUsage(compactCpu);
  const rendered = await renderTranscriptArchive({
    source_text: source,
    source_hash: hash,
    manifest: captionArchiveCoverage(hash, p.cues),
    descriptor: {
      video_id: 'fixture0001',
      title: 'Offline replay',
      channel: 'Fixture',
      url: 'https://www.youtube.com/watch?v=fixture0001',
      published_at: null,
      discovered_at: '2026-10-14T00:00:00.000Z',
      language_code: 'en',
      track_kind: 'MANUAL',
      upstream_track_id: 'fixture',
      provider_id: 'local_ytdlp',
      provider_version: 'fixture',
      source_status: 'AVAILABLE_FULL',
      original_language_confirmed: true,
      retrieved_at: null,
      timestamp_precision: 'CUE',
      missing_ranges: [],
      warnings: [],
    },
  });
  const describe = (bodies: string[]) => ({
    artifacts: bodies.length,
    bytes: bodies.reduce((n, s) => n + Buffer.byteLength(s), 0),
    chunks: bodies.reduce((n, s) => n + splitArtifactText(s).length, 0),
  });
  const before = describe(legacy),
    after = describe(compact);
  // ArtifactClient: begin + one write and verify-step per chunk. Control RPCs
  // are measured separately by live worker logs; periodic heartbeats vary.
  const artifactRpcBefore = before.artifacts + 2 * before.chunks,
    artifactRpcAfter = after.artifacts + 2 * after.chunks;
  // Technical package includes base64 bodies and chunk/header descriptors.
  // This byte model deliberately reserves 4KiB metadata plus 320B/chunk.
  const companionEstimate =
    Math.ceil((after.bytes * 4) / 3) + 4096 + 320 * after.chunks;
  results.push({
    profile: p.name,
    input: p.kind,
    cues: p.cues.length,
    raw_sha256: await sha256(p.raw),
    source_sha256: hash,
    before,
    after,
    measured_local: {
      legacy_preparation_wall_ms: legacyMs,
      legacy_cpu_ms: (legacyCpu.user + legacyCpu.system) / 1000,
      compact_preparation_wall_ms: preparationMs,
      compact_cpu_ms: (preparationCpu.user + preparationCpu.system) / 1000,
      readable_archive_bytes: rendered.byte_count,
      node_rss_bytes: process.memoryUsage.rss(),
    },
    artifact_rpc: { before: artifactRpcBefore, after: artifactRpcAfter },
    scenarios: [3, 9, 30, 100].map((n) => ({
      films_per_day: n,
      artifact_rpc_per_day: n * artifactRpcAfter,
      archive_queue_messages: n,
      queue_operations_estimate: n * 3,
      // SQLite index write model, explicitly not production billed rows.
      d1_chunk_rows_inserted: n * after.chunks,
      d1_chunk_rows_write_estimate: n * after.chunks * 3,
      d1_buffer_peak_base64_bytes: Math.ceil((after.bytes * 4) / 3) * n,
      drive_growth_per_30_days_estimate:
        n * 30 * (rendered.byte_count + companionEstimate),
      oracle_avoidable_pause_before_ms: (n - 1) * 30000,
      oracle_avoidable_pause_after_ms: 0,
      archive_first_to_last_avoidable_pause_before_ms: (n - 1) * 300000,
      archive_avoidable_pause_after_ms: 0,
      oracle_drain_seconds_estimate: n * 29,
      workers_requests_minimum_estimate: n * (artifactRpcAfter + 10) + 288 + 72,
    })),
  });
}
const report = {
  generated_at: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  note: 'Local Node replay and explicit models. No production CPU, Oracle timing, real Drive capacity or whole-account quota acceptance.',
  profiles: results,
};
writeFileSync(
  resolve(directory, 'BENCHMARK_MODEL.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(
  JSON.stringify(
    {
      output: resolve(directory, 'BENCHMARK_MODEL.json'),
      profiles: results.map((r) => ({
        profile: r.profile,
        before: r.before,
        after: r.after,
        artifact_rpc: r.artifact_rpc,
        measured_local: r.measured_local,
      })),
    },
    null,
    2,
  ),
);
