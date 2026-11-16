import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { installSharedApi, runShared, TEST_ACCESS_HASH } from './helpers/shared-link.js';

const ROOT = 'target_registry_root_12345', SOURCES = 'target_sources_folder_12345', SEGMENT = 'target_segment_folder_12345';
const TARGET = 'target_contact_center_12345', SOURCE = 'target_incoming_book_12345', SERVICE = 'target_service_book_12345';
const MIME = 'application/vnd.google-apps.spreadsheet';
const plain = value => JSON.parse(JSON.stringify(value));
const iter = values => { let index = 0; return { hasNext: () => index < values.length, next: () => values[index++] }; };
const inn = prefix => prefix + ([2,4,10,3,5,9,4,6,8].reduce((sum, n, index) => sum + n * Number(prefix[index]), 0) % 11 % 10);
const INN_A = inn('770708389'), INN_B = inn('771014067');
const row = (id = 'source_company_1', tax = INN_A, emails = ['one@example.com'], phones = ['+79991234567']) => ({ localId: id, inn: tax, name: id, emails, phones: phones.map(value => ({ value, kind: 'mobile' })), source: { sheetId: 1, sheetName: 'Входные данные', row: 2 } });
const base = (id = 'center_company_1', tax = INN_A) => [id, 'Компания Центра', tax];
const email = (value = 'one@example.com', owner = 'center_company_1', id = 'center_email_1') => [id, owner, 'Компания Центра', value];
const phone = (value = '+79991234567', owner = 'center_company_1', id = 'center_phone_1') => [id, owner, 'Компания Центра', '', value];

function fixture(options = {}) {
  const calls = { opens: [], reads: [], writes: 0, propertiesWritten: 0 };
  const properties = new Map(Object.entries({ ROOT_FOLDER_ID: ROOT, SOURCE_BASES_FOLDER_ID: SOURCES, SOURCE_BASES_STORAGE_ID: SERVICE, SHARED_ACCESS_KEY_SHA256: TEST_ACCESS_HASH, ...options.properties }));
  const folders = new Map();
  const folder = (id, parents, name = id) => ({ getId: () => id, getName: () => name, isTrashed: () => false, getParents: () => iter(parents.map(parent => folders.get(parent))), getFolders: () => iter([]) });
  folders.set(ROOT, folder(ROOT, [])); folders.set(SOURCES, folder(SOURCES, [ROOT], 'Исходные базы')); folders.set(SEGMENT, folder(SEGMENT, [ROOT]));
  const fileState = { parents: options.outside ? [ROOT] : [SEGMENT], trashed: !!options.trashed, mime: options.mime || MIME };
  const files = new Map();
  const file = id => ({ getId: () => id, getName: () => 'Центр базы Кухни', isTrashed: () => fileState.trashed, getMimeType: () => fileState.mime, getParents: () => iter(fileState.parents.map(parent => folders.get(parent))) });
  files.set(TARGET, file(TARGET)); files.set(SERVICE, file(SERVICE)); files.set(SOURCE, file(SOURCE));
  const state = new Map();
  const context = vm.createContext({
    console,
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) ?? null, setProperty: () => { calls.propertiesWritten++; throw new Error('No writes'); } }) },
    DriveApp: { getFolderById: id => { if (!folders.has(id)) throw new Error('Missing folder'); return folders.get(id); }, getFileById: id => { if (!files.has(id)) throw new Error('Missing file'); return files.get(id); } },
    SpreadsheetApp: {
      openById: id => {
        calls.opens.push(id);
        assert.equal(id, TARGET, 'Only the configured target can be opened');
        return { getSheetByName: name => state.has(name) ? sheet(name) : null };
      },
      flush: () => { calls.writes++; throw new Error('No flush'); },
    },
  });
  for (const name of ['Config.gs', 'Code.gs', 'ContactPreview.gs', 'ContactTarget.gs']) vm.runInContext(readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'), context, { filename: name });
  context.REGISTRY_CONFIG = Object.freeze({ ...context.REGISTRY_CONFIG, defaultRootFolderId: ROOT, defaultSourceBasesFolderId: SOURCES, defaultSourceBasesStorageId: SERVICE, defaultContactCenterId: TARGET, defaultContactCenterFolderId: SEGMENT });
  if (options.limits) context.CONTACT_TARGET_LIMITS = Object.freeze({ ...context.CONTACT_TARGET_LIMITS, ...options.limits });
  const schemas = { База: context.CONTACT_TARGET_HEADERS.base, Email: context.CONTACT_TARGET_HEADERS.email, Telegram: context.CONTACT_TARGET_HEADERS.telegram };
  for (const [name, headers] of Object.entries(schemas)) state.set(name, { rows: [plain(headers), ...(options[name] || [])], formulas: [], id: name === 'База' ? 100 : name === 'Email' ? 101 : 102 });
  function sheet(name) {
    const value = state.get(name);
    return {
      getName: () => name, getSheetId: () => value.id,
      getLastRow: () => value.lastRow ?? value.rows.length,
      getLastColumn: () => value.lastColumn ?? schemas[name].length,
      getRange: (startRow, startColumn, rowCount, columnCount) => ({
        getDisplayValues: () => {
          calls.reads.push({ name, row: startRow, rowCount, columnCount });
          options.onRead?.({ name, row: startRow, state, properties, fileState });
          if (options.readFails === name) throw new Error('Read unavailable');
          const result = Array.from({ length: rowCount }, (_, y) => Array.from({ length: columnCount }, (_, x) => String(value.rows[startRow - 1 + y]?.[startColumn - 1 + x] ?? '')));
          return options.shortRead && startRow > 1 ? result.slice(1) : result;
        },
        getFormulas: () => Array.from({ length: rowCount }, (_, y) => Array.from({ length: columnCount }, (_, x) => value.formulas[startRow - 1 + y]?.[startColumn - 1 + x] ?? '')),
        setValues: () => { calls.writes++; throw new Error('No writes'); },
      }),
    };
  }
  installSharedApi(context);
  const resultFor = (rows, extra = {}) => {
    const result = { state: 'ready', scanComplete: true, companies: { unique: 0, unresolvedRows: 0 }, emails: { occurrences: 0, unique: 0, multiCompany: 0, unresolved: 0 }, phones: { occurrences: 0, unique: 0, mobiles: 0, landlines: 0, unknownType: 0, multiCompany: 0, unresolved: 0 }, conflicts: { total: 0, items: [], truncated: false }, warnings: [] };
    context.contactPreviewAggregate_(result, rows, SOURCE, { started: Date.now(), partial: false });
    return Object.assign(result, extra);
  };
  return { context, calls, state, properties, fileState, resultFor, compare: (rows = [row()], extra = {}) => runShared(context, () => context.contactPreviewCompareTarget_(context.authorize_(), resultFor(rows, extra), rows, SOURCE)) };
}

