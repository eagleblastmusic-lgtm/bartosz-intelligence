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
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import type {
  JobInput,
  LeaseToken,
} from '../../packages/contracts/src/jobs.js';
import { addSource } from '../../packages/core/src/sources/youtube/backfill.js';
beforeEach(resetCore);
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
    '/api/v1/jobs',
    '/api/v1/sources',
    '/api/v1/system/summary',
  ]) {
    const response = await request(path);
    expect(response.status).toBe(401);
    expect(response.headers.get('Content-Type')).toContain('application/json');
  }
  const response = await request('/internal/unknown');
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'NOT_FOUND' });
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
