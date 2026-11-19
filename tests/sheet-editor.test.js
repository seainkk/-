import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TEST_ACCESS_KEY, TEST_ACCESS_HASH } from './helpers/shared-link.js';

const ROOT = 'grid_root_folder_123456', SOURCES = 'grid_source_folder_123456', OUTREACH = 'grid_outreach_folder_123456', SEGMENT = 'grid_segment_folder_123456';
const STAGING = 'grid_private_drafts_123456', FILE = 'grid_source_book_123456', SERVICE = 'grid_service_book_123456';
const MIME = 'application/vnd.google-apps.spreadsheet';
const plain = value => JSON.parse(JSON.stringify(value));
const iter = values => { let index = 0; return { hasNext: () => index < values.length, next: () => values[index++] }; };

function fixture(options = {}) {
  const calls = { opened: [], mutations: [], rawRequests: [], flushes: 0, capabilities: 0, reads: 0, propertyWrites: 0, digests: 0 };
  const properties = new Map(Object.entries({ ROOT_FOLDER_ID: ROOT, SOURCE_BASES_FOLDER_ID: SOURCES, SEGMENTS_FOLDER_ID: OUTREACH, SOURCE_BASES_STORAGE_ID: SERVICE, SHARED_ACCESS_KEY_SHA256: TEST_ACCESS_HASH, ...options.properties }));
  let locked = false, parents = options.parents || [SOURCES], writeFault = options.writeFault, appendFault = options.appendFault, doneFault = options.doneFault;
  const folders = new Map();
  const folder = (id, name, parentIds) => ({ getId: () => id, getName: () => name, isTrashed: () => false, getParents: () => iter(parentIds.map(id => folders.get(id))), getFolders: () => iter([]) });
  for (const [id, name, parentIds] of [[ROOT, 'Корень', []], [SOURCES, 'Исходные базы', [ROOT]], [OUTREACH, 'Аутричи', [ROOT]], [SEGMENT, 'Сегмент', [OUTREACH]], [STAGING, 'Подготовка', options.stagingParents || [ROOT]]]) folders.set(id, folder(id, name, parentIds));
  const file = { getId: () => FILE, getName: () => 'Рабочая база', getMimeType: () => options.mime || MIME, isTrashed: () => !!options.trashed, getParents: () => iter(parents.map(id => folders.get(id))) };
  const sourceRows = options.rows || [['Название', 'Число', 'Телефон'], ['Компания', 7, '+79991234567']];
  const cells = sourceRows.map(row => row.map(initialCell));
  function initialCell(input) {
    if (input && typeof input === 'object' && !(input instanceof Date)) return { value: input.value ?? '', formula: input.formula || '', display: input.display };
    return { value: input ?? '', formula: '', display: undefined };
  }
  function at(row, column) { return cells[row - 1]?.[column - 1] || { value: '', formula: '', display: undefined }; }
  function put(row, column, value, literal = false) {
    cells[row - 1] ||= [];
    if (!literal && typeof value === 'string' && value.startsWith("'")) cells[row - 1][column - 1] = { value: value.slice(1), formula: '', display: undefined };
    else if (!literal && typeof value === 'string' && value.startsWith('=')) cells[row - 1][column - 1] = { value: value === '=1+2' ? 3 : 0, formula: value, display: undefined };
    else cells[row - 1][column - 1] = { value, formula: '', display: undefined };
  }
  const state = { rows: options.rowCount || 100, columns: options.columnCount || 26 };
  const sheet = {
    getSheetId: () => 0, getName: () => 'Исходная база', getMaxRows: () => state.rows, getMaxColumns: () => state.columns,
    getLastRow: () => cells.reduce((last, row, index) => row?.some(c => c && (c.formula || c.value !== '')) ? index + 1 : last, 0),
    getLastColumn: () => cells.reduce((max, row) => Math.max(max, (row || []).reduce((last, c, index) => c && (c.formula || c.value !== '') ? index + 1 : last, 0)), 0),
    getRange: (row, column, rowCount, columnCount) => {
      function read(pick) {
        calls.reads++;
        options.onRead?.({ row, column, rowCount, columnCount, locked, move: ids => { parents = ids; }, revoke: () => properties.set('SHARED_ACCESS_KEY_SHA256', 'x'.repeat(43)), setCell: put });
        return Array.from({ length: rowCount }, (_, y) => Array.from({ length: columnCount }, (_, x) => pick(at(row + y, column + x))));
      }
      return {
        getValues: () => read(cell => cell.value), getFormulas: () => read(cell => cell.formula),
        getDisplayValues: () => read(cell => cell.display ?? (Object.prototype.toString.call(cell.value) === '[object Date]' ? cell.value.toISOString() : String(cell.value))),
        setValues: values => {
          assert.equal(locked, true); calls.mutations.push({ kind: 'values', row, column, rowCount, columnCount });
          if (writeFault === 'before') { writeFault = null; throw new Error('Write lost before apply'); }
          values.forEach((line, y) => line.forEach((value, x) => put(row + y, column + x, value)));
          if (writeFault === 'after') { writeFault = null; throw new Error('Write response lost'); }
        },
        setRichTextValues: values => { assert.equal(locked, true); calls.mutations.push({ kind: 'rich', row, column, rowCount, columnCount }); values.forEach((line, y) => line.forEach((value, x) => { let text = value.text; if (text.startsWith('+')) text = '=' + text; else if (/^\d+$/.test(text)) text = Number(text); put(row + y, column + x, text); })); },
      };
    },
    insertRowsAfter: (after, count) => {
      assert.equal(locked, true); assert.equal(after, state.rows); calls.mutations.push({ kind: 'rows', count }); state.rows += count;
      if (appendFault) { appendFault = false; throw new Error('Append response lost'); }
    },
    insertColumnsAfter: (after, count) => {
      assert.equal(locked, true); assert.equal(after, state.columns); calls.mutations.push({ kind: 'columns', count }); state.columns += count;
      if (appendFault) { appendFault = false; throw new Error('Append response lost'); }
    },
  };
  const context = vm.createContext({
    console: { warn() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key) ?? null,
      setProperty: (key, value) => { calls.propertyWrites++; if (options.propertyFault === 'pending' && key.startsWith('GRID_') && key !== 'GRID_RECEIPT_INDEX') throw new Error('Storage unavailable'); if (doneFault && key.startsWith('GRID_') && key !== 'GRID_RECEIPT_INDEX' && JSON.parse(value).status === 'done') { doneFault = false; throw new Error('Completion journal lost'); } properties.set(key, value); },
      deleteProperty: key => properties.delete(key),
    }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: (_, value) => { calls.digests++; return [...crypto.createHash('sha256').update(value).digest()]; }, base64EncodeWebSafe: value => Buffer.from(value).toString('base64url') },
    LockService: { getScriptLock: () => ({ tryLock: () => { if (options.busy) return false; locked = true; return true; }, releaseLock: () => { locked = false; } }) },
    DriveApp: { getFolderById: id => { if (!folders.has(id)) throw new Error('Missing folder'); return folders.get(id); }, getFileById: id => { if (id !== FILE) throw new Error('Missing book'); return file; } },
    Drive: { Files: { get: id => { assert.equal(id, FILE); calls.capabilities++; if (options.capabilityThrows) throw new Error('No capability'); return { appProperties: options.appProperties || {}, ...(options.capabilityMissing ? {} : { capabilities: { canEdit: options.canEdit !== false } }) }; } } },
    ScriptApp: { getOAuthToken: () => { throw new Error('The literal writer must not request a raw OAuth token'); } },
    UrlFetchApp: { fetch: () => { throw new Error('The literal writer must not use raw HTTP'); } },
    Sheets: { Spreadsheets: { batchUpdate: (request, id) => {
      assert.equal(id, FILE);
      const body = plain(request); calls.rawRequests.push(body);
      assert.ok(body.requests.every(item => item.updateCells));
      assert.ok(locked || options.directRaw);
      if (options.rawStatus) {
        let payload = {}; try { payload = JSON.parse(options.rawBody || '{}'); } catch {}
        const error = new Error(payload.error?.message || 'OAuth secret and private data must not appear in an error');
        error.details = { ...payload.error, code: options.rawStatus }; throw error;
      }
      if (options.rawFault === 'before') throw new Error('RAW response lost before apply');
      for (const item of body.requests) {
        const update = item.updateCells, area = update.range;
        calls.mutations.push({ kind: 'raw', row: area.startRowIndex + 1, column: area.startColumnIndex + 1, rowCount: area.endRowIndex - area.startRowIndex, columnCount: area.endColumnIndex - area.startColumnIndex });
        update.rows.forEach((line, y) => line.values.forEach((cell, x) => { assert.equal(typeof cell.userEnteredValue.stringValue, 'string'); put(area.startRowIndex + y + 1, area.startColumnIndex + x + 1, cell.userEnteredValue.stringValue, true); }));
      }
      if (options.rawFault === 'after') throw new Error('RAW response lost after apply');
      return { spreadsheetId: options.rawWrongId ? 'wrong' : FILE, replies: body.requests.map(() => ({})) };
    } } },
    SpreadsheetApp: { openById: id => { assert.equal(id, FILE); calls.opened.push(id); return { getSheets: () => [sheet] }; }, flush: () => { assert.ok(locked || options.directRaw); calls.flushes++; }, newRichTextValue: () => { let text = ''; return { setText(value) { text = value; return this; }, build() { return { text }; } }; } },
  });
  for (const name of ['Config.gs', 'Code.gs', 'Segments.gs', 'SourceBases.gs', 'SegmentActions.gs', 'SheetEditor.gs', 'Access.gs']) vm.runInContext(readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'), context, { filename: name });
  const run = callback => plain(context.withSharedAccess_(TEST_ACCESS_KEY, callback));
  const read = (area = {}) => run(() => context.getGridRange_({ id: FILE, sheetId: 0, row: 1, column: 1, rowCount: 2, columnCount: 3, ...area }));
  const save = (values, old, extra = {}) => run(() => context.saveGridRange_({ id: FILE, sheetId: 0, row: old.row, column: old.column, values, expected: old.versions, requestId: 'grid_save_request_12345', ...extra }));
  return { context, calls, properties, cells, state, run, read, save, put, move: ids => { parents = ids; }, metadata: () => run(() => context.getGridWorkbook_({ id: FILE })) };
}

