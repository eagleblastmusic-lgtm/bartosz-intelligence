import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const starter = readFileSync('.local/owner-bootstrap.html');
const grant = JSON.parse(readFileSync('.local/owner-bootstrap.json', 'utf8'));
const submitScript =
  "document.querySelector('form').addEventListener('submit',()=>document.querySelector('button').disabled=true)";
const scriptHash = createHash('sha256').update(submitScript).digest('base64');
if (Date.parse(grant.expires_at) <= Date.now())
  throw new Error('BOOTSTRAP_EXPIRED');
let address;
const server = createServer((request, response) => {
  const site = request.headers['sec-fetch-site'];
  if (
    request.method !== 'GET' ||
    request.url !== '/' ||
    request.headers.host !== address ||
    request.headers.origin ||
    (site && !['none', 'same-origin'].includes(site))
  ) {
    response.writeHead(403);
    response.end();
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${scriptHash}'; form-action https://bartosz-intelligence.eagleblastmusic.workers.dev https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'`,
  });
  response.end(starter);
});
server.listen(0, '127.0.0.1', () => {
  address = '127.0.0.1:' + server.address().port;
  writeFileSync(
    '.local/owner-bootstrap-server.json',
    JSON.stringify({
      url: 'http://' + address + '/',
      pid: process.pid,
      expires_at: grant.expires_at,
    }) + '\n',
  );
});
setTimeout(
  () => server.close(() => process.exit(0)),
  Math.min(3600000, Date.parse(grant.expires_at) - Date.now()),
);
