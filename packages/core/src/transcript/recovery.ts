import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { JobStore } from '../jobs/store.js';
import { retryDisposition } from '../jobs/policy.js';
import type { LeaseToken } from '../../../contracts/src/jobs.js';
import type { TranscriptStatus } from '../../../contracts/src/transcript.js';

export const transcriptRuntime = Object.freeze({
  primary: 'local',
  provider: 'local_ytdlp',
  cloud_caption_enabled: false,
  stt_enabled: false,
  stt_reason: 'NO_QUALIFIED_HARDWARE_ROUTE',
  paid_services_enabled: false,
});
export function transcriptDisposition(
  status: TranscriptStatus,
  counts: { no_captions: number; transient: number },
  now: Date,
  activeLive = false,
  random = Math.random,
) {
  if (status === 'OK' || status === 'PARTIAL')
    throw new Error('SOURCE_ACCEPTANCE_REQUIRED');
  if (
    !Number.isSafeInteger(counts.no_captions) ||
    counts.no_captions < 0 ||
    !Number.isSafeInteger(counts.transient) ||
    counts.transient < 0
  )
    throw new Error('INVALID_ATTEMPT');
  const defer = (reason: string, milliseconds: number) => ({
    state: 'DEFERRED' as const,
    reason,
    due_at: new Date(now.getTime() + milliseconds).toISOString(),
  });
  if (activeLive) return defer('LIVE_ACTIVE', 3600000);
  if (status === 'NO_CAPTIONS')
    return defer(
      'LOCAL_YTDLP_NO_CAPTIONS',
      [3600000, 21600000, 86400000, 259200000, 604800000][
        Math.min(counts.no_captions, 4)
      ]!,
    );
  if (status === 'IP_BLOCKED') return defer('LOCAL_YTDLP_IP_BLOCKED', 1800000);
  if (status === 'RATE_LIMITED')
    return defer('LOCAL_YTDLP_RATE_LIMITED', 3600000);
  if (status === 'PARSE_ERROR' || status === 'UPSTREAM_CHANGED')
    return defer('LOCAL_YTDLP_PARSER_CHANGED', 21600000);
  if (
    ['AUTH_REQUIRED', 'REGION_BLOCKED', 'UNAVAILABLE', 'TOO_LARGE'].includes(
      status,
    )
  )
    return {
      state: 'BLOCKED' as const,
      reason: `LOCAL_YTDLP_${status}`,
      due_at: now.toISOString(),
    };
  const decision = retryDisposition(
    'TRANSIENT',
    counts.transient + 1,
    now,
    random,
  );
  return { ...decision, reason: 'LOCAL_YTDLP_TEMPORARY_FAILURE' };
}
export class TranscriptRecovery {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async admission(now: Date, runtime: 'local' | 'cloud') {
    this.context.requireTask('FETCH_TRANSCRIPT');
    if (runtime !== 'local')
      return {
        available: false,
        reason: 'LOCAL_EXECUTOR_REQUIRED',
        next_check_at: null,
      };
    const row = await this.db
      .prepare(
        `SELECT a.error_code,a.finished_at FROM job_attempts a JOIN jobs j ON j.owner_id=a.owner_id AND j.job_id=a.job_id WHERE a.owner_id=? AND j.task_type='FETCH_TRANSCRIPT' AND ((a.error_code='LOCAL_YTDLP_IP_BLOCKED' AND a.finished_at>?) OR (a.error_code='LOCAL_YTDLP_PARSER_CHANGED' AND a.finished_at>?)) ORDER BY julianday(a.finished_at)+CASE WHEN a.error_code='LOCAL_YTDLP_IP_BLOCKED' THEN 0.0208333333333333 ELSE 0.25 END DESC LIMIT 1`,
      )
      .bind(
        this.context.ownerId,
        new Date(now.getTime() - 1800000).toISOString(),
        new Date(now.getTime() - 21600000).toISOString(),
      )
      .first<{ error_code: string; finished_at: string }>();
    if (row) {
      const next =
        Date.parse(row.finished_at) +
        (row.error_code === 'LOCAL_YTDLP_IP_BLOCKED' ? 1800000 : 21600000);
      if (next > now.getTime())
        return {
          available: false,
          reason: row.error_code,
          next_check_at: new Date(next).toISOString(),
        };
    }
    return { available: true, reason: null, next_check_at: null };
  }
  async outcome(
    token: LeaseToken,
    status: TranscriptStatus,
    now: Date,
    activeLive = false,
    random = Math.random,
  ) {
    this.context.requireTask('FETCH_TRANSCRIPT');
    const counts = await this.db
      .prepare(
        `SELECT SUM(CASE WHEN error_code='LOCAL_YTDLP_NO_CAPTIONS' THEN 1 ELSE 0 END) AS no_captions,SUM(CASE WHEN error_code='LOCAL_YTDLP_TEMPORARY_FAILURE' THEN 1 ELSE 0 END) AS transient FROM job_attempts WHERE owner_id=? AND job_id=? AND finished_at IS NOT NULL`,
      )
      .bind(this.context.ownerId, token.job_id)
      .first<{ no_captions: number | null; transient: number | null }>();
    const decision = transcriptDisposition(
      status,
      {
        no_captions: counts?.no_captions ?? 0,
        transient: counts?.transient ?? 0,
      },
      now,
      activeLive,
      random,
    );
    await new JobStore(this.db, this.context).disposition(
      token,
      'FETCH_TRANSCRIPT',
      decision.state,
      decision.reason,
      decision.due_at,
      now,
    );
    return decision;
  }
}
