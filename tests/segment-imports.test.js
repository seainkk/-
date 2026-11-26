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
  const registered = new Set([SOURCE]);
  function addSource(id, rows) { registered.add(id); resource(id, 'Ещё одна база'); return sheet(book(id), 'Исходная база', rows); }
  if (options.legacy) sheet(companyBook, 'Не трогать', [['Доход', 'Особые заметки'], ['100', 'Оставить в исходном виде']], 12); else sheet(companyBook, 'Лист1', [], 12);
  sheet(peopleBook, 'Лист1', [], 13);
  const status = { value: options.status || 'ready', revision: 1 }, tracking = { tables: [{ segmentId: SEGMENT, kind: 'companies', fileId: COMPANIES }, { segmentId: SEGMENT, kind: 'lpr', fileId: PEOPLE }] };
  const context = vm.createContext({ console: { warn() {} } });
  for (const name of ['Config.gs', 'Segments.gs', 'SegmentActions.gs','ContactSync.gs']) vm.runInContext(readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'), context, { filename: name });
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
  context.requireReadySourceBase_ = (_scope, _storage, _db, id, revision) => { if (!registered.has(id)) context.fail_('OUTSIDE_REGISTRY', 'Outside source folder'); if (status.value !== 'ready') context.fail_('SOURCE_NOT_READY', 'Not ready'); if (revision !== undefined && revision !== status.revision) context.fail_('CONFLICT', 'Stale revision'); return { record: { revision: status.revision }, contents: ['companies', 'lpr'] }; };
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
  context.contactSyncSegmentImportStep_ = () => true;
  context.contactSyncInstallWorkingHistory_ = (_file,_kind,_segment,_history,_settle,origins) => { (calls.origins ||= []).push(plain(origins || {})); return true; };
  vm.runInContext(readFileSync(new URL('../src/Config.gs', import.meta.url), 'utf8'), context, { filename: 'Config.gs' });
  context.REGISTRY_CONFIG = { defaultSourceBasesStorageId: STORE };
  context.Utilities = { getUuid: () => 'lease-' + ++sequence, newBlob: value => ({ value }) };
  context.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  context.SpreadsheetApp = { openById: id => { if (!books.has(id)) throw new Error('Missing book'); return books.get(id); }, flush() {} };
  context.Sheets = { Spreadsheets:{ batchUpdate(body,id) {
    const tab=body.requests[0].addSheet.properties;
    const book=books.get(id);
    if (book.getSheets().some(s=>s.getSheetId()===tab.sheetId || s.getName()===tab.title)) throw Error('Duplicate tab');
    sheet(book,tab.title,[],tab.sheetId);
    if (options.loseMasterCreation) { options.loseMasterCreation=false; throw Error('Lost addSheet response'); }
  } } };
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
  for (const name of ['ContactPreview.gs', 'SourceRecords.gs', 'PreparedData.gs', 'LegacyContactHistory.gs', 'SegmentRecords.gs', 'SegmentImports.gs','SegmentContactCard.gs','SegmentLegacyPreview.gs']) vm.runInContext(readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'), context, { filename: name });
  const preview = () => context.previewSegmentRecords_({ segmentId: SEGMENT, sourceIds: [SOURCE] });
  const start = (shown, requestId = 'segment-normalize-request-001') => context.importSegmentRecords_({ segmentId: SEGMENT, planToken: shown.planToken, requestId });
  const next = state => context.continueSegmentRecords_({ segmentId: SEGMENT, jobId: state.jobId, requestId: state.requestId });
  const finish = initial => { let result = initial; for (let i = 0; i < 100 && result.state === 'processing'; i++) result = next(result); assert.equal(result.state, 'complete'); return result; };
  const master = (kind, create = false) => context.segmentRecordsMaster_({ context: config, folder: resources.get(SEGMENT), tables: { companies: COMPANIES, lpr: PEOPLE } }, kind, create).sheet;
  return { context, calls, resources, books, properties, sourceBook, sourceSheet, companyBook, peopleBook, status, preview, start, next, finish, master, config, addSource };
}

test('a foreign project cannot reserve a segment job or acquire its lease through a previous plan or job ID', () => {
  const f = fixture(), preview = f.preview();
  const plan = f.context.segmentRecordsLoadPreview_(f.config, preview.planToken, SEGMENT);
  let allow = false;
  f.context.registryRequireSegment_ = (_scope, id) => {
    assert.equal(id, SEGMENT);
    if (!allow) f.context.fail_('OUTSIDE_PROJECT', 'Другой проект');
  };
  const before = [...f.properties];
  assert.throws(() => f.start(preview), /OUTSIDE_PROJECT/);
  assert.throws(() => f.context.segmentRecordsAllocateJob_(f.config, plan, preview.planToken, 'different-scope-job'), /OUTSIDE_PROJECT/);
  assert.deepEqual([...f.properties], before);
  allow = true;
  const job = f.start(preview);
  allow = false;
  const active = [...f.properties];
  assert.throws(() => f.next(job), /OUTSIDE_PROJECT/);
  assert.throws(() => f.context.segmentRecordsRunJob_(job.jobId, job.requestId), /OUTSIDE_PROJECT/);
  assert.deepEqual([...f.properties], active);
});

test('automatic mixed import writes only company-leaf companies and person-leaf people, links them in reverse tab order and resumes once', () => {
  const f = fixture({ rows:[
    ['Название (компания)','ИНН','Имя','Отчество','Фамилия','Должность','Основной телефон','Доп. тел. (не проверяли на тг)','Почта основная','Почта основная рез. валидации','Доп. почта','Доп. почта рез. валидации'],
    ['Компания Пример','7707083893','Анна','Петровна','Иванова','Директор','+79991110002','+79991110003','anna@example.test','valid','other@example.test','invalid']
  ]});
  f.sourceSheet.setName('ЛПР');
  const companies = f.sourceBook.insertSheet('Компании');
  companies.state.rows.push(['Название','ИНН','Имя','Отчество','Фамилия','Должность','Рабочий телефон (компания)','Рабочий email'],
    ['Компания Пример','7707083893','Игнат','Львович','Петров','Менеджер','+79991110001','org@example.test']);
  f.sourceBook.insertSheet('Сводка').state.rows.push(['Компания', 'Email'], ['Другая', 'never@example.test']);
  const selected = () => f.context.previewSegmentRecords_({segmentId:SEGMENT, sourceIds:[SOURCE], targetKind:'auto'});
  const show = selected();
  assert.equal(show.targetKind,'auto'); assert.equal(show.counts.companiesAdded,1); assert.equal(show.counts.peopleAdded,1);
  const counts = []; f.context.contactSyncSegmentImportStep_ = (_file, kind) => { counts.push(kind); return true; };
  const result = f.finish(f.start(show));
  assert.deepEqual(counts,['companies','lpr']); assert.equal(result.targetKind,'auto');
  assert.equal(f.calls.relations.length,1); assert.equal(f.sourceSheet.state.rows[0].includes('Перенос в ЛПР'),false);
  const [companyHead,company]=f.master('companies').state.rows, [personHead,person]=f.master('lpr').state.rows;
  assert.equal(company[companyHead.indexOf('Email')],'org@example.test');
  assert.equal(person[personHead.indexOf('ФИО')],'Иванова Анна Петровна');
  assert.deepEqual(person[personHead.indexOf('Email')].split('; ').sort(),['anna@example.test','other@example.test']);
  assert.deepEqual(person[personHead.indexOf('Телефон')].split('; ').sort(),['+79991110002','+79991110003']);
  assert.equal(person[personHead.indexOf('ID компании')],company[companyHead.indexOf('ID компании')]);
  assert.equal(f.finish(f.start(show)).state,'complete');
  const repeat=selected(); assert.equal(repeat.counts.peopleAdded,0); assert.equal(repeat.counts.companiesAdded,0);
});

test('re-importing the same raw LPR sheet fills accepted primary phone history with no master additions or paid checks', () => {
  const f = fixture({rows:[
    ['ИНН','Название (компания)','ФИО','Основной телефон','Есть ТГ','ТГ Ник','ТГ ID ','Active_days_ago','В рассылке НСА','Доп. тел. (не проверяли на тг)','Почта основная'],
    ['7707083893','Компания Пример','Анна Иванова','+79991110001',1,'sample_user','123456789',3,'да','+79991110002','person@example.test'],
    ['7707083893','Компания Пример','Антон Петров','+79991110003',0,'','','','','',''],
    ['7707083893','Компания Пример','Ирина Котова','нет данных',0,'','','','','',''],
    ['7707083893','Компания Пример','Иван Орлов','+79991110004',1,'','','','добавление в контакты','',''],
    ['7707083893','Компания Пример','Ольга Емельянова','+79991110005',1,'','','','Отправлено','','']
  ]});
  f.sourceSheet.setName('ЛПР');
  f.sourceBook.insertSheet('Компании').state.rows.push(['ИНН','Название'],['7707083893','Компания Пример']);
  const ready=f.context.segmentRecordsReadySources_;
  const preview=()=>f.context.previewSegmentRecords_({segmentId:SEGMENT, sourceIds:[SOURCE], targetKind:'auto'});
  f.context.segmentRecordsReadySources_=(...args)=>ready(...args).map(binding=>{delete binding.mainTelegramHistory;return binding;});
  const old=preview(); assert.equal(old.counts.peopleAdded,5);
  const oldPlan=f.context.segmentRecordsLoadPreview_(f.config,old.planToken,SEGMENT);
  assert.equal(oldPlan.workingHistory,undefined);
  f.finish(f.start(old,'previous-import-00001'));
  f.context.segmentRecordsReadySources_=ready;
  let installed;
  f.context.contactSyncInstallWorkingHistory_=(_file,kind,_segment,rows)=>{ if(kind==='lpr') installed=plain(rows); return true; };
  f.context.queueWorkbookValidation_=()=>assert.fail('The segment import must never queue a paid validation');
  const updated=preview(); assert.equal(updated.counts.peopleAdded,0); assert.equal(updated.counts.companiesAdded,0);
  const plan=f.context.segmentRecordsLoadPreview_(f.config,updated.planToken,SEGMENT);
  assert.deepEqual(Object.keys(plan.workingHistory.lpr).sort(),['phone:79991110001','phone:79991110003','phone:79991110004','phone:79991110005']);
  assert.equal(plan.workingHistory.companies,undefined);
  const evidence=plan.workingHistory.lpr['phone:79991110001'][0];
  assert.equal(evidence.source,SOURCE); assert.equal(evidence.sheet,f.sourceSheet.getSheetId()); assert.equal(evidence.refs,'2');
  assert.equal(evidence.fields['Валидация'],'Telegram: активен'); assert.equal(evidence.fields['Статус'],'в рассылке');
  assert.equal(evidence.fields['Nickname_TG'],'sample_user'); assert.equal(evidence.fields['ID_TG'],'123456789'); assert.equal(evidence.fields['Active_days_ago'],'3');
  assert.equal(plan.workingHistory.lpr['phone:79991110003'][0].fields['Валидация'],'Telegram не найден');
  [['phone:79991110004','добавление в контакты'],['phone:79991110005','Отправлено']].forEach(([key,note])=>{
    const materialized=f.context.contactSyncWorkingFields_(plan.workingHistory.lpr[key]);
    assert.equal(materialized['Статус из источника'],note);
    assert.equal(materialized['Статус рассылки'],'Новый контакт');
    assert.equal(materialized['Валидация'],'Telegram найден');
    assert.ok(materialized['История контакта'].includes(note));
  });
  assert.equal(f.finish(f.start(updated,'phone-history-retry-00001')).state,'complete');
  assert.deepEqual(installed,plain(plan.workingHistory.lpr)); assert.equal(f.master('lpr').state.rows.length,6);
});

test('a mixed selection honours the registered type of a separate single-sheet source with ambiguous headers', () => {
  const f = fixture({rows: [['Компания', 'ИНН'], ['Пример', '7707083893']]});
  f.sourceSheet.setName('Компании');
  const second = 'registered_people_example_12345';
  f.addSource(second, [['Компания', 'ИНН', 'ФИО', 'Email'], ['Пример', '7707083893', 'Анна Петрова', 'anna@example.test']]);
  const requireSource = f.context.requireReadySourceBase_;
  f.context.requireReadySourceBase_ = (...args) => {
    const item = requireSource(...args);
    if (args[3] === second) item.contents = ['lpr'];
    return item;
  };
  assert.equal(f.context.preparedAutoRoute_(f.books.get(second).getSheets()[0], {}), '');
  const plan = f.context.previewSegmentRecords_({segmentId: SEGMENT, sourceIds: [SOURCE, second], targetKind: 'auto'});
  assert.equal(plan.counts.companiesAdded, 1);
  assert.equal(plan.counts.peopleAdded, 1);
  assert.equal(plan.sample.people[0][plan.headers.people.indexOf('ФИО')], 'Анна Петрова');
});

test('dashboard recovery exposes only the live receipt belonging to this registry and actual segment', () => {
  const f = fixture();
  const processing = f.start(f.preview());
  vm.runInContext(readFileSync(new URL('../src/Segments.gs', import.meta.url), 'utf8'), f.context);
  const snapshot = Object.fromEntries(f.properties), pointer = 'SEGMENT_RECORD_ACTIVE_' + SEGMENT;
  const project = (properties, root = ROOT) => plain(f.context.segmentDashboardPendingImport_({rootId: root}, SEGMENT, properties));
  assert.deepEqual(project(snapshot), {jobId: processing.jobId, requestId: processing.requestId});
  assert.equal(project(snapshot, 'another_root_123456789'), null);
  const other = {...snapshot};
  const key = 'SEGMENT_RECORD_JOB_' + snapshot[pointer], job = JSON.parse(other[key]);
  for (const fields of [{segmentId:'another_segment_123456789'}, {requestId:'another_receipt_123456789'}, {expiresAt:'2001-01-01'}, {state:'complete'}]) {
    other[key] = JSON.stringify({...job, ...fields}); assert.equal(project(other), null);
  }
  delete other[pointer]; assert.equal(project(other), null);
});

test('a confirmed strict target survives a lost reply and never edits the other table or source rows', () => {
  const rows = [['Компания', 'ИНН', 'Email', 'ФИО ЛПР', 'Должность ЛПР', 'Телефон ЛПР'], ['Компания Москва', '7707083893', 'sales@example.test', 'Иван Иванов', 'Директор', '+79990000001']];
  const f = fixture({ rows, writeFailure: { id: PEOPLE } });
  const show = targetKind => f.context.previewSegmentRecords_({ segmentId: SEGMENT, sourceIds: [SOURCE], targetKind });
  assert.throws(() => show('mixed'), /INVALID_REQUEST/);
  assert.equal(f.calls.created.length, 0);
  const companies = show('companies');
  assert.equal(companies.counts.companiesAdded, 1); assert.equal(companies.counts.peopleAdded, 0);
  assert.deepEqual(plain(companies.sample.people), []);
  assert.equal(f.finish(f.start(companies)).targetKind, 'companies');
  assert.deepEqual(f.master('companies').state.rows[1].filter(value => value === 'Иван Иванов' || value === '+79990000001'), []);
  assert.equal(f.master('lpr').state.rows.length, 1);
  assert.ok(f.calls.enrollments.every(entry => entry.fileId === COMPANIES));
  const before = plain(f.master('companies').state.rows), people = show('lpr');
  assert.equal(people.counts.companiesAdded + people.counts.companiesUpdated, 0); assert.equal(people.counts.peopleAdded, 1);
  const sample = people.sample.people[0];
  assert.ok(sample.includes(before[1][0])); assert.ok(sample.includes('+79990000001')); assert.ok(!sample.includes('sales@example.test'));
  assert.throws(() => f.start(people, 'strict-people-request-01'), /SHEETS_RAW_UNCERTAIN/);
  const done = f.finish(f.start(people, 'strict-people-request-01'));
  assert.equal(done.targetKind, 'lpr'); assert.equal(f.master('lpr').state.rows.length, 2);
  assert.deepEqual(f.master('companies').state.rows, before);
  assert.deepEqual(f.sourceSheet.state.rows, rows); assert.equal(f.calls.segmentMutations.length, 0);
  assert.equal(f.calls.relations.length, 1);
  assert.throws(() => f.context.importSegmentRecords_({ segmentId: SEGMENT, planToken: people.planToken, requestId: 'strict-people-request-01', targetKind: 'companies' }), /INVALID_REQUEST/);
});

test('a shared address retains only company or LPR source columns accepted by each target', () => {
  const shared = 'shared@example.test', key = 'email:' + shared;
  const f = fixture({rows: [
    ['ИНН', 'Названия', 'Email-адреса', 'ФИО ЛПР', 'Email ЛПР', 'Корпоративный email'],
    ['7707083893', 'Альфа', shared, 'Анна Иванова', shared, ''],
    ['7710140679', 'Бета', '', 'Борис Петров', '', shared]
  ]});
  f.resources.get(SOURCE).name = 'База для теста';
  const shown = f.preview(), plan = f.context.segmentRecordsLoadPreview_(f.config, shown.planToken, SEGMENT);
  const prefix = 'База для теста / Исходная база · ';
  assert.deepEqual(plain(plan.emailOrigins), {
    companies: {[key]: prefix + 'C — Email-адреса\n' + prefix + 'F — Корпоративный email'},
    lpr: {[key]: prefix + 'E — Email ЛПР'}
  });
  assert.equal(f.finish(f.start(shown)).state, 'complete');
  assert.deepEqual(f.calls.origins.map(group => group[key]).sort(),
    [plan.emailOrigins.lpr[key], plan.emailOrigins.companies[key]].sort());
});

test('reimporting a raw segment source after a phone-list parse error fills its existing company once', () => {
  const rows = [['Названия', 'ИНН', 'Рабочий телефон (компания)'], ['Фабрика', '7707083893', '#ERROR!']];
  const f = fixture({rows});
  const show = () => f.context.previewSegmentRecords_({segmentId:SEGMENT, sourceIds:[SOURCE], targetKind:'companies'});
  f.finish(f.start(show(), 'first_segment_without_phone'));
  f.sourceSheet.state.formulas['2:3'] = '=+7 (999) 123-45-67, 312-22-11, 12-34-56-78-90-12-34';
  const update = show();
  assert.equal(update.counts.companiesAdded, 0); assert.equal(update.counts.peopleAdded, 0);
  assert.equal(update.counts.companiesUpdated, 1);
  f.finish(f.start(update, 'repair_segment_company_phone'));
  const [header, row] = f.master('companies').state.rows, phones = row[header.indexOf('Телефон')];
  assert.match(phones, /\+79991234567/); assert.match(phones, /3122211/); assert.doesNotMatch(phones, /12345678901234/);
  const repeat = show();
  assert.equal(repeat.counts.companiesAdded + repeat.counts.companiesUpdated, 0);
  assert.equal(f.sourceSheet.state.rows[1][2], '#ERROR!'); assert.match(f.sourceSheet.state.formulas['2:3'], /^=\+/);
});

test('a segment import waits for contact receipts and reuses the same per-book request after a lost reply', () => {
  for (const targetKind of ['companies', 'lpr', undefined]) {
    const f = fixture(), steps = [], pending = new Map(), receipts = new Set();
    const kinds = targetKind ? [targetKind] : ['companies', 'lpr'];
    const shown = f.context.previewSegmentRecords_({ segmentId: SEGMENT, sourceIds: [SOURCE], ...(targetKind && { targetKind }) });
    f.context.contactSyncSegmentImportStep_ = (fileId, kind, segmentId, requestId) => {
      assert.equal(segmentId, SEGMENT); assert.equal(fileId, kind === 'companies' ? COMPANIES : PEOPLE);
      assert.equal(f.calls.relations.length, 0);
      steps.push([kind, requestId]);
      if (receipts.has(requestId)) return true;
      if (!pending.has(requestId)) { pending.set(requestId, kind); return false; }
      receipts.add(requestId);
      throw Error('Contact receipt acknowledgement lost');
    };
    let state = f.start(shown);
    for (let tries = 0; state.state === 'processing' && tries < 45; tries++) {
      try { state = f.next(state); } catch (error) { assert.match(error.message, /Contact receipt acknowledgement lost/); state = f.start(shown); }
    }
    assert.equal(state.state, 'complete'); assert.equal(f.calls.relations.length, 1);
    assert.deepEqual([...new Set(steps.map(entry => entry[0]))], kinds);
    assert.deepEqual([...pending.values()], kinds); assert.equal(receipts.size, kinds.length);
    const count = steps.length;
    assert.equal(f.start(shown).state, 'complete'); assert.equal(steps.length, count);
  }
});

test('an outstanding plan from the previous release finishes using its original phases', () => {
  const f = fixture(), shown = f.preview(), plan = f.context.segmentRecordsLoadPreview_(f.config, shown.planToken, SEGMENT);
  delete plan.materializeContacts;
  const legacy = f.context.segmentRecordsSavePlan_(f.config, plan);
  f.context.contactSyncSegmentImportStep_ = () => assert.fail('a legacy plan cannot acquire a new contact request');
  assert.equal(f.finish(f.start({ planToken: legacy.token })).state, 'complete');
});

test('strict people keep a named person without contacts or a company link and recheck referenced IDs', () => {
  const f = fixture(), show = targetKind => f.context.previewSegmentRecords_({ segmentId: SEGMENT, sourceIds: [SOURCE], targetKind });
  let people = show('lpr'); assert.equal(people.counts.peopleWithoutContacts, 1);
  assert.equal(people.sample.people[0][1], ''); assert.equal(people.sample.people[0][2], 'ООО Пример');
  f.finish(f.start(people)); assert.equal(f.master('companies').state.rows.length, 1);
  f.finish(f.start(show('companies'), 'strict-company-request-02'));
  people = show('lpr');
  assert.ok(people.sample.people[0][1].startsWith('C-'));
  f.master('companies').state.rows.splice(1);
  assert.throws(() => f.start(people, 'strict-people-request-03'), /SEGMENT_PREVIEW_CHANGED/);
  assert.equal(f.master('lpr').state.rows[1][1], '');
});

test('strict destination interprets an unlabelled Name and Email while explicit source sheet meaning wins', () => {
  const f = fixture({ rows: [['Name','Email'],['Example Name','hello@example.test']] });
  const show = targetKind => f.context.previewSegmentRecords_({ segmentId: SEGMENT, sourceIds: [SOURCE], targetKind });
  let shown = show('lpr'); assert.equal(shown.counts.peopleAdded, 1); assert.ok(shown.sample.people[0].includes('hello@example.test'));
  shown = show('companies'); assert.equal(shown.counts.companiesAdded, 1); assert.ok(shown.sample.companies[0].includes('hello@example.test'));
  f.sourceSheet.setName('Компании'); shown = show('lpr'); assert.equal(shown.counts.peopleAdded, 0);
  f.sourceSheet.setName('ЛПР'); shown = show('companies'); assert.equal(shown.counts.companiesAdded, 0);
});

test('preview rejects unready files before creating masters or plans', () => {
  const f = fixture({ status: 'collection' });
  assert.throws(f.preview, /SOURCE_NOT_READY/);
  assert.equal(f.calls.raw.length, 0); assert.equal(f.calls.created.length, 0);
});

const directoryHeaders = ['Названия', 'Категории', 'Регионы, области', 'Населенные пункты', 'Полные адреса', 'Мобильные телефоны', 'Городские телефоны', 'Email-адреса', 'Telegram', 'WhatsApp', 'Вконтакте', 'Одноклассники', 'Сайты', 'Max', 'Филиалов', 'Индексы', 'Дата парсинга'];
const directoryRow = ['Тестовый каталог', 'Мебель', 'Ленинградская область', 'Санкт-Петербург', 'Тестовая ул., 2', '+7 (999) 100-02-01', '+7 (812) 100-02-01', 'shop@example.test', 'https://t.me/test_catalog', 'https://wa.me/79991000201', 'https://vk.com/test_catalog', 'https://ok.ru/test_catalog', 'https://shop.example.test', 'https://max.ru/test_catalog', '2', '019001', '01.11.2026'];

test('all 17 directory values survive two independent uploads into one company and retain their original headings', () => {
  const f = fixture({ rows: [directoryHeaders, directoryRow] });
  function prepareIds(sheet, sourceId) {
    const model = f.context.preparedDataRead_(sheet, sourceId, 'companies', {});
    const working = f.context.preparedWorkingLists_({ ...model, models: [model], sourceSheets: [model.source] }, sourceId);
    const ids = working.sourceIds.get(sheet.getSheetId());
    sheet.state.rows.forEach((row, index) => row.push(ids[index]));
    return ids[1];
  }
  const firstId = prepareIds(f.sourceSheet, 'original_company_directory_001');
  f.context.segmentNormalizedMutation_('create', { name: 'Тестовый каталог', requestId: 'directory-create-001', loads: [] });
  const typed = id => f.context.previewSegmentRecords_({ segmentId: SEGMENT, sourceIds: [id], targetKind: 'companies' });
  const first = typed(SOURCE); assert.equal(first.sample.companies[0].length, first.headers.companies.length);
  f.finish(f.start(first, 'directory-batch-001'));
  const sheet = f.master('companies'), headers = sheet.state.rows[0], firstRow = sheet.state.rows[1];
  assert.deepEqual(headers.slice(0,18), ['ID компании', ...directoryHeaders]);
  assert.deepEqual(firstRow.slice(1,18), directoryRow);
  const secondId = 'independent_selection_file_0002', nextRow = [...directoryRow];
  nextRow[1] = 'Кухни'; nextRow[4] = 'Тестовая ул., 5'; nextRow[7] = 'office@example.test';
  const secondSheet = f.addSource(secondId, [directoryHeaders,nextRow]);
  assert.equal(prepareIds(secondSheet, 'another_independent_origin_002'), firstId);
  const shown = typed(secondId); assert.equal(shown.counts.companiesAdded, 0); assert.equal(shown.counts.companiesUpdated, 1);
  f.finish(f.start(shown, 'directory-batch-002'));
  assert.equal(sheet.state.rows.length, 2);
  assert.equal(sheet.state.rows[1][0], firstRow[0]);
  assert.equal(sheet.state.rows[1][headers.indexOf('Категории')], 'Мебель\nКухни');
  assert.equal(sheet.state.rows[1][headers.indexOf('Полные адреса')], 'Тестовая ул., 2\nТестовая ул., 5');
  assert.equal(sheet.state.rows[1][headers.indexOf('Индексы')], '019001');
  assert.equal(typed(secondId).counts.companiesUpdated, 0);
  assert.equal(f.master('lpr').state.rows.length, 1);
  secondSheet.state.rows[1][directoryHeaders.length] = 'C-independent_explicit_manual_id';
  const conflict = typed(secondId);
  assert.equal(conflict.counts.companiesAdded, 0); assert.equal(conflict.counts.companiesUpdated, 0);
  assert.ok(conflict.review.some(item => item.reason.includes('разные ID')));
});

test('an established working sheet appends directory columns beyond user data and preserves earlier previews and formulas', () => {
  const f = fixture(), sheet = f.master('companies', true), old = f.preview();
  const oldHeaders = [...sheet.state.rows[0], 'Заметка пользователя', 'Категории'];
  sheet.state.rows[0] = [...oldHeaders];
  const secondId = 'independent_directory_0003';
  const incoming = [...directoryRow]; incoming[0] = 'ООО Пример';
  f.addSource(secondId, [[...directoryHeaders,'ИНН'], [...incoming,'7707083893']]);
  const typed = () => f.context.previewSegmentRecords_({ segmentId: SEGMENT, sourceIds: [secondId], targetKind: 'companies' });
  typed(); f.finish(f.start(old));
  assert.deepEqual(sheet.state.rows[0].slice(0,oldHeaders.length),oldHeaders);
  const note = oldHeaders.indexOf('Заметка пользователя'), category = oldHeaders.indexOf('Категории');
  sheet.state.rows[1][note] = 'Сохранить'; sheet.state.rows[1][category] = 'Ручное значение'; sheet.state.formulas['2:' + (category+1)] = '=A5';
  const shown = typed(); assert.equal(shown.counts.companiesAdded, 0); f.finish(f.start(shown, 'directory-batch-003'));
  assert.equal(sheet.state.rows.length, 2); assert.equal(sheet.state.rows[1][note], 'Сохранить');
  assert.equal(sheet.state.rows[1][category], 'Ручное значение'); assert.equal(sheet.state.formulas['2:' + (category+1)], '=A5');
  assert.equal(sheet.state.rows[1][sheet.state.rows[0].indexOf('Telegram из исходника')], directoryRow[8]);
  const saved = plain(sheet.state.rows); typed(); assert.deepEqual(sheet.state.rows,saved);
});

test('partial and reordered directory headings preserve company evidence and keep personal contacts out of company fields', () => {
  const rows = [
    ['Юридический адрес','ФИО ЛПР','Регион','Почта компании','Компания','Email ЛПР','Категория','Город','Фактический адрес','Моя колонка','Сайт'],
    ['  ул. Юридическая, 1','Анна Тестова','Московская область','info@example.test','Тестовый завод','anna@example.test','Производство','Москва','ул. Фактическая, 2','Текст сотрудника','https://company.example.test']
  ];
  const f = fixture({ rows }), preview = f.context.previewSegmentRecords_({ segmentId: SEGMENT, sourceIds: [SOURCE], targetKind: 'companies' });
  f.finish(f.start(preview));
  const [headers, row] = f.master('companies').state.rows;
  assert.equal(row[headers.indexOf('Полные адреса')], '  ул. Юридическая, 1\nул. Фактическая, 2');
  assert.equal(row[headers.indexOf('Категории')], 'Производство'); assert.equal(row[headers.indexOf('Регионы, области')], 'Московская область');
  assert.equal(row[headers.indexOf('Названия')], 'Тестовый завод'); assert.equal(row[headers.indexOf('Населенные пункты')], 'Москва');
  assert.equal(row[headers.indexOf('Email-адреса')], 'info@example.test'); assert.equal(row[headers.indexOf('Сайты')], 'https://company.example.test');
  assert.ok(!row.includes('anna@example.test')); assert.equal(f.sourceSheet.state.rows[1][9], 'Текст сотрудника');
});

test('creates lean masters, transfers a person without contacts and marks original only after verified LPR write', () => {
  const f = fixture(), shown = f.preview();
  assert.equal(shown.counts.companiesAdded, 1); assert.equal(shown.counts.peopleAdded, 1); assert.equal(shown.counts.peopleWithoutContacts, 1);
  assert.equal(f.calls.raw.length, 0, 'preview leaves even empty working sheets untouched');
  assert.equal(f.calls.enrollments.length, 0);
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
  assert.equal(f.companyBook.sheets[0].getLastRow(), 0);
  assert.equal(f.properties.has('SEGMENT_RECORD_ACTIVE_' + SEGMENT), false);
});

test('renaming a source leaf after preview invalidates a plan even if all cells stay identical', () => {
  const f = fixture(), shown = f.preview(); f.sourceSheet.setName('ЛПР — исходные'); f.resources.get(SOURCE).version++;
  assert.throws(() => f.start(shown), /SEGMENT_PREVIEW_CHANGED/);
  assert.equal(f.companyBook.sheets[0].getLastRow(), 0);
});

test('source readiness is rechecked between job steps', () => {
  const f = fixture(), state = f.start(f.preview()); f.status.value = 'rework';
  assert.throws(() => f.next(state), /SEGMENT_PREVIEW_CHANGED/);
  assert.equal(f.master('lpr').state.rows.length, 1);
});

test('legacy worksheets and manually added columns remain intact', () => {
  const f = fixture({ legacy: true }), original = plain(f.companyBook.sheets[0].state.rows);
  const shown = f.preview();
  assert.equal(f.companyBook.sheets.length, 1);
  f.finish(f.start(shown));
  const master = f.master('companies'); master.state.rows[0].push('Ручная заметка');
  assert.deepEqual(f.companyBook.sheets[0].state.rows, original);
  const noteColumn = master.state.rows[0].indexOf('Ручная заметка'); master.state.rows[1][noteColumn] = 'Не менять';
  f.sourceSheet.state.rows[1][2] += '; new@example.test'; f.resources.get(SOURCE).version++;
  f.finish(f.start(f.preview(), 'segment-normalize-request-002'));
  assert.equal(master.state.rows[1][noteColumn], 'Не менять');
});

test('lost master creation acknowledgement reuses the planned sheet id and records a single import', () => {
  const f=fixture({legacy:true,loseMasterCreation:true}), shown=f.preview();
  assert.equal(shown.counts.contactsAdded,1);
  assert.equal(shown.counts.contactDuplicates,0);
  assert.equal(f.companyBook.sheets.length,1);
  assert.throws(()=>f.start(shown),/Lost addSheet response/);
  const result=f.finish(f.start(shown));
  assert.equal(f.companyBook.sheets.length,2);
  const job=f.context.segmentRecordsReadJob_(f.config,result.jobId);
  assert.ok(Date.parse(job.completedAt)>=Date.parse(job.startedAt));
  assert.equal(job.sources[0].id,SOURCE);
  const repeated=f.preview();
  assert.equal(repeated.counts.contactsAdded,0);
  assert.equal(repeated.counts.contactDuplicates,1);
});

test('a segment without tracked tables previews empty targets and binds them only on explicit confirmation', () => {
  const f=fixture(), tracked=f.context.segmentTrackingStorage_(f.config).tables;
  const initial=tracked.splice(0), folder=f.resources.get(SEGMENT);
  folder.getFilesByType=()=>({hasNext:()=>false});
  let mutations=0;
  f.context.segmentMutation_=()=>{mutations++;tracked.push(...initial);};
  const shown=f.preview();
  assert.equal(shown.counts.contactsAdded,1);
  assert.equal(mutations,0);assert.equal(f.calls.raw.length,0);assert.equal(tracked.length,0);
  assert.equal(f.finish(f.start(shown)).state,'complete');
  assert.equal(mutations,1);assert.equal(f.master('companies').getLastRow(),2);
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
  const f = fixture(), master = f.master('companies', true), shown = f.preview(); master.state.rows[0].push('Заметка'); master.state.rows.push(Array(17).fill('').concat(['Новое ручное содержимое']));
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
