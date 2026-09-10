// Explicit opt-in, one paid image POST maximum. Never prints credentials/payloads.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
if (process.argv[2] !== '--confirm-one-paid-request') throw new Error('Explicit confirmation required');
const localRequire = createRequire(import.meta.url);
const sdk = pathToFileURL(localRequire.resolve('@earendil-works/pi-coding-agent')).href;
const require = createRequire(sdk);
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
const { configureHttpDispatcher } = await import(new URL('./core/http-dispatcher.js', sdk));
const { getGlobalDispatcher } = require('undici');
const { readLiveCodexCredential } = await jiti.import('../../pi-codex-official/extensions/codex-auth.ts');
const { generateOpenAICodexImages } = await jiti.import('../src/openai-codex-images.ts');
const { saveGeneratedImages } = await jiti.import('../src/image-files.ts');
const { createDiagnosticWriter } = await jiti.import('../src/diagnostics.ts');
const cwd = fileURLToPath(new URL('../../../../../', import.meta.url));
configureHttpDispatcher();
let calls = 0;
const started = performance.now();
const summary = { mode: 'plugin-live', model: 'gpt-image-2', size: 'auto', quality: 'auto', references: 0 };
try {
 const credential = readLiveCodexCredential();
 const result = await generateOpenAICodexImages({
  apiKey: credential.access, baseUrl: 'https://chatgpt.com/backend-api/codex', model: summary.model,
  prompt: 'A single red circle centered on a plain white background.', images: [], size: summary.size, quality: summary.quality,
  signal: AbortSignal.timeout(300000), onDiagnostic: createDiagnosticWriter(cwd),
  fetch: async (url, init) => {
   if (++calls > 1) throw new Error('More than one request blocked');
   return globalThis.fetch(url, init);
  },
 });
 const saved = await saveGeneratedImages(cwd, 'openai', summary.model, result.images, new AbortController().signal);
 summary.status = 'success'; summary.saved = saved.map(x => x.path ?? x.filePath);
 summary.images = result.images.length;
} catch (error) {
 // Adapter errors already sanitize credentials/prompt. Pre-request credential errors
 // intentionally emit only a category, never raw authentication file content.
 summary.status = 'failed';
 summary.error = calls ? error.message : 'Pre-request setup/credential validation failed; no request sent';
} finally {
 summary.calls = calls; summary.elapsedMs = Math.round(performance.now() - started);
 console.log(JSON.stringify(summary, null, 2));
 await writeFile(path.join(cwd, 'plans/openai-image-live-probe-result.json'), JSON.stringify(summary, null, 2) + '\n');
 await getGlobalDispatcher().close();
}
