import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const ROOT = '1WKcvDDKqYBo94eXsYc5vKp6OPtOzv6Wh';
const SOURCE = '1deuP0ovOC70PrElQKZjSjuvSMgPF0J7r';
const SERVICE = '1lzbjoPNnrVn5-8GoAhaLZPS_S8J0lfcaoO8Ybxw396M';
const ORIGINAL = 'original_native_source_1234567890';
const OUTSIDE = 'external_parent_folder_1234567890';
const MIME = 'application/vnd.google-apps.spreadsheet';
const FOLDER = 'application/vnd.google-apps.folder';
const KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const plain = value => JSON.parse(JSON.stringify(value));
const iterator = values => { let i = 0; return { hasNext: () => i < values.length, next: () => values[i++] }; };

function fixture(options = {}) {
  let serial = 0, sheetSerial = 100;
  const resources = new Map(), books = new Map(), records = new Map();
  const properties = new Map([['ROOT_FOLDER_ID', ROOT], ['SOURCE_BASES_FOLDER_ID', SOURCE], ['SHARED_ACCESS_KEY_SHA256', crypto.createHash('sha256').update(KEY).digest('base64url')]]);
  const calls = { actions: [], opens: [], writes: [], copies: 0, locks: 0 };
  const store = { getProperty: name => properties.get(name) ?? null, setProperty: (name, value) => { properties.set(name, String(value)); return store; }, deleteProperty: name => properties.delete(name) };
  const context = vm.createContext({ console, Date, JSON, Object, Array, Number, String, Boolean, RegExp, Math, Error, Set, Map, encodeURIComponent, decodeURIComponent });
  function resource(id, name, mime, parents, extra = {}) {
    const value = { id, name, mimeType: mime, parents: [...parents], appProperties: {}, trashed: false, version: '1', capabilities: { canCopy: true, canEdit: true, canAddChildren: true }, ...extra };
    resources.set(id, value); return value;
  }
  resource(ROOT, 'Реестр баз', FOLDER, []); resource(SOURCE, 'Исходные базы', FOLDER, [ROOT]);
  resource(OUTSIDE, 'Внешняя папка', FOLDER, []); resource(SERVICE, 'Служебный реестр', MIME, [ROOT]);
  resource(ORIGINAL, 'Источник', MIME, [options.outside ? OUTSIDE : SOURCE]);
  function sheet(id, name, rows, book, formulas = {}) {
    const data = rows.map(row => row.slice()); let maxRows = Math.max(1000, data.length), maxColumns = Math.max(26, ...data.map(row => row.length));
    const formulaMap = { ...formulas };
    const api = {
      state: { data, formulaMap }, getSheetId: () => id, getName: () => name, getParent: () => book,
      getLastRow: () => { for (let i = data.length - 1; i >= 0; i--) if (data[i]?.some(value => value !== '' && value !== null && value !== undefined)) return i + 1; return 0; },
      getLastColumn: () => Math.max(0, ...data.map(row => { for (let i = row.length - 1; i >= 0; i--) if (row[i] !== '' && row[i] !== null && row[i] !== undefined) return i + 1; return 0; })),
      getMaxRows: () => maxRows, getMaxColumns: () => maxColumns,
      insertRowsAfter: (_position, count) => { maxRows += count; }, insertColumnsAfter: (_position, count) => { maxColumns += count; },
      setName(value) { if (book.tabs.some(tab => tab !== api && tab.getName() === value)) throw Error('Duplicate sheet'); name = value; return api; },
      setFrozenRows() { return api; },
      copyTo(destination) {
        calls.copies++;
        const copied = sheet(++sheetSerial, 'Копия ' + name, data, destination, formulaMap); destination.tabs.push(copied);
        if (options.loseSheetCopy) { options.loseSheetCopy = false; throw Error('Lost copy reply'); }
        return copied;
      },
      getRange(row, column, height = 1, width = 1) {
        const values = () => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => data[row - 1 + r]?.[column - 1 + c] ?? ''));
        const write = (rows, rich) => {
          calls.writes.push({ sheet: id, row, column, rows: plain(rows), rich });
          for (let r = 0; r < height; r++) { while (data.length < row + r) data.push([]); for (let c = 0; c < width; c++) { const value = rows[r][c], text = rich ? value.getText() : value; data[row - 1 + r][column - 1 + c] = rich && options.nativeRichTextPrefix && /^\+/.test(text) ? '=' + text : text; delete formulaMap[(row + r) + ':' + (column + c)]; } }
          if (options.loseWrite) { options.loseWrite = false; throw Error('Lost write reply'); }
        };
        const range = { getValues: values, getDisplayValues: () => values().map(line => line.map(value => value === null || value === undefined ? '' : String(value))), getRichTextValues: () => Array.from({ length: height }, () => Array(width).fill(null)), getFormulas: () => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => formulaMap[(row + r) + ':' + (column + c)] || '')), getFormula: () => formulaMap[row + ':' + column] || '', getValue: () => values()[0][0], setNumberFormat: () => range, setValues(rows) { write(rows, false); return range; }, setValue(value) { write([[value]], false); return range; }, setRichTextValues(rows) { write(rows, true); return range; }, setRichTextValue(value) { write([[value]], true); return range; } };
        return range;
      }
    };
    return api;
  }
  function book(id, rows = null) {
    const api = { tabs: [], getId: () => id, getSheets: () => api.tabs.slice(), getSheetByName: name => api.tabs.find(tab => tab.getName() === name) || null, insertSheet: name => { const created = sheet(++sheetSerial, name, [], api); api.tabs.push(created); return created; }, setActiveSheet(value) { api.active = value; }, moveActiveSheet(position) { const at = api.tabs.indexOf(api.active); api.tabs.splice(at, 1); api.tabs.splice(position - 1, 0, api.active); }, setSpreadsheetTimeZone() {}, getSpreadsheetTimeZone: () => 'Europe/Moscow', setSpreadsheetLocale() {}, getSpreadsheetLocale: () => 'ru_RU' };
    api.tabs.push(sheet(0, rows ? 'Компании' : 'Лист1', rows || [], api)); books.set(id, api); return api;
  }
  const originalBook = book(ORIGINAL, [['Company_ID', 'Название', 'Email', 'Телефон'], ['A', 'Компания А', 'a@example.test', '+79991112233'], ['A', 'Компания А', 'a@example.test', '+79991112233']]);
  originalBook.tabs.push(sheet(9, 'ЛПР', [['Company_ID', 'Название', 'Email', 'Телефон'], ['B', 'Компания Б', 'person@example.test', '+79994445566']], originalBook));
  function driveObject(id) {
    const item = resources.get(id); if (!item) throw Error('Missing file');
    return { getId: () => id, getName: () => item.name, getMimeType: () => item.mimeType, getUrl: () => `https://docs.google.com/spreadsheets/d/${id}/edit`, isTrashed: () => item.trashed, getParents: () => iterator(item.parents.map(driveObject)), getFolders: () => iterator([...resources.values()].filter(candidate => candidate.mimeType === FOLDER && candidate.parents.includes(id)).map(candidate => driveObject(candidate.id))), getFilesByType: mime => iterator([...resources.values()].filter(candidate => candidate.mimeType === mime && candidate.parents.includes(id)).map(candidate => driveObject(candidate.id))), getBlob: () => ({ getDataAsString: () => item.content || '' }) };
  }
  const advanced = {
    get(id) { const found = resources.get(id); if (!found) throw Error('Missing file'); if (typeof options.onGet === 'function') options.onGet(id, found); return plain(found); },
    list(params = {}) {
      if (options.hideRecovery) return { files: [] };
      const filters = [...String(params.q || '').matchAll(/key='([^']+)' and value='([^']+)'/g)];
      const parent = String(params.q || '').match(/'([^']+)' in parents/);
      const files = [...resources.values()].filter(item => !item.trashed && (!parent || item.parents.includes(parent[1])) && filters.every(match => item.appProperties[match[1]] === match[2]));
      return { files: plain(files) };
    },
    create(metadata, body) {
      const id = 'prepared_file_' + (++serial) + '_1234567890';
      const item = resource(id, metadata.name, metadata.mimeType, metadata.parents || [], { appProperties: plain(metadata.appProperties || {}), content: body?.getDataAsString ? body.getDataAsString() : '' });
      calls.actions.push({ kind: 'create', id, role: item.appProperties.registryPreparedRole, mime: item.mimeType });
      if (metadata.mimeType === MIME) book(id, body ? originalBook.tabs[0].state.data : null);
      if (options.loseCreateRole === item.appProperties.registryPreparedRole) { options.loseCreateRole = null; throw Error('Lost create reply'); }
      return plain(item);
    },
    copy(metadata, originalId) {
      const original = resources.get(originalId), id = 'prepared_file_' + (++serial) + '_1234567890';
      const item = resource(id, metadata.name, original.mimeType, metadata.parents, { appProperties: plain(metadata.appProperties) });
      const output = book(id); output.tabs = books.get(originalId).tabs.map(tab => sheet(tab.getSheetId(), tab.getName(), tab.state.data, output, tab.state.formulaMap));
      calls.actions.push({ kind: 'copy', id, originalId });
      if (options.loseStageCopy) { options.loseStageCopy = false; throw Error('Lost stage copy reply'); }
      return plain(item);
    },
    update(metadata, id, _body, params = {}) {
      const item = resources.get(id); if (!item) throw Error('Missing file');
      if (metadata.appProperties) item.appProperties = { ...item.appProperties, ...plain(metadata.appProperties) };
      if (metadata.trashed !== undefined) item.trashed = metadata.trashed;
      if (params.removeParents) item.parents = item.parents.filter(parent => !params.removeParents.split(',').includes(parent));
      if (params.addParents) for (const parent of params.addParents.split(',')) if (!item.parents.includes(parent)) item.parents.push(parent);
      calls.actions.push({ kind: 'update', id, trashed: metadata.trashed, addParents: params.addParents });
      if (options.losePublish && params.addParents === SOURCE) { options.losePublish = false; throw Error('Lost publish reply'); }
      return plain(item);
    }
  };
  context.PropertiesService = { getScriptProperties: () => store };
  context.DriveApp = { getFolderById: driveObject, getFileById: driveObject };
  context.Drive = { Files: advanced };
  context.LockService = { getScriptLock: () => ({ tryLock: () => { calls.locks++; return true; }, releaseLock: () => { calls.locks--; } }) };
  context.SpreadsheetApp = { openById(id) { calls.opens.push(id); if (!books.has(id)) throw Error('Unexpected book'); return books.get(id); }, flush() {}, newRichTextValue() { let text = '', link = null; const rich = { setText(value) { text = value; return rich; }, setLinkUrl(value) { link = value; return rich; }, build: () => ({ getText: () => text, getLinkUrl: () => link }) }; return rich; } };
  context.sheetWriteRawStrings_ = (fileId, sheetId, row, column, values, mask, links) => {
    const target = books.get(fileId)?.tabs.find(sheet => sheet.getSheetId() === sheetId); assert.ok(target, 'RAW string writer receives the owned output book and exact sheet id');
    assert.ok(Number.isSafeInteger(row) && row >= 1 && Number.isSafeInteger(column) && column >= 1);
    calls.writes.push({ sheet: sheetId, row, column, rows: plain(values), raw: true, links: links ? plain(links) : null });
    for (let r = 0; r < values.length; r++) { while (target.state.data.length < row + r) target.state.data.push([]); for (let c = 0; c < values[r].length; c++) { if (mask && !mask[r][c]) continue; assert.equal(typeof values[r][c], 'string'); target.state.data[row - 1 + r][column - 1 + c] = values[r][c]; delete target.state.formulaMap[(row + r) + ':' + (column + c)]; } }
    if (options.loseWrite) { options.loseWrite = false; throw Error('Lost RAW write reply'); }
  };
  context.Utilities = { getUuid: () => crypto.randomUUID(), DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: (_kind, value) => [...crypto.createHash('sha256').update(typeof value === 'string' ? value : Buffer.from(value)).digest()], base64EncodeWebSafe: value => Buffer.from(value).toString('base64url'), newBlob: (value, type, name) => ({ getBytes: () => [...Buffer.from(value)], getDataAsString: () => String(value), getContentType: () => type, getName: () => name }) };
  for (const name of ['Config.gs', 'Code.gs', 'Segments.gs', 'SourceBases.gs', 'SourceImport.gs', 'PreparedImport.gs', 'Access.gs']) vm.runInContext(readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'), context, { filename: name });
  const storage = { public: { id: SERVICE }, basesSheet: {} };
  const database = () => ({ records: Object.fromEntries(records), relations: [], lastRow: Math.max(1, ...[...records.values()].map(row => row.row || 1)) });
  context.sourceBasesReadDatabase_ = database;
  context.sourceBasesStorage_ = () => storage;
  context.sourceBaseWriteRecords_ = (_sheet, values) => { assert.ok(calls.locks > 0); if (options.registrationFailures > 0) { options.registrationFailures--; throw context.registryError_('STORAGE_WRITE', 'Retry registration'); } for (const value of values) records.set(value.fileId, plain(value)); };
  context.importPrepare_ = () => ({ context: context.authorize_(), binding: context.sourceBasesSource_(context.authorize_()), storage, database: database(), destination: { id: SOURCE, capabilities: { canAddChildren: true } } });
  context.preparedDataRead_ = (source, id, section, settings) => {
    settings.guard(); if (typeof options.onModelRead === 'function') options.onModelRead(id, resources.get(id)); const values = source.state.data.map(row => row.slice()); const rows = values.slice(1);
    const emailRows = [...new Set(rows.map(row => row[2]).filter(Boolean))].map(email => [email]);
    const phoneRows = [...new Set(rows.map(row => row[3]).filter(Boolean))].map(phone => [phone]);
    const counts = { sourceRows: rows.length, companies: 1, companyUnknown: 0, emails: emailRows.length, phones: phoneRows.length, mobiles: phoneRows.length, sharedEmails: 0, sharedPhones: 0 };
    const sourceMeta = { sheetId: source.getSheetId(), name: source.getName(), headers: values[0], rowCount: values.length, columnCount: values[0].length, sample: rows.slice(0, 5) };
    const formulas = options.formulaSnapshots || [];
    return { complete: !options.incomplete, canConfirm: !options.incomplete, fingerprint: context.digest_(JSON.stringify([values, section, formulas])), counts, source: sourceMeta, sourceValues: values, formulaSnapshots: formulas, email: { headers: ['Email'], rows: emailRows }, phone: { headers: ['Телефон'], rows: phoneRows }, previewSheets: [{ name: 'Исходная база', headers: values[0], sample: rows.slice(0, 5), rowCount: values.length }, { name: 'Email', headers: ['Email'], sample: emailRows, rowCount: emailRows.length + 1 }, { name: 'Телефоны', headers: ['Телефон'], sample: phoneRows, rowCount: phoneRows.length + 1 }], warnings: options.incomplete ? ['Неполный анализ'] : [] };
  };
  const invoke = (name, payload, key = KEY) => plain(context.withSharedAccess_(key, () => context[name](payload)));
  const stage = (changes = {}) => invoke('stagePreparedBaseLink_', { url: `https://docs.google.com/spreadsheets/d/${ORIGINAL}/edit`, name: 'Новая база', section: 'companies', status: 'collection', requestId: 'staging_request_1234567890', ...changes });
  const preview = (draft, sheetId = 0) => invoke('previewPreparedBase_', { draftId: draft.draftId, sheetId });
  const confirm = (draft, shown, changes = {}) => invoke('confirmPreparedBase_', { draftId: draft.draftId, sheetId: shown.sheetId, previewToken: shown.previewToken, requestId: 'confirm_request_1234567890', ...changes });
  const next = draft => invoke('continuePreparedBase_', { draftId: draft.draftId, requestId: 'confirm_request_1234567890' });
  function finish(draft, shown = preview(draft)) { let result = confirm(draft, shown); for (let i = 0; result.state === 'processing' && i < 30; i++) result = next(draft); assert.equal(result.state, 'complete'); return result; }
  const drafts = () => [...properties.entries()].filter(([name]) => name.startsWith('PREPARED_DRAFT_')).map(([, text]) => JSON.parse(text));
  return { context, options, resources, books, properties, calls, records, invoke, stage, preview, confirm, next, finish, drafts, blob: () => ({ getName: () => 'base.csv', getContentType: () => 'text/csv', setContentType() {}, getBytes: () => [1, 2, 3] }) };
}

