import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { uxFixtureSql, uxSessionSecret } from '../../tools/gates/ux-fixture.js';
import { sqliteAdapter } from '../../tools/db/sqlite-adapter.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { EvidenceProjection } from '../../packages/core/src/projections/evidence.js';
import { ArtifactRepository } from '../../packages/core/src/artifacts/store.js';
import {
  captureDailyExport,
  renderOwnerDaily,
} from '../../packages/core/src/export/snapshot.js';

it('seeds 10000 isolated items and a byte-exact synthetic source/Evidence path without provider requests', async () => {
  const fixture = await uxFixtureSql(10000, true),
    sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec('PRAGMA foreign_keys=ON');
    sqlite.exec(fixture.sql);
    expect(sqlite.prepare('SELECT COUNT(*) n FROM items').get()!.n).toBe(10000);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const db = sqliteAdapter(sqlite),
      owner = await AccessContext.owner(
        db,
        await sha256(fixture.cookie.split('.')[0]!),
        new Date().toISOString(),
      );
    const row = sqlite.prepare('SELECT evidence_id FROM evidence').get()!;
    const evidence = await new EvidenceProjection(db, owner).read(
      String(row.evidence_id),
      'run-ux-6',
    );
    expect(evidence).toMatchObject({
      source_artifact_id: 'ux-source-original',
      timestamp_precision: 'NONE',
      start_ms: null,
      timestamp_url: null,
    });
    const source = await new ArtifactRepository(db, owner).readVerifiedText(
      evidence.source_artifact_id,
      1024,
    );
    expect(await sha256(source.text)).toBe(evidence.source_hash);
    expect(source.text).toContain('Żółć 🧠.');
    expect(
      sqlite.prepare('SELECT COUNT(*) n FROM usage_records').get()!.n,
    ).toBe(0);
    expect(
      sqlite.prepare('SELECT COUNT(*) n FROM quota_reservations').get()!.n,
    ).toBe(0);
    // Isolate the single fully verified synthetic result on another fixture
    // publication day. Other UI-only run stubs must not masquerade as artifacts.
    sqlite
      .prepare(
        "UPDATE items SET published_at='2026-10-07T10:00:00Z' WHERE item_id='ux-6'",
      )
      .run();
    const exportInput = {
      date: '2026-10-07',
      app_origin: 'https://bartosz-intelligence.eagleblastmusic.workers.dev',
      revision: 1,
      mode: 'FULL' as const,
    };
    const captured = await captureDailyExport(
      db,
      owner,
      exportInput,
      uxSessionSecret,
      new Date(),
    );
    expect(captured.selections).toHaveLength(1);
    expect(captured.selections[0]!.canonical_hash).toBe(
      await sha256(JSON.stringify(captured.selections[0]!.canonical)),
    );
    const report = await renderOwnerDaily(
      db,
      owner,
      exportInput,
      uxSessionSecret,
      new Date(),
    );
    expect(report.item_ids).toEqual(['ux-6']);
    expect(report.markdown).toContain('ITEM ux-6');
    expect(report.markdown).toContain('### Evidence');
    expect(report.markdown).toContain('Żółć 🧠.');
    expect(() =>
      sqlite
        .prepare(
          "UPDATE analysis_runs SET candidate_hash='tampered' WHERE run_id='run-ux-6'",
        )
        .run(),
    ).toThrow('IMMUTABLE_ACCEPTED_RUN');
    expect(
      await renderOwnerDaily(
        db,
        owner,
        exportInput,
        uxSessionSecret,
        new Date(),
      ),
    ).toEqual(report);
  } finally {
    sqlite.close();
  }
});
