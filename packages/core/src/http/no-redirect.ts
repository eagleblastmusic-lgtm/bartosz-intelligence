// workerd supports manual/follow, but rejects the browser/Node "error" mode.
// Manual handling preserves the stronger invariant: no redirected credential request.
export async function fetchWithoutRedirect(
  target: string,
  options: RequestInit = {},
  transport: typeof fetch = fetch,
) {
  const response = await transport(target, { ...options, redirect: 'manual' });
  if (
    response.status >= 300 &&
    response.status < 400 &&
    response.status !== 304
  ) {
    await response.body?.cancel();
    throw new Error('OUTBOUND_REDIRECT_DENIED');
  }
  return response;
}
