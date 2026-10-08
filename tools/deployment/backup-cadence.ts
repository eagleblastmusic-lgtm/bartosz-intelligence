export interface BackupReceipt {
  version?: unknown;
  recorded_at?: unknown;
  captured_at?: unknown;
  drill_elapsed_ms?: unknown;
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
    .map((row) => {
      const recorded = Date.parse(row.recorded_at as string);
      // Completion is later than the consistent cut. Old verified receipts
      // provide total drill duration, a conservative bound on capture age.
      const captured =
        row.captured_at !== undefined
          ? typeof row.captured_at === 'string'
            ? Date.parse(row.captured_at)
            : NaN
          : Number.isSafeInteger(row.drill_elapsed_ms) &&
              (row.drill_elapsed_ms as number) >= 0
            ? recorded - (row.drill_elapsed_ms as number)
            : NaN;
      return Number.isFinite(recorded) &&
        recorded <= now.getTime() &&
        captured <= recorded
        ? captured
        : NaN;
    })
    .filter((time) => Number.isFinite(time) && time <= now.getTime());
  const latest = timestamps.length ? Math.max(...timestamps) : null;
  return {
    // Reserve two hours for the hourly check and bounded backup/restore.
    // Offline hosts and failed runs still require separate RPO observation.
    due: latest === null || now.getTime() - latest >= 22 * 60 * 60 * 1000,
    latest_verified_at: latest === null ? null : new Date(latest).toISOString(),
  };
}
