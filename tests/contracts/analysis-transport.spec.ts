import { it, expect } from 'vitest';
import { executePreparedAnalysis } from '../../apps/executor/src/analysis-transport.js';
import type { AIRequest } from '../../packages/contracts/src/ai.js';
import type { LeaseToken } from '../../packages/contracts/src/jobs.js';
import success from '../fixtures/gemini/interactions-success.json';
import bundle from '../../config/registry/master-bundle.json';
const now = new Date('2026-10-06T09:00:00.000Z');
const token: LeaseToken = {
  job_id: 'job',
  lease_owner: 'local-analysis',
  fencing_token: 2,
  lease_until: '2026-10-06T09:15:00.000Z',
};
const reservation = '12345678-1234-1234-1234-123456789abc';
function request(): AIRequest {
  return {
    request_id: 'request',
    runtime: 'local',
    profile: {
      profile_id: 'gemini_free',
      revision: 1,
      provider_id: 'gemini',
      model: 'gemini-3.8-flash',
      account_key: 'fixture',
      free_eligible: true,
      billing_enabled: false,
      purposes: ['personal'],
      regions: ['PL'],
      task_types: ['ECONOMY'],
      runtimes: ['local'],
      structured_output: true,
      context_tokens: 100000,
      output_tokens: 8192,
      rank: 0,
      quality_approvals: [],
      eligibility_expires_at: '2026-10-07T00:00:00.000Z',
    },
    prompt: 'fixture',
    wire_schema: bundle.schemas.find(
      (s) => s.id === 'urn:bartosz:schema:economy-wire:1.0',
    )!.schema,
    estimated_input_tokens: 100,
    max_output_tokens: 1024,
    deadline: '2026-10-06T09:05:00.000Z',
    quality_scope: 'fixture',
    mode: 'QUALITY_TEST',
    paid_services_enabled: false,
  };
}
it('denied quota and ambiguous submit each prevent provider HTTP without hidden retry', async () => {
  for (const denied of ['analysis/reserve', 'analysis/submit']) {
    const routes: string[] = [];
    let calls = 0,
      retained = 0;
    await expect(
      executePreparedAnalysis({
        request: request(),
        token,
        key: 'fixture-secret',
        clock: () => now,
        rpc: {
          request: async (path) => {
            routes.push(path);
            if (path === denied) throw new Error('denied');
            return { reservation_id: reservation, request_id: 'request' };
          },
        },
        providerTransport: async () => {
          calls++;
          throw new Error('unexpected');
        },
        retain: async () => {
          retained++;
          return {};
        },
      }),
    ).rejects.toThrow('denied');
    expect(calls).toBe(0);
    expect(retained).toBe(0);
    expect(routes).toEqual(
      denied === 'analysis/reserve'
        ? ['analysis/reserve']
        : ['analysis/reserve', 'analysis/submit'],
    );
  }
});
it('retains one response through the existing receipt endpoint after a lost lease, with no accepted effect', async () => {
  const events: string[] = [];
  const result = await executePreparedAnalysis({
    request: request(),
    token,
    key: 'fixture-secret',
    clock: () => now,
    rpc: {
      request: async (path) => {
        events.push(path);
        if (path === 'heartbeat') throw new Error('lost');
        return { reservation_id: reservation, request_id: 'request' };
      },
    },
    providerTransport: async () => {
      events.push('provider-http');
      return new Response(JSON.stringify(success), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
    retain: async (id, original, response) => {
      events.push('durable-candidate-and-usage');
      expect(id).toBe(reservation);
      expect(original).toEqual(token);
      expect(response.usage.total_tokens).toBe(17);
      return {
        request_id: response.request_id,
        diagnostic_only: true,
        artifact_id: 'candidate',
      };
    },
  });
  expect(events).toEqual([
    'analysis/reserve',
    'analysis/submit',
    'provider-http',
    'heartbeat',
    'durable-candidate-and-usage',
  ]);
  expect(result.eligible_for_validation).toBe(false);
  expect(result.diagnostics).toEqual(['STALE_LEASE_RESPONSE']);
});
it('durability failure cannot return a candidate eligible for validation or call the provider again', async () => {
  let calls = 0;
  await expect(
    executePreparedAnalysis({
      request: request(),
      token,
      key: 'fixture-secret',
      clock: () => now,
      rpc: {
        request: async (path) =>
          path === 'heartbeat'
            ? { token }
            : { reservation_id: reservation, request_id: 'request' },
      },
      providerTransport: async () => {
        calls++;
        return new Response(JSON.stringify(success), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
      retain: async () => {
        throw new Error('durability-failure');
      },
    }),
  ).rejects.toThrow('durability-failure');
  expect(calls).toBe(1);
});
