import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

const ROOT = 'registry_root_1234567890';
const ADMIN = 'admin@example.com';
const TARGET = 'second@example.com';
const MEMBER = 'member@example.com';
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(options = {}) {
  const properties = new Map(Object.entries({ ROOT_FOLDER_ID: ROOT, ALLOWED_EMAILS: `${ADMIN}, ${MEMBER}`, ADMIN_EMAILS: ADMIN, OTHER_SETTING: 'preserve', ...options.properties }));
  const permissions = new Map((options.permissions || []).map(p => [p.id, { ...p }]));
  const calls = { drive: [], writes: [], events: [], props: [], locks: 0 };
  let nextId = 0, propertyFailure = options.propertyFailure;
  const store = {
    getProperty: key => properties.get(key) ?? null,
    setProperty(key, value) { calls.events.push(`property:${key}`); if (options.failMarker) throw new Error('Private property detail'); properties.set(key, value); return store; },
    deleteProperty(key) { properties.delete(key); return store; },
    setProperties(values) {
      calls.props.push(plain(values)); calls.events.push('app-config');
      if (propertyFailure === 'partial') { properties.set('ADMIN_EMAILS', values.ADMIN_EMAILS); propertyFailure = null; throw new Error('Lost configuration acknowledgement'); }
      if (propertyFailure) { propertyFailure = null; throw new Error('Private write detail'); }
      for (const [key, value] of Object.entries(values)) properties.set(key, value);
      return store;
    },
  };
  const root = { getId: () => ROOT, getName: () => 'Реестр баз', isTrashed: () => options.trashed === true };
  const drive = {
    Files: { get(id, params) { calls.drive.push({ kind: 'metadata', id, params: plain(params) }); return { id: options.metadataId || id, mimeType: options.rootMime || 'application/vnd.google-apps.folder', trashed: options.metadataTrashed || false, capabilities: options.capabilities ?? { canEdit: true, canShare: true } }; } },
    Permissions: {
      list(id, params) {
        calls.drive.push({ kind: 'list', id, params: plain(params) });
        if (options.listError) throw options.listError;
        if (options.pages) return plain(options.pages[params.pageToken || 'first']);
        return { permissions: plain([...permissions.values()]) };
      },
      get(id, permissionId, params) {
        calls.drive.push({ kind: 'readback', id, permissionId, params: plain(params) }); calls.events.push('readback');
        if (options.readbackError) throw options.readbackError;
        const p = permissions.get(permissionId);
        return p ? { ...p, ...(options.readbackOverrides || {}) } : null;
      },
      create(body, id, params) {
        calls.writes.push({ kind: 'create', body: plain(body), id, params: plain(params) }); calls.events.push('permission-create');
        if (options.createError) throw options.createError;
        const p = { ...body, id: `permission-${++nextId}` }; permissions.set(p.id, p);
        if (options.loseCreateResponse) { options.loseCreateResponse = false; throw new Error('Connection lost after accepted grant'); }
        return plain(p);
      },
      update(body, id, permissionId, params) {
        calls.writes.push({ kind: 'update', body: plain(body), id, permissionId, params: plain(params) }); calls.events.push('permission-update');
        if (options.updateError) throw options.updateError;
        const p = permissions.get(permissionId); Object.assign(p, body); return plain(p);
      },
    },
  };
  if (options.apiUnavailable) delete drive.Permissions;
  const context = vm.createContext({
    console: { warn() {} }, JSON, Object, Array, Number, String, Boolean, RegExp, Math, Error, Set, Map, Date,
    Session: { getActiveUser: () => ({ getEmail: () => options.email ?? ADMIN }), getEffectiveUser: () => ({ getEmail: () => options.effectiveEmail ?? options.email ?? ADMIN }) },
    PropertiesService: { getScriptProperties: () => store },
    LockService: { getScriptLock: () => ({ tryLock() { calls.locks++; return !options.busy; }, releaseLock() { calls.events.push('unlock'); } }) },
    DriveApp: { getFolderById(id) { calls.drive.push({ kind: 'root', id }); if (options.folderError) throw options.folderError; return root; } },
    Drive: drive,
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: (_, value) => [...crypto.createHash('sha256').update(value).digest()], base64EncodeWebSafe: value => Buffer.from(value).toString('base64url') },
  });
  for (const name of ['Config.gs', 'Code.gs', 'TeamAccess.gs']) vm.runInContext(readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'), context);
  return { context, calls, properties, permissions, options, add: (request = { email: TARGET, role: 'member' }) => plain(context.addTeamMember(request)), get: () => plain(context.getTeamAccess()) };
}

