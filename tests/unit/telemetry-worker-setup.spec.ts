import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  local: 'APP_ORIGIN=https://example.test\n',
  workers: [] as {
    owner_id: string;
    credential_hash: string;
    scopes_json: string;
    revoked_at: string | null;
  }[],
  writes: 0,
  inserts: 0,
  owners: [{ owner_id: 'owner-a' }],
}));
vi.mock('node:fs', async () => ({
  ...(await vi.importActual('node:fs')),
  readFileSync: () => state.local,
  writeFileSync: (_path: string, value: string) => {
    state.local = value;
    state.writes++;
  },
}));
vi.mock('../../tools/deployment/cloudflare.mjs', () => ({
  query: async (sql: string, values?: string[]) => {
    if (sql.startsWith('SELECT owner_id FROM owner_users'))
      return [{ results: state.owners }];
    if (sql.startsWith('SELECT owner_id,credential_hash'))
      return [{ results: state.workers }];
    if (sql.startsWith('INSERT INTO worker_identities')) {
      expect(state.local).toContain('LOCAL_TELEMETRY_WORKER_CREDENTIAL=');
      expect(values?.[0]).toBe('capacity-observer');
      state.workers.push({
        owner_id: values![1]!,
        credential_hash: values![2]!,
        scopes_json: values![3]!,
        revoked_at: null,
      });
      state.inserts++;
      return [{ results: [] }];
    }
    throw new Error('UNEXPECTED_SETUP_QUERY');
  },
}));
const argv = process.argv;
beforeEach(() => {
  vi.resetModules();
  state.local = 'APP_ORIGIN=https://example.test\n';
  state.workers = [];
  state.writes = state.inserts = 0;
  state.owners = [{ owner_id: 'owner-a' }];
  process.argv = ['node', 'prepare.mjs', 'telemetry-worker'];
  vi.stubEnv('LOCAL_TELEMETRY_WORKER_CREDENTIAL', 'a'.repeat(43));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  process.argv = argv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('persists a recoverable credential before registering only PROJECT and resumes without rotation', async () => {
  await import('../../tools/deployment/prepare.mjs');
  expect(state.workers[0]?.scopes_json).toBe('["PROJECT"]');
  expect(console.log).toHaveBeenCalledWith(
    JSON.stringify({
      telemetry_worker_registered: true,
      scopes: ['PROJECT'],
      private_credential_readback: true,
      observation_started: false,
    }),
  );
  vi.resetModules();
  await import('../../tools/deployment/prepare.mjs');
  expect(state.writes).toBe(1);
  expect(state.inserts).toBe(1);
});

it('does not rotate a revoked identity', async () => {
  await import('../../tools/deployment/prepare.mjs');
  state.workers[0]!.revoked_at = '2026-10-08T12:00:00Z';
  vi.resetModules();
  await expect(import('../../tools/deployment/prepare.mjs')).rejects.toThrow(
    'TELEMETRY_CREDENTIAL_RECOVERY_REQUIRED',
  );
  expect(state.writes).toBe(1);
  expect(state.inserts).toBe(1);
});

it('rejects mismatched owner, scope and private recovery copy without changing identity', async () => {
  await import('../../tools/deployment/prepare.mjs');
  const original = { ...state.workers[0]! };
  const privateCopy = state.local;
  for (const mismatch of ['owner', 'scope', 'private-copy']) {
    state.workers = [{ ...original }];
    state.local = privateCopy;
    if (mismatch === 'owner') state.workers[0]!.owner_id = 'another-owner';
    if (mismatch === 'scope') state.workers[0]!.scopes_json = '["ANALYZE"]';
    if (mismatch === 'private-copy')
      state.local = 'APP_ORIGIN=https://example.test\n';
    vi.resetModules();
    await expect(import('../../tools/deployment/prepare.mjs')).rejects.toThrow(
      'TELEMETRY_CREDENTIAL_RECOVERY_REQUIRED',
    );
    expect(state.writes).toBe(1);
    expect(state.inserts).toBe(1);
  }
});

it('denies duplicate private configuration before registering an identity', async () => {
  state.local +=
    'LOCAL_TELEMETRY_WORKER_CREDENTIAL=' +
    'a'.repeat(43) +
    '\nLOCAL_TELEMETRY_WORKER_CREDENTIAL=' +
    'b'.repeat(43) +
    '\n';
  await expect(import('../../tools/deployment/prepare.mjs')).rejects.toThrow(
    'DUPLICATE_TELEMETRY_CONFIGURATION',
  );
  expect(state.writes).toBe(0);
  expect(state.inserts).toBe(0);
});