test('empty Center reports source-unique new candidates without writing or importing', () => {
  const f = fixture();
  const result = plain(f.compare([row(), row('company2', INN_B, ['two@example.com'], [])]));
  assert.equal(result.target.state, 'ready');
  assert.deepEqual([result.emails.unique, result.emails.existingInTarget, result.emails.newUnique, result.emails.newUnambiguous], [2,0,2,2]);
  assert.deepEqual([result.phones.unique, result.phones.existingInTarget, result.phones.newUnique], [1,0,1]);
  assert.deepEqual([result.companies.unique, result.companies.existingInTarget, result.companies.newUnique], [2,0,2]);
  assert.equal(result.conflicts.totalCombined, 0);
  assert.equal(f.calls.writes, 0); assert.equal(f.calls.propertiesWritten, 0);
});

test('matching verified INN maps different source and target IDs to the same company', () => {
  const f = fixture({ База: [base()], Email: [email()], Telegram: [phone()] });
  const result = plain(f.compare());
  assert.deepEqual([result.emails.existingInTarget, result.emails.newUnique, result.emails.multiCompanyCombined], [1,0,0]);
  assert.deepEqual([result.phones.existingInTarget, result.phones.newUnique], [1,0]);
  assert.deepEqual([result.companies.existingInTarget, result.companies.newUnique], [1,0]);
  assert.equal(result.conflicts.totalCombined, 0);
});

test('target is read fresh on each invocation and changed contacts are not reported new', () => {
  const f = fixture();
  assert.equal(f.compare().emails.newUnique, 1);
  f.state.get('База').rows.push(base()); f.state.get('Email').rows.push(email());
  const result = f.compare();
  assert.equal(result.emails.newUnique, 0); assert.equal(result.emails.existingInTarget, 1);
  assert.equal(f.calls.opens.length, 2);
});

test('a contact incoming under another company is flagged against existing target owners', () => {
  const f = fixture({ База: [base()], Email: [email()], Telegram: [phone()] });
  const result = plain(f.compare([row('companyB', INN_B)]));
  assert.equal(result.emails.multiCompany, 0, 'Input-only metric stays unchanged');
  assert.equal(result.conflicts.total, 0, 'Input-only conflict total stays unchanged');
  assert.equal(result.emails.multiCompanyCombined, 1); assert.equal(result.phones.multiCompanyCombined, 1);
  assert.equal(result.emails.targetConflicts, 1); assert.equal(result.conflicts.totalCombined, 2);
  assert.ok(result.conflicts.items.every(item => item.reason === 'multiple_companies' && item.scope === 'source_and_target'));
  assert.ok(result.conflicts.items.every(item => item.sources.some(source => source.fileId === TARGET)));
});

