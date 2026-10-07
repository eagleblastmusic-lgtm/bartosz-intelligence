import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import { PromptLab } from '../../packages/core/src/registry/lab-store.js';
import { LabQuotaPolicies } from '../../packages/core/src/registry/lab-quota.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import type { LabControls } from '../../packages/core/src/registry/lab.js';
beforeEach(resetCore);
async function fixture() {
  const owner = await fixtureOwner(),
    lab = new PromptLab(env.DB, owner);
  await new LabQuotaPolicies(env.DB, owner).save(
    {
      version: 'lab-quota:1',
      account_key: 'fixture-account',
      model: 'gemini-3.8-flash',
      daily_requests: 1,
      normal_headroom: { RPM: 1, RPD: 1, INPUT_TPM: 100 },
    },
    0,
    'Protect regular processing',
    fixtureNow,
  );
  const sourceHash = 'a'.repeat(64),
    wireHash = 'b'.repeat(64),
    canonicalHash = 'c'.repeat(64);
  const base = {
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    model_revision: 1,
    prompt_hash: 'd'.repeat(64),
    wire_hash: wireHash,
    canonical_hash: canonicalHash,
    reasoning: 'low',
    max_output_tokens: 128,
    seed: null,
  };
  const controls: LabControls = {
    version: 'lab-controls:1',
    mode: 'PROMPT_AB',
    source_hashes: [sourceHash],
    repeats: 1,
    variants: [
      { ...base, id: 'A' },
      { ...base, id: 'B', prompt_hash: 'e'.repeat(64) },
    ],
    confounders: ['SEED_UNAVAILABLE', 'PROVIDER_NONDETERMINISM'],
  };
  // Fixtures exercise orchestration integrity, never provider qualification.
  const values = controls.variants.map((variant) => ({
    version: 'explicit-analysis-preview:1',
    prepared_at: fixtureNow.toISOString(),
    snapshot: {
      version: 'analysis-job:1',
      source: {
        run_id: 'source-run',
        item_id: 'fixture-item',
        source_hash: sourceHash,
      },
      prompt: {
        prompt_hash: variant.prompt_hash,
        wire: { hash: wireHash },
        canonical: { hash: canonicalHash },
      },
      profile: {
        profile_id: 'gemini_free',
        revision: 1,
        provider_id: 'gemini',
        model: variant.model,
        account_key: 'fixture-account',
        free_eligible: true,
        billing_enabled: false,
      },
      settings: {
        mode: 'QUALITY_TEST',
        runtime: 'local',
        purpose: 'professional_single_owner',
        region: 'PL',
        max_output_tokens: 128,
        limits: {},
      },
      semantic_profile: { profile_id: 'fixture-profile', revision: 1 },
      semantic_context: { title: 'Frozen title' },
    },
  }));
  const store = async (value: unknown) => {
    const serialized = JSON.stringify(value),
      hash = await sha256(serialized);
    await env.DB.prepare(
      'INSERT INTO config_versions VALUES(?,?,1,?,?,?) ON CONFLICT DO NOTHING',
    )
      .bind(
        'analysis-preview-' + hash,
        'a',
        serialized,
        hash,
        fixtureNow.toISOString(),
      )
      .run();
    return { kind: 'ANALYSIS' as const, hash };
  };
  const input = {
    controls,
    pairs: [
      {
        source_hash: sourceHash,
        repeat: 1,
        a: await store(values[0]),
        b: await store(values[1]),
      },
    ],
    reason: 'Controlled synthetic orchestration check',
  };
  return { owner, lab, values, store, input };
}
it('freezes paired receipts, classifies Lab jobs, preserves originals and deduplicates experiment retry', async () => {
  const s = await fixture(),
    created = await s.lab.create(s.input, fixtureNow);
  expect(await s.lab.create(s.input, fixtureNow)).toEqual(created);
  expect((await s.lab.list()).items).toEqual([
    expect.objectContaining({
      experiment_hash: created.experiment_hash,
      source_count: 1,
      case_count: 2,
    }),
  ]);
  expect((await s.lab.list(created.experiment_hash)).items).toEqual([]);
  expect(
    (await new PromptLab(env.DB, await fixtureOwner('b')).list()).items,
  ).toEqual([]);
  await expect(s.lab.list('not-a-cursor')).rejects.toThrow(
    'INVALID_LAB_CURSOR',
  );
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM audit_events WHERE event_type='PROMPT_LAB_CREATED'",
    ).first('n'),
  ).toBe(1);
  for (const trial of created.cases) {
    const raw = await env.DB.prepare(
      'SELECT payload_json FROM config_versions WHERE owner_id=? AND config_id=?',
    )
      .bind('a', 'analysis-preview-' + trial.preview_hash)
      .first<string>('payload_json');
    expect(JSON.parse(raw!).snapshot).toMatchObject({
      workload: 'PROMPT_LAB',
      lab_experiment_hash: created.experiment_hash,
    });
  }
  const original = await env.DB.prepare(
    'SELECT payload_json FROM config_versions WHERE owner_id=? AND config_id=?',
  )
    .bind('a', 'analysis-preview-' + s.input.pairs[0]!.a.hash)
    .first<string>('payload_json');
  expect(JSON.parse(original!).snapshot.workload).toBeUndefined();
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM jobs').first('n')).toBe(
    0,
  );
  await s.lab.cancel(created.experiment_hash, 'Owner cancelled', fixtureNow);
  expect((await s.lab.get(created.experiment_hash)).cancelled).toBe(true);
  await expect(
    s.lab.submit(created.experiment_hash, 0, fixtureNow),
  ).rejects.toThrow('LAB_EXPERIMENT_CANCELLED');
  await expect(
    new PromptLab(env.DB, await fixtureOwner('b')).get(created.experiment_hash),
  ).rejects.toThrow('NOT_FOUND');
});
it('rejects changed semantic context, production receipts, expired input and incomplete pair matrix', async () => {
  const s = await fixture();
  s.values[1]!.snapshot.semantic_context.title = 'Changed between A and B';
  s.input.pairs[0]!.b = await s.store(s.values[1]);
  await expect(s.lab.create(s.input, fixtureNow)).rejects.toThrow(
    'LAB_INPUT_SNAPSHOT_MISMATCH',
  );
  s.values[1]!.snapshot.settings.mode = 'PRODUCTION';
  s.input.pairs[0]!.b = await s.store(s.values[1]);
  await expect(s.lab.create(s.input, fixtureNow)).rejects.toThrow(
    'LAB_PREVIEW_CONTROL_MISMATCH',
  );
  await expect(
    s.lab.create({ ...s.input, pairs: [] }, fixtureNow),
  ).rejects.toThrow('INVALID_LAB_EXPERIMENT');
  await expect(
    s.lab.create(s.input, new Date(fixtureNow.getTime() + 900001)),
  ).rejects.toThrow('LAB_PREVIEW_CONTROL_MISMATCH');
});
