export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
const pending = new Set<AbortController>();
export function clearPrivateRequests() {
  for (const controller of pending) controller.abort();
  pending.clear();
}
export async function api<T>(
  path: string,
  input?: unknown,
  key?: string,
  signal?: AbortSignal,
): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new Error('INVALID_API_PATH');
  const controller = new AbortController();
  pending.add(controller);
  const csrf = document.cookie
    .split('; ')
    .find((value) => value.startsWith('__Host-bi-csrf='))
    ?.slice('__Host-bi-csrf='.length);
  try {
    const response = await fetch('/api/v1' + path, {
      method: input === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal,
      headers:
        input === undefined
          ? {}
          : {
              'Content-Type': 'application/json',
              'X-CSRF-Token': csrf ?? '',
              ...(key ? { 'Idempotency-Key': key } : {}),
            },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw new ApiError(response.status, 'INVALID_API_RESPONSE');
    const data = (await response.json()) as { code?: unknown };
    if (!response.ok) {
      if (response.status === 401 && path !== '/auth/session')
        window.dispatchEvent(new Event('bi-session-expired'));
      throw new ApiError(
        response.status,
        typeof data.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(data.code)
          ? data.code
          : 'REQUEST_FAILED',
      );
    }
    return data as T;
  } finally {
    pending.delete(controller);
  }
}
export function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 409 && error.code === 'READ_SNAPSHOT_CHANGED')
      return 'Dane zmieniły się podczas przeglądania. Odśwież widok.';
    if (error.status === 403) return 'Brak dostępu do tej operacji.';
    if (error.status === 429 || error.status === 503)
      return `Operacja chwilowo niedostępna. Możesz spróbować ponownie. (${error.code})`;
  }
  return 'Nie udało się pobrać danych. Sprawdź połączenie i spróbuj ponownie.';
}
