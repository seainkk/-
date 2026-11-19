import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const ROOT = 'root_contact_sync_1234567890', SOURCES = 'sources_contact_sync_1234567890';
const FILE = 'workbook_contact_sync_1234567890', ADMIN = 'admin_contact_sync_1234567890';
const OUTSIDE = 'outside_contact_sync_1234567890', MIME = 'application/vnd.google-apps.spreadsheet';
const EMAIL = ['Email', 'Компания / ЛПР', 'Исходные строки', 'Проверить принадлежность'];
const PHONE = ['Телефон', 'Компания / ЛПР', 'Откуда', 'Исходные строки', 'Проверить принадлежность', 'Telegram', 'Тип контакта'];
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(options = {}) {
  let serial = 0, sheetSerial = 100;
  const resources = new Map(), properties = new Map(), calls = { raw: [], model: 0, mutations: [], opened: [], provider: [], locks: 0 };
  const store = { getProperty: key => properties.get(key) ?? null, setProperty(key, value) { properties.set(key, String(value)); return store; }, deleteProperty: key => properties.delete(key) };
  function resource(id, name, mimeType, parents, tags = {}) {
    const item = { id, name, mimeType, parents: [...parents], appProperties: { ...tags }, version: '1', trashed: false, capabilities: { canEdit: true, canAddChildren: true }, content: '' };
    resources.set(id, item); return item;
  }
  resource(ROOT, 'Root', 'application/vnd.google-apps.folder', []);
  resource(SOURCES, 'Sources', 'application/vnd.google-apps.folder', [ROOT]);
  resource(OUTSIDE, 'Outside', 'application/vnd.google-apps.folder', []);
  resource(ADMIN, 'Admin', MIME, [ROOT]);
  resource(FILE, 'Base', MIME, [options.outside ? OUTSIDE : SOURCES]);
  const book = {
    tabs: [], getId: () => FILE, getSheets: () => book.tabs.slice(),
    getSheetByName: name => book.tabs.find(tab => tab.getName() === name) || null,
    insertSheet(name) {
      if (book.getSheetByName(name)) throw Error('duplicate name');
      const created = makeSheet(++sheetSerial, name, []); book.tabs.push(created);
      calls.mutations.push({ kind: 'sheet', name });
      if (options.loseSheet) { options.loseSheet = false; throw Error('sheet reply lost'); }
      return created;
    }
  };
  function makeSheet(id, name, rows) {
    const data = rows.map(row => row.slice()), formulas = {};
    let maxRows = options.gridRows || Math.max(1000, rows.length), maxColumns = Math.max(26, ...rows.map(line => line.length));
    const api = {
      data, formulas, getSheetId: () => id, getName: () => name, getParent: () => book,
      getLastRow() { for (let y = data.length - 1; y >= 0; y--) if (data[y]?.some(v => v !== '' && v !== null && v !== undefined)) return y + 1; return 0; },
      getLastColumn() { return Math.max(0, ...data.map(row => { for (let x = row.length - 1; x >= 0; x--) if (row[x] !== '' && row[x] !== null && row[x] !== undefined) return x + 1; return 0; })); },
      getMaxRows: () => maxRows, getMaxColumns: () => maxColumns,
      insertRowsAfter(_at, count) { maxRows += count; calls.mutations.push({ kind: 'rows', id, count }); },
      insertColumnsAfter(_at, count) { maxColumns += count; calls.mutations.push({ kind: 'columns', id, count }); },
      setFrozenRows() {},
      getRange(row, column, height = 1, width = 1) {
        if (row < 1 || column < 1 || row + height - 1 > maxRows || column + width - 1 > maxColumns) throw Error('grid bounds');
        const values = () => Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => data[row + y - 1]?.[column + x - 1] ?? ''));
        return {
          getValues: values, getDisplayValues: () => values().map(line => line.map(v => v === null || v === undefined ? '' : String(v))),
          getFormulas: () => Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => formulas[(row + y) + ':' + (column + x)] || '')),
          getRichTextValues: () => Array.from({ length: height }, () => Array(width).fill(null))
        };
      }
    };
    return api;
  }
  book.tabs.push(makeSheet(0, options.sourceName || 'Исходная база', options.rows || [['Email', 'Телефон', 'Telegram'], ['one@example.test', '+79990000001', '@person_1']]));
  if (options.secondSource) book.tabs.push(makeSheet(9, options.secondName || 'Другой исходник', options.secondSource));
  if (options.legacy) {
    Object.assign(resources.get(FILE).appProperties, { registryPreparedRoot: ROOT, registryPreparedRole: 'output', registryPreparedVersion: '1', registryPreparedOriginalSheetId: '0' });
    book.tabs.push(makeSheet(1, 'Email', options.emailRows || [EMAIL]));
    book.tabs.push(makeSheet(2, 'Телефоны', options.phoneRows || [PHONE.slice(0, 5)]));
  } else {
    if (options.emailRows) book.tabs.push(makeSheet(1, 'Email', options.emailRows));
    if (options.phoneRows) book.tabs.push(makeSheet(2, 'Телефоны', options.phoneRows));
  }
  const scope = { rootId: ROOT, properties: store };
  const context = vm.createContext({ console: { warn() {} }, Date, JSON, Object, Array, Number, String, Boolean, RegExp, Math, Error, Set, Map });
  context.authorize_ = () => { if (options.revoked) context.fail_('LINK_ACCESS_REQUIRED', 'revoked'); return scope; };
  context.object_ = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) context.fail_('INVALID_REQUEST', 'request'); return value; };
  context.id_ = id => { if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(id)) context.fail_('INVALID_ID', 'id'); return id; };
  context.registryError_ = (code, message) => Object.assign(new Error('[' + code + '] ' + message), { registryCode: code });
  context.fail_ = (code, message) => { throw context.registryError_(code, message); };
  context.api_ = fn => fn();
  context.digest_ = value => crypto.createHash('sha256').update(value).digest('base64url');
  context.SHARED_REQUEST_SCOPE_ = { keyHash: 'A'.repeat(43) };
  context.REGISTRY_CONFIG = { defaultSegmentsFolderId: 'outreach_contact_sync_1234567890' };
  context.sourceBasesSource_ = () => ({ state: 'ready', source: { id: SOURCES } });
  context.gridSheetId_ = id => { if (!Number.isSafeInteger(id) || id < 0) context.fail_('INVALID_REQUEST', 'sheet'); return id; };
  context.gridSheet_ = (_book, id) => { const s = book.tabs.find(tab => tab.getSheetId() === id); if (!s) context.fail_('GRID_SHEET_MISSING', 'sheet'); return s; };
  context.gridFile_ = (id, writable, expectedRoot) => {
    context.authorize_(); context.id_(id);
    if (expectedRoot && expectedRoot !== ROOT) context.fail_('OUTSIDE_REGISTRY', 'root');
    if (id === ADMIN) context.fail_('GRID_PROTECTED', 'admin');
    const item = resources.get(id);
    if (!item || item.trashed || !item.parents.includes(SOURCES)) context.fail_('OUTSIDE_REGISTRY', 'outside');
    if (writable && !item.capabilities.canEdit) context.fail_('GRID_READ_ONLY', 'read only');
    return { context: scope, file: { getId: () => id }, canEdit: item.capabilities.canEdit };
  };
  context.locked_ = fn => { if (options.busy) context.fail_('BUSY', 'busy'); calls.locks++; try { return fn(); } finally { calls.locks--; } };
  context.LockService = { getScriptLock: () => ({ tryLock: () => !options.busy, releaseLock() {} }) };
  context.SpreadsheetApp = { openById(id) { calls.opened.push(id); if (id !== FILE) throw Error('unexpected book'); return book; }, flush() {} };
  context.Utilities = {
    getUuid: () => crypto.randomUUID(),
    newBlob: (text, type, name) => ({ getDataAsString: () => String(text), getName: () => name, type })
  };
  context.DriveApp = { getFileById: id => ({ getBlob: () => ({ getDataAsString: () => resources.get(id).content }) }) };
  context.Drive = { Files: {
    get(id) { if (!resources.has(id)) throw Error('missing file'); options.onGet?.(id, resources.get(id)); return plain(resources.get(id)); },
    list(args) {
      const parent = String(args.q || '').match(/'([^']+)' in parents/), filters = [...String(args.q || '').matchAll(/key='([^']+)' and value='([^']+)'/g)];
      const all = [...resources.values()].filter(v => !v.trashed && (!parent || v.parents.includes(parent[1])) && filters.every(m => v.appProperties[m[1]] === m[2])).sort((a, b) => a.name.localeCompare(b.name));
      const first = Number(args.pageToken || 0), page = all.slice(first, first + (args.pageSize || 100));
      return { files: plain(page), nextPageToken: first + page.length < all.length ? String(first + page.length) : undefined };
    },
    create(metadata, body) {
      const id = 'contact_artifact_' + (++serial) + '_1234567890', item = resource(id, metadata.name, metadata.mimeType, metadata.parents || [], metadata.appProperties || {});
      item.content = body?.getDataAsString() || ''; calls.mutations.push({ kind: 'file', id, role: item.appProperties.registryContactRole });
      if (options.loseCreateRole === item.appProperties.registryContactRole) { options.loseCreateRole = null; throw Error('file reply lost'); }
      return plain(item);
    },
    update(metadata, id, body) {
      const item = resources.get(id); if (!item) throw Error('missing file');
      if (metadata.appProperties) Object.assign(item.appProperties, plain(metadata.appProperties));
      if (metadata.trashed !== undefined) item.trashed = metadata.trashed;
      if (body?.getDataAsString) {
        const text = body.getDataAsString(); options.beforeStateWrite?.(id, text);
        item.content = text;
        options.afterStateWrite?.(id, text);
      }
      item.version = String(Number(item.version) + 1);
      return plain(item);
    }
  } };
  context.sheetWriteRawStrings_ = (id, sheetId, row, column, values, mask) => {
    assert.equal(id, FILE); assert.equal(options.revoked, undefined);
    const s = book.tabs.find(t => t.getSheetId() === sheetId); assert.ok(s);
    if (values.length * values[0].length > 50000) throw Error('RAW cell bound');
    const isBody = row > 1;
    calls.raw.push({ id, sheetId, row, column, values: plain(values), mask: mask ? plain(mask) : null });
    if (isBody && options.writeFault === 'before') { options.writeFault = null; throw Error('write reply lost before apply'); }
    for (let y = 0; y < values.length; y++) {
      while (s.data.length < row + y) s.data.push([]);
      for (let x = 0; x < values[y].length; x++) {
        if (mask && !mask[y][x]) continue;
        assert.equal(typeof values[y][x], 'string');
        s.data[row + y - 1][column + x - 1] = values[y][x]; delete s.formulas[(row + y) + ':' + (column + x)];
      }
    }
    resources.get(FILE).version = String(Number(resources.get(FILE).version) + 1);
    options.onRaw?.({ id, sheetId, row, values, mask });
    if (isBody && options.writeFault === 'after') { options.writeFault = null; throw Error('write reply lost after apply'); }
  };
  context.PREPARED_DATA_HEADERS = { email: EMAIL, phone: PHONE };
  context.preparedDataReadWorkbook_ = (_book, id, section, settings) => {
    calls.model++; settings.guard(); options.onModel?.({ book, resources, calls });
    const ids = settings.sourceSheetIds, email = new Map(), phone = new Map(), records = [];
    for (const s of book.tabs.filter(tab => ids.includes(tab.getSheetId()))) {
      const data = s.data.slice(1);
      for (const row of data) {
        const general = { emails: [], phones: [], telegrams: [] };
        if (row[0]) { email.set(String(row[0]).toLowerCase(), [String(row[0]).toLowerCase(), 'Company', 'Source', '']); general.emails.push(String(row[0]).toLowerCase()); }
        if (row[1]) { phone.set('p:' + row[1], [String(row[1]), 'Company', 'Phone column', 'Source', '', '', 'Телефон']); general.phones.push(String(row[1])); }
        if (row[2]) { phone.set('t:' + row[2], ['', 'Company', 'Telegram column', 'Source', '', String(row[2]), 'Telegram']); general.telegrams.push(String(row[2])); }
        records.push({ general });
      }
    }
    const result = { complete: !options.incomplete, canConfirm: !options.emptySource, fingerprint: context.digest_(JSON.stringify(ids.map(id => book.tabs.find(t => t.getSheetId() === id).data))), email: { headers: EMAIL, rows: [...email.values()] }, phone: { headers: PHONE, rows: [...phone.values()] }, records, warnings: options.modelWarnings || [] };
    options.adjustModel?.(result); return result;
  };
  if (options.provider) context.queueWorkbookValidation_ = (_ctx, id, settings) => { calls.provider.push({ id, settings: plain(settings) }); if (options.providerFail) throw Error('provider secret'); return { state: 'queued' }; };
  if (options.realExtractor) {
    for (const name of ['ContactPreview.gs', 'SourceRecords.gs', 'PreparedData.gs']) vm.runInContext(readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'), context, { filename: name });
    const extract = context.preparedDataReadWorkbook_;
    context.preparedDataReadWorkbook_ = (...args) => { calls.model++; return extract(...args); };
  }
  vm.runInContext(readFileSync(new URL('../src/ContactSync.gs', import.meta.url), 'utf8'), context, { filename: 'ContactSync.gs' });
  const invoke = (name, payload) => plain(context[name](payload));
  const start = (requestId = 'sync_request_1234567890') => invoke('syncWorkbookContacts_', { id: FILE, requestId });
  const next = result => invoke('continueContactSync_', { id: FILE, jobId: result.jobId, requestId: result.requestId });
  const finish = (requestId = 'sync_request_1234567890') => { let result = start(requestId); for (let i = 0; result.state === 'processing' && i < 200; i++) result = next(result); assert.equal(result.state, 'complete'); return result; };
  const state = () => JSON.parse(resources.get(resources.get(FILE).appProperties.registryContactStateId).content);
  const saveState = value => { resources.get(value.stateFileId).content = JSON.stringify(value); };
  const target = kind => book.tabs.find(tab => tab.getSheetId() === state().targets[kind + 'SheetId']);
  const editSource = rows => { book.tabs[0].data.splice(1, Infinity, ...rows.map(r => r.slice())); resources.get(FILE).version = String(Number(resources.get(FILE).version) + 1); };
  return { context, options, resources, book, properties, calls, invoke, start, next, finish, state, saveState, target, editSource, scope };
}

