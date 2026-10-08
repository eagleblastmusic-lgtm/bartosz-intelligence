import { expect, it } from 'vitest';
import {
  evaluateDriveGate,
  evidenceHash,
  type DriveGateInput,
  type GateObservation,
} from '../../tools/gates/drive-evidence.js';
const now = new Date('2026-10-08T14:00:00Z');
const configBytes = new TextEncoder().encode(
  JSON.stringify({
    version: 'drive-gate-config:1',
    gate: 'D_BRIDGE',
    owner_id: 'fixture-owner',
    connection_id: 'fixture-connection',
    root_id: 'fixture-root',
    renderer_version: '1.1',
    report_schema: '1.1',
    cut_seq: 1,
    scope_dates: ['2026-10-05'],
    consumer: {
      plan: 'fixture',
      workspace: 'fixture',
      model: 'fixture',
      chat: 'fixture',
    },
  }),
);
const configuration = evidenceHash(configBytes);
const load = (bytes: Uint8Array) => (path: string) =>
  path === 'configuration.json' ? configBytes : bytes;
const input = (): DriveGateInput => ({
  version: 'drive-gate-evidence:1',
  gate: 'D_BRIDGE',
  configuration_sha256: configuration,
  configuration_path: 'configuration.json',
  rows: [],
});
const actual = (): GateObservation => ({
  version: 'drive-gate-observation:1',
  kind: 'ACTUAL',
  configuration_sha256: configuration,
  check: 'scheduled_owner_root_access',
  observed_at: '2026-10-08T13:00:00Z',
  observer: 'OWNER_A',
  result: 'PASS',
  method: 'UNATTENDED_SCHEDULED',
  facts: {
    correct_owner_connection: true,
    correct_root: true,
    gui_closed: true,
    unattended_runs: 2,
    late_run: true,
  },
});
it('rejects altered frozen configuration before consuming observations', () => {
  expect(() =>
    evaluateDriveGate(input(), () => new TextEncoder().encode('{}'), now),
  ).toThrow('DRIVE_CONFIGURATION_HASH_MISMATCH');
});
it('export hash acceptance requires the full rendered and remote digest to match', () => {
  const exportConfiguration = new TextEncoder().encode(
    JSON.stringify({
      version: 'drive-gate-config:1',
      gate: 'D_EXPORT',
      owner_id: 'fixture-owner',
      connection_id: 'fixture-connection',
      root_id: 'fixture-root',
      renderer_version: '1.1',
      report_schema: '1.1',
      cut_seq: 1,
      scope_dates: ['2026-10-05'],
      consumer: null,
    }),
  );
  const hash = evidenceHash(exportConfiguration);
  const observed = {
    ...actual(),
    configuration_sha256: hash,
    check: 'complete_hash_counts_identity',
    method: 'PROVIDER_READBACK' as const,
    facts: {
      full_hash_match: true,
      body_hash_match: true,
      counts_match: true,
      root_file_date_match: true,
      rendered_sha256: 'c'.repeat(64),
      readback_sha256: 'd'.repeat(64),
      bytes: 1000,
    },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(observed));
  const gate: DriveGateInput = {
    ...input(),
    gate: 'D_EXPORT',
    configuration_sha256: hash,
    rows: [
      {
        id: observed.check,
        result: 'PASS',
        evidence: [{ path: 'observation.json', sha256: evidenceHash(bytes) }],
      },
    ],
  };
  expect(() =>
    evaluateDriveGate(
      gate,
      (path) => (path === 'configuration.json' ? exportConfiguration : bytes),
      now,
    ),
  ).toThrow('INVALID_DRIVE_HASH_READBACK');
});
it('missing actual receipts stays NOT_RUN with nine separate checks and no activation', () => {
  expect(evaluateDriveGate(input(), load(new Uint8Array()), now)).toMatchObject(
    {
      status: 'NOT_RUN',
      automatic_activation: false,
      performed_provider_requests: false,
    },
  );
  expect(
    evaluateDriveGate(input(), load(new Uint8Array()), now).rows,
  ).toHaveLength(9);
});
it.each([
  'valid',
  'mock',
  'hash',
  'scope',
  'method',
  'one-run',
  'future',
  'missing-fact',
  'secret',
  'duplicate',
  'unknown',
] as const)('rejects unqualified gate evidence (%s)', (scenario) => {
  const observed = actual();
  if (scenario === 'mock') observed.kind = 'SIMULATED';
  if (scenario === 'scope') observed.configuration_sha256 = 'b'.repeat(64);
  if (scenario === 'method') observed.method = 'PROVIDER_READBACK';
  if (scenario === 'one-run') observed.facts.unattended_runs = 1;
  if (scenario === 'future') observed.observed_at = '2026-10-09T13:00:00Z';
  if (scenario === 'missing-fact') delete observed.facts.gui_closed;
  if (scenario === 'secret')
    observed.facts.refresh_token = 'synthetic-forbidden';
  const bytes = new TextEncoder().encode(JSON.stringify(observed));
  const gate = input();
  gate.rows.push({
    id: observed.check,
    result: 'PASS',
    evidence: [
      {
        path: 'observation.json',
        sha256: scenario === 'hash' ? 'f'.repeat(64) : evidenceHash(bytes),
      },
    ],
  });
  if (scenario === 'duplicate') gate.rows.push(gate.rows[0]!);
  if (scenario === 'unknown') gate.rows[0]!.id = 'new_unregistered_check';
  const evaluate = () => evaluateDriveGate(gate, load(bytes), now);
  if (scenario === 'valid')
    expect(evaluate()).toMatchObject({ status: 'NOT_RUN' });
  else expect(evaluate).toThrow();
});
it('preserves actual FAIL independently from missing evidence and other gate', () => {
  const observed = actual();
  observed.result = 'FAIL';
  const bytes = new TextEncoder().encode(JSON.stringify(observed));
  const gate = input();
  gate.rows = [
    {
      id: observed.check,
      result: 'FAIL',
      evidence: [{ path: 'failed.json', sha256: evidenceHash(bytes) }],
    },
  ];
  expect(evaluateDriveGate(gate, load(bytes), now).status).toBe('FAIL');
  gate.gate = 'D_EXPORT';
  expect(() => evaluateDriveGate(gate, load(bytes), now)).toThrow();
});
