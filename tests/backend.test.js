import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourceDir = fileURLToPath(new URL('../src/', import.meta.url));
const ROOT = '1WKcvDDKqYBo94eXsYc5vKp6OPtOzv6Wh';
const INSIDE = 'inside_sheet_1234567890';
const OUTSIDE = 'outside_sheet_1234567890';
const OTHER = 'outside_folder_1234567890';
const MEMBER = 'member@example.com';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

function iterator(items) {
  let position = 0;
  return { hasNext: () => position < items.length, next: () => items[position++] };
}

function fixture(options = {}) {
  const calls = { folder: 0, file: 0, open: 0, writes: 0, creates: 0, moves: 0, trashed: [], released: 0 };
  const properties = new Map(Object.entries({
    ROOT_FOLDER_ID: ROOT, ALLOWED_EMAILS: MEMBER, ADMIN_EMAILS: MEMBER,
    ...options.properties,
  }));
  const cache = new Map();
  const folders = new Map();
  const files = new Map();
  const books = new Map();
  const data = [['Компания', 'Сумма'], ['Атлас', 100], ['Север', 200]];
  function folder(id, name, parent = null) {
    const item = {
      id, name, parent,
      getId: () => id,
      getName: () => item.name,
      getUrl: () => `https://drive.google.com/drive/folders/${id}`,
      getParents: () => iterator(item.parent ? [folders.get(item.parent)] : []),
      getMimeType: () => 'application/vnd.google-apps.folder',
      isTrashed: () => false,
      getFilesByType: mime => iterator([...files.values()].filter(file => file.parent === id && !file.trashed && file.getMimeType() === mime)),
      getFiles: () => iterator([...files.values()].filter(file => file.parent === id && !file.trashed)),
      getFolders: () => iterator([...folders.values()].filter(child => child.parent === id)),
      setName: value => { item.name = value; return item; },
      createFolder: value => folder(`new_folder_${folders.size}_1234567890`, value, id),
    };
    folders.set(id, item);
    return item;
  }
  function file(id, name, parent) {
    const item = {
      id, name, parent, trashed: false,
      getId: () => id,
      getName: () => item.name,
      getUrl: () => `https://docs.google.com/spreadsheets/d/${id}/edit`,
      getMimeType: () => SHEET_MIME,
      getParents: () => iterator(item.parent ? [folders.get(item.parent)] : []),
      isTrashed: () => item.trashed,
      setName: value => { item.name = value; return item; },
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
  function book(id, name, rows = structuredClone(data)) {
    let maxRows = 1000;
    let maxColumns = 26;
    const cells = rows;
    const raw = (row, col) => cells[row - 1]?.[col - 1] ?? '';
    const store = (row, col, value) => {
      while (cells.length < row) cells.push([]);
      cells[row - 1][col - 1] = value;
      calls.writes++;
    };
    const sheet = {
      getSheetId: () => 7,
      getName: () => 'Лист 1',
      getMaxRows: () => maxRows,
      getMaxColumns: () => maxColumns,
      getLastRow: () => cells.length,
      getLastColumn: () => Math.max(1, ...cells.map(row => row.length)),
      insertRowsAfter: (after, count) => { maxRows += count; },
      insertColumnsAfter: (after, count) => { maxColumns += count; },
      appendRow: values => { cells.push(values); },
      getRange: (row, col, height = 1, width = 1) => {
        const matrix = transform => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => transform(raw(row + r, col + c))));
        const result = {
          getValue: () => raw(row, col),
          getDisplayValue: () => String(raw(row, col)),
          getFormula: () => String(raw(row, col)).startsWith('=') ? raw(row, col) : '',
          getValues: () => matrix(value => value),
          getDisplayValues: () => matrix(value => String(value)),
          getFormulas: () => matrix(value => typeof value === 'string' && value.startsWith('=') ? value : ''),
          getNumberFormats: () => matrix(() => 'General'),
          setValue: value => { store(row, col, value); return result; },
          setFormula: value => { store(row, col, value); return result; },
          clearContent: () => { store(row, col, ''); return result; },
          clear: () => { store(row, col, ''); return result; },
          getA1Notation: () => `${String.fromCharCode(64 + col)}${row}`,
        };
        return result;
      },
    };
    const item = {
      id, cells, sheet,
      getId: () => id,
      getName: () => files.get(id)?.name || name,
      getUrl: () => `https://docs.google.com/spreadsheets/d/${id}/edit`,
      getSheets: () => [sheet],
      getSheetById: requested => requested === 7 ? sheet : null,
      getSpreadsheetLocale: () => 'ru_RU',
      getSpreadsheetTimeZone: () => 'Europe/Moscow',
      setSpreadsheetLocale: () => item,
      setSpreadsheetTimeZone: () => item,
    };
    books.set(id, item);
    return item;
  }
  folder(ROOT, 'Реестр баз');
  folder(OTHER, 'Чужая папка');
  file(INSIDE, 'Клиенты', ROOT);
  file(OUTSIDE, 'Вне реестра', OTHER);
  book(INSIDE, 'Клиенты');
  book(OUTSIDE, 'Вне реестра');
  const propertyStore = {
    getProperty: key => properties.get(key) ?? null,
    getProperties: () => Object.fromEntries(properties),
    setProperty: (key, value) => { properties.set(key, String(value)); return propertyStore; },
    setProperties: values => { for (const [key, value] of Object.entries(values)) properties.set(key, String(value)); return propertyStore; },
    deleteProperty: key => { properties.delete(key); return propertyStore; },
  };
  const cacheStore = { get: key => cache.get(key) ?? null, put: (key, value) => cache.set(key, value), remove: key => cache.delete(key) };
  const lock = { waitLock: () => {}, tryLock: () => true, releaseLock: () => { calls.released++; } };
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
      openById: id => { calls.open++; if (!books.has(id)) throw new Error('Not found'); return books.get(id); },
      create: name => {
        calls.creates++;
        const id = `created_sheet_${calls.creates}_1234567890`;
        file(id, name, null);
        return book(id, name, []);
      },
      flush: () => {},
    },
    HtmlService: {
      createTemplateFromFile: () => ({ evaluate: () => ({ setTitle: () => ({ addMetaTag: () => ({}) }) }) }),
      createHtmlOutput: () => ({ setTitle: () => ({}) }),
      createHtmlOutputFromFile: () => ({ getContent: () => '' }),
    },
  });
  const source = ['Config.gs', 'Code.gs'].map(name => readFileSync(`${sourceDir}${name}`, 'utf8')).join('\n');
  vm.runInContext(source, context, { filename: 'AppsScript-backend.gs' });
  return { context, calls, properties, files, books, folders, data: books.get(INSIDE).cells };
}

