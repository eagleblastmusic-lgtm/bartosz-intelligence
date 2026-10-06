import { expect, it } from 'vitest';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  appendCapacityEvidence,
  readCapacityEvidence,
} from '../../tools/gates/capacity/store.js';
const config_hash = 'a'.repeat(64),
  sampled_at = '2026-10-06T12:00:00.000Z';
function directory() {
  const path = resolve('.local/tests/capacity-' + randomUUID());
  mkdirSync(path, { recursive: true });
  return path;
}
function clean(path: string) {
  for (const name of readdirSync(path)) unlinkSync(resolve(path, name));
  rmdirSync(path);
}
it('writes immutable hashed samples, resumes the same configuration and rejects missing starts/config changes', () => {
  const dir = directory();
  try {
    expect(() =>
      appendCapacityEvidence(dir, {
        config_hash,
        sampled_at,
        kind: 'OBSERVATION',
        payload: {},
      }),
    ).toThrow('CAPACITY_START_REQUIRED');
    const start = appendCapacityEvidence(dir, {
      config_hash,
      sampled_at,
      kind: 'START',
      payload: { paid_services_enabled: false },
    });
    const before = readFileSync(resolve(dir, readdirSync(dir)[0]!), 'utf8');
    const next = appendCapacityEvidence(dir, {
      config_hash,
      sampled_at,
      kind: 'OBSERVATION',
      payload: { status: 'PARTIAL', unknown_eligibility: 2 },
    });
    const records = readCapacityEvidence(dir);
    expect(records).toHaveLength(2);
    expect(records[1]!.record.previous_hash).toBe(start.hash);
    expect(next.sequence).toBe(2);
    expect(
      readFileSync(resolve(dir, readdirSync(dir).sort()[0]!), 'utf8'),
    ).toBe(before);
    expect(() =>
      appendCapacityEvidence(dir, {
        config_hash: 'b'.repeat(64),
        sampled_at,
        kind: 'OBSERVATION',
        payload: {},
      }),
    ).toThrow('CAPACITY_EVIDENCE_CONFIG_CHANGED');
    expect(() =>
      appendCapacityEvidence(dir, {
        config_hash,
        sampled_at,
        kind: 'START',
        payload: {},
      }),
    ).toThrow('CAPACITY_ALREADY_STARTED');
  } finally {
    clean(dir);
  }
});
it('retains interrupted uncommitted bytes but never treats them as complete evidence; detects tampering without overwriting history', () => {
  const dir = directory();
  try {
    writeFileSync(resolve(dir, 'interrupted.pending'), 'partial data');
    appendCapacityEvidence(dir, {
      config_hash,
      sampled_at,
      kind: 'START',
      payload: {},
    });
    expect(readCapacityEvidence(dir)).toHaveLength(1);
    expect(readFileSync(resolve(dir, 'interrupted.pending'), 'utf8')).toBe(
      'partial data',
    );
    const name = readdirSync(dir).find((name) => name.endsWith('.json'))!;
    writeFileSync(resolve(dir, name), 'modified test fixture');
    expect(() => readCapacityEvidence(dir)).toThrow(
      'CAPACITY_EVIDENCE_HASH_MISMATCH',
    );
    expect(() =>
      appendCapacityEvidence(dir, {
        config_hash,
        sampled_at,
        kind: 'OBSERVATION',
        payload: {},
      }),
    ).toThrow('CAPACITY_EVIDENCE_HASH_MISMATCH');
    expect(readFileSync(resolve(dir, name), 'utf8')).toBe(
      'modified test fixture',
    );
  } finally {
    clean(dir);
  }
});
it('prevents concurrent writers and rejects malformed abandoned locks', () => {
  const dir = directory();
  try {
    writeFileSync(resolve(dir, 'writer.lock'), String(process.pid));
    expect(() =>
      appendCapacityEvidence(dir, {
        config_hash,
        sampled_at,
        kind: 'START',
        payload: {},
      }),
    ).toThrow('CAPACITY_COLLECTOR_BUSY');
    writeFileSync(resolve(dir, 'writer.lock'), 'not-a-pid');
    expect(() =>
      appendCapacityEvidence(dir, {
        config_hash,
        sampled_at,
        kind: 'START',
        payload: {},
      }),
    ).toThrow('CAPACITY_LOCK_INVALID');
  } finally {
    clean(dir);
  }
});
