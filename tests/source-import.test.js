import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TEST_ACCESS_KEY, TEST_ACCESS_HASH, installSharedApi } from './helpers/shared-link.js';

const sourceDir = fileURLToPath(new URL('../src/', import.meta.url));
const ROOT = '1WKcvDDKqYBo94eXsYc5vKp6OPtOzv6Wh';
const SOURCE = '1deuP0ovOC70PrElQKZjSjuvSMgPF0J7r';
const STORAGE = '1lzbjoPNnrVn5-8GoAhaLZPS_S8J0lfcaoO8Ybxw396M';
const OTHER = 'external_folder_1234567890';
const ORIGINAL = 'registered_native_1234567890';
const SOURCE_CHILD = 'source_child_folder_1234567890';
const REGISTERED = 'registry_other_folder_1234567890';
const MEMBER = 'member@example.com';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const plain = value => JSON.parse(JSON.stringify(value));
const iterator = values => { let index = 0; return { hasNext: () => index < values.length, next: () => values[index++] }; };

function blob(name = 'companies.csv', mime = 'text/csv', bytes = [65,44,66,10,49,44,50]) {
  const state = { name, mime, bytes };
  const api = {
    getName: () => state.name, getContentType: () => state.mime, getBytes: () => state.bytes,
    getDataAsString: () => Buffer.from(state.bytes).toString('utf8'),
    setName: value => { state.name = value; return api; },
    setContentType: value => { state.mime = value; return api; },
    copyBlob: () => blob(state.name, state.mime, state.bytes.slice ? state.bytes.slice() : state.bytes),
    isGoogleType: () => false,
  };
  return api;
}

