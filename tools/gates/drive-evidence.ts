import { createHash } from 'node:crypto';
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { strictJson } from '../../packages/core/src/ai/repair/strict-json.js';

export const exportChecks = [
  'oauth_offline_renewal',
  'private_root_child_access',
  'stable_snapshot',
  'compact_raw_markdown',
  'reserved_create_timeout_recovery',
  'same_file_late_revision',
  'same_file_mode_switch',
  'manual_edit_conflict',
  'concurrent_remote_guard',
  'complete_hash_counts_identity',
  'quota_storage_stop',
  'core_independent_of_drive',
  'human_compact_quality',
] as const;
export const bridgeChecks = [
  'scheduled_owner_root_access',
  'exact_daily_file',
  'complete_file_read',
  'stable_chunk_pagination',
  'revision_count_late_update',
  'partial_disclosure',
  'claim_attribution_qualifiers',
  'natural_polish_briefing',
  'voice_existing_chat',
] as const;
type Result = 'PASS' | 'FAIL' | 'NOT_RUN' | 'UNAVAILABLE';
export interface DriveGateInput {
  version: 'drive-gate-evidence:1';
  gate: 'D_EXPORT' | 'D_BRIDGE';
  configuration_sha256: string;
  configuration_path: string;
  rows: {
    id: string;
    result: Result;
    evidence: { path: string; sha256: string }[];
  }[];
}
export interface GateObservation {
  version: 'drive-gate-observation:1';
  kind: 'ACTUAL' | 'SIMULATED';
  configuration_sha256: string;
  check: string;
  observed_at: string;
  observer: string;
  result: Exclude<Result, 'NOT_RUN'>;
  method:
    | 'PROVIDER_READBACK'
    | 'HUMAN_REVIEW'
    | 'UNATTENDED_SCHEDULED'
    | 'OWNER_VOICE'
    | 'CAPABILITY_CHECK';
  facts: Record<string, string | number | boolean>;
}
export const evidenceHash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const identifier = /^[A-Za-z0-9_.:-]{1,128}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function keys(value: Record<string, unknown>, expected: string[]) {
  if (
    Object.keys(value).some((key) => !expected.includes(key)) ||
    expected.some((key) => !(key in value))
  )
    throw new Error('INVALID_DRIVE_GATE_SHAPE');
}
function observation(
  bytes: Uint8Array,
  input: DriveGateInput,
  check: string,
  now: Date,
): GateObservation {
  const value: unknown = strictJson(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  );
  if (!record(value)) throw new Error('INVALID_DRIVE_OBSERVATION');
  keys(value, [
    'version',
    'kind',
    'configuration_sha256',
    'check',
    'observed_at',
    'observer',
    'result',
    'method',
    'facts',
  ]);
  if (
    value.version !== 'drive-gate-observation:1' ||
    value.kind !== 'ACTUAL' ||
    value.configuration_sha256 !== input.configuration_sha256 ||
    value.check !== check ||
    !identifier.test(String(value.observer)) ||
    typeof value.observed_at !== 'string' ||
    !Number.isFinite(Date.parse(value.observed_at)) ||
    Date.parse(value.observed_at) > now.getTime() ||
    !['PASS', 'FAIL', 'UNAVAILABLE'].includes(String(value.result)) ||
    ![
      'PROVIDER_READBACK',
      'HUMAN_REVIEW',
      'UNATTENDED_SCHEDULED',
      'OWNER_VOICE',
      'CAPABILITY_CHECK',
    ].includes(String(value.method)) ||
    !record(value.facts) ||
    Object.keys(value.facts).length > 64
  )
    throw new Error('INVALID_DRIVE_OBSERVATION');
  for (const [key, fact] of Object.entries(value.facts)) {
    if (
      !/^[a-z][a-z0-9_]{0,63}$/.test(key) ||
      /token|secret|credential|authorization|cookie|password|content|transcript/i.test(
        key,
      ) ||
      !(
        typeof fact === 'boolean' ||
        (typeof fact === 'number' && Number.isFinite(fact)) ||
        (typeof fact === 'string' && fact.length <= 256 && !/[\r\n]/.test(fact))
      )
    )
      throw new Error('INVALID_DRIVE_OBSERVATION_FACT');
  }
  return value as unknown as GateObservation;
}
function passFacts(value: GateObservation, gate: DriveGateInput['gate']) {
  const f = value.facts;
  if (value.result !== 'PASS') return;
  if (gate === 'D_EXPORT') {
    if (
      value.method !==
      (value.check === 'human_compact_quality'
        ? 'HUMAN_REVIEW'
        : 'PROVIDER_READBACK')
    )
      throw new Error('WRONG_DRIVE_OBSERVER_METHOD');
    const required: Record<string, string[]> = {
      oauth_offline_renewal: [
        'offline_refresh_success',
        'failure_visible',
        'publishing_verified',
      ],
      private_root_child_access: ['root_private', 'child_create_read_update'],
      stable_snapshot: ['stable_cut', 'late_change_retained'],
      compact_raw_markdown: [
        'raw_markdown',
        'compact_default',
        'filename_date_match',
      ],
      reserved_create_timeout_recovery: [
        'reserved_before_create',
        'ambiguous_response_reconciled',
        'one_file',
      ],
      same_file_late_revision: [
        'same_file_id',
        'newer_revision',
        'no_duplicate',
      ],
      same_file_mode_switch: [
        'same_file_id',
        'compact_full_roundtrip',
        'no_duplicate',
      ],
      manual_edit_conflict: [
        'manual_preserved',
        'conflict_visible',
        'no_overwrite',
      ],
      concurrent_remote_guard: [
        'one_writer_accepted',
        'other_writer_412',
        'stable_readback',
      ],
      complete_hash_counts_identity: [
        'full_hash_match',
        'body_hash_match',
        'counts_match',
        'root_file_date_match',
      ],
      quota_storage_stop: [
        'fresh_quota_storage',
        'failure_visible',
        'no_paid_fallback',
        'no_data_loss',
      ],
      core_independent_of_drive: [
        'intake_continues',
        'jobs_durable',
        'no_extra_daily_ai',
      ],
      human_compact_quality: [
        'all_items',
        'custom_fallback',
        'source_inference_attributed',
        'qualifiers_preserved',
        'largest_case_reviewed',
      ],
    };
    if (!required[value.check]?.every((key) => f[key] === true))
      throw new Error('INCOMPLETE_DRIVE_PASS_FACTS');
    if (
      value.check === 'complete_hash_counts_identity' &&
      (!digest.test(String(f.rendered_sha256)) ||
        f.rendered_sha256 !== f.readback_sha256 ||
        typeof f.bytes !== 'number' ||
        f.bytes < 1)
    )
      throw new Error('INVALID_DRIVE_HASH_READBACK');
  } else {
    if (
      value.check === 'voice_existing_chat'
        ? value.method !== 'OWNER_VOICE'
        : ['claim_attribution_qualifiers', 'natural_polish_briefing'].includes(
              value.check,
            )
          ? value.method !== 'HUMAN_REVIEW'
          : value.method !== 'UNATTENDED_SCHEDULED'
    )
      throw new Error('WRONG_DRIVE_OBSERVER_METHOD');
    const required: Record<string, string[]> = {
      scheduled_owner_root_access: [
        'correct_owner_connection',
        'correct_root',
        'gui_closed',
      ],
      exact_daily_file: ['mapping_file_id', 'date_root_mime_match'],
      complete_file_read: [
        'all_blocks',
        'unique_items_counts',
        'footer',
        'middle_end_control_facts',
        'large_actual_connector',
      ],
      stable_chunk_pagination: [
        'all_cursors',
        'no_gaps_duplicates',
        'stable_version',
        'mixed_read_rejected',
      ],
      revision_count_late_update: [
        'date_revision_count',
        'late_newer_revision',
      ],
      partial_disclosure: [
        'pending_disclosed',
        'discovery_disclosed',
        'blocked_separate',
        'no_fake_summary',
      ],
      claim_attribution_qualifiers: [
        'attributed',
        'negations_preserved',
        'qualifiers_preserved',
        'predictions_not_facts',
        'custom_scope_respected',
      ],
      natural_polish_briefing: [
        'understandable_polish',
        'important_end_items',
        'source_links',
        'no_material_misstatement',
      ],
      voice_existing_chat: [
        'existing_chat_result',
        'owner_voice_used',
        'briefing_referenced',
      ],
    };
    if (!required[value.check]?.every((key) => f[key] === true))
      throw new Error('INCOMPLETE_DRIVE_PASS_FACTS');
    if (
      value.check === 'scheduled_owner_root_access' &&
      (typeof f.unattended_runs !== 'number' ||
        f.unattended_runs < 2 ||
        f.late_run !== true)
    )
      throw new Error('TWO_ACTUAL_SCHEDULED_RUNS_REQUIRED');
  }
}
export function evaluateDriveGate(
  input: DriveGateInput,
  load: (path: string) => Uint8Array,
  now: Date,
) {
  if (!record(input)) throw new Error('INVALID_DRIVE_GATE_SHAPE');
  keys(input as unknown as Record<string, unknown>, [
    'version',
    'gate',
    'configuration_sha256',
    'configuration_path',
    'rows',
  ]);
  const checks =
    input.gate === 'D_EXPORT'
      ? exportChecks
      : input.gate === 'D_BRIDGE'
        ? bridgeChecks
        : null;
  if (
    input.version !== 'drive-gate-evidence:1' ||
    !checks ||
    !digest.test(input.configuration_sha256) ||
    !Number.isFinite(now.getTime()) ||
    !Array.isArray(input.rows) ||
    input.rows.length > checks.length
  )
    throw new Error('INVALID_DRIVE_GATE_INPUT');
  if (typeof input.configuration_path !== 'string')
    throw new Error('INVALID_DRIVE_CONFIGURATION');
  const configurationBytes = load(input.configuration_path);
  if (
    configurationBytes.byteLength > 256 * 1024 ||
    evidenceHash(configurationBytes) !== input.configuration_sha256
  )
    throw new Error('DRIVE_CONFIGURATION_HASH_MISMATCH');
  const configuration: unknown = strictJson(
    new TextDecoder('utf-8', { fatal: true }).decode(configurationBytes),
  );
  if (!record(configuration)) throw new Error('INVALID_DRIVE_CONFIGURATION');
  keys(configuration, [
    'version',
    'gate',
    'owner_id',
    'connection_id',
    'root_id',
    'renderer_version',
    'report_schema',
    'cut_seq',
    'scope_dates',
    'consumer',
  ]);
  if (
    configuration.version !== 'drive-gate-config:1' ||
    configuration.gate !== input.gate ||
    !['owner_id', 'connection_id', 'root_id'].every(
      (key) =>
        typeof configuration[key] === 'string' &&
        identifier.test(configuration[key]),
    ) ||
    configuration.renderer_version !== '1.1' ||
    configuration.report_schema !== '1.1' ||
    !Number.isSafeInteger(configuration.cut_seq) ||
    Number(configuration.cut_seq) < 0 ||
    !Array.isArray(configuration.scope_dates) ||
    configuration.scope_dates.length < 1 ||
    configuration.scope_dates.length > 32 ||
    !configuration.scope_dates.every(
      (date) =>
        typeof date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        Number.isFinite(Date.parse(date)) &&
        new Date(date).toISOString().slice(0, 10) === date,
    )
  )
    throw new Error('INVALID_DRIVE_CONFIGURATION');
  if (input.gate === 'D_EXPORT') {
    if (configuration.consumer !== null)
      throw new Error('INVALID_DRIVE_CONFIGURATION');
  } else {
    if (!record(configuration.consumer))
      throw new Error('INVALID_DRIVE_CONFIGURATION');
    keys(configuration.consumer, ['plan', 'workspace', 'model', 'chat']);
    if (
      !Object.values(configuration.consumer).every(
        (value) =>
          typeof value === 'string' &&
          value.length >= 1 &&
          value.length <= 128 &&
          !/[\r\n]/.test(value),
      )
    )
      throw new Error('INVALID_DRIVE_CONFIGURATION');
  }
  const seen = new Set<string>();
  const rows = input.rows.map((row) => {
    if (!record(row)) throw new Error('INVALID_DRIVE_GATE_ROW');
    keys(row, ['id', 'result', 'evidence']);
    if (
      !(checks as readonly string[]).includes(row.id) ||
      seen.has(row.id) ||
      !['PASS', 'FAIL', 'NOT_RUN', 'UNAVAILABLE'].includes(row.result) ||
      !Array.isArray(row.evidence) ||
      row.evidence.length > 16
    )
      throw new Error('INVALID_DRIVE_GATE_ROW');
    seen.add(row.id);
    if (row.result === 'NOT_RUN') {
      if (row.evidence.length) throw new Error('NOT_RUN_HAS_OBSERVATION');
    } else {
      if (!row.evidence.length) throw new Error('ACTUAL_OBSERVATION_REQUIRED');
      for (const ref of row.evidence) {
        if (!record(ref)) throw new Error('INVALID_DRIVE_EVIDENCE_REFERENCE');
        keys(ref, ['path', 'sha256']);
        if (typeof ref.path !== 'string' || !digest.test(ref.sha256))
          throw new Error('INVALID_DRIVE_EVIDENCE_REFERENCE');
        const bytes = load(ref.path);
        if (bytes.byteLength > 256 * 1024 || evidenceHash(bytes) !== ref.sha256)
          throw new Error('DRIVE_EVIDENCE_HASH_MISMATCH');
        const actual = observation(bytes, input, row.id, now);
        if (actual.result !== row.result)
          throw new Error('DRIVE_OBSERVATION_RESULT_MISMATCH');
        passFacts(actual, input.gate);
      }
    }
    return {
      id: row.id,
      result: row.result,
      evidence_sha256: row.evidence.map((ref) => ref.sha256),
    };
  });
  for (const id of checks)
    if (!seen.has(id))
      rows.push({ id, result: 'NOT_RUN', evidence_sha256: [] });
  const status = rows.some((row) => row.result === 'FAIL')
    ? 'FAIL'
    : rows.some((row) => row.result === 'UNAVAILABLE')
      ? 'UNAVAILABLE'
      : rows.every((row) => row.result === 'PASS')
        ? 'PASS'
        : 'NOT_RUN';
  return {
    version: 'drive-gate-scorecard:1',
    gate: input.gate,
    status,
    configuration_sha256: input.configuration_sha256,
    evaluated_at: now.toISOString(),
    rows,
    performed_provider_requests: false,
    automatic_activation: false,
  };
}
export function loadGateEvidence(directory: string, path: string) {
  if (isAbsolute(path) || !/\.json$/.test(path))
    throw new Error('INVALID_DRIVE_EVIDENCE_PATH');
  const root = realpathSync(resolve(directory)),
    file = realpathSync(resolve(root, path)),
    local = relative(root, file);
  if (
    local === '..' ||
    local.startsWith('..' + sep) ||
    isAbsolute(local) ||
    /(^|[\\/])\./.test(local) ||
    statSync(file).size > 256 * 1024
  )
    throw new Error('INVALID_DRIVE_EVIDENCE_PATH');
  return readFileSync(file);
}
