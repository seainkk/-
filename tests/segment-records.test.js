import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function fixture() {
  const context = vm.createContext({ console });
  context.digest_ = text => crypto.createHash('sha256').update(text).digest('base64url');
  context.fail_ = (code, message) => { throw new Error('[' + code + '] ' + message); };
  vm.runInContext(readFileSync(new URL('../src/SegmentRecords.gs', import.meta.url), 'utf8'), context);
  const plain = value => JSON.parse(JSON.stringify(value));
  return { context, plan: input => plain(context.segmentRecordsPlanner_(input)), fields: kind => plain(context.segmentRecordsSchema_(kind)).map(field => field[0]) };
}
const source = (row = 2, fileId = 'source_file_1234567890') => ({ fileId, sheetId: 42, sheetName: 'Исходная база', row });
const company = (overrides = {}, row = 2) => ({ source: source(row), company: { name: 'ООО Пример', inn: '7707083893', city: 'Москва', ...overrides }, general: { emails: ['sales@example.test'], phones: ['+79990000001'] }, people: [] });
const rowRecord = (f, action, kind) => Object.fromEntries(f.fields(kind).map((key, i) => [key, action.after[i]]).concat([['row', action.row]]));

test('normalizes companies into lean fields, unions contacts and never duplicates a repeated source', () => {
  const f = fixture(), first = company(), second = company({}, 3);
  second.general.emails.push('new@example.test');
  const result = f.plan({ records: [first, second] });
  assert.equal(result.counts.companiesAdded, 1);
  assert.equal(result.companies.length, 1);
  assert.match(result.companies[0].after[0], /^C-/);
  assert.equal(result.companies[0].after[6], 'sales@example.test; new@example.test');
  assert.equal(result.companies[0].after.length, 17);
  assert.equal(result.companies[0].after.some(value => value.includes('revenue')), false);
  const existing = rowRecord(f, result.companies[0], 'companies');
  const replay = f.plan({ records: [first, second], companies: [existing] });
  assert.equal(replay.counts.companiesAdded, 0);
  assert.equal(replay.companies.length, 0);
});

test('creates and retains a decision maker with no contacts, including a role-only placeholder', () => {
  const f = fixture(), input = company();
  input.people = [{ name: 'Иван Иванов', role: 'Директор', emails: [], phones: [] }, { name: '', role: 'Маркетолог' }];
  const result = f.plan({ records: [input] });
  assert.equal(result.counts.peopleAdded, 2);
  assert.equal(result.counts.peopleWithoutContacts, 2);
  assert.equal(result.people[0].after[3], 'Иван Иванов');
  assert.equal(result.people[0].after[9], 'Найти контакты');
  assert.equal(result.people[1].after[9], 'Найти ФИО и контакты');
  assert.equal(result.markers.length, 1);
  assert.equal(result.markers[0].personIds.length, 2);
  assert.equal(result.companies[0].after[14], 'Перенесено в ЛПР');
  assert.equal(result.companies[0].after[6], 'sales@example.test', 'generic company email does not become a personal email');
  assert.equal(result.people[0].after[5], '');
});

test('keeps shared corporate inboxes on distinct named people rather than merging them', () => {
  const f = fixture(), input = company();
  input.people = [{ name: 'Иван Иванов', emails: ['office@example.test'] }, { name: 'Анна Иванова', emails: ['office@example.test'] }];
  const result = f.plan({ records: [input] });
  assert.equal(result.people.length, 2);
  assert.notEqual(result.people[0].id, result.people[1].id);
});

test('person updates fill contact gaps while retaining statuses and stable IDs', () => {
  const f = fixture(), initial = company(); initial.people = [{ name: 'Иван Иванов', role: 'Директор' }];
  const first = f.plan({ records: [initial] });
  const oldCompany = rowRecord(f, first.companies[0], 'companies'); oldCompany.status = 'Запущен';
  const oldPerson = rowRecord(f, first.people[0], 'lpr'); oldPerson.status = 'В рассылке';
  const newer = company(); newer.people = [{ name: 'Иван Иванов', role: 'CEO', phones: ['+79990000002'] }];
  const result = f.plan({ records: [newer], companies: [oldCompany], people: [oldPerson] });
  assert.equal(result.counts.peopleAdded, 0);
  assert.equal(result.people[0].id, oldPerson.id);
  assert.equal(result.people[0].after[4], 'Директор', 'nonempty existing role is not silently overwritten');
  assert.equal(result.people[0].after[6], '+79990000002');
  assert.equal(result.people[0].after[9], 'В рассылке');
  assert.equal(result.companies[0]?.after[16] || oldCompany.status, 'Запущен');
});

