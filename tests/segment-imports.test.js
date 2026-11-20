import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const ROOT = 'registry_root_1234567890', SEGMENT = 'segment_folder_1234567890', SOURCE = 'source_book_1234567890', COMPANIES = 'company_book_1234567890', PEOPLE = 'people_book_1234567890', STORE = 'service_book_1234567890', PRIVATE = 'staging_folder_1234567890';
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(options = {}) {
  const resources = new Map(), books = new Map(), properties = new Map(), calls = { raw: [], created: [], relations: [], enrollments: [], mutations: [], locked: 0, segmentMutations: [] };
  let sequence = 100, writeFailure = options.writeFailure || null;
  const config = { rootId: ROOT, email: 'shared-link', properties: { getProperty: key => properties.get(key) ?? null, setProperty: (key, value) => properties.set(key, value), deleteProperty: key => properties.delete(key) } };
  function resource(id, name, parent = ROOT, mime = 'application/vnd.google-apps.spreadsheet') {
    const item = { id, name, parent, mime, appProperties: {}, version: 1, trashed: false, canEdit: true, content: '', getId: () => id, getName: () => item.name, getMimeType: () => item.mime, isTrashed: () => item.trashed, getBlob: () => ({ getDataAsString: () => item.content }) };
    resources.set(id, item); return item;
  }
  function metadata(id) { const item = resources.get(id); if (!item) throw new Error('Missing resource'); return { id, name: item.name, mimeType: item.mime, parents: [item.parent], trashed: item.trashed, appProperties: { ...item.appProperties }, version: String(item.version), capabilities: { canEdit: item.canEdit } }; }
  function sheet(book, name, rows = [], id = ++sequence) {
    const state = { name, rows: structuredClone(rows), id, maxRows: 1000, maxColumns: 26, formulas: {}, developerMetadata: [] };
    const raw = (r, col) => state.rows[r - 1]?.[col - 1] ?? '';
    const result = { state, getSheetId: () => id, getName: () => state.name, setName: value => { state.name = value; return result; }, getParent: () => book,
      getLastRow: () => { let row = state.rows.length; while (row && state.rows[row - 1].every(value => value === '')) row--; return row; },
      getLastColumn: () => Math.max(0, ...state.rows.map(row => { let col = row.length; while (col && row[col - 1] === '') col--; return col; })),
      getMaxRows: () => state.maxRows, getMaxColumns: () => state.maxColumns,
      createDeveloperMetadataFinder: () => { let key, value; const finder = { withKey: v => { key = v; return finder; }, withValue: v => { value = v; return finder; }, find: () => state.developerMetadata.filter(item => item.key === key && item.value === value).map(item => ({ getLocation: () => ({ getColumn: () => ({ getSheet: () => result, getColumn: () => item.column }) }) })) }; return finder; },
      insertRowsAfter: (_last, count) => { state.maxRows += count; }, insertColumnsAfter: (_last, count) => { state.maxColumns += count; }, setFrozenRows: () => {},
      getRange: (row, column, height = 1, width = 1) => {
        const matrix = getter => Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => getter(row + y, column + x)));
        return { getValues: () => matrix(raw), getDisplayValues: () => matrix((r, col) => String(raw(r, col))), getFormulas: () => matrix((r, col) => state.formulas[r + ':' + col] || ''), getRichTextValues: () => matrix(() => null), addDeveloperMetadata: (key, value) => { state.developerMetadata.push({ key, value, column }); } };
      }
    };
    book.sheets.push(result); return result;
  }
  function book(id, name) { const result = { id, sheets: [], getId: () => id, getSheets: () => result.sheets, getSheetByName: wanted => result.sheets.find(entry => entry.getName() === wanted) || null, insertSheet: wanted => sheet(result, wanted) }; books.set(id, result); return result; }
  resource(ROOT, 'Реестр', null, 'application/vnd.google-apps.folder'); resource(SEGMENT, 'Кухни', ROOT, 'application/vnd.google-apps.folder'); resource(PRIVATE, 'Подготовка', ROOT, 'application/vnd.google-apps.folder'); resource(STORE, 'Служебная таблица');
  resource(SOURCE, 'Исходная база'); resource(COMPANIES, 'Кухни: компании', SEGMENT); resource(PEOPLE, 'Кухни: ЛПР', SEGMENT);
  const sourceBook = book(SOURCE), companyBook = book(COMPANIES), peopleBook = book(PEOPLE);
  const sourceSheet = sheet(sourceBook, 'Исходная база', options.rows || [['Компания', 'ИНН', 'Email', 'ФИО ЛПР', 'Должность ЛПР', 'Телефон ЛПР'], ['ООО Пример', '7707083893', 'sales@example.test', 'Иван Иванов', 'Директор', '']], 11);
  if (options.legacy) sheet(companyBook, 'Не трогать', [['Доход', 'Особые заметки'], ['100', 'Оставить в исходном виде']], 12); else sheet(companyBook, 'Лист1', [], 12);
  sheet(peopleBook, 'Лист1', [], 13);
  const status = { value: options.status || 'ready', revision: 1 }, tracking = { tables: [{ segmentId: SEGMENT, kind: 'companies', fileId: COMPANIES }, { segmentId: SEGMENT, kind: 'lpr', fileId: PEOPLE }] };
  const context = vm.createContext({ console: { warn() {} } });
  for (const name of ['Config.gs', 'Segments.gs', 'SegmentActions.gs']) vm.runInContext(readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'), context, { filename: name });
  context.digest_ = value => crypto.createHash('sha256').update(value).digest('base64url');
  context.registryError_ = (code, message) => Object.assign(new Error('[' + code + '] ' + message), { registryCode: code });
  context.fail_ = (code, message) => { throw context.registryError_(code, message); };
  context.api_ = callback => callback(); context.authorize_ = () => config;
  context.object_ = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) context.fail_('INVALID_REQUEST', 'Object required'); return value; };
  context.id_ = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(value)) context.fail_('INVALID_ID', 'ID required'); return value; };
  context.locked_ = callback => { calls.locked++; try { return callback(); } finally { calls.locked--; } };
  context.segmentInput_ = (value, allowed) => { context.object_(value); if (Object.keys(value).some(key => !allowed.includes(key))) context.fail_('INVALID_REQUEST', 'Unknown field'); return value; };
  context.segmentRequestId_ = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) context.fail_('INVALID_REQUEST', 'request ID'); return value; };
  context.segmentRevision_ = value => { if (value !== undefined && (!Number.isInteger(value) || value < 1)) context.fail_('INVALID_REQUEST', 'revision'); };
  context.sourceBasesStorage_ = () => ({ public: { id: STORE }, book: {} });
  context.sourceBasesReadDatabase_ = () => ({ records: { [SOURCE]: { status: status.value, revision: status.revision, present: true } }, relations: [] });
  context.requireReadySourceBase_ = (_scope, _storage, _db, id, revision) => { if (id !== SOURCE) context.fail_('OUTSIDE_REGISTRY', 'Outside source folder'); if (status.value !== 'ready') context.fail_('SOURCE_NOT_READY', 'Not ready'); if (revision !== undefined && revision !== status.revision) context.fail_('CONFLICT', 'Stale revision'); return { record: { revision: status.revision }, contents: ['companies', 'lpr'] }; };
  context.segmentSourceFolder_ = () => resources.get(ROOT);
  context.segmentFolder_ = (_scope, _parent, id) => { if (id !== SEGMENT) context.fail_('OUTSIDE_SEGMENTS', 'Wrong folder'); return resources.get(SEGMENT); };
  context.segmentTrackingStorage_ = () => tracking;
  context.segmentTargetFile_ = (_scope, folder, id) => { const item = resources.get(id); if (!item || item.parent !== folder.id || item.mime !== 'application/vnd.google-apps.spreadsheet') context.fail_('OUTSIDE_SEGMENTS', 'Target moved'); return item; };
  context.segmentFindSheet_ = (target, id) => target.sheets.find(entry => entry.getSheetId() === id) || null;
  context.segmentRememberRelation_ = (_scope, _storage, _db, fileId, segmentId) => { if (!calls.relations.some(entry => entry.fileId === fileId && entry.segmentId === segmentId)) calls.relations.push({ fileId, segmentId }); };
  context.segmentMutation_ = (kind, input) => { calls.segmentMutations.push({ kind, input: plain(input) }); return { segment: { id: SEGMENT }, loadedSheets: [] }; };
  context.spreadsheetUrl_ = id => 'https://docs.google.com/spreadsheets/d/' + id + '/edit';
  context.preparedEnsureFolder_ = () => resources.get(PRIVATE); context.preparedFolder_ = (_scope, id) => { if (id !== PRIVATE) context.fail_('OUTSIDE_REGISTRY', 'Wrong private folder'); return resources.get(PRIVATE); };
  context.enrollContactWorkbook_ = (_scope, fileId, settings) => { calls.enrollments.push({ fileId, settings: plain(settings) }); };
  vm.runInContext(readFileSync(new URL('../src/Config.gs', import.meta.url), 'utf8'), context, { filename: 'Config.gs' });
  context.REGISTRY_CONFIG = { defaultSourceBasesStorageId: STORE };
  context.Utilities = { getUuid: () => 'lease-' + ++sequence, newBlob: value => ({ value }) };
  context.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  context.SpreadsheetApp = { openById: id => { if (!books.has(id)) throw new Error('Missing book'); return books.get(id); }, flush() {} };
  context.DriveApp = { getFileById: id => { if (!resources.has(id)) throw new Error('Missing file'); return resources.get(id); } };
  context.Drive = { Files: {
    get: id => metadata(id),
    update: (change, id) => { const item = resources.get(id); if (change.appProperties) item.appProperties = { ...item.appProperties, ...plain(change.appProperties) }; if (change.trashed !== undefined) item.trashed = change.trashed; item.version++; return metadata(id); },
    create: (value, blob) => { const id = 'private_plan_' + ++sequence; const created = resource(id, value.name, value.parents[0], value.mimeType); created.appProperties = plain(value.appProperties); created.content = blob.value; calls.created.push(id); return { id }; }
  } };
  context.sheetWriteRawStrings_ = (id, sheetId, firstRow, firstColumn, values, mask) => {
    const target = books.get(id).sheets.find(entry => entry.getSheetId() === sheetId); if (!target) throw new Error('Missing sheet');
    calls.raw.push({ id, sheetId, firstRow, firstColumn, values: plain(values), mask: mask ? plain(mask) : undefined });
    for (let y = 0; y < values.length; y++) for (let x = 0; x < values[y].length; x++) {
      if (mask && !mask[y][x]) continue;
      while (target.state.rows.length < firstRow + y) target.state.rows.push([]);
      target.state.rows[firstRow + y - 1][firstColumn + x - 1] = values[y][x]; delete target.state.formulas[(firstRow + y) + ':' + (firstColumn + x)];
    }
    resources.get(id).version++;
    if (writeFailure && (!writeFailure.id || id === writeFailure.id) && firstRow > 1) { writeFailure = null; throw context.registryError_('SHEETS_RAW_UNCERTAIN', 'Reply lost after apply'); }
  };
  for (const name of ['ContactPreview.gs', 'SourceRecords.gs', 'PreparedData.gs', 'SegmentRecords.gs', 'SegmentImports.gs']) vm.runInContext(readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'), context, { filename: name });
  const preview = () => context.previewSegmentRecords_({ segmentId: SEGMENT, sourceIds: [SOURCE] });
  const start = (shown, requestId = 'segment-normalize-request-001') => context.importSegmentRecords_({ segmentId: SEGMENT, planToken: shown.planToken, requestId });
  const next = state => context.continueSegmentRecords_({ segmentId: SEGMENT, jobId: state.jobId, requestId: state.requestId });
  const finish = initial => { let result = initial; for (let i = 0; i < 100 && result.state === 'processing'; i++) result = next(result); assert.equal(result.state, 'complete'); return result; };
  const master = kind => context.segmentRecordsMaster_({ context: config, folder: resources.get(SEGMENT), tables: { companies: COMPANIES, lpr: PEOPLE } }, kind, false).sheet;
  return { context, calls, resources, books, properties, sourceBook, sourceSheet, companyBook, peopleBook, status, preview, start, next, finish, master, config };
}

