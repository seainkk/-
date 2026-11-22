import { TEST_ACCESS_KEY, TEST_ACCESS_HASH, SHARED_ACTOR, installSharedApi, runShared } from './helpers/shared-link.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const ROOT = 'registry_root_1234567890';
const OUTREACH = 'outreach_folder_1234567890';
const SOURCE = 'source_folder_1234567890';
const STORAGE = 'service_book_1234567890';
const SEGMENT = 'existing_segment_1234567890';
const COMPANY = 'companies_book_1234567890';
const LPR = 'lpr_book_1234567890';
const MIXED = 'source_mixed_1234567890';
const GENERAL = 'source_general_1234567890';
const MIME = 'application/vnd.google-apps.spreadsheet';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const EMAIL = 'teammate@example.com';
const HEADERS = ['fileId','fileName','mimeType','url','format','status','formatCheck','revision','present','updatedAt','updatedBy','baseType','contents'];
const RELATIONS = ['fileId','segmentId','createdAt','createdBy'];
const TABLES = ['segmentId','kind','fileId'];
const LOADS = ['sourceId','sourceSheetId','segmentId','targetKind','targetFileId','targetSheetId','hasHeader','requestId','stage','updatedAt'];
const plain = value => JSON.parse(JSON.stringify(value));
const iterator = values => { let i = 0; return { hasNext: () => i < values.length, next: () => values[i++] }; };

