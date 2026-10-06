import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
  existsSync,
} from 'node:fs';
import { resolve } from 'node:path';
export const contentHash = (raw: string) =>
  createHash('sha256').update(raw).digest('hex');
interface RecordEnvelope {
  version: 'capacity-evidence:1';
  sequence: number;
  previous_hash: string | null;
  config_hash: string;
  sampled_at: string;
  kind: 'START' | 'OBSERVATION';
  payload: unknown;
}
export function readCapacityEvidence(directory: string) {
  mkdirSync(directory, { recursive: true });
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const records: { hash: string; record: RecordEnvelope }[] = [];
  for (const name of names) {
    const match = /^(\d{8})-([a-f0-9]{64})\.json$/.exec(name);
    if (!match) throw new Error('INVALID_CAPACITY_EVIDENCE_FILE');
    const raw = readFileSync(resolve(directory, name), 'utf8');
    if (contentHash(raw) !== match[2])
      throw new Error('CAPACITY_EVIDENCE_HASH_MISMATCH');
    const record = JSON.parse(raw) as RecordEnvelope;
    if (
      record.version !== 'capacity-evidence:1' ||
      record.sequence !== records.length + 1 ||
      Number(match[1]) !== record.sequence ||
      record.previous_hash !== (records.at(-1)?.hash ?? null) ||
      !/^[a-f0-9]{64}$/.test(record.config_hash)
    )
      throw new Error('CAPACITY_EVIDENCE_CHAIN_MISMATCH');
    if (
      record.kind !== (records.length ? 'OBSERVATION' : 'START') ||
      !Number.isFinite(Date.parse(record.sampled_at))
    )
      throw new Error('INVALID_CAPACITY_EVIDENCE');
    if (records.length && record.config_hash !== records[0]!.record.config_hash)
      throw new Error('CAPACITY_EVIDENCE_CONFIG_CHANGED');
    records.push({ hash: match[2]!, record });
  }
  return records;
}
export function appendCapacityEvidence(
  directory: string,
  input: Omit<RecordEnvelope, 'version' | 'sequence' | 'previous_hash'>,
) {
  const lock = resolve(directory, 'writer.lock');
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(lock, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1)
      throw new Error('CAPACITY_LOCK_INVALID');
    try {
      process.kill(pid, 0);
      throw new Error('CAPACITY_COLLECTOR_BUSY');
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code !== 'ESRCH')
        throw new Error('CAPACITY_COLLECTOR_BUSY');
      unlinkSync(lock);
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
    }
  }
  try {
    const previous = readCapacityEvidence(directory);
    if (
      previous.length &&
      input.config_hash !== previous[0]!.record.config_hash
    )
      throw new Error('CAPACITY_EVIDENCE_CONFIG_CHANGED');
    if (
      !/^[a-f0-9]{64}$/.test(input.config_hash) ||
      !Number.isFinite(Date.parse(input.sampled_at))
    )
      throw new Error('INVALID_CAPACITY_EVIDENCE');
    if (!previous.length && input.kind !== 'START')
      throw new Error('CAPACITY_START_REQUIRED');
    if (previous.length && input.kind === 'START')
      throw new Error('CAPACITY_ALREADY_STARTED');
    const record: RecordEnvelope = {
      ...input,
      version: 'capacity-evidence:1',
      sequence: previous.length + 1,
      previous_hash: previous.at(-1)?.hash ?? null,
    };
    const raw = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(raw) > 16 * 1024 * 1024)
      throw new Error('CAPACITY_EVIDENCE_TOO_LARGE');
    const hash = contentHash(raw),
      name = String(record.sequence).padStart(8, '0') + '-' + hash + '.json';
    const target = resolve(directory, name),
      pending = target + '.pending';
    if (existsSync(target)) throw new Error('CAPACITY_EVIDENCE_ALREADY_EXISTS');
    const descriptor = openSync(pending, 'wx');
    try {
      writeFileSync(descriptor, raw);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(pending, target);
    return { hash, sequence: record.sequence };
  } finally {
    unlinkSync(lock);
  }
}
