import type { Database } from '../db/boundary.js';
import { backupTables, assertSecretFree } from './snapshot.js';
import type { BackupManifest, BackupChunk } from './snapshot.js';
import { sha256 } from '../auth/crypto.js';
import ledger from '../../../../db/migration-ledger.json';
export interface PortableCoreBackup {
  manifest: BackupManifest;
  chunks: BackupChunk[];
}
export async function verifyPortableBackup(input: PortableCoreBackup) {
  if (
    !input?.manifest ||
    !Array.isArray(input.chunks) ||
    input.chunks.length > 200
  )
    throw new Error('BACKUP_INVALID');
  const { sha256: manifestHash, ...body } = input.manifest;
  if (
    body.version !== 1 ||
    typeof body.owner_id !== 'string' ||
    !body.owner_id ||
    !Number.isSafeInteger(body.cut_seq) ||
    body.cut_seq < 0 ||
    !Number.isFinite(Date.parse(body.created_at)) ||
    !/^[a-f0-9-]{36}$/.test(body.backup_id) ||
    JSON.stringify(body.migrations) !== JSON.stringify(ledger.migrations) ||
    (await sha256(JSON.stringify(body))) !== manifestHash
  )
    throw new Error('BACKUP_MANIFEST_MISMATCH');
  if (
    Object.keys(body.tables).sort().join(',') !==
    [...backupTables].sort().join(',')
  )
    throw new Error('BACKUP_TABLES_MISMATCH');
  let total = 0,
    consumed = 0;
  for (const table of backupTables) {
    const specification = body.tables[table]!;
    if (
      !specification ||
      !Number.isSafeInteger(specification.count) ||
      specification.count < 0 ||
      !Array.isArray(specification.chunks)
    )
      throw new Error('BACKUP_INVALID');
    if (table === 'owner_users' && specification.count !== 1)
      throw new Error('BACKUP_OWNER_REQUIRED');
    const chunks = input.chunks
      .filter((chunk) => chunk.table === table)
      .sort((a, b) => a.index - b.index);
    let cursor: number | null = 0,
      count = 0;
    if (chunks.length !== specification.chunks.length || !chunks.length)
      throw new Error('BACKUP_INCOMPLETE');
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!,
        receipt = specification.chunks[index]!;
      if (
        chunk.index !== index ||
        cursor === null ||
        chunk.cursor !== cursor ||
        chunk.cursor !== receipt.cursor ||
        chunk.next_cursor !== receipt.next_cursor ||
        chunk.sha256 !== receipt.sha256 ||
        JSON.stringify(chunk.columns) !== JSON.stringify(receipt.columns) ||
        !Array.isArray(chunk.rows)
      )
        throw new Error('BACKUP_CHAIN_MISMATCH');
      const serialized = JSON.stringify(chunk.rows);
      if ((await sha256(serialized)) !== chunk.sha256)
        throw new Error('BACKUP_CHUNK_MISMATCH');
      const bytes = new TextEncoder().encode(serialized).byteLength;
      if (bytes > 64000 || chunk.bytes !== bytes || receipt.bytes !== bytes)
        throw new Error('BACKUP_BYTES_MISMATCH');
      total += bytes;
      for (const row of chunk.rows) {
        if (
          !row ||
          Array.isArray(row) ||
          Object.keys(row).sort().join(',') !==
            [...chunk.columns].sort().join(',') ||
          Object.values(row).some(
            (value) =>
              value !== null &&
              typeof value !== 'string' &&
              !(typeof value === 'number' && Number.isFinite(value)),
          ) ||
          ('owner_id' in row && row.owner_id !== body.owner_id)
        )
          throw new Error('BACKUP_ROW_MISMATCH');
        assertSecretFree(row);
      }
      cursor = chunk.next_cursor;
      count += chunk.rows.length;
      consumed++;
    }
    if (cursor !== null || count !== specification.count)
      throw new Error('BACKUP_COUNT_MISMATCH');
  }
  if (total > 2 * 1024 * 1024 || consumed !== input.chunks.length)
    throw new Error('BACKUP_PILOT_LIMIT');
  return {
    rows: Object.values(body.tables).reduce(
      (sum, table) => sum + table.count,
      0,
    ),
    bytes: total,
    manifest_sha256: manifestHash,
  };
}
// Administrative/offline restoration only, into an isolated empty target.
// It never restores a live session or reusable worker credential.
export async function restoreCanonical(
  db: Database,
  input: PortableCoreBackup,
  ownerSubject: string,
) {
  const verified = await verifyPortableBackup(input),
    restoredAt = new Date().toISOString();
  const expectedColumns: Record<string, string[]> = {};
  for (const table of backupTables) {
    if (
      (await db
        .prepare(`SELECT COUNT(*) n FROM ${table}`)
        .first<number>('n')) !== 0
    )
      throw new Error('RESTORE_TARGET_NOT_EMPTY');
    expectedColumns[table] = (
      await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
    ).results.map((row) => row.name);
  }
  const plans = [];
  const pointers: { item_id: string; owner_id: string; revision_id: string }[] =
    [];
  for (const table of backupTables) {
    for (const chunk of input.chunks
      .filter((chunk) => chunk.table === table)
      .sort((a, b) => a.index - b.index))
      for (const original of chunk.rows) {
        const row = { ...original };
        if (table === 'owner_users') {
          if (
            !ownerSubject ||
            (await sha256(ownerSubject)) !== row.subject_hash
          )
            throw new Error('RESTORE_OWNER_BINDING_REQUIRED');
          delete row.subject_hash;
          row.subject = ownerSubject;
        }
        if (table === 'worker_identities') {
          row.credential_hash = await sha256(
            'revoked-restore:' + crypto.randomUUID(),
          );
          row.revoked_at = restoredAt;
        }
        if (table === 'items' && typeof row.current_revision_id === 'string') {
          pointers.push({
            item_id: String(row.item_id),
            owner_id: String(row.owner_id),
            revision_id: row.current_revision_id,
          });
          row.current_revision_id = null;
        }
        if (
          table === 'jobs' &&
          (row.state === 'LEASED' || row.state === 'RUNNING')
        ) {
          row.state = 'RETRY_WAIT';
          row.reason_code = 'RESTORE_RECOVERY';
          row.due_at = restoredAt;
          row.updated_at = restoredAt;
          row.lease_owner = null;
          row.lease_until = null;
          row.fencing_token = Number(row.fencing_token) + 1;
        }
        if (table === 'job_attempts' && row.finished_at === null) {
          row.finished_at = restoredAt;
          row.error_code = 'RESTORE_INTERRUPTED';
        }
        if (table === 'outbox') {
          row.delivered_at = null;
          row.due_at = restoredAt;
        }
        if (
          Object.keys(row).sort().join(',') !==
          [...expectedColumns[table]!].sort().join(',')
        )
          throw new Error('RESTORE_COLUMNS_MISMATCH');
        plans.push(
          db
            .prepare(
              `INSERT INTO ${table}(${expectedColumns[table]!.join(',')}) VALUES(${expectedColumns[table]!.map(() => '?').join(',')})`,
            )
            .bind(...expectedColumns[table]!.map((column) => row[column]!)),
        );
      }
  }
  // Only derived-view notifications are suspended in the verified empty,
  // isolated target. Canonical replay must not manufacture new change events.
  // Integrity, auth, immutable-content and backup-barrier triggers stay enabled.
  const notifications = (
    await db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'projection_invalidate_%' ORDER BY name",
      )
      .all<{ name: string; sql: string }>()
  ).results;
  if (
    notifications.some(
      (row) =>
        !/^projection_invalidate_(?:item|job|selection|source|scan|alias_decision)_(?:insert|update)$/.test(
          row.name,
        ),
    )
  )
    throw new Error('RESTORE_NOTIFICATION_TRIGGER_MISMATCH');
  if (notifications.length)
    await db.batch(
      notifications.map((row) => db.prepare(`DROP TRIGGER "${row.name}"`)),
    );
  try {
    // Each transaction stays bounded; the target is not activated halfway.
    for (let offset = 0; offset < plans.length; offset += 40)
      await db.batch(plans.slice(offset, offset + 40));
    for (let offset = 0; offset < pointers.length; offset += 40)
      await db.batch(
        pointers
          .slice(offset, offset + 40)
          .map((pointer) =>
            db
              .prepare(
                'UPDATE items SET current_revision_id=? WHERE owner_id=? AND item_id=?',
              )
              .bind(pointer.revision_id, pointer.owner_id, pointer.item_id),
          ),
      );
  } finally {
    if (notifications.length)
      await db.batch(notifications.map((row) => db.prepare(row.sql)));
  }
  for (const table of backupTables)
    if (
      (await db
        .prepare(`SELECT COUNT(*) n FROM ${table}`)
        .first<number>('n')) !== input.manifest.tables[table]!.count
    )
      throw new Error('RESTORE_COUNT_MISMATCH');
  if (
    (await db.prepare('PRAGMA foreign_key_check').all()).results.length ||
    (await db.prepare('PRAGMA quick_check').first<string>('quick_check')) !==
      'ok'
  )
    throw new Error('RESTORE_INTEGRITY_FAILED');
  return {
    ...verified,
    result: 'PASS',
    active_sessions_restored: 0,
    active_worker_credentials_restored: 0,
  };
}