test('source Company_ID is file-scoped and cannot blindly match a same-named target ID', () => {
  const f = fixture({ База: [base('same_raw_id', '')], Email: [email('one@example.com', 'same_raw_id')] });
  const result = f.compare([row('same_raw_id', '')]);
  assert.equal(result.companies.existingInTarget, 0);
  assert.equal(result.companies.newUnique, null, 'Opaque target aliases cannot prove all companies new');
  assert.equal(result.emails.multiCompanyCombined, 1);
  const g = fixture({ База: [base('source:' + SOURCE + ':same_raw_id', '')], Email: [email('one@example.com', 'source:' + SOURCE + ':same_raw_id')] });
  assert.equal(g.compare([row('same_raw_id', '')]).emails.multiCompanyCombined, 0);
});

test('unknown target ownership is manual review without claiming multiple known companies', () => {
  const f = fixture({ Email: [email('one@example.com', '')] });
  const result = f.compare();
  assert.equal(result.emails.existingInTarget, 1); assert.equal(result.emails.newUnique, 0);
  assert.equal(result.emails.multiCompanyCombined, 0); assert.equal(result.emails.unresolvedCombined, 1);
  assert.equal(result.conflicts.totalCombined, 1); assert.equal(result.conflicts.items[0].reason, 'unknown_owner');
});

test('unknown input owner does not make a complete scan all-ready or invalidate exact contact delta', () => {
  const f = fixture();
  const result = f.compare([row('', '', ['unknown@example.com'], [])], { state: 'partial', scanComplete: true });
  assert.equal(result.target.state, 'ready'); assert.equal(result.emails.newUnique, 1);
  assert.equal(result.emails.newUnambiguous, 0); assert.equal(result.conflicts.items[0].reason, 'unknown_owner');
});

test('partial source scan yields unknown comparison without reading target data', () => {
  const f = fixture();
  const result = f.compare([row()], { state: 'partial', scanComplete: false });
  assert.equal(result.target.state, 'unavailable'); assert.equal(result.emails.unique, 1);
  assert.equal(result.emails.newUnique, null); assert.equal(result.companies.newUnique, null);
  assert.deepEqual(f.calls.opens, []);
});

test('missing or malformed target schema, rows, IDs and contacts never imply all-new', () => {
  const scenarios = [
    f => f.state.delete('Telegram'),
    f => { f.state.get('Email').rows[0][3] = 'Changed'; },
    f => { f.state.get('База').rows.push(base('', INN_A)); },
    f => { f.state.get('База').rows.push(base('companyA', '123')); },
    f => { f.state.get('Email').rows.push(email('broken')); },
    f => { f.state.get('Email').rows.push(email('one@example.com', '', '')); },
    f => { f.state.get('Email').rows.push(email('a@example.com', '', 'duplicate'), email('b@example.com', '', 'duplicate')); },
    f => { f.state.get('Telegram').rows.push(phone('not-a-number')); },
  ];
  for (const mutate of scenarios) {
    const f = fixture(); mutate(f); const result = f.compare();
    assert.equal(result.target.state, 'unavailable'); assert.equal(result.emails.newUnique, null);
    assert.equal(result.phones.existingInTarget, null); assert.equal(result.companies.newUnique, null);
    assert.equal(result.emails.unique, 1); assert.equal(f.calls.writes, 0);
  }
});

test('formula contacts or identity fields are unavailable, while unused summary formulas are harmless', () => {
  for (const [name, index] of [['База', 0], ['Email', 3], ['Telegram', 4]]) {
    const f = fixture({ База: [base()], Email: [email()], Telegram: [phone()] });
    f.state.get(name).formulas[1] = []; f.state.get(name).formulas[1][index] = '=SECRET()';
    assert.equal(f.compare().target.state, 'unavailable');
  }
  const f = fixture({ База: [base()] }); f.state.get('База').formulas[1] = []; f.state.get('База').formulas[1][7] = '=COUNT()';
  assert.equal(f.compare().target.state, 'ready');
});

test('target limits, incomplete reads and target read failures preserve source totals with unknown delta', () => {
  for (const options of [{ limits: { maxRows: 0 }, База: [base()] }, { limits: { maxCells: 1 } }, { limits: { maxMillis: -1 } }, { shortRead: true, Email: [email()] }, { readFails: 'Email' }]) {
    const f = fixture(options), result = f.compare();
    assert.equal(result.target.state, 'unavailable'); assert.equal(result.emails.unique, 1);
    assert.equal(result.emails.newUnique, null); assert.equal(result.conflicts.totalCombined, null);
  }
});