test('an unmanaged workbook keeps an original tab named Email and creates separate managed lists', () => {
  const f = fixture({ sourceName: 'Email' }), before = plain(f.book.tabs[0].data), r = f.finish();
  assert.equal(r.counts.addedEmail, 1); assert.equal(r.counts.addedPhone, 1); assert.equal(r.counts.addedTelegram, 1);
  assert.deepEqual(f.book.tabs[0].data, before); assert.equal(f.target('email').getName(), 'Email — контакты');
  assert.equal(f.book.tabs.length, 3);
  assert.equal(f.target('phone').data[1][0], '+79990000001');
  assert.equal(f.target('phone').data[2][5], '@person_1');
});

test('source changes append only new contacts while existing validation, campaign statuses and dates survive', () => {
  const date = new Date('2026-01-02T00:00:00Z');
  const f = fixture({ legacy: true, emailRows: [EMAIL.concat(['Валидация', 'Статус рассылки', 'Дата']), ['one@example.test', 'Manual company', 'Manual refs', '', 'valid', 'запущен', date]], phoneRows: [PHONE.slice(0, 5).concat(['Статус рассылки']), ['+79990000001', 'Manual', 'Manual origin', 'Manual refs', '', 'запущен']] });
  f.finish();
  const emailBefore = f.target('email').data[1].slice(), phoneBefore = f.target('phone').data[1].slice();
  f.editSource([['one@example.test', '+79990000001', '@person_1'], ['new@example.test', '+79990000002', '@new_person']]);
  const r = f.finish('sync_second_request_12345');
  assert.equal(r.counts.addedEmail, 1); assert.equal(r.counts.addedPhone, 1); assert.equal(r.counts.addedTelegram, 1);
  assert.deepEqual(f.target('email').data[1], emailBefore); assert.deepEqual(f.target('phone').data[1], phoneBefore);
  assert.equal(f.target('phone').data[0][5], 'Статус рассылки');
  assert.equal(f.target('phone').data[0][6], 'Telegram');
  assert.equal(f.target('phone').data[0][7], 'Тип контакта');
  assert.equal(f.target('phone').data.find(row => row[0] === '+79990000002')[5] ?? '', '');
});

