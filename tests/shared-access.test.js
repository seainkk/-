import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { TEST_ACCESS_KEY, TEST_ACCESS_HASH } from './helpers/shared-link.js';

const ROOT = 'registry_root_1234567890';
const hash = value => crypto.createHash('sha256').update(value).digest('base64url');
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const properties = new Map([['ROOT_FOLDER_ID', ROOT], ['SHARED_ACCESS_KEY_SHA256', TEST_ACCESS_HASH]]);
  const calls = { folders: 0, uploads: 0, warnings: [], shell: 0 };
  const store = { getProperty: key => properties.get(key) ?? null, setProperty: (key, value) => properties.set(key, value) };
  const root = { getId: () => ROOT, getName: () => 'Реестр баз', isTrashed: () => false };
  const context = vm.createContext({
    console: { warn: value => calls.warnings.push(value) }, JSON, Object, Array, Number, String, Boolean, RegExp, Math, Error, Set, Map, Date,
    PropertiesService: { getScriptProperties: () => store },
    Session: { getActiveUser() { throw new Error('Visitor identity is unavailable'); }, getEffectiveUser() { throw new Error('Identity is not an access credential'); } },
    DriveApp: { getFolderById(id) { calls.folders++; assert.equal(id, ROOT); return root; } },
    HtmlService: {
      createTemplateFromFile(name) { assert.equal(name, 'Index'); calls.shell++; return { evaluate: () => ({ setTitle: title => ({ staticShell: true, title }) }) }; },
      createHtmlOutput: text => ({ text }),
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_, value) => [...crypto.createHash('sha256').update(value).digest()],
      base64EncodeWebSafe: value => Buffer.from(value).toString('base64url'),
    },
  });
  for (const name of ['Config.gs', 'Code.gs', 'Segments.gs', 'SourceBases.gs', 'SourceImport.gs', 'SegmentActions.gs', 'SegmentAnalytics.gs', 'Access.gs']) {
    vm.runInContext(readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'), context, { filename: name });
  }
  return { context, properties, calls, call: (method, accessKey = TEST_ACCESS_KEY, payload) => context.callApp({ method, accessKey, ...(payload === undefined ? {} : { payload }) }) };
}

test('the public page renders only a static shell without visitor identity, access checks or Drive reads', () => {
  const f = fixture();
  assert.deepEqual(plain(f.context.doGet({ parameter: { access_key: 'untrusted-query-key' } })), { staticShell: true, title: 'Реестр баз' });
  assert.equal(f.calls.shell, 1);
  assert.equal(f.calls.folders, 0);
  assert.equal(f.context.SHARED_REQUEST_SCOPE_, null);
});

test('missing, malformed and incorrect keys cannot reach data or mutation handlers', () => {
  for (const key of [undefined, null, '', [], {}, true, 'a'.repeat(42), 'a'.repeat(44), '~'.repeat(43), 'Z'.repeat(43)]) {
    const f = fixture();
    let writes = 0;
    f.context.createFolder_ = () => { writes++; throw new Error('A mutation must not run'); };
    for (const method of ['getAppBootstrap', 'createFolder']) assert.throws(() => f.context.callApp({ method, accessKey: key }), /LINK_ACCESS_REQUIRED/);
    assert.equal(writes, 0);
    assert.equal(f.calls.folders, 0);
    assert.equal(f.context.SHARED_REQUEST_SCOPE_, null);
  }
});

test('a valid shared key works anonymously and never returns the credential or owner email', () => {
  const f = fixture();
  f.properties.set('ALLOWED_EMAILS', '');
  f.properties.set('ADMIN_EMAILS', '');
  const data = plain(f.call('getAppBootstrap'));
  assert.deepEqual(data, { user: { email: '', isAdmin: false, accessMode: 'link' }, registry: { id: ROOT, name: 'Реестр баз' } });
  assert.equal(f.calls.folders, 1);
  assert.equal(JSON.stringify(data).includes(TEST_ACCESS_KEY), false);
  assert.equal(f.context.SHARED_REQUEST_SCOPE_, null);
  assert.throws(() => f.context.getAppBootstrap_(), /LINK_ACCESS_REQUIRED/, 'a private handler cannot run outside a verified invocation');
});