function fixture(options = {}) {
  const properties = new Map(Object.entries({ ROOT_FOLDER_ID: ROOT, SHARED_ACCESS_KEY_SHA256: TEST_ACCESS_HASH, ALLOWED_EMAILS: MEMBER, ADMIN_EMAILS: MEMBER, ...options.properties }));
  const resources = new Map(), records = new Map();
  const calls = { drive: [], serviceOpens: [], metadataReads: 0, registrations: [], actions: [], lists: [], fetches: [], events: [], lockDepth: 0, trashes: [], warnings: [] };
  let nextId = 0, originalReadCount = 0;
  const store = {
    getProperty: key => properties.get(key) ?? null,
    setProperty: (key, value) => { properties.set(key, String(value)); return store; },
    deleteProperty: key => { properties.delete(key); return store; },
    getProperties: () => Object.fromEntries(properties),
    setProperties: values => { for (const [key, value] of Object.entries(values)) properties.set(key, String(value)); return store; },
  };
  function resource(id, name, mimeType, parents = [], extra = {}) {
    const item = { id, name, mimeType, parents: [...parents], trashed: false, appProperties: {}, webViewLink: `https://drive.google.com/file/d/${id}/view`, capabilities: { canCopy: true, canEdit: true, canAddChildren: true }, ...extra };
    if (mimeType === SHEET_MIME) item.webViewLink = `https://docs.google.com/spreadsheets/d/${id}/edit`;
    resources.set(id, item);
    return item;
  }
  resource(ROOT, 'Реестр баз', FOLDER_MIME);
  resource(SOURCE, 'Исходные базы', FOLDER_MIME, [ROOT]);
  resource(OTHER, 'Внешняя папка', FOLDER_MIME);
  resource(SOURCE_CHILD, 'Вложенные исходные', FOLDER_MIME, [SOURCE]);
  resource(REGISTERED, 'Другая папка реестра', FOLDER_MIME, [ROOT]);
  resource(STORAGE, 'Служебный реестр', SHEET_MIME, [options.storageParent || ROOT]);
  resource(ORIGINAL, 'Оригинал', SHEET_MIME, [options.originalParent || SOURCE_CHILD]);
  function driveObject(id) {
    const item = resources.get(id);
    if (!item) throw new Error('File not found');
    const object = {
      getId: () => id, getName: () => item.name, getMimeType: () => item.mimeType,
      getUrl: () => item.webViewLink, isTrashed: () => item.trashed,
      getParents: () => iterator(item.parents.map(driveObject)),
      getFolders: () => iterator([...resources.values()].filter(candidate => candidate.mimeType === FOLDER_MIME && candidate.parents.includes(id)).map(candidate => driveObject(candidate.id))),
      getFiles: () => iterator([...resources.values()].filter(candidate => candidate.mimeType !== FOLDER_MIME && candidate.parents.includes(id)).map(candidate => driveObject(candidate.id))),
      getFilesByType: mime => iterator([...resources.values()].filter(candidate => candidate.mimeType === mime && candidate.parents.includes(id)).map(candidate => driveObject(candidate.id))),
      setTrashed: value => { calls.trashes.push(id); item.trashed = value; return object; },
      setName: value => { calls.actions.push({ kind: 'driveAppRename', id, value }); item.name = value; return object; },
      moveTo: destination => { calls.actions.push({ kind: 'driveAppMove', id }); item.parents = [destination.getId()]; return object; },
    };
    return object;
  }
  function getResource(id, withKey = false) {
    const item = resources.get(id);
    if (!item) throw new Error('File not found');
    if (id === ORIGINAL && typeof options.onOriginalRead === 'function') options.onOriginalRead(item, ++originalReadCount);
    if (item.resourceKey && !withKey) throw new Error('Resource key required');
    return plain(item);
  }
  function createResource(metadata, payload, params) {
    assert.equal(metadata.mimeType, SHEET_MIME, 'upload must request conversion to native Google Sheets');
    assert.deepEqual(Array.from(metadata.parents || []), [SOURCE]);
    assert.equal(typeof payload.getBytes, 'function');
    calls.actions.push({ kind: 'create', metadata: plain(metadata), params: plain(params || {}), blobMime: payload.getContentType() });
    calls.events.push('create');
    if (options.rejectCreateError) throw options.rejectCreateError;
    const id = `imported_native_${++nextId}_1234567890`;
    const item = resource(id, metadata.name, SHEET_MIME, metadata.parents, { appProperties: plain(metadata.appProperties || {}) });
    if (options.loseCreateResponse) {
      options.loseCreateResponse = false;
      throw new Error('Connection lost after create');
    }
    return plain(item);
  }
  function copyResource(metadata, id, params, withKey = false) {
    assert.equal(typeof metadata, 'object', 'Drive v3 copy receives body before fileId');
    assert.equal(typeof id, 'string');
    assert.deepEqual(Array.from(metadata.parents || []), [SOURCE]);
    const original = getResource(id, withKey);
    calls.actions.push({ kind: 'copy', id, metadata: plain(metadata), params: plain(params || {}) });
    calls.events.push('copy');
    if (options.rejectCopyError) throw options.rejectCopyError;
    const copy = resource(`imported_native_${++nextId}_1234567890`, metadata.name || original.name, original.mimeType, metadata.parents, { appProperties: plain(metadata.appProperties || {}) });
    if (options.loseCopyResponse) { options.loseCopyResponse = false; throw new Error('Connection lost after copy'); }
    return plain(copy);
  }
  function updateResource(metadata, id, media, params, withKey = false) {
    assert.equal(typeof metadata, 'object', 'Drive v3 update receives body before fileId');
    assert.equal(typeof id, 'string');
    assert.ok(media === null || media === undefined, 'metadata-only update must not pass a media body');
    const settings = params || {};
    getResource(id, withKey);
    calls.actions.push({ kind: 'update', id, metadata: plain(metadata), params: plain(settings) });
    calls.events.push('update');
    if (options.rejectUpdateError) throw options.rejectUpdateError;
    if (options.failUpdateBeforeApply) throw new Error('Connection lost before update confirmation');
    const item = resources.get(id);
    if (metadata.name !== undefined) item.name = metadata.name;
    if (metadata.appProperties) item.appProperties = { ...item.appProperties, ...plain(metadata.appProperties) };
    if (settings.removeParents) item.parents = item.parents.filter(parent => !String(settings.removeParents).split(',').includes(parent));
    if (settings.addParents) for (const parent of String(settings.addParents).split(',')) if (!item.parents.includes(parent)) item.parents.push(parent);
    if (metadata.trashed !== undefined) { calls.trashes.push(id); item.trashed = metadata.trashed; }
    if (options.loseUpdateResponse) { options.loseUpdateResponse = false; throw new Error('Connection lost after update'); }
    return plain(item);
  }
  function listResources(params = {}) {
    calls.lists.push(plain(params));
    if (options.rejectListError) throw options.rejectListError;
    if (options.hideRecovery) return { files: [] };
    const query = params.q || '';
    const key = query.match(/key\s*=\s*'([^']+)'/);
    const value = query.match(/value\s*=\s*'([^']+)'/);
    const parent = query.match(/'([^']+)'\s+in\s+parents/);
    let matches = [...resources.values()];
    if (key && value) matches = matches.filter(item => item.appProperties?.[key[1]] === value[1]);
    if (parent) matches = matches.filter(item => item.parents.includes(parent[1]));
    if (/trashed\s*=\s*false/.test(query)) matches = matches.filter(item => !item.trashed);
    return { files: plain(matches) };
  }
  const advanced = {
    Files: {
      get: (id, params) => { calls.drive.push({ kind: 'advancedGet', id, params: plain(params || {}) }); if (id === ORIGINAL && options.rejectOriginalGetError) throw options.rejectOriginalGetError; if (id === SOURCE && options.rejectDestinationGetError) throw options.rejectDestinationGetError; return getResource(id); },
      create: createResource, copy: copyResource, update: updateResource, list: listResources,
      remove: id => { calls.actions.push({ kind: 'delete', id }); resources.delete(id); },
    },
  };
  const lock = {
    tryLock: () => { if (options.busy) return false; calls.lockDepth++; calls.events.push('lock'); return true; },
    releaseLock: () => { calls.events.push('unlock'); calls.lockDepth--; },
  };
  const cacheValues = new Map();
  const cache = { get: key => cacheValues.get(key) ?? null, put: (key, value) => cacheValues.set(key, value), remove: key => cacheValues.delete(key) };
  const serviceBook = { getId: () => STORAGE, getSheetByName: name => ({ name }) };
  const context = vm.createContext({
    console: { ...console, warn: value => calls.warnings.push(String(value)) },
    Date, JSON, Object, Array, Number, String, Boolean, RegExp, Math, Error, Set, Map, encodeURIComponent, decodeURIComponent,
    PropertiesService: { getScriptProperties: () => store },
    Session: {
      getActiveUser: () => ({ getEmail: () => options.activeEmail ?? MEMBER }),
      getEffectiveUser: () => ({ getEmail: () => options.effectiveEmail ?? options.activeEmail ?? MEMBER }),
    },
    DriveApp: {
      getFolderById: id => { calls.drive.push({ kind: 'folder', id }); return driveObject(id); },
      getFileById: id => { calls.drive.push({ kind: 'file', id }); return driveObject(id); },
    },
    ...(options.apiUnavailable ? {} : { Drive: advanced }),
    SpreadsheetApp: {
      openById: id => { calls.serviceOpens.push(id); calls.events.push('service-open'); if (id !== STORAGE) throw new Error('Business spreadsheet data must never be opened'); return serviceBook; },
      flush: () => {},
    },
    LockService: { getScriptLock: () => lock },
    CacheService: { getUserCache: () => cache, getScriptCache: () => cache },
    ScriptApp: { getOAuthToken: () => 'server-only-oauth-token' },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (algorithm, value) => [...crypto.createHash(algorithm).update(typeof value === 'string' ? value : Buffer.from(value)).digest()],
      base64EncodeWebSafe: value => Buffer.from(value).toString('base64url'),
      base64Encode: value => Buffer.from(value).toString('base64'),
      newBlob: (bytes, mime, name) => blob(name, mime, bytes),
      getUuid: () => crypto.randomUUID(),
      sleep: () => {},
    },
    UrlFetchApp: {
      fetch: (address, settings = {}) => {
        calls.fetches.push({ address, settings: plain(settings) });
        const url = new URL(address);
        assert.equal(url.origin, 'https://www.googleapis.com', 'resource-key requests use a fixed provider origin');
        assert.equal(settings.headers?.Authorization, 'Bearer server-only-oauth-token');
        const match = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)(\/copy)?$/);
        assert.ok(match, 'only fixed Drive file resource paths are used');
        const id = decodeURIComponent(match[1]);
        const item = resources.get(id);
        const key = settings.headers?.['X-Goog-Drive-Resource-Keys'];
        const withKey = !item?.resourceKey || key === `${id}/${item.resourceKey}`;
        let result;
        const method = String(settings.method || 'get').toLowerCase();
        if (options.restFailure && method === options.restFailure.method) return { getResponseCode: () => options.restFailure.status, getContentText: () => JSON.stringify({ error: { errors: [{ reason: options.restFailure.reason }] } }) };
        if (method === 'get') result = getResource(id, withKey);
        else if (method === 'post' && match[2]) result = copyResource(JSON.parse(settings.payload), id, Object.fromEntries(url.searchParams), withKey);
        else if (method === 'patch') result = updateResource(JSON.parse(settings.payload), id, null, Object.fromEntries(url.searchParams), withKey);
        else throw new Error('Unexpected resource-key HTTP operation');
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(result) };
      },
    },
  });
  const source = ['Config.gs','Code.gs','Segments.gs','SourceBases.gs','SourceImport.gs'].map(name => readFileSync(`${sourceDir}${name}`, 'utf8')).join('\n');
  vm.runInContext(source, context, { filename: 'source-import-backend.gs' });
  context.sourceBasesReadDatabase_ = () => {
    calls.metadataReads++;
    calls.events.push('metadata-preflight');
    if (options.storageError) throw context.registryError_('STORAGE_SCHEMA', 'Bad service schema');
    return { records: Object.fromEntries(records), relations: [], lastRow: options.databaseLastRow ?? Math.max(1, ...[...records.values()].map(record => record.row || 1)) };
  };
  context.sourceBaseWriteRecords_ = (sheet, changed) => {
    assert.ok(calls.lockDepth > 0, 'metadata registration must be locked');
    calls.registrations.push(plain(changed));
    if (options.metadataFailures > 0) { options.metadataFailures--; throw context.registryError_('STORAGE_WRITE', 'Service metadata write failed'); }
    for (const record of changed) records.set(record.fileId, plain(record));
  };
  installSharedApi(context, { accessKey: () => options.accessKey === undefined ? TEST_ACCESS_KEY : options.accessKey });
  const upload = (changes = {}) => plain(context.uploadSourceBase({ name: 'Новая база', baseType: 'general', status: 'collection', requestId: 'upload_request_1234567890', file: blob(), ...changes }));
  const link = (changes = {}) => plain(context.importSourceBaseLink({ url: `https://docs.google.com/spreadsheets/d/${ORIGINAL}/edit`, name: 'Импортированная база', baseType: 'general', status: 'collection', mode: 'copy', requestId: 'link_request_1234567890', ...changes }));
  const imported = () => [...resources.values()].filter(item => item.id.startsWith('imported_native_'));
  const receipts = () => [...properties.entries()].filter(([key, value]) => key.startsWith('IMPORT_') && value.startsWith('{')).map(([key, value]) => ({ key, ...JSON.parse(value) }));
  const seedDiscoveredRecord = (id, changes = {}) => {
    const item = resources.get(id);
    records.set(id, { fileId: id, fileName: item.name, mimeType: item.mimeType, url: item.webViewLink, format: 'Google Таблицы', baseType: 'general', status: 'collection', formatCheck: 'unchecked', revision: 1, present: true, updatedAt: new Date().toISOString(), updatedBy: MEMBER, row: records.size + 2, ...changes });
  };
  return { context, options, calls, properties, resources, records, upload, link, imported, receipts, seedDiscoveredRecord, resource };
}