test('promotes a no-contact status after new contacts appear without changing a manual campaign status', () => {
  const f = fixture(), initial = company(); initial.people = [{ name: 'Иван Иванов' }];
  const first = f.plan({ records: [initial] }), oldCompany = rowRecord(f, first.companies[0], 'companies'), oldPerson = rowRecord(f, first.people[0], 'lpr');
  const newer = company(); newer.people = [{ name: 'Иван Иванов', emails: ['person@example.test'] }];
  const result = f.plan({ records: [newer], companies: [oldCompany], people: [oldPerson] });
  assert.equal(result.people[0].after[9], 'Подготовка');
});

test('same weak name with new contacts goes to review instead of inventing a merge or duplicate company', () => {
  const f = fixture(), old = { id: 'C-old_company_identity_123456', row: 2, name: 'ООО Ромашка', emails: 'old@example.test', status: 'В работе' };
  const input = company({ inn: '', city: '', name: 'ООО Ромашка' });
  const result = f.plan({ records: [input], companies: [old] });
  assert.equal(result.companies.length, 0);
  assert.equal(result.counts.companiesAdded, 0);
  assert.equal(result.review.length, 1);
  assert.match(result.review[0].reason, /недостаточно/);
});

test('different known INNs remain different legal companies even with identical names and cities', () => {
  const f = fixture(), a = company(), b = company({ inn: '7710140679' }, 3);
  const result = f.plan({ records: [a, b] });
  assert.equal(result.counts.companiesAdded, 2);
  assert.notEqual(result.companies[0].id, result.companies[1].id);
});

test('ambiguous company still keeps a named contactless person with unresolved company metadata', () => {
  const f = fixture(), old = { id: 'C-old_company_identity_123456', row: 2, name: 'ООО Ромашка', emails: 'old@example.test' };
  const input = company({ inn: '', city: '', name: 'ООО Ромашка' }); input.people = [{ name: 'Иван Иванов', role: 'Директор' }];
  const result = f.plan({ records: [input], companies: [old] });
  assert.equal(result.companies.length, 0);
  assert.equal(result.people.length, 1);
  assert.equal(result.people[0].after[1], '');
  assert.equal(result.people[0].after[2], 'ООО Ромашка');
  assert.equal(result.markers.length, 1);
});

test('all supplied person groups survive and repeated groups deduplicate within the segment', () => {
  const f = fixture(), a = company(), b = company({}, 3);
  a.people = [{ name: 'Иван Иванов' }, { name: 'Анна Иванова', telegrams: ['https://t.me/anna_example'] }];
  b.people = [{ name: 'Иван Иванов', emails: ['ivan@example.test'] }];
  const result = f.plan({ records: [a, b] });
  assert.equal(result.people.length, 2);
  assert.equal(result.people.find(action => action.after[3] === 'Иван Иванов').after[5], 'ivan@example.test');
  assert.equal(result.people.find(action => action.after[3] === 'Анна Иванова').after[7], '@anna_example');
  assert.equal(result.markers.length, 2);
});

test('social network domains never identify all companies as one site', () => {
  const f = fixture();
  assert.equal(f.context.segmentRecordsDomain_('https://t.me/company'), '');
  const a = company({ inn: '', city: '', name: 'Альфа', website: 'https://t.me/alpha' });
  const b = company({ inn: '', city: '', name: 'Бета', website: 'https://t.me/beta' }, 3);
  assert.equal(f.plan({ records: [a, b] }).companies.length, 2);
});

test('invalid-checksum and all-zero INNs never act as strong company identity', () => {
  const f = fixture();
  assert.equal(f.context.segmentRecordsInn_('0000000000'), '');
  assert.equal(f.context.segmentRecordsInn_('7707083899'), '');
  assert.equal(f.context.segmentRecordsInn_('7707083893'), '7707083893');
  const a = company({ inn: '0000000000', city: '', name: 'Альфа' }), b = company({ inn: '0000000000', city: '', name: 'Бета' }, 3);
  assert.equal(f.plan({ records: [a, b] }).companies.length, 2);
});

