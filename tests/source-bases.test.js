import { TEST_ACCESS_KEY, TEST_ACCESS_HASH, SHARED_ACTOR, installSharedApi, runShared } from './helpers/shared-link.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourceDir = fileURLToPath(new URL('../src/', import.meta.url));
const ROOT = '1WKcvDDKqYBo94eXsYc5vKp6OPtOzv6Wh';
const SOURCE = '1deuP0ovOC70PrElQKZjSjuvSMgPF0J7r';
const OUTREACH = '1sQ8WrTgdEOPTPYLIwoBwHb6gL_ULT4yu';
const STORAGE = '1lzbjoPNnrVn5-8GoAhaLZPS_S8J0lfcaoO8Ybxw396M';
const OTHER = 'other_root_1234567890';
const CHILD = 'source_child_1234567890';
const NATIVE = 'source_native_1234567890';
const CSV = 'source_csv_1234567890';
const XLSX = 'source_xlsx_1234567890';
const PDF = 'source_pdf_1234567890';
const MEMBER = 'member@example.com';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const HEADERS = ['fileId','fileName','mimeType','url','format','status','formatCheck','revision','present','updatedAt','updatedBy','baseType','contents'];
const RELATION_HEADERS = ['fileId','segmentId','createdAt','createdBy'];
const plain = value => JSON.parse(JSON.stringify(value));
const iterator = items => {
  let position = 0;
  return { hasNext: () => position < items.length, next: () => items[position++] };
};
const rowFor = (id, overrides = {}) => HEADERS.map(key => ({
  fileId: id, fileName: 'Сохранённое имя.csv', mimeType: 'text/csv', url: `https://drive.google.com/file/d/${id}/view`,
  format: 'CSV', status: 'collection', formatCheck: 'unchecked', revision: 1, present: true,
  updatedAt: '2026-11-15T10:00:00.000Z', updatedBy: MEMBER, baseType: 'general', contents: JSON.stringify(overrides.baseType === 'lpr' ? ['lpr'] : overrides.baseType === 'mixed' ? ['companies','lpr'] : ['companies']), ...overrides,
})[key]);

