import { randomUUID } from 'node:crypto';
import {
  AccessContext,
  type Database,
} from '../../../packages/core/src/db/boundary.js';
import { sha256, randomToken } from '../../../packages/core/src/auth/crypto.js';
import {
  DriveClient,
  DriveFailure,
} from '../../../packages/core/src/drive/client.js';
import { DriveExportIdentity } from '../../../packages/core/src/drive/identity.js';
import { DailyExportArtifacts } from '../../../packages/core/src/export/artifacts.js';
import { runDriveExportTick } from '../../../packages/core/src/export/runtime.js';

// Real D1/runtime/artifact path with an explicitly simulated Drive transport.
export async function drillDrive(
  db: Database,
  owner: AccessContext,
  now: Date,
) {
  const id = 'drive-drill-' + randomUUID(),
    credential = await sha256(randomToken());
  const root = id + '-root',
    date = '2000-01-01';
  await db
    .prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(id, owner.ownerId, credential, '["DRIVE_EXPORT"]', now.toISOString())
    .run();
  await db
    .prepare(
      `INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,root_id,root_state,revision,last_intent_hash,created_at,updated_at) VALUES(?,?,?,?,?,'CONNECTED',?,'VERIFIED',1,?,?,?)`,
    )
    .bind(
      owner.ownerId,
      id,
      'isolated-subject',
      'isolated-client',
      '[]',
      root,
      id,
      now.toISOString(),
      now.toISOString(),
    )
    .run();
  // Exclude restored production mappings from this disposable consumer drill.
  await db
    .prepare('UPDATE export_state SET paused_reason=? WHERE owner_id=?')
    .bind('ISOLATED_DRILL_EXCLUDED', owner.ownerId)
    .run();
  const context = await AccessContext.worker(db, credential);
  const identity = new DriveExportIdentity(db, context);
  await identity.ensure(id, root, date, new Date(now.getTime() - 1800000));
  const properties = await identity.appProperties(root, date);
  let calls = 0,
    creates = 0,
    exists = false,
    markdown = '';
  const input = {
    app_origin: 'https://example.test',
    cursor_secret: randomToken(),
    client: async () => {
      calls++;
      if (calls === 1) throw new DriveFailure('TRANSIENT');
      const artifact = await db
        .prepare(
          'SELECT rendered_artifact_id FROM export_state WHERE owner_id=? AND root_namespace=? AND publication_date=?',
        )
        .bind(owner.ownerId, root, date)
        .first<string>('rendered_artifact_id');
      markdown = new TextDecoder().decode(
        (await new DailyExportArtifacts(db, context).read(artifact!)).bytes,
      );
      const file = {
        id: id + '-file',
        name: date + '.md',
        mimeType: 'text/markdown',
        parents: [root],
        trashed: false,
        version: '1',
        appProperties: properties,
      };
      return new DriveClient('synthetic', async (target, init) => {
        if (String(target).includes('generateIds'))
          return Response.json({ ids: [file.id] });
        if (init?.method === 'POST') {
          creates++;
          exists = true;
          return Response.json(file);
        }
        if (!exists) return new Response(null, { status: 404 });
        return String(target).includes('alt=media')
          ? new Response(markdown)
          : Response.json(file);
      });
    },
  };
  const first = await runDriveExportTick(db, context, input, now);
  const snapshot = async () =>
    db
      .prepare(
        'SELECT rendered_artifact_id,revision,next_retry_at,dirty_seq,exported_seq,full_file_hash FROM export_state WHERE owner_id=? AND root_namespace=? AND publication_date=?',
      )
      .bind(owner.ownerId, root, date)
      .first<{
        rendered_artifact_id: string;
        revision: number;
        next_retry_at: string;
        dirty_seq: number;
        exported_seq: number;
        full_file_hash: string;
      }>();
  const failed = (await snapshot())!;
  const early = await runDriveExportTick(
    db,
    context,
    input,
    new Date(now.getTime() + 299000),
  );
  const recovered = await runDriveExportTick(
    db,
    await AccessContext.worker(db, credential),
    input,
    new Date(failed.next_retry_at),
  );
  const final = (await snapshot())!;
  const repeated = await runDriveExportTick(
    db,
    context,
    input,
    new Date(Date.parse(failed.next_retry_at) + 1),
  );
  const observations = {
    failure_state: first.state,
    early_state: early.state,
    recovered_state: recovered.state,
    repeated_state: repeated.state,
    same_artifact: failed.rendered_artifact_id === final.rendered_artifact_id,
    failure_revision: failed.revision,
    final_revision: final.revision,
    creates,
    canonical_readback: final.full_file_hash === (await sha256(markdown)),
    dirty_acknowledged: final.exported_seq >= final.dirty_seq,
    provider_requests: 0,
    simulated_transport: true,
    logical_clock: true,
  };
  return {
    pass:
      first.state === 'RETRY_WAIT' &&
      early.state === 'IDLE' &&
      recovered.state === 'VERIFIED' &&
      repeated.state === 'IDLE' &&
      observations.same_artifact &&
      failed.revision === 0 &&
      final.revision === 1 &&
      creates === 1 &&
      observations.canonical_readback &&
      observations.dirty_acknowledged,
    observations,
  };
}
