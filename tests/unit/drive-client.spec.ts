import { expect, it } from 'vitest';
import { DriveClient } from '../../packages/core/src/drive/client.js';
it('reserves one fixed-origin ID and creates exact raw Markdown with the persisted identity and private appProperties', async () => {
  const calls: string[] = [],
    markdown = '# Daily\nŻółć 🧠\nEND_REPORT date=2026-10-07\n';
  const transport: typeof fetch = async (target, init) => {
    calls.push(String(target));
    expect(init?.redirect).toBe('manual');
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer synthetic',
    );
    if (calls.length === 1) return Response.json({ ids: ['reserved-id'] });
    expect(target).toMatch(
      /^https:\/\/www.googleapis.com\/upload\/drive\/v3\/files\?uploadType=multipart/,
    );
    expect(init?.method).toBe('POST');
    expect(init?.body).toContain(markdown);
    expect(init?.body).toContain('"id":"reserved-id"');
    expect(init?.body).toContain('"parents":["root-id"]');
    expect(init?.body).not.toContain('anyone');
    return Response.json({
      id: 'reserved-id',
      name: '2026-10-07.md',
      mimeType: 'text/markdown',
      parents: ['root-id'],
    });
  };
  const client = new DriveClient('synthetic', transport),
    id = await client.reserveId();
  expect(JSON.stringify(client)).toBe('{}');
  expect(Object.keys(client)).toEqual([]);
  expect(
    await client.createMarkdown({
      reserved_id: id,
      root_id: 'root-id',
      name: '2026-10-07.md',
      markdown,
      app_properties: { bi_day: '2026-10-07', bi_export_key: 'stable-key' },
    }),
  ).toMatchObject({ id });
  expect(calls).toHaveLength(2);
});
it('bounds byte reads and denies redirects or arbitrary locators without leaking private provider body', async () => {
  let calls = 0;
  const redirect = new DriveClient('synthetic', async () => {
    calls++;
    return new Response('private provider message', {
      status: 302,
      headers: { Location: 'https://evil.example' },
    });
  });
  await expect(redirect.getFile('file')).rejects.toMatchObject({
    category: 'TRANSPORT',
    message: 'DRIVE_TRANSPORT',
  });
  await expect(redirect.getFile('../escape?token=x')).rejects.toMatchObject({
    category: 'FORMAT',
  });
  expect(calls).toBe(1);
  const tooLarge = new DriveClient(
    'synthetic',
    async () => new Response('🧠'.repeat(100)),
  );
  await expect(tooLarge.readMarkdown('file', 399)).rejects.toMatchObject({
    category: 'FORMAT',
  });
});
it('classifies quota/auth/transient/conflict independently, performs no hidden retries and refuses unqualified updates before transport', async () => {
  for (const [status, category] of [
    [401, 'AUTH'],
    [404, 'NOT_FOUND'],
    [429, 'QUOTA'],
    [503, 'TRANSIENT'],
    [412, 'CONFLICT'],
  ] as const) {
    let calls = 0;
    const client = new DriveClient('synthetic', async () => {
      calls++;
      return new Response('private details', {
        status,
        headers: { 'Retry-After': '60' },
      });
    });
    await expect(client.getFile('file')).rejects.toMatchObject({
      category,
      retry_after_seconds: 60,
    });
    await expect(client.updateMarkdown()).rejects.toMatchObject({
      category: 'UNQUALIFIED_UPDATE',
    });
    expect(calls).toBe(1);
  }
  const client = new DriveClient('synthetic', async () =>
    Response.json(
      {
        error: {
          errors: [{ reason: 'storageQuotaExceeded' }],
          message: 'private message',
        },
      },
      { status: 403 },
    ),
  );
  await expect(client.storage()).rejects.toMatchObject({ category: 'QUOTA' });
});
it('validates returned file identity and actual storage values; an unlimited/unknown account is not zero capacity', async () => {
  const wrong = new DriveClient('synthetic', async () =>
    Response.json({ id: 'different', name: 'file', mimeType: 'text/markdown' }),
  );
  await expect(wrong.getFile('requested')).rejects.toMatchObject({
    category: 'FORMAT',
  });
  const storage = new DriveClient('synthetic', async () =>
    Response.json({ storageQuota: { usage: '123' } }),
  );
  expect(await storage.storage()).toEqual({
    limit_bytes: null,
    usage_bytes: '123',
  });
});
