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