test('workbook metadata exposes actual sheets, dimensions and editable capability', () => {
  const f = fixture();
  assert.deepEqual(f.metadata(), { id: FILE, name: 'Рабочая база', url: `https://docs.google.com/spreadsheets/d/${FILE}/edit`, canEdit: true, sheets: [{ id: 0, name: 'Исходная база', rowCount: 100, columnCount: 26, usedRows: 2, usedColumns: 3 }] });
  assert.equal(f.calls.mutations.length, 0);
});

test('display values, formula/raw inputs and independent cell versions are read within bounds', () => {
  const f = fixture({ rows: [['plain', { formula: '=1+2', value: 3 }, '000123'], [false, 12.5, new Date('2026-01-02T00:00:00.000Z')]] });
  const data = f.read();
  assert.deepEqual(data.values, [['plain', '3', '000123'], ['false', '12.5', '2026-01-02T00:00:00.000Z']]);
  assert.deepEqual(data.inputs, [['plain', '=1+2', '000123'], ['false', '12.5', '2026-01-02T00:00:00.000Z']]);
  assert.equal(data.totalRows, 100); assert.equal(data.rowCount, 2);
  assert.ok(data.versions.flat().every(value => /^[A-Za-z0-9_-]{43}$/.test(value)));
});

test('a 5000-cell blank viewport hashes one distinct cell value per request', () => {
  const f = fixture({ rows: [[]], columnCount: 50 });
  const result = f.read({ rowCount: 100, columnCount: 50 });
  assert.equal(result.versions.length, 100);
  assert.equal(new Set(result.versions.flat()).size, 1);
  assert.equal(f.calls.digests, 2, 'one access-key hash and one distinct cell hash');
  f.read({ rowCount: 100, columnCount: 50 });
  assert.equal(f.calls.digests, 4, 'the memo belongs to one request only');
});

