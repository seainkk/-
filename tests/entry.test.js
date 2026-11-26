import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { hkdfSync, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../entry/index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]).join('\n');
const reader = readFileSync(new URL('../entry/directory.js',import.meta.url),'utf8');
const KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const PAGES_ORIGIN = 'https://seainkk.github.io';

test('Pages deploy retries consume the completed build artifact without uploading another one', () => {
  const workflow = readFileSync(new URL('../.github/workflows/entry-pages.yml', import.meta.url), 'utf8');
  const [build, deploy] = workflow.split(/^  deploy:\s*$/m);
  assert.match(build, /artifact_name=github-pages-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/);
  assert.match(build, /artifact_name: \$\{\{ steps\.name\.outputs\.artifact_name \}\}/);
  assert.match(build, /artifact_id: \$\{\{ steps\.upload\.outputs\.artifact_id \}\}/);
  assert.match(build, /uses: actions\/upload-pages-artifact@v3\s+with:\s+name: \$\{\{ steps\.name\.outputs\.artifact_name \}\}\s+path: _site/);
  assert.match(deploy, /needs: build/);
  assert.doesNotMatch(deploy, /upload-pages-artifact|run_attempt|GITHUB_RUN_ATTEMPT/i);
  assert.match(deploy, /ARTIFACT_ID: \$\{\{ needs\.build\.outputs\.artifact_id \}\}/);
  assert.match(deploy, /actions\/runs\/\$GITHUB_RUN_ID\/artifacts\?name=\$ARTIFACT_NAME/);
  assert.match(deploy, /artifact_name: \$\{\{ needs\.build\.outputs\.artifact_name \}\}/);
  assert.doesNotMatch(build, /pages: write|id-token: write|github-pages\s*\n\s*url:/);
});

test('the public entry and Apps Script shell identify the service and open one shared catalog', () => {
  const app = readFileSync(new URL('../src/Index.html', import.meta.url), 'utf8');
  for (const page of [html, app]) {
    assert.match(page, /<title>Центр мультиканального аутрича<\/title>/);
    assert.match(page, /Центр <(?:b|span)>мультиканального аутрича</);
  }
  assert.match(app, /id="br-view-sources"[^>]*>Общий каталог<\/button>/);
  assert.match(app, /id="br-sources-title">Общий каталог<\/h1>/);
  assert.match(html, /id="entry-preview-title">Общий каталог<\/h1>/);
  assert.doesNotMatch(app, /id="br-source-catalog-toggle"/);
});