function fixture(options = {}) {
  const properties = new Map(Object.entries({ ROOT_FOLDER_ID: ROOT, SHARED_ACCESS_KEY_SHA256: TEST_ACCESS_HASH, ALLOWED_EMAILS: MEMBER, ADMIN_EMAILS: MEMBER, ...options.properties }));
  const calls = { drive: [], opens: [], writes: [], reads: [], grows: [], events: [], folderLists: [], typedScans: [], ancestryReads: [], flushes: 0, lockDepth: 0 };
  const folders = new Map(), files = new Map();
  const propertiesStore = {
    getProperty: key => properties.get(key) ?? null,
    getProperties: () => Object.fromEntries(properties),
    setProperty: (key, value) => { properties.set(key, value); return propertiesStore; },
    setProperties: values => { for (const [key, value] of Object.entries(values)) properties.set(key, value); return propertiesStore; },
    deleteProperty: key => properties.delete(key),
  };
  function folder(id, name, parent = null, trashed = false) {
    const item = {
      id, name, parent, trashed,
      getId: () => id, getName: () => item.name, isTrashed: () => item.trashed,
      getUrl: () => `https://drive.google.com/drive/folders/${id}`,
      getParents: () => { calls.ancestryReads.push(id); return iterator(item.parent ? [folders.get(item.parent)] : []); },
      getFiles: () => {
        calls.events.push({ kind: 'scan', id, locked: calls.lockDepth > 0 });
        if (options.failScanFolder === id) throw new Error('Source scan failed');
        return iterator([...files.values()].filter(file => file.parent === id));
      },
      getFilesByType: mime => { calls.typedScans.push(id); return iterator([...files.values()].filter(file => file.parent === id && file.mime === mime)); },
      getFolders: () => { calls.folderLists.push(id); return iterator([...folders.values()].filter(child => child.parent === id)); },
    };
    folders.set(id, item);
    return item;
  }
  function file(id, name, mime, parent, url, trashed = false) {
    const item = {
      id, name, mime, parent, url: url || `https://drive.google.com/file/d/${id}/view`, trashed,
      getId: () => id, getName: () => item.name, getMimeType: () => item.mime,
      getUrl: () => item.url, isTrashed: () => item.trashed,
      getParents: () => { calls.ancestryReads.push(id); return iterator(item.parent ? [folders.get(item.parent)] : []); },
      getLastUpdated: () => new Date('2026-11-15T10:00:00Z'),
      getDateCreated: () => new Date('2026-11-14T10:00:00Z'),
    };
    files.set(id, item);
    return item;
  }
  folder(ROOT, 'Реестр баз'); folder(OTHER, 'Чужой реестр');
  folder(SOURCE, 'Исходные базы', ROOT); folder(CHILD, 'Импорт', SOURCE);
  file(STORAGE, 'Служебный реестр', SHEET_MIME, options.storageParent || ROOT);
  file(NATIVE, 'Нативная база', SHEET_MIME, SOURCE, `https://docs.google.com/spreadsheets/d/${NATIVE}/edit?usp=custom`);
  file(CSV, 'Компании.csv', 'text/csv', SOURCE, `https://drive.google.com/file/d/${CSV}/view?usp=csv-fixture`);
  file(XLSX, 'Импорт.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', CHILD);
  file(PDF, 'Описание.pdf', 'application/pdf', CHILD);
  file('source_trashed_1234567890', 'Удалённая.csv', 'text/csv', SOURCE, null, true);
  file('outside_file_1234567890', 'Не наш файл.csv', 'text/csv', OTHER);

  function sheet(name, rows, lastRowOverride) {
    const state = { name, rows: structuredClone(rows), formulas: new Map(), maxRows: Math.max(1000, rows.length) };
    const maximumColumns = () => Math.max(1, ...state.rows.map(row => row.length));
    const readAt = (row, col) => state.rows[row - 1]?.[col - 1] ?? '';
    const range = (row, column, rowCount = 1, columnCount = 1) => {
      if (typeof row !== 'number') throw new Error('Fixture expects numeric service ranges');
      if (row < 1 || column < 1 || rowCount < 1 || columnCount < 1 || row + rowCount - 1 > state.maxRows) throw new Error('Service range exceeds allocated grid');
      const matrix = transform => Array.from({ length: rowCount }, (_, r) => Array.from({ length: columnCount }, (_, c) => transform(readAt(row + r, column + c), row + r, column + c)));
      const result = {
        getValues: () => { calls.reads.push({ sheet: name, row, rowCount, locked: calls.lockDepth > 0 }); return matrix(value => value); },
        getDisplayValues: () => matrix(value => String(value)),
        getFormulas: () => matrix((value, r, c) => state.formulas.get(`${r}:${c}`) || ''),
        getValue: () => readAt(row, column),
        setValues: values => {
          calls.writes.push({ kind: 'values', sheet: name, row, column, values: structuredClone(values), locked: calls.lockDepth > 0 });
          calls.events.push({ kind: 'write', sheet: name, row, rowCount: values.length, locked: calls.lockDepth > 0 });
          for (let r = 0; r < values.length; r++) for (let c = 0; c < values[r].length; c++) {
            while (state.rows.length < row + r) state.rows.push([]);
            let value = values[r][c];
            const key = `${row + r}:${column + c}`;
            state.formulas.delete(key);
            if (typeof value === 'string' && value.startsWith("'")) value = value.slice(1);
            else if (typeof value === 'string' && value.startsWith('=')) state.formulas.set(key, value);
            state.rows[row + r - 1][column + c - 1] = value;
          }
          if (options.failWriteAfterApply) throw new Error('Service write failed after buffering');
          return result;
        },
        setValue: value => result.setValues([[value]]),
        setRichTextValue: rich => {
          const value = rich.getText();
          calls.writes.push({ kind: 'rich', sheet: name, row, column, values: [[value]], locked: calls.lockDepth > 0 });
          calls.events.push({ kind: 'rich', sheet: name, row, locked: calls.lockDepth > 0 });
          while (state.rows.length < row) state.rows.push([]);
          state.rows[row - 1][column - 1] = value;
          state.formulas.delete(`${row}:${column}`);
          return result;
        },
        setRichTextValues: richValues => {
          const values = richValues.map(richRow => richRow.map(value => value.getText()));
          calls.writes.push({ kind: 'richBatch', sheet: name, row, column, values, locked: calls.lockDepth > 0 });
          calls.events.push({ kind: 'richBatch', sheet: name, row, rowCount: values.length, locked: calls.lockDepth > 0 });
          for (let r = 0; r < values.length; r++) for (let c = 0; c < values[r].length; c++) {
            while (state.rows.length < row + r) state.rows.push([]);
            state.rows[row + r - 1][column + c - 1] = values[r][c];
            state.formulas.delete(`${row + r}:${column + c}`);
          }
          return result;
        },
        setNumberFormat: () => result,
        setNumberFormats: () => result,
        clearContent: () => result.setValues(Array.from({ length: rowCount }, () => Array(columnCount).fill(''))),
      };
      return result;
    };
    return {
      state, getName: () => name, getSheetId: () => name === 'SourceBases' ? 0 : 1,
      getLastRow: () => lastRowOverride ?? state.rows.length,
      getLastColumn: maximumColumns, getMaxRows: () => state.maxRows, getMaxColumns: () => 26,
      insertRowsAfter: (after, count) => {
        if (after !== state.maxRows || count < 1 || state.maxRows + count > 5001) throw new Error('Invalid service grid growth');
        calls.grows.push({ sheet: name, after, count, locked: calls.lockDepth > 0 });
        calls.events.push({ kind: 'grow', sheet: name, after, count, locked: calls.lockDepth > 0 });
        state.maxRows += count;
      },
      getRange: range,
      getDataRange: () => range(1, 1, state.rows.length, maximumColumns()),
      appendRow: values => range(state.rows.length + 1, 1, 1, values.length).setValues([values]),
    };
  }
  const sourceSheet = sheet('SourceBases', options.sourceRows || [HEADERS], options.sourceLastRow);
  const relationSheet = sheet('SourceBaseSegments', options.relationRows || [RELATION_HEADERS], options.relationLastRow);
  const book = {
    getId: () => STORAGE,
    getUrl: () => `https://docs.google.com/spreadsheets/d/${STORAGE}/edit`,
    getName: () => 'Служебный реестр',
    getSheetByName: name => name === 'SourceBases' ? sourceSheet : name === 'SourceBaseSegments' ? relationSheet : null,
    getSheets: () => [sourceSheet, relationSheet],
  };
  const lock = {
    tryLock: () => { if (options.busy) return false; calls.lockDepth++; calls.events.push({ kind: 'lock' }); if (options.onLock) options.onLock(); return true; },
    waitLock: () => { if (options.busy) throw new Error('Busy'); calls.lockDepth++; },
    releaseLock: () => { calls.events.push({ kind: 'unlock', locked: calls.lockDepth > 0 }); calls.lockDepth--; },
  };
  const cache = { get: () => null, put: () => {}, remove: () => {} };
  const context = vm.createContext({
    console, Date, JSON, Object, Array, Map, Set, Number, String, Boolean, RegExp, Error, Math, encodeURIComponent,
    PropertiesService: { getScriptProperties: () => propertiesStore },
    Session: {
      getActiveUser: () => ({ getEmail: () => options.activeEmail ?? MEMBER }),
      getEffectiveUser: () => ({ getEmail: () => options.effectiveEmail ?? options.activeEmail ?? MEMBER }),
    },
    DriveApp: {
      getFolderById: id => { calls.drive.push({ type: 'folder', id, locked: calls.lockDepth > 0 }); if (!folders.has(id)) throw new Error('Not found'); return folders.get(id); },
      getFileById: id => { calls.drive.push({ type: 'file', id, locked: calls.lockDepth > 0 }); if (!files.has(id)) throw new Error('Not found'); return files.get(id); },
    },
    SpreadsheetApp: {
      openById: id => { calls.opens.push(id); if (id !== STORAGE) throw new Error('Business sheets must never be opened'); return book; },
      flush: () => { calls.flushes++; calls.events.push({ kind: 'flush', locked: calls.lockDepth > 0 }); },
      newRichTextValue: () => {
        let text = '';
        const builder = { setText: value => { text = String(value); return builder; }, build: () => ({ getText: () => text }) };
        return builder;
      },
    },
    LockService: { getScriptLock: () => lock, getUserLock: () => lock },
    CacheService: { getUserCache: () => cache, getScriptCache: () => cache },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (algorithm, value) => [...crypto.createHash(algorithm).update(String(value)).digest()],
      base64EncodeWebSafe: value => Buffer.from(value).toString('base64url'),
    },
  });
  const source = ['Config.gs','Code.gs','Segments.gs','SourceBases.gs'].map(name => readFileSync(`${sourceDir}${name}`, 'utf8')).join('\n');
  vm.runInContext(source, context, { filename: 'source-bases-backend.gs' });
  installSharedApi(context, { accessKey: () => Object.hasOwn(options, 'accessKey') ? options.accessKey : TEST_ACCESS_KEY });
  const list = () => plain(context.getSourceBases());
  const patch = payload => plain(context.updateSourceBase(payload));
  const record = id => {
    const values = sourceSheet.state.rows.find((row, index) => index > 0 && row[0] === id);
    return values ? Object.fromEntries(HEADERS.map((name, index) => [name, values[index]])) : null;
  };
  return { context, calls, folders, files, sourceSheet, relationSheet, properties, list, patch, record, makeFolder: folder, makeFile: file };
}

test('source-base APIs authorize before Drive or service storage access', () => {
  for (const options of [
    { accessKey: null },
    { accessKey: 'wrong' },
    { accessKey: 'a'.repeat(43) },
  ]) {
    const f = fixture(options);
    assert.throws(() => f.list());
    assert.throws(() => f.patch({ id: CSV, status: 'ready', expectedRevision: 1 }));
    assert.deepEqual(f.calls.drive, []);
    assert.deepEqual(f.calls.opens, []);
  }
});