test('a rectangular paste writes only the explicitly requested cells and returns current versions', () => {
  const f = fixture(), old = f.read({ row: 2, column: 1, rowCount: 1, columnCount: 2 });
  const saved = f.save([['Другая', '8,5']], old);
  assert.equal(saved.state, 'saved'); assert.equal(saved.recovered, false);
  assert.deepEqual(saved.values, [['Другая', '8.5']]); assert.equal(f.cells[1][2].value, '+79991234567');
  assert.equal(f.calls.mutations.length, 2); assert.equal(f.calls.flushes, 2);
  assert.notDeepEqual(saved.versions, old.versions);
});

test('a 5000-cell paste uses an explicit rectangle and one exact RAW batch with payload limits', () => {
  const f = fixture({ rows: [[]], rowCount: 5000 }), old = f.read({ rowCount: 5000, columnCount: 1 });
  const saved = f.save(Array.from({ length: 5000 }, (_, i) => ['contact-' + i]), old);
  assert.equal(saved.rowCount, 5000); assert.equal(f.calls.mutations.length, 2); assert.equal(f.cells[4999][0].value, 'contact-4999');
  const g = fixture({ rows: [[]], rowCount: 5000 }), before = g.read({ rowCount: 5000, columnCount: 1 });
  assert.throws(() => g.save(Array.from({ length: 5000 }, () => ['x'.repeat(51)]), before), /GRID_LIMIT/);
  assert.equal(g.calls.mutations.length, 0);
});

test('a long vertical text-number paste groups literal writes and retains strings', () => {
  const f = fixture({ rows: [[]], rowCount: 1000 }), old = f.read({ rowCount: 1000, columnCount: 1 });
  f.save(Array.from({ length: 1000 }, () => ["'123"]), old);
  assert.equal(f.calls.mutations.length, 2, 'one safe SDK rectangle plus one vertical RAW rectangle');
  assert.equal(f.cells[999][0].value, '123');
});