function itemOf(result) { return result.item || result; }
function capture(callback) { try { return { value: callback() }; } catch (error) { return { error }; } }
function driveRejection(reason, status = 403) { return Object.assign(new Error('Provider detail must not be returned: private-file-name'), { details: { error: { code: status, errors: [{ reason }] } } }); }

test('owner-mode link imports cannot copy or move any external file, including resource-key links', () => {
  for (const mode of ['copy', 'move']) for (const resourceKey of ['', 'rk_external_1234567890']) {
    const f = fixture({ originalParent: OTHER });
    const original = f.resources.get(ORIGINAL);
    if (resourceKey) original.resourceKey = resourceKey;
    const before = plain(original);
    const url = `https://docs.google.com/spreadsheets/d/${ORIGINAL}/edit` + (resourceKey ? `?resourcekey=${resourceKey}` : '');
    assert.throws(() => f.link({ mode, url }), /SOURCE_SCOPE_REQUIRED/);
    assert.deepEqual(f.calls.actions, []);
    assert.deepEqual(f.calls.registrations, []);
    assert.deepEqual(original, before);
    assert.equal(f.calls.fetches.some(call => ['post', 'patch'].includes(call.settings.method)), false);
    assert.ok(f.calls.serviceOpens.every(id => id === STORAGE));
  }
});

test('registry tables outside source bases may be copied but never moved out of their section', () => {
  const copy = fixture({ originalParent: REGISTERED });
  const before = plain(copy.resources.get(ORIGINAL));
  assert.notEqual(itemOf(copy.link()).id, ORIGINAL);
  assert.deepEqual(copy.resources.get(ORIGINAL), before);
  const move = fixture({ originalParent: REGISTERED });
  assert.throws(() => move.link({ mode: 'move' }), /SOURCE_MOVE_SCOPE/);
  assert.deepEqual(move.calls.actions, []);
  assert.deepEqual(move.calls.registrations, []);
});

test('an unknown or ambiguous source ancestry is never a move permission', () => {
  for (const parents of [[], ['unknown_folder_1234567890'], [SOURCE_CHILD, OTHER]]) {
    const f = fixture();
    f.resources.get(ORIGINAL).parents = parents;
    assert.throws(() => f.link({ mode: 'move' }), /SOURCE_SCOPE_REQUIRED|SOURCE_MOVE_SCOPE/);
    assert.deepEqual(f.calls.actions, []);
  }
});

test('scope is checked again after preflight immediately before copy or move', () => {
  for (const mode of ['copy', 'move']) {
    const f = fixture({ onOriginalRead: (item, count) => { if (count === 2) item.parents = [OTHER]; } });
    assert.throws(() => f.link({ mode }), /SOURCE_SCOPE_REQUIRED/);
    assert.deepEqual(f.calls.actions, []);
    assert.deepEqual(f.calls.registrations, []);
  }
});

test('scope denial precedes pending artifact recovery and completed replay finalization', () => {
  for (const pending of [false, true]) {
    const options = pending ? { loseCopyResponse: true, hideRecovery: true } : {};
    const f = fixture(options);
    if (pending) assert.throws(() => f.link(), /UNCERTAIN/);
    else f.link();
    const registrations = f.calls.registrations.length;
    options.hideRecovery = false;
    f.resources.get(ORIGINAL).parents = [OTHER];
    const beforeLists = f.calls.lists.length;
    assert.throws(() => f.link(), /SOURCE_SCOPE_REQUIRED/);
    assert.equal(f.calls.actions.filter(action => action.kind === 'copy').length, 1);
    assert.equal(f.calls.registrations.length, registrations);
    assert.equal(f.calls.lists.length, beforeLists, 'out-of-scope original cannot enter recovery listing');
  }
});

test('explicit copy and move capability denials stop before writes without an ownership requirement', () => {
  const cases = [
    ['copy', { canCopy: false }, 'COPY_ACCESS_REQUIRED'],
    ['move', { canEdit: false }, 'MOVE_ACCESS_REQUIRED'],
    ['move', { canRename: false }, 'MOVE_ACCESS_REQUIRED'],
    ['move', { canMoveItemWithinDrive: false }, 'MOVE_ACCESS_REQUIRED'],
  ];
  for (const [mode, capabilities, code] of cases) {
    const f = fixture();
    Object.assign(f.resources.get(ORIGINAL).capabilities, capabilities);
    const snapshot = plain(f.resources.get(ORIGINAL));
    const denied = capture(() => f.link({ mode })).error;
    assert.match(denied.message, new RegExp(code));
    if (mode === 'move') assert.match(denied.message, /Право редактирования.*Создать копию/s);
    assert.deepEqual(f.calls.actions, []);
    assert.deepEqual(f.resources.get(ORIGINAL), snapshot);
    assert.equal(f.receipts()[0].attempted, false);
    assert.equal(f.receipts()[0].status, 'retryable');
  }
  const f = fixture();
  f.resources.get(ORIGINAL).ownedByMe = false;
  Object.assign(f.resources.get(ORIGINAL).capabilities, { canRename: true, canMoveItemWithinDrive: true });
  assert.equal(itemOf(f.link({ mode: 'move' })).id, ORIGINAL, 'writer may move when Google permits it; ownership alone is not a gate');
});

