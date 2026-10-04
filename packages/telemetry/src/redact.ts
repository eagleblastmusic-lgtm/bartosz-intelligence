const privateKey =
  /token|secret|password|authorization|cookie|api.?key|credential/i;

export function redact(
  input: unknown,
  secretValues: readonly string[] = [],
): unknown {
  if (typeof input === 'string') {
    let value = input
      .replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]')
      .replace(
        /([?&](?:key|token|api_key|signature)=)[^&\s]+/gi,
        '$1[REDACTED]',
      );
    for (const secret of secretValues)
      if (secret) value = value.split(secret).join('[REDACTED]');
    return value;
  }
  if (Array.isArray(input))
    return input.map((value) => redact(value, secretValues));
  if (input && typeof input === 'object')
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [
        key,
        privateKey.test(key) ? '[REDACTED]' : redact(value, secretValues),
      ]),
    );
  return input;
}

export function logRecord(
  correlationId: string,
  fields: Record<string, unknown>,
  secrets: readonly string[] = [],
) {
  return JSON.stringify(
    redact({ correlation_id: correlationId, ...fields }, secrets),
  );
}
