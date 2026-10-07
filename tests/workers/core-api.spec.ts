import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { beforeEach, it, expect } from 'vitest';
import worker from '../../apps/api/src/index.js';
import {
  resetCore,
  fixtureSecret,
  fixtureOwner,
  fixtureNow,
} from './core-fixture.js';
import application from '../../config/application.json';
import { issueSession } from '../../packages/core/src/auth/session.js';
import { randomToken, sha256 } from '../../packages/core/src/auth/crypto.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import type {
  JobInput,
  LeaseToken,
} from '../../packages/contracts/src/jobs.js';
import { addSource } from '../../packages/core/src/sources/youtube/backfill.js';
beforeEach(resetCore);
it('Lab quota API requires owner/CSRF and records immutable bounded policies without AI work', async () => {
  const headers = await ownerHeaders(),
    path = '/api/v1/prompts/lab/quota';
  const input = {
    account_key: 'fixture-project',
    model: 'gemini-3.8-flash',
    daily_requests: 1,
    normal_headroom: { RPM: 1, RPD: 2, INPUT_TPM: 100 },
    expected_revision: 0,
    reason: 'Protect normal processing',
  };
  expect((await request(path)).status).toBe(401);
  const noCsrf = { ...headers };
  delete (noCsrf as Record<string, string>)['X-CSRF-Token'];
  expect((await request(path, noCsrf, input)).status).toBe(403);
  expect(
    (await request(path, headers, { ...input, paid_services_enabled: true }))
      .status,
  ).toBe(422);
  expect(
    (
      await request(path, headers, {
        ...input,
        normal_headroom: { RPM: 0, RPD: 2, INPUT_TPM: 100 },
      })
    ).status,
  ).toBe(422);
  const saved = await request(path, headers, input);
  expect(saved.status).toBe(200);
  const receipt = await saved.json();
  expect(receipt).toMatchObject({ revision: 1, policy: { daily_requests: 1 } });
  expect(await (await request(path, headers, input)).json()).toEqual(receipt);
  expect(
    await (await request(path, await ownerHeaders('b'))).json(),
  ).toBeNull();
  expect(
    (await request(path, headers, { ...input, daily_requests: 3 })).status,
  ).toBe(409);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM jobs').first('n')).toBe(
    0,
  );
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM quota_reservations').first(
      'n',
    ),
  ).toBe(0);
});
it('profile API protects previews and immutable versions without starting provider work', async () => {
  const headers = await ownerHeaders();
  const config = {
    mode: 'CUSTOM',
    modules: {
      summary: true,
      key_points: false,
      entities: false,
      tools: false,
      claims: false,
      stance: false,
      predictions: false,
      usage: false,
      recommendations: false,
      uncertainties: false,
      contradictions: true,
    },
    translation: 'NONE',
    history: false,
    second_pass: null,
    validation_pass: null,
  };
  expect((await request('/api/v1/profiles', {})).status).toBe(401);
  const noCsrf: Record<string, string> = { ...headers };
  delete noCsrf['X-CSRF-Token'];
  expect(
    (await request('/api/v1/profiles/preview', noCsrf, { config })).status,
  ).toBe(403);
  const preview = await request('/api/v1/profiles/preview', headers, {
    config,
  });
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({
    config,
    request_estimate: { minimum: 1, exact: false },
  });
  const input = {
    profile_id: 'monitor',
    revision: 1,
    name: 'Monitoring',
    config,
    reason: 'Owner scope',
  };
  expect(
    (
      await request('/api/v1/profiles/versions', headers, {
        ...input,
        owner_id: 'b',
      })
    ).status,
  ).toBe(422);
  expect(
    (await request('/api/v1/profiles/versions', headers, input)).status,
  ).toBe(200);
  expect(
    (
      await request('/api/v1/profiles/versions', headers, {
        ...input,
        name: 'Conflict',
      })
    ).status,
  ).toBe(409);
  expect(
    (await request('/api/v1/profiles/monitor/1', await ownerHeaders('b')))
      .status,
  ).toBe(404);
  expect(
    await (await request('/api/v1/profiles', headers)).json(),
  ).toMatchObject({
    profiles: [{ name: 'Monitoring', revision: 1 }],
    has_more: false,
  });
  expect(
    (
      await request('/api/v1/profiles/preview', headers, {
        config: { ...config, translation: ['FULL', 'IMPORTANT_SEGMENTS'] },
      })
    ).status,
  ).toBe(422);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM jobs').first('n')).toBe(
    0,
  );
});
it('search API is private, validates literal queries and protects rebuild with CSRF', async () => {
  const headers = await ownerHeaders();
  expect((await request('/api/v1/search?q=hello', {})).status).toBe(401);
  const result = await request('/api/v1/search?q=hello', headers);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    documents: [],
    freshness: 'UNKNOWN',
  });
  expect(
    (await request('/api/v1/search?q=hello&owner_id=b', headers)).status,
  ).toBe(422);
  expect((await request('/api/v1/search?q=*', headers)).status).toBe(422);
  const noCsrf: Record<string, string> = { ...headers };
  delete noCsrf['X-CSRF-Token'];
  expect((await request('/api/v1/search/rebuild', noCsrf, {})).status).toBe(
    403,
  );
  expect((await request('/api/v1/search/rebuild', headers, {})).status).toBe(
    200,
  );
  expect(
    await (await request('/api/v1/search/status', headers)).json(),
  ).toMatchObject({ freshness: 'BUILDING' });
  expect(
    await (
      await request('/api/v1/search/status', await ownerHeaders('b'))
    ).json(),
  ).toMatchObject({ freshness: 'UNKNOWN' });
});
it('organization API keeps Spaces owner scoped and guards mutations with CSRF and revisions', async () => {
  const headers = await ownerHeaders(),
    space_id = crypto.randomUUID();
  const input = {
    space_id,
    name: 'Research',
    active: true,
    expected_revision: 0,
    mutation_id: crypto.randomUUID(),
  };
  const noCsrf: Record<string, string> = { ...headers };
  delete noCsrf['X-CSRF-Token'];
  expect(
    (await request('/api/v1/organization/spaces', noCsrf, input)).status,
  ).toBe(403);
  expect(
    (
      await request('/api/v1/organization/spaces', headers, {
        ...input,
        owner_id: 'b',
      })
    ).status,
  ).toBe(422);
  expect(
    (await request('/api/v1/organization/spaces', headers, input)).status,
  ).toBe(200);
  const replay = await request('/api/v1/organization/spaces', headers, input);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ duplicate: true });
  expect(
    (
      await request('/api/v1/organization/spaces', headers, {
        ...input,
        name: 'Other',
        mutation_id: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  const own = await request('/api/v1/organization/spaces', headers);
  expect(await own.json()).toMatchObject({
    spaces: [{ space_id, name: 'Research' }],
  });
  const foreign = await request(
    '/api/v1/organization/spaces',
    await ownerHeaders('b'),
  );
  expect(await foreign.json()).toMatchObject({ spaces: [] });
});
it('identity preview/confirmation requires owner CSRF and correction writes retain immutable source labels', async () => {
  const headers = await ownerHeaders();
  for (const id of ['identity-a', 'identity-b'])
    await env.DB.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?)')
      .bind('a', id, id, 'TOOL', 'UNRESOLVED_LITERAL', fixtureNow.toISOString())
      .run();
  const input = {
    action: 'MERGE',
    source_entity_id: 'identity-a',
    target_entity_id: 'identity-b',
    reason: 'Owner confirmed identities',
    parent_event_id: null,
  };
  const preview = await request(
    '/api/v1/entities/identity-preview',
    headers,
    input,
  );
  expect(preview.status).toBe(200);
  const proposal = await preview.json();
  const noCsrf: Record<string, string> = { ...headers };
  delete noCsrf['X-CSRF-Token'];
  expect(
    (await request('/api/v1/entities/identity-confirm', noCsrf, proposal))
      .status,
  ).toBe(403);
  expect(
    (
      await request(
        '/api/v1/entities/identity-confirm',
        await ownerHeaders('b'),
        proposal,
      )
    ).status,
  ).toBe(404);
  expect(
    (await request('/api/v1/entities/identity-confirm', headers, proposal))
      .status,
  ).toBe(200);
  const target = await request(
    '/api/v1/corrections/ENTITY_LABEL/identity-a',
    headers,
  );
  const metadata = (await target.json()) as {
    target_hash: string;
    original_value: string;
  };
  const correction = {
    expected_revision: 0,
    target_hash: metadata.target_hash,
    old_value: metadata.original_value,
    new_value: 'Authored interpretation',
    action: 'APPLY',
    reason: 'Owner annotation',
    correction_id: crypto.randomUUID(),
  };
  expect(
    (
      await request(
        '/api/v1/corrections/ENTITY_LABEL/identity-a',
        noCsrf,
        correction,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        '/api/v1/corrections/ENTITY_LABEL/identity-a',
        headers,
        correction,
      )
    ).status,
  ).toBe(200);
  expect(
    await env.DB.prepare(
      "SELECT label FROM entities WHERE entity_id='identity-a'",
    ).first('label'),
  ).toBe('identity-a');
});
it('alias mutations require owner CSRF, preserve revision conflicts and reject unexpected fields', async () => {
  const headers = await ownerHeaders();
  await env.DB.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?)')
    .bind(
      'a',
      'alias-test',
      'Claude',
      'TOOL',
      'UNRESOLVED_LITERAL',
      fixtureNow.toISOString(),
    )
    .run();
  const path = '/api/v1/entities/alias-test/aliases';
  const input = {
    literal: 'Claude',
    reason: 'Confirmed by owner',
    language: null,
    action: 'APPROVE',
    expected_revision: 0,
    decision_id: crypto.randomUUID(),
  };
  const noCsrf: Record<string, string> = { ...headers };
  delete noCsrf['X-CSRF-Token'];
  expect((await request(path, noCsrf, input)).status).toBe(403);
  expect((await request(path, await ownerHeaders('b'), input)).status).toBe(
    404,
  );
  const approved = await request(path, headers, input);
  expect(approved.status).toBe(200);
  expect(await approved.json()).toMatchObject({
    revision: 1,
    duplicate: false,
  });
  expect(await (await request(path, headers, input)).json()).toMatchObject({
    revision: 1,
    duplicate: true,
  });
  expect(
    (
      await request(path, headers, {
        ...input,
        decision_id: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect(
    (await request(path, headers, { ...input, secret: 'unexpected' })).status,
  ).toBe(422);
});
it('capacity metadata endpoint authenticates and enforces PROJECT scope and strict bounded queries', async () => {
  const path = '/internal/workers/capacity-observation';
  expect((await request(path)).status).toBe(401);
  const headers = await credential(['ANALYZE']);
  expect((await request(path, headers)).status).toBe(403);
  await env.DB.prepare(
    'UPDATE worker_identities SET scopes_json=? WHERE worker_id=?',
  )
    .bind('["PROJECT"]', 'test-worker')
    .run();
  const response = await request(path, headers);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    cases: [],
    next_cursor: null,
    eligibility_status: 'UNCLASSIFIED',
  });
  expect((await request(path + '?limit=51', headers)).status).toBe(422);
  expect((await request(path + '?unknown=1', headers)).status).toBe(422);
  expect((await request(path + '?cursor=malformed', headers)).status).toBe(422);
});
it('System distinguishes task completion from accepted analysis and retains failed arrival age without fabricating capacity', async () => {
  const owner = await fixtureOwner(),
    headers = await ownerHeaders(),
    store = new JobStore(env.DB, owner);
  const completed = (await store.enqueue(
    { ...base, task_type: 'DISCOVER', explicit_run_nonce: crypto.randomUUID() },
    fixtureNow.toISOString(),
  ))!;
  const failed = (await store.enqueue(
    {
      ...base,
      arrival_origin_at: '2026-10-01T00:00:00.000Z',
      explicit_run_nonce: crypto.randomUUID(),
    },
    fixtureNow.toISOString(),
  ))!;
  const workerHeaders = await credential(['DISCOVER', 'FETCH_TRANSCRIPT']);
  const workerStore = new JobStore(
    env.DB,
    await AccessContext.worker(
      env.DB,
      await sha256(workerHeaders.Authorization.slice(7)),
    ),
  );
  const completedLease = (await workerStore.lease(
    completed.job_id,
    'DISCOVER',
    fixtureNow,
    'local',
  ))!;
  await workerStore.start(completedLease, 'DISCOVER', fixtureNow);
  await env.DB.prepare(
    "UPDATE jobs SET state='SUCCEEDED',lease_owner=NULL,lease_until=NULL WHERE job_id=?",
  )
    .bind(completed.job_id)
    .run();
  const failedLease = (await workerStore.lease(
    failed.job_id,
    'FETCH_TRANSCRIPT',
    fixtureNow,
    'local',
  ))!;
  await workerStore.start(failedLease, 'FETCH_TRANSCRIPT', fixtureNow);
  await workerStore.disposition(
    failedLease,
    'FETCH_TRANSCRIPT',
    'FAILED',
    'NO_CAPTIONS',
    fixtureNow.toISOString(),
    fixtureNow,
  );
  const before = await env.DB.prepare(
    'SELECT COUNT(*) n FROM change_log',
  ).first();
  const response = await request('/api/v1/system/summary', headers);
  expect(response.status).toBe(200);
  const data = (await response.json()) as {
    capacity: {
      accepted_count: number;
      succeeded_jobs_count: number;
      open_count: number;
      oldest_open_arrival_origin_at: string;
    };
    capacity_metrics: { metrics: Record<string, { value: number | null }> };
    job_reasons: { reason_code: string }[];
    costs: { status: string };
    transcript_coverage: { denominator: number };
  };
  expect(data.capacity).toMatchObject({
    accepted_count: 0,
    succeeded_jobs_count: 1,
    open_count: 1,
    oldest_open_arrival_origin_at: '2026-10-01T00:00:00.000Z',
  });
  expect(data.job_reasons[0]?.reason_code).toBe('NO_CAPTIONS');
  expect(Object.keys(data.capacity_metrics.metrics)).toHaveLength(8);
  for (const metric of Object.values(data.capacity_metrics.metrics))
    expect(metric.value).toBeNull();
  expect(data.costs.status).toBe('PAID_DISABLED');
  expect(data.transcript_coverage.denominator).toBe(0);
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM change_log').first(),
  ).toEqual(before);
  expect(
    (await request('/api/v1/system/summary?arbitrary=1', headers)).status,
  ).toBe(422);
});
const settings = {
  ...env,
  GOOGLE_OIDC_CLIENT_ID: 'fixture-client',
  GOOGLE_OIDC_CLIENT_SECRET: 'fixture-secret',
  GOOGLE_OIDC_OWNER_SUBJECT: 'subject-a',
  SESSION_SIGNING_SECRET: fixtureSecret,
};
async function ownerHeaders(owner = 'a') {
  const session = await issueSession(
    env.DB,
    { issuer: 'https://accounts.google.com', subject: `subject-${owner}` },
    fixtureSecret,
    new Date(),
  );
  return {
    Cookie: session.cookie.split(';')[0]!,
    Origin: application.app_origin,
    'X-CSRF-Token': session.csrf,
    'Content-Type': 'application/json',
  };
}
function request(
  path: string,
  headers: Record<string, string> = {},
  input?: unknown,
) {
  return worker.fetch(
    new Request(application.app_origin + path, {
      method: input === undefined ? 'GET' : 'POST',
      headers,
      body: input === undefined ? undefined : JSON.stringify(input),
    }),
    settings,
    createExecutionContext(),
  );
}
const base: JobInput = {
  item_id: null,
  source_id: null,
  task_type: 'FETCH_TRANSCRIPT',
  input_revision: 'test',
  profile_revision: 'economy-1',
  prompt_snapshot_id: null,
  routing_policy_version: 'local-primary-1',
  wire_schema_version: null,
  canonical_schema_version: null,
  enrichment_version: null,
  explicit_run_nonce: '',
  arrival_origin_at: fixtureNow.toISOString(),
  origin_kind: 'NEW',
  payload: {},
  priority: 80,
  due_at: fixtureNow.toISOString(),
};
async function credential(scopes = ['FETCH_TRANSCRIPT']) {
  const value = randomToken();
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'test-worker',
      'a',
      await sha256(value),
      JSON.stringify(scopes),
      fixtureNow.toISOString(),
    )
    .run();
  return {
    Authorization: `Bearer ${value}`,
    'Content-Type': 'application/json',
  };
}
it('owner routes require auth before domain reads and never fall through to HTML', async () => {
  for (const path of [
    '/api/v1/items',
    '/api/v1/ledger',
    '/api/v1/entities',
    '/api/v1/entities/missing',
    '/api/v1/corrections/ENTITY_LABEL/missing',
    '/api/v1/items/missing/detail',
    '/api/v1/items/missing/canonical?run_id=missing',
    '/api/v1/evidence/missing?run_id=missing',
    '/api/v1/daily?date=2026-10-05',
    '/api/v1/daily/calendar?month=2026-10',
    '/api/v1/daily/undated',
    '/api/v1/jobs',
    '/api/v1/sources',
    '/api/v1/sources/missing/progress',
    '/api/v1/system/summary',
    '/api/v1/organization/spaces',
    '/api/v1/organization/items/missing',
    '/api/v1/backup/missing/manifest',
  ]) {
    const response = await request(path);
    expect(response.status).toBe(401);
    expect(response.headers.get('Content-Type')).toContain('application/json');
  }
  const response = await request('/internal/unknown');
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'NOT_FOUND' });
});
it('Daily GET contracts reject invalid fields, worker auth and foreign cursors without creating work', async () => {
  await fixtureOwner();
  const headers = await ownerHeaders();
  for (const path of [
    '/api/v1/daily?date=2026-02-29',
    '/api/v1/daily?date=2026-10-05&timezone=UTC',
    '/api/v1/daily?date=2026-10-05&limit=51',
    '/api/v1/daily?date=2026-10-05&date=2026-10-06',
    '/api/v1/daily/calendar?month=2026-13',
    '/api/v1/daily/calendar?month=2026-10&timezone=UTC',
    '/api/v1/daily/undated?date=2026-10-05',
  ])
    expect((await request(path, headers)).status).toBe(422);
  const before = await env.DB.prepare('SELECT COUNT(*) n FROM jobs').first('n');
  for (const path of [
    '/api/v1/daily?date=2026-10-05',
    '/api/v1/daily/calendar?month=2026-10',
    '/api/v1/daily/undated',
  ]) {
    const response = await request(path, headers);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toContain('application/json');
  }
  expect(
    (
      await request(
        '/api/v1/daily?date=2026-10-05',
        await credential(['ANALYZE']),
      )
    ).status,
  ).toBe(401);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM jobs').first('n')).toBe(
    before,
  );
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM usage_records').first('n'),
  ).toBe(0);
});
it('backup requires owner CSRF, rejects worker access, and remains closed before verification', async () => {
  await fixtureOwner();
  const headers = await ownerHeaders();
  expect(
    (await request('/api/v1/backup', { ...headers, 'X-CSRF-Token': '' }, {}))
      .status,
  ).toBe(403);
  expect(
    (
      await request(
        '/api/v1/backup',
        {
          ...(await credential()),
          Origin: application.app_origin,
          'X-CSRF-Token': 'fixture',
        },
        {},
      )
    ).status,
  ).toBe(401);
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM backup_snapshots').first('n'),
  ).toBe(0);
  const begun = await request('/api/v1/backup', headers, {});
  expect(begun.status).toBe(201);
  const { backup_id } = (await begun.json()) as { backup_id: string };
  expect(
    (await request(`/api/v1/backup/${backup_id}/manifest`, headers)).status,
  ).toBe(409);
  expect(
    (
      await request(
        `/api/v1/backup/${backup_id}/chunk?table=owner_sessions`,
        headers,
      )
    ).status,
  ).toBe(422);
  expect(
    (await request(`/api/v1/backup/${backup_id}/abort`, headers, {})).status,
  ).toBe(200);
  expect(
    await env.DB.prepare('SELECT barrier_token FROM maintenance_state').first(
      'barrier_token',
    ),
  ).toBeNull();
});
it('owner listing is bounded, owner-scoped and filter cursors cannot be repurposed', async () => {
  const a = await fixtureOwner(),
    b = await fixtureOwner('b');
  const first = (await new JobStore(env.DB, a).enqueue(
    base,
    fixtureNow.toISOString(),
  ))!;
  await new JobStore(env.DB, a).enqueue(
    { ...base, input_revision: 'another' },
    fixtureNow.toISOString(),
  );
  const foreign = (await new JobStore(env.DB, b).enqueue(
    base,
    fixtureNow.toISOString(),
  ))!;
  const headers = await ownerHeaders(),
    response = await request('/api/v1/jobs?limit=1', headers),
    page = (await response.json()) as {
      jobs: { job_id: string }[];
      next_cursor: string;
    };
  expect(page.jobs).toHaveLength(1);
  expect(page.jobs[0]!.job_id).not.toBe(foreign.job_id);
  expect((await request(`/api/v1/jobs/${first.job_id}`, headers)).status).toBe(
    200,
  );
  expect(
    (await request(`/api/v1/jobs/${foreign.job_id}`, headers)).status,
  ).toBe(404);
  expect((await request('/api/v1/jobs?limit=51', headers)).status).toBe(422);
  expect((await request('/api/v1/jobs?limit=1&limit=2', headers)).status).toBe(
    422,
  );
  expect(
    (
      await request(
        `/api/v1/jobs?cursor=${encodeURIComponent(page.next_cursor)}&state=PENDING`,
        headers,
      )
    ).status,
  ).toBe(422);
  expect(
    (
      await request(
        `/api/v1/jobs?cursor=${encodeURIComponent(page.next_cursor)}`,
        await ownerHeaders('b'),
      )
    ).status,
  ).toBe(422);
  const next = await request(
    `/api/v1/jobs?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`,
    headers,
  );
  expect(next.status).toBe(200);
});
it('source disable requires bound CSRF and records owner audit without removing history', async () => {
  const owner = await fixtureOwner(),
    source = (await new SourceRepository(env.DB, owner).upsert(
      {
        namespace: 'youtube',
        external_id: 'UC' + 'a'.repeat(22),
        canonical_locator:
          'https://www.youtube.com/channel/UC' + 'a'.repeat(22),
        title: 'Fixture',
        uploads_playlist_id: 'UU' + 'a'.repeat(22),
        handle: '@fixture',
      },
      fixtureNow.toISOString(),
    ))!;
  const headers = await ownerHeaders();
  expect(
    (
      await request(
        `/api/v1/sources/${source.source_id}/disable`,
        { ...headers, 'X-CSRF-Token': '' },
        {},
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        `/api/v1/sources/${source.source_id}/disable`,
        { ...headers, Origin: 'https://evil.example' },
        {},
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(`/api/v1/sources/${source.source_id}/disable`, headers, {
        unrecognized: true,
      })
    ).status,
  ).toBe(422);
  expect(
    (await request(`/api/v1/sources/${source.source_id}/disable`, headers, {}))
      .status,
  ).toBe(200);
  const listing = await request('/api/v1/sources', headers);
  expect(listing.status).toBe(200);
  expect(await listing.json()).toMatchObject({ sources: [{ enabled: 0 }] });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE event_type='SOURCE_DISABLED'",
    ).first('n'),
  ).toBe(1);
});
it('rejects malformed and oversized input with secret-free errors', async () => {
  const headers = await ownerHeaders();
  const oversized = await request('/api/v1/sources/resolve', headers, {
    locator: 'z'.repeat(70000),
  });
  expect(oversized.status).toBe(422);
  const malformed = await worker.fetch(
    new Request(application.app_origin + '/api/v1/sources/resolve', {
      method: 'POST',
      headers,
      body: '{',
    }),
    settings,
    createExecutionContext(),
  );
  expect(malformed.status).toBe(422);
  expect(await malformed.json()).toMatchObject({ code: 'INVALID_BODY' });
  const summary = await request('/api/v1/system/summary', headers);
  expect(summary.status).toBe(200);
  const data = await summary.json();
  expect(data).toMatchObject({
    quota: [],
    provider_health: [],
    workers: [],
    unobserved_provider_status: 'UNKNOWN',
    paid_services_enabled: false,
    outbox: { pending: 0, oldest_due_at: null },
    backup: { last_verified_at: null },
    capacity: {
      arrival_count: 0,
      service_rate: null,
      service_rate_status: 'NOT_CALIBRATED',
    },
    database_usage: { status: 'UNKNOWN', storage_bytes: null },
  });
  expect(JSON.stringify(data)).not.toContain(fixtureSecret);
});
it('worker mutations enforce task scope and stale fence; rotated credentials fail closed', async () => {
  const job = (await new JobStore(env.DB, await fixtureOwner()).enqueue(
      base,
      fixtureNow.toISOString(),
    ))!,
    headers = await credential();
  expect(
    (
      await request('/internal/workers/lease', headers, {
        runtime: 'local',
        task_type: 'ANALYZE',
        job_id: job.job_id,
      })
    ).status,
  ).toBe(403);
  const leased = await request('/internal/workers/lease', headers, {
    runtime: 'local',
    task_type: 'FETCH_TRANSCRIPT',
    job_id: job.job_id,
  });
  expect(leased.status).toBe(200);
  const lease = ((await leased.json()) as { leases: { token: LeaseToken }[] })
    .leases[0]!.token;
  expect(
    (
      await request('/internal/workers/start', headers, {
        task_type: 'FETCH_TRANSCRIPT',
        token: { ...lease, fencing_token: lease.fencing_token + 1 },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await request('/internal/workers/start', headers, {
        task_type: 'FETCH_TRANSCRIPT',
        token: lease,
      })
    ).status,
  ).toBe(200);
  // The Stage 02 boundary cannot accept arbitrary unvalidated analysis/transcript payloads.
  expect(
    (
      await request('/internal/workers/complete', headers, {
        task_type: 'FETCH_TRANSCRIPT',
        token: lease,
      })
    ).status,
  ).toBe(503);
  expect(
    (
      await request('/internal/workers/heartbeat', headers, {
        runtime: 'local',
        task_type: 'FETCH_TRANSCRIPT',
        token: lease,
      })
    ).status,
  ).toBe(200);
  const summary = await request('/api/v1/system/summary', await ownerHeaders());
  expect(await summary.json()).toMatchObject({
    workers: [{ availability: 'ONLINE', runtime: 'local' }],
  });
  await env.DB.prepare(
    'UPDATE worker_identities SET credential_hash=? WHERE worker_id=?',
  )
    .bind(await sha256(randomToken()), 'test-worker')
    .run();
  expect(
    (
      await request('/internal/workers/heartbeat', headers, {
        runtime: 'local',
        task_type: 'FETCH_TRANSCRIPT',
        token: lease,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request('/internal/workers/lease', await ownerHeaders(), {
        runtime: 'local',
      })
    ).status,
  ).toBe(401);
});
it('worker retry policy preserves immutable arrival clock and does not permit reason injection', async () => {
  const job = (await new JobStore(env.DB, await fixtureOwner()).enqueue(
      base,
      fixtureNow.toISOString(),
    ))!,
    headers = await credential();
  const leased = await request('/internal/workers/lease', headers, {
      runtime: 'local',
      task_type: 'FETCH_TRANSCRIPT',
      job_id: job.job_id,
    }),
    lease = ((await leased.json()) as { leases: { token: LeaseToken }[] })
      .leases[0]!.token;
  await request('/internal/workers/start', headers, {
    task_type: 'FETCH_TRANSCRIPT',
    token: lease,
  });
  expect(
    (
      await request('/internal/workers/retry', headers, {
        task_type: 'FETCH_TRANSCRIPT',
        token: lease,
        code: 'secret-string',
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await request('/internal/workers/retry', headers, {
        task_type: 'FETCH_TRANSCRIPT',
        token: lease,
        code: 'TRANSIENT',
      })
    ).status,
  ).toBe(200);
  expect(
    await env.DB.prepare(
      'SELECT state,arrival_origin_at,origin_kind FROM jobs WHERE job_id=?',
    )
      .bind(job.job_id)
      .first(),
  ).toMatchObject({
    state: 'RETRY_WAIT',
    arrival_origin_at: fixtureNow.toISOString(),
    origin_kind: 'NEW',
  });
});
it('model eligibility deferral is durable, fenced and limited to analysis tasks', async () => {
  const owner = await fixtureOwner();
  const headers = await credential(['ANALYZE', 'FETCH_TRANSCRIPT']);
  for (const type of ['FETCH_TRANSCRIPT', 'ANALYZE'] as const) {
    const job = (await new JobStore(env.DB, owner).enqueue(
      { ...base, task_type: type },
      fixtureNow.toISOString(),
    ))!;
    const leased = await request('/internal/workers/lease', headers, {
      runtime: 'local',
      task_type: type,
      job_id: job.job_id,
    });
    const lease = ((await leased.json()) as { leases: { token: LeaseToken }[] })
      .leases[0]!.token;
    await request('/internal/workers/start', headers, {
      task_type: type,
      token: lease,
    });
    const due = new Date(Date.now() + 900000).toISOString();
    const payload = {
      task_type: type,
      token: lease,
      reason: 'MODEL_NOT_ELIGIBLE',
      due_at: due,
    };
    if (type === 'FETCH_TRANSCRIPT') {
      expect(
        (await request('/internal/workers/defer', headers, payload)).status,
      ).toBe(422);
      continue;
    }
    expect(
      (
        await request('/internal/workers/defer', headers, {
          ...payload,
          token: { ...lease, fencing_token: lease.fencing_token + 1 },
        })
      ).status,
    ).toBe(409);
    expect(
      (await request('/internal/workers/defer', headers, payload)).status,
    ).toBe(200);
    expect(
      await env.DB.prepare(
        'SELECT state,reason_code,due_at,lease_owner,arrival_origin_at FROM jobs WHERE job_id=?',
      )
        .bind(job.job_id)
        .first(),
    ).toMatchObject({
      state: 'DEFERRED',
      reason_code: 'MODEL_NOT_ELIGIBLE',
      due_at: due,
      lease_owner: null,
      arrival_origin_at: fixtureNow.toISOString(),
    });
    expect(
      (await request('/internal/workers/defer', headers, payload)).status,
    ).toBe(409);
  }
});
it('control execution stays below the Free D1 query budget and duplicate completion has no second effect', async () => {
  const owner = await fixtureOwner(),
    identity = {
      namespace: 'youtube' as const,
      external_id: 'UC' + 'q'.repeat(22),
      uploads_playlist_id: 'UU' + 'q'.repeat(22),
      canonical_locator: 'https://www.youtube.com/channel/UC' + 'q'.repeat(22),
      title: 'Fixture',
      handle: '@fixture',
    };
  const intent = await addSource(
    env.DB,
    owner,
    identity,
    'core-api-discovery',
    {
      window_start: '2026-09-05T17:30:00.000Z',
      window_end: fixtureNow.toISOString(),
    },
    fixtureNow,
  );
  const candidates = Array.from({ length: 8 }, (_, index) => ({
    namespace: 'youtube',
    external_id: String(index).padStart(11, '0'),
    item_type: 'unknown',
    canonical_url: `https://www.youtube.com/watch?v=${String(index).padStart(11, '0')}`,
    title: 'Fixture',
    published_at: '2026-10-01T00:00:00.000Z',
    publication_provenance: 'videos.snippet.publishedAt',
    availability: 'PUBLIC',
    duration_seconds: 60,
  }));
  await env.DB.prepare(
    'UPDATE discovery_scans SET staged_page_json=?,staged_page_hash=?,staged_next_cursor=NULL WHERE job_id=?',
  )
    .bind(
      JSON.stringify(candidates),
      await sha256(JSON.stringify(candidates)),
      intent.job_id,
    )
    .run();
  const headers = await credential(['DISCOVER', 'RECONCILE']);
  let queries = 0;
  const metered = {
    prepare(sql: string) {
      queries++;
      return env.DB.prepare(sql);
    },
    batch: env.DB.batch.bind(env.DB),
  } as typeof env.DB;
  const configuration = {
    ...settings,
    DB: metered,
    CONTROL_WORKER_CREDENTIAL: headers.Authorization.slice(7),
    YOUTUBE_API_KEY: 'fixture-only-no-network',
  };
  const tick = () =>
    worker.fetch(
      new Request(application.app_origin + '/internal/workers/control-tick', {
        method: 'POST',
        headers,
        body: '{}',
      }),
      configuration,
      createExecutionContext(),
    );
  const first = await tick();
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ coverage: 'PARTIAL' });
  expect(queries).toBeLessThanOrEqual(50);
  queries = 0;
  const second = await tick();
  expect(second.status).toBe(200);
  expect(await second.json()).toMatchObject({ coverage: 'COMPLETE' });
  expect(queries).toBeLessThanOrEqual(50);
  const completed = await env.DB.prepare(
    'SELECT job_id,fencing_token FROM jobs WHERE job_id=?',
  )
    .bind(intent.job_id)
    .first<{ job_id: string; fencing_token: number }>();
  const lease: LeaseToken = {
    ...completed!,
    lease_owner: 'test-worker',
    lease_until: new Date().toISOString(),
  };
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE task_type='FETCH_TRANSCRIPT'",
    ).first('n'),
  ).toBe(8);
  const repeated = await worker.fetch(
    new Request(application.app_origin + '/internal/workers/complete', {
      method: 'POST',
      headers,
      body: JSON.stringify({ task_type: 'DISCOVER', token: lease }),
    }),
    configuration,
    createExecutionContext(),
  );
  expect(repeated.status).toBe(200);
  expect(await repeated.json()).toMatchObject({
    state: 'SUCCEEDED',
    already_completed: true,
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE task_type='FETCH_TRANSCRIPT'",
    ).first('n'),
  ).toBe(8);
});
