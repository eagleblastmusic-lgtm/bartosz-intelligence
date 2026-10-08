import { sha256 } from '../auth/crypto.js';
import { requireLocalDate } from '../projections/dates.js';
import { requireDriveId } from '../drive/client.js';

export interface DailyRead {
  root_id: string;
  file_id: string;
  date: string;
  version_before: string;
  version_after: string;
  chunks: readonly {
    root_id: string;
    file_id: string;
    version: string;
    offset: number;
    bytes: Uint8Array;
  }[];
}

/** Deterministic full-read contract, never a Scheduled/Voice capability proof. */
export async function verifyDailyRead(input: DailyRead) {
  requireDriveId(input.root_id);
  requireDriveId(input.file_id);
  requireLocalDate(input.date);
  if (
    !input.version_before ||
    input.version_before.length > 128 ||
    input.version_after !== input.version_before
  )
    throw new Error('BRIDGE_MIXED_REVISION');
  if (input.chunks.length < 1 || input.chunks.length > 1024)
    throw new Error('BRIDGE_INCOMPLETE_READ');
  let size = 0;
  for (const chunk of input.chunks) {
    if (
      chunk.root_id !== input.root_id ||
      chunk.file_id !== input.file_id ||
      chunk.version !== input.version_before
    )
      throw new Error('BRIDGE_MIXED_REVISION');
    if (
      !(chunk.bytes instanceof Uint8Array) ||
      chunk.bytes.length < 1 ||
      chunk.bytes.length > 256 * 1024 ||
      chunk.offset !== size
    )
      throw new Error('BRIDGE_INCOMPLETE_READ');
    size += chunk.bytes.length;
    if (size > 8 * 1024 * 1024) throw new Error('BRIDGE_OVERSIZE_READ');
  }
  const bytes = new Uint8Array(size);
  for (const chunk of input.chunks) bytes.set(chunk.bytes, chunk.offset);
  const markdown = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const boundary = markdown.indexOf('\n---\n\n');
  if (!markdown.startsWith('---\n') || boundary < 0)
    throw new Error('BRIDGE_PROTOCOL_INVALID');
  const header: Record<string, string> = {};
  const fields = new Set([
    'report_schema_version',
    'export_mode',
    'renderer_version',
    'date',
    'timezone',
    'revision',
    'source_change_seq',
    'item_count',
    'ready_count',
    'pending_count',
    'blocked_count',
    'failed_count',
    'discovery_coverage',
    'compaction_level',
    'omitted_detail_units',
    'bridge_size_state',
    'body_sha256',
  ]);
  for (const line of markdown.slice(4, boundary).split('\n')) {
    const match = /^([a-z_0-9]+): (.+)$/.exec(line);
    if (!match || !fields.has(match[1]!) || Object.hasOwn(header, match[1]!))
      throw new Error('BRIDGE_PROTOCOL_INVALID');
    header[match[1]!] = match[2]!;
  }
  if (
    Object.keys(header).length !== fields.size ||
    header.report_schema_version !== '"1.1"' ||
    header.renderer_version !== '"daily-renderer:1.1"' ||
    header.date !== input.date ||
    header.timezone !== 'Europe/Warsaw' ||
    !['COMPACT', 'FULL'].includes(header.export_mode!) ||
    !['complete', 'incomplete'].includes(header.discovery_coverage!) ||
    !['WITHIN_ESTIMATE', 'OVERSIZE'].includes(header.bridge_size_state!)
  )
    throw new Error('BRIDGE_PROTOCOL_INVALID');
  const integer = (key: string, minimum = 0) => {
    const value = header[key]!;
    const number = Number(value);
    if (
      !/^(0|[1-9]\d*)$/.test(value) ||
      !Number.isSafeInteger(number) ||
      number < minimum
    )
      throw new Error('BRIDGE_PROTOCOL_INVALID');
    return number;
  };
  const revision = integer('revision', 1),
    count = integer('item_count'),
    ready = integer('ready_count'),
    pending = integer('pending_count');
  integer('source_change_seq');
  integer('omitted_detail_units');
  if (integer('compaction_level') > 3 || count !== ready + pending)
    throw new Error('BRIDGE_COUNT_MISMATCH');
  const footer = `END_REPORT date=${input.date} revision=${revision} item_count=${count} ready_count=${ready} pending_count=${pending}\n`;
  if (!markdown.endsWith(footer)) throw new Error('BRIDGE_INCOMPLETE_READ');
  const body = markdown.slice(boundary + 6, markdown.length - footer.length);
  if ((await sha256(body)) !== header.body_sha256)
    throw new Error('BRIDGE_BODY_HASH_MISMATCH');
  const blocks = [...body.matchAll(/^ITEM ([A-Za-z0-9_-]{1,128})\n/gm)];
  const ids = blocks.map((block) => block[1]!);
  if (ids.length !== count || new Set(ids).size !== count)
    throw new Error('BRIDGE_COUNT_MISMATCH');
  const states: string[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = body.slice(
      blocks[index]!.index,
      blocks[index + 1]?.index ?? body.length,
    );
    const statuses = [
      ...block.matchAll(/^Status: (READY|PENDING|BLOCKED|FAILED|PARTIAL)$/gm),
    ];
    if (statuses.length !== 1) throw new Error('BRIDGE_PROTOCOL_INVALID');
    states.push(statuses[0]![1]!);
  }
  if (
    states.filter((state) => state === 'READY').length !== ready ||
    states.filter((state) => state === 'BLOCKED').length !==
      integer('blocked_count') ||
    states.filter((state) => state === 'FAILED').length !==
      integer('failed_count')
  )
    throw new Error('BRIDGE_COUNT_MISMATCH');
  return {
    protocol: 'daily-full-read:1' as const,
    full_read: 'VERIFIED' as const,
    root_id: input.root_id,
    file_id: input.file_id,
    remote_version: input.version_before,
    date: input.date,
    revision,
    item_ids: ids,
    item_count: count,
    ready_count: ready,
    pending_count: pending,
    partial: pending > 0 || header.discovery_coverage !== 'complete',
    byte_count: size,
    content_hash: await sha256(markdown),
    size_state: header.bridge_size_state,
    bridge_gate: 'NOT_RUN' as const,
    semantic_verification: 'NOT_ASSERTED' as const,
  };
}