const grant = (role = 'writer', email = TARGET, id = 'existing-permission') => ({ id, type: 'user', emailAddress: email, role });

test('team APIs deny unauthenticated, mismatched and nonadmin callers before any Drive access', () => {
  for (const options of [{ email: '' }, { email: MEMBER }, { effectiveEmail: MEMBER }, { email: 'outside@example.com' }]) {
    const f = fixture(options);
    assert.throws(() => f.get()); assert.throws(() => f.add());
    assert.deepEqual(f.calls.drive, []); assert.deepEqual(f.calls.props, []); assert.deepEqual(f.calls.writes, []);
  }
});

test('readonly team state stays admin-only and returns app membership rather than disabled historical admins', () => {
  const f = fixture({ properties: { ADMIN_EMAILS: `${ADMIN}, historical@example.com` } });
  assert.deepEqual(f.get(), { members: [{ email: ADMIN, role: 'admin' }, { email: MEMBER, role: 'member' }], currentUser: { email: ADMIN, role: 'admin' }, registry: { id: ROOT, name: 'Реестр баз' }, canManage: true });
  assert.deepEqual(f.calls.writes, []); assert.deepEqual(f.calls.props, []);
});

test('member access grants only a private writer permission on the fixed root and verifies it before preserving configuration', () => {
  const f = fixture({ properties: { ADMIN_EMAILS: `${ADMIN}, historical@example.com` } });
  const result = f.add({ email: `  ${TARGET.toUpperCase()} `, role: 'member' });
  assert.deepEqual(result, { email: TARGET, role: 'member', driveAccess: 'writer', alreadyAllowed: false });
  assert.deepEqual(f.calls.writes, [{ kind: 'create', body: { type: 'user', role: 'writer', emailAddress: TARGET }, id: ROOT, params: { supportsAllDrives: true, sendNotificationEmail: false, fields: 'id,type,role,emailAddress,deleted' } }]);
  assert.deepEqual(JSON.parse(f.properties.get('ALLOWED_EMAILS')), [ADMIN, MEMBER, TARGET]);
  assert.deepEqual(JSON.parse(f.properties.get('ADMIN_EMAILS')), [ADMIN, 'historical@example.com']);
  assert.equal(f.properties.get('OTHER_SETTING'), 'preserve');
  assert.equal(f.calls.events.indexOf('permission-create') < f.calls.events.indexOf('readback'), true);
  assert.equal(f.calls.events.indexOf('readback') < f.calls.events.indexOf('app-config'), true);
  assert.equal([...f.properties.keys()].some(key => key.startsWith('TEAM_ACCESS_')), false);
});

test('admin access appends only the requested account to both lists and repeated member calls do not demote it', () => {
  const f = fixture();
  assert.equal(f.add({ email: TARGET, role: 'admin' }).role, 'admin');
  assert.deepEqual(JSON.parse(f.properties.get('ADMIN_EMAILS')), [ADMIN, TARGET]);
  assert.equal(f.add({ email: TARGET, role: 'member' }).role, 'admin');
  assert.equal(f.add({ email: TARGET, role: 'admin' }).alreadyAllowed, true);
  assert.equal(f.calls.writes.length, 1); assert.equal(f.calls.props.length, 1);
});

test('existing stronger roles are verified and preserved; reader and commenter user grants upgrade only on the root', () => {
  for (const role of ['owner', 'organizer', 'fileOrganizer', 'writer']) {
    const f = fixture({ permissions: [grant(role)] });
    assert.equal(f.add().driveAccess, role); assert.deepEqual(f.calls.writes, []);
  }
  for (const role of ['reader', 'commenter']) {
    const f = fixture({ permissions: [grant(role)] });
    assert.equal(f.add().driveAccess, 'writer');
    assert.equal(f.calls.writes.length, 1); assert.equal(f.calls.writes[0].kind, 'update'); assert.equal(f.calls.writes[0].id, ROOT);
    assert.deepEqual(f.calls.writes[0].body, { role: 'writer' });
  }
});