test('move capability uses the actual shared-drive boundary and never the add-only or remove-only flags', () => {
  for (const [sourceDrive, destinationDrive, deniedFlag] of [['', '', 'canMoveItemWithinDrive'], ['shared_drive_a', 'shared_drive_a', 'canMoveItemWithinDrive'], ['', 'shared_drive_b', 'canMoveItemOutOfDrive'], ['shared_drive_a', '', 'canMoveItemOutOfDrive']]) {
    const f = fixture();
    f.resources.get(ORIGINAL).driveId = sourceDrive;
    f.resources.get(SOURCE).driveId = destinationDrive;
    Object.assign(f.resources.get(ORIGINAL).capabilities, { canMoveItemWithinDrive: true, canMoveItemOutOfDrive: true, [deniedFlag]: false });
    assert.throws(() => f.link({ mode: 'move' }), /MOVE_ACCESS_REQUIRED/);
    assert.deepEqual(f.calls.actions, []);
  }
  const f = fixture();
  Object.assign(f.resources.get(ORIGINAL).capabilities, { canMoveItemWithinDrive: true, canMoveItemOutOfDrive: false, canAddMyDriveParent: false, canRemoveMyDriveParent: false });
  f.link({ mode: 'move' });
  assert.equal(f.calls.actions.filter(action => action.kind === 'update').length, 1);
});

test('destination add permission is required for new children but not an existing child metadata update', () => {
  for (const mode of ['upload', 'copy', 'move']) {
    const f = fixture();
    f.resources.get(SOURCE).capabilities.canAddChildren = false;
    assert.throws(() => mode === 'upload' ? f.upload() : f.link({ mode }), /DESTINATION_ACCESS_REQUIRED/);
    assert.deepEqual(f.calls.actions, []);
  }
  const f = fixture(), original = f.resources.get(ORIGINAL);
  original.parents = [SOURCE];
  Object.assign(original.capabilities, { canEdit: true, canRename: false, canMoveItemWithinDrive: false, canMoveItemOutOfDrive: false });
  f.resources.get(SOURCE).capabilities.canAddChildren = false;
  f.link({ mode: 'move', name: original.name });
  assert.equal(f.calls.actions.length, 1);
  assert.equal(f.calls.actions[0].kind, 'update');
  assert.equal(f.calls.actions[0].params.addParents, undefined);
  assert.equal(f.calls.actions[0].params.removeParents, undefined);
  assert.equal(Object.hasOwn(f.calls.actions[0].metadata, 'name'), false, 'an unchanged title must not request a forbidden rename');
});

test('absent capabilities stay unknown and positive capabilities do not override an actual Drive rejection', () => {
  for (const mode of ['upload', 'copy', 'move']) {
    const f = fixture();
    delete f.resources.get(SOURCE).capabilities;
    delete f.resources.get(ORIGINAL).capabilities;
    mode === 'upload' ? f.upload() : f.link({ mode });
    assert.equal(f.calls.actions.length, 1);
  }
  const f = fixture({ rejectUpdateError: driveRejection('insufficientFilePermissions') });
  Object.assign(f.resources.get(ORIGINAL).capabilities, { canRename: true, canMoveItemWithinDrive: true, canMoveItemOutOfDrive: true });
  assert.throws(() => f.link({ mode: 'move' }), /MOVE_ACCESS_REQUIRED/);
  assert.equal(f.calls.actions.length, 1);
  assert.equal(f.calls.actions[0].kind, 'update');
  assert.equal(f.receipts()[0].status, 'retryable');
  assert.equal(f.receipts()[0].attempted, false);
  assert.deepEqual(f.resources.get(ORIGINAL).parents, [SOURCE_CHILD]);
  assert.equal(f.imported().length, 0, 'a refused move never silently copies the source');
});

test('lost move recovery and completed replay do not require permission to add or mutate an existing result', () => {
  const options = { loseUpdateResponse: true, hideRecovery: true }, f = fixture(options);
  assert.throws(() => f.link({ mode: 'move' }), /UNCERTAIN/);
  assert.equal(f.receipts()[0].attempted, true);
  options.hideRecovery = false;
  f.resources.get(SOURCE).capabilities.canAddChildren = false;
  Object.assign(f.resources.get(ORIGINAL).capabilities, { canEdit: false, canRename: false, canMoveItemWithinDrive: false, canMoveItemOutOfDrive: false });
  assert.equal(itemOf(f.link({ mode: 'move' })).id, ORIGINAL);
  assert.equal(itemOf(f.link({ mode: 'move' })).id, ORIGINAL);
  assert.equal(f.calls.actions.length, 1);
  assert.equal(f.calls.actions[0].kind, 'update');
  assert.deepEqual(f.calls.trashes, []);
});

test('source, destination, copy, move and recovery rejections keep their own safe context', () => {
  for (const [option, mode, code, status] of [
    ['rejectOriginalGetError', 'copy', 'SOURCE_ACCESS_REQUIRED', 403],
    ['rejectOriginalGetError', 'move', 'SOURCE_NOT_FOUND', 404],
    ['rejectDestinationGetError', 'move', 'DESTINATION_ACCESS_REQUIRED', 403],
    ['rejectDestinationGetError', 'copy', 'DESTINATION_NOT_FOUND', 404],
    ['rejectCopyError', 'copy', 'COPY_ACCESS_REQUIRED', 403],
    ['rejectUpdateError', 'move', 'MOVE_ACCESS_REQUIRED', 403],
    ['rejectListError', 'move', 'IMPORT_RECOVERY_ACCESS_REQUIRED', 403],
  ]) {
    const f = fixture({ [option]: driveRejection(status === 404 ? 'notFound' : 'insufficientFilePermissions', status) });
    const error = capture(() => f.link({ mode })).error;
    assert.match(error.message, new RegExp(code));
    assert.doesNotMatch(error.message, /private-file-name|server-only-oauth-token/);
    assert.equal(f.imported().length, 0);
    if (option === 'rejectListError') assert.doesNotMatch(error.message, /MOVE_ACCESS_REQUIRED|право переносить/);
  }
});

test('structured quota, policy, OAuth and 403 rate errors are distinguished without weakening retry receipts', () => {
  for (const [reason, code] of [['storageQuotaExceeded', 'DRIVE_STORAGE_FULL'], ['fileOwnerNotMemberOfTeamDrive', 'DRIVE_POLICY_REQUIRED'], ['fileWriterTeamDriveMoveInDisabled', 'DRIVE_POLICY_REQUIRED'], ['teamDriveMembershipRequired', 'DRIVE_POLICY_REQUIRED'], ['domainPolicy', 'DRIVE_POLICY_REQUIRED'], ['insufficientPermissions', 'DRIVE_AUTH_REQUIRED'], ['userRateLimitExceeded', 'DRIVE_BUSY']]) {
    const options = { rejectUpdateError: driveRejection(reason) }, f = fixture(options);
    assert.throws(() => f.link({ mode: 'move' }), new RegExp(code));
    assert.equal(f.receipts()[0].status, 'retryable');
    assert.equal(f.receipts()[0].attempted, false);
    assert.deepEqual(f.resources.get(ORIGINAL).parents, [SOURCE_CHILD]);
    options.rejectUpdateError = null;
    f.link({ mode: 'move' });
    assert.equal(f.calls.actions.filter(action => action.kind === 'update').length, 2);
    assert.equal(f.calls.actions.filter(action => action.kind === 'copy').length, 0);
  }
});