test('staging and preview publish no output; confirmation creates exactly three tabs from one chosen leaf', () => {
  const f = fixture(); const draft = f.stage();
  assert.equal(draft.state, 'staged'); assert.equal(draft.sheets.length, 2);
  assert.equal(f.records.size, 0); assert.equal(f.calls.actions.some(action => action.role === 'output'), false);
  const shown = f.preview(draft, 9); assert.equal(shown.canConfirm, true); assert.equal(shown.counts.emails, 1);
  assert.deepEqual(shown.sheets.map(tab => tab.name), ['Исходная база', 'Email', 'Телефоны']);
  assert.equal(f.calls.actions.some(action => action.role === 'output'), false);
  const result = f.finish(draft, shown), output = f.books.get(result.file.id);
  assert.deepEqual(output.getSheets().map(tab => tab.getName()), ['Исходная база', 'Email', 'Телефоны']);
  assert.equal(output.getSheetByName('Исходная база').state.data[1][2], 'person@example.test');
  assert.equal(output.getSheetByName('Email').state.data[1][0], 'person@example.test');
  assert.deepEqual(f.resources.get(result.file.id).parents, [SOURCE]);
  assert.equal(f.resources.get(result.file.id).appProperties.registryPreparedOriginalSheetId, String(output.getSheetByName('Исходная база').getSheetId()));
  assert.equal(f.resources.get(ORIGINAL).name, 'Источник'); assert.equal(f.books.get(ORIGINAL).getSheets().length, 2);
});