function fixture({ hash = '#access_key=' + KEY, supported = true, path = '/-/', active = true, storage = new Map(), fetch, firebase='', clock=Date, crypto=webcrypto } = {}) {
  const events = new Map(), timers = new Map(), sequence = [], created = [];
  let timerId = 0;
  const location = new URL('https://seainkk.github.io' + path + hash);
  const window = { location, fetch, crypto, localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},addEventListener(name, handler) { events.set(name, handler); } };
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
      node.contentWindow = { parent: window,postMessage(data,origin){sent.push({type:data.type,origin});} };
      Object.defineProperty(node, 'credentialless', { get: () => node._credentialless, set(value) { sequence.push(['isolate', value]); node._credentialless = value; } });
      Object.defineProperty(node, 'src', { get: () => node._src, set(value) { sequence.push(['navigate', value]); node._src = value; } });
    }
    return node;
  }
  const ids = Object.fromEntries(Array.from(html.matchAll(/id="(entry-[\w-]+)"/g),match => [match[1],element()]));
  const body = element('body');
  const document = {
    body, getElementById: id => ids[id],
    createElement(tag) { const node = element(tag); created.push(node); return node; },
  };
  function Frame() {}
  if (supported) Frame.prototype.credentialless = false;
  const context = vm.createContext({
    window, document, URL, HTMLIFrameElement: Frame, TextEncoder, TextDecoder, btoa, atob, Uint8Array, AbortController, Date:clock,
    navigator: { userActivation: activation },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(script.replace('/* directory reader bundle */',()=>reader).replace('const directoryProject = "";',()=> 'const directoryProject = '+JSON.stringify(firebase)+';'), context, { filename: 'entry/index.html' });
  const currentFrame = () => ids['entry-frame-host'].children[0];
  const app = () => currentFrame()?.contentWindow;
  return { ids, window, body, timers, sequence, created, currentFrame, activation, app, pushes, sent, get backs(){return backs;},
    event(name, value) { return events.get(name)?.(value); },
    traverse(by) { assert.ok(position + by >= 0 && position + by < states.length); position += by; events.get('popstate')({ state: states[position] }); },
    nav(source, canBack, origin = PAGES_ORIGIN) { events.get('message')({ origin, source, data: { type:'bases-registry-navigation', canBack } }); },
    ready(source = app(), origin = PAGES_ORIGIN) { events.get('message')({ origin, source, data: { type: 'bases-registry-ready' } }); return source; },
  };
}

test('missing, malformed and query-only credentials never create an app iframe', () => {
  for (const hash of ['', '#access_key=', '#access_key=' + 'a'.repeat(42), '#access_key=' + KEY + '&other=1', '#access_key=' + '~'.repeat(43), '#other=' + KEY]) {
    const f = fixture({ hash });
    assert.equal(f.created.filter(node => node.tag === 'iframe').length, 0);
    assert.equal(f.body.dataset.state, 'locked');

    assert.equal(f.timers.size, 0);
  }
  const queryOnly = fixture({ path: '/-/?access_key=' + KEY, hash: '' });
  assert.equal(queryOnly.currentFrame(), undefined);
});

test('a worksheet opens only its preview after a valid private link and authenticated frame readiness', () => {
  const f=fixture({path:'/-/?validate=workbook_123456',hash:''}), field=f.ids['entry-private-link'];
  assert.equal(f.ids['entry-validation-access'].hidden,false);
  const submit=f.ids['entry-validation-access'].listeners.get('submit');
  field.value='https://another.example/-/#access_key='+KEY;submit({preventDefault(){}});
  assert.equal(f.window.location.hash,'');assert.equal(f.currentFrame(),undefined);
  field.value='https://seainkk.github.io/-/#access_key='+KEY;submit({preventDefault(){}});f.event('hashchange');
  assert.equal(field.value,'');assert.ok(f.currentFrame());assert.equal(f.sent.length,0);
  const calls=[],app=f.app();app.postMessage=(data,origin)=>calls.push({data,origin});
  f.ready(app,'https://other.example'); f.ready({parent:f.window,postMessage:() => assert.fail('foreign window received a worksheet selection')});
  assert.equal(calls.length,0);assert.equal(f.body.dataset.state,'loading');
  f.ready(app);f.ready(app);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{data:{type:'bases-registry-open-validation',id:'workbook_123456'},origin:PAGES_ORIGIN}]);
});

test('an authenticated sheet link keeps the requested Email action and project inside the ready Pages app', () => {
  const titles={email:/email/,mailing:/рассылку/,telegram:/телефоны/,telegramReady:/готовые контакты/,telegramAddressBook:/записной книжки/};
  for(const action of Object.keys(titles))for(const project of ['numshield','neosender']){
    const path='/-/?validate=workbook_123456&action='+action+'&project='+project;
    const f=fixture({path,hash:''}),sent=[];
    assert.equal(f.ids['entry-validation-access'].hidden,false);
    assert.match(f.ids['entry-title'].textContent,titles[action]);
    f.ids['entry-private-link'].value='https://seainkk.github.io/-/#access_key='+KEY;
    f.ids['entry-validation-access'].listeners.get('submit')({preventDefault(){}});f.event('hashchange');
    const app=f.app();app.postMessage=(m,to)=>sent.push([m,to]);f.ready(app);f.ready(app);
    assert.deepEqual(JSON.parse(JSON.stringify(sent)),[[{type:'bases-registry-open-validation',id:'workbook_123456',workbookAction:action,projectId:project},PAGES_ORIGIN]]);
  }
  for(const suffix of ['&action=other','&action=mailing&project=other']){
    const f=fixture({path:'/-/?validate=workbook_123456'+suffix});f.ready();
    assert.equal(f.sent.some(m=>m.type==='bases-registry-open-validation'),false);
  }
});

