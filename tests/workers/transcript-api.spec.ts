import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import worker from '../../apps/api/src/index.js';
import application from '../../config/application.json';
import { resetCore, fixtureSecret } from './core-fixture.js';
import { issueSession } from '../../packages/core/src/auth/session.js';
import {
  base64url,
  decode64,
  sha256,
} from '../../packages/core/src/auth/crypto.js';

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
async function intake(
  headers: Record<string, string>,
  locator = 'aircAruvnKk',
) {
  const response = await request('/api/v1/jobs/transcript', headers, {
    locator,
  });
  expect(response.status).toBe(201);
  return response.json<{
    item_id: string;
    job_id: string;
    state: string;
    video_id: string;
  }>();
}

it('single-video intake requires owner/CSRF, accepts URLs and IDs, and deduplicates jobs without a channel subscription', async () => {
  expect(
    (
      await request(
        '/api/v1/jobs/transcript',
        {
          Origin: application.app_origin,
          'X-CSRF-Token': 'fixture',
        },
        { locator: 'aircAruvnKk' },
      )
    ).status,
  ).toBe(401);
  const headers = await ownerHeaders();
  expect(
    (
      await request(
        '/api/v1/jobs/transcript',
        { ...headers, 'X-CSRF-Token': '' },
        { locator: 'aircAruvnKk' },
      )
    ).status,
  ).toBe(403);
  const first = await intake(headers);
  for (const locator of [
    'https://www.youtube.com/watch?v=aircAruvnKk&t=3',
    'https://youtu.be/aircAruvnKk?si=fixture',
    'https://m.youtube.com/shorts/aircAruvnKk',
  ]) {
    expect(await intake(headers, locator)).toEqual(first);
  }
  expect(first).toMatchObject({ state: 'PENDING', video_id: 'aircAruvnKk' });
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM jobs').first('n')).toBe(
    1,
  );
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM channels').first('n'),
  ).toBe(0);
  expect(
    await env.DB.prepare('SELECT enabled FROM sources').first('enabled'),
  ).toBe(0);
  const metadata = JSON.parse(
    (await env.DB.prepare(
      'SELECT metadata_json FROM item_revisions',
    ).first<string>('metadata_json'))!,
  );
  expect(metadata).toMatchObject({
    availability: 'UNKNOWN',
    duration_seconds: null,
    publication_provenance: 'USER_SUBMITTED',
  });
  const other = await intake(await ownerHeaders('b'));
  expect(other.item_id).not.toBe(first.item_id);
  expect(
    (await request(`/api/v1/items/${first.item_id}/transcript`, headers))
      .status,
  ).toBe(404);
});

it('owner replays a transcript after reauthentication without duplicating the job or unblocking other access refusals', async () => {
  const headers = await ownerHeaders(),
    first = await intake(headers);
  await env.DB.prepare(
    "INSERT INTO worker_identities VALUES('replay-fixture','a','replay-fixture-hash','[\"FETCH_TRANSCRIPT\"]',?,NULL)",
  )
    .bind(new Date().toISOString())
    .run();
  const block = async (reason: string) => {
    await env.DB.prepare(
      "UPDATE jobs SET state='LEASED',lease_owner='replay-fixture',lease_until=? WHERE job_id=?",
    )
      .bind(new Date(Date.now() + 60000).toISOString(), first.job_id)
      .run();
    await env.DB.prepare("UPDATE jobs SET state='RUNNING' WHERE job_id=?")
      .bind(first.job_id)
      .run();
    await env.DB.prepare(
      "UPDATE jobs SET state='BLOCKED',reason_code=?,lease_owner=NULL,lease_until=NULL WHERE job_id=?",
    )
      .bind(reason, first.job_id)
      .run();
  };
  await block('LOCAL_YTDLP_AUTH_REQUIRED');
  expect(
    (
      await request(
        `/api/v1/jobs/${first.job_id}/replay`,
        await ownerHeaders('b'),
        {},
      )
    ).status,
  ).toBe(409);
  expect(
    (await request(`/api/v1/jobs/${first.job_id}/replay`, headers, {})).status,
  ).toBe(200);
  expect(await intake(headers)).toMatchObject({
    job_id: first.job_id,
    state: 'PENDING',
  });
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM jobs').first('n')).toBe(
    1,
  );
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM audit_events WHERE event_type='JOB_REPLAY'",
    ).first('n'),
  ).toBe(1);
  await block('LOCAL_YTDLP_REGION_BLOCKED');
  expect(
    (await request(`/api/v1/jobs/${first.job_id}/replay`, headers, {})).status,
  ).toBe(409);
});

it('single-video intake rejects foreign, ambiguous, credential and non-HTTPS URLs before storage', async () => {
  const headers = await ownerHeaders();
  for (const locator of [
    'https://example.test/watch?v=aircAruvnKk',
    'http://www.youtube.com/watch?v=aircAruvnKk',
    'https://name:secret@www.youtube.com/watch?v=aircAruvnKk',
    'https://www.youtube.com/watch?v=aircAruvnKk&v=uEztHu4NHrs',
    'https://www.youtube.com/@TED',
    'invalid',
  ]) {
    expect(
      (await request('/api/v1/jobs/transcript', headers, { locator })).status,
    ).toBe(422);
  }
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM jobs').first('n')).toBe(
    0,
  );
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM items').first('n')).toBe(
    0,
  );
});

