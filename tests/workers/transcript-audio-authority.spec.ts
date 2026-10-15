import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../../apps/api/src/index.js';
import { resetCore, fixtureOwner, fixtureSecret } from './core-fixture.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { ItemRepository } from '../../packages/core/src/db/items.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import application from '../../config/application.json';

beforeEach(resetCore);
afterEach(() => vi.restoreAllMocks());

async function inputRequest() {
  const now = new Date(),
    owner = await fixtureOwner();
  const source = (await new SourceRepository(env.DB, owner).upsert(
    {
      namespace: 'youtube',
      external_id: 'UC-fixture',
      canonical_locator: 'https://www.youtube.com/channel/UC-fixture',
      title: 'Fixture',
      uploads_playlist_id: 'UU-fixture',
      handle: null,
    },
    now.toISOString(),
  ))!;
  const item = (await new ItemRepository(env.DB, owner).upsert(
    source.source_id,
    {
      namespace: 'youtube',
      external_id: 'fixture0001',
      item_type: 'video',
      canonical_url: 'https://www.youtube.com/watch?v=fixture0001',
      title: 'English original title is not language authority',
      published_at: null,
      publication_provenance: 'UNKNOWN',
      availability: 'PUBLIC',
      duration_seconds: 60,
    },
    now.toISOString(),
  ))!;
  const secret = 'z'.repeat(43),
    hash = await sha256(secret);
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'authority-worker',
      'a',
      hash,
      '["FETCH_TRANSCRIPT"]',
      now.toISOString(),
    )
    .run();
  const job = (await new JobStore(env.DB, owner).enqueue(
    {
      item_id: item.item_id,
      source_id: source.source_id,
      task_type: 'FETCH_TRANSCRIPT',
      input_revision: 'fixture',
      profile_revision: 'fixture',
      prompt_snapshot_id: null,
      routing_policy_version: 'local-1',
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: '',
      arrival_origin_at: now.toISOString(),
      origin_kind: 'NEW',
      payload: {},
      priority: 80,
      due_at: now.toISOString(),
    },
    now.toISOString(),
  ))!;
  const access = await AccessContext.worker(env.DB, hash),
    store = new JobStore(env.DB, access);
  const token = (await store.lease(
    job.job_id,
    'FETCH_TRANSCRIPT',
    now,
    'local',
  ))!;
  await store.start(token, 'FETCH_TRANSCRIPT', now);
  return {
    item,
    token,
    request: () =>
      worker.fetch(
        new Request(
          application.app_origin + '/internal/workers/transcript/input',
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + secret,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ token }),
          },
        ),
        {
          ...env,
          SESSION_SIGNING_SECRET: fixtureSecret,
          YOUTUBE_API_KEY: 'fixture-key',
        },
        createExecutionContext(),
      ),
  };
}

it('returns only the exact videos.snippet.defaultAudioLanguage declaration without altering historical metadata', async () => {
  const setup = await inputRequest();
  const before = await env.DB.prepare(
    'SELECT metadata_json FROM item_revisions WHERE item_id=?',
  )
    .bind(setup.item.item_id)
    .first('metadata_json');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      items: [
        {
          id: 'fixture0001',
          snippet: { defaultAudioLanguage: 'de-DE', defaultLanguage: 'en' },
        },
      ],
    }),
  );
  const response = await setup.request();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    external_id: 'fixture0001',
    default_audio_language: 'de-DE',
    duration_ms: 60000,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const url = new URL(String(fetcher.mock.calls[0]![0]));
  expect(url.origin + url.pathname).toBe(
    'https://www.googleapis.com/youtube/v3/videos',
  );
  expect(url.searchParams.get('id')).toBe('fixture0001');
  expect(url.searchParams.get('part')).toBe('snippet');
  expect(
    await env.DB.prepare(
      'SELECT metadata_json FROM item_revisions WHERE item_id=?',
    )
      .bind(setup.item.item_id)
      .first('metadata_json'),
  ).toBe(before);
});

it('does not infer audio language from defaultLanguage or title', async () => {
  const setup = await inputRequest();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      items: [
        {
          id: 'fixture0001',
          snippet: { defaultLanguage: 'en', title: 'English original' },
        },
      ],
    }),
  );
  const response = await setup.request();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ default_audio_language: null });
});

it.each([
  { items: [{ id: 'another0001', snippet: { defaultAudioLanguage: 'en' } }] },
  {
    items: [
      { id: 'fixture0001', snippet: { defaultAudioLanguage: 'en;command' } },
    ],
  },
  { items: [{ id: 'fixture0001', snippet: { defaultAudioLanguage: null } }] },
  {
    items: [
      { id: 'fixture0001', snippet: { defaultAudioLanguage: 'en' } },
      { id: 'fixture0001', snippet: { defaultAudioLanguage: 'en' } },
    ],
  },
])(
  'rejects mismatched, ambiguous or malformed official metadata before returning source input',
  async (body) => {
    const setup = await inputRequest();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body));
    const response = await setup.request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'PARSER' });
  },
);

it('propagates technical metadata failures without converting them into absent captions', async () => {
  const setup = await inputRequest();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('fixture network failure'),
  );
  const response = await setup.request();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'TRANSIENT' });
  expect(
    await env.DB.prepare('SELECT state FROM jobs WHERE job_id=?')
      .bind(setup.token.job_id)
      .first('state'),
  ).toBe('RUNNING');
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM job_attempts WHERE job_id=? AND error_code IN ('LOCAL_YTDLP_NO_CAPTIONS','LOCAL_YTDLP_NO_CAPTIONS_FINAL')",
    )
      .bind(setup.token.job_id)
      .first('n'),
  ).toBe(0);
});
