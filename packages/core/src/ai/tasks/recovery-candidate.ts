import {
  assertContext,
  type AccessContext,
  type Database,
} from '../../db/boundary.js';
import { sha256 } from '../../auth/crypto.js';
import { mapTranslation } from './translation.js';
import type { OptionalTaskSnapshot } from './jobs.js';
import {
  verifyTranslationPart,
  composeTranslations,
  type TranslationPart,
} from './translation-recovery.js';
export interface TranslationRecoveryRef {
  parent_run_id: string;
  parent_outcome_hash: string;
  generation: number;
}
type TranslationSnapshot = Extract<OptionalTaskSnapshot, { task: 'TRANSLATE' }>;
export async function loadTranslationRecovery(
  db: Database,
  context: AccessContext,
  runId: string,
  seen: readonly string[] = [],
): Promise<{
  snapshot: TranslationSnapshot;
  plan: TranslationSnapshot['plan'];
  mapped: TranslationPart['mapped'];
  generation: number;
  outcome_hash: string;
}> {
  assertContext(context);
  if (context.kind === 'worker') context.requireTask('TRANSLATE');
  else context.requireOwner();
  if (seen.length > 3 || seen.includes(runId))
    throw new Error('TRANSLATION_RECOVERY_EXHAUSTED');
  const row = await db
    .prepare(
      "SELECT r.outcome_json,r.candidate_hash,j.payload_json,j.profile_revision FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=? AND r.run_id=? AND r.state='CANDIDATE' AND j.task_type='TRANSLATE' AND ((r.validation_outcome='DETERMINISTIC_CORE_CANDIDATE' AND j.state='SUCCEEDED' AND j.reason_code='OPTIONAL_PARTIAL_COMPLETE') OR (r.validation_outcome='DETERMINISTIC_CORE_INVALID' AND j.state='FAILED' AND j.reason_code='OPTIONAL_INVALID_COMPLETE'))",
    )
    .bind(context.ownerId, runId)
    .first<{
      outcome_json: string;
      candidate_hash: string;
      payload_json: string;
      profile_revision: string;
    }>();
  if (!row || (await sha256(row.outcome_json)) !== row.candidate_hash)
    throw new Error('TRANSLATION_RECOVERY_NOT_AVAILABLE');
  const snapshot = (
    JSON.parse(row.payload_json) as { snapshot: OptionalTaskSnapshot }
  ).snapshot;
  if (
    snapshot.task !== 'TRANSLATE' ||
    (await sha256(JSON.stringify(snapshot))) !== row.profile_revision
  )
    throw new Error('OPTIONAL_SNAPSHOT_MISMATCH');
  const outcome = JSON.parse(row.outcome_json) as {
    version: string;
    task: string;
    mapped: TranslationPart['mapped'];
    part_mapped?: TranslationPart['mapped'];
    reason?: string;
    plan_hash?: string;
  };
  if (
    !['optional-candidate:1', 'optional-invalid:1'].includes(outcome.version) ||
    outcome.task !== 'TRANSLATE'
  )
    throw new Error('TRANSLATION_RECOVERY_NOT_AVAILABLE');
  let plan = snapshot.plan,
    generation = 0;
  let parent: Awaited<ReturnType<typeof loadTranslationRecovery>> | null = null;
  if (snapshot.recovery) {
    parent = await loadTranslationRecovery(
      db,
      context,
      snapshot.recovery.parent_run_id,
      [...seen, runId],
    );
    if (
      parent.outcome_hash !== snapshot.recovery.parent_outcome_hash ||
      snapshot.recovery.generation !== parent.generation + 1
    )
      throw new Error('OPTIONAL_SNAPSHOT_MISMATCH');
    plan = parent.plan;
    generation = snapshot.recovery.generation;
  }
  let mapped = snapshot.chunk ? outcome.part_mapped! : outcome.mapped;
  if (outcome.version === 'optional-invalid:1') {
    if (outcome.plan_hash !== snapshot.plan.hash || !outcome.reason)
      throw new Error('OPTIONAL_SNAPSHOT_MISMATCH');
    // Invalid output contributes no accepted translation. Keep its immutable FAIL;
    // the empty diagnostic merely identifies the original IDs that need a new request.
    const empty = await mapTranslation(snapshot.plan, {
      status: 'OK',
      raw_output: JSON.stringify({
        status: 'OK',
        translated_segments: [],
        limitations_pl: [],
      }),
    });
    const diagnostic = {
      ...empty,
      repair_report: {
        result: 'INVALID_OUTPUT_EXCLUDED',
        reason: outcome.reason,
        parent_outcome_hash: row.candidate_hash,
      },
    };
    mapped = parent
      ? await composeTranslations(plan, [
          { plan: parent.plan, mapped: parent.mapped },
          { plan: snapshot.plan, mapped: diagnostic },
        ])
      : diagnostic;
  }
  await verifyTranslationPart(plan, { plan, mapped });
  return {
    snapshot,
    plan,
    mapped,
    generation,
    outcome_hash: row.candidate_hash,
  };
}
