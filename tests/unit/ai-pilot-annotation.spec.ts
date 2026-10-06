import { it, expect } from 'vitest';
import { renderAnnotationSheet } from '../../tools/gates/ai-pilot-annotation.js';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
it('renders exact source as inert data and preserves source offsets and unknown time', async () => {
  const text = '</script><script>steal()</script> \uFEFF literal & <tag> 🚀';
  const normalized = await normalizeTranscript(
    await sha256(text),
    [
      {
        upstream_index: 0,
        text,
        start_ms: null,
        end_ms: null,
        speaker_label: null,
      },
    ],
    'NONE',
  );
  const input = {
    video_id: 'fixture0001',
    source_text: text,
    manifest: normalized.manifest,
    manifest_hash: await sha256(JSON.stringify(normalized.manifest)),
  };
  const sheet = await renderAnnotationSheet(input);
  const encoded =
    /<script type="application\/json" id="dataset">([^<]*)<\/script>/.exec(
      sheet,
    )![1]!;
  const recovered = JSON.parse(encoded);
  expect(recovered.source_text).toBe(text);
  expect(recovered.source_hash).toBe(await sha256(text));
  expect(recovered.manifest.anchors[0].start_ms).toBeNull();
  expect(sheet).not.toContain('</script><script>steal()');
  await expect(
    renderAnnotationSheet({ ...input, source_text: text + 'changed' }),
  ).rejects.toThrow('INVALID_ANNOTATION_SOURCE');
});