test('an invalid worksheet identifier leaves the service at its normal entry', () => {
  for (const target of ['short', 'not%2Fa%2Fworkbook', 'x'.repeat(201)]) {
    const path = '/-/?validate=' + target, locked = fixture({path, hash:''});
    assert.equal(locked.ids['entry-validation-access'].hidden, true);
    assert.equal(locked.currentFrame(), undefined);
    const signed = fixture({path});
    signed.ready();
    assert.equal(signed.sent.some(message => message.type === 'bases-registry-open-validation'), false);
  }
});

test('repeat entry decrypts only dated names for this link before Google responds, and revocation clears them', async () => {
  async function until(check) {
    for(let i=0;i<100&&!check();i++) await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok(check());
  }
  const storage=new Map(), first=fixture({storage}), source=first.ready();
  const message={type:'bases-registry-catalog',checkedAt:Date.now(),items:[
    {name:'Справочник',contents:['companies'],distribution:'unassigned',email:'excluded@example.test'},
    {name:'Уже распределена',contents:['companies'],distribution:'assigned'},
    {name:'Без подтверждённого статуса',contents:[]}]};
  first.event('message',{source:{parent:first.app()},origin:PAGES_ORIGIN,data:message});
  assert.equal(storage.size,0);
  first.event('message',{source,origin:PAGES_ORIGIN,data:message});
  await until(()=>storage.size===1);
  const raw=[...storage.values()][0];
  assert.doesNotMatch(raw,/Справочник|excluded|access_key/);
  assert.ok(!raw.includes(KEY));
  const repeat=fixture({storage}),wrong=fixture({storage,hash:'#access_key='+'Z'.repeat(43)});
  await until(()=>!repeat.ids['entry-preview'].hidden);
  assert.equal(repeat.body.dataset.state,'loading');
  assert.deepEqual(repeat.ids['entry-preview-list'].children.map(row=>row.textContent),message.items.map(item=>item.name));
  assert.equal(wrong.ids['entry-preview'].hidden,true);
  for(const [page,available] of [[repeat,true],[wrong,false]]){
    let hint;
    const reader=page.app();reader.postMessage=data=>{hint=JSON.parse(JSON.stringify(data));};
    page.event('message',{source:reader,origin:PAGES_ORIGIN,data:{type:'bases-registry-catalog-hint',epoch:3}});
    assert.deepEqual(hint,{type:'bases-registry-catalog-hint',epoch:3,available});
    assert.equal(page.body.dataset.state,'loading');
  }
  const active=repeat.ready();
  assert.equal(repeat.ids['entry-preview'].hidden,false);
  repeat.event('message',{origin:PAGES_ORIGIN,source:active,data:{type:'bases-registry-startup-catalog-presented',checkedAt:message.checkedAt,visible:true}});
  assert.equal(repeat.ids['entry-preview'].hidden,true);
  const offline=fixture({storage});
  offline.event('message',{source:offline.app(),origin:PAGES_ORIGIN,data:{type:'bases-registry-unavailable'}});
  assert.equal(offline.body.dataset.state,'error');assert.equal(storage.size,1);
  repeat.event('message',{source:active,origin:PAGES_ORIGIN,data:{type:'bases-registry-locked'}});
  assert.equal(storage.size,0);assert.equal(repeat.ids['entry-preview-list'].children.length,0);
});

test('unsupported browsers receive a clear instruction instead of a credentialed fallback', () => {
  const f = fixture({ supported: false });
  assert.equal(f.body.dataset.state, 'unsupported');
  assert.match(f.ids['entry-message'].textContent, /Chrome или Edge/);
  assert.equal(f.created.filter(node => node.tag === 'iframe').length, 0);
  assert.equal(f.timers.size, 0);
});