test('formulas execute only when explicitly entered, while apostrophe literals never become formulas', () => {
  const f = fixture(), old = f.read({ row: 3, column: 1, rowCount: 1, columnCount: 3 });
  const saved = f.save([['=1+2', "'=1+2", "''quoted"]], old);
  assert.deepEqual(saved.values, [['3', '=1+2', "'quoted"]]);
  assert.deepEqual(saved.inputs, [['=1+2', "'=1+2", "''quoted"]]);
  assert.equal(f.cells[2][0].formula, '=1+2'); assert.equal(f.cells[2][1].formula, ''); assert.equal(f.cells[2][2].formula, '');
});

test('the RAW writer preserves exact plus, formula-like, leading-zero and apostrophe strings', () => {
  const f = fixture({ directRaw: true });
  const strings = [['+79990000001', '=SUM(1,2)', '00123', "'quoted"]];
  f.run(() => f.context.sheetWriteRawStrings_(FILE, 0, 6, 3, strings));
  assert.deepEqual(f.cells[5].slice(2, 6).map(cell => cell.value), strings[0]);
  assert.ok(f.cells[5].slice(2, 6).every(cell => cell.formula === ''));
  assert.equal(f.calls.rawRequests.length, 1);
  const sent = f.calls.rawRequests[0].requests[0].updateCells;
  assert.equal(sent.range.startRowIndex, 5); assert.equal(sent.range.startColumnIndex, 2);
  assert.deepEqual(sent.rows[0].values.map(cell => cell.userEnteredValue), strings[0].map(stringValue => ({ stringValue })));
});

test('mixed checkerboard edits never send false-mask formulas, dates or booleans through RAW', () => {
  const f = fixture(), old = f.read({ row: 3, column: 1, rowCount: 1, columnCount: 6 });
  const saved = f.save([['+79990000001', '=1+2', '2026-01-02T00:00:00.000Z', "'00123", 'TRUE', "'=SUM(1,2)"]], old);
  assert.deepEqual(saved.values[0], ['+79990000001', '3', '2026-01-02T00:00:00.000Z', '00123', 'true', '=SUM(1,2)']);
  assert.equal(f.cells[2][1].formula, '=1+2'); assert.equal(Object.prototype.toString.call(f.cells[2][2].value), '[object Date]'); assert.equal(f.cells[2][4].value, true);
  const ranges = f.calls.rawRequests[0].requests.map(request => request.updateCells.range);
  assert.deepEqual(ranges.map(range => [range.startColumnIndex, range.endColumnIndex]), [[0,1],[3,4],[5,6]]);
  assert.ok(f.calls.mutations.every(mutation => mutation.kind !== 'rich'));
});

test('RAW hyperlinks use text runs and provider errors never disclose response bodies or credentials', () => {
  const f = fixture({ directRaw: true });
  f.run(() => f.context.sheetWriteRawStrings_(FILE, 0, 4, 2, [['WhatsApp']], undefined, [['https://wa.me/79990000001']]));
  const cell = f.calls.rawRequests[0].requests[0].updateCells.rows[0].values[0];
  assert.deepEqual(cell.textFormatRuns, [{ startIndex: 0, format: { link: { uri: 'https://wa.me/79990000001' } } }]);
  for (const options of [{ rawStatus: 403 }, { rawWrongId: true }, { rawFault: 'after' }]) {
    const g = fixture({ ...options, directRaw: true });
    assert.throws(() => g.run(() => g.context.sheetWriteRawStrings_(FILE, 0, 4, 2, [['+79990000001']])), error => /SHEETS_RAW_UNCERTAIN/.test(error.message) && !/synthetic-private-token|OAuth secret|private data/.test(error.message));
  }
});

