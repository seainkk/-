import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../entry/index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]).join('\n');
const KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const GOOGLE_ORIGIN = 'https://n-example-script.googleusercontent.com';

function fixture({ hash = '#access_key=' + KEY, supported = true, clipboard = true, copyFallback = true, path = '/-/' } = {}) {
  const events = new Map(), timers = new Map(), sequence = [], created = [], copies = [];
  let timerId = 0;
  const location = new URL('https://seainkk.github.io' + path + hash);
  const window = { location, addEventListener(name, handler) { events.set(name, handler); } };
  window.parent = window;
  function element(tag = 'div') {
    const node = {
      tag, hidden: false, disabled: false, textContent: '', dataset: {}, attributes: {}, children: [], listeners: new Map(),
      setAttribute(name, value) { node.attributes[name] = value; },
      addEventListener(name, handler) { node.listeners.set(name, handler); },
      append(child) { node.children.push(child); child.parentElement = node; sequence.push(['append', child.tag]); },
      remove() { node.removed = true; if (node.parentElement) node.parentElement.children = node.parentElement.children.filter(child => child !== node); },
      focus() { node.focused = true; }, select() { node.selected = true; },
    };
    if (tag === 'iframe') {
      node.contentWindow = { parent: window };
      Object.defineProperty(node, 'credentialless', { get: () => node._credentialless, set(value) { sequence.push(['isolate', value]); node._credentialless = value; } });
      Object.defineProperty(node, 'src', { get: () => node._src, set(value) { sequence.push(['navigate', value]); node._src = value; } });
    }
    return node;
  }
  const ids = Object.fromEntries(['entry-copy-status', 'entry-copy', 'entry-card', 'entry-title', 'entry-message', 'entry-spinner', 'entry-retry', 'entry-frame-host'].map(id => [id, element()]));
  const body = element('body');
  const document = {
    body, getElementById: id => ids[id],
    createElement(tag) { const node = element(tag); created.push(node); return node; },
    execCommand(name) { assert.equal(name, 'copy'); const field = created.findLast(node => node.tag === 'textarea' && !node.removed); if (copyFallback) copies.push(field.value); return copyFallback; },
  };
  function Frame() {}
  if (supported) Frame.prototype.credentialless = false;
  const context = vm.createContext({
    window, document, URL, HTMLIFrameElement: Frame,
    navigator: clipboard ? { clipboard: { async writeText(value) { copies.push(value); } } } : {},
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(script, context, { filename: 'entry/index.html' });
  const currentFrame = () => ids['entry-frame-host'].children[0];
  return { ids, window, body, timers, sequence, created, copies, currentFrame,
    event(name, value) { return events.get(name)?.(value); },
    ready(source = { parent: currentFrame()?.contentWindow }, origin = GOOGLE_ORIGIN) { events.get('message')({ origin, source, data: { type: 'bases-registry-ready' } }); },
  };
}

test('missing, malformed and query-only credentials never create a Google iframe', () => {
  for (const hash of ['', '#access_key=', '#access_key=' + 'a'.repeat(42), '#access_key=' + KEY + '&other=1', '#access_key=' + '~'.repeat(43), '#other=' + KEY]) {
    const f = fixture({ hash });
    assert.equal(f.created.filter(node => node.tag === 'iframe').length, 0);
    assert.equal(f.body.dataset.state, 'locked');
    assert.equal(f.ids['entry-copy'].hidden, true);
    assert.equal(f.timers.size, 0);
  }
  const queryOnly = fixture({ path: '/-/?access_key=' + KEY, hash: '' });
  assert.equal(queryOnly.currentFrame(), undefined);
});

test('unsupported browsers receive a clear instruction instead of a credentialed fallback', () => {
  const f = fixture({ supported: false });
  assert.equal(f.body.dataset.state, 'unsupported');
  assert.match(f.ids['entry-message'].textContent, /Chrome или Edge/);
  assert.equal(f.created.filter(node => node.tag === 'iframe').length, 0);
  assert.equal(f.timers.size, 0);
});

test('isolation and no-referrer are applied before the fixed Google app navigates', () => {
  const f = fixture(), frame = f.currentFrame(), url = new URL(frame.src);
  assert.equal(frame.credentialless, true);
  assert.equal(frame.attributes.credentialless, '');
  assert.equal(frame.referrerPolicy, 'no-referrer');
  assert.equal(frame.allow, 'clipboard-write');
  assert.equal(url.origin, 'https://script.google.com');
  assert.equal(url.pathname, '/macros/s/AKfycbxKxdFPQt4gGQAOrgyRUBNm1yQEhEyEeXTiPPZqYz2KsVEZNyD6gXrDRj78BhgybCv0WA/exec');
  assert.equal(url.search, '');
  assert.equal(url.hash, '#access_key=' + KEY);
  assert.deepEqual(f.sequence.slice(0, 3).map(event => event[0]), ['isolate', 'navigate', 'append']);
  assert.equal(f.body.dataset.state, 'loading');
  assert.equal(f.ids['entry-frame-host'].hidden, true, 'unconfirmed Google screens stay behind the loading card');
  assert.equal(f.ids['entry-copy'].disabled, true);
});

test('only a Google-origin message from the current iframe subtree confirms readiness', () => {
  const f = fixture();
  f.ready({ parent: f.currentFrame().contentWindow }, 'https://script.google.com.attacker.invalid');
  f.ready({ parent: f.window }, GOOGLE_ORIGIN);
  f.ready({ get parent() { throw new Error('Cross-origin access denied'); } }, GOOGLE_ORIGIN);
  assert.equal(f.body.dataset.state, 'loading');
  f.ready({ parent: { parent: f.currentFrame().contentWindow } });
  assert.equal(f.body.dataset.state, 'ready');
  assert.equal(f.ids['entry-card'].hidden, true);
  assert.equal(f.ids['entry-frame-host'].hidden, false);
  assert.equal(f.ids['entry-copy'].disabled, false);
  assert.equal(f.timers.size, 0);
});

test('a rejected key clears the iframe and never publishes the private credential as text', () => {
  const f = fixture(), frame = f.currentFrame();
  f.ready();
  f.event('message', { origin: GOOGLE_ORIGIN, source: { parent: frame.contentWindow }, data: { type: 'bases-registry-locked' } });
  assert.equal(f.body.dataset.state, 'locked');
  assert.equal(frame.removed, true);
  assert.equal(f.currentFrame(), undefined);
  assert.equal(f.ids['entry-copy'].hidden, true);
  assert.equal(Object.values(f.ids).some(node => node.textContent.includes(KEY)), false);
});

test('copy shares the entry address without a Google account index, query or visible credential', async () => {
  for (const clipboard of [true, false]) {
    const f = fixture({ clipboard, path: '/-/index.html?ignored=1' });
    f.ready();
    await f.ids['entry-copy'].listeners.get('click')();
    assert.deepEqual(f.copies, ['https://seainkk.github.io/-/#access_key=' + KEY]);
    assert.equal(f.ids['entry-copy-status'].textContent, 'Ссылка скопирована');
    assert.equal(f.created.filter(node => node.tag === 'textarea' && !node.removed).length, 0);
    assert.equal(Object.values(f.ids).some(node => node.textContent.includes(KEY)), false);
  }
});

test('hash changes destroy the old isolation context; a missing key does not navigate again', () => {
  const f = fixture(), old = f.currentFrame();
  f.window.location.hash = '#access_key=' + 'Z'.repeat(43);
  f.event('hashchange');
  const next = f.currentFrame();
  assert.equal(old.removed, true);
  assert.notEqual(next, old);
  assert.equal(new URL(next.src).hash, '#access_key=' + 'Z'.repeat(43));
  f.ready({ parent: old.contentWindow });
  assert.equal(f.body.dataset.state, 'loading', 'stale iframe messages cannot unlock the new frame');
  f.window.location.hash = '';
  f.event('hashchange');
  assert.equal(next.removed, true);
  assert.equal(f.currentFrame(), undefined);
  assert.equal(f.body.dataset.state, 'locked');
  assert.equal(f.timers.size, 0);
});

test('a timeout permits an explicit retry and never reports a loaded error page as success', () => {
  const f = fixture(), old = f.currentFrame();
  assert.equal(old.listeners.has('load'), false, 'iframe load is not proof that our app started');
  [...f.timers.values()][0].callback();
  assert.equal(f.body.dataset.state, 'error');
  assert.equal(f.ids['entry-retry'].hidden, false);
  assert.equal(f.ids['entry-copy'].disabled, true);
  f.ids['entry-retry'].listeners.get('click')();
  assert.equal(old.removed, true);
  assert.notEqual(f.currentFrame(), old);
  assert.equal(f.body.dataset.state, 'loading');
});
