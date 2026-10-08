import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import { disconnectDrive } from '../../packages/core/src/drive/disconnect.js';
import { DriveExportIdentity } from '../../packages/core/src/drive/identity.js';
beforeEach(resetCore);
it.each(['success', 'stale', 'foreign'] as const)(
  'disconnect protects credentials and existing mapping (%s)',
  async (scenario) => {
    const owner = await fixtureOwner();
    await env.DB.prepare(
      `INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,root_id,root_state,revision,last_intent_hash,created_at,updated_at) VALUES('a','connection','subject-a','client','[]','CONNECTED','root','VERIFIED',1,'receipt',?,?)`,
    )
      .bind(fixtureNow.toISOString(), fixtureNow.toISOString())
      .run();
    await env.DB.prepare(
      `INSERT INTO drive_credentials VALUES('a','connection',?,?)`,
    )
      .bind(
        JSON.stringify({ version: 'drive-refresh-aes256gcm:1' }),
        fixtureNow.toISOString(),
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO drive_oauth_intents VALUES('state','a','connection',1,'client','redirect','key','nonce','verifier','browser',?,NULL)`,
    )
      .bind(new Date(fixtureNow.getTime() + 600000).toISOString())
      .run();
    const identity = new DriveExportIdentity(env.DB, owner);
    await identity.ensure('connection', 'root', '2026-10-05', fixtureNow);
    const lease = await identity.claim(
      'root',
      '2026-10-05',
      'exporter',
      fixtureNow,
    );
    await identity.reserve(lease, 'reserved-file', fixtureNow);
    const before = await env.DB.prepare(
      `SELECT * FROM export_state WHERE owner_id='a'`,
    ).first();
    const action = disconnectDrive(
      env.DB,
      scenario === 'foreign' ? await fixtureOwner('b') : owner,
      {
        connection_id: 'connection',
        expected_revision: scenario === 'stale' ? 2 : 1,
      },
      fixtureNow,
    );
    if (scenario === 'success') {
      expect(await action).toMatchObject({
        auth_state: 'REVOKED',
        local_credential_removed: true,
        google_account_grant_revoked: false,
      });
      expect(
        await env.DB.prepare(`SELECT * FROM drive_credentials`).first(),
      ).toBeNull();
      expect(
        await env.DB.prepare(
          `SELECT consumed_at FROM drive_oauth_intents`,
        ).first(),
      ).toEqual({ consumed_at: fixtureNow.toISOString() });
      expect(
        await env.DB.prepare(
          `SELECT root_id,root_state,revision FROM drive_connections`,
        ).first(),
      ).toEqual({
        root_id: 'root',
        root_state: 'VERIFY_REQUIRED',
        revision: 2,
      });
      const after = await env.DB.prepare(
        `SELECT * FROM export_state WHERE owner_id='a'`,
      ).first();
      expect(after).toMatchObject({
        reserved_remote_id: 'reserved-file',
        lease_owner: null,
        lease_until: null,
        fencing_token: Number(before!.fencing_token) + 1,
      });
      await expect(
        disconnectDrive(
          env.DB,
          owner,
          { connection_id: 'connection', expected_revision: 1 },
          fixtureNow,
        ),
      ).rejects.toThrow('REVISION_CONFLICT');
    } else {
      await expect(action).rejects.toThrow('REVISION_CONFLICT');
      expect(
        await env.DB.prepare(
          `SELECT * FROM export_state WHERE owner_id='a'`,
        ).first(),
      ).toEqual(before);
      expect(
        await env.DB.prepare(`SELECT * FROM drive_credentials`).first(),
      ).not.toBeNull();
      expect(
        await env.DB.prepare(
          `SELECT consumed_at FROM drive_oauth_intents`,
        ).first(),
      ).toEqual({ consumed_at: null });
    }
  },
);
