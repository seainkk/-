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
  const request = sharedRequest('updateSourceBase', payload, KEY);
  assert.equal(request.method, 'updateSourceBase');
  assert.equal(request.accessKey, KEY);
  assert.equal(request.payload, payload);
  assert.deepEqual(payload, { id: 'source_123', status: 'ready', expectedRevision: 4 });
  assert.deepEqual(Object.keys(sharedRequest('getAppBootstrap', undefined, KEY)).sort(), ['accessKey', 'method']);
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
  const calls = [], locks = [], field = { value: '', disabled: false };
  const context = vm.createContext({ accessKey: key, networkPending: 0, Promise, setTimeout() {}, $: () => field, failure(error) { const match = String(error.message).match(/\[([A-Z_]+)\]/); return { code: match?.[1], message: error.message }; }, lockAccess(message) { locks.push(message); }, flushPendingView() {} });
  const handlers = {};
  const runner = { withSuccessHandler(fn) { handlers.success = fn; return runner; }, withFailureHandler(fn) { handlers.failure = fn; return runner; }, callApp(request) { calls.push({ kind: 'dispatch', request }); }, uploadSourceBase(form) { calls.push({ kind: 'upload', form, tokenAtDispatch: field.value, disabledAtDispatch: field.disabled }); } };
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
  vm.runInContext(source('notifyEntry') + ';notifyEntry("ready");notifyEntry("locked");', context);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { data: { type: 'bases-registry-ready' }, origin: 'https://seainkk.github.io' },
    { data: { type: 'bases-registry-locked' }, origin: 'https://seainkk.github.io' },
  ]);
  assert.equal(JSON.stringify(calls).includes(KEY), false);
});
