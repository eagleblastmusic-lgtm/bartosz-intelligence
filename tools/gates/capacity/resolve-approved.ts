import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  YoutubeClient,
  YoutubeError,
} from '../../../packages/core/src/sources/youtube/client.js';
import { resolveSource } from '../../../packages/core/src/sources/youtube/resolver.js';

// The human approved these 19 links and staged new-only in this task.
// Resolution has no D1 writes, activation, backfill or AI side effects.
if (
  process.argv.slice(2).join(' ') !== '--approved-list --once' ||
  !process.env.YOUTUBE_API_KEY
)
  throw new Error('EXPLICIT_APPROVED_SOURCE_RESOLUTION_REQUIRED');
const proposalPath = 'docs/decisions/GATE_C_CHANNEL_PROPOSAL_2026-10-09.md';
const proposal = readFileSync(proposalPath, 'utf8');
if (!proposal.includes('OWNER_APPROVED / NOT_ADDED'))
  throw new Error('OWNER_APPROVED_LIST_REQUIRED');
const links = [
  ...proposal.matchAll(
    /\]\((https:\/\/www\.youtube\.com\/@[A-Za-z0-9_.-]+)\)/g,
  ),
].map((match) => match[1]!);
if (links.length !== 19 || new Set(links).size !== 19)
  throw new Error('EXACT_APPROVED_19_SOURCES_REQUIRED');
mkdirSync('.local/capacity-observation', { recursive: true });
writeFileSync(
  '.local/capacity-observation/approved-resolution-intent.json',
  JSON.stringify({
    started_at: new Date().toISOString(),
    maximum_provider_requests: 19,
    source_create_requests: 0,
    paid_services_enabled: false,
    proposal_sha256: createHash('sha256').update(proposal).digest('hex'),
  }) + '\n',
  { flag: 'wx' },
);
const client = new YoutubeClient(process.env.YOUTUBE_API_KEY, 19),
  identities: Record<string, unknown>[] = [];
for (const locator of links) {
  try {
    identities.push({
      approved_locator: locator,
      state: 'RESOLVED',
      ...(await resolveSource(client, locator)),
    });
  } catch (error) {
    identities.push({
      approved_locator: locator,
      state: 'FAILED',
      reason: error instanceof YoutubeError ? error.code : 'RESOLUTION_FAILED',
    });
    // Preserve partial work; do not storm quota/auth/transient failures.
    if (!(error instanceof YoutubeError) || error.code !== 'NOT_FOUND') break;
  }
}
const complete =
  identities.length === 19 &&
  identities.every((row) => row.state === 'RESOLVED') &&
  new Set(identities.map((row) => row.external_id)).size === 19;
const receipt = {
  version: 'ApprovedSourceIdentities/1.0',
  observed_at: new Date().toISOString(),
  status: complete ? 'RESOLVED_NOT_ADDED' : 'PARTIAL_NOT_ADDED',
  proposal_sha256: createHash('sha256').update(proposal).digest('hex'),
  approval: 'OWNER_EXPLICIT_LIST_AND_STAGED_NEW_ONLY_2026_10_09',
  activation_mode: 'NEW_ONLY',
  identities,
  youtube_usage: client.usage,
  production_d1_requests: 0,
  source_create_requests: 0,
  backfill_requests: 0,
  gemini_requests: 0,
  paid_services_enabled: false,
};
mkdirSync('docs/verification/capacity', { recursive: true });
writeFileSync(
  'docs/verification/capacity/approved-channel-identities-2026-10-09.json',
  JSON.stringify(receipt, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(
  JSON.stringify({
    status: receipt.status,
    resolved: identities.filter((row) => row.state === 'RESOLVED').length,
    requests: client.usage.requests,
  }),
);
if (!complete) process.exitCode = 2;
