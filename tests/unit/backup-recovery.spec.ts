import { expect, it } from 'vitest';
import {
  recoverBackupChunk,
  recoverBackupCompletion,
} from '../../tools/deployment/backup-recovery.js';
const expires = '2026-10-08T00:01:00Z',
  clock = () => Date.parse('2026-10-08T00:00:00Z');
it('retries an immutable chunk once and preserves its identity', async () => {
  let calls = 0;
  const chunk = { backup: 'isolated', table: 'jobs', cursor: 25 };
  expect(
    await recoverBackupChunk(
      async () => {
        if (++calls === 1) throw new Error('CLOUDFLARE_TRANSPORT_FAILED');
        return chunk;
      },
      expires,
      clock,
    ),
  ).toBe(chunk);
  expect(calls).toBe(2);
});
it.each([
  'CLOUDFLARE_REQUEST_FAILED_403_10000',
  'BACKUP_CHUNK_MISMATCH',
  'BACKUP_EXPIRED_OR_CLOSED',
  'CLOUDFLARE_REQUEST_FAILED_400_7500',
  'CLOUDFLARE_REQUEST_FAILED_400_7500_D1_SQL_INVALID',
  'CLOUDFLARE_REQUEST_FAILED_400_7500_D1_TOO_LARGE',
])('does not retry permanent or integrity failure %s', async (reason) => {
  let calls = 0;
  await expect(
    recoverBackupChunk(
      async () => {
        calls++;
        throw new Error(reason);
      },
      expires,
      clock,
    ),
  ).rejects.toThrow(reason);
  expect(calls).toBe(1);
});
it.each(['BUSY', 'TIMEOUT'])(
  'retries an explicitly classified D1 %s once for the same immutable chunk',
  async (category) => {
    let calls = 0;
    const retained = { cursor: 55 };
    expect(
      await recoverBackupChunk(
        async () => {
          if (++calls === 1)
            throw new Error(
              'CLOUDFLARE_REQUEST_FAILED_400_7500_D1_' + category,
            );
          return retained;
        },
        expires,
        clock,
      ),
    ).toBe(retained);
    expect(calls).toBe(2);
  },
);
it('exhausts one transient retry and never extends an expired barrier', async () => {
  let calls = 0;
  const fail = async () => {
    calls++;
    throw new Error('CLOUDFLARE_TRANSPORT_FAILED');
  };
  await expect(recoverBackupChunk(fail, expires, clock)).rejects.toThrow(
    'CLOUDFLARE_TRANSPORT_FAILED',
  );
  expect(calls).toBe(2);
  calls = 0;
  await expect(
    recoverBackupChunk(fail, expires, () => Date.parse(expires)),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});
it('reconciles committed completion after lost response without repeating the mutation', async () => {
  let mutations = 0;
  const manifest = { sha256: 'verified' };
  expect(
    await recoverBackupCompletion(
      async () => {
        mutations++;
        throw new Error('CLOUDFLARE_TRANSPORT_FAILED');
      },
      async () => manifest,
      expires,
      clock,
    ),
  ).toBe(manifest);
  expect(mutations).toBe(1);
});
it('retries completion only after readback proves it has not been verified', async () => {
  let mutations = 0;
  expect(
    await recoverBackupCompletion(
      async () => {
        if (++mutations === 1)
          throw new Error('CLOUDFLARE_REQUEST_FAILED_503_UNKNOWN');
        return 'verified';
      },
      async () => {
        throw new Error('BACKUP_NOT_VERIFIED');
      },
      expires,
      clock,
    ),
  ).toBe('verified');
  expect(mutations).toBe(2);
});
it('never repeats completion when reconciliation is unavailable', async () => {
  let mutations = 0;
  await expect(
    recoverBackupCompletion(
      async () => {
        mutations++;
        throw new Error('CLOUDFLARE_TRANSPORT_FAILED');
      },
      async () => {
        throw new Error('CLOUDFLARE_TRANSPORT_FAILED');
      },
      expires,
      clock,
    ),
  ).rejects.toThrow('CLOUDFLARE_TRANSPORT_FAILED');
  expect(mutations).toBe(1);
});
