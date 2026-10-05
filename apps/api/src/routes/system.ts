import { ownerRouter } from './common.js';
export const systemApp = ownerRouter();
systemApp.get('/summary', async (c) => {
  const owner = c.get('access').ownerId,
    now = new Date().toISOString();
  const [jobs, workers, health, quota] = await Promise.all([
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
  ]);
  return c.json({
    sampled_at: now,
    paid_services_enabled: false,
    transcript_runtime: 'local',
    ai_profile: 'gemini_free',
    durable_jobs: jobs.results,
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