test('unknown fields, invalid roles and malformed emails fail before root access or mutations', () => {
  for (const request of [null, { email: TARGET, role: 'owner' }, { email: TARGET, role: 'member', rootId: 'other_root_1234567890' }, { email: 'user@example.com\nother@example.com', role: 'member' }, { email: ['target@example.com'], role: 'member' }, { email: 'bad@host', role: 'member' }, { email: 'user@-bad.example', role: 'member' }]) {
    const f = fixture(); assert.throws(() => f.add(request)); assert.deepEqual(f.calls.drive, []); assert.deepEqual(f.calls.props, []);
  }
});

test('duplicate or corrupt app access lists and the 100-member cap stop before sharing', () => {
  for (const properties of [{ ALLOWED_EMAILS: `${ADMIN}, ${ADMIN}` }, { ALLOWED_EMAILS: `["${ADMIN}",42]` }, { ADMIN_EMAILS: `${ADMIN}, not-an-email` }, { ADMIN_EMAILS: `["${ADMIN}"` }]) {
    const f = fixture({ properties }); assert.throws(() => f.add(), /TEAM_CONFIG_INVALID|ADMIN_REQUIRED/); assert.deepEqual(f.calls.drive, []); assert.deepEqual(f.calls.writes, []);
  }
  const f = fixture({ properties: { ALLOWED_EMAILS: [ADMIN, ...Array.from({ length: 99 }, (_, n) => `person${n}@example.com`)].join(',') } });
  assert.throws(() => f.add(), /TEAM_LIMIT/); assert.deepEqual(f.calls.writes, []);
});

test('missing API, absent sharing capabilities, corrupt root metadata and trashed root cannot grant membership', () => {
  for (const options of [{ apiUnavailable: true }, { capabilities: {} }, { capabilities: { canEdit: true, canShare: false } }, { capabilities: { canEdit: false, canShare: true } }, { metadataId: 'another_root_1234567890' }, { rootMime: 'application/vnd.google-apps.spreadsheet' }, { metadataTrashed: true }, { trashed: true }]) {
    const f = fixture(options); assert.throws(() => f.add()); assert.deepEqual(f.calls.writes, []); assert.deepEqual(f.calls.props, []);
  }
});

test('pagination finds the target without a second grant and duplicate target records or looping pages fail safely', () => {
  const f = fixture({ permissions: [grant()], pages: { first: { permissions: [{ id: 'domain-permission', type: 'domain', domain: 'example.com', role: 'reader' }], nextPageToken: 'page-two' }, 'page-two': { permissions: [grant()] } } });
  assert.equal(f.add().driveAccess, 'writer'); assert.deepEqual(f.calls.writes, []);
  assert.deepEqual(f.calls.drive.filter(c => c.kind === 'list').map(c => c.params.pageToken), [undefined, 'page-two']);
  for (const pages of [{ first: { permissions: [grant(), grant('reader', TARGET, 'another-permission')] } }, { first: { permissions: [], nextPageToken: 'again' }, again: { permissions: [], nextPageToken: 'again' } }, { first: { permissions: null } }]) {
    const bad = fixture({ pages }); assert.throws(() => bad.add(), /TEAM_PERMISSIONS_INVALID/); assert.deepEqual(bad.calls.writes, []); assert.deepEqual(bad.calls.props, []);
  }
});

test('sharing rejection never adds app access and a definite rejection can retry after permissions are fixed', () => {
  const options = { createError: Object.assign(new Error('private provider content'), { status: 403 }) }, f = fixture(options);
  assert.throws(() => f.add(), /TEAM_DRIVE_ACCESS_REQUIRED/); assert.deepEqual(f.calls.props, []);
  assert.equal(f.properties.get('ALLOWED_EMAILS').includes(TARGET), false);
  options.createError = null; assert.equal(f.add().email, TARGET); assert.equal(f.calls.writes.length, 2);
});

