// One-off operator-approved M1/S1 runner. NOT an npm script or production entry.
// Offline rehearsal: node test/codex-online-acceptance.mjs --offline
// Live M1:          node test/codex-online-acceptance.mjs --execute M1
// Live S1:          --execute S1 --m1-reviewed (ONLY after operator visual confirmation)
// Current explicit follow-up approval also allows --operator-resume-after-M1-size-anomaly.
// That flag preserves the M1 anomaly and does NOT claim an operator visual pass.
// This ledger is tied to the explicit 2026-11-05 conversation approval, never auto-reset.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAcceptanceFetch, sha256 } from './acceptance-guard.mjs';
import { resolveSdkUrl, siblingEntry } from './sdk.mjs';

const report = console.log.bind(console);
let actualExternalImageCalls = 0;
const promptHashes = { M1: 'ccba6c27566c8a5e6580eacc573d0109b9181f6121b1a042e97a7c03beaeddd8', S1: 'da3d843450e1a59d7884453efb6a9ceabaa143f56686248b1c250627708e85eb' };
const plugin = fileURLToPath(new URL('../', import.meta.url));
const repo = path.resolve(plugin, '../../../..');
const fixtureHashes = {
 original: 'db39e85282b51566923d08a099eb360b7a7b7da0126200fa0d650aab023f7e01',
 markup: '344bce2e1fb0696295c2a049f4f4ea06b1ccde52fbf920afd5d8fe39367635c1',
};
function privateDirectory(p) {
 mkdirSync(p, { recursive: true, mode: 0o700 });
 const s = lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Unsafe acceptance directory');
}
function recordFile(p, value) {
 const temp = `${p}.tmp`;
 writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
 renameSync(temp, p);
}

