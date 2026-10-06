import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  appendCapacityEvidence,
  readCapacityEvidence,
  contentHash,
} from './store.js';
import application from '../../../config/application.json';
const configPath = process.argv[2],
  output = process.argv[3];
if (!configPath || !output)
  throw new Error('CAPACITY_COLLECTOR_CONFIG_REQUIRED');
const raw = readFileSync(configPath, 'utf8'),
  config_hash = contentHash(raw);
const config = JSON.parse(raw) as {
  version: string;
  paid_services_enabled: boolean;
  scope: string;
  interval_seconds: number;
  max_pages: number;
};
if (
  Object.keys(config).some(
    (key) =>
      ![
        'version',
        'paid_services_enabled',
        'scope',
        'interval_seconds',
        'max_pages',
      ].includes(key),
  )
)
  throw new Error('INVALID_CAPACITY_COLLECTOR_CONFIG');
if (
  config.version !== 'capacity-collector:1' ||
  config.paid_services_enabled !== false ||
  config.scope !== 'REAL_PRODUCTION' ||
  !Number.isSafeInteger(config.interval_seconds) ||
  config.interval_seconds < 3600 ||
  !Number.isSafeInteger(config.max_pages) ||
  config.max_pages < 1 ||
  config.max_pages > 200
)
  throw new Error('INVALID_CAPACITY_COLLECTOR_CONFIG');
const credential = process.env.LOCAL_TELEMETRY_WORKER_CREDENTIAL;
if (!credential || !/^[A-Za-z0-9_-]{43}$/.test(credential))
  throw new Error('TELEMETRY_PROJECT_CREDENTIAL_REQUIRED');
const directory = resolve(output);
const existing = readCapacityEvidence(directory);
if (!existing.length)
  appendCapacityEvidence(directory, {
    config_hash,
    sampled_at: new Date().toISOString(),
    kind: 'START',
    payload: {
      config,
      app_origin: application.app_origin,
      gate_c_status: 'OBSERVING',
      qualification_status: 'NOT_ASSERTED',
    },
  });
else if (existing[0]!.record.config_hash !== config_hash)
  throw new Error('CAPACITY_EVIDENCE_CONFIG_CHANGED');
const allowed = new Set([
  'item_id',
  'source_id',
  'external_id',
  'published_at',
  'publication_provenance',
  'discovered_at',
  'availability',
  'job_id',
  'job_state',
  'reason_code',
  'arrival_origin_at',
  'origin_kind',
  'attempt_count',
  'due_at',
  'input_revision',
  'profile_revision',
  'prompt_snapshot_id',
  'analysis_started_at',
  'accepted_complete_at',
  'accepted_effect_id',
  'source_run_id',
  'source_accepted_at',
  'source_outcome_hash',
  'source_artifact_id',
  'source_hash',
  'source_language',
  'source_authority',
  'source_bytes',
]);
async function collect() {
  const cases: Record<string, unknown>[] = [];
  let cursor: string | null = null,
    cut: string | null = null,
    sampled: string | null = null,
    complete = false;
  let reason: string | null = null;
  try {
    for (let page = 0; page < config.max_pages; page++) {
      const url = new URL(
        '/internal/workers/capacity-observation',
        application.app_origin,
      );
      url.searchParams.set('limit', '50');
      if (cursor) url.searchParams.set('cursor', cursor);
      const response = await fetch(url, {
        headers: { Authorization: 'Bearer ' + credential },
        signal: AbortSignal.timeout(30000),
        redirect: 'error',
      });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? 'READ_SNAPSHOT_CHANGED'
            : 'CAPACITY_HTTP_' + response.status,
        );
      const data = (await response.json()) as {
        version: string;
        sampled_at: string;
        cut_seq: string;
        cases: Record<string, unknown>[];
        next_cursor: string | null;
      };
      if (
        data.version !== 'capacity-collection:1' ||
        !Array.isArray(data.cases) ||
        data.cases.length > 50 ||
        typeof data.cut_seq !== 'string' ||
        !/^\d+$/.test(data.cut_seq) ||
        (data.next_cursor !== null &&
          (typeof data.next_cursor !== 'string' ||
            data.next_cursor.length > 2048)) ||
        !Number.isFinite(Date.parse(data.sampled_at)) ||
        (cut !== null && (cut !== data.cut_seq || sampled !== data.sampled_at))
      )
        throw new Error('INVALID_CAPACITY_COLLECTION_PAGE');
      cut = data.cut_seq;
      sampled = data.sampled_at;
      for (const row of data.cases) {
        if (
          Object.keys(row).some((key) => !allowed.has(key)) ||
          Object.values(row).some(
            (value) =>
              value !== null &&
              typeof value !== 'string' &&
              typeof value !== 'number',
          )
        )
          throw new Error('INVALID_CAPACITY_COLLECTION_FIELDS');
        cases.push({
          ...row,
          reason_code:
            typeof row.reason_code === 'string' &&
            /^[A-Z][A-Z_0-9]{0,64}$/.test(row.reason_code)
              ? row.reason_code
              : null,
        });
      }
      cursor = data.next_cursor;
      if (!cursor) {
        complete = true;
        break;
      }
    }
  } catch (error) {
    reason =
      error instanceof Error && /^[A-Z_0-9]+$/.test(error.message)
        ? error.message
        : 'CAPACITY_TRANSPORT_FAILURE';
  }
  const receipt = appendCapacityEvidence(directory, {
    config_hash,
    sampled_at: sampled ?? new Date().toISOString(),
    kind: 'OBSERVATION',
    payload: {
      status: complete ? 'COMPLETE' : 'PARTIAL',
      reason,
      cut_seq: cut,
      cases,
      has_more: cursor !== null,
      eligibility_status: 'UNCLASSIFIED',
      gate_c_status: 'OBSERVING',
      qualification_status: 'NOT_ASSERTED',
    },
  });
  process.stdout.write(
    JSON.stringify({
      status: complete ? 'COMPLETE' : 'PARTIAL',
      cases: cases.length,
      ...receipt,
    }) + '\n',
  );
}
await collect();
if (process.argv.includes('--watch')) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void collect()
      .catch(() => {
        clearInterval(timer);
        process.exitCode = 1;
      })
      .finally(() => {
        running = false;
      });
  }, config.interval_seconds * 1000);
}
