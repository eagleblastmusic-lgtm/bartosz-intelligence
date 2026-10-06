import { sha256 } from '../../auth/crypto.js';
import type { MaterializedSemanticProfile } from '../../registry/semantic-profiles.js';
import { validateSemanticCandidate } from '../repair/validate.js';

export interface AdditionalPassSnapshot {
  mode: 'SECOND_PASS' | 'VALIDATE';
  purpose: string;
  candidate_run_id: string;
  candidate_hash: string;
  candidate_wire: Record<string, unknown>;
}

/** The previous candidate is an input for inspection; original source remains authority. */
export async function validateAdditionalPass(
  pass: AdditionalPassSnapshot,
  profile: MaterializedSemanticProfile,
  aliases: ReadonlySet<string>,
) {
  if (
    profile.config.mode !== 'CUSTOM' ||
    !['SECOND_PASS', 'VALIDATE'].includes(pass.mode) ||
    Object.keys(pass).sort().join(',') !==
      'candidate_hash,candidate_run_id,candidate_wire,mode,purpose' ||
    typeof pass.candidate_run_id !== 'string' ||
    !pass.candidate_run_id ||
    pass.candidate_run_id.length > 128
  )
    throw new Error('INVALID_ADDITIONAL_PASS');
  const declared =
    pass.mode === 'SECOND_PASS'
      ? profile.config.second_pass
      : profile.config.validation_pass;
  if (!declared || pass.purpose !== declared.purpose)
    throw new Error('ADDITIONAL_PASS_PURPOSE_MISMATCH');
  const raw = JSON.stringify(pass.candidate_wire);
  if (
    new TextEncoder().encode(raw).length > 2 * 1024 * 1024 ||
    (await sha256(raw)) !== pass.candidate_hash
  )
    throw new Error('ADDITIONAL_PASS_CANDIDATE_MISMATCH');
  const candidate = await validateSemanticCandidate(
    raw,
    'OK',
    aliases,
    profile,
  );
  if (!candidate.valid) throw new Error('INVALID_ADDITIONAL_PASS_CANDIDATE');
  return structuredClone(pass);
}
