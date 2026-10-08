import { assertContext, AccessContext, type Database } from '../db/boundary.js';
import { DriveExportIdentity } from '../drive/identity.js';
import { DriveClient, DriveFailure } from '../drive/client.js';
import { DriveOAuthFailure } from '../drive/oauth.js';
import { ExportDirtyDays } from './dirty.js';
import { DailyExportArtifacts } from './artifacts.js';
import { DailyExportExecutor } from './executor.js';
import { renderOwnerDaily } from './snapshot.js';

/** One fair day per tick. Retry identity and backoff survive process restarts. */
export async function runDriveExportTick(
  db: Database,
  context: AccessContext,
  input: {
    app_origin: string;
    cursor_secret: string;
    client: (connectionId: string) => Promise<DriveClient>;
  },
  now: Date,
) {
  assertContext(context);
  context.requireTask('DRIVE_EXPORT');
  const active = await AccessContext.worker(db, context.credentialHash!);
  active.requireTask('DRIVE_EXPORT');
  if (active.ownerId !== context.ownerId) throw new Error('FORBIDDEN');
  if (
    !Number.isFinite(now.getTime()) ||
    input.cursor_secret.length < 32 ||
    new URL(input.app_origin).origin !== input.app_origin
  )
    throw new Error('INVALID_EXPORT_RUNTIME');
  const dirty = new ExportDirtyDays(db, context);
  const replay = await dirty.sync(now);
  const due = (await dirty.due(now))[0];
  if (!due) return { state: 'IDLE' as const, replay };
  const identity = new DriveExportIdentity(db, context);
  const lease = await identity.claim(
    due.root_id,
    due.date,
    context.actorId,
    now,
  );
  const binding = [
    context.ownerId,
    due.root_id,
    due.date,
    lease.lease_owner,
    lease.fencing_token,
  ] as const;
  const predicate =
    "owner_id=? AND root_namespace=? AND publication_date=? AND lease_owner=? AND fencing_token=? AND destination_key GLOB 'drive:*'";
  try {
    const state = await db
      .prepare(
        `SELECT connection_id,revision,COALESCE(desired_mode,mode) mode,rendered_artifact_id,retry_count FROM export_state WHERE ${predicate}`,
      )
      .bind(...binding)
      .first<{
        connection_id: string;
        revision: number;
        mode: 'COMPACT' | 'FULL';
        rendered_artifact_id: string | null;
        retry_count: number;
      }>();
    if (!state) throw new Error('EXPORT_STALE_FENCE_OR_REVISION');
    const artifacts = new DailyExportArtifacts(db, context);
    let artifactId: string | null = null;
    if (state.rendered_artifact_id) {
      const saved = await artifacts.read(state.rendered_artifact_id);
      const reason = await db
        .prepare(
          'SELECT reason FROM drive_export_attempts WHERE owner_id=? AND artifact_id=?',
        )
        .bind(context.ownerId, state.rendered_artifact_id)
        .first<string>('reason');
      if (
        saved.manifest.revision > state.revision &&
        saved.manifest.mode === state.mode &&
        reason !== 'NO_MATERIAL_CHANGE'
      )
        artifactId = state.rendered_artifact_id;
    }
    if (!artifactId) {
      const lastRevision = await db
        .prepare(
          'SELECT COALESCE(MAX(revision),0) revision FROM daily_export_artifacts WHERE owner_id=? AND root_id=? AND publication_date=?',
        )
        .bind(context.ownerId, due.root_id, due.date)
        .first<number>('revision');
      const report = await renderOwnerDaily(
        db,
        context,
        {
          date: due.date,
          app_origin: input.app_origin,
          revision: Math.max(state.revision, lastRevision ?? 0) + 1,
          mode: state.mode,
        },
        input.cursor_secret,
        now,
      );
      artifactId = await artifacts.save(lease, report, now);
    }
    const client = await input.client(state.connection_id);
    const receipt = await new DailyExportExecutor(db, context).execute(
      lease,
      artifactId,
      client,
      now,
    );
    await db
      .prepare(
        `UPDATE export_state SET retry_count=0,next_retry_at=NULL,paused_reason=NULL,last_failure_code=NULL WHERE ${predicate}`,
      )
      .bind(...binding)
      .run();
    return { state: 'VERIFIED' as const, receipt, replay };
  } catch (error) {
    const count =
      ((await db
        .prepare(`SELECT retry_count FROM export_state WHERE ${predicate}`)
        .bind(...binding)
        .first<number>('retry_count')) ?? 0) + 1;
    const code =
      error instanceof DriveFailure
        ? 'DRIVE_' + error.category
        : error instanceof DriveOAuthFailure
          ? 'DRIVE_AUTHORIZATION'
          : error instanceof Error && error.message === 'EXPORT_CONFLICT'
            ? 'EXPORT_CONFLICT'
            : 'EXPORT_RECOVERY_REQUIRED';
    const permanent =
      (error instanceof DriveFailure &&
        [
          'CONFLICT',
          'DENIED',
          'FORMAT',
          'NOT_FOUND',
          'UNQUALIFIED_UPDATE',
        ].includes(error.category)) ||
      code === 'EXPORT_CONFLICT';
    const retryAfter =
      error instanceof DriveFailure ? (error.retry_after_seconds ?? 0) : 0;
    const seconds = Math.min(
      86400,
      Math.max(retryAfter, Math.min(21600, 300 * 2 ** Math.min(count - 1, 7))),
    );
    const paused = permanent
      ? code
      : count >= 8
        ? 'RETRY_BUDGET_EXHAUSTED'
        : null;
    const retryAt = paused
      ? null
      : new Date(now.getTime() + seconds * 1000).toISOString();
    await db
      .prepare(
        `UPDATE export_state SET retry_count=?,next_retry_at=?,paused_reason=?,last_failure_code=? WHERE ${predicate}`,
      )
      .bind(count, retryAt, paused, code, ...binding)
      .run();
    return {
      state: paused ? ('PAUSED' as const) : ('RETRY_WAIT' as const),
      reason: code,
      retry_at: retryAt,
      replay,
    };
  } finally {
    await identity.release(lease);
  }
}
