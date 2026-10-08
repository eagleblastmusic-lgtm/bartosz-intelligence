import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { resetCore, fixtureNow, fixtureOwner } from './core-fixture.js';
import { DriveExportIdentity } from '../../packages/core/src/drive/identity.js';
import { DriveClient } from '../../packages/core/src/drive/client.js';
import {
  previewDriveConflict,
  preserveManualDriveConflict,
} from '../../packages/core/src/drive/conflict.js';
import { ExportSettings } from '../../packages/core/src/export/settings.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
beforeEach(resetCore);
it.each([
  'stable',
  'changed',
  'expired',
  'foreign-owner',
  'settings-race',
  'foreign-file',
] as const)(
  'preserves manual Drive bytes with owner preview and CAS (%s)',
  async (scenario) => {
    const owner = await fixtureOwner();
    await env.DB.prepare(
      `INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,root_id,root_state,revision,last_intent_hash,created_at,updated_at) VALUES('a','connection','subject-a','client','[]','CONNECTED','root','VERIFIED',1,'receipt',?,?)`,
    )
      .bind(fixtureNow.toISOString(), fixtureNow.toISOString())
      .run();
    const identity = new DriveExportIdentity(env.DB, owner);
    await identity.ensure('connection', 'root', '2026-10-05', fixtureNow);
    const lease = await identity.claim(
      'root',
      '2026-10-05',
      'exporter',
      fixtureNow,
    );
    await identity.reserve(lease, 'manual', fixtureNow);
    await identity.release(lease);
    await env.DB.prepare(
      "UPDATE export_state SET file_id='manual',paused_reason='EXPORT_CONFLICT' WHERE owner_id='a'",
    ).run();
    const properties = await identity.appProperties('root', '2026-10-05');
    let version = '1',
      text = 'Właściciel: ręcznie zachowana treść 🧠';
    let writes = 0;
    const client = new DriveClient('synthetic', async (target, init) => {
      if (init?.method && init.method !== 'GET') {
        writes++;
        throw new Error('UNEXPECTED_REMOTE_WRITE');
      }
      if (String(target).includes('/permissions?'))
        return Response.json({
          permissions: [{ type: 'user', role: 'owner' }],
        });
      if (String(target).includes('alt=media')) return new Response(text);
      return Response.json({
        id: 'manual',
        name: '2026-10-05.md',
        mimeType: 'text/markdown',
        parents: ['root'],
        trashed: false,
        version,
        appProperties: properties,
      });
    });
    const preview = await previewDriveConflict(
      env.DB,
      owner,
      client,
      {
        connection_id: 'connection',
        connection_revision: 1,
        root_id: 'root',
        date: '2026-10-05',
        expected_settings_revision: 1,
      },
      fixtureNow,
    );
    expect(preview.remote_hash).toBe(await sha256(text));
    expect(JSON.stringify(preview)).not.toContain(text);
    await env.DB.prepare(
      "UPDATE drive_connections SET revision=2 WHERE owner_id='a'",
    ).run();
    if (scenario === 'changed') {
      version = '2';
      text = 'Nowsza ręczna treść';
    }
    if (scenario === 'settings-race')
      await env.DB.prepare(
        "UPDATE export_state SET settings_revision=2 WHERE owner_id='a'",
      ).run();
    if (scenario === 'foreign-file') properties.bi_owner = 'foreign';
    const input = {
      connection_id: 'connection',
      connection_revision: 2,
      preview_hash: preview.preview_hash,
      action: 'KEEP_MANUAL' as const,
    };
    const confirm = preserveManualDriveConflict(
      env.DB,
      scenario === 'foreign-owner' ? await fixtureOwner('b') : owner,
      client,
      input,
      scenario === 'expired'
        ? new Date(fixtureNow.getTime() + 600000)
        : fixtureNow,
    );
    if (scenario === 'stable') {
      await expect(confirm).resolves.toMatchObject({
        file_id: 'manual',
        paused_reason: 'OWNER_PRESERVED_MANUAL',
        settings_revision: 2,
        remote_write_performed: false,
      });
      await expect(
        preserveManualDriveConflict(env.DB, owner, client, input, fixtureNow),
      ).rejects.toThrow('REVISION_CONFLICT');
      await expect(
        new ExportSettings(env.DB, owner).retry('root', '2026-10-05', 2),
      ).rejects.toThrow('REVISION_CONFLICT');
      expect(
        await env.DB.prepare(
          "SELECT paused_reason,file_id,full_file_hash FROM export_state WHERE owner_id='a'",
        ).first(),
      ).toMatchObject({
        paused_reason: 'OWNER_PRESERVED_MANUAL',
        file_id: 'manual',
        full_file_hash: null,
      });
    } else
      await expect(confirm).rejects.toThrow(
        scenario === 'foreign-owner'
          ? 'INVALID_EXPORT_SETTINGS'
          : scenario === 'foreign-file'
            ? 'DRIVE_CONFLICT'
            : 'REVISION_CONFLICT',
      );
    expect(writes).toBe(0);
  },
);