function fixture(options = {}) {
  const calls = { creates: [], copies: [], opens: [], reads: [], writes: [], flushes: 0, locks: 0, events: [], lists: [], fileGets: [], folderGets: [], fileListings: [], propertyWrites: [] };
  const folders = new Map(), files = new Map(), books = new Map();
  const properties = new Map(Object.entries({ ROOT_FOLDER_ID: ROOT, SHARED_ACCESS_KEY_SHA256: TEST_ACCESS_HASH, SEGMENTS_FOLDER_ID: OUTREACH, SOURCE_BASES_FOLDER_ID: SOURCE, SOURCE_BASES_STORAGE_ID: STORAGE, ALLOWED_EMAILS: EMAIL }));
  let sequence = 1000, failedCreate = false, failedCopy = false, failedName = false, failedTracking = false, failedInsert = false, failedTableWrite = false, failedCategoryWrite = false;
  function folder(id, name, parent) {
    const item = { id, name, parent, trashed: false,
      getId: () => id, getName: () => item.name, setName: name => { item.name = name; return item; },
      isTrashed: () => item.trashed, getParents: () => iterator(item.parent ? [folders.get(item.parent)] : []),
      getFilesByType: mime => { calls.fileListings.push(id); return iterator([...files.values()].filter(file => file.parent === id && file.mime === mime && !(options.hideNewLpr && file.role === 'lpr'))); },
      getFolders: () => iterator([...folders.values()].filter(child => child.parent === id)),
    };
    folders.set(id, item); return item;
  }
  function file(id, name, parent, mime = MIME) {
    const item = { id, name, parent, mime, trashed: false,
      getId: () => id, getName: () => item.name, setName: name => {
        if (options.failRenameRole && options.failRenameRole === item.role && !failedName) { failedName = true; throw new Error('Lost rename response'); }
        item.name = name; return item;
      },
      getMimeType: () => item.mime, isTrashed: () => item.trashed,
      getUrl: () => 'https://docs.google.com/spreadsheets/d/' + id + '/edit',
      getParents: () => iterator(item.parent ? [folders.get(item.parent)] : []),
    };
    files.set(id, item); return item;
  }
  function sheet(name, rows = [], sheetId = ++sequence, owner = null) {
    const state = { name, rows: structuredClone(rows), id: sheetId, maxRows: 1000, maxColumns: 26, owner };
    const value = (r, c) => state.rows[r - 1]?.[c - 1] ?? '';
    const result = {
      state,
      getSheetId: () => state.id, getName: () => state.name,
      setName: name => { state.name = name; return result; },
      getLastRow: () => { let i = state.rows.length; while (i && state.rows[i - 1].every(v => v === '')) i--; return i; },
      getLastColumn: () => Math.max(0, ...state.rows.map(row => { let i = row.length; while (i && row[i - 1] === '') i--; return i; })),
      getMaxRows: () => state.maxRows, getMaxColumns: () => state.maxColumns,
      insertRowsAfter: (after, count) => { state.maxRows += count; }, insertColumnsAfter: (after, count) => { state.maxColumns += count; },
      getRange: (row, col, height = 1, width = 1) => {
        const matrix = transform => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => transform(value(row + r, col + c))));
        const range = {
          getValues: () => { calls.reads.push({ owner: state.owner, name: state.name, type: 'values' }); return matrix(v => v); },
          getDisplayValues: () => matrix(String),
          getFormulas: () => { calls.reads.push({ owner: state.owner, name: state.name, type: 'formulas' }); return matrix(() => ''); },
          setValues: values => {
            if (options.failCopiedTrackingWrite && state.name === 'SegmentLoads' && values[0]?.[8] === 'copied' && !failedTracking) { failedTracking = true; throw new Error('Service write unavailable'); }
            calls.writes.push({ owner: state.owner, name: state.name, row, col, values: structuredClone(values), locked: calls.locks > 0 });
            calls.events.push({ type: 'write', locked: calls.locks > 0 });
            for (let r = 0; r < values.length; r++) for (let c = 0; c < values[r].length; c++) {
              while (state.rows.length < row + r) state.rows.push([]);
              const v = values[r][c]; state.rows[row + r - 1][col + c - 1] = typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v;
            }
            if (options.failTableTrackingAfterApply && state.name === 'SegmentTables' && row > 1 && !failedTableWrite) { failedTableWrite = true; throw new Error('Assignment write response lost'); }
            return range;
          },
          setValue: v => range.setValues([[v]]),
          setRichTextValue: rich => range.setValues([[rich.getText()]]),
        }; return range;
      },
      copyTo: target => {
        calls.copies.push({ source: state.owner, sheetId, target: target.id, locked: calls.locks > 0 });
        const copied = sheet('Copy of ' + state.name, state.rows, ++sequence, target.id);
        target.sheets.push(copied);
        if (options.failCopyAfterApply && !failedCopy) { failedCopy = true; throw new Error('Copy response lost'); }
        return copied;
      },
    }; return result;
  }
  function book(id, entries = []) {
    const item = { id, sheets: entries, getId: () => id, getSheets: () => item.sheets,
      getSheetByName: name => item.sheets.find(s => s.getName() === name) || null,
      insertSheet: name => {
        const added = sheet(name, [], ++sequence, id); item.sheets.push(added);
        if (options.failInsertSheet === name && !failedInsert) { failedInsert = true; throw new Error('Insert response lost'); }
        return added;
      },
    };
    books.set(id, item); return item;
  }
  folder(ROOT, 'Реестр баз'); folder(OUTREACH, 'Аутричи', ROOT); folder(SOURCE, 'Исходные базы', ROOT);
  folder(SEGMENT, 'Сегмент', OUTREACH); folder('other_folder_1234567890', 'Другая папка', ROOT);
  file(STORAGE, 'Служебный реестр', options.storageParent || ROOT);
  file(COMPANY, 'Сегмент: компании', SEGMENT); file(LPR, 'Сегмент: ЛПР', SEGMENT);
  file(MIXED, 'Компании и ЛПР', SOURCE); file(GENERAL, 'Компании', SOURCE);
  const records = [
    [MIXED, 'Компании и ЛПР', MIME, 'https://docs.google.com/spreadsheets/d/' + MIXED + '/edit', 'Google Таблицы', options.status || 'ready', 'unchecked', 1, true, '2026-11-16T10:00:00.000Z', EMAIL, 'mixed', '["companies","lpr"]'],
    [GENERAL, 'Компании', MIME, 'https://docs.google.com/spreadsheets/d/' + GENERAL + '/edit', 'Google Таблицы', 'ready', 'unchecked', 1, true, '2026-11-16T10:00:00.000Z', EMAIL, 'general', '["companies"]'],
  ];
  const sources = sheet('SourceBases', [HEADERS, ...records], 1, STORAGE);
  const relations = sheet('SourceBaseSegments', [RELATIONS], 2, STORAGE);
  book(STORAGE, [sources, relations]);
  book(MIXED, [sheet('Компании', [['Компания'], ['ООО Пример']], 11, MIXED), sheet('ЛПР', [['ФИО'], ['Иван Иванов']], 12, MIXED)]);
  book(GENERAL, [sheet('Компании', [['Компания'], ['Компания Б']], 21, GENERAL)]);
  book(COMPANY, [sheet('Существующие данные', [['Компания'], ['Не менять']], 31, COMPANY)]);
  book(LPR, [sheet('Лист1', [], 41, LPR)]);
  const propertiesStore = {
    getProperty: key => properties.get(key) ?? null,
    getProperties: () => Object.fromEntries(properties),
    setProperty: (key, value) => {
      calls.propertyWrites.push(key);
      properties.set(key, value);
      if (options.failCategoryAfterApply && key.startsWith('SEGMENT_CATEGORY_') && !failedCategoryWrite) {
        failedCategoryWrite = true;
        throw new Error('Category write response lost');
      }
      return propertiesStore;
    },
    deleteProperty: key => { properties.delete(key); return propertiesStore; },
  };
  const context = vm.createContext({
    console: { warn() {} },
    Session: { getActiveUser: () => ({ getEmail: () => options.email || EMAIL }), getEffectiveUser: () => ({ getEmail: () => options.email || EMAIL }) },
    PropertiesService: { getScriptProperties: () => propertiesStore },
    LockService: { getScriptLock: () => ({ tryLock: () => { calls.locks++; calls.events.push({ type: 'lock' }); return true; }, releaseLock: () => { calls.events.push({ type: 'unlock' }); calls.locks--; } }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: (_, v) => [...crypto.createHash('sha256').update(v).digest()], base64EncodeWebSafe: bytes => Buffer.from(bytes).toString('base64url') },
    DriveApp: {
      getFolderById: id => { calls.folderGets.push(id); if (!folders.has(id)) throw new Error('Missing folder'); return folders.get(id); },
      getFileById: id => { calls.fileGets.push(id); if (!files.has(id)) throw new Error('Missing file'); return files.get(id); },
    },
    SpreadsheetApp: {
      openById: id => { calls.opens.push({ id, locked: calls.locks > 0 }); if (!books.has(id)) throw new Error('Missing book'); return books.get(id); },
      flush: () => { calls.flushes++; calls.events.push({ type: 'flush', locked: calls.locks > 0 }); },
      newRichTextValue: () => { let text; const builder = { setText: v => { text = v; return builder; }, build: () => ({ getText: () => text }) }; return builder; },
    },
    Drive: { Files: {
      get: () => ({ capabilities: { canEdit: options.storageCanEdit !== false } }),
      create: metadata => {
        calls.creates.push(structuredClone(metadata));
        const id = 'created_artifact_' + (++sequence);
        let created;
        if (metadata.mimeType === FOLDER_MIME) created = folder(id, metadata.name, metadata.parents[0]);
        else { created = file(id, metadata.name, metadata.parents[0]); book(id, [sheet('Лист1', [], ++sequence, id)]); }
        created.tags = metadata.appProperties; created.role = metadata.appProperties.registrySegmentRole;
        if (options.failCreateRole === created.role && !failedCreate) { failedCreate = true; throw new Error('Create response lost'); }
        return { id };
      },
      list: listOptions => {
        calls.lists.push(listOptions);
        const marker = listOptions.q.match(/key='registrySegmentAction' and value='([^']+)'/)[1];
        const role = listOptions.q.match(/key='registrySegmentRole' and value='([^']+)'/)[1];
        return { files: [...folders.values(), ...files.values()].filter(item => role !== options.hideMarkerRole && item.tags?.registrySegmentAction === marker && item.tags?.registrySegmentRole === role).map(item => ({ id: item.id, mimeType: item.mime || FOLDER_MIME, parents: [item.parent], trashed: item.trashed, appProperties: item.tags })) };
      },
    } },
  });
  for (const name of ['Config.gs','Code.gs','Segments.gs','SourceBases.gs','SegmentActions.gs']) vm.runInContext(readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'), context, { filename: name });
  installSharedApi(context, { accessKey: () => Object.hasOwn(options, 'accessKey') ? options.accessKey : TEST_ACCESS_KEY });
  return { context, calls, folders, files, books, properties, sources, relations, records, book, sheet, folder };
}