test('lost sharing response recovers by exact existing grant and never creates a duplicate', () => {
  const f = fixture({ loseCreateResponse: true });
  assert.equal(f.add().email, TARGET); assert.equal(f.calls.writes.length, 1);
  assert.equal(f.add().alreadyAllowed, true); assert.equal(f.calls.writes.length, 1);
});

test('an unconfirmed creation cannot blindly repeat; manual writer confirmation resumes the same address', () => {
  const options = { createError: new Error('Connection lost: insufficient permission may be mentioned') }, f = fixture(options);
  assert.throws(() => f.add(), /TEAM_ACCESS_PARTIAL/); assert.throws(() => f.add(), /TEAM_ACCESS_PARTIAL/);
  assert.equal(f.calls.writes.length, 1); assert.deepEqual(f.calls.props, []);
  f.permissions.set('manual-permission', grant('writer', TARGET, 'manual-permission'));
  assert.equal(f.add().email, TARGET); assert.equal(f.calls.writes.length, 1);
});

test('configuration write failure and a partially saved admin list recover without dropping members or creating another permission', () => {
  for (const propertyFailure of [true, 'partial']) {
    const f = fixture({ propertyFailure });
    assert.throws(() => f.add({ email: TARGET, role: 'admin' }), /TEAM_ACCESS_PARTIAL/);
    assert.equal(f.calls.writes.length, 1);
    assert.equal(f.add({ email: TARGET, role: 'admin' }).role, 'admin');
    assert.equal(f.calls.writes.length, 1);
    assert.deepEqual(JSON.parse(f.properties.get('ALLOWED_EMAILS')), [ADMIN, MEMBER, TARGET]);
    assert.deepEqual(JSON.parse(f.properties.get('ADMIN_EMAILS')), [ADMIN, TARGET]);
  }
});

test('readback mismatch and journal failures cannot add application access or expose raw provider errors', () => {
  for (const options of [{ readbackError: new Error('Private provider detail') }, { readbackOverrides: { emailAddress: 'different@example.com' } }, { readbackOverrides: { role: 'reader' } }, { failMarker: true }]) {
    const f = fixture(options); let error;
    try { f.add(); } catch (value) { error = value; }
    assert.match(error.message, /TEAM_ACCESS_PARTIAL/); assert.doesNotMatch(error.message, /Private|provider|different@example/);
    assert.deepEqual(f.calls.props, []);
    if (options.failMarker) assert.deepEqual(f.calls.writes, []);
  }
});

test('fresh admin authorization is repeated after entering the lock', () => {
  const f = fixture(); let calls = 0;
  const original = f.context.authorize_;
  f.context.authorize_ = () => { const value = original(); calls++; if (calls > 1) value.isAdmin = false; return value; };
  assert.throws(() => f.add(), /ADMIN_REQUIRED/); assert.equal(calls, 2); assert.deepEqual(f.calls.drive, []);
});


test('a manually confirmed writer can finish app access when current admin cannot issue new Drive grants', () => {
  const f = fixture({ capabilities: { canEdit: true, canShare: false }, permissions: [grant()] });
  assert.equal(f.add().driveAccess, 'writer');
  assert.deepEqual(f.calls.writes, []);
  assert.deepEqual(JSON.parse(f.properties.get('ALLOWED_EMAILS')), [ADMIN, MEMBER, TARGET]);
});

test('a newly granted account can sign in through the existing bootstrap with its selected app role', () => {
  for (const role of ['member', 'admin']) {
    const options = {}, f = fixture(options);
    f.add({ email: TARGET, role });
    assert.equal(f.context.getAppBootstrap().user.email, ADMIN, 'the existing admin remains allowed');
    options.email = TARGET;
    const bootstrap = plain(f.context.getAppBootstrap());
    assert.deepEqual(bootstrap.user, { email: TARGET, isAdmin: role === 'admin' });
    const before = f.calls.drive.length;
    if (role === 'admin') assert.equal(f.get().currentUser.email, TARGET);
    else {
      assert.throws(() => f.get(), /ADMIN_REQUIRED/);
      assert.equal(f.calls.drive.length, before, 'a member cannot inspect the team through Drive');
    }
  }
});
