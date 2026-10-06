import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
import { dailyQuotaWindow } from './windows.js';

export interface GeminiQuotaObservation {
  version: 'gemini-quota-observation:1';
  project: string;
  model: string;
  tier: 'FREE';
  source: 'GOOGLE_CLOUD_QUOTA_CURRENT';
  sampled_at: string;
  buckets: {
    bucket: 'RPM' | 'RPD' | 'INPUT_TPM';
    limit: number;
    used: number;
  }[];
}

// This is an explicit owner observation boundary, not a quota-fetch API. A
// historical peak, missing graph data or absent counter cannot become used=0.
export class QuotaSnapshots {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async record(observation: GeminiQuotaObservation, now: Date) {
    this.context.requireOwner();
    if (
      !observation ||
      typeof observation !== 'object' ||
      Array.isArray(observation)
    )
      throw new Error('INVALID_QUOTA_OBSERVATION');
    const sampled = Date.parse(observation.sampled_at);
    if (
      Object.keys(observation).some(
        (k) =>
          ![
            'version',
            'project',
            'model',
            'tier',
            'source',
            'sampled_at',
            'buckets',
          ].includes(k),
      ) ||
      observation.version !== 'gemini-quota-observation:1' ||
      typeof observation.project !== 'string' ||
      !/^[a-z][a-z0-9-]{4,62}$/.test(observation.project) ||
      typeof observation.model !== 'string' ||
      !/^gemini-[a-z0-9.-]+$/.test(observation.model) ||
      observation.tier !== 'FREE' ||
      observation.source !== 'GOOGLE_CLOUD_QUOTA_CURRENT' ||
      typeof observation.sampled_at !== 'string' ||
      !Number.isFinite(now.getTime()) ||
      !Number.isFinite(sampled) ||
      sampled > now.getTime() ||
      now.getTime() - sampled > 60000 ||
      !Array.isArray(observation.buckets) ||
      observation.buckets.length !== 3 ||
      observation.buckets.some(
        (b) =>
          !b ||
          typeof b !== 'object' ||
          Array.isArray(b) ||
          Object.keys(b).length !== 3 ||
          !['RPM', 'RPD', 'INPUT_TPM'].includes(b.bucket) ||
          !Number.isSafeInteger(b.limit) ||
          b.limit < 1 ||
          !(b.bucket === 'RPM'
            ? Number.isFinite(b.used) && b.used <= Number.MAX_SAFE_INTEGER
            : Number.isSafeInteger(b.used)) ||
          b.used < 0,
      ) ||
      new Set(observation.buckets.map((b) => b.bucket)).size !== 3
    )
      throw new Error('INVALID_QUOTA_OBSERVATION');
    const normalized = {
      ...observation,
      buckets: [...observation.buckets].sort((a, b) =>
        a.bucket.localeCompare(b.bucket),
      ),
    };
    const payload = JSON.stringify(normalized),
      hash = await sha256(payload);
    const scopedHash = await sha256(this.context.ownerId + ':' + hash);
    const day = dailyQuotaWindow(new Date(sampled), 'America/Los_Angeles');
    const rows = normalized.buckets.map((b) => ({
      snapshot_id: 'quota_' + scopedHash + '_' + b.bucket,
      bucket: b.bucket,
      // Official RPM telemetry can be a fractional rate. Preserve the actual
      // observation and round available whole requests down, never usage down.
      remaining: Math.max(0, Math.floor(b.limit - b.used)),
      reset_at:
        b.bucket === 'RPD'
          ? day.reset_at
          : new Date(sampled + 60000).toISOString(),
      expires_at: new Date(
        Math.min(
          sampled + (b.bucket === 'RPD' ? 900000 : 60000),
          Date.parse(day.reset_at),
        ),
      ).toISOString(),
    }));
    // The immutable configuration revision retains the original counter receipt
    // and project binding for backup/audit; replay does not refresh its age.
    await this.db.batch([
      this.db
        .prepare(
          'INSERT INTO config_versions(owner_id,config_id,revision,payload_json,content_hash,created_at) VALUES(?,?,1,?,?,?) ON CONFLICT DO NOTHING',
        )
        .bind(
          this.context.ownerId,
          'quota-observation-' + scopedHash,
          payload,
          hash,
          now.toISOString(),
        ),
      ...rows.map((row) => {
        const counter = normalized.buckets.find(
          (b) => b.bucket === row.bucket,
        )!;
        return this.db
          .prepare(
            'INSERT INTO quota_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
          )
          .bind(
            row.snapshot_id,
            this.context.ownerId,
            'gemini',
            observation.model,
            row.bucket,
            row.bucket === 'INPUT_TPM' ? 'tokens' : 'requests',
            counter.limit,
            counter.used,
            row.remaining,
            row.reset_at,
            'America/Los_Angeles',
            'dashboard',
            observation.sampled_at,
            row.expires_at,
            'actual',
          );
      }),
    ]);
    return {
      observation_hash: hash,
      project: observation.project,
      snapshots: rows,
    };
  }
}