test('resource-key REST moves preserve contextual quota and access errors without leaking provider data', () => {
  for (const [reason, code] of [['insufficientFilePermissions', 'MOVE_ACCESS_REQUIRED'], ['storageQuotaExceeded', 'DRIVE_STORAGE_FULL'], ['userRateLimitExceeded', 'DRIVE_BUSY']]) {
    const f = fixture({ restFailure: { method: 'patch', status: 403, reason } });
    f.resources.get(ORIGINAL).resourceKey = 'rk_access_1234567890';
    assert.throws(() => f.link({ mode: 'move', url: 'https://docs.google.com/spreadsheets/d/' + ORIGINAL + '/edit?resourcekey=rk_access_1234567890' }), new RegExp(code));
    assert.equal(f.receipts()[0].status, 'retryable');
    assert.equal(f.receipts()[0].attempted, false);
    assert.deepEqual(f.resources.get(ORIGINAL).parents, [SOURCE_CHILD]);
    assert.deepEqual(f.calls.actions, []);
  }
});

test('only anchored provider rejection prefixes classify storage and shared-drive policy failures', () => {
  for (const [text, code] of [["The user's Drive storage quota has been exceeded.", 'DRIVE_STORAGE_FULL'], ['Cannot move a file into a shared drive as a writer when the owner of the file is not a member of that shared drive.', 'DRIVE_POLICY_REQUIRED']]) {
    const known = fixture({ rejectUpdateError: new Error('API call to drive.files.update failed with error: ' + text) });
    assert.throws(() => known.link({ mode: 'move' }), new RegExp(code));
    assert.equal(known.receipts()[0].status, 'retryable');
    const unknown = fixture({ rejectUpdateError: new Error('Socket closed after write: ' + text) });
    assert.throws(() => unknown.link({ mode: 'move' }), /UNCERTAIN/);
    assert.equal(unknown.receipts()[0].attempted, true);
    assert.equal(unknown.receipts()[0].status, 'pending');
  }
});

test('loading the module performs no Drive action or spreadsheet access', () => {
  const f = fixture();
  assert.deepEqual(f.calls.actions, []);
  assert.deepEqual(f.calls.drive, []);
  assert.deepEqual(f.calls.serviceOpens, []);
});

test('both import APIs require the shared key before inspecting Drive or service storage', () => {
  for (const options of [{ accessKey: '' }, { accessKey: 'wrong' }, { accessKey: null }]) {
    const f = fixture(options);
    assert.throws(() => f.upload());
    assert.throws(() => f.link());
    assert.deepEqual(f.calls.actions, []);
    assert.deepEqual(f.calls.drive, []);
    assert.deepEqual(f.calls.serviceOpens, []);
  }
});

test('CSV, TSV, XLS, XLSX and ODS uploads create native Sheets in the fixed source folder', () => {
  const cases = [
    ['csv','text/csv'], ['tsv','text/tab-separated-values'], ['xls','application/vnd.ms-excel'],
    ['xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ['ods','application/vnd.oasis.opendocument.spreadsheet'],
  ];
  for (const [extension, mime] of cases) {
    const f = fixture();
    const result = itemOf(f.upload({ file: blob(`companies.${extension}`, mime), baseType: 'lpr', status: 'ready' }));
    const created = f.imported()[0];
    assert.equal(created.mimeType, SHEET_MIME);
    assert.deepEqual(created.parents, [SOURCE]);
    assert.equal(created.name, 'Новая база');
    assert.equal(result.id || result.fileId, created.id);
    assert.equal(f.records.get(created.id).baseType, 'lpr');
    assert.equal(f.records.get(created.id).status, 'ready');
    assert.ok(created.appProperties.registryImportKey);
    assert.ok(created.appProperties.registryImportFingerprint);
    assert.ok(f.calls.events.indexOf('metadata-preflight') < f.calls.events.indexOf('create'));
    assert.ok(f.calls.serviceOpens.every(id => id === STORAGE));
  }
});

test('unsupported, mismatched, empty and oversized uploads are rejected before file creation', () => {
  const huge = blob('too-large.csv', 'text/csv', { length: 10 * 1024 * 1024 + 1 });
  for (const file of [blob('payload.exe','application/octet-stream'), blob('wrong.csv','image/png'), blob('empty.csv','text/csv',[]), huge]) {
    const f = fixture();
    assert.throws(() => f.upload({ file }));
    assert.deepEqual(f.calls.actions, []);
  }
});

test('invalid names, classifications and request IDs cannot trigger Drive mutations', () => {
  for (const change of [{ name: 'x'.repeat(101) }, { baseType: 'guessed' }, { status: 'invented' }, { requestId: 'tiny' }]) {
    const f = fixture();
    assert.throws(() => f.upload(change));
    assert.deepEqual(f.calls.actions, []);
  }
});

test('bad service schema blocks upload, copy and move before their Drive actions', () => {
  const f = fixture({ storageError: true });
  assert.throws(() => f.upload());
  assert.throws(() => f.link());
  assert.throws(() => f.link({ mode: 'move' }));
  assert.deepEqual(f.calls.actions, []);
  assert.equal(f.calls.registrations.length, 0);
});

test('service storage outside the registry root blocks every import before it is opened', () => {
  const f = fixture({ storageParent: OTHER });
  assert.throws(() => f.upload());
  assert.throws(() => f.link());
  assert.deepEqual(f.calls.serviceOpens, []);
  assert.deepEqual(f.calls.actions, []);
});

test('copy imports an in-registry native Sheet into the fixed destination without changing the original', () => {
  const f = fixture();
  const original = plain(f.resources.get(ORIGINAL));
  const result = itemOf(f.link());
  assert.notEqual(result.id || result.fileId, ORIGINAL);
  assert.deepEqual(f.resources.get(ORIGINAL), original);
  assert.deepEqual(f.imported()[0].parents, [SOURCE]);
  assert.equal(f.calls.actions.filter(action => action.kind === 'copy').length, 1);
  assert.ok(f.calls.events.indexOf('metadata-preflight') < f.calls.events.indexOf('copy'));
  assert.deepEqual(f.calls.trashes, []);
});

test('move preserves the original ID and applies destination, title and receipt tags in one Drive update', () => {
  const f = fixture();
  const result = itemOf(f.link({ mode: 'move', baseType: 'lpr', status: 'ready' }));
  assert.equal(result.id || result.fileId, ORIGINAL);
  const original = f.resources.get(ORIGINAL);
  assert.deepEqual(original.parents, [SOURCE]);
  assert.equal(original.name, 'Импортированная база');
  assert.ok(original.appProperties.registryImportKey);
  assert.ok(original.appProperties.registryImportFingerprint);
  const updates = f.calls.actions.filter(action => action.kind === 'update');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].params.addParents, SOURCE);
  assert.ok(String(updates[0].params.removeParents).includes(SOURCE_CHILD));
  assert.ok(updates[0].metadata.appProperties.registryImportKey);
  assert.equal(f.calls.actions.filter(action => action.kind === 'create' || action.kind === 'copy').length, 0);
  assert.deepEqual(f.calls.trashes, []);
});

test('the protected service spreadsheet cannot be copied or moved as a source', () => {
  for (const mode of ['copy','move']) {
    const f = fixture();
    assert.throws(() => f.link({ url: STORAGE, mode }));
    assert.deepEqual(f.calls.actions, []);
  }
});

test('a link must resolve to a native Google Sheet, not an Excel or CSV source file', () => {
  const f = fixture();
  f.resources.get(ORIGINAL).mimeType = 'text/csv';
  assert.throws(() => f.link());
  assert.deepEqual(f.calls.actions, []);
});

