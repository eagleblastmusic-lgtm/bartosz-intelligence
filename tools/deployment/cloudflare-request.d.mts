export function cloudflareRequest(
  account: string,
  credential: string,
  path: string,
  method: string,
  body: unknown,
  refresh: () => Promise<string> | string,
  transport?: typeof fetch,
): Promise<{ result: unknown; credential: string }>;