test('file uploads stage a native copy and classify the confirmed output into exactly one section', () => {
  const f = fixture();
  const draft = f.invoke('stagePreparedUpload_', { name: 'ЛПР', section: 'lpr', status: 'ready', requestId: 'upload_stage_1234567890', file: f.blob() });
  assert.equal(f.records.size, 0);
  const result = f.finish(draft);
  assert.deepEqual(f.records.get(result.file.id).contents, ['lpr']); assert.equal(f.records.get(result.file.id).status, 'ready');
  assert.equal(f.calls.actions.filter(action => action.role === 'output').length, 1);
});

test('partial preview and stale source snapshots cannot create a result', () => {
  const f = fixture({ incomplete: true }), draft = f.stage(), shown = f.preview(draft);
  assert.equal(shown.canConfirm, false); assert.throws(() => f.confirm(draft, shown), /PREVIEW_REQUIRED/);
  assert.equal(f.calls.actions.some(action => action.role === 'output'), false);
  const g = fixture(), other = g.stage(), preview = g.preview(other);
  g.resources.get(g.drafts()[0].stageFileId).version = '2';
  g.books.get(g.drafts()[0].stageFileId).getSheets()[0].state.data[1][2] = 'changed-after-preview@example.test';
  assert.throws(() => g.confirm(other, preview), /PREVIEW_CHANGED/);
  assert.equal(g.calls.actions.some(action => action.role === 'output'), false);
});