const loads = (sourceId = MIXED) => [{ sourceId, expectedRevision: 1, sheets: sourceId === MIXED ? [{ sheetId: 11, target: 'companies', hasHeader: true }, { sheetId: 12, target: 'lpr', hasHeader: false }] : [{ sheetId: 21, target: 'companies', hasHeader: true }] }];
const request = (overrides = {}) => ({ id: SEGMENT, requestId: 'segment_request_12345678', loads: loads(), ...overrides });

test('preview uses actual ready source worksheets and never reads their cells', () => {
  const f = fixture();
  const result = plain(f.context.getSourceSheets({ sourceId: MIXED, expectedRevision: 1 }));
  assert.deepEqual(result.contents, ['companies','lpr']);
  assert.deepEqual(result.sheets, [{ id: 11, name: 'Компании', hasHeader: true }, { id: 12, name: 'ЛПР', hasHeader: true }]);
  assert.equal(result.revision, 1);
  assert.equal(f.calls.writes.length, 0);
  assert.ok(f.calls.opens.every(call => call.locked));
});

test('nonready sources cannot preview, create or append from any endpoint', () => {
  for (const status of ['collection','rework']) {
    const f = fixture({ status });
    for (const action of [() => f.context.getSourceSheets({ sourceId: MIXED }), () => f.context.createSegment({ name: 'Новый', requestId: 'create_request_123456', loads: loads() }), () => f.context.updateSegment(request())]) assert.throws(action, /SOURCE_NOT_READY/);
    assert.equal(f.calls.creates.length, 0); assert.equal(f.calls.copies.length, 0);
    assert.ok(f.calls.opens.every(call => call.id === STORAGE));
  }
});

test('fresh source membership, present flag, native MIME and optimistic revision are authoritative', () => {
  for (const change of [f => { f.files.get(MIXED).parent = 'other_folder_1234567890'; }, f => { f.records[0][8] = false; f.sources.state.rows[1][8] = false; }, f => { f.files.get(MIXED).mime = 'text/csv'; }, f => { f.sources.state.rows[1][7] = 2; }]) {
    const f = fixture(); change(f);
    assert.throws(() => f.context.updateSegment(request()), /OUTSIDE_REGISTRY|SOURCE_NOT_READY|INVALID_FILE_TYPE|CONFLICT/);
    assert.equal(f.calls.creates.length, 0); assert.equal(f.calls.copies.length, 0);
  }
});

test('empty creation always creates folder plus two native tables directly inside it', () => {
  const f = fixture();
  const result = plain(f.context.createSegment({ name: 'Ритейл', requestId: 'empty_create_12345678' }));
  assert.equal(result.segment.name, 'Ритейл'); assert.equal(result.segment.files.length, 2);
  assert.deepEqual(result.segment.files.map(file => file.name), ['Ритейл: компании','Ритейл: ЛПР']);
  assert.equal(f.folders.get(result.segment.id).parent, OUTREACH);
  for (const file of result.segment.files) assert.equal(f.files.get(file.id).parent, result.segment.id);
  assert.equal(f.calls.creates.length, 3); assert.equal(f.calls.copies.length, 0);
  assert.ok(f.calls.creates.every(metadata => metadata.parents.length === 1 && metadata.appProperties.registrySegmentAction));
});

test('a confirmed source load attaches the real source to the selected segment project, even with an existing relation', () => {
  const f = fixture();
  f.context.registryProjectId_ = () => 'neosender';
  f.context.registrySegmentProject_ = (_scope, id) => id === SEGMENT ? 'neosender' : null;
  const assignments = [];
  f.context.sourceBaseAddProject_ = (_scope, storage, fileId, projectId, operationId) => {
    assert.ok(f.calls.locks > 0);
    assignments.push([storage.public.id, fileId, projectId, operationId]);
  };
  const input = request();
  f.context.updateSegment(input);
  f.context.updateSegment(input);
  assert.ok(assignments.length >= 2);
  for (const [storageId, fileId, projectId, operationId] of assignments) {
    assert.equal(storageId, STORAGE);
    assert.equal(fileId, MIXED);
    assert.equal(projectId, 'neosender');
    assert.equal(operationId, 'segment:' + SEGMENT + ':' + input.requestId);
  }
  assert.equal(f.relations.state.rows.filter(row => row[0] === MIXED && row[1] === SEGMENT).length, 1);
});

test('creation stores an explicit category without changing the Drive parent, and validates category values', () => {
  const f = fixture();
  const input = { name: 'Веб-студии', category: 'clients', requestId: 'category-create-001' };
  assert.throws(() => f.context.createSegment({ ...input, category: 'lpr' }), /INVALID_REQUEST/);
  const result = f.context.createSegment(input);
  assert.equal(result.segment.category, 'clients');
  assert.equal(f.folders.get(result.segment.id).parent, OUTREACH);
  assert.equal(JSON.parse(f.properties.get('SEGMENT_CATEGORY_' + result.segment.id)).category, 'clients');
  assert.throws(() => f.context.createSegment({ ...input, category: 'partners' }), /REQUEST_REUSED/);
  assert.equal(f.calls.creates.length, 3);
});

