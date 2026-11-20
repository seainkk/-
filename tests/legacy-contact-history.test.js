import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const script = ['Config.gs', 'LegacyContactHistory.gs'].map(name => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8')).join('\n');
function env() { const context = vm.createContext({}); vm.runInContext(script, context); return context; }
function leaf(headers, rows, name = 'Исходная база', id = 0) {
  return { source: { headers, hasHeader: true, headerIndex: 0, name, sheetId: id }, sourceDisplayValues: [headers, ...rows] };
}
function model(leaves, emails = [], phones = []) {
  return { models: leaves, email: { headers: ['Email', 'Компания / ЛПР', 'Исходные строки', 'Проверить принадлежность'], rows: emails.map(email => [email, 'Компания', '2', 'Нет']) },
    phone: { headers: ['Телефон', 'Компания / ЛПР', 'Откуда', 'Исходные строки', 'Проверить принадлежность', 'Telegram', 'Тип контакта'], rows: phones.map(phone => [phone, 'Компания', 'Телефон', '2', 'Нет', '', 'Мобильный']) }, warnings: [] };
}
function field(list, row, header) { return list.rows[row][list.headers.indexOf(header)]; }

test('known source mailing history initializes the working status and preserves the original text', () => {
  const c = env(), addresses = ['sent@example.test', 'excluded@example.test', 'unknown@example.test'];
  const data = model([leaf(['Email', 'Статус'], [[addresses[0], 'Запущен'], [addresses[1], 'Фильтр'], [addresses[2], 'Сбор']])], addresses);
  data.email.headers.push('Статус рассылки');
  data.email.rows.forEach(row => row.push('новый'));
  c.legacyContactHistoryEnrich_(data);
  assert.deepEqual(data.email.rows.map((_, row) => field(data.email, row, 'Статус рассылки')), ['в рассылке', 'фильтр', 'новый']);
  assert.deepEqual(data.email.rows.map((_, row) => field(data.email, row, 'Статус из источника')), ['Запущен', 'Фильтр', '']);
});

test('legacy source validation preserves all completed email verdicts and real mailbox providers', () => {
  const c = env(); const data = model([leaf(['Email', 'Валидация', 'Провайдер'], [
    ['valid@example.test', 'valid', 'Yandex'], ['invalid@example.test', 'invalid', 'Other'], ['risk@example.test', 'accept_all', 'Google'], ['unknown@example.test', 'unknown', '']
  ])], ['valid@example.test', 'invalid@example.test', 'risk@example.test', 'unknown@example.test']);
  c.legacyContactHistoryEnrich_(data);
  assert.deepEqual(data.email.rows.map((_, i) => field(data.email, i, 'Валидация')), ['Валиден', 'Невалиден', 'Рискованный', 'Неизвестно']);
  assert.equal(field(data.email, 0, 'Провайдер'), 'Yandex'); assert.equal(field(data.email, 0, 'Дата проверки'), '');
  assert.equal(field(data.email, 0, 'Валидатор'), 'источник');
});

test('previous mailing is not a new contact or a valid auto-upload candidate', () => {
  const c = env(); const data = model([leaf(['Email', 'Валидация', 'Статус'], [['one@example.test', 'valid', 'Рассылка']])], ['one@example.test']);
  c.legacyContactHistoryEnrich_(data);
  assert.equal(field(data.email, 0, 'Валидация'), 'Проверить историю контакта');
  assert.equal(field(data.email, 0, 'Статус из источника'), 'Рассылка');
  const raw = field(data.email, 0, 'Результат проверки'); assert.match(raw, /valid/); assert.match(raw, /Рассылка/);
  assert.doesNotMatch(field(data.email, 0, 'Валидация'), /^(валиден|valid)$/i);
});

test('manual exclusions with no provider verdict remain completed and ineligible', () => {
  const c = env(); const statuses = ['Фильтр', 'Нецелевой', 'Не совпал', 'Дубль', 'Невалид', 'Срок > 30'];
  const emails = statuses.map((_, i) => `person${i}@example.test`);
  const data = model([leaf(['Email', 'Статус'], statuses.map((status, i) => [emails[i], status]))], emails);
  c.legacyContactHistoryEnrich_(data);
  data.email.rows.forEach((_, i) => assert.equal(field(data.email, i, 'Валидация'), 'Проверить историю контакта'));
});

test('benign collection statuses and unchecked values do not create fake completions', () => {
  const c = env(); const data = model([leaf(['Email', 'Статус', 'Валидация'], [['new@example.test', 'Нашли контакты', 'not_verified'], ['other@example.test', 'Сбор', 'Не проверено']])], ['new@example.test', 'other@example.test']);
  c.legacyContactHistoryEnrich_(data); assert.equal(data.email.headers.length, 4); assert.equal(data.legacyHistory, undefined);
});

test('different company and personal numbers are not given each others Telegram results', () => {
  const c = env(); const data = model([leaf(['Мобильные телефоны', 'Тел основной', 'ID_TG', 'Nickname_TG', 'Active_days_ago', 'Тел доп'], [
    ['79990000001', '79990000002', '123456789', 'example_person', '12', '79990000003']
  ])], [], ['+79990000001', '+79990000002', '+79990000003']);
  c.legacyContactHistoryEnrich_(data);
  assert.equal(field(data.phone, 0, 'Валидация'), ''); assert.equal(field(data.phone, 1, 'ID_TG'), '123456789');
  assert.equal(field(data.phone, 1, 'Для Telegram'), 'Да'); assert.equal(field(data.phone, 2, 'Валидация'), '');
});

test('an explicit Telegram negative is a completed result with no invented user ID', () => {
  const c = env(); const data = model([leaf(['Тел основной', 'ID_TG', 'Active_days_ago'], [['79990000004', 'нет', '']])], [], ['+79990000004']);
  c.legacyContactHistoryEnrich_(data); assert.equal(field(data.phone, 0, 'Валидация'), 'Telegram не найден');
  assert.equal(field(data.phone, 0, 'Для Telegram'), 'Нет'); assert.equal(field(data.phone, 0, 'ID_TG'), '');
});

test('inactive Telegram keeps ID, nickname and exact days without an invented check date', () => {
  const c = env(); const data = model([leaf(['Мобильный телефон', 'ID_TG', 'Nickname_TG', 'Active_days_ago'], [['89990000005', '987654321', 'offline_person', '101']])], [], ['+79990000005']);
  c.legacyContactHistoryEnrich_(data); assert.equal(field(data.phone, 0, 'Валидация'), 'Telegram: более 30 дней офлайн');
  assert.equal(field(data.phone, 0, 'Active_days_ago'), '101'); assert.equal(field(data.phone, 0, 'Для Telegram'), 'Нет');
});

test('multi-phone report row is ambiguous and does not transfer the verdict to both', () => {
  const c = env(); const data = model([leaf(['Телефон', 'ID_TG', 'Active_days_ago'], [['79990000006; 79990000007', '123456', '1']])], [], ['+79990000006', '+79990000007']);
  c.legacyContactHistoryEnrich_(data); assert.equal(data.phone.headers.length, 7);
});

test('a multi-email company row does not assign one provider verdict to all addresses', () => {
  const c = env(); const data = model([leaf(['Email', 'Валидация'], [['first@example.test; second@example.test', 'valid']])], ['first@example.test', 'second@example.test']);
  c.legacyContactHistoryEnrich_(data); assert.equal(data.email.headers.length, 4);
});

test('cross-tab completed verdict conflicts become review, never whichever tab came first', () => {
  const c = env(); const source = [leaf(['Email', 'Валидация'], [['one@example.test', 'valid']], 'Valid', 0), leaf(['Email', 'Валидация'], [['one@example.test', 'invalid']], 'Invalid', 1)];
  const data = model(source, ['one@example.test']); c.legacyContactHistoryEnrich_(data);
  assert.equal(field(data.email, 0, 'Валидация'), 'Проверить историю контакта');
  assert.match(field(data.email, 0, 'Результат проверки'), /valid; invalid/);
});

test('existing completion and user columns in a destination model are retained', () => {
  const c = env(); const data = model([leaf(['Email', 'Валидация'], [['one@example.test', 'valid']])], ['one@example.test']);
  data.email.headers.push('Валидация', 'Моя колонка'); data.email.rows[0].push('Невалиден', 'Сохранить');
  c.legacyContactHistoryEnrich_(data); assert.equal(field(data.email, 0, 'Валидация'), 'Невалиден'); assert.equal(field(data.email, 0, 'Моя колонка'), 'Сохранить');
});

test('headerless data and ID-only columns cannot invent contact histories', () => {
  const c = env(); const noHeader = leaf(['Email', 'Валидация'], [['person@example.test', 'valid']]); noHeader.source.hasHeader = false;
  const data = model([noHeader, leaf(['Telegram ID', 'Active_days_ago'], [['79990000001', '2']])], ['person@example.test'], ['+79990000001']);
  c.legacyContactHistoryEnrich_(data); assert.equal(data.email.headers.length, 4); assert.equal(data.phone.headers.length, 7);
});

test('unconfirmed or outdated person-source comments are conservative review, not validation claims', () => {
  const c = env(); const data = model([leaf(['Личный email', 'Комментарий'], [['person@example.test', 'Не актуально']])], ['person@example.test']);
  c.legacyContactHistoryEnrich_(data); assert.equal(field(data.email, 0, 'Валидация'), 'Проверить историю контакта');
  assert.match(field(data.email, 0, 'Статус из источника'), /Не актуально/);
});

test('source data and status strings are preserved as literals without formula execution', () => {
  const c = env(); const input = leaf(['Email', 'Валидация', 'Провайдер'], [['person@example.test', 'valid', '=unsafe()']]); const before = JSON.stringify(input);
  const data = model([input], ['person@example.test']); c.legacyContactHistoryEnrich_(data);
  assert.equal(field(data.email, 0, 'Провайдер'), '=unsafe()'); assert.equal(JSON.stringify(input), before);
  assert.equal(data.emailRows, data.email.rows); assert.equal(data.phoneRows, undefined);
});

test('manual exclusion also follows contacts already parsed from social links or unnamed cells', () => {
  const c = env(); const source = leaf(['Данные', 'WhatsApp', 'Статус'], [['адрес скрыт в ссылке', 'https://wa.me/79990000009', 'Фильтр']]);
  source.cellContacts = { '2:1': { emails: ['hidden@example.test'], phones: [] }, '2:2': { emails: [], phones: [{ value: '+79990000009' }] } };
  const data = model([source], ['hidden@example.test'], ['+79990000009']); c.legacyContactHistoryEnrich_(data);
  assert.equal(field(data.email, 0, 'Валидация'), 'Проверить историю контакта');
  assert.equal(field(data.phone, 0, 'Валидация'), 'Проверить историю контакта');
});
