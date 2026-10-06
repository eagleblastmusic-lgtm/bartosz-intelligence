import { sha256 } from '../../auth/crypto.js';
import {
  validateCanonical,
  validateEconomyCandidate,
} from '../repair/validate.js';
import {
  buildEvidence,
  prepareEvidenceSource,
  type EvidenceInput,
} from './evidence.js';
import {
  resolveEntityMention,
  type ApprovedAlias,
  type EntityType,
} from './entities.js';
type Note = { text_pl: string; segment_refs: string[] };
type Attribution = 'SOURCE_SPEAKER' | 'REPORTED_OTHER' | 'UNCLEAR';
type Claim = Note & {
  entity_refs: number[];
  subject_ref: number | null;
  attribution: Attribution;
  qualifiers: string[];
};
type Stance = Claim & {
  target_ref: number | null;
  polarity: 'POSITIVE' | 'NEGATIVE' | 'MIXED' | 'NEUTRAL' | 'UNCLEAR';
};
type Prediction = Claim & { horizon: string | null };
interface EconomyWire {
  summary_pl: Note[];
  key_points: Note[];
  entity_mentions: {
    segment_refs: string[];
    label: string;
    entity_type: EntityType;
  }[];
  tools: { segment_refs: string[]; entity_ref: number; context_pl: string }[];
  claims: Claim[];
  stance: Stance[];
  predictions: Prediction[];
  source_issues: string[];
}
export async function enrichEconomy(input: {
  raw: string;
  completion: 'OK' | 'REFUSED' | 'INCOMPLETE';
  run_id: string;
  item_id: string;
  profile_id: string;
  profile_revision: string;
  source: Omit<EvidenceInput, 'segment_refs'>;
  approved_aliases: readonly ApprovedAlias[];
}) {
  if (
    !input.run_id ||
    !input.item_id ||
    !input.profile_id ||
    !input.profile_revision
  )
    throw new Error('INVALID_ENRICHMENT_CONTEXT');
  const checked = await validateEconomyCandidate(
    input.raw,
    input.completion,
    new Set(input.source.manifest.anchors.map((a) => a.alias)),
  );
  if (!checked.valid) throw new Error(checked.reason!);
  const wire = checked.value as EconomyWire;
  const evidenceBuilder = await prepareEvidenceSource(input.source);
  const evidenceMap = new Map<
    string,
    Awaited<ReturnType<typeof buildEvidence>>[number]
  >();
  const refs = async (aliases: readonly string[]) => {
    const rows = await evidenceBuilder(aliases);
    for (const row of rows) evidenceMap.set(row.canonical.evidence_id, row);
    return rows.map((row) => row.canonical.evidence_id);
  };
  const identities = await Promise.all(
    wire.entity_mentions.map((mention, index) =>
      resolveEntityMention({
        owner_id: input.source.owner_id,
        source_artifact_id: input.source.source_artifact_id,
        mention_index: index,
        label: mention.label,
        entity_type: mention.entity_type,
        aliases: input.approved_aliases,
        language: input.source.source_language,
      }),
    ),
  );
  const entityRef = (index: number | null) =>
    index === null ? null : identities[index]!.entity_id;
  const entities = [];
  for (let i = 0; i < wire.entity_mentions.length; i++) {
    const identity = identities[i]!;
    entities.push({
      entity_id: identity.entity_id,
      label: identity.label,
      entity_type: identity.entity_type,
      evidence_ids: await refs(wire.entity_mentions[i]!.segment_refs),
    });
  }
  const notes = async (rows: Note[]) =>
    Promise.all(
      rows.map(async (row) => ({
        text_pl: row.text_pl,
        evidence_ids: await refs(row.segment_refs),
      })),
    );
  const typed = async (
    rows: (Claim | Stance | Prediction)[],
    kind: 'CLAIM' | 'STANCE' | 'PREDICTION',
  ) => {
    const mapped = new Map<
      string,
      {
        observation_id: string;
        kind: string;
        content_pl: string;
        subject_ref: string | null;
        target_ref: string | null;
        entity_refs: string[];
        evidence_ids: string[];
        epistemic_status: string;
        qualifiers: string[];
        temporal_text: string | null;
        stance_polarity: string | null;
        usage_stage: null;
        prediction_horizon: string | null;
        relation_refs: string[];
        attribution: Attribution;
      }
    >();
    for (const row of rows) {
      const value = {
        kind,
        content_pl: row.text_pl,
        subject_ref: entityRef(row.subject_ref),
        target_ref:
          kind === 'STANCE' ? entityRef((row as Stance).target_ref) : null,
        entity_refs: [
          ...new Set(row.entity_refs.map((index) => entityRef(index)!)),
        ],
        evidence_ids: await refs(row.segment_refs),
        epistemic_status:
          row.attribution === 'SOURCE_SPEAKER'
            ? 'SOURCE_STATEMENT'
            : row.attribution === 'REPORTED_OTHER'
              ? 'SOURCE_REPORT'
              : 'UNRESOLVED',
        qualifiers: [...row.qualifiers],
        temporal_text:
          kind === 'PREDICTION' ? (row as Prediction).horizon : null,
        stance_polarity: kind === 'STANCE' ? (row as Stance).polarity : null,
        usage_stage: null,
        prediction_horizon:
          kind === 'PREDICTION' ? (row as Prediction).horizon : null,
        relation_refs: [] as string[],
        attribution: row.attribution,
      };
      const id =
        'obs_' +
        (await sha256(
          JSON.stringify({
            owner: input.source.owner_id,
            run: input.run_id,
            source: input.source.source_artifact_id,
            value,
          }),
        ));
      mapped.set(id, { observation_id: id, ...value });
    }
    return [...mapped.values()];
  };
  const tools = [];
  for (const tool of wire.tools)
    tools.push({
      entity_ref: entityRef(tool.entity_ref)!,
      context_pl: tool.context_pl,
      evidence_ids: await refs(tool.segment_refs),
    });
  const orderedEvidence = () =>
    [...evidenceMap.values()].sort(
      (a, b) =>
        a.anchor_snapshot.source_start - b.anchor_snapshot.source_start ||
        a.anchor_snapshot.source_end - b.anchor_snapshot.source_end ||
        a.canonical.evidence_id.localeCompare(b.canonical.evidence_id),
    );
  const canonical = {
    schema_version: '1.2',
    item_id: input.item_id,
    source_artifact_id: input.source.source_artifact_id,
    profile_id: input.profile_id,
    profile_revision: input.profile_revision,
    output_language: 'pl',
    status: 'OK',
    enabled_modules: [
      'summary',
      'key_points',
      'entities',
      'tools',
      'claims',
      'stance',
      'predictions',
    ],
    source_issues: [],
    summary_pl: await notes(wire.summary_pl),
    key_points: await notes(wire.key_points),
    entities,
    tools,
    claims: await typed(wire.claims, 'CLAIM'),
    stance: await typed(wire.stance, 'STANCE'),
    predictions: await typed(wire.predictions, 'PREDICTION'),
    usage: [],
    recommendations: [],
    uncertainties: [],
    contradictions: [],
    evidence: orderedEvidence().map((row) => row.canonical),
    wire_schema_id: 'urn:bartosz:schema:economy-wire:1.0',
    enrichment_version: '1.0',
  };
  if (!validateCanonical(canonical))
    throw new Error('CANONICAL_SCHEMA_INVALID');
  return {
    canonical,
    canonical_hash: await sha256(JSON.stringify(canonical)),
    evidence_snapshots: orderedEvidence(),
    entity_resolutions: identities,
    // Exactly the typed projection rows; notes/mentions never manufacture observations.
    observation_rows: [
      ...canonical.claims,
      ...canonical.stance,
      ...canonical.predictions,
    ],
    semantic_verification: 'NOT_ASSERTED' as const,
  };
}