test('preview rejects unready files before creating masters or plans', () => {
  const f = fixture({ status: 'collection' });
  assert.throws(f.preview, /SOURCE_NOT_READY/);
  assert.equal(f.calls.raw.length, 0); assert.equal(f.calls.created.length, 0);
});

test('creates lean masters, transfers a person without contacts and marks original only after verified LPR write', () => {
  const f = fixture(), shown = f.preview();
  assert.equal(shown.counts.companiesAdded, 1); assert.equal(shown.counts.peopleAdded, 1); assert.equal(shown.counts.peopleWithoutContacts, 1);
  assert.equal(f.calls.raw.filter(call => call.firstRow > 1).length, 0, 'preview writes only new empty master headers');
  let state = f.start(shown), companies = f.master('companies'), people = f.master('lpr');
  const transferColumn = f.context.SEGMENT_RECORDS_SCHEMA.company.findIndex(field => field[0] === 'transferred');
  assert.equal(companies.state.rows[1]?.[transferColumn] || '', '', 'company marker is not set before LPR confirmation');
  state = f.finish(state);
  assert.equal(state.counts.peopleAdded, 1);
  assert.equal(companies.state.rows.length, 2); assert.equal(people.state.rows.length, 2);
  assert.equal(people.state.rows[1][3], 'Иван Иванов'); assert.equal(people.state.rows[1][9], 'Найти контакты');
  assert.equal(companies.state.rows[1][transferColumn], 'Перенесено в ЛПР');
  const original = f.sourceSheet.state.rows;
  assert.deepEqual(original[1].slice(0, 6), ['ООО Пример', '7707083893', 'sales@example.test', 'Иван Иванов', 'Директор', '']);
  assert.match(original[1][6], /Перенесено в ЛПР/);
  assert.equal(f.calls.relations.length, 1); assert.ok(f.calls.enrollments.some(entry => entry.settings.role === 'segment-lpr'));
});

