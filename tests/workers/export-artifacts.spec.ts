import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import {
  resetCore,
  resetSchema,
  fixtureOwner,
  fixtureNow,
  fixtureSecret,
} from './core-fixture.js';
import { DriveExportIdentity } from '../../packages/core/src/drive/identity.js';
import { DailyExportArtifacts } from '../../packages/core/src/export/artifacts.js';
import { renderOwnerDaily } from '../../packages/core/src/export/snapshot.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import {
  CoreBackup,
  backupTables,
  type BackupChunk,
} from '../../packages/core/src/backup/snapshot.js';
import { restoreCanonical } from '../../packages/core/src/backup/restore.js';
import type { Database } from '../../packages/core/src/db/boundary.js';
beforeEach(resetCore);
async function setup() {
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
  return {
    owner,
    identity,
    lease,
    report,
    store: new DailyExportArtifacts(env.DB, owner),
  };
}
it('stores exact UTF-8 report bytes, rejects a changed revision and keeps sealed chunks immutable', async () => {
  const { store, lease, report } = await setup();
  const id = await store.save(lease, report, fixtureNow);
  expect(await store.save(lease, report, fixtureNow)).toBe(id);
  const stored = await store.read(id);
  expect(new TextDecoder().decode(stored.bytes)).toBe(report.markdown);
  expect(stored.manifest.content_hash).toBe(report.content_hash);
  expect(
    await env.DB.prepare(
      "SELECT rendered_artifact_id FROM export_state WHERE owner_id='a'",
    ).first('rendered_artifact_id'),
  ).toBe(id);
  await expect(
    store.save(lease, { ...report, body_sha256: '0'.repeat(64) }, fixtureNow),
  ).rejects.toThrow('INVALID_EXPORT_REPORT');
  const full = await renderOwnerDaily(
    env.DB,
    await fixtureOwner(),
    {
      date: lease.date,
      app_origin: 'https://example.test',
      revision: 1,
      mode: 'FULL',
    },
    fixtureSecret,
    fixtureNow,
  );
  await expect(store.save(lease, full, fixtureNow)).rejects.toThrow(
    'EXPORT_REVISION_CONTENT_CONFLICT',
  );
  await expect(
    env.DB.prepare(
      "UPDATE daily_export_chunks SET data_base64='YWJj' WHERE owner_id='a'",
    ).run(),
  ).rejects.toThrow('IMMUTABLE_EXPORT_CHUNK');
  await expect(
    new DailyExportArtifacts(env.DB, await fixtureOwner('b')).read(id),
  ).rejects.toThrow('NOT_FOUND');
});
it('resumes partial chunk persistence without changing bytes or exposing STAGING artifacts', async () => {
  const { owner, lease, report, store } = await setup();
  // Storage stress uses explicit synthetic body text, not AI quality evidence.
  const start = report.markdown.indexOf('\n---\n\n') + 6;
  const end = report.markdown.lastIndexOf('END_REPORT date=');
  const body =
    report.markdown.slice(start, end) +
    'Żółć 🧠 synthetic recovery fixture\n'.repeat(18000);
  const bodyHash = await sha256(body);
  const markdown =
    report.markdown.slice(0, start).replace(report.body_sha256, bodyHash) +
    body +
    report.markdown.slice(end);
  const large = {
    ...report,
    markdown,
    body_sha256: bodyHash,
    content_hash: await sha256(markdown),
    byte_count: new TextEncoder().encode(markdown).length,
  };
  let crash = true;
  const db: Database = env.DB;
  const failing = new DailyExportArtifacts(
    {
      prepare: (sql) => env.DB.prepare(sql),
      batch: async (statements) => {
        const result = await db.batch(statements);
        if (crash) {
          crash = false;
          throw new Error('SIMULATED_CRASH');
        }
        return result;
      },
    },
    owner,
  );
  await expect(failing.save(lease, large, fixtureNow)).rejects.toThrow(
    'SIMULATED_CRASH',
  );
  const id = await env.DB.prepare(
    "SELECT artifact_id FROM daily_export_artifacts WHERE owner_id='a'",
  ).first<string>('artifact_id');
  expect(id).not.toBeNull();
  await expect(store.read(id!)).rejects.toThrow('EXPORT_ARTIFACT_NOT_VERIFIED');
  await expect(
    env.DB.prepare(
      "UPDATE daily_export_artifacts SET state='SEALED' WHERE owner_id='a'",
    ).run(),
  ).rejects.toThrow('EXPORT_ARTIFACT_INCOMPLETE');
  expect(await store.save(lease, large, fixtureNow)).toBe(id);
  expect(new TextDecoder().decode((await store.read(id!)).bytes)).toBe(
    markdown,
  );
  await env.DB.prepare(
    'DELETE FROM daily_export_chunks WHERE owner_id=? AND artifact_id=? AND ordinal=0',
  )
    .bind('a', id!)
    .run();
  await expect(store.read(id!)).rejects.toThrow('EXPORT_ARTIFACT_INTEGRITY');
});
it('rejects stale fences and older revisions while preserving the latest rendered bytes', async () => {
  const { store, identity, lease, report, owner } = await setup();
  const first = await store.save(lease, report, fixtureNow);
  const later = new Date(fixtureNow.getTime() + 900001);
  const recovered = await identity.claim('root', lease.date, 'recovery', later);
  await expect(store.save(lease, report, later)).rejects.toThrow(
    'EXPORT_STALE_FENCE_OR_REVISION',
  );
  const revised = await renderOwnerDaily(
    env.DB,
    owner,
    {
      date: lease.date,
      app_origin: 'https://example.test',
      revision: 2,
      mode: 'FULL',
    },
    fixtureSecret,
    fixtureNow,
  );
  const second = await store.save(recovered, revised, later);
  expect(second).not.toBe(first);
  await expect(store.save(recovered, report, later)).rejects.toThrow(
    'EXPORT_STALE_FENCE_OR_REVISION',
  );
  expect(
    await env.DB.prepare(
      "SELECT rendered_artifact_id FROM export_state WHERE owner_id='a'",
    ).first('rendered_artifact_id'),
  ).toBe(second);
  expect(new TextDecoder().decode((await store.read(first)).bytes)).toBe(
    report.markdown,
  );
});
it('backs up and restores sealed bytes and their pointer, fencing all old writers', async () => {
  const { store, lease, report, owner } = await setup();
  const id = await store.save(lease, report, fixtureNow);
  const backup = new CoreBackup(env.DB, owner);
  const started = await backup.begin();
  await expect(store.save(lease, report, fixtureNow)).rejects.toThrow(
    'BACKUP_MUTATION_PAUSED',
  );
  const chunks: BackupChunk[] = [];
  for (const table of backupTables) {
    let cursor: number | null = 0;
    do {
      const chunk = await backup.chunk(started.backup_id, table, cursor);
      chunks.push(chunk);
      cursor = chunk.next_cursor;
    } while (cursor !== null);
  }
  const manifest = await backup.complete(started.backup_id);
  await resetSchema();
  await restoreCanonical(env.DB, { manifest, chunks }, 'subject-a');
  const restored = new DailyExportArtifacts(env.DB, await fixtureOwner());
  expect(new TextDecoder().decode((await restored.read(id)).bytes)).toBe(
    report.markdown,
  );
  expect(
    await env.DB.prepare(
      "SELECT rendered_artifact_id,lease_owner,fencing_token FROM export_state WHERE owner_id='a'",
    ).first(),
  ).toMatchObject({
    rendered_artifact_id: id,
    lease_owner: null,
    fencing_token: lease.fencing_token + 1,
  });
  await expect(restored.save(lease, report, fixtureNow)).rejects.toThrow(
    'EXPORT_STALE_FENCE_OR_REVISION',
  );
});
