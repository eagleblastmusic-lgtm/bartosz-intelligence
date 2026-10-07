import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import {
  LabReviews,
  type LabHumanReview,
} from '../../packages/core/src/registry/lab-reviews.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { RunRepository } from '../../packages/core/src/jobs/acceptance.js';
import { finalizeCandidateRun } from '../../packages/core/src/ai/candidate-finalization.js';
import apiWorker from '../../apps/api/src/index.js';
import { createExecutionContext } from 'cloudflare:test';
import { issueSession } from '../../packages/core/src/auth/session.js';
import { fixtureSecret } from './core-fixture.js';
import application from '../../config/application.json';
beforeEach(resetCore);
async function fixture() {
  const owner = await fixtureOwner(),
    hash = 'a'.repeat(64),
    reviewer = new LabReviews(env.DB, owner),
    credential = await sha256('fixture-review-worker');
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'review-worker',
      'a',
      credential,
      '["TRANSLATE"]',
      fixtureNow.toISOString(),
    )
    .run();
  const worker = await AccessContext.worker(env.DB, credential),
    store = new JobStore(env.DB, worker);
  const planSnapshot = {
    source_hash: 'b'.repeat(64),
    segments: [
      {
        text: 'Source <script>literal</script>',
        source_segment_id: 's1',
        start_ms: 1000,
        end_ms: 2000,
      },
    ],
  };
  const snapshot = {
    version: 'optional-ai-job:1',
    task: 'TRANSLATE',
    workload: 'PROMPT_LAB',
    lab_experiment_hash: hash,
    lab_case_index: 0,
    profile: { provider_id: 'gemini', model: 'fixture-model' },
    prompt: { prompt_hash: 'c'.repeat(64) },
    settings: { mode: 'QUALITY_TEST' },
    plan: {
      snapshot: planSnapshot,
      hash: await sha256(JSON.stringify(planSnapshot)),
    },
  };
  const job = (await new JobStore(env.DB, owner).enqueue(
    {
      item_id: null,
      source_id: null,
      task_type: 'TRANSLATE',
      input_revision: 'fixture',
      profile_revision: 'fixture',
      prompt_snapshot_id: null,
      routing_policy_version: 'fixture',
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: 'fixture-review',
      arrival_origin_at: fixtureNow.toISOString(),
      origin_kind: 'MANUAL',
      payload: { snapshot },
      priority: 20,
      due_at: fixtureNow.toISOString(),
    },
    fixtureNow.toISOString(),
  ))!;
  const token = (await store.lease(
    job.job_id,
    'TRANSLATE',
    fixtureNow,
    'local',
  ))!;
  await store.start(token, 'TRANSLATE', fixtureNow);
  await new RunRepository(env.DB, worker).prepare(
    'fixture-review-run',
    job.job_id,
    fixtureNow.toISOString(),
  );
  const canonical = {
    translated_segments: [
      {
        source_segment_id: 's1',
        text_pl: 'Tekst <img src=x> ' + 'x'.repeat(20000),
      },
    ],
  };
  await finalizeCandidateRun(
    env.DB,
    worker,
    token,
    'fixture-review-run',
    {
      version: 'optional-candidate:1',
      mapped: {
        canonical,
        canonical_hash: await sha256(JSON.stringify(canonical)),
      },
    },
    'QUALITY_TEST_COMPLETE',
    fixtureNow,
    'TRANSLATE',
  );
  const review: LabHumanReview = {
    reviewer_id: 'FIXTURE_A',
    role: 'PRIMARY',
    blind_label: 'sample-17',
    scores: [null, null, null, null],
    supported: null,
    important_claims_complete: null,
    evidence_valid: null,
    critical_errors: null,
    notes: 'Synthetic persistence test, no human quality evidence.',
  };
  return { owner, hash, reviewer, review };
}
it('inspects exact frozen source and paged candidate text without accepting or inventing semantic approval', async () => {
  const s = await fixture(),
    first = await s.reviewer.inspect(s.hash, 'fixture-review-run');
  expect(first).toMatchObject({
    section: 'CANONICAL',
    offset: 0,
    end: 16384,
    next_offset: 16384,
    semantic_verification: 'NOT_ASSERTED',
    selection_effect: 'NONE',
  });
  const second = await s.reviewer.inspect(
    s.hash,
    'fixture-review-run',
    'CANONICAL',
    16384,
  );
  expect(second.next_offset).toBeNull();
  expect(first.text + second.text).toContain('<img src=x>');
  const source = await s.reviewer.inspect(
    s.hash,
    'fixture-review-run',
    'SOURCE',
  );
  expect(source.text).toContain('Source <script>literal</script>');
  await expect(
    new LabReviews(env.DB, await fixtureOwner('b')).inspect(
      s.hash,
      'fixture-review-run',
    ),
  ).rejects.toThrow('NOT_FOUND');
  await expect(
    s.reviewer.inspect('b'.repeat(64), 'fixture-review-run'),
  ).rejects.toThrow('NOT_FOUND');
  await expect(
    s.reviewer.inspect(s.hash, 'fixture-review-run', 'CANONICAL', -1),
  ).rejects.toThrow('INVALID_LAB_INSPECTION');
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM analysis_runs WHERE state='ACCEPTED'",
    ).first('n'),
  ).toBe(0);
});
it('stores null labels, reviewer disagreements and immutable revisions with retry and CAS', async () => {
  const s = await fixture();
  const saved = await s.reviewer.record(
    s.hash,
    'fixture-review-run',
    s.review,
    0,
    fixtureNow,
  );
  expect(saved.quality_approval).toBe('NOT_GRANTED');
  expect(
    await s.reviewer.record(
      s.hash,
      'fixture-review-run',
      s.review,
      0,
      new Date(fixtureNow.getTime() + 1000),
    ),
  ).toEqual(saved);
  await s.reviewer.record(
    s.hash,
    'fixture-review-run',
    {
      ...s.review,
      reviewer_id: 'FIXTURE_B',
      role: 'INDEPENDENT',
      scores: [4, 4, 4, 4],
      critical_errors: ['NEGATION_CHANGED'],
    },
    0,
    fixtureNow,
  );
  await s.reviewer.record(
    s.hash,
    'fixture-review-run',
    { ...s.review, notes: 'Second immutable revision' },
    1,
    fixtureNow,
  );
  await expect(
    s.reviewer.record(
      s.hash,
      'fixture-review-run',
      { ...s.review, notes: 'Stale write' },
      1,
      fixtureNow,
    ),
  ).rejects.toThrow('REVISION_CONFLICT');
  const history = await s.reviewer.history(s.hash, 'fixture-review-run');
  expect(history.reviews).toHaveLength(3);
  expect(history.quality_approval).toBe('NOT_GRANTED');
  expect(
    history.reviews.some((r) =>
      r.review.critical_errors?.includes('NEGATION_CHANGED'),
    ),
  ).toBe(true);
  expect(
    history.reviews.some((r) =>
      r.review.scores.every((value) => value === null),
    ),
  ).toBe(true);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM audit_events WHERE event_type='LAB_HUMAN_REVIEW_RECORDED'",
    ).first('n'),
  ).toBe(3);
  await expect(
    s.reviewer.record(
      s.hash,
      'fixture-review-run',
      { ...s.review, role: 'INDEPENDENT' },
      2,
      fixtureNow,
    ),
  ).rejects.toThrow('INVALID_LAB_REVIEW_ROLE');
});
it('owner HTTP inspection/review endpoints enforce isolation, strict query fields and CSRF', async () => {
  const s = await fixture(),
    session = await issueSession(
      env.DB,
      { issuer: 'https://accounts.google.com', subject: 'subject-a' },
      fixtureSecret,
      new Date(),
    );
  const headers = {
    Cookie: session.cookie.split(';')[0]!,
    Origin: application.app_origin,
    'X-CSRF-Token': session.csrf,
    'Content-Type': 'application/json',
  };
  const path =
    '/api/v1/prompts/lab/experiments/' + s.hash + '/runs/fixture-review-run';
  const request = (
    suffix: string,
    input?: unknown,
    auth: Record<string, string> = headers,
  ) =>
    apiWorker.fetch(
      new Request(application.app_origin + path + suffix, {
        method: input === undefined ? 'GET' : 'POST',
        headers: auth,
        body: input === undefined ? undefined : JSON.stringify(input),
      }),
      {
        ...env,
        SESSION_SIGNING_SECRET: fixtureSecret,
        GOOGLE_OIDC_CLIENT_ID: 'fixture-client',
        GOOGLE_OIDC_CLIENT_SECRET: 'fixture-secret',
        GOOGLE_OIDC_OWNER_SUBJECT: 'subject-a',
      },
      createExecutionContext(),
    );
  expect((await request('/inspect', undefined, {})).status).toBe(401);
  expect((await request('/inspect?unexpected=1')).status).toBe(422);
  expect((await request('/inspect?section=SOURCE&offset=-1')).status).toBe(422);
  const view = await request('/inspect');
  expect(view.status).toBe(200);
  expect(await view.json()).toMatchObject({
    run_id: 'fixture-review-run',
    semantic_verification: 'NOT_ASSERTED',
    selection_effect: 'NONE',
  });
  const noCsrf: Record<string, string> = { ...headers };
  delete noCsrf['X-CSRF-Token'];
  expect(
    (
      await request(
        '/reviews',
        { review: s.review, expected_revision: 0 },
        noCsrf,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request('/reviews', {
        review: s.review,
        expected_revision: 0,
        provider_approved: true,
      })
    ).status,
  ).toBe(422);
  const saved = await request('/reviews', {
    review: s.review,
    expected_revision: 0,
  });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({
    revision: 1,
    quality_approval: 'NOT_GRANTED',
  });
  const history = await request('/reviews');
  expect(await history.json()).toMatchObject({
    reviews: [{ revision: 1, review: { scores: [null, null, null, null] } }],
    quality_approval: 'NOT_GRANTED',
  });
});
it('rejects invalid scores, inferred missing labels and exposed variant labels', async () => {
  const s = await fixture();
  await expect(
    s.reviewer.record(
      s.hash,
      'fixture-review-run',
      { ...s.review, scores: [5, 4, 4, 4] },
      0,
      fixtureNow,
    ),
  ).rejects.toThrow('INVALID_LAB_HUMAN_REVIEW');
  await expect(
    s.reviewer.record(
      s.hash,
      'fixture-review-run',
      { ...s.review, blind_label: 'A' },
      0,
      fixtureNow,
    ),
  ).rejects.toThrow('INVALID_LAB_HUMAN_REVIEW');
  await expect(
    s.reviewer.record(
      s.hash,
      'fixture-review-run',
      { ...s.review, supported: undefined as unknown as null },
      0,
      fixtureNow,
    ),
  ).rejects.toThrow('INVALID_LAB_HUMAN_REVIEW');
  expect(
    (await s.reviewer.history(s.hash, 'fixture-review-run')).reviews,
  ).toEqual([]);
});