test('normalized previews and import results include the current segment category', () => {
  const f = fixture();
  f.properties.set('SEGMENT_CATEGORY_' + SEGMENT, JSON.stringify({ category: 'partners' }));
  const shown = f.preview();
  assert.equal(shown.segment.category, 'partners');
  assert.equal(f.finish(f.start(shown)).segment.category, 'partners');
});

test('a second import and completed-request replay never duplicate rows or reset campaign statuses', () => {
  const f = fixture(), firstPreview = f.preview(), first = f.finish(f.start(firstPreview));
  const companySheet = f.master('companies'), personSheet = f.master('lpr');
  const companyStatus = f.context.SEGMENT_RECORDS_SCHEMA.company.findIndex(field => field[0] === 'status');
  companySheet.state.rows[1][companyStatus] = 'Запущен'; personSheet.state.rows[1][9] = 'В рассылке';
  const source = f.sourceSheet.state.rows[1]; source[5] = '+79990000001'; f.resources.get(SOURCE).version++;
  const nextPreview = f.preview(), second = f.finish(f.start(nextPreview, 'segment-normalize-request-002'));
  assert.equal(second.counts.peopleAdded, 0); assert.equal(companySheet.state.rows.length, 2); assert.equal(personSheet.state.rows.length, 2);
  assert.equal(companySheet.state.rows[1][companyStatus], 'Запущен'); assert.equal(personSheet.state.rows[1][9], 'В рассылке'); assert.equal(personSheet.state.rows[1][6], '+79990000001');
  const writes = f.calls.raw.length;
  assert.equal(f.next(first).state, 'complete'); assert.equal(f.calls.raw.length, writes, 'old completed replay cannot overwrite later contact edits');
});

