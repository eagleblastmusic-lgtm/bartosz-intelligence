import { strictJson } from './strict-json.js';
import { sha256 } from '../../auth/crypto.js';
export async function parseWithDeterministicRepair(raw: string) {
  const rawHash = await sha256(raw),
    applied: string[] = [],
    changes: {
      rule: string;
      removed_bytes: number;
      // UTF-16 offsets in the original raw candidate, not in a prior repair.
      removed_spans: { start: number; end: number }[];
    }[] = [];
  try {
    return {
      value: strictJson(raw),
      candidate: raw,
      report: {
        raw_hash: rawHash,
        candidate_hash: rawHash,
        applied,
        changes,
        result: 'STRICT_PASS',
      },
    };
  } catch (error) {
    if (
      error instanceof Error &&
      [
        'DUPLICATE_JSON_KEY',
        'JSON_TOO_LARGE',
        'JSON_COMPLEXITY_LIMIT',
      ].includes(error.message)
    )
      throw error;
  }
  let candidate = raw;
  let rawStart = 0;
  const change = (rule: string, next: string) => {
    if (next !== candidate) {
      const start = candidate.indexOf(next);
      if (start < 0) throw new Error('NON_OUTER_REPAIR');
      const end = start + next.length;
      const spans = [];
      if (start) spans.push({ start: rawStart, end: rawStart + start });
      if (end < candidate.length)
        spans.push({ start: rawStart + end, end: rawStart + candidate.length });
      applied.push(rule);
      changes.push({
        rule,
        removed_bytes:
          new TextEncoder().encode(candidate).length -
          new TextEncoder().encode(next).length,
        removed_spans: spans,
      });
      rawStart += start;
      candidate = next;
    }
  };
  if (candidate.startsWith('\uFEFF')) change('DR1', candidate.slice(1));
  change('DR2', candidate.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ''));
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(candidate);
  if (fence) change('DR3', fence[1]!);
  const prefix =
    /^(?:JSON:|Oto JSON:|Here is the JSON:)[ \t]*\r?\n([\s\S]*)$/.exec(
      candidate,
    );
  if (prefix) change('DR4', prefix[1]!);
  change('DR2', candidate.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ''));
  const parsed = strictJson(candidate);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('INVALID_ANALYSIS_ROOT');
  return {
    value: parsed,
    candidate,
    report: {
      raw_hash: rawHash,
      candidate_hash: await sha256(candidate),
      applied: [...new Set(applied)],
      changes,
      result: 'DETERMINISTIC_PASS',
    },
  };
}
