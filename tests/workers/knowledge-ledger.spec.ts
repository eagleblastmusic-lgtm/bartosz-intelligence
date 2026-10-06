import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import {
  fixtureOwner,
  fixtureNow,
  fixtureSecret,
  resetCore,
} from './core-fixture.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { ItemRepository } from '../../packages/core/src/db/items.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { ObservationLedger } from '../../packages/core/src/knowledge/ledger.js';
beforeEach(resetCore);
it('pages current immutable observation identities, pins filters/cuts, and keeps unselected candidates out', async () => {
  const owner = await fixtureOwner();
  const at = fixtureNow.toISOString();
  const source = (await new SourceRepository(env.DB, owner).upsert(
    {
      namespace: 'youtube',
      external_id: 'UC' + 'a'.repeat(22),
      uploads_playlist_id: 'UU' + 'a'.repeat(22),
      canonical_locator: 'https://www.youtube.com/channel/UC' + 'a'.repeat(22),
      title: 'Channel',
      handle: '@channel',
    },
    at,
  ))!;
  const item = (await new ItemRepository(env.DB, owner).upsert(
    source.source_id,
    {
      namespace: 'youtube',
      external_id: 'abcdefghijk',
      item_type: 'video',
      canonical_url: 'https://www.youtube.com/watch?v=abcdefghijk',
      title: 'Title',
      published_at: '2026-10-05T10:00:00.000Z',
      publication_provenance: 'videos.snippet.publishedAt',
      availability: 'PUBLIC',
      duration_seconds: 60,
    },
    at,
  ))!;
  const job = (await new JobStore(env.DB, owner).enqueue(
    {
      item_id: item.item_id,
      source_id: source.source_id,
      task_type: 'ANALYZE',
      input_revision: '1',
      profile_revision: '1',
      prompt_snapshot_id: null,
      routing_policy_version: 'local',
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: '',
      arrival_origin_at: at,
      origin_kind: 'NEW',
      payload: {},
      priority: 80,
      due_at: at,
    },
    at,
  ))!;
  // Projection-only fixture; production acceptance equality is checked in artifacts.spec.ts.
  await env.DB.prepare(
    `INSERT INTO analysis_runs(run_id,owner_id,item_id,job_id,input_snapshot_json,profile_snapshot_json,routing_snapshot_json,state,outcome_json,created_at,accepted_at) VALUES('selected','a',?,?,'{}','{"profile_id":"economy"}','{}','ACCEPTED','{"version":"intelligence-accepted:1"}',?,?)`,
  )
    .bind(item.item_id, job.job_id, at, at)
    .run();
  await env.DB.prepare(
    'INSERT INTO active_analysis_selections VALUES(?,?,?,?,?)',
  )
    .bind('a', item.item_id, 'selected', 1, 'selected')
    .run();
  await env.DB.prepare(
    `INSERT INTO analysis_runs(run_id,owner_id,item_id,job_id,input_snapshot_json,profile_snapshot_json,routing_snapshot_json,state,created_at) VALUES('candidate','a',?,?,'{}','{}','{}','CANDIDATE',?)`,
  )
    .bind(item.item_id, job.job_id, at)
    .run();
  for (let index = 0; index < 53; index++) {
    const id = 'obs-' + String(index).padStart(3, '0');
    const row = JSON.stringify({
      observation_id: id,
      kind: 'CLAIM',
      content_pl: 'Reported statement',
      epistemic_status: 'SOURCE_REPORT',
      temporal_text: null,
      qualifiers: ['condition'],
      evidence_ids: [],
      entity_refs: [],
    });
    await env.DB.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?)')
      .bind(
        'a',
        id,
        index === 52 ? 'candidate' : 'selected',
        'CLAIM',
        row,
        await sha256(row),
        at,
      )
      .run();
  }
  const ledger = new ObservationLedger(env.DB, owner);
  const first = await ledger.page(
    { kind: 'CLAIM', date: '2026-10-05', profile_id: 'economy' },
    50,
    fixtureSecret,
    fixtureNow,
  );
  expect(first.observations).toHaveLength(50);
  expect(first.observations[0]!.observation).toMatchObject({
    epistemic_status: 'SOURCE_REPORT',
    temporal_text: null,
    qualifiers: ['condition'],
  });
  const last = await ledger.page(
    { profile_id: 'economy', date: '2026-10-05', kind: 'CLAIM' },
    50,
    fixtureSecret,
    fixtureNow,
    first.next_cursor!,
  );
  expect(last.observations.map((row) => row.observation_id)).toEqual([
    'obs-050',
    'obs-051',
  ]);
  expect(last.next_cursor).toBeNull();
  await expect(
    ledger.page({}, 50, fixtureSecret, fixtureNow, first.next_cursor!),
  ).rejects.toThrow('INVALID_CURSOR');
  await expect(
    new ObservationLedger(env.DB, await fixtureOwner('b')).page(
      { kind: 'CLAIM', date: '2026-10-05', profile_id: 'economy' },
      50,
      fixtureSecret,
      fixtureNow,
      first.next_cursor!,
    ),
  ).rejects.toThrow('INVALID_CURSOR');
  expect(
    (await ledger.page({ date: '2026-10-06' }, 50, fixtureSecret, fixtureNow))
      .observations,
  ).toHaveLength(0);
  await env.DB.prepare(
    'UPDATE active_analysis_selections SET selection_revision=2 WHERE item_id=?',
  )
    .bind(item.item_id)
    .run();
  await expect(
    ledger.page(
      { kind: 'CLAIM', date: '2026-10-05', profile_id: 'economy' },
      50,
      fixtureSecret,
      fixtureNow,
      first.next_cursor!,
    ),
  ).rejects.toThrow('READ_SNAPSHOT_CHANGED');
});