test('category-only updates preserve folder and workbook contents and reject stale expected categories', () => {
  const f = fixture();
  const input = { id: SEGMENT, category: 'partners', expectedCategory: 'clients', requestId: 'category-change-001' };
  assert.throws(() => f.context.updateSegment({ ...input, id: 'other_folder_1234567890' }), /OUTSIDE_SEGMENTS/);
  assert.equal(f.calls.propertyWrites.length, 0);
  const first = f.context.updateSegment(input);
  assert.equal(first.segment.category, 'partners');
  assert.equal(first.segment.name, 'Сегмент');
  assert.equal(f.folders.get(SEGMENT).parent, OUTREACH);
  assert.equal(f.calls.creates.length, 0);
  assert.equal(f.calls.writes.length, 0);
  assert.equal(f.calls.fileListings.length, 0);
  const writes = f.calls.propertyWrites.length;
  assert.throws(() => f.context.updateSegment({ ...input, requestId: 'category-stale-001' }), /SEGMENT_CATEGORY_CONFLICT/);
  assert.equal(f.calls.propertyWrites.length, writes);

  assert.equal(f.context.updateSegment({ ...input, category: 'clients', expectedCategory: 'partners', requestId: 'category-change-002' }).segment.category, 'clients');
  assert.equal(f.context.updateSegment(input).segment.category, 'clients', 'a completed retry cannot undo a later update');
  assert.equal(f.calls.propertyWrites.filter(key => key === 'SEGMENT_CATEGORY_' + SEGMENT).length, 2);
});

test('a category write with a lost response can be retried with its original expected value', () => {
  const f = fixture({ failCategoryAfterApply: true });
  const input = { id: SEGMENT, category: 'partners', expectedCategory: 'clients', requestId: 'category-recovery-001' };
  assert.throws(() => f.context.updateSegment(input), /SEGMENT_RECOVERY_REQUIRED/);
  const retried = f.context.updateSegment(input);
  assert.equal(retried.recovered, true);
  assert.equal(retried.segment.category, 'partners');
  assert.equal(f.calls.propertyWrites.filter(key => key === 'SEGMENT_CATEGORY_' + SEGMENT).length, 1);
});

test('renaming an uncategorized legacy studio preserves its partners category and old request fingerprints', () => {
  const f = fixture();
  f.folders.get(SEGMENT).name = 'Веб-студии';
  const input = { id: SEGMENT, name: 'Новое название', requestId: 'category-legacy-rename-001' };
  const result = f.context.updateSegment(input);
  assert.equal(result.segment.category, 'partners');
  assert.equal(result.segment.name, input.name);
  const journalKey = 'SEGMENT_ACTION_' + f.context.digest_(SHARED_ACTOR + '|update|' + input.requestId).slice(0, 32);
  const journal = JSON.parse(f.properties.get(journalKey));
  assert.equal(journal.fingerprint, f.context.digest_(JSON.stringify({ id: SEGMENT, name: input.name, loads: [] })));
});

test('empty creation has bounded service calls and reads only the two tracking tabs', () => {
  const f = fixture();
  f.context.createSegment({ name: 'Без контактов', requestId: 'empty_budget_12345678' });
  assert.deepEqual(f.calls.opens.map(call => call.id), [STORAGE]);
  // Previously this path read 12 whole ranges, listed markers four times,
  // fetched files nine times and wrote ScriptProperties fourteen times.
  assert.deepEqual(f.calls.reads.map(read => [read.name, read.type]), [
    ['SegmentTables','formulas'], ['SegmentTables','values'],
    ['SegmentLoads','formulas'], ['SegmentLoads','values'],
  ]);
  assert.equal(f.calls.lists.length, 3);
  assert.equal(f.calls.fileListings.length, 1);
  assert.ok(f.calls.fileGets.length <= 7);
  assert.ok(f.calls.propertyWrites.length <= 10);
  assert.equal(f.calls.flushes, 2);
  assert.equal(f.calls.writes.filter(write => write.name === 'SegmentTables' && write.row > 1).length, 1);
  assert.equal(f.properties.has('SEGMENT_TRACKING_INIT_' + STORAGE), false);
});

test('name-only changes do not open source records or repeat marker and folder listings', () => {
  const f = fixture();
  f.context.updateSegment(request({ name: 'Новое имя', loads: undefined }));
  assert.deepEqual(f.calls.opens.map(call => call.id), [STORAGE]);
  assert.ok(f.calls.reads.every(read => ['SegmentTables','SegmentLoads'].includes(read.name)));
  assert.equal(f.calls.reads.length, 4);
  assert.equal(f.calls.fileListings.length, 1);
  assert.equal(f.calls.lists.length, 0);
  assert.ok(f.calls.fileGets.length <= 7);
});

test('mixed source copies whole selected worksheets into separate tables preserving original data and header choices', () => {
  const f = fixture();
  const beforeSource = plain(f.books.get(MIXED).getSheets().map(sheet => sheet.state.rows));
  const beforeExisting = plain(f.books.get(COMPANY).getSheets()[0].state.rows);
  const result = plain(f.context.updateSegment(request()));
  assert.equal(f.calls.copies.length, 2); assert.ok(f.calls.copies.every(call => call.locked));
  assert.deepEqual(result.loadedSheets.map(sheet => [sheet.target, sheet.hasHeader]), [['companies',true],['lpr',false]]);
  assert.deepEqual(f.books.get(MIXED).getSheets().map(sheet => sheet.state.rows), beforeSource);
  assert.deepEqual(f.books.get(COMPANY).getSheets()[0].state.rows, beforeExisting);
  assert.deepEqual(f.books.get(COMPANY).getSheets()[1].state.rows, [['Компания'],['ООО Пример']]);
  assert.deepEqual(f.relations.state.rows.slice(1).map(row => row.slice(0,2)), [[MIXED,SEGMENT]]);
  const storedLoads = f.books.get(STORAGE).getSheetByName('SegmentLoads').state.rows;
  assert.ok(storedLoads.slice(1).every(row => row[8] === 'complete'));
  assert.ok(f.calls.writes.every(write => write.owner === STORAGE && write.locked));
});

