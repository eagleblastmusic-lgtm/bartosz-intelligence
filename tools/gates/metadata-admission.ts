// Account discovery is distinct from provider admission: GET metadata only.
// Unknown billing never grants permission to generate, mutate or deploy.
export function admitMetadataRead(
  url: string,
  account: string | undefined,
  paid: unknown,
) {
  if (paid !== false) throw new Error('METADATA_PAID_POLICY_DENIED');
  const target = new URL(url);
  if (target.username || target.password || target.hash)
    throw new Error('METADATA_TARGET_DENIED');
  const paths = [
    'subscriptions',
    'workers/account-settings',
    'd1/database',
    'queues',
    'workers/scripts',
  ];
  const cloudflare =
    (/^[a-f0-9]{32}$/i.test(account ?? '') &&
      target.origin === 'https://api.cloudflare.com' &&
      !target.search &&
      paths.some(
        (path) => target.pathname === `/client/v4/accounts/${account}/${path}`,
      )) ||
    (/^[a-f0-9]{32}$/i.test(account ?? '') &&
      target.origin === 'https://api.cloudflare.com' &&
      !target.search &&
      new RegExp(
        `^/client/v4/accounts/${account}/d1/database/[a-f0-9-]{36}$`,
        'i',
      ).test(target.pathname));
  const youtubeTarget =
    target.origin === 'https://www.googleapis.com' &&
    target.pathname === '/youtube/v3/videos' &&
    [...target.searchParams.keys()].every((key) =>
      ['part', 'id', 'key', 'fields'].includes(key),
    ) &&
    target.searchParams.get('part') === 'snippet,contentDetails,status' &&
    (!target.searchParams.has('fields') ||
      target.searchParams.get('fields') ===
        'items(id,snippet(channelId,publishedAt,liveBroadcastContent),contentDetails(duration),status(privacyStatus))') &&
    Boolean(target.searchParams.get('id')) &&
    /^[\w-]{11}(,[\w-]{11}){0,49}$/.test(target.searchParams.get('id')!) &&
    Boolean(target.searchParams.get('key'));
  const youtubeSearch =
    target.origin === 'https://www.googleapis.com' &&
    target.pathname === '/youtube/v3/search' &&
    [...target.searchParams.keys()].every((key) =>
      ['part', 'type', 'q', 'maxResults', 'order', 'key'].includes(key),
    ) &&
    target.searchParams.get('part') === 'snippet' &&
    target.searchParams.get('type') === 'video' &&
    Boolean(target.searchParams.get('q')) &&
    target.searchParams.get('maxResults') === '50' &&
    target.searchParams.get('order') === 'relevance' &&
    Boolean(target.searchParams.get('key'));
  const youtube = youtubeTarget || youtubeSearch;
  if (!cloudflare && !youtube) throw new Error('METADATA_TARGET_DENIED');
  return { method: 'GET' as const, redirect: 'error' as const };
}

export const D1_ACCOUNT_DAILY_USAGE_QUERY = `query D1ObservabilitySampleQuery3(
  $accountTag: string!
  $start: Date
  $end: Date
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(
        limit: 10000
        filter: { date_geq: $start, date_leq: $end }
      ) {
        sum {
          rowsRead
          rowsWritten
        }
      }
    }
  }
}`;

export function admitD1AnalyticsRead(
  url: string,
  account: string | undefined,
  query: unknown,
  paid: unknown,
) {
  if (paid !== false) throw new Error('METADATA_PAID_POLICY_DENIED');
  const target = new URL(url);
  if (
    target.origin !== 'https://api.cloudflare.com' ||
    target.pathname !== '/client/v4/graphql' ||
    target.search ||
    target.username ||
    target.password ||
    target.hash ||
    !/^[a-f0-9]{32}$/i.test(account ?? '')
  )
    throw new Error('METADATA_TARGET_DENIED');
  if (
    !query ||
    typeof query !== 'object' ||
    (query as Record<string, unknown>).query !== D1_ACCOUNT_DAILY_USAGE_QUERY ||
    JSON.stringify((query as Record<string, unknown>).variables) !==
      JSON.stringify({
        accountTag: account,
        start: new Date().toISOString().slice(0, 10),
        end: new Date().toISOString().slice(0, 10),
      })
  )
    throw new Error('METADATA_QUERY_DENIED');
  return { method: 'POST' as const, redirect: 'error' as const };
}
