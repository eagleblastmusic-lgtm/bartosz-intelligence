import { expect, it } from 'vitest';
import { DriveClient } from '../../packages/core/src/drive/client.js';
const input = {
  reserved_id: 'probe-id',
  root_id: 'root-id',
  nonce: 'a'.repeat(64),
};
const base = 'Bartosz Intelligence guard probe\n' + input.nonce + '\nBASE\n';
function fixture(
  options: {
    ignoreGuard?: boolean;
    etag?: string | null;
    foreign?: boolean;
    changed?: boolean;
  } = {},
) {
  let body = options.changed ? 'manual change' : base,
    revision = 1;
  const writes: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    expect(target.origin).toBe('https://www.googleapis.com');
    expect(init?.redirect).toBe('manual');
    if (target.pathname.endsWith('/permissions'))
      return Response.json({ permissions: [{ type: 'user', role: 'owner' }] });
    const metadata = () => ({
      id: input.reserved_id,
      name: 'bi-guard-probe.md',
      mimeType: 'text/markdown',
      parents: [input.root_id],
      trashed: false,
      appProperties: {
        bi_guard_probe: options.foreign ? 'foreign' : input.nonce,
      },
    });
    if (init?.method === 'PATCH') {
      expect(target.pathname).toBe('/upload/drive/v3/files/probe-id');
      expect(target.searchParams.get('uploadType')).toBe('media');
      const headers = init.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('text/markdown; charset=UTF-8');
      writes.push(String(init.body));
      if (!options.ignoreGuard && headers['If-Match'] !== '"r' + revision + '"')
        return new Response(null, { status: 412 });
      body = String(init.body);
      revision++;
      return Response.json(metadata());
    }
    if (target.searchParams.get('alt') === 'media') return new Response(body);
    const etag =
      options.etag === undefined ? '"r' + revision + '"' : options.etag;
    return Response.json(metadata(), {
      headers: etag === null ? {} : { ETag: etag },
    });
  };
  return {
    client: new DriveClient('synthetic', transport),
    writes,
    body: () => body,
  };
}
it('checks exact media upload guard with two concurrent writers and a current-guard write without enabling automatic updates', async () => {
  const tested = fixture();
  expect(await tested.client.probeMarkdownGuard(input)).toMatchObject({
    accepted_writers: 1,
    rejected_http_status: 412,
    current_guard_write: 'PASS',
    stable_readback: 'PASS',
    automatic_updates_enabled: false,
  });
  expect(tested.writes).toHaveLength(3);
  expect(tested.body()).toBe(base + 'CURRENT_GUARD\n');
  await expect(tested.client.updateMarkdown()).rejects.toThrow(
    'DRIVE_UNQUALIFIED_UPDATE',
  );
  expect(tested.writes).toHaveLength(3);
});
it('fails qualification when the provider ignores the guard, without retrying either writer', async () => {
  const tested = fixture({ ignoreGuard: true });
  await expect(tested.client.probeMarkdownGuard(input)).rejects.toThrow(
    'DRIVE_UNQUALIFIED_UPDATE',
  );
  expect(tested.writes).toHaveLength(2);
});
it('rejects missing, weak or malformed ETags before any update', async () => {
  for (const etag of [null, 'W/"weak"', 'unquoted', '"unsafe value"']) {
    const tested = fixture({ etag });
    await expect(tested.client.probeMarkdownGuard(input)).rejects.toThrow(
      'DRIVE_UNQUALIFIED_UPDATE',
    );
    expect(tested.writes).toHaveLength(0);
  }
});
it('never updates a foreign Daily identity or an altered canary', async () => {
  for (const options of [{ foreign: true }, { changed: true }]) {
    const tested = fixture(options);
    await expect(tested.client.probeMarkdownGuard(input)).rejects.toThrow(
      options.foreign ? 'DRIVE_DENIED' : 'DRIVE_CONFLICT',
    );
    expect(tested.writes).toHaveLength(0);
  }
});
