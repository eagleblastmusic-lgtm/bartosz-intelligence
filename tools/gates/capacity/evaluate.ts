import { readFileSync, writeFileSync } from 'node:fs';
import { strictJson } from '../../../packages/core/src/ai/repair/strict-json.js';
import { evaluateGateC } from '../../../packages/telemetry/src/gate-c.js';
import type { GateCInput } from '../../../packages/contracts/src/gate-c.js';
import { contentHash } from './store.js';
const input = process.argv[2],
  output = process.argv[3];
if (!input || !output) {
  process.stdout.write(
    JSON.stringify({
      version: 'GateCReport/1.0',
      status: 'NOT_RUN',
      reason: 'PREREGISTERED_REAL_OBSERVATIONS_AND_EVIDENCE_REQUIRED',
    }) + '\n',
  );
  process.exitCode = 2;
} else {
  const raw = readFileSync(input, 'utf8');
  let result: unknown;
  try {
    const data = strictJson(raw) as unknown as GateCInput;
    let verified = false;
    if (data.basis === 'REAL_PRODUCTION' && data.evidence_files?.length) {
      const receipts = new Map<string, Record<string, unknown>>();
      for (const file of data.evidence_files) {
        const body = readFileSync(file.path, 'utf8');
        if (body.length > 16 * 1024 * 1024 || contentHash(body) !== file.sha256)
          throw new Error('GATE_C_EVIDENCE_HASH_MISMATCH');
        receipts.set(file.sha256, strictJson(body) as Record<string, unknown>);
      }
      verified =
        Object.entries(data.proofs).every(([criterion, proof]) => {
          const receipt = proof.evidence_ref
            ? receipts.get(proof.evidence_ref)
            : null;
          return (
            receipt?.version === 'gate-c-proof-receipt:1' &&
            receipt.basis === 'REAL_PRODUCTION' &&
            receipt.config_hash === data.measurements.config_hash &&
            receipt.criterion === criterion &&
            receipt.status === proof.status
          );
        }) &&
        receipts.has(data.preregistration.evidence_ref ?? '') &&
        receipts.has(data.conservative_service_rate.evidence_ref ?? '');
    }
    result = {
      ...evaluateGateC(data, verified),
      input_hash: contentHash(raw),
    };
  } catch (error) {
    result = {
      version: 'GateCReport/1.0',
      status: 'INCONCLUSIVE',
      input_hash: contentHash(raw),
      reason:
        error instanceof Error && /^[A-Z_0-9]+$/.test(error.message)
          ? error.message
          : 'INVALID_GATE_C_INPUT',
    };
  }
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(
    JSON.stringify({
      report: output,
      status: (result as { status: string }).status,
    }) + '\n',
  );
}
