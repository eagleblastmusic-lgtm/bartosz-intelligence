import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { cf, query } from './cloudflare.mjs';

const deployment = JSON.parse(readFileSync('config/deployment.json', 'utf8'));
const ledger = JSON.parse(
  readFileSync('db/migration-ledger.json', 'utf8'),
).migrations;
const applied = (
  await query('SELECT name,sha256 FROM applied_migrations ORDER BY name')
)[0].results;
if (
  applied.some(
    (row, index) =>
      row.name !== ledger[index]?.name || row.sha256 !== ledger[index]?.sha256,
  )
)
  throw new Error('REMOTE_MIGRATION_CHECKSUM_MISMATCH');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const suppliedCopy = process.argv[2];
const virtualTables = (
  await query(
    "SELECT name,sql FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'",
  )
).at(0).results;
if (virtualTables.some((row) => row.name !== 'knowledge_fts'))
  throw new Error('UNSUPPORTED_BACKUP_DERIVED_TABLE');
const exportTables = (
  await query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'knowledge_fts%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name",
  )
)
  .at(0)
  .results.map((row) => row.name);
let bytes;
const supplementarySchema = (
  await query(
    "SELECT sql FROM sqlite_master WHERE type IN ('index','trigger','view') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'knowledge_fts%' ORDER BY CASE type WHEN 'index' THEN 0 WHEN 'trigger' THEN 1 ELSE 2 END,name",
  )
)
  .at(0)
  .results.map(
    (row) =>
      row.sql.replace(
        /^CREATE (UNIQUE )?(INDEX|TRIGGER|VIEW) /i,
        (_match, unique = '', kind) =>
          'CREATE ' + unique + kind + ' IF NOT EXISTS ',
      ) + ';',
  )
  .join('\n');
if (suppliedCopy) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.sql$/.test(suppliedCopy))
    throw new Error('PRIVATE_BACKUP_COPY_NAME_REQUIRED');
  bytes = readFileSync('.local/pre-deployment-backups/' + suppliedCopy);
} else {
  let bookmark;
  let exported;
  for (let attempt = 0; attempt < 12; attempt++) {
    exported = await cf(
      `d1/database/${deployment.database_id}/export`,
      'POST',
      {
        output_format: 'polling',
        ...(virtualTables.length
          ? { dump_options: { tables: exportTables } }
          : {}),
        ...(bookmark ? { current_bookmark: bookmark } : {}),
      },
    );
    if (exported.status === 'complete') break;
    if (exported.status === 'error' || exported.error)
      throw new Error('REMOTE_BACKUP_EXPORT_FAILED');
    bookmark = exported.at_bookmark;
    if (typeof bookmark !== 'string')
      throw new Error('REMOTE_BACKUP_BOOKMARK_REQUIRED');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (
    exported?.status !== 'complete' ||
    typeof exported.result?.signed_url !== 'string'
  )
    throw new Error('REMOTE_BACKUP_NOT_READY');
  try {
    const url = new URL(exported.result.signed_url);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error();
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok || !response.body) throw new Error();
    const reader = response.body.getReader(),
      parts = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 64 * 1024 * 1024) {
        await reader.cancel();
        throw new Error();
      }
      parts.push(part.value);
    }
    bytes = Buffer.concat(parts);
  } catch {
    throw new Error('PRIVATE_BACKUP_DOWNLOAD_FAILED');
  }
}
const id = new Date().toISOString().replaceAll(':', '-');
const directory = '.local/pre-deployment-backups';
mkdirSync(directory, { recursive: true });
const path = directory + '/' + id + '.sql';
// Store a self-contained restore script, including only the derived virtual
// schema before ordinary rows and an explicit rebuild after canonical import.
if (
  virtualTables.length &&
  !new TextDecoder()
    .decode(bytes.subarray(0, 4096))
    .includes('CREATE VIRTUAL TABLE knowledge_fts')
) {
  bytes = Buffer.concat([
    Buffer.from(
      'PRAGMA foreign_keys=OFF;\n' +
        virtualTables.map((row) => row.sql + ';').join('\n') +
        '\n',
    ),
    bytes,
    Buffer.from(
      "\nINSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild');\n",
    ),
  ]);
}
if (virtualTables.length)
  bytes = Buffer.concat([
    bytes,
    Buffer.from('\n' + supplementarySchema + '\n'),
  ]);
writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
const db = new DatabaseSync(directory + '/' + id + '.restore.sqlite');
const tables = [
  'owner_users',
  'sources',
  'channels',
  'items',
  'jobs',
  'analysis_runs',
  'artifacts',
  'artifact_chunks',
  'evidence',
  'observations',
];
const counts = () =>
  Object.fromEntries(
    tables
      .filter((table) =>
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table),
      )
      .map((table) => [
        table,
        Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n),
      ]),
  );
let before, after;
let phase = 'SQL_IMPORT';
try {
  // Official dumps can create a referencing table before its target table.
  // This isolated empty SQLite target enables FK validation immediately after
  // the complete import, and keeps it enabled throughout upgrade rehearsal.
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
  );
  before = counts();
  phase = 'RESTORED_INTEGRITY';
  db.exec('PRAGMA foreign_keys=ON');
  if (
    db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
    db.prepare('PRAGMA foreign_key_check').all().length
  )
    throw new Error();
  const restored = db
    .prepare('SELECT name,sha256 FROM applied_migrations ORDER BY name')
    .all();
  phase = 'APPLIED_LEDGER';
  if (
    restored.length !== applied.length ||
    restored.some(
      (row, index) =>
        row.name !== applied[index]?.name ||
        row.sha256 !== applied[index]?.sha256,
    )
  )
    throw new Error();
  for (const migration of ledger.slice(applied.length)) {
    phase = 'MIGRATION_' + migration.name;
    const sql = readFileSync('db/migrations/' + migration.name);
    if (hash(sql) !== migration.sha256) throw new Error();
    db.exec(sql.toString('utf8'));
    db.prepare(
      'INSERT INTO applied_migrations(name,sha256,applied_at) VALUES(?,?,?)',
    ).run(migration.name, migration.sha256, new Date().toISOString());
  }
  after = counts();
  phase = 'UPGRADED_INTEGRITY';
  if (
    Object.entries(before).some(([table, count]) => after[table] !== count) ||
    db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
    db.prepare('PRAGMA foreign_key_check').all().length
  )
    throw new Error();
} catch (error) {
  const evidence = {
    created_at: new Date().toISOString(),
    result: 'FAIL',
    phase,
    sqlite_error_code: Number.isInteger(error?.errcode) ? error.errcode : null,
    missing_table:
      /^no such table: (?:main\.)?([a-z_]{1,64})$/.exec(
        error?.message ?? '',
      )?.[1] ?? null,
    backup_sha256: hash(bytes),
    backup_bytes: bytes.length,
    remote_mutation_performed: false,
    credential_values_recorded: false,
  };
  mkdirSync('docs/verification/deployment', { recursive: true });
  if (!suppliedCopy || phase !== 'SQL_IMPORT')
    writeFileSync(
      'docs/verification/deployment/' + id + '-pre-upgrade-fail.json',
      JSON.stringify(evidence, null, 2) + '\n',
      { flag: 'wx' },
    );
  console.log(JSON.stringify(evidence));
  throw new Error('PRIVATE_BACKUP_RESTORE_OR_UPGRADE_FAILED_' + phase);
} finally {
  db.close();
}
const evidence = {
  created_at: new Date().toISOString(),
  backup_sha256: hash(bytes),
  backup_bytes: bytes.length,
  private_backup_present: true,
  old_migration_count: applied.length,
  target_migration_count: ledger.length,
  independent_restore: 'PASS',
  upgrade_rehearsal: 'PASS',
  canonical_counts_preserved: true,
  counts_before: before,
  counts_after: after,
  integrity_check: 'PASS',
  foreign_key_check: 'PASS',
  signed_url_recorded: false,
  credential_values_recorded: false,
  derived_fts_rebuilt: virtualTables.length > 0,
  source:
    'https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/',
};
mkdirSync('docs/verification/deployment', { recursive: true });
writeFileSync(
  'docs/verification/deployment/' + id + '-pre-upgrade.json',
  JSON.stringify(evidence, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(JSON.stringify(evidence));
