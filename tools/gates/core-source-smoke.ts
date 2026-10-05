import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { YoutubeClient } from '../../packages/core/src/sources/youtube/client.js';
import { resolveSource } from '../../packages/core/src/sources/youtube/resolver.js';
import { previewBackfill } from '../../packages/core/src/sources/youtube/preview.js';
import { backfillWindow } from '../../packages/core/src/sources/youtube/backfill.js';
const policy = JSON.parse(readFileSync('config/defaults.json', 'utf8'));
if (policy.paid_services_enabled !== false || !process.env.YOUTUBE_API_KEY)
  throw new Error('FREE_METADATA_CONFIGURATION_REQUIRED');
const corpus = JSON.parse(
  readFileSync('docs/verification/gate-0/MANIFEST.json', 'utf8'),
);
const locator = corpus.entries[0].channel_id as string;
const at = new Date();
const client = new YoutubeClient(process.env.YOUTUBE_API_KEY, 4);
const directory = 'docs/verification/core-source';
mkdirSync(directory, { recursive: true });
const filename = `${directory}/cp-2.6-${at.toISOString().replaceAll(':', '-')}.json`;
let report: Record<string, unknown>;
try {
  const identity = await resolveSource(client, locator);
  const equivalent = identity.handle?.startsWith('@')
    ? await resolveSource(client, identity.handle)
    : await resolveSource(client, identity.canonical_locator);
  if (equivalent.external_id !== identity.external_id)
    throw new Error('IDENTITY_MISMATCH');
  const preview = await previewBackfill(
    client,
    identity,
    backfillWindow(at),
    1,
  );
  const evidence = {
    sampled_at: at.toISOString(),
    source: 'actual YouTube public metadata API',
    paid_services_enabled: false,
    budget_units_max: 4,
    identity,
    equivalent_identity: true,
    preview,
    provider_generation_requests: 0,
    oauth_requests: 0,
  };
  report = {
    ...evidence,
    evidence_sha256: createHash('sha256')
      .update(JSON.stringify(evidence))
      .digest('hex'),
    result: 'PASS_BOUNDED_PREVIEW',
    full_discovery:
      preview.coverage === 'COMPLETE' ? 'COMPLETE' : 'NOT_CLAIMED',
  };
} catch (error) {
  const allowed = [
    'QUOTA',
    'AUTH',
    'NOT_FOUND',
    'TRANSIENT',
    'INVALID_CURSOR',
    'PARSER',
    'IDENTITY_MISMATCH',
  ];
  report = {
    sampled_at: at.toISOString(),
    result: 'FAIL',
    failure_code:
      error instanceof Error && allowed.includes(error.message)
        ? error.message
        : 'LOCAL_HARNESS_FAILURE',
    usage: client.usage,
  };
  process.exitCode = 1;
}
writeFileSync(filename, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(
  JSON.stringify({
    evidence_ref: filename,
    result: report.result,
    usage: client.usage,
  }),
);
