import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
const local = JSON.parse(
  readFileSync('.local/owner-bootstrap-server.json', 'utf8'),
);
const response = await fetch(local.url);
const oldPolicy = process.argv.includes('--old-policy');
const policy = oldPolicy
  ? response.headers
      .get('content-security-policy')
      .replace(' https://accounts.google.com', '')
  : response.headers.get('content-security-policy');
const template = (await response.text()).replace(
  /name="capability" value="[^"]+"/,
  'name="capability" value="fixture-capability"',
);
let port,
  posts = 0,
  google = 0,
  googleMethod = null,
  googleBody = false,
  cspBlocked = false;
const fixture = createServer(async (request, response) => {
  if (request.url === '/') {
    const html = template.replaceAll(
      'https://bartosz-intelligence.eagleblastmusic.workers.dev',
      `http://127.0.0.1:${port}`,
    );
    const csp = policy
      .replaceAll(
        'https://bartosz-intelligence.eagleblastmusic.workers.dev',
        `http://127.0.0.1:${port}`,
      )
      .replaceAll('https://accounts.google.com', `http://localhost:${port}`);
    response.writeHead(200, {
      'Content-Type': 'text/html',
      'Content-Security-Policy': csp,
    });
    response.end(html);
    return;
  }
  if (request.url === '/api/v1/auth/bootstrap/login') {
    posts++;
    response.writeHead(303, { Location: `http://localhost:${port}/google` });
    response.end();
    return;
  }
  if (request.url === '/google') {
    google++;
    googleMethod = request.method;
    let length = 0;
    for await (const chunk of request) length += chunk.length;
    googleBody = length > 0;
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<h1>Fixture Google login</h1>');
    return;
  }
  response.writeHead(404);
  response.end();
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
port = fixture.address().port;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext(),
    page = await context.newPage();
  await context.route('**/*', (route) =>
    ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort(),
  );
  page.on('console', (message) => {
    if (/form-action|Refused to send form data/.test(message.text()))
      cspBlocked = true;
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page
    .getByRole('button', { name: 'Kontynuuj z Google' })
    .click({ noWaitAfter: true });
  if (oldPolicy) await page.waitForTimeout(250);
  else
    await page
      .getByRole('heading', { name: 'Fixture Google login' })
      .waitFor({ timeout: 5000 });
  const outcome = {
    fixture_only: true,
    post_requests: posts,
    google_requests: google,
    google_method: googleMethod,
    google_received_post_body: googleBody,
    csp_form_redirect_blocked: cspBlocked,
    final_host: new URL(page.url()).hostname,
  };
  console.log(JSON.stringify(outcome));
  if (oldPolicy) {
    if (posts !== 1 || google !== 0 || !cspBlocked)
      throw new Error('CSP_NEGATIVE_CONTROL_FAILED');
  } else if (
    posts !== 1 ||
    google !== 1 ||
    googleMethod !== 'GET' ||
    googleBody ||
    cspBlocked
  )
    throw new Error('BOOTSTRAP_REDIRECT_REGRESSION');
} finally {
  await browser.close();
  await new Promise((resolve) => fixture.close(resolve));
}
