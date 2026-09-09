// Explicit slow LOCAL test: actual Clash7897 -> ephemeral loopback HTTPS server.
// No OpenAI requests, credentials, system certificate installation or TLS bypass.
// node test/clash-https-probe.mjs --confirm-local-clash-test
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { channel } from 'node:diagnostics_channel';

if (process.argv[2] === '--confirm-local-clash-test') {
  const dir = mkdtempSync(join(tmpdir(), 'pi-clash-https-'));
  const cert = join(dir, 'localhost.pem');
  const key = join(dir, 'localhost-key.pem');
  let output;
  try {
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-addext', 'basicConstraints=critical,CA:TRUE'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    if (generated.error || generated.status !== 0) throw new Error('Local test certificate generation failed; no request sent.');
    const env = { ...process.env, NODE_EXTRA_CA_CERTS: cert };
    // Do not inherit any setting that disables certificate verification.
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) env[name] = 'http://127.0.0.1:7897';
    env.NO_PROXY = env.no_proxy = '';
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', dir], {
      env, encoding: 'utf8', timeout: 95_000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    if (child.error) throw new Error(`Local probe process failed: ${child.error.code ?? 'unknown'}; no automatic retry.`);
    if (!child.stdout.trim()) throw new Error('Local probe produced no result; no automatic retry.');
    output = JSON.parse(child.stdout);
    if (child.status !== 0) process.exitCode = 1;
  } catch (error) {
    output = { passed: false, error: String(error.message).slice(0, 500) };
    process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ ...output, temporaryCertificateAndKeyRemoved: true }, null, 2));
} else if (process.argv[2] === '--child') {
  await runChild(process.argv[3]);
} else {
  throw new Error('Requires --confirm-local-clash-test (one local POST, about70seconds).');
}

async function runChild(dir) {
  const hostUrl = 'file:///D:/Nodejs/node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js';
  const requireHost = createRequire(hostUrl);
  const undici = requireHost('undici');
  const { configureHttpDispatcher } = await import(hostUrl);
  const { requestImageJson } = await import('../src/http.ts');
  const sockets = new Set();
  const timers = new Set();
  let calls = 0;
  let proxyConnects = 0;
  let throughLocal7897 = false;
  let authorizedTls = false;
  let diagnostic;
  let bodyReceivedMs;
  let responseSentMs;
  let started;
  let dispatcher;
  let outcome;
  const methods = [];
  const server = createServer({ key: readFileSync(join(dir, 'localhost-key.pem')), cert: readFileSync(join(dir, 'localhost.pem')) }, (req, res) => {
    calls++;
    req.resume();
    req.on('end', () => {
      bodyReceivedMs = Math.round(performance.now() - started);
      const timer = setTimeout(() => {
        timers.delete(timer);
        responseSentMs = Math.round(performance.now() - started);
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end('{"localHttpsProbe":true}');
      }, 70_000);
      timers.add(timer);
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  const subscriptions = [
    ['undici:request:create', ({ request }) => { methods.push(request.method); }],
    ['undici:proxy:connected', ({ socket }) => {
      proxyConnects++;
      throughLocal7897 = socket.remotePort === 7897 && ['127.0.0.1', '::ffff:127.0.0.1'].includes(socket.remoteAddress);
    }],
    ['undici:client:sendHeaders', ({ request, socket }) => {
      if (request.method === 'POST') authorizedTls = socket.encrypted === true && socket.authorized === true;
    }],
  ];
  try {
    assert.equal(process.env.NODE_EXTRA_CA_CERTS, join(dir, 'localhost.pem'));
    assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    configureHttpDispatcher();
    dispatcher = undici.getGlobalDispatcher();
    assert.equal(globalThis.fetch, undici.fetch);
    for (const [name, fn] of subscriptions) channel(name).subscribe(fn);
    started = performance.now();
    const payload = await requestImageJson(`https://127.0.0.1:${server.address().port}/delayed-headers`, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: '{"synthetic":true}', signal: AbortSignal.timeout(300_000),
    }, 1024, { operation: 'generate', onDiagnostic: async record => { diagnostic = record; return 'in-memory-only'; } });
    assert.deepEqual(payload, { localHttpsProbe: true });
    assert.equal(calls, 1);
    assert.equal(proxyConnects, 1);
    assert.equal(throughLocal7897, true);
    assert.equal(authorizedTls, true);
    assert.equal(methods.filter(x => x === 'POST').length, 1);
    assert.equal(methods.filter(x => x === 'CONNECT').length, 1);
    assert.equal(diagnostic?.outcome, 'success');
    assert.ok(diagnostic.elapsedMs >= 70_000);
    outcome = { passed: true };
  } catch (error) {
    outcome = { passed: false, error: String(error.message).slice(0,1000) };
    process.exitCode = 1;
  } finally {
    for (const [name, fn] of subscriptions) channel(name).unsubscribe(fn);
    for (const timer of timers) clearTimeout(timer);
    if (dispatcher) await dispatcher.destroy();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify({ ...outcome, node: process.version, undici: requireHost('undici/package.json').version,
    hostDefaultTimeoutMs: 300_000, delayMs: 70_000, calls, proxyConnects, throughLocal7897, authorizedTls,
    methods, bodyReceivedMs, responseSentMs, diagnostic,
    limitations: 'Independent Node process -> actual local Clash7897 -> local HTTPS. Does not validate remote proxy nodes, OpenAI, or running Pi heap.' }));
}
