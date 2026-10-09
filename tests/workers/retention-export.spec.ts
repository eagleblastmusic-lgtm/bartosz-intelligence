import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  resetCore,
  fixtureOwner,
  fixtureNow,
  fixtureSecret,
} from './core-fixture.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { ItemRepository } from '../../packages/core/src/db/items.js';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import { enrichEconomy } from '../../packages/core/src/ai/enrichment/canonical.js';
import { DailyProjection } from '../../packages/core/src/projections/daily.js';
import { renderDaily } from '../../packages/core/src/export/renderer.js';
import { DailyExportArtifacts } from '../../packages/core/src/export/artifacts.js';
import { DailyExportExecutor } from '../../packages/core/src/export/executor.js';
import { DriveExportIdentity } from '../../packages/core/src/drive/identity.js';
import { DriveClient } from '../../packages/core/src/drive/client.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { ExportSettings } from '../../packages/core/src/export/settings.js';
beforeEach(resetCore);
it.each([true, false])(
  'starts the seven-day clock only after exact FULL membership and verified readback; corrupt readback: %s',
  async (corrupt) => {
    const owner = await fixtureOwner(),
      at = fixtureNow.toISOString();
    const source = (await new SourceRepository(env.DB, owner).upsert(
      {
        namespace: 'youtube',
        external_id: 'UC-fixture',
        canonical_locator: 'https://www.youtube.com/channel/UC-fixture',
        title: 'Kanał',
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
        item_type: 'video',
        title: 'Materiał',
        published_at: at,
        publication_provenance: 'SOURCE',
        availability: 'PUBLIC',
        duration_seconds: 60,
      },
      at,
    ))!;
    const transcript = await normalizeTranscript(
      await sha256('Source text'),
      [
        {
          upstream_index: 0,
          text: 'Source text',
          start_ms: null,
          end_ms: null,
          speaker_label: null,
        },
      ],
      'CUE',
    );
    // Deterministic fixture; this is a protocol/integrity test, not AI quality evidence.
    const { canonical } = await enrichEconomy({
      raw: JSON.stringify({
        summary_pl: [
          { text_pl: 'Polskie streszczenie.', segment_refs: ['s1'] },
        ],
        key_points: [{ text_pl: 'Ważne ustalenie.', segment_refs: ['s1'] }],
        entity_mentions: [],
        tools: [],
        claims: [],
        stance: [],
        predictions: [],
        source_issues: [],
      }),
      completion: 'OK',
      run_id: 'run',
      item_id: item.item_id,
      profile_id: 'gemini_free',
      profile_revision: 'fixture',
      approved_aliases: [],
      source: {
        owner_id: 'a',
        source_artifact_id: 'source',
        source_text: transcript.source_text,
        manifest: transcript.manifest,
        manifest_hash: transcript.manifest_hash,
        video_url: 'https://www.youtube.com/watch?v=abcdefghijk',
      },
    });
    const canonicalHash = await sha256(JSON.stringify(canonical));
    await env.DB.prepare(
      `INSERT INTO jobs(job_id,owner_id,item_id,source_id,task_type,input_revision,profile_revision,routing_policy_version,explicit_run_nonce,dedup_key,state,due_at,priority,arrival_origin_at,origin_kind,payload_json,created_at,updated_at) VALUES('job','a',?,?,'ANALYZE','input','economy-1','policy','','dedup','SUCCEEDED',?,80,?,'NEW','{}',?,?)`,
    )
      .bind(item.item_id, source.source_id, at, at, at, at)
      .run();
    await env.DB.prepare(
      `INSERT INTO analysis_runs(run_id,owner_id,item_id,job_id,input_snapshot_json,profile_snapshot_json,routing_snapshot_json,state,outcome_json,created_at,accepted_at) VALUES('run','a',?,'job','{}','{}','{}','ACCEPTED',?,?,?)`,
    )
      .bind(
        item.item_id,
        JSON.stringify({
          version: 'intelligence-accepted:1',
          canonical_hash: canonicalHash,
          view: { status: 'OK', coverage_complete: true },
        }),
        at,
        at,
      )
      .run();
    await env.DB.prepare(
      "INSERT INTO active_analysis_selections VALUES('a',?,'run',1,'run')",
    )
      .bind(item.item_id)
      .run();
    await env.DB.prepare(
      `INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,root_id,root_state,revision,last_intent_hash,created_at,updated_at) VALUES('a','connection','subject-a','client','[]','CONNECTED','root','VERIFIED',1,'receipt',?,?)`,
    )
      .bind(at, at)
      .run();
    const identity = new DriveExportIdentity(env.DB, owner);
    await identity.ensure('connection', 'root', '2026-10-05');
    await new ExportSettings(env.DB, owner).mode(
      'root',
      '2026-10-05',
      'FULL',
      1,
      fixtureNow,
    );
    const lease = await identity.claim(
      'root',
      '2026-10-05',
      'exporter',
      fixtureNow,
    );
    const snapshot = await new DailyProjection(env.DB, owner).day(
      { date: lease.date, timezone: 'Europe/Warsaw', limit: 20 },
      fixtureSecret,
      fixtureNow,
    );
    snapshot.discovery_complete = true;
    snapshot.complete = true;
    snapshot.partial = false;
    const report = await renderDaily({
      snapshot,
      selections: [
        {
          item_id: item.item_id,
          run_id: 'run',
          canonical_hash: canonicalHash,
          canonical,
        },
      ],
      app_origin: 'https://example.test',
      revision: 1,
      mode: 'FULL',
    });
    expect(report.archive_members).toHaveLength(1);
    const id = await new DailyExportArtifacts(env.DB, owner).save(
      lease,
      report,
      fixtureNow,
    );
    expect(
      await env.DB.prepare('SELECT COUNT(*) n FROM daily_export_members').first(
        'n',
      ),
    ).toBe(1);
    expect(
      await env.DB.prepare('SELECT COUNT(*) n FROM retention_items').first('n'),
    ).toBe(0);
    let exists = false,
      elapsed = 0;
    const wallClock = vi.spyOn(Date, 'now').mockImplementation(() => elapsed);
    try {
      const file = {
        id: 'reserved',
        name: lease.date + '.md',
        mimeType: 'text/markdown',
        parents: ['root'],
        trashed: false,
        version: '1',
        appProperties: await identity.appProperties('root', lease.date),
      };
      const client = new DriveClient('synthetic', async (target, init) => {
        if (String(target).includes('generateIds'))
          return Response.json({ ids: ['reserved'] });
        if (init?.method === 'POST') {
          exists = true;
          return Response.json(file);
        }
        if (!exists) return new Response(null, { status: 404 });
        if (String(target).includes('alt=media')) elapsed = 90000;
        return String(target).includes('alt=media')
          ? new Response(report.markdown + (corrupt ? 'corrupt' : ''))
          : Response.json(file);
      });
      const executor = new DailyExportExecutor(env.DB, owner);
      if (corrupt) {
        await expect(
          executor.execute(lease, id, client, fixtureNow),
        ).rejects.toThrow('EXPORT_CONFLICT');
        expect(
          await env.DB.prepare('SELECT COUNT(*) n FROM retention_items').first(
            'n',
          ),
        ).toBe(0);
        return;
      }
      await executor.execute(lease, id, client, fixtureNow);
      const receipt = await env.DB.prepare(
        'SELECT accepted_run_id,file_id,remote_version,verified_at,purge_after,canonical_hash FROM retention_items',
      ).first();
      expect(receipt).toEqual({
        accepted_run_id: 'run',
        file_id: 'reserved',
        remote_version: '1',
        verified_at: new Date(fixtureNow.getTime() + 90000).toISOString(),
        purge_after: new Date(
          fixtureNow.getTime() + 90000 + 7 * 86400000,
        ).toISOString(),
        canonical_hash: canonicalHash,
      });
      await executor.execute(
        lease,
        id,
        client,
        new Date(fixtureNow.getTime() + 120000),
      );
      expect(
        await env.DB.prepare(
          'SELECT verified_at,purge_after FROM retention_items',
        ).first(),
      ).toMatchObject({
        verified_at: receipt!.verified_at,
        purge_after: receipt!.purge_after,
      });
    } finally {
      wallClock.mockRestore();
    }
  },
);