test('preview token binds the selected leaf and confirmation request id', () => {
  const f = fixture(), draft = f.stage(), shown = f.preview(draft);
  assert.throws(() => f.confirm(draft, shown, { sheetId: 9 }), /PREVIEW_REQUIRED/);
  assert.throws(() => f.confirm(draft, shown, { previewToken: 'wrong' }), /PREVIEW_REQUIRED/);
  f.confirm(draft, shown);
  assert.throws(() => f.confirm(draft, shown, { requestId: 'another_confirm_1234567890' }), /REQUEST_REUSED/);
});

test('lost stage and output create replies recover their atomic Drive markers', () => {
  const f = fixture({ loseStageCopy: true }), draft = f.stage(), shown = f.preview(draft);
  f.options.loseCreateRole = 'output';
  const result = f.finish(draft, shown);
  assert.equal(f.calls.actions.filter(action => action.kind === 'copy').length, 1);
  assert.equal(f.calls.actions.filter(action => action.role === 'output').length, 1);
  assert.equal(result.state, 'complete');
});

test('unknown stage creation cannot blindly repeat when recovery is unavailable', () => {
  const f = fixture({ loseStageCopy: true, hideRecovery: true });
  assert.throws(() => f.stage(), /CREATION_UNCERTAIN/);
  assert.throws(() => f.stage(), /CREATION_UNCERTAIN/);
  assert.equal(f.calls.actions.filter(action => action.kind === 'copy').length, 1);
  f.options.hideRecovery = false; assert.equal(f.stage().state, 'staged');
});

