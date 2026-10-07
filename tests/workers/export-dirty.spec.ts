import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import { ExportDirtyDays } from '../../packages/core/src/export/dirty.js';
import { DriveExportIdentity } from '../../packages/core/src/drive/identity.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { ItemRepository } from '../../packages/core/src/db/items.js';
beforeEach(resetCore);
async function fixture() {
  const owner = await fixtureOwner();
  const source = (await new SourceRepository(env.DB, owner).upsert(
    {
      namespace: 'youtube',
      external_id: 'UC' + 'a'.repeat(22),
      uploads_playlist_id: 'UU' + 'a'.repeat(22),
      canonical_locator: 'https://www.youtube.com/channel/UC' + 'a'.repeat(22),
      title: 'Fixture',
      handle: null,
    },
    fixtureNow.toISOString(),
  ))!;
  const item = (await new ItemRepository(env.DB, owner).upsert(
    source.source_id,
    {
      namespace: 'youtube',
      external_id: '00000000001',
      item_type: 'video',
      canonical_url: 'https://www.youtube.com/watch?v=00000000001',
      title: 'Fixture',
      published_at: '2026-10-04T22:30:00.000Z',
      publication_provenance: 'videos.snippet.publishedAt',
      availability: 'PUBLIC',
      duration_seconds: 60,
    },
    fixtureNow.toISOString(),
  ))!;
  await env.DB.prepare(
    `INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,root_id,root_state,revision,last_intent_hash,created_at,updated_at) VALUES('a','connection','subject-a','client','[]','CONNECTED','root','VERIFIED',1,'receipt',?,?)`,
  )
    .bind(fixtureNow.toISOString(), fixtureNow.toISOString())
    .run();
  const identity = new DriveExportIdentity(env.DB, owner);
  for (const date of ['2026-10-04', '2026-10-05', '2026-10-06'])
    await identity.ensure('connection', 'root', date);
  const queue = new ExportDirtyDays(env.DB, owner);
  await queue.sync(fixtureNow);
  await env.DB.prepare(
    "UPDATE export_state SET exported_seq=dirty_seq,revision=1,first_dirty_at=NULL,last_material_event_at=NULL WHERE owner_id='a'",
  ).run();
  return { owner, item, queue };
}
async function event(component: string, target: string, type: string) {
  await env.DB.prepare(
    'INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) VALUES(?,?,?,?,?)',
  )
    .bind('a', component, target, type, fixtureNow.toISOString())
    .run();
}
const later = (minutes: number) =>
  new Date(fixtureNow.getTime() + minutes * 60000);
it('queues an explicit empty-day first export even when its source sequence is already acknowledged', async () => {
  const f = await fixture();
  const identity = new DriveExportIdentity(env.DB, f.owner);
  await identity.ensure('connection', 'root', '2026-10-07', fixtureNow);
  expect(await f.queue.due(later(9))).toEqual([]);
  expect((await f.queue.due(later(10))).map((row) => row.date)).toEqual([
    '2026-10-07',
  ]);
});
it('durably creates the new publication day for a qualified root without replacing older mappings', async () => {
  const f = await fixture();
  await env.DB.prepare(
    "UPDATE items SET published_at='2026-10-07T12:00:00.000Z' WHERE owner_id='a' AND item_id=?",
  )
    .bind(f.item.item_id)
    .run();
  await f.queue.sync(fixtureNow);
  expect((await f.queue.due(later(10))).map((row) => row.date)).toEqual([
    '2026-10-05',
    '2026-10-07',
  ]);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM export_state WHERE owner_id='a'",
    ).first('n'),
  ).toBe(4);
});
it('late selection dirties the original Warsaw publication day, not arrival day, and debounce is replay-idempotent', async () => {
  const f = await fixture();
  await event('selection', f.item.item_id, 'SELECTION_CHANGED');
  expect((await f.queue.sync(fixtureNow)).processed_events).toBe(1);
  expect(await f.queue.due(later(9))).toEqual([]);
  expect((await f.queue.due(later(10))).map((row) => row.date)).toEqual([
    '2026-10-05',
  ]);
  const before = await env.DB.prepare(
    "SELECT dirty_seq,first_dirty_at,last_material_event_at FROM export_state WHERE owner_id='a' AND publication_date='2026-10-05'",
  ).first();
  expect((await f.queue.sync(later(20))).processed_events).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT dirty_seq,first_dirty_at,last_material_event_at FROM export_state WHERE owner_id='a' AND publication_date='2026-10-05'",
    ).first(),
  ).toEqual(before);
  expect(
    await new ExportDirtyDays(env.DB, await fixtureOwner('b')).due(later(20)),
  ).toEqual([]);
});
it('publication correction dirties both old and new days; undated and organization events do not manufacture a dated export', async () => {
  const f = await fixture();
  await env.DB.prepare(
    "UPDATE items SET published_at='2026-10-05T22:30:00.000Z' WHERE owner_id='a' AND item_id=?",
  )
    .bind(f.item.item_id)
    .run();
  await f.queue.sync(fixtureNow);
  expect((await f.queue.due(later(10))).map((row) => row.date)).toEqual([
    '2026-10-05',
    '2026-10-06',
  ]);
  await env.DB.prepare(
    'UPDATE export_state SET exported_seq=dirty_seq,first_dirty_at=NULL,last_material_event_at=NULL',
  ).run();
  await event('organization', f.item.item_id, 'SPACE_ATTACHED_CHANGED');
  await event('registry', 'draft', 'SEMANTIC_PROFILE_VERSION_CREATED');
  await f.queue.sync(later(11));
  expect(await f.queue.due(later(30))).toEqual([]);
});
it('continuous changes retain first dirty time, reach max wait and older completion does not clear newer sequence', async () => {
  const f = await fixture();
  await event('selection', f.item.item_id, 'SELECTION_CHANGED');
  await f.queue.sync(fixtureNow);
  const first = await env.DB.prepare(
    "SELECT dirty_seq FROM export_state WHERE publication_date='2026-10-05'",
  ).first<number>('dirty_seq');
  for (const minute of [9, 18, 27]) {
    await event('jobs', f.item.item_id, 'JOB_STATUS_CHANGED');
    await f.queue.sync(later(minute));
  }
  expect(await f.queue.due(later(29))).toEqual([]);
  expect((await f.queue.due(later(30)))[0]?.date).toBe('2026-10-05');
  await env.DB.prepare(
    "UPDATE export_state SET exported_seq=? WHERE publication_date='2026-10-05'",
  )
    .bind(first!)
    .run();
  expect((await f.queue.due(later(30)))[0]!.dirty_seq).toBeGreaterThan(first!);
  await env.DB.prepare(
    "UPDATE drive_connections SET auth_state='REAUTH_REQUIRED'",
  ).run();
  expect(await f.queue.due(later(31))).toEqual([]);
});
