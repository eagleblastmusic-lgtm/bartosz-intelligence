import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { query } from './cloudflare.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const mode = process.argv[2];
if (mode === 'migrate') {
  const ledger = JSON.parse(readFileSync('db/migration-ledger.json', 'utf8'));
  for (const migration of ledger.migrations)
    if (
      hash(readFileSync('db/migrations/' + migration.name)) !== migration.sha256
    )
      throw new Error('MIGRATION_CHECKSUM_MISMATCH');
  await query(
    'CREATE TABLE IF NOT EXISTS applied_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL)',
  );
  const applied = (
    await query('SELECT name,sha256 FROM applied_migrations ORDER BY name')
  )[0].results;
  for (let i = 0; i < applied.length; i++)
    if (
      applied[i].name !== ledger.migrations[i]?.name ||
      applied[i].sha256 !== ledger.migrations[i]?.sha256
    )
      throw new Error('APPLIED_MIGRATION_CHANGED');
  for (const migration of ledger.migrations.slice(applied.length)) {
    const sql = readFileSync('db/migrations/' + migration.name, 'utf8');
    await query(
      sql +
        `\nINSERT INTO applied_migrations(name,sha256,applied_at) VALUES('${migration.name}','${migration.sha256}','${new Date().toISOString()}');`,
    );
    console.log(
      JSON.stringify({ migration: migration.name, result: 'APPLIED' }),
    );
  }
  const checks = await query('PRAGMA quick_check; PRAGMA foreign_key_check;');
  if (checks[0].results[0]?.quick_check !== 'ok' || checks[1].results.length)
    throw new Error('REMOTE_INTEGRITY_FAILED');
  console.log(
    JSON.stringify({
      migrations: ledger.migrations.length,
      quick_check: 'PASS',
      foreign_key_check: 'PASS',
    }),
  );
} else if (mode === 'control-worker') {
  const owners = (
    await query('SELECT owner_id FROM owner_users WHERE allowlisted=1 LIMIT 2')
  )[0].results;
  if (owners.length !== 1) throw new Error('VERIFIED_OWNER_REQUIRED');
  const owner = owners[0].owner_id;
  const existing = (
    await query(
      'SELECT owner_id,credential_hash,scopes_json,revoked_at FROM worker_identities WHERE worker_id=?',
      ['control-plane'],
    )
  )[0].results;
  if (existing.length) {
    if (
      existing[0].owner_id !== owner ||
      existing[0].revoked_at ||
      !process.env.CONTROL_WORKER_CREDENTIAL ||
      existing[0].credential_hash !==
        hash(process.env.CONTROL_WORKER_CREDENTIAL) ||
      existing[0].scopes_json !== '["DISCOVER","RECONCILE"]'
    )
      throw new Error('CONTROL_CREDENTIAL_RECOVERY_REQUIRED');
  } else {
    const credential =
      process.env.CONTROL_WORKER_CREDENTIAL ||
      randomBytes(32).toString('base64url');
    if (!/^[A-Za-z0-9_-]{43}$/.test(credential))
      throw new Error('CONTROL_CREDENTIAL_INVALID');
    // Persist the recoverable private value before creating its hashed identity.
    let local = readFileSync('.env', 'utf8');
    if (/^CONTROL_WORKER_CREDENTIAL=/m.test(local))
      local = local.replace(
        /^CONTROL_WORKER_CREDENTIAL=.*$/m,
        'CONTROL_WORKER_CREDENTIAL=' + credential,
      );
    else local += '\nCONTROL_WORKER_CREDENTIAL=' + credential + '\n';
    writeFileSync('.env', local);
    await query(
      'INSERT INTO worker_identities(worker_id,owner_id,credential_hash,scopes_json,created_at) VALUES(?,?,?,?,?)',
      [
        'control-plane',
        owner,
        hash(credential),
        '["DISCOVER","RECONCILE"]',
        new Date().toISOString(),
      ],
    );
  }
  console.log(
    JSON.stringify({
      control_worker_registered: true,
      scopes: ['DISCOVER', 'RECONCILE'],
      runtime: 'cloud',
    }),
  );
} else if (mode === 'telemetry-worker') {
  const owners = (
    await query('SELECT owner_id FROM owner_users WHERE allowlisted=1 LIMIT 2')
  )[0].results;
  if (owners.length !== 1) throw new Error('VERIFIED_OWNER_REQUIRED');
  const owner = owners[0].owner_id;
  const name = 'LOCAL_TELEMETRY_WORKER_CREDENTIAL';
  const credential = process.env[name] || randomBytes(32).toString('base64url');
  if (!/^[A-Za-z0-9_-]{43}$/.test(credential))
    throw new Error('TELEMETRY_CREDENTIAL_INVALID');
  const read = async () =>
    (
      await query(
        'SELECT owner_id,credential_hash,scopes_json,revoked_at FROM worker_identities WHERE worker_id=?',
        ['capacity-observer'],
      )
    )[0].results;
  const existing = await read();
  if (!existing.length) {
    let local = readFileSync('.env', 'utf8');
    const matches = local.match(/^LOCAL_TELEMETRY_WORKER_CREDENTIAL=/gm) ?? [];
    if (matches.length > 1)
      throw new Error('DUPLICATE_TELEMETRY_CONFIGURATION');
    local = matches.length
      ? local.replace(
          /^LOCAL_TELEMETRY_WORKER_CREDENTIAL=.*$/m,
          name + '=' + credential,
        )
      : local + '\n' + name + '=' + credential + '\n';
    // Recoverable private value precedes the remote hash; interrupted setup can
    // resume without implicitly rotating an existing worker identity.
    writeFileSync('.env', local);
    await query(
      'INSERT INTO worker_identities(worker_id,owner_id,credential_hash,scopes_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(worker_id) DO NOTHING',
      [
        'capacity-observer',
        owner,
        hash(credential),
        '["PROJECT"]',
        new Date().toISOString(),
      ],
    );
  }
  const current = await read();
  const privateLines =
    readFileSync('.env', 'utf8').match(
      /^LOCAL_TELEMETRY_WORKER_CREDENTIAL=(.*)$/gm,
    ) ?? [];
  const privateValue =
    privateLines.length === 1
      ? privateLines[0]
          .slice(name.length + 1)
          .trim()
          .replace(/^(['"])([A-Za-z0-9_-]{43})\1$/, '$2')
      : null;
  if (
    privateValue !== credential ||
    current.length !== 1 ||
    current[0].owner_id !== owner ||
    current[0].revoked_at ||
    current[0].credential_hash !== hash(credential) ||
    current[0].scopes_json !== '["PROJECT"]'
  )
    throw new Error('TELEMETRY_CREDENTIAL_RECOVERY_REQUIRED');
  console.log(
    JSON.stringify({
      telemetry_worker_registered: true,
      scopes: ['PROJECT'],
      private_credential_readback: true,
      observation_started: false,
    }),
  );
} else if (mode === 'secrets') {
  mkdirSync('.local', { recursive: true });
  let local = readFileSync('.env', 'utf8');
  if (!process.env.SESSION_SIGNING_SECRET) {
    const secret = randomBytes(48).toString('base64url');
    if (/^SESSION_SIGNING_SECRET=/m.test(local))
      local = local.replace(
        /^SESSION_SIGNING_SECRET=.*$/m,
        'SESSION_SIGNING_SECRET=' + secret,
      );
    else local += '\nSESSION_SIGNING_SECRET=' + secret + '\n';
    writeFileSync('.env', local);
    process.env.SESSION_SIGNING_SECRET = secret;
  }
  const secrets = {};
  for (const name of [
    'GOOGLE_OIDC_CLIENT_ID',
    'GOOGLE_OIDC_CLIENT_SECRET',
    'SESSION_SIGNING_SECRET',
    'YOUTUBE_API_KEY',
    'GOOGLE_OIDC_OWNER_SUBJECT',
    'CONTROL_WORKER_CREDENTIAL',
    'LOCAL_WORKER_CREDENTIAL',
    'GOOGLE_DRIVE_CLIENT_ID',
    'GOOGLE_DRIVE_CLIENT_SECRET',
    'DRIVE_WRAPPING_KEY_ID',
    'DRIVE_WRAPPING_KEY',
    'DRIVE_KEY_RECOVERY_READY',
    'GOOGLE_DRIVE_OAUTH_PUBLISHING_STATUS',
  ])
    if (process.env[name]) secrets[name] = process.env[name];
  if (
    !secrets.GOOGLE_OIDC_CLIENT_ID ||
    !secrets.GOOGLE_OIDC_CLIENT_SECRET ||
    secrets.SESSION_SIGNING_SECRET.length < 32
  )
    throw new Error('DEPLOYMENT_SECRETS_REQUIRED');
  writeFileSync(
    '.local/deployment-secrets.json',
    JSON.stringify(secrets) + '\n',
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({ secrets_prepared: true, names: Object.keys(secrets) }),
  );
} else if (mode === 'grant') {
  if (
    (
      await query(
        'SELECT owner_id FROM owner_users WHERE allowlisted=1 LIMIT 1',
      )
    )[0].results.length
  )
    throw new Error('BOOTSTRAP_ALREADY_CLOSED');
  const capability = randomBytes(32).toString('base64url'),
    expires = new Date(Date.now() + 3600000).toISOString();
  if (existsSync('.local/owner-bootstrap.json')) {
    const previous = JSON.parse(
      readFileSync('.local/owner-bootstrap.json', 'utf8'),
    );
    await query(
      'UPDATE owner_bootstrap_grants SET consumed_at=? WHERE grant_hash=? AND consumed_at IS NULL',
      [new Date().toISOString(), hash(previous.capability)],
    );
  }
  await query(
    'INSERT INTO owner_bootstrap_grants(grant_hash,expires_at) VALUES(?,?)',
    [hash(capability), expires],
  );
  mkdirSync('.local', { recursive: true });
  writeFileSync(
    '.local/owner-bootstrap.json',
    JSON.stringify({ capability, expires_at: expires }) + '\n',
    { mode: 0o600 },
  );
  const app = JSON.parse(readFileSync('config/application.json', 'utf8'));
  const html = `<!doctype html><html lang="pl"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Bartosz Intelligence — właściciel</title><body><h1>Ustanowienie właściciela Bartosz Intelligence</h1><p>Zaloguj się wyłącznie na swoim koncie Google. Ten jednorazowy krok przypnie konto jako jedynego właściciela aplikacji.</p><form method="post" action="${app.app_origin}/api/v1/auth/bootstrap/login"><input type="hidden" name="capability" value="${capability}"><button type="submit">Kontynuuj z Google</button></form><script>document.querySelector('form').addEventListener('submit',()=>document.querySelector('button').disabled=true)</script></body></html>`;
  writeFileSync('.local/owner-bootstrap.html', html, { mode: 0o600 });
  console.log(
    JSON.stringify({
      bootstrap_prepared: true,
      expires_at: expires,
      private_start_file: '.local/owner-bootstrap.html',
    }),
  );
} else if (mode === 'status') {
  const rows = (
    await query('SELECT subject FROM owner_users WHERE allowlisted=1 LIMIT 2')
  )[0].results;
  if (rows.length === 1) {
    const value = rows[0].subject;
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value))
      throw new Error('OWNER_SUBJECT_INVALID');
    let local = readFileSync('.env', 'utf8');
    if (/^GOOGLE_OIDC_OWNER_SUBJECT=/m.test(local))
      local = local.replace(
        /^GOOGLE_OIDC_OWNER_SUBJECT=.*$/m,
        'GOOGLE_OIDC_OWNER_SUBJECT=' + value,
      );
    else local += '\nGOOGLE_OIDC_OWNER_SUBJECT=' + value + '\n';
    writeFileSync('.env', local);
    console.log(
      JSON.stringify({ owner_subject_pinned: true, local_env_updated: true }),
    );
  } else
    console.log(
      JSON.stringify({ owner_subject_pinned: false, owner_count: rows.length }),
    );
} else throw new Error('DEPLOYMENT_MODE_REQUIRED');