test('controlled RAW diagnostics distinguish API setup, masks and scopes without provider text', () => {
  const examples = [
    [403, { error: { status: 'PERMISSION_DENIED', message: 'private-project-998877 and OAuth secret', details: [{ reason: 'SERVICE_DISABLED', metadata: { consumer: 'projects/private-project-998877' } }] } }, 'HTTP 403, SERVICE_DISABLED'],
    [400, { error: { status: 'INVALID_ARGUMENT', message: 'Invalid field mask userEnteredFormat.textFormat.link; private customer text' } }, 'HTTP 400, INVALID_FIELD_MASK'],
    [403, { error: { status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }, 'HTTP 403, INSUFFICIENT_SCOPES'],
    [429, { error: { message: 'OAuth secret and private customer text' } }, 'HTTP 429, RATE_LIMITED'],
  ];
  for (const [status, body, expected] of examples) {
    const f = fixture({ directRaw: true, rawStatus: status, rawBody: JSON.stringify(body) });
    assert.throws(() => f.run(() => f.context.sheetWriteRawStrings_(FILE, 0, 4, 2, [['+79990000001']])), error => error.sheetRawDiagnostic === expected && error.message.includes(expected) && !/private-project|OAuth secret|private customer/.test(error.message));
  }
});

test('a missing Advanced Sheets service fails closed without raw OAuth or HTTP fallback', () => {
  const f = fixture({ directRaw: true }); delete f.context.Sheets;
  assert.throws(() => f.run(() => f.context.sheetWriteRawStrings_(FILE, 0, 4, 2, [['+79990000001']])), error => error.sheetRawDiagnostic === 'ADVANCED_SERVICE_UNAVAILABLE');
  assert.equal(f.calls.rawRequests.length, 0); assert.equal(f.calls.mutations.length, 0);
});

test('Grid uncertainty exposes only the safe RAW diagnostic and keeps the request pending', () => {
  const f = fixture({ rawStatus: 403, rawBody: JSON.stringify({ error: { details: [{ reason: 'SERVICE_DISABLED' }], message: 'PRIVATE_TOKEN_PRIVATE_USERDATA' } }) });
  const old = f.read({ row: 3, column: 1, rowCount: 1, columnCount: 1 });
  assert.throws(() => f.save([["'+79990000001"]], old), error => /GRID_UNCERTAIN/.test(error.message) && /HTTP 403, SERVICE_DISABLED/.test(error.message) && !/PRIVATE_TOKEN|PRIVATE_USERDATA/.test(error.message));
  const key = JSON.parse(f.properties.get('GRID_RECEIPT_INDEX'))[0];
  assert.equal(JSON.parse(f.properties.get(key)).status, 'pending');
});

test('the initial SDK pass escapes every string before the RAW batch restores its exact type', () => {
  const f = fixture(), old = f.read({ row: 3, column: 1, rowCount: 1, columnCount: 4 });
  const inputs = [['+79990000001', 'text', "'=SUM(1,2)", "'00123"]];
  const prepared = f.context.gridValues_(inputs);
  assert.deepEqual(plain(prepared.values), [["'+79990000001", "'text", "'=SUM(1,2)", "'00123"]]);
  f.save(inputs, old);
  assert.deepEqual(f.cells[2].map(cell => cell.value), ['+79990000001','text','=SUM(1,2)','00123']);
  assert.equal(f.cells[2][2].formula, '');
});

test('long identifiers, phone numbers and leading zeroes remain text, simple locale numbers are typed', () => {
  const f = fixture(), old = f.read({ row: 3, column: 1, rowCount: 1, columnCount: 6 });
  f.save([['0007', '79991234567', '+79991234567', '12345678901234567890', '1,25', 'TRUE']], old);
  assert.deepEqual(f.cells[2].map(cell => cell.value), ['0007', '79991234567', '+79991234567', '12345678901234567890', 1.25, true]);
});

test('raw numeric-looking text has an escaped edit input and can be round-tripped without changing its type', () => {
  const f = fixture({ rows: [['123', 'TRUE', '=literal']] }), old = f.read({ rowCount: 1 });
  assert.deepEqual(old.inputs, [["'123", "'TRUE", "'=literal"]]);
  f.save(old.inputs, old);
  assert.deepEqual(f.cells[0].map(cell => cell.value), ['123', 'TRUE', '=literal']);
  assert.ok(f.cells[0].every(cell => !cell.formula));
});

test('stale cell versions reject the whole rectangle before any writes or receipts', () => {
  const f = fixture(), old = f.read({ row: 2, rowCount: 1 });
  f.put(2, 2, 9);
  assert.throws(() => f.save([['X', '10', 'new']], old), /GRID_CONFLICT/);
  assert.equal(f.calls.mutations.length, 0); assert.equal(f.calls.propertyWrites, 0); assert.equal(f.cells[1][0].value, 'Компания');
});

test('volatile formula recalculation does not create a false human-edit conflict', () => {
  const f = fixture({ rows: [[{ formula: '=RAND()', value: 0.1 }]] }), old = f.read({ rowCount: 1, columnCount: 1 });
  f.cells[0][0].value = 0.9;
  assert.deepEqual(f.read({ rowCount: 1, columnCount: 1 }).versions, old.versions);
  assert.equal(f.save([['=1+2']], old).state, 'saved');
});

test('new cross-document formulas are blocked before writing but quoted text is not treated as a function', () => {
  const f = fixture(), old = f.read({ row: 3, column: 1, rowCount: 1, columnCount: 1 });
  for (const value of ['=IMPORTRANGE("private-book","A1")', '=IFERROR( importrange ("private-book";"A1");"")']) assert.throws(() => f.save([[value]], old), /GRID_FORMULA_UNSUPPORTED/);
  assert.equal(f.calls.mutations.length, 0); assert.equal(f.calls.propertyWrites, 0);
  assert.equal(f.save([['=SUM(1,2)']], old).state, 'saved');
  const g = fixture(), target = g.read({ row: 3, column: 1, rowCount: 1, columnCount: 3 });
  assert.equal(g.save([['="IMPORTRANGE("', "'=IMPORTRANGE(\"literal\",\"A1\")", "='IMPORTRANGE('!A1"]], target).state, 'saved');
});

test('existing cross-document formulas remain readable without executing a new write', () => {
  const formula = '=IMPORTRANGE("existing-approved-book","A1")';
  const f = fixture({ rows: [[{ formula, value: 'existing result' }]] });
  assert.deepEqual(f.read({ rowCount: 1, columnCount: 1 }).inputs, [[formula]]);
  assert.equal(f.calls.mutations.length, 0);
});

test('a completed request replay returns later external edits without reapplying the old value', () => {
  const f = fixture(), old = f.read({ row: 2, column: 1, rowCount: 1, columnCount: 1 });
  f.save([['Saved']], old); f.put(2, 1, 'Edited later');
  const replay = f.save([['Saved']], old);
  assert.equal(replay.recovered, true); assert.deepEqual(replay.values, [['Edited later']]); assert.equal(f.calls.mutations.length, 2);
});

test('request IDs are bound to the exact payload and cannot overwrite another range', () => {
  const f = fixture(), old = f.read({ row: 2, column: 1, rowCount: 1, columnCount: 1 });
  f.save([['Saved']], old);
  assert.throws(() => f.save([['Different']], old), /REQUEST_REUSED/); assert.equal(f.calls.mutations.length, 2);
});

test('a lost write response is recovered by comparing intended values and does not write twice', () => {
  const f = fixture({ writeFault: 'after' }), old = f.read({ row: 2, column: 1, rowCount: 1, columnCount: 1 });
  assert.throws(() => f.save([['Saved']], old), /GRID_UNCERTAIN/);
  const recovered = f.save([['Saved']], old);
  assert.equal(recovered.recovered, true); assert.equal(f.calls.mutations.length, 1);
});

test('a lost response followed by an external edit remains uncertain and never overwrites that edit', () => {
  const f = fixture({ writeFault: 'after' }), old = f.read({ row: 2, column: 1, rowCount: 1, columnCount: 1 });
  assert.throws(() => f.save([['Saved']], old), /GRID_UNCERTAIN/); f.put(2, 1, 'Later');
  assert.throws(() => f.save([['Saved']], old), /GRID_UNCERTAIN/);
  assert.equal(f.calls.mutations.length, 1); assert.equal(f.cells[1][0].value, 'Later');
});

test('an unconfirmed write not applied by Google is not blindly retried', () => {
  const f = fixture({ writeFault: 'before' }), old = f.read({ row: 2, column: 1, rowCount: 1, columnCount: 1 });
  assert.throws(() => f.save([['Saved']], old), /GRID_UNCERTAIN/);
  assert.throws(() => f.save([['Saved']], old), /GRID_UNCERTAIN/); assert.equal(f.calls.mutations.length, 1);
});

test('failure to persist the pending receipt prevents every native write', () => {
  const f = fixture({ propertyFault: 'pending' }), old = f.read({ row: 2, column: 1, rowCount: 1, columnCount: 1 });
  assert.throws(() => f.save([['Never written']], old), /GOOGLE_ERROR/);
  assert.equal(f.calls.mutations.length, 0); assert.equal(f.cells[1][0].value, 'Компания');
});

test('a lost completion journal update still returns the saved range and can be recovered once', () => {
  const f = fixture({ doneFault: true }), old = f.read({ row: 2, column: 1, rowCount: 1, columnCount: 1 });
  assert.equal(f.save([['Saved']], old).state, 'saved');
  assert.equal(f.save([['Saved']], old).recovered, true); assert.equal(f.calls.mutations.length, 2);
});

test('root-only private drafts, direct Outreach-root files, outside files and non-native files are not editable', () => {
  for (const options of [{ parents: [STAGING] }, { parents: [ROOT] }, { parents: [OUTREACH] }, { mime: 'text/csv' }, { trashed: true }]) {
    const f = fixture(options); assert.throws(() => f.read(), /OUTSIDE_REGISTRY/); assert.equal(f.calls.opened.length, 0); assert.equal(f.calls.mutations.length, 0);
  }
  const segment = fixture({ parents: [SEGMENT] }); assert.equal(segment.metadata().canEdit, true);
});

test('default and configured service books are protected before cell reads', () => {
  const f = fixture();
  for (const id of [SERVICE, f.context.REGISTRY_CONFIG.defaultSourceBasesStorageId]) assert.throws(() => f.run(() => f.context.getGridWorkbook_({ id })), /GRID_PROTECTED/);
  assert.equal(f.calls.opened.length, 0);
});

test('missing keys and revoked keys cannot read or mutate workbook cells', () => {
  const f = fixture();
  assert.throws(() => f.context.getGridWorkbook_({ id: FILE }), /LINK_ACCESS_REQUIRED/);
  assert.throws(() => f.context.withSharedAccess_('Z'.repeat(43), () => f.context.getGridWorkbook_({ id: FILE })), /LINK_ACCESS_REQUIRED/);
  const old = f.read({ row: 2, column: 1, rowCount: 1, columnCount: 1 });
  f.properties.set('SHARED_ACCESS_KEY_SHA256', 'x'.repeat(43));
  assert.throws(() => f.save([['Never']], old), /LINK_ACCESS_REQUIRED/); assert.equal(f.calls.mutations.length, 0);
});

test('viewer-only or unknown edit capabilities allow reading but prevent writes', () => {
  for (const option of [{ canEdit: false }, { capabilityMissing: true }]) {
    const f = fixture(option), old = f.read({ row: 2, column: 1, rowCount: 1, columnCount: 1 });
    assert.equal(f.metadata().canEdit, false);
    assert.throws(() => f.save([['Never']], old), /GRID_READ_ONLY/); assert.equal(f.calls.mutations.length, 0);
  }
});

test('unavailable metadata fails closed because draft privacy cannot be checked', () => {
  const f = fixture({ capabilityThrows: true });
  assert.throws(() => f.read(), /GRID_ACCESS_UNAVAILABLE/); assert.equal(f.calls.opened.length, 0);
});

test('known staging descendants stay private even if the folder moves into Sources', () => {
  const f = fixture({ parents: [STAGING], stagingParents: [SOURCES], properties: { PREPARED_STAGING_FOLDER_ID: STAGING } });
  assert.throws(() => f.read(), /GRID_PROTECTED/); assert.equal(f.calls.opened.length, 0);
});

test('draft markers stay private after an individual input or output is moved into Sources', () => {
  for (const tags of [
    { registryPreparedRole: 'input', registryPreparedRoot: ROOT },
    { registryPreparedRole: 'plan_token', registryPreparedRoot: ROOT },
    { registryPreparedRole: 'output', registryPreparedRoot: ROOT },
    { registryPreparedDraft: 'opaque', registryPreparedRoot: ROOT },
    { registryPreparedRole: 'output', registryPreparedVersion: '1', registryPreparedRoot: 'other_root_1234567890' },
  ]) {
    const f = fixture({ appProperties: tags }); assert.throws(() => f.read(), /GRID_PROTECTED/); assert.equal(f.calls.opened.length, 0);
  }
  const done = fixture({ appProperties: { registryPreparedRole: 'output', registryPreparedVersion: '1', registryPreparedRoot: ROOT } });
  assert.equal(done.metadata().canEdit, true);
});

test('membership and authorization are checked again after reading expected versions', () => {
  let moveOnRead = false;
  const f = fixture({ onRead(event) { if (moveOnRead && event.locked) event.move([ROOT]); } });
  const old = f.read({ row: 2, column: 1, rowCount: 1, columnCount: 1 }); moveOnRead = true;
  assert.throws(() => f.save([['Never']], old), /OUTSIDE_REGISTRY/); assert.equal(f.calls.mutations.length, 0);
  let revokeOnRead = false;
  const g = fixture({ onRead(event) { if (revokeOnRead && event.locked) event.revoke(); } });
  const before = g.read({ row: 2, column: 1, rowCount: 1, columnCount: 1 }); revokeOnRead = true;
  assert.throws(() => g.save([['Never']], before), /LINK_ACCESS_REQUIRED/); assert.equal(g.calls.mutations.length, 0);
});

test('edit capability is checked again immediately before the native mutation', () => {
  let revokeRights = false;
  const options = { onRead(event) { if (revokeRights && event.locked) options.canEdit = false; } };
  const f = fixture(options), old = f.read({ row: 2, column: 1, rowCount: 1, columnCount: 1 }); revokeRights = true;
  assert.throws(() => f.save([['Never']], old), /GRID_READ_ONLY/);
  assert.equal(f.calls.mutations.length, 0);
});

test('read, write, payload and sheet bounds are enforced before mutation', () => {
  const f = fixture();
  for (const area of [{ row: 0 }, { column: -1 }, { rowCount: 501, columnCount: 10 }, { row: 99, rowCount: 3 }]) assert.throws(() => f.read(area), /GRID_LIMIT|GRID_BOUNDS/);
  assert.throws(() => f.run(() => f.context.getGridRange_({ id: FILE, sheetId: 99, row: 1, column: 1, rowCount: 1, columnCount: 1 })), /GRID_SHEET_MISSING/);
  const old = f.read({ row: 1, column: 1, rowCount: 1, columnCount: 1 });
  assert.throws(() => f.save([['a', 'b']], old), /INVALID_REQUEST/);
  assert.throws(() => f.save([[42]], old), /INVALID_REQUEST/);
  assert.throws(() => f.save([['x'.repeat(50001)]], old), /INVALID_REQUEST/);
  assert.throws(() => f.run(() => f.context.getGridWorkbook_({ id: FILE, folderId: ROOT })), /INVALID_REQUEST/);
  assert.equal(f.calls.mutations.length, 0);
});

test('append rows and columns use actual expected dimensions and replay without a second insert', () => {
  const f = fixture();
  const rows = { id: FILE, sheetId: 0, count: 10, expectedRowCount: 100, requestId: 'append_rows_request_1234' };
  assert.equal(f.run(() => f.context.appendGridRows_(rows)).rowCount, 110);
  assert.equal(f.run(() => f.context.appendGridRows_(rows)).recovered, true);
  const columns = { id: FILE, sheetId: 0, count: 2, expectedColumnCount: 26, requestId: 'append_cols_request_1234' };
  assert.equal(f.run(() => f.context.appendGridColumns_(columns)).columnCount, 28);
  assert.equal(f.run(() => f.context.appendGridColumns_(columns)).recovered, true);
  assert.equal(f.calls.mutations.length, 2);
});

test('an uncertain append never guesses success from dimensions or inserts again', () => {
  const f = fixture({ appendFault: true }), request = { id: FILE, sheetId: 0, count: 10, expectedRowCount: 100, requestId: 'append_lost_request_1234' };
  assert.throws(() => f.run(() => f.context.appendGridRows_(request)), /GRID_UNCERTAIN/);
  assert.equal(f.state.rows, 110);
  assert.throws(() => f.run(() => f.context.appendGridRows_(request)), /GRID_UNCERTAIN/); assert.equal(f.calls.mutations.length, 1);
});

test('append stale dimensions and native grid cell limits fail before insertion', () => {
  const f = fixture();
  assert.throws(() => f.run(() => f.context.appendGridRows_({ id: FILE, sheetId: 0, count: 1, expectedRowCount: 99, requestId: 'append_stale_request_1234' })), /GRID_CONFLICT/);
  const g = fixture({ rowCount: 100000, columnCount: 100 });
  assert.throws(() => g.run(() => g.context.appendGridColumns_({ id: FILE, sheetId: 0, count: 1, expectedColumnCount: 100, requestId: 'append_limit_request_1234' })), /GRID_LIMIT/);
  assert.equal(f.calls.mutations.length + g.calls.mutations.length, 0);
});

test('pending receipt eviction is forbidden while completed receipt eviction remains bounded', () => {
  const f = fixture(), keys = [];
  for (let i = 0; i < 80; i++) { const key = 'GRID_' + crypto.createHash('sha256').update('pending' + i).digest('base64url').slice(0,32); keys.push(key); f.properties.set(key, JSON.stringify({ version: 1, status: 'pending', fingerprint: 'x' })); }
  f.properties.set('GRID_RECEIPT_INDEX', JSON.stringify(keys));
  const old = f.read({ row: 2, column: 1, rowCount: 1, columnCount: 1 });
  assert.throws(() => f.save([['Never']], old), /GRID_JOURNAL_LIMIT/); assert.equal(f.calls.mutations.length, 0);
  f.properties.set(keys[0], JSON.stringify({ version: 1, status: 'done', fingerprint: 'x' }));
  assert.equal(f.save([['Now saved']], old).state, 'saved');
  assert.equal(JSON.parse(f.properties.get('GRID_RECEIPT_INDEX')).length, 80);
  assert.equal(f.properties.has(keys[0]), false);
});

test('a malformed old receipt is not silently evicted from a full journal', () => {
  const f = fixture(), keys = [];
  for (let i = 0; i < 80; i++) { const key = 'GRID_' + crypto.createHash('sha256').update('corrupted' + i).digest('base64url').slice(0,32); keys.push(key); f.properties.set(key, i ? JSON.stringify({ version: 1, status: 'pending', fingerprint: 'x' }) : '{broken'); }
  f.properties.set('GRID_RECEIPT_INDEX', JSON.stringify(keys));
  const old = f.read({ row: 2, column: 1, rowCount: 1, columnCount: 1 });
  assert.throws(() => f.save([['Never']], old), /GRID_UNCERTAIN/);
  assert.equal(f.calls.mutations.length, 0); assert.equal(f.properties.get(keys[0]), '{broken');
});

test('a busy app lock prevents editing without native writes', () => {
  const f = fixture({ busy: true }), old = f.read({ row: 2, column: 1, rowCount: 1, columnCount: 1 });
  assert.throws(() => f.save([['Never']], old), /BUSY/); assert.equal(f.calls.mutations.length, 0);
});
