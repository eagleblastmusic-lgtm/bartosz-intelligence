import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
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
beforeEach(resetCore);
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
