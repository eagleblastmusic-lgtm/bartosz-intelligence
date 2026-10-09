export const d1ResumeNotBefore = '2026-10-10T00:00:00.000Z';
export const d1ProbeSql =
  'SELECT 1 AS readable FROM owner_users WHERE owner_id=? AND allowlisted=1 LIMIT 1';

export interface D1ProbeReceipt {
  version: 'D1AvailabilityProbe/1.0';
  observed_at: string;
  state: 'AVAILABLE' | 'QUOTA_BLOCKED' | 'FAILED';
  requests: number;
  rows_read: number | null;
  rows_written: number | null;
  reason: string | null;
  account_remaining_rows: null;
  paid_services_enabled: false;
}

/** One table probe per UTC day; no retries, capture, AI or writes. */
export function probeAdmission(now: Date, attemptedDay: boolean) {
  if (!Number.isFinite(now.getTime())) throw new Error('INVALID_PROBE_CLOCK');
  if (now.getTime() < Date.parse(d1ResumeNotBefore))
    return 'WAITING_RESET' as const;
  return attemptedDay ? ('ALREADY_ATTEMPTED' as const) : ('PROBE_DUE' as const);
}

export async function probeD1Availability(
  ownerId: string,
  query: (
    sql: string,
    params: string[],
  ) => Promise<
    {
      results: { readable?: unknown }[];
      meta: { rows_read?: unknown; rows_written?: unknown };
    }[]
  >,
  now: Date,
): Promise<D1ProbeReceipt> {
  if (!ownerId || ownerId.length > 256 || !Number.isFinite(now.getTime()))
    throw new Error('INVALID_PROBE_INPUT');
  const receipt: D1ProbeReceipt = {
    version: 'D1AvailabilityProbe/1.0',
    observed_at: now.toISOString(),
    state: 'FAILED',
    requests: 1,
    rows_read: null,
    rows_written: null,
    reason: null,
    account_remaining_rows: null,
    paid_services_enabled: false,
  };
  try {
    const rows = await query(d1ProbeSql, [ownerId]);
    const row = rows[0];
    const read = row?.meta.rows_read;
    const written = row?.meta.rows_written;
    if (
      rows.length !== 1 ||
      row?.results.length !== 1 ||
      row.results[0]?.readable !== 1 ||
      !Number.isSafeInteger(read) ||
      (read as number) < 1 ||
      (read as number) > 4 ||
      written !== 0
    )
      throw new Error('D1_PROBE_METADATA_OR_BOUND_FAILED');
    receipt.rows_read = read as number;
    receipt.rows_written = 0;
    receipt.state = 'AVAILABLE';
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    receipt.reason =
      /^CLOUDFLARE_REQUEST_FAILED_\d{3}_\d+(?:_D1_(?:DAILY_(?:READ|WRITE)_LIMIT|BUSY|TIMEOUT|SQL_INVALID|TOO_LARGE))?$/.test(
        code,
      ) ||
      [
        'CLOUDFLARE_AUTH_REQUIRED',
        'CLOUDFLARE_TRANSPORT_FAILED',
        'CLOUDFLARE_AUTH_REFRESH_REQUIRED',
        'CLOUDFLARE_RESPONSE_INVALID',
        'D1_PROBE_METADATA_OR_BOUND_FAILED',
      ].includes(code)
        ? code
        : 'D1_PROBE_FAILED';
    receipt.state = /_D1_DAILY_(READ|WRITE)_LIMIT$/.test(receipt.reason)
      ? 'QUOTA_BLOCKED'
      : 'FAILED';
  }
  return receipt;
}
