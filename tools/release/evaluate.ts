import { strictJson } from '../../packages/core/src/ai/repair/strict-json.js';
import { evidenceHash } from '../gates/drive-evidence.js';
type Ref = { path: string; sha256: string };
type State =
  | 'PASS'
  | 'FAIL'
  | 'NOT_RUN'
  | 'DISABLED'
  | 'UNAVAILABLE'
  | 'OBSERVING'
  | 'NOT_YET_MATURE';
export interface ReleaseManifest {
  version: 'ReleaseManifest/1.0';
  candidate_sha256: string;
  migration_set_sha256: string;
  paid_services_enabled: false;
  rows: { id: number; state: State; evidence: Ref[] }[];
}
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_RELEASE_SHAPE');
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(','))
    throw new Error('INVALID_RELEASE_SHAPE');
}
export function evaluateRelease(
  input: ReleaseManifest,
  pins: { candidate_sha256: string; migration_set_sha256: string },
  load: (path: string) => Uint8Array,
  now: Date,
) {
  object(input);
  keys(input, [
    'version',
    'candidate_sha256',
    'migration_set_sha256',
    'paid_services_enabled',
    'rows',
  ]);
  if (
    input.version !== 'ReleaseManifest/1.0' ||
    input.paid_services_enabled !== false ||
    input.candidate_sha256 !== pins.candidate_sha256 ||
    input.migration_set_sha256 !== pins.migration_set_sha256 ||
    !Array.isArray(input.rows)
  )
    throw new Error('INVALID_RELEASE_PINS');
  const seen = new Set<number>();
  const rows = input.rows.map((row) => {
    object(row);
    keys(row, ['id', 'state', 'evidence']);
    if (
      !Number.isInteger(row.id) ||
      row.id < 1 ||
      row.id > 20 ||
      seen.has(row.id) ||
      ![
        'PASS',
        'FAIL',
        'NOT_RUN',
        'DISABLED',
        'UNAVAILABLE',
        'OBSERVING',
        'NOT_YET_MATURE',
      ].includes(row.state) ||
      !Array.isArray(row.evidence) ||
      row.evidence.length > 16
    )
      throw new Error('INVALID_RELEASE_ROW');
    seen.add(row.id);
    if (
      ['DISABLED', 'UNAVAILABLE'].includes(row.state) &&
      ![14, 15].includes(row.id)
    )
      throw new Error('REQUIRED_RELEASE_ROW_CANNOT_BE_DISABLED');
    if (['OBSERVING', 'NOT_YET_MATURE'].includes(row.state) && row.id !== 18)
      throw new Error('ONLY_CAPACITY_CAN_BE_IMMATURE');
    if (row.state !== 'NOT_RUN' && !row.evidence.length)
      throw new Error('RELEASE_EVIDENCE_REQUIRED');
    if (row.state === 'NOT_RUN' && row.evidence.length)
      throw new Error('NOT_RUN_HAS_RELEASE_EVIDENCE');
    for (const ref of row.evidence) {
      object(ref);
      keys(ref, ['path', 'sha256']);
      if (typeof ref.path !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256))
        throw new Error('INVALID_RELEASE_REFERENCE');
      const bytes = load(ref.path);
      if (bytes.length > 256 * 1024 || evidenceHash(bytes) !== ref.sha256)
        throw new Error('RELEASE_EVIDENCE_HASH_MISMATCH');
      const observation: unknown = strictJson(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
      object(observation);
      keys(observation, [
        'version',
        'row_id',
        'candidate_sha256',
        'migration_set_sha256',
        'state',
        'basis',
        'observed_at',
        'reason',
        'primary_evidence',
      ]);
      if (
        observation.version !== 'ReleaseObservation/1.0' ||
        observation.row_id !== row.id ||
        observation.state !== row.state ||
        observation.candidate_sha256 !== input.candidate_sha256 ||
        observation.migration_set_sha256 !== input.migration_set_sha256 ||
        observation.basis !== 'ACTUAL' ||
        typeof observation.observed_at !== 'string' ||
        !Number.isFinite(Date.parse(observation.observed_at)) ||
        Date.parse(observation.observed_at) > now.getTime() ||
        typeof observation.reason !== 'string' ||
        !/^[A-Z][A-Z0-9_]{1,100}$/.test(observation.reason) ||
        !Array.isArray(observation.primary_evidence) ||
        !observation.primary_evidence.length ||
        observation.primary_evidence.length > 16
      )
        throw new Error('INVALID_RELEASE_OBSERVATION');
      for (const primary of observation.primary_evidence) {
        object(primary);
        keys(primary, ['path', 'sha256']);
        if (
          typeof primary.path !== 'string' ||
          typeof primary.sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(primary.sha256) ||
          evidenceHash(load(primary.path)) !== primary.sha256
        )
          throw new Error('RELEASE_PRIMARY_EVIDENCE_MISMATCH');
      }
    }
    return {
      id: row.id,
      state: row.state,
      evidence_sha256: row.evidence.map((ref) => ref.sha256),
    };
  });
  for (let id = 1; id <= 20; id++)
    if (!seen.has(id)) rows.push({ id, state: 'NOT_RUN', evidence_sha256: [] });
  rows.sort((a, b) => a.id - b.id);
  const implementationComplete = rows.every((row) =>
    row.id === 18
      ? ['PASS', 'OBSERVING', 'NOT_YET_MATURE'].includes(row.state)
      : ['PASS', 'DISABLED', 'UNAVAILABLE'].includes(row.state),
  );
  return {
    version: 'ReleaseReport/1.0',
    status: rows.some((row) => row.state === 'FAIL')
      ? 'FAIL'
      : implementationComplete
        ? 'PASS'
        : 'NOT_RUN',
    implementation: implementationComplete ? 'COMPLETE' : 'INCOMPLETE',
    long_run_observation: rows.find((row) => row.id === 18)!.state,
    production_release_qualified:
      implementationComplete &&
      rows.find((row) => row.id === 18)!.state === 'PASS',
    candidate_sha256: input.candidate_sha256,
    migration_set_sha256: input.migration_set_sha256,
    evaluated_at: now.toISOString(),
    rows,
    deployed: false,
    paid_services_enabled: false,
  };
}