test('discovery returns all nested file formats and the actual Drive URLs without opening business sheets', () => {
  const f = fixture();
  const result = f.list();
  assert.equal(result.state, 'ready');
  assert.equal(result.source.id, SOURCE);
  assert.equal(result.storage.id, STORAGE);
  assert.deepEqual(result.items.map(item => item.id).sort(), [CSV, NATIVE, PDF, XLSX].sort());
  const csv = result.items.find(item => item.id === CSV);
  assert.equal(csv.url, f.files.get(CSV).url);
  assert.match(String(csv.format), /csv/i);
  assert.match(String(result.items.find(item => item.id === XLSX).format), /xls|excel/i);
  assert.ok(result.items.every(item => item.id !== STORAGE));
  assert.equal(result.canEdit, true);
  assert.ok(result.items.every(item => item.status === 'collection' && item.formatCheck === 'unchecked' && item.baseType === 'general' && Number.isSafeInteger(item.revision))); 
  assert.ok(f.calls.opens.every(id => id === STORAGE));
  for (const item of result.items) assert.equal(item.url, f.files.get(item.id).url);
});

test('a service spreadsheet outside the direct registry root is rejected before opening it', () => {
  const f = fixture({ storageParent: CHILD });
  const result = f.list();
  assert.equal(result.state, 'storage_unavailable');
  assert.deepEqual(f.calls.opens, []);
  assert.equal(result.items.length, 4);
  assert.equal(result.canEdit, false);
  assert.ok(result.items.every(item => item.revision === null && item.status === null && item.formatCheck === null && item.baseType === null && item.segments === null));
  assert.equal(f.calls.writes.length, 0);
});

test('corrupt service headers produce a read-only list and are never overwritten', () => {
  for (const options of [
    { sourceRows: [['bad-header']] },
    { relationRows: [['wrong-relations-header']] },
  ]) {
    const f = fixture(options);
    const before = JSON.stringify([f.sourceSheet.state.rows, f.relationSheet.state.rows]);
    const result = f.list();
    assert.equal(result.state, 'storage_unavailable');
    assert.equal(result.canEdit, false);
  assert.ok(result.items.every(item => item.revision === null && item.status === null && item.formatCheck === null && item.baseType === null && item.segments === null));
    assert.equal(f.calls.writes.length, 0);
    assert.equal(JSON.stringify([f.sourceSheet.state.rows, f.relationSheet.state.rows]), before);
  }
});

test('duplicate stored source IDs fail closed without rewriting either service tab', () => {
  const f = fixture({ sourceRows: [HEADERS, rowFor(CSV), rowFor(CSV, { revision: 2 })] });
  const result = f.list();
  assert.equal(result.state, 'storage_unavailable');
  assert.equal(result.canEdit, false);
  assert.equal(f.calls.writes.length, 0);
});

test('status and format checks persist by file ID when Drive renames the file', () => {
  const relation = [CSV, 'segment_a_1234567890', '2026-11-15T10:00:00Z', MEMBER];
  const f = fixture({ relationRows: [RELATION_HEADERS, relation] });
  const first = f.list().items.find(item => item.id === CSV);
  f.patch({ id: CSV, baseType: 'lpr', status: 'ready', formatCheck: 'valid', expectedRevision: first.revision });
  f.files.get(CSV).name = 'Переименованная база.csv';
  const result = f.list().items.find(item => item.id === CSV);
  assert.equal(result.status, 'ready');
  assert.equal(result.baseType, 'lpr');
  assert.equal(result.formatCheck, 'valid');
  assert.equal(result.id, CSV);
  assert.equal(result.name || result.fileName, 'Переименованная база.csv');
  assert.deepEqual(f.relationSheet.state.rows, [RELATION_HEADERS, relation]);
});

test('repeated synchronization of unchanged metadata does not rewrite rows or change revisions', () => {
  const f = fixture();
  const first = f.list();
  const writes = f.calls.writes.length;
  const second = f.list();
  assert.equal(f.calls.writes.length, writes);
  assert.deepEqual(second.items.map(item => [item.id, item.revision]).sort(), first.items.map(item => [item.id, item.revision]).sort());
});

test('removed sources are retained with present=false and regain their manual status when restored by ID', () => {
  const f = fixture();
  const first = f.list().items.find(item => item.id === CSV);
  f.patch({ id: CSV, baseType: 'lpr', status: 'rework', formatCheck: 'invalid', expectedRevision: first.revision });
  f.files.get(CSV).parent = OTHER;
  assert.ok(f.list().items.every(item => item.id !== CSV));
  assert.equal(f.record(CSV).present, false);
  f.files.get(CSV).parent = SOURCE;
  const restored = f.list().items.find(item => item.id === CSV);
  assert.equal(restored.status, 'rework');
  assert.equal(restored.baseType, 'lpr');
  assert.equal(restored.formatCheck, 'invalid');
  assert.equal(f.record(CSV).present, true);
});

test('stale patches conflict under a lock and do not overwrite the newer status', () => {
  const f = fixture();
  const initial = f.list().items.find(item => item.id === CSV);
  f.patch({ id: CSV, status: 'ready', expectedRevision: initial.revision });
  const before = f.calls.writes.length;
  f.calls.reads.length = 0;
  assert.throws(() => f.patch({ id: CSV, status: 'rework', expectedRevision: initial.revision }), /CONFLICT/);
  assert.equal(f.calls.writes.length, before);
  assert.equal(f.record(CSV).status, 'ready');
  const recordReads = f.calls.reads.filter(read => read.sheet === 'SourceBases' && (read.row > 1 || read.rowCount > 1));
  assert.ok(recordReads.length > 0);
  assert.ok(recordReads.every(read => read.locked));
  assert.equal(f.calls.lockDepth, 0);
});

test('invalid enums and attempts to assign segments are rejected without service writes', () => {
  const f = fixture();
  const initial = f.list().items.find(item => item.id === CSV);
  const before = f.calls.writes.length;
  assert.throws(() => f.patch({ id: CSV, status: 'invented', expectedRevision: initial.revision }));
  assert.throws(() => f.patch({ id: CSV, formatCheck: 'guessed-from-name', expectedRevision: initial.revision }));
  assert.throws(() => f.patch({ id: CSV, baseType: 'guessed-from-name', expectedRevision: initial.revision }));
  assert.throws(() => f.patch({ id: CSV, segmentId: 'segment_a_1234567890', expectedRevision: initial.revision }));
  assert.throws(() => f.patch({ id: CSV, status: 'ready' }));
  assert.equal(f.calls.writes.length, before);
  assert.deepEqual(f.relationSheet.state.rows, [RELATION_HEADERS]);
});

test('formula-like filenames are stored as literal text and survive a later read', () => {
  const f = fixture();
  const dangerous = '=IMPORTXML("https://example.invalid","//x")';
  f.files.get(CSV).name = dangerous;
  const first = f.list().items.find(item => item.id === CSV);
  assert.equal(first.name || first.fileName, dangerous);
  assert.equal(f.sourceSheet.state.formulas.size, 0);
  const rawValues = f.calls.writes.filter(write => write.kind === 'values').flatMap(write => write.values.flat());
  assert.ok(rawValues.every(value => typeof value !== 'string' || !value.startsWith('=')), 'formula must never be sent unescaped, even before a later rich-text overwrite');
  assert.equal(f.record(CSV).fileName, dangerous);
  const again = f.list().items.find(item => item.id === CSV);
  assert.equal(again.name || again.fileName, dangerous);
});

test('oversized service storage fails closed before any row update', () => {
  for (const options of [{ sourceLastRow: 5002 }, { relationLastRow: 5002 }]) {
    const f = fixture(options);
    const result = f.list();
    assert.equal(result.state, 'storage_unavailable');
    assert.equal(result.canEdit, false);
    assert.equal(f.calls.writes.length, 0);
  }
});