test('a repeated request is a pure receipt replay and a fresh scan adds no duplicates', () => {
  const f = fixture({ provider: true }); const first = f.finish(), writes = f.calls.raw.length;
  const replay = f.start(); assert.equal(replay.replayed, true); assert.equal(f.calls.raw.length, writes); assert.equal(f.calls.provider.length, 1);
  const second = f.finish('another_sync_request_12345');
  assert.equal(second.counts.addedEmail + second.counts.addedPhone + second.counts.addedTelegram, 0);
  assert.equal(second.counts.existing, 3); assert.equal(f.target('email').getLastRow(), 2); assert.equal(f.target('phone').getLastRow(), 3);
  assert.equal(first.state, 'complete');
});

test('manually removed contacts remain excluded even after new source rows arrive', () => {
  const f = fixture(); f.finish(); f.target('email').data.splice(1, 1);
  f.editSource([['one@example.test', '+79990000001', '@person_1'], ['two@example.test', '', '']]);
  const r = f.finish('after_manual_removal_12345');
  assert.equal(r.counts.excluded, 1); assert.equal(r.counts.addedEmail, 1);
  assert.deepEqual(f.target('email').data.slice(1).map(r => r[0]), ['two@example.test']);
  f.finish('after_another_scan_12345'); assert.equal(f.target('email').getLastRow(), 2);
});

