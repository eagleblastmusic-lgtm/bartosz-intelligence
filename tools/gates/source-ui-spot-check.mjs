import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const [path, video] = process.argv.slice(2);
if (!path || !/^[\w-]{11}$/.test(video ?? ''))
  throw new Error('SOURCE_REFERENCE_ARGUMENTS');
const bytes = readFileSync(path);
const lines = bytes.toString('utf8').split(/\r?\n/);
const reference = lines.flatMap((line) => {
  const m = line.match(/^\[(?:(\d+):)?(\d+):(\d+)\]\s*(.+)$/);
  if (!m) return [];
  return [
    {
      start_second: Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]),
      text_sha256: createHash('sha256')
        .update(m[4].replace(/\s+/g, ' ').trim())
        .digest('hex'),
    },
  ];
});
const rows = readFileSync('docs/verification/gate-0/results.jsonl', 'utf8')
  .trim()
  .split(/\r?\n/)
  .map(JSON.parse);
const row = rows
  .filter(
    (r) =>
      r.video_id === video &&
      r.provider === 'yt-dlp captions-only' &&
      r.operation === 'fetch_track' &&
      r.status === 'OK',
  )
  .at(-1);
if (!row) throw new Error('MATCHING_SUCCESS_REQUIRED');
const boundaries = ['first_cue', 'middle_cue', 'last_cue'].map((key) => {
  const cue = row.result[key];
  const matches = reference.filter((r) => r.text_sha256 === cue.text_sha256);
  const aligned =
    matches.find((r) => Math.floor(cue.start_ms / 1000) === r.start_second) ??
    matches[0];
  return {
    boundary: key,
    text_hash_match: matches.length > 0,
    source_start_second: aligned?.start_second ?? null,
    candidate_start_ms: cue.start_ms,
    candidate_end_ms: cue.end_ms,
    start_within_source_display_second: matches.some(
      (r) => Math.floor(cue.start_ms / 1000) === r.start_second,
    ),
  };
});
const target = 'docs/verification/gate-0/source-ui-spot-checks.json';
const evidence = existsSync(target)
  ? JSON.parse(readFileSync(target, 'utf8')).filter((r) => r.video_id !== video)
  : [];
evidence.push({
  video_id: video,
  stratum: row.primary_stratum,
  source: 'Official public YouTube transcript via browser export',
  checked_at: new Date().toISOString(),
  source_file_sha256: createHash('sha256').update(bytes).digest('hex'),
  reference_cue_count: reference.length,
  candidate_cue_count: row.cue_count,
  candidate_request_id: row.request_id,
  boundaries,
  precise_250ms_fidelity_status: 'INCONCLUSIVE',
  limitation:
    'UI export shows integer seconds and no cue end. Text hashes and displayed-second alignment can be checked; this does not prove frozen 250ms start/end fidelity. No source text retained in evidence.',
});
writeFileSync(target, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence.at(-1)));