async function main() {
 const args = process.argv.slice(2), offline = args.length === 1 && args[0] === '--offline';
 const stage = offline ? 'M1' : args[0] === '--execute' && ['M1', 'S1'].includes(args[1]) ? args[1] : undefined;
 const resumeAfterSizeAnomaly = stage === 'S1' && args[2] === '--operator-resume-after-M1-size-anomaly';
 if (!stage || (!offline && (args.length !== (stage === 'M1' ? 2 : 3) || (stage === 'S1' && args[2] !== '--m1-reviewed' && !resumeAfterSizeAnomaly)))) throw new Error('Explicit --offline or approved --execute stage required');
 // Keep third-party diagnostics from printing unreviewed auth objects or bodies.
 for (const name of ['log', 'info', 'warn', 'error', 'debug']) console[name] = () => {};
 // No incidental model/catalog/image calls during SDK import or local preparation.
 globalThis.fetch = async () => { throw new Error('Unapproved network operation blocked'); };
 const sdkUrl = resolveSdkUrl(), requireHost = createRequire(sdkUrl);
 const sdk = await import(sdkUrl);
 const { createJiti } = requireHost('jiti');
 const jiti = createJiti(import.meta.url, { moduleCache: true, fsCache: false, alias: {
  '@earendil-works/pi-coding-agent': fileURLToPath(sdkUrl),
  '@earendil-works/pi-ai': siblingEntry(sdkUrl, '@earendil-works/pi-ai'),
  '@earendil-works/pi-tui': siblingEntry(sdkUrl, '@earendil-works/pi-tui'),
 } });
 const { readImageConfig } = await jiti.import('../src/model-config.ts');
 const { prepareMarkupEdit } = await jiti.import('../src/markup.ts');
 const { buildOpenAICodexRequest } = await jiti.import('../src/openai-codex-images.ts');
 const { resolveImageCommand } = await jiti.import('../src/command.ts');
 const { generateAndSave } = await jiti.import('../src/runtime.ts');
 const { resolveImageAuth } = await jiti.import('../src/credentials.ts');
 const { createResultView } = await jiti.import('../src/result-view.ts');
 const tui = await jiti.import('@earendil-works/pi-tui');
 const plan = readFileSync(path.join(plugin, 'CODEX-ONLINE-ACCEPTANCE.md'), 'utf8');
 const prompts = [...plan.matchAll(/^> (.+)$/gm)].map(m => m[1]);
 const prompt = prompts.find(p => p.startsWith(stage === 'M1' ? 'Recolor only the circular object' : 'Create a minimal flat vector icon'));
 if (!prompt || sha256(prompt) !== promptHashes[stage]) throw new Error('Approved public prompt is unavailable or changed');
 const config = structuredClone(await readImageConfig());
 for (const m of config.models) for (const policy of Object.values(m.nativeCapabilities ?? {})) assert.equal(policy.enabled, false);
 const model = config.models.find(m => m.key === 'openai-flare-26');
 assert.equal(model?.id, 'gpt-image-2.6-flare');
 model.nativeCapabilities[stage === 'M1' ? 'markup' : 'svg'].enabled = true; // in-memory ONLY
 const source = readFileSync(path.join(plugin, 'test/fixtures/codex-acceptance-original.png'));
 const overlay = readFileSync(path.join(plugin, 'test/fixtures/codex-acceptance-markup.png'));
 assert.equal(sha256(source), fixtureHashes.original); assert.equal(sha256(overlay), fixtureHashes.markup);
 const image = bytes => ({ data: bytes.toString('base64'), mimeType: 'image/png' });
 const images = stage === 'M1' ? [{ type: 'image', ...image(source) }] : [];
 const fields = { prompt, help: false, size: '1024x1024', quality: 'low', complexity: 'low', background: 'opaque', outputFormat: stage === 'M1' ? 'png' : 'svg', ...(stage === 'M1' ? { markup: image(overlay) } : {}) };
 const command = resolveImageCommand(fields, model, images.length, config);
 const prepared = stage === 'M1' ? await prepareMarkupEdit(model, images, fields.markup) : { images: [] };
 const fakeToken = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'OFFLINE-SHAPE-ONLY' } })).toString('base64url')}.signature`;
 const expected = buildOpenAICodexRequest({ ...command, ...prepared, apiKey: fakeToken, baseUrl: 'https://chatgpt.com/backend-api/codex' });
 assert.deepEqual(Object.keys(expected.body).sort(), ['prompt', 'background', 'model', 'n', 'quality', 'size', 'complexity', ...(stage === 'M1' ? ['images', 'markup'] : ['output_format'])].sort());
 // No credential was resolved and no external image request has occurred above.
 let workspace, ledgerPath, lockPath, lock, ledger, runtime, dispatcher, ownsStage = false;
 let guard, oauthRequests = 0, authCalls = 0;
 const abort = new AbortController(), timer = setTimeout(() => abort.abort(new DOMException('Acceptance timed out', 'TimeoutError')), 300_000);
 const cancel = () => abort.abort(new DOMException('Acceptance cancelled', 'AbortError'));
 process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
 try {
  if (offline) {
   workspace = await mkdtemp(path.join(tmpdir(), 'pi-acceptance-offline-'));
   ledger = { mode: 'offline', approved: ['M1', 'S1'], attempts: 0, stages: {} };
  } else {
   for (const folder of [path.join(repo, '.pi'), path.join(repo, '.pi/image-generation-logs'), path.join(repo, '.pi/image-generation-logs/acceptance-M1-S1-20261105')]) privateDirectory(folder);
   workspace = path.join(repo, '.pi/image-generation-logs/acceptance-M1-S1-20261105');
   ledgerPath = path.join(workspace, 'ledger.json'); lockPath = path.join(workspace, '.execution.lock');
   lock = openSync(lockPath, 'wx', 0o600); // crash => retained lock, never stale-released automatically
   if (existsSync(ledgerPath)) {
    const stats = lstatSync(ledgerPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink > 1 || stats.size > 64 * 1024) throw new Error('Unsafe acceptance ledger');
   }
   ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : {
    mode: 'live', approval: 'Operator: M1+S1; current Pi openai-codex OAuth; each <=1; 2026-11-05 conversation',
    approved: ['M1', 'S1'], attempts: 0, stages: {}, stopped: false,
   };
   assert.equal(ledger.mode, 'live');
   if (resumeAfterSizeAnomaly) {
    assert.equal(ledger.stopped, true); assert.equal(ledger.attempts, 1);
    assert.equal(ledger.stages.M1?.http?.status, 200);
    assert.equal(ledger.stages.M1?.localValidation, 'passed');
    assert.equal(ledger.stages.M1?.acceptance, 'CODEX_ONLINE_BEHAVIOR_ANOMALY');
    assert.equal(ledger.stopReason, 'M1 decoded dimensions differ from explicit size; S1 not attempted under whole-round stop conditions.');
    ledger.continuations = [...(ledger.continuations ?? []), { at: new Date().toISOString(), operatorInstruction: '无需暂停，继续s1', scope: 'S1 only; one request; no retry; total cap remains 2', priorStopReason: ledger.stopReason, M1VisualPass: false }];
    ledger.stopped = false;
    ledger.stages.M1.humanReview = 'not confirmed; operator explicitly directed S1 despite disclosed dimension anomaly';
   }
   assert.equal(ledger.stopped, false);
   assert.ok(ledger.attempts < 2 && !ledger.stages[stage], 'Attempt already recorded; no retry');
   if (stage === 'S1' && !resumeAfterSizeAnomaly) {
    assert.equal(ledger.stages.M1?.state, 'awaiting-human-review');
    ledger.stages.M1.humanReview = 'operator-confirmed-before-S1';
   }
   runtime = await sdk.ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
   const stored = (await runtime.listCredentials()).filter(c => c.providerId === 'openai-codex');
   assert.equal(stored.length, 1); assert.equal(stored[0].type, 'oauth');
   assert.equal((await runtime.checkAuth('openai-codex'))?.type, 'oauth');
   const http = await import(new URL('./core/http-dispatcher.js', sdkUrl));
   http.configureHttpDispatcher(); // same installed Pi dispatcher/proxy handling, no TLS overrides
   const undici = requireHost('undici'); dispatcher = undici.getGlobalDispatcher();
  }
  const networkFetch = globalThis.fetch.bind(globalThis);
  // Only the existing SDK OAuth refresh endpoint may use global fetch. Images must
  // use the per-request exact-body, single-attempt guarded fetch below.
  globalThis.fetch = async (target, init) => {
   if (!offline && String(target) === 'https://auth.openai.com/oauth/token' && init?.method === 'POST') {
    oauthRequests++; return networkFetch(target, init);
   }
   throw new Error('Unapproved global network operation blocked');
  };
  const item = { test: stage, model: model.id, endpoint: expected.url, parameters: { n: 1, size: '1024x1024', quality: 'low', complexity: 'low', background: 'opaque', outputFormat: fields.outputFormat }, fixtureHashes: stage === 'M1' ? fixtureHashes : undefined, state: 'prepared', http: null };
  ledger.stages[stage] = item; ownsStage = true;
  const persist = () => { if (!offline) recordFile(ledgerPath, ledger); };
  persist();
  guard = createAcceptanceFetch({ url: expected.url, body: expected.body,
   fetch: offline ? async () => Response.json({ data: [{ b64_json: source.toString('base64') }] }) : async (target, init) => { actualExternalImageCalls++; return networkFetch(target, init); },
   beforeAttempt: async () => {
    item.state = 'attempt-reserved'; item.startedAt = new Date().toISOString(); ledger.attempts++;
    persist(); // conservative durable slot; a crash cannot authorize a replay
   },
   onResponse: meta => { item.http = meta; persist(); },
  });
  const registry = !offline ? new sdk.ModelRegistry(runtime) : undefined;
  const key = Symbol.for('pi-image-generation.task-state');
  const state = globalThis[key] ??= { busy: false, cancelling: false };
  if (state.busy) throw new Error('Image operation already running');
  state.busy = true;
  try {
   const outcome = await generateAndSave(config, command, images, workspace, async () => {
    authCalls++;
    return offline ? { apiKey: fakeToken, baseUrl: 'https://chatgpt.com/backend-api/codex' } : resolveImageAuth(command.providerConfig, sdk.getAgentDir(), registry);
   }, abort.signal, guard.fetch);
   assert.equal(guard.attempts, 1); assert.equal(actualExternalImageCalls, offline ? 0 : 1); assert.equal(outcome.entries.length, 1);
   const entry = outcome.entries[0], bytes = readFileSync(entry.path);
   item.actualType = entry.mimeType;
   item.artifact = offline ? 'temporary-offline-fixture' : path.relative(repo, entry.path).split(path.sep).join('/');
   item.artifactSha256 = sha256(bytes); item.localValidation = 'plugin-saved; extra-check-pending'; persist();
   assert.equal(entry.mimeType, stage === 'M1' ? 'image/png' : 'image/svg+xml');
   // A real raster decode checks M1's returned PNG in this test only; production
   // output validation is unchanged. No SVG is sent to a renderer or native codec.
   let dimensions;
   if (stage === 'M1') {
    const { default: sharp } = await import('sharp');
    const decoded = await sharp(bytes, { limitInputPixels: 16_777_216, failOn: 'warning' }).raw().toBuffer({ resolveWithObject: true });
    dimensions = { width: decoded.info.width, height: decoded.info.height };
   }
   tui.setCapabilities({ images: null, hyperlinks: true, trueColor: true });
   const theme = { fg: (_token, value) => value, underline: value => value };
   const rendered = createResultView(entry, theme).render(2000).join('');
   assert.ok(rendered.includes(pathToFileURL(entry.path).href), 'Saved result must have a checked history link');
   item.state = 'awaiting-human-review'; item.actualType = entry.mimeType; item.dimensions = dimensions;
   item.artifact = offline ? 'temporary-offline-fixture' : path.relative(repo, entry.path).split(path.sep).join('/');
   item.artifactSha256 = sha256(bytes); item.localValidation = 'passed'; item.historyRendererLink = true;
   item.mainPiSessionHistoryPublished = false; item.humanReview = 'pending'; item.finishedAt = new Date().toISOString();
   if (!offline && ledger.attempts >= 2) { ledger.stopped = true; ledger.stopReason = 'Authorized total hard cap reached; no further image requests'; }
   persist();
  } finally { state.busy = false; state.cancelling = false; }
  report(JSON.stringify({ mode: ledger.mode, test: stage, imageAttemptsThisStage: guard.attempts, totalReservedAttempts: ledger.attempts, actualExternalImageCalls, oauthRefreshRequests: oauthRequests, authCalls, result: item }, null, 2));
 } catch (error) {
  if (ledger && ownsStage) {
   const item = ledger.stages[stage];
   item.state = 'stopped'; item.finishedAt = new Date().toISOString();
   item.failure = guard?.attempts ? item.http?.status >= 400 ? 'HTTP_REJECTED' : item.http ? 'PROTOCOL_OR_LOCAL_VALIDATION_FAILED' : 'NETWORK_OUTCOME_UNKNOWN' : 'LOCAL_PREFLIGHT_FAILED';
   item.errorFlags = { mentionsMarkup: /markup/i.test(String(error?.message)), unknownParameter: /unknown|unrecognized|unexpected.*(?:field|parameter)/i.test(String(error?.message)), timeout: abort.signal.aborted };
   ledger.stopped = true; if (ledgerPath) recordFile(ledgerPath, ledger);
   report(JSON.stringify({ mode: ledger.mode, test: stage, imageAttemptsThisStage: guard?.attempts ?? 0, totalReservedAttempts: ledger.attempts, oauthRefreshRequests: oauthRequests, authCalls, result: item, remainingStages: 'STOPPED; no automatic S1 or retry' }, null, 2));
  } else report(JSON.stringify({ mode: offline ? 'offline' : 'live', test: stage, state: 'local-preflight-blocked; prior ledger untouched', actualExternalImageCalls }));
  process.exitCode = 1;
 } finally {
  clearTimeout(timer); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  if (dispatcher) await dispatcher.destroy();
  if (lock !== undefined) { closeSync(lock); rmSync(lockPath); }
  if (offline && workspace) await rm(workspace, { recursive: true, force: true });
 }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
 await main().catch(error => {
  const location = /codex-online-acceptance\.mjs:(\d+):(\d+)/.exec(String(error?.stack));
  report(JSON.stringify({ state: actualExternalImageCalls ? 'execution-stopped; consult durable ledger; no retry' : 'local-preflight-failed', actualExternalImageCalls, errorClass: /^[A-Za-z]+$/.test(error?.name) ? error.name : 'Error', runnerLine: location ? Number(location[1]) : null, details: 'not printed to protect credentials and payloads' })); process.exitCode = 1;
 });
}