test('lost Sheet.copyTo reply adopts the one verified copied source without duplicating', () => {
  const f = fixture({ loseSheetCopy: true }), draft = f.stage(), result = f.finish(draft);
  assert.equal(result.state, 'complete'); assert.equal(f.calls.copies, 1);
  assert.equal(f.books.get(result.file.id).getSheets().length, 3);
});

test('lost normalized write and publication replies resume without duplicate contacts', () => {
  const f = fixture(), draft = f.stage(), shown = f.preview(draft);
  let result = f.confirm(draft, shown);
  while (f.drafts()[0].phase !== 'emails') result = f.next(draft);
  f.options.loseWrite = true; assert.throws(() => f.next(draft), /GOOGLE_ERROR/);
  f.options.losePublish = true;
  for (let i = 0; result.state !== 'complete' && i < 20; i++) result = f.next(draft);
  assert.equal(result.state, 'complete');
  assert.equal(f.books.get(result.file.id).getSheetByName('Email').getLastRow(), 2);
  assert.equal(f.records.size, 1);
});

test('completed replay preserves later edits and statuses instead of rebuilding', () => {
  const f = fixture(), draft = f.stage(), shown = f.preview(draft), result = f.finish(draft, shown);
  const output = f.books.get(result.file.id), email = output.getSheetByName('Email');
  email.state.data[1][0] = 'manually-kept@example.test'; f.records.get(result.file.id).status = 'rework';
  const writes = f.calls.writes.length;
  const replay = f.confirm(draft, shown);
  assert.equal(replay.item.status, 'rework'); assert.equal(email.state.data[1][0], 'manually-kept@example.test');
  assert.equal(f.calls.writes.length, writes); assert.equal(f.calls.actions.filter(action => action.role === 'output').length, 1);
});

test('cancel trashes only owned staging files and never the original or a complete result', () => {
  const f = fixture(), draft = f.stage(); f.preview(draft);
  assert.equal(f.invoke('cancelPreparedBase_', { draftId: draft.draftId }).state, 'cancelled');
  assert.equal(f.resources.get(ORIGINAL).trashed, false);
  assert.ok([...f.resources.values()].filter(file => file.appProperties.registryPreparedDraft === draft.draftId).every(file => file.trashed));
  const g = fixture(), second = g.stage(), result = g.finish(second);
  assert.equal(g.invoke('cancelPreparedBase_', { draftId: second.draftId }).state, 'complete');
  assert.equal(g.resources.get(result.file.id).trashed, false);
});

test('expired drafts reject preview while explicit cancellation can still clean scratch files', () => {
  const f = fixture(), draft = f.stage(), record = f.drafts()[0]; record.expiresAt = '2000-01-01T00:00:00.000Z';
  f.properties.set('PREPARED_DRAFT_' + record.draftId, JSON.stringify(record));
  assert.throws(() => f.preview(draft), /DRAFT_EXPIRED/);
  assert.equal(f.invoke('cancelPreparedBase_', { draftId: draft.draftId }).state, 'cancelled');
});

test('wrong key, root changes, external or protected originals cannot reach a source read', () => {
  const f = fixture({ outside: true }); assert.throws(() => f.stage(), /SOURCE_SCOPE_REQUIRED/); assert.equal(f.calls.actions.length, 0);
  const g = fixture(); assert.throws(() => g.invoke('stagePreparedBaseLink_', { url: `https://docs.google.com/spreadsheets/d/${SERVICE}/edit`, name: 'Bad', section: 'companies', status: 'collection', requestId: 'protected_1234567890' }), /PROTECTED_FILE/);
  assert.throws(() => g.invoke('stagePreparedBaseLink_', {}, 'Z'.repeat(43)), /LINK_ACCESS_REQUIRED/);
  const draft = g.stage(); g.resources.get(ORIGINAL).parents = [OUTSIDE];
  const opened = g.calls.opens.length; assert.throws(() => g.preview(draft), /SOURCE_SCOPE_REQUIRED/); assert.equal(g.calls.opens.length, opened);
});

test('moved or tampered draft artifacts are rejected before confirmation writes', () => {
  const f = fixture(), draft = f.stage(), shown = f.preview(draft), entry = f.drafts()[0];
  f.resources.get(entry.planId).content = '{}';
  assert.throws(() => f.confirm(draft, shown), /PREVIEW_CHANGED/);
  assert.equal(f.calls.actions.some(action => action.role === 'output'), false);
  const g = fixture(), second = g.stage(), preview = g.preview(second), metadata = g.drafts()[0];
  g.resources.get(metadata.stageFileId).parents = [SOURCE];
  assert.throws(() => g.confirm(second, preview), /OUTSIDE_REGISTRY/);
});

