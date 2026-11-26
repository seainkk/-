import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const client = readFileSync(new URL('../src/Client.html', import.meta.url), 'utf8');
const KEY = 'A'.repeat(43);
function source(name) {
  const start = client.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'Actual client function exists: ' + name);
  let depth = 0, quote = null, escaped = false;
  for (let i = client.indexOf('{', start); i < client.length; i++) {
    const c = client[i];
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === String.fromCharCode(96)) { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return client.slice(start, i + 1);
  }
  assert.fail('Complete client function exists: ' + name);
}
function helpers(...names) {
  const context = vm.createContext({});
  vm.runInContext(names.map(source).join('\n'), context);
  return context;
}

test('the shared key is read only from one strictly formed URL fragment', () => {
  const { sharedKeyFromHash: parse } = helpers('sharedKeyFromHash');
  assert.equal(parse('access_key=' + KEY), KEY);
  assert.equal(parse('#access_key=' + KEY), KEY);
  for (const value of ['', null, undefined, '?access_key=' + KEY, 'https://example.invalid/#access_key=' + KEY, 'access_key=' + KEY + '&access_key=' + KEY, 'access_key=' + 'A'.repeat(42), 'access_key=' + 'A'.repeat(44), 'access_key=' + 'a'.repeat(42) + '.', 'access_key%3D' + KEY, 'access_key=' + KEY + '\n']) assert.equal(parse(value), null);
});

test('ordinary requests carry the bearer in the outer envelope without changing business data', () => {
  const { sharedRequest } = helpers('sharedRequest');
  const payload = { id: 'source_123', status: 'ready', expectedRevision: 4 };
  const request = sharedRequest('updateSourceBase', payload, KEY, 'neosender');
  assert.equal(request.projectId, 'neosender');
  assert.equal(request.method, 'updateSourceBase');
  assert.equal(request.accessKey, KEY);
  assert.equal(request.payload, payload);
  assert.deepEqual(payload, { id: 'source_123', status: 'ready', expectedRevision: 4 });
  assert.deepEqual(Object.keys(sharedRequest('getAppBootstrap', undefined, KEY, 'numshield')).sort(), ['accessKey', 'method', 'projectId']);
  for (const key of ['', null, 'short', KEY + '?', KEY + '\n']) assert.throws(() => sharedRequest('getSourceBases', {}, key));
});

test('the copied link has a fixed app origin and keeps the bearer out of the query string', () => {
  const { sharedUrl } = helpers('sharedUrl');
  const url = new URL(sharedUrl(KEY));
  assert.equal(url.origin, 'https://seainkk.github.io');
  assert.equal(url.pathname, '/-/');
  assert.equal(url.search, '');
  assert.equal(url.hash, '#access_key=' + KEY);
  assert.throws(() => sharedUrl('https://untrusted.invalid/'));
});

function rpcFixture(key = KEY) {
  const calls = [], locks = [], field = { value: '', disabled: false }, project = { value: '' };
  const context = vm.createContext({ activeProjectId: 'neosender', accessKey: key, networkPending: 0, Promise, setTimeout() {}, $: id => id === 'br-upload-project' ? project : field, failure(error) { const match = String(error.message).match(/\[([A-Z_]+)\]/); return { code: match?.[1], message: error.message }; }, lockAccess(message) { locks.push(message); }, flushPendingView() {} });
  const handlers = {};
  const runner = { withSuccessHandler(fn) { handlers.success = fn; return runner; }, withFailureHandler(fn) { handlers.failure = fn; return runner; }, callApp(request) { calls.push({ kind: 'dispatch', request }); }, uploadSourceBase(form) { calls.push({ kind: 'upload', form, tokenAtDispatch: field.value, projectId: project.value, disabledAtDispatch: field.disabled }); } };
  context.google = { script: { run: runner } };
  vm.runInContext(source('sharedRequest') + '\n' + source('accessFailure') + '\n' + source('rpc'), context);
  return { context, calls, locks, field, handlers };
}

