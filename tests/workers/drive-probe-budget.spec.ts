import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';

beforeEach(resetCore);
it('counts long immutable probe prefixes exactly without LIKE and bounds trials per owner/root', async () => {
  const owner = await fixtureOwner();
  const prefix = 'drive-guard-probe:' + 'a'.repeat(64) + ':';
  const insert = (id: string) =>
    env.DB.prepare(
      `INSERT INTO config_versions(config_id,owner_id,revision,payload_json,content_hash,created_at)
    SELECT ?,?,1,'{}',?,? WHERE (SELECT count(*) FROM config_versions WHERE owner_id=? AND substr(config_id,1,length(?))=? AND revision=1)<3`,
    )
      .bind(
        id,
        owner.ownerId,
        'b'.repeat(64),
        fixtureNow.toISOString(),
        owner.ownerId,
        prefix,
        prefix,
      )
      .run();
  for (let i = 0; i < 3; i++)
    expect((await insert(prefix + i)).meta.changes).toBe(1);
  expect((await insert(prefix + 'fourth')).meta.changes).toBe(0);
  expect(
    (
      await env.DB.prepare(
        'SELECT count(*) n FROM config_versions WHERE owner_id=? AND substr(config_id,1,length(?))=? AND revision=1',
      )
        .bind(owner.ownerId, prefix, prefix)
        .first<{ n: number }>()
    )?.n,
  ).toBe(3);
});
