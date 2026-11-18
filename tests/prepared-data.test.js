import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const FILE = 'prepared_source_file_1234567890';
const plain = value => JSON.parse(JSON.stringify(value));
const inn = prefix => prefix + ([2, 4, 10, 3, 5, 9, 4, 6, 8].reduce((sum, n, index) => sum + n * Number(prefix[index]), 0) % 11 % 10);
const INN_A = inn('770708389'), INN_B = inn('771014067');

function fixture(rows, options = {}) {
  const calls = { reads: [], guards: 0, writes: 0 };
  const width = options.width ?? Math.max(0, ...rows.map(row => row.length));
  const context = vm.createContext({ console });
  vm.runInContext(['ContactPreview.gs', 'PreparedData.gs'].map(name => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8')).join('\n'), context);
  context.digest_ = value => crypto.createHash('sha256').update(value).digest('base64url');
  context.fail_ = (code, text) => { throw new Error('[' + code + '] ' + text); };
  if (options.limits) context.PREPARED_DATA_LIMITS = { ...context.PREPARED_DATA_LIMITS, ...options.limits };
  const cell = (r, c) => rows[r - 1]?.[c - 1] ?? '';
  const show = (r, c) => options.display?.[`${r}:${c}`] ?? String(cell(r, c));
  const rich = (r, c) => {
    const specified = options.rich?.[`${r}:${c}`];
    if (!specified) return null;
    const runs = specified.runs || [{ text: show(r, c), url: specified.url, start: 0 }];
    return {
      getLinkUrl: () => specified.url || null,
      getRuns: () => runs.map(run => ({ getText: () => run.text, getLinkUrl: () => run.url, getStartIndex: () => run.start, getEndIndex: () => run.start + run.text.length })),
    };
  };
  const sheet = {
    getLastRow: () => options.lastRow ?? rows.length,
    getLastColumn: () => width,
    getSheetId: () => options.sheetId ?? 42,
    getName: () => options.name || 'Исходник',
    getRange: (row, column, height, columns) => {
      calls.reads.push({ row, column, height, columns });
      const matrix = accessor => Array.from({ length: height }, (_, y) => Array.from({ length: columns }, (_, x) => accessor(row + y, column + x)));
      const range = {
        getValues: () => { options.onRead?.('values'); return matrix(cell); },
        getDisplayValues: () => matrix(show),
        getFormulas: () => matrix((r, c) => options.formulas?.[`${r}:${c}`] || ''),
        getRichTextValues: () => options.shortRich ? [] : matrix(rich),
        setValues: () => { calls.writes++; throw new Error('Writes forbidden'); },
      };
      if (options.noRich) delete range.getRichTextValues;
      return range;
    },
  };
  const read = (section = 'companies') => context.preparedDataRead_(sheet, FILE, section, { guard: () => { calls.guards++; options.guard?.(); } });
  return { context, sheet, calls, read, result: section => plain(read(section)) };
}

test('one selected source becomes exactly three preview sheets and unique contact rows', () => {
  const f = fixture([
    ['Company_ID', 'Компания', 'Email', 'Телефон'],
    ['A', 'Альфа', 'ONE@EXAMPLE.COM; two@example.com', '+7 999 123-45-67'],
    ['A', 'Альфа', 'one@example.com', '8 (999) 123-45-67'],
    ['B', 'Бета', 'one@example.com', '+7 (495) 123-45-67'],
  ]);
  const r = f.result();
  assert.equal(r.complete, true); assert.equal(r.canConfirm, true);
  assert.deepEqual(r.previewSheets.map(s => s.name), ['Исходная база', 'Email', 'Телефоны']);
  assert.deepEqual(r.counts, { sourceRows: 3, companies: 2, companyUnknown: 0, emails: 2, phones: 2, mobiles: 1, sharedEmails: 1, sharedPhones: 0 });
  assert.deepEqual(r.emailRows.map(row => row[0]), ['one@example.com', 'two@example.com']);
  assert.equal(r.emailRows[0][1], 'Альфа; Бета');
  assert.equal(r.emailRows[0][2], 'Строки 2–4'); assert.equal(r.emailRows[0][3], 'Да');
  assert.equal(r.phoneRows.find(row => row[0] === '+79991234567')[4], '');
  assert.equal(r.sourceValues.length, 4); assert.equal(r.sourceRows, 4); assert.equal(r.sourceCols, 4);
  assert.equal(f.calls.writes, 0); assert.ok(f.calls.guards >= 4);
});

test('social-link phones deduplicate with plain phones; numeric social profile IDs never become phones', () => {
  const f = fixture([
    ['Company_ID', 'Компания', 'Телефон', 'Ссылка', 'Контакт'],
    ['A', 'Альфа', '8 (999) 123-45-67; https://vk.com/id79998887766', 'https://wa.me/79991234567', 'Написать'],
    ['A', 'Альфа', 'https://ok.ru/profile79998887766', 'https://instagram.com/p/79998887766', ''],
  ], { rich: { '2:5': { url: 'https://api.whatsapp.com/send?phone=%2B79991234567' } } });
  const r = f.result();
  assert.equal(r.canConfirm, true); assert.equal(r.counts.phones, 1);
  assert.equal(r.phoneRows[0][0], '+79991234567');
  assert.match(r.phoneRows[0][2], /WhatsApp/); assert.match(r.phoneRows[0][2], /Столбец/);
  assert.equal(r.phoneRows.some(row => row[0].includes('8887766')), false);
});

test('explicit phone URL schemes work without browser URL or URLSearchParams globals', () => {
  const { context: c } = fixture([['Телефон']]);
  for (const [url, number] of [
    ['tel:+7(999)123-45-67;ext=99', '+79991234567'],
    ['https://wa.me/79991234567?text=hello', '+79991234567'],
    ['https://web.whatsapp.com/send?phone=%2B442079460123&text=hello', '+442079460123'],
    ['tg://resolve?phone=%2B79991234567', '+79991234567'],
    ['https://t.me/+79991234567', '+79991234567'],
    ['viber://chat?number=%2B79991234567', '+79991234567'],
    ['viber://add?phone=%2B79991234567', '+79991234567'],
  ]) assert.equal(c.preparedDataUrlPhones_(url)[0]?.value, number, url);
  for (const url of ['https://vk.com/id79991234567', 'https://ok.ru/profile79991234567', 'https://max.ru/u/79991234567', 'https://instagram.com/79991234567', 'https://t.me/+invite123', 'https://t.me/79991234567', 'https://wa.me.evil.invalid/79991234567', 'https://wa.me@evil.invalid/79991234567', 'https://evil.invalid/?next=https://wa.me/79991234567']) assert.equal(c.preparedDataUrlPhones_(url).length, 0, url);
});

test('formatted tel links in plain text keep their country code instead of leaving an orphan local number', () => {
  const r = fixture([['Company_ID', 'Телефон'], ['A', 'tel:+7 (999) 123-45-67; ext=12']]).result();
  assert.deepEqual(r.phoneRows.map(row => row[0]), ['+79991234567']);
});

test('RichText runs and literal HYPERLINK formulas expose phone links behind labels', () => {
  const f = fixture([
    ['Company_ID', 'Компания', 'Ссылка', 'Действие'],
    ['A', 'Альфа', 'Написать', 'Позвонить'],
  ], {
    rich: { '2:3': { runs: [{ text: 'Написать', start: 0, url: 'https://wa.me/79991234567' }] } },
    formulas: { '2:4': '=HYPERLINK("tel:+442079460123";"Позвонить")' },
  });
  const r = f.result();
  assert.equal(r.counts.phones, 2); assert.equal(r.formulaSnapshots.length, 1);
  assert.equal(r.formulaSnapshots[0].value, 'Позвонить');
  assert.equal(r.formulaSnapshots[0].link, 'tel:+442079460123');
  assert.equal(r.sourceLinks.length, 2);
});

test('local-reference HYPERLINK is resolved from selected source values only', () => {
  const f = fixture([
    ['Company_ID', 'Компания', 'Адрес ссылки', 'Связаться'],
    ['A', 'Альфа', 'https://wa.me/79991234567', 'WhatsApp'],
  ], { formulas: { '2:4': '=HYPERLINK($C$2,"WhatsApp")' } });
  const r = f.result(); assert.equal(r.counts.phones, 1); assert.equal(r.canConfirm, true);
  assert.equal(r.formulaSnapshots[0].link, 'https://wa.me/79991234567');
  const bad = fixture([['Company_ID', 'Компания', 'Ссылка'], ['A', 'Альфа', 'WhatsApp']], { formulas: { '2:3': '=HYPERLINK(ДругойЛист!A2;"WhatsApp")' } }).result();
  assert.equal(bad.canConfirm, false); assert.match(bad.warnings.join(' '), /HYPERLINK/);
});

test('mail addresses behind RichText and HYPERLINK labels are extracted only from email columns', () => {
  const f = fixture([
    ['Company_ID', 'Компания', 'Email', 'Доп. почта', 'Комментарий'],
    ['A', 'Альфа', 'Написать', 'Почта', 'Не брать'],
  ], {
    rich: { '2:3': { url: 'mailto:ann%2Btag@example.com?subject=hello&cc=sender@private.example' }, '2:5': { url: 'mailto:comment@private.example' } },
    formulas: { '2:4': '=HYPERLINK("mailto:second@example.com";"Почта")' },
  });
  const r = f.result();
  assert.deepEqual(r.emailRows.map(row => row[0]), ['ann+tag@example.com', 'second@example.com']);
  assert.equal(r.canConfirm, true);
});

test('mixed contact columns cannot reinterpret digits from email localparts as phone numbers', () => {
  const r = fixture([
    ['Company_ID', 'Компания', 'Контакты', 'Email / Телефон'],
    ['A', 'Альфа', 'sales79123456789@example.com', 'real@example.com; +7 999 123-45-67'],
  ]).result();
  assert.equal(r.counts.emails, 2); assert.equal(r.counts.phones, 1);
  assert.deepEqual(r.phoneRows.map(row => row[0]), ['+79991234567']);
});

test('sender, validation, count and comment fields are not email contact columns', () => {
  const r = fixture([
    ['Company_ID', 'Компания', 'Email', 'Email отправителя', 'Почта основная рез. валидации', 'Комментарий', 'Кол-во email'],
    ['A', 'Альфа', 'to@example.com', 'sender@private.example', 'validation@private.example', 'comment@private.example', 'counter@private.example'],
  ]).result();
  assert.deepEqual(r.emailRows.map(row => row[0]), ['to@example.com']);
});

test('email extraction preserves Unicode, dots and plus aliases without inventing truncated addresses', () => {
  const r = fixture([
    ['Company_ID', 'Email'],
    ['A', 'Анна@пример.рф; A.B+Tag@EXAMPLE.COM; ab@example.com; broken@@example.com'],
  ]).result();
  assert.deepEqual(r.emailRows.map(row => row[0]), ['a.b+tag@example.com', 'ab@example.com', 'анна@пример.рф']);
  assert.equal(r.canConfirm, true); assert.match(r.warnings.join(' '), /не удалось распознать/);
  assert.equal(r.sourceValues[1][1].includes('broken@@'), true);
});

test('unknown country/local phones are kept without inventing +7 or declaring Telegram eligibility', () => {
  const r = fixture([['Company_ID', 'Телефон'], ['A', '9991234567; 123456; +44 20 7946 0123']]).result();
  assert.deepEqual(r.phoneRows.map(row => row[0]), ['+442079460123', '123456', '9991234567']);
  assert.equal(r.counts.mobiles, 0); assert.match(r.warnings.join(' '), /международного/);
});

test('Company_ID aliases use valid INN while generic person IDs and matching names are not companies', () => {
  const r = fixture([
    ['Company_ID', 'ИНН', 'Компания', 'Email'],
    ['A', INN_A, 'Альфа', 'same@example.com'],
    ['A', '', 'Альфа', 'same@example.com'],
    ['B', INN_B, 'Бета', 'same@example.com'],
  ]).result();
  assert.equal(r.counts.companies, 2); assert.equal(r.counts.sharedEmails, 1); assert.equal(r.counts.companyUnknown, 0);
  const unknown = fixture([['ID', 'Компания', 'Email'], ['personA', 'Одинаковая', 'one@example.com'], ['personB', 'Одинаковая', 'one@example.com']]).result();
  assert.equal(unknown.counts.companies, 0); assert.equal(unknown.counts.companyUnknown, 2); assert.equal(unknown.emailRows[0][3], 'Да'); assert.equal(unknown.canConfirm, true);
});

test('LPR and general company email keep their distinct human context', () => {
  const r = fixture([
    ['Company_ID', 'Компания', 'ФИО', 'Должность', 'Почта основная', 'Email-адреса'],
    ['A', 'Альфа', 'Анна Иванова', 'Маркетолог', 'ann@example.com', 'info@example.com'],
  ]).result('lpr');
  assert.equal(r.emailRows.find(row => row[0] === 'ann@example.com')[1], 'Альфа — Анна Иванова (Маркетолог)');
  assert.equal(r.emailRows.find(row => row[0] === 'info@example.com')[1], 'Альфа');
});

test('two horizontal LPR groups do not become an invented combined person', () => {
  const r = fixture([
    ['Company_ID', 'Компания', 'Руководитель', 'ЛПР маркетинг', 'Email руководителя', 'Email ЛПР'],
    ['A', 'Альфа', 'Анна Иванова', 'Борис Петров', 'ann@example.com', 'boris@example.com'],
  ]).result('lpr');
  assert.equal(r.emailRows.every(row => row[1] === 'Альфа' && row[3] === 'Да'), true);
  assert.match(r.warnings.join(' '), /несколько ЛПР/);
});

test('source values, formulas, links and selected section participate in preview fingerprints', () => {
  const rows = [['Company_ID', 'Компания', 'Email', 'Ссылка'], ['A', 'Альфа', 'one@example.com', 'WhatsApp']];
  const a = fixture(rows, { rich: { '2:4': { url: 'https://wa.me/79991234567' } } }).result();
  const b = fixture(rows, { rich: { '2:4': { url: 'https://wa.me/79997654321' } } }).result();
  const c = fixture(rows, { formulas: { '2:2': '="Альфа"' }, rich: { '2:4': { url: 'https://wa.me/79991234567' } } }).result();
  assert.notEqual(a.fingerprint, b.fingerprint); assert.notEqual(a.fingerprint, c.fingerprint);
  assert.notEqual(a.fingerprint, fixture(rows, { rich: { '2:4': { url: 'https://wa.me/79991234567' } } }).result('lpr').fingerprint);
  assert.equal(a.fingerprint, fixture(rows, { rich: { '2:4': { url: 'https://wa.me/79991234567' } } }).result().fingerprint);
});

test('formula snapshots contain computed typed values and safe literal helper never executes contact content', () => {
  const date = new Date('2026-01-02T00:00:00Z');
  const f = fixture([['Company_ID', 'Компания', 'Дата', 'Email'], ['A', 'Альфа', date, '=evil@example.com']], { formulas: { '2:3': '=DATE(2026,1,2)' }, display: { '2:3': '02.01.2026' } });
  const r = f.result();
  assert.equal(r.formulaSnapshots[0].valueType, 'date'); assert.equal(r.formulaSnapshots[0].value, date.toISOString());
  assert.equal(r.sourceDisplayValues[1][2], '02.01.2026');
  for (const value of ['=SUM(1,2)', '+79991234567', '-abc@example.com', '@label', "'literal", '  =1']) assert.equal(f.context.preparedDataLiteral_(value), "'" + value);
  assert.equal(f.context.preparedDataLiteral_('ann@example.com'), 'ann@example.com');
  assert.equal(f.context.preparedDataLiteral_(12), 12); assert.equal(f.calls.writes, 0);
});

test('headerless one-column email, phone and phone-link lists include the first contact', () => {
  for (const [rows, emails, phones] of [
    [[['one@example.com'], ['two@example.com']], 2, 0],
    [[['+79991234567'], ['89991234567']], 0, 1],
    [[['https://wa.me/79991234567'], ['https://wa.me/79997654321']], 0, 2],
  ]) {
    const r = fixture(rows).result(); assert.equal(r.source.hasHeader, false); assert.equal(r.counts.emails, emails); assert.equal(r.counts.phones, phones); assert.equal(r.counts.sourceRows, 2); assert.equal(r.canConfirm, true);
  }
});

test('limits, absent rich link inspection, shortened ranges and unreadable mappings disable confirmation', () => {
  const rows = [['Company_ID', 'Email'], ['A', 'a@example.com'], ['B', 'b@example.com']];
  for (const options of [{ limits: { maxRows: 2 } }, { limits: { maxCells: 2 } }, { limits: { maxColumns: 1 } }, { noRich: true }, { shortRich: true }]) {
    const r = fixture(rows, options).result(); assert.equal(r.complete, false, JSON.stringify(options)); assert.equal(r.canConfirm, false);
  }
  const unknown = fixture([['Непонятно'], ['some data']]).result(); assert.equal(unknown.canConfirm, false);
  const ambiguous = fixture([['Company_ID', 'Phone ID'], ['A', '79991234567']]).result(); assert.equal(ambiguous.canConfirm, false);
});

test('guard failures after a chunk prevent any preview from being returned', () => {
  let changed = false;
  const f = fixture([['Company_ID', 'Email'], ['A', 'a@example.com']], { onRead: () => { changed = true; }, guard: () => { if (changed) throw new Error('Scope changed'); } });
  assert.throws(() => f.read(), /Scope changed/); assert.equal(f.calls.writes, 0);
});

test('large input is read in bounded chunks and returns every unique contact', () => {
  const rows = [['Company_ID', 'Компания', 'Email', 'Телефон'], ...Array.from({ length: 5000 }, (_, i) => ['C' + i, 'Компания ' + i, `a${i}@example.com`, '+7999' + String(i).padStart(7, '0')])];
  const f = fixture(rows, { limits: { chunkCells: 2000 } }), r = f.result();
  assert.equal(r.counts.emails, 5000); assert.equal(r.counts.phones, 5000); assert.equal(r.canConfirm, true);
  assert.ok(f.calls.reads.length > 1); assert.ok(f.calls.reads.every(read => read.height * read.columns <= 2000)); assert.equal(f.calls.writes, 0);
});

test('Kitchen-sized selected sheet fits the full snapshot budget in eight bounded reads', () => {
  const header = Array.from({ length: 44 }, (_, index) => 'Поле ' + index);
  header[0] = 'Company_ID'; header[3] = 'Компания'; header[5] = 'Мобильные телефоны'; header[7] = 'Email-адреса'; header[10] = 'WhatsApp';
  const rows = [header, ...Array.from({ length: 17128 }, (_, index) => {
    const row = Array(44).fill('');
    row[0] = 'KITCHEN-' + index; row[3] = 'Компания ' + index;
    row[5] = '+7999' + String(index).padStart(7, '0'); row[7] = 'contact' + index + '@example.com';
    if (index % 100 === 0) row[10] = 'https://wa.me/' + row[5].slice(1);
    return row;
  })];
  const f = fixture(rows), r = f.result();
  assert.equal(r.canConfirm, true); assert.equal(r.counts.sourceRows, 17128);
  assert.equal(r.counts.emails, 17128); assert.equal(r.counts.phones, 17128);
  assert.equal(f.calls.reads.length, 8);
  assert.ok(f.calls.reads.reduce((sum, range) => sum + range.height * range.columns, 0) < 1000000);
});

test('convenience wrapper requires caller staging guard and resolves one exact selected sheet', () => {
  const f = fixture([['Email'], ['one@example.com']]);
  f.context.SpreadsheetApp = { openById: id => { assert.equal(id, FILE); return { getSheets: () => [f.sheet] }; } };
  assert.throws(() => f.context.preparedReadSource_({}, FILE, 42, 'companies'), /INVALID_REQUEST/);
  let guards = 0;
  assert.equal(f.context.preparedReadSource_({}, FILE, 42, 'companies', { guard: () => { guards++; } }).counts.emails, 1);
  assert.ok(guards > 1);
  assert.throws(() => f.context.preparedReadSource_({}, FILE, 99, 'companies', { guard: () => {} }), /SHEET_NOT_FOUND/);
});