test('the live RPC transports ordinary operations only through the keyed dispatcher', async () => {
  const f = rpcFixture(), payload = { segmentId: 'segment_123' };
  const result = f.context.rpc('getSegmentMailings', payload);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].kind, 'dispatch');
  assert.equal(f.calls[0].request.accessKey, KEY);
  assert.equal(f.calls[0].request.method, 'getSegmentMailings');
  assert.equal(f.calls[0].request.projectId, 'neosender');
  assert.equal(f.calls[0].request.payload, payload);
  f.handlers.success({ state: 'not_connected' });
  assert.equal((await result).state, 'not_connected');
  assert.equal(f.context.networkPending, 0);
});

test('the upload dispatches one live form with its named key populated', async () => {
  const f = rpcFixture(), form = { tagName: 'FORM' };
  const pending = f.context.rpc('uploadSourceBase', form);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].kind, 'upload');
  assert.equal(f.calls[0].form, form);
  assert.equal(f.calls[0].tokenAtDispatch, KEY);
  assert.equal(f.calls[0].projectId, 'neosender');
  assert.equal(f.calls[0].disabledAtDispatch, false);
  f.handlers.success({ file: { id: 'created_123' } });
  await pending;
  assert.equal(f.context.networkPending, 0);
});

test('missing and revoked keys cannot silently continue data requests', async () => {
  const absent = rpcFixture('');
  await assert.rejects(absent.context.rpc('getSourceBases'), /закрытая ссылка/);
  assert.equal(absent.calls.length, 0);
  assert.equal(absent.context.networkPending, 0);
  const revoked = rpcFixture(), pending = revoked.context.rpc('getSourceBases');
  revoked.handlers.failure(new Error('[LINK_ACCESS_REQUIRED] Closed link required'));
  await assert.rejects(pending, /LINK_ACCESS_REQUIRED/);
  assert.equal(revoked.locks.length, 1);
  assert.equal(revoked.context.networkPending, 0);
  assert.equal(helpers('accessFailure').accessFailure('DRIVE_ACCESS_REQUIRED'), false, 'file permissions do not revoke the link');
});

test('Google parent URL metadata is used rather than an iframe URL or query token', async () => {
  let callback, clearCount = 0;
  const context = vm.createContext({ Promise, setTimeout() { return 7; }, clearTimeout(id) { assert.equal(id, 7); clearCount++; }, google: { script: { url: { getLocation(fn) { callback = fn; } } } } });
  vm.runInContext(source('sharedKeyFromHash') + '\n' + source('readSharedKey'), context);
  const found = context.readSharedKey(); callback({ hash: 'access_key=' + KEY, parameter: { access_key: 'ignored' } });
  assert.equal(await found, KEY); assert.equal(clearCount, 1);
  const absent = context.readSharedKey(); callback({ hash: '', parameter: { access_key: KEY } });
  assert.equal(await absent, null);
});


test('embedded status messages go only to the fixed entry origin without a credential', () => {
  const calls = [], outer = { postMessage: (data, origin) => calls.push({ data, origin }) };
  const context = vm.createContext({ window: { top: outer } });
  vm.runInContext(['entryWindow','postEntryMessage','notifyEntry'].map(source).join('\n') + ';notifyEntry("ready");notifyEntry("locked");', context);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { data: { type: 'bases-registry-ready' }, origin: 'https://seainkk.github.io' },
    { data: { type: 'bases-registry-locked' }, origin: 'https://seainkk.github.io' },
  ]);
  assert.equal(JSON.stringify(calls).includes(KEY), false);
});

