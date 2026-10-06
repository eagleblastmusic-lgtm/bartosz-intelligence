import {
  assertContext,
  type Database,
  type AccessContext,
} from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
import type { PipelineProfile } from '../../../contracts/src/ai.js';
import type { AdmissionBucket } from './admission.js';
import type { GeminiQuotaObservation } from './quota-snapshots.js';
import { dailyQuotaWindow } from './windows.js';

// Shared actual-quota proof and reserve policy for every independently admitted AI task.
export async function currentGeminiBuckets(
  db: Database,
  context: AccessContext,
  profile: PipelineProfile,
  now: Date,
) {
  assertContext(context);
  const buckets: AdmissionBucket[] = [];
  const observations = new Map<string, GeminiQuotaObservation>();
  for (const bucket of ['RPM', 'RPD', 'INPUT_TPM'] as const) {
    const row = await db
      .prepare(
        `SELECT snapshot_id,remaining,reset_at,reset_zone,sampled_at,expires_at,source,confidence FROM quota_snapshots WHERE owner_id=? AND provider='gemini' AND model=? AND bucket=? ORDER BY sampled_at DESC,snapshot_id DESC LIMIT 1`,
      )
      .bind(context.ownerId, profile.model, bucket)
      .first<{
        snapshot_id: string;
        remaining: number | null;
        reset_at: string;
        reset_zone: string;
        sampled_at: string;
        expires_at: string;
        source: string;
        confidence: string;
      }>();
    if (
      !row ||
      !['api', 'dashboard'].includes(row.source) ||
      row.confidence !== 'actual' ||
      row.remaining === null
    )
      throw new Error('QUOTA_UNKNOWN_OR_STALE');
    const observed = /^quota_([a-f0-9]{64})_(?:RPM|RPD|INPUT_TPM)$/.exec(
      row.snapshot_id,
    );
    if (observed) {
      let observation = observations.get(observed[1]!);
      if (!observation) {
        const receipt = await db
          .prepare(
            'SELECT payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
          )
          .bind(context.ownerId, 'quota-observation-' + observed[1])
          .first<{ payload_json: string; content_hash: string }>();
        if (
          !receipt ||
          (await sha256(receipt.payload_json)) !== receipt.content_hash
        )
          throw new Error('QUOTA_UNKNOWN_OR_STALE');
        observation = JSON.parse(
          receipt.payload_json,
        ) as GeminiQuotaObservation;
        observations.set(observed[1]!, observation);
      }
      if (
        observation.project !== profile.account_key ||
        observation.model !== profile.model ||
        observation.sampled_at !== row.sampled_at
      )
        throw new Error('QUOTA_ACCOUNT_MISMATCH');
    }
    let window_start: string;
    if (bucket === 'RPD') {
      const window = dailyQuotaWindow(now, 'America/Los_Angeles');
      if (
        row.reset_zone !== window.reset_zone ||
        row.reset_at !== window.reset_at
      )
        throw new Error('QUOTA_UNKNOWN_OR_STALE');
      window_start = window.window_start;
    } else {
      const start = Date.parse(row.reset_at) - 60000;
      if (!Number.isFinite(start)) throw new Error('QUOTA_UNKNOWN_OR_STALE');
      window_start = new Date(start).toISOString();
    }
    buckets.push({ ...row, bucket, window_start, reserve: 0 });
  }
  const policy = await db
    .prepare(
      `SELECT payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id='quota-reserve-gemini_free' ORDER BY revision DESC LIMIT 1`,
    )
    .bind(context.ownerId)
    .first<{ payload_json: string; content_hash: string }>();
  if (!policy || (await sha256(policy.payload_json)) !== policy.content_hash)
    throw new Error('QUOTA_POLICY_NOT_CONFIGURED');
  const reserves = JSON.parse(policy.payload_json) as Record<string, number>;
  if (
    Object.keys(reserves).length !== 3 ||
    buckets.some(
      (b) =>
        !Number.isSafeInteger(reserves[b.bucket]) || reserves[b.bucket]! < 0,
    )
  )
    throw new Error('INVALID_QUOTA_POLICY');
  for (const b of buckets) b.reserve = reserves[b.bucket]!;
  return buckets;
}
