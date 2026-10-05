import { createHash } from 'node:crypto';
export const PYTHON_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export function safePythonProcessFailure(
  error: unknown,
): Record<string, unknown> {
  const value =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>)
      : {};
  const code =
    typeof value['code'] === 'string' && /^[A-Z0-9_]+$/.test(value['code'])
      ? value['code']
      : null;
  const signal =
    typeof value['signal'] === 'string' && /^SIG[A-Z]+$/.test(value['signal'])
      ? value['signal']
      : null;
  const stdoutBytes = Buffer.isBuffer(value['stdout'])
    ? value['stdout'].length
    : typeof value['stdout'] === 'string'
      ? Buffer.byteLength(value['stdout'])
      : null;
  const stderr = Buffer.isBuffer(value['stderr'])
    ? value['stderr']
    : typeof value['stderr'] === 'string'
      ? Buffer.from(value['stderr'])
      : null;
  const errorTypes = [
    'TypeError',
    'UnicodeEncodeError',
    'JSONDecodeError',
    'MemoryError',
    'AttributeError',
    'KeyError',
    'ValueError',
    'RecursionError',
    'ImportError',
    'ModuleNotFoundError',
    'OSError',
  ];
  const stderrErrorType =
    errorTypes.find((type) =>
      new RegExp(`(^|\\n)${type}:`).test(stderr?.toString('utf8') ?? ''),
    ) ?? null;
  return {
    status: 'TEMPORARY_FAILURE',
    reason_code: 'LOCAL_ADAPTER_PROCESS_FAILED',
    evidence_classification: 'INCONCLUSIVE',
    failure_origin: 'HARNESS_FAILURE',
    provider_failure: false,
    process_error_code: code,
    process_signal: signal,
    process_exit_status:
      typeof value['status'] === 'number' ? value['status'] : null,
    process_stderr_error_type: stderrErrorType,
    stdout_bytes: stdoutBytes,
    stderr_bytes: stderr?.length ?? null,
    stderr_sha256: stderr
      ? createHash('sha256').update(stderr).digest('hex')
      : null,
  };
}