test('lost RAW acknowledgement recovers the original range without a duplicate append', () => {
  const f = fixture({ writeFault: 'after' });
  assert.throws(() => f.start(), /write reply lost/);
  const pending = f.state().job.pending; assert.ok(pending);
  const resumed = f.start(); let r = resumed;
  for (let i = 0; r.state === 'processing' && i < 20; i++) r = f.next(r);
  assert.equal(r.state, 'complete'); assert.equal(f.target('email').getLastRow(), 2);
  assert.equal(f.calls.raw.filter(call => call.sheetId === pending.sheetId && call.row === pending.startRow).length, 1);
});

test('a failure before RAW application retries only its saved empty range', () => {
  const f = fixture({ writeFault: 'before' }); assert.throws(() => f.start(), /before apply/);
  const pending = f.state().job.pending; assert.ok(pending);
  const r = f.finish(); assert.equal(r.counts.addedEmail, 1); assert.equal(f.target('email').getLastRow(), 2);
  const writes = f.calls.raw.filter(call => call.sheetId === pending.sheetId && call.row > 1);
  assert.deepEqual(writes.map(write => write.row), [2, 2]);
});

test('manual data in an uncertain append range is not overwritten', () => {
  const f = fixture({ writeFault: 'before' }); assert.throws(() => f.start());
  f.target('email').data[1] = ['someone-else@example.test', 'Manual work'];
  assert.throws(() => f.start(), /CONTACT_SYNC_CONFLICT/);
  assert.equal(f.target('email').data[1][0], 'someone-else@example.test');
});

