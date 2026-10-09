import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { query } from './cloudflare.mjs';
import {
  d1ResumeNotBefore,
  probeAdmission,
  probeD1Availability,
} from './d1-resume-policy.js';

const args = process.argv.slice(2);
if (args.length !== 1 || !['--check', '--probe'].includes(args[0]!))
  throw new Error('EXPLICIT_D1_RESUME_MODE_REQUIRED');
const now = new Date();
const directory = resolve('.local/d1-resume');
const day = now.toISOString().slice(0, 10);
const intentPath = resolve(directory, day + '-intent.json');
const receiptPath = resolve(
  'docs/verification/release',
  'd1-probe-' + day + '.json',
);
const admission = probeAdmission(now, existsSync(intentPath));
if (args[0] === '--check' || admission !== 'PROBE_DUE') {
  console.log(
    JSON.stringify({
      state: admission,
      not_before: d1ResumeNotBefore,
      provider_requests: 0,
      existing_receipt: existsSync(receiptPath) ? receiptPath : null,
      paid_services_enabled: false,
    }),
  );
  if (args[0] === '--probe' && admission !== 'PROBE_DUE') process.exitCode = 2;
} else {
  const backupId = '5a30668c-f9f2-4aae-b965-b9e15dc9c073';
  const bytes = readFileSync(
    resolve('.local/drive-backups', backupId + '-downloaded.json'),
  );
  const verified = JSON.parse(
    readFileSync(
      'docs/verification/backup/drive-' + backupId + '-restore.json',
      'utf8',
    ),
  );
  if (
    verified.status !== 'PASS' ||
    createHash('sha256').update(bytes).digest('hex') !== verified.archive_sha256
  )
    throw new Error('VERIFIED_BACKUP_REFERENCE_REQUIRED');
  const ownerId: unknown = JSON.parse(bytes.toString('utf8')).manifest.owner_id;
  if (typeof ownerId !== 'string')
    throw new Error('BACKUP_OWNER_REFERENCE_REQUIRED');
  mkdirSync(directory, { recursive: true });
  // An exclusive intent precedes the request, including ambiguous interruption.
  writeFileSync(
    intentPath,
    JSON.stringify(
      {
        version: 'D1ProbeIntent/1.0',
        started_at: now.toISOString(),
        maximum_requests: 1,
        maximum_rows_read: 4,
        maximum_rows_written: 0,
        automatic_retries: 0,
        paid_services_enabled: false,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  const receipt = await probeD1Availability(ownerId, query, now);
  mkdirSync(resolve('docs/verification/release'), { recursive: true });
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(JSON.stringify(receipt));
  if (receipt.state !== 'AVAILABLE') process.exitCode = 2;
}
