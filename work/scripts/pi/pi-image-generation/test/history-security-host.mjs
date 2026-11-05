import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { svgXml } from './advanced-fixtures.mjs';

/** Real files and real Pi OSC 8 decoding. No auth/fetch or external viewers. */
export async function runHistorySecurityHostChecks({ t, jiti, sdk, dir, themeModule }) {
 const { createResultView } = await jiti.import('../src/result-view.ts');
 const { saveGeneratedImages } = await jiti.import('../src/image-files.ts');
 const { SVG_MAX_BYTES } = await jiti.import('../src/svg.ts');
 const { initTheme } = await import(sdk);
 const { getCapabilities, setCapabilities, visibleWidth, stripTerminalSequences, getOsc8LinkAtColumn } = await jiti.import('@earendil-works/pi-tui');
 const capabilities = getCapabilities();
 const root = path.join(dir, 'history-security'), output = path.join(root, '.pi', 'generated-images');
 fs.mkdirSync(output, { recursive: true });
 const svg = Buffer.from(svgXml), gif = fs.readFileSync(new URL('./fixtures/native-two-frame.gif', import.meta.url));
 const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh9kAAAAASUVORK5CYII=', 'base64');
 const entry = (filePath, mimeType, kind) => ({ provider: 'openai', model: 'gpt-image-2.6-flare', prompt: 'offline', path: filePath, mimeType, kind, bytes: 1, createdAt: 0 });
 const write = (name, bytes) => { const p = path.join(output, name); fs.writeFileSync(p, bytes); return p; };
 const settings = function* () { for (const appearance of ['dark', 'light']) for (const hyperlinks of [true, false]) for (const images of [null, 'kitty', 'iterm2']) yield { appearance, hyperlinks, images }; };
 function check(data, allowed, { appearance = 'dark', hyperlinks = true, images = 'kitty' } = {}, createView = createResultView) {
  initTheme(appearance, false); setCapabilities({ images, hyperlinks, trueColor: true });
  const view = createView(data, themeModule.theme);
  const expectedUrl = typeof data?.path === 'string' ? pathToFileURL(path.resolve(data.path)).href : undefined;
  for (const width of [24, 40, 80, 120]) {
   const lines = view.render(width), raw = lines.join('\n');
   assert.ok(lines.every(line => visibleWidth(line) <= width), `history width ${width}`);
   const text = lines.map(line => stripTerminalSequences(line).trimEnd()).join('');
   const targets = new Set();
   for (const line of lines) for (let col = 0; col < visibleWidth(line); col++) {
    const target = getOsc8LinkAtColumn(line, col); if (target !== undefined) targets.add(target);
   }
   if (allowed) {
    assert.ok(text.includes(expectedUrl), 'validated history keeps the exact file URL');
    assert.deepEqual([...targets], hyperlinks ? [expectedUrl] : [], 'actual OSC 8 targets, not just a warning assertion');
    assert.match(text, /打开原图/);
   } else {
    assert.deepEqual([...targets], [], 'unsafe history must have no OSC 8 target');
    assert.doesNotMatch(raw, /\x1b\]8;/, 'unsafe history must not emit even an OSC 8 opener');
    assert.ok(!expectedUrl || !text.includes(expectedUrl), 'unsafe history must not expose a fallback file URI');
    assert.doesNotMatch(text, /打开原图|复制 URL/);
    assert.match(text, /当前历史文件无法安全预览/);
    if (typeof data?.path === 'string' && !/[\x00-\x1f\x7f-\x9f]/.test(data.path)) {
     assert.ok(text.replace(/\s/g, '').includes(data.path.replace(/\s/g, '')), 'keep non-clickable path text');
    }
   }
   if (data?.mimeType === 'image/svg+xml' || data?.mimeType === 'image/gif' || !allowed) assert.doesNotMatch(raw, /\x1b_G|\x1b\]1337;File=/);
   view.invalidate();
  }
  return view;
 }
 try {
  await t.test('history security: valid SVG/GIF and legacy kind-free entries keep exact links without terminal rendering in both themes/all widths', () => {
   for (const [name, bytes, mime, kind] of [['合法 SVG 空格 # %.svg', svg, 'image/svg+xml', 'vector'], ['合法 GIF 空格 # %.gif', gif, 'image/gif', 'animation']]) {
    const p = write(name, bytes);
    for (const options of settings()) for (const k of [kind, undefined]) check(JSON.parse(JSON.stringify(entry(p, mime, k))), true, options);
    assert.deepEqual(fs.readFileSync(p), bytes);
   }
  });

  await t.test('history security: invalid/script/external-resource/oversized SVG never gets a link', () => {
   const cases = [
    '<svg', '', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.test/private.png"/></svg>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///private">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(https://example.test/x)"/></svg>',
    Buffer.alloc(SVG_MAX_BYTES + 1, 32),
   ];
   cases.forEach((bytes, i) => {
    const p = write(`unsafe-${i}.svg`, bytes), before = fs.readFileSync(p);
    for (const options of settings()) check(entry(p, 'image/svg+xml'), false, options);
    assert.deepEqual(fs.readFileSync(p), before, 'renderer must not clean, delete or overwrite the file');
   });
  });

  await t.test('history security: saved SVG/GIF tampered after save are rejected on history load without changing the files', async () => {
   for (const [bytes, mimeType, replacement] of [[svg, 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')], [gif, 'image/gif', gif.subarray(0, gif.length - 1)]]) {
    const [saved] = await saveGeneratedImages(root, 'openai', 'gpt-image-2.6-flare', [{ data: bytes.toString('base64'), mimeType }]);
    const data = { ...entry(saved.path, mimeType, saved.kind), bytes: saved.bytes };
    check(data, true);
    fs.writeFileSync(saved.path, replacement);
    const before = fs.readdirSync(output).sort();
    for (const options of settings()) check(data, false, options);
    assert.deepEqual(fs.readFileSync(saved.path), replacement);
    assert.deepEqual(fs.readdirSync(output).sort(), before);
   }
  });

  await t.test('history security: corrupt/oversized/missing GIF, directories and missing SVG have no links', () => {
   const corrupt = write('corrupt.gif', gif.subarray(0, 30));
   const oversized = write('oversized.gif', gif); fs.truncateSync(oversized, 32 * 1024 * 1024 + 1);
   const folder = path.join(output, 'directory.gif'); fs.mkdirSync(folder);
   for (const options of settings()) {
    for (const p of [corrupt, oversized, folder, path.join(output, 'missing.gif')]) check(entry(p, 'image/gif'), false, options);
    check(entry(path.join(output, 'missing.svg'), 'image/svg+xml'), false, options);
   }
  });

  await t.test('history security: malformed metadata, escaped paths, wrong real type and injected OSC controls cannot provide opening links', () => {
   const p = write('metadata.svg', svg), good = entry(p, 'image/svg+xml');
   const outside = path.join(root, 'outside.svg'); fs.writeFileSync(outside, svg);
   const fakeSvg = write('actual-raster.svg', png), fakeGif = write('actual-xml.gif', svg);
   for (const data of [undefined, null, [], { ...good, bytes: -1 }, { ...good, createdAt: NaN }, { ...good, model: 1 }, { ...good, model: 'file:///unsafe.svg' }, { ...good, model: '\x1b]8;;https://example.test/\x1b\\' }, { ...good, provider: 'https://example.test/' }, { ...good, kind: 'unknown' }, { ...good, kind: 'animation' }, { ...good, mimeType: 'text/html' }, { ...good, path: outside }, { ...good, path: '.pi/generated-images/relative.svg' }, { ...good, path: path.join(output, '..', 'escaped.svg') }, { ...good, path: fakeSvg }, entry(fakeGif, 'image/gif'), { ...good, path: path.join(output, 'escape\x1b]8;;https://example.test/\x1b\\.svg') }]) check(data, false);
   check(good, true);
   const view = createResultView(good, themeModule.theme);
   good.path = outside; good.model = '\x1b]8;;https://example.test/\x1b\\';
   const rendered = view.render(1000).join('');
   assert.ok(rendered.includes(pathToFileURL(p).href), 'validated link must capture the original path');
   assert.ok(!rendered.includes(pathToFileURL(outside).href));
   assert.doesNotMatch(rendered, /https:\/\/example.test/);
  });

  await t.test('history security: file symlinks and project/.pi/output directory symlinks or junctions are refused', async () => {
   const target = write('symlink-target.svg', svg), gifTarget = write('symlink-target.gif', gif);
   for (const [source, mime] of [[target, 'image/svg+xml'], [gifTarget, 'image/gif']]) {
    const link = path.join(output, `file-link${path.extname(source)}`);
    try { fs.symlinkSync(source, link, 'file'); check(entry(link, mime), false); }
    catch (error) {
     if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
     // Windows without Developer Mode/admin cannot create file symlinks. Exercise
     // the actual lstat rejection branch via an explicit API simulation instead.
     t.diagnostic(`file symlink ${path.extname(source)}: creation EPERM; lstat simulation; directory junctions below are real`);
     fs.copyFileSync(source, link);
     const original = fs.lstatSync; let observations = 0;
     const mock = t.mock.method(fs, 'lstatSync', function(p, ...args) {
      const stats = original.call(this, p, ...args);
      if (p === link) { observations++; stats.isSymbolicLink = () => true; stats.isFile = () => false; }
      return stats;
     });
     syncBuiltinESMExports();
     try {
      const { createResultView: checkedView } = await jiti.import('../src/result-view.ts');
      check(entry(link, mime), false, {}, checkedView);
     } finally { mock.mock.restore(); syncBuiltinESMExports(); }
     assert.ok(observations > 0, 'simulated lstat must actually be observed');
    }
   }
   const type = process.platform === 'win32' ? 'junction' : 'dir';
   const rootLink = path.join(dir, 'history-root-link'); fs.symlinkSync(root, rootLink, type);
   check(entry(path.join(rootLink, '.pi', 'generated-images', path.basename(target)), 'image/svg+xml'), false);
   const piRoot = path.join(dir, 'history-pi-link'); fs.mkdirSync(piRoot);
   fs.symlinkSync(path.join(root, '.pi'), path.join(piRoot, '.pi'), type);
   check(entry(path.join(piRoot, '.pi', 'generated-images', path.basename(target)), 'image/svg+xml'), false);
   const outRoot = path.join(dir, 'history-output-link'); fs.mkdirSync(path.join(outRoot, '.pi'), { recursive: true });
   fs.symlinkSync(output, path.join(outRoot, '.pi', 'generated-images'), type);
   check(entry(path.join(outRoot, '.pi', 'generated-images', path.basename(target)), 'image/svg+xml'), false);
   assert.deepEqual(fs.readFileSync(target), svg); assert.deepEqual(fs.readFileSync(gifTarget), gif);
  });

  await t.test('history security: file and directory replacement between lstat/open/read cannot inherit a checked link', async () => {
   for (const replaceDirectory of [false, true]) {
    const r = path.join(dir, `history-race-${replaceDirectory}`), out = path.join(r, '.pi', 'generated-images'); fs.mkdirSync(out, { recursive: true });
    const p = path.join(out, 'race.svg'); fs.writeFileSync(p, svg);
    const realOpen = fs.openSync; let swapped = 0;
    const mock = t.mock.method(fs, 'openSync', function(filePath, ...args) {
     if (filePath === p && !swapped) {
      swapped++;
      if (replaceDirectory) { fs.renameSync(out, out + '-old'); fs.mkdirSync(out); }
      else fs.renameSync(p, p + '.old');
      fs.writeFileSync(p, svg); // Still valid XML: identity, not just content, must be checked.
     }
     return realOpen.call(this, filePath, ...args);
    });
    syncBuiltinESMExports();
    try {
     const { createResultView: checkedView } = await jiti.import('../src/result-view.ts');
     check(entry(p, 'image/svg+xml'), false, {}, checkedView);
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(swapped, 1, 'race hook must actually run');
    assert.deepEqual(fs.readFileSync(p), svg);
   }
  });

  await t.test('history security: bounded descriptor reads reject growth and close the file even on failure', async () => {
   const p = write('growing.svg', svg), realOpen = fs.openSync, realRead = fs.readSync, realClose = fs.closeSync;
   let tracked, reads = 0, closes = 0, maximumRead = 0;
   const opens = t.mock.method(fs, 'openSync', function(filePath, ...args) { const fd = realOpen.call(this, filePath, ...args); if (filePath === p) tracked = fd; return fd; });
   const reading = t.mock.method(fs, 'readSync', function(fd, buffer, offset, length, position) {
    if (fd === tracked) { if (reads++ === 0) fs.appendFileSync(p, Buffer.alloc(1024 * 1024, 32)); maximumRead = Math.max(maximumRead, length); }
    return realRead.call(this, fd, buffer, offset, length, position);
   });
   const closing = t.mock.method(fs, 'closeSync', function(fd) { if (fd === tracked) closes++; return realClose.call(this, fd); });
   syncBuiltinESMExports();
   try {
    const { createResultView: checkedView } = await jiti.import('../src/result-view.ts');
    check(entry(p, 'image/svg+xml'), false, {}, checkedView);
   } finally { opens.mock.restore(); reading.mock.restore(); closing.mock.restore(); syncBuiltinESMExports(); }
   assert.ok(reads > 0); assert.equal(closes, 1); assert.equal(maximumRead, svg.length + 1);
   assert.equal(fs.statSync(p).size, svg.length + 1024 * 1024, 'view must not truncate the changed file');
  });

  await t.test('history security: legacy static PNG previews and links remain available, while corrupt static files no longer get links', () => {
   const p = write('legacy-preview.png', png);
   for (const appearance of ['dark', 'light']) for (const images of [null, 'kitty']) {
    check(entry(p, 'image/png'), true, { appearance, images, hyperlinks: true });
    const raw = createResultView(entry(p, 'image/png'), themeModule.theme).render(80).join('');
    if (images) assert.match(raw, /\x1b_G/); else assert.match(raw, /当前终端不支持图片预览/);
   }
   check(entry(write('broken.png', 'invalid'), 'image/png'), false);
   check(entry(path.join(output, 'missing.png'), 'image/png'), false);
  });
 } finally {
  setCapabilities(capabilities); initTheme('dark', false);
 }
}
