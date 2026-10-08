import { createExecutionContext } from 'cloudflare:test';
import { expect, it } from 'vitest';
import worker from '../../apps/api/src/index.js';
import type { Env } from '../../apps/api/src/env.js';

it('serves public information without credentials, bindings, cookies or private SPA', async () => {
  for (const path of ['/about', '/privacy', '/terms']) {
    const response = await worker.fetch(
      new Request('https://example.com' + path),
      {} as Env,
      createExecutionContext(),
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(response.headers.has('Set-Cookie')).toBe(false);
    expect(response.headers.get('Content-Security-Policy')).toContain(
      "default-src 'none'",
    );
    expect(html).toContain('Bartosz Intelligence');
    expect(html).toContain('href="/privacy"');
    expect(html).not.toMatch(
      /<script|<iframe|\/assets\/|owner_id|account_subject|client_secret|envelope_json/,
    );
  }
});