it('owner reads accepted original text and timestamp map without an AI run; foreign owner and corrupt pages are denied', async () => {
  const headers = await ownerHeaders(),
    { item_id: item, job_id: job } = await intake(headers);
  const at = new Date().toISOString(),
    source = 'source-fixture',
    map = 'segments-fixture';
  const text = 'First cue\nSecond cue',
    mapText = JSON.stringify({
      anchors: [{ start_ms: 0, end_ms: 1000, text: 'First cue' }],
    });
  for (const [id, kind, payload, original] of [
    [source, 'SOURCE_ORIGINAL', text, null],
    [map, 'SEGMENT_MAP', mapText, source],
  ] as const) {
    const hash = await sha256(payload),
      bytes = new TextEncoder().encode(payload);
    await env.DB.prepare(
      "INSERT INTO artifacts(artifact_id,owner_id,item_id,kind,content_hash,byte_size,chunk_count,schema_version,producer_version,provenance_json,original_ref,state,manifest_hash,created_at,verified_at) VALUES(?,'a',?,?,?,?,1,'fixture:1','fixture','{}',?,'VERIFIED',?,?,?)",
    )
      .bind(id, item, kind, hash, bytes.length, original, hash, at, at)
      .run();
    await env.DB.prepare(
      "INSERT INTO artifact_chunks VALUES('a',?,?,0,0,?,?,?,?)",
    )
      .bind(item, id, bytes.length, hash, `d1:${id}/0`, base64url(bytes))
      .run();
  }
  const outcome = {
    version: 'transcript-source:1',
    source_artifact_id: source,
    segment_map_artifact_id: map,
    source_hash: await sha256(text),
    authority: { language_code: 'en', track_kind: 'MANUAL' },
    warnings: [],
  };
  await env.DB.prepare(
    "INSERT INTO analysis_runs(run_id,owner_id,item_id,job_id,input_snapshot_json,profile_snapshot_json,routing_snapshot_json,state,outcome_json,created_at,accepted_at) VALUES('source-run','a',?,?,'{}','{}','{}','ACCEPTED',?,?,?)",
  )
    .bind(item, job, JSON.stringify(outcome), at, at)
    .run();
  await env.DB.prepare(
    "INSERT INTO worker_identities VALUES('fixture','a',?,'[\"FETCH_TRANSCRIPT\"]',?,NULL)",
  )
    .bind(await sha256('fixture-worker-credential'), at)
    .run();
  await env.DB.prepare(
    "UPDATE jobs SET state='LEASED',lease_owner='fixture',lease_until=? WHERE job_id=?",
  )
    .bind(new Date(Date.now() + 60000).toISOString(), job)
    .run();
  await env.DB.prepare("UPDATE jobs SET state='RUNNING' WHERE job_id=?")
    .bind(job)
    .run();
  await env.DB.prepare("UPDATE jobs SET state='SUCCEEDED' WHERE job_id=?")
    .bind(job)
    .run();
  for (const [kind, expected] of [
    ['source', text],
    ['segments', mapText],
  ]) {
    const response = await request(
      `/api/v1/items/${item}/transcript?kind=${kind}`,
      headers,
    );
    expect(response.status).toBe(200);
    const page = await response.json<{
      chunks: { body_base64: string }[];
      next_index: number | null;
    }>();
    expect(
      new TextDecoder().decode(decode64(page.chunks[0]!.body_base64)),
    ).toBe(expected);
    expect(page.next_index).toBeNull();
  }
  expect(
    (await request(`/api/v1/items/${item}/transcript`, await ownerHeaders('b')))
      .status,
  ).toBe(404);
  expect(
    (await request(`/api/v1/items/${item}/transcript?kind=raw`, headers))
      .status,
  ).toBe(422);
  const corrupt = 'corrupt-source',
    badHash = await sha256(text);
  await env.DB.prepare(
    "INSERT INTO artifacts(artifact_id,owner_id,item_id,kind,content_hash,byte_size,chunk_count,schema_version,producer_version,provenance_json,original_ref,state,manifest_hash,created_at,verified_at) VALUES(?,'a',?,'SOURCE_ORIGINAL',?,3,1,'fixture:1','corrupt','{}',NULL,'VERIFIED',?,?,?)",
  )
    .bind(corrupt, item, badHash, badHash, at, at)
    .run();
  await env.DB.prepare(
    "INSERT INTO artifact_chunks VALUES('a',?,?,0,0,3,?,?,?)",
  )
    .bind(item, corrupt, badHash, `d1:${corrupt}/0`, 'YmFk')
    .run();
  await env.DB.prepare(
    "INSERT INTO analysis_runs(run_id,owner_id,item_id,job_id,input_snapshot_json,profile_snapshot_json,routing_snapshot_json,state,outcome_json,created_at,accepted_at) VALUES('corrupt-run','a',?,?,'{}','{}','{}','ACCEPTED',?,?,?)",
  )
    .bind(
      item,
      job,
      JSON.stringify({ ...outcome, source_artifact_id: corrupt }),
      at,
      new Date(Date.parse(at) + 1000).toISOString(),
    )
    .run();
  expect(
    (await request(`/api/v1/items/${item}/transcript`, headers)).status,
  ).toBe(500);
});
