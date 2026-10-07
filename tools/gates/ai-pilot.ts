import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evaluateAiPilot, type PilotReview } from './ai-pilot-evaluation.js';
import { strictJson } from '../../packages/core/src/ai/repair/strict-json.js';
import { verifyPilotFiles } from './ai-pilot-inputs.js';
const input = process.argv[2],
  output = process.argv[3];
const level = process.argv.includes('--full')
  ? 'FULL_GATE_AI'
  : 'STAGE_03_PILOT';
if (!input || !output) {
  process.stdout.write(
    JSON.stringify({
      gate: level,
      status: 'NOT_RUN',
      reason: 'FROZEN_HUMAN_REVIEW_AND_REAL_PROVIDER_INPUT_REQUIRED',
    }) + '\n',
  );
  process.exitCode = 2;
} else {
  let inputHash: string | null = null;
  let report: Record<string, unknown>;
  try {
    if (statSync(input).size > 8 * 1024 * 1024)
      throw new Error('PILOT_FILE_TOO_LARGE');
    const raw = readFileSync(input, 'utf8');
    inputHash = createHash('sha256').update(raw).digest('hex');
    const review = strictJson(raw) as unknown as PilotReview;
    if (!Array.isArray(review.films) || review.films.length > 100)
      throw new Error('INVALID_PILOT_CORPUS');
    for (const film of review.films) await verifyPilotFiles(film, review.scope);
    report = {
      ...evaluateAiPilot(review, level),
      input_hash: inputHash,
      evaluated_at: new Date().toISOString(),
    };
  } catch (error) {
    const reason =
      error instanceof Error && /^[A-Z][A-Z_]{1,80}$/.test(error.message)
        ? error.message
        : 'INVALID_PILOT_INPUT';
    report = {
      version: 'ai-pilot-evaluation:1',
      level,
      status: 'FAIL',
      input_hash: inputHash,
      evaluated_at: new Date().toISOString(),
      verification_reason: reason,
      approval_published: false,
    };
  }
  // Exclusive create preserves previous FAIL evidence. Reports contain hashes,
  // metrics and categories only, never source text, tokens or provider bodies.
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(
    JSON.stringify({
      gate: level,
      status: report.status,
      films: report.films,
      reasons: report.reasons,
      verification_reason: report.verification_reason,
    }) + '\n',
  );
  if (report.status !== 'PASS') process.exitCode = 2;
}