test('a changed source requires a fresh request and preserves already appended rows', () => {
  const f = fixture({ rows: [['Email', 'Телефон', 'Telegram'], ['a@example.test', '+79990000001', '']] });
  let r = f.start(); assert.equal(r.state, 'processing');
  f.editSource([['b@example.test', '+79990000002', '']]);
  assert.throws(() => f.next(r), /CONTACT_SOURCE_CHANGED/);
  r = f.finish('fresh_after_source_change_12345'); assert.equal(r.state, 'complete');
  assert.deepEqual(f.target('email').data.slice(1).map(row => row[0]), ['a@example.test', 'b@example.test']);
});

test('read-only, revoked, protected or moved books fail before any contact artifact is created', () => {
  for (const mode of ['outside', 'readOnly', 'revoked']) {
    const f = fixture({ outside: mode === 'outside', revoked: mode === 'revoked' || undefined });
    if (mode === 'readOnly') f.resources.get(FILE).capabilities.canEdit = false;
    assert.throws(() => f.start(), /OUTSIDE_REGISTRY|GRID_READ_ONLY|LINK_ACCESS_REQUIRED/); assert.equal(f.calls.mutations.length, 0);
  }
  const f = fixture(); assert.throws(() => f.invoke('syncWorkbookContacts_', { id: ADMIN, requestId: 'protected_request_12345' }), /GRID_PROTECTED/);
});

test('metadata pointers cannot read or write another workbook journal', () => {
  const f = fixture(); f.finish(); const state = f.state();
  f.resources.get(state.stateFileId).appProperties.registryContactFileId = ADMIN;
  assert.throws(() => f.start('tampered_pointer_12345'), /OUTSIDE_REGISTRY/);
});

test('private state and plan moves fail closed and never write the moved artifacts', () => {
  const f = fixture(); const r = f.start(), state = f.state();
  f.resources.get(state.job.planId).parents = [OUTSIDE];
  assert.throws(() => f.next(r), /OUTSIDE_REGISTRY/);
  const g = fixture(); g.finish(); g.resources.get(g.state().stateFileId).parents = [OUTSIDE];
  assert.throws(() => g.start('moved_state_request_12345'), /OUTSIDE_REGISTRY/);
});

test('enrollment seeds prepared contacts and keeps all original phone column positions', () => {
  const f = fixture({ legacy: true, emailRows: [EMAIL, ['one@example.test', 'Company', 'Source', '']], phoneRows: [PHONE.slice(0, 5), ['+79990000001', 'Company', 'Origin', 'Source', '']] });
  const enrolled = f.context.enrollContactWorkbook_(f.scope, FILE, { sourceSheetIds: [0], section: 'companies', role: 'registry', seedExisting: true });
  assert.equal(enrolled.enrolled, true); assert.deepEqual(plain(enrolled.sourceSheetIds), [0]);
  f.target('email').data.splice(1);
  const result = f.finish(); assert.equal(result.counts.excluded, 1);
  assert.deepEqual(f.target('phone').data[0].slice(0, 5), PHONE.slice(0, 5));
});

test('all-source mode deduplicates across source leaves and never reads its generated sheets', () => {
  const f = fixture({ secondSource: [['Email', 'Телефон', 'Telegram'], ['one@example.test', '+79990000001', '@person_1'], ['new@example.test', '+79990000002', '@other_person']] });
  const r = f.finish(); assert.equal(r.counts.addedEmail, 2); assert.equal(r.counts.addedPhone, 2); assert.equal(r.counts.addedTelegram, 2);
  const again = f.finish('multileaf_second_scan_12345'); assert.equal(again.counts.existing, 6); assert.equal(again.counts.addedEmail, 0);
});

test('header renames and duplicate managed headers stop before contact mutation', () => {
  const f = fixture(); f.finish(); const target = f.target('email'); target.data[0][0] = 'Renamed';
  f.editSource([['new@example.test', '', '']]); const count = f.calls.raw.length;
  assert.throws(() => f.start('renamed_header_request_12345'), /CONTACT_SCHEMA_CHANGED/); assert.equal(f.calls.raw.length, count);
  const g = fixture({ legacy: true, emailRows: [EMAIL.concat(['Email'])] });
  assert.throws(() => g.start(), /CONTACT_SCHEMA_CHANGED/);
});

test('empty valid sources finish without adding fake contacts; incomplete reads never append', () => {
  const f = fixture({ rows: [['Email', 'Телефон', 'Telegram']], emptySource: true }); const r = f.finish();
  assert.equal(r.counts.addedEmail + r.counts.addedPhone + r.counts.addedTelegram, 0);
  const g = fixture({ incomplete: true }); assert.throws(() => g.start(), /CONTACT_SOURCE_INCOMPLETE/);
  assert.equal(g.calls.raw.filter(call => call.row > 1).length, 0);
});

test('target grid extension happens before reading or writing an out-of-grid pending range', () => {
  const f = fixture({ gridRows: 2, legacy: true, rows: [['Email', 'Телефон', 'Telegram'], ['new@example.test', '', '']], emailRows: [EMAIL, ['old@example.test', '', '', '']] });
  const r = f.finish(); assert.equal(r.counts.addedEmail, 1); assert.equal(f.target('email').data[2][0], 'new@example.test');
  assert.ok(f.calls.mutations.some(call => call.kind === 'rows'));
});

