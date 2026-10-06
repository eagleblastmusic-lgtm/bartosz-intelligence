import { it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { sqliteAdapter } from '../../tools/db/sqlite-adapter.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { SearchIndex } from '../../packages/core/src/knowledge/search-index.js';
import { KnowledgeSearch } from '../../packages/core/src/knowledge/search.js';
import { backupTables } from '../../packages/core/src/backup/snapshot.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { ItemRepository } from '../../packages/core/src/db/items.js';
it('indexes 10k canonical rows, bounds pages and reconstructs identical derived text/ref hashes', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec('PRAGMA foreign_keys=ON');
    for (const name of readdirSync('db/migrations')
      .filter((name) => name.endsWith('.sql'))
      .sort())
      sqlite.exec(readFileSync('db/migrations/' + name, 'utf8'));
    const now = new Date('2026-10-06T12:00:00.000Z'),
      at = now.toISOString();
    sqlite
      .prepare('INSERT INTO owner_users VALUES(?,?,?,?,?)')
      .run('a', 'https://accounts.google.com', 'subject-a', 1, at);
    sqlite
      .prepare('INSERT INTO owner_sessions VALUES(?,?,?,?,?,NULL)')
      .run('session', 'a', 'csrf', at, '2099-01-01T00:00:00Z');
    const db = sqliteAdapter(sqlite),
      owner = await AccessContext.owner(db, 'session', at),
      index = new SearchIndex(db, owner),
      search = new KnowledgeSearch(db, owner);
    const source = (await new SourceRepository(db, owner).upsert(
      {
        namespace: 'youtube',
        external_id: 'UC-corpus',
        canonical_locator: 'https://www.youtube.com/channel/UC-corpus',
        title: 'Synthetic corpus',
        uploads_playlist_id: 'UU-corpus',
        handle: null,
      },
      at,
    ))!;
    const items = new ItemRepository(db, owner);
    for (let count = 0; count < 10000; count++)
      await items.upsert(
        source.source_id,
        {
          namespace: 'youtube',
          external_id: 'corpus' + String(count).padStart(5, '0'),
          item_type: 'video',
          canonical_url:
            'https://www.youtube.com/watch?v=corpus' +
            String(count).padStart(5, '0'),
          title: 'Zażółć narzędzie ' + count,
          published_at:
            count % 10 === 0
              ? null
              : new Date(now.getTime() - count * 60000).toISOString(),
          publication_provenance: 'synthetic-corpus',
          availability: 'PUBLIC',
          duration_seconds: 60 + (count % 3600),
        },
        at,
      );
    const start = performance.now();
    console.info(
      JSON.stringify({ event: 'SEARCH_CORPUS_SEEDED', items: 10000 }),
    );
    for (let step = 0; step < 10005; step++) {
      const result = await index.step(now);
      if (!result.progressed) break;
    }
    expect((await index.metadata()).freshness).toBe('FRESH');
    console.info(
      JSON.stringify({
        event: 'SEARCH_CORPUS_INDEXED',
        elapsed_ms: performance.now() - start,
      }),
    );
    expect(
      sqlite.prepare('SELECT COUNT(*) n FROM search_documents').get()?.n,
    ).toBe(10000);
    const before = sqlite
      .prepare(
        'SELECT doc_id,parent_id,text,content_hash FROM search_documents ORDER BY doc_id',
      )
      .all();
    const queryStart = performance.now(),
      first = await search.page(
        'zazolc',
        {},
        50,
        'fixture-search-signing-secret-32-bytes-minimum',
        now,
      );
    const queryMs = performance.now() - queryStart;
    console.info(
      JSON.stringify({ event: 'SEARCH_CORPUS_QUERIED', elapsed_ms: queryMs }),
    );
    expect(first.documents).toHaveLength(50);
    expect(first.next_cursor).toBeTruthy();
    const second = await search.page(
      'zazolc',
      {},
      50,
      'fixture-search-signing-secret-32-bytes-minimum',
      now,
      first.next_cursor!,
    );
    expect(second.documents[0]?.doc_id).not.toBe(first.documents[0]?.doc_id);
    expect(backupTables).not.toContain('search_documents');
    expect(backupTables).not.toContain('search_index_state');
    sqlite.exec('DELETE FROM search_documents; DELETE FROM search_index_state');
    expect(
      (
        await search.page(
          'zazolc',
          {},
          50,
          'fixture-search-signing-secret-32-bytes-minimum',
          now,
        )
      ).freshness,
    ).toBe('UNKNOWN');
    for (let step = 0; step < 10005; step++) {
      const result = await index.step(now);
      if (!result.progressed) break;
    }
    expect(
      sqlite
        .prepare(
          'SELECT doc_id,parent_id,text,content_hash FROM search_documents ORDER BY doc_id',
        )
        .all(),
    ).toEqual(before);
    const bytes =
      Number(sqlite.prepare('PRAGMA page_count').get()?.page_count) *
      Number(sqlite.prepare('PRAGMA page_size').get()?.page_size);
    console.info(
      JSON.stringify({
        event: 'SEARCH_10K_LOCAL_SQLITE',
        rows: 10000,
        index_and_rebuild_ms: performance.now() - start,
        first_page_ms: queryMs,
        database_bytes: bytes,
        canonical_rebuild: 'PASS',
      }),
    );
  } finally {
    sqlite.close();
  }
}, 120000);
