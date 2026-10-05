import { describe, expect, it } from 'vitest';
import {
  admitD1AnalyticsRead,
  admitMetadataRead,
  D1_ACCOUNT_DAILY_USAGE_QUERY,
} from '../../tools/gates/metadata-admission.js';

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
  it('admits bounded public YouTube discovery and metadata lookup', () => {
    const discovery = new URL('https://www.googleapis.com/youtube/v3/search');
    discovery.search = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      q: 'long form educational lecture English',
      maxResults: '50',
      order: 'relevance',
      key: 'redacted-test-key',
    }).toString();
    expect(admitMetadataRead(discovery.toString(), account, false)).toEqual({
      method: 'GET',
      redirect: 'error',
    });
    const details = new URL('https://www.googleapis.com/youtube/v3/videos');
    details.search = new URLSearchParams({
      part: 'snippet,contentDetails,status',
      id: 'abcdefghijk,lmnopqrstuv',
      key: 'redacted-test-key',
    }).toString();
    expect(admitMetadataRead(details.toString(), account, false)).toEqual({
      method: 'GET',
      redirect: 'error',
    });
  });
  it.each([
    `https://api.cloudflare.com/client/v4/accounts/${'b'.repeat(32)}/queues`,
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/new`,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    'https://www.googleapis.com/youtube/v3/videos?key=secret',
    'https://www.googleapis.com/youtube/v3/videos?part=snippet%2CcontentDetails%2Cstatus&id=bad&key=secret',
    'https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=test&maxResults=500&key=secret',
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

  it('admits only the bounded account-scoped D1 daily usage query', () => {
    const date = new Date().toISOString().slice(0, 10);
    expect(
      admitD1AnalyticsRead(
        'https://api.cloudflare.com/client/v4/graphql',
        account,
        {
          query: D1_ACCOUNT_DAILY_USAGE_QUERY,
          variables: { accountTag: account, start: date, end: date },
        },
        false,
      ),
    ).toEqual({ method: 'POST', redirect: 'error' });
    expect(() =>
      admitD1AnalyticsRead(
        'https://api.cloudflare.com/client/v4/graphql',
        account,
        { query: 'mutation { deleteEverything }' },
        false,
      ),
    ).toThrow('METADATA_QUERY_DENIED');
  });
});
