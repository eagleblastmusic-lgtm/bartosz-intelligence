import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  resetCore,
  fixtureOwner,
  fixtureNow,
  fixtureSecret,
} from './core-fixture.js';
import { DriveExportIdentity } from '../../packages/core/src/drive/identity.js';
import { DailyExportArtifacts } from '../../packages/core/src/export/artifacts.js';
import { DailyExportExecutor } from '../../packages/core/src/export/executor.js';
import { renderOwnerDaily } from '../../packages/core/src/export/snapshot.js';
import { DriveClient } from '../../packages/core/src/drive/client.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { ExportSettings } from '../../packages/core/src/export/settings.js';
import type { Database } from '../../packages/core/src/db/boundary.js';
beforeEach(resetCore);
it('expires the lease during remote HTTP even without a competing claim and reconciles on a new lease', async () => {
  const f = await fixture();
  let clock = 0,
    exists = false,
    creates = 0;
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
  try {
    const client = new DriveClient('synthetic', async (target, init) => {
      if (String(target).includes('generateIds'))
        return Response.json({ ids: ['reserved'] });
      if (init?.method === 'POST') {
        exists = true;
        creates++;
        clock = 900001;
        return Response.json(f.file);
      }
      if (!exists) return new Response(null, { status: 404 });
      return String(target).includes('alt=media')
        ? new Response(f.report.markdown)
        : Response.json(f.file);
    });
    await expect(
      f.executor.execute(f.lease, f.artifact, client, fixtureNow),
    ).rejects.toThrow('EXPORT_STALE_FENCE_OR_REVISION');
    expect(
      await env.DB.prepare(
        "SELECT file_id FROM export_state WHERE owner_id='a'",
      ).first('file_id'),
    ).toBeNull();
    const later = new Date(fixtureNow.getTime() + 900001);
    const lease = await f.identity.claim(
      'root',
      f.lease.date,
      'recovery',
      later,
    );
    await expect(
      f.executor.execute(lease, f.artifact, client, later),
    ).resolves.toMatchObject({ file_id: 'reserved' });
    expect(creates).toBe(1);
  } finally {
    spy.mockRestore();
  }
});
it('reports a conflict when another owner action changes the mode between the successful CAS and its readback', async () => {
  const f = await fixture();
  let raced = false;
  const database: Database = env.DB;
  const interleaved: Database = {
    batch: (statements) => database.batch(statements),
    prepare(sql) {
      let statement = database.prepare(sql);
      return {
        bind(...values) {
          statement = statement.bind(...values);
          return this;
        },
        all: () => statement.all(),
        run: () => statement.run(),
        async first<T>(column?: string) {
          if (!raced && sql.startsWith('SELECT settings_revision')) {
            raced = true;
            await new ExportSettings(env.DB, f.owner).mode(
              'root',
              f.lease.date,
              'COMPACT',
              2,
              fixtureNow,
            );
          }
          return statement.first<T>(column);
        },
      };
    },
  };
  await expect(
    new ExportSettings(interleaved, f.owner).mode(
      'root',
      f.lease.date,
      'FULL',
      1,
      fixtureNow,
    ),
  ).rejects.toThrow('REVISION_CONFLICT');
  expect(raced).toBe(true);
  expect(
    await env.DB.prepare(
      "SELECT settings_revision,desired_mode,revision FROM export_state WHERE owner_id='a'",
    ).first(),
  ).toMatchObject({
    settings_revision: 3,
    desired_mode: 'COMPACT',
    revision: 0,
  });
});
it.each([false, true])(
  'acknowledges identical material and reconciles guarded updates (accepted timeout: %s)',
  async (acceptedTimeout) => {
    const f = await fixture();
    let exists = false,
      writes = 0;
    let markdown = f.report.markdown;
    let version = 1;
    const client = new DriveClient('synthetic', async (target, init) => {
      const url = new URL(String(target));
      if (url.pathname.endsWith('/root/permissions'))
        return Response.json({
          permissions: [{ type: 'user', role: 'owner' }],
        });
      if (url.pathname.endsWith('/root'))
        return Response.json({
          id: 'root',
          mimeType: 'application/vnd.google-apps.folder',
          trashed: false,
          ownedByMe: true,
        });
      if (init?.method === 'PUT') {
        expect(new Headers(init.headers).get('If-Match')).toBe(
          '"v' + version + '"',
        );
        markdown = String(init.body);
        version++;
        writes++;
        if (acceptedTimeout) return new Response(null, { status: 503 });
        return Response.json({ id: 'reserved' });
      }
      if (String(target).includes('generateIds'))
        return Response.json({ ids: ['reserved'] });
      if (init?.method === 'POST') {
        exists = true;
        writes++;
        return Response.json(f.file);
      }
      if (init?.method === 'PATCH') throw new Error('UNEXPECTED_UPDATE');
      if (!exists) return new Response(null, { status: 404 });
      if (url.pathname.includes('/v2/'))
        return Response.json({
          id: 'reserved',
          mimeType: 'text/markdown',
          parents: [{ id: 'root' }],
          labels: { trashed: false },
          properties: Object.entries(f.file.appProperties).map(
            ([key, value]) => ({ key, value, visibility: 'PRIVATE' }),
          ),
          etag: '"v' + version + '"',
        });
      return String(target).includes('alt=media')
        ? new Response(markdown)
        : Response.json({ ...f.file, version: String(version) });
    });
    await f.executor.execute(f.lease, f.artifact, client, fixtureNow);
    const report = await renderOwnerDaily(
      env.DB,
      f.owner,
      { date: f.lease.date, app_origin: 'https://example.test', revision: 2 },
      fixtureSecret,
      fixtureNow,
    );
    // Synthetic cut metadata exercises acknowledgement versus later dirty work;
    // the rendered day stays unchanged and no provider result is manufactured.
    report.markdown = report.markdown.replace(
      /^source_change_seq: \d+$/m,
      'source_change_seq: 100',
    );
    report.source_change_seq = 100;
    report.content_hash = await sha256(report.markdown);
    report.byte_count = new TextEncoder().encode(report.markdown).length;
    await env.DB.prepare(
      "UPDATE export_state SET dirty_seq=101 WHERE owner_id='a'",
    ).run();
    const candidate = await new DailyExportArtifacts(env.DB, f.owner).save(
      f.lease,
      report,
      fixtureNow,
    );
    const result = await f.executor.execute(
      f.lease,
      candidate,
      client,
      fixtureNow,
    );
    expect(result).toMatchObject({
      disposition: 'NO_MATERIAL_CHANGE',
      revision: 1,
      content_hash: f.report.content_hash,
    });
    expect(writes).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT revision,full_file_hash,exported_seq,dirty_seq FROM export_state WHERE owner_id='a'",
      ).first(),
    ).toMatchObject({
      revision: 1,
      full_file_hash: f.report.content_hash,
      exported_seq: 100,
      dirty_seq: 101,
    });
    expect(
      await env.DB.prepare(
        'SELECT state,reason,verified_hash FROM drive_export_attempts WHERE artifact_id=?',
      )
        .bind(candidate)
        .first(),
    ).toMatchObject({
      state: 'PREPARED',
      reason: 'NO_MATERIAL_CHANGE',
      verified_hash: f.report.content_hash,
    });
    const full = await renderOwnerDaily(
      env.DB,
      f.owner,
      {
        date: f.lease.date,
        app_origin: 'https://example.test',
        revision: 3,
        mode: 'FULL',
      },
      fixtureSecret,
      fixtureNow,
    );
    await new ExportSettings(env.DB, f.owner).mode(
      'root',
      f.lease.date,
      'FULL',
      1,
      fixtureNow,
    );
    const fullLease = await f.identity.claim(
      'root',
      f.lease.date,
      'full',
      fixtureNow,
    );
    const fullId = await new DailyExportArtifacts(env.DB, f.owner).save(
      fullLease,
      full,
      fixtureNow,
    );
    if (acceptedTimeout) {
      await expect(
        f.executor.execute(fullLease, fullId, client, fixtureNow),
      ).rejects.toThrow('TRANSIENT');
      expect(
        await env.DB.prepare(
          "SELECT revision FROM export_state WHERE owner_id='a'",
        ).first('revision'),
      ).toBe(1);
    }
    await expect(
      f.executor.execute(fullLease, fullId, client, fixtureNow),
    ).resolves.toMatchObject({ revision: 3, content_hash: full.content_hash });
    expect(writes).toBe(2);
    await f.executor.execute(fullLease, fullId, client, fixtureNow);
    expect(writes).toBe(2);
  },
);
it('mode settings preserve the file mapping, invalidate old workers and queue changes even at the same source cut', async () => {
  const f = await fixture();
  const settings = new ExportSettings(env.DB, f.owner);
  await f.identity.reserve(f.lease, 'reserved', fixtureNow);
  expect(
    await settings.mode('root', f.lease.date, 'COMPACT', 1, fixtureNow),
  ).toMatchObject({ settings_revision: 1 });
  expect(
    await settings.mode('root', f.lease.date, 'FULL', 1, fixtureNow),
  ).toMatchObject({ settings_revision: 2, desired_mode: 'FULL' });
  await expect(
    settings.mode('root', f.lease.date, 'COMPACT', 1, fixtureNow),
  ).rejects.toThrow('REVISION_CONFLICT');
  let requests = 0;
  const client = new DriveClient('synthetic', async () => {
    requests++;
    throw new Error('UNEXPECTED_HTTP');
  });
  await expect(
    f.executor.execute(f.lease, f.artifact, client, fixtureNow),
  ).rejects.toThrow('EXPORT_STALE_FENCE_OR_REVISION');
  expect(requests).toBe(0);
  await settings.mode('root', f.lease.date, 'COMPACT', 2, fixtureNow);
  expect(
    await env.DB.prepare(
      "SELECT mode,desired_mode,desired_generation,exported_generation,reserved_remote_id,revision FROM export_state WHERE owner_id='a'",
    ).first(),
  ).toMatchObject({
    mode: 'COMPACT',
    desired_mode: 'COMPACT',
    desired_generation: 2,
    exported_generation: 0,
    reserved_remote_id: 'reserved',
    revision: 0,
  });
  await expect(
    settings.mode('root', '2026-10-06', 'FULL', 1, fixtureNow),
  ).rejects.toThrow('NOT_FOUND');
});
async function fixture() {
  const owner = await fixtureOwner();
  await env.DB.prepare(
    `INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,root_id,root_state,revision,last_intent_hash,created_at,updated_at) VALUES('a','connection','subject-a','client','[]','CONNECTED','root','VERIFIED',1,'receipt',?,?)`,
  )
    .bind(fixtureNow.toISOString(), fixtureNow.toISOString())
    .run();
  const identity = new DriveExportIdentity(env.DB, owner);
  await identity.ensure('connection', 'root', '2026-10-05');
  const lease = await identity.claim(
    'root',
    '2026-10-05',
    'exporter',
    fixtureNow,
  );
  const report = await renderOwnerDaily(
    env.DB,
    owner,
    { date: lease.date, app_origin: 'https://example.test', revision: 1 },
    fixtureSecret,
    fixtureNow,
  );
  const artifact = await new DailyExportArtifacts(env.DB, owner).save(
    lease,
    report,
    fixtureNow,
  );
  const properties = await identity.appProperties('root', lease.date);
  const file = {
    id: 'reserved',
    name: lease.date + '.md',
    mimeType: 'text/markdown',
    parents: ['root'],
    trashed: false,
    version: '1',
    appProperties: properties,
  };
  return {
    owner,
    identity,
    lease,
    report,
    artifact,
    file,
    executor: new DailyExportExecutor(env.DB, owner),
  };
}
it('persists reserved identity and intent before HTTP, reconciles an accepted create timeout and never creates twice', async () => {
  const f = await fixture();
  let exists = false,
    creates = 0;
  const client = new DriveClient('synthetic', async (target, init) => {
    const url = String(target);
    if (url.includes('generateIds'))
      return Response.json({ ids: ['reserved'] });
    if (init?.method === 'POST') {
      creates++;
      expect(
        await env.DB.prepare(
          "SELECT reserved_remote_id FROM export_state WHERE owner_id='a'",
        ).first('reserved_remote_id'),
      ).toBe('reserved');
      expect(
        await env.DB.prepare(
          "SELECT state FROM drive_export_attempts WHERE owner_id='a'",
        ).first('state'),
      ).toBe('PREPARED');
      expect(init.body).toContain(f.report.markdown);
      exists = true;
      return new Response(null, { status: 503 });
    }
    if (!exists) return new Response(null, { status: 404 });
    return url.includes('alt=media')
      ? new Response(f.report.markdown)
      : Response.json(f.file);
  });
  const receipt = await f.executor.execute(
    f.lease,
    f.artifact,
    client,
    fixtureNow,
  );
  expect(receipt).toMatchObject({
    file_id: 'reserved',
    content_hash: f.report.content_hash,
    revision: 1,
  });
  await f.executor.execute(f.lease, f.artifact, client, fixtureNow);
  expect(creates).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT state,verified_hash FROM drive_export_attempts WHERE owner_id='a'",
    ).first(),
  ).toMatchObject({ state: 'VERIFIED', verified_hash: f.report.content_hash });
});
it('retains ambiguous identity after an unaccepted timeout and retries exactly the same file and bytes', async () => {
  const f = await fixture();
  let exists = false,
    creates = 0,
    reservations = 0;
  const client = new DriveClient('synthetic', async (target, init) => {
    const url = String(target);
    if (url.includes('generateIds')) {
      reservations++;
      return Response.json({ ids: ['reserved'] });
    }
    if (init?.method === 'POST') {
      creates++;
      expect(init.body).toContain('"id":"reserved"');
      expect(init.body).toContain(f.report.markdown);
      if (creates === 1) return new Response(null, { status: 503 });
      exists = true;
      return Response.json(f.file);
    }
    if (!exists) return new Response(null, { status: 404 });
    return url.includes('alt=media')
      ? new Response(f.report.markdown)
      : Response.json(f.file);
  });
  await expect(
    f.executor.execute(f.lease, f.artifact, client, fixtureNow),
  ).rejects.toThrow('EXPORT_AMBIGUOUS');
  expect(
    await env.DB.prepare(
      "SELECT reason FROM drive_export_attempts WHERE owner_id='a'",
    ).first('reason'),
  ).toBe('EXPORT_AMBIGUOUS');
  await f.executor.execute(f.lease, f.artifact, client, fixtureNow);
  expect(reservations).toBe(1);
  expect(creates).toBe(2);
});
it('rejects unrelated reserved metadata and concurrent manual edits without any remote overwrite', async () => {
  const f = await fixture();
  await f.identity.reserve(f.lease, 'reserved', fixtureNow);
  let reads = 0,
    writes = 0;
  const client = new DriveClient('synthetic', async (target, init) => {
    if (init?.method === 'POST' || init?.method === 'PATCH') {
      writes++;
      throw new Error('UNEXPECTED_WRITE');
    }
    if (String(target).includes('alt=media'))
      return new Response(f.report.markdown);
    reads++;
    return Response.json({ ...f.file, version: reads === 1 ? '1' : '2' });
  });
  await expect(
    f.executor.execute(f.lease, f.artifact, client, fixtureNow),
  ).rejects.toThrow('EXPORT_CONFLICT');
  expect(writes).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT file_id FROM export_state WHERE owner_id='a'",
    ).first('file_id'),
  ).toBeNull();
  await expect(
    f.executor.execute(f.lease, f.artifact, client, fixtureNow),
  ).rejects.toThrow('EXPORT_CONFLICT');
  expect(reads).toBe(2);
});
it('rejects a stale completion after remote create and recovers by GET on the next lease', async () => {
  const f = await fixture();
  let exists = false,
    creates = 0;
  const later = new Date(fixtureNow.getTime() + 900001);
  let newer: Awaited<ReturnType<typeof f.identity.claim>> | undefined;
  const client = new DriveClient('synthetic', async (target, init) => {
    const url = String(target);
    if (url.includes('generateIds'))
      return Response.json({ ids: ['reserved'] });
    if (init?.method === 'POST') {
      creates++;
      exists = true;
      newer = await f.identity.claim('root', f.lease.date, 'recovery', later);
      return Response.json(f.file);
    }
    if (!exists) return new Response(null, { status: 404 });
    return url.includes('alt=media')
      ? new Response(f.report.markdown)
      : Response.json(f.file);
  });
  await expect(
    f.executor.execute(f.lease, f.artifact, client, fixtureNow),
  ).rejects.toThrow('EXPORT_STALE_FENCE_OR_REVISION');
  expect(
    await env.DB.prepare(
      "SELECT file_id FROM export_state WHERE owner_id='a'",
    ).first('file_id'),
  ).toBeNull();
  await f.executor.execute(newer!, f.artifact, client, later);
  expect(creates).toBe(1);
});
