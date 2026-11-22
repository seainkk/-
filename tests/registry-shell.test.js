import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildRegistryShell } from '../scripts/deploy.mjs';

const source = fileURLToPath(new URL('../src/', import.meta.url));
const file = name => readFileSync(path.join(source, name),'utf8');

test('the published shell is byte-for-byte the authored Index with the existing runtime static includes', async () => {
  const used = [];
  const context = vm.createContext({HtmlService:{createHtmlOutputFromFile(name) {
    used.push(name);
    return {getContent:() => file(name+'.html')};
  }}});
  vm.runInContext(file('Code.gs'), context);
  const rendered = file('Index.html').replace(/<\?!= include_\('([^']+)'\); \?>/g, (_, name) => context.include_(name));
  assert.equal(used.length, 8);
  assert.equal(new Set(used).size, 8);
  assert.ok(!rendered.includes('<?'));
  assert.equal(await buildRegistryShell(source), rendered);
});

test('doGet serves the release in one HTML Service read without an auth or data lookup', () => {
  const calls = [], page = {
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
