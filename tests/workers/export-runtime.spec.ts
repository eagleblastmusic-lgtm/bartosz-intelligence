import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import {
  resetCore,
  fixtureNow,
  fixtureSecret,
  fixtureOwner,
} from './core-fixture.js';
import { ExportSettings } from '../../packages/core/src/export/settings.js';
import { exportStatus } from '../../packages/core/src/export/status.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { DriveExportIdentity } from '../../packages/core/src/drive/identity.js';
import {
  DriveClient,
  DriveFailure,
} from '../../packages/core/src/drive/client.js';
import { DailyExportArtifacts } from '../../packages/core/src/export/artifacts.js';
import { runDriveExportTick } from '../../packages/core/src/export/runtime.js';
beforeEach(resetCore);
it.each(['TRANSIENT', 'CONFLICT', 'EXHAUSTED'] as const)(
  'persists bounded %s policy and resumes the exact prepared revision without AI',
  async (failure) => {
    const hash = await sha256('synthetic-runtime');
    await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
      .bind('exporter', 'a', hash, '["DRIVE_EXPORT"]', fixtureNow.toISOString())
      .run();
    const context = await AccessContext.worker(env.DB, hash);
    await env.DB.prepare(
      `INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,root_id,root_state,revision,last_intent_hash,created_at,updated_at) VALUES('a','connection','subject-a','client','[]','CONNECTED','root','VERIFIED',1,'receipt',?,?)`,
    )
      .bind(fixtureNow.toISOString(), fixtureNow.toISOString())
      .run();
    const identity = new DriveExportIdentity(env.DB, context);
    await identity.ensure(
      'connection',
      'root',
      '2026-10-05',
      new Date(fixtureNow.getTime() - 1800000),
    );
    const properties = await identity.appProperties('root', '2026-10-05');
    let calls = 0,
      creates = 0,
      exists = false;
    let markdown = '';
    const input = {
      app_origin: 'https://example.test',
      cursor_secret: fixtureSecret,
      client: async () => {
        calls++;
        if (calls === 1 || failure === 'EXHAUSTED')
          throw new DriveFailure(
            failure === 'EXHAUSTED' ? 'TRANSIENT' : failure,
          );
        const id = await env.DB.prepare(
          "SELECT rendered_artifact_id FROM export_state WHERE owner_id='a'",
        ).first<string>('rendered_artifact_id');
        const saved = await new DailyExportArtifacts(env.DB, context).read(id!);
        markdown = new TextDecoder().decode(saved.bytes);
        return new DriveClient('synthetic', async (target, init) => {
          const file = {
            id: 'reserved',
            name: '2026-10-05.md',
            mimeType: 'text/markdown',
            parents: ['root'],
            trashed: false,
            version: '1',
            appProperties: properties,
          };
          if (String(target).includes('generateIds'))
            return Response.json({ ids: ['reserved'] });
          if (init?.method === 'POST') {
            creates++;
            exists = true;
            expect(String(init.body)).toContain(markdown);
            return Response.json(file);
          }
          if (!exists) return new Response(null, { status: 404 });
          return String(target).includes('alt=media')
            ? new Response(markdown)
            : Response.json(file);
        });
      },
    };
    expect(
      await runDriveExportTick(env.DB, context, input, fixtureNow),
    ).toMatchObject({
      state: failure === 'CONFLICT' ? 'PAUSED' : 'RETRY_WAIT',
      reason: 'DRIVE_' + (failure === 'EXHAUSTED' ? 'TRANSIENT' : failure),
    });
    expect(
      await runDriveExportTick(
        env.DB,
        context,
        input,
        new Date(fixtureNow.getTime() + 299000),
      ),
    ).toMatchObject({ state: 'IDLE' });
    expect(calls).toBe(1);
    const later = await runDriveExportTick(
      env.DB,
      context,
      input,
      new Date(fixtureNow.getTime() + 301000),
    );
    expect(later.state).toBe(
      failure === 'TRANSIENT'
        ? 'VERIFIED'
        : failure === 'CONFLICT'
          ? 'IDLE'
          : 'RETRY_WAIT',
    );
    if (failure === 'EXHAUSTED') {
      for (let count = 2; count < 8; count++) {
        const next = await env.DB.prepare(
          "SELECT next_retry_at FROM export_state WHERE owner_id='a'",
        ).first<string>('next_retry_at');
        const result = await runDriveExportTick(
          env.DB,
          context,
          input,
          new Date(next!),
        );
        expect(result.state).toBe(count === 7 ? 'PAUSED' : 'RETRY_WAIT');
      }
      expect(calls).toBe(8);
      expect(
        await runDriveExportTick(
          env.DB,
          context,
          input,
          new Date(fixtureNow.getTime() + 365 * 86400000),
        ),
      ).toMatchObject({ state: 'IDLE' });
      expect(calls).toBe(8);
    }
    expect(creates).toBe(failure === 'TRANSIENT' ? 1 : 0);
    expect(
      await env.DB.prepare(
        "SELECT count(*) n FROM daily_export_artifacts WHERE owner_id='a'",
      ).first('n'),
    ).toBe(1);
    expect(await env.DB.prepare('SELECT count(*) n FROM jobs').first('n')).toBe(
      0,
    );
    const owner = await fixtureOwner();
    const status = await exportStatus(env.DB, owner, fixtureNow);
    expect(status.days[0]!.report_metrics).toMatchObject({
      item_count: 0,
      ready_count: 0,
      pending_count: 0,
      compaction_level: 0,
      size_state: 'WITHIN_ESTIMATE',
      estimator_version: 'utf8-ceil-div3:1',
    });
    expect(status.days[0]!.report_metrics!.estimated_tokens).toBe(
      Math.ceil(status.days[0]!.rendered_bytes! / 3),
    );
    expect(JSON.stringify(status)).not.toContain('report_header_prefix');
    expect(JSON.stringify(status)).not.toContain('body_sha256:');
    const settings = new ExportSettings(env.DB, owner);
    if (failure === 'CONFLICT')
      await expect(settings.retry('root', '2026-10-05', 1)).rejects.toThrow(
        'REVISION_CONFLICT',
      );
    else {
      await env.DB.prepare(
        "UPDATE export_state SET retry_count=8,paused_reason='RETRY_BUDGET_EXHAUSTED' WHERE owner_id='a'",
      ).run();
      await expect(settings.retry('root', '2026-10-05', 1)).resolves.toEqual({
        settings_revision: 2,
      });
      await expect(settings.retry('root', '2026-10-05', 1)).rejects.toThrow(
        'REVISION_CONFLICT',
      );
      expect(
        await env.DB.prepare(
          "SELECT retry_count,paused_reason,next_retry_at FROM export_state WHERE owner_id='a'",
        ).first(),
      ).toMatchObject({
        retry_count: 0,
        paused_reason: null,
        next_retry_at: null,
      });
    }
  },
);
