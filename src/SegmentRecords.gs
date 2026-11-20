/** Pure, deterministic normalization and upsert planning for the two segment masters. */
var SEGMENT_RECORDS_SCHEMA = Object.freeze({
  version: 1,
  company: [
    ['id', 'ID компании'], ['name', 'Компания'], ['inn', 'ИНН'], ['ogrn', 'ОГРН'], ['website', 'Сайт'],
    ['city', 'Город'], ['emails', 'Email'], ['phones', 'Телефон'], ['telegrams', 'Telegram'],
    ['personName', 'ФИО ЛПР'], ['personRole', 'Должность ЛПР'], ['personEmails', 'Email ЛПР'],
    ['personPhones', 'Телефон ЛПР'], ['personTelegrams', 'Telegram ЛПР'],
    ['transferred', 'Перенос в ЛПР'], ['sources', 'Источники'], ['status', 'Статус']
  ],
  person: [
    ['id', 'ID ЛПР'], ['companyId', 'ID компании'], ['companyName', 'Компания'], ['name', 'ФИО'],
    ['role', 'Должность'], ['emails', 'Email'], ['phones', 'Телефон'], ['telegrams', 'Telegram'],
    ['sources', 'Источники'], ['status', 'Статус']
  ],
  markerHeader: 'Перенос в ЛПР'
});

