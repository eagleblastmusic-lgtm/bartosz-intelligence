import { sha256 } from '../../auth/crypto.js';
export type EntityType =
  'PERSON' | 'ORG' | 'TOOL' | 'MODEL' | 'PRODUCT' | 'TOPIC' | 'PLACE' | 'OTHER';
export interface ApprovedAlias {
  owner_id: string;
  entity_id: string;
  entity_type: EntityType;
  literal: string;
}
export async function resolveEntityMention(input: {
  owner_id: string;
  source_artifact_id: string;
  mention_index: number;
  label: string;
  entity_type: EntityType;
  aliases: readonly ApprovedAlias[];
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
          row.literal.normalize('NFC').trim() === literal,
      )
      .map((row) => row.entity_id),
  );
  if (ids.size === 1)
    return {
      entity_id: [...ids][0]!,
      label: literal,
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
