// Explicit online-acceptance helper, never imported by production code.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
export const MAX_ACCEPTANCE_RESPONSE_BYTES = 48 * 1024 * 1024;
export const sha256 = value => createHash('sha256').update(value).digest('hex');

/** One exact approved POST per instance. No retry, permissive fallback or body logging. */
export function createAcceptanceFetch({ url, body, fetch: networkFetch, beforeAttempt = async () => {}, onResponse = () => {}, maxBytes = MAX_ACCEPTANCE_RESPONSE_BYTES }) {
 if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ACCEPTANCE_RESPONSE_BYTES) throw new Error('Invalid acceptance byte limit');
 if (!['https://chatgpt.com/backend-api/codex/images/edits', 'https://chatgpt.com/backend-api/codex/images/generations'].includes(url) || typeof networkFetch !== 'function') throw new Error('Invalid acceptance target');
 const expectedBody = structuredClone(body);
 let consumed = false, attempts = 0;
 const fetch = async (target, init = {}) => {
  if (consumed) throw new Error('Acceptance request slot already consumed; no retry');
  consumed = true;
  init.signal?.throwIfAborted();
  let actual;
  try { actual = typeof init.body === 'string' ? JSON.parse(init.body) : undefined; } catch { /* generic failure below */ }
  if (String(target) !== url || init.method !== 'POST' || init.redirect !== 'error' || !isDeepStrictEqual(actual, expectedBody)) throw new Error('Request does not match approved acceptance plan');
  await beforeAttempt(); // durable reservation BEFORE invoking a network function
  init.signal?.throwIfAborted();
  attempts++;
  const response = await networkFetch(target, init);
  const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  const ids = {};
  for (const header of ['x-codex-imagegen-request-id', 'x-request-id']) {
   const value = response.headers.get(header); ids[header] = value ? `sha256:${sha256(value)}` : null;
  }
  onResponse({ status: response.status, contentType: type === 'application/json' ? type : 'other', requestIds: ids });
  if (init.signal?.aborted || response.redirected || (response.url && response.url !== url) || type !== 'application/json' || !response.body) {
   void response.body?.cancel().catch(() => {});
   init.signal?.throwIfAborted();
   throw new Error('Unexpected acceptance response protocol; stopped without retry');
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
   void response.body.cancel().catch(() => {});
   throw new Error('Acceptance response exceeds byte limit');
  }
  // Actual decoded response bytes are counted, independent of Content-Length.
  const reader = response.body.getReader(); let stopped = false, received = 0, abort;
  const cleanup = () => init.signal?.removeEventListener('abort', abort);
  const stop = () => {
   if (stopped) return; stopped = true; cleanup();
   void reader.cancel().catch(() => {}).finally(() => { try { reader.releaseLock(); } catch {} });
  };
  const stream = new ReadableStream({
   start(controller) {
    abort = () => { if (!stopped) { controller.error(new DOMException('Acceptance cancelled', 'AbortError')); stop(); } };
    init.signal?.addEventListener('abort', abort, { once: true });
    if (init.signal?.aborted) abort();
   },
   async pull(controller) {
    try {
     const chunk = await reader.read();
     if (stopped) return;
     if (chunk.done) { stopped = true; cleanup(); reader.releaseLock(); controller.close(); return; }
     received += chunk.value.byteLength;
     if (received > maxBytes) throw new Error('Acceptance response exceeds byte limit');
     controller.enqueue(chunk.value);
    } catch (error) {
     if (!stopped) { controller.error(error instanceof Error && error.message === 'Acceptance response exceeds byte limit' ? error : new Error('Acceptance response stream failed')); stop(); }
    }
   },
   cancel() { stop(); },
  }, { highWaterMark: 0 });
  // Preserve protocol payload exactly; only metadata is observed, never dumped.
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
 };
 return { fetch, get attempts() { return attempts; } };
}
