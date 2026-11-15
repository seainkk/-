import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const extensionFile = name => readFileSync(new URL('../extension/' + name, import.meta.url), 'utf8');
const shared = extensionFile('shared.js');
const content = extensionFile('content.js');
const worker = extensionFile('background.js');
const manifest = JSON.parse(extensionFile('manifest.json'));
const sheetUrl = 'https://docs.google.com/spreadsheets/d/team-file_123/edit#gid=0';
const registryUrl = 'https://script.google.com/macros/s/AKfycbxKxdFPQt4gGQAOrgyRUBNm1yQEhEyEeXTiPPZqYz2KsVEZNyD6gXrDRj78BhgybCv0WA/exec';

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.focusCount = 0;
    this.textContent = '';
  }
  append(...nodes) { this.children.push(...nodes); }
  attachShadow() { this.shadowRoot = new Element('#shadow-root'); return this.shadowRoot; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  focus() { this.focusCount++; }
  click() { if (!this.disabled) (this.listeners.click || []).forEach(listener => listener({})); }
}

function descendants(node) {
  return [node, ...node.children.flatMap(descendants), ...(node.shadowRoot ? descendants(node.shadowRoot) : [])];
}

function environment(options = {}) {
  const doc = new Element('html');
  const body = new Element('body');
  const nativeSheet = new Element('main');
  nativeSheet.textContent = 'Existing Google Sheets data and controls';
  body.append(nativeSheet);
  doc.append(body);
  const persisted = [];
  const messages = [];
  const dataCalls = [];
  const context = vm.createContext({
    URL,
    location: { href: options.url || sheetUrl },
    document: {
      documentElement: doc,
      createElement: tag => new Element(tag),
      getElementById(id) {
        assert.equal(id, 'team-registry-tasks-extension', 'Only own extension host is queried');
        return doc.children.find(node => node.id === id) || null;
      }
    },
    chrome: {
      storage: { local: {
        get: options.get || (() => Promise.resolve(options.stored || {})),
        set: options.set || (value => { persisted.push(value.registryTasksExpanded); return Promise.resolve(); })
      } },
      runtime: { onMessage: { addListener: listener => messages.push(listener) } }
    },
    fetch() { dataCalls.push('fetch'); throw new Error('Network access is forbidden for this menu'); },
    XMLHttpRequest: function () { dataCalls.push('xhr'); throw new Error('XHR is forbidden'); }
  });
  vm.runInContext(shared, context);
  function run() { vm.runInContext(content, context); }
  function node(className) {
    return descendants(doc).find(item => item.className === className);
  }
  function message(type = context.RegistryTasks.messageType) {
    let reply;
    messages.forEach(listener => listener({ type }, {}, value => { reply = value; }));
    return reply;
  }
  run();
  return { context, doc, body, nativeSheet, persisted, messages, dataCalls, run, node, message };
}

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test('extension permissions and execution are limited to the Sheets surface', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '0.1.0');
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://docs.google.com/spreadsheets/*']);
  assert.equal(manifest.content_scripts[0].all_frames, false);
  assert.equal(manifest.content_scripts[0].run_at, 'document_idle');
  for (const name of manifest.content_scripts[0].js) new vm.Script(extensionFile(name));
  new vm.Script(worker);
});

test('route guard accepts real file links and rejects home, published, and foreign pages', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(shared, context);
  const route = context.RegistryTasks.isSpreadsheetUrl;
  for (const url of [sheetUrl, 'https://docs.google.com/spreadsheets/d/ID_2-abc',
    'https://docs.google.com/spreadsheets/u/0/d/ID_2-abc/edit?usp=sharing',
    'https://docs.google.com/spreadsheets/u/12/d/ID_2-abc/view']) {
    assert.equal(route(url), true, url);
  }
  for (const url of ['https://docs.google.com/spreadsheets/',
    'https://docs.google.com/spreadsheets/u/0/', 'https://docs.google.com/spreadsheets/create',
    'https://docs.google.com/spreadsheets/d/e/published-file/pubhtml',
    'https://docs.google.com/spreadsheets/u/0/d/e/published-file/pubhtml',
    'https://docs.google.com/document/d/ID/edit', 'https://evil.example/spreadsheets/d/ID/edit',
    'https://docs.google.com.evil.example/spreadsheets/d/ID/edit', 'http://docs.google.com/spreadsheets/d/ID/edit',
    'https://docs.google.com/spreadsheets/d/', 'invalid']) {
    assert.equal(route(url), false, url);
    const env = environment({ url });
    assert.equal(env.doc.children.length, 1, 'No panel on ' + url);
    assert.equal(env.messages.length, 0);
  }
});

