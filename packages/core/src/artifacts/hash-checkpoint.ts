import { _SHA256 } from '@noble/hashes/sha2.js';
import { base64url, decode64 } from '../auth/crypto.js';
export interface HashCheckpoint {
  version: 'noble-sha256:2.4.0';
  words: [number, number, number, number, number, number, number, number];
  length: number;
  position: number;
  buffer: string;
}
// Protected state belongs to the pinned implementation. This explicit adapter
// is versioned and roundtrip-tested, never restored from unsigned input.
export class CheckpointSha256 extends _SHA256 {
  snapshot(): HashCheckpoint {
    if (this.finished || this.destroyed)
      throw new Error('HASH_CHECKPOINT_CLOSED');
    return {
      version: 'noble-sha256:2.4.0',
      words: this.get(),
      length: this.length,
      position: this.pos,
      buffer: base64url(this.buffer),
    };
  }
  static restore(value: HashCheckpoint) {
    if (
      value.version !== 'noble-sha256:2.4.0' ||
      value.words.length !== 8 ||
      value.words.some(
        (n) => !Number.isInteger(n) || n < -2147483648 || n > 4294967295,
      ) ||
      !Number.isSafeInteger(value.length) ||
      value.length < 0 ||
      !Number.isSafeInteger(value.position) ||
      value.position < 0 ||
      value.position > 63 ||
      value.length % 64 !== value.position
    )
      throw new Error('INVALID_HASH_CHECKPOINT');
    const buffer = decode64(value.buffer);
    if (buffer.length !== 64) throw new Error('INVALID_HASH_CHECKPOINT');
    const state = new CheckpointSha256();
    state.set(...value.words);
    state.length = value.length;
    state.pos = value.position;
    state.buffer.set(buffer);
    return state;
  }
}
