export interface BackupReceipt {
  version?: unknown;
  recorded_at?: unknown;
  private_copy_readback?: unknown;
  independent_sqlite_restore?: unknown;
  integrity_check?: unknown;
  foreign_key_check?: unknown;
}

/** Failed, future-dated and incomplete receipts never postpone a backup. */
export function backupDue(receipts: BackupReceipt[], now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error('INVALID_BACKUP_CLOCK');
  const timestamps = receipts
    .filter(
      (row) =>
        row.version === 'portable-backup-drill:1' &&
        row.private_copy_readback === 'PASS' &&
        row.independent_sqlite_restore === 'PASS' &&
        row.integrity_check === 'PASS' &&
        row.foreign_key_check === 'PASS' &&
        typeof row.recorded_at === 'string',
    )
    .map((row) => Date.parse(row.recorded_at as string))
    .filter((time) => Number.isFinite(time) && time <= now.getTime());
  const latest = timestamps.length ? Math.max(...timestamps) : null;
  return {
    due: latest === null || now.getTime() - latest >= 24 * 60 * 60 * 1000,
    latest_verified_at: latest === null ? null : new Date(latest).toISOString(),
  };
}