test('RPC input cannot switch service storage or patch a file outside the discovered source', () => {
  const f = fixture();
  const result = plain(f.context.getSourceBases({ storageId: NATIVE, sourceId: OTHER }));
  assert.equal(result.state, 'ready');
  assert.equal(result.storage.id, STORAGE);
  assert.ok(f.calls.opens.every(id => id === STORAGE));
  const before = f.calls.writes.length;
  assert.throws(() => f.patch({ id: 'outside_file_1234567890', status: 'ready', expectedRevision: 1 }));
  assert.equal(f.calls.writes.length, before);
});

test('a non-spreadsheet service file is refused before SpreadsheetApp opens it', () => {
  const f = fixture();
  f.files.get(STORAGE).mime = 'text/csv';
  const result = f.list();
  assert.equal(result.state, 'storage_unavailable');
  assert.deepEqual(f.calls.opens, []);
  assert.equal(f.calls.writes.length, 0);
});


test('duplicate exact relation pairs fail closed while distinct links remain valid and unchanged', () => {
  const first = [CSV, 'segment_a_1234567890', '2026-11-15T10:00:00Z', MEMBER];
  const second = [CSV, 'segment_b_1234567890', '2026-11-15T10:00:00Z', MEMBER];
  const duplicate = fixture({ relationRows: [RELATION_HEADERS, first, first] });
  const failed = duplicate.list();
  assert.equal(failed.state, 'storage_unavailable');
  assert.equal(failed.canEdit, false);
  assert.equal(duplicate.calls.writes.length, 0);
  const valid = fixture({ relationRows: [RELATION_HEADERS, first, second] });
  assert.equal(valid.list().state, 'ready');
  assert.deepEqual(valid.relationSheet.state.rows, [RELATION_HEADERS, first, second]);
  assert.ok(valid.calls.writes.every(write => write.sheet === 'SourceBases'));
});

test('service cells containing formulas are rejected without rewriting stored data', () => {
  const f = fixture();
  f.list();
  f.sourceSheet.state.formulas.set('2:2', '=IMPORTXML("https://example.invalid","//x")');
  const before = f.calls.writes.length;
  const result = f.list();
  assert.equal(result.state, 'storage_unavailable');
  assert.equal(result.canEdit, false);
  assert.equal(f.calls.writes.length, before);
});

test('date-valued metadata cells are serialized as ISO strings through the RPC bridge', () => {
  const f = fixture();
  f.list();
  const stored = f.sourceSheet.state.rows.find(row => row[0] === CSV);
  stored[9] = new Date('2026-11-15T10:00:00Z');
  const result = f.list().items.find(item => item.id === CSV);
  assert.equal(result.updatedAt, '2026-11-15T10:00:00.000Z');
  assert.equal(typeof result.updatedAt, 'string');
});


test('source binding states fail closed without opening service storage when unavailable', () => {
  const missing = fixture();
  missing.folders.delete(SOURCE);
  const absent = missing.list();
  assert.equal(absent.state, 'source_missing');
  assert.deepEqual(absent.items, []);
  assert.deepEqual(missing.calls.opens, []);

  const ambiguous = fixture();
  ambiguous.folders.delete(SOURCE);
  ambiguous.makeFolder('first_source_folder_1234567890', 'Исходные базы', ROOT);
  ambiguous.makeFolder('second_source_folder_1234567890', '  ИСХОДНЫЕ БАЗЫ  ', ROOT);
  const duplicate = ambiguous.list();
  assert.equal(duplicate.state, 'source_ambiguous');
  assert.deepEqual(duplicate.items, []);
  assert.deepEqual(ambiguous.calls.opens, []);

  const outside = fixture({ properties: { SOURCE_BASES_FOLDER_ID: OTHER } });
  const denied = outside.list();
  assert.equal(denied.state, 'source_outside_registry');
  assert.equal(denied.source, null);
  assert.deepEqual(denied.items, []);
  assert.deepEqual(outside.calls.opens, []);
});

test('invalid saved statuses, revision types or present flags are never silently repaired', () => {
  for (const change of [{ status: 'invented' }, { revision: 0 }, { present: 'true' }]) {
    const f = fixture({ sourceRows: [HEADERS, rowFor(CSV, change)] });
    const before = JSON.stringify(f.sourceSheet.state.rows);
    const result = f.list();
    assert.equal(result.state, 'storage_unavailable');
    assert.equal(result.canEdit, false);
    assert.equal(f.calls.writes.length, 0);
    assert.equal(JSON.stringify(f.sourceSheet.state.rows), before);
    assert.throws(() => f.patch({ id: CSV, status: 'ready', expectedRevision: 1 }));
    assert.equal(f.calls.writes.length, 0);
  }
});

test('source binding and complete discovery run under the same lock as metadata synchronization', () => {
  const f = fixture();
  assert.equal(f.list().state, 'ready');
  assert.ok(f.calls.drive.length > 0);
  assert.ok(f.calls.drive.every(call => call.locked));
  const scans = f.calls.events.filter(event => event.kind === 'scan');
  assert.ok(scans.length >= 2);
  assert.ok(scans.every(event => event.locked));
  assert.equal(f.calls.lockDepth, 0);
});

test('discovery uses the post-lock folder snapshot instead of reapplying an older outside-lock snapshot', () => {
  const options = {};
  const f = fixture(options);
  f.list();
  options.onLock = () => { f.files.get(CSV).parent = OTHER; };
  const result = f.list();
  assert.ok(result.items.every(item => item.id !== CSV));
  assert.equal(f.record(CSV).present, false);
  assert.equal(f.calls.lockDepth, 0);
});

test('a failed partial source scan throws before service reads or writes and preserves existing metadata', () => {
  const options = {};
  const f = fixture(options);
  f.list();
  const saved = JSON.stringify(f.sourceSheet.state.rows);
  f.calls.opens.length = 0;
  f.calls.writes.length = 0;
  f.calls.events.length = 0;
  f.calls.flushes = 0;
  options.failScanFolder = CHILD;
  assert.throws(() => f.list(), /SOURCE|GOOGLE_ERROR/);
  assert.deepEqual(f.calls.opens, []);
  assert.equal(f.calls.writes.length, 0);
  assert.equal(f.calls.flushes, 0);
  assert.equal(JSON.stringify(f.sourceSheet.state.rows), saved);
  assert.equal(f.record(CSV).present, true);
  assert.equal(f.calls.lockDepth, 0);
});

test('a large new source list grows the service grid and writes one contiguous batch rather than one RPC per file', () => {
  const f = fixture();
  for (let index = 0; index < 1001; index++) {
    f.makeFile(`bulk_source_${index}_1234567890`, `База ${index}.csv`, 'text/csv', SOURCE);
  }
  const result = f.list();
  assert.equal(result.state, 'ready');
  assert.equal(result.items.length, 1005);
  assert.equal(f.calls.grows.length, 1);
  assert.ok(f.calls.grows.every(call => call.locked));
  assert.ok(f.sourceSheet.state.maxRows >= result.items.length + 1);
  assert.ok(f.sourceSheet.state.maxRows <= 5001);
  const valueWrites = f.calls.writes.filter(write => write.kind === 'values');
  assert.equal(valueWrites.length, 1);
  assert.equal(valueWrites[0].values.length, result.items.length);
  assert.ok(f.calls.writes.every(write => write.locked));
  assert.equal(f.calls.flushes, 1);
  const flush = f.calls.events.findIndex(event => event.kind === 'flush');
  const unlock = f.calls.events.findIndex(event => event.kind === 'unlock');
  assert.ok(flush >= 0 && flush < unlock);
  assert.equal(f.calls.events[flush].locked, true);
  assert.equal(f.calls.lockDepth, 0);
});

