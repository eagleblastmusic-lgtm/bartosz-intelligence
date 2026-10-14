/** Bound the stock provider's transport; tokens and headers never enter telemetry. */
import { createHash } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const server = process.env.BARTOSZ_POT_SERVER;
const output = process.env.BARTOSZ_POT_TRACE;
if (!server || !output) throw new Error('POT_TRACE_PATHS_REQUIRED');
const maximum = Number(process.env.BARTOSZ_POT_MAX_REQUESTS ?? 8);
if (!Number.isInteger(maximum) || maximum < 1 || maximum > 8)
  throw new Error('POT_REQUEST_LIMIT_INVALID');
const maximumBody = 4 * 1024 * 1024;
const observations = [];
let total = 0;
const hash = (data) => createHash('sha256').update(data).digest('hex');
function save() {
  writeFileSync(
    output + '.tmp',
    JSON.stringify({
      schema: 'ote-pot-transport:1',
      body_hash_basis: 'decoded_axios_body',
      requests: observations,
      total_response_bytes: total,
    }) + '\n',
    { mode: 0o600 },
  );
  renameSync(output + '.tmp', output);
}
function begin(url) {
  if (observations.length >= maximum) throw new Error('POT_REQUEST_BUDGET');
  const locator = new URL(url);
  if (
    locator.protocol !== 'https:' ||
    locator.username ||
    locator.password ||
    !['youtube.com', 'google.com', 'googleapis.com', 'gstatic.com'].some(
      (host) =>
        locator.hostname === host || locator.hostname.endsWith('.' + host),
    )
  )
    throw new Error('POT_SOURCE_HOST_REFUSED');
  const row = {
    host: locator.hostname,
    path: locator.pathname,
    http_status: null,
    bytes: 0,
    sha256: null,
  };
  observations.push(row);
  save();
  return row;
}
function body(row, bytes) {
  if (bytes.length > maximumBody || total + bytes.length > 32 * 1024 * 1024)
    throw new Error('POT_RESPONSE_LIMIT');
  total += bytes.length;
  row.bytes = bytes.length;
  row.sha256 = hash(bytes);
  save();
}
save();
process.once('exit', save);
const { default: axios } = await import(
  pathToFileURL(resolve(server, 'node_modules/axios/index.js')).href
);
const responseBytes = (data) =>
  Buffer.isBuffer(data)
    ? data
    : Buffer.from(
        typeof data === 'string' ? data : (JSON.stringify(data) ?? ''),
      );
function attach(client) {
  client.defaults.proxy = false;
  client.defaults.timeout = 10000;
  client.defaults.maxContentLength = maximumBody;
  client.defaults.maxBodyLength = maximumBody;
  client.defaults.maxRedirects = 0;
  client.interceptors.request.use((config) => {
    config.bartoszObservation = begin(new URL(config.url, config.baseURL).href);
    return config;
  });
  client.interceptors.response.use(
    (response) => {
      const row = response.config.bartoszObservation;
      row.http_status = response.status;
      body(row, responseBytes(response.data));
      return response;
    },
    (error) => {
      const row = error.config?.bartoszObservation;
      if (row) {
        row.http_status = error.response?.status ?? null;
        row.error_type = /^[A-Z_]+$/.test(String(error.code))
          ? error.code
          : 'TRANSPORT_FAILURE';
        if (error.response) body(row, responseBytes(error.response.data));
        save();
      }
      throw error;
    },
  );
  return client;
}
attach(axios);
const create = axios.create.bind(axios);
axios.create = (...args) => attach(create(...args));
const fetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const row = begin(input instanceof Request ? input.url : String(input));
  try {
    const response = await fetch(input, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.any(
        [
          options.signal,
          input instanceof Request ? input.signal : undefined,
          AbortSignal.timeout(10000),
        ].filter(Boolean),
      ),
    });
    row.http_status = response.status;
    const chunks = [];
    let received = 0;
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > maximumBody || total + received > 32 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('POT_RESPONSE_LIMIT');
        }
        chunks.push(Buffer.from(value));
      }
    }
    const bytes = Buffer.concat(chunks);
    body(row, bytes);
    return new Response(
      [204, 205, 304].includes(response.status) ? null : bytes,
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  } catch {
    row.error_type = 'TRANSPORT_FAILURE';
    save();
    throw new Error('POT_FETCH_FAILED');
  }
};
