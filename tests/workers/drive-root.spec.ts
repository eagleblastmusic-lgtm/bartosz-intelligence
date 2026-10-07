import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import { previewDriveRoot } from '../../packages/core/src/drive/root.js';
import { DriveClient } from '../../packages/core/src/drive/client.js';
beforeEach(resetCore);
async function connection() {
  await env.DB.prepare(
    `INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,root_id,root_state,revision,last_intent_hash,created_at,updated_at) VALUES('a','connection','subject-a','client','[]','CONNECTED','old-root','VERIFIED',1,'receipt',?,?)`,
  )
    .bind(fixtureNow.toISOString(), fixtureNow.toISOString())
    .run();
  await env.DB.prepare(
    `INSERT INTO export_state(owner_id,publication_date,destination_key,root_namespace,file_id) VALUES('a','2026-10-05','drive','old-root','existing-daily')`,
  ).run();
}
function client(override = {}, quota = { usage: '10', limit: '100' }) {
  return new DriveClient('synthetic', async (target) =>
    String(target).includes('/permissions?')
      ? Response.json({ permissions: [{ type: 'user', role: 'owner' }] })
      : String(target).includes('/about?')
        ? Response.json({ storageQuota: quota })
        : Response.json({
            id: 'new-root',
            name: 'Wybrany folder',
            mimeType: 'application/vnd.google-apps.folder',
            trashed: false,
            capabilities: { canAddChildren: true },
            ...override,
          }),
  );
}
it('previews explicit folder and root-change mapping impact without qualifying exports, writing root or touching existing file identity', async () => {
  await connection();
  const owner = await fixtureOwner();
  const result = await previewDriveRoot(
    env.DB,
    owner,
    client(),
    { connection_id: 'connection', root_id: 'new-root', expected_revision: 1 },
    fixtureNow,
  );
  expect(result).toMatchObject({
    current_root_id: 'old-root',
    requested_root_id: 'new-root',
    root_changed: true,
    existing_mapping_count: 1,
    mapping_action: 'PRESERVE_EXISTING',
    duplicate_risk: 'ROOT_CHANGE_REQUIRES_MAPPING_REVIEW',
    folder_metadata_access: 'PASS',
    child_create_read_update: 'NOT_RUN',
    export_ready: false,
  });
  expect(result.preview_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(
    await env.DB.prepare(
      'SELECT root_id,revision FROM drive_connections',
    ).first(),
  ).toEqual({ root_id: 'old-root', revision: 1 });
  expect(
    await env.DB.prepare('SELECT file_id FROM export_state').first(),
  ).toEqual({ file_id: 'existing-daily' });
  await expect(
    previewDriveRoot(
      env.DB,
      await fixtureOwner('b'),
      client(),
      {
        connection_id: 'connection',
        root_id: 'new-root',
        expected_revision: 1,
      },
      fixtureNow,
    ),
  ).rejects.toThrow('NOT_FOUND');
});
it('denies trash/non-folder/unknown permission/full storage and stale connection rather than adopting arbitrary root', async () => {
  await connection();
  const owner = await fixtureOwner(),
    input = {
      connection_id: 'connection',
      root_id: 'new-root',
      expected_revision: 1,
    };
  for (const override of [
    { trashed: true },
    { trashed: undefined },
    { mimeType: 'text/markdown' },
    { capabilities: {} },
    { capabilities: { canAddChildren: false } },
  ])
    await expect(
      previewDriveRoot(env.DB, owner, client(override), input, fixtureNow),
    ).rejects.toThrow('DRIVE_DENIED');
  await expect(
    previewDriveRoot(
      env.DB,
      owner,
      client({}, { usage: '100', limit: '100' }),
      input,
      fixtureNow,
    ),
  ).rejects.toThrow('DRIVE_QUOTA');
  await expect(
    previewDriveRoot(
      env.DB,
      owner,
      client(),
      { ...input, expected_revision: 2 },
      fixtureNow,
    ),
  ).rejects.toThrow('REVISION_CONFLICT');
});
it('rejects concurrent reconnect during remote folder inspection', async () => {
  await connection();
  const owner = await fixtureOwner();
  const changing = new DriveClient('synthetic', async (target) => {
    if (String(target).includes('/permissions?'))
      return Response.json({ permissions: [{ type: 'user', role: 'owner' }] });
    if (String(target).includes('/about?')) {
      await env.DB.prepare(
        "UPDATE drive_connections SET revision=2 WHERE owner_id='a'",
      ).run();
      return Response.json({ storageQuota: { usage: '0' } });
    }
    return Response.json({
      id: 'new-root',
      name: 'Folder',
      mimeType: 'application/vnd.google-apps.folder',
      trashed: false,
      capabilities: { canAddChildren: true },
    });
  });
  await expect(
    previewDriveRoot(
      env.DB,
      owner,
      changing,
      {
        connection_id: 'connection',
        root_id: 'new-root',
        expected_revision: 1,
      },
      fixtureNow,
    ),
  ).rejects.toThrow('REVISION_CONFLICT');
});
