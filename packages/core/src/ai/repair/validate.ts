import {
  economy_wire,
  intelligence_canonical,
  repair_wire,
  full_wire,
} from '../../registry/generated/validators.js';
import { semanticModules } from '../semantic-profile.js';
import type { MaterializedSemanticProfile } from '../../registry/semantic-profiles.js';
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

// Custom is a strict Full subset. Padding is validator-only and never becomes
// accepted semantic output, an extra module, or a provider request.
export async function validateSemanticCandidate(
  raw: string,
  completion: 'OK' | 'REFUSED' | 'INCOMPLETE',
  aliases: ReadonlySet<string>,
  profile: MaterializedSemanticProfile,
) {
  if (profile.config.mode === 'ECONOMY')
    return validateEconomyCandidate(raw, completion, aliases);
  if (completion !== 'OK')
    throw new Error(
      completion === 'REFUSED'
        ? 'REFUSAL_NOT_REPAIRABLE'
        : 'TRUNCATION_NOT_REPAIRABLE',
    );
  const parsed = await parseWithDeterministicRepair(raw);
  const invalid = (reason: string) => ({
    ...parsed,
    valid: false,
    reason,
    errors: [],
  });
  if (
    !parsed.value ||
    typeof parsed.value !== 'object' ||
    Array.isArray(parsed.value)
  )
    return invalid('WIRE_SCHEMA_INVALID');
  const expected = [
    'entity_mentions',
    'source_issues',
    ...semanticModules
      .filter((key) => profile.config.modules[key])
      .map((key) =>
        key === 'entities'
          ? 'entity_mentions'
          : key === 'summary'
            ? 'summary_pl'
            : key,
      ),
  ];
  const keys = new Set(expected);
  const value = parsed.value as Record<string, unknown[]>;
  if (
    Object.keys(value).length !== keys.size ||
    Object.keys(value).some((key) => !keys.has(key)) ||
    [...keys].some((key) => !Object.hasOwn(value, key))
  )
    return invalid('WIRE_SCOPE_INVALID');
  if (Object.values(value).some((rows) => !Array.isArray(rows)))
    return invalid('WIRE_SCHEMA_INVALID');
  const padded = Object.fromEntries(
    [
      'summary_pl',
      'key_points',
      'entity_mentions',
      'tools',
      'claims',
      'stance',
      'predictions',
      'source_issues',
      'usage',
      'recommendations',
      'uncertainties',
      'contradictions',
    ].map((key) => [key, value[key] ?? []]),
  );
  if (!full_wire(padded)) return invalid('WIRE_SCHEMA_INVALID');
  const entities = value.entity_mentions!;
  for (const [module, records] of Object.entries(value)) {
    if (module === 'source_issues') continue;
    for (const row of records) {
      const record = row as Record<string, unknown>;
      if (module === 'contradictions') {
        const left = record.left as { module: string; index: number },
          right = record.right as { module: string; index: number };
        if (
          !profile.config.modules[
            left.module as keyof typeof profile.config.modules
          ] ||
          !profile.config.modules[
            right.module as keyof typeof profile.config.modules
          ] ||
          !value[left.module]?.[left.index] ||
          !value[right.module]?.[right.index]
        )
          return invalid('FOREIGN_RELATION_REF');
        if (left.module === right.module && left.index === right.index)
          return invalid('SELF_RELATION_REF');
        if (
          JSON.stringify(value[left.module]![left.index]) ===
          JSON.stringify(value[right.module]![right.index])
        )
          return invalid('DUPLICATE_RELATION_SIDES');
        if (!(record.explanation_pl as string).trim())
          return invalid('EMPTY_SEMANTIC_CONTENT');
        continue;
      }
      if (
        (record.segment_refs as string[]).some((alias) => !aliases.has(alias))
      )
        return invalid('FOREIGN_SOURCE_REF');
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
        return invalid('FOREIGN_ENTITY_REF');
      const text = record.text_pl ?? record.label ?? record.context_pl;
      if (typeof text !== 'string' || !text.trim())
        return invalid('EMPTY_SEMANTIC_CONTENT');
    }
  }
  if (profile.config.modules.summary && !value.summary_pl!.length)
    return invalid('MISSING_REQUIRED_SUMMARY');
  if (value.source_issues!.length) return invalid('REVIEW_REQUIRED');
  return { ...parsed, valid: true, reason: null, errors: [] };
}