test('single-content source can populate only corresponding target', () => {
  const f = fixture();
  const invalid = loads(GENERAL); invalid[0].sheets[0].target = 'lpr';
  assert.throws(() => f.context.updateSegment(request({ loads: invalid })), /INVALID_SHEET_TARGET/);
  assert.equal(f.calls.copies.length, 0);
  f.context.updateSegment(request({ loads: loads(GENERAL) }));
  assert.equal(f.calls.copies[0].target, COMPANY);
});

test('new segment optionally populates both canonical tables with explicitly mapped sheets', () => {
  const f = fixture();
  const result = plain(f.context.createSegment({ name: 'Новый', requestId: 'create_with_data_12345', loads: loads() }));
  assert.equal(result.loadedSheets.length, 2);
  assert.deepEqual(f.relations.state.rows[1].slice(0,2), [MIXED,result.segment.id]);
  assert.deepEqual(f.calls.copies.map(copy => copy.target), result.segment.files.map(file => file.id));
});

test('replaying same action and later requests reuse confirmed source-sheet receipt without duplicates', () => {
  const f = fixture();
  const first = plain(f.context.updateSegment(request()));
  const retry = plain(f.context.updateSegment(request()));
  const later = plain(f.context.updateSegment(request({ requestId: 'later_request_12345678' })));
  assert.equal(retry.recovered, true); assert.equal(later.recovered, false);
  assert.deepEqual(first.loadedSheets, retry.loadedSheets); assert.deepEqual(first.loadedSheets, later.loadedSheets);
  assert.equal(f.calls.copies.length, 2); assert.equal(f.relations.state.rows.length, 2);
  const changed = loads(); changed[0].sheets[0].hasHeader = false;
  assert.throws(() => f.context.updateSegment(request({ requestId: 'changed_header_12345', loads: changed })), /SHEET_ALREADY_LOADED/);
});

test('reused request with different payload is rejected without recopying', () => {
  const f = fixture(); f.context.updateSegment(request());
  assert.throws(() => f.context.updateSegment(request({ name: 'Другое имя' })), /REQUEST_REUSED/);
  assert.equal(f.calls.copies.length, 2);
});

test('readiness is checked again on replay even when previous copies completed', () => {
  const f = fixture(); f.context.updateSegment(request()); f.sources.state.rows[1][5] = 'rework';
  assert.throws(() => f.context.updateSegment(request()), /SOURCE_NOT_READY/);
  assert.equal(f.calls.copies.length, 2);
});

test('each leaf rechecks current readiness after a preceding copy changed the source status', () => {
  const f = fixture();
  const first = f.books.get(MIXED).getSheets()[0], copyTo = first.copyTo;
  first.copyTo = target => { const copied = copyTo(target); f.sources.state.rows[1][5] = 'rework'; return copied; };
  assert.throws(() => f.context.updateSegment(request()), /SOURCE_NOT_READY/);
  assert.equal(f.calls.copies.length, 1);
  assert.equal(f.relations.state.rows.length, 1);
  // One initial source snapshot and one fresh snapshot per attempted leaf.
  assert.equal(f.calls.reads.filter(read => read.name === 'SourceBases' && read.type === 'values').length, 3);
});

test('each leaf checks actual destination membership even after a preceding successful copy', () => {
  const f = fixture();
  const first = f.books.get(MIXED).getSheets()[0], copyTo = first.copyTo;
  first.copyTo = target => { const copied = copyTo(target); f.files.get(LPR).parent = SOURCE; return copied; };
  assert.throws(() => f.context.updateSegment(request()), /OUTSIDE_SEGMENTS/);
  assert.equal(f.calls.copies.length, 1);
  assert.equal(f.relations.state.rows.length, 1);
});

test('unknown copy outcome retains pending receipt, adds no relation and blocks both old and new request IDs', () => {
  const f = fixture({ failCopyAfterApply: true });
  assert.throws(() => f.context.updateSegment(request()), /SEGMENT_RECOVERY_REQUIRED/);
  assert.equal(f.calls.copies.length, 1); assert.equal(f.relations.state.rows.length, 1);
  assert.throws(() => f.context.updateSegment(request()), /SEGMENT_RECOVERY_REQUIRED/);
  assert.throws(() => f.context.updateSegment(request({ requestId: 'new_request_123456789' })), /SEGMENT_RECOVERY_REQUIRED/);
  assert.equal(f.calls.copies.length, 1);
  assert.equal(f.books.get(STORAGE).getSheetByName('SegmentLoads').state.rows[1][8], 'copying');
});

test('known returned copy ID survives tracking write failure and retry resumes without a second copy', () => {
  const f = fixture({ failCopiedTrackingWrite: true });
  assert.throws(() => f.context.updateSegment(request()), error => /SEGMENT_RECOVERY_REQUIRED/.test(error.message) && error.message.includes('/folders/' + SEGMENT));
  assert.equal(f.calls.copies.length, 1); assert.equal(f.relations.state.rows.length, 1);
  assert.equal(f.books.get(STORAGE).getSheetByName('SegmentLoads').state.rows[1][8], 'copying');
  const result = plain(f.context.updateSegment(request()));
  assert.equal(result.loadedSheets.length, 2); assert.equal(f.calls.copies.length, 2);
  assert.equal(f.relations.state.rows.length, 2);
});

test('lost batched assignment response recovers both roles without creating duplicate files', () => {
  const f = fixture({ failTableTrackingAfterApply: true });
  const input = { name: 'Новый', requestId: 'lost_assignment_12345' };
  assert.throws(() => f.context.createSegment(input), /SEGMENT_RECOVERY_REQUIRED/);
  assert.equal(f.calls.creates.length, 3);
  const result = plain(f.context.createSegment(input));
  assert.equal(f.calls.creates.length, 3);
  const rows = f.books.get(STORAGE).getSheetByName('SegmentTables').state.rows.slice(1);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row[2]), result.segment.files.map(file => file.id));
});

