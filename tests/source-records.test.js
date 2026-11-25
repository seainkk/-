import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const plain = value => JSON.parse(JSON.stringify(value));
const source = row => ({ fileId: 'source_records_fixture_123456', sheetId: 42, sheetName: 'Компании', row });
function fixture(rows, contacts = {}, options = {}) {
  const context = vm.createContext({ console });
  vm.runInContext(['ContactPreview.gs', 'SourceRecords.gs'].map(name => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8')).join('\n'), context);
  return plain(context.sourceRecordsBuild_(rows, { ...source(0), section: 'companies', headerIndex: 0, hasHeader: true, ...options, cellContacts: contacts }));
}
const email = (...emails) => ({ emails });
const phone = (...phones) => ({ phones });

test('numbered and qualified name components combine in surname, given name, patronymic order',()=>{
  const r=fixture([['Фамилия ЛПР 1','Имя ЛПР 1','Отчество ЛПР 1','Contact Given Name 2','Contact Family Name 2','Contact Middle Name 2'],
    ['Смирнова','Анна','Викторовна','John','Smith','Henry']],{},{section:'lpr'});
  assert.deepEqual(r.records[0].people.map(person=>person.name),['Смирнова Анна Викторовна','Smith John Henry']);
});

test('a sole named manager and generic position become one person with both source columns', () => {
  const r = fixture([['Компания', 'Руководитель (ФИО)', 'Должность', 'Почта основная'], ['Альфа', 'Иванов Иван Иванович', 'Генеральный директор', 'ivan@example.test']],
    { '2:4': email('ivan@example.test') }, { section: 'lpr' });
  assert.equal(r.records[0].people.length, 1);
  const person = r.records[0].people[0]; assert.equal(person.name, 'Иванов Иван Иванович'); assert.equal(person.role, 'Генеральный директор');
  assert.deepEqual(person.emails, ['ivan@example.test']); assert.deepEqual(person.source.columns, [2, 3, 4]);
  assert.equal(person.provenance.role[0].column, 3);
});

test('matching generic first name and position enrich a sole full-name manager', () => {
  const r = fixture([['Руководитель (ФИО)', 'Имя', 'Должность'], ['Иванов Иван Иванович', 'Иван', 'Генеральный директор']], {}, { section: 'lpr' });
  assert.equal(r.records[0].people.length, 1); assert.equal(r.records[0].people[0].name, 'Иванов Иван Иванович');
  assert.equal(r.records[0].people[0].role, 'Генеральный директор');
  assert.equal(r.records[0].people[0].provenance.name.length, 2);
});

test('generic position is retained separately when two named people are present', () => {
  const r = fixture([['ФИО директора', 'Маркетолог', 'Должность'], ['Иванов Иван', 'Петров Пётр', 'Специалист']], {}, { section: 'lpr' });
  assert.equal(r.records[0].people.length, 3);
  assert.ok(r.records[0].people.some(person => !person.name && person.role === 'Специалист'));
});

test('an unnamed role with its own alternative personal contacts is not merged into a named manager', () => {
  const r = fixture([['Руководитель (ФИО)', 'Должность', 'Email маркетолога'], ['Иванов Иван', 'Маркетолог', 'marketing@example.test']],
    { '2:3': email('marketing@example.test') }, { section: 'lpr' });
  assert.ok(r.records[0].people.some(person => person.name === 'Иванов Иван' && !person.emails.length));
  assert.ok(r.records[0].people.some(person => !person.name && person.role === 'Маркетолог'));
});

test('a different generic first name is a separate person rather than evidence of the full-name manager', () => {
  const r = fixture([['Руководитель (ФИО)', 'Имя', 'Должность'], ['Иванов Иван Иванович', 'Пётр', 'Маркетолог']], {}, { section: 'lpr' });
  assert.equal(r.records[0].people.length, 2); assert.ok(r.records[0].people.some(person => person.name === 'Пётр'));
});

test('a genuine unnamed role survives when there is no named person', () => {
  const r = fixture([['Компания', 'Должность'], ['Альфа', 'Директор по маркетингу']], {}, { section: 'lpr' });
  assert.equal(r.records[0].people.length, 1); assert.equal(r.records[0].people[0].name, ''); assert.equal(r.records[0].people[0].role, 'Директор по маркетингу');
});

test('web-studio person summaries keep named role lines and discard explanatory evidence rather than inventing people',()=>{
  const r=fixture([['Компания','ЛПР / маркетинг / PR','Полное ФИО ЛПР'],['Студия',
    'Иванов Иван — Генеральный директор\nУказан в карточке Рейтинга Рунета; проверено 17.11.2026. На сайте должность не подтверждена.\n<https://rating.example.test/card>',
    '']]);
  assert.equal(r.records[0].people.length,1);const p=r.records[0].people[0];assert.equal(p.name,'Иванов Иван');assert.equal(p.role,'Генеральный директор');assert.deepEqual(p.emails,[]);assert.deepEqual(p.phones,[]);assert.equal(p.source.columns[0],2);
});

test('several named people in one summary stay separate and embedded contacts are not assigned to a guessed person',()=>{
  const r=fixture([['Компания','ЛПР / маркетинг / PR'],['Студия','Иванов Иван — Директор\nУказан в карточке Рейтинга Рунета\nПетров Пётр — Основатель\nпроверено . На сайте должность не подтверждена.\nshared@example.test']],{'2:2':email('shared@example.test')});
  assert.deepEqual(r.records[0].people.map(p=>p.name),['Иванов Иван','Петров Пётр']);assert.deepEqual(r.records[0].people.map(p=>p.role),['Директор','Основатель']);assert.ok(r.records[0].people.every(p=>!p.emails.length));assert.deepEqual(r.records[0].general.emails,['shared@example.test']);
});

test('dedicated full name and explicit job title take priority when the same person appears in summary evidence',()=>{
  const r=fixture([['ЛПР / маркетинг / PR','Полное ФИО ЛПР','Должность','Тел ЛПР'],['Иванов Иван — Генеральный директор\nУказан в карточке Рейтинга Рунета','Иванов Иван','Директор по продажам','+79990000001']],{'2:4':phone('+79990000001')});
  assert.equal(r.records[0].people.length,1);const p=r.records[0].people[0];assert.equal(p.name,'Иванов Иван');assert.equal(p.role,'Директор по продажам');assert.deepEqual(p.phones,['+79990000001']);
});

test('a different summary person cannot receive the dedicated full-name persons contacts',()=>{
  const r=fixture([['ЛПР / маркетинг / PR','Полное ФИО ЛПР','Тел ЛПР'],['Иванов Иван — Директор\nУказан в карточке Рейтинга Рунета','Петров Пётр','+79990000002']],{'2:3':phone('+79990000002')});
  assert.equal(r.records[0].people.length,2);assert.deepEqual(r.records[0].people.find(p=>p.name==='Петров Пётр').phones,['+79990000002']);assert.deepEqual(r.records[0].people.find(p=>p.name==='Иванов Иван').phones,[]);
});

test('comments and evidence mentioning an LPR are not identities; genuine dedicated no-contact names and roles survive',()=>{
  const r=fixture([['Комментарий ЛПР','Описание маркетолога','Источник ЛПР','Полное ФИО ЛПР','Должность'],['Указан в карточке Рейтинга Рунета','Проверено. На сайте должность не подтверждена.','Карточка компании','Иванов Иван','Директор']]);
  assert.equal(r.records[0].people.length,1);assert.equal(r.records[0].people[0].name,'Иванов Иван');assert.equal(r.records[0].people[0].role,'Директор');assert.deepEqual(r.records[0].people[0].phones,[]);
  const noPerson=fixture([['ЛПР / маркетинг / PR'],['Указан в карточке Рейтинга Рунета\nпроверено . На сайте должность не подтверждена.']]);assert.equal(noPerson.records[0].people.length,0);
});

test('actual directory plural headers retain company identity and contacts in a lean segment instead of anonymous contact rows', () => {
  const headers = ['Названия', 'Категории', 'Регионы, области', 'Населенные пункты', 'Полные адреса', 'Мобильные телефоны', 'Городские телефоны', 'Email-адреса', 'Telegram', 'WhatsApp', 'Вконтакте', 'Одноклассники', 'Сайты', 'Max', 'Филиалов', 'Индексы', 'Дата парсинга'];
  const rows = [headers, ['Тестовая компания', 'Магазин', 'Москва', 'Москва', '', '+79990000001', '', 'hello@example.test', '', '', '', '', 'https://company.example.test']];
  const parsed = fixture(rows, { '2:6': phone('+79990000001'), '2:8': email('hello@example.test') });
  assert.equal(parsed.records[0].company.name, 'Тестовая компания'); assert.equal(parsed.records[0].company.website, 'https://company.example.test'); assert.equal(parsed.records[0].company.city, 'Москва');
  assert.deepEqual(parsed.records[0].general.emails, ['hello@example.test']); assert.deepEqual(parsed.records[0].general.phones, ['+79990000001']); assert.equal(parsed.records[0].people.length, 0);
  const c = vm.createContext({ console });
  vm.runInContext(readFileSync(new URL('../src/SegmentRecords.gs', import.meta.url), 'utf8'), c);
  c.digest_ = text => 'deterministic_' + Buffer.from(String(text)).toString('base64url');
  const plan = plain(c.segmentRecordsPlanner_({ records: parsed.records, companies: [], people: [] }));
  assert.equal(plan.companies.length, 1); assert.equal(plan.companies[0].after[1], 'Тестовая компания');
  assert.equal(plan.counts.companiesAdded, 1); assert.ok(!plan.review.some(issue => /без определения компании/.test(issue.reason)));
});

test('actual web-studio city and existing singular company aliases keep their meaning', () => {
  const parsed = fixture([['ID компании', 'Компания', 'Сайт', 'Город / страна', 'Инн компании'], ['WEB-1', 'Студия', 'https://studio.example.test', 'Москва / Россия', '7707083893']]);
  const company = parsed.records[0].company;
  assert.equal(company.id, 'WEB-1'); assert.equal(company.name, 'Студия'); assert.equal(company.website, 'https://studio.example.test'); assert.equal(company.city, 'Москва / Россия'); assert.equal(company.inn, '7707083893');
});

test('actual developer source-list website identifies the company without mistaking evidence links for its site', () => {
  const parsed = fixture([['Компания', 'ФИО', 'Должность в источнике', 'Сайт из исходного списка', 'Публикация / упоминание', 'Ссылка из бота'],
    ['Застройщик', 'Иванов Иван', 'Директор по маркетингу', 'https://developer.example.test/', 'https://news.example.test/article', 'https://report.example.test/result']], {}, { section: 'lpr' });
  const record = parsed.records[0]; assert.equal(record.company.name, 'Застройщик'); assert.equal(record.company.website, 'https://developer.example.test/');
  assert.equal(record.company.provenance.website.length, 1); assert.equal(record.company.provenance.website[0].column, 4);
  assert.equal(record.people.length, 1); assert.equal(record.people[0].name, 'Иванов Иван'); assert.equal(record.people[0].role, 'Директор по маркетингу');
});

test('combined INN/OGRN requisites retain their checked identifier type without using invalid values as keys', () => {
  const parsed = fixture([['Компания', 'ИНН/ОГРН'], ['ИНН', '7707083893'], ['ОГРН', '1027700132195'], ['Оба', 'ИНН 7707083893 / ОГРН 1027700132195'], ['Ошибка', '7707083894']]);
  assert.equal(parsed.records[0].company.inn, '7707083893'); assert.equal(parsed.records[0].company.ogrn, '');
  assert.equal(parsed.records[1].company.ogrn, '1027700132195'); assert.equal(parsed.records[1].company.inn, '');
  assert.equal(parsed.records[2].company.inn, '7707083893'); assert.equal(parsed.records[2].company.ogrn, '1027700132195');
  assert.equal(parsed.records[3].company.inn, ''); assert.equal(parsed.records[3].company.ogrn, ''); assert.equal(parsed.records[3].company.rawRegistration, '7707083894');
  assert.ok(parsed.warnings.some(warning => warning.includes('ИНН/ОГРН')));
});

test('normalizes company requisites and keeps a named director with no contacts', () => {
  const r = fixture([
    ['Company_ID', 'ИНН', 'ОГРН', 'Название', 'Сайт', 'Город', 'Директор'],
    ['A', '7707083893', '1027700132195', 'Альфа', 'https://alpha.example', 'Москва', 'Иванов Иван'],
  ]);
  assert.equal(r.records.length, 1);
  const record = r.records[0];
  assert.deepEqual(record.source, source(2));
  assert.equal(record.company.id, 'A'); assert.equal(record.company.inn, '7707083893'); assert.equal(record.company.ogrn, '1027700132195');
  assert.equal(record.company.name, 'Альфа'); assert.equal(record.company.website, 'https://alpha.example'); assert.equal(record.company.city, 'Москва');
  assert.equal(record.people.length, 1); assert.equal(record.people[0].name, 'Иванов Иван'); assert.equal(record.people[0].role, 'Директор');
  assert.deepEqual(record.people[0].emails, []); assert.deepEqual(record.people[0].phones, []); assert.deepEqual(record.people[0].telegrams, []);
  assert.equal(record.people[0].provenance.name[0].column, 7);
});

test('numbered LPR groups remain separate and generic company emails stay general', () => {
  const r = fixture([
    ['Компания', 'ФИО1', 'Должность1', 'Email ЛПР1', 'ФИО2', 'Должность2', 'Телефон ЛПР2', 'Email'],
    ['Альфа', 'Иванов Иван', 'Директор', 'ivan@example.test', 'Петров Пётр', 'Маркетолог', '+79990000002', 'info@example.test'],
  ], { '2:4': email('ivan@example.test'), '2:7': phone({ value: '+79990000002', kind: 'mobile' }), '2:8': email('info@example.test') });
  const record = r.records[0];
  assert.equal(record.people.length, 2);
  const ivan = record.people.find(person => person.name === 'Иванов Иван'), petr = record.people.find(person => person.name === 'Петров Пётр');
  assert.deepEqual(ivan.emails, ['ivan@example.test']); assert.deepEqual(ivan.phones, []);
  assert.deepEqual(petr.emails, []); assert.deepEqual(petr.phones, ['+79990000002']);
  assert.deepEqual(record.general.emails, ['info@example.test']);
  assert.equal(record.provenance.emails['ivan@example.test'][0].column, 4);
  assert.equal(petr.provenance.phones['+79990000002'][0].row, 2);
});

test('director and marketing groups use their explicit contacts only', () => {
  const r = fixture([
    ['Компания', 'ФИО директора', 'Email директора', 'Маркетолог', 'Telegram маркетолога', 'Почта компании'],
    ['Альфа', 'Иванов Иван', 'director@example.test', 'Петров Пётр', '@Market_Petr', 'info@example.test'],
  ], { '2:3': email('director@example.test'), '2:5': { telegrams: ['@Market_Petr'] }, '2:6': email('info@example.test') });
  const record = r.records[0], director = record.people.find(person => person.role === 'Директор'), marketing = record.people.find(person => person.role === 'Маркетинг');
  assert.deepEqual(director.emails, ['director@example.test']); assert.deepEqual(director.telegrams, []);
  assert.deepEqual(marketing.emails, []); assert.deepEqual(marketing.telegrams, ['@market_petr']);
  assert.deepEqual(record.general.emails, ['info@example.test']);
});

test('one generic LPR name can receive explicit director contacts without inventing another person', () => {
  const r = fixture([['ФИО', 'Email директора'], ['Иванов Иван', 'ivan@example.test']], { '2:2': email('ivan@example.test') });
  assert.equal(r.records[0].people.length, 1);
  assert.equal(r.records[0].people[0].name, 'Иванов Иван'); assert.equal(r.records[0].people[0].role, 'Директор');
  assert.deepEqual(r.records[0].people[0].emails, ['ivan@example.test']);
});

test('conflicting role context does not attach a director email to a marketing person', () => {
  const r = fixture([['ФИО', 'Должность', 'Email директора'], ['Петров Пётр', 'Маркетолог', 'director@example.test']], { '2:3': email('director@example.test') });
  assert.equal(r.records[0].people.length, 2);
  assert.deepEqual(r.records[0].people.find(person => person.name === 'Петров Пётр').emails, []);
  assert.deepEqual(r.records[0].people.find(person => person.role === 'Директор').emails, ['director@example.test']);
});

test('in LPR section unambiguous generic contacts attach to the person, while companies section keeps them general', () => {
  const rows = [['Компания', 'ФИО', 'Email', 'Телефон', 'Telegram'], ['Альфа', 'Иванов Иван', 'i@example.test', '+79990000001', '@ivanov']], contacts = { '2:3': email('i@example.test'), '2:4': phone('+79990000001'), '2:5': { telegrams: ['ivanov'] } };
  const lpr = fixture(rows, contacts, { section: 'lpr' }).records[0], company = fixture(rows, contacts).records[0];
  assert.deepEqual(lpr.people[0].emails, ['i@example.test']); assert.deepEqual(lpr.people[0].phones, ['+79990000001']); assert.deepEqual(lpr.people[0].telegrams, ['@ivanov']);
  assert.deepEqual(lpr.general, { emails: [], phones: [], telegrams: [] });
  assert.deepEqual(company.people[0].emails, []); assert.deepEqual(company.general.emails, ['i@example.test']);
});

test('generic LPR contacts with multiple named people remain general and flagged', () => {
  const r = fixture([['ФИО1', 'ФИО2', 'Email'], ['Иванов Иван', 'Петров Пётр', 'shared@example.test']], { '2:3': email('shared@example.test') }, { section: 'lpr' });
  assert.equal(r.records[0].people.length, 2); assert.equal(r.records[0].ambiguous, true);
  assert.ok(r.records[0].people.every(person => !person.emails.length));
  assert.deepEqual(r.records[0].general.emails, ['shared@example.test']); assert.match(r.warnings.join(' '), /несколько людей/);
});

test('multiple names inside one cell are preserved separately and not given every contact', () => {
  const r = fixture([['Компания', 'ФИО', 'Email ЛПР'], ['Альфа', 'Иванов Иван; Петров Пётр', 'shared@example.test']], { '2:3': email('shared@example.test') });
  assert.deepEqual(r.records[0].people.map(person => person.name), ['Иванов Иван', 'Петров Пётр']);
  assert.ok(r.records[0].people.every(person => person.ambiguous && !person.emails.length));
  assert.deepEqual(r.records[0].general.emails, ['shared@example.test']);
});

test('surname first name patronymic are composed in one numbered group without mixing another group', () => {
  const r = fixture([['Имя1', 'Фамилия1', 'Отчество1', 'ФИО2'], ['Иван', 'Иванов', 'Иванович', 'Петров Пётр']]);
  assert.deepEqual(r.records[0].people.map(person => person.name), ['Иванов Иван Иванович', 'Петров Пётр']);
});

test('a role-only person survives with empty contacts', () => {
  const r = fixture([['Company_ID', 'Должность'], ['A', 'Директор']]);
  assert.equal(r.records[0].people.length, 1); assert.equal(r.records[0].people[0].name, ''); assert.equal(r.records[0].people[0].role, 'Директор');
  assert.deepEqual(r.records[0].people[0].emails, []);
});

test('empty rows and blank person fields do not fabricate people', () => {
  const r = fixture([['Компания', 'ФИО', 'Email директора'], ['Альфа', '', ''], ['', '', ''], ['Бета', '', '']]);
  assert.equal(r.records.length, 2); assert.ok(r.records.every(record => !record.people.length));
});

test('role-specific contacts without names are separate and generic LPR contacts are ambiguous', () => {
  const r = fixture([['Email директора', 'Email маркетолога', 'Email'], ['d@example.test', 'm@example.test', 'shared@example.test']], { '2:1': email('d@example.test'), '2:2': email('m@example.test'), '2:3': email('shared@example.test') }, { section: 'lpr' });
  assert.equal(r.records[0].people.length, 2); assert.ok(r.records[0].people.every(person => !person.name));
  assert.deepEqual(r.records[0].general.emails, ['shared@example.test']);
});

test('LPR contacts with no name columns remain a person with honest empty identity', () => {
  const r = fixture([['Email', 'Телефон'], ['a@example.test', '+79990000001']], { '2:1': email('a@example.test'), '2:2': phone('+79990000001') }, { section: 'lpr' });
  assert.equal(r.records[0].people.length, 1); assert.equal(r.records[0].people[0].name, ''); assert.equal(r.records[0].people[0].role, '');
  assert.deepEqual(r.records[0].people[0].emails, ['a@example.test']);
});

test('header row after a title and headerless data retain absolute provenance', () => {
  const r = fixture([['Титул'], ['Компания', 'ФИО'], ['Альфа', 'Иванов Иван']], {}, { headerIndex: 1 });
  assert.equal(r.records[0].source.row, 3); assert.equal(r.records[0].people[0].source.row, 3);
  const headless = fixture([['a@example.test'], ['b@example.test']], { '1:1': email('a@example.test'), '2:1': email('b@example.test') }, { hasHeader: false });
  assert.deepEqual(headless.records.map(record => record.source.row), [1, 2]);
});

test('all contact cell origins are retained and duplicate values remain unique in each owner', () => {
  const r = fixture([['Компания', 'Что-то', 'Другое'], ['Альфа', 'a@example.test', 'A@example.test']], { '2:2': email('a@example.test'), '2:3': email('A@example.test') });
  assert.deepEqual(r.records[0].general.emails, ['a@example.test']);
  assert.deepEqual(r.records[0].provenance.emails['a@example.test'].map(ref => ref.column), [2, 3]);
});

test('invalid INN is retained for review but never used as a valid company identifier', () => {
  const r = fixture([['Компания', 'ИНН'], ['Альфа', '0000000000']]);
  assert.equal(r.records[0].company.inn, ''); assert.equal(r.records[0].company.rawInn, '0000000000'); assert.match(r.warnings.join(' '), /ИНН/);
});

test('conflicting company IDs do not silently select one identity', () => {
  const r = fixture([['Company_ID', 'ID компании', 'Компания'], ['A', 'B', 'Альфа']]);
  assert.equal(r.records[0].company.id, ''); assert.equal(r.records[0].company.rawId, 'A; B'); assert.equal(r.records[0].ambiguous, true);
});

test('contact strings in a person-name field are not invented as a full name', () => {
  const r = fixture([['ФИО', 'Компания'], ['UPPER@EXAMPLE.TEST', 'Альфа']], { '2:1': email('upper@example.test') }, { section: 'lpr' });
  assert.equal(r.records[0].people[0].name, ''); assert.deepEqual(r.records[0].people[0].emails, ['upper@example.test']);
});

test('status and sender columns are never interpreted as personal identities', () => {
  const r = fixture([['Компания', 'Email отправителя', 'Результат валидации ЛПР', 'Title'], ['Альфа', 'sender@example.test', 'VALID', 'Страница компании']]);
  assert.equal(r.records[0].people.length, 0);
});

test('explicit company and common contact columns stay general in LPR section', () => {
  const headers = ['ФИО', 'Email-адреса', 'Мобильные телефоны', 'Городские телефоны', 'Email компании', 'Общий Email', 'Email ЛПР'];
  const r = fixture([headers, ['Иванов Иван', 'catalog@example.test', '+79990000001', '+74950000001', 'corp@example.test', 'shared@example.test', 'ivan@example.test']], { '2:2': email('catalog@example.test'), '2:3': phone('+79990000001'), '2:4': phone('+74950000001'), '2:5': email('corp@example.test'), '2:6': email('shared@example.test'), '2:7': email('ivan@example.test') }, { section: 'lpr' });
  assert.deepEqual(r.records[0].general.emails, ['catalog@example.test', 'corp@example.test', 'shared@example.test']);
  assert.deepEqual(r.records[0].general.phones, ['+79990000001', '+74950000001']);
  assert.deepEqual(r.records[0].people[0].emails, ['ivan@example.test']);
  assert.deepEqual(r.records[0].people[0].phones, []);
});

test('English Name is a company in company section and a person in LPR section', () => {
  const rows = [['Name', 'Email'], ['Alpha', 'a@example.test']], contacts = { '2:2': email('a@example.test') };
  assert.equal(fixture(rows, contacts).records[0].company.name, 'Alpha');
  assert.equal(fixture(rows, contacts, { section: 'lpr' }).records[0].people[0].name, 'Alpha');
});

test('numbered plain contacts attach only to existing numbered person groups in company section', () => {
  const r = fixture([['Компания', 'ФИО1', 'Email1', 'ФИО2', 'Телефон2', 'Email3'], ['Альфа', 'Иванов Иван', 'i@example.test', 'Петров Пётр', '+79990000002', 'info@example.test']], { '2:3': email('i@example.test'), '2:5': phone('+79990000002'), '2:6': email('info@example.test') });
  assert.deepEqual(r.records[0].people[0].emails, ['i@example.test']);
  assert.deepEqual(r.records[0].people[1].phones, ['+79990000002']);
  assert.deepEqual(r.records[0].general.emails, ['info@example.test']);
});

test('department corporate inboxes are not invented as people or assigned to the only LPR', () => {
  const r = fixture([['ФИО', 'Email маркетинга', 'Email продаж', 'Email ЛПР'], ['Иванов Иван', 'marketing@example.test', 'sales@example.test', 'ivan@example.test']], { '2:2': email('marketing@example.test'), '2:3': email('sales@example.test'), '2:4': email('ivan@example.test') }, { section: 'lpr' });
  assert.equal(r.records[0].people.length, 1);
  assert.deepEqual(r.records[0].people[0].emails, ['ivan@example.test']);
  assert.deepEqual(r.records[0].general.emails, ['marketing@example.test', 'sales@example.test']);
});

test('provider metadata and sender contacts are excluded even if an upstream candidate is supplied', () => {
  const r = fixture([['ФИО', 'Email отправителя', 'Результат валидации ЛПР'], ['Иванов Иван', 'sender@example.test', 'provider@example.test']], { '2:2': email('sender@example.test'), '2:3': email('provider@example.test') }, { section: 'lpr' });
  assert.deepEqual(r.records[0].people[0].emails, []); assert.deepEqual(r.records[0].general.emails, []);
});


test('safe raw numeric identities are retained when display formatting is scientific', () => {
  const rows = [['Company_ID', 'ИНН', 'ОГРН', 'Компания'], ['7.70000E+10', '7.70708E+9', '1.02770E+12', 'Альфа']];
  const rawRows = [rows[0], [77000000001, 7707083893, 1027700132195, 'Альфа']];
  const r = fixture(rows, {}, { rawRows });
  assert.equal(r.records[0].company.id, '77000000001'); assert.equal(r.records[0].company.inn, '7707083893'); assert.equal(r.records[0].company.ogrn, '1027700132195');
});


test('a generic head is not relabelled as a director and spaced slash names are kept separate', () => {
  const r = fixture([['Компания', 'Руководитель'], ['Альфа', 'Иван Петров / Анна Иванова']]);
  assert.deepEqual(r.records[0].people.map(person => person.name), ['Иван Петров', 'Анна Иванова']);
  assert.equal(r.records[0].people.every(person => person.role === 'Руководитель'), true);
  assert.equal(r.records[0].ambiguous, true);
});


test('managed transfer markers and LPR identifiers cannot create fake people', () => {
  const r = fixture([
    ['Company_ID', 'Компания', 'ФИО ЛПР', 'Перенос в ЛПР', 'ID ЛПР'],
    ['A', 'Альфа', 'Анна Иванова', 'Перенесено в ЛПР — сегмент Кухни', 'lpr_generated_identifier'],
  ]);
  assert.equal(r.records[0].people.length, 1); assert.equal(r.records[0].people[0].name, 'Анна Иванова');
});
