import { ownerRouter, body } from './common.js';
import {
  QuotaSnapshots,
  type GeminiQuotaObservation,
} from '../../../../packages/core/src/ai/quota-snapshots.js';
export const systemApp = ownerRouter();
systemApp.post('/quota-observations', async (c) => {
  const input = await body(c, ['observation']);
  return c.json(
    await new QuotaSnapshots(c.env.DB, c.get('access')).record(
      input.observation as GeminiQuotaObservation,
      new Date(),
    ),
  );
});
systemApp.get('/summary', async (c) => {
  const owner = c.get('access').ownerId,
    now = new Date().toISOString();
  const [jobs, workers, health, quota, sources, outbox, backup, capacity] =
    await Promise.all([
      c.env.DB.prepare(
        `SELECT state,task_type,origin_kind,COUNT(*) AS count,MIN(arrival_origin_at) AS oldest_arrival_origin_at FROM jobs WHERE owner_id=? GROUP BY state,task_type,origin_kind`,
      )
        .bind(owner)
        .all(),
      c.env.DB.prepare(
        `SELECT s.worker_id,s.runtime,s.heartbeat_at,s.online_until FROM worker_sessions s JOIN worker_identities w USING(owner_id,worker_id) WHERE s.owner_id=? AND w.revoked_at IS NULL ORDER BY heartbeat_at DESC LIMIT 50`,
      )
        .bind(owner)
        .all<{
          worker_id: string;
          runtime: string;
          heartbeat_at: string;
          online_until: string;
        }>(),
      c.env.DB.prepare(
        `SELECT provider,runtime,state,sampled_at,expires_at FROM provider_health WHERE owner_id=? ORDER BY sampled_at DESC LIMIT 50`,
      )
        .bind(owner)
        .all<{
          provider: string;
          runtime: string;
          state: string;
          sampled_at: string;
          expires_at: string;
        }>(),
      c.env.DB.prepare(
        `SELECT provider,model,bucket,units,remaining,limit_value,used_value,reset_at,source,sampled_at,expires_at,confidence FROM quota_snapshots WHERE owner_id=? ORDER BY sampled_at DESC LIMIT 50`,
      )
        .bind(owner)
        .all<{ expires_at: string }>(),
      c.env.DB.prepare(
        'SELECT source_id,last_rss_at,last_attempt_at,last_success_at,last_complete_window_end FROM sources WHERE owner_id=? ORDER BY activated_at DESC LIMIT 50',
      )
        .bind(owner)
        .all(),
      c.env.DB.prepare(
        'SELECT COUNT(*) pending,MIN(due_at) oldest_due_at FROM outbox WHERE owner_id=? AND delivered_at IS NULL',
      )
        .bind(owner)
        .first(),
      c.env.DB.prepare(
        "SELECT MAX(created_at) last_verified_at FROM backup_snapshots WHERE owner_id=? AND state='VERIFIED'",
      )
        .bind(owner)
        .first(),
      c.env.DB.prepare(
        "SELECT COUNT(*) arrival_count,SUM(CASE WHEN state='SUCCEEDED' THEN 1 ELSE 0 END) accepted_count,SUM(CASE WHEN state NOT IN ('SUCCEEDED','FAILED') THEN 1 ELSE 0 END) open_count,SUM(CASE WHEN state IN ('PENDING','RETRY_WAIT','DEFERRED') AND due_at<=? THEN 1 ELSE 0 END) due_count,SUM(CASE WHEN state IN ('LEASED','RUNNING') AND lease_until<=? THEN 1 ELSE 0 END) expired_lease_count FROM jobs WHERE owner_id=?",
      )
        .bind(now, now, owner)
        .first(),
    ]);
  return c.json({
    sampled_at: now,
    paid_services_enabled: false,
    transcript_runtime: 'local',
    ai_profile: 'gemini_free',
    durable_jobs: jobs.results,
    source_coverage: sources.results,
    outbox,
    backup,
    capacity: {
      ...capacity,
      service_rate: null,
      service_rate_status: 'NOT_CALIBRATED',
    },
    database_usage: {
      status: 'UNKNOWN',
      rows_read: null,
      rows_written: null,
      storage_bytes: null,
    },
    queue_operations: { status: 'UNKNOWN', value: null },
    workers: workers.results.map((row) => ({
      ...row,
      availability: row.online_until > now ? 'ONLINE' : 'OFFLINE',
    })),
    provider_health: health.results.map((row) => ({
      ...row,
      state: row.expires_at > now ? row.state : 'UNKNOWN',
      freshness: row.expires_at > now ? 'FRESH' : 'STALE',
    })),
    quota: quota.results.map((row) => ({
      ...row,
      freshness: row.expires_at > now ? 'FRESH' : 'STALE',
    })),
    unobserved_provider_status: 'UNKNOWN',
  });
});