test('contiguous unsafe filenames use one literal-rich-text batch and never execute transient formulas', () => {
  const f = fixture();
  for (let index = 0; index < 40; index++) {
    f.makeFile(`unsafe_source_${index}_1234567890`, `=Unsafe ${index}.csv`, 'text/csv', SOURCE);
  }
  assert.equal(f.list().state, 'ready');
  const richWrites = f.calls.writes.filter(write => write.kind === 'richBatch');
  assert.equal(richWrites.length, 1);
  assert.equal(richWrites[0].values.length, 40);
  assert.equal(f.calls.writes.filter(write => write.kind === 'rich').length, 0);
  assert.equal(f.sourceSheet.state.formulas.size, 0);
  const raw = f.calls.writes.filter(write => write.kind === 'values').flatMap(write => write.values.flat());
  assert.ok(raw.every(value => typeof value !== 'string' || !value.startsWith('=')));
  for (let index = 0; index < 40; index++) assert.equal(f.record(`unsafe_source_${index}_1234567890`).fileName, `=Unsafe ${index}.csv`);
  assert.equal(f.calls.flushes, 1);
});

test('a service write error still flushes once while locked before releasing the lock', () => {
  const options = { failWriteAfterApply: true };
  const f = fixture(options);
  const result = f.list();
  assert.equal(result.state, 'storage_unavailable');
  assert.equal(result.canEdit, false);
  assert.ok(f.calls.writes.length > 0);
  assert.equal(f.calls.flushes, 1);
  const write = f.calls.events.findIndex(event => event.kind === 'write');
  const flush = f.calls.events.findIndex(event => event.kind === 'flush');
  const unlock = f.calls.events.findIndex(event => event.kind === 'unlock');
  assert.ok(write >= 0 && write < flush && flush < unlock);
  assert.equal(f.calls.events[flush].locked, true);
  assert.equal(f.calls.lockDepth, 0);
  const rowsAfterWrite = f.sourceSheet.state.rows.length;
  options.failWriteAfterApply = false;
  assert.equal(f.list().state, 'ready');
  assert.equal(f.sourceSheet.state.rows.length, rowsAfterWrite);
});


const legacyHeaders = HEADERS.slice(0, 11);
const typeMigrationKey = 'SOURCE_BASES_TYPE_MIGRATION_' + STORAGE;
const contentsMigrationKey = 'SOURCE_BASES_CONTENTS_MIGRATION_' + STORAGE;
const readServiceDatabase = f => plain(runShared(f.context, () => f.context.locked_(() => {
  const context = f.context.authorize_();
  return f.context.sourceBasesReadDatabase_(f.context.sourceBasesStorage_(context));
})));
const registerSource = (f, id, type, status, options) => plain(runShared(f.context, () => f.context.locked_(() => {
  const context = f.context.authorize_();
  const storage = f.context.sourceBasesStorage_(context);
  const database = f.context.sourceBasesReadDatabase_(storage);
  const file = f.context.sourceBaseMetadata_(f.files.get(id));
  return f.context.registerImportedSourceBase_(context, storage, database, file, type, status, options);
})));

test('legacy eleven-column storage gains the type column without altering its states, revisions or relations', () => {
  const historical = rowFor(CSV, { status: 'ready', formatCheck: 'valid', revision: 9, present: false }).slice(0, 11);
  const relation = [CSV, 'segment_a_1234567890', '2026-11-15T10:00:00Z', MEMBER];
  const f = fixture({ sourceRows: [legacyHeaders, historical], relationRows: [RELATION_HEADERS, relation] });
  const priorRelations = structuredClone(f.relationSheet.state.rows);
  const database = readServiceDatabase(f);
  assert.equal(database.records[CSV].baseType, 'general');
  assert.deepEqual(f.sourceSheet.state.rows[0], HEADERS);
  assert.deepEqual(f.sourceSheet.state.rows[1].slice(0, 11), historical);
  assert.equal(f.sourceSheet.state.rows[1][11], 'general');
  assert.deepEqual(f.relationSheet.state.rows, priorRelations);
  assert.ok(f.calls.writes.length > 0);
  assert.ok(f.calls.writes.every(write => write.sheet === 'SourceBases' && [12,13].includes(write.column) && write.locked));
  assert.equal(f.calls.lockDepth, 0);
  const lastWrite = f.calls.events.findLastIndex(event => event.kind === 'write');
  const flush = f.calls.events.findLastIndex(event => event.kind === 'flush');
  const unlock = f.calls.events.findLastIndex(event => event.kind === 'unlock');
  assert.ok(lastWrite >= 0 && lastWrite < flush && flush < unlock);
  assert.ok(f.calls.events[flush].locked);
  const writeCount = f.calls.writes.length;
  const flushCount = f.calls.flushes;
  readServiceDatabase(f);
  assert.equal(f.calls.writes.length, writeCount);
  assert.equal(f.calls.flushes, flushCount);
});

test('an interrupted type-column migration completes blank legacy cells and keeps explicit LPR types', () => {
  const missing = rowFor(CSV, { baseType: '', status: 'rework', formatCheck: 'invalid', revision: 7 });
  const lpr = rowFor(NATIVE, { baseType: 'lpr', status: 'ready', revision: 4 });
  const f = fixture({ sourceRows: [HEADERS, missing, lpr], properties: { [typeMigrationKey]: 'pending' } });
  const database = readServiceDatabase(f);
  assert.equal(database.records[CSV].baseType, 'general');
  assert.equal(database.records[NATIVE].baseType, 'lpr');
  assert.deepEqual(f.sourceSheet.state.rows[1].slice(0, 11), missing.slice(0, 11));
  assert.deepEqual(f.sourceSheet.state.rows[2], lpr);
  assert.equal(f.properties.has(typeMigrationKey), false);
  assert.ok(f.calls.writes.every(write => [12,13].includes(write.column) && write.locked));
});

test('invalid legacy records or relations prevent all type-migration writes', () => {
  for (const settings of [
    { sourceRows: [legacyHeaders, rowFor(CSV, { status: 'invented' }).slice(0, 11)] },
    { sourceRows: [legacyHeaders, rowFor(CSV).slice(0, 11)], relationRows: [['broken-relations']] },
    { sourceRows: [HEADERS, rowFor(CSV, { baseType: '' }), rowFor(NATIVE, { baseType: 'invented' })], properties: { [typeMigrationKey]: 'pending' } },
    { sourceRows: [HEADERS, rowFor(CSV, { baseType: '' })] },
  ]) {
    const f = fixture(settings);
    const previous = JSON.stringify([f.sourceSheet.state.rows, f.relationSheet.state.rows]);
    const propertiesBefore = [...f.properties.entries()];
    assert.throws(() => readServiceDatabase(f), /STORAGE_/);
    assert.equal(f.calls.writes.length, 0);
    assert.equal(JSON.stringify([f.sourceSheet.state.rows, f.relationSheet.state.rows]), previous);
    assert.deepEqual([...f.properties.entries()], propertiesBefore);
    assert.equal(f.calls.lockDepth, 0);
  }
});

