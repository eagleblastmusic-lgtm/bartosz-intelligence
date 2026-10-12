import { env } from 'cloudflare:workers';
import { beforeEach, it, expect } from 'vitest';
import { resetCore, fixtureOwner } from './core-fixture.js';
import { dailyFixture, reportFixture } from './daily-workflow-fixture.js';
import { DailyTasksWorkflow } from '../../packages/core/src/daily/workflow.js';
import { DailyDriveStorage } from '../../packages/core/src/daily/drive.js';
import { renderDailyReport } from '../../packages/core/src/daily/format.js';
import {
  canonicalTranscriptRoot,
  canonicalReportRoot,
} from '../../packages/contracts/src/daily-report.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import worker from '../../apps/api/src/index.js';
import application from '../../config/application.json';
import { issueSession } from '../../packages/core/src/auth/session.js';
import { ArtifactRepository } from '../../packages/core/src/artifacts/store.js';
beforeEach(resetCore);
const morning = new Date('2026-10-12T06:05:00.000Z');
it('enrolls a first complete acceptance once, preserves its Warsaw acquisition date, and fences stale/disabled effects', async () => {
  const f = await dailyFixture();
  await f.material('rUhllpnYWR8', '2026-10-11T21:59:59.999Z', '0=1');
  expect((await f.workflow.day('2026-10-11')).expected_count).toBe(0);
  await f.material();
  await f.material('rUhllpnYWR8', '2026-10-12T12:00:00.000Z');
  await f.material('abcdefghijk', '2026-10-11T22:00:00.000Z');
  expect((await f.workflow.day('2026-10-11')).expected_count).toBe(1);
  expect((await f.workflow.day('2026-10-12')).expected_count).toBe(1);
  await env.DB.prepare(
    "UPDATE daily_workflow_settings SET enabled=0 WHERE owner_id='a'",
  ).run();
  await f.material('ABCDEFGHIJK');
  expect((await f.workflow.day('2026-10-11')).expected_count).toBe(1);
  await expect(
    env.DB.prepare(
      "UPDATE daily_materials SET material_date='2026-10-12' WHERE owner_id='a'",
    ).run(),
  ).rejects.toThrow('IMMUTABLE_DAILY_MATERIAL');
});
it('publishes full transcripts under Polish folders with source/timestamp integrity and no duplicate on restart', async () => {
  const f = await dailyFixture();
  await f.material();
  await f.workflow.tick(f.drive, morning);
  const storage = new DailyDriveStorage(
      env.DB,
      f.owner,
      f.drive,
      async () => {},
    ),
    row = await storage.read('transcript:rUhllpnYWR8');
  expect(row?.state).toBe('VERIFIED');
  expect(await sha256(f.drive.texts.get(row!.reserved_file_id)!)).toBe(
    row!.verified_hash,
  );
  expect(f.drive.texts.get(row!.reserved_file_id)).toContain(
    'Ostatnie istotne zastrzeżenie.',
  );
  expect(
    [...f.drive.files.values()]
      .filter((f) => f.mimeType === 'application/vnd.google-apps.folder')
      .map((f) => f.name),
  ).toEqual(expect.arrayContaining(['2026', 'Październik', '11']));
  const parent = f.drive.files.get(row!.folder_id)!;
  expect(parent.name).toBe('11');
  expect((await storage.read('manifest:2026-10-11'))?.state).toBe('VERIFIED');
  const creates = f.drive.creates;
  await new DailyTasksWorkflow(env.DB, f.owner).tick(
    f.drive,
    new Date(morning.getTime() + 300000),
  );
  expect(f.drive.creates).toBe(creates);
});
it('does not close an open day or mark a pending Drive source ready; late completed sources enter the next day', async () => {
  const f = await dailyFixture();
  await f.material();
  await f.material('abcdefghijk', '2026-10-11T22:00:00.000Z');
  await expect(f.workflow.close('2026-10-12', morning)).rejects.toThrow(
    'DAILY_DAY_OPEN',
  );
  const manifest = await f.workflow.close('2026-10-11', morning);
  expect(manifest.expected_count).toBe(1);
  expect(manifest.ready_count).toBe(0);
  expect(manifest.entries[0]!.state).toBe('PENDING');
});
it.each(['create-before-write', 'create-after-write'] as const)(
  'recovers %s with the reserved ID and intact source',
  async (fault) => {
    const f = await dailyFixture();
    await f.material();
    f.drive.fault = fault;
    await f.workflow.tick(f.drive, morning);
    await new DailyTasksWorkflow(env.DB, f.owner).tick(
      f.drive,
      new Date(morning.getTime() + 300000),
    );
    const row = await env.DB.prepare(
      "SELECT state,reserved_file_id FROM daily_drive_files WHERE object_key='transcript:rUhllpnYWR8'",
    ).first<{ state: string; reserved_file_id: string }>();
    expect(row?.state).toBe('VERIFIED');
    expect(
      [...f.drive.files.values()].filter((f) => f.name === 'rUhllpnYWR8.md'),
    ).toHaveLength(1);
    expect(
      await env.DB.prepare(
        "SELECT state FROM artifacts WHERE artifact_id='source_rUhllpnYWR8'",
      ).first('state'),
    ).toBe('VERIFIED');
  },
);
it('holds corrupted readback and public permissions without a false ready receipt or a write to a public root', async () => {
  const f = await dailyFixture();
  await f.material();
  f.drive.fault = 'public';
  expect((await f.workflow.tick(f.drive, morning)).state).toBe(
    'PERMISSION_HOLD',
  );
  expect(f.drive.creates).toBe(0);
  expect((await f.workflow.settings())?.enabled).toBe(0);
  f.drive.fault = '';
  const settings = (await f.workflow.settings())!;
  await f.workflow.configure(
    f.drive,
    {
      connection_id: settings.connection_id,
      staging_folder_id: settings.staging_folder_id,
      enabled: true,
    },
    morning,
  );
  f.drive.fault = 'corrupt-readback';
  await f.workflow.tick(f.drive, morning);
  expect((await f.workflow.day('2026-10-11')).ready_count).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT state FROM daily_drive_files WHERE object_key='transcript:rUhllpnYWR8'",
    ).first('state'),
  ).toBe('CONFLICT');
});
it('withdraws completeness in both day and calendar after root privacy or the Drive connection is lost', async () => {
  const f = await dailyFixture();
  await f.material();
  await f.workflow.tick(f.drive, morning);
  f.drive.addDocument(
    'doc',
    '2026-10-11',
    renderDailyReport(
      await reportFixture(await f.workflow.close('2026-10-11', morning)),
    ),
  );
  await f.workflow.tick(f.drive, new Date(morning.getTime() + 300000));
  const calendarComplete = async () =>
    (await f.workflow.calendar('2026-10')).days.find(
      (day) => day.date === '2026-10-11',
    )!.complete;
  expect(await calendarComplete()).toBe(true);
  await env.DB.prepare(
    "UPDATE drive_connections SET auth_state='REAUTH_REQUIRED' WHERE owner_id='a'",
  ).run();
  expect((await f.workflow.day('2026-10-11')).state).toBe('INTEGRITY_HOLD');
  expect(await calendarComplete()).toBe(false);
  await env.DB.prepare(
    "UPDATE drive_connections SET auth_state='CONNECTED' WHERE owner_id='a'",
  ).run();
  const creates = f.drive.creates;
  f.drive.fault = 'public';
  expect(
    (await f.workflow.tick(f.drive, new Date(morning.getTime() + 600000)))
      .state,
  ).toBe('PERMISSION_HOLD');
  expect(f.drive.creates).toBe(creates);
  expect((await f.workflow.day('2026-10-11')).state).toBe('INTEGRITY_HOLD');
  expect(await calendarComplete()).toBe(false);
});
it('imports native Docs from the private inbox as one actual Markdown, verifies placement and preserves a valid report on rerun/conflict', async () => {
  const f = await dailyFixture();
  await f.material();
  await f.workflow.tick(f.drive, morning);
  const manifest = await f.workflow.close('2026-10-11', morning),
    report = await reportFixture(manifest);
  f.drive.addDocument('native-doc', '2026-10-11', renderDailyReport(report));
  await f.workflow.tick(f.drive, new Date(morning.getTime() + 300000));
  const day = await f.workflow.day('2026-10-11');
  expect(day.state).toBe('COMPLETE');
  expect(day.videos).toEqual(report.videos);
  expect(day.missing_video_ids).toEqual([]);
  const canonical = f.drive.files.get(day.report_file_id!)!;
  expect(canonical.mimeType).toBe('text/markdown');
  expect(canonical.name).toBe('2026-10-11.md');
  expect(f.drive.files.get(canonical.parents![0]!)!.name).toBe('11');
  expect(f.drive.files.get('native-doc')!.parents).toEqual(['inbox']);
  expect(
    [...f.drive.files.values()].filter((f) => f.name === '2026-10-11.md'),
  ).toHaveLength(1);
  const creates = f.drive.creates;
  await f.workflow.registerCandidate('native-doc', '2026-10-11', morning);
  await f.workflow.tick(f.drive, new Date(morning.getTime() + 600000));
  expect(f.drive.creates).toBe(creates);
  report.videos[0]!.summary += ' Inna treść.';
  f.drive.texts.set('native-doc', renderDailyReport(report));
  f.drive.files.get('native-doc')!.version = '2';
  await f.workflow.registerCandidate('native-doc', '2026-10-11', morning);
  await f.workflow.tick(f.drive, new Date(morning.getTime() + 900000));
  expect((await f.workflow.day('2026-10-11')).videos[0]!.summary).not.toContain(
    'Inna treść',
  );
});
it('automatically reimports a corrected partial report without duplicates and exposes omitted films', async () => {
  const f = await dailyFixture();
  await f.material();
  await f.workflow.tick(f.drive, morning);
  const report = await reportFixture(
      await f.workflow.close('2026-10-11', morning),
    ),
    full = structuredClone(report);
  Object.assign(report.videos[0]!, {
    status: 'UNPROCESSED',
    summary: '',
    reason: 'Nie udało się przeczytać całego pliku',
  });
  report.processed_count = 0;
  report.skipped_count = 1;
  f.drive.addDocument('doc', '2026-10-11', renderDailyReport(report));
  await f.workflow.tick(f.drive, new Date(morning.getTime() + 300000));
  expect((await f.workflow.day('2026-10-11')).state).toBe('PARTIAL');
  expect((await f.workflow.day('2026-10-11')).missing_video_ids).toEqual([
    'rUhllpnYWR8',
  ]);
  f.drive.texts.set('doc', renderDailyReport(full));
  f.drive.files.get('doc')!.version = '2';
  await f.workflow.tick(f.drive, new Date(morning.getTime() + 600000));
  expect((await f.workflow.day('2026-10-11')).state).toBe('COMPLETE');
  expect(
    [...f.drive.files.values()].filter((f) => f.name === '2026-10-11.md'),
  ).toHaveLength(1);
});
it('adopts a verified direct Markdown without copying or moving it, and detects later canonical moves', async () => {
  const f = await dailyFixture();
  await f.material();
  await f.workflow.tick(f.drive, morning);
  const storage = new DailyDriveStorage(
      env.DB,
      f.owner,
      f.drive,
      async () => {},
    ),
    folder = await storage.folder(canonicalReportRoot, '2026-10-11', morning),
    report = await reportFixture(await f.workflow.close('2026-10-11', morning));
  f.drive.addDocument(
    'direct',
    '2026-10-11',
    renderDailyReport(report),
    false,
    folder,
  );
  const creates = f.drive.creates;
  await f.workflow.tick(f.drive, new Date(morning.getTime() + 300000));
  expect((await f.workflow.day('2026-10-11')).report_file_id).toBe('direct');
  expect(f.drive.creates).toBe(creates);
  f.drive.files.get('direct')!.parents = ['inbox'];
  await f.workflow.tick(f.drive, new Date(morning.getTime() + 600000));
  expect((await f.workflow.day('2026-10-11')).state).toBe('INTEGRITY_HOLD');
});
it('isolates owners, refuses a second active lease and blocks workers from reading report content', async () => {
  const f = await dailyFixture();
  await f.material();
  const other = await fixtureOwner('b');
  expect(
    (await new DailyTasksWorkflow(env.DB, other).day('2026-10-11'))
      .expected_count,
  ).toBe(0);
  await env.DB.prepare(
    "UPDATE daily_workflow_settings SET lease_owner='other',lease_until='2099-01-01T00:00:00Z' WHERE owner_id='a'",
  ).run();
  expect(await f.workflow.tick(f.drive, morning)).toEqual({
    state: 'LEASE_BUSY',
  });
  expect(f.drive.creates).toBe(0);
  await env.DB.prepare(
    "INSERT INTO worker_identities VALUES('exporter','a',?,'[\"DRIVE_EXPORT\"]',?,NULL)",
  )
    .bind(await sha256('credential'), morning.toISOString())
    .run();
  const access = await AccessContext.worker(env.DB, await sha256('credential'));
  await expect(
    new DailyTasksWorkflow(env.DB, access).day('2026-10-11'),
  ).rejects.toThrow('FORBIDDEN');
  const response = await worker.fetch(
    new Request(application.app_origin + '/api/v1/daily/reports/2026-10-11'),
    {
      ...env,
      SESSION_SIGNING_SECRET: 'fixture-session-signing-key-32-bytes-minimum',
      APP_ORIGIN: application.app_origin,
      GOOGLE_OIDC_CLIENT_ID: 'fixture-client',
      GOOGLE_OIDC_CLIENT_SECRET: 'fixture-secret',
      GOOGLE_OIDC_OWNER_SUBJECT: 'subject-a',
    },
  );
  expect(response.status).toBe(401);
});
it('keeps canonical transcript/report namespaces separate from legacy roots', async () => {
  const f = await dailyFixture();
  const settings = await f.workflow.settings();
  expect(settings?.transcript_root_id).toBe(canonicalTranscriptRoot);
  expect(settings?.report_root_id).toBe(canonicalReportRoot);
  expect(
    await env.DB.prepare(
      "SELECT root_id FROM drive_connections WHERE owner_id='a'",
    ).first('root_id'),
  ).toBe('old-root');
});
it('serves a verified report through the authenticated backend and requires CSRF for candidate writes', async () => {
  const f = await dailyFixture();
  await f.material();
  await f.workflow.tick(f.drive, morning);
  f.drive.addDocument(
    'doc',
    '2026-10-11',
    renderDailyReport(
      await reportFixture(await f.workflow.close('2026-10-11', morning)),
    ),
  );
  await f.workflow.tick(f.drive, new Date(morning.getTime() + 300000));
  const secret = 'fixture-session-signing-key-32-bytes-minimum',
    signed = await issueSession(
      env.DB,
      { issuer: 'https://accounts.google.com', subject: 'subject-a' },
      secret,
      new Date(),
    ),
    cookie = signed.cookie.split(';')[0]!;
  const settings = {
    ...env,
    SESSION_SIGNING_SECRET: secret,
    APP_ORIGIN: application.app_origin,
    GOOGLE_OIDC_CLIENT_ID: 'fixture-client',
    GOOGLE_OIDC_CLIENT_SECRET: 'fixture-secret',
    GOOGLE_OIDC_OWNER_SUBJECT: 'subject-a',
  };
  const response = await worker.fetch(
    new Request(application.app_origin + '/api/v1/daily/reports/2026-10-11', {
      headers: { Cookie: cookie },
    }),
    settings,
  );
  expect(response.status).toBe(200);
  expect(((await response.json()) as { state: string }).state).toBe('COMPLETE');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const denied = await worker.fetch(
    new Request(application.app_origin + '/api/v1/daily/reports/candidates', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: application.app_origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file_id: 'doc', material_date: '2026-10-11' }),
    }),
    settings,
  );
  expect(denied.status).toBe(403);
});
it('allows the scoped scheduled exporter only during its active lease, without widening artifact access', async () => {
  const f = await dailyFixture();
  await f.material();
  await env.DB.prepare(
    "INSERT INTO worker_identities VALUES('exporter','a',?,'[\"DRIVE_EXPORT\"]',?,NULL)",
  )
    .bind(await sha256('credential'), morning.toISOString())
    .run();
  const context = await AccessContext.worker(
    env.DB,
    await sha256('credential'),
  );
  expect(
    (await new DailyTasksWorkflow(env.DB, context).tick(f.drive, morning))
      .state,
  ).toBe('BOUNDED_TICK');
  expect((await f.workflow.day('2026-10-11')).ready_count).toBe(1);
  await expect(
    new ArtifactRepository(env.DB, context).readTranscriptArchiveText(
      'source_rUhllpnYWR8',
      morning,
    ),
  ).rejects.toThrow('NOT_FOUND');
});