async function until(check) {
  for(let i=0;i<100&&!check();i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(check());
}

function directoryMock(transform) {
  const calls=[],firebase='directory-test',stamp=Date.now();
  async function fetch(url,options){
    calls.push({url,options});
    const {documents}=JSON.parse(options.body), project=documents[1].split('segments-')[1];
    const found=(name,rows)=>({found:{name,fields:{schema:{integerValue:'1'},generatedAt:{timestampValue:new Date(stamp).toISOString()},
      expiresAt:{timestampValue:new Date(stamp+600000).toISOString()},rowsJson:{stringValue:JSON.stringify(rows)}}}});
    const docs=[found(documents[1],[{id:'test_segment_001',name:'Сегмент '+project,project,section:'partners'}]),
      found(documents[0],[{id:'test_source_0001',name:'Тестовый источник',workbook:true,email:'private@example.test'}])];
    return {ok:true,text:async()=>JSON.stringify(transform?await transform(docs,calls.length):docs)};
  }
  return {calls,firebase,stamp,fetch};
}

test('first document shows all sections and passes live catalog filters through the authenticated frame handoff',async()=>{
  const mock=directoryMock(),page=fixture(mock);
  await until(()=>page.ids['entry-preview-list'].children.length===1);
  assert.equal(page.ids['entry-source-fields'].hidden,false);
  page.ids['entry-search'].value='нет такого имени';page.ids['entry-search'].listeners.get('input')();
  assert.equal(page.ids['entry-preview-list'].children.length,0);
  for(const view of ['analytics','infrastructure','retarget','settings','sources']){
    page.ids['entry-view-'+view].listeners.get('click')();
    assert.equal(page.ids['entry-view-'+view].attributes['aria-pressed'],'true');
  }
  const messages=[],scope={epoch:1,projectId:'numshield'};
  page.app().postMessage=(m)=>messages.push(structuredClone(m));
  page.event('message',{origin:PAGES_ORIGIN,source:page.app(),data:{type:'bases-registry-directory-scope',...scope}});
  const view=messages.find(m=>m.type==='bases-registry-fast-view');
  assert.equal(view.kind,'sources');assert.equal(view.filters.query,'нет такого имени');
});

test('first document reads real directory rows with an origin-scoped capability and keeps them until the application acknowledges the selected view',async()=>{
  const mock=directoryMock(),f=fixture(mock);
  assert.equal(f.ids['entry-directory-nav'].hidden,false);
  f.ids['entry-view-segments'].listeners.get('click')();
  f.ids['entry-category-partners'].listeners.get('click')();
  await until(()=>f.ids['entry-preview-list'].children.length===1);
  const row=f.ids['entry-preview-list'].children[0].children[0];
  assert.equal(row.textContent,'Сегмент numshield');assert.equal(row.dataset.directoryKind,'segments');
  assert.equal(row.dataset.directoryId,'test_segment_001');
  assert.equal(mock.calls.length,1);
  const {url,options}=mock.calls[0];assert.match(url,/^https:\/\/firestore\.googleapis\.com\/v1\/projects\/directory-test\/databases\/\(default\)\/documents:batchGet$/);
  const cap=Buffer.from(hkdfSync('sha256',KEY,'outreach-center/firebase-directory/v1',mock.firebase,32)).toString('base64url');
  assert.ok(options.body.includes('/directoryViews/'+cap+'/lists/catalog'));assert.ok(!options.body.includes(KEY)&&!url.includes(cap));
  assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');assert.equal(options.referrerPolicy,'no-referrer');
  assert.deepEqual(Object.entries(options.headers),[['Content-Type','text/plain;charset=UTF-8']]);
  row.listeners.get('click')();
  const messages=[],app=f.app();app.postMessage=data=>messages.push(structuredClone(data));
  const send=data=>f.event('message',{origin:PAGES_ORIGIN,source:app,data});
  send({type:'bases-registry-shell'});assert.equal(f.ids['entry-preview'].hidden,false);
  f.ready();assert.equal(f.ids['entry-preview'].hidden,false);
  const scope={epoch:2,projectId:'numshield'};
  send({type:'bases-registry-directory-scope',...scope});
  assert.deepEqual(messages.map(m=>m.type),['bases-registry-fast-view','bases-registry-fast-directory','bases-registry-fast-directory','bases-registry-fast-open']);
  assert.deepEqual(messages.find(m=>m.kind==='sources').items,[{id:'test_source_0001',name:'Тестовый источник'}]);
  assert.deepEqual(messages.find(m=>m.type==='bases-registry-fast-directory'&&m.kind==='segments').items,
    [{id:'test_segment_001',name:'Сегмент numshield',category:'partners'}]);
  assert.equal(messages.at(-1).id,row.dataset.directoryId);
  send({type:'bases-registry-fast-viewed',...scope,kind:'segments',serial:messages[0].serial,visible:true});
  assert.equal(f.ids['entry-preview'].hidden,false);
  send({type:'bases-registry-fast-presented',...scope,kind:'segments',checkedAt:mock.stamp,visible:true});
  assert.equal(f.ids['entry-preview'].hidden,true);assert.equal(f.ids['entry-directory-nav'].hidden,true);
  assert.equal(f.ids['entry-preview-list'].children.length,0);
});

test('a delayed first-project response cannot expose rows or cover the active application after changing project',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const mock=directoryMock(async(docs,n)=>{if(n===1)await pending;return docs;}),f=fixture(mock);
  await until(()=>mock.calls.length===1);
  const messages=[],app=f.app();app.postMessage=data=>messages.push(structuredClone(data));
  const send=(projectId,epoch)=>f.event('message',{origin:PAGES_ORIGIN,source:app,data:{type:'bases-registry-directory-scope',projectId,epoch}});
  send('numshield',1);send('neosender',2);
  await until(()=>messages.some(m=>m.kind==='segments'));release();
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.ok(messages.every(m=>m.epoch===2&&m.projectId==='neosender'));
  assert.equal(messages.find(m=>m.kind==='segments').items[0].name,'Сегмент neosender');assert.equal(f.ids['entry-preview-list'].children.length,0);
});

