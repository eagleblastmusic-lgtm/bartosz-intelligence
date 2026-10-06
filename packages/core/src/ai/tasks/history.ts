import { sha256 } from '../../auth/crypto.js';
import type { enrichEconomy } from '../enrichment/canonical.js';
import { parseWithDeterministicRepair } from '../repair/deterministic.js';
import {
  history_wire,
  historical,
} from '../../registry/generated/validators.js';
import type { AIResponse } from '../../../../contracts/src/ai.js';
type Canonical = Awaited<ReturnType<typeof enrichEconomy>>['canonical'];
export interface HistoryRecord {
  owner_id: string;
  item_id: string;
  run_id: string;
  accepted_at: string;
  published_at: string | null;
  row: Canonical['claims'][number];
  row_hash: string;
  evidence: Canonical['evidence'];
}
export async function historyPlan(input: {
  owner_id: string;
  current_item_id: string;
  current_run_id: string;
  cut: string;
  scope_note_pl: string;
  current: readonly HistoryRecord[];
  prior: readonly HistoryRecord[];
}) {
  const frozen = structuredClone(input);
  if (
    !frozen.owner_id ||
    !frozen.current_item_id ||
    !frozen.current_run_id ||
    !Number.isFinite(Date.parse(frozen.cut)) ||
    !frozen.scope_note_pl.trim() ||
    frozen.scope_note_pl.length > 2000 ||
    !frozen.current.length ||
    frozen.current.length > 20 ||
    frozen.prior.length > 40
  )
    throw new Error('INVALID_HISTORY_SCOPE');
  const observationIds = new Set<string>(),
    evidenceIds = new Set<string>();
  const evidenceHashes = new Map<string, string>();
  for (const [side, rows] of [
    ['current', frozen.current],
    ['prior', frozen.prior],
  ] as const) {
    for (const record of rows) {
      if (
        record.owner_id !== frozen.owner_id ||
        !record.item_id ||
        !record.run_id ||
        !Number.isFinite(Date.parse(record.accepted_at)) ||
        Date.parse(record.accepted_at) > Date.parse(frozen.cut) ||
        (record.published_at !== null &&
          (!Number.isFinite(Date.parse(record.published_at)) ||
            Date.parse(record.published_at) > Date.parse(frozen.cut))) ||
        (side === 'current'
          ? record.item_id !== frozen.current_item_id ||
            record.run_id !== frozen.current_run_id
          : record.item_id === frozen.current_item_id) ||
        observationIds.has(record.row.observation_id) ||
        !record.row.content_pl.trim() ||
        record.row_hash !== (await sha256(JSON.stringify(record.row))) ||
        !record.row.evidence_ids.length ||
        record.evidence.length > 8
      )
        throw new Error('HISTORY_RECORD_MISMATCH');
      observationIds.add(record.row.observation_id);
      const refs = new Set(record.row.evidence_ids);
      if (
        refs.size !== record.row.evidence_ids.length ||
        record.evidence.length !== refs.size ||
        record.evidence.some((e) => !refs.has(e.evidence_id))
      )
        throw new Error('HISTORY_EVIDENCE_MISMATCH');
      for (const evidence of record.evidence) {
        const hash = await sha256(JSON.stringify(evidence));
        if (
          !evidence.quote_original.trim() ||
          evidence.quote_hash !== (await sha256(evidence.quote_original)) ||
          !/^[a-f0-9]{64}$/.test(evidence.source_hash) ||
          !evidence.segment_ids.length ||
          (evidenceHashes.has(evidence.evidence_id) &&
            evidenceHashes.get(evidence.evidence_id) !== hash)
        )
          throw new Error('HISTORY_EVIDENCE_MISMATCH');
        evidenceHashes.set(evidence.evidence_id, hash);
        evidenceIds.add(evidence.evidence_id);
      }
    }
  }
  if (
    evidenceIds.size > 120 ||
    new TextEncoder().encode(JSON.stringify(frozen)).length > 128000
  )
    throw new Error('HISTORY_SCOPE_TOO_LARGE');
  const side = (rows: readonly HistoryRecord[], prefix: 'c' | 'p') => {
    const evidence = [
      ...new Map(
        rows.flatMap((row) =>
          row.evidence.map((e) => [e.evidence_id, e] as const),
        ),
      ).values(),
    ];
    return {
      observations: rows.map((record, i) => ({
        alias: `${prefix}o${i + 1}`,
        ...record,
      })),
      evidence: evidence.map((row, i) => ({
        alias: `${prefix}e${i + 1}`,
        ...row,
      })),
    };
  };
  const snapshot = {
    version: 'history-plan:1' as const,
    owner_id: frozen.owner_id,
    current_item_id: frozen.current_item_id,
    current_run_id: frozen.current_run_id,
    cut: frozen.cut,
    scope_note_pl: frozen.scope_note_pl,
    current: side(frozen.current, 'c'),
    prior: side(frozen.prior, 'p'),
  };
  return { snapshot, hash: await sha256(JSON.stringify(snapshot)) };
}
export type HistoryPlan = Awaited<ReturnType<typeof historyPlan>>;
export function historyPromptSide(side: HistoryPlan['snapshot']['current']) {
  return side.observations.map((record) => ({
    observation_ref: record.alias,
    published_at: record.published_at,
    kind: record.row.kind,
    content_pl: record.row.content_pl,
    attribution: record.row.attribution,
    qualifiers: record.row.qualifiers,
    temporal_text: record.row.temporal_text,
    stance_polarity: record.row.stance_polarity,
    usage_stage: record.row.usage_stage,
    prediction_horizon: record.row.prediction_horizon,
    evidence: record.evidence.map((e) => ({
      evidence_ref: side.evidence.find(
        (row) => row.evidence_id === e.evidence_id,
      )!.alias,
      quote_original: e.quote_original,
    })),
  }));
}
export async function mapHistory(
  plan: HistoryPlan,
  response: Pick<AIResponse, 'status' | 'raw_output'>,
) {
  if ((await sha256(JSON.stringify(plan.snapshot))) !== plan.hash)
    throw new Error('HISTORY_PLAN_MISMATCH');
  if (response.status !== 'OK' || response.raw_output === null)
    throw new Error('HISTORY_RESPONSE_NOT_COMPLETE');
  const parsed = await parseWithDeterministicRepair(response.raw_output);
  if (!history_wire(parsed.value)) throw new Error('INVALID_HISTORY_WIRE');
  const wire = parsed.value as {
    status: 'OK' | 'INSUFFICIENT_CONTEXT' | 'REFUSED';
    relations: {
      relation_type:
        | 'CONSISTENT'
        | 'POSSIBLE_CHANGE'
        | 'POSSIBLE_CONTRADICTION'
        | 'DIFFERENT_CONTEXT'
        | 'NOT_COMPARABLE';
      current_observation_refs: string[];
      prior_observation_refs: string[];
      current_evidence_refs: string[];
      prior_evidence_refs: string[];
      explanation_pl: string;
      qualifiers: string[];
    }[];
    limitations_pl: string[];
  };
  if (
    (wire.status !== 'OK' && wire.relations.length) ||
    (!plan.snapshot.prior.observations.length && wire.status === 'OK')
  )
    throw new Error('HISTORY_STATUS_MISMATCH');
  const compared = new Set<string>();
  const resolve = (
    side: HistoryPlan['snapshot']['current'],
    observationRefs: string[],
    evidenceRefs: string[],
  ) => {
    if (
      !observationRefs.length ||
      !evidenceRefs.length ||
      new Set(observationRefs).size !== observationRefs.length ||
      new Set(evidenceRefs).size !== evidenceRefs.length
    )
      throw new Error('MISSING_HISTORY_SIDE');
    const records = observationRefs.map((alias) => {
      const row = side.observations.find((o) => o.alias === alias);
      if (!row) throw new Error('FOREIGN_HISTORY_OBSERVATION');
      return row;
    });
    const evidence = evidenceRefs.map((alias) => {
      const row = side.evidence.find((e) => e.alias === alias);
      if (
        !row ||
        !records.some((o) => o.row.evidence_ids.includes(row.evidence_id))
      )
        throw new Error('FOREIGN_HISTORY_EVIDENCE');
      return row;
    });
    if (
      records.some(
        (o) =>
          !evidence.some((e) => o.row.evidence_ids.includes(e.evidence_id)),
      )
    )
      throw new Error('MISSING_HISTORY_OBSERVATION_EVIDENCE');
    return { records, evidence };
  };
  const relations = await Promise.all(
    wire.relations.map(async (row, index) => {
      if (!row.explanation_pl.trim())
        throw new Error('EMPTY_HISTORY_EXPLANATION');
      const current = resolve(
        plan.snapshot.current,
        row.current_observation_refs,
        row.current_evidence_refs,
      );
      const prior = resolve(
        plan.snapshot.prior,
        row.prior_observation_refs,
        row.prior_evidence_refs,
      );
      for (const record of prior.records) compared.add(record.item_id);
      return {
        ...row,
        local_id:
          'history_' +
          (await sha256(JSON.stringify({ plan_hash: plan.hash, index, row }))),
        current_observation_refs: current.records.map(
          (o) => o.row.observation_id,
        ),
        prior_observation_refs: prior.records.map((o) => o.row.observation_id),
        current_evidence_refs: current.evidence.map((e) => e.evidence_id),
        prior_evidence_refs: prior.evidence.map((e) => e.evidence_id),
      };
    }),
  );
  const canonical = {
    schema_version: '1.0' as const,
    status: wire.status,
    current_item_id: plan.snapshot.current_item_id,
    compared_item_ids: [...compared].sort(),
    scope_note_pl: plan.snapshot.scope_note_pl,
    relations,
    limitations_pl: wire.limitations_pl,
  };
  if (!historical(canonical)) throw new Error('INVALID_HISTORY_CANONICAL');
  return {
    canonical,
    canonical_hash: await sha256(JSON.stringify(canonical)),
    plan_hash: plan.hash,
    semantic_verification: 'NOT_ASSERTED' as const,
    repair_report: parsed.report,
  };
}
