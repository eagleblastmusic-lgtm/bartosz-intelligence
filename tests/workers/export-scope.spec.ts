import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { resetCore, fixtureNow, fixtureSecret } from './core-fixture.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { renderOwnerDaily } from '../../packages/core/src/export/snapshot.js';
import { DailyProjection } from '../../packages/core/src/projections/daily.js';
import { ExportSettings } from '../../packages/core/src/export/settings.js';
import { ArtifactRepository } from '../../packages/core/src/artifacts/store.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { DriveExportIdentity } from '../../packages/core/src/drive/identity.js';
import { DailyExportArtifacts } from '../../packages/core/src/export/artifacts.js';
import { DailyExportExecutor } from '../../packages/core/src/export/executor.js';
import { DriveClient } from '../../packages/core/src/drive/client.js';
beforeEach(resetCore);
it.each([false, true])(
  'scopes unattended export and checks credential revocation before completion (revoked: %s)',
  async (revoked) => {
    const hash = await sha256('synthetic-export-worker');
    await env.DB.prepare(
      'INSERT INTO worker_identities(worker_id,owner_id,credential_hash,scopes_json,created_at) VALUES(?,?,?,?,?)',
    )
      .bind('exporter', 'a', hash, '["DRIVE_EXPORT"]', fixtureNow.toISOString())
      .run();
    const context = await AccessContext.worker(env.DB, hash);
    expect(context.kind).toBe('worker');
    expect(() => context.requireOwner()).toThrow('FORBIDDEN');
    const report = await renderOwnerDaily(
      env.DB,
      context,
      { date: '2026-10-05', app_origin: 'https://example.test', revision: 1 },
      fixtureSecret,
      fixtureNow,
    );
    expect(report.item_ids).toHaveLength(0);
    const projection = new DailyProjection(env.DB, context);
    await expect(
      projection.day(
        { date: null, timezone: 'Europe/Warsaw', limit: 1 },
        fixtureSecret,
        fixtureNow,
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      projection.day(
        {
          date: '2026-10-05',
          timezone: 'Europe/Warsaw',
          limit: 1,
          source_ids: ['source'],
        },
        fixtureSecret,
        fixtureNow,
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(projection.detail('item')).rejects.toThrow('FORBIDDEN');
    await expect(projection.sourceProgress('source')).rejects.toThrow(
      'FORBIDDEN',
    );
    expect(() => new ExportSettings(env.DB, context)).toThrow('FORBIDDEN');
    await expect(
      new ArtifactRepository(env.DB, context).get(
        'not-an-accepted-canonical-artifact',
      ),
    ).rejects.toThrow('NOT_FOUND');
    await env.DB.prepare(
      `INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,root_id,root_state,revision,last_intent_hash,created_at,updated_at) VALUES('a','connection','subject-a','client','[]','CONNECTED','root','VERIFIED',1,'receipt',?,?)`,
    )
      .bind(fixtureNow.toISOString(), fixtureNow.toISOString())
      .run();
    const identity = new DriveExportIdentity(env.DB, context);
    await identity.ensure('connection', 'root', '2026-10-05', fixtureNow);
    const lease = await identity.claim(
      'root',
      '2026-10-05',
      'exporter',
      fixtureNow,
    );
    const artifact = await new DailyExportArtifacts(env.DB, context).save(
      lease,
      report,
      fixtureNow,
    );
    const file = {
      id: 'reserved',
      name: '2026-10-05.md',
      mimeType: 'text/markdown',
      parents: ['root'],
      trashed: false,
      version: '1',
      appProperties: await identity.appProperties('root', '2026-10-05'),
    };
    let exists = false;
    const client = new DriveClient('synthetic', async (target, init) => {
      if (String(target).includes('generateIds'))
        return Response.json({ ids: ['reserved'] });
      if (init?.method === 'POST') {
        exists = true;
        if (revoked)
          await env.DB.prepare(
            "UPDATE worker_identities SET revoked_at=? WHERE worker_id='exporter'",
          )
            .bind(fixtureNow.toISOString())
            .run();
        return Response.json(file);
      }
      if (!exists) return new Response(null, { status: 404 });
      return String(target).includes('alt=media')
        ? new Response(report.markdown)
        : Response.json(file);
    });
    const completion = new DailyExportExecutor(env.DB, context).execute(
      lease,
      artifact,
      client,
      fixtureNow,
    );
    if (revoked) {
      await expect(completion).rejects.toThrow('UNAUTHENTICATED');
      expect(
        await env.DB.prepare(
          "SELECT file_id FROM export_state WHERE owner_id='a'",
        ).first('file_id'),
      ).toBeNull();
    } else
      await expect(completion).resolves.toMatchObject({
        file_id: 'reserved',
        content_hash: report.content_hash,
      });
    await env.DB.prepare(
      "UPDATE worker_identities SET revoked_at=? WHERE worker_id='exporter'",
    )
      .bind(fixtureNow.toISOString())
      .run();
    await expect(AccessContext.worker(env.DB, hash)).rejects.toThrow(
      'UNAUTHENTICATED',
    );
  },
);
