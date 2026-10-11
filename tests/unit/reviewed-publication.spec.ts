import { expect, it } from 'vitest';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { DriveClient } from '../../packages/core/src/drive/client.js';
import { publishReviewedMarkdown } from '../../packages/core/src/export/reviewed-publication.js';

async function fixture(
  options: {
    loss?: boolean;
    badHash?: boolean;
    conflict?: boolean;
    attempted?: boolean;
    shared?: boolean;
  } = {},
) {
  const markdown = '# Zaakceptowana rewizja redakcyjna\nŻółć.\n',
    hash = await sha256(markdown),
    revision = 'a'.repeat(64);
  let exists = false,
    gets = 0,
    creates = 0,
    intent = false;
  const client = new DriveClient('synthetic', async (url, init) => {
    const target = String(url);
    if (target.includes('/permissions?'))
      return Response.json({
        permissions: options.shared
          ? [{ type: 'anyone', role: 'reader' }]
          : [{ type: 'user', role: 'owner' }],
      });
    if (target.includes('upload/')) {
      expect(intent).toBe(true);
      expect(init?.body).toContain(markdown);
      creates++;
      exists = true;
      if (options.loss) throw new Error('Lost success');
    } else if (target.endsWith('?alt=media'))
      return new Response(options.badHash ? markdown + 'changed' : markdown);
    else {
      gets++;
      if (!exists) return new Response(null, { status: 404 });
    }
    return Response.json({
      id: 'fixed',
      name: 'review.md',
      mimeType: 'text/markdown',
      parents: ['daily'],
      trashed: false,
      version: options.conflict && gets > 2 ? '3' : '2',
      appProperties: {
        bi_kind: 'owner_reviewed_summary',
        bi_revision: revision,
        bi_decision: 'owner-decision',
        bi_content_hash: hash,
      },
    });
  });
  const input = {
    file_id: 'fixed',
    root_id: 'daily',
    name: 'review.md',
    markdown,
    content_hash: hash,
    revision_hash: revision,
    decision_reference: 'owner-decision',
    create_attempted: options.attempted ?? false,
    before_create: async () => {
      intent = true;
    },
  };
  return { client, input, creates: () => creates };
}
it('persists intent before one create, verifies all bytes/metadata/private ACL, and resumes with zero writes', async () => {
  const f = await fixture();
  const result = await publishReviewedMarkdown(f.client, f.input);
  expect(result).toMatchObject({
    state: 'VERIFIED',
    file_version: '2',
    model_qualification: false,
    original_run_promoted: false,
  });
  expect(f.creates()).toBe(1);
  expect(
    await publishReviewedMarkdown(f.client, {
      ...f.input,
      create_attempted: true,
    }),
  ).toMatchObject({ state: 'VERIFIED', created: false });
  expect(f.creates()).toBe(1);
});
it('recovers a lost create response by the same ID without a second POST', async () => {
  const f = await fixture({ loss: true });
  expect(await publishReviewedMarkdown(f.client, f.input)).toMatchObject({
    state: 'VERIFIED',
    created: false,
  });
  expect(f.creates()).toBe(1);
});
it.each([{ badHash: true }, { conflict: true }])(
  'rejects a changed remote body/version without updating it: %j',
  async (options) => {
    const f = await fixture(options);
    await expect(publishReviewedMarkdown(f.client, f.input)).rejects.toThrow(
      'OWNER_PUBLICATION_READBACK_MISMATCH',
    );
    expect(f.creates()).toBe(1);
  },
);
it('keeps an ambiguous absent create pending and refuses another create', async () => {
  const f = await fixture({ attempted: true });
  await expect(publishReviewedMarkdown(f.client, f.input)).rejects.toThrow(
    'OWNER_PUBLICATION_CREATE_UNRESOLVED',
  );
  expect(f.creates()).toBe(0);
});
it('refuses publication into shared destination or with a wrong local hash before any write', async () => {
  const shared = await fixture({ shared: true });
  await expect(
    publishReviewedMarkdown(shared.client, shared.input),
  ).rejects.toThrow('DRIVE_DENIED');
  expect(shared.creates()).toBe(0);
  const f = await fixture();
  await expect(
    publishReviewedMarkdown(f.client, {
      ...f.input,
      content_hash: 'b'.repeat(64),
    }),
  ).rejects.toThrow('OWNER_PUBLICATION_PIN_MISMATCH');
  expect(f.creates()).toBe(0);
});