test('normalized writes keep phone plus signs literal and never execute formula-like text', () => {
  const f = fixture(), draft = f.stage(), result = f.finish(draft);
  const phone = f.books.get(result.file.id).getSheetByName('Телефоны');
  assert.equal(phone.state.data[1][0], '+79991112233');
  assert.equal(Object.keys(phone.state.formulaMap).length, 0);
  assert.ok(f.calls.writes.filter(write => write.sheet === phone.getSheetId()).every(write => write.raw));
});

test('Date formula snapshots freeze to typed dates while preserving the required tab order', () => {
  const value = new Date('2026-01-02T00:00:00.000Z');
  const f = fixture({ formulaSnapshots: [{ row: 2, column: 2, value: value.toISOString(), valueType: 'date' }] });
  const source = f.books.get(ORIGINAL).getSheets()[0]; source.state.data[1][1] = value; source.state.formulaMap['2:2'] = '=DATE(2026,1,2)';
  const result = f.finish(f.stage()), output = f.books.get(result.file.id), frozen = output.getSheetByName('Исходная база').state;
  assert.equal(Object.prototype.toString.call(frozen.data[1][1]), '[object Date]');
  assert.equal(frozen.data[1][1].toISOString(), value.toISOString()); assert.equal(frozen.formulaMap['2:2'], undefined);
  assert.deepEqual(output.getSheets().map(tab => tab.getName()), ['Исходная база', 'Email', 'Телефоны']);
});

test('manual edits before first publication reject the result instead of publishing a different preview', () => {
  const f = fixture(), draft = f.stage(), shown = f.preview(draft);
  f.confirm(draft, shown); while (f.drafts()[0].phase !== 'publish') f.next(draft);
  const id = f.drafts()[0].outputId; f.books.get(id).getSheetByName('Email').state.data[1][0] = 'changed@example.test';
  assert.throws(() => f.next(draft), /PREVIEW_CHANGED/);
  assert.equal(f.records.size, 0); assert.notDeepEqual(f.resources.get(id).parents, [SOURCE]);
});

test('a lost metadata commit after publication resumes without rejecting or overwriting later edits', () => {
  const f = fixture({ registrationFailures: 1 }), draft = f.stage(), shown = f.preview(draft);
  f.confirm(draft, shown); while (f.drafts()[0].phase !== 'publish') f.next(draft);
  assert.throws(() => f.next(draft), /STORAGE_WRITE/);
  const id = f.drafts()[0].outputId; assert.deepEqual(f.resources.get(id).parents, [SOURCE]);
  f.books.get(id).getSheetByName('Email').state.data[1][0] = 'kept-after-publication@example.test';
  const result = f.next(draft); assert.equal(result.state, 'complete');
  assert.equal(f.books.get(id).getSheetByName('Email').state.data[1][0], 'kept-after-publication@example.test');
});

test('cancel rechecks actual position immediately before trashing each scratch file', () => {
  const f = fixture(), draft = f.stage(); f.preview(draft); const stageId = f.drafts()[0].stageFileId;
  f.options.onGet = (id, item) => { if (id === stageId) item.parents = [SOURCE]; };
  assert.throws(() => f.invoke('cancelPreparedBase_', { draftId: draft.draftId }), /OUTSIDE_REGISTRY/);
  assert.equal(f.resources.get(stageId).trashed, false); assert.equal(f.resources.get(ORIGINAL).trashed, false);
});

test('unknown output creation can be resumed only through its existing marker', () => {
  const f = fixture(), draft = f.stage(), shown = f.preview(draft);
  f.options.loseCreateRole = 'output'; f.options.hideRecovery = true;
  assert.throws(() => f.confirm(draft, shown), /CREATION_UNCERTAIN/);
  assert.throws(() => f.confirm(draft, shown), /CREATION_UNCERTAIN/);
  assert.equal(f.calls.actions.filter(action => action.role === 'output').length, 1);
  f.options.hideRecovery = false;
  let result = f.next(draft); for (let i = 0; result.state === 'processing' && i < 20; i++) result = f.next(draft);
  assert.equal(result.state, 'complete'); assert.equal(f.calls.actions.filter(action => action.role === 'output').length, 1);
});

test('a sources-root binding cannot make staging visible as registered source files', () => {
  const f = fixture(); f.properties.set('SOURCE_BASES_FOLDER_ID', ROOT);
  assert.throws(() => f.stage(), /OUTSIDE_REGISTRY/);
  assert.equal(f.calls.actions.filter(action => action.kind === 'copy').length, 0);
});

