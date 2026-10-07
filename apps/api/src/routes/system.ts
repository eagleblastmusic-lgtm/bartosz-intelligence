import { ownerRouter, body, queryFields } from './common.js';
import { unobservedCapacity } from '../../../../packages/core/src/projections/capacity.js';
import { exportStatus } from '../../../../packages/core/src/export/status.js';
import { sha256 } from '../../../../packages/core/src/auth/crypto.js';
import type { PipelineProfile } from '../../../../packages/contracts/src/ai.js';
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
  queryFields(c, []);
  const owner = c.get('access').ownerId,
    now = new Date().toISOString();
  const [
    jobs,
    workers,
    health,
    quota,
    sources,
    outbox,
    backup,
    capacity,
    reasons,
    usage,
    models,
    prompts,
    scans,
    transcriptCoverage,
    dailyExports,
  ] = await Promise.all([
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
      "SELECT COUNT(*) arrival_count,SUM(CASE WHEN state='SUCCEEDED' THEN 1 ELSE 0 END) succeeded_jobs_count,(SELECT COUNT(*) FROM analysis_runs r WHERE r.owner_id=? AND r.state='ACCEPTED' AND json_extract(r.outcome_json,'$.version')='intelligence-accepted:1') accepted_count,COALESCE(SUM(CASE WHEN state!='SUCCEEDED' THEN 1 ELSE 0 END),0) open_count,MIN(CASE WHEN state!='SUCCEEDED' THEN arrival_origin_at END) oldest_open_arrival_origin_at,SUM(CASE WHEN state IN ('PENDING','RETRY_WAIT','DEFERRED') AND due_at<=? THEN 1 ELSE 0 END) due_count,SUM(CASE WHEN state IN ('LEASED','RUNNING') AND lease_until<=? THEN 1 ELSE 0 END) expired_lease_count FROM jobs WHERE owner_id=?",
    )
      .bind(owner, now, now, owner)
      .first(),
    c.env.DB.prepare(
      "SELECT state,task_type,origin_kind,reason_code,COUNT(*) count,MIN(arrival_origin_at) oldest_arrival_origin_at,MIN(due_at) next_due_at,SUM(attempt_count) attempts FROM jobs WHERE owner_id=? AND state!='SUCCEEDED' GROUP BY state,task_type,origin_kind,reason_code ORDER BY count DESC LIMIT 50",
    )
      .bind(owner)
      .all(),
    c.env.DB.prepare(
      'SELECT COUNT(*) requests,COALESCE(SUM(input_tokens),0) known_input_tokens,COALESCE(SUM(output_tokens),0) known_output_tokens,COALESCE(SUM(total_tokens),0) known_total_tokens,COALESCE(SUM(CASE WHEN total_tokens IS NULL THEN 1 ELSE 0 END),0) unknown_usage_count,MAX(observed_at) latest_observed_at FROM usage_records WHERE owner_id=?',
    )
      .bind(owner)
      .first(),
    c.env.DB.prepare(
      "SELECT profile_id,revision,snapshot_json,content_hash FROM model_registry WHERE owner_id=? AND profile_id='gemini_free' ORDER BY revision DESC LIMIT 1",
    )
      .bind(owner)
      .all<{
        profile_id: string;
        revision: number;
        snapshot_json: string;
        content_hash: string;
      }>(),
    c.env.DB.prepare(
      "SELECT p.prompt_id,p.version,p.status FROM prompt_versions p WHERE p.owner_id=? AND p.status='PUBLISHED' AND p.version=(SELECT MAX(q.version) FROM prompt_versions q WHERE q.owner_id=p.owner_id AND q.prompt_id=p.prompt_id AND q.status='PUBLISHED') ORDER BY p.prompt_id LIMIT 20",
    )
      .bind(owner)
      .all(),
    c.env.DB.prepare(
      'SELECT source_id,scan_id,coverage,enumerated_count,started_at,completed_at,window_start,window_end FROM discovery_scans WHERE owner_id=? ORDER BY started_at DESC LIMIT 50',
    )
      .bind(owner)
      .all(),
    c.env.DB.prepare(
      "SELECT COUNT(*) denominator,COALESCE(SUM(EXISTS(SELECT 1 FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=i.owner_id AND r.item_id=i.item_id AND r.state='ACCEPTED' AND j.task_type='FETCH_TRANSCRIPT' AND json_extract(r.outcome_json,'$.version')='transcript-source:1')),0) usable_source FROM items i WHERE i.owner_id=? AND i.availability='PUBLIC' AND EXISTS(SELECT 1 FROM jobs j WHERE j.owner_id=i.owner_id AND j.item_id=i.item_id AND j.task_type='FETCH_TRANSCRIPT')",
    )
      .bind(owner)
      .first(),
    exportStatus(c.env.DB, c.get('access'), new Date(now)),
  ]);
  return c.json({
    sampled_at: now,
    paid_services_enabled: false,
    transcript_runtime: 'local',
    daily_exports: dailyExports,
    ai_profile: 'gemini_free',
    pipeline_profiles: await Promise.all(
      models.results.map(async (row) => {
        if ((await sha256(row.snapshot_json)) !== row.content_hash)
          return {
            profile_id: row.profile_id,
            revision: row.revision,
            integrity: 'FAIL',
          };
        const profile = JSON.parse(row.snapshot_json) as PipelineProfile;
        return {
          profile_id: row.profile_id,
          revision: row.revision,
          integrity: 'PASS',
          provider_id: profile.provider_id,
          model: profile.model,
          free_eligible: profile.free_eligible,
          billing_enabled: profile.billing_enabled,
          eligibility_expires_at: profile.eligibility_expires_at,
          freshness: profile.eligibility_expires_at > now ? 'FRESH' : 'STALE',
          quality_approval_count: profile.quality_approvals.length,
        };
      }),
    ),
    registry_versions: {
      published_prompts: prompts.results,
      wire: '1.0',
      canonical: '1.2',
      enrichment: '1.0',
    },
    usage: usage,
    costs: {
      status: 'PAID_DISABLED',
      paid_services_enabled: false,
      actual_external_cost: null,
      external_cost_status: 'NOT_OBSERVED',
    },
    job_reasons: reasons.results,
    recent_discovery_scans: scans.results,
    capacity_metrics: unobservedCapacity(now),
    transcript_coverage: {
      ...transcriptCoverage,
      cohort: 'AVAILABLE_ITEMS_WITH_TRANSCRIPT_JOB',
      provider_success: {
        value: null,
        status: 'UNKNOWN',
        reason: 'ELIGIBLE_ATTEMPT_DENOMINATOR_NOT_MEASURED',
      },
    },
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