test('warm entry shows both encrypted lists with original timestamps while fetching, and clears all named rows on denial',async()=>{
  const storage=new Map(), first=directoryMock(), one=fixture({...first,storage});
  await until(()=>storage.size===1);
  const [slot,raw]=[...storage][0];
  assert.ok(!raw.includes(KEY)&&!raw.includes('Тестовый')&&!raw.includes('test_segment')&&!raw.includes('directoryViews'));
  const originalDate=one.ids['entry-preview-time'].textContent;
  let reply;const response=new Promise(done=>{reply=done;});let calls=0;
  const repeat=fixture({storage,firebase:first.firebase,fetch:()=>{calls++;return response;}});
  await until(()=>calls===1&&repeat.ids['entry-preview-list'].children.length===1);
  assert.equal(repeat.ids['entry-preview-time'].textContent,originalDate);
  repeat.ids['entry-view-segments'].listeners.get('click')();
  repeat.ids['entry-category-partners'].listeners.get('click')();
  assert.equal(repeat.ids['entry-preview-list'].children[0].children[0].dataset.directoryId,'test_segment_001');
  reply({ok:false,status:403});
  await until(()=>!storage.has(slot)&&!repeat.ids['entry-preview-list'].children.length);
  assert.equal(repeat.ids['entry-preview-time'].textContent,'');
  for(const reason of ['google-locked','changed-key']){
    const local=new Map([[slot,raw],[slot.replace('numshield','neosender'),raw]]);
    const page=fixture({storage:local,firebase:first.firebase,fetch:()=>new Promise(()=>{})});
    await until(()=>page.ids['entry-preview-list'].children.length===1);
    if(reason==='google-locked'){
      page.event('message',{source:page.app(),origin:PAGES_ORIGIN,data:{type:'bases-registry-locked'}});
    }else{
      page.window.location.hash='#access_key='+'X'.repeat(43);
      page.event('hashchange');
    }
    assert.equal(local.size,0,reason);
    assert.equal(page.ids['entry-preview-list'].children.length,0,reason);
  }
});

