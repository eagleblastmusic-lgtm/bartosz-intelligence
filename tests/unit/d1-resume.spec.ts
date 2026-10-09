import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import {
  d1ProbeSql,
  probeAdmission,
  probeD1Availability,
} from '../../tools/deployment/d1-resume-policy.js';
const now = new Date('2026-10-10T00:00:00.000Z');
it('waits until the actual UTC boundary and prevents repeated attempts that day', () => {
  expect(probeAdmission(new Date(now.getTime() - 1), false)).toBe(
    'WAITING_RESET',
  );
  expect(probeAdmission(now, false)).toBe('PROBE_DUE');
  expect(probeAdmission(now, true)).toBe('ALREADY_ATTEMPTED');
  expect(() => probeAdmission(new Date('invalid'), false)).toThrow(
    'INVALID_PROBE_CLOCK',
  );
});
it('uses a primary-key table lookup rather than a constant expression or table scan', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'CREATE TABLE owner_users(owner_id TEXT PRIMARY KEY,allowlisted INTEGER NOT NULL)',
    );
    const plan = db
      .prepare('EXPLAIN QUERY PLAN ' + d1ProbeSql)
      .all('private-owner');
    expect(plan.map((row) => row.detail).join(' ')).toContain(
      'SEARCH owner_users USING INDEX',
    );
    expect(db.prepare(d1ProbeSql).get('private-owner')).toBeUndefined();
  } finally {
    db.close();
  }
});
it('records measured row metadata without claiming account headroom', async () => {
  let requests = 0;
  const receipt = await probeD1Availability(
    'private-owner',
    async (sql, params) => {
      requests++;
      expect(sql).toBe(d1ProbeSql);
      expect(params).toEqual(['private-owner']);
      return [
        { results: [{ readable: 1 }], meta: { rows_read: 1, rows_written: 0 } },
      ];
    },
    now,
  );
  expect(requests).toBe(1);
  expect(receipt).toMatchObject({
    state: 'AVAILABLE',
    rows_read: 1,
    rows_written: 0,
    account_remaining_rows: null,
    paid_services_enabled: false,
  });
  expect(JSON.stringify(receipt)).not.toContain('private-owner');
});
it.each(['READ', 'WRITE'])(
  'does not retry a daily %s limit',
  async (category) => {
    let calls = 0;
    const receipt = await probeD1Availability(
      'owner',
      async () => {
        calls++;
        throw new Error(
          'CLOUDFLARE_REQUEST_FAILED_400_7500_D1_DAILY_' + category + '_LIMIT',
        );
      },
      now,
    );
    expect(calls).toBe(1);
    expect(receipt.state).toBe('QUOTA_BLOCKED');
  },
);
it.each([
  { rows_read: 0, rows_written: 0 },
  { rows_read: 5, rows_written: 0 },
  { rows_read: 1, rows_written: 1 },
  {},
])('fails closed on missing or excessive metadata: %j', async (meta) => {
  expect(
    (
      await probeD1Availability(
        'owner',
        async () => [{ results: [{ readable: 1 }], meta }],
        now,
      )
    ).state,
  ).toBe('FAILED');
});
it('redacts unclassified provider text and does not retry an ambiguous transport failure', async () => {
  let calls = 0;
  const result = await probeD1Availability(
    'owner',
    async () => {
      calls++;
      throw new Error('private query owner secret body');
    },
    now,
  );
  expect(calls).toBe(1);
  expect(result.reason).toBe('D1_PROBE_FAILED');
  expect(JSON.stringify(result)).not.toContain('secret');
});