function segmentRecordsText_(value) { return String(value === undefined || value === null ? '' : value).normalize('NFC').trim(); }
function segmentRecordsName_(value) { return segmentRecordsText_(value).normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[«»"“”‘’]/g, '').replace(/\s+/g, ' '); }
function segmentRecordsCity_(value) { return segmentRecordsName_(value).replace(/^(?:г(?:ород)?\.?\s+)/, ''); }
function segmentRecordsDigits_(value) { return segmentRecordsText_(value).replace(/[^0-9]/g, ''); }
function segmentRecordsInn_(value) {
  var digits = segmentRecordsDigits_(value); if (!/^(?:\d{10}|\d{12})$/.test(digits) || /^0+$/.test(digits)) return '';
  function sum(weights) { return weights.reduce(function (total, weight, index) { return total + weight * Number(digits.charAt(index)); }, 0) % 11 % 10; }
  if (digits.length === 10) return sum([2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(digits.charAt(9)) ? digits : '';
  return sum([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(digits.charAt(10)) && sum([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(digits.charAt(11)) ? digits : '';
}
function segmentRecordsOgrn_(value) {
  var digits = segmentRecordsDigits_(value); if (!/^(?:\d{13}|\d{15})$/.test(digits) || /^0+$/.test(digits)) return '';
  var divisor = digits.length === 13 ? 11 : 13, remainder = 0;
  for (var index = 0; index < digits.length - 1; index++) remainder = (remainder * 10 + Number(digits.charAt(index))) % divisor;
  return remainder % 10 === Number(digits.charAt(digits.length - 1)) ? digits : '';
}
function segmentRecordsCopy_(value) { var result = {}; Object.keys(value || {}).forEach(function (key) { if (key !== '__proto__' && key !== 'constructor') result[key] = value[key]; }); return result; }

function segmentRecordsDomain_(value) {
  var text = segmentRecordsText_(value).toLowerCase(), match = text.match(/^(?:https?:\/\/)?(?:www\.)?([^/?#\s]+)(?:[/?#]|$)/);
  if (!match || /[@:]/.test(match[1]) || match[1].indexOf('.') < 1) return '';
  var domain = match[1].replace(/\.$/, '');
  if (/(?:^|\.)(?:t\.me|telegram\.me|vk\.com|ok\.ru|instagram\.com|facebook\.com|wa\.me|whatsapp\.com|youtube\.com|linktr\.ee)$/.test(domain)) return '';
  return domain;
}

function segmentRecordsList_(value, kind) {
  var values = Array.isArray(value) ? value : [value], result = [], seen = Object.create(null);
  values.forEach(function (part) {
    if (part && typeof part === 'object') part = part.value || part.email || part.phone || part.username || '';
    var text = segmentRecordsText_(part);
    if (!text) return;
    var items;
    if (kind === 'email' && typeof preparedDataEmails_ === 'function') items = preparedDataEmails_(text);
    else items = text.split(/[;\n\r,]+/);
    items.forEach(function (item) {
      item = segmentRecordsText_(item);
      if (kind === 'email') item = item.replace(/^mailto:/i, '').toLowerCase();
      if (kind === 'telegram') item = item.replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '').toLowerCase();
      if (!item) return;
      if (kind === 'telegram') item = '@' + item;
      var key = item.toLowerCase();
      if (!seen[key]) { seen[key] = true; result.push(item); }
    });
  });
  return result;
}

function segmentRecordsUnion_(before, after, kind) { return segmentRecordsList_(segmentRecordsList_(before, kind).concat(segmentRecordsList_(after, kind)), kind).join('; '); }
function segmentRecordsHash_(value) { return digest_(JSON.stringify(value)); }
function segmentRecordsId_(prefix, value) { return prefix + '-' + segmentRecordsHash_(value).slice(0, 24); }
function segmentRecordsSource_(source) {
  source = source || {};
  return { fileId: segmentRecordsText_(source.fileId || source.sourceId), sheetId: Number(source.sheetId), sheetName: segmentRecordsText_(source.sheetName), row: Number(source.row) };
}
function segmentRecordsSourceKey_(source) { var ref = segmentRecordsSource_(source); return [ref.fileId, ref.sheetId, ref.row].join('|'); }
function segmentRecordsSourceLabel_(source) {
  var ref = segmentRecordsSource_(source);
  return ref.fileId ? 'https://docs.google.com/spreadsheets/d/' + ref.fileId + '/edit#gid=' + (Number.isSafeInteger(ref.sheetId) ? ref.sheetId : 0) + '&range=A' + (Number.isSafeInteger(ref.row) && ref.row > 0 ? ref.row : 1) : '';
}
function segmentRecordsJoinSources_(before, after) {
  var result = [], seen = Object.create(null);
  [before, after].forEach(function (value) { segmentRecordsText_(value).split(/[\r\n]+/).forEach(function (item) { item = item.trim(); if (item && !seen[item]) { seen[item] = true; result.push(item); } }); });
  return result.join('\n');
}
function segmentRecordsHasContacts_(record) { return ['emails', 'phones', 'telegrams'].some(function (key) { return segmentRecordsText_(record[key]) !== ''; }); }
function segmentRecordsSchema_(kind, directory) {
  if (kind !== 'companies') return SEGMENT_RECORDS_SCHEMA.person;
  return directory ? SEGMENT_RECORDS_SCHEMA.company.concat(SOURCE_DIRECTORY_FIELDS) : SEGMENT_RECORDS_SCHEMA.company;
}
function segmentRecordsFieldValue_(key, value) { return key.indexOf('directory') === 0 ? String(value == null ? '' : value) : segmentRecordsText_(value); }
function segmentRecordsValues_(record, kind, directory) { return segmentRecordsSchema_(kind, directory).map(function (field) { return segmentRecordsFieldValue_(field[0], record[field[0]]); }); }

function segmentRecordsCompany_(record) {
  var raw = record.company || {}, general = record.general || {};
  return {
    id: segmentRecordsText_(raw.id), name: segmentRecordsText_(raw.name), inn: segmentRecordsDigits_(raw.inn), ogrn: segmentRecordsDigits_(raw.ogrn),
    website: segmentRecordsText_(raw.website), city: segmentRecordsText_(raw.city),
    emails: segmentRecordsList_(general.emails || raw.emails, 'email').join('; '),
    phones: segmentRecordsList_(general.phones || raw.phones, 'phone').join('; '),
    telegrams: segmentRecordsList_(general.telegrams || raw.telegrams, 'telegram').join('; '),
    source: segmentRecordsSource_(record.source), directory: record.directory
  };
}

function segmentRecordsCompanyKeys_(record) {
  var keys = [], inn = segmentRecordsInn_(record.inn), ogrn = segmentRecordsOgrn_(record.ogrn), name = segmentRecordsName_(record.name), city = segmentRecordsCity_(record.city), domain = segmentRecordsDomain_(record.website);
  if (inn) keys.push('inn:' + inn);
  if (ogrn) keys.push('ogrn:' + ogrn);
  if (/^C-[A-Za-z0-9_-]{20,43}$/.test(record.id || '')) keys.push('id:' + record.id);
  if (domain && name) keys.push('site:' + domain + '|' + name + '|' + city);
  if (name && city) keys.push('name-city:' + name + '|' + city);
  if (name) keys.push('exact:' + segmentRecordsHash_([name, city, domain, segmentRecordsList_(record.emails, 'email').sort(), segmentRecordsList_(record.phones, 'phone').sort(), segmentRecordsList_(record.telegrams, 'telegram').sort()]));
  if (!name && segmentRecordsHasContacts_(record)) keys.push('contacts:' + segmentRecordsHash_([segmentRecordsList_(record.emails, 'email').sort(), segmentRecordsList_(record.phones, 'phone').sort(), segmentRecordsList_(record.telegrams, 'telegram').sort()]));
  return keys;
}

function segmentRecordsPlanner_(input) {
  input = input || {};
  var sourceRecords = Array.isArray(input.records) ? input.records : [], companies = [], people = [], review = [], markers = [], companyIndex = Object.create(null), companyNames = Object.create(null), personIndex = Object.create(null), companyChanges = [], personChanges = [];
  var nextCompanyRow = 2, nextPersonRow = 2, targetKind = input.targetKind, linkedCompanies = Object.create(null);
  function addIndex(index, key, record) { if (!index[key]) index[key] = []; if (index[key].indexOf(record) === -1) index[key].push(record); }
  function indexCompany(record) {
    segmentRecordsCompanyKeys_(record).forEach(function (key) { addIndex(companyIndex, key, record); });
    var name = segmentRecordsName_(record.name); if (name) addIndex(companyNames, name, record);
  }
  function personIdentity(record) {
    var company = record.companyId || (record.companyName ? 'label:' + segmentRecordsName_(record.companyName) : ''), name = segmentRecordsName_(record.name), role = segmentRecordsName_(record.role);
    if (!company) return '';
    if (name) return 'name:' + company + '|' + name;
    var contact = segmentRecordsList_(record.phones, 'phone')[0] || segmentRecordsList_(record.emails, 'email')[0] || segmentRecordsList_(record.telegrams, 'telegram')[0];
    return contact ? 'contact:' + company + '|' + contact.toLowerCase() : (role ? 'role:' + company + '|' + role : '');
  }
  function indexPerson(record) {
    if (record.id) addIndex(personIndex, 'id:' + record.id, record);
    var key = personIdentity(record); if (key) addIndex(personIndex, key, record);
    var label = segmentRecordsName_(record.companyName), name = segmentRecordsName_(record.name);
    if (name && label) addIndex(personIndex, 'label:' + label + '|' + name, record);
    if (name && !record.companyId && !label) addIndex(personIndex, 'unresolved-name:' + name, record);
  }
  function loadExisting(records, kind) {
    return (records || []).map(function (raw) {
      var record = segmentRecordsCopy_(raw); record.row = Number(raw.row || raw.rowIndex);
      if (!Number.isSafeInteger(record.row) || record.row < 2) fail_('SEGMENT_MASTER_SCHEMA', 'В единой таблице есть некорректный номер строки.');
      segmentRecordsSchema_(kind, input.directory).forEach(function (field) { record[field[0]] = segmentRecordsFieldValue_(field[0], record[field[0]]); });
      record.before = segmentRecordsValues_(record, kind, input.directory); record.existing = true;
      if (kind === 'companies') { nextCompanyRow = Math.max(nextCompanyRow, record.row + 1); indexCompany(record); }
      else { nextPersonRow = Math.max(nextPersonRow, record.row + 1); indexPerson(record); }
      return record;
    });
  }
  companies = loadExisting(input.companies, 'companies'); people = loadExisting(input.people, 'lpr');
  var seenSourceMarkers = Object.create(null), acceptedCompanies = 0, acceptedPeople = 0;
  function issue(kind, reason, source, value) { review.push({ kind: kind, reason: reason, source: segmentRecordsSource_(source), name: segmentRecordsText_(value) }); }
  function mergeCompany(record, incoming) {
    var directory = Object.assign({ directoryNames: incoming.name, directoryCities: incoming.city, directorySites: incoming.website, directoryEmails: incoming.emails, directoryTelegram: incoming.telegrams }, incoming.directory || {});
    if (input.directory) SOURCE_DIRECTORY_FIELDS.forEach(function (field) {
      var key = field[0], value = segmentRecordsFieldValue_(key, directory[key]);
      if (!value || (record._formulaFields && record._formulaFields[key]) || record[key] === value) return;
      if (!record[key]) record[key] = value;
      else if (key !== 'directoryBranches' && key !== 'directoryParsedAt') {
        var seen = new Set(record[key].split(/\r?\n/));
        var additions = value.split(/\r?\n/).filter(function (line) { if (!line || seen.has(line)) return false; seen.add(line); return true; });
        if (additions.length) record[key] += '\n' + additions.join('\n');
      }
    });
    ['name', 'inn', 'ogrn', 'website', 'city'].forEach(function (key) { if (!record[key] && incoming[key]) record[key] = incoming[key]; });
    if (!segmentRecordsInn_(record.inn) && segmentRecordsInn_(incoming.inn)) record.inn = segmentRecordsInn_(incoming.inn);
    if (!segmentRecordsOgrn_(record.ogrn) && segmentRecordsOgrn_(incoming.ogrn)) record.ogrn = segmentRecordsOgrn_(incoming.ogrn);
    ['emails', 'phones', 'telegrams'].forEach(function (key) { var kind = key === 'emails' ? 'email' : key === 'phones' ? 'phone' : 'telegram'; if (!record._formulaFields || !record._formulaFields[key]) record[key] = segmentRecordsUnion_(record[key], incoming[key], kind); });
    record.sources = segmentRecordsJoinSources_(record.sources, segmentRecordsSourceLabel_(incoming.source));
    if (!record.status) record.status = !record.name && !segmentRecordsInn_(record.inn) && !segmentRecordsOgrn_(record.ogrn) ? 'Уточнить компанию' : segmentRecordsHasContacts_(record) ? 'Подготовка' : 'Нет контактов';
    indexCompany(record); return record;
  }
  function resolveCompany(incoming) {
    var keys = segmentRecordsCompanyKeys_(incoming), matches = [], hardConflict = false;
    var explicitId = /^C-[A-Za-z0-9_-]{20,43}$/.test(incoming.id || '') ? incoming.id : '';
    if (!keys.length) return null;
    var strongKeys = keys.filter(function (key) { return /^(?:inn|ogrn|id):/.test(key); });
    function findCandidates(selected, strong) {
      for (var i = 0; i < selected.length; i++) {
      var found = companyIndex[selected[i]] || [];
      if (found.length > 1) { issue('company', 'В сегменте несколько компаний с одним идентификатором. Нужна ручная проверка.', incoming.source, incoming.name); return null; }
      if (found.length) {
        var candidate = found[0];
        var incompatible = (segmentRecordsInn_(incoming.inn) && segmentRecordsInn_(candidate.inn) && segmentRecordsInn_(incoming.inn) !== segmentRecordsInn_(candidate.inn)) || (segmentRecordsOgrn_(incoming.ogrn) && segmentRecordsOgrn_(candidate.ogrn) && segmentRecordsOgrn_(incoming.ogrn) !== segmentRecordsOgrn_(candidate.ogrn));
        var differentNames = explicitId && explicitId === candidate.id && incoming.name && candidate.name &&
          segmentRecordsName_(incoming.name) !== segmentRecordsName_(candidate.name);
        var sameRegistration = (segmentRecordsInn_(incoming.inn) && segmentRecordsInn_(incoming.inn) === segmentRecordsInn_(candidate.inn)) ||
          (segmentRecordsOgrn_(incoming.ogrn) && segmentRecordsOgrn_(incoming.ogrn) === segmentRecordsOgrn_(candidate.ogrn));
        if (incompatible || differentNames && !sameRegistration || explicitId && candidate.id && explicitId !== candidate.id) {
          if (strong) { issue('company', 'Сильные идентификаторы компании противоречат друг другу. Контакты не объединялись.', incoming.source, incoming.name); return null; }
          hardConflict = true; continue;
        }
        if (matches.indexOf(candidate) === -1) matches.push(candidate);
      }
      }
      return true;
    }
    if (findCandidates(strongKeys, true) === null) return null;
    if (!matches.length && findCandidates(keys.filter(function (key) { return targetKind === 'lpr' ? /^(?:site|name-city):/.test(key) : !/^(?:inn|ogrn|id):/.test(key); }), false) === null) return null;
    if (matches.length > 1) { issue('company', 'ИНН, сайт или название указывают на разные компании. Нужна ручная проверка.', incoming.source, incoming.name); return null; }
    if (targetKind === 'lpr') {
      var existing = matches[0];
      if (!existing || !existing.id || hardConflict || (companyIndex['id:' + existing.id] || []).length !== 1) return null;
      linkedCompanies[existing.id] = existing.row;
      return existing;
    }
    if (matches.length === 1) return mergeCompany(matches[0], incoming);
    var nameMatches = companyNames[segmentRecordsName_(incoming.name)] || [];
    var strong = keys.some(function (key) { return /^(?:inn|ogrn|id|site|name-city):/.test(key); });
    if (nameMatches.length && !strong && !hardConflict) { issue('company', 'Совпадает название, но недостаточно данных для безопасного объединения. Исходная строка сохранена.', incoming.source, incoming.name); return null; }
    var identity = keys.filter(function (key) { return /^(?:inn|ogrn|id|site|name-city):/.test(key); })[0] || keys[0];
    var record = { id: explicitId || segmentRecordsId_('C', identity), name: '', inn: '', ogrn: '', website: '', city: '', emails: '', phones: '', telegrams: '', personName: '', personRole: '', personEmails: '', personPhones: '', personTelegrams: '', transferred: '', sources: '', status: '', row: nextCompanyRow++, existing: false, before: [] };
    companies.push(record); acceptedCompanies++;
    if (identity.indexOf('contacts:') === 0) issue('company', 'Контакты сохранены без определения компании. Заполните компанию или ИНН позднее.', incoming.source, segmentRecordsList_(incoming.emails, 'email')[0] || segmentRecordsList_(incoming.phones, 'phone')[0] || segmentRecordsList_(incoming.telegrams, 'telegram')[0]);
    return mergeCompany(record, incoming);
  }
  function resolvePerson(raw, company, companyLabel, source) {
    var record = { companyId: company ? company.id : '', companyName: company ? company.name : companyLabel, name: segmentRecordsText_(raw.name), role: segmentRecordsText_(raw.role), emails: segmentRecordsList_(raw.emails, 'email').join('; '), phones: segmentRecordsList_(raw.phones, 'phone').join('; '), telegrams: segmentRecordsList_(raw.telegrams, 'telegram').join('; ') };
    if (!record.name && !record.role && !segmentRecordsHasContacts_(record)) return null;
    var key = personIdentity(record), provisional = segmentRecordsId_('P', ['source', segmentRecordsSourceKey_(source), record.name, record.role].join('|'));
    var explicitId = /^P-[A-Za-z0-9_-]{20,43}$/.test(raw.id || '') ? raw.id : '';
    var found = explicitId ? personIndex['id:' + explicitId] || [] : key ? personIndex[key] || [] : personIndex['id:' + provisional] || [];
    if (!found.length && record.name && record.companyName) found = personIndex['label:' + segmentRecordsName_(record.companyName) + '|' + segmentRecordsName_(record.name)] || [];
    if (found.length > 1) { issue('person', 'Есть несколько ЛПР с одинаковыми ФИО в этой компании. Контакты не объединялись.', source, record.name); return null; }
    var target = found[0];
    if (target && explicitId && target.id !== explicitId) { issue('person', 'ФИО совпадают, но ID ЛПР различаются. Контакты не объединялись.', source, record.name); return null; }
    if (target && explicitId && target.name && record.name && segmentRecordsName_(target.name) !== segmentRecordsName_(record.name)) { issue('person', 'Один ID ЛПР указан для разных ФИО. Нужна ручная проверка.', source, record.name); return null; }
    if (target && targetKind === 'lpr' && target.companyId && !record.companyId && !explicitId) { issue('person', 'Название компании и ФИО совпадают, но связь с компанией не подтверждена. Нужна ручная проверка.', source, record.name); return null; }
    if (target && explicitId && ((target.companyId && record.companyId && target.companyId !== record.companyId) ||
        (!target.companyId || !record.companyId) && target.companyName && record.companyName && segmentRecordsName_(target.companyName) !== segmentRecordsName_(record.companyName))) {
      issue('person', 'Один ID ЛПР указан для разных компаний. Проверьте принадлежность перед объединением.', source, record.name); return null;
    }
    if (target && target.companyId && record.companyId && target.companyId !== record.companyId) target = null;
    if (target && !explicitId && record.name) {
      var overlapping = false, comparable = false;
      ['email', 'phone', 'telegram'].forEach(function (channel) {
        var field = channel + 's', known = segmentRecordsList_(target[field], channel), incoming = segmentRecordsList_(record[field], channel);
        if (known.length && incoming.length) { comparable = true; if (known.some(function (value) { return incoming.indexOf(value) >= 0; })) overlapping = true; }
      });
      if (comparable && !overlapping) { issue('person', 'ФИО совпадают, но контакты не совпали. Проверьте, один ли это человек.', source, record.name); return null; }
    }
    if (!target) {
      var identity = key || ['source', segmentRecordsSourceKey_(source), record.name, record.role].join('|');
      if (!key && (personIndex['unresolved-name:' + segmentRecordsName_(record.name)] || []).length) issue('person', 'ЛПР без компании сохранён отдельно: совпадение ФИО не доказывает принадлежность одному человеку.', source, record.name);
      target = { id: explicitId || segmentRecordsId_('P', identity), companyId: '', companyName: '', name: '', role: '', emails: '', phones: '', telegrams: '', sources: '', status: '', row: nextPersonRow++, existing: false, before: [] };
      people.push(target); acceptedPeople++;
    }
    ['companyId', 'companyName', 'name', 'role'].forEach(function (field) { if (!target[field] && record[field]) target[field] = record[field]; });
    ['emails', 'phones', 'telegrams'].forEach(function (key) { var kind = key === 'emails' ? 'email' : key === 'phones' ? 'phone' : 'telegram'; if (!target._formulaFields || !target._formulaFields[key]) target[key] = segmentRecordsUnion_(target[key], record[key], kind); });
    target.sources = segmentRecordsJoinSources_(target.sources, segmentRecordsSourceLabel_(source));
    if (!target.status) target.status = segmentRecordsHasContacts_(target) ? 'Подготовка' : (target.name ? 'Найти контакты' : 'Найти ФИО и контакты');
    else if ((target.status === 'Найти контакты' || target.status === 'Найти ФИО и контакты') && segmentRecordsHasContacts_(target)) target.status = 'Подготовка';
    indexPerson(target); return target;
  }
  sourceRecords.forEach(function (sourceRecord) {
    var incoming = segmentRecordsCompany_(sourceRecord), source = segmentRecordsSource_(sourceRecord.source), transferred = [];
    if (targetKind === 'lpr' && !(sourceRecord.people || []).length) return;
    var company = resolveCompany(incoming);
    if (!company && !segmentRecordsHasContacts_(incoming) && !(Array.isArray(sourceRecord.people) && sourceRecord.people.length) && !segmentRecordsCompanyKeys_(incoming).length) issue('row', 'Строка не распознана как компания, ЛПР или контакт. Подробности сохранены в исходной базе.', source, incoming.name);
    if (targetKind === 'companies') return;
    (Array.isArray(sourceRecord.people) ? sourceRecord.people : []).forEach(function (raw) {
      var person = resolvePerson(raw || {}, company, incoming.name, raw && raw.source || source);
      if (!person) return;
      if (targetKind === 'lpr') return;
      transferred.push(person.id);
      if (company && !company.personName && !company.personRole && !company.personEmails && !company.personPhones && !company.personTelegrams) {
        company.personName = person.name; company.personRole = person.role; company.personEmails = person.emails; company.personPhones = person.phones; company.personTelegrams = person.telegrams;
      } else if (company && segmentRecordsName_(company.personName) === segmentRecordsName_(person.name)) {
        if (!company.personRole) company.personRole = person.role;
        if (!company.personEmails) company.personEmails = person.emails;
        if (!company.personPhones) company.personPhones = person.phones;
        if (!company.personTelegrams) company.personTelegrams = person.telegrams;
      }
    });
    if (transferred.length) {
      if (company) company.transferred = 'Перенесено в ЛПР';
      var key = segmentRecordsSourceKey_(source);
      if (!seenSourceMarkers[key]) { seenSourceMarkers[key] = { source: source, personIds: [], companyId: company ? company.id : '' }; markers.push(seenSourceMarkers[key]); }
      transferred.forEach(function (id) { if (seenSourceMarkers[key].personIds.indexOf(id) === -1) seenSourceMarkers[key].personIds.push(id); });
    }
  });
  function actions(records, kind) {
    return records.map(function (record) {
      var after = segmentRecordsValues_(record, kind, input.directory);
      if (record.existing && JSON.stringify(record.before) === JSON.stringify(after)) return null;
      return { row: record.row, id: record.id, before: record.before, after: after, added: !record.existing };
    }).filter(Boolean);
  }
  companyChanges = actions(companies, 'companies'); personChanges = actions(people, 'lpr');
  return {
    version: SEGMENT_RECORDS_SCHEMA.version, companies: companyChanges, people: personChanges, markers: markers, review: review, linkedCompanies: linkedCompanies,
    counts: { companiesAdded: acceptedCompanies, companiesUpdated: companyChanges.filter(function (action) { return !action.added; }).length, peopleAdded: acceptedPeople, peopleUpdated: personChanges.filter(function (action) { return !action.added; }).length, peopleWithoutContacts: targetKind === 'companies' ? 0 : people.filter(function (record) { return !segmentRecordsHasContacts_(record); }).length, review: review.length },
    sample: { companies: companyChanges.slice(0, 5).map(function (action) { return action.after; }), people: personChanges.slice(0, 5).map(function (action) { return action.after; }) }
  };
}
