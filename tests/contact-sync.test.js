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
  const resources = new Map(), properties = new Map(), calls = { raw: [], reads: [], updates: [], model: 0, mutations: [], opened: [], provider: [], locks: 0, lockAttempts: 0 };
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
    const data = rows.map(row => row.slice()), formulas = {}, validations = {}, links = {};
    let maxRows = options.gridRows || Math.max(1000, rows.length), maxColumns = Math.max(26, ...rows.map(line => line.length));
    const api = {
      data, formulas, validations, links, getSheetId: () => id, getName: () => name, getParent: () => book,
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
          getValues: values, getDisplayValues() {
            calls.reads.push({ sheetId: id, row, column, height, width }); options.onRead?.({ sheetId: id, row, height });
            return values().map(line => line.map(v => v === null || v === undefined ? '' : String(v)));
          },
          getFormulas: () => Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => formulas[(row + y) + ':' + (column + x)] || '')),
          getNotes: () => Array.from({ length: height }, () => Array(width).fill('')),
          getDataValidations: () => Array.from({ length: height }, (_, y) => [validations[(row + y) + ':' + column] || null]),
          setDataValidations: rules => rules.forEach((line, y) => { validations[(row + y) + ':' + column] = line[0]; }),
          getRichTextValues: () => Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => {
            const uri = links[(row + y) + ':' + (column + x)];
            return uri ? {getLinkUrl: () => uri, getRuns: () => []} : null;
          }))
        };
      }
    };
    return api;
  }
  book.tabs.push(makeSheet(options.sourceSheetId ?? 0, options.sourceName || 'Исходная база', options.rows || [['Email', 'Телефон', 'Telegram'], ['one@example.test', '+79990000001', '@person_1']]));
  if (options.secondSource) book.tabs.push(makeSheet(9, options.secondName || 'Другой исходник', options.secondSource));
  if (options.legacy) {
    Object.assign(resources.get(FILE).appProperties, { registryPreparedRoot: ROOT, registryPreparedRole: 'output', registryPreparedVersion: '1', registryPreparedOriginalSheetId: '0' });
    book.tabs.push(makeSheet(1, 'Email', options.emailRows || [EMAIL]));
    book.tabs.push(makeSheet(2, 'Телефоны', options.phoneRows || [PHONE.slice(0, 5)]));
  } else {
    if (options.emailRows) book.tabs.push(makeSheet(options.emailSheetId ?? 1, 'Email', options.emailRows));
    if (options.phoneRows) book.tabs.push(makeSheet(2, options.phoneName || 'Телефоны', options.phoneRows));
  }
  const scope = { rootId: ROOT, properties: store };
  const context = vm.createContext({ console: { warn() {} }, Date, JSON, Object, Array, Number, String, Boolean, RegExp, Math, Error, Set, Map });
  vm.runInContext(readFileSync(new URL('../src/Config.gs', import.meta.url), 'utf8'), context, { filename: 'Config.gs' });
  vm.runInContext(readFileSync(new URL('../src/ContactPreview.gs', import.meta.url), 'utf8'), context, { filename: 'ContactPreview.gs' });
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
  context.locked_ = fn => { calls.lockAttempts++; if (options.busy) context.fail_('BUSY', 'busy'); calls.locks++; try { return fn(); } finally { calls.locks--; } };
  context.LockService = { getScriptLock: () => ({ tryLock: () => !options.busy, releaseLock() {} }) };
  context.SpreadsheetApp = { openById(id) { calls.opened.push(id); if (id !== FILE) throw Error('unexpected book'); return book; }, flush() {} };
  if (options.nativeDropdown) context.SpreadsheetApp.newDataValidation = () => {
    const rule = {}, builder = {
      requireValueInList(values, dropdown) { rule.values = plain(values); rule.dropdown = dropdown; return builder; },
      setAllowInvalid(allowInvalid) { rule.allowInvalid = allowInvalid; return builder; },
      build: () => rule,
    };
    return builder;
  };
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
      calls.updates.push({ id, body: !!body });
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
  context.sheetWriteRawStrings_ = (id, sheetId, row, column, values, mask, links) => {
    assert.equal(id, FILE); assert.equal(options.revoked, undefined);
    const s = book.tabs.find(t => t.getSheetId() === sheetId); assert.ok(s);
    if (values.length * values[0].length > 50000) throw Error('RAW cell bound');
    const isBody = row > 1;
    calls.raw.push({ id, sheetId, row, column, values: plain(values), mask: mask ? plain(mask) : null, links: links ? plain(links) : null });
    if (isBody && options.writeFault === 'before') { options.writeFault = null; throw Error('write reply lost before apply'); }
    for (let y = 0; y < values.length; y++) {
      while (s.data.length < row + y) s.data.push([]);
      for (let x = 0; x < values[y].length; x++) {
        if (mask && !mask[y][x]) continue;
        assert.equal(typeof values[y][x], 'string');
        s.data[row + y - 1][column + x - 1] = values[y][x]; delete s.formulas[(row + y) + ':' + (column + x)];
        const key = (row + y) + ':' + (column + x);
        if (links?.[y][x]) s.links[key] = links[y][x]; else delete s.links[key];
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

test('curated records carry every owner decision into the segment and a replay preserves manual changes', () => {
  const id = suffix => 'C-' + suffix.repeat(24), email = 'shared@example.test', phone = '+79990000001';
  const src = fixture({ realExtractor: true, phoneName: 'Мобильные телефоны',
    rows: [['ID компании', 'Названия', 'Email-адреса', 'Мобильные телефоны'], [id('a'), 'Альфа', email + '; omitted@example.test', phone], [id('b'), 'Бета', email, '']],
    emailRows: [['Статус', 'Комментарий', 'Почт на компанию', 'Строки в Лист1', 'Компания', 'Email', 'Валидация', 'Провайдер', 'Сайты', 'ID компании'],
      ['Рассылка', 'Первое решение', '1', '2, 3', 'Альфа', email, 'valid', 'provider A', '', id('a')],
      ['Нецелевой', 'Второе решение', '1', '2, 3', 'Бета', email, 'invalid', 'provider B', '', id('b')]],
    phoneRows: [['Статус', 'Строки в Лист1', 'Компания', 'Мобильный телефон', 'ID_TG', 'Nickname_TG', 'Active_days_ago', 'Сайты'], ['Срок > 30', '2', 'Альфа', phone, '799', 'example_user', '34', '']]
  });
  const load = (ctx, name) => vm.runInContext(readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'), ctx, { filename: name });
  for (const name of ['SegmentImports.gs', 'SegmentRecords.gs', 'Promouser.gs']) load(src.context, name);
  src.context.segmentFindSheet_ = (book, gid) => book.tabs.find(sheet => sheet.getSheetId() === gid);
  const selection = src.context.workingSelectionTargets_(src.book.tabs), read = () => {
    const model = src.context.preparedDataReadWorkbook_(src.book, FILE, 'companies', { sourceSheetIds: [0], guard() {} });
    const history = src.context.segmentSelectionContacts_(src.book, selection, model.records, () => {});
    return { history, records: model.records };
  };
  const { history, records } = read();
  assert.deepEqual(plain(records.map(record => record.general.emails)), [[email], [email]]);
  assert.deepEqual(plain(records.map(record => record.general.phones)), [[phone], []]);
  const planned = src.context.segmentRecordsPlanner_({ records });
  const accepted = src.context.segmentSelectionAccepted_(history.roles, { companies: { records: [] } }, planned);
  assert.equal(accepted.companies['email:' + email].length, 2);
  src.book.tabs[1].data[2][1] = 'Изменено';
  assert.notEqual(read().history.fingerprint, history.fingerprint);
  assert.deepEqual(Object.keys(src.context.segmentSelectionAccepted_(history.roles, { companies: { records: [] } }, { companies: [] })), []);

  const dst = fixture({ realExtractor: true, rows: [['ID компании', 'Компания', 'Email', 'Телефон'], [id('a'), 'Альфа', email, phone], [id('b'), 'Бета', email, '']] });
  load(dst.context, 'SegmentImports.gs');
  const segment = SOURCES;
  dst.context.enrollContactWorkbook_(dst.scope, FILE, { sourceSheetIds: [0], role: 'segment-companies', section: 'companies', segmentId: segment });
  dst.context.contactSyncInstallWorkingHistory_(FILE, 'companies', segment, accepted.companies);
  const settle = () => dst.context.contactSyncSegmentImportStep_(FILE, 'companies', segment, 'import_with_ready_history');
  let ready = false;
  for (let step = 0; !ready && step < 10; step++) ready = settle();
  assert.equal(ready, true);
  assert.equal(dst.state().lastCounts.addedEmail, 1); assert.equal(dst.state().lastCounts.addedPhone, 1);
  const matrix = dst.target('email').data, col = label => matrix[0].indexOf(label);
  assert.equal(matrix[0][0], 'Статус рассылки'); assert.equal(matrix[1][0], 'фильтр');
  assert.equal(matrix[1][col('Валидация')], 'Проверить историю контакта');
  assert.match(matrix[1][col('История контакта')], /Первое решение/); assert.match(matrix[1][col('История контакта')], /Второе решение/);
  const mobile = dst.target('phone').data;
  assert.equal(mobile[1][0], 'фильтр'); assert.equal(mobile[1][mobile[0].indexOf('Active_days_ago')], '34');
  matrix[1][col('Комментарий')] = 'Ручное решение'; matrix[1][0] = 'в рассылке';
  dst.context.contactSyncInstallWorkingHistory_(FILE, 'companies', segment, accepted.companies);
  assert.equal(matrix[1][0], 'в рассылке'); assert.equal(matrix[1][col('Комментарий')], 'Ручное решение');
  assert.equal(settle(), true); assert.equal(matrix[1][0], 'в рассылке');
  assert.equal(dst.finish('working_history_repeat_1234').counts.addedEmail, 0);
});

test('new email and phone headers link to the same public preview and do not duplicate the action on resync', () => {
  const f = fixture(), action = 'Проверить новые контакты';
  f.finish('new_book_preview_headers');
  f.finish('new_book_preview_headers_replay');
  for (const channel of ['email', 'phone']) {
    const tab = f.target(channel);
    const headers = tab.data[0], position = headers.indexOf(action);
    assert.ok(position >= 0); assert.equal(position, headers.lastIndexOf(action));
    const writes = f.calls.raw.filter(write => write.sheetId === tab.getSheetId() && write.row === 1 && write.values[0].includes(action));
    assert.equal(writes.length, 1);
    const link = writes[0].links[0][position + 1 - writes[0].column];
    assert.equal(link, 'https://seainkk.github.io/-/?validate=' + FILE);
  }
});

test('contact sync appends literal phone-list errors from an owned source only once', () => {
  const f = fixture({realExtractor:true, rows:[['Компания','Рабочий телефон (компания)'], ['Фабрика','#ERROR!']]});
  f.book.tabs[0].formulas['2:2'] = '=+7 (999) 123-45-67, 312-22-11, 12-34-56-78-90-12-34';
  assert.equal(f.finish('sync_literal_phone_lists').counts.addedPhone, 2);
  const [headers,...contacts] = f.target('phone').data;
  assert.deepEqual(contacts.map(row => row[headers.indexOf('Телефон')]).sort(), ['+79991234567','3122211']);
  assert.equal(f.finish('sync_after_literal_phones').counts.addedPhone, 0);
  assert.equal(f.book.tabs[0].data[1][1], '#ERROR!'); assert.equal(f.calls.provider.length, 0);
});

test('enrollment replaces a copied workbook link and preserves a manual formula at the other action heading', () => {
  const action = 'Проверить новые контакты', prefix = 'https://seainkk.github.io/-/?validate=';
  const f = fixture({legacy:true, emailRows:[[...EMAIL, action]], phoneRows:[[...PHONE, action]]});
  const email = f.book.tabs[1], phone = f.book.tabs[2], emailColumn = EMAIL.length + 1, phoneColumn = PHONE.length + 1;
  email.links['1:' + emailColumn] = prefix + 'previous_company_book';
  phone.formulas['1:' + phoneColumn] = '="Проверить новые контакты"';
  f.finish('template_native_actions');
  assert.equal(email.links['1:' + emailColumn], prefix + FILE);
  assert.equal(email.data[0].filter(name => name === action).length, 1);
  assert.equal(phone.formulas['1:' + phoneColumn], '="Проверить новые контакты"');
  const alternate = phone.data[0].indexOf(action + ' (2)') + 1;
  assert.ok(alternate > 0); assert.equal(phone.links['1:' + alternate], prefix + FILE);
});

test('a segment import upgrades a legacy validation heading once per channel without restoring one the team removed', () => {
  const f = fixture(), action = 'Проверить новые контакты';
  f.context.enrollContactWorkbook_(f.scope, FILE, {sourceSheetIds:[0], role:'segment-companies', section:'companies', segmentId:SOURCES});
  const prior = f.state(), email = f.target('email'), phone = f.target('phone');
  for (const sheet of [email, phone]) {
    const position = sheet.data[0].indexOf(action);
    assert.ok(position >= 0); sheet.data[0][position] = ''; delete sheet.links['1:' + (position + 1)];
  }
  delete prior.schemas.phone.validationLinkVersion;
  f.saveState(prior);
  const writes = f.calls.raw.length, reads = f.calls.reads.length;
  f.invoke('getContactWorkspace_', {id:FILE});
  assert.equal(f.calls.raw.length, writes); assert.equal(f.calls.reads.length, reads);
  const complete = request => {
    for (let i = 0; i < 12; i++) if (f.context.contactSyncSegmentImportStep_(FILE, 'companies', SOURCES, request)) return;
    assert.fail('segment contact sync did not finish');
  };
  complete('upgrade_old_contact_targets');
  const phonePosition = phone.data[0].indexOf(action);
  assert.ok(phonePosition >= 0); assert.equal(phone.links['1:' + (phonePosition + 1)], 'https://seainkk.github.io/-/?validate=' + FILE);
  assert.equal(f.state().schemas.phone.validationLinkVersion, 1);
  assert.equal(email.data[0].includes(action), false);
  phone.data[0][phonePosition] = ''; delete phone.links['1:' + (phonePosition + 1)];
  complete('sync_after_removing_link');
  assert.equal(phone.data[0].includes(action), false);
  assert.equal(email.data[0].includes(action), false);
});

test('segment source columns append and deduplicate while manual history and formula cells survive repeated imports', () => {
  const f = fixture({realExtractor:true, rows:[
    ['ID компании', 'Компания', 'Email'], ['C-' + 'a'.repeat(24), 'Компания', 'a@example.test; b@example.test']
  ]});
  vm.runInContext(readFileSync(new URL('../src/SegmentImports.gs', import.meta.url), 'utf8'), f.context);
  f.context.enrollContactWorkbook_(f.scope, FILE, {sourceSheetIds:[0], role:'segment-companies', section:'companies', segmentId:SOURCES});
  const a = 'email:a@example.test', b = 'email:b@example.test';
  const first = 'База 1 / Контакты · B — Почта', second = 'База 2 / Компании · C — Email';
  const install = origins => f.context.contactSyncInstallWorkingHistory_(FILE, 'companies', SOURCES, {}, false, origins);
  install({[a]:first, [b]:first});
  f.finish('first_segment_source_columns');
  const tab = f.target('email'), [header, rowA, rowB] = tab.data, column = header.indexOf('Исходный столбец email');
  assert.equal(rowA[column], first); assert.equal(rowB[column], first);
  const status = header.indexOf('Статус рассылки'), validation = header.indexOf('Валидация');
  rowA[status] = 'фильтр'; rowA[validation] = 'ручное решение'; rowA[column] = 'Добавлено вручную\n' + first;
  rowB[column] = 'Значение из формулы'; tab.formulas['3:' + (column + 1)] = '=A10';
  install({[a]:second,[b]:second}); install({[a]:second,[b]:second});
  assert.deepEqual(rowA[column].split('\n'), ['Добавлено вручную', first, second]);
  assert.equal(rowA[status], 'фильтр'); assert.equal(rowA[validation], 'ручное решение');
  assert.equal(rowB[column], 'Значение из формулы'); assert.equal(tab.formulas['3:' + (column + 1)], '=A10');
  assert.equal(tab.data.length, 3); assert.equal(f.calls.provider.length, 0);
});

test('company and LPR masters keep original directory values out of the three verified working channels', () => {
  for (const role of ['segment-companies', 'segment-lpr']) {
    const headers = ['ID компании', 'Компания', 'Источники', 'Статус', 'Email', 'Телефон', 'Telegram', 'Telegram для контактов', 'Email-адреса', 'Городские телефоны', 'WhatsApp'];
    if (role === 'segment-lpr') headers.push('ФИО ЛПР');
    const row = ['C-' + 'a'.repeat(24), 'Альфа', '', '', 'allowed@example.test', '+79990000001', '@raw_dir', '@working_user', 'hidden@example.test', '+74950000002', 'https://wa.me/79990000003'];
    if (role === 'segment-lpr') row.push('Иван Иванов');
    const f = fixture({ realExtractor: true, rows: [headers, row] });
    f.context.enrollContactWorkbook_(f.scope, FILE, { sourceSheetIds: [0], role, section: role === 'segment-lpr' ? 'lpr' : 'companies' });
    const result = f.finish();
    assert.equal(result.counts.addedEmail, 1); assert.equal(result.counts.addedPhone, 1); assert.equal(result.counts.addedTelegram, 1);
    const actual = JSON.stringify([f.target('email').data, f.target('phone').data]);
    assert.match(actual, /allowed@example\.test/); assert.match(actual, /@working_user/);
    assert.doesNotMatch(actual, /hidden@example|raw_dir|74950000002|79990000003/);
  }
});

function slowWholeSourceFixture(chunkMillis) {
  const clock = { now: 0, reading: false }, modelReads = [];
  const f = fixture({ realExtractor: true,
    rows: [['Компания', 'Email', 'Телефон'], ['One', 'one@example.test', ''], ['Two', 'two@example.test', '']],
    secondSource: [['Компания', 'Email', 'Телефон'], ['Three', 'three@example.test', ''], ['Four', 'four@example.test', '']],
    onRead({ sheetId }) { if (clock.reading && [0, 9].includes(sheetId)) clock.now += chunkMillis; }
  });
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } }
  f.context.Date = Clock;
  f.context.PREPARED_DATA_LIMITS = { ...f.context.PREPARED_DATA_LIMITS, chunkCells: 6 };
  const workbookRead = f.context.preparedDataReadWorkbook_, leafRead = f.context.preparedDataRead_;
  f.context.preparedDataReadWorkbook_ = (...args) => {
    modelReads.push({ deadline: args[3].deadline, leaves: [] }); clock.reading = true;
    try { return workbookRead(...args); } finally { clock.reading = false; }
  };
  f.context.preparedDataRead_ = (...args) => {
    modelReads.at(-1).leaves.push({ sheetId: args[0].getSheetId(), deadline: args[3].deadline });
    return leafRead(...args);
  };
  return { ...f, clock, modelReads };
}

test('an unmanaged workbook keeps an original tab named Email and creates separate managed lists', () => {
  const f = fixture({ sourceName: 'Email' }), before = plain(f.book.tabs[0].data), r = f.finish();
  assert.equal(r.counts.addedEmail, 1); assert.equal(r.counts.addedPhone, 1); assert.equal(r.counts.addedTelegram, 1);
  assert.deepEqual(f.book.tabs[0].data, before); assert.equal(f.target('email').getName(), 'Email — контакты');
  assert.equal(f.book.tabs.length, 3);
  assert.equal(f.target('phone').data[1][0], '+79990000001');
  assert.equal(f.target('phone').data[2][5], '@person_1');
});

test('a completed selection keeps its row filtering and existing phone and email results on enrollment and append', () => {
  const email = ['Статус', 'Комментарий', 'Почт на компанию', 'Строки в Лист1', 'Компания', 'Email', 'Валидация', 'Провайдер', 'Сайты', 'ID компании'];
  const phone = ['Статус', 'Строки в Лист1', 'Компания', 'Мобильный телефон', 'ID_TG', 'Nickname_TG', 'Active_days_ago', 'Сайты', 'ID компании'];
  const companyId = 'C-' + 'g'.repeat(24);
  const rows = [['Названия', 'Email-адреса', 'Мобильные телефоны', 'Городские телефоны', 'ID компании'],
    ['One', 'one@example.test', '+79990000001', '+74951234567', companyId],
    ['Omitted', 'excluded@example.test', '+79990000002', '', '']];
  const oldEmail = ['в рассылке', 'Manual', '1', '2', 'One', 'one@example.test', 'valid', 'Example', '', companyId];
  const oldPhone = ['фильтр', '2', 'One', '+79990000001', '0', '', '0', '', companyId];
  const f = fixture({ realExtractor: true, rows, phoneName: 'Мобильные телефоны', emailRows: [email, oldEmail], phoneRows: [phone, oldPhone] });
  assert.deepEqual(f.invoke('getContactWorkspace_', {id: FILE}).sourceSheetIds, [0]);
  f.finish();
  assert.equal(f.book.tabs.length, 3);
  assert.deepEqual(f.target('email').data.slice(1), [oldEmail]);
  assert.deepEqual(f.target('phone').data.slice(1), [oldPhone]);
  f.editSource(rows.slice(1).concat([['One', 'two@example.test', '+79990000003', '+74959876543', companyId]]));
  f.finish('sync_selection_second');
  for (const [kind, key, value] of [['email', 'Email', 'two@example.test'], ['phone', 'Мобильный телефон', '+79990000003']]) {
    const [headers, , added] = f.target(kind).data;
    assert.equal(f.target(kind).data.length, 3);
    assert.equal(added[headers.indexOf(key)], value);
    assert.equal(added[headers.indexOf('ID компании')], companyId);
    assert.equal(added[headers.indexOf('Статус')], 'Новый контакт');
  }
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
  assert.equal(f.target('phone').data.find(row => row[0] === '+79990000002')[5], 'Новый контакт');
  assert.equal(f.target('email').data.find(row => row[0] === 'new@example.test')[5], 'Новый контакт');
  assert.equal(f.target('phone').data.find(row => row[6] === '@new_person')[5], 'Новый контакт');
});

test('opting in while opening managed legacy contact tabs fills only blank statuses without provider work', () => {
  const f = fixture({ legacy: true, nativeDropdown: true, provider: true,
    emailRows: [EMAIL.concat(['Статус', 'Статус из источника']), ['one@example.test', '', '', '', 'Ручной'], ['two@example.test', '', '', '', '', 'Фильтр'],
      ['formula@example.test'], ['new@example.test'], ['', '', 'Примечание']],
    phoneRows: [PHONE.slice(0, 5).concat('Рассылка'), ['+79990000001', '', '', '', '', 'Кампания Б']] });
  const email = f.book.getSheetByName('Email'), phone = f.book.getSheetByName('Телефоны');
  email.formulas['4:5'] = '=""';
  const customRule = { allowed: 'Ручной' };
  email.validations['2:5'] = customRule;
  f.context.contactSyncWithLease_(FILE, () => null, true);
  Object.assign(f.resources.get(FILE).appProperties, { registryContactEmailSheetId: '1', registryContactPhoneSheetId: '2' });
  assert.equal(f.invoke('getContactWorkspace_', { id: FILE }).enrolled, true);
  assert.equal(f.calls.raw.length, 0);
  assert.equal(f.invoke('getContactWorkspace_', { id: FILE, prepareMailingStatus: true }).mailingStatusChanged, true);
  assert.equal(email.data[0][4], 'Статус');
  assert.equal(email.data[1][4], 'Ручной');
  assert.equal(email.data[2][4], 'фильтр');
  assert.equal(email.data[2][5], 'Фильтр');
  assert.equal(email.formulas['4:5'], '=""');
  assert.equal(email.data[4][4], 'Новый контакт');
  assert.equal(email.data[5][4], undefined);
  assert.deepEqual(phone.data[0].slice(5), ['Рассылка', 'Статус рассылки']);
  assert.deepEqual(phone.data[1].slice(5), ['Кампания Б', 'Новый контакт']);
  assert.equal(email.validations['2:5'], customRule);
  assert.equal(email.validations['4:5'], null);
  assert.deepEqual(email.validations['3:5'], { values: ['Новый контакт', 'в рассылке', 'фильтр'], dropdown: true, allowInvalid: false });
  assert.equal(f.calls.provider.length, 0);
  const writes = f.calls.raw.length;
  assert.equal(f.invoke('getContactWorkspace_', { id: FILE, prepareMailingStatus: true }).mailingStatusChanged, false);
  assert.equal(f.calls.raw.length, writes);
});

test('opening an unenrolled legacy workbook creates no contact status columns or artifacts', () => {
  const f = fixture({ legacy: true, emailRows: [EMAIL, ['one@example.test']] });
  const r = f.invoke('getContactWorkspace_', { id: FILE, prepareMailingStatus: true });
  assert.equal(r.mailingStatusChanged, false);
  assert.equal(r.enrolled, false);
  assert.deepEqual(f.calls.mutations, []);
  assert.deepEqual(f.calls.raw, []);
});

test('manual rows on enrolled email and phone tabs get the same default before preview or sync without reopening old decisions', () => {
  const f = fixture({ realExtractor:true });
  f.finish();
  const email = f.target('email'), phone = f.target('phone');
  const makeRow = (sheet,fields) => sheet.data[0].map(label => fields[label] || '');
  email.data.push(makeRow(email,{Email:'manual@example.test'}), makeRow(email,{Email:'excluded@example.test','Статус рассылки':'фильтр'}),
    makeRow(email,{Email:'checked@example.test','Валидация':'Валиден'}),makeRow(email,{Email:'older@example.test','Статус рассылки':'новый'}));
  phone.data.push(makeRow(phone,{'Телефон':'+79997654321'}));
  const status = sheet => sheet.data[0].indexOf('Статус рассылки');
  const first = f.invoke('getContactWorkspace_',{id:FILE,prepareNewContactStatuses:true});
  assert.equal(first.mailingStatusChanged,true);
  assert.deepEqual(email.data.slice(-4).map(row=>row[status(email)]),['Новый контакт','фильтр','','новый']);
  assert.equal(phone.data.at(-1)[status(phone)],'Новый контакт');
  assert.equal(f.invoke('getContactWorkspace_',{id:FILE,prepareNewContactStatuses:true}).mailingStatusChanged,false);
  email.data.push(makeRow(email,{Email:'second@example.test'}));
  f.finish('sync_after_manual_row');
  assert.equal(email.data.find(row=>row.includes('second@example.test'))[status(email)],'Новый контакт');
  assert.equal(f.calls.provider.length,0);
});

test('a strict legacy dropdown accepts the new default on appended rows and preserves a custom rule',()=>{
  const f=fixture({nativeDropdown:true,realExtractor:true});f.finish();
  f.context.SpreadsheetApp.DataValidationCriteria={VALUE_IN_LIST:'list'};
  const email=f.target('email'), column=email.data[0].indexOf('Статус рассылки')+1,start=email.data.length+1;
  const old={getCriteriaType:()=>'list',getAllowInvalid:()=>false,getHelpText:()=>'',
    getCriteriaValues:()=>[['новый','в рассылке','фильтр'],true]};
  const custom={...old,getHelpText:()=>'Личный список'};
  email.validations[start+':'+column]=old;email.validations[(start+1)+':'+column]=custom;
  f.editSource([['new@example.test','','']]);f.finish('legacy_rule_append_1234');
  assert.equal(email.data[start-1][column-1],'Новый контакт');
  assert.deepEqual(email.validations[start+':'+column].values,['Новый контакт','в рассылке','фильтр']);
  assert.equal(email.validations[(start+1)+':'+column],custom);
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

test('segment contact materialization resumes committed batches without validation or duplicate contacts', () => {
  const segment = SOURCES, request = 'segment_contact_request_1234567890';
  const rows = [['Email', 'Телефон', 'Telegram'], ...Array.from({ length: 1001 }, (_, index) => ['company' + index + '@example.test', '+79' + String(index).padStart(9, '0'), ''])];
  const f = fixture({ rows, provider: true });
  f.context.enrollContactWorkbook_(f.scope, FILE, { sourceSheetIds: [0], role: 'segment-companies', section: 'companies', segmentId: segment });
  f.context.emailValidationProvider_ = () => 'coldy'; f.context.queueColdyWorkbookValidation_ = () => assert.fail('unexpected provider scan');
  const step = () => f.context.contactSyncSegmentImportStep_(FILE, 'companies', segment, request);
  assert.throws(() => f.context.contactSyncSegmentImportStep_(FILE, 'lpr', segment, request), /SEGMENT_MASTER_CHANGED/);
  f.options.writeFault = 'after';
  assert.throws(step, /write reply lost/); assert.ok(f.state().job.pending);
  let done = false, calls = 0;
  while (!done && calls++ < 15) done = step();
  assert.equal(done, true); assert.equal(f.calls.provider.length, 0);
  for (const [kind, label] of [['email', 'Email'], ['phone', 'Телефон']]) {
    const [headers, ...contacts] = f.target(kind).data;
    assert.equal(contacts.length, 1001); assert.equal(new Set(contacts.map(row => row[headers.indexOf(label)])).size, 1001);
    assert.ok(contacts.every(row => row[headers.indexOf('Статус рассылки')] === 'Новый контакт'));
  }
  const writes = f.calls.raw.length; assert.equal(step(), true); assert.equal(f.calls.raw.length, writes);
});

test('a previous contact job finishes before the segment takes its own snapshot', () => {
  const f = fixture({ provider: true }), segment = SOURCES;
  f.context.enrollContactWorkbook_(f.scope, FILE, { sourceSheetIds: [0], role: 'segment-companies', section: 'companies', segmentId: segment });
  assert.equal(f.start('previous_contact_request').state, 'processing');
  const step = () => f.context.contactSyncSegmentImportStep_(FILE, 'companies', segment, 'next_segment_request');
  assert.equal(step(), false);
  let done = false;
  for (let index = 0; !done && index < 20; index++) done = step();
  assert.equal(done, true);
  assert.deepEqual(f.state().receipts.map(receipt => [receipt.requestId, receipt.status]), [
    ['previous_contact_request', 'complete'], ['next_segment_request', 'complete']
  ]);
  assert.equal(f.calls.provider.length, 1);
});

test('a literal master email receiving its own mailto decoration after target writes completes the same segment receipt', () => {
  const f = fixture({realExtractor:true, rows:[['Компания','Email','Телефон'],['Компания','one@example.test','+79991110001']]});
  f.context.enrollContactWorkbook_(f.scope, FILE, {sourceSheetIds:[0], role:'segment-companies', section:'companies', segmentId:SOURCES});
  const complete = f.context.contactSyncComplete_;
  let changed = false;
  f.context.contactSyncComplete_ = (claim, plan) => {
    if (!changed) {
      const original = claim.state.job.sourceFingerprint;
      f.book.tabs[0].links['2:2'] = 'mailto:one@example.test';
      assert.notEqual(f.context.contactSyncStableModel_(claim).model.fingerprint, original);
      changed = true;
    }
    return complete(claim, plan);
  };
  const step = () => f.context.contactSyncSegmentImportStep_(FILE, 'companies', SOURCES, 'literally_the_same_master');
  let done = false;
  for (let i = 0; i < 10 && !done; i++) done = step();
  assert.ok(done && changed); assert.equal(f.state().dirty, false);
  assert.equal(f.target('email').getLastRow(), 2); assert.equal(f.target('phone').getLastRow(), 2);
  assert.ok(step()); assert.equal(f.state().receipts.length, 1);
});

test('a new hidden hyperlink or a changed source formula invalidates a segment master snapshot', () => {
  for (const change of [
    f => { f.book.tabs[0].links['2:2'] = 'mailto:other@example.test'; },
    f => { f.book.tabs[0].formulas['2:2'] = '="one@example.test"'; }
  ]) {
    const f = fixture({realExtractor:true, rows:[['Компания','Email'],['Одна','one@example.test']]});
    f.context.enrollContactWorkbook_(f.scope, FILE, {sourceSheetIds:[0], role:'segment-companies', section:'companies', segmentId:SOURCES});
    const complete = f.context.contactSyncComplete_;
    f.context.contactSyncComplete_ = (claim, plan) => { change(f); return complete(claim, plan); };
    assert.throws(() => {
      for (let i=0; i<10; i++) f.context.contactSyncSegmentImportStep_(FILE, 'companies', SOURCES, 'changed_hidden_source');
    }, /CONTACT_SOURCE_CHANGED/);
    assert.equal(f.state().receipts.length, 0);
  }
});

test('workbook version churn at the final segment contact step waits then finishes the original request', () => {
  const f = fixture(), complete = f.context.contactSyncComplete_;
  f.context.enrollContactWorkbook_(f.scope, FILE, {sourceSheetIds:[0], role:'segment-companies', section:'companies', segmentId:SOURCES});
  f.context.contactSyncComplete_ = (claim, plan) => {
    f.context.contactSyncComplete_ = complete;
    f.options.onModel = () => { const file=f.resources.get(FILE); file.version=String(Number(file.version)+1); };
    return complete(claim, plan);
  };
  const step = () => f.context.contactSyncSegmentImportStep_(FILE, 'companies', SOURCES, 'version_churn_original_request');
  for (let i=0; i<10 && f.state().job?.phase!=='complete'; i++) assert.equal(step(),false);
  assert.equal(f.state().job.phase,'complete'); assert.equal(f.state().receipts.length,0);
  f.options.onModel = null;
  assert.ok(step()); assert.ok(step()); assert.equal(f.state().receipts.length,1);
  assert.equal(f.target('email').getLastRow(),2);
});

test('a concurrent edit to the master cannot publish a completed import contact receipt', () => {
  const segment = SOURCES, f = fixture(), complete = f.context.contactSyncComplete_;
  f.context.enrollContactWorkbook_(f.scope, FILE, { sourceSheetIds: [0], role: 'segment-companies', section: 'companies', segmentId: segment });
  f.context.contactSyncComplete_ = (claim, plan) => {
    f.context.contactSyncComplete_ = complete;
    f.editSource([['changed@example.test', '', '']]);
    return complete(claim, plan);
  };
  const step = requestId => f.context.contactSyncSegmentImportStep_(FILE, 'companies', segment, requestId);
  assert.throws(() => { for (let index = 0; index < 15 && !step('changed_master_import'); index++) {} }, /CONTACT_SOURCE_CHANGED/);
  assert.equal(f.state().receipts.some(entry => entry.requestId === 'changed_master_import'), false);
  let done = false;
  for (let index = 0; !done && index < 15; index++) done = step('refreshed_master_import');
  assert.equal(done, true);
  assert.equal(f.state().receipts.find(entry => entry.requestId === 'changed_master_import').status, 'superseded');
});

test('a workbook moved to another authorized folder stops before a segment contact append', () => {
  const f = fixture(), append = f.context.contactSyncWritePending_, grid = f.context.gridFile_;
  f.context.enrollContactWorkbook_(f.scope, FILE, { sourceSheetIds: [0], role: 'segment-companies', section: 'companies', segmentId: SOURCES });
  let moved = false;
  f.context.gridFile_ = (...args) => moved ? { context: f.scope, canEdit: true } : grid(...args);
  f.context.contactSyncWritePending_ = claim => {
    f.resources.get(FILE).parents = [ROOT]; moved = true;
    return append(claim);
  };
  assert.throws(() => f.context.contactSyncSegmentImportStep_(FILE, 'companies', SOURCES, 'relocated_book_import'), /SEGMENT_MASTER_CHANGED/);
  assert.equal(f.target('email').getLastRow(), 1); assert.equal(f.state().receipts.length, 0);
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

test('contact sync reads slow whole sources within one 120-second budget while other reader calls retain 45 seconds', () => {
  const f = slowWholeSourceFixture(25000);
  const defaultRead = f.context.preparedDataReadWorkbook_(f.book, FILE, 'companies', { sourceSheetIds: [0, 9] });
  assert.equal(defaultRead.complete, false); assert.equal(f.context.PREPARED_DATA_LIMITS.maxMillis, 45000);
  f.clock.now = 0; f.modelReads.length = 0;
  const result = f.finish(); assert.equal(result.counts.addedEmail, 4);
  assert.ok(f.modelReads.length > 0);
  for (const read of f.modelReads) {
    assert.equal(read.leaves.length, 2);
    assert.deepEqual(read.leaves.map(leaf => leaf.sheetId), [0, 9]);
    assert.ok(read.leaves.every(leaf => leaf.deadline === read.deadline), 'all leaves/chunks receive the same absolute deadline');
  }
  assert.equal(f.modelReads[0].deadline, 120000);
  assert.ok(f.clock.now >= 100000, 'the full extraction really takes longer than the default 45 seconds');
});

test('contact sync rejects an over-budget partial multi-leaf source before writing any contacts', () => {
  const f = slowWholeSourceFixture(35000), before = plain(f.book.tabs.map(sheet => sheet.data));
  assert.throws(() => f.start(), /CONTACT_SOURCE_INCOMPLETE/);
  assert.equal(f.modelReads[0].deadline, 120000);
  assert.ok(f.modelReads[0].leaves.every(leaf => leaf.deadline === 120000));
  assert.ok(f.clock.now >= 120000);
  assert.equal(f.calls.raw.filter(call => call.row > 1).length, 0);
  assert.deepEqual(f.book.tabs.slice(0, 2).map(sheet => sheet.data), before, 'source data is unchanged');
});

test('a source-version retry shares the original contact-read deadline instead of gaining another 120 seconds', () => {
  const f = slowWholeSourceFixture(25000), extract = f.context.preparedDataReadWorkbook_; let changed = false;
  f.context.preparedDataReadWorkbook_ = (...args) => {
    const model = extract(...args);
    if (!changed) { changed = true; f.resources.get(FILE).version = String(Number(f.resources.get(FILE).version) + 1); }
    return model;
  };
  assert.throws(() => f.start(), /CONTACT_SOURCE_INCOMPLETE/);
  assert.equal(f.modelReads.length, 2);
  assert.deepEqual(f.modelReads.map(read => read.deadline), [120000, 120000]);
  assert.equal(f.calls.raw.filter(call => call.row > 1).length, 0);
});

test('the longer contact-read budget still rejects a source moved outside the registry during reading', () => {
  const f = slowWholeSourceFixture(25000), onRead = f.options.onRead;
  f.options.onRead = read => { onRead(read); if (f.clock.reading) f.resources.get(FILE).parents = [OUTSIDE]; };
  assert.throws(() => f.start(), /OUTSIDE_REGISTRY/);
  assert.equal(f.calls.raw.filter(call => call.row > 1).length, 0);
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
  assert.equal(f.target('email').data[1][f.target('email').data[0].indexOf('Email')], 'company@example.test');
  assert.equal(f.target('phone').data[1][f.target('phone').data[0].indexOf('Телефон')], '+79990000001');
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

test('an enrolled workspace opens no spreadsheet and reads no contact rows or source models', () => {
  const f = fixture(); f.finish(); const stored = f.state();
  stored.known = Array.from({ length: 25000 }, (_, index) => f.context.digest_('known-' + index)); f.saveState(stored);
  const before = { opened: f.calls.opened.length, reads: f.calls.reads.length, models: f.calls.model, writes: f.calls.raw.length, updates: f.calls.updates.length };
  const workspace = f.invoke('getContactWorkspace_', { id: FILE });
  assert.equal(workspace.enrolled, true); assert.deepEqual(workspace.targets, stored.targets); assert.equal(workspace.counts.addedEmail, 1);
  assert.equal(f.calls.opened.length, before.opened); assert.equal(f.calls.reads.length, before.reads); assert.equal(f.calls.model, before.models);
  assert.equal(f.calls.raw.length, before.writes); assert.equal(f.calls.updates.length, before.updates); assert.equal(f.state().known.length, 25000, 'history is neither rebuilt nor rewritten for presentation');
});

test('unenrolled and legacy workspace discovery still opens the book lazily without enrollment or writes', () => {
  for (const legacy of [false, true]) {
    const f = fixture({ legacy }), workspace = f.invoke('getContactWorkspace_', { id: FILE });
    assert.equal(workspace.enrolled, false); assert.equal(f.calls.opened.length, 1); assert.deepEqual(workspace.sourceSheetIds, [0]);
    if (legacy) assert.deepEqual(workspace.targets, { emailSheetId: 1, phoneSheetId: 2 });
    assert.equal(f.calls.model, 0); assert.equal(f.calls.raw.length, 0); assert.equal(f.calls.mutations.length, 0);
  }
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
  assert.deepEqual(f.target('email').data.slice(1).map(row => row[f.target('email').data[0].indexOf('Email')]), ['general@example.test']);
  assert.deepEqual(f.book.tabs[0].data, rows);
});

test('a renamed fixed company master keeps generic contacts general despite an LPR sheet name', () => {
  const rows = [['Компания', 'Email', 'Телефон'], ['Альфа', 'general@example.test', '+79990000001']];
  const f = fixture({ realExtractor: true, sourceName: 'ЛПР — пользовательское название', rows });
  f.context.enrollContactWorkbook_(f.scope, FILE, { sourceSheetIds: [0], role: 'segment-companies', section: 'companies' });
  const r = f.finish();
  assert.equal(r.counts.addedEmail, 1); assert.equal(r.counts.addedPhone, 1);
  assert.deepEqual(f.target('email').data.slice(1).map(row => row[f.target('email').data[0].indexOf('Email')]), ['general@example.test']);
  assert.deepEqual(f.target('phone').data.slice(1).map(row => row[f.target('phone').data[0].indexOf('Телефон')]), ['+79990000001']);
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

test('unchanged seeded enrollment with GID zero skips leases, writes and contact-row scans', () => {
  const f = fixture({ sourceSheetId: 9, emailSheetId: 0, emailRows: [EMAIL, ['one@example.test', 'Manual company', 'Manual source', '']], phoneRows: [PHONE.concat(['Статус', 'Дата']), ['+79990000001', '', '', '', '', '', 'Телефон', 'запущен', new Date('2026-01-02')]] });
  const options = { sourceSheetIds: [9], emailSheetId: 0, phoneSheetId: 2, role: 'segment-companies', section: 'companies', segmentId: 'segment_1234567890', relatedFileId: 'linked_lpr_1234567890', seedExisting: true };
  f.context.enrollContactWorkbook_(f.scope, FILE, options);
  f.target('email').data.splice(1, 1);
  f.target('email').data.push(['manual@example.test', 'Manual addition']);
  const before = { state: f.state(), raw: f.calls.raw.length, updates: f.calls.updates.length, locks: f.calls.lockAttempts, reads: f.calls.reads.length, phone: f.target('phone').data[1].slice() };
  f.options.busy = true;
  const workspace = plain(f.context.enrollContactWorkbook_(f.scope, FILE, options));
  assert.equal(workspace.enrolled, true); assert.equal(workspace.targets.emailSheetId, 0);
  assert.equal(f.calls.lockAttempts, before.locks); assert.equal(f.calls.updates.length, before.updates); assert.equal(f.calls.raw.length, before.raw);
  assert.deepEqual(f.calls.reads.slice(before.reads).map(read => read.row), [1, 1]);
  assert.deepEqual(f.state(), before.state); assert.deepEqual(f.target('phone').data[1], before.phone);
  f.options.busy = false;
  const synced = f.finish('after_fast_enrollment_12345');
  assert.equal(synced.counts.excluded, 1);
  assert.deepEqual(f.target('email').data.slice(1).map(row => row[0]), ['manual@example.test']);
});

test('changed enrollment options retain the leased update path', () => {
  const cases = [
    { role: 'segment-lpr' }, { section: 'lpr' }, { segmentId: 'other_segment_1234567890' },
    { relatedFileId: 'other_related_1234567890' }, { sourceSheetIds: [0, 9] }, { sourceMode: 'all' }
  ];
  for (const change of cases) {
    const f = fixture({ secondSource: [['Email'], ['two@example.test']] });
    const initial = { sourceSheetIds: [0], role: 'registry', section: 'companies', segmentId: 'segment_1234567890', relatedFileId: 'related_1234567890', seedExisting: true };
    f.context.enrollContactWorkbook_(f.scope, FILE, initial);
    const locks = f.calls.lockAttempts, updates = f.calls.updates.length;
    f.context.enrollContactWorkbook_(f.scope, FILE, { ...initial, ...change });
    assert.ok(f.calls.lockAttempts > locks, JSON.stringify(change)); assert.ok(f.calls.updates.length > updates, JSON.stringify(change));
    for (const [key, value] of Object.entries(change)) assert.deepEqual(f.state()[key], value);
  }
});

test('unseeded enrollment and a changed access hash cannot use the read-only fast path', () => {
  for (const change of ['unseeded', 'accessHash']) {
    const f = fixture(), options = { sourceSheetIds: [0], seedExisting: true };
    f.context.enrollContactWorkbook_(f.scope, FILE, options);
    if (change === 'unseeded') { const state = f.state(); state.seeded = false; f.saveState(state); }
    else f.context.SHARED_REQUEST_SCOPE_.keyHash = 'B'.repeat(43);
    const locks = f.calls.lockAttempts, updates = f.calls.updates.length;
    f.context.enrollContactWorkbook_(f.scope, FILE, options);
    assert.ok(f.calls.lockAttempts > locks); assert.ok(f.calls.updates.length > updates); assert.equal(f.state().seeded, true);
    const tags = f.resources.get(f.state().stateFileId).appProperties;
    assert.equal(tags.registryContactAccessHash, f.context.SHARED_REQUEST_SCOPE_.keyHash);
  }
});

test('active jobs and outstanding leases retain their original enrollment behavior', () => {
  const f = fixture(), running = f.start(), locks = f.calls.lockAttempts, raw = f.calls.raw.length;
  const workspace = plain(f.context.enrollContactWorkbook_(f.scope, FILE, { sourceSheetIds: [0], seedExisting: true }));
  assert.ok(f.calls.lockAttempts > locks); assert.equal(workspace.job.jobId, running.jobId); assert.equal(f.calls.raw.length, raw);
  const state = f.state(); state.job = null; state.lease = { id: 'foreign_lease', until: Date.now() + 500000 }; f.saveState(state);
  assert.throws(() => f.context.enrollContactWorkbook_(f.scope, FILE, { sourceSheetIds: [0], seedExisting: true }), /BUSY/);
  assert.equal(f.state().lease.id, 'foreign_lease');
});

test('enrolled deleted targets, replaced target IDs and renamed headers fail closed instead of taking the fast path', () => {
  for (const mode of ['deleted', 'replaced', 'renamed']) {
    const f = fixture(), options = { sourceSheetIds: [0], seedExisting: true };
    f.context.enrollContactWorkbook_(f.scope, FILE, options);
    const locks = f.calls.lockAttempts, raw = f.calls.raw.length;
    if (mode === 'deleted') f.book.tabs.splice(f.book.tabs.findIndex(tab => tab.getSheetId() === f.state().targets.emailSheetId), 1);
    if (mode === 'replaced') options.emailSheetId = 0;
    if (mode === 'renamed') f.target('email').data[0][0] = 'Changed manually';
    assert.throws(() => f.context.enrollContactWorkbook_(f.scope, FILE, options), /GRID_SHEET_MISSING|CONTACT_SCHEMA_CHANGED/);
    assert.ok(f.calls.lockAttempts > locks); assert.equal(f.calls.raw.length, raw);
  }
});

test('fast enrollment rechecks ancestry and validates its private state rather than trusting cached pointers', () => {
  const f = fixture(), options = { sourceSheetIds: [0], seedExisting: true };
  f.context.enrollContactWorkbook_(f.scope, FILE, options);
  const updates = f.calls.updates.length, locks = f.calls.lockAttempts;
  f.options.onRead = () => { f.resources.get(FILE).parents = [OUTSIDE]; };
  assert.throws(() => f.context.enrollContactWorkbook_(f.scope, FILE, options), /OUTSIDE_REGISTRY/);
  assert.equal(f.calls.updates.length, updates); assert.equal(f.calls.lockAttempts, locks);
  f.resources.get(FILE).parents = [SOURCES]; f.options.onRead = null;
  f.resources.get(f.state().stateFileId).parents = [OUTSIDE];
  assert.throws(() => f.context.enrollContactWorkbook_(f.scope, FILE, options), /OUTSIDE_REGISTRY/);
  assert.equal(f.calls.updates.length, updates);
});
