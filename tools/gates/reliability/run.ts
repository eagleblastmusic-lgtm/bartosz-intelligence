import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { strictJson } from '../../../packages/core/src/ai/repair/strict-json.js';
import { evidenceHash, loadGateEvidence } from '../drive-evidence.js';
import { evaluateRecovery, type GateRManifest } from './evaluate.js';
import { candidatePins } from '../../release/pins.js';
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
      gate: 'R',
      status: 'NOT_RUN',
      reason: 'HASH_BOUND_DRILL_MANIFEST_REQUIRED',
    }),
  );
  process.exitCode = 2;
} else {
  let report: Record<string, unknown>;
  try {
    const path = resolve(args[1]);
    if (statSync(path).size > 256 * 1024)
      throw new Error('RECOVERY_MANIFEST_TOO_LARGE');
    const bytes = readFileSync(path);
    report = {
      ...evaluateRecovery(
        strictJson(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        ) as unknown as GateRManifest,
        (ref) => loadGateEvidence(dirname(path), ref),
        new Date(),
        candidatePins(),
      ),
      input_sha256: evidenceHash(bytes),
    };
  } catch (error) {
    report = {
      version: 'GateRReport/1.0',
      gate: 'R',
      status: 'FAIL',
      reason:
        error instanceof Error && /^[A-Z][A-Z_]{1,80}$/.test(error.message)
          ? error.message
          : 'INVALID_RECOVERY_EVIDENCE',
      provider_requests_performed: false,
      automatic_activation: false,
      global_release_approved: false,
    };
  }
  writeFileSync(args[3], JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({ gate: 'R', status: report.status, reason: report.reason }),
  );
  if (report.status !== 'PASS') process.exitCode = 2;
}
