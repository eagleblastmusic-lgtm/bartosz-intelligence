/** Retry only an explicit D1 authentication rejection, never an ambiguous
 * transport failure, provider 5xx or a general permission/validation error. */
export async function cloudflareRequest(
  account,
  credential,
  path,
  method,
  body,
  refresh,
  transport = fetch,
) {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await transport(
      `https://api.cloudflare.com/client/v4/accounts/${account}/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
        },
        body: serialized,
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      },
    ).catch(() => {
      throw new Error('CLOUDFLARE_TRANSPORT_FAILED');
    });
    let value;
    try {
      value = await response.json();
      if (!value || typeof value !== 'object') throw new Error();
    } catch {
      throw new Error('CLOUDFLARE_RESPONSE_INVALID');
    }
    const code = value.errors?.[0]?.code ?? 'UNKNOWN';
    if (response.ok && value.success === true)
      return { result: value.result, credential };
    if (attempt === 0 && response.status === 403 && code === 7403) {
      credential = await refresh();
      continue;
    }
    // Code 7500 covers both permanent SQL errors and retryable D1 failures.
    // Never expose the original message (it may contain query/parameter data).
    const message =
      typeof value.errors?.[0]?.message === 'string'
        ? value.errors[0].message.toLowerCase()
        : '';
    const category =
      code !== 7500
        ? ''
        : /daily.*read|read.*daily/.test(message) &&
            /exceed|limit/.test(message)
          ? '_D1_DAILY_READ_LIMIT'
          : /daily.*writ|writ.*daily/.test(message) &&
              /exceed|limit/.test(message)
            ? '_D1_DAILY_WRITE_LIMIT'
            : /database is locked|database is busy/.test(message)
              ? '_D1_BUSY'
              : /execution timed out|query timed out/.test(message)
                ? '_D1_TIMEOUT'
                : /no such column|no such table|syntax error/.test(message)
                  ? '_D1_SQL_INVALID'
                  : /string or blob too big|response size limit/.test(message)
                    ? '_D1_TOO_LARGE'
                    : '';
    throw new Error(
      `CLOUDFLARE_REQUEST_FAILED_${response.status}_${typeof code === 'number' ? code : 'UNKNOWN'}${category}`,
    );
  }
  throw new Error('CLOUDFLARE_AUTH_REQUIRED');
}