test('lost write acknowledgement resumes fixed rows instead of appending duplicates', () => {
  const f = fixture({ writeFailure: { id: COMPANIES } }), shown = f.preview();
  assert.throws(() => f.start(shown), /SHEETS_RAW_UNCERTAIN/);
  const jobId = [...f.properties.keys()].find(key => key.startsWith('SEGMENT_RECORD_JOB_')).slice('SEGMENT_RECORD_JOB_'.length);
  const resumed = f.context.continueSegmentRecords_({ segmentId: SEGMENT, jobId, requestId: 'segment-normalize-request-001' });
  f.finish(resumed);
  assert.equal(f.master('companies').state.rows.length, 2); assert.equal(f.master('lpr').state.rows.length, 2);
});

test('source edits after preview stop the job and release its active pointer for a new preview', () => {
  const f = fixture(), shown = f.preview(); f.sourceSheet.state.rows[1][0] = 'Другая компания'; f.resources.get(SOURCE).version++;
  assert.throws(() => f.start(shown), /SEGMENT_PREVIEW_CHANGED/);
  assert.equal(f.master('companies').state.rows.length, 1);
  assert.equal(f.properties.has('SEGMENT_RECORD_ACTIVE_' + SEGMENT), false);
});

test('renaming a source leaf after preview invalidates a plan even if all cells stay identical', () => {
  const f = fixture(), shown = f.preview(); f.sourceSheet.setName('ЛПР — исходные'); f.resources.get(SOURCE).version++;
  assert.throws(() => f.start(shown), /SEGMENT_PREVIEW_CHANGED/);
  assert.equal(f.master('companies').state.rows.length, 1);
});

