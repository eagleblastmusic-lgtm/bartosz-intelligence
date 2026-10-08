import { expect, it } from 'vitest';
import {
  evaluateRelease,
  type ReleaseManifest,
} from '../../tools/release/evaluate.js';
import { evidenceHash } from '../../tools/gates/drive-evidence.js';
const pins = {
    candidate_sha256: 'a'.repeat(64),
    migration_set_sha256: 'b'.repeat(64),
  },
  now = new Date('2026-10-08T00:00:00Z');
function fixture() {
  const files = new Map<string, Uint8Array>();
  const add = (path: string, value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    files.set(path, bytes);
    return { path, sha256: evidenceHash(bytes) };
  };
  const primary = add('primary.json', { version: 'synthetic-unit-proof:1' });
  const manifest: ReleaseManifest = {
    version: 'ReleaseManifest/1.0',
    ...pins,
    paid_services_enabled: false,
    rows: [],
  };
  for (let id = 1; id <= 20; id++) {
    const state = id === 15 ? 'DISABLED' : id === 18 ? 'OBSERVING' : 'PASS';
    manifest.rows.push({
      id,
      state,
      evidence: [
        add(id + '.json', {
          version: 'ReleaseObservation/1.0',
          row_id: id,
          ...pins,
          state,
          basis: 'ACTUAL',
          observed_at: now.toISOString(),
          reason: 'SYNTHETIC_UNIT_FIXTURE',
          primary_evidence: [primary],
        }),
      ],
    });
  }
  const load = (path: string) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error('MISSING_FIXTURE');
    return bytes;
  };
  return { manifest, files, add, load };
}
it('separates implemented application from immature observation without claiming production qualification', () => {
  const f = fixture(),
    report = evaluateRelease(f.manifest, pins, f.load, now);
  expect(report.implementation).toBe('COMPLETE');
  expect(report.long_run_observation).toBe('OBSERVING');
  expect(report.production_release_qualified).toBe(false);
});
it('does not turn missing acceptance into complete implementation', () => {
  const f = fixture();
  f.manifest.rows = f.manifest.rows.filter((row) => row.id !== 13);
  expect(evaluateRelease(f.manifest, pins, f.load, now).implementation).toBe(
    'INCOMPLETE',
  );
});
it.each([9, 13, 16, 17])('cannot disable required acceptance row %s', (id) => {
  const f = fixture();
  f.manifest.rows.find((row) => row.id === id)!.state = 'DISABLED';
  expect(() => evaluateRelease(f.manifest, pins, f.load, now)).toThrow(
    'REQUIRED_RELEASE_ROW_CANNOT_BE_DISABLED',
  );
});
it('rejects wrong candidate pins, duplicate rows, changed evidence and simulated receipts', () => {
  const f = fixture();
  expect(() =>
    evaluateRelease(
      f.manifest,
      { ...pins, candidate_sha256: 'c'.repeat(64) },
      f.load,
      now,
    ),
  ).toThrow('INVALID_RELEASE_PINS');
  f.manifest.rows.push(f.manifest.rows[0]!);
  expect(() => evaluateRelease(f.manifest, pins, f.load, now)).toThrow(
    'INVALID_RELEASE_ROW',
  );
  f.manifest.rows.pop();
  f.files.set('1.json', new TextEncoder().encode('{}'));
  expect(() => evaluateRelease(f.manifest, pins, f.load, now)).toThrow(
    'RELEASE_EVIDENCE_HASH_MISMATCH',
  );
  const row = f.manifest.rows[0]!;
  row.evidence = [
    f.add('1.json', {
      version: 'ReleaseObservation/1.0',
      row_id: 1,
      ...pins,
      state: 'PASS',
      basis: 'SIMULATED',
      observed_at: now.toISOString(),
      reason: 'UNIT_FIXTURE',
      primary_evidence: [],
    }),
  ];
  expect(() => evaluateRelease(f.manifest, pins, f.load, now)).toThrow(
    'INVALID_RELEASE_OBSERVATION',
  );
});