test('published prepared books may be new link inputs while unpublished artifacts remain protected', () => {
  const f = fixture(), draft = f.stage(), result = f.finish(draft);
  const next = f.stage({ url: result.file.url, requestId: 'new_stage_request_1234567890' });
  assert.equal(next.state, 'staged');
  const pending = f.drafts().find(entry => entry.draftId === next.draftId);
  assert.throws(() => f.stage({ url: `https://docs.google.com/spreadsheets/d/${pending.stageFileId}/edit`, requestId: 'bad_draft_as_input_1234567890' }), /PROTECTED_FILE/);
  // A partially applied publication marker does not make a staging object public.
  const input = f.resources.get(pending.stageFileId); input.appProperties.registryPreparedRole = 'output'; input.appProperties.registryPreparedVersion = '1';
  assert.throws(() => f.stage({ url: `https://docs.google.com/spreadsheets/d/${pending.stageFileId}/edit`, requestId: 'bad_marker_as_input_1234567890' }), /PROTECTED_FILE/);
});

test('the real data reader and writer agree on unique emails, social-link phones and exactly three tabs', () => {
  const f = fixture(), source = f.books.get(ORIGINAL).getSheets()[0];
  source.state.data[0].push('WhatsApp'); source.state.data[1].push('https://wa.me/79994445566'); source.state.data[2].push('https://vk.com/id123456789');
  for (const name of ['ContactPreview.gs', 'PreparedData.gs']) vm.runInContext(readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'), f.context, { filename: name });
  const draft = f.stage(), shown = f.preview(draft); assert.equal(shown.canConfirm, true);
  assert.equal(shown.counts.emails, 1); assert.equal(shown.counts.phones, 2);
  const result = f.finish(draft, shown), output = f.books.get(result.file.id);
  assert.equal(output.getSheetByName('Email').getLastRow(), 2); assert.equal(output.getSheetByName('Телефоны').getLastRow(), 3);
  assert.deepEqual(output.getSheetByName('Телефоны').state.data.slice(1).map(row => row[0]).sort(), ['+79991112233', '+79994445566']);
  assert.equal(output.getSheetByName('Исходная база').state.data[1][4], 'https://wa.me/79994445566');
});

test('confirmed unfinished jobs survive a reload and list only current nonexpired processing records', () => {
  const f = fixture(), staged = f.stage();
  assert.deepEqual(f.invoke('listPreparedJobs_', {}).items, []);
  const shown = f.preview(staged); f.confirm(staged, shown);
  const reads = f.calls.opens.length, jobs = f.invoke('listPreparedJobs_', {}).items;
  assert.equal(f.calls.opens.length, reads, 'listing jobs opens no business spreadsheet');
  assert.equal(jobs.length, 1); assert.equal(jobs[0].draftId, staged.draftId); assert.equal(jobs[0].requestId, 'confirm_request_1234567890'); assert.equal(jobs[0].sheetId, 0);
  let result; do { result = f.invoke('continuePreparedBase_', { draftId: jobs[0].draftId, requestId: jobs[0].requestId }); } while (result.state === 'processing');
  assert.equal(result.state, 'complete'); assert.deepEqual(f.invoke('listPreparedJobs_', {}).items, []);
  assert.throws(() => f.invoke('listPreparedJobs_', {}, 'Z'.repeat(43)), /LINK_ACCESS_REQUIRED/);
  assert.throws(() => f.invoke('listPreparedJobs_', { rootId: ROOT }), /INVALID_REQUEST/);
});

test('job listing omits expired, cancelled, unconfirmed and different-root receipts', () => {
  const f = fixture(), first = f.stage(), shown = f.preview(first); f.confirm(first, shown);
  const entry = f.drafts()[0]; entry.expiresAt = '2000-01-01T00:00:00.000Z'; f.properties.set('PREPARED_DRAFT_' + entry.draftId, JSON.stringify(entry));
  assert.deepEqual(f.invoke('listPreparedJobs_', {}).items, []);
  entry.expiresAt = '2099-01-01T00:00:00.000Z'; entry.rootId = OUTSIDE; f.properties.set('PREPARED_DRAFT_' + entry.draftId, JSON.stringify(entry));
  assert.deepEqual(f.invoke('listPreparedJobs_', {}).items, []);
  entry.rootId = ROOT; entry.state = 'cancelled'; f.properties.set('PREPARED_DRAFT_' + entry.draftId, JSON.stringify(entry));
  assert.deepEqual(f.invoke('listPreparedJobs_', {}).items, []);
});

test('new uploads reclaim expired unconfirmed scratch without trashing confirmed jobs or originals', () => {
  const f = fixture(), abandoned = f.stage(); f.preview(abandoned);
  const old = f.drafts()[0]; old.expiresAt = '2000-01-01T00:00:00.000Z'; f.properties.set('PREPARED_DRAFT_' + old.draftId, JSON.stringify(old));
  const newer = f.stage({ requestId: 'another_stage_1234567890' });
  assert.equal(newer.state, 'staged');
  assert.ok([...f.resources.values()].filter(file => file.appProperties.registryPreparedDraft === abandoned.draftId).every(file => file.trashed));
  assert.equal(f.resources.get(ORIGINAL).trashed, false);
  const shown = f.preview(newer); f.confirm(newer, shown);
  const active = f.drafts().find(entry => entry.draftId === newer.draftId); active.expiresAt = '2000-01-01T00:00:00.000Z'; f.properties.set('PREPARED_DRAFT_' + active.draftId, JSON.stringify(active));
  f.stage({ requestId: 'third_stage_1234567890' });
  assert.equal(f.resources.get(active.outputId).trashed, false);
});

test('durable completion cleans only its input and plan while replay needs neither scratch file', () => {
  const f = fixture(), draft = f.stage(), shown = f.preview(draft), entry = f.drafts()[0];
  const result = f.finish(draft, shown);
  assert.equal(f.resources.get(entry.stageFileId).trashed, true); assert.equal(f.resources.get(entry.planId).trashed, true);
  assert.equal(f.resources.get(result.file.id).trashed, false); assert.equal(f.resources.get(ORIGINAL).trashed, false);
  const opened = f.calls.opens.length;
  assert.equal(f.confirm(draft, shown).state, 'complete');
  assert.equal(f.calls.opens.length, opened, 'complete replay does not reopen trashed staging books');
});

test('best-effort cleanup leaves moved plan artifacts intact and still returns the complete result', () => {
  const f = fixture(), draft = f.stage(), shown = f.preview(draft), planId = f.drafts()[0].planId;
  f.options.onGet = (id, item) => { if (id === planId && f.drafts()[0].state === 'complete') item.parents = [SOURCE]; };
  const result = f.finish(draft, shown);
  assert.equal(result.state, 'complete'); assert.equal(f.resources.get(planId).trashed, false); assert.equal(f.resources.get(result.file.id).trashed, false);
});

test('bounded cleanup frees a full index of expired unconfirmed drafts for the next upload', () => {
  const f = fixture();
  for (let i = 0; i < 60; i++) f.stage({ requestId: 'abandoned_request_' + i + '_1234567890' });
  for (const entry of f.drafts()) { entry.expiresAt = '2000-01-01T00:00:00.000Z'; f.properties.set('PREPARED_DRAFT_' + entry.draftId, JSON.stringify(entry)); }
  const next = f.stage({ requestId: 'new_upload_after_gc_1234567890' });
  assert.equal(next.state, 'staged');
  assert.equal(JSON.parse(f.properties.get('PREPARED_DRAFT_INDEX')).length, 60);
  assert.equal([...f.resources.values()].filter(item => item.trashed).length, 3, 'one start cleans at most three abandoned input copies');
  assert.equal(f.resources.get(ORIGINAL).trashed, false);
});

test('preview discards an initial conversion-version bump and accepts only the stable second read', () => {
  const f = fixture(), draft = f.stage(); let reads = 0;
  f.options.onModelRead = (_id, file) => { if (++reads === 1) file.version = '2'; };
  const shown = f.preview(draft);
  assert.equal(shown.canConfirm, true); assert.equal(reads, 2);
  assert.equal(f.drafts()[0].sourceVersion, '2'); assert.equal(f.calls.actions.some(action => action.role === 'output'), false);
});

test('continuous source version changes cannot produce a confirmable preview', () => {
  const f = fixture(), draft = f.stage(); let reads = 0;
  f.options.onModelRead = (_id, file) => { reads++; file.version = String(Number(file.version) + 1); };
  assert.throws(() => f.preview(draft), /PREVIEW_CHANGED/); assert.equal(reads, 2);
  assert.equal(f.calls.actions.some(action => action.role === 'output'), false);
});

test('metadata-only version changes require a fresh matching content fingerprint before confirmation', () => {
  const f = fixture(), draft = f.stage(), shown = f.preview(draft); let reads = 0;
  f.resources.get(f.drafts()[0].stageFileId).version = '2'; f.options.onModelRead = () => { reads++; };
  assert.equal(f.confirm(draft, shown).state, 'processing'); assert.equal(reads, 1);
  assert.equal(f.drafts()[0].sourceVersion, '2');
});

test('authoritative RAW strings avoid native RichText =+ corruption without relaxing verification', () => {
  const f = fixture({ nativeRichTextPrefix: true }), draft = f.stage(), result = f.finish(draft);
  const phone = f.books.get(result.file.id).getSheetByName('Телефоны');
  assert.equal(phone.state.data[1][0], '+79991112233'); assert.equal(phone.state.formulaMap['2:1'], undefined);
  assert.ok(f.calls.writes.filter(write => write.sheet === phone.getSheetId()).every(write => write.raw));
  const g = fixture({ nativeRichTextPrefix: true, formulaSnapshots: [{ row: 2, column: 2, value: '+79990000004', link: 'https://wa.me/79990000004' }] });
  const source = g.books.get(ORIGINAL).tabs[0]; source.state.data[1][1] = '+79990000004'; source.state.formulaMap['2:2'] = '=HYPERLINK("https://wa.me/79990000004","+79990000004")';
  const finished = g.finish(g.stage()), original = g.books.get(finished.file.id).getSheetByName('Исходная база');
  assert.equal(original.state.data[1][1], '+79990000004'); assert.equal(original.state.formulaMap['2:2'], undefined);
  assert.ok(g.calls.writes.some(write => write.sheet === original.getSheetId() && write.raw && write.links?.[0]?.[0] === 'https://wa.me/79990000004'));
});
