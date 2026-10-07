import { sha256 } from '../../auth/crypto.js';
import {
  assertContext,
  type AccessContext,
  type Database,
} from '../../db/boundary.js';
import type { OptionalTaskSnapshot } from './jobs.js';
import {
  planTranslationChunks,
  type TranslationChunkPolicy,
} from './translation-chunks.js';
import {
  verifyTranslationPart,
  type TranslationPart,
} from './translation-recovery.js';

export type TranslationSnapshot = Extract<
  OptionalTaskSnapshot,
  { task: 'TRANSLATE' }
>;
export interface TranslationChunkRef {
  group_hash: string;
  index: number;
  previous_run_id: string | null;
  previous_outcome_hash: string | null;
}
export interface TranslationGroup {
  version: 'translation-group:1';
  owner_id: string;
  nonce: string;
  root: TranslationSnapshot;
  policy: TranslationChunkPolicy;
  manifest_hash: string;
}

export async function loadTranslationGroup(
  db: Database,
  context: AccessContext,
  snapshot: TranslationSnapshot,
) {
  assertContext(context);
  if (context.kind === 'worker') context.requireTask('TRANSLATE');
  else context.requireOwner();
  const ref = snapshot.chunk;
  if (!ref || !/^[a-f0-9]{64}$/.test(ref.group_hash))
    throw new Error('INVALID_TRANSLATION_GROUP');
  const row = await db
    .prepare(
      'SELECT payload_json,content_hash,created_at FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
    )
    .bind(context.ownerId, 'translation-group-' + ref.group_hash)
    .first<{
      payload_json: string;
      content_hash: string;
      created_at: string;
    }>();
  if (
    !row ||
    row.content_hash !== ref.group_hash ||
    (await sha256(row.payload_json)) !== ref.group_hash
  )
    throw new Error('INVALID_TRANSLATION_GROUP');
  const group = JSON.parse(row.payload_json) as TranslationGroup;
  if (
    group.version !== 'translation-group:1' ||
    group.owner_id !== context.ownerId ||
    group.root.chunk ||
    group.root.recovery
  )
    throw new Error('INVALID_TRANSLATION_GROUP');
  const chunks = await planTranslationChunks(group.root.plan, group.policy);
  if (
    chunks.hash !== group.manifest_hash ||
    !Number.isSafeInteger(ref.index) ||
    ref.index < 0 ||
    !chunks.parts[ref.index]
  )
    throw new Error('INVALID_TRANSLATION_GROUP');
  const pins = (s: TranslationSnapshot) => ({
    version: s.version,
    task: s.task,
    item_id: s.item_id,
    glossary: s.glossary,
    selected_run_id: s.selected_run_id,
    profile: s.profile,
    prompt: s.prompt,
    settings: s.settings,
  });
  if (
    JSON.stringify(pins(group.root)) !== JSON.stringify(pins(snapshot)) ||
    (!snapshot.recovery && snapshot.plan.hash !== chunks.parts[ref.index]!.hash)
  )
    throw new Error('INVALID_TRANSLATION_GROUP');
  let previous: TranslationPart | null = null;
  if (ref.index === 0) {
    if (ref.previous_run_id !== null || ref.previous_outcome_hash !== null)
      throw new Error('INVALID_TRANSLATION_GROUP');
  } else {
    const prior = await db
      .prepare(
        "SELECT r.outcome_json,r.candidate_hash,j.payload_json,j.profile_revision FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=? AND r.run_id=? AND r.state='CANDIDATE' AND r.validation_outcome='DETERMINISTIC_CORE_CANDIDATE' AND j.state='SUCCEEDED' AND j.reason_code='OPTIONAL_PARTIAL_COMPLETE' AND j.task_type='TRANSLATE'",
      )
      .bind(context.ownerId, ref.previous_run_id)
      .first<{
        outcome_json: string;
        candidate_hash: string;
        payload_json: string;
        profile_revision: string;
      }>();
    if (
      !prior ||
      prior.candidate_hash !== ref.previous_outcome_hash ||
      (await sha256(prior.outcome_json)) !== prior.candidate_hash
    )
      throw new Error('INVALID_TRANSLATION_GROUP');
    const priorSnapshot = (
      JSON.parse(prior.payload_json) as { snapshot: TranslationSnapshot }
    ).snapshot;
    const value = JSON.parse(prior.outcome_json) as {
      version: string;
      task: string;
      part_complete: boolean;
      mapped: TranslationPart['mapped'];
    };
    if (
      (await sha256(JSON.stringify(priorSnapshot))) !==
        prior.profile_revision ||
      priorSnapshot.chunk?.group_hash !== ref.group_hash ||
      priorSnapshot.chunk.index !== ref.index - 1 ||
      value.version !== 'optional-candidate:1' ||
      value.task !== 'TRANSLATE' ||
      value.part_complete !== true
    )
      throw new Error('INVALID_TRANSLATION_GROUP');
    await verifyTranslationPart(group.root.plan, {
      plan: group.root.plan,
      mapped: value.mapped,
    });
    const expected = chunks.parts
      .slice(0, ref.index)
      .flatMap((p) => p.snapshot.segments.map((s) => s.source_segment_id));
    if (
      JSON.stringify(
        value.mapped.canonical.translated_segments.map(
          (s) => s.source_segment_id,
        ),
      ) !== JSON.stringify(expected)
    )
      throw new Error('INVALID_TRANSLATION_GROUP');
    previous = {
      plan: group.root.plan,
      mapped: {
        ...value.mapped,
        repair_report: {
          result: 'VERIFIED_TRANSLATION_PREFIX',
          previous_run_id: ref.previous_run_id,
          previous_outcome_hash: prior.candidate_hash,
        },
      },
    };
  }
  return {
    group,
    chunks,
    previous,
    part: chunks.parts[ref.index]!,
    created_at: row.created_at,
  };
}
