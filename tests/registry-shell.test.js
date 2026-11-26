import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildRegistryShell } from '../scripts/deploy.mjs';
import { buildPages } from '../scripts/build-pages.mjs';

const source = fileURLToPath(new URL('../src/', import.meta.url));
const file = name => readFileSync(path.join(source, name),'utf8');

test('Pages publishes the shared interface and its transport without server files or private data', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'registry-pages-'));
  try {
    await buildPages(output,'directory-test');
    assert.deepEqual((await readdir(output)).sort(), ['app.html','favicon.png','index.html']);
    const app = await readFile(path.join(output,'app.html'),'utf8');
    const navigation = file('PagesNavigation.html');
    assert.equal(app.replace(navigation + '\n','').replace(file('PagesTransport.html') + '\n',''), await buildRegistryShell(source));
    assert.ok(app.indexOf(navigation) < app.indexOf('</head>'));
    assert.ok(app.indexOf(file('PagesTransport.html')) < app.indexOf(file('Client.html')));
    assert.match(app, /id="br-view-segments"/);
    const entry=await readFile(path.join(output,'index.html'),'utf8');
    assert.match(entry,/<link rel="preconnect" href="https:\/\/firestore.googleapis.com" crossorigin>/);
    assert.match(entry,/const directoryProject = "directory-test";/);
    assert.ok(entry.indexOf('takeEntryDirectoryRead')<entry.indexOf('<body'));
    assert.doesNotMatch(entry,/access_key=[\w-]{43}|private_key|client_email|directoryViews\/[\w-]{43}/);
    assert.doesNotMatch(app, /<\?|access_key=[\w-]{43}|function authorize_\(/);
    await buildPages(output,'outreach-directory');
    const productionEntry=await readFile(path.join(output,'index.html'),'utf8');
    const directoryOrigin='https://firestore.europe-west3.rep.googleapis.com';
    assert.ok(productionEntry.includes('<link rel="preconnect" href="'+directoryOrigin+'" crossorigin>'));
    assert.ok(productionEntry.includes('})('+JSON.stringify(directoryOrigin)+');'));
    await writeFile(path.join(output,'unrelated.txt'),'test');
    await assert.rejects(buildPages(output), /папка только с файлами интерфейса/);
  } finally { await rm(output,{recursive:true,force:true}); }
});

test('the published shell is byte-for-byte the authored Index with the existing runtime static includes', async () => {
  const used = [];
  const context = vm.createContext({HtmlService:{createHtmlOutputFromFile(name) {
    used.push(name);
    return {getContent:() => file(name+'.html')};
  }}});
  vm.runInContext(file('Code.gs'), context);
  const rendered = file('Index.html').replace(/<\?!= include_\('([^']+)'\); \?>/g, (_, name) => context.include_(name));
  assert.deepEqual(used.sort(), ['Client', 'GridClient', 'GridPanel', 'GridStyles', 'ProjectClient', 'ProjectPanel', 'ProjectStyles', 'SegmentCardClient', 'SegmentCardPanel', 'SegmentSelectionsClient', 'Styles', 'WorkbookMailingClient']);
  assert.ok(!rendered.includes('<?'));
  assert.equal(await buildRegistryShell(source), rendered);
});

test('doGet serves the release in one HTML Service read without an auth or data lookup', () => {
  const calls = [], page = {
    setFaviconUrl(url) { this.favicon=url; return this; },
    setTitle(title) { this.title=title; return this; },
    setXFrameOptionsMode(value) { this.frame=value; return this; }
  };
  const context = vm.createContext({REGISTRY_CONFIG:{title:'Registry'}, HtmlService:{
    XFrameOptionsMode:{ALLOWALL:'ALLOWALL'},
    createHtmlOutputFromFile(name) { calls.push(name); return page; }
  }});
  vm.runInContext(file('Code.gs'), context);
  assert.equal(context.doGet(), page);
  assert.deepEqual(calls, ['RegistryShell']);
  assert.equal(page.title,'Registry');
  assert.equal(page.favicon,'https://seainkk.github.io/-/favicon.png');
  assert.equal(page.frame,'ALLOWALL');
});

test('packing rejects unknown and dynamic directives and does not expand JS replacement metacharacters', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(),'registry-shell-test-'));
  try {
    for (const template of ["<?!= include_('../private'); ?>", "<?!= include_('Config'); ?>", '<?!= getApiKey_(); ?>', '<? unclosed']) {
      await writeFile(path.join(cwd,'Index.html'),template);
      await assert.rejects(buildRegistryShell(cwd),/неизвестную шаблонную инструкцию/);
    }
    await writeFile(path.join(cwd,'Index.html'),'<html><?!= include_("Client"); ?></html>');
    await writeFile(path.join(cwd,'Client.html'),'<script>const replacement = "$&$1";</script>');
    assert.equal(await buildRegistryShell(cwd),'<html><script>const replacement = "$&$1";</script></html>');
  } finally {
    await rm(cwd,{recursive:true,force:true});
  }
});
