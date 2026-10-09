const transient = (error: unknown) =>
  error instanceof Error &&
  /^(?:CLOUDFLARE_TRANSPORT_FAILED|CLOUDFLARE_RESPONSE_INVALID|CLOUDFLARE_REQUEST_FAILED_50[0234]_[A-Z0-9_]+|CLOUDFLARE_REQUEST_FAILED_400_7500_D1_(?:BUSY|TIMEOUT))$/.test(
    error.message,
  );
/** Only use for a chunk's immutable (backup, table, cursor) identity. */
export async function recoverBackupChunk<T>(
  read: () => Promise<T>,
  expiresAt: string,
  clock = Date.now,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!transient(error) || clock() >= Date.parse(expiresAt)) throw error;
    return read();
  }
}
/** Reconcile an ambiguous completion before issuing another mutation. */
export async function recoverBackupCompletion<T>(
  complete: () => Promise<T>,
  manifest: () => Promise<T>,
  expiresAt: string,
  clock = Date.now,
): Promise<T> {
  try {
    return await complete();
  } catch (error) {
    if (!transient(error)) throw error;
    try {
      return await manifest();
    } catch (reconcile) {
      if (
        !(reconcile instanceof Error) ||
        reconcile.message !== 'BACKUP_NOT_VERIFIED' ||
        clock() >= Date.parse(expiresAt)
      )
        throw reconcile;
      return complete();
    }
  }
}
