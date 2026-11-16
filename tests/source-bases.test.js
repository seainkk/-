import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourceDir = fileURLToPath(new URL('../src/', import.meta.url));
const ROOT = '1WKcvDDKqYBo94eXsYc5vKp6OPtOzv6Wh';
const SOURCE = '1deuP0ovOC70PrElQKZjSjuvSMgPF0J7r';
const STORAGE = '1lzbjoPNnrVn5-8GoAhaLZPS_S8J0lfcaoO8Ybxw396M';
const OTHER = 'other_root_1234567890';
const CHILD = 'source_child_1234567890';
const NATIVE = 'source_native_1234567890';
const CSV = 'source_csv_1234567890';
const XLSX = 'source_xlsx_1234567890';
const PDF = 'source_pdf_1234567890';
const MEMBER = 'member@example.com';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const HEADERS = ['fileId','fileName','mimeType','url','format','status','formatCheck','revision','present','updatedAt','updatedBy'];
const RELATION_HEADERS = ['fileId','segmentId','createdAt','createdBy'];
const plain = value => JSON.parse(JSON.stringify(value));
const iterator = items => {
  let position = 0;
  return { hasNext: () => position < items.length, next: () => items[position++] };
};
const rowFor = (id, overrides = {}) => HEADERS.map(key => ({
  fileId: id, fileName: 'Сохранённое имя.csv', mimeType: 'text/csv', url: `https://drive.google.com/file/d/${id}/view`,
  format: 'CSV', status: 'collection', formatCheck: 'unchecked', revision: 1, present: true,
  updatedAt: '2026-11-15T10:00:00.000Z', updatedBy: MEMBER, ...overrides,
})[key]);

function fixture(options = {}) {
  const properties = new Map(Object.entries({ ROOT_FOLDER_ID: ROOT, ALLOWED_EMAILS: MEMBER, ADMIN_EMAILS: MEMBER, ...options.properties }));
  const calls = { drive: [], opens: [], writes: [], reads: [], grows: [], events: [], flushes: 0, lockDepth: 0 };
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
      getParents: () => iterator(item.parent ? [folders.get(item.parent)] : []),
      getFiles: () => {
        calls.events.push({ kind: 'scan', id, locked: calls.lockDepth > 0 });
        if (options.failScanFolder === id) throw new Error('Source scan failed');
        return iterator([...files.values()].filter(file => file.parent === id));
      },
      getFilesByType: mime => iterator([...files.values()].filter(file => file.parent === id && file.mime === mime)),
      getFolders: () => iterator([...folders.values()].filter(child => child.parent === id)),
    };
    folders.set(id, item);
    return item;
  }
  function file(id, name, mime, parent, url, trashed = false) {
    const item = {
      id, name, mime, parent, url: url || `https://drive.google.com/file/d/${id}/view`, trashed,
      getId: () => id, getName: () => item.name, getMimeType: () => item.mime,
      getUrl: () => item.url, isTrashed: () => item.trashed,
      getParents: () => iterator(item.parent ? [folders.get(item.parent)] : []),
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
    { properties: { ALLOWED_EMAILS: '' } },
    { activeEmail: 'outsider@example.com' },
    { activeEmail: '', effectiveEmail: MEMBER },
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
  assert.ok(result.items.every(item => item.status === 'collection' && item.formatCheck === 'unchecked' && Number.isSafeInteger(item.revision))); 
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
  assert.ok(result.items.every(item => item.revision === null && item.status === null && item.formatCheck === null && item.segments === null));
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
  assert.ok(result.items.every(item => item.revision === null && item.status === null && item.formatCheck === null && item.segments === null));
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
  f.patch({ id: CSV, status: 'ready', formatCheck: 'valid', expectedRevision: first.revision });
  f.files.get(CSV).name = 'Переименованная база.csv';
  const result = f.list().items.find(item => item.id === CSV);
  assert.equal(result.status, 'ready');
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
  f.patch({ id: CSV, status: 'rework', formatCheck: 'invalid', expectedRevision: first.revision });
  f.files.get(CSV).parent = OTHER;
  assert.ok(f.list().items.every(item => item.id !== CSV));
  assert.equal(f.record(CSV).present, false);
  f.files.get(CSV).parent = SOURCE;
  const restored = f.list().items.find(item => item.id === CSV);
  assert.equal(restored.status, 'rework');
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