test('native links accept a raw file ID and an account-indexed /u/N/d/ path', () => {
  for (const url of [ORIGINAL, `https://docs.google.com/spreadsheets/u/2/d/${ORIGINAL}/edit#gid=7`]) {
    const f = fixture();
    const result = itemOf(f.link({ url }));
    assert.ok(result.id || result.fileId);
    assert.equal(f.calls.actions.filter(action => action.kind === 'copy').length, 1);
  }
});

test('URL validation rejects wrong origins, protocols, published paths and duplicate resource keys', () => {
  const invalid = [
    `https://docs.google.com.evil.invalid/spreadsheets/d/${ORIGINAL}/edit`,
    `https://evil.invalid/spreadsheets/d/${ORIGINAL}/edit`,
    `http://docs.google.com/spreadsheets/d/${ORIGINAL}/edit`,
    'https://docs.google.com/spreadsheets/d/e/published-token/pubhtml',
    `https://docs.google.com/spreadsheets/d/${ORIGINAL}/edit?resourcekey=key_one_1234567890&resourcekey=key_two_1234567890`,
    `https://docs.google.com/spreadsheets/d/${ORIGINAL}/edit?resourcekey=key_one_1234567890&%72esourceKey=key_two_1234567890`,
    `https://docs.google.com/spreadsheets/d/${ORIGINAL}/edit?resourcekey=%E0%A4%A`,
    `https://docs.google.com/spreadsheets/u/wrong/d/${ORIGINAL}/edit`,
  ];
  for (const url of invalid) {
    const f = fixture();
    assert.throws(() => f.link({ url }));
    assert.deepEqual(f.calls.actions, []);
  }
});

test('resource-key links use fixed Google API URLs and keep OAuth credentials server-side', () => {
  const f = fixture();
  const key = 'rk_access_1234567890';
  f.resources.get(ORIGINAL).resourceKey = key;
  const result = f.link({ url: `https://docs.google.com/spreadsheets/d/${ORIGINAL}/edit?resourcekey=${key}` });
  assert.ok(f.calls.fetches.length >= 1);
  assert.ok(f.calls.fetches.every(call => call.address.startsWith('https://www.googleapis.com/drive/v3/files/')));
  assert.ok(f.calls.fetches.some(call => call.settings.headers?.['X-Goog-Drive-Resource-Keys'] === `${ORIGINAL}/${key}`));
  assert.ok(!JSON.stringify(result).includes('server-only-oauth-token'));
  assert.ok(!JSON.stringify(result).includes(key));
  assert.equal(f.calls.actions.filter(action => action.kind === 'copy').length, 1);
});

test('a lost create response is recovered by tags without creating a duplicate', () => {
  const f = fixture({ loseCreateResponse: true });
  capture(() => f.upload());
  const result = itemOf(f.upload());
  assert.equal(f.imported().length, 1);
  assert.equal(result.id || result.fileId, f.imported()[0].id);
  assert.equal(f.calls.actions.filter(action => action.kind === 'create').length, 1);
  for (const query of f.calls.lists.filter(query => String(query.q).includes('registryImportKey'))) {
    assert.doesNotMatch(query.q, /\bin\s+parents|trashed\s*=\s*false/);
  }
});

test('pending recovery includes outside and trashed tagged files instead of creating replacements', () => {
  for (const state of ['outside','trashed']) {
    const options = { loseCreateResponse: true, hideRecovery: true };
    const f = fixture(options);
    assert.ok(capture(() => f.upload()).error);
    const created = f.imported()[0];
    if (state === 'outside') created.parents = [OTHER];
    else created.trashed = true;
    options.hideRecovery = false;
    assert.throws(() => f.upload());
    assert.equal(f.calls.actions.filter(action => action.kind === 'create').length, 1);
    assert.equal(f.calls.registrations.length, 0);
  }
});

test('metadata failure preserves a created file and the same request repairs it without another create', () => {
  const f = fixture({ metadataFailures: 1 });
  assert.ok(capture(() => f.upload()).error);
  const created = f.imported()[0];
  assert.ok(created);
  assert.equal(created.trashed, false);
  assert.deepEqual(f.calls.trashes, []);
  const result = itemOf(f.upload());
  assert.equal(result.id || result.fileId, created.id);
  assert.equal(f.calls.actions.filter(action => action.kind === 'create').length, 1);
  assert.equal(f.records.get(created.id).status, 'collection');
});

test('repair applies requested type and status to an untouched auto-discovered revision-one default row', () => {
  const f = fixture({ metadataFailures: 1 });
  const changes = { baseType: 'lpr', status: 'ready' };
  assert.ok(capture(() => f.upload(changes)).error);
  const id = f.imported()[0].id;
  f.seedDiscoveredRecord(id);
  const result = itemOf(f.upload(changes));
  assert.equal(result.id || result.fileId, id);
  assert.equal(f.records.get(id).baseType, 'lpr');
  assert.equal(f.records.get(id).status, 'ready');
  assert.equal(f.calls.actions.filter(action => action.kind === 'create').length, 1);
});

test('repair preserves newer or manually changed discovered rows', () => {
  for (const changes of [{ revision: 2, status: 'rework', baseType: 'general', formatCheck: 'invalid' }, { revision: 1, status: 'rework', baseType: 'general' }]) {
    const f = fixture({ metadataFailures: 1 });
    const request = { baseType: 'lpr', status: 'ready' };
    assert.ok(capture(() => f.upload(request)).error);
    const id = f.imported()[0].id;
    f.seedDiscoveredRecord(id, changes);
    f.upload(request);
    assert.equal(f.records.get(id).status, changes.status);
    assert.equal(f.records.get(id).baseType, changes.baseType);
    if (changes.formatCheck) assert.equal(f.records.get(id).formatCheck, changes.formatCheck);
  }
});

test('replaying a completed import returns current metadata and does not overwrite later manual edits', () => {
  const f = fixture();
  const first = itemOf(f.upload());
  const id = first.id || first.fileId;
  Object.assign(f.records.get(id), { status: 'rework', baseType: 'lpr', formatCheck: 'valid', revision: 2 });
  const result = itemOf(f.upload());
  assert.equal(result.status, 'rework');
  assert.equal(result.baseType, 'lpr');
  assert.equal(f.records.get(id).formatCheck, 'valid');
  assert.equal(f.calls.actions.filter(action => action.kind === 'create').length, 1);
});

test('an import request ID is bound to the bytes, title, type and initial status', () => {
  for (const change of [
    { file: blob('companies.csv','text/csv',[65,44,66,10,51,44,52]) },
    { name: 'Другое имя' }, { baseType: 'lpr' }, { status: 'ready' },
  ]) {
    const f = fixture();
    f.upload();
    assert.throws(() => f.upload(change), /REUSED|FINGERPRINT|REQUEST/);
    assert.equal(f.calls.actions.filter(action => action.kind === 'create').length, 1);
  }
});

test('the same link request cannot silently switch from copy to move', () => {
  const f = fixture();
  f.link();
  assert.throws(() => f.link({ mode: 'move' }), /REUSED|FINGERPRINT|REQUEST/);
  assert.equal(f.calls.actions.filter(action => action.kind === 'copy').length, 1);
  assert.equal(f.calls.actions.filter(action => action.kind === 'update').length, 0);
});

