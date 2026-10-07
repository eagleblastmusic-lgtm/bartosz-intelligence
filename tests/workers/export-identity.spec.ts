import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import { DriveExportIdentity } from '../../packages/core/src/drive/identity.js';
beforeEach(resetCore);
async function setup() {
  await env.DB.prepare(
    `INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,root_id,root_state,revision,last_intent_hash,created_at,updated_at) VALUES('a','connection','subject-a','client','[]','CONNECTED','root','VERIFIED',1,'receipt',?,?)`,
  )
    .bind(fixtureNow.toISOString(), fixtureNow.toISOString())
    .run();
  return new DriveExportIdentity(env.DB, await fixtureOwner());
}
it('pins one file identity per owner/root/day across mode switches and repeated creation with unique private appProperties', async () => {
  const identity = await setup();
  const first = await identity.ensure('connection', 'root', '2026-10-05');
  expect(await identity.ensure('connection', 'root', '2026-10-05')).toEqual(
    first,
  );
  const lease = await identity.claim(
    'root',
    '2026-10-05',
    'exporter',
    fixtureNow,
  );
  await identity.reserve(lease, 'reserved-file', fixtureNow);
  await identity.reserve(lease, 'reserved-file', fixtureNow);
  await env.DB.prepare(
    "UPDATE export_state SET file_id='reserved-file',mode='FULL' WHERE owner_id='a'",
  ).run();
  expect(await identity.get('root', '2026-10-05')).toMatchObject({
    mode: 'FULL',
    reserved_remote_id: 'reserved-file',
    file_id: 'reserved-file',
  });
  await env.DB.prepare(
    "UPDATE export_state SET mode='COMPACT' WHERE owner_id='a'",
  ).run();
  expect((await identity.get('root', '2026-10-05')).file_id).toBe(
    'reserved-file',
  );
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM export_state').first<number>(
      'n',
    ),
  ).toBe(1);
  const properties = await identity.appProperties('root', '2026-10-05');
  expect(properties.bi_owner).toMatch(/^[a-f0-9]{64}$/);
  expect(properties.bi_day).toBe('2026-10-05');
  expect(properties).toEqual(
    await identity.appProperties('root', '2026-10-05'),
  );
  expect(properties.bi_export_key).not.toBe(
    (await identity.appProperties('root', '2026-10-06')).bi_export_key,
  );
  await expect(
    new DriveExportIdentity(env.DB, await fixtureOwner('b')).get(
      'root',
      '2026-10-05',
    ),
  ).rejects.toThrow('NOT_FOUND');
});
it('crash recovery retains reserved ID and rejects expired owner, stale fence and late release', async () => {
  const identity = await setup();
  await identity.ensure('connection', 'root', '2026-10-05');
  const first = await identity.claim('root', '2026-10-05', 'first', fixtureNow);
  await identity.reserve(first, 'reserved-file', fixtureNow);
  await expect(
    identity.claim('root', '2026-10-05', 'second', fixtureNow),
  ).rejects.toThrow('EXPORT_LEASE_UNAVAILABLE');
  const recoveredAt = new Date(fixtureNow.getTime() + 900001);
  const second = await identity.claim(
    'root',
    '2026-10-05',
    'second',
    recoveredAt,
  );
  expect(second.fencing_token).toBe(first.fencing_token + 1);
  expect((await identity.get('root', '2026-10-05')).reserved_remote_id).toBe(
    'reserved-file',
  );
  await expect(
    identity.reserve(first, 'reserved-file', recoveredAt),
  ).rejects.toThrow('EXPORT_STALE_FENCE_OR_ID');
  await expect(
    identity.reserve(second, 'different-file', recoveredAt),
  ).rejects.toThrow('EXPORT_STALE_FENCE_OR_ID');
  await expect(identity.release(first)).rejects.toThrow(
    'EXPORT_STALE_FENCE_OR_ID',
  );
  await identity.reserve(second, 'reserved-file', recoveredAt);
  await identity.release(second);
});
it('D1 guards prevent reserved ID replacement, remote ID mismatch and root/date mutation even outside repository', async () => {
  const identity = await setup();
  await identity.ensure('connection', 'root', '2026-10-05');
  const lease = await identity.claim(
    'root',
    '2026-10-05',
    'worker',
    fixtureNow,
  );
  await identity.reserve(lease, 'reserved-file', fixtureNow);
  await expect(
    env.DB.prepare(
      "UPDATE export_state SET reserved_remote_id='another'",
    ).run(),
  ).rejects.toThrow('IMMUTABLE_EXPORT_RESERVED_ID');
  await expect(
    env.DB.prepare("UPDATE export_state SET file_id='another'").run(),
  ).rejects.toThrow('EXPORT_RESERVED_ID_MISMATCH');
  await env.DB.prepare("UPDATE export_state SET file_id='reserved-file'").run();
  await expect(
    env.DB.prepare('UPDATE export_state SET file_id=NULL').run(),
  ).rejects.toThrow('IMMUTABLE_EXPORT_FILE_ID');
  await expect(
    env.DB.prepare("UPDATE export_state SET root_namespace='another'").run(),
  ).rejects.toThrow('IMMUTABLE_EXPORT_MAPPING');
  await expect(
    env.DB.prepare(
      "UPDATE export_state SET publication_date='2026-10-06'",
    ).run(),
  ).rejects.toThrow('IMMUTABLE_EXPORT_MAPPING');
});
it('unverified/offline/reconnected roots cannot acquire an export lease or create a new destination', async () => {
  const identity = await setup();
  await identity.ensure('connection', 'root', '2026-10-05');
  await env.DB.prepare(
    "UPDATE drive_connections SET root_state='VERIFY_REQUIRED'",
  ).run();
  await expect(
    identity.ensure('connection', 'root', '2026-10-06'),
  ).rejects.toThrow('DRIVE_ROOT_NOT_VERIFIED');
  await expect(
    identity.claim('root', '2026-10-05', 'worker', fixtureNow),
  ).rejects.toThrow('EXPORT_LEASE_UNAVAILABLE');
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM export_state').first<number>(
      'n',
    ),
  ).toBe(1);
});
