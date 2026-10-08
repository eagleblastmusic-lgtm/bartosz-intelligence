import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { driveGuardQualification } from '../../packages/core/src/drive/qualification.js';
import { DriveClient } from '../../packages/core/src/drive/client.js';
import {
  previewDriveRoot,
  confirmDriveRoot,
} from '../../packages/core/src/drive/root.js';
beforeEach(resetCore);
it('qualifies only a complete immutable actual receipt for the exact owner, connection, root and method', async () => {
  const owner = await fixtureOwner();
  const id =
    'drive-guard-probe:' +
    (await sha256(JSON.stringify(['connection', 'root']))) +
    ':trial';
  const intent = JSON.stringify({
    version: 'drive-guard-probe-intent:1',
    connection_id: 'connection',
    root_id: 'root',
    method: 'V2_MEDIA_PUT_IF_MATCH',
  });
  const receipt = JSON.stringify({
    version: 'drive-upload-guard-probe:1',
    phase: 'PROBE',
    status: 'PASS',
    method: 'V2_MEDIA_PUT_IF_MATCH',
    concurrent_writers: 2,
    accepted_writers: 1,
    rejected_http_status: 412,
    current_guard_write: 'PASS',
    stable_readback: 'PASS',
  });
  const insert = async (revision: number, payload: string) =>
    env.DB.prepare('INSERT INTO config_versions VALUES(?,?,?,?,?,?)')
      .bind(
        id,
        owner.ownerId,
        revision,
        payload,
        await sha256(payload),
        fixtureNow.toISOString(),
      )
      .run();
  expect(
    await driveGuardQualification(env.DB, owner, 'connection', 'root'),
  ).toBeNull();
  await env.DB.prepare(
    `INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,revision,last_intent_hash,created_at,updated_at) VALUES('a','connection','subject-a','client','[]','CONNECTED',1,'receipt',?,?)`,
  )
    .bind(fixtureNow.toISOString(), fixtureNow.toISOString())
    .run();
  const client = new DriveClient('synthetic', async (target) =>
    String(target).includes('/permissions?')
      ? Response.json({ permissions: [{ type: 'user', role: 'owner' }] })
      : String(target).includes('/about?')
        ? Response.json({ storageQuota: { usage: '10', limit: '100' } })
        : Response.json({
            id: 'root',
            name: 'Daily',
            mimeType: 'application/vnd.google-apps.folder',
            trashed: false,
            capabilities: { canAddChildren: true },
          }),
  );
  await insert(1, intent);
  expect(
    await driveGuardQualification(env.DB, owner, 'connection', 'root'),
  ).toBeNull();
  await insert(2, receipt);
  expect(
    await driveGuardQualification(env.DB, owner, 'connection', 'root'),
  ).toBe(await sha256(receipt));
  const preview = await previewDriveRoot(
    env.DB,
    owner,
    client,
    { connection_id: 'connection', root_id: 'root', expected_revision: 1 },
    fixtureNow,
  );
  expect(preview.child_create_read_update).toBe('PASS');
  await env.DB.prepare(
    "UPDATE drive_connections SET revision=2 WHERE owner_id='a'",
  ).run();
  const confirmation = {
    connection_id: 'connection',
    preview_hash: preview.preview_hash,
    expected_revision: 2,
    acknowledge_mapping_review: false,
  };
  await expect(
    confirmDriveRoot(
      env.DB,
      owner,
      client,
      confirmation,
      new Date(fixtureNow.getTime() + 600000),
    ),
  ).rejects.toThrow('REVISION_CONFLICT');
  await expect(
    confirmDriveRoot(
      env.DB,
      owner,
      client,
      { ...confirmation, preview_hash: '0'.repeat(64) },
      fixtureNow,
    ),
  ).rejects.toThrow('INVALID_DRIVE_ROOT_PREVIEW');
  await expect(
    confirmDriveRoot(env.DB, owner, client, confirmation, fixtureNow),
  ).resolves.toMatchObject({
    root_id: 'root',
    root_state: 'VERIFIED',
    revision: 3,
    export_ready: false,
  });
  await expect(
    confirmDriveRoot(env.DB, owner, client, confirmation, fixtureNow),
  ).rejects.toThrow('REVISION_CONFLICT');
  expect(
    await driveGuardQualification(env.DB, owner, 'other', 'root'),
  ).toBeNull();
  expect(
    await driveGuardQualification(env.DB, owner, 'connection', 'other'),
  ).toBeNull();
  expect(
    await driveGuardQualification(
      env.DB,
      await fixtureOwner('b'),
      'connection',
      'root',
    ),
  ).toBeNull();
});
