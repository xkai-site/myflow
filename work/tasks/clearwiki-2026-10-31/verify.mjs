/** Check this cleanup against local files and the pre-cleanup Git snapshot. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const record = 'work/tasks/clearwiki-2026-10-31';
const reportFile = process.argv[2] || `${record}/results/document-check.json`;
const normalize = text => text.replaceAll('\r\n', '\n');
const read = file => readFileSync(path.join(root, file), 'utf8');
const original = file => execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8', windowsHide: true });
const files = [];
function visit(directory = '') {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    if (['.git', '.pi', 'node_modules'].includes(entry.name)) continue;
    const file = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (file.endsWith('.md')) files.push(file);
  }
}
visit();
const errors = [];
let links = 0;
for (const file of files) {
  const source = read(file);
  if (source.includes('\uFFFD')) errors.push(`${file}: replacement character`);
  const fences = source.match(/^\s*```/gm) || [];
  if (fences.length % 2) errors.push(`${file}: unpaired code fence`);
  const prose = source.replace(/^\s*```[^\n]*\n[\s\S]*?^\s*```\s*$/gm, '');
  for (const match of prose.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split(/\s+"/)[0];
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
    const filePart = decodeURIComponent(target.split('#')[0]);
    if (!filePart) continue;
    links++;
    if (!existsSync(path.resolve(path.dirname(path.join(root, file)), filePart))) errors.push(`${file}: missing ${target}`);
  }
}

const preserved = [
  'plans/archive/pi-image-generation/clash-https-probe-result.json',
  'plans/archive/pi-image-generation/host-dispatcher-direct-result.json',
  'plans/archive/pi-image-generation/host-dispatcher-tunnel-result.json',
  'plans/archive/pi-image-generation/openai-image-live-probe-result.json',
  'plans/archive/pi-image-generation/openai-image-request-investigation.md',
  'plans/archive/pi-image-generation/openai-image-async-client-research.md',
  'plans/archive/pi-notification/pi-notification-ux/findings.md',
  'plans/archive/pi-notification/pi-notification-ux/progress.md',
  'work/scripts/pi/pi-edit-fallback/test/results/VERIFICATION.md',
  'work/scripts/pi/pi-edit-fallback/test/results/offline.log',
];
for (const file of preserved) assert.equal(normalize(read(file)), normalize(original(file)), `Original material changed: ${file}`);

const excerpts = [
  ['plans/archive/pi-image-generation/image-generation-model-config.md', '## Execution log', undefined, 'plans/archive/pi-image-generation/model-config-verification.md'],
  ['plans/archive/pi-usage-openai/README.md', '## Verification', '## 已确认决策', 'plans/archive/pi-usage-openai/verification-history.md'],
  ['plans/archive/pi-notification/pi-notification-plugin-design.md', '## 18. S0 实测结论', '## 19. 正文内容字段', 'plans/archive/pi-notification/verification-history.md'],
  ['plans/archive/pi-notification/pi-notification-plugin-m2.md', '## Verification', '## 下一个里程碑', 'plans/archive/pi-notification/verification-history.md'],
  ['plans/archive/pi-notification/pi-notification-ux.md', '## 实施结果与差异', undefined, 'plans/archive/pi-notification/verification-history.md'],
  ['plans/archive/pi-notification/pi-notification-progressive-ui.md', '## Progress', undefined, 'plans/archive/pi-notification/verification-history.md'],
  ['plans/archive/pi-notification/polish-tests-and-comments.md', '## 执行结果', undefined, 'plans/archive/pi-notification/verification-history.md'],
  ['plans/archive/pi-notification/pi-notification-handoff.md', '### M3-3 人工验收记录', '### 文档同步', 'plans/archive/pi-notification/verification-history.md'],
];
for (const [file, start, end, target] of excerpts) {
  const source = original(file);
  const first = source.indexOf(start);
  const last = end ? source.indexOf(end, first) : source.length;
  assert.ok(first >= 0 && last > first, `Missing source section: ${file}`);
  assert.ok(normalize(read(target)).includes(normalize(source.slice(first, last))), `Historical excerpt changed: ${file}`);
}

const packages = readdirSync('work/scripts/pi', { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(`work/scripts/pi/${entry.name}/package.json`));
let scriptEntries = 0;
const independentPackages = [];
for (const entry of packages) {
  const directory = `work/scripts/pi/${entry.name}`;
  const manifest = JSON.parse(read(`${directory}/package.json`));
  assert.ok(manifest.scripts.test, `${directory}: missing test command`);
  assert.equal(read(`${directory}/LICENSE`), read('LICENSE'), `${directory}: standalone license differs`);
  const packageRoot = path.resolve(directory);
  let localImports = 0;
  let localDocumentLinks = 0;
  const inspectPackage = current => {
    for (const child of readdirSync(current, { withFileTypes: true })) {
      if (child.name === 'node_modules') continue;
      const file = path.join(current, child.name);
      if (child.isDirectory()) { inspectPackage(file); continue; }
      if (/\.(?:ts|mjs|cjs)$/.test(file)) {
        for (const match of readFileSync(file, 'utf8').matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)) {
          const resolved = path.resolve(path.dirname(file), match[1]);
          assert.ok(resolved.startsWith(packageRoot + path.sep), `${file}: import leaves plugin: ${match[1]}`);
          assert.ok(existsSync(resolved), `${file}: missing local import: ${match[1]}`);
          localImports++;
        }
      }
      if (file.endsWith('.md')) {
        const prose = readFileSync(file, 'utf8').replace(/^\s*```[^\n]*\n[\s\S]*?^\s*```\s*$/gm, '');
        for (const match of prose.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
          const target = match[1];
          if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
          const resolved = path.resolve(path.dirname(file), decodeURIComponent(target.split('#')[0]));
          assert.ok(resolved.startsWith(packageRoot + path.sep), `${file}: documentation leaves plugin: ${target}`);
          localDocumentLinks++;
        }
      }
    }
  };
  inspectPackage(directory);
  independentPackages.push({ name: entry.name, localImports, localDocumentLinks });
  for (const script of Object.values(manifest.scripts)) {
    for (const match of script.matchAll(/\bnode\s+(test\/[\w./-]+\.(?:mjs|cjs))/g)) {
      scriptEntries++;
      assert.ok(existsSync(`${directory}/${match[1]}`), `${directory}: missing test script ${match[1]}`);
    }
  }
  assert.ok(existsSync(`${directory}/${manifest.pi.extensions[0]}`), `${directory}: missing extension`);
}

const sourceHashes = {};
const hashFiles = directory => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'results') continue;
    const file = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) hashFiles(file);
    else if (/\.(?:ts|mjs|cjs)$/.test(file) || entry.name === 'package.json') {
      sourceHashes[file] = createHash('sha256').update(readFileSync(file)).digest('hex');
    }
  }
};
for (const name of ['pi-image-generation', 'pi-video-generation', 'pi-notification', 'pi-usage-openai', 'pi-edit-fallback']) {
  hashFiles(`work/scripts/pi/${name}`);
}
const report = { checkedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, arch: process.arch }, markdownFiles: files.length, localLinks: links,
  preservedFiles: preserved, preservedExcerpts: excerpts.map(([file]) => file), packages: packages.map(entry => entry.name),
  independentPackages, scriptEntries, errors, files, sourceHashes };
writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
console.log(`Checked ${files.length} Markdown files, ${links} local links, ${packages.length} package manifests and ${scriptEntries} test script references.`);
console.log(`Preserved ${preserved.length} original files and ${excerpts.length} historical report sections.`);
console.log(`Checked ${independentPackages.length} standalone plugin boundaries, documentation links and licenses.`);
for (const error of errors) console.error(error);
if (errors.length) process.exitCode = 1;
