import { env } from 'cloudflare:workers';
import { beforeEach, it, expect } from 'vitest';
import { fixtureOwner, fixtureNow, resetCore } from './core-fixture.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { ItemRepository } from '../../packages/core/src/db/items.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { KnowledgeOrganization } from '../../packages/core/src/knowledge/organization.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
beforeEach(resetCore);
async function setup() {
  const owner = await fixtureOwner(),
    at = fixtureNow.toISOString();
  const source = (await new SourceRepository(env.DB, owner).upsert(
    {
      namespace: 'youtube',
      external_id: 'UC-fixture',
      canonical_locator: 'https://www.youtube.com/channel/fixture',
      title: 'Fixture',
      uploads_playlist_id: 'UU-fixture',
      handle: null,
    },
    at,
  ))!;
  const item = (await new ItemRepository(env.DB, owner).upsert(
    source.source_id,
    {
      namespace: 'youtube',
      external_id: 'abcdefghijk',
      canonical_url: 'https://www.youtube.com/watch?v=abcdefghijk',
      title: 'Fixture',
      item_type: 'video',
      published_at: null,
      publication_provenance: 'unknown',
      availability: 'PUBLIC',
      duration_seconds: 60,
    },
    at,
  ))!;
  const job = (await new JobStore(env.DB, owner).enqueue(
    {
      item_id: item.item_id,
      source_id: source.source_id,
      task_type: 'ANALYZE',
      input_revision: 'fixture',
      profile_revision: 'fixture',
      prompt_snapshot_id: null,
      routing_policy_version: 'local',
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: '',
      arrival_origin_at: at,
      origin_kind: 'NEW',
      payload: {},
      priority: 80,
      due_at: at,
    },
    at,
  ))!;
  // Organization-only fixture, not provider or quality acceptance evidence.
  for (const id of ['run-old', 'run-new'])
    await env.DB.prepare(
      "INSERT INTO analysis_runs(run_id,owner_id,item_id,job_id,input_snapshot_json,profile_snapshot_json,routing_snapshot_json,state,created_at) VALUES(?,'a',?,?,'{}','{}','{}','ACCEPTED',?)",
    )
      .bind(id, item.item_id, job.job_id, at)
      .run();
  await env.DB.prepare(
    'INSERT INTO active_analysis_selections VALUES(?,?,?,?,?)',
  )
    .bind('a', item.item_id, 'run-old', 1, 'run-old')
    .run();
  const row = JSON.stringify({
    observation_id: 'obs-note',
    kind: 'CLAIM',
    content_pl: 'Source statement',
  });
  await env.DB.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?)')
    .bind('a', 'obs-note', 'run-old', 'CLAIM', row, await sha256(row), at)
    .run();
  return {
    owner,
    item,
    organization: new KnowledgeOrganization(env.DB, owner),
  };
}
it('spaces remain many-to-many without copying items and mutations are audited, idempotent and revision guarded', async () => {
  const { item, organization } = await setup();
  const spaces = [crypto.randomUUID(), crypto.randomUUID()];
  for (const space_id of spaces)
    await organization.space(
      {
        space_id,
        name: 'Research',
        active: true,
        expected_revision: 0,
        mutation_id: crypto.randomUUID(),
      },
      fixtureNow,
    );
  for (const space_id of spaces)
    await organization.membership(
      {
        item_id: item.item_id,
        space_id,
        active: true,
        expected_revision: 0,
        mutation_id: crypto.randomUUID(),
      },
      fixtureNow,
    );
  expect((await organization.read(item.item_id)).memberships).toHaveLength(2);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM items').first('n')).toBe(
    1,
  );
  const request = {
    item_id: item.item_id,
    space_id: spaces[0]!,
    active: true,
    expected_revision: 1,
    mutation_id: crypto.randomUUID(),
  };
  expect(
    (await organization.membership(request, fixtureNow)).state.revision,
  ).toBe(1);
  expect(await organization.membership(request, fixtureNow)).toMatchObject({
    duplicate: true,
  });
  await expect(
    organization.membership({ ...request, active: false }, fixtureNow),
  ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  await expect(
    organization.membership(
      { ...request, expected_revision: 0, mutation_id: crypto.randomUUID() },
      fixtureNow,
    ),
  ).rejects.toThrow('REVISION_CONFLICT');
  await organization.membership(
    { ...request, active: false, mutation_id: crypto.randomUUID() },
    fixtureNow,
  );
  await organization.space(
    {
      space_id: spaces[0]!,
      name: 'Archived',
      active: false,
      expected_revision: 1,
      mutation_id: crypto.randomUUID(),
    },
    fixtureNow,
  );
  await expect(
    organization.membership(
      { ...request, expected_revision: 2, mutation_id: crypto.randomUUID() },
      fixtureNow,
    ),
  ).rejects.toThrow('NOT_FOUND');
  expect((await organization.read(item.item_id)).memberships[0]).toBeDefined();
  await expect(
    new KnowledgeOrganization(env.DB, await fixtureOwner('b')).read(
      item.item_id,
    ),
  ).rejects.toThrow('NOT_FOUND');
  await expect(
    env.DB.prepare("UPDATE organization_mutations SET after_json='{}'").run(),
  ).rejects.toThrow('IMMUTABLE_ORGANIZATION_EVENT');
});
it('concurrent reviews have one revision winner and the backup barrier denies every organization write', async () => {
  const { item, organization } = await setup();
  const results = await Promise.allSettled(
    ['SAVE', 'READ'].map((action) =>
      organization.review(
        {
          item_id: item.item_id,
          action: action as 'SAVE' | 'READ',
          reviewed_run_id: null,
          expected_revision: 0,
          mutation_id: crypto.randomUUID(),
        },
        fixtureNow,
      ),
    ),
  );
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(
    1,
  );
  expect((await organization.read(item.item_id)).review.revision).toBe(1);
  await env.DB.prepare(
    "UPDATE maintenance_state SET barrier_token='fixture',barrier_until='2099-01-01T00:00:00.000Z' WHERE singleton=1",
  ).run();
  await expect(
    organization.space(
      {
        space_id: crypto.randomUUID(),
        name: 'Paused',
        active: true,
        expected_revision: 0,
        mutation_id: crypto.randomUUID(),
      },
      fixtureNow,
    ),
  ).rejects.toThrow('BACKUP_MUTATION_PAUSED');
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM spaces WHERE name='Paused'",
    ).first('n'),
  ).toBe(0);
});
it('accepted run updates preserve saved/read state and manual insights stay owner authored without AI jobs', async () => {
  const { item, organization } = await setup();
  let revision = 0;
  for (const action of ['SAVE', 'READ', 'REVIEW'] as const)
    await organization.review(
      {
        item_id: item.item_id,
        action,
        reviewed_run_id: action === 'REVIEW' ? 'run-old' : null,
        expected_revision: revision++,
        mutation_id: crypto.randomUUID(),
      },
      fixtureNow,
    );
  expect((await organization.read(item.item_id)).review).toMatchObject({
    saved: 1,
    read_at: fixtureNow.toISOString(),
    reviewed_run_id: 'run-old',
    updated: false,
  });
  await env.DB.prepare(
    "UPDATE active_analysis_selections SET accepted_run_id='run-new',requested_run_id='run-new',selection_revision=2 WHERE item_id=?",
  )
    .bind(item.item_id)
    .run();
  expect((await organization.read(item.item_id)).review).toMatchObject({
    saved: 1,
    read_at: fixtureNow.toISOString(),
    reviewed_run_id: 'run-old',
    updated: true,
  });
  await expect(
    organization.review(
      {
        item_id: item.item_id,
        action: 'REVIEW',
        reviewed_run_id: 'foreign-run',
        expected_revision: revision,
        mutation_id: crypto.randomUUID(),
      },
      fixtureNow,
    ),
  ).rejects.toThrow('INVALID_REVIEWED_RUN');
  const jobCount = await env.DB.prepare('SELECT COUNT(*) n FROM jobs').first(
    'n',
  );
  const insight_id = crypto.randomUUID();
  const note = {
    insight_id,
    item_id: item.item_id,
    text: '<script>alert(1)</script> **Owner note**',
    active: true,
    observation_ids: ['obs-note'],
    expected_revision: 0,
    mutation_id: crypto.randomUUID(),
  };
  await organization.insight(note, fixtureNow);
  await expect(
    organization.insight(
      {
        ...note,
        insight_id: crypto.randomUUID(),
        observation_ids: ['foreign-observation'],
        mutation_id: crypto.randomUUID(),
      },
      fixtureNow,
    ),
  ).rejects.toThrow('INVALID_INSIGHT_OBSERVATION');
  const result = await organization.read(item.item_id);
  expect(result.insights[0]).toMatchObject({
    text: note.text,
    authored_by: 'a',
  });
  expect(result.observation_refs).toEqual([
    { insight_id, observation_id: 'obs-note' },
  ]);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM jobs').first('n')).toBe(
    jobCount,
  );
  await organization.insight(
    {
      ...note,
      active: false,
      expected_revision: 1,
      mutation_id: crypto.randomUUID(),
    },
    fixtureNow,
  );
  expect((await organization.read(item.item_id)).insights[0]).toMatchObject({
    active: 0,
    revision: 2,
  });
});
