import { it, expect } from 'vitest';
import { fetchWithoutRedirect } from '../../packages/core/src/http/no-redirect.js';
it('workerd requires manual redirect mode for outbound fail-closed requests', () => {
  expect(
    () =>
      new Request('https://oauth2.googleapis.com/token', {
        method: 'POST',
        redirect: 'error',
        body: new URLSearchParams({ code: 'fixture-invalid' }),
      }),
  ).toThrow();
  const request = new Request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({ code: 'fixture-invalid' }),
  });
  expect(request.redirect).toBe('manual');
  expect(request.headers.get('content-type')).toContain(
    'application/x-www-form-urlencoded',
  );
});
it('runtime-compatible transport rejects redirect responses before a second request and preserves RSS 304', async () => {
  let requests = 0;
  const transport: typeof fetch = async (input, options) => {
    requests++;
    const request = new Request(input, options);
    expect(request.redirect).toBe('manual');
    return new Response(null, {
      status: 303,
      headers: { Location: 'https://untrusted.fixture.invalid/' },
    });
  };
  await expect(
    fetchWithoutRedirect(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        body: new URLSearchParams({ code: 'fixture-invalid' }),
      },
      transport,
    ),
  ).rejects.toThrow('OUTBOUND_REDIRECT_DENIED');
  expect(requests).toBe(1);
  expect(
    (
      await fetchWithoutRedirect(
        'https://www.youtube.com/feeds/videos.xml',
        {},
        async (input, options) => {
          expect(new Request(input, options).redirect).toBe('manual');
          return new Response(null, { status: 304 });
        },
      )
    ).status,
  ).toBe(304);
});