test('provider queuing cannot undo completed contact lists or expose provider errors', () => {
  const f = fixture({ provider: true, providerFail: true }), r = f.finish();
  assert.equal(r.state, 'complete'); assert.equal(r.validation.state, 'error'); assert.ok(!JSON.stringify(r).includes('secret'));
  assert.equal(f.calls.provider.length, 1); assert.deepEqual(Object.keys(f.calls.provider[0].settings).sort(), ['emailSheetId', 'phoneSheetId', 'reason']);
  const again = f.start(); assert.equal(again.replayed, true); assert.equal(f.calls.provider.length, 1);
});

test('only general company contacts enter a segment-company contact list', () => {
  const f = fixture({ rows: [['Email', 'Телефон', 'Telegram'], ['company@example.test', '+79990000001', ''], ['person@example.test', '+79990000002', '']] });
  f.context.enrollContactWorkbook_(f.scope, FILE, { sourceSheetIds: [0], section: 'companies', role: 'segment-companies', relatedFileId: 'lpr_related_workbook_1234567890' });
  f.options.adjustModel = model => { model.records = [{ general: { emails: ['company@example.test'], phones: ['+79990000001'], telegrams: [] }, people: [{ name: 'Person', emails: ['person@example.test'] }] }]; };
  const r = f.finish(); assert.equal(r.counts.addedEmail, 1); assert.equal(r.counts.addedPhone, 1);
  assert.equal(f.target('email').data[1][0], 'company@example.test'); assert.equal(f.target('phone').data[1][0], '+79990000001');
});

test('automation enumeration does not create a folder and uses metadata-only opaque cursors', () => {
  const f = fixture(); assert.deepEqual(plain(f.context.listContactWorkspacesForAutomation_(f.scope, { limit: 1 })), { items: [], nextCursor: null });
  assert.equal(f.calls.mutations.length, 0); f.finish();
  const listed = plain(f.context.listContactWorkspacesForAutomation_(f.scope, { limit: 1 }));
  assert.equal(listed.items.length, 1); assert.equal(listed.items[0].id, FILE); assert.equal(listed.items[0].accessHash, 'A'.repeat(43));
  assert.equal(listed.items[0].role, 'registry'); assert.equal(listed.items[0].dirty, false);
});

test('a lightweight dirty marker changes only private metadata and workspace reports fresh versions', () => {
  const f = fixture(); f.finish(); const writes = f.calls.raw.length;
  let workspace = f.invoke('getContactWorkspace_', { id: FILE }); assert.equal(workspace.shouldSync, false); assert.equal(workspace.counts.addedEmail, 1);
  f.context.markContactWorkbookDirty_(FILE); workspace = f.invoke('getContactWorkspace_', { id: FILE });
  assert.equal(workspace.shouldSync, true); assert.equal(f.calls.raw.length, writes);
  assert.equal(workspace.fileVersion, f.resources.get(FILE).version);
});

test('active jobs return their original request IDs and reject a forged continuation', () => {
  const f = fixture(); const first = f.start(), other = f.start('different_new_request_12345');
  assert.equal(other.jobId, first.jobId); assert.equal(other.requestId, first.requestId);
  assert.throws(() => f.invoke('continueContactSync_', { id: FILE, jobId: first.jobId, requestId: 'wrong_request_id_12345' }), /CONTACT_SYNC_JOB_MISSING/);
});

test('foreign or malformed source/target assignments never enroll source as its own output', () => {
  const f = fixture();
  assert.throws(() => f.context.enrollContactWorkbook_(f.scope, FILE, { sourceSheetIds: [0], emailSheetId: 0 }), /CONTACT_SCHEMA_CHANGED/);
  const g = fixture(); assert.throws(() => g.invoke('syncWorkbookContacts_', { id: FILE, requestId: 'bad' }), /INVALID_REQUEST/);
  assert.equal(g.calls.mutations.length, 0);
});

test('a lost target-sheet creation acknowledgement recovers one empty sheet instead of adding duplicates', () => {
  const f = fixture({ loseSheet: true }); assert.throws(() => f.start(), /CONTACT_STORAGE_UNCERTAIN/);
  assert.equal(f.book.tabs.length, 2);
  const r = f.finish(); assert.equal(r.state, 'complete'); assert.equal(f.book.tabs.length, 3);
  assert.equal(f.book.tabs.filter(tab => tab.getName() === 'Email').length, 1);
});

test('a newly created target that gained manual content before recovery is not adopted or overwritten', () => {
  const f = fixture({ loseSheet: true }); assert.throws(() => f.start());
  f.book.tabs[1].data.push(['Manual user notes']);
  assert.throws(() => f.start(), /CONTACT_STORAGE_UNCERTAIN/);
  assert.equal(f.book.tabs[1].data[0][0], 'Manual user notes'); assert.equal(f.book.tabs.length, 2);
});