test('an uncertain move preserves the original and recovers by its own tags', () => {
  const f = fixture({ loseUpdateResponse: true });
  capture(() => f.link({ mode: 'move' }));
  const result = itemOf(f.link({ mode: 'move' }));
  assert.equal(result.id || result.fileId, ORIGINAL);
  assert.equal(f.resources.get(ORIGINAL).trashed, false);
  assert.deepEqual(f.resources.get(ORIGINAL).parents, [SOURCE]);
  assert.deepEqual(f.calls.trashes, []);
  assert.equal(f.calls.actions.filter(action => action.kind === 'update').length, 1);
});

test('retrying a pending move refuses an externally changed original without moving it again', () => {
  const options = { failUpdateBeforeApply: true };
  const f = fixture(options);
  assert.ok(capture(() => f.link({ mode: 'move' })).error);
  f.resources.get(ORIGINAL).name = 'Изменено другим участником';
  options.failUpdateBeforeApply = false;
  assert.throws(() => f.link({ mode: 'move' }));
  assert.equal(f.calls.actions.filter(action => action.kind === 'update').length, 1);
  assert.equal(f.resources.get(ORIGINAL).name, 'Изменено другим участником');
  assert.deepEqual(f.resources.get(ORIGINAL).parents, [SOURCE_CHILD]);
  assert.deepEqual(f.calls.trashes, []);
});

test('missing Drive API setup produces an actionable error before any mutation', () => {
  const f = fixture({ apiUnavailable: true });
  assert.throws(() => f.upload(), error => {
    assert.match(error.message, /Drive|DRIVE/);
    assert.match(error.message, /API|служб|настро|включ/i);
    return true;
  });
  assert.deepEqual(f.calls.actions, []);
});

test('a pending request with no confirmed recovery match never blindly sends a second create', () => {
  const f = fixture({ loseCreateResponse: true, hideRecovery: true });
  assert.ok(capture(() => f.upload()).error);
  assert.throws(() => f.upload());
  assert.equal(f.calls.actions.filter(action => action.kind === 'create').length, 1);
});

test('shared-link requests deduplicate the same action independently of Google account identities', () => {
  const options = {};
  const f = fixture(options);
  const first = itemOf(f.upload());
  options.activeEmail = 'second@example.com';
  f.properties.set('ALLOWED_EMAILS', '');
  const second = itemOf(f.upload());
  assert.equal(first.id || first.fileId, second.id || second.fileId);
  assert.equal(f.calls.actions.filter(action => action.kind === 'create').length, 1);
});

