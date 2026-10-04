import { createHash } from 'node:crypto';
export interface Migration {
  name: string;
  sha256: string;
  depends_on: string[];
}
export function hashSql(sql: string) {
  return createHash('sha256').update(sql).digest('hex');
}
export function verifyMigrations(
  files: Record<string, string>,
  ledger: readonly Migration[],
  applied: readonly Pick<Migration, 'name' | 'sha256'>[] = [],
) {
  const names = Object.keys(files).sort();
  if (
    ledger.length !== names.length ||
    new Set(ledger.map((row) => row.name)).size !== ledger.length
  )
    throw new Error('MIGRATION_LEDGER_MISMATCH');
  const seen = new Set<string>();
  for (const row of ledger) {
    if (
      !/^\d{3}_[a-z0-9_]+\.sql$/.test(row.name) ||
      !files[row.name]?.trim() ||
      hashSql(files[row.name]!) !== row.sha256
    )
      throw new Error('MIGRATION_CHECKSUM_INVALID');
    if (
      row.depends_on.some((name) => !seen.has(name)) ||
      (seen.size > 0 && row.name <= [...seen].at(-1)!)
    )
      throw new Error('MIGRATION_ORDER_INVALID');
    seen.add(row.name);
  }
  for (const row of applied)
    if (
      !ledger.some(
        (entry) => entry.name === row.name && entry.sha256 === row.sha256,
      )
    )
      throw new Error('APPLIED_MIGRATION_CHANGED');
  return {
    result: 'PASS',
    count: names.length,
    next_number: names.length ? Number(names.at(-1)!.slice(0, 3)) + 1 : 1,
  };
}
