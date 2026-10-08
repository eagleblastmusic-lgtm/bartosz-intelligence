import { expect, it } from 'vitest';
import {
  evaluateRecovery,
  recoveryCases,
  type GateRManifest,
} from '../../tools/gates/reliability/evaluate.js';
import { evidenceHash } from '../../tools/gates/drive-evidence.js';
const pins = {
  candidate_sha256: 'a'.repeat(64),
  migration_set_sha256: 'b'.repeat(64),
  migration_count: 35,
};
const now = new Date('2026-10-08T00:00:00Z');
function fixture() {
  const files = new Map<string, Uint8Array>();
  const add = (path: string, data: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    files.set(path, bytes);
    return { path, sha256: evidenceHash(bytes) };
  };
  const config = {
    version: 'GateRConfiguration/1.0',
    ...pins,
    target_origin: 'http://127.0.0.1:8791',
    isolated_database_id: 'isolated-fixture',
    production_database_id: 'production-fixture',
    owner_pseudonym: 'OWNER_A',
    paid_services_enabled: false,
  };
  const configuration = add('configuration.json', config);
  const baseline = add('baseline.json', {
    version: 'GateRBaseline/1.0',
    configuration_sha256: configuration.sha256,
    backup_sha256: 'c'.repeat(64),
    backup_receipt: add('backup.json', {
      version: 'portable-backup-drill:1',
      backup_sha256: 'c'.repeat(64),
      consistent_cut_seq: 100,
      migration_count: 35,
      independent_sqlite_restore: 'PASS',
      private_copy_readback: 'PASS',
      integrity_check: 'PASS',
      foreign_key_check: 'PASS',
      secret_values_recorded: false,
      active_sessions_restored: 0,
      active_worker_credentials_restored: 0,
    }),
    restore_verified: true,
    cut_seq: 100,
    counts: {
      items: 1,
      jobs: 1,
      analysis_runs: 0,
      evidence: 0,
      observations: 0,
    },
    origin_set_sha256: 'd'.repeat(64),
  });
  const manifest: GateRManifest = {
    version: 'GateRManifest/1.0',
    configuration,
    baseline,
    cases: [],
  };
  const receipt = (id: string) => ({
    version: 'GateRCase/1.0',
    case_id: id,
    configuration_sha256: configuration.sha256,
    baseline_sha256: baseline.sha256,
    kind: ['transcript_failure', 'drive_consumer_failure'].includes(id)
      ? 'ACTUAL_PROVIDER'
      : 'ACTUAL_LOCAL_D1',
    observed_at: now.toISOString(),
    result: 'PASS',
    lost_jobs: 0,
    duplicate_effects: 0,
    stale_writes: 0,
    origins_preserved: true,
    recovered: true,
    paid_requests: 0,
    recovery_elapsed_ms: 10,
  });
  const load = (path: string) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error('MISSING_FIXTURE');
    return bytes;
  };
  return { files, add, config, manifest, receipt, load };
}
it('missing drills remain NOT_RUN and a complete synthetic unit fixture evaluates all required cases', () => {
  const f = fixture();
  expect(evaluateRecovery(f.manifest, f.load, now, pins).status).toBe(
    'NOT_RUN',
  );
  f.manifest.cases = recoveryCases.map((id) => ({
    id,
    deadline_ms: 100,
    evidence: f.add(id + '.json', f.receipt(id)),
  }));
  const report = evaluateRecovery(f.manifest, f.load, now, pins);
  expect(report.status).toBe('PASS');
  expect(report.global_release_approved).toBe(false);
});
it.each([
  'lost_jobs',
  'duplicate_effects',
  'stale_writes',
  'paid_requests',
  'recovery_elapsed_ms',
] as const)(
  'rejects broken invariant %s even when observation declares PASS',
  (field) => {
    const f = fixture();
    const row = {
      ...f.receipt('lease_crash'),
      [field]: field === 'recovery_elapsed_ms' ? 101 : 1,
    };
    f.manifest.cases = [
      {
        id: 'lease_crash',
        deadline_ms: 100,
        evidence: f.add('case.json', row),
      },
    ];
    expect(evaluateRecovery(f.manifest, f.load, now, pins).status).toBe('FAIL');
  },
);
it('does not substitute simulation or local fixtures for actual provider recovery', () => {
  const f = fixture();
  f.manifest.cases = [
    {
      id: 'drive_consumer_failure',
      deadline_ms: 100,
      evidence: f.add('case.json', {
        ...f.receipt('drive_consumer_failure'),
        kind: 'SIMULATED',
      }),
    },
  ];
  expect(
    evaluateRecovery(f.manifest, f.load, now, pins).rows.find(
      (row) => row.id === 'drive_consumer_failure',
    )?.status,
  ).toBe('NOT_RUN');
});
it.each(['production', 'same-db', 'paid', 'candidate', 'migration'] as const)(
  'rejects unsafe or unpinned configuration (%s)',
  (scenario) => {
    const f = fixture();
    if (scenario === 'production')
      f.config.target_origin = 'https://example.test';
    if (scenario === 'same-db')
      f.config.isolated_database_id = f.config.production_database_id;
    if (scenario === 'paid') f.config.paid_services_enabled = true;
    if (scenario === 'candidate') f.config.candidate_sha256 = 'f'.repeat(64);
    if (scenario === 'migration')
      f.config.migration_set_sha256 = 'f'.repeat(64);
    f.manifest.configuration = f.add('configuration.json', f.config);
    expect(() => evaluateRecovery(f.manifest, f.load, now, pins)).toThrow();
  },
);
it('rejects changed receipts, duplicates and secret-bearing extra fields', () => {
  const f = fixture();
  const row = {
    id: 'lease_crash',
    deadline_ms: 100,
    evidence: f.add('case.json', f.receipt('lease_crash')),
  };
  f.manifest.cases = [row, row];
  expect(() => evaluateRecovery(f.manifest, f.load, now, pins)).toThrow(
    'INVALID_RECOVERY_CASE',
  );
  f.manifest.cases = [row];
  f.files.set('case.json', new TextEncoder().encode('{}'));
  expect(() => evaluateRecovery(f.manifest, f.load, now, pins)).toThrow(
    'RECOVERY_EVIDENCE_HASH_MISMATCH',
  );
  row.evidence = f.add('case.json', {
    ...f.receipt('lease_crash'),
    authorization: 'synthetic-canary',
  });
  expect(() => evaluateRecovery(f.manifest, f.load, now, pins)).toThrow(
    'INVALID_RECOVERY_SHAPE',
  );
});
it.each(['unverified', 'wrong-migration', 'active-credential'] as const)(
  'rejects an incompatible backup proof (%s)',
  (scenario) => {
    const f = fixture();
    const baseline = JSON.parse(
      new TextDecoder().decode(f.files.get('baseline.json')!),
    );
    const backup = JSON.parse(
      new TextDecoder().decode(f.files.get('backup.json')!),
    );
    if (scenario === 'unverified')
      backup.independent_sqlite_restore = 'NOT_RUN';
    if (scenario === 'wrong-migration') backup.migration_count = 34;
    if (scenario === 'active-credential')
      backup.active_worker_credentials_restored = 1;
    baseline.backup_receipt = f.add('backup.json', backup);
    f.manifest.baseline = f.add('baseline.json', baseline);
    expect(() => evaluateRecovery(f.manifest, f.load, now, pins)).toThrow(
      'VERIFIED_RECOVERY_BACKUP_RECEIPT_REQUIRED',
    );
  },
);