test('panel is injected once, starts collapsed, and does not alter the native document', async () => {
  const env = environment();
  await settle();
  env.run();
  assert.equal(env.doc.children.length, 2);
  assert.equal(env.doc.children[0], env.body);
  assert.deepEqual(env.body.children, [env.nativeSheet]);
  assert.equal(env.nativeSheet.textContent, 'Existing Google Sheets data and controls');
  assert.deepEqual(env.nativeSheet.attributes, {});
  assert.equal(env.node('panel').hidden, true);
  assert.equal(env.node('handle').hidden, false);
  assert.equal(env.messages.length, 1);
  assert.equal(env.node('registry').href, registryUrl);
  assert.equal(env.node('registry').target, '_blank');
  assert.equal(env.node('registry').rel, 'noopener noreferrer');
  assert.deepEqual(env.dataCalls, []);
});

test('open, close, Escape and toolbar messages keep placeholder tasks disabled without data calls', async () => {
  const env = environment();
  await settle();
  const tasks = descendants(env.doc).filter(node => node.className === 'task');
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map(node => node.children[1].textContent), ['Провалидировать email', 'Распределить контакты']);
  function assertDisabled() {
    tasks.forEach(task => {
      assert.equal(task.disabled, true);
      assert.equal(task.attributes['aria-disabled'], 'true');
      assert.deepEqual(task.listeners, {});
      task.click();
    });
    assert.deepEqual(env.dataCalls, []);
  }
  assertDisabled();
  env.node('handle').click();
  assert.equal(env.node('panel').hidden, false);
  assert.equal(env.node('handle').attributes['aria-expanded'], 'true');
  assertDisabled();
  env.node('close').click();
  assert.equal(env.node('panel').hidden, true);
  assert.equal(env.node('handle').focusCount, 1);
  assert.equal(env.message().handled, true);
  assert.equal(env.node('panel').hidden, false);
  let prevented = false;
  const root = env.doc.children[1].shadowRoot;
  root.listeners.keydown[0]({ key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(env.node('panel').hidden, true);
  assert.equal(env.message('unrelated'), undefined);
  assert.equal(env.node('panel').hidden, true);
  assert.deepEqual(env.persisted, [true, false, true, false]);
  assertDisabled();
});

test('saved panel state is restored, unknown values are ignored, and late reads cannot undo a click', async () => {
  const env = environment({ stored: { registryTasksExpanded: true } });
  await settle();
  assert.equal(env.node('panel').hidden, false);
  for (const value of ['true', 1, null, {}, undefined]) {
    const unknown = environment({ stored: { registryTasksExpanded: value } });
    await settle();
    assert.equal(unknown.node('panel').hidden, true);
  }
  let resolve;
  const late = environment({ get: () => new Promise(done => { resolve = done; }) });
  late.node('handle').click();
  resolve({ registryTasksExpanded: false });
  await settle();
  assert.equal(late.node('panel').hidden, false);
});

test('storage rejections or a destroyed extension context do not disable the UI', async () => {
  for (const throwsSynchronously of [true, false]) {
    function unavailable() {
      if (throwsSynchronously) throw new Error('Extension context invalidated');
      return Promise.reject(new Error('Storage unavailable'));
    }
    const env = environment({ get: unavailable, set: unavailable });
    await settle();
    env.node('handle').click();
    assert.equal(env.node('panel').hidden, false);
    env.node('close').click();
    await settle();
    assert.equal(env.node('panel').hidden, true);
  }
});

test('toolbar toggles existing receiver and otherwise opens the trusted registry without tabs permission', async () => {
  async function click(sendMessage, tab = { id: 7 }) {
    const created = [];
    let handler;
    const context = vm.createContext({
      URL,
      chrome: {
        action: { onClicked: { addListener(listener) { handler = listener; } } },
        tabs: { sendMessage, create: options => { created.push(options.url); return Promise.resolve(); } }
      }
    });
    context.importScripts = name => {
      assert.equal(name, 'shared.js');
      vm.runInContext(shared, context);
    };
    vm.runInContext(worker, context);
    await handler(tab);
    return created;
  }
  assert.deepEqual(await click(async (id, message) => {
    assert.equal(id, 7);
    assert.equal(message.type, 'registry-tasks:toggle');
    return { handled: true };
  }), []);
  assert.deepEqual(await click(async () => { throw new Error('No receiver'); }), [registryUrl]);
  assert.deepEqual(await click(async () => undefined), [registryUrl]);
  assert.deepEqual(await click(() => { throw new Error('No tab id should be messaged'); }, {}), [registryUrl]);
});