test('generic browser MIME types are normalized to the explicit conversion MIME by extension', () => {
  for (const [name, declared, normalized] of [
    ['data.csv','application/octet-stream','text/csv'],
    ['data.tsv','text/plain','text/tab-separated-values'],
    ['data.xlsx','application/zip','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ]) {
    const f = fixture();
    f.upload({ file: blob(name, declared) });
    assert.equal(f.calls.actions.find(action => action.kind === 'create').blobMime, normalized);
  }
});

test('stable Google API rejection messages are definite failures with retryable receipts', () => {
  const cases = [
    ['rejectCreateError', 'API call to drive.files.create failed with error: Insufficient Permission', 'DESTINATION_ACCESS_REQUIRED', 'upload'],
    ['rejectCreateError', 'API call to drive.files.create failed with error: Conversion of the uploaded content to the requested output type is not supported', 'IMPORT_FAILED', 'upload'],
    ['rejectCopyError', 'API call to drive.files.copy failed with error: This file cannot be copied by the user', 'COPY_ACCESS_REQUIRED', 'copy'],
    ['rejectUpdateError', 'API call to drive.files.update failed with error: User Rate Limit Exceeded', 'DRIVE_BUSY', 'move'],
  ];
  for (const [key, message, code, mode] of cases) {
    const f = fixture({ [key]: new Error(message) });
    const invoke = () => mode === 'upload' ? f.upload() : f.link({ mode });
    assert.throws(invoke, new RegExp(code));
    assert.equal(f.imported().length, 0);
    assert.equal(f.receipts()[0].status, 'retryable');
    assert.equal(f.receipts()[0].attempted, false);
    assert.deepEqual(f.calls.trashes, []);
  }
});

test('pre-action metadata failure leaves a retryable receipt and allows the same request after access is restored', () => {
  const options = { rejectOriginalGetError: new Error('API call to drive.files.get failed with error: File not found: ' + ORIGINAL) };
  const f = fixture(options);
  assert.throws(() => f.link(), /SOURCE_NOT_FOUND/);
  assert.deepEqual(f.calls.actions, []);
  assert.equal(f.receipts()[0].status, 'retryable');
  assert.equal(f.receipts()[0].attempted, false);
  options.rejectOriginalGetError = null;
  f.link();
  assert.equal(f.calls.actions.filter(action => action.kind === 'copy').length, 1);
});

test('permission-like words inside a transport error do not authorize a blind second creation', () => {
  const f = fixture({ rejectCreateError: new Error('Socket closed: Insufficient Permission') });
  assert.throws(() => f.upload(), /UNCERTAIN/);
  assert.equal(f.receipts()[0].status, 'pending');
  assert.equal(f.receipts()[0].attempted, true);
  assert.throws(() => f.upload(), /UNCERTAIN/);
  assert.equal(f.calls.actions.filter(action => action.kind === 'create').length, 1);
});

test('a full service register blocks conversion, copy and untracked move before mutation', () => {
  for (const mode of ['upload','copy','move']) {
    const f = fixture({ databaseLastRow: 5001 });
    assert.throws(() => mode === 'upload' ? f.upload() : f.link({ mode }), /STORAGE_LIMIT/);
    assert.deepEqual(f.calls.actions, []);
    assert.equal(f.calls.registrations.length, 0);
  }
});

test('a tracked move can use its captured pre-action revision even when the service register is full', () => {
  const f = fixture({ databaseLastRow: 5001 });
  f.seedDiscoveredRecord(ORIGINAL, { revision: 4, status: 'collection', baseType: 'general', present: false });
  const result = itemOf(f.link({ mode: 'move', baseType: 'lpr', status: 'ready' }));
  assert.equal(result.id || result.fileId, ORIGINAL);
  assert.equal(f.records.get(ORIGINAL).status, 'ready');
  assert.equal(f.records.get(ORIGINAL).baseType, 'lpr');
  assert.equal(f.records.get(ORIGINAL).revision, 5);
  Object.assign(f.records.get(ORIGINAL), { status: 'rework', revision: 6 });
  assert.equal(itemOf(f.link({ mode: 'move', baseType: 'lpr', status: 'ready' })).status, 'rework');
  assert.equal(f.calls.actions.filter(action => action.kind === 'update').length, 1);
});

test('metadata failure after moving an original never trashes it and repairs without another move', () => {
  const f = fixture({ metadataFailures: 1 });
  assert.ok(capture(() => f.link({ mode: 'move' })).error);
  assert.equal(f.resources.get(ORIGINAL).trashed, false);
  assert.deepEqual(f.resources.get(ORIGINAL).parents, [SOURCE]);
  assert.deepEqual(f.calls.trashes, []);
  const result = itemOf(f.link({ mode: 'move' }));
  assert.equal(result.id || result.fileId, ORIGINAL);
  assert.equal(f.calls.actions.filter(action => action.kind === 'update').length, 1);
});

test('ambiguous or fingerprint-mismatched recovery artifacts never produce replacements or registrations', () => {
  for (const state of ['ambiguous','tampered']) {
    const options = { loseCreateResponse: true, hideRecovery: true };
    const f = fixture(options);
    assert.ok(capture(() => f.upload()).error);
    const created = f.imported()[0];
    if (state === 'ambiguous') {
      f.resource('ambiguous_tagged_1234567890', created.name, SHEET_MIME, [OTHER], { appProperties: plain(created.appProperties) });
    } else {
      created.appProperties.registryImportFingerprint = 'wrong-fingerprint';
    }
    options.hideRecovery = false;
    assert.throws(() => f.upload(), /UNCERTAIN/);
    assert.equal(f.calls.actions.filter(action => action.kind === 'create').length, 1);
    assert.equal(f.calls.registrations.length, 0);
  }
});

test('a later recovery-list rejection cannot downgrade an earlier uncertain create into a new-create permission', () => {
  for (const message of [
    'API call to drive.files.list failed with error: User Rate Limit Exceeded',
    'API call to drive.files.list failed with error: Insufficient Permission',
  ]) {
    const options = { loseCreateResponse: true, hideRecovery: true };
    const f = fixture(options);
    assert.ok(capture(() => f.upload()).error);
    assert.equal(f.receipts()[0].status, 'pending');
    assert.equal(f.receipts()[0].attempted, true);
    options.rejectListError = new Error(message);
    assert.throws(() => f.upload());
    assert.equal(f.receipts()[0].status, 'pending');
    assert.equal(f.receipts()[0].attempted, true);
    options.rejectListError = null;
    assert.throws(() => f.upload());
    assert.equal(f.calls.actions.filter(action => action.kind === 'create').length, 1);
    assert.equal(f.imported().length, 1);
    assert.equal(f.calls.registrations.length, 0);
  }
});

test('a failed recovery GET preserves a pending move snapshot and later human changes are never moved again', () => {
  const options = { failUpdateBeforeApply: true };
  const f = fixture(options);
  assert.ok(capture(() => f.link({ mode: 'move' })).error);
  const snapshot = plain(f.receipts()[0].original);
  assert.equal(snapshot.id, ORIGINAL);
  assert.equal(f.receipts()[0].attempted, true);
  options.failUpdateBeforeApply = false;
  options.rejectOriginalGetError = new Error('API call to drive.files.get failed with error: Insufficient Permission');
  assert.throws(() => f.link({ mode: 'move' }));
  assert.deepEqual(f.receipts()[0].original, snapshot);
  assert.equal(f.receipts()[0].attempted, true);
  options.rejectOriginalGetError = null;
  f.resources.get(ORIGINAL).name = 'Переименовано человеком после неопределённого перемещения';
  assert.throws(() => f.link({ mode: 'move' }));
  assert.equal(f.calls.actions.filter(action => action.kind === 'update').length, 1);
  assert.deepEqual(f.resources.get(ORIGINAL).parents, [SOURCE_CHILD]);
  assert.deepEqual(f.calls.trashes, []);
  assert.equal(f.calls.registrations.length, 0);
});

test('viewer-only or unknown service-book edit capability blocks every import before metadata migration or Drive mutation', () => {
  for (const missing of [false, true]) {
    const f = fixture();
    f.resources.get(STORAGE).capabilities = missing ? {} : { canEdit: false };
    assert.equal(f.resources.get(SOURCE).capabilities.canAddChildren, true, 'destination folder remains writable');
    for (const invoke of [() => f.upload(), () => f.link(), () => f.link({ mode: 'move' })]) {
      assert.throws(invoke, /STORAGE_WRITE_REQUIRED/);
    }
    assert.equal(f.calls.metadataReads, 0, 'schema reads and possible migrations must not begin for a service-book viewer');
    assert.equal(f.calls.registrations.length, 0);
    assert.deepEqual(f.calls.actions, []);
    assert.deepEqual(f.calls.trashes, []);
    assert.ok(f.calls.drive.some(call => call.kind === 'advancedGet' && call.id === STORAGE && call.params.fields === 'capabilities(canEdit)'));
  }
});

test('canonical mixed contents persist for file conversion and linked copy or move', () => {
  for (const mode of ['upload', 'copy', 'move']) {
    const f = fixture();
    const result = mode === 'upload'
      ? itemOf(f.upload({ baseType: undefined, contentsJSON: '["lpr","companies"]', status: 'ready' }))
      : itemOf(f.link({ baseType: undefined, contents: ['lpr', 'companies'], mode, status: 'ready' }));
    assert.equal(result.baseType, 'mixed');
    assert.deepEqual(result.contents, ['companies', 'lpr']);
    assert.deepEqual(f.records.get(result.id).contents, ['companies', 'lpr']);
    assert.equal(result.status, 'ready');
    assert.equal(result.formatCheck, 'unchecked');
    assert.equal(f.calls.actions.length, 1);
  }
});

test('canonical single-content retries share legacy import receipt fingerprints without creating again', () => {
  for (const [legacy, contents] of [['general', ['companies']], ['lpr', ['lpr']]]) {
    const f = fixture();
    const first = itemOf(f.link({ baseType: legacy }));
    const fingerprint = f.receipts()[0].fingerprint;
    const replay = itemOf(f.link({ baseType: undefined, contents }));
    assert.equal(replay.id, first.id);
    assert.deepEqual(replay.contents, contents);
    assert.equal(f.receipts()[0].fingerprint, fingerprint);
    assert.equal(f.calls.actions.length, 1);
  }
});

test('changing canonical import contents binds the same request and cannot create a second file', () => {
  const f = fixture();
  const first = itemOf(f.upload({ baseType: undefined, contentsJSON: '["companies","lpr"]' }));
  assert.throws(() => f.upload({ baseType: undefined, contentsJSON: '["lpr"]' }), /REQUEST_REUSED/);
  const replay = itemOf(f.upload({ baseType: undefined, contentsJSON: '["lpr","companies"]' }));
  assert.equal(replay.id, first.id);
  assert.equal(f.calls.actions.length, 1);
});

test('invalid or conflicting upload and link contents are refused before any Drive mutation', () => {
  for (const change of [
    { baseType: undefined, contentsJSON: '[]' },
    { baseType: undefined, contentsJSON: '["companies","companies"]' },
    { baseType: undefined, contentsJSON: '["unknown"]' },
    { baseType: undefined, contentsJSON: '"mixed"' },
    { baseType: undefined, contentsJSON: '{' },
    { baseType: 'lpr', contentsJSON: '["companies","lpr"]' },
  ]) {
    const f = fixture();
    assert.throws(() => f.upload(change), /INVALID_/);
    assert.deepEqual(f.calls.actions, []);
    assert.deepEqual(f.calls.drive, []);
  }
  for (const contents of [[], ['companies', 'companies'], ['unknown'], 'mixed', null]) {
    const f = fixture();
    assert.throws(() => f.link({ baseType: undefined, contents }), /INVALID_CONTENTS/);
    assert.deepEqual(f.calls.actions, []);
  }
});
