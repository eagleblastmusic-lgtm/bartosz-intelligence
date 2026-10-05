export const account: string | undefined;
export function cf(
  path: string,
  method?: string,
  body?: unknown,
): Promise<unknown>;
export function query<T = Record<string, unknown>>(
  sql: string,
  params?: readonly (string | number | null)[],
): Promise<{ results: T[]; success: boolean }[]>;
