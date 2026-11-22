import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../entry/index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]).join('\n');
const KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const GOOGLE_ORIGIN = 'https://n-example-script.googleusercontent.com';

test('Pages deploy retries consume the completed build artifact without uploading another one', () => {
  const workflow = readFileSync(new URL('../.github/workflows/entry-pages.yml', import.meta.url), 'utf8');
  const [build, deploy] = workflow.split(/^  deploy:\s*$/m);
  assert.match(build, /artifact_name=github-pages-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/);
  assert.match(build, /artifact_name: \$\{\{ steps\.name\.outputs\.artifact_name \}\}/);
  assert.match(build, /artifact_id: \$\{\{ steps\.upload\.outputs\.artifact_id \}\}/);
  assert.match(build, /uses: actions\/upload-pages-artifact@v3\s+with:\s+name: \$\{\{ steps\.name\.outputs\.artifact_name \}\}\s+path: entry/);
  assert.match(deploy, /needs: build/);
  assert.doesNotMatch(deploy, /upload-pages-artifact|run_attempt|GITHUB_RUN_ATTEMPT/i);
  assert.match(deploy, /ARTIFACT_ID: \$\{\{ needs\.build\.outputs\.artifact_id \}\}/);
  assert.match(deploy, /actions\/runs\/\$GITHUB_RUN_ID\/artifacts\?name=\$ARTIFACT_NAME/);
  assert.match(deploy, /artifact_name: \$\{\{ needs\.build\.outputs\.artifact_name \}\}/);
  assert.doesNotMatch(build, /pages: write|id-token: write|github-pages\s*\n\s*url:/);
});

test('the public entry and Apps Script shell identify the service and retain the base registry section', () => {
  const app = readFileSync(new URL('../src/Index.html', import.meta.url), 'utf8');
  for (const page of [html, app]) {
    assert.match(page, /<title>Центр мультиканального аутрича<\/title>/);
    assert.match(page, /Центр <(?:b|span)>мультиканального аутрича</);
  }
  assert.match(app, /id="br-view-sources"[^>]*>Базы<\/button>/);
  assert.match(app, /id="br-sources-title">Исходные базы и выборки<\/h1>/);
});

