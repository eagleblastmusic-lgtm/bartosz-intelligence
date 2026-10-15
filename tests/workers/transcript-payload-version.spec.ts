import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { resetCore, fixtureNow } from './core-fixture.js';
import { compactFixture, memoryDrive } from './performance-fixture.js';
import { TranscriptDriveArchive } from '../../packages/core/src/transcript/archive.js';
import {
  TranscriptPayloadArchive,
  type PayloadArchiveReceipt,
} from '../../packages/core/src/transcript/payload-archive.js';
import { PayloadEviction } from '../../packages/core/src/retention/payload-eviction.js';
import { ArtifactRepository } from '../../packages/core/src/artifacts/store.js';
import { DriveFailure } from '../../packages/core/src/drive/client.js';
beforeEach(resetCore);
async function fixture() {
  const f = await compactFixture(),
    drive = memoryDrive();
  expect(
    (
      await new TranscriptDriveArchive(env.DB, f.exporter).tick(
        { client: async () => drive.client() },
        fixtureNow,
      )
    ).state,
  ).toBe('VERIFIED');
  const receipt = (await env.DB.prepare(
    'SELECT * FROM transcript_payload_archives',
  ).first<PayloadArchiveReceipt>())!;
  const original = { ...receipt };
  const file = drive.files.get(receipt.reserved_file_id)!;
  const archive = new TranscriptPayloadArchive(env.DB, f.exporter);
  return {
    ...f,
    drive,
    receipt,
    original,
    file,
    archive,
    read: () =>
      env.DB.prepare(
        'SELECT * FROM transcript_payload_archives',
      ).first<PayloadArchiveReceipt>(),
  };
}
it('reconciles stable metadata-only advance after exact readback without changing hashes, IDs, verification time or payloads', async () => {
  const f = await fixture();
  f.file.meta.version = '2';
  const payload = await f.archive.verify(f.receipt, f.drive.client());
  expect(payload.artifacts).toHaveLength(3);
  expect(f.receipt.remote_version).toBe('2');
  expect(await f.read()).toEqual({ ...f.original, remote_version: '2' });
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM artifact_chunks').first('n'),
  ).toBe(3);
  expect(f.drive.creates).toBe(2);
});
it('rejects changed bytes even when metadata advanced and does not refresh the receipt', async () => {
  const f = await fixture();
  f.file.meta.version = '2';
  f.drive.setFault('hash');
  await expect(f.archive.verify(f.receipt, f.drive.client())).rejects.toThrow(
    'PAYLOAD_ARCHIVE_INTEGRITY_FAILED',
  );
  expect(await f.read()).toEqual(f.original);
});
it('rejects version changing during readback', async () => {
  const f = await fixture();
  f.file.meta.version = '2';
  const c = f.drive.client(),
    read = c.readTranscriptMarkdown.bind(c);
  c.readTranscriptMarkdown = async (id) => {
    const text = await read(id);
    f.file.meta.version = '3';
    return text;
  };
  await expect(f.archive.verify(f.receipt, c)).rejects.toThrow(
    'PAYLOAD_ARCHIVE_INTEGRITY_FAILED',
  );
  expect(await f.read()).toEqual(f.original);
});
it('rejects nonprivate archives without updating metadata', async () => {
  const f = await fixture();
  f.file.meta.version = '2';
  const c = f.drive.client();
  c.verifyPrivateFolder = async () => {
    throw new DriveFailure('DENIED');
  };
  await expect(f.archive.verify(f.receipt, c)).rejects.toThrow('DRIVE_DENIED');
  expect(await f.read()).toEqual(f.original);
});
it('never overwrites a receipt concurrently changed after the read started', async () => {
  const f = await fixture();
  f.file.meta.version = '2';
  const c = f.drive.client(),
    read = c.readTranscriptMarkdown.bind(c);
  c.readTranscriptMarkdown = async (id) => {
    const text = await read(id);
    await env.DB.prepare(
      "UPDATE transcript_payload_archives SET remote_version='3'",
    ).run();
    return text;
  };
  await expect(f.archive.verify(f.receipt, c)).rejects.toThrow(
    'PAYLOAD_ARCHIVE_STALE_RECEIPT',
  );
  expect((await f.read())!.remote_version).toBe('3');
});
it('holds reconciliation while an eviction permit is active', async () => {
  const f = await fixture();
  f.file.meta.version = '2';
  await env.DB.prepare(
    'UPDATE transcript_payload_archives SET permit_token=?,permit_until=?',
  )
    .bind('local-test-only', new Date(Date.now() + 60000).toISOString())
    .run();
  await expect(f.archive.verify(f.receipt, f.drive.client())).rejects.toThrow(
    'PAYLOAD_ARCHIVE_STALE_RECEIPT',
  );
  expect((await f.read())!.remote_version).toBe('1');
});
it('does not grant receipt-write authority to a FETCH_TRANSCRIPT worker', async () => {
  const f = await fixture();
  f.file.meta.version = '2';
  await expect(
    new TranscriptPayloadArchive(env.DB, f.access).verify(
      f.receipt,
      f.drive.client(),
    ),
  ).rejects.toThrow('FORBIDDEN');
  expect(await f.read()).toEqual(f.original);
});
it('reads exact source after isolated eviction and a later provider metadata advance', async () => {
  const f = await fixture(),
    id = f.inputs[0]!.completion.source_artifact_id;
  await env.DB.prepare(
    "INSERT INTO retention_settings(owner_id,deletion_enabled,approval_reference) VALUES('a',1,'LOCAL-TEST-ONLY')",
  ).run();
  expect(
    (
      await new PayloadEviction(env.DB, f.owner).step(
        id,
        f.drive.client(),
        fixtureNow,
        { dry_run: false },
      )
    ).state,
  ).toBe('EVICTED_PAGE');
  f.file.meta.version = '2';
  const repository = new ArtifactRepository(env.DB, f.owner, null, (h) =>
    new TranscriptPayloadArchive(env.DB, f.exporter).read(h, async () =>
      f.drive.client(),
    ),
  );
  expect((await repository.readVerifiedText(id, 1024 * 1024)).text).toBe(
    f.inputs[0]!.text,
  );
  expect((await f.read())!.remote_version).toBe('2');
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM artifact_chunks').first('n'),
  ).toBe(0);
});
