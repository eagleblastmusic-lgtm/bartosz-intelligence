import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { strictJson } from '../../packages/core/src/ai/repair/strict-json.js';
import { validateLabControls } from '../../packages/core/src/registry/lab.js';
import {
  evaluateTranslation,
  type TranslationBenchmark,
} from './translation-evaluation.js';
import { verifyTranslationFiles } from './translation-inputs.js';
const [input, output] = process.argv.slice(2);
if (!input || !output) {
  process.stdout.write(
    JSON.stringify({
      gate: 'TRANSLATION',
      status: 'NOT_RUN',
      reason: 'REAL_FILES_AND_BLIND_HUMAN_LABELS_REQUIRED',
    }) + '\n',
  );
  process.exitCode = 2;
} else {
  let inputHash: string | null = null;
  let report: Record<string, unknown>;
  try {
    const text = readFileSync(input, 'utf8');
    inputHash = createHash('sha256').update(text).digest('hex');
    if (Buffer.byteLength(text) > 8 * 1024 * 1024)
      throw new Error('TRANSLATION_INPUT_TOO_LARGE');
    const review = strictJson(text) as unknown as TranslationBenchmark;
    validateLabControls(review.controls);
    if (!Array.isArray(review.trials) || review.trials.length > 300)
      throw new Error('INVALID_TRANSLATION_BENCHMARK');
    const measurements = [];
    for (const trial of review.trials) {
      const variant = review.controls.variants.find(
        (candidate) => candidate.id === trial.variant,
      );
      if (!variant) throw new Error('INVALID_LAB_VARIANT');
      measurements.push(await verifyTranslationFiles(trial, variant));
    }
    report = {
      ...evaluateTranslation(review, measurements),
      input_hash: inputHash,
      evaluated_at: new Date().toISOString(),
    };
  } catch (error) {
    const reason =
      error instanceof Error && /^[A-Z][A-Z_]{1,80}$/.test(error.message)
        ? error.message
        : 'INVALID_TRANSLATION_INPUT';
    report = {
      version: 'translation-evaluation:1',
      status: 'FAIL',
      input_hash: inputHash,
      verification_reason: reason,
      approval_published: false,
      automatic_promotion: false,
    };
  }
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(
    JSON.stringify({
      gate: 'TRANSLATION',
      status: report.status,
      reasons: report.reasons,
      verification_reason: report.verification_reason,
    }) + '\n',
  );
  if (report.status !== 'PASS') process.exitCode = 2;
}
