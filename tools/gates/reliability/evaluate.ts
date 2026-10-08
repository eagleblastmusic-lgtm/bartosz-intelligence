import { strictJson } from '../../../packages/core/src/ai/repair/strict-json.js';
import { evidenceHash } from '../drive-evidence.js';

export const recoveryCases = [
  'lease_crash',
  'queue_loss',
  'discovery_interruption',
  'database_rollback',
  'transcript_failure',
  'auth_revocation',
  'quota_local_offline',
  'malformed_ai',
  'model_prompt_rollback',
  'drive_consumer_failure',
] as const;
const providerCases = new Set(['transcript_failure', 'drive_consumer_failure']);
type Ref = { path: string; sha256: string };
export interface GateRManifest {
  version: 'GateRManifest/1.0';
  configuration: Ref;
  baseline: Ref;
  cases: { id: string; deadline_ms: number; evidence: Ref | null }[];
}
const digest = /^[a-f0-9]{64}$/;
function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_RECOVERY_EVIDENCE');
}
function shape(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(','))
    throw new Error('INVALID_RECOVERY_SHAPE');
}
function integer(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function referenced(ref: Ref, load: (path: string) => Uint8Array) {
  record(ref);
  shape(ref, ['path', 'sha256']);
  if (typeof ref.path !== 'string' || !digest.test(String(ref.sha256)))
    throw new Error('INVALID_RECOVERY_REFERENCE');
  const bytes = load(ref.path);
  if (bytes.byteLength > 256 * 1024 || evidenceHash(bytes) !== ref.sha256)
    throw new Error('RECOVERY_EVIDENCE_HASH_MISMATCH');
  const parsed: unknown = strictJson(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  );
  record(parsed);
  return parsed;
}

/** Evaluates recorded drills only; performs no injection or provider request. */
export function evaluateRecovery(
  manifest: GateRManifest,
  load: (path: string) => Uint8Array,
  now: Date,
  pins: {
    candidate_sha256: string;
    migration_set_sha256: string;
    migration_count: number;
  },
) {
  record(manifest);
  shape(manifest, ['version', 'configuration', 'baseline', 'cases']);
  if (
    manifest.version !== 'GateRManifest/1.0' ||
    !Array.isArray(manifest.cases)
  )
    throw new Error('INVALID_RECOVERY_MANIFEST');
  const configuration = referenced(manifest.configuration, load);
  shape(configuration, [
    'version',
    'candidate_sha256',
    'migration_set_sha256',
    'migration_count',
    'target_origin',
    'isolated_database_id',
    'production_database_id',
    'owner_pseudonym',
    'paid_services_enabled',
  ]);
  if (
    configuration.version !== 'GateRConfiguration/1.0' ||
    !digest.test(String(configuration.candidate_sha256)) ||
    !digest.test(String(configuration.migration_set_sha256)) ||
    configuration.paid_services_enabled !== false ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(String(configuration.owner_pseudonym)) ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(
      String(configuration.isolated_database_id),
    ) ||
    typeof configuration.production_database_id !== 'string' ||
    configuration.isolated_database_id === configuration.production_database_id
  )
    throw new Error('INVALID_RECOVERY_CONFIGURATION');
  if (
    configuration.candidate_sha256 !== pins.candidate_sha256 ||
    configuration.migration_set_sha256 !== pins.migration_set_sha256 ||
    configuration.migration_count !== pins.migration_count
  )
    throw new Error('RECOVERY_CANDIDATE_PINS_MISMATCH');
  let target: URL;
  try {
    target = new URL(String(configuration.target_origin));
  } catch {
    throw new Error('ISOLATED_RECOVERY_TARGET_REQUIRED');
  }
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    target.username ||
    target.password ||
    target.pathname !== '/' ||
    target.search ||
    target.hash
  )
    throw new Error('ISOLATED_RECOVERY_TARGET_REQUIRED');
  const baseline = referenced(manifest.baseline, load);
  shape(baseline, [
    'version',
    'configuration_sha256',
    'backup_sha256',
    'backup_receipt',
    'restore_verified',
    'cut_seq',
    'counts',
    'origin_set_sha256',
  ]);
  record(baseline.counts);
  shape(baseline.counts, [
    'items',
    'jobs',
    'analysis_runs',
    'evidence',
    'observations',
  ]);
  if (
    baseline.version !== 'GateRBaseline/1.0' ||
    baseline.configuration_sha256 !== manifest.configuration.sha256 ||
    !digest.test(String(baseline.backup_sha256)) ||
    baseline.restore_verified !== true ||
    !integer(baseline.cut_seq) ||
    !Object.values(baseline.counts).every(integer) ||
    !digest.test(String(baseline.origin_set_sha256))
  )
    throw new Error('VERIFIED_RECOVERY_BASELINE_REQUIRED');
  const backup = referenced(baseline.backup_receipt as Ref, load);
  if (
    backup.version !== 'portable-backup-drill:1' ||
    backup.backup_sha256 !== baseline.backup_sha256 ||
    backup.consistent_cut_seq !== baseline.cut_seq ||
    backup.migration_count !== pins.migration_count ||
    backup.independent_sqlite_restore !== 'PASS' ||
    backup.private_copy_readback !== 'PASS' ||
    backup.integrity_check !== 'PASS' ||
    backup.foreign_key_check !== 'PASS' ||
    backup.secret_values_recorded !== false ||
    backup.active_sessions_restored !== 0 ||
    backup.active_worker_credentials_restored !== 0
  )
    throw new Error('VERIFIED_RECOVERY_BACKUP_RECEIPT_REQUIRED');
  const seen = new Set<string>();
  const rows = manifest.cases.map((row) => {
    record(row);
    shape(row, ['id', 'deadline_ms', 'evidence']);
    if (
      !(recoveryCases as readonly string[]).includes(row.id) ||
      seen.has(row.id) ||
      !integer(row.deadline_ms) ||
      row.deadline_ms < 1 ||
      row.deadline_ms > 4 * 60 * 60 * 1000
    )
      throw new Error('INVALID_RECOVERY_CASE');
    seen.add(row.id);
    if (row.evidence === null)
      return { id: row.id, status: 'NOT_RUN', evidence_sha256: null };
    const actual = referenced(row.evidence, load);
    shape(actual, [
      'version',
      'case_id',
      'configuration_sha256',
      'baseline_sha256',
      'kind',
      'observed_at',
      'result',
      'lost_jobs',
      'duplicate_effects',
      'stale_writes',
      'origins_preserved',
      'recovered',
      'paid_requests',
      'recovery_elapsed_ms',
    ]);
    if (
      actual.version !== 'GateRCase/1.0' ||
      actual.case_id !== row.id ||
      actual.configuration_sha256 !== manifest.configuration.sha256 ||
      actual.baseline_sha256 !== manifest.baseline.sha256 ||
      !['ACTUAL_LOCAL_D1', 'ACTUAL_PROVIDER', 'SIMULATED'].includes(
        String(actual.kind),
      ) ||
      !['PASS', 'FAIL'].includes(String(actual.result)) ||
      typeof actual.observed_at !== 'string' ||
      !Number.isFinite(Date.parse(actual.observed_at)) ||
      Date.parse(actual.observed_at) > now.getTime() ||
      ![
        actual.lost_jobs,
        actual.duplicate_effects,
        actual.stale_writes,
        actual.paid_requests,
        actual.recovery_elapsed_ms,
      ].every(integer) ||
      typeof actual.origins_preserved !== 'boolean' ||
      typeof actual.recovered !== 'boolean'
    )
      throw new Error('INVALID_RECOVERY_OBSERVATION');
    const invariantFailed =
      actual.result === 'FAIL' ||
      actual.lost_jobs !== 0 ||
      actual.duplicate_effects !== 0 ||
      actual.stale_writes !== 0 ||
      actual.paid_requests !== 0 ||
      !actual.origins_preserved ||
      !actual.recovered ||
      (actual.recovery_elapsed_ms as number) > row.deadline_ms;
    const qualifiedKind = providerCases.has(row.id)
      ? actual.kind === 'ACTUAL_PROVIDER'
      : actual.kind === 'ACTUAL_LOCAL_D1';
    return {
      id: row.id,
      status: invariantFailed ? 'FAIL' : qualifiedKind ? 'PASS' : 'NOT_RUN',
      evidence_sha256: row.evidence.sha256,
    };
  });
  for (const id of recoveryCases)
    if (!seen.has(id))
      rows.push({ id, status: 'NOT_RUN', evidence_sha256: null });
  return {
    version: 'GateRReport/1.0',
    gate: 'R',
    status: rows.some((row) => row.status === 'FAIL')
      ? 'FAIL'
      : rows.every((row) => row.status === 'PASS')
        ? 'PASS'
        : 'NOT_RUN',
    configuration_sha256: manifest.configuration.sha256,
    baseline_sha256: manifest.baseline.sha256,
    evaluated_at: now.toISOString(),
    rows,
    provider_requests_performed: false,
    automatic_activation: false,
    global_release_approved: false,
  };
}
