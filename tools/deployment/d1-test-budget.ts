/** Admin test budget only. Never wrap canonical recovery/cleanup in this guard. */
export function d1TestBudget<
  TQuery,
  TResult extends { meta: { rows_read?: number; rows_written?: number } },
>(
  execute: (queries: TQuery[]) => Promise<TResult[]>,
  limits: { requests: number; rows_read: number; rows_written: number },
) {
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error('INVALID_D1_TEST_BUDGET');
  const usage = {
    requests: 0,
    rows_read: 0,
    rows_written: 0,
    metadata_complete: true,
    stopped: false,
  };
  return {
    usage,
    async execute(queries: TQuery[]) {
      if (
        usage.stopped ||
        usage.requests >= limits.requests ||
        usage.rows_read >= limits.rows_read ||
        usage.rows_written >= limits.rows_written
      )
        throw new Error('D1_TEST_BUDGET_EXHAUSTED');
      usage.requests++;
      let results: TResult[];
      try {
        results = await execute(queries);
      } catch (error) {
        usage.stopped = true;
        throw error;
      }
      if (results.length !== queries.length) {
        usage.metadata_complete = false;
        usage.stopped = true;
      }
      for (const result of results) {
        if (
          !Number.isSafeInteger(result.meta.rows_read) ||
          !Number.isSafeInteger(result.meta.rows_written) ||
          result.meta.rows_read! < 0 ||
          result.meta.rows_written! < 0
        ) {
          usage.metadata_complete = false;
          usage.stopped = true;
        } else {
          usage.rows_read += result.meta.rows_read!;
          usage.rows_written += result.meta.rows_written!;
        }
      }
      if (
        !usage.metadata_complete ||
        usage.rows_read >= limits.rows_read ||
        usage.rows_written >= limits.rows_written
      )
        usage.stopped = true;
      // Return an already committed result. Throwing here would obscure a write
      // and invite replay. The next request stops; this is no hard account cap.
      return results;
    },
  };
}
