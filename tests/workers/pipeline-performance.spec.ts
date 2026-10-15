import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { resetCore, fixtureNow } from './core-fixture.js';
import {
  compactFixture,
  memoryDrive,
  meterDatabase,
} from './performance-fixture.js';
import { TranscriptDriveArchive } from '../../packages/core/src/transcript/archive.js';
import { runTranscriptArchiveTick } from '../../apps/api/src/drive-export.js';
import { PayloadEviction } from '../../packages/core/src/retention/payload-eviction.js';
import { TranscriptPayloadArchive } from '../../packages/core/src/transcript/payload-archive.js';
import { ArtifactRepository } from '../../packages/core/src/artifacts/store.js';
import { DailyTasksWorkflow } from '../../packages/core/src/daily/workflow.js';
import { MockDailyDrive } from './daily-workflow-fixture.js';
beforeEach(resetCore);
it('the existing Daily/ChatGPT document flow archives compact sources in separate bounded transcript invocations', async () => {
  const drive = new MockDailyDrive(),
    f = await compactFixture(3, 3, drive),
    meter = meterDatabase(env.DB);
  const workflow = new DailyTasksWorkflow(meter.db, f.exporter);
  let verified = 0,
    invocations = 0;
  while (await workflow.hasReadyTranscript(fixtureNow)) {
    meter.reset();
    const result = await workflow.tick(drive, fixtureNow, 'TRANSCRIPT');
    if (result.state !== 'TRANSCRIPT_PREPARED') {
      expect(result).toMatchObject({
        state: 'TRANSCRIPT_TICK',
        transcript: { state: 'VERIFIED' },
      });
      verified++;
    }
    expect(meter.stats.queries).toBeLessThanOrEqual(50);
    if (++invocations > 7) throw new Error('unexpected extra continuation');
  }
  expect(verified).toBe(3);
  expect(await workflow.hasReadyTranscript(fixtureNow)).toBe(false);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM daily_drive_files WHERE state='VERIFIED' AND object_key LIKE 'transcript:%'",
    ).first('n'),
  ).toBe(3);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM transcript_payload_archives WHERE state='VERIFIED'",
    ).first('n'),
  ).toBe(3);
  expect(
    (
      await new TranscriptDriveArchive(env.DB, f.exporter).tick(
        { client: async () => drive },
        fixtureNow,
      )
    ).state,
  ).toBe('IDLE');
}, 30000);
it('a consumer appearing during Drive verification blocks the final eviction transaction', async () => {
  const f = await compactFixture(),
    drive = memoryDrive(),
    sourceId = f.inputs[0]!.completion.source_artifact_id;
  await new TranscriptDriveArchive(env.DB, f.exporter).tick(
    { client: async () => drive.client() },
    fixtureNow,
  );
  await env.DB.prepare(
    "INSERT INTO retention_settings(owner_id,deletion_enabled,approval_reference) VALUES('a',1,'LOCAL-TEST-ONLY')",
  ).run();
  const client = drive.client(),
    read = client.readTranscriptMarkdown.bind(client);
  let changed = false;
  client.readTranscriptMarkdown = async (id) => {
    const text = await read(id);
    if (!changed) {
      changed = true;
      await env.DB.prepare(
        "INSERT INTO jobs(job_id,owner_id,item_id,task_type,input_revision,profile_revision,routing_policy_version,explicit_run_nonce,dedup_key,state,due_at,priority,arrival_origin_at,origin_kind,payload_json,created_at,updated_at) SELECT 'new-reader',owner_id,item_id,'NORMALIZE','input','economy-1','local-primary-1','','new-reader','PENDING',due_at,1,arrival_origin_at,origin_kind,'{}',created_at,updated_at FROM jobs LIMIT 1",
      ).run();
    }
    return text;
  };
  expect(
    (
      await new PayloadEviction(env.DB, f.owner).step(
        sourceId,
        client,
        fixtureNow,
        { dry_run: false },
      )
    ).state,
  ).toBe('HELD');
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM artifact_chunks').first('n'),
  ).toBe(3);
});
it.each([10, 30, 100])(
  'archives %i compact materials through immediate bounded invocations',
  async (count) => {
    const f = await compactFixture(count),
      drive = memoryDrive(),
      meter = meterDatabase(env.DB),
      hints: unknown[] = [{ kind: 'TRANSCRIPT_ARCHIVE' }];
    const queue = {
      async send(h: unknown) {
        hints.push(h);
      },
    } as unknown as Pick<Queue, 'send'>;
    const started = Date.now(),
      stats = [];
    while (hints.length) {
      hints.shift();
      meter.reset();
      const result = await runTranscriptArchiveTick(
        new TranscriptDriveArchive(meter.db, f.exporter),
        { client: async () => drive.client() },
        fixtureNow,
        queue,
      );
      expect(result.state).toBe('VERIFIED');
      stats.push(meter.stats);
      expect(meter.stats.queries).toBeLessThanOrEqual(50);
      if (stats.length > count) throw new Error('busy loop');
    }
    expect(stats).toHaveLength(count);
    expect(drive.creates).toBe(count * 2); // one readable file and one exact package
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM transcript_payload_archives WHERE state='VERIFIED'",
      ).first('n'),
    ).toBe(count);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM jobs WHERE task_type IN ('ANALYZE','PROJECT')",
      ).first('n'),
    ).toBe(0);
    const result = await runTranscriptArchiveTick(
      new TranscriptDriveArchive(env.DB, f.exporter),
      { client: async () => drive.client() },
      fixtureNow,
      queue,
    );
    expect(result.state).toBe('IDLE');
    expect(hints).toHaveLength(0);
    expect(drive.creates).toBe(count * 2);
    console.log(
      JSON.stringify({
        benchmark: 'compact_archive',
        count,
        wall_ms: Date.now() - started,
        drive_requests: drive.requests,
        sql_max: Math.max(...stats.map((s) => s.queries)),
        rows_read: stats.reduce((n, s) => n + s.rows_read, 0),
        rows_written: stats.reduce((n, s) => n + s.rows_written, 0),
        artificial_delay_ms: 0,
      }),
    );
  },
  120000,
);
it('dry run, eviction, remote paging and rollback preserve exact data and block failed Drive verification', async () => {
  const f = await compactFixture(),
    source = f.inputs[0]!,
    drive = memoryDrive();
  const archive = new TranscriptDriveArchive(env.DB, f.exporter);
  expect(
    (await archive.tick({ client: async () => drive.client() }, fixtureNow))
      .state,
  ).toBe('VERIFIED');
  const eviction = new PayloadEviction(env.DB, f.owner),
    sourceId = source.completion.source_artifact_id;
  expect(
    (await eviction.step(sourceId, drive.client(), fixtureNow)).state,
  ).toBe('DRY_RUN');
  expect(
    (
      await eviction.step(sourceId, drive.client(), fixtureNow, {
        dry_run: false,
      })
    ).state,
  ).toBe('DELETION_DISABLED');
  await env.DB.prepare(
    "INSERT INTO retention_settings(owner_id,deletion_enabled,approval_reference) VALUES('a',1,'LOCAL-TEST-ONLY')",
  ).run();
  for (const fault of ['hash', 'unavailable']) {
    drive.setFault(fault);
    await expect(
      eviction.step(sourceId, drive.client(), fixtureNow, { dry_run: false }),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare('SELECT COUNT(*) n FROM artifact_chunks').first('n'),
    ).toBe(3);
  }
  drive.setFault('');
  expect(
    (
      await eviction.step(sourceId, drive.client(), fixtureNow, {
        dry_run: false,
      })
    ).state,
  ).toBe('EVICTED_PAGE');
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM artifact_chunks').first('n'),
  ).toBe(0);
  const repository = new ArtifactRepository(env.DB, f.owner, null, (h) =>
    new TranscriptPayloadArchive(env.DB, f.owner).read(h, async () =>
      drive.client(),
    ),
  );
  expect((await repository.readVerifiedText(sourceId, 1024 * 1024)).text).toBe(
    source.text,
  );
  const page = await repository.readOwnerPage(sourceId, 0);
  expect(page.chunks).toHaveLength(1);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM items').first('n')).toBe(
    1,
  );
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM artifacts').first('n'),
  ).toBe(3);
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM analysis_runs').first('n'),
  ).toBe(1);
  expect(
    (await eviction.restore(sourceId, drive.client())).restored_chunks,
  ).toBe(3);
  expect(
    (
      await new ArtifactRepository(env.DB, f.owner).readVerifiedText(
        sourceId,
        1024 * 1024,
      )
    ).text,
  ).toBe(source.text);
}, 30000);
it('resumes an interrupted upload with the reserved ID and creates no duplicate', async () => {
  const f = await compactFixture(),
    drive = memoryDrive();
  drive.setFault('crash');
  expect(
    (
      await new TranscriptDriveArchive(env.DB, f.exporter).tick(
        { client: async () => drive.client() },
        fixtureNow,
      )
    ).state,
  ).toBe('RETRY_WAIT');
  drive.setFault('');
  expect(
    (
      await new TranscriptDriveArchive(env.DB, f.exporter).tick(
        { client: async () => drive.client() },
        new Date(fixtureNow.getTime() + 3600000),
      )
    ).state,
  ).toBe('VERIFIED');
  expect(drive.creates).toBe(2);
});
it('archives a synthetic three-hour source without dropping cues or timestamp precision', async () => {
  const f = await compactFixture(1, 10800),
    drive = memoryDrive(),
    meter = meterDatabase(env.DB),
    source = f.inputs[0]!;
  const start = Date.now();
  const result = await new TranscriptDriveArchive(meter.db, f.exporter).tick(
    { client: async () => drive.client() },
    fixtureNow,
  );
  expect(result.state).toBe('VERIFIED');
  expect(meter.stats.queries).toBeLessThanOrEqual(50);
  const exact = [...drive.files.values()].find(
    (file) => file.meta.mimeType === 'application/json',
  )!;
  const pack = JSON.parse(exact.text);
  expect(pack.artifacts).toHaveLength(3);
  const payload = new TranscriptPayloadArchive(env.DB, f.owner);
  const repository = new ArtifactRepository(env.DB, f.owner, null, (h) =>
    payload.read(h, async () => drive.client()),
  );
  expect(
    (
      await repository.readVerifiedText(
        source.completion.source_artifact_id,
        4 * 1024 * 1024,
      )
    ).text,
  ).toBe(source.text);
  console.log(
    JSON.stringify({
      benchmark: 'long_compact_archive',
      cues: 10800,
      wall_ms: Date.now() - start,
      ...meter.stats,
      drive_requests: drive.requests,
      technical_bytes: new TextEncoder().encode(exact.text).length,
    }),
  );
}, 120000);
