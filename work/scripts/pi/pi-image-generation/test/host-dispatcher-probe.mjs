// Explicit, local-only slow probe. Not part of npm test. No credentials or external requests.
// node test/host-dispatcher-probe.mjs --direct|--tunnel [host dispatcher file URL]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { createRequire } from 'node:module';
import { channel } from 'node:diagnostics_channel';
import { requestImageJson } from '../src/http.ts';

const mode = process.argv[2];
if (!['--direct', '--tunnel'].includes(mode)) throw new Error('Choose --direct or --tunnel; each waits 70 seconds locally.');
const hostUrl = process.argv[3] ?? 'file:///D:/Nodejs/node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js';
if (!hostUrl.startsWith('file:')) throw new Error('Host module must be a local file URL');
// These changes are confined to this standalone child process, never persisted.
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']) delete process.env[key];
const requireHost = createRequire(hostUrl);
const undici = requireHost('undici');
const { configureHttpDispatcher, DEFAULT_HTTP_IDLE_TIMEOUT_MS } = await import(hostUrl);
const timers = new Set();
const sockets = new Set();
let calls = 0;
let tunnels = 0;
let diagnostic;
let result;
let serverBodyMs;
let serverResponseMs;
let started;
const observedRequests = [];
function observe({ request }) {
  // Only method and timeout overrides, never headers, body, URL or socket details.
  observedRequests.push({ method: request.method, headersTimeout: request.headersTimeout ?? null, bodyTimeout: request.bodyTimeout ?? null });
}
const events = channel('undici:request:create');
function track(socket) {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
}
const server = createServer((req, res) => {
  calls++;
  req.resume();
  req.on('end', () => {
    serverBodyMs = Math.round(performance.now() - started);
    const timer = setTimeout(() => {
      timers.delete(timer);
      serverResponseMs = Math.round(performance.now() - started);
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end('{"localProbe":true}');
    }, 70_000);
    timers.add(timer);
  });
});
server.on('connection', track);
const proxy = createServer((_req, res) => { res.writeHead(405); res.end(); });
proxy.on('connection', track);
function listen(s) { return new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve); }); }
function close(s) { return new Promise(resolve => { if (!s.listening) return resolve(); s.close(resolve); }); }
let dispatcher;
try {
  await listen(server);
  const authority = `127.0.0.1:${server.address().port}`;
  proxy.on('connect', (req, client, head) => {
    tunnels++;
    // Refuse any target except this test's own loopback server.
    if (req.url !== authority) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const upstream = connect({ host: '127.0.0.1', port: server.address().port });
    track(upstream);
    client.on('close', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  });
  if (mode === '--tunnel') {
    await listen(proxy);
    process.env.HTTP_PROXY = process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.address().port}`;
  }
  configureHttpDispatcher();
  dispatcher = undici.getGlobalDispatcher();
  assert.equal(DEFAULT_HTTP_IDLE_TIMEOUT_MS, 300_000);
  assert.equal(globalThis.fetch, undici.fetch, 'host must install its matching fetch');
  events.subscribe(observe);
  started = performance.now();
  const payload = await requestImageJson(`http://${authority}/delayed-headers`, {
    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
    body: '{"synthetic":true}', signal: AbortSignal.timeout(300_000),
  }, 1024, {
    operation: 'generate', onDiagnostic: async record => { diagnostic = record; return 'in-memory-only'; },
  });
  assert.deepEqual(payload, { localProbe: true });
  assert.equal(calls, 1);
  assert.equal(tunnels, mode === '--tunnel' ? 1 : 0);
  assert.equal(diagnostic?.outcome, 'success');
  assert.ok(diagnostic.elapsedMs >= 70_000);
  assert.equal(observedRequests.filter(r => r.method === 'POST').length, 1);
  result = { passed: true };
} catch (error) {
  // Controlled local fixture: only emit a bounded message, not an arbitrary object/stack.
  result = { passed: false, error: String(error.message).slice(0,1000) };
  process.exitCode = 1;
} finally {
  events.unsubscribe(observe);
  for (const timer of timers) clearTimeout(timer);
  if (dispatcher) await dispatcher.destroy();
  for (const socket of sockets) socket.destroy();
  await Promise.all([close(server), close(proxy)]);
}
console.log(JSON.stringify({ ...result, mode, node: process.version, undici: requireHost('undici/package.json').version,
  hostDefaultTimeoutMs: DEFAULT_HTTP_IDLE_TIMEOUT_MS, delayMs: 70_000, calls, tunnels,
  serverBodyMs, serverResponseMs, observedRequests, diagnostic,
  limitations: 'Independent Node process; loopback HTTP only, not running Pi heap, real Clash, TLS or OpenAI.' }, null, 2));