test('interrupted tracking initialization recovers only its own blank tabs before business creation', () => {
  const f = fixture({ failInsertSheet: 'SegmentLoads' });
  const input = { name: 'Новый', requestId: 'initialization_12345678' };
  assert.throws(() => f.context.createSegment(input), /GOOGLE_ERROR/);
  assert.equal(f.calls.creates.length, 0);
  f.context.createSegment(input);
  assert.equal(f.calls.creates.length, 3);
  assert.deepEqual(f.books.get(STORAGE).getSheetByName('SegmentLoads').state.rows[0], LOADS);
});

test('lost folder creation response is recovered by unique Drive marker, with no duplicate folder', () => {
  const f = fixture({ failCreateRole: 'folder' });
  const input = { name: 'Новый', requestId: 'lost_folder_123456789' };
  assert.throws(() => f.context.createSegment(input), /SEGMENT_RECOVERY_REQUIRED/);
  const result = plain(f.context.createSegment(input));
  assert.equal(f.calls.creates.filter(call => call.mimeType === FOLDER_MIME).length, 1);
  assert.equal(f.calls.creates.length, 3); assert.equal(result.segment.files.length, 2);
  assert.ok(f.calls.lists.some(options => /registrySegmentRole.*folder/.test(options.q)));
});

test('lost LPR create response survives companies revisit and hidden name listing without second create', () => {
  const f = fixture({ failCreateRole: 'lpr', hideNewLpr: true });
  const input = { name: 'Новый', requestId: 'lost_lpr_create_123456' };
  assert.throws(() => f.context.createSegment(input), /SEGMENT_RECOVERY_REQUIRED/);
  const result = plain(f.context.createSegment(input));
  assert.equal(f.calls.creates.filter(call => call.appProperties.registrySegmentRole === 'lpr').length, 1);
  assert.equal(f.calls.creates.length, 3); assert.equal(result.segment.files.length, 2);
  assert.ok(f.calls.lists.some(options => /registrySegmentRole.*lpr/.test(options.q)));
});

test('an uncertain create redoes marker lookup in the next invocation and blocks on a missing marker', () => {
  for (const role of ['folder','lpr']) {
    const options = { failCreateRole: role }, f = fixture(options);
    const input = { name: 'Новый', requestId: 'pending_creation_' + role + '_12345' };
    assert.throws(() => f.context.createSegment(input), /SEGMENT_RECOVERY_REQUIRED/);
    const creates = f.calls.creates.length, markerReads = f.calls.lists.length;
    options.hideMarkerRole = role;
    assert.throws(() => f.context.createSegment(input), /SEGMENT_RECOVERY_REQUIRED/);
    assert.equal(f.calls.creates.length, creates);
    assert.ok(f.calls.lists.length > markerReads);
  }
});

test('Drive operation markers recover creations even after bounded receipt eviction', () => {
  const f = fixture();
  f.context.SEGMENT_ACTIONS_SCHEMA = { ...f.context.SEGMENT_ACTIONS_SCHEMA, receiptLimit: 1 };
  const input = { name: 'Первый', requestId: 'receipt_eviction_123456' };
  const first = plain(f.context.createSegment(input));
  f.context.createSegment({ name: 'Второй', requestId: 'second_creation_123456' });
  const creates = f.calls.creates.length;
  const recovered = plain(f.context.createSegment(input));
  assert.equal(recovered.segment.id, first.segment.id);
  assert.equal(f.calls.creates.length, creates);
});

test('replaying a pre-project create waits for an explicit claim, both with an old receipt and after eviction', () => {
  for (const evict of [false, true]) {
    const f = fixture(), input = { name: 'Старые кухни', requestId: 'legacy-project-create-001' };
    const old = f.context.createSegment(input).segment;
    if (evict) f.properties.delete('SEGMENT_ACTION_' + f.context.digest_(SHARED_ACTOR + '|create|' + input.requestId).slice(0, 32));
    vm.runInContext(readFileSync(new URL('../src/RegistryProjects.gs', import.meta.url), 'utf8'), f.context);
    const rpc = (method, payload, projectId) => f.context.callApp({ method, payload, projectId, accessKey: TEST_ACCESS_KEY });
    assert.throws(() => rpc('createSegment', input, 'numshield'), /SEGMENT_PROJECT_REQUIRED/);
    assert.equal(f.properties.has('REGISTRY_SEGMENT_PROJECT_' + old.id), false);
    rpc('claimRegistrySegment', { segmentId: old.id, requestId: 'claim-old-kitchens-001' }, 'numshield');
    assert.equal(rpc('createSegment', input, 'numshield').segment.id, old.id);
    assert.equal(f.calls.creates.length, 3);
  }
});

test('two projects can recover their own identically named segments after a lost create reply and a matching request ID', () => {
  const f = fixture({ failCreateRole: 'folder' });
  vm.runInContext(readFileSync(new URL('../src/RegistryProjects.gs', import.meta.url), 'utf8'), f.context);
  const payload = { name: 'Кухни', requestId: 'same-projects-request-001' };
  const create = projectId => f.context.callApp({ method: 'createSegment', payload, projectId, accessKey: TEST_ACCESS_KEY }).segment;
  assert.throws(() => create('numshield'), /SEGMENT_RECOVERY_REQUIRED/);
  const other = create('neosender'), first = create('numshield');
  assert.notEqual(first.id, other.id);
  assert.deepEqual([...first.files, ...other.files].map(file => file.id).length, 4);
  assert.equal(new Set([...first.files, ...other.files].map(file => file.id)).size, 4);
  assert.equal(create('numshield').id, first.id);
  assert.equal(create('neosender').id, other.id);
  assert.equal(f.calls.creates.length, 6);
});

