import type {
  TranscriptSegment,
  TimestampPrecision,
} from '../../../contracts/src/transcript.js';
import { sha256 } from '../auth/crypto.js';
import { normalizeTranscript } from './normalize.js';

export interface SourceCorrectionPatch {
  source_start: number;
  source_end: number;
  old_value: string;
  new_value: string;
}
/** Local materialization only: owner corrections form a new representation,
 * never a replacement for the captured source or its timestamps. */
export async function materializeCorrectedSource(input: {
  original_ref: string;
  original_hash: string;
  cues: readonly TranscriptSegment[];
  precision: TimestampPrecision;
  patches: readonly SourceCorrectionPatch[];
  authored_by: string;
  reason: string;
}) {
  const original = input.cues.map((cue) => cue.text).join('\n');
  if (
    !input.original_ref ||
    !input.authored_by ||
    !input.reason.trim() ||
    input.reason.length > 2000 ||
    !input.patches.length ||
    input.patches.length > 100 ||
    (await sha256(original)) !== input.original_hash
  )
    throw new Error('INVALID_SOURCE_CORRECTION');
  const patches = [...input.patches].sort(
    (a, b) => a.source_start - b.source_start,
  );
  const boundary = (offset: number) =>
    !(
      offset > 0 &&
      offset < original.length &&
      /[\uD800-\uDBFF]/.test(original[offset - 1]!) &&
      /[\uDC00-\uDFFF]/.test(original[offset]!)
    );
  let previousEnd = -1;
  for (const patch of patches) {
    if (
      !Number.isSafeInteger(patch.source_start) ||
      !Number.isSafeInteger(patch.source_end) ||
      patch.source_start < 0 ||
      patch.source_end <= patch.source_start ||
      patch.source_end > original.length ||
      patch.source_start < previousEnd ||
      !boundary(patch.source_start) ||
      !boundary(patch.source_end) ||
      original.slice(patch.source_start, patch.source_end) !==
        patch.old_value ||
      !patch.new_value.trim() ||
      /[\uD800-\uDFFF]/u.test(patch.new_value) ||
      /[\r\n]/.test(patch.new_value) ||
      new TextEncoder().encode(patch.new_value).length > 20000
    )
      throw new Error('INVALID_SOURCE_CORRECTION_PATCH');
    previousEnd = patch.source_end;
  }
  let cursor = 0;
  const used = new Set<SourceCorrectionPatch>();
  const cues = input.cues.map((cue) => {
    const start = cursor,
      end = start + cue.text.length;
    cursor = end + 1;
    let text = cue.text;
    for (const patch of patches
      .filter((patch) => patch.source_start >= start && patch.source_end <= end)
      .reverse()) {
      text =
        text.slice(0, patch.source_start - start) +
        patch.new_value +
        text.slice(patch.source_end - start);
      used.add(patch);
    }
    return { ...cue, text };
  });
  if (used.size !== patches.length)
    throw new Error('SOURCE_CORRECTION_CROSSES_CUE');
  const revision = await sha256(cues.map((cue) => cue.text).join('\n'));
  if (revision === input.original_hash)
    throw new Error('SOURCE_CORRECTION_NO_CHANGE');
  return {
    kind: 'CORRECTED_SOURCE' as const,
    original_ref: input.original_ref,
    original_hash: input.original_hash,
    authored_by: input.authored_by,
    reason: input.reason.trim(),
    patches,
    normalized: await normalizeTranscript(revision, cues, input.precision),
  };
}
