// Repository-only differential test: execute the last working implementation and
// the current extension with identical synthetic auth/input and mocked fetch.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const sdk = process.argv[2] ?? pathToFileURL(require.resolve('@earendil-works/pi-coding-agent')).href;
const hostRequire = createRequire(sdk);
const { createJiti } = hostRequire('jiti');
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: {
 '@earendil-works/pi-coding-agent': fileURLToPath(sdk),
 '@earendil-works/pi-ai': fileURLToPath(new URL('../node_modules/@earendil-works/pi-ai/dist/index.js', sdk)),
 '@earendil-works/pi-tui': fileURLToPath(new URL('../node_modules/@earendil-works/pi-tui/dist/index.js', sdk)),
}});
const baselineRef = '4df3ccd805ef32616ccbc8ee635649b3be1f1e46';
const pluginPath = 'work/scripts/pi/pi-image-generation';
const directory = await mkdtemp(path.join(tmpdir(), 'image-baseline-'));
const originalFetch = globalThis.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = directory;
globalThis.fetch = async () => { throw new Error('Real network disabled'); };
try {
 for (const relative of ['extensions/index.ts', 'src/ali-wan-images.ts', 'src/openai-codex-images.ts', 'src/command.ts', 'src/http.ts', 'src/image-files.ts', 'src/types.ts']) {
  const destination = path.join(directory, 'baseline', relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, execFileSync('git', ['show', `${baselineRef}:${pluginPath}/${relative}`], { cwd: fileURLToPath(new URL('..', import.meta.url)), maxBuffer: 1024 * 1024 }));
 }
 const { default: baseline } = await jiti.import(path.join(directory, 'baseline/extensions/index.ts'));
 const { default: current } = await jiti.import('../extensions/index.ts');
 const { buildOpenAICodexRequest: oldBuilder } = await jiti.import(path.join(directory, 'baseline/src/openai-codex-images.ts'));
 const { buildOpenAICodexRequest: newBuilder } = await jiti.import('../src/openai-codex-images.ts');
 const token = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url')}.signature`;
 const png = Buffer.from([137,80,78,71,13,10,26,10]).toString('base64');
 let scenarios = 0;
 for (const baseUrl of ['https://chatgpt.com/backend-api', 'https://chatgpt.com/backend-api/codex', 'https://chatgpt.com/backend-api/codex/']) {
  for (const quality of [undefined, 'auto', 'low', 'medium', 'high']) {
   for (const edit of [false, true]) {
    const captures = [];
    const images = edit ? [{ type: 'image', data: png, mimeType: 'image/png' }] : [];
    for (const [index, extension] of [baseline, current].entries()) {
     const requests = [], notices = [], resolutions = [], entries = [];
     let input;
     await extension({ registerEntryRenderer() {}, registerCommand() {}, on(event, callback) { if (event === 'input') input = callback; }, appendEntry(_type, data) { entries.push(data); } });
     globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body: init.body, redirect: init.redirect });
      assert.equal(init.signal.aborted, false);
      return Response.json({ data: [{ b64_json: png }] });
     };
     await input({ text: `/image openai ${quality ? `--quality ${quality} ` : ''}--size 1024x1024 synthetic comparison`, images }, {
      mode: 'rpc', cwd: path.join(directory, `case-${scenarios}-${index}`), isIdle: () => true,
      ui: { notify: (message) => notices.push(message) },
      modelRegistry: {
       getProvider: (id) => id === 'openai-codex' ? { baseUrl } : undefined,
       getProviderAuthStatus: () => ({ configured: true }),
       getProviderAuth: async (id) => { resolutions.push(id); return { auth: { apiKey: token, headers: { 'x-synthetic-header': 'test-value' } } }; },
      },
     });
     assert.equal(requests.length, 1, `Expected one request, got notices: ${notices.join('\n')}`);
     assert.equal(entries.length, 1, `Expected saved image: ${notices.join('\n')}`);
     assert.deepEqual(resolutions, ['openai-codex']);
     captures.push(requests[0]);
    }
    assert.equal(captures[0].redirect, undefined);
    assert.equal(captures[1].redirect, 'error'); // Intentional credential protection, not a wire-header/body change.
    delete captures[0].redirect; delete captures[1].redirect;
    assert.deepEqual(captures[1], captures[0], 'URL, method, headers and serialized body must match the working baseline');
    // Also test direct adapter callers: the historical default was quality:auto.
    const options = { apiKey: token, baseUrl, images, prompt: 'synthetic comparison', model: 'gpt-image-2', size: 'auto', quality };
    assert.deepEqual(newBuilder(options).body, oldBuilder(options).body, 'Direct adapter must preserve legacy defaults');
    scenarios++;
   }
  }
 }
 console.log(`Baseline ${baselineRef}: ${scenarios} scenarios passed; identical URL/method/auth headers/serialized request body and direct-adapter defaults. All fetch calls mocked; no credential reads or paid requests.`);
} finally {
 globalThis.fetch = originalFetch;
 if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
 await rm(directory, { recursive: true, force: true });
}