test('the dispatcher denies old team APIs, private helpers and prototype names', () => {
  const f = fixture();
  for (const name of ['getTeamAccess', 'addTeamMember', 'authorize_', 'getAppBootstrap_', 'uploadSourceBase', 'constructor', '__proto__', 'toString']) assert.throws(() => f.call(name), /INVALID_REQUEST/);
  assert.equal(f.calls.folders, 0);
  assert.throws(() => f.context.callApp({ method: 'getAppBootstrap', accessKey: TEST_ACCESS_KEY, rootId: 'foreign_root_1234567890' }), /INVALID_REQUEST/);
  assert.equal(f.context.SHARED_REQUEST_SCOPE_, null);
});

test('the sole-form upload verifies the key before reading a Blob and strips it before importing', () => {
  const f = fixture();
  const file = { getBytes() { throw new Error('A denied upload must not read its Blob'); } };
  f.context.uploadSourceBase_ = clean => { f.calls.uploads++; assert.equal(Object.hasOwn(clean, 'accessKey'), false); assert.equal(clean.file, file); assert.equal(f.context.authorize_().email, 'shared-link'); return { accepted: true }; };
  assert.throws(() => f.context.uploadSourceBase({ name: 'База', file, accessKey: 'Z'.repeat(43) }), /LINK_ACCESS_REQUIRED/);
  assert.equal(f.calls.uploads, 0);
  assert.deepEqual(plain(f.context.uploadSourceBase({ name: 'База', file, accessKey: TEST_ACCESS_KEY })), { accepted: true });
  assert.equal(f.calls.uploads, 1);
  assert.equal(f.context.SHARED_REQUEST_SCOPE_, null);
});

test('scope is removed after exceptions and raw provider errors never reveal the credential', () => {
  const f = fixture();
  f.context.createFolder_ = () => { throw new Error('Private provider detail ' + TEST_ACCESS_KEY); };
  assert.throws(() => f.call('createFolder'), error => /GOOGLE_ERROR/.test(error.message) && !error.message.includes(TEST_ACCESS_KEY));
  assert.equal(f.context.SHARED_REQUEST_SCOPE_, null);
  assert.throws(() => f.context.authorize_(), /LINK_ACCESS_REQUIRED/);
  assert.equal(f.calls.warnings.some(value => String(value).includes(TEST_ACCESS_KEY)), false);
});

test('rotating the private verifier revokes the old key even inside an existing scope', () => {
  const f = fixture(), nextKey = 'R'.repeat(43);
  f.context.withSharedAccess_(TEST_ACCESS_KEY, () => {
    assert.equal(f.context.authorize_().rootId, ROOT);
    f.properties.set('SHARED_ACCESS_KEY_SHA256', hash(nextKey));
    assert.throws(() => f.context.getAppBootstrap_(), /LINK_ACCESS_REQUIRED/);
  });
  assert.throws(() => f.call('getAppBootstrap'), /LINK_ACCESS_REQUIRED/);
  assert.equal(f.call('getAppBootstrap', nextKey).registry.id, ROOT);
  assert.equal(f.context.SHARED_REQUEST_SCOPE_, null);
});

test('a corrupt verifier fails closed and an absent override uses only the packaged verifier', () => {
  const f = fixture();
  f.properties.set('SHARED_ACCESS_KEY_SHA256', '');
  assert.throws(() => f.call('getAppBootstrap'), /LINK_SETUP_REQUIRED/);
  assert.equal(f.calls.folders, 0);
  f.properties.delete('SHARED_ACCESS_KEY_SHA256');
  f.context.REGISTRY_CONFIG = Object.freeze({ ...f.context.REGISTRY_CONFIG, sharedAccessKeyHash: TEST_ACCESS_HASH });
  assert.equal(f.call('getAppBootstrap').registry.id, ROOT);
});

test('only the shell and the two verified transports are exposed to google.script.run', () => {
  const names = readdirSync(new URL('../src/', import.meta.url)).filter(name => name.endsWith('.gs'));
  const publicFunctions = names.flatMap(name => [...readFileSync(new URL('../src/' + name, import.meta.url), 'utf8').matchAll(/^function\s+([A-Za-z0-9_]+)\s*\(/gm)].map(match => match[1])).filter(name => !name.endsWith('_')).sort();
  assert.deepEqual(publicFunctions, ['callApp', 'doGet', 'uploadSourceBase']);
});
