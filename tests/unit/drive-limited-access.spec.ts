import { expect, it } from 'vitest';
import { DriveClient } from '../../packages/core/src/drive/client.js';
import { encryptCanonicalBackup } from '../../packages/core/src/backup/encryption.js';
const owner = { type: 'user', role: 'owner' };
it('uploads only an encrypted canonical envelope and retains its reserved identity', async () => {
  const backup = '12345678-1234-1234-1234-123456789abc',
    key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  const envelope = await encryptCanonicalBackup(
    new TextEncoder().encode('private source'),
    backup,
    'recovery-v1',
    key,
  );
  let uploads = 0;
  const drive = new DriveClient('fixture-token', async (url, options) => {
    if (String(url).includes('/permissions'))
      return Response.json({ permissions: [owner] });
    uploads++;
    expect(options?.body).not.toContain('private source');
    expect(options?.body).toContain(envelope.ciphertext);
    return Response.json({
      id: 'reserved',
      name: backup + '.bi-backup.json',
      mimeType: 'application/json',
      parents: ['backups'],
    });
  });
  expect(
    (
      await drive.createEncryptedBackup({
        reserved_id: 'reserved',
        root_id: 'backups',
        backup_id: backup,
        envelope_json: JSON.stringify(envelope),
      })
    ).id,
  ).toBe('reserved');
  await expect(
    drive.createEncryptedBackup({
      reserved_id: 'other',
      root_id: 'backups',
      backup_id: backup,
      envelope_json: JSON.stringify({ manifest: 'private canonical' }),
    }),
  ).rejects.toThrow('DRIVE_FORMAT');
  expect(uploads).toBe(1);
});
const client = (permissions: unknown[]) =>
  new DriveClient(
    'fixture-token',
    async () =>
      new Response(JSON.stringify({ permissions }), {
        headers: { 'Content-Type': 'application/json' },
      }),
  );
it('allows only official metadata-only limited-access parent viewers', async () => {
  expect(
    await client([
      owner,
      {
        type: 'user',
        role: 'reader',
        view: 'metadata',
        inheritedPermissionsDisabled: true,
      },
    ]).verifyPrivateFolder('folder'),
  ).toEqual({ private_owner_only: true });
});
it.each([
  { type: 'user', role: 'reader' },
  { type: 'anyone', role: 'reader' },
  { type: 'user', role: 'reader', view: 'metadata' },
  {
    type: 'user',
    role: 'reader',
    view: 'metadata',
    inheritedPermissionsDisabled: false,
  },
  {
    type: 'user',
    role: 'reader',
    view: 'unknown',
    inheritedPermissionsDisabled: true,
  },
])(
  'denies content access or incomplete limited-access marker %j',
  async (permission) => {
    await expect(
      client([owner, permission]).verifyPrivateFolder('folder'),
    ).rejects.toThrow('DRIVE_DENIED');
  },
);
it('creates a nested limited-access folder with the reserved identity', async () => {
  let sent: Record<string, unknown> = {};
  const drive = new DriveClient('fixture-token', async (_url, options) => {
    sent = JSON.parse(String(options?.body));
    return new Response(JSON.stringify({ ...sent, id: 'reserved' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const result = await drive.createFolder({
    reserved_id: 'reserved',
    name: 'Backups',
    parent_id: 'parent',
    limited_access: true,
    app_properties: { bi_role: 'backups' },
  });
  expect(sent.parents).toEqual(['parent']);
  expect(sent.inheritedPermissionsDisabled).toBe(true);
  expect(result.id).toBe('reserved');
});