test('cached ciphertext is bound to its link, Firebase project, selected project and original expiry even if clear envelope timestamps are forged',async()=>{
  const first=directoryMock(),store=new Map();fixture({...first,storage:store});
  await until(()=>store.size===1);
  const [slot,raw]=[...store][0], never=()=>new Promise(()=>{});
  for(const mode of ['key','project','firebase','expired','malformed']){
    const storage=new Map([[slot,raw]]), options={storage,fetch:never,firebase:first.firebase};
    let target=slot;
    if(mode==='key')options.hash='#access_key='+'X'.repeat(43);
    if(mode==='project'){storage.set('registry.activeProject','neosender');target=slot.replace('numshield','neosender');storage.set(target,raw);}
    if(mode==='firebase'){options.firebase='different-project';target=slot.replace(first.firebase,options.firebase);storage.set(target,raw);}
    if(mode==='expired'){
      const now=first.stamp+610000;
      options.clock=class extends Date{static now(){return now;}};
      storage.set(slot,JSON.stringify({...JSON.parse(raw),checkedAt:now,expiresAt:now+600000}));
    }
    if(mode==='malformed')storage.set(slot,'{broken');
    const page=fixture(options);await until(()=>!storage.has(target));
    assert.equal(page.ids['entry-preview-list'].children.length,0,mode);
  }
});

test('a delayed decryption cannot replace newer verified data, and unavailable device storage does not block the network',async()=>{
  const storage=new Map(),first=directoryMock();fixture({...first,storage});await until(()=>storage.size===1);
  let release;
  const barrier=new Promise(done=>{release=done;});
  const subtle=new Proxy(webcrypto.subtle,{get(object,prop){
    if(prop==='decrypt')return async(...args)=>{await barrier;return object.decrypt(...args);};
    return typeof object[prop]==='function'?object[prop].bind(object):object[prop];
  }});
  const crypto={subtle,getRandomValues:webcrypto.getRandomValues.bind(webcrypto)};
  const next=directoryMock(docs=>{const rows=JSON.parse(docs[1].found.fields.rowsJson.stringValue);rows[0].name='Новее';docs[1].found.fields.rowsJson.stringValue=JSON.stringify(rows);return docs;});
  const page=fixture({...next,storage,crypto});
  const visible=f=>f.ids['entry-preview-list'].children[0]?.children[0]?.textContent;
  await until(()=>visible(page)==='Новее');release();await new Promise(done=>setTimeout(done,15));
  assert.equal(visible(page),'Новее');
  const denied={get(){throw Error('blocked');},set(){throw Error('blocked');},delete(){throw Error('blocked');}};
  const fallback=fixture({...first,storage:denied});
  await until(()=>visible(fallback)==='Тестовый источник');
});

test('missing, malformed, expired, or cross-project documents give way to Google and a truly empty catalogue is recognized',async()=>{
  for(const mode of ['missing','invalid','expired','other','empty']){
    const mock=directoryMock(docs=>{
      const doc=docs[1],name=doc.found.name;
      if(mode==='missing')return [{missing:name},{missing:docs[0].found.name}];
      if(mode==='invalid')doc.found.fields.rowsJson.stringValue='{';
      if(mode==='expired')doc.found.fields.expiresAt.timestampValue=new Date(Date.now()-10000).toISOString();
      if(mode==='other')doc.found.name+='-unexpected';
      if(mode==='empty')doc.found.fields.rowsJson.stringValue='[]';
      return docs;
    }),f=fixture(mock);
    await until(()=>mock.calls.length===1);await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(f.ids['entry-preview-list'].children.length,0);
    assert.equal(f.ids['entry-preview-time'].textContent.includes('Пустой список'),mode==='empty');
  }
});

