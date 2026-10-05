import { it, expect } from 'vitest';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { CheckpointSha256 } from '../../packages/core/src/artifacts/hash-checkpoint.js';
it('pinned incremental SHA checkpoint roundtrips every buffer boundary without changing digest', async () => {
  for (const cut of [0, 1, 55, 56, 63, 64, 65, 127, 128, 32768]) {
    const text = 'a'.repeat(cut) + '🦋 Unicode tail';
    const bytes = new TextEncoder().encode(text);
    const hash = new CheckpointSha256();
    hash.update(bytes.slice(0, cut));
    const restored = CheckpointSha256.restore(
      JSON.parse(JSON.stringify(hash.snapshot())),
    );
    restored.update(bytes.slice(cut));
    expect(
      Array.from(restored.digest(), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join(''),
    ).toBe(await sha256(text));
  }
  const state = new CheckpointSha256().snapshot();
  expect(() => CheckpointSha256.restore({ ...state, position: 1 })).toThrow(
    'INVALID_HASH_CHECKPOINT',
  );
  expect(() =>
    CheckpointSha256.restore({
      ...state,
      version: 'unknown' as typeof state.version,
    }),
  ).toThrow('INVALID_HASH_CHECKPOINT');
});