test('a lost private state creation acknowledgement recovers the same root-bound artifact', () => {
  const f = fixture({ loseCreateRole: 'state' }); assert.throws(() => f.start(), /CONTACT_STORAGE_UNCERTAIN/);
  assert.equal([...f.resources.values()].filter(item => item.appProperties.registryContactRole === 'state').length, 1);
  f.finish();
  assert.equal([...f.resources.values()].filter(item => item.appProperties.registryContactRole === 'state').length, 1);
});

test('restoring a formerly excluded contact manually prevents a duplicate on future scans', () => {
  const f = fixture(); f.finish();
  const row = f.target('email').data[1].slice(); f.target('email').data.splice(1);
  const excluded = f.finish('deleted_scan_request_12345'); assert.equal(excluded.counts.excluded, 1);
  f.target('email').data.push(row);
  const restored = f.finish('restored_scan_request_12345');
  assert.equal(restored.counts.excluded, 0); assert.equal(restored.counts.addedEmail, 0); assert.equal(f.target('email').getLastRow(), 2);
});

test('a phone row may also hold a provider-discovered Telegram username without duplicating either key', () => {
  const f = fixture({ legacy: true, emailRows: [EMAIL], phoneRows: [PHONE, ['+79990000001', 'Company', 'Source', '', '', '@person_1', 'Телефон']] });
  const r = f.finish(); assert.equal(r.counts.addedPhone, 0); assert.equal(r.counts.addedTelegram, 0);
  assert.equal(f.target('phone').getLastRow(), 2);
});

test('source additions during provider queuing remain dirty instead of being hidden by a fresh book version', () => {
  const f = fixture({ provider: true });
  f.context.queueWorkbookValidation_ = () => { f.editSource([['one@example.test', '+79990000001', '@person_1'], ['during-queue@example.test', '', '']]); return { state: 'queued' }; };
  const r = f.finish(); assert.equal(r.sourceChanged, true);
  const workspace = f.invoke('getContactWorkspace_', { id: FILE }); assert.equal(workspace.shouldSync, true); assert.equal(workspace.lastObservedVersion, '');
  f.context.queueWorkbookValidation_ = () => ({ state: 'queued' });
  const again = f.finish('queue_source_change_12345'); assert.equal(again.counts.addedEmail, 1);
});

test('a source edit sharing the target-write Drive version is not mistaken for our own write', () => {
  const f = fixture(); let added = false;
  f.options.onRaw = write => {
    if (!added && write.row > 1) {
      added = true; f.editSource([['one@example.test', '+79990000001', '@person_1'], ['arrived-during-write@example.test', '', '']]);
    }
  };
  const r = f.finish(); assert.equal(r.sourceChanged, true);
  assert.equal(f.invoke('getContactWorkspace_', { id: FILE }).shouldSync, true);
  const next = f.finish('after_concurrent_source_12345'); assert.equal(next.counts.addedEmail, 1);
});

test('completed receipts do not overwrite later manual edits or require the completed private plan', () => {
  const f = fixture(); f.finish(); const state = f.state();
  const completedPlan = [...f.resources.values()].find(item => item.appProperties.registryContactRole === 'plan');
  assert.equal(completedPlan.trashed, true);
  f.target('email').data[1][0] = 'manually-edited@example.test';
  const replay = f.start(); assert.equal(replay.replayed, true); assert.equal(f.target('email').data[1][0], 'manually-edited@example.test');
  assert.equal(state.job, null);
});

test('a foreign lease stops writes and is never cleared by the older invocation', () => {
  const f = fixture({ writeFault: 'before' }); assert.throws(() => f.start());
  let changed = false;
  f.options.onGet = id => {
    if (changed || id !== f.state().stateFileId) return;
    changed = true; const state = f.state(); state.lease = { id: 'foreign_lease', until: Date.now() + 500000 }; f.saveState(state);
  };
  assert.throws(() => f.start(), /BUSY|CONTACT_SYNC_LEASE_LOST/);
  assert.equal(f.state().lease.id, 'foreign_lease');
});

test('large target schemas split append batches so RAW receives at most fifty thousand cells', () => {
  const extra = Array.from({ length: 100 }, (_, i) => 'Custom ' + i);
  const rows = [['Email', 'Телефон', 'Telegram'], ...Array.from({ length: 600 }, (_, i) => ['batch' + i + '@example.test', '', ''])];
  const f = fixture({ legacy: true, rows, emailRows: [EMAIL.concat(extra)] });
  const r = f.finish(); assert.equal(r.counts.addedEmail, 600);
  assert.ok(f.calls.raw.filter(write => write.row > 1).every(write => write.values.length * write.values[0].length <= 50000));
  assert.equal(f.target('email').getLastRow(), 601);
});

test('four-character collectible Telegram names and digit-prefixed handles deduplicate case-insensitively', () => {
  const f = fixture({ rows: [['Email', 'Телефон', 'Telegram'], ['', '', '@1Abc'], ['', '', '@1abc'], ['', '', '@_abc']] });
  const r = f.finish(); assert.equal(r.counts.addedTelegram, 2);
  assert.deepEqual(f.target('phone').data.slice(1).map(row => row[5]), ['@1Abc', '@_abc']);
});

