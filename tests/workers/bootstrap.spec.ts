import { env } from 'cloudflare:workers';
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../../apps/api/src/index.js';
import type { Env } from '../../apps/api/src/index.js';

describe('LOCAL workerd smoke (not Gate E)', () => {
  it('health exposes binding presence only', async () => {
    const response = await worker.fetch(
      new Request('http://localhost/health'),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      build: '0.0.1',
      status: 'LOCAL_READY',
      bindings: { DB: true, BARTOSZ_QUEUE: true, ASSETS: true },
    });
  });
  it('missing binding yields not-ready without production secrets', async () => {
    const response = await worker.fetch(
      new Request('http://localhost/health'),
      {} as Env,
      createExecutionContext(),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('owner');
  });
  it('reserved API returns JSON for browser Accept', async () => {
    const response = await worker.fetch(
      new Request('http://localhost/api/missing', {
        headers: { Accept: 'text/html' },
      }),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toContain('application/json');
  });
  it('local D1 insert/read, SQL batch rollback and fixture restore', async () => {
    await env.DB.exec(
      'CREATE TABLE smoke(id INTEGER PRIMARY KEY, value TEXT NOT NULL);',
    );
    await env.DB.prepare('INSERT INTO smoke VALUES(?,?)')
      .bind(1, 'original')
      .run();
    expect(
      await env.DB.prepare('SELECT value FROM smoke WHERE id=1').first('value'),
    ).toBe('original');
    await expect(
      env.DB.batch([
        env.DB.prepare("INSERT INTO smoke VALUES(2,'must-rollback')"),
        env.DB.prepare('INSERT INTO missing_table VALUES(1)'),
      ]),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS n FROM smoke').first('n'),
    ).toBe(1);
    const snapshot = await env.DB.prepare(
      'SELECT * FROM smoke ORDER BY id',
    ).all<{ id: number; value: string }>();
    await env.DB.exec(
      'DROP TABLE smoke; CREATE TABLE smoke(id INTEGER PRIMARY KEY, value TEXT NOT NULL);',
    );
    await env.DB.batch(
      snapshot.results.map((row) =>
        env.DB.prepare('INSERT INTO smoke VALUES(?,?)').bind(row.id, row.value),
      ),
    );
    expect(
      (await env.DB.prepare('SELECT * FROM smoke ORDER BY id').all()).results,
    ).toEqual(snapshot.results);
  });
  it('local Queue producer accepts message and invalid signal retries', async () => {
    await env.BARTOSZ_QUEUE.send({ fixture: true });
    const batch = createMessageBatch('stage01-local-fixture', [
      {
        id: 'smoke',
        timestamp: new Date(),
        attempts: 1,
        body: { fixture: true },
      },
    ]);
    const context = createExecutionContext();
    await worker.queue(batch, env);
    expect((await getQueueResult(batch, context)).retryMessages).toEqual([
      { msgId: 'smoke' },
    ]);
  });
});