test('the static app opens immediately without sending the access key, workbook or project in its URL', () => {
  const f = fixture(), frame = f.currentFrame(), url = new URL(frame.src);
  assert.equal(frame.credentialless, undefined);
  assert.equal(frame.attributes.credentialless, undefined);
  assert.equal(frame.referrerPolicy, 'no-referrer');
  assert.equal(frame.allow, 'clipboard-write');
  assert.equal(url.origin, PAGES_ORIGIN);
  assert.equal(url.pathname, '/-/app.html');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  assert.deepEqual(f.sequence.slice(0, 2).map(event => event[0]), ['navigate', 'append']);
  assert.equal(f.body.dataset.state, 'loading');
  assert.equal(f.ids['entry-frame-host'].hidden, false, 'the public navigation can paint before authorization');

});

test('only the exact Pages app origin and direct child window can confirm readiness', () => {
  const f = fixture();
  f.ready({ parent: f.currentFrame().contentWindow }, 'https://script.google.com.attacker.invalid');
  f.ready({ parent: f.window }, PAGES_ORIGIN);
  f.ready({ get parent() { throw new Error('Cross-origin access denied'); } }, PAGES_ORIGIN);
  assert.equal(f.body.dataset.state, 'loading');
  f.ready({ parent: f.currentFrame().contentWindow });assert.equal(f.body.dataset.state,'loading');f.ready();
  assert.equal(f.body.dataset.state, 'ready');
  assert.equal(f.ids['entry-card'].hidden, true);
  assert.equal(f.ids['entry-frame-host'].hidden, false);

  assert.equal(f.timers.size, 0);
});

test('a rejected key clears the iframe and never publishes the private credential as text', () => {
  const f = fixture(), frame = f.currentFrame();
  const source = f.ready();
  f.event('message', { origin: PAGES_ORIGIN, source, data: { type: 'bases-registry-locked' } });
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
  assert.equal(new URL(next.src).hash, '');
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

test('a visible static shell stays open for a slow backend and cannot authorize data by itself',()=>{
  const f=fixture(), frame=f.currentFrame(),source=f.app();
  f.event('message',{origin:PAGES_ORIGIN,source,data:{type:'bases-registry-shell'}});
  assert.equal(f.timers.size,0);
  assert.equal(f.body.dataset.state,'loading');assert.equal(f.currentFrame(),frame);
  f.nav(source,true);assert.deepEqual(f.pushes,[{basesRegistryBack:true}]);
  assert.equal(f.body.dataset.state,'loading');
  f.traverse(-1);assert.deepEqual(f.sent,[{type:'bases-registry-back',origin:PAGES_ORIGIN}]);
  f.ready(source);assert.equal(f.body.dataset.state,'ready');assert.equal(f.currentFrame(),frame);
});

test('browser Back sends one step to the ready child and re-arms only after its acknowledgement', () => {
  const f=fixture(), app=f.ready(), address=f.window.location.href;
  f.nav(app,false); assert.equal(f.pushes.length,0);
  f.nav(app,true); f.nav(app,true);
  assert.deepEqual(f.pushes,[{basesRegistryBack:true}]); assert.equal(f.window.location.href,address);
  f.traverse(-1);
  assert.deepEqual(f.sent,[{type:'bases-registry-back',origin:PAGES_ORIGIN}]);
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
  const f=fixture(), app=f.app(), sibling={parent:app};
  f.nav(app,true); assert.equal(f.pushes.length,0);
  f.ready(app); f.ready(sibling); f.nav(sibling,true); f.nav(app,true,'https://script.google.com');
  f.nav(app,true,PAGES_ORIGIN+':8443'); f.nav(app,'true');
  assert.equal(f.pushes.length,0);
  f.nav(app,true);
  f.event('message',{source:sibling,origin:PAGES_ORIGIN,data:{type:'bases-registry-locked'}});
  assert.equal(f.body.dataset.state,'ready');
  f.event('message',{source:app,origin:PAGES_ORIGIN,data:{type:'bases-registry-locked'}});
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