test('the old Drive tree and generic mutations exclude the private preparation folder and its contents', () => {
  const f = fixture();
  vm.runInContext(readFileSync(new URL('../src/RegistryProjects.gs', import.meta.url), 'utf8'), f.context);
  const staging = 'private_staging_001', nested = 'private_subdir_001';
  f.folder(staging, 'Подготовка', ROOT); f.folder(nested, 'Черновики', staging);
  f.files.get(GENERAL).parent = nested;
  f.properties.set('PREPARED_STAGING_FOLDER_ID', staging);
  const bootstrap = f.context.getBootstrap();
  assert.ok(bootstrap.folders.every(item => item.id !== staging && item.id !== nested));
  assert.ok(bootstrap.files.every(item => item.id !== GENERAL));
  assert.ok(!f.calls.fileListings.includes(staging));
  for (const parentId of [staging, nested]) {
    assert.throws(() => f.context.createFolder({ parentId, name: 'Новая', requestId: 'new-private-folder-001' }), /PROTECTED_FILE/);
    assert.throws(() => f.context.createBase({ parentId, name: 'Новая', requestId: 'new-private-sheet-001' }), /PROTECTED_FILE/);
    assert.throws(() => f.context.renameItem({ id: parentId, kind: 'folder', name: 'Название' }), /PROTECTED_FILE/);
  }
  assert.throws(() => f.context.renameItem({ id: GENERAL, kind: 'file', name: 'Название' }), /PROTECTED_FILE/);
});

test('a generic folder creation receipt rechecks the project of the folder when replayed', () => {
  const f = fixture();
  vm.runInContext(readFileSync(new URL('../src/RegistryProjects.gs', import.meta.url), 'utf8'), f.context);
  const requestId = 'old-common-folder-001', name = 'Сегмент';
  f.properties.set('CREATE_' + f.context.digest_(SHARED_ACTOR + '|folder|' + requestId).slice(0, 32), JSON.stringify({
    fingerprint: JSON.stringify([OUTREACH, name]), status: 'done', result: { folder: { id: SEGMENT, name, parentId: OUTREACH } },
  }));
  f.properties.set('REGISTRY_SEGMENT_PROJECT_' + SEGMENT, JSON.stringify({ rootId: ROOT, projectId: 'neosender' }));
  assert.throws(() => f.context.createFolder({ parentId: OUTREACH, name, requestId }), /OUTSIDE_PROJECT/);
});

test('persistent fingerprint rejects changed payload after receipt eviction', () => {
  const f = fixture();
  f.context.SEGMENT_ACTIONS_SCHEMA = { ...f.context.SEGMENT_ACTIONS_SCHEMA, receiptLimit: 1 };
  const input = { name: 'Первый', requestId: 'fingerprint_eviction_1234' };
  f.context.createSegment(input);
  f.context.createSegment({ name: 'Второй', requestId: 'other_creation_1234567' });
  assert.throws(() => f.context.createSegment({ ...input, name: 'Новое имя' }), /REQUEST_REUSED/);
  assert.equal(f.calls.creates.length, 6);
});

test('rename updates folder and both server-resolved files and can retry partial rename', () => {
  const f = fixture({ failRenameRole: 'lpr' }); f.files.get(LPR).role = 'lpr';
  const input = request({ name: 'Новое имя', loads: undefined });
  assert.throws(() => f.context.updateSegment(input), error => /SEGMENT_RECOVERY_REQUIRED/.test(error.message) && error.message.includes('/folders/' + SEGMENT));
  const result = plain(f.context.updateSegment(input));
  assert.equal(result.segment.name, 'Новое имя');
  assert.deepEqual(result.segment.files.map(file => file.name), ['Новое имя: компании','Новое имя: ЛПР']);
  assert.equal(f.calls.creates.length, 0);
});

test('metadata and canonical destination ancestry are checked before business writes', () => {
  for (const options of [{ storageCanEdit: false }, { storageParent: 'other_folder_1234567890' }]) {
    const f = fixture(options);
    assert.throws(() => f.context.createSegment({ name: 'Новый', requestId: 'service_guard_12345678' }), /STORAGE_WRITE_REQUIRED|STORAGE_UNAVAILABLE/);
    assert.equal(f.calls.creates.length, 0); assert.equal(f.calls.copies.length, 0); assert.equal(f.calls.writes.length, 0);
  }
  const f = fixture(); f.folders.get(SEGMENT).parent = ROOT;
  assert.throws(() => f.context.updateSegment(request()), /OUTSIDE_SEGMENTS/);
  assert.equal(f.calls.copies.length, 0);
});

test('tracked target moved outside its segment is not silently replaced or written', () => {
  const f = fixture(); f.context.updateSegment(request());
  f.files.get(COMPANY).parent = SOURCE;
  assert.throws(() => f.context.updateSegment(request({ requestId: 'moved_target_12345678' })), /OUTSIDE_SEGMENTS/);
  assert.equal(f.calls.copies.length, 2); assert.equal(f.calls.creates.length, 0);
});

test('ambiguous canonical names and malformed tracking fail before new business data is created', () => {
  const f = fixture();
  f.files.set('duplicate_book_1234567890', { ...f.files.get(COMPANY), getId: () => 'duplicate_book_1234567890' });
  assert.throws(() => f.context.updateSegment(request()), /SEGMENT_TABLE_AMBIGUOUS/);
  assert.equal(f.calls.copies.length, 0);
  const g = fixture(); g.books.get(STORAGE).insertSheet('SegmentTables').getRange(1,1).setValue('wrong');
  assert.throws(() => g.context.createSegment({ name: 'Не создавать', requestId: 'broken_schema_123456' }), /STORAGE_SCHEMA/);
  assert.equal(g.calls.creates.length, 0);
});

test('readonly tracking handles legacy absence, active receipts and partial schemas without mutations', () => {
  const f = fixture();
  const absent = plain(runShared(f.context, () => f.context.segmentReadTracking_(f.context.authorize_(), SEGMENT)));
  assert.deepEqual(absent, { available: true, tables: [], loads: [] });
  assert.equal(f.calls.writes.length, 0);
  f.context.updateSegment(request());
  const loaded = plain(runShared(f.context, () => f.context.segmentReadTracking_(f.context.authorize_(), SEGMENT)));
  assert.equal(loaded.available, true); assert.equal(loaded.tables.length, 2);
  assert.deepEqual(loaded.loads.map(load => load.hasHeader), [true,false]);
  const g = fixture(); g.books.get(STORAGE).insertSheet('SegmentTables').getRange(1,1,1,TABLES.length).setValues([TABLES]);
  const writes = g.calls.writes.length;
  assert.equal(runShared(g.context, () => g.context.segmentReadTracking_(g.context.authorize_(), SEGMENT)).available, false);
  assert.equal(g.calls.writes.length, writes);
});