test('only bounded catalog titles and classifications can reach the authenticated Pages preview', () => {
  const sent=[];
  const context=vm.createContext({accessReady:false,window:{top:{postMessage:(data,origin)=>sent.push({data,origin})}}});
  vm.runInContext(['entryWindow','postEntryMessage','catalogNames','normalizeContents','sendEntryCatalog','notifyEntry'].map(source).join('\n'),context);
  const rows=[{name:' Тест ',contents:['lpr','private','companies'],id:'private-id',url:'private-url',contacts:['secret-email']}];
  const preview=context.catalogNames(rows,100);
  context.sendEntryCatalog(preview);
  assert.equal(sent.length,0);
  context.accessReady=true;
  context.notifyEntry('ready',true);
  context.sendEntryCatalog(preview);
  context.sendEntryCatalog(null);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)),[
    {data:{type:'bases-registry-ready',catalogPending:true},origin:'https://seainkk.github.io'},
    {data:{type:'bases-registry-catalog',items:[{name:'Тест',contents:['companies','lpr']}],checkedAt:100},origin:'https://seainkk.github.io'},
    {data:{type:'bases-registry-catalog',items:null,checkedAt:0},origin:'https://seainkk.github.io'}
  ]);
  assert.equal(context.catalogNames(Array(201).fill(rows[0]),100),null);
  assert.equal(context.catalogNames([{name:' '}],100),null);
  assert.equal(context.catalogNames(rows,NaN),null);
  assert.equal(context.catalogNames([{name:'x'.repeat(300)}],100).items[0].name.length,200);
});

test('the embedded Sheets dialog exchanges messages with its actual Pages ancestor and opens the authorized project', () => {
  const origin='https://seainkk.github.io', outerOrigin='https://docs.google.com', wrapperOrigin='https://script.google.com';
  const sent=[], opened=[], project={value:''};
  const sheets={postMessage(){assert.fail('the outer sheet received a message');}};
  const pages={parent:sheets,postMessage:(message,to)=>sent.push([message,to])};
  const wrapper={parent:pages,postMessage(){assert.fail('the Google wrapper received a message');}};
  const window={top:sheets,parent:wrapper,location:{ancestorOrigins:[wrapperOrigin,origin,outerOrigin]},RegistryGrid:{open:options=>opened.push(options)}};
  const context=vm.createContext({window,projectNames:{numshield:'Намшилд',neosender:'Нео Сендер'},activeProjectId:'numshield',accessReady:false,
    $:()=>project,importing:false,sourceSaving:false,segmentSaving:false,segmentEditor:null,coldySession:null,providerSession:null,coldyMailings:null,
    workspaceRpc(){},armViewTimer(){},updateControls(){},switchProject(){context.activeProjectId=project.value;}});
  vm.runInContext(['entryWindow','postEntryMessage','notifyEntry','sendEntryCatalog','receiveEntryMessage','openEntryWorkbook','openGridWorkbook'].map(source).join('\n'),context);
  const message={type:'bases-registry-open-validation',id:'workbook_123456',projectId:'neosender',workbookAction:'mailing'};
  const receive=(source,from,data=message)=>context.receiveEntryMessage({source,origin:from,data});
  receive(pages,origin);assert.equal(opened.length,0);
  context.accessReady=true;context.notifyEntry('ready');context.sendEntryCatalog({items:[{name:'Кухни'}],checkedAt:123});
  assert.deepEqual(sent.map(([m,to])=>[m.type,to]),[['bases-registry-ready',origin],['bases-registry-catalog',origin]]);
  for(const [source,from] of [[sheets,origin],[{},origin],[wrapper,origin],[pages,outerOrigin],[pages,'null']])receive(source,from);
  receive(pages,origin,{...message,projectId:'unknown'});receive(pages,origin,{...message,workbookAction:'other'});
  assert.equal(opened.length,0);assert.equal(context.activeProjectId,'numshield');
  receive(pages,origin);assert.equal(project.value,'neosender');
  assert.deepEqual([opened[0].id,opened[0].projectId,opened[0].workbookAction,opened[0].validateNew],['workbook_123456','neosender','mailing',false]);
  receive(pages,origin,{type:message.type,id:message.id});assert.equal(opened[1].validateNew,true);
  window.location.ancestorOrigins=[wrapperOrigin,'https://other.invalid',outerOrigin];
  context.notifyEntry('ready');context.sendEntryCatalog(null);receive(pages,origin);assert.equal(sent.length,2);assert.equal(opened.length,2);
});
