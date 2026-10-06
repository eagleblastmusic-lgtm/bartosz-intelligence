const fields = new Set([
  'total_input_tokens',
  'total_output_tokens',
  'total_tokens',
  'total_thought_tokens',
  'total_cached_tokens',
  'total_tool_use_tokens',
  'raw_prompt_token',
]);
const nested =
  /^(?:input_tokens_by_modality\[\d{1,2}\]\.tokens|(?:model_invocation_token_counts|non_grounding_model_invocation_token_counts)\[\d{1,2}\]\.(?:prompt_tokens_details\[\d{1,2}\]\.tokens|candidates_tokens_details\[\d{1,2}\]\.tokens))$/;
export function validTokenAccounting(
  value: unknown,
): value is Record<string, number> | null {
  return (
    value === null ||
    (!!value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length <= 48 &&
      Object.entries(value).every(
        ([key, count]) =>
          (fields.has(key) || nested.test(key)) &&
          Number.isSafeInteger(count) &&
          (count as number) >= 0,
      ))
  );
}
// Only documented numeric accounting paths are retained, never arbitrary strings
// or thought text. Missing counts remain absent instead of becoming zero.
export function extractTokenAccounting(
  value: unknown,
): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>,
    result: Record<string, number> = {};
  const add = (key: string, count: unknown) => {
    if (
      Object.keys(result).length < 48 &&
      Number.isSafeInteger(count) &&
      (count as number) >= 0
    )
      result[key] = count as number;
  };
  for (const field of fields) add(field, usage[field]);
  const record = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  const array = (v: unknown) => (Array.isArray(v) ? v.slice(0, 8) : []);
  array(usage.input_tokens_by_modality).forEach((entry, i) =>
    add(`input_tokens_by_modality[${i}].tokens`, record(entry).tokens),
  );
  for (const group of [
    'model_invocation_token_counts',
    'non_grounding_model_invocation_token_counts',
  ])
    array(usage[group]).forEach((entry, i) => {
      for (const detail of [
        'prompt_tokens_details',
        'candidates_tokens_details',
      ])
        array(record(entry)[detail]).forEach((count, j) =>
          add(`${group}[${i}].${detail}[${j}].tokens`, record(count).tokens),
        );
    });
  return result;
}