const load = f => f.context.loadTable({ fileId: INSIDE, sheetId: 7, startRow: 1, startColumn: 1, rowCount: 10, columnCount: 4 });
const write = (f, value, expected) => f.context.writeCell({ fileId: INSIDE, sheetId: 7, row: 2, column: 2, value, expected });

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
    ['writeCell', { fileId: INSIDE, sheetId: 7, row: 2, column: 1, value: 'Новый клиент', expected: 'token' }],
  ];
  for (const [method, payload] of methods) assert.throws(() => f.context[method](payload), method);
  assert.equal(f.calls.creates + f.calls.writes + f.calls.moves, 0);
});

test('load and write reject a spreadsheet outside the configured folder before opening it', () => {
  const f = fixture();
  assert.throws(() => f.context.loadTable({ fileId: OUTSIDE, sheetId: 7 }));
  assert.throws(() => f.context.writeCell({ fileId: OUTSIDE, sheetId: 7, row: 2, column: 1, value: 'x', expected: 'x' }));
  assert.equal(f.calls.open, 0);
  assert.equal(f.calls.writes, 0);
});

test('stale cell revision rejects the write and preserves a newer value', () => {
  const f = fixture();
  const table = load(f);
  const revision = table.revisions[1][1];
  f.data[1][1] = 250;
  assert.throws(() => write(f, '300', revision), /CONFLICT/i);
  assert.equal(f.data[1][1], 250);
  assert.equal(f.calls.writes, 0);
  assert.equal(f.calls.released, 1);
});

