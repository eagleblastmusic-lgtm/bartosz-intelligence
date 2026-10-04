import { readFileSync, readdirSync } from 'node:fs';
import { verifyMigrations } from './migrations.js';
const ledger = JSON.parse(readFileSync('db/migration-ledger.json', 'utf8'));
const files = Object.fromEntries(
  readdirSync('db/migrations')
    .filter((name) => name.endsWith('.sql'))
    .map((name) => [name, readFileSync(`db/migrations/${name}`, 'utf8')]),
);
console.log(JSON.stringify(verifyMigrations(files, ledger.migrations)));
