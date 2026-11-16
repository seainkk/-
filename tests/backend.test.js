import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourceDir = fileURLToPath(new URL('../src/', import.meta.url));
const ROOT = '1WKcvDDKqYBo94eXsYc5vKp6OPtOzv6Wh';
const INSIDE = 'inside_sheet_1234567890';
const NESTED = 'nested_sheet_1234567890';
const CHILD = 'child_folder_1234567890';
const OUTSIDE = 'outside_sheet_1234567890';
const OTHER = 'outside_folder_1234567890';
const MEMBER = 'member@example.com';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const navigationCode = () => ['Config.gs', 'Code.gs', 'Segments.gs'].map(name => readFileSync(`${sourceDir}${name}`, 'utf8')).join('\n');
const code = () => `${navigationCode()}\n${['SourceBases.gs', 'SourceImport.gs', 'SegmentActions.gs', 'SegmentAnalytics.gs'].map(name => readFileSync(`${sourceDir}${name}`, 'utf8')).join('\n')}`;

function iterator(items) {
  let position = 0;
  return { hasNext: () => position < items.length, next: () => items[position++] };
}

function fixture(options = {}) {
  const calls = { folder: 0, file: 0, open: 0, creates: 0, moves: 0, renames: 0, trashed: [], released: 0 };
  const properties = new Map(Object.entries({ ROOT_FOLDER_ID: ROOT, ALLOWED_EMAILS: MEMBER, ADMIN_EMAILS: MEMBER, ...options.properties }));
  const cache = new Map(), folders = new Map(), files = new Map();
  function folder(id, name, parent = null, trashed = false) {
    const item = {
      id, name, parent, trashed,
      getId: () => id,
      getName: () => item.name,
      getUrl: () => `https://drive.google.com/drive/folders/${id}`,
      getParents: () => iterator(item.parent ? [folders.get(item.parent)] : []),
      getMimeType: () => 'application/vnd.google-apps.folder',
      isTrashed: () => item.trashed,
      getFilesByType: mime => iterator([...files.values()].filter(file => file.parent === id && file.getMimeType() === mime)),
      getFiles: () => iterator([...files.values()].filter(file => file.parent === id)),
      getFolders: () => iterator([...folders.values()].filter(child => child.parent === id)),
      setName: value => { calls.renames++; item.name = value; return item; },
      createFolder: value => folder(`new_folder_${folders.size}_1234567890`, value, id),
    };
    folders.set(id, item);
    return item;
  }
  function file(id, name, parent, mime = SHEET_MIME, trashed = false) {
    const item = {
      id, name, parent, trashed,
      getId: () => id,
      getName: () => item.name,
      getUrl: () => `https://docs.google.com/spreadsheets/d/${id}/edit`,
      getMimeType: () => mime,
      getParents: () => iterator(item.parent ? [folders.get(item.parent)] : []),
      isTrashed: () => item.trashed,
      setName: value => { calls.renames++; item.name = value; return item; },
      moveTo: destination => {
        calls.moves++;
        if (options.failMove) throw new Error('Denied move');
        item.parent = destination.getId();
        return item;
      },
      setTrashed: value => { item.trashed = value; calls.trashed.push(id); return item; },
    };
    files.set(id, item);
    return item;
  }
  folder(ROOT, 'Реестр баз');
  folder(CHILD, 'Продажи', ROOT);
  folder(OTHER, 'Чужая папка');
  folder('trashed_folder_1234567890', 'Корзина', ROOT, true);
  file(INSIDE, 'Клиенты', ROOT);
  file(NESTED, 'Сделки', CHILD);
  file(OUTSIDE, 'Вне реестра', OTHER);
  file('plain_csv_1234567890', 'CSV', ROOT, 'text/csv');
  file('shortcut_1234567890', 'Ярлык', ROOT, 'application/vnd.google-apps.shortcut');
  file('trashed_sheet_1234567890', 'Удалённая база', ROOT, SHEET_MIME, true);
  file('sheet_in_trash_folder_1234567890', 'В удалённой папке', 'trashed_folder_1234567890');
  const propertyStore = {
    getProperty: key => properties.get(key) ?? null,
    getProperties: () => Object.fromEntries(properties),
    setProperty: (key, value) => { properties.set(key, String(value)); return propertyStore; },
    setProperties: values => { for (const [key, value] of Object.entries(values)) properties.set(key, String(value)); return propertyStore; },
    deleteProperty: key => { properties.delete(key); return propertyStore; },
  };
  const cacheStore = { get: key => cache.get(key) ?? null, put: (key, value) => cache.set(key, value), remove: key => cache.delete(key) };
  const lock = { waitLock: () => {}, tryLock: () => !options.busy, releaseLock: () => { calls.released++; } };
  const context = vm.createContext({
    console, Date, JSON, Math, Number, String, Boolean, Object, Array, RegExp, Error, Set, Map, encodeURIComponent,
    Session: {
      getActiveUser: () => ({ getEmail: () => options.activeEmail ?? MEMBER }),
      getEffectiveUser: () => ({ getEmail: () => options.effectiveEmail ?? options.activeEmail ?? MEMBER }),
      getScriptTimeZone: () => 'Europe/Moscow',
    },
    PropertiesService: { getScriptProperties: () => propertyStore, getUserProperties: () => propertyStore },
    LockService: { getScriptLock: () => lock, getUserLock: () => lock },
    CacheService: { getUserCache: () => cacheStore, getScriptCache: () => cacheStore },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256', MD5: 'md5' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (algorithm, value) => [...crypto.createHash(algorithm).update(String(value)).digest()],
      base64EncodeWebSafe: value => Buffer.from(value).toString('base64url'),
      base64Encode: value => Buffer.from(value).toString('base64'),
      getUuid: () => crypto.randomUUID(),
      formatDate: date => new Date(date).toISOString(),
    },
    MimeType: { GOOGLE_SHEETS: SHEET_MIME, FOLDER: 'application/vnd.google-apps.folder' },
    DriveApp: {
      getFolderById: id => { calls.folder++; if (!folders.has(id)) throw new Error('Not found'); return folders.get(id); },
      getFileById: id => { calls.file++; if (!files.has(id) || (options.failCreatedFileLookup && id.startsWith('created_sheet_'))) throw new Error('Not found'); return files.get(id); },
    },
    SpreadsheetApp: {
      openById: () => { calls.open++; throw new Error('Reading existing spreadsheet data is outside the app contract'); },
      create: name => {
        calls.creates++;
        const id = `created_sheet_${calls.creates}_1234567890`;
        file(id, name, null);
        return { getId: () => id, getName: () => name, getUrl: () => `https://docs.google.com/spreadsheets/d/${id}/edit` };
      },
    },
    HtmlService: {
      createTemplateFromFile: () => ({ evaluate: () => ({ setTitle: () => ({}) }) }),
      createHtmlOutput: () => ({ setTitle: () => ({}) }),
      createHtmlOutputFromFile: () => ({ getContent: () => '' }),
    },
  });
  vm.runInContext(code(), context, { filename: 'AppsScript-backend.gs' });
  return { context, calls, properties, files, folders };
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('the app exposes catalog and segment APIs without arbitrary spreadsheet cell RPCs', () => {
  const f = fixture();
  assert.equal(typeof f.context.loadTable, 'undefined');
  assert.equal(typeof f.context.writeCell, 'undefined');
  const publicFunctions = [...code().matchAll(/^function\s+([A-Za-z0-9_]+)\s*\(/gm)].map(match => match[1]).filter(name => !name.endsWith('_')).sort();
  assert.deepEqual(publicFunctions, ['createBase', 'createFolder', 'createSegment', 'doGet', 'getAppBootstrap', 'getBootstrap', 'getSegmentMailings', 'getSegmentsDashboard', 'getSourceBases', 'getSourceSheets', 'importSourceBaseLink', 'renameItem', 'updateSegment', 'updateSourceBase', 'uploadSourceBase']);
  assert.doesNotMatch(navigationCode(), /SpreadsheetApp\.openById|\.getRange\s*\(|\.getValues\s*\(|\.setValue\s*\(/);
});

test('missing allowlist denies requests before Drive or Sheets access', () => {
  const f = fixture({ properties: { ALLOWED_EMAILS: '' } });
  assert.throws(() => f.context.getBootstrap());
  assert.equal(f.calls.folder + f.calls.file + f.calls.open, 0);
});

test('blank identity and client-provided identities cannot authorize the caller', () => {
  for (const activeEmail of ['', 'outsider@example.com']) {
    const f = fixture({ activeEmail, effectiveEmail: MEMBER });
    assert.throws(() => f.context.getBootstrap({ email: MEMBER }));
    assert.equal(f.calls.folder + f.calls.file + f.calls.open, 0);
  }
});

test('all mutating APIs verify the current server-side identity', () => {
  const f = fixture({ activeEmail: 'outsider@example.com' });
  const methods = [
    ['createBase', { parentId: ROOT, name: 'Новая база', requestId: 'create_base_request_12345' }],
    ['createFolder', { parentId: ROOT, name: 'Продажи', requestId: 'create_folder_request_12345' }],
    ['renameItem', { id: INSIDE, kind: 'file', name: 'Новое имя' }],
  ];
  for (const [method, payload] of methods) assert.throws(() => f.context[method](payload), method);
  assert.equal(f.calls.creates + f.calls.renames + f.calls.moves, 0);
});

test('registry tree includes nested Sheets metadata and excludes other roots, non-Sheets and trash', () => {
  const f = fixture();
  const result = plain(f.context.getBootstrap());
  assert.equal(result.registry.id, ROOT);
  assert.deepEqual(result.files.map(file => file.id).sort(), [INSIDE, NESTED].sort());
  assert.deepEqual(result.folders.map(folder => folder.id), [CHILD]);
  assert.equal(result.files.find(file => file.id === NESTED).parentId, CHILD);
  assert.equal(f.calls.open, 0);
  assert.deepEqual(Object.keys(result.files[0]).sort(), ['id', 'name', 'parentId', 'url']);
  assert.ok(result.files.every(file => file.url.startsWith('https://docs.google.com/spreadsheets/d/')));
  assert.ok(!JSON.stringify(result).includes('values'));
});

test('metadata payloads are JSON-compatible and never include an access token', () => {
  const f = fixture();
  const result = plain(f.context.getBootstrap());
  assert.equal(result.user.email, MEMBER);
  assert.equal(result.user.isAdmin, true);
  assert.equal(typeof result.registry.name, 'string');
  assert.doesNotMatch(JSON.stringify(result), /access_token|refresh_token|Bearer/i);
  assert.equal(f.calls.open, 0);
});

test('renaming an item outside the registry is denied before mutation', () => {
  const f = fixture();
  assert.throws(() => f.context.renameItem({ id: OUTSIDE, kind: 'file', name: 'Новый файл' }), /OUTSIDE_REGISTRY/);
  assert.throws(() => f.context.renameItem({ id: OTHER, kind: 'folder', name: 'Новая папка' }), /OUTSIDE_REGISTRY/);
  assert.equal(f.calls.renames, 0);
  assert.equal(f.calls.open, 0);
});

test('renaming a nested registered file updates only its Drive metadata', () => {
  const f = fixture();
  const result = plain(f.context.renameItem({ id: NESTED, kind: 'file', name: 'Сделки 2026' }));
  assert.deepEqual(result, { id: NESTED, name: 'Сделки 2026', kind: 'file' });
  assert.equal(f.files.get(NESTED).name, 'Сделки 2026');
  assert.equal(f.calls.open, 0);
});

test('base creation is idempotent and puts a new empty spreadsheet into the selected registry folder', () => {
  const f = fixture();
  const payload = { parentId: CHILD, name: 'Новая база', requestId: 'request-create-base-123456' };
  const first = f.context.createBase(payload), second = f.context.createBase(payload);
  assert.equal(first.file.id, second.file.id);
  assert.equal(f.calls.creates, 1);
  assert.equal(f.calls.moves, 1);
  assert.equal(f.files.get(first.file.id).parent, CHILD);
  assert.equal(f.calls.open, 0);
});

test('folder creation is idempotent and stays under the requested registry parent', () => {
  const f = fixture();
  const count = f.folders.size;
  const payload = { parentId: CHILD, name: 'Архив', requestId: 'request-create-folder-123456' };
  const first = f.context.createFolder(payload), second = f.context.createFolder(payload);
  assert.equal(first.folder.id, second.folder.id);
  assert.equal(f.folders.size, count + 1);
  assert.equal(f.folders.get(first.folder.id).parent, CHILD);
});

test('creation outside the registry is rejected without creating a spreadsheet or folder', () => {
  const f = fixture();
  const count = f.folders.size;
  assert.throws(() => f.context.createBase({ parentId: OTHER, name: 'База', requestId: 'request-create-other-123456' }), /OUTSIDE_REGISTRY/);
  assert.throws(() => f.context.createFolder({ parentId: OTHER, name: 'Папка', requestId: 'request-folder-other-123456' }), /OUTSIDE_REGISTRY/);
  assert.equal(f.calls.creates, 0);
  assert.equal(f.folders.size, count);
});

test('failed move trashes only the newly created orphan and leaves existing bases intact', () => {
  const f = fixture({ failMove: true });
  assert.throws(() => f.context.createBase({ parentId: ROOT, name: 'Новая база', requestId: 'request-create-fail-123456' }));
  assert.equal(f.calls.creates, 1);
  assert.deepEqual(f.calls.trashed, ['created_sheet_1_1234567890']);
  assert.equal(f.files.get(INSIDE).trashed, false);
});

test('renaming the registry root is prohibited', () => {
  const f = fixture();
  assert.throws(() => f.context.renameItem({ id: ROOT, kind: 'folder', name: 'Другое имя' }), /ROOT_PROTECTED/);
  assert.equal(f.folders.get(ROOT).name, 'Реестр баз');
});

test('reusing a creation request for a different name is rejected', () => {
  const f = fixture();
  const payload = { parentId: ROOT, name: 'Первая база', requestId: 'request-reuse-base-123456' };
  f.context.createBase(payload);
  assert.throws(() => f.context.createBase({ ...payload, name: 'Вторая база' }), /REQUEST_REUSED/);
  assert.equal(f.calls.creates, 1);
});

test('a created spreadsheet whose Drive lookup fails returns a recovery link and never duplicates on retry', () => {
  const f = fixture({ failCreatedFileLookup: true });
  const payload = { parentId: ROOT, name: 'База', requestId: 'request-create-lookup-123456' };
  assert.throws(() => f.context.createBase(payload), error => {
    assert.match(error.message, /CREATION_UNCERTAIN/);
    assert.match(error.message, /created_sheet_1_1234567890/);
    return true;
  });
  assert.throws(() => f.context.createBase(payload), /CREATION_UNCERTAIN/);
  assert.equal(f.calls.creates, 1);
});

test('retrying a rolled-back creation keeps one receipt and then deduplicates success', () => {
  const options = { failMove: true };
  const f = fixture(options);
  const payload = { parentId: ROOT, name: 'Повтор базы', requestId: 'request-create-rollback-retry-123456' };
  assert.throws(() => f.context.createBase(payload), /CREATE_FAILED/);
  options.failMove = false;
  const created = f.context.createBase(payload), repeated = f.context.createBase(payload);
  assert.equal(created.file.id, repeated.file.id);
  assert.equal(f.calls.creates, 2);
  const index = JSON.parse(f.properties.get('CREATE_RECEIPT_INDEX'));
  assert.equal(index.length, 1);
  assert.equal(new Set(index).size, 1);
  assert.equal(f.files.get(created.file.id).parent, ROOT);
});

test('editor-only setup seeds the owner allowlist without putting account data in source', () => {
  const f = fixture({ properties: { ALLOWED_EMAILS: '', ADMIN_EMAILS: '' } });
  const result = f.context.setupRegistry_();
  assert.equal(result.folderId, ROOT);
  assert.equal(f.properties.get('ALLOWED_EMAILS'), MEMBER);
  assert.equal(f.properties.get('ADMIN_EMAILS'), MEMBER);
  assert.ok(!code().includes(MEMBER));
});
