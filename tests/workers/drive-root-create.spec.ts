import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import { DriveClient } from '../../packages/core/src/drive/client.js';
import { createDriveRootCandidate } from '../../packages/core/src/drive/root-create.js';
beforeEach(resetCore);
async function fixture() {
  const owner = await fixtureOwner();
  await env.DB.prepare(
    `INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,revision,last_intent_hash,created_at,updated_at) VALUES('a','connection','subject-a','client','[]','CONNECTED',1,'receipt',?,?)`,
  )
    .bind(fixtureNow.toISOString(), fixtureNow.toISOString())
    .run();
  const input = {
    connection_id: 'connection',
    name: 'Daily',
    expected_revision: 1,
  };
  let file: Record<string, unknown> | null = null,
    creates = 0,
    reservations = 0,
    shared = false,
    timeout = false;
  const client = new DriveClient('synthetic', async (target, init) => {
    const url = String(target);
    if (url.includes('generateIds')) {
      reservations++;
      return Response.json({ ids: ['reserved-root'] });
    }
    if (init?.method === 'POST') {
      creates++;
      expect(
        await env.DB.prepare(
          "SELECT reserved_folder_id FROM drive_root_candidates WHERE owner_id='a'",
        ).first('reserved_folder_id'),
      ).toBe('reserved-root');
      file = {
        ...JSON.parse(String(init.body)),
        trashed: false,
        capabilities: { canAddChildren: true },
      };
      return timeout
        ? new Response(null, { status: 503 })
        : Response.json(file);
    }
    if (url.includes('/permissions?'))
      return Response.json({
        permissions: [
          { type: 'user', role: 'owner' },
          ...(shared ? [{ type: 'anyone', role: 'reader' }] : []),
        ],
      });
    if (url.includes('/about?'))
      return Response.json({ storageQuota: { limit: '100000', usage: '500' } });
    return file ? Response.json(file) : new Response(null, { status: 404 });
  });
  return {
    owner,
    input,
    client,
    get creates() {
      return creates;
    },
    get reservations() {
      return reservations;
    },
    set shared(value: boolean) {
      shared = value;
    },
    set timeout(value: boolean) {
      timeout = value;
    },
    remove() {
      file = null;
    },
  };
}
it('reserves a private folder before create and reuses it after an accepted timeout and repeated explicit requests', async () => {
  const f = await fixture();
  f.timeout = true;
  const result = await createDriveRootCandidate(
    env.DB,
    f.owner,
    f.client,
    f.input,
    fixtureNow,
  );
  expect(result).toMatchObject({
    requested_root_id: 'reserved-root',
    private_owner_only: true,
    created_candidate: true,
    child_create_read_update: 'NOT_RUN',
    export_ready: false,
  });
  expect(
    (
      await createDriveRootCandidate(
        env.DB,
        f.owner,
        f.client,
        f.input,
        fixtureNow,
      )
    ).requested_root_id,
  ).toBe('reserved-root');
  expect(f.creates).toBe(1);
  expect(f.reservations).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT root_id,root_state FROM drive_connections WHERE owner_id='a'",
    ).first(),
  ).toEqual({ root_id: null, root_state: 'UNSELECTED' });
});
it('denies shared folder permissions and never qualifies the connection or broadens OAuth scope', async () => {
  const f = await fixture();
  f.shared = true;
  await expect(
    createDriveRootCandidate(env.DB, f.owner, f.client, f.input, fixtureNow),
  ).rejects.toMatchObject({ category: 'DENIED' });
  expect(
    await env.DB.prepare(
      "SELECT state FROM drive_root_candidates WHERE owner_id='a'",
    ).first('state'),
  ).toBe('PREPARED');
  expect(
    await env.DB.prepare(
      "SELECT root_state FROM drive_connections WHERE owner_id='a'",
    ).first('root_state'),
  ).toBe('UNSELECTED');
});
it('preserves a previously created candidate when the remote folder disappears instead of silently recreating it', async () => {
  const f = await fixture();
  await createDriveRootCandidate(
    env.DB,
    f.owner,
    f.client,
    f.input,
    fixtureNow,
  );
  f.remove();
  await expect(
    createDriveRootCandidate(env.DB, f.owner, f.client, f.input, fixtureNow),
  ).rejects.toThrow('DRIVE_ROOT_IDENTITY_CONFLICT');
  expect(f.creates).toBe(1);
});
it('rejects foreign owner, stale revision and malformed names before any remote reservation', async () => {
  const f = await fixture();
  await expect(
    createDriveRootCandidate(
      env.DB,
      await fixtureOwner('b'),
      f.client,
      f.input,
      fixtureNow,
    ),
  ).rejects.toThrow('NOT_FOUND');
  await expect(
    createDriveRootCandidate(
      env.DB,
      f.owner,
      f.client,
      { ...f.input, expected_revision: 2 },
      fixtureNow,
    ),
  ).rejects.toThrow('REVISION_CONFLICT');
  await expect(
    createDriveRootCandidate(
      env.DB,
      f.owner,
      f.client,
      { ...f.input, name: 'Daily\nFolder' },
      fixtureNow,
    ),
  ).rejects.toThrow('INVALID_DRIVE_ROOT_CANDIDATE');
  expect(f.reservations).toBe(0);
});
