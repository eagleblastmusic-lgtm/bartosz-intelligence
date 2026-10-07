import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import { enrichEconomy } from '../../packages/core/src/ai/enrichment/canonical.js';
import { acceptedView } from '../../packages/core/src/projections/accepted-view.js';

/** Byte-exact synthetic source and canonical for isolated browser integrity checks. */
export async function knowledgeUxFixtureSql(at: string) {
  const owner = 'ux-owner',
    item = 'ux-6',
    run = 'run-ux-6',
    sourceId = 'ux-source-original';
  const text =
    'Synthetic source: I tried Tool X, but did not adopt it. Żółć 🧠.';
  const normalized = await normalizeTranscript(
    await sha256(text),
    [
      {
        upstream_index: 0,
        text,
        start_ms: null,
        end_ms: null,
        speaker_label: null,
      },
    ],
    'NONE',
  );
  const enriched = await enrichEconomy({
    raw: JSON.stringify({
      summary_pl: [
        {
          text_pl:
            'Syntetyczne źródło: autor wypróbował narzędzie, ale go nie wdrożył.',
          segment_refs: ['s1'],
        },
      ],
      key_points: [],
      entity_mentions: [
        { label: 'Tool X', entity_type: 'TOOL', segment_refs: ['s1'] },
      ],
      tools: [],
      claims: [
        {
          text_pl: 'Autor wypróbował narzędzie, ale go nie wdrożył.',
          segment_refs: ['s1'],
          entity_refs: [0],
          subject_ref: null,
          attribution: 'SOURCE_SPEAKER',
          qualifiers: ['tylko próba'],
        },
      ],
      stance: [],
      predictions: [],
      source_issues: [],
    }),
    completion: 'OK',
    run_id: run,
    item_id: item,
    profile_id: 'gemini_free',
    profile_revision: '1',
    approved_aliases: [],
    source: {
      owner_id: owner,
      source_artifact_id: sourceId,
      source_text: text,
      manifest: normalized.manifest,
      manifest_hash: normalized.manifest_hash,
      video_url: 'https://www.youtube.com/watch?v=00000000006',
    },
  });
  const literal = (v: unknown) =>
    v === null
      ? 'NULL'
      : typeof v === 'number'
        ? String(v)
        : "'" + String(v).replaceAll("'", "''") + "'";
  const insert = (table: string, row: Record<string, unknown>) =>
    `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.values(row).map(literal).join(',')});\n`;
  let sql = '';
  const artifact = async (
    id: string,
    kind: string,
    body: string,
    schema: string,
    original: string | null,
  ) => {
    const bytes = Buffer.from(body, 'utf8'),
      hash = await sha256(body);
    if (bytes.length > 32768)
      throw new Error('KNOWLEDGE_FIXTURE_ARTIFACT_TOO_LARGE');
    sql += insert('artifacts', {
      artifact_id: id,
      owner_id: owner,
      item_id: item,
      kind,
      content_hash: hash,
      byte_size: bytes.length,
      chunk_count: 1,
      schema_version: schema,
      producer_version: 'synthetic-knowledge-ux:1',
      provenance_json: '{"fixture":true,"provider_requests":0}',
      original_ref: original,
      state: 'VERIFIED',
      manifest_hash: await sha256('synthetic-manifest:' + hash),
      created_at: at,
      verified_at: at,
    });
    sql += insert('artifact_chunks', {
      owner_id: owner,
      item_id: item,
      artifact_id: id,
      chunk_index: 0,
      byte_start: 0,
      byte_size: bytes.length,
      byte_hash: hash,
      storage_ref: `d1:${id}/0`,
      body_base64: bytes.toString('base64url'),
    });
    return hash;
  };
  await artifact(sourceId, 'SOURCE_ORIGINAL', text, 'decoded-cue-text:1', null);
  const canonicalId = 'ux-canonical';
  const canonicalHash = await artifact(
    canonicalId,
    'ANALYSIS_CANDIDATE',
    JSON.stringify(enriched.canonical),
    'intelligence-canonical:1.2',
    sourceId,
  );
  const outcome = JSON.stringify({
    version: 'intelligence-accepted:1',
    view: acceptedView(enriched.canonical),
    run_id: run,
    canonical_artifact_id: canonicalId,
    canonical_hash: canonicalHash,
    source_artifact_id: sourceId,
    source_run_id: 'synthetic-transcript',
    quality_scope: 'SYNTHETIC_NOT_QUALIFIED',
    semantic_verification: 'NOT_ASSERTED',
  });
  sql += insert('analysis_runs', {
    run_id: run,
    owner_id: owner,
    item_id: item,
    job_id: 'job-ux-6',
    input_snapshot_json: '{}',
    profile_snapshot_json: '{}',
    routing_snapshot_json: '{}',
    state: 'ACCEPTED',
    candidate_hash: await sha256(outcome),
    outcome_json: outcome,
    created_at: at,
    accepted_at: at,
  });
  sql += insert('active_analysis_selections', {
    owner_id: owner,
    item_id: item,
    accepted_run_id: run,
    selection_revision: 1,
    requested_run_id: run,
  });
  for (const entity of enriched.canonical.entities)
    sql += insert('entities', {
      owner_id: owner,
      entity_id: entity.entity_id,
      label: entity.label,
      entity_type: entity.entity_type,
      resolution: 'UNRESOLVED_LITERAL',
      created_at: at,
    });
  for (const proof of enriched.evidence_snapshots) {
    const ev = proof.canonical,
      anchor = proof.anchor_snapshot;
    sql += insert('evidence', {
      owner_id: owner,
      evidence_id: ev.evidence_id,
      item_id: item,
      source_artifact_id: sourceId,
      source_hash: ev.source_hash,
      source_start: anchor.source_start,
      source_end: anchor.source_end,
      quote_hash: ev.quote_hash,
      segment_ids_json: JSON.stringify(ev.segment_ids),
      anchor_snapshot_json: JSON.stringify(anchor),
      start_ms: ev.start_ms,
      end_ms: ev.end_ms,
      timestamp_precision: ev.timestamp_precision,
      timestamp_url: ev.timestamp_url,
      created_at: at,
    });
    sql += insert('analysis_evidence', {
      owner_id: owner,
      run_id: run,
      evidence_id: ev.evidence_id,
    });
  }
  for (const row of enriched.observation_rows) {
    const body = JSON.stringify(row);
    sql += insert('observations', {
      owner_id: owner,
      observation_id: row.observation_id,
      run_id: run,
      kind: row.kind,
      row_json: body,
      row_hash: await sha256(body),
      recorded_at: at,
    });
    for (const evidence of row.evidence_ids)
      sql += insert('observation_evidence', {
        owner_id: owner,
        observation_id: row.observation_id,
        evidence_id: evidence,
      });
    for (const entity of row.entity_refs)
      sql += insert('observation_entities', {
        owner_id: owner,
        observation_id: row.observation_id,
        entity_id: entity,
        role: 'MENTION',
      });
  }
  return sql;
}