test('valid cell writes store numbers but preserve identifiers with leading zeros', () => {
  const f = fixture();
  const table = load(f);
  const first = write(f, '0', table.revisions[1][1]);
  assert.equal(f.data[1][1], 0);
  assert.notEqual(first.revision, table.revisions[1][1]);
  write(f, '00123', first.revision);
  assert.equal(f.data[1][1], '00123');
});

test('base creation is idempotent for a repeated request and moves directly into requested folder', () => {
  const f = fixture();
  const payload = { parentId: ROOT, name: 'Новая база', requestId: 'request-create-base-123456' };
  const first = f.context.createBase(payload);
  const second = f.context.createBase(payload);
  assert.equal(first.file.id, second.file.id);
  assert.equal(f.calls.creates, 1);
  assert.equal(f.calls.moves, 1);
  assert.equal(f.files.get(first.file.id).parent, ROOT);
});

test('creation in a folder outside the registry is rejected without creating a spreadsheet', () => {
  const f = fixture();
  assert.throws(() => f.context.createBase({ parentId: OTHER, name: 'База', requestId: 'request-create-other-123456' }));
  assert.equal(f.calls.creates, 0);
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
  assert.throws(() => f.context.renameItem({ id: ROOT, kind: 'folder', name: 'Другое имя' }));
  assert.equal(f.folders.get(ROOT).name, 'Реестр баз');
});


test('a missing revision token cannot overwrite a cell', () => {
  const f = fixture();
  assert.throws(() => write(f, '999', undefined), /INVALID_REQUEST/);
  assert.equal(f.data[1][1], 100);
  assert.equal(f.calls.writes, 0);
});

test('table RPC payloads serialize date-valued cells as editable strings', () => {
  const f = fixture();
  f.data[1][1] = new Date('2026-11-15T10:00:00Z');
  const table = load(f);
  assert.equal(typeof table.values[1][1], 'string');
  assert.equal(typeof table.inputs[1][1], 'string');
  assert.equal(typeof table.revisions[1][1], 'string');
  const encoded = JSON.stringify(table);
  assert.ok(encoded.includes('Атлас'));
});

test('reusing a creation request for a different name is rejected', () => {
  const f = fixture();
  const payload = { parentId: ROOT, name: 'Первая база', requestId: 'request-reuse-base-123456' };
  f.context.createBase(payload);
  assert.throws(() => f.context.createBase({ ...payload, name: 'Вторая база' }), /REQUEST_REUSED/);
  assert.equal(f.calls.creates, 1);
});

test('a created spreadsheet whose Drive lookup fails returns its recovery link and never duplicates on retry', () => {
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


test('retrying a rolled-back creation keeps one receipt index entry and then deduplicates success', () => {
  const options = { failMove: true };
  const f = fixture(options);
  const payload = { parentId: ROOT, name: 'Повтор базы', requestId: 'request-create-rollback-retry-123456' };
  assert.throws(() => f.context.createBase(payload), /CREATE_FAILED/);
  options.failMove = false;
  const created = f.context.createBase(payload);
  const repeated = f.context.createBase(payload);
  assert.equal(created.file.id, repeated.file.id);
  assert.equal(f.calls.creates, 2);
  const index = JSON.parse(f.properties.get('CREATE_RECEIPT_INDEX'));
  assert.equal(index.length, 1);
  assert.equal(new Set(index).size, 1);
  assert.equal(f.files.get(created.file.id).parent, ROOT);
});