test('changing base type invalidates a previous manual check unless the caller explicitly checks the new criterion', () => {
  const f = fixture();
  const initial = f.list().items.find(item => item.id === CSV);
  const validated = f.patch({ id: CSV, formatCheck: 'valid', expectedRevision: initial.revision }).item;
  const changed = f.patch({ id: CSV, baseType: 'lpr', expectedRevision: validated.revision }).item;
  assert.equal(changed.baseType, 'lpr');
  assert.equal(changed.formatCheck, 'unchecked');
  assert.equal(changed.revision, validated.revision + 1);
  const checked = f.patch({ id: CSV, baseType: 'general', formatCheck: 'valid', expectedRevision: changed.revision }).item;
  assert.equal(checked.baseType, 'general');
  assert.equal(checked.formatCheck, 'valid');
  assert.equal(f.record(CSV).baseType, 'general');
  assert.equal(f.record(CSV).formatCheck, 'valid');
  const staleWrites = f.calls.writes.length;
  assert.throws(() => f.patch({ id: CSV, baseType: 'lpr', expectedRevision: changed.revision }), /CONFLICT/);
  assert.equal(f.calls.writes.length, staleWrites);
});

test('import registration stores the selected type and status and an unchecked manual validation', () => {
  const f = fixture();
  const record = registerSource(f, NATIVE, 'lpr', 'rework');
  assert.equal(record.baseType, 'lpr');
  assert.equal(record.status, 'rework');
  assert.equal(record.formatCheck, 'unchecked');
  assert.equal(record.revision, 1);
  assert.equal(f.record(NATIVE).baseType, 'lpr');
  assert.equal(f.record(NATIVE).status, 'rework');
  assert.deepEqual(f.relationSheet.state.rows, [RELATION_HEADERS]);
  assert.ok(f.calls.writes.every(write => write.locked));
  assert.ok(f.calls.opens.every(id => id === STORAGE));
});

test('retrying import registration preserves later manual decisions and does not add a duplicate', () => {
  const f = fixture();
  const first = registerSource(f, NATIVE, 'lpr', 'rework');
  const manual = f.patch({ id: NATIVE, baseType: 'general', status: 'ready', formatCheck: 'valid', expectedRevision: first.revision }).item;
  const writes = f.calls.writes.length;
  const retried = registerSource(f, NATIVE, 'lpr', 'rework');
  assert.equal(retried.baseType, 'general');
  assert.equal(retried.status, 'ready');
  assert.equal(retried.formatCheck, 'valid');
  assert.equal(retried.revision, manual.revision);
  assert.equal(f.calls.writes.length, writes);
  assert.equal(f.sourceSheet.state.rows.filter(row => row[0] === NATIVE).length, 1);
});


test('a partially committed legacy migration resumes only from its stored marker and removes it after flush', () => {
  const historical = rowFor(CSV, { status: 'ready', formatCheck: 'valid', revision: 6 }).slice(0, 11);
  const settings = { sourceRows: [legacyHeaders, historical], failWriteAfterApply: true };
  const f = fixture(settings);
  assert.throws(() => readServiceDatabase(f));
  assert.equal(f.properties.get(contentsMigrationKey), 'pending');
  assert.deepEqual(f.sourceSheet.state.rows[1].slice(0, 11), historical);
  const failureFlush = f.calls.events.findLastIndex(event => event.kind === 'flush');
  const failureUnlock = f.calls.events.findLastIndex(event => event.kind === 'unlock');
  assert.ok(failureFlush >= 0 && failureFlush < failureUnlock);
  settings.failWriteAfterApply = false;
  const recovered = readServiceDatabase(f);
  assert.equal(recovered.records[CSV].baseType, 'general');
  assert.equal(recovered.records[CSV].revision, 6);
  assert.deepEqual(f.sourceSheet.state.rows[1].slice(0, 11), historical);
  assert.equal(f.properties.has(typeMigrationKey), false);
});


test('legacy type migration does not create records in empty rows or an empty source register', () => {
  const empty = fixture({ sourceRows: [legacyHeaders] });
  const emptyResult = readServiceDatabase(empty);
  assert.deepEqual(Object.keys(emptyResult.records), []);
  assert.equal(empty.sourceSheet.state.rows.length, 1);
  assert.deepEqual(empty.sourceSheet.state.rows[0], HEADERS);
  assert.ok(empty.calls.writes.every(write => [12,13].includes(write.column) && write.row === 1));

  const historical = rowFor(CSV, { status: 'ready', revision: 3 }).slice(0, 11);
  const sparse = fixture({ sourceRows: [legacyHeaders, [], historical] });
  const result = readServiceDatabase(sparse);
  assert.deepEqual(Object.keys(result.records), [CSV]);
  assert.equal(result.records[CSV].row, 3);
  assert.deepEqual(sparse.sourceSheet.state.rows[1], []);
  assert.deepEqual(sparse.sourceSheet.state.rows[2].slice(0, 11), historical);
  assert.equal(sparse.sourceSheet.state.rows[2][11], 'general');
});


test('a deliberate move can replace a known metadata revision once while retries preserve newer decisions', () => {
  const f = fixture();
  const initial = registerSource(f, NATIVE, 'general', 'collection');
  const validated = f.patch({ id: NATIVE, formatCheck: 'valid', expectedRevision: initial.revision }).item;
  const selected = registerSource(f, NATIVE, 'lpr', 'ready', { expectedRevision: validated.revision });
  assert.equal(selected.baseType, 'lpr');
  assert.equal(selected.status, 'ready');
  assert.equal(selected.formatCheck, 'unchecked');
  assert.equal(selected.revision, validated.revision + 1);
  const manual = f.patch({ id: NATIVE, status: 'rework', formatCheck: 'invalid', expectedRevision: selected.revision }).item;
  const writes = f.calls.writes.length;
  const retried = registerSource(f, NATIVE, 'lpr', 'ready', { expectedRevision: validated.revision });
  assert.equal(retried.status, 'rework');
  assert.equal(retried.formatCheck, 'invalid');
  assert.equal(retried.revision, manual.revision);
  assert.equal(f.calls.writes.length, writes);
});

test('twelve-column source metadata migrates canonical contents without changing manual metadata or associations', () => {
  const legacy = HEADERS.slice(0, 12);
  const company = rowFor(CSV, { status: 'ready', formatCheck: 'valid', revision: 12 }).slice(0, 12);
  const lpr = rowFor(NATIVE, { baseType: 'lpr', status: 'rework', revision: 4 }).slice(0, 12);
  const relation = [CSV, 'segment_existing_1234567890', '2026-11-15T10:00:00Z', MEMBER];
  const f = fixture({ sourceRows: [legacy, company, lpr], relationRows: [RELATION_HEADERS, relation] });
  const database = readServiceDatabase(f);
  assert.deepEqual(database.records[CSV].contents, ['companies']);
  assert.deepEqual(database.records[NATIVE].contents, ['lpr']);
  assert.deepEqual(f.sourceSheet.state.rows[1].slice(0, 12), company);
  assert.deepEqual(f.sourceSheet.state.rows[2].slice(0, 12), lpr);
  assert.equal(f.sourceSheet.state.rows[1][12], '["companies"]');
  assert.equal(f.sourceSheet.state.rows[2][12], '["lpr"]');
  assert.ok(f.calls.writes.every(write => write.column === 13 && write.locked));
  assert.deepEqual(f.relationSheet.state.rows, [RELATION_HEADERS, relation]);
  assert.equal(f.properties.has(contentsMigrationKey), false);
});

