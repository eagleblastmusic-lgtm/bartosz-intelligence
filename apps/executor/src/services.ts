export const localServices = [
  { name: 'transcript', flag: null, credential: 'LOCAL_WORKER_CREDENTIAL' },
  {
    name: 'source-corrections',
    flag: '--source-corrections',
    credential: 'LOCAL_CORRECTION_WORKER_CREDENTIAL',
  },
  {
    name: 'search',
    flag: '--search',
    credential: 'LOCAL_SEARCH_WORKER_CREDENTIAL',
  },
] as const;
export type LocalService = (typeof localServices)[number];

/** A child receives one scoped credential and no provider/control-plane secrets. */
export function serviceEnvironment(
  service: LocalService,
  input: Record<string, string | undefined>,
) {
  if (
    !input.APP_ORIGIN ||
    !/^[A-Za-z0-9_-]{43}$/.test(input[service.credential] ?? '')
  )
    throw new Error('LOCAL_SERVICE_CONFIGURATION_REQUIRED');
  const origin = new URL(input.APP_ORIGIN);
  if (
    origin.protocol !== 'https:' &&
    !(origin.protocol === 'http:' && origin.hostname === '127.0.0.1')
  )
    throw new Error('LOCAL_SERVICE_ORIGIN_REQUIRED');
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error('LOCAL_SERVICE_ORIGIN_REQUIRED');
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      value &&
      [
        'PATH',
        'SYSTEMROOT',
        'TEMP',
        'TMP',
        'HOME',
        'USERPROFILE',
        'LOCALAPPDATA',
        'APPDATA',
        'COMSPEC',
        'SYSTEMDRIVE',
        'WINDIR',
      ].includes(key.toUpperCase())
    )
      output[key] = value;
  }
  output.APP_ORIGIN = input.APP_ORIGIN;
  output[service.credential] = input[service.credential]!;
  return output;
}

export async function superviseService(input: {
  signal: AbortSignal;
  run: () => Promise<{ code: number | null; signal: string | null }>;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  emit: (event: 'EXIT' | 'RESTART' | 'STOPPED', code: number | null) => void;
}) {
  let failures = 0;
  while (!input.signal.aborted) {
    const result = await input.run();
    if (input.signal.aborted) return 0;
    input.emit('EXIT', result.code);
    // The continuous cycle CLI uses 78 for authentication denial. Never
    // turn revoked credentials into an automatic restart loop.
    if (result.code === 78) {
      input.emit('STOPPED', 78);
      return 1;
    }
    failures = Math.min(failures + 1, 3);
    try {
      await input.wait(
        Math.min(120000, 30000 * 2 ** (failures - 1)),
        input.signal,
      );
    } catch (error) {
      if (input.signal.aborted) return 0;
      throw error;
    }
    if (!input.signal.aborted) input.emit('RESTART', null);
  }
  return 0;
}
