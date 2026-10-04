import { describe, expect, it } from 'vitest';
import { admitMetadataRead } from '../../tools/gates/metadata-admission.js';

const account = 'a'.repeat(32);
describe('account metadata boundary', () => {
  it('allows only read-only discovery on the selected account', () => {
    expect(
      admitMetadataRead(
        `https://api.cloudflare.com/client/v4/accounts/${account}/subscriptions`,
        account,
        false,
      ),
    ).toEqual({ method: 'GET', redirect: 'error' });
  });
  it.each([
    `https://api.cloudflare.com/client/v4/accounts/${'b'.repeat(32)}/queues`,
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/new`,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    'https://www.googleapis.com/youtube/v3/videos?key=secret',
    'https://example.com/',
  ])('rejects other endpoints before transport: %s', (url) => {
    let submissions = 0;
    expect(() => {
      admitMetadataRead(url, account, false);
      submissions++;
    }).toThrow('METADATA_TARGET_DENIED');
    expect(submissions).toBe(0);
  });
  it.each([true, undefined, null])('rejects paid or unknown policy', (paid) => {
    expect(() =>
      admitMetadataRead(
        `https://api.cloudflare.com/client/v4/accounts/${account}/queues`,
        account,
        paid,
      ),
    ).toThrow('METADATA_PAID_POLICY_DENIED');
  });
});