test('mixed contents persist canonically and invalidate manual checks once without losing state or relations', () => {
  const f = fixture();
  const first = f.list().items.find(item => item.id === NATIVE);
  const checked = f.patch({ id: NATIVE, status: 'ready', formatCheck: 'valid', expectedRevision: first.revision }).item;
  const mixed = f.patch({ id: NATIVE, contents: ['lpr', 'companies'], expectedRevision: checked.revision }).item;
  assert.deepEqual(mixed.contents, ['companies', 'lpr']);
  assert.equal(mixed.baseType, 'mixed');
  assert.equal(mixed.status, 'ready');
  assert.equal(mixed.formatCheck, 'unchecked');
  assert.equal(mixed.canAddToSegment, true);
  assert.equal(f.record(NATIVE).contents, '["companies","lpr"]');
  const writes = f.calls.writes.length;
  const repeated = f.patch({ id: NATIVE, contents: ['companies', 'lpr'], expectedRevision: mixed.revision }).item;
  assert.equal(repeated.revision, mixed.revision);
  assert.equal(f.calls.writes.length, writes);
  const final = f.patch({ id: NATIVE, contents: ['lpr'], formatCheck: 'valid', expectedRevision: mixed.revision }).item;
  assert.deepEqual(final.contents, ['lpr']);
  assert.equal(final.formatCheck, 'valid');
  assert.deepEqual(f.list().items.find(item => item.id === NATIVE).contents, ['lpr']);
});

test('empty, duplicate, unknown, scalar and conflicting contents patches cannot write source metadata', () => {
  const f = fixture();
  const first = f.list().items.find(item => item.id === CSV);
  const writes = f.calls.writes.length;
  for (const changes of [
    { contents: [] }, { contents: ['companies', 'companies'] }, { contents: ['company'] },
    { contents: 'mixed' }, { contents: ['companies', 'lpr'], baseType: 'lpr' },
  ]) assert.throws(() => f.patch({ id: CSV, expectedRevision: first.revision, ...changes }), /INVALID_/);
  assert.equal(f.calls.writes.length, writes);
});

test('stored malformed or mismatched contents never trigger a repair or overwrite', () => {
  for (const contents of ['', 'null', '[]', '["unknown"]', '["companies","companies"]', '["lpr"]']) {
    const f = fixture({ sourceRows: [HEADERS, rowFor(CSV, { contents })] });
    assert.throws(() => readServiceDatabase(f), /STORAGE_SCHEMA/);
    assert.equal(f.calls.writes.length, 0);
  }
});

test('an interrupted contents migration resumes appended cells and preserves completed migration rows', () => {
  const legacy = HEADERS.slice(0, 12);
  const company = rowFor(CSV, { status: 'ready', revision: 5 }).slice(0, 12);
  const lpr = rowFor(NATIVE, { baseType: 'lpr', revision: 8 }).slice(0, 12);
  const f = fixture({ sourceRows: [legacy, company, lpr] });
  const originalRange = f.sourceSheet.getRange;
  let interrupted = false;
  f.sourceSheet.getRange = (...args) => {
    const range = originalRange(...args), originalSet = range.setValues;
    if (args[0] > 1 && args[1] === 13) range.setValues = values => {
      const result = originalSet(values);
      if (!interrupted) { interrupted = true; throw new Error('Lost migration write acknowledgement'); }
      return result;
    };
    return range;
  };
  assert.throws(() => readServiceDatabase(f), /STORAGE_SCHEMA/);
  assert.equal(f.properties.get(contentsMigrationKey), 'pending');
  const completed = structuredClone(f.sourceSheet.state.rows);
  const beforeWrites = f.calls.writes.length;
  const database = readServiceDatabase(f);
  assert.deepEqual(database.records[NATIVE].contents, ['lpr']);
  assert.deepEqual(f.sourceSheet.state.rows, completed);
  assert.equal(f.calls.writes.length, beforeWrites);
  assert.equal(f.properties.has(contentsMigrationKey), false);
});

const readySource = (f, id, revision) => plain(runShared(f.context, () => f.context.locked_(() => {
  const context = f.context.authorize_(), storage = f.context.sourceBasesStorage_(context);
  const database = f.context.sourceBasesReadDatabase_(storage);
  const result = f.context.requireReadySourceBase_(context, storage, database, id, revision);
  return { metadata: result.metadata, record: result.record, contents: result.contents };
})));

test('only a currently ready native source inside the bound folder may expose sheets to segment code', () => {
  const f = fixture();
  const sources = f.list().items;
  assert.throws(() => readySource(f, NATIVE), /SOURCE_NOT_READY/);
  const current = sources.find(item => item.id === NATIVE);
  const ready = f.patch({ id: NATIVE, contents: ['companies', 'lpr'], status: 'ready', expectedRevision: current.revision }).item;
  const accepted = readySource(f, NATIVE, ready.revision);
  assert.deepEqual(accepted.contents, ['companies', 'lpr']);
  assert.equal(accepted.metadata.id, NATIVE);
  assert.throws(() => readySource(f, NATIVE, ready.revision - 1), /CONFLICT/);
  assert.throws(() => readySource(f, NATIVE, '1'), /INVALID_REQUEST/);
  f.files.get(NATIVE).parent = OTHER;
  assert.throws(() => readySource(f, NATIVE, ready.revision), /OUTSIDE_REGISTRY/);
  const csv = sources.find(item => item.id === CSV);
  f.patch({ id: CSV, status: 'ready', expectedRevision: csv.revision });
  assert.throws(() => readySource(f, CSV), /INVALID_FILE_TYPE/);
  assert.ok(f.calls.opens.every(id => id === STORAGE), 'the readiness gate itself never reads business cells');
});

test('source associations resolve direct segment names without walking Outreach tables or descendants', () => {
  const segmentId = 'segment_existing_1234567890';
  const f = fixture({ relationRows: [RELATION_HEADERS, [CSV, segmentId, '2026-11-15T10:00:00Z', MEMBER]] });
  f.context.getBootstrap = () => { throw new Error('Full registry tree must not be consulted'); };
  f.context.getSegmentsMetadata_ = () => { throw new Error('Full Outreach subtree must not be consulted'); };
  f.makeFolder(OUTREACH, 'Аутричи', ROOT);
  f.makeFolder(segmentId, 'Действующий сегмент', OUTREACH);
  const nested = f.makeFolder('segment_nested_1234567890', 'Архив', segmentId);
  nested.getFolders = () => { throw new Error('Segment descendants must not be enumerated'); };
  for (let index = 0; index < 6; index++) f.makeFile('outreach_book_' + index + '_1234567890', 'Книга ' + index, SHEET_MIME, segmentId);
  const item = f.list().items.find(item => item.id === CSV);
  assert.equal(item.associationsAvailable, true);
  assert.deepEqual(item.segments, [{ id: segmentId, name: 'Действующий сегмент', url: 'https://drive.google.com/drive/folders/' + segmentId }]);
  assert.equal(f.calls.folderLists.filter(id => id === OUTREACH).length, 1);
  assert.equal(f.calls.folderLists.includes(segmentId), false);
  assert.deepEqual(f.calls.typedScans, []);
  assert.ok(f.calls.opens.every(id => id === STORAGE));
  const updated = f.patch({ id: CSV, status: 'ready', expectedRevision: item.revision }).item;
  assert.equal(updated.associationsAvailable, true);
  assert.deepEqual(updated.segments, item.segments);
  assert.equal(f.calls.folderLists.filter(id => id === OUTREACH).length, 2);
  assert.deepEqual(f.calls.typedScans, []);
});

