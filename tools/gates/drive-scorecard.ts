import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { strictJson } from '../../packages/core/src/ai/repair/strict-json.js';
import {
  evaluateDriveGate,
  evidenceHash,
  loadGateEvidence,
  type DriveGateInput,
} from './drive-evidence.js';
export function runDriveScorecard(gate: DriveGateInput['gate']) {
  const args = process.argv.slice(2);
  const inputFlag = gate === 'D_EXPORT' ? '--manifest' : '--receipts';
  if (
    args.length !== 4 ||
    args[0] !== inputFlag ||
    args[2] !== '--output' ||
    !args[1] ||
    !args[3]
  ) {
    process.stdout.write(
      JSON.stringify({
        gate,
        status: 'NOT_RUN',
        reason: 'ACTUAL_HASH_BOUND_RECEIPTS_REQUIRED',
      }) + '\n',
    );
    process.exitCode = 2;
    return;
  }
  let report: Record<string, unknown>;
  try {
    const inputPath = resolve(args[1]);
    const bytes = readFileSync(inputPath);
    if (bytes.length > 256 * 1024)
      throw new Error('DRIVE_GATE_INPUT_TOO_LARGE');
    const input = strictJson(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown as DriveGateInput;
    if (input.gate !== gate) throw new Error('DRIVE_GATE_TYPE_MISMATCH');
    report = {
      ...evaluateDriveGate(
        input,
        (path) => loadGateEvidence(dirname(inputPath), path),
        new Date(),
      ),
      input_sha256: evidenceHash(bytes),
    };
  } catch (error) {
    report = {
      version: 'drive-gate-scorecard:1',
      gate,
      status: 'FAIL',
      reason:
        error instanceof Error && /^[A-Z][A-Z_]{1,80}$/.test(error.message)
          ? error.message
          : 'INVALID_DRIVE_GATE_EVIDENCE',
      automatic_activation: false,
      performed_provider_requests: false,
    };
  }
  writeFileSync(args[3], JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  process.stdout.write(
    JSON.stringify({ gate, status: report.status, reason: report.reason }) +
      '\n',
  );
  if (report.status !== 'PASS') process.exitCode = 2;
}
