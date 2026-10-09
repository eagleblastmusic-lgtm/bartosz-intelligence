import { expect, it } from 'vitest';
import { cloudflareRequest } from '../../tools/deployment/cloudflare-request.mjs';
it.each([
  ['database is locked: private parameter', 'D1_BUSY'],
  ['query timed out: private SQL', 'D1_TIMEOUT'],
  ['no such column: private column', 'D1_SQL_INVALID'],
  ['string or blob too big: private payload', 'D1_TOO_LARGE'],
  [
    "You have exceeded your account's daily D1 read limit: private",
    'D1_DAILY_READ_LIMIT',
  ],
  [
    "You have exceeded your account's daily D1 write limit: private",
    'D1_DAILY_WRITE_LIMIT',
  ],
])(
  'classifies D1 7500 without exposing its message or replaying %s',
  async (message, category) => {
    let calls = 0;
    await expect(
      cloudflareRequest(
        'account',
        'synthetic',
        'path',
        'POST',
        {},
        () => 'unused',
        async () => {
          calls++;
          return Response.json(
            { success: false, errors: [{ code: 7500, message }] },
            { status: 400 },
          );
        },
      ),
    ).rejects.toThrow('CLOUDFLARE_REQUEST_FAILED_400_7500_' + category);
    expect(calls).toBe(1);
  },
);
it('refreshes once after explicit expired D1 authentication without changing the request or exposing response messages', async () => {
  let calls = 0,
    refreshes = 0;
  const transport: typeof fetch = async (url, init) => {
    expect(String(url)).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account/d1/database/db/query',
    );
    expect(init?.body).toBe('{"batch":[{"sql":"SELECT 1"}]}');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    calls++;
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      calls === 1 ? 'Bearer stale-synthetic' : 'Bearer renewed-synthetic',
    );
    return calls === 1
      ? Response.json(
          {
            success: false,
            errors: [{ code: 7403, message: 'private diagnostic' }],
          },
          { status: 403 },
        )
      : Response.json({ success: true, result: [{ ok: true }] });
  };
  const result = await cloudflareRequest(
    'account',
    'stale-synthetic',
    'd1/database/db/query',
    'POST',
    { batch: [{ sql: 'SELECT 1' }] },
    () => {
      refreshes++;
      return 'renewed-synthetic';
    },
    transport,
  );
  expect(result.result).toEqual([{ ok: true }]);
  expect(calls).toBe(2);
  expect(refreshes).toBe(1);
});
it('does not replay ambiguous transport failures, 5xx or general permission rejection', async () => {
  for (const status of [0, 500, 403]) {
    let calls = 0,
      refreshes = 0;
    const transport: typeof fetch = async () => {
      calls++;
      if (!status) throw new Error('transport');
      return Response.json(
        { success: false, errors: [{ code: 10000, message: 'private' }] },
        { status },
      );
    };
    await expect(
      cloudflareRequest(
        'account',
        'synthetic',
        'path',
        'POST',
        {},
        () => {
          refreshes++;
          return 'next';
        },
        transport,
      ),
    ).rejects.toThrow(
      status
        ? 'CLOUDFLARE_REQUEST_FAILED_' + status + '_10000'
        : 'CLOUDFLARE_TRANSPORT_FAILED',
    );
    expect(calls).toBe(1);
    expect(refreshes).toBe(0);
  }
});
it('redacts malformed response bodies without replaying the request', async () => {
  let calls = 0;
  await expect(
    cloudflareRequest(
      'account',
      'synthetic',
      'path',
      'GET',
      undefined,
      () => {
        throw new Error('must not refresh');
      },
      async () => {
        calls++;
        return new Response('private invalid response');
      },
    ),
  ).rejects.toThrow('CLOUDFLARE_RESPONSE_INVALID');
  expect(calls).toBe(1);
});
it('a permanent D1 permission failure exhausts one refresh and never logs the private provider diagnostic', async () => {
  let calls = 0,
    refreshes = 0;
  const transport: typeof fetch = async () => {
    calls++;
    return Response.json(
      {
        success: false,
        errors: [{ code: 7403, message: 'private diagnostic' }],
      },
      { status: 403 },
    );
  };
  await expect(
    cloudflareRequest(
      'account',
      'synthetic',
      'path',
      'GET',
      undefined,
      () => {
        refreshes++;
        return 'next';
      },
      transport,
    ),
  ).rejects.toThrow('CLOUDFLARE_REQUEST_FAILED_403_7403');
  expect(calls).toBe(2);
  expect(refreshes).toBe(1);
});
