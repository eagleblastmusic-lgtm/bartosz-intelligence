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
export const captionAttemptOffsets = [
  10 * 60000,
  3600000,
  10 * 3600000,
] as const;
export function firstCaptionAttempt(detectedAt: string) {
  if (!Number.isFinite(Date.parse(detectedAt)))
    throw new Error('INVALID_DETECTION_CLOCK');
  return new Date(
    Date.parse(detectedAt) + captionAttemptOffsets[0],
  ).toISOString();
}
export function transcriptDisposition(
  status: TranscriptStatus,
  counts: { no_captions: number; transient: number },
  now: Date,
  activeLive = false,
  random = Math.random,
  detectedAt: Date = now,
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
  if (status === 'NO_CAPTIONS') {
    if (counts.no_captions >= 2)
      return {
        state: 'FAILED' as const,
        reason: 'LOCAL_YTDLP_NO_CAPTIONS_FINAL',
        due_at: now.toISOString(),
      };
    return {
      state: 'DEFERRED' as const,
      reason: 'LOCAL_YTDLP_NO_CAPTIONS',
      due_at: new Date(
        Math.max(
          now.getTime(),
          detectedAt.getTime() + captionAttemptOffsets[counts.no_captions + 1]!,
        ),
      ).toISOString(),
    };
  }
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
    const rate = await this.db
      .prepare(
        "SELECT due_at FROM jobs WHERE owner_id=? AND task_type='FETCH_TRANSCRIPT' AND reason_code='LOCAL_YTDLP_RATE_LIMITED' AND due_at>? ORDER BY due_at DESC LIMIT 1",
      )
      .bind(this.context.ownerId, now.toISOString())
      .first<{ due_at: string }>();
    if (rate)
      return {
        available: false,
        reason: 'LOCAL_YTDLP_RATE_LIMITED',
        next_check_at: rate.due_at,
      };
    const row = await this.db
      .prepare(
        `SELECT a.error_code,a.finished_at FROM job_attempts a JOIN jobs j ON j.owner_id=a.owner_id AND j.job_id=a.job_id WHERE a.owner_id=? AND a.error_code IN ('LOCAL_YTDLP_IP_BLOCKED','LOCAL_YTDLP_PARSER_CHANGED') AND j.task_type='FETCH_TRANSCRIPT' AND ((a.error_code='LOCAL_YTDLP_IP_BLOCKED' AND a.finished_at>?) OR (a.error_code='LOCAL_YTDLP_PARSER_CHANGED' AND a.finished_at>?)) ORDER BY julianday(a.finished_at)+CASE WHEN a.error_code='LOCAL_YTDLP_IP_BLOCKED' THEN 0.0208333333333333 ELSE 0.25 END DESC LIMIT 1`,
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
    retryAfter?: string,
  ) {
    this.context.requireTask('FETCH_TRANSCRIPT');
    const counts = await this.db
      .prepare(
        `SELECT SUM(CASE WHEN a.error_code IN ('LOCAL_YTDLP_NO_CAPTIONS','LOCAL_YTDLP_NO_CAPTIONS_FINAL') THEN 1 ELSE 0 END) AS no_captions,SUM(CASE WHEN a.error_code='LOCAL_YTDLP_TEMPORARY_FAILURE' THEN 1 ELSE 0 END) AS transient FROM job_attempts a JOIN jobs j ON j.owner_id=a.owner_id AND j.job_id=a.job_id WHERE a.owner_id=? AND a.job_id=? AND a.finished_at IS NOT NULL AND a.fencing_token>j.caption_retry_after_fence`,
      )
      .bind(this.context.ownerId, token.job_id)
      .first<{ no_captions: number | null; transient: number | null }>();
    const detected = await this.db
      .prepare(
        'SELECT COALESCE(j.caption_retry_origin_at,i.discovered_at,j.created_at) detected_at FROM jobs j LEFT JOIN items i ON i.owner_id=j.owner_id AND i.item_id=j.item_id WHERE j.owner_id=? AND j.job_id=?',
      )
      .bind(this.context.ownerId, token.job_id)
      .first<string>('detected_at');
    const decision = transcriptDisposition(
      status,
      {
        no_captions: counts?.no_captions ?? 0,
        transient: counts?.transient ?? 0,
      },
      now,
      activeLive,
      random,
      new Date(detected ?? now.toISOString()),
    );
    if (
      status !== 'NO_CAPTIONS' &&
      retryAfter &&
      Number.isFinite(Date.parse(retryAfter))
    )
      decision.due_at = new Date(
        Math.max(Date.parse(decision.due_at), Date.parse(retryAfter)),
      ).toISOString();
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
