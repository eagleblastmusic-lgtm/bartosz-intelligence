export type BackupFormatVersion = 1 | 2;
export function backupLimits(version: BackupFormatVersion) {
  if (version === 1)
    return {
      chunk_bytes: 64000,
      total_bytes: 2 * 1024 * 1024,
      chunks: 200,
      barrier_ms: 120000,
    };
  if (version === 2)
    return {
      chunk_bytes: 128 * 1024,
      total_bytes: 32 * 1024 * 1024,
      chunks: 2048,
      barrier_ms: 600000,
    };
  throw new Error('INVALID_BACKUP_FORMAT');
}
