import { env } from 'cloudflare:workers';
import { it, expect, beforeEach } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import {
  LabQuotaPolicies,
  type LabQuotaPolicy,
} from '../../packages/core/src/registry/lab-quota.js';
import {
  QuotaAdmission,
  type AdmissionBucket,
} from '../../packages/core/src/ai/admission.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import type {
  Database,
  Statement,
} from '../../packages/core/src/db/boundary.js';
beforeEach(resetCore);
const policy: LabQuotaPolicy = {
  version: 'lab-quota:1',
  account_key: 'fixture-account',
  model: 'gemini-3.8-flash',
  daily_requests: 1,
  normal_headroom: { RPM: 1, RPD: 1, INPUT_TPM: 100 },
};
async function setup() {
  const owner = await fixtureOwner(),
    credential = await sha256('lab-fixture-worker');
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'lab-worker',
      'a',
      credential,
      '["ANALYZE"]',
      fixtureNow.toISOString(),
    )
    .run();
  const worker = await AccessContext.worker(env.DB, credential),
    store = new JobStore(env.DB, worker);
  const job = async (lab: boolean, nonce: string) => {
    const queued = (await new JobStore(env.DB, owner).enqueue(
      {
        item_id: null,
        source_id: null,
        task_type: 'ANALYZE',
        input_revision: 'fixture',
        profile_revision: 'fixture',
        prompt_snapshot_id: null,
        routing_policy_version: 'fixture-local',
        wire_schema_version: null,
        canonical_schema_version: null,
        enrichment_version: null,
        explicit_run_nonce: nonce,
        arrival_origin_at: fixtureNow.toISOString(),
        origin_kind: 'MANUAL',
        payload: {
          snapshot: {
            ...(lab
              ? { workload: 'PROMPT_LAB', lab_experiment_hash: 'a'.repeat(64) }
              : {}),
            settings: { mode: lab ? 'QUALITY_TEST' : 'PRODUCTION' },
          },
        },
        priority: lab ? 20 : 60,
        due_at: fixtureNow.toISOString(),
      },
      fixtureNow.toISOString(),
    ))!;
    const token = (await store.lease(
      queued.job_id,
      'ANALYZE',
      fixtureNow,
      'local',
    ))!;
    await store.start(token, 'ANALYZE', fixtureNow);
    return token;
  };
  const buckets: AdmissionBucket[] = [];
  for (const bucket of ['RPM', 'RPD', 'INPUT_TPM'] as const) {
    const row = {
      snapshot_id: bucket,
      bucket,
      window_start: fixtureNow.toISOString(),
      reset_at: new Date(fixtureNow.getTime() + 60000).toISOString(),
      remaining: bucket === 'INPUT_TPM' ? 1000 : 2,
      sampled_at: fixtureNow.toISOString(),
      expires_at: new Date(fixtureNow.getTime() + 60000).toISOString(),
      reserve: 0,
    };
    buckets.push(row);
    await env.DB.prepare(
      'INSERT INTO quota_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
      .bind(
        bucket,
        'a',
        'gemini',
        policy.model,
        bucket,
        bucket === 'INPUT_TPM' ? 'tokens' : 'requests',
        row.remaining,
        0,
        row.remaining,
        row.reset_at,
        'America/Los_Angeles',
        'dashboard',
        row.sampled_at,
        row.expires_at,
        'actual',
      )
      .run();
  }
  const input = {
    account_key: policy.account_key,
    model: policy.model,
    input_tokens: 100,
    buckets,
    paid_services_enabled: false,
  };
  return {
    owner,
    worker,
    job,
    input,
    admission: new QuotaAdmission(env.DB, worker),
    policies: new LabQuotaPolicies(env.DB, owner),
  };
}
it('requires explicit policy, preserves normal headroom and has one atomic Lab winner', async () => {
  const s = await setup(),
    first = await s.job(true, 'a'),
    second = await s.job(true, 'b'),
    normal = await s.job(false, 'normal');
  await expect(
    s.admission.reserve(
      { ...s.input, request_id: 'missing-policy' },
      first,
      fixtureNow,
    ),
  ).rejects.toThrow('QUOTA_LAB_POLICY_NOT_CONFIGURED');
  await s.policies.save(policy, 0, 'Reserve for normal processing', fixtureNow);
  const outcomes = await Promise.allSettled([
    s.admission.reserve({ ...s.input, request_id: 'first' }, first, fixtureNow),
    s.admission.reserve(
      { ...s.input, request_id: 'second' },
      second,
      fixtureNow,
    ),
  ]);
  expect(
    outcomes.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  const stored = await env.DB.prepare(
    'SELECT snapshots_json FROM quota_reservations',
  ).first<string>('snapshots_json');
  expect(
    JSON.parse(stored!).map(
      (bucket: { reserve: number; lab_policy_revision: number }) => [
        bucket.reserve,
        bucket.lab_policy_revision,
      ],
    ),
  ).toEqual([
    [1, 1],
    [1, 1],
    [100, 1],
  ]);
  await expect(
    s.admission.reserve(
      { ...s.input, request_id: 'normal' },
      normal,
      fixtureNow,
    ),
  ).resolves.toHaveProperty('reservation_id');
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM quota_reservations').first(
      'n',
    ),
  ).toBe(2);
});
it('headroom remains protected even with a larger Lab allowance and policy races fail closed', async () => {
  const s = await setup();
  await s.policies.save(
    { ...policy, daily_requests: 10 },
    0,
    'Large test budget',
    fixtureNow,
  );
  const normal = await s.job(false, 'normal-first'),
    lab = await s.job(true, 'lab-after-normal');
  await s.admission.reserve(
    { ...s.input, request_id: 'normal-first' },
    normal,
    fixtureNow,
  );
  await expect(
    s.admission.reserve(
      { ...s.input, request_id: 'lab-after-normal' },
      lab,
      fixtureNow,
    ),
  ).rejects.toThrow('QUOTA_ADMISSION_DENIED');
  // Give the isolated race ample global capacity; only the policy CAS may deny it.
  for (const bucket of s.input.buckets)
    if (bucket.bucket !== 'INPUT_TPM') {
      bucket.remaining = 20;
      await env.DB.prepare(
        'UPDATE quota_snapshots SET remaining=20,limit_value=20 WHERE snapshot_id=?',
      )
        .bind(bucket.snapshot_id)
        .run();
    }
  const database: Database = env.DB;
  const wrap = (statement: Statement): Statement => ({
    bind: (...values) => wrap(statement.bind(...values)),
    first: statement.first.bind(statement),
    all: statement.all.bind(statement),
    run: async () => {
      await s.policies.save(
        { ...policy, daily_requests: 0 },
        1,
        'Pause before atomic insert',
        fixtureNow,
      );
      return statement.run();
    },
  });
  const race: Database = {
    prepare: (sql) =>
      sql.startsWith('INSERT INTO quota_reservations')
        ? wrap(database.prepare(sql))
        : database.prepare(sql),
    batch: database.batch.bind(database),
  };
  await expect(
    new QuotaAdmission(race, s.worker).reserve(
      { ...s.input, request_id: 'raced' },
      lab,
      fixtureNow,
    ),
  ).rejects.toThrow('QUOTA_ADMISSION_DENIED');
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM quota_reservations').first(
      'n',
    ),
  ).toBe(1);
});
it('unknown actual usage still consumes the Lab allowance', async () => {
  const s = await setup();
  await s.policies.save(policy, 0, 'Protect capacity', fixtureNow);
  const token = await s.job(true, 'unknown'),
    next = await s.job(true, 'next');
  const permit = await s.admission.reserve(
    { ...s.input, request_id: 'unknown' },
    token,
    fixtureNow,
  );
  await s.admission.submit(permit.reservation_id, token, fixtureNow);
  await s.admission.reconcile(
    permit.reservation_id,
    {
      request_id: 'unknown',
      status: 'TEMPORARY_FAILURE',
      raw_output: null,
      actual_provider: 'gemini',
      actual_model: null,
      finish_reason: 'TRANSPORT_FAILURE',
      usage: { input_tokens: null, output_tokens: null, total_tokens: null },
      retry_after: null,
    },
    fixtureNow,
  );
  await expect(
    s.admission.reserve({ ...s.input, request_id: 'next' }, next, fixtureNow),
  ).rejects.toThrow('QUOTA_ADMISSION_DENIED');
  expect(
    await env.DB.prepare(
      'SELECT state FROM quota_reservations WHERE reservation_id=?',
    )
      .bind(permit.reservation_id)
      .first('state'),
  ).toBe('UNKNOWN');
});
it('durable cancellation fences both reservation and the last pre-HTTP submit boundary', async () => {
  const s = await setup();
  await s.policies.save(policy, 0, 'Protect normal work', fixtureNow);
  const token = await s.job(true, 'cancel'),
    later = await s.job(true, 'later');
  const permit = await s.admission.reserve(
    { ...s.input, request_id: 'cancel' },
    token,
    fixtureNow,
  );
  const serialized = JSON.stringify({ reason: 'Owner cancelled' });
  await env.DB.prepare('INSERT INTO config_versions VALUES(?,?,1,?,?,?)')
    .bind(
      'prompt-lab-cancel-' + 'a'.repeat(64),
      'a',
      serialized,
      await sha256(serialized),
      fixtureNow.toISOString(),
    )
    .run();
  await expect(
    s.admission.submit(permit.reservation_id, token, fixtureNow),
  ).rejects.toThrow('RESERVATION_NOT_SUBMITTABLE');
  await expect(
    s.admission.reserve({ ...s.input, request_id: 'later' }, later, fixtureNow),
  ).rejects.toThrow('QUOTA_ADMISSION_DENIED');
  expect(
    await env.DB.prepare(
      'SELECT state FROM quota_reservations WHERE reservation_id=?',
    )
      .bind(permit.reservation_id)
      .first('state'),
  ).toBe('RESERVED');
});
it('policy revisions are owner-only, immutable, retry-safe and account-specific', async () => {
  const s = await setup();
  const saved = await s.policies.save(
    policy,
    0,
    'Protect capacity',
    fixtureNow,
  );
  expect(
    await s.policies.save(
      policy,
      0,
      'Protect capacity',
      new Date(fixtureNow.getTime() + 1000),
    ),
  ).toEqual(saved);
  await expect(
    new LabQuotaPolicies(env.DB, s.worker).save(
      policy,
      1,
      'worker cannot change',
      fixtureNow,
    ),
  ).rejects.toThrow('FORBIDDEN');
  await expect(
    s.policies.save({ ...policy, daily_requests: 2 }, 0, 'stale', fixtureNow),
  ).rejects.toThrow('REGISTRY_GENERATION_CONFLICT');
  expect(
    await new LabQuotaPolicies(env.DB, await fixtureOwner('b')).current(),
  ).toBeNull();
  const token = await s.job(true, 'wrong-account');
  await expect(
    s.admission.reserve(
      { ...s.input, account_key: 'other', request_id: 'other' },
      token,
      fixtureNow,
    ),
  ).rejects.toThrow('QUOTA_LAB_ACCOUNT_MISMATCH');
  await s.policies.save(
    { ...policy, daily_requests: 0 },
    1,
    'Pause laboratory',
    fixtureNow,
  );
  await expect(
    s.admission.reserve(
      { ...s.input, request_id: 'paused' },
      token,
      fixtureNow,
    ),
  ).rejects.toThrow('QUOTA_ADMISSION_DENIED');
});
