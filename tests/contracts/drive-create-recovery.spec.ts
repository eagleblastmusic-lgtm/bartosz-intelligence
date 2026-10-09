import { expect, it } from 'vitest';
import { verifyReservedCreateRecovery } from '../../tools/deployment/drive-create-recovery.js';
it('loses the successful create response and recovers exact bytes through a separate client without a second create', async () => {
  const scope = {
    reserved_id: 'reserved',
    root_id: 'root',
    trial_id: 'fixture-trial',
  };
  const methods: string[] = [];
  const report = await verifyReservedCreateRecovery(
    'fixture',
    scope,
    async (url, options) => {
      methods.push(options?.method ?? 'GET');
      if (options?.method === 'POST') return Response.json({ id: 'reserved' });
      if (String(url).includes('alt=media'))
        return new Response(
          '# Bartosz Intelligence recovery verification\n\nfixture-trial\n',
        );
      return Response.json({
        id: 'reserved',
        name: 'fixture.md',
        mimeType: 'text/markdown',
        parents: ['root'],
        trashed: false,
        version: '1',
        appProperties: { bi_recovery_trial: 'fixture-trial' },
      });
    },
  );
  expect(methods).toEqual(['POST', 'GET', 'GET']);
  expect(report).toMatchObject({
    create_attempts: 1,
    same_reserved_identity: true,
    second_create_performed: false,
  });
  expect(report.expected_sha256).toBe(report.independent_readback_sha256);
});
it('does not label a provider rejection or changed remote bytes as recovered', async () => {
  const scope = {
    reserved_id: 'reserved',
    root_id: 'root',
    trial_id: 'fixture-trial',
  };
  await expect(
    verifyReservedCreateRecovery(
      'fixture',
      scope,
      async () => new Response(null, { status: 503 }),
    ),
  ).rejects.toThrow('DRIVE_TRANSIENT');
  await expect(
    verifyReservedCreateRecovery('fixture', scope, async (url, options) => {
      if (options?.method === 'POST') return Response.json({ id: 'reserved' });
      if (String(url).includes('alt=media')) return new Response('changed');
      return Response.json({
        id: 'reserved',
        name: 'fixture.md',
        mimeType: 'text/markdown',
        parents: ['root'],
        trashed: false,
        version: '1',
        appProperties: { bi_recovery_trial: 'fixture-trial' },
      });
    }),
  ).rejects.toThrow('CREATE_PROBE_RECOVERY_MISMATCH');
});