test('the real dashboard opens and validates tracking once for ten segments, fresh on every request', () => {
  const f = fixture();
  for (let index = 0; index < 9; index++) f.folder('dashboard_segment_' + index + '_12345', 'Пустой ' + index, OUTREACH);
  f.books.get(STORAGE).sheets.push(f.sheet('SegmentTables', [TABLES], 3, STORAGE), f.sheet('SegmentLoads', [LOADS], 4, STORAGE));
  const first = plain(f.context.getSegmentsDashboard());
  assert.equal(first.items.length, 10);
  assert.equal(f.calls.opens.filter(call => call.id === STORAGE).length, 1);
  assert.equal(f.calls.reads.filter(read => read.owner === STORAGE).length, 4);
  assert.equal(f.calls.writes.length, 0);
  f.books.get(STORAGE).getSheetByName('SegmentTables').state.rows[0][0] = 'changed';
  const second = plain(f.context.getSegmentsDashboard());
  assert.equal(second.items.length, 10);
  assert.equal(f.calls.opens.filter(call => call.id === STORAGE).length, 2);
  assert.ok(second.items.every(item => item.analysis.state === 'partial'));
  assert.equal(f.calls.writes.length, 0);
});

test('shared tracking snapshots validate all records before filtering segment-specific public fields', () => {
  const f = fixture(); f.context.updateSegment(request());
  runShared(f.context, () => {
    const context = f.context.authorize_(), snapshot = f.context.segmentReadTrackingSnapshot_(context);
    const opens = f.calls.opens.length;
    const selected = plain(f.context.segmentReadTracking_(context, SEGMENT, snapshot));
    const absent = plain(f.context.segmentReadTracking_(context, 'other_segment_12345678', snapshot));
    assert.equal(f.calls.opens.length, opens);
    assert.ok(selected.tables.every(table => Object.keys(table).sort().join() === 'fileId,kind'));
    assert.ok(selected.loads.every(load => !Object.hasOwn(load, 'row') && !Object.hasOwn(load, 'requestId')));
    assert.deepEqual(absent, { available: true, tables: [], loads: [] });
    f.books.get(STORAGE).getSheetByName('SegmentTables').state.rows.push(['other_segment_12345678','invalid',GENERAL]);
    const invalid = f.context.segmentReadTrackingSnapshot_(context);
    assert.equal(f.context.segmentReadTracking_(context, SEGMENT, invalid).available, false);
  });
});

test('invalid mapping and unknown caller fields fail before mutation', () => {
  const f = fixture();
  const duplicate = loads(); duplicate[0].sheets.push(duplicate[0].sheets[0]);
  const missingHeader = loads(); delete missingHeader[0].sheets[0].hasHeader;
  const missingSheet = loads(); missingSheet[0].sheets[0].sheetId = 999;
  for (const input of [request({ loads: duplicate }), request({ loads: missingHeader }), request({ loads: missingSheet }), request({ targetFileId: LPR })]) assert.throws(() => f.context.updateSegment(input), /INVALID_REQUEST|SOURCE_SHEET_CHANGED/);
  assert.equal(f.calls.creates.length, 0); assert.equal(f.calls.copies.length, 0);
});

test('full service capacity blocks new folder or copies before any business mutation', () => {
  const init = f => {
    f.context.REGISTRY_CONFIG = { ...f.context.REGISTRY_CONFIG, maxSourceBaseRows: 2 };
    f.books.get(STORAGE).insertSheet('SegmentTables').getRange(1,1,3,3).setValues([TABLES,[SEGMENT,'companies',COMPANY],[SEGMENT,'lpr',LPR]]);
    f.books.get(STORAGE).insertSheet('SegmentLoads').getRange(1,1,1,10).setValues([LOADS]);
  };
  const fullTables = fixture(); init(fullTables);
  assert.throws(() => fullTables.context.createSegment({ name: 'Нет места', requestId: 'full_tables_12345678' }), /STORAGE_LIMIT/);
  assert.equal(fullTables.calls.creates.length, 0);
  const fullRelations = fixture(); init(fullRelations);
  fullRelations.relations.getRange(2,1,2,4).setValues([[MIXED,'other_segment_12345678','2026-11-16T10:00:00Z',EMAIL],[GENERAL,'other_segment_12345678','2026-11-16T10:00:00Z',EMAIL]]);
  assert.throws(() => fullRelations.context.updateSegment(request()), /STORAGE_LIMIT/);
  assert.equal(fullRelations.calls.copies.length, 0);
  const fullLoads = fixture(); init(fullLoads);
  fullLoads.books.get(STORAGE).getSheetByName('SegmentLoads').getRange(2,1,2,10).setValues([
    ['old_source_1234567890',100,SEGMENT,'companies',COMPANY,31,true,'old_request_12345678','complete','2026-11-16T10:00:00Z'],
    ['old_source_1234567890',101,SEGMENT,'lpr',LPR,41,true,'old_request_12345678','complete','2026-11-16T10:00:00Z'],
  ]);
  assert.throws(() => fullLoads.context.updateSegment(request()), /STORAGE_LIMIT/);
  assert.equal(fullLoads.calls.copies.length, 0);
});

test('all buffered service writes flush while lock is held before unlock', () => {
  const f = fixture(); f.context.updateSegment(request());
  assert.ok(f.calls.events.filter(event => event.type === 'flush').every(event => event.locked));
  const lastWrite = f.calls.events.findLastIndex(event => event.type === 'write');
  const lastFlush = f.calls.events.findLastIndex(event => event.type === 'flush');
  const unlock = f.calls.events.findLastIndex(event => event.type === 'unlock');
  assert.ok(lastWrite < lastFlush && lastFlush < unlock);
});
