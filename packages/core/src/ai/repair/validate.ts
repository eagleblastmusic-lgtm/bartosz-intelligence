import {
  economy_wire,
  intelligence_canonical,
  repair_wire,
} from '../../registry/generated/validators.js';
import { parseWithDeterministicRepair } from './deterministic.js';
type StandaloneValidator = ((value: unknown) => boolean) & {
  errors?:
    | readonly {
        instancePath: string;
        schemaPath: string;
        keyword: string;
        params: Record<string, unknown>;
        message?: string;
      }[]
    | null;
};
const validateWire = economy_wire as StandaloneValidator;
export async function validateEconomyCandidate(
  raw: string,
  completion: 'OK' | 'REFUSED' | 'INCOMPLETE',
  aliases: ReadonlySet<string>,
) {
  if (completion !== 'OK')
    throw new Error(
      completion === 'REFUSED'
        ? 'REFUSAL_NOT_REPAIRABLE'
        : 'TRUNCATION_NOT_REPAIRABLE',
    );
  const parsed = await parseWithDeterministicRepair(raw);
  if (!validateWire(parsed.value))
    return {
      ...parsed,
      valid: false,
      reason: 'WIRE_SCHEMA_INVALID',
      errors: validateWire.errors?.map((error) => ({ ...error })),
    };
  const value = parsed.value as Record<string, unknown[]>;
  const entities = value.entity_mentions!;
  for (const [module, records] of Object.entries(value)) {
    if (module === 'source_issues') continue;
    for (const row of records) {
      const record = row as Record<string, unknown>;
      if (
        (record.segment_refs as string[]).some((alias) => !aliases.has(alias))
      )
        return {
          ...parsed,
          valid: false,
          reason: 'FOREIGN_SOURCE_REF',
          errors: [],
        };
      const refs = [
        ...(Array.isArray(record.entity_refs) ? record.entity_refs : []),
        record.entity_ref,
        record.subject_ref,
        record.target_ref,
      ].filter((ref) => ref !== null && ref !== undefined);
      if (
        refs.some(
          (ref) =>
            !Number.isSafeInteger(ref) ||
            (ref as number) < 0 ||
            (ref as number) >= entities.length,
        )
      )
        return {
          ...parsed,
          valid: false,
          reason: 'FOREIGN_ENTITY_REF',
          errors: [],
        };
      const text = record.text_pl ?? record.label ?? record.context_pl;
      if (typeof text !== 'string' || !text.trim())
        return {
          ...parsed,
          valid: false,
          reason: 'EMPTY_SEMANTIC_CONTENT',
          errors: [],
        };
    }
  }
  if (!value.summary_pl!.length)
    return {
      ...parsed,
      valid: false,
      reason: 'MISSING_REQUIRED_SUMMARY',
      errors: [],
    };
  if (value.source_issues!.length)
    return { ...parsed, valid: false, reason: 'REVIEW_REQUIRED', errors: [] };
  return { ...parsed, valid: true, reason: null, errors: [] };
}
export const validateCanonical = (value: unknown) =>
  intelligence_canonical(value);
export const validateRepairWire = (value: unknown) => repair_wire(value);