test('source readiness is rechecked between job steps', () => {
  const f = fixture(), state = f.start(f.preview()); f.status.value = 'rework';
  assert.throws(() => f.next(state), /SEGMENT_PREVIEW_CHANGED/);
  assert.equal(f.master('lpr').state.rows.length, 1);
});

test('legacy worksheets and manually added columns remain intact', () => {
  const f = fixture({ legacy: true }), original = plain(f.companyBook.sheets[0].state.rows);
  f.preview(); const master = f.master('companies'); master.state.rows[0].push('Ручная заметка');
  f.finish(f.start(f.preview()));
  assert.deepEqual(f.companyBook.sheets[0].state.rows, original);
  const noteColumn = master.state.rows[0].indexOf('Ручная заметка'); master.state.rows[1][noteColumn] = 'Не менять';
  f.sourceSheet.state.rows[1][2] += '; new@example.test'; f.resources.get(SOURCE).version++;
  f.finish(f.start(f.preview(), 'segment-normalize-request-002'));
  assert.equal(master.state.rows[1][noteColumn], 'Не менять');
});

test('manual company edits transfer a new contactless person automatically and do not self-invalidate', () => {
  const f = fixture(); f.finish(f.start(f.preview()));
  const companySheet = f.master('companies'), headers = f.context.SEGMENT_RECORDS_SCHEMA.company, index = key => headers.findIndex(field => field[0] === key);
  companySheet.setName('ЛПР — пользовательское название');
  companySheet.state.rows[1][index('personName')] = 'Анна Иванова'; companySheet.state.rows[1][index('personRole')] = 'Маркетолог'; companySheet.state.rows[1][index('personEmails')] = ''; companySheet.state.rows[1][index('personPhones')] = '';
  f.resources.get(COMPANIES).version++;
  const result = f.finish(f.context.syncSegmentPeople_({ companyFileId: COMPANIES, requestId: 'manual-people-sync-001' }));
  assert.equal(result.counts.peopleAdded, 1); assert.equal(f.master('lpr').state.rows.length, 3);
  assert.equal(f.master('lpr').state.rows[2][3], 'Анна Иванова'); assert.equal(f.master('lpr').state.rows[2][9], 'Найти контакты');
});

test('manual cell changes during import are not overwritten and another user column is not confused with a new company row', () => {
  const f = fixture(), shown = f.preview(), master = f.master('companies'); master.state.rows[0].push('Заметка'); master.state.rows.push(Array(17).fill('').concat(['Новое ручное содержимое']));
  assert.throws(() => f.start(shown), /SEGMENT_PREVIEW_CHANGED/);
  assert.equal(master.state.rows[1][17], 'Новое ручное содержимое');
  assert.equal(master.state.rows[1][0], '');
});

test('v2 original sheet named Email is read while only explicit managed target IDs are excluded', () => {
  const f = fixture(); f.sourceSheet.setName('Email'); sheetExtra();
  function sheetExtra() { const email = f.sourceBook.insertSheet('Email — contacts'); email.state.rows = [['Email'], ['output@example.test']]; f.resources.get(SOURCE).appProperties = { registryPreparedVersion: '2', registryPreparedOriginalSheetId: '11', registryContactEmailSheetId: String(email.getSheetId()), registryContactPhoneSheetId: '999' }; }
  const shown = f.preview(); assert.equal(shown.counts.companiesAdded, 1); assert.equal(shown.counts.peopleAdded, 1);
  assert.throws(() => f.context.previewSegmentRecords_({ segmentId: SEGMENT, loads: [{ sourceId: SOURCE, sheets: [{ sheetId: f.sourceBook.sheets[1].getSheetId() }] }] }), /INVALID_SHEET_TARGET/);
});

