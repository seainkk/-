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
  vm.runInContext(['ContactPreview.gs', 'SourceRecords.gs', 'PreparedData.gs'].map(name => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8')).join('\n'), context);
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
  assert.deepEqual(r.counts, { sourceRows: 3, companies: 2, companyUnknown: 0, emails: 2, phones: 2, mobiles: 1, sharedEmails: 1, sharedPhones: 0, telegrams: 0, sharedTelegrams: 0 });
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

test('mail addresses behind RichText and HYPERLINK labels are extracted from every ordinary column', () => {
  const f = fixture([
    ['Company_ID', 'Компания', 'Email', 'Доп. почта', 'Комментарий'],
    ['A', 'Альфа', 'Написать', 'Почта', 'Не брать'],
  ], {
    rich: { '2:3': { url: 'mailto:ann%2Btag@example.com?subject=hello&cc=sender@private.example' }, '2:5': { url: 'mailto:comment@private.example' } },
    formulas: { '2:4': '=HYPERLINK("mailto:second@example.com";"Почта")' },
  });
  const r = f.result();
  assert.deepEqual(r.emailRows.map(row => row[0]), ['ann+tag@example.com', 'comment@private.example', 'second@example.com']);
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

test('sender, validation and count fields are excluded while ordinary comments can contain contacts', () => {
  const r = fixture([
    ['Company_ID', 'Компания', 'Email', 'Email отправителя', 'Почта основная рез. валидации', 'Комментарий', 'Кол-во email'],
    ['A', 'Альфа', 'to@example.com', 'sender@private.example', 'validation@private.example', 'comment@private.example', 'counter@private.example'],
  ]).result();
  assert.deepEqual(r.emailRows.map(row => row[0]), ['comment@private.example', 'to@example.com']);
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
  const ann = r.emailRows.find(row => row[0] === 'ann@example.com'), boris = r.emailRows.find(row => row[0] === 'boris@example.com');
  assert.match(ann[1], /Анна Иванова/); assert.equal(ann[1].includes('Борис Петров'), false);
  assert.equal(boris[1], 'Альфа'); assert.equal(r.emailRows.every(row => row[3] === 'Да'), true);
  assert.deepEqual(r.records[0].people.map(person => person.name).sort(), ['Анна Иванова', 'Борис Петров']);
  assert.match(r.warnings.join(' '), /несколько (?:ЛПР|людей)/);
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

test('incomplete reads disable confirmation but unknown headers preserve source data and do not block', () => {
  const rows = [['Company_ID', 'Email'], ['A', 'a@example.com'], ['B', 'b@example.com']];
  for (const options of [{ limits: { maxRows: 2 } }, { limits: { maxCells: 2 } }, { limits: { maxColumns: 1 } }, { noRich: true }, { shortRich: true }]) {
    const r = fixture(rows, options).result(); assert.equal(r.complete, false, JSON.stringify(options)); assert.equal(r.canConfirm, false);
  }
  const unknown = fixture([['Непонятно'], ['some data']]).result(); assert.equal(unknown.canConfirm, true); assert.equal(unknown.counts.emails, 0);
  const ambiguous = fixture([['Company_ID', 'Phone ID'], ['A', '79991234567']]).result(); assert.equal(ambiguous.canConfirm, true); assert.equal(ambiguous.counts.phones, 0);
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


test('strong contacts in unfamiliar columns and arbitrary text are recognized without a header contract', () => {
  const r = fixture([
    ['Company_ID', 'Компания', 'Необычная колонка', 'Другое'],
    ['A', 'Альфа', 'Для связи: SALES@Example.COM, +7 (999) 123-45-67', 'Telegram: @Sales_Team'],
  ]).result();
  assert.equal(r.canConfirm, true); assert.equal(r.counts.emails, 1); assert.equal(r.counts.phones, 1); assert.equal(r.counts.telegrams, 1);
  assert.equal(r.emailRows[0][0], 'sales@example.com');
  assert.equal(r.phoneRows.find(row => row[0])[0], '+79991234567');
  assert.deepEqual(r.phoneRows.find(row => row[5] === '@sales_team').slice(5), ['@sales_team', 'Telegram']);
  assert.equal(r.records[0].source.column, undefined); assert.equal(r.records[0].provenance.emails['sales@example.com'][0].column, 3);
});

test('a title before the real header is preserved and does not hide company or contact data', () => {
  const r = fixture([
    ['Подборка кухонь 2026', '', ''],
    ['', '', ''],
    ['Company_ID', 'Компания', 'Email'],
    ['A', 'Альфа', 'one@example.com'],
  ]).result();
  assert.equal(r.source.headerIndex, 2); assert.equal(r.source.hasHeader, true); assert.equal(r.counts.sourceRows, 1);
  assert.equal(r.records[0].source.row, 4); assert.equal(r.records[0].company.id, 'A'); assert.equal(r.sourceValues[0][0], 'Подборка кухонь 2026');
});

test('headerless multi-column contacts include the first row and retain unresolved ownership for review', () => {
  const r = fixture([
    ['Анна', 'ann@example.com', '+7 999 123-45-67'],
    ['Борис', 'boris@example.com', '+7 999 765-43-21'],
  ]).result('lpr');
  assert.equal(r.source.hasHeader, false); assert.equal(r.counts.sourceRows, 2); assert.equal(r.counts.emails, 2); assert.equal(r.counts.phones, 2);
  assert.equal(r.emailRows.every(row => row[3] === 'Да'), true);
});

test('Telegram profiles normalize and deduplicate while invitations, posts and numeric IDs are not contacts', () => {
  const r = fixture([
    ['Company_ID', 'Telegram', 'Ещё'],
    ['A', '@Market_Team', 'https://t.me/market_team'],
    ['A', 'tg://resolve?domain=Another_User', 'https://telegram.me/another_user'],
    ['A', 'bare_user', 'mail@example.com'],
    ['A', '79991234567', 'https://t.me/+InviteHash12345'],
    ['A', 'https://t.me/market_team/123', 'https://t.me/joinchat/InviteHash'],
    ['A', 'https://t.me/share/url?url=https://a.example', 'tg://user?id=79991234567'],
  ]).result();
  assert.equal(r.counts.telegrams, 3); assert.equal(r.counts.phones, 0); assert.equal(r.counts.emails, 1);
  assert.deepEqual(r.phoneRows.map(row => row[5]), ['@another_user', '@bare_user', '@market_team']);
  assert.equal(r.phoneRows.every(row => row[0] === '' && row[6] === 'Telegram'), true);
  assert.deepEqual(r.phone.headers.slice(0, 5), ['Телефон', 'Компания / ЛПР', 'Откуда', 'Исходные строки', 'Проверить принадлежность']);
});

test('numeric dates, INN and ID columns and bare social profile paths cannot become fallback phones', () => {
  const r = fixture([
    ['Company_ID', 'Дата', 'ИНН', 'ID', 'Комментарий'],
    ['79991234567', new Date('2026-01-02T00:00:00Z'), INN_A, '79997654321', 'vk.com/79991234567, ok.ru/profile79991234567'],
    ['B', '02.01.2026', INN_B, '79990001122', 'Телефон: +7 999 111-22-33'],
  ], { display: { '2:2': '02.01.2026' } }).result();
  assert.deepEqual(r.phoneRows.map(row => row[0]), ['+79991112233']);
});

test('safe raw integers recover phones when the visible numeric format is scientific', () => {
  const r = fixture([
    ['Company_ID', 'Телефон', 'Другое'],
    ['A', 79991234567, 79997654321],
  ], { display: { '2:2': '7,99912E+10', '2:3': '7.99977E+10' } }).result();
  assert.deepEqual(r.phoneRows.map(row => row[0]), ['+79991234567', '+79997654321']);
});

test('normalized company and person records remain available even when nobody has contacts', () => {
  const r = fixture([
    ['Company_ID', 'Компания', 'Директор', 'Сайт', 'Город'],
    ['A', 'Альфа', 'Иван Петров', 'https://alpha.example', 'Москва'],
  ]).result();
  assert.equal(r.canConfirm, true); assert.equal(r.counts.emails, 0); assert.equal(r.counts.phones, 0);
  assert.equal(r.records.length, 1); assert.equal(r.records[0].company.website, 'https://alpha.example');
  assert.equal(r.records[0].people.length, 1); assert.equal(r.records[0].people[0].name, 'Иван Петров');
  assert.deepEqual(r.records[0].people[0].emails, []); assert.deepEqual(r.records[0].people[0].phones, []);
});

test('workbook scans all explicit leaves, deduplicates globally and keeps distinct source coordinates', () => {
  const a = fixture([['Company_ID', 'Компания', 'Email', 'Telegram'], ['A', 'Альфа', 'shared@example.com', '@alpha_team']], { sheetId: 11, name: 'Компании' });
  const b = fixture([['Company_ID', 'Компания', 'Email', 'Телефон'], ['B', 'Бета', 'shared@example.com', '+79991234567']], { sheetId: 22, name: 'ЛПР' });
  const r = plain(a.context.preparedDataReadWorkbook_({ getSheets: () => [a.sheet, b.sheet] }, FILE, 'companies', { guard() {} }));
  assert.equal(r.complete, true); assert.equal(r.canConfirm, true); assert.equal(r.counts.emails, 1); assert.equal(r.counts.phones, 1); assert.equal(r.counts.telegrams, 1);
  assert.equal(r.counts.sharedEmails, 1); assert.equal(r.records.length, 2); assert.deepEqual(r.sourceSheetIds, [11, 22]);
  assert.match(r.email.rows[0][2], /Компании: строки 2/); assert.match(r.email.rows[0][2], /ЛПР: строки 2/);
  const refs = r.contactIndex.find(item => item.type === 'email').sourceRefs;
  assert.deepEqual(refs.map(ref => [ref.sheetId, ref.row, ref.column]), [[11, 2, 3], [22, 2, 3]]);
});

test('workbook does not mistake an original sheet named Email for a generated target and validates source IDs', () => {
  const a = fixture([['Email'], ['one@example.com']], { sheetId: 11, name: 'Email' });
  const target = fixture([['Email'], ['old@example.com']], { sheetId: 22, name: 'Generated email' });
  const book = { getSheets: () => [a.sheet, target.sheet] };
  const all = plain(a.context.preparedDataReadWorkbook_(book, FILE, 'companies', {}));
  assert.equal(all.counts.emails, 2);
  const source = plain(a.context.preparedDataReadWorkbook_(book, FILE, 'companies', { sourceSheetIds: [11], managedSheetIds: [22] }));
  assert.equal(source.counts.emails, 1); assert.equal(source.email.rows[0][0], 'one@example.com');
  assert.throws(() => a.context.preparedDataReadWorkbook_(book, FILE, 'companies', { sourceSheetIds: [99] }), /SOURCE_CHANGED/);
  assert.throws(() => a.context.preparedDataReadWorkbook_(book, FILE, 'companies', { sourceSheetIds: [11, 11] }), /INVALID_REQUEST/);
  assert.throws(() => a.context.preparedDataReadWorkbook_(book, FILE, 'companies', { sourceSheetIds: [11], managedSheetIds: [11] }), /INVALID_REQUEST/);
});

test('an empty sibling source is allowed but an unreadable source prevents automatic partial application', () => {
  const a = fixture([['Company_ID', 'Email'], ['A', 'one@example.com']], { sheetId: 11 });
  const empty = fixture([], { sheetId: 22 });
  const r = plain(a.context.preparedDataReadWorkbook_({ getSheets: () => [a.sheet, empty.sheet] }, FILE, 'companies', {}));
  assert.equal(r.complete, true); assert.equal(r.canConfirm, true); assert.equal(r.counts.emails, 1);
  const bad = fixture([['Company_ID', 'Email'], ['B', 'two@example.com']], { sheetId: 33, noRich: true });
  const failed = plain(a.context.preparedDataReadWorkbook_({ getSheets: () => [a.sheet, bad.sheet] }, FILE, 'companies', {}));
  assert.equal(failed.complete, false); assert.equal(failed.canConfirm, false);
});


test('workbook can resolve simple cross-leaf HYPERLINK targets without reading unselected leaves', () => {
  const source = fixture([
    ['Company_ID', 'Ссылка'], ['A', 'Написать'],
  ], { sheetId: 11, name: 'Компании', formulas: { '2:2': '=HYPERLINK(\'Адреса\'!$B$2,"Написать")' } });
  const urls = fixture([['Company_ID', 'Сайт'], ['A', 'https://wa.me/79991234567']], { sheetId: 22, name: 'Адреса' });
  const book = { getSheets: () => [source.sheet, urls.sheet] };
  const full = plain(source.context.preparedDataReadWorkbook_(book, FILE, 'companies', {}));
  assert.equal(full.complete, true); assert.equal(full.counts.phones, 1); assert.equal(full.phoneRows[0][0], '+79991234567');
  assert.equal(full.models[0].formulaSnapshots[0].link, 'https://wa.me/79991234567');
  const restricted = plain(source.context.preparedDataReadWorkbook_(book, FILE, 'companies', { sourceSheetIds: [11] }));
  assert.equal(restricted.complete, false); assert.equal(restricted.canConfirm, false); assert.match(restricted.warnings.join(' '), /HYPERLINK/);
});

test('person-only records and grouped personal labels do not depend on the old company header aliases', () => {
  const noContacts = fixture([['Контактное лицо'], ['Иван Петров']]).result('lpr');
  assert.equal(noContacts.source.hasHeader, true); assert.equal(noContacts.records[0].people[0].name, 'Иван Петров');
  const mixed = fixture([
    ['Company_ID', 'Компания', 'ФИО1', 'Email1', 'ФИО2', 'Email2', 'Email компании'],
    ['A', 'Альфа', 'Анна Иванова', 'ann@example.com', 'Борис Петров', 'boris@example.com', 'info@example.com'],
  ]).result();
  assert.match(mixed.emailRows.find(row => row[0] === 'ann@example.com')[1], /Анна Иванова/);
  assert.match(mixed.emailRows.find(row => row[0] === 'boris@example.com')[1], /Борис Петров/);
  assert.equal(mixed.emailRows.find(row => row[0] === 'info@example.com')[1], 'Альфа');
});


test('invalid Telegram tokens are not truncated into invented valid usernames', () => {
  const r = fixture([['Company_ID', 'Telegram'], ['A', '@john-doe; @john.doe; a@domain.example'], ['A', 'Пишите @valid_user.']]).result();
  assert.deepEqual(r.phoneRows.map(row => row[5]), ['@valid_user']);
});

test('ISO dates and explicitly labelled inline numeric IDs are not telephone contacts', () => {
  const r = fixture([['Company_ID', 'Телефон', 'Комментарий'], ['A', '2026-01-02', 'ID: 79991234567; ИНН: 7707083893']]).result();
  assert.equal(r.counts.phones, 0);
});

test('an unlabelled bare Russian-looking number is a review candidate, not certain ownership', () => {
  const r = fixture([['Company_ID', 'Компания', 'Данные'], ['A', 'Альфа', '79991234567']]).result();
  assert.equal(r.counts.phones, 1); assert.equal(r.phoneRows[0][4], 'Да'); assert.equal(r.contactIndex[0].needsReview, true);
});


test('an embedded social URL inside another URL is not promoted into a trusted phone or Telegram profile', () => {
  const r = fixture([
    ['Company_ID', 'Другое'],
    ['A', 'https://evil.invalid/?next=https://wa.me/79991234567'],
    ['A', 'https://evil.invalid/t.me/valid_user'],
    ['A', 'https://wa.me.evil.invalid/79991234567'],
    ['A', 'https://t.me@evil.invalid/valid_user'],
  ]).result();
  assert.equal(r.counts.phones, 0); assert.equal(r.counts.telegrams, 0);
  const bare = fixture([['Company_ID', 'Другое'], ['A', 'WhatsApp:wa.me/79991234567;Telegram:t.me/valid_user']]).result();
  assert.equal(bare.counts.phones, 1); assert.equal(bare.counts.telegrams, 1);
});


test('transfer status columns never create people or contacts during subsequent automatic checks', () => {
  const r = fixture([
    ['Company_ID', 'Компания', 'ФИО ЛПР', 'Перенос в ЛПР', 'ID ЛПР'],
    ['A', 'Альфа', 'Анна Иванова', 'Перенесено в ЛПР — +79991234567 test@example.com @fake_user', 'lpr_79997654321'],
  ]).result();
  assert.equal(r.records[0].people.length, 1); assert.equal(r.records[0].people[0].name, 'Анна Иванова');
  assert.equal(r.counts.emails, 0); assert.equal(r.counts.phones, 0); assert.equal(r.counts.telegrams, 0);
});


test('a legacy source fingerprint remains available for safe version-one job recovery', () => {
  const f = fixture([['Company_ID', 'Email'], ['A', 'one@example.com']]);
  const r = f.result();
  const oldHash = crypto.createHash('sha256').update(JSON.stringify({ version: 1, sourceId: FILE, section: 'companies', sheetId: 42, sheetName: 'Исходник', rows: 2, columns: 2, values: r.sourceValues, display: r.sourceDisplayValues, formulas: [['', ''], ['', '']], links: [] })).digest('base64url');
  assert.equal(r.legacyFingerprint, oldHash); assert.notEqual(r.fingerprint, oldHash);
});


test('explicit per-leaf header and LPR section settings are respected for generic Name Email Phone columns', () => {
  const f = fixture([['Name', 'Email', 'Phone'], ['Anna Smith', 'ann@example.com', '+79991234567']]);
  const r = plain(f.context.preparedDataRead_(f.sheet, FILE, 'lpr', { guard() {}, hasHeader: true, headerIndex: 0 }));
  assert.equal(r.source.hasHeader, true); assert.equal(r.source.headerIndex, 0); assert.equal(r.counts.sourceRows, 1);
  assert.equal(r.records[0].people[0].name, 'Anna Smith'); assert.deepEqual(r.records[0].people[0].emails, ['ann@example.com']);
  assert.deepEqual(r.records[0].people[0].phones, ['+79991234567']);
});

test('explicit no-header keeps a header-like first data row and validates header override inputs', () => {
  const f = fixture([['Email', 'Телефон'], ['ann@example.com', '+79991234567']]);
  const r = plain(f.context.preparedDataRead_(f.sheet, FILE, 'companies', { guard() {}, hasHeader: false }));
  assert.equal(r.source.hasHeader, false); assert.equal(r.source.headerIndex, -1); assert.equal(r.counts.sourceRows, 2);
  assert.equal(r.records[0].source.row, 1); assert.equal(r.counts.emails, 1); assert.equal(r.counts.phones, 1);
  for (const settings of [{ hasHeader: 'false' }, { hasHeader: true, headerIndex: -1 }, { hasHeader: true, headerIndex: 2 }, { hasHeader: true, headerIndex: 0.5 }]) assert.throws(() => f.context.preparedDataRead_(f.sheet, FILE, 'companies', settings), /INVALID_REQUEST/);
});