test('OGRN remains a persisted strong identity when an INN disappears and the company is renamed', () => {
  const f = fixture(), ogrnPrefix = '102770013219', ogrn = ogrnPrefix + (Number(ogrnPrefix) % 11 % 10);
  const first = f.plan({ records: [company({ ogrn })] });
  const old = rowRecord(f, first.companies[0], 'companies');
  const next = company({ inn: '', ogrn, name: 'Новое название', city: '' });
  const result = f.plan({ records: [next], companies: [old] });
  assert.equal(result.counts.companiesAdded, 0); assert.equal(result.companies.length, 0, 'existing nonempty name is preserved and same original source does not change the row');
  assert.equal(old.ogrn, ogrn);
});

test('different strong keys cannot combine two existing legal identities or overwrite a conflicting identifier', () => {
  const f = fixture(), prefix = '102770013219', ogrn = prefix + (Number(prefix) % 11 % 10);
  const a = { row: 2, id: 'C-company_identity_a_123456789', name: 'Компания А', inn: '7707083893', status: 'Запущен' };
  const b = { row: 3, id: 'C-company_identity_b_123456789', name: 'Компания Б', ogrn, status: 'В работе' };
  const incoming = company({ inn: a.inn, ogrn });
  const collision = f.plan({ records: [incoming], companies: [a, b] });
  assert.equal(collision.companies.length, 0); assert.equal(collision.counts.companiesAdded, 0); assert.equal(collision.review.length, 1);
  const otherPrefix = '102773928979', otherOgrn = otherPrefix + (Number(otherPrefix) % 11 % 10);
  const contradiction = f.plan({ records: [incoming], companies: [{ ...a, ogrn: otherOgrn }] });
  assert.equal(f.context.segmentRecordsOgrn_(otherOgrn), otherOgrn);
  assert.equal(contradiction.companies.length, 0); assert.match(contradiction.review[0].reason, /противоречат/);
});

test('contactless names without company stay source-scoped and never globally merge by full name alone', () => {
  const f = fixture(), a = { source: source(2), company: {}, general: {}, people: [{ name: 'Иван Иванов' }] }, b = { source: source(2, 'other_source_1234567890'), company: {}, general: {}, people: [{ name: 'Иван Иванов' }] };
  const first = f.plan({ records: [a, b] });
  assert.equal(first.people.length, 2); assert.notEqual(first.people[0].id, first.people[1].id); assert.equal(first.review.length, 1);
  const people = first.people.map(action => rowRecord(f, action, 'lpr'));
  assert.equal(f.plan({ records: [a, b], people }).people.length, 0, 'same source replay resolves its provisional person ID');
});

test('a conflicting explicit person ID does not silently merge people with identical names', () => {
  const f = fixture(), initial = company(); initial.people = [{ name: 'Иван Иванов' }];
  const first = f.plan({ records: [initial] }), oldCompany = rowRecord(f, first.companies[0], 'companies'), oldPerson = rowRecord(f, first.people[0], 'lpr');
  const next = company(); next.people = [{ id: 'P-different_person_id_1234567890', name: 'Иван Иванов', emails: ['new@example.test'] }];
  const result = f.plan({ records: [next], companies: [oldCompany], people: [oldPerson] });
  assert.equal(result.people.length, 0); assert.match(result.review[0].reason, /ID ЛПР различаются/);
});

test('contact-only inputs create honest unresolved company rows and preserve all channels', () => {
  const f = fixture(), input = { source: source(), company: {}, people: [], general: { emails: ['only@example.test'], phones: ['+79990000001'], telegrams: ['@contact_user'] } };
  const first = f.plan({ records: [input] });
  assert.equal(first.companies.length, 1); assert.equal(first.companies[0].after[1], '');
  const row = rowRecord(f, first.companies[0], 'companies');
  assert.equal(row.status, 'Уточнить компанию'); assert.equal(row.emails, 'only@example.test'); assert.equal(row.phones, '+79990000001'); assert.equal(row.telegrams, '@contact_user');
  assert.equal(f.plan({ records: [input], companies: [row] }).companies.length, 0);
});

test('unrecognized nonempty rows are reported instead of silently disappearing', () => {
  const f = fixture(), result = f.plan({ records: [{ source: source(), company: {}, general: {}, people: [] }] });
  assert.equal(result.review.length, 1); assert.equal(result.review[0].kind, 'row');
});
