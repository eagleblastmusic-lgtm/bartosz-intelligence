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
    /^[a-f0-9]{32}$/i.test(account ?? '') &&
    target.origin === 'https://api.cloudflare.com' &&
    !target.search &&
    paths.some(
      (path) => target.pathname === `/client/v4/accounts/${account}/${path}`,
    );
  const youtube =
    url ===
    'https://www.googleapis.com/youtube/v3/videos?part=id&id=TyGkMeECZJA';
  if (!cloudflare && !youtube) throw new Error('METADATA_TARGET_DENIED');
  return { method: 'GET' as const, redirect: 'error' as const };
}
