import { expect, it } from 'vitest';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { materializeCorrectedSource } from '../../packages/core/src/transcript/corrected-source.js';
const cues = [
  {
    upstream_index: 0,
    start_ms: 900,
    end_ms: 2300,
    text: '😀 Clod works',
    speaker_label: null,
  },
  {
    upstream_index: 1,
    start_ms: 2200,
    end_ms: 5500,
    text: 'Other statement',
    speaker_label: null,
  },
];
async function input() {
  return {
    original_ref: 'original-artifact',
    original_hash: await sha256(cues.map((cue) => cue.text).join('\n')),
    cues,
    precision: 'CUE' as const,
    authored_by: 'owner',
    reason: 'Reviewed ASR spelling',
    patches: [
      {
        source_start: 3,
        source_end: 7,
        old_value: 'Clod',
        new_value: 'Claude',
      },
    ],
  };
}
it('creates a distinct corrected representation while preserving original cues and source timing', async () => {
  const before = structuredClone(cues),
    request = await input();
  const result = await materializeCorrectedSource(request);
  expect(result.kind).toBe('CORRECTED_SOURCE');
  expect(result.original_hash).toBe(request.original_hash);
  expect(result.normalized.source_text).toBe(
    '😀 Claude works\nOther statement',
  );
  expect(result.normalized.manifest.source_text_hash).not.toBe(
    request.original_hash,
  );
  expect(
    result.normalized.manifest.coverage.map((cue) => [
      cue.upstream_index,
      cue.start_ms,
      cue.end_ms,
    ]),
  ).toEqual([
    [0, 900, 2300],
    [1, 2200, 5500],
  ]);
  expect(cues).toEqual(before);
});
it('rejects stale source hashes, overlapping edits, surrogate splits, malformed replacements and cross-cue edits', async () => {
  const request = await input();
  await expect(
    materializeCorrectedSource({ ...request, original_hash: '0'.repeat(64) }),
  ).rejects.toThrow('INVALID_SOURCE_CORRECTION');
  for (const patches of [
    [...request.patches, ...request.patches],
    [{ source_start: 0, source_end: 1, old_value: '\uD83D', new_value: 'X' }],
    [{ ...request.patches[0]!, new_value: '\uD800' }],
    [{ ...request.patches[0]!, new_value: 'new\ncue' }],
    [{ ...request.patches[0]!, old_value: 'wrong' }],
  ])
    await expect(
      materializeCorrectedSource({ ...request, patches }),
    ).rejects.toThrow('INVALID_SOURCE_CORRECTION_PATCH');
  await expect(
    materializeCorrectedSource({
      ...request,
      patches: [
        {
          source_start: 10,
          source_end: 16,
          old_value: 'rks\nOt',
          new_value: 'Edited',
        },
      ],
    }),
  ).rejects.toThrow('SOURCE_CORRECTION_CROSSES_CUE');
});