test('private plan substitution and destination moves fail closed', () => {
  const f = fixture(), shown = f.preview(), planFile = f.resources.get(f.calls.created[0]); planFile.parent = ROOT;
  assert.throws(() => f.start(shown), /OUTSIDE_REGISTRY/);
  const g = fixture(), preview = g.preview(); g.resources.get(PEOPLE).parent = ROOT;
  assert.throws(() => g.start(preview), /OUTSIDE_SEGMENTS/);
  assert.equal(g.calls.raw.filter(call => call.firstRow > 1).length, 0);
});

test('old-client loads are normalized only after READY preflight, without raw sheet copying', () => {
  const f = fixture({ status: 'collection' });
  assert.throws(() => f.context.segmentNormalizedMutation_('create', { name: 'Новый', requestId: 'create-segment-001', loads: [{ sourceId: SOURCE }] }), /SOURCE_NOT_READY/);
  assert.equal(f.calls.segmentMutations.length, 0);
});

test('a legacy loads-only segment update keeps its existing name when stripping raw loads', () => {
  const f = fixture();
  const result = f.context.segmentNormalizedMutation_('update', { id: SEGMENT, requestId: 'legacy-segment-load-only-001', loads: [{ sourceId: SOURCE }] });
  assert.equal(f.calls.segmentMutations[0].input.name, 'Кухни');
  assert.deepEqual(f.calls.segmentMutations[0].input.loads, []);
  f.finish(result.normalizedImport);
  assert.equal(f.master('companies').state.rows.length, 2);
});

test('a normalized category-only update does not initialize target workbooks', () => {
  const f = fixture();
  f.context.segmentRecordsTargets_ = () => assert.fail('Category-only updates must not initialize target workbooks');
  f.context.segmentNormalizedMutation_('update', { id: SEGMENT, category: 'partners', expectedCategory: 'clients', requestId: 'category-update-001' });
  assert.equal(f.calls.segmentMutations[0].input.category, 'partners');
  assert.equal(f.calls.segmentMutations[0].input.expectedCategory, 'clients');
  assert.equal(f.calls.segmentMutations[0].input.name, undefined);
});

test('per-sheet person target and header choice are retained through preview and import', () => {
  const f = fixture({ rows: [['Name', 'Email', 'Phone'], ['Иван Иванов', 'ivan@example.test', '+79990000001']] });
  const shown = f.context.previewSegmentRecords_({ segmentId: SEGMENT, loads: [{ sourceId: SOURCE, sheets: [{ sheetId: 11, target: 'lpr', hasHeader: true }] }] });
  assert.equal(shown.counts.peopleAdded, 1);
  f.finish(f.start(shown));
  assert.equal(f.master('lpr').state.rows[1][3], 'Иван Иванов');
  assert.equal(f.master('lpr').state.rows[1][5], 'ivan@example.test');
  assert.equal(f.sourceSheet.state.rows[0][3], 'Перенос в ЛПР');
  const g = fixture({ rows: [['only@example.test', '+79990000001'], ['next@example.test', '+79990000002']] });
  const noHeader = g.context.previewSegmentRecords_({ segmentId: SEGMENT, loads: [{ sourceId: SOURCE, sheets: [{ sheetId: 11, target: 'companies', hasHeader: false }] }] });
  assert.equal(noHeader.counts.companiesAdded, 2, 'first physical data row is never consumed as a header');
  g.finish(g.start(noHeader));
  assert.match(g.master('companies').state.rows.map(row => row[6]).join(';'), /only@example\.test/);
});

test('strong LPR leaf names classify generic contacts personally while an explicit companies target wins', () => {
  const f = fixture(), lpr = f.sourceBook.insertSheet('ЛПР — исходные');
  lpr.state.rows = [['Компания', 'ФИО', 'Email', 'Phone'], ['ООО Пример', 'Анна Петрова', 'anna@example.test', '+79990000002']];
  const shown = f.preview();
  assert.equal(shown.counts.peopleAdded, 2); assert.equal(shown.counts.peopleWithoutContacts, 1);
  f.finish(f.start(shown));
  const anna = f.master('lpr').state.rows.find(row => row[3] === 'Анна Петрова');
  assert.equal(anna[5], 'anna@example.test'); assert.equal(anna[6], '+79990000002');
  const g = fixture(), explicit = g.sourceBook.insertSheet('ЛПР — исходные'); explicit.state.rows = structuredClone(lpr.state.rows);
  const overridden = g.context.previewSegmentRecords_({ segmentId: SEGMENT, loads: [{ sourceId: SOURCE, sheets: [{ sheetId: explicit.getSheetId(), target: 'companies', hasHeader: true }] }] });
  assert.equal(overridden.counts.peopleWithoutContacts, 1, 'explicit company allocation keeps generic mail on the company');
  g.finish(g.start(overridden));
  assert.match(g.master('companies').state.rows[1][6], /anna@example\.test/);
  assert.equal(g.master('lpr').state.rows[1][5], '');
});

