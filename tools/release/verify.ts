import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { strictJson } from '../../packages/core/src/ai/repair/strict-json.js';
import { loadGateEvidence, evidenceHash } from '../gates/drive-evidence.js';
import { candidatePins } from './pins.js';
import { evaluateRelease, type ReleaseManifest } from './evaluate.js';
const args = process.argv.slice(2);
if (
  args.length !== 4 ||
  args[0] !== '--manifest' ||
  args[2] !== '--output' ||
  !args[1] ||
  !args[3]
) {
  console.log(
    JSON.stringify({
      status: 'NOT_RUN',
      reason: 'ACTUAL_RELEASE_MANIFEST_REQUIRED',
    }),
  );
  process.exitCode = 2;
} else {
  let report: Record<string, unknown>;
  try {
    const path = resolve(args[1]);
    if (statSync(path).size > 256 * 1024)
      throw new Error('RELEASE_MANIFEST_TOO_LARGE');
    const bytes = readFileSync(path);
    report = {
      ...evaluateRelease(
        strictJson(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        ) as unknown as ReleaseManifest,
        candidatePins(),
        (ref) => loadGateEvidence(dirname(path), ref),
        new Date(),
      ),
      input_sha256: evidenceHash(bytes),
    };
  } catch (error) {
    report = {
      version: 'ReleaseReport/1.0',
      status: 'FAIL',
      reason:
        error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : 'INVALID_RELEASE_EVIDENCE',
      deployed: false,
    };
  }
  writeFileSync(args[3], JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      status: report.status,
      implementation: report.implementation,
      long_run_observation: report.long_run_observation,
      reason: report.reason,
    }),
  );
  if (report.status !== 'PASS') process.exitCode = 2;
}
