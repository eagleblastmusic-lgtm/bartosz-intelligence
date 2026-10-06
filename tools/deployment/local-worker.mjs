import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { query } from './cloudflare.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const owners = (
  await query('SELECT owner_id FROM owner_users WHERE allowlisted=1 LIMIT 2')
)[0].results;
if (owners.length !== 1) throw new Error('VERIFIED_OWNER_REQUIRED');
const analysis = process.argv.includes('--analysis');
const owner = owners[0].owner_id,
  worker = analysis ? 'local-analysis' : 'local-transcript',
  variable = analysis
    ? 'LOCAL_AI_WORKER_CREDENTIAL'
    : 'LOCAL_WORKER_CREDENTIAL',
  scopes = analysis ? ['ANALYZE'] : ['FETCH_TRANSCRIPT'];
const existing = (
  await query(
    'SELECT owner_id,credential_hash,scopes_json,revoked_at FROM worker_identities WHERE worker_id=?',
    [worker],
  )
)[0].results;
const credential =
  process.env[variable] ?? randomBytes(32).toString('base64url');
if (!/^[A-Za-z0-9_-]{43}$/.test(credential))
  throw new Error('LOCAL_CREDENTIAL_INVALID');
if (existing.length) {
  const row = existing[0];
  if (
    row.owner_id !== owner ||
    row.revoked_at ||
    !process.env[variable] ||
    row.credential_hash !== hash(credential) ||
    row.scopes_json !== JSON.stringify(scopes)
  )
    throw new Error('LOCAL_CREDENTIAL_RECOVERY_REQUIRED');
} else {
  let local = readFileSync('.env', 'utf8');
  const entry = new RegExp('^' + variable + '=.*$', 'm');
  if (entry.test(local))
    local = local.replace(entry, variable + '=' + credential);
  else local += '\n' + variable + '=' + credential + '\n';
  // Recoverable private value is saved before its one-way identity hash.
  writeFileSync('.env', local, { mode: 0o600 });
  await query(
    'INSERT INTO worker_identities(worker_id,owner_id,credential_hash,scopes_json,created_at) VALUES(?,?,?,?,?)',
    [
      worker,
      owner,
      hash(credential),
      JSON.stringify(scopes),
      new Date().toISOString(),
    ],
  );
}
console.log(
  JSON.stringify({
    local_worker_registered: true,
    runtime: 'local',
    scopes,
    credential_values_recorded: false,
  }),
);