test('a moved marker column is resolved by its current header instead of a stale numeric pointer', () => {
  const f = fixture(); f.finish(f.start(f.preview()));
  f.sourceSheet.state.rows.forEach(row => { row.splice(1, 0, row.splice(6, 1)[0]); });
  f.sourceSheet.state.rows[1][6] = '+79990000002'; f.resources.get(SOURCE).version++;
  assert.equal(f.resources.get(SOURCE).appProperties.registryLprMarker_11, '7', 'old positional hint is stale');
  f.finish(f.start(f.preview(), 'segment-normalize-request-002'));
  assert.equal(f.sourceSheet.state.rows[1][6], '+79990000002', 'the user phone cell is untouched');
  assert.match(f.sourceSheet.state.rows[1][1], /Перенесено в ЛПР/);
  assert.equal(f.resources.get(SOURCE).appProperties.registryLprMarker_11, '2');
  assert.equal(f.master('lpr').state.rows[1][6], '+79990000002');
});

test('a headerless transfer marker follows bound column metadata after column insertion', () => {
  const f = fixture({ rows: [['Иван Иванов', 'ivan@example.test', '+79990000001']] });
  const preview = () => f.context.previewSegmentRecords_({ segmentId: SEGMENT, loads: [{ sourceId: SOURCE, sheets: [{ sheetId: 11, target: 'lpr', hasHeader: false }] }] });
  const shown = preview(); assert.equal(shown.counts.peopleAdded, 1); f.finish(f.start(shown));
  const before = f.sourceSheet.state.rows[0].slice(0, 3);
  assert.deepEqual(before, ['Иван Иванов', 'ivan@example.test', '+79990000001']);
  assert.equal(f.sourceSheet.state.developerMetadata.length, 1);
  f.sourceSheet.state.rows.forEach(row => row.unshift('Сохранить'));
  f.sourceSheet.state.developerMetadata.forEach(entry => entry.column++); f.resources.get(SOURCE).version++;
  f.finish(f.start(preview(), 'segment-normalize-request-002'));
  assert.equal(f.sourceSheet.state.rows[0][3], '+79990000001');
  assert.match(f.sourceSheet.state.rows[0][4], /Перенесено в ЛПР/);
  assert.equal(f.sourceSheet.state.developerMetadata.length, 1, 'one bound marker is reused');
  assert.equal(f.master('lpr').state.rows.length, 2, 'marker text and its link must not create an extra person');
});

test('duplicate marker headers fail safely before writing into either ambiguous source column', () => {
  const f = fixture(); f.sourceSheet.state.rows[0].push('Перенос в ЛПР', 'Перенос в ЛПР');
  assert.throws(f.preview, /SOURCE_MARKER_AMBIGUOUS/);
  assert.equal(f.calls.raw.filter(call => call.id === SOURCE).length, 0);
});

test('abandoned preview receipts stay bounded while an active job keeps its protected plan', () => {
  const f = fixture(), shown = f.preview(), state = f.start(shown), firstPlan = f.resources.get(f.calls.created[0]);
  const plan = JSON.parse(firstPlan.content);
  for (let i = 0; i < 140; i++) f.context.segmentRecordsSavePlan_(f.config, { ...plan, createdAt: 'unique-preview-' + i });
  assert.equal(JSON.parse(f.properties.get('SEGMENT_RECORD_PREVIEW_INDEX')).length, 128);
  assert.equal([...f.properties.keys()].filter(key => key.startsWith('SEGMENT_RECORD_PREVIEW_') && key !== 'SEGMENT_RECORD_PREVIEW_INDEX').length, 128);
  assert.equal(firstPlan.trashed, false, 'a resumable job cannot lose its active plan');
  assert.ok(f.calls.created.some(id => f.resources.get(id).trashed), 'only expired own JSON plan files are trashed');
  assert.equal(f.resources.get(SOURCE).trashed, false);
  f.finish(state);
});