test('service, self, moved-outside, trashed, wrong MIME and Sources targets are blocked before opening', () => {
  for (const options of [{ properties: { CONTACT_CENTER_ID: SERVICE } }, { properties: { CONTACT_CENTER_ID: SOURCE } }, { outside: true }, { trashed: true }, { mime: 'text/csv' }]) {
    const f = fixture(options); assert.equal(f.compare().target.state, 'unavailable'); assert.deepEqual(f.calls.opens, []);
  }
  const f = fixture({ properties: { CONTACT_CENTER_FOLDER_ID: SOURCES } }); f.fileState.parents = [SOURCES];
  assert.equal(f.compare().target.state, 'unavailable'); assert.deepEqual(f.calls.opens, []);
});

test('target moving after headers blocks body data and yields no mixed target result', () => {
  const f = fixture({ Email: [email()], onRead: ({ name, row, fileState }) => { if (name === 'Email' && row === 1) fileState.parents = [ROOT]; } });
  const result = f.compare();
  assert.equal(result.target.state, 'unavailable'); assert.equal(result.emails.newUnique, null);
  assert.ok(f.calls.reads.every(read => read.row === 1));
});

test('key revocation and root changes during target reading propagate instead of returning source data', () => {
  const f = fixture({ Email: [email()], onRead: ({ name, row, properties }) => { if (name === 'Email' && row === 1) properties.set('SHARED_ACCESS_KEY_SHA256', 'x'.repeat(43)); } });
  assert.throws(() => f.compare(), /LINK_ACCESS_REQUIRED/);
  assert.ok(f.calls.reads.every(read => read.row === 1));
  const g = fixture({ Email: [email()], onRead: ({ name, row, properties }) => { if (name === 'Email' && row === 1) properties.set('ROOT_FOLDER_ID', 'replacement_root_123456789'); } });
  assert.throws(() => g.compare(), /SOURCE_CHANGED/);
  assert.equal(f.calls.writes + g.calls.writes, 0);
});

test('private target helper denies reads outside the verified shared-request scope', () => {
  const f = fixture();
  assert.throws(() => f.context.contactPreviewCompareTarget_({}, f.resultFor([row()]), [row()], SOURCE), /LINK_ACCESS_REQUIRED/);
  assert.deepEqual(f.calls.opens, []);
});

test('blank formula results in contact columns are not mistaken for a definitely empty target', () => {
  const f = fixture(); f.state.get('Email').rows.push([]); f.state.get('Email').formulas[1] = []; f.state.get('Email').formulas[1][3] = '=IF(FALSE,"a@example.com","")';
  assert.equal(f.compare().target.state, 'unavailable');
});

test('conflict payload budget truncates details while retaining exact combined counts', () => {
  const f = fixture(); f.context.CONTACT_PREVIEW_LIMITS = Object.freeze({ ...f.context.CONTACT_PREVIEW_LIMITS, maxDetailCharacters: 10 });
  const result = f.compare([row('A', INN_A), row('B', INN_B)]);
  assert.equal(result.target.state, 'ready'); assert.equal(result.conflicts.totalCombined, 2);
  assert.equal(result.conflicts.items.length, 0); assert.equal(result.conflicts.truncated, true);
  assert.equal(result.emails.multiCompanyCombined, 1); assert.equal(result.phones.multiCompanyCombined, 1);
});

test('target provenance is retained when source contact already has many incoming locations', () => {
  const f = fixture({ База: [base()], Email: [email()] });
  const incoming = Array.from({ length: 25 }, (_, index) => ({ ...row('B', INN_B, ['one@example.com'], []), source: { sheetId: 1, sheetName: 'Входные данные', row: index + 2 } }));
  const result = f.compare(incoming), detail = result.conflicts.items[0];
  assert.equal(detail.sources.length, f.context.CONTACT_PREVIEW_LIMITS.maxSources);
  assert.ok(detail.sources.some(item => item.fileId === TARGET));
  assert.ok(detail.sources.some(item => item.fileId === SOURCE));
});

test('username-only target rows cannot prove that an incoming phone already exists', () => {
  const f = fixture({ База: [base()], Telegram: [['username_contact', 'center_company_1', '', 'same_name', '', '123456789']] });
  const result = f.compare();
  assert.equal(result.phones.existingInTarget, 0); assert.equal(result.phones.newUnique, 1);
});