function fixture({ hash = '#access_key=' + KEY, supported = true, path = '/-/', active = true, storage = new Map() } = {}) {
  const events = new Map(), timers = new Map(), sequence = [], created = [];
  let timerId = 0;
  const location = new URL('https://seainkk.github.io' + path + hash);
  const window = { location, crypto:webcrypto, localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},addEventListener(name, handler) { events.set(name, handler); } };
  const states = [null], pushes = [], sent = [];
  let position = 0, backs = 0;
  window.history = {
    get state() { return states[position]; },
    pushState(state, title, ...url) {
      assert.deepEqual(url, []); pushes.push(structuredClone(state));
      states.splice(position + 1, Infinity, state); position++;
    },
    back() { backs++; },
  };
  const activation = { hasBeenActive: active };
  window.parent = window;
  function element(tag = 'div') {
    const node = {
      tag, hidden: false, disabled: false, textContent: '', dataset: {}, attributes: {}, children: [], listeners: new Map(),
      setAttribute(name, value) { node.attributes[name] = value; },
      addEventListener(name, handler) { node.listeners.set(name, handler); },
      append(child) { node.children.push(child); child.parentElement = node; sequence.push(['append', child.tag]); },
      replaceChildren(...nodes) { node.children=nodes; },
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
  const ids = Object.fromEntries(['entry-card', 'entry-title', 'entry-message', 'entry-spinner', 'entry-retry', 'entry-frame-host','entry-preview','entry-preview-list','entry-preview-time'].map(id => [id, element()]));
  const body = element('body');
  const document = {
    body, getElementById: id => ids[id],
    createElement(tag) { const node = element(tag); created.push(node); return node; },
  };
  function Frame() {}
  if (supported) Frame.prototype.credentialless = false;
  const context = vm.createContext({
    window, document, URL, HTMLIFrameElement: Frame, TextEncoder, TextDecoder, btoa, atob, Uint8Array,
    navigator: { userActivation: activation },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(script, context, { filename: 'entry/index.html' });
  const currentFrame = () => ids['entry-frame-host'].children[0];
  const app = () => ({ parent: currentFrame()?.contentWindow, postMessage(data, origin) { sent.push({ type: data.type, origin }); } });
  return { ids, window, body, timers, sequence, created, currentFrame, activation, app, pushes, sent, get backs(){return backs;},
    event(name, value) { return events.get(name)?.(value); },
    traverse(by) { assert.ok(position + by >= 0 && position + by < states.length); position += by; events.get('popstate')({ state: states[position] }); },
    nav(source, canBack, origin = GOOGLE_ORIGIN) { events.get('message')({ origin, source, data: { type:'bases-registry-navigation', canBack } }); },
    ready(source = app(), origin = GOOGLE_ORIGIN) { events.get('message')({ origin, source, data: { type: 'bases-registry-ready' } }); return source; },
  };
}

test('missing, malformed and query-only credentials never create a Google iframe', () => {
  for (const hash of ['', '#access_key=', '#access_key=' + 'a'.repeat(42), '#access_key=' + KEY + '&other=1', '#access_key=' + '~'.repeat(43), '#other=' + KEY]) {
    const f = fixture({ hash });
    assert.equal(f.created.filter(node => node.tag === 'iframe').length, 0);
    assert.equal(f.body.dataset.state, 'locked');

    assert.equal(f.timers.size, 0);
  }
  const queryOnly = fixture({ path: '/-/?access_key=' + KEY, hash: '' });
  assert.equal(queryOnly.currentFrame(), undefined);
});

test('repeat entry decrypts only dated names for this link before Google responds, and revocation clears them', async () => {
  async function until(check) {
    for(let i=0;i<100&&!check();i++) await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok(check());
  }
  const storage=new Map(), first=fixture({storage}), source=first.ready();
  const message={type:'bases-registry-catalog',checkedAt:Date.now(),items:[{name:'Справочник',contents:['companies'],email:'excluded@example.test'}]};
  first.event('message',{source:first.app(),origin:GOOGLE_ORIGIN,data:message});
  assert.equal(storage.size,0);
  first.event('message',{source,origin:GOOGLE_ORIGIN,data:message});
  await until(()=>storage.size===1);
  const raw=[...storage.values()][0];
  assert.doesNotMatch(raw,/Справочник|excluded|access_key/);
  assert.ok(!raw.includes(KEY));
  const repeat=fixture({storage}),wrong=fixture({storage,hash:'#access_key='+'Z'.repeat(43)});
  await until(()=>!repeat.ids['entry-preview'].hidden);
  assert.equal(repeat.body.dataset.state,'loading');
  assert.deepEqual(repeat.ids['entry-preview-list'].children.map(row=>row.textContent),['Справочник']);
  assert.equal(wrong.ids['entry-preview'].hidden,true);
  for(const [page,available] of [[repeat,true],[wrong,false]]){
    let hint;
    const reader={parent:page.currentFrame().contentWindow,postMessage(data){hint=JSON.parse(JSON.stringify(data));}};
    page.event('message',{source:reader,origin:GOOGLE_ORIGIN,data:{type:'bases-registry-catalog-hint',epoch:3}});
    assert.deepEqual(hint,{type:'bases-registry-catalog-hint',epoch:3,available});
    assert.equal(page.body.dataset.state,'loading');
  }
  const active=repeat.ready();
  assert.equal(repeat.ids['entry-preview'].hidden,true);
  const offline=fixture({storage});
  offline.event('message',{source:offline.app(),origin:GOOGLE_ORIGIN,data:{type:'bases-registry-unavailable'}});
  assert.equal(offline.body.dataset.state,'error');assert.equal(storage.size,1);
  repeat.event('message',{source:active,origin:GOOGLE_ORIGIN,data:{type:'bases-registry-locked'}});
  assert.equal(storage.size,0);assert.equal(repeat.ids['entry-preview-list'].children.length,0);
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

  assert.equal(f.timers.size, 0);
});

test('a rejected key clears the iframe and never publishes the private credential as text', () => {
  const f = fixture(), frame = f.currentFrame();
  const source = f.ready();
  f.event('message', { origin: GOOGLE_ORIGIN, source, data: { type: 'bases-registry-locked' } });
  assert.equal(f.body.dataset.state, 'locked');
  assert.equal(frame.removed, true);
  assert.equal(f.currentFrame(), undefined);

  assert.equal(Object.values(f.ids).some(node => node.textContent.includes(KEY)), false);
});

test('copy belongs to service settings and the outer frame delegates clipboard access', () => {
  assert.doesNotMatch(html, /id="entry-copy"/);
  assert.equal(fixture().currentFrame().allow, 'clipboard-write');
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

  f.ids['entry-retry'].listeners.get('click')();
  assert.equal(old.removed, true);
  assert.notEqual(f.currentFrame(), old);
  assert.equal(f.body.dataset.state, 'loading');
});

test('browser Back sends one step to the ready child and re-arms only after its acknowledgement', () => {
  const f=fixture(), app=f.ready(), address=f.window.location.href;
  f.nav(app,false); assert.equal(f.pushes.length,0);
  f.nav(app,true); f.nav(app,true);
  assert.deepEqual(f.pushes,[{basesRegistryBack:true}]); assert.equal(f.window.location.href,address);
  f.traverse(-1);
  assert.deepEqual(f.sent,[{type:'bases-registry-back',origin:GOOGLE_ORIGIN}]);
  f.event('popstate',{state:null}); assert.equal(f.sent.length,1);
  f.nav(app,true); assert.equal(f.pushes.length,2);
  f.traverse(-1); f.nav(app,false);
  assert.equal(f.sent.length,2); assert.equal(f.pushes.length,2); assert.equal(f.backs,0);
});

test('going home removes the extra entry without sending a second back action', () => {
  const f=fixture(), app=f.ready();
  f.nav(app,true); f.nav(app,false); f.nav(app,false);
  assert.equal(f.backs,1);
  f.traverse(-1); assert.equal(f.sent.length,0);
  f.event('popstate',{state:null}); assert.equal(f.sent.length,0); assert.equal(f.pushes.length,1);
  // The forward entry is inert on the home screen.
  f.traverse(1); f.traverse(-1); assert.equal(f.sent.length,0);
  f.nav(app,true); f.nav(app,false); f.nav(app,true);
  f.traverse(-1); assert.equal(f.sent.length,0); assert.equal(f.pushes.length,3);
});

test('only the same ready origin and window can claim browser Back in the current frame', () => {
  const f=fixture(), app=f.app(), sibling=f.app();
  f.nav(app,true); assert.equal(f.pushes.length,0);
  f.ready(app); f.ready(sibling); f.nav(sibling,true); f.nav(app,true,'https://script.google.com');
  f.nav(app,true,GOOGLE_ORIGIN+':8443'); f.nav(app,'true');
  assert.equal(f.pushes.length,0);
  f.nav(app,true);
  f.event('message',{source:sibling,origin:GOOGLE_ORIGIN,data:{type:'bases-registry-locked'}});
  assert.equal(f.body.dataset.state,'ready');
  f.event('message',{source:app,origin:GOOGLE_ORIGIN,data:{type:'bases-registry-locked'}});
  f.traverse(-1); assert.equal(f.sent.length,0);
  f.window.location.hash='#access_key='+'Z'.repeat(43); f.event('hashchange');
  const next=f.ready(); f.nav(app,true); assert.equal(f.pushes.length,1);
  f.nav(next,true); f.window.location.hash='#changed'; f.traverse(-1);
  assert.equal(f.sent.length,0);
});

test('lack of activation or a denied history operation leaves the browser free to navigate', () => {
  const f=fixture({active:false}), app=f.ready();
  f.nav(app,true); assert.equal(f.pushes.length,0);
  f.event('popstate',{state:null}); assert.equal(f.sent.length,0);
  f.activation.hasBeenActive=true;
  const push=f.window.history.pushState;
  f.window.history.pushState=()=>{throw Error('SecurityError');};
  f.event('pointerup',{}); assert.equal(f.pushes.length,0);
  f.window.history.pushState=push; f.nav(app,true);
  assert.equal(f.pushes.length,1);
  f.window.history.back=()=>{throw Error('SecurityError');};
  f.nav(app,false); f.traverse(-1); assert.equal(f.sent.length,0);
});
