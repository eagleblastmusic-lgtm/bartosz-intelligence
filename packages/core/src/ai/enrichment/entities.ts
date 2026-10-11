import { sha256 } from '../../auth/crypto.js';
export type EntityType =
  'PERSON' | 'ORG' | 'TOOL' | 'MODEL' | 'PRODUCT' | 'TOPIC' | 'PLACE' | 'OTHER';
export interface ApprovedAlias {
  owner_id: string;
  entity_id: string;
  entity_type: EntityType;
  literal: string;
  canonical_label?: string;
  language?: string | null;
}
export async function resolveEntityMention(input: {
  owner_id: string;
  source_artifact_id: string;
  mention_index: number;
  label: string;
  entity_type: EntityType;
  aliases: readonly ApprovedAlias[];
  language?: string | null;
}) {
  if (
    !input.owner_id ||
    !input.source_artifact_id ||
    !Number.isSafeInteger(input.mention_index) ||
    input.mention_index < 0 ||
    !input.label.trim() ||
    ![
      'PERSON',
      'ORG',
      'TOOL',
      'MODEL',
      'PRODUCT',
      'TOPIC',
      'PLACE',
      'OTHER',
    ].includes(input.entity_type)
  )
    throw new Error('INVALID_ENTITY_MENTION');
  const literal = input.label.normalize('NFC').trim();
  const ids = new Set(
    input.aliases
      .filter(
        (row) =>
          row.owner_id === input.owner_id &&
          row.entity_type === input.entity_type &&
          (!row.language ||
            row.language.toLowerCase() === input.language?.toLowerCase()) &&
          row.literal.normalize('NFC').trim() === literal,
      )
      .map((row) => row.entity_id),
  );
  const approved = input.aliases.filter(
    (a) =>
      a.owner_id === input.owner_id &&
      ids.has(a.entity_id) &&
      a.entity_type === input.entity_type &&
      a.literal.normalize('NFC').trim() === literal &&
      (!a.language ||
        a.language.toLowerCase() === input.language?.toLowerCase()),
  );
  const labels = new Set(
    approved
      .map((a) => a.canonical_label?.trim())
      .filter((label): label is string => !!label),
  );
  if (ids.size === 1 && labels.size <= 1)
    return {
      entity_id: [...ids][0]!,
      label: [...labels][0] ?? literal,
      entity_type: input.entity_type,
      resolution: 'APPROVED_ALIAS' as const,
    };
  return {
    entity_id:
      'ent_' +
      (await sha256(
        JSON.stringify({
          owner: input.owner_id,
          source: input.source_artifact_id,
          index: input.mention_index,
          literal,
          type: input.entity_type,
        }),
      )),
    label: literal,
    entity_type: input.entity_type,
    resolution: ids.size
      ? ('AMBIGUOUS_LITERAL' as const)
      : ('UNRESOLVED_LITERAL' as const),
  };
}

export function approvedNameNormalizer(
  pairs: readonly { literal: string; label: string }[],
) {
  const labels = new Map<string, Set<string>>();
  for (const pair of pairs) {
    const values = labels.get(pair.literal) ?? new Set<string>();
    values.add(pair.label);
    labels.set(pair.literal, values);
  }
  const names = [...labels]
    .filter(([, values]) => values.size === 1)
    .sort(([a], [b]) => b.length - a.length);
  // One replacement pass: aliases cannot cascade into another entity's alias.
  if (!names.length) return (text: string) => text;
  const escape = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${names.map(([literal]) => escape(literal)).join('|')})(?![\\p{L}\\p{N}])`,
    'gu',
  );
  return (text: string) =>
    text.replace(pattern, (literal) => [...labels.get(literal)!][0]!);
}
