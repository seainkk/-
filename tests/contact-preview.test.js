import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { installSharedApi, TEST_ACCESS_HASH, TEST_ACCESS_KEY } from './helpers/shared-link.js';

const ROOT = 'preview_registry_root_12345', SOURCE = 'preview_sources_folder_12345', FILE = 'preview_business_book_12345', SERVICE = 'preview_service_book_12345';
const MIME = 'application/vnd.google-apps.spreadsheet';
const plain = value => JSON.parse(JSON.stringify(value));
const iter = array => { let index = 0; return { hasNext: () => index < array.length, next: () => array[index++] }; };
const inn = prefix => prefix + ([2,4,10,3,5,9,4,6,8].reduce((sum, n, index) => sum + n * Number(prefix[index]), 0) % 11 % 10);
const INN_A = inn('770708389'), INN_B = inn('771014067');

function fixture(options = {}) {
  const calls = { opened: [], ranges: [], files: [], propertiesWritten: 0, writes: 0 };
  const properties = new Map(Object.entries({ ROOT_FOLDER_ID: ROOT, SOURCE_BASES_FOLDER_ID: SOURCE, SOURCE_BASES_STORAGE_ID: SERVICE, SHARED_ACCESS_KEY_SHA256: TEST_ACCESS_HASH, ...options.properties }));
  const folders = new Map();
  const folder = (id, parentIds) => ({ getId: () => id, getName: () => id === SOURCE ? 'Исходные базы' : 'Корень', isTrashed: () => false, getParents: () => iter(parentIds.map(parent => folders.get(parent))), getFolders: () => iter([]) });
  folders.set(ROOT, folder(ROOT, [])); folders.set(SOURCE, folder(SOURCE, [ROOT]));
  let fileParents = options.outside ? [ROOT] : [SOURCE];
  const makeFile = id => ({ getId: () => id, getName: () => 'Проверяемая база', isTrashed: () => !!options.trashed, getMimeType: () => options.mime || MIME, getParents: () => iter(fileParents.map(parent => folders.get(parent))) });
  const rows = options.sheets || [{ name: 'База', rows: [['Company_ID', 'Компания', 'Email', 'Телефон'], ['company1', 'Одна', 'a@example.com', '+7 999 123-45-67']] }];
  const context = vm.createContext({
    console,
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) ?? null, setProperty: () => { calls.propertiesWritten++; throw new Error('No property writes'); } }) },
    DriveApp: {
      getFolderById: id => { if (!folders.has(id)) throw new Error('Missing folder'); return folders.get(id); },
      getFileById: id => { calls.files.push(id); return makeFile(id); },
    },
    SpreadsheetApp: {
      openById: id => {
        calls.opened.push(id);
        return { getSheets: () => rows.map((sheet, sheetIndex) => ({
          getName: () => sheet.name,
          getSheetId: () => sheet.id ?? sheetIndex,
          getLastRow: () => sheet.lastRow ?? sheet.rows.length,
          getLastColumn: () => sheet.lastColumn ?? Math.max(0, ...sheet.rows.map(row => row.length)),
          getRange: (row, column, rowCount, columnCount) => ({ getDisplayValues: () => {
            calls.ranges.push({ sheet: sheet.name, row, column, rowCount, columnCount });
            options.onRead?.({ row, column, sheet: sheet.name, moveOutside: () => { fileParents = [ROOT]; }, revoke: () => properties.set('SHARED_ACCESS_KEY_SHA256', 'x'.repeat(43)) });
            return Array.from({ length: rowCount }, (_, y) => Array.from({ length: columnCount }, (_, x) => String(sheet.rows[row - 1 + y]?.[column - 1 + x] ?? '')));
          } }),
        })) };
      },
      flush: () => { calls.writes++; throw new Error('No flush'); },
    },
  });
  vm.runInContext(['Config.gs', 'Code.gs', 'SourceBases.gs', 'ContactPreview.gs'].map(name => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8')).join('\n'), context);
  // Target comparison has separate integration fixtures; these isolate input analysis.
  context.contactPreviewCompareTarget_ = () => {};
  installSharedApi(context, { accessKey: () => Object.hasOwn(options, 'accessKey') ? options.accessKey : TEST_ACCESS_KEY });
  if (options.limits) context.CONTACT_PREVIEW_LIMITS = { ...context.CONTACT_PREVIEW_LIMITS, ...options.limits };
  return { context, calls, properties, preview: (id = FILE) => plain(context.previewSourceBaseContacts({ id })) };
}

test('counts separate general and personal contact columns but excludes sender, comments and validation cells', () => {
  const f = fixture({ sheets: [{ name: 'ЛПР', rows: [
    ['Company_ID', 'Компания', 'Почта основная', 'Почта доп', 'Email-адреса', 'Тел основной', 'Тел доп', 'Мобильные телефоны', 'Email отправителя', 'Комментарий', 'Почта основная рез. валидации', 'ИНН руководителя'],
    ['one', 'Одна', 'Ann+test@EXAMPLE.COM', 'other@example.com', 'general@example.com; general@example.com', '+7 999 123-45-67', '8 (999) 123-45-67', '+7 495 123-45-67', 'sender@private.example', 'comment@private.example', 'bad@private.example', INN_B],
  ] }] });
  const r = f.preview();
  assert.equal(r.state, 'ready'); assert.equal(r.companies.unique, 1); assert.equal(r.scannedRows, 1);
  assert.deepEqual(r.emails, { occurrences: 4, unique: 3, multiCompany: 0, unresolved: 0 });
  assert.deepEqual(r.phones, { occurrences: 3, unique: 2, mobiles: 1, landlines: 1, unknownType: 0, multiCompany: 0, unresolved: 0 });
  assert.equal(r.sheets[0].emailColumns.length, 3);
  assert.equal(f.calls.opened.length, 1); assert.equal(f.calls.propertiesWritten, 0); assert.equal(f.calls.writes, 0);
});

test('company INN aliases join Full and LPR sheets without treating LPR generic ID as a company', () => {
  const f = fixture({ sheets: [
    { name: 'Полная база', rows: [['Company_ID', 'ИНН', 'Название', 'Email-адреса'], ['KITCHEN-1', INN_A, 'Компания А', 'SAME@EXAMPLE.COM'], ['KITCHEN-2', INN_B, 'Компания Б', 'same@example.com']] },
    { name: 'ЛПР', rows: [['ID', 'ИНН компании', 'Компания', 'Почта основная'], ['person42', INN_A, 'Компания А', 'same@example.com']] },
  ] });
  const r = f.preview();
  assert.equal(r.companies.unique, 2); assert.equal(r.emails.occurrences, 3); assert.equal(r.emails.unique, 1); assert.equal(r.emails.multiCompany, 1);
  assert.equal(r.conflicts.total, 1); assert.equal(r.conflicts.items[0].companies.length, 2);
  assert.equal(r.conflicts.items[0].sources.length, 3);
  assert.deepEqual(r.sheets[1].companyColumns.map(c => c.kind), ['inn', 'name']);
});

test('a late valid INN resolves earlier rows for the same source-local Company_ID', () => {
  const f = fixture({ sheets: [{ name: 'База', rows: [['Company_ID', 'ИНН', 'Компания', 'Email'], ['localA', '', 'A', 'one@example.com'], ['localA', INN_A, 'A', 'one@example.com'], ['', INN_A, 'A', 'two@example.com']] }] });
  const r = f.preview();
  assert.equal(r.companies.unique, 1); assert.equal(r.companies.unresolvedRows, 0); assert.equal(r.emails.unique, 2); assert.equal(r.emails.multiCompany, 0);
});

test('different valid INNs sharing one Company_ID are not merged and ambiguous ID-only rows remain unresolved', () => {
  const f = fixture({ sheets: [{ name: 'База', rows: [['Company_ID', 'ИНН', 'Компания', 'Email'], ['badID', INN_A, 'A', 'one@example.com'], ['badID', INN_B, 'B', 'one@example.com'], ['badID', '', 'Unknown', 'one@example.com']] }] });
  const r = f.preview();
  assert.equal(r.state, 'partial'); assert.equal(r.companies.unique, 2); assert.equal(r.companies.unresolvedRows, 1);
  assert.equal(r.emails.multiCompany, 1); assert.equal(r.emails.unresolved, 1); assert.ok(r.warnings.some(x => /разными ИНН/.test(x)));
});

test('company names, sites and persons do not silently become reliable identities', () => {
  const f = fixture({ sheets: [{ name: 'База', rows: [['ID', 'Компания', 'Сайт', 'Email'], ['person1', 'Одинаковая', 'same.example', 'one@example.com'], ['person2', 'Одинаковая', 'same.example', 'one@example.com']] }] });
  const r = f.preview();
  assert.equal(r.state, 'partial'); assert.equal(r.companies.unique, 0); assert.equal(r.companies.unresolvedRows, 2);
  assert.equal(r.scanComplete, true);
  assert.equal(r.emails.unique, 1); assert.equal(r.emails.multiCompany, 0); assert.equal(r.emails.unresolved, 1);
});

test('email normalization preserves plus aliases and dots', () => {
  const f = fixture({ sheets: [{ name: 'База', rows: [['Company_ID', 'Email'], ['a', 'A.B+tag@example.com; ab@example.com; a.b@example.com; A.B+TAG@EXAMPLE.COM']] }] });
  assert.equal(f.preview().emails.unique, 3);
});

test('unsupported Unicode local parts are not silently rewritten to ASCII addresses', () => {
  const f = fixture({ sheets: [{ name: 'База', rows: [['Company_ID', 'Email'], ['a', 'примерuser@example.com']] }] });
  const r = f.preview(); assert.equal(r.emails.unique, 0); assert.equal(r.state, 'partial'); assert.ok(r.warnings.some(x => /не удалось извлечь/.test(x)));
});

test('a mixed cell retains valid emails but unsupported fragments prevent a complete transfer estimate', () => {
  const f = fixture({ sheets: [{ name: 'База', rows: [['Company_ID','Email'], ['a','valid@example.com; примерuser@example.com']] }] });
  const r = f.preview(); assert.equal(r.emails.unique, 1); assert.equal(r.state, 'partial'); assert.equal(r.scanComplete, false);
});

test('scientific notation IDs do not silently merge rounded source identifiers', () => {
  const f = fixture({ sheets: [{ name: 'База', rows: [['Company_ID','Email'], ['1.23E+12','a@example.com'], ['1.23E+12','a@example.com']] }] });
  const r = f.preview(); assert.equal(r.companies.unique, 0); assert.equal(r.companies.unresolvedRows, 2); assert.equal(r.state, 'partial');
});

test('long company IDs never collide through display-label truncation', () => {
  const prefix = 'x'.repeat(181);
  const f = fixture({ sheets: [{ name: 'База', rows: [['Company_ID','Email'], [prefix + 'a','a@example.com'], [prefix + 'b','a@example.com']] }] });
  const r = f.preview(); assert.equal(r.companies.unique, 2); assert.equal(r.emails.multiCompany, 1);
});

test('duplicate company identity columns with different values require manual identity review', () => {
  const f = fixture({ sheets: [{ name: 'База', rows: [['Company_ID','ИНН','ИНН компании','Email'], ['a',INN_A,INN_B,'a@example.com']] }] });
  const r = f.preview(); assert.equal(r.state, 'partial'); assert.equal(r.companies.unique, 0); assert.equal(r.companies.unresolvedRows, 1);
});

test('common short Russian contact labels are recognized and unfamiliar contact headers warn', () => {
  const f = fixture({ sheets: [{ name: 'База', rows: [['Company_ID','Эл. почта','Мобильный 1','Почта для особых вопросов'], ['a','a@example.com','79991234567','b@example.com']] }] });
  const r = f.preview(); assert.equal(r.emails.unique, 1); assert.equal(r.phones.unique, 1); assert.equal(r.state, 'partial'); assert.ok(r.sheets[0].reason.includes('Почта для особых вопросов'));
});

test('an extra phone column annotated not checked for Telegram is still extracted', () => {
  const f = fixture({ sheets: [{ name: 'ЛПР', rows: [['Company_ID','Основной телефон','Доп. тел. (не проверяли на тг)'], ['a','79123456789','79223456789']] }] });
  const r = f.preview(); assert.equal(r.phones.unique, 2); assert.equal(r.sheets[0].phoneColumns.length, 2); assert.equal(r.state, 'ready');
});

test('phones distinguish mobile, landline and uncertain international or national format', () => {
  const f = fixture({ sheets: [{ name: 'База', rows: [['Company_ID', 'Телефон'], ['a', '+7(999)1234567;89991234567;+7(495)1234567;+44 20 7123 4567;9991234567']] }] });
  const r = f.preview();
  assert.deepEqual(r.phones, { occurrences: 5, unique: 4, mobiles: 1, landlines: 1, unknownType: 2, multiCompany: 0, unresolved: 0 });
});

test('a phone shared across companies produces one conflict with exact source rows', () => {
  const f = fixture({ sheets: [{ name: 'Компания', id: 12, rows: [['Company_ID', 'Телефон'], ['a', '79991234567'], ['a', '+7 999 123-45-67'], ['b', '8(999)1234567']] }] });
  const r = f.preview();
  assert.equal(r.phones.multiCompany, 1); assert.equal(r.conflicts.items[0].type, 'phone');
  assert.deepEqual(r.conflicts.items[0].sources.map(s => s.row), [2,3,4]);
  assert.equal(r.conflicts.items[0].sources[0].sheetId, 12);
});

test('multiple phones separated by newlines or spaces between complete national numbers are parsed independently', () => {
  const f = fixture({ sheets: [{ name: 'База', rows: [['Company_ID','Телефон'], ['a','79123456789\n79223456789'], ['b','79323456789 79423456789']] }] });
  const r = f.preview(); assert.equal(r.phones.occurrences, 4); assert.equal(r.phones.unique, 4); assert.equal(r.phones.mobiles, 4);
});

test('company rows without contacts count, while blank rows and grid padding do not', () => {
  const f = fixture({ sheets: [{ name: 'База', rows: [['Company_ID', 'Email'], ['a', ''], ['', ''], ['b', '']] }, { name: 'Пусто', rows: [] }] });
  const r = f.preview(); assert.equal(r.state, 'ready'); assert.equal(r.scannedRows, 2); assert.equal(r.companies.unique, 2); assert.equal(r.emails.unique, 0);
});

test('unrecognized nonempty sheets require mapping and never scan arbitrary email-looking body cells', () => {
  const f = fixture({ sheets: [{ name: 'Неясно', rows: [['Иное', 'Описание'], ['person', 'sender@example.com']] }] });
  const r = f.preview(); assert.equal(r.state, 'mapping_required'); assert.equal(r.scannedRows, 0); assert.equal(r.emails.unique, 0);
  assert.equal(f.calls.ranges.length, 1); assert.equal(f.calls.ranges[0].row, 1);
});

test('partial and mixed recognized/mapping sheets cannot present complete exact totals', () => {
  const f = fixture({ sheets: [{ name: 'База', rows: [['Company_ID','Email'], ['a','a@example.com']] }, { name: 'Неясно', rows: [['Что-то'], ['value']] }] });
  const r = f.preview(); assert.equal(r.state, 'partial'); assert.equal(r.emails.unique, 1); assert.equal(r.sheets[1].state, 'mapping_required');
  assert.equal(r.scanComplete, false);
});

test('volume and time caps return marked partial counts instead of false full totals', () => {
  const f = fixture({ limits: { maxRows: 1 }, sheets: [{ name: 'База', rows: [['Company_ID','Email'], ['a','a@example.com'], ['b','b@example.com']] }] });
  const r = f.preview(); assert.equal(r.state, 'partial'); assert.equal(r.scannedRows, 1); assert.equal(r.emails.unique, 1); assert.ok(r.warnings.length);
  const timed = fixture({ limits: { maxMillis: 0 } }).preview(); assert.equal(timed.state, 'partial'); assert.equal(timed.scannedRows, 0);
});

test('contact cap is explicit and conflict detail truncation keeps the total count', () => {
  const f = fixture({ limits: { maxConflicts: 1 }, sheets: [{ name: 'База', rows: [['Company_ID','Email'], ['a','a@example.com;b@example.com'], ['b','a@example.com;b@example.com']] }] });
  const r = f.preview(); assert.equal(r.conflicts.total, 2); assert.equal(r.conflicts.items.length, 1); assert.equal(r.conflicts.truncated, true);
  const g = fixture({ limits: { maxContacts: 1 }, sheets: [{ name: 'База', rows: [['Company_ID','Email'], ['a','a@example.com;b@example.com']] }] }).preview(); assert.equal(g.state, 'partial'); assert.equal(g.emails.unique, 1);
});

test('all 3550 conflict contacts fit the standard manual-review list and explicit payload cap is marked', () => {
  const rows = [['Company_ID','Компания','Email']];
  for (let index = 0; index < 3550; index++) { rows.push(['a','Компания А','shared' + index + '@example.com']); rows.push(['b','Компания Б','shared' + index + '@example.com']); }
  const f = fixture({ sheets: [{ name: 'База', rows }] });
  const r = f.preview(); assert.equal(r.conflicts.total, 3550); assert.equal(r.conflicts.items.length, 3550); assert.equal(r.conflicts.truncated, false);
  const limited = fixture({ limits: { maxDetailCharacters: 1 }, sheets: [{ name: 'База', rows: rows.slice(0,3) }] }).preview();
  assert.equal(limited.conflicts.total, 1); assert.equal(limited.conflicts.items.length, 0); assert.equal(limited.conflicts.truncated, true);
});

test('a kitchen-sized two-sheet file completes in bounded batch reads without grid-sized or per-contact reads', () => {
  const header = Array(44).fill('');
  header[0] = 'Company_ID'; header[3] = 'Название'; header[5] = 'Мобильные телефоны'; header[7] = 'Email-адреса'; header[15] = 'ИНН'; header[27] = 'Номера из ссылок соцсетей';
  const companyRows = Array.from({ length: 17128 }, (_, i) => {
    const row = Array(44).fill(''); row[0] = 'KITCHEN-' + i; row[3] = 'Компания ' + i; row[5] = '79' + (100000000 + i); row[7] = 'desk' + i + '@example.com'; return row;
  });
  const peopleRows = Array.from({ length: 550 }, (_, i) => ['KITCHEN-' + i, 'Компания ' + i, 'person' + i + '@example.com', '79' + (100000000 + i)]);
  const f = fixture({ sheets: [{ name: 'Полная база', rows: [header, ...companyRows] }, { name: 'ЛПР', rows: [['Company_ID','Компания','Почта основная','Основной телефон'], ...peopleRows] }] });
  const r = f.preview();
  assert.equal(r.state, 'ready'); assert.equal(r.scanComplete, true); assert.equal(r.scannedRows, 17678);
  assert.equal(r.companies.unique, 17128); assert.equal(r.emails.unique, 17678); assert.equal(r.phones.unique, 17128);
  assert.equal(f.calls.opened.length, 1); assert.equal(f.calls.ranges.length, 8);
  assert.ok(f.calls.ranges.reduce((sum, range) => sum + range.rowCount * range.columnCount, 0) < 500000);
});

test('authorization, source membership, service exclusion and native MIME checks precede business workbook access', () => {
  for (const options of [{ accessKey: null }, { accessKey: 'wrong' }, { accessKey: 'x'.repeat(43) }, { outside: true }, { trashed: true }, { mime: 'text/csv' }]) {
    const f = fixture(options); assert.throws(() => f.preview()); assert.equal(f.calls.opened.length, 0); assert.equal(f.calls.ranges.length, 0);
  }
  for (const id of [SERVICE, fixture().context.REGISTRY_CONFIG.defaultSourceBasesStorageId, fixture().context.REGISTRY_CONFIG.defaultContactCenterId]) {
    const f = fixture(); assert.throws(() => f.preview(id), /PROTECTED_FILE/); assert.equal(f.calls.opened.length, 0);
  }
  const otherCenter = fixture({ properties: { CONTACT_CENTER_ID: 'other_preview_center_12345' } });
  assert.throws(() => otherCenter.preview('other_preview_center_12345'), /PROTECTED_FILE/); assert.equal(otherCenter.calls.opened.length, 0);
});

test('movement or revoked access after header inspection blocks all body reads', () => {
  for (const action of ['moveOutside', 'revoke']) {
    const f = fixture({ onRead: event => { if (event.row === 1) event[action](); } });
    assert.throws(() => f.preview()); assert.equal(f.calls.ranges.length, 1); assert.equal(f.calls.ranges[0].row, 1);
  }
});

test('request accepts only source id and never arbitrary target or spreadsheet parameters', () => {
  const f = fixture(); assert.throws(() => f.context.previewSourceBaseContacts({ id: FILE, targetId: FILE }), /INVALID_REQUEST/); assert.equal(f.calls.opened.length, 0);
});