const segmentNames = f => plain(runShared(f.context, () => f.context.getSegmentNames_(f.context.authorize_())));

test('lightweight segment names authorize before any Drive lookup', () => {
  const f = fixture();
  assert.throws(() => f.context.getSegmentNames_(), /LINK_ACCESS_REQUIRED/);
  assert.deepEqual(f.calls.drive, []);
});

test('segment names honor the default binding and explicit in-registry override', () => {
  const f = fixture();
  f.makeFolder(OUTREACH, 'Переименованные аутричи', ROOT);
  f.makeFolder('named_outreach_1234567890', 'Аутричи', ROOT);
  f.makeFolder('segment_default_1234567890', 'По умолчанию', OUTREACH);
  f.makeFolder('segment_override_1234567890', 'Другой сегмент', 'named_outreach_1234567890');
  assert.equal(segmentNames(f).source.id, OUTREACH);
  assert.deepEqual(segmentNames(f).items.map(item => item.id), ['segment_default_1234567890']);
  f.properties.set('SEGMENTS_FOLDER_ID', ' named_outreach_1234567890 ');
  assert.equal(segmentNames(f).source.id, 'named_outreach_1234567890');
  assert.deepEqual(segmentNames(f).items.map(item => item.id), ['segment_override_1234567890']);
  assert.deepEqual(f.calls.typedScans, []);
  assert.deepEqual(f.calls.opens, []);
});

test('segment name fallback preserves missing, normalized-name, and ambiguous binding states', () => {
  const f = fixture();
  assert.equal(segmentNames(f).state, 'source_missing');
  f.makeFolder('fallback_outreach_1234567890', '  АУТРИЧИ  ', ROOT);
  f.makeFolder('fallback_segment_1234567890', 'Сегмент', 'fallback_outreach_1234567890');
  const unique = segmentNames(f);
  assert.equal(unique.state, 'ready');
  assert.equal(unique.source.id, 'fallback_outreach_1234567890');
  assert.deepEqual(unique.items.map(item => item.id), ['fallback_segment_1234567890']);
  f.makeFolder('duplicate_outreach_1234567890', 'Аутричи', ROOT);
  const ambiguous = segmentNames(f);
  assert.equal(ambiguous.state, 'source_ambiguous');
  assert.equal(ambiguous.source, null);
  assert.deepEqual(ambiguous.items, []);
});

test('explicit missing, outside, root, or trashed Outreach bindings never expose a segment', () => {
  for (const binding of ['missing_outreach_1234567890', OTHER, ROOT, OUTREACH]) {
    const f = fixture({ properties: { SEGMENTS_FOLDER_ID: binding } });
    f.makeFolder(OUTREACH, 'Закрытые аутричи', ROOT, true);
    f.makeFolder('hidden_segment_1234567890', 'Закрытый сегмент', binding);
    const result = segmentNames(f);
    assert.equal(result.state, 'source_outside_registry');
    assert.equal(result.source, null);
    assert.deepEqual(result.items, []);
    assert.deepEqual(f.calls.opens, []);
    assert.equal(JSON.stringify(result).includes('Закрытый сегмент'), false);
  }
});

test('moved or trashed segment relations remain unknown and preserve their stored history', () => {
  const segmentId = 'segment_existing_1234567890';
  const relation = [CSV, segmentId, '2026-11-15T10:00:00Z', MEMBER];
  const f = fixture({ relationRows: [RELATION_HEADERS, relation] });
  f.makeFolder(OUTREACH, 'Аутричи', ROOT);
  const child = f.makeFolder(segmentId, 'Сегмент', OUTREACH);
  assert.equal(f.list().items.find(item => item.id === CSV).associationsAvailable, true);
  for (const change of [() => { child.parent = OTHER; }, () => { child.parent = OUTREACH; child.trashed = true; }]) {
    change();
    const item = f.list().items.find(item => item.id === CSV);
    assert.equal(item.associationsAvailable, false);
    assert.deepEqual(item.segments, []);
    assert.match(item.associationWarning, /недоступна/);
    assert.deepEqual(f.relationSheet.state.rows, [RELATION_HEADERS, relation]);
  }
});

test('a stale child iterator cannot invent a currently moved segment association', () => {
  const segmentId = 'segment_existing_1234567890';
  const f = fixture({ relationRows: [RELATION_HEADERS, [CSV, segmentId, '2026-11-15T10:00:00Z', MEMBER]] });
  const source = f.makeFolder(OUTREACH, 'Аутричи', ROOT);
  const child = f.makeFolder(segmentId, 'Сегмент', OUTREACH);
  const listChildren = source.getFolders;
  source.getFolders = () => { const stale = listChildren(); child.parent = OTHER; return stale; };
  const item = f.list().items.find(item => item.id === CSV);
  assert.equal(item.associationsAvailable, false);
  assert.deepEqual(item.segments, []);
  assert.deepEqual(f.calls.typedScans, []);
});

test('Outreach scope is checked again after listing before returning any segment names', () => {
  for (const move of ['outside', 'trash']) {
    const f = fixture();
    const source = f.makeFolder(OUTREACH, 'Аутричи', ROOT);
    f.makeFolder('private_segment_1234567890', 'Скрытый сегмент', OUTREACH);
    const listChildren = source.getFolders;
    source.getFolders = () => { const stale = listChildren(); if (move === 'outside') source.parent = OTHER; else source.trashed = true; return stale; };
    const result = segmentNames(f);
    assert.equal(result.state, 'source_outside_registry');
    assert.equal(result.source, null);
    assert.deepEqual(result.items, []);
    assert.equal(JSON.stringify(result).includes('Скрытый сегмент'), false);
  }
});

test('source binding performs one final ancestry check and rejects a source moved during resolution', () => {
  const f = fixture();
  const result = plain(runShared(f.context, () => {
    const binding = f.context.sourceBasesSource_(f.context.authorize_());
    return { state: binding.state, source: binding.source };
  }));
  assert.equal(result.state, 'ready');
  assert.equal(f.calls.ancestryReads.filter(id => id === SOURCE).length, 1);
  const moved = fixture();
  moved.folders.delete(SOURCE);
  const fallback = moved.makeFolder('fallback_source_1234567890', 'Исходные базы', ROOT);
  const name = fallback.getName;
  fallback.getName = () => { fallback.parent = OTHER; return name(); };
  const denied = moved.list();
  assert.equal(denied.state, 'source_outside_registry');
  assert.equal(denied.source, null);
  assert.deepEqual(denied.items, []);
  assert.deepEqual(moved.calls.opens, []);
});