test('bare international digits and their plus-prefixed spelling share a key without changing stored text', () => {
  const f = fixture({ rows: [['Email', 'Телефон', 'Telegram'], ['', '442079460123', ''], ['', '+442079460123', '']] });
  const r = f.finish(); assert.equal(r.counts.addedPhone, 1);
  assert.equal(f.target('phone').data[1][0], '442079460123');
  const again = f.finish('foreign_phone_rescan_12345'); assert.equal(again.counts.existing, 1); assert.equal(again.counts.addedPhone, 0);
});

test('real extraction integrates unknown headers, several source tabs and Telegram without recursive targets', () => {
  const f = fixture({ realExtractor: true, rows: [['Произвольное поле', 'Связаться'], ['person@example.test', 'https://t.me/Example_User']], secondSource: [['Company_ID', 'Компания', 'Мобильный'], ['A', 'Альфа', '+7 (999) 000-00-01']] });
  const r = f.finish(); assert.equal(r.counts.addedEmail, 1); assert.equal(r.counts.addedPhone, 1); assert.equal(r.counts.addedTelegram, 1);
  assert.equal(f.target('email').data[1][0], 'person@example.test'); assert.equal(f.target('phone').data.find(row => row[0])[0], 'Телефон');
  assert.ok(f.target('phone').data.some(row => row[5] === '@example_user'));
  const repeat = f.finish('real_parser_repeat_12345'); assert.equal(repeat.counts.existing, 3); assert.equal(repeat.counts.addedEmail, 0);
});

test('real company-role filtering keeps personal email only for the linked LPR workflow', () => {
  const rows = [['Company_ID', 'Компания', 'Email компании', 'ФИО ЛПР', 'Email ЛПР'], ['A', 'Альфа', 'general@example.test', 'Иван Иванов', 'person@example.test']];
  const f = fixture({ realExtractor: true, rows });
  f.context.enrollContactWorkbook_(f.scope, FILE, { sourceSheetIds: [0], role: 'segment-companies', section: 'companies' });
  const r = f.finish(); assert.equal(r.counts.addedEmail, 1);
  assert.deepEqual(f.target('email').data.slice(1).map(row => row[0]), ['general@example.test']);
  assert.deepEqual(f.book.tabs[0].data, rows);
});

test('real contact-free LPR rows remain in their source while derived lists stay empty', () => {
  const rows = [['Компания', 'ФИО', 'Должность'], ['Альфа', 'Иван Иванов', 'Директор']];
  const f = fixture({ realExtractor: true, rows });
  f.context.enrollContactWorkbook_(f.scope, FILE, { sourceSheetIds: [0], role: 'segment-lpr', section: 'lpr' });
  const r = f.finish(); assert.equal(r.counts.addedEmail + r.counts.addedPhone + r.counts.addedTelegram, 0);
  assert.deepEqual(f.book.tabs[0].data, rows);
  assert.equal(f.target('email').getLastRow(), 1); assert.equal(f.target('phone').getLastRow(), 1);
});

test('V2 recovery enrolls every original leaf even if publication ended before contact enrollment', () => {
  const f = fixture({ legacy: true, secondSource: [['Email', 'Телефон', 'Telegram'], ['from-second@example.test', '+79990000002', '']] });
  Object.assign(f.resources.get(FILE).appProperties, { registryPreparedVersion: '2', registryContactEmailSheetId: '1', registryContactPhoneSheetId: '2' });
  const before = f.invoke('getContactWorkspace_', { id: FILE }); assert.deepEqual(before.sourceSheetIds, [0, 9]);
  const r = f.finish(); assert.equal(r.counts.addedEmail, 2); assert.equal(r.counts.addedPhone, 2);
  assert.deepEqual(f.state().sourceSheetIds, [0, 9]);
});

test('V1 missing source is not recursively reconstructed from its generated contact lists', () => {
  const f = fixture({ legacy: true, emailRows: [EMAIL, ['one@example.test', '', '', '']] });
  f.book.tabs.splice(0, 1);
  assert.throws(() => f.start(), /CONTACT_SOURCE_MISSING/);
  assert.equal(f.book.tabs.length, 2); assert.equal(f.calls.raw.length, 0);
});

test('a missing legacy derived list is recreated while the surviving list remains a target', () => {
  const f = fixture({ legacy: true, phoneRows: [PHONE, ['+79990000001', '', '', '', '', '@person_1', 'Телефон']] });
  f.book.tabs.splice(f.book.tabs.findIndex(tab => tab.getSheetId() === 1), 1);
  const r = f.finish(); assert.equal(r.counts.addedEmail, 1); assert.equal(r.counts.addedPhone, 0); assert.equal(r.counts.addedTelegram, 0);
  assert.equal(f.book.tabs.length, 3); assert.equal(f.target('phone').getSheetId(), 2);
});
