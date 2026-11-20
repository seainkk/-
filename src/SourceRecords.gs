/** Pure source-row normalization. Contact extraction and every write belong to the caller. */
function sourceRecordsBuild_(displayRows, options) {
  options = options || {};
  if (!Array.isArray(displayRows)) throw new Error('Source rows must be an array.');
  var hasHeader = options.hasHeader !== false, headerIndex = Number.isInteger(options.headerIndex) && options.headerIndex >= 0 ? options.headerIndex : 0;
  var header = Array.isArray(options.header) ? options.header : hasHeader ? displayRows[headerIndex] || [] : [];
  var columns = sourceRecordsColumns_(header, options.section), contacts = options.cellContacts || Object.create(null), warnings = [], records = [];
  var warn = function (message) { if (warnings.indexOf(message) === -1) warnings.push(message); };
  for (var rowIndex = hasHeader ? headerIndex + 1 : 0; rowIndex < displayRows.length; rowIndex++) {
    var cells = Array.isArray(displayRows[rowIndex]) ? displayRows[rowIndex] : [], rowNumber = rowIndex + 1;
    var rowContacts = Object.create(null), width = Math.max(cells.length, header.length);
    for (var x = 0; x < width; x++) rowContacts[x] = sourceRecordsContacts_(contacts[rowNumber + ':' + (x + 1)]);
    if (!cells.some(function (value) { return sourceRecordsText_(value) !== ''; }) && !Object.keys(rowContacts).some(function (key) { return sourceRecordsHasContacts_(rowContacts[key]); })) continue;
    var source = { fileId: String(options.fileId || ''), sheetId: options.sheetId, sheetName: String(options.sheetName || ''), row: rowNumber };
    var record = { source: source, company: { id: '', inn: '', ogrn: '', name: '', website: '', city: '' }, people: [], general: sourceRecordsEmptyContacts_(), provenance: sourceRecordsEmptyProvenance_() };
    var companyValues = Object.create(null), groups = Object.create(null);
    var getGroup = function (key) { if (!groups[key]) groups[key] = { key: key, names: [], first: [], last: [], middle: [], roles: [], defaultRoles: [], columns: [], contacts: sourceRecordsEmptyContacts_(), provenance: sourceRecordsEmptyProvenance_(), nameRefs: [], roleRefs: [] }; return groups[key]; };
    columns.forEach(function (column, index) {
      var value = sourceRecordsText_(cells[index]), ref = sourceRecordsRef_(source, index + 1), cellContacts = rowContacts[index] || sourceRecordsEmptyContacts_();
      var raw = options.rawRows && options.rawRows[rowIndex] && options.rawRows[rowIndex][index];
      if (['id', 'inn', 'ogrn', 'registration'].indexOf(column.company) >= 0 && typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && /^[\d., ]+[eE][+-]?\d+$/.test(value)) value = String(raw);
      if (column.company && value) {
        if (!companyValues[column.company]) companyValues[column.company] = [];
        companyValues[column.company].push({ value: value, source: ref });
      }
      if (column.person && column.kind !== 'contact') {
        var group = getGroup(column.group), cleaned = column.kind === 'role' ? value : sourceRecordsCleanName_(value, cellContacts);
        if (!cleaned) return;
        sourceRecordsPush_(group.columns, index + 1);
        if (column.defaultRole) sourceRecordsPush_(group.defaultRoles, column.defaultRole);
        if (column.kind === 'role') { sourceRecordsPush_(group.roles, cleaned); group.roleRefs.push(ref); }
        else {
          sourceRecordsSplitNames_(cleaned).forEach(function (name) { sourceRecordsPush_(group[column.kind === 'name' ? 'names' : column.kind], name); });
          group.nameRefs.push(ref);
        }
      }
    });
    sourceRecordsMergeGenericPerson_(groups, columns, rowContacts);
    sourceRecordsCompany_(record, companyValues, warn);
    var knownKeys = Object.keys(groups).filter(function (key) { var group = groups[key]; return group.names.length || group.first.length || group.last.length || group.middle.length || group.roles.length; }), personalTargets = Object.create(null);
    columns.forEach(function (column, index) {
      if (!column.person || column.kind !== 'contact' || column.group === 'personal' || !sourceRecordsHasContacts_(rowContacts[index] || sourceRecordsEmptyContacts_())) return;
      var targetKey = column.group;
      if (!groups[targetKey] && targetKey.indexOf('role:') === 0 && knownKeys.length === 1 && groups[knownKeys[0]].key.indexOf('role:') !== 0 && !groups[knownKeys[0]].roles.some(function (role) { var mapped = sourceRecordsRole_(sourceRecordsKey_(role)); return mapped.key && targetKey !== 'role:' + mapped.key; })) targetKey = knownKeys[0];
      var hinted = getGroup(targetKey); hinted.contactHint = true; personalTargets[index] = targetKey;
      if (column.defaultRole) sourceRecordsPush_(hinted.defaultRoles, column.defaultRole);
    });
    var activeKeys = Object.keys(groups).filter(function (key) { var group = groups[key]; return group.names.length || group.first.length || group.last.length || group.middle.length || group.roles.length || group.contactHint; });
    for (var columnIndex = 0; columnIndex < width; columnIndex++) {
      var values = rowContacts[columnIndex], descriptor = columns[columnIndex] || {}, target = null, ambiguous = false;
      if (descriptor.ignored) continue;
      if (!sourceRecordsHasContacts_(values)) continue;
      var cellRef = sourceRecordsRef_(source, columnIndex + 1);
      sourceRecordsAddContacts_(record.provenance, null, values, cellRef);
      if (descriptor.general) target = null;
      else if (descriptor.number && groups['number:' + descriptor.number]) target = groups['number:' + descriptor.number];
      else if (descriptor.person && descriptor.group && descriptor.group !== 'personal') {
        if (personalTargets[columnIndex]) target = groups[personalTargets[columnIndex]];
        else if (groups[descriptor.group]) target = groups[descriptor.group];
        else if (descriptor.group.indexOf('role:') === 0 && activeKeys.length === 1 && groups[activeKeys[0]].key.indexOf('role:') !== 0 && !groups[activeKeys[0]].roles.some(function (role) { var mapped = sourceRecordsRole_(sourceRecordsKey_(role)); return mapped.key && descriptor.group !== 'role:' + mapped.key; })) target = groups[activeKeys[0]];
        else target = getGroup(descriptor.group);
      }
      else if (descriptor.person || options.section === 'lpr') {
        if (options.section === 'lpr' && descriptor.number && groups['number:' + descriptor.number]) target = groups['number:' + descriptor.number];
        else if (activeKeys.length === 1) target = groups[activeKeys[0]];
        else if (!activeKeys.length) target = getGroup('default');
        else ambiguous = true;
      }
      if (target) {
        sourceRecordsPush_(target.columns, columnIndex + 1);
        if (descriptor.defaultRole) sourceRecordsPush_(target.defaultRoles, descriptor.defaultRole);
        sourceRecordsAddContacts_(target.provenance, target.contacts, values, cellRef);
      } else {
        sourceRecordsAddContacts_(null, record.general, values, cellRef);
        if (ambiguous) { record.ambiguous = true; warn('Контакты без однозначного указания ЛПР сохранены как общие: в строке найдено несколько людей.'); }
      }
    }
    Object.keys(groups).forEach(function (key) {
      var group = groups[key], names = group.names.slice(), roles = group.roles.length ? group.roles : group.defaultRoles;
      var partAmbiguous = group.first.length > 1 || group.last.length > 1 || group.middle.length > 1;
      if (!names.length && !partAmbiguous) {
        var joined = [group.last[0], group.first[0], group.middle[0]].filter(Boolean).join(' ');
        if (joined) names.push(joined);
      } else if (!names.length && partAmbiguous) names = sourceRecordsUnique_(group.last.concat(group.first, group.middle));
      var groupAmbiguous = names.length > 1 || partAmbiguous || (!names.length && roles.length > 1);
      if (!names.length && !roles.length && !sourceRecordsHasContacts_(group.contacts)) return;
      if (groupAmbiguous) {
        record.ambiguous = true;
        warn('В одной группе столбцов найдено несколько ЛПР. Имена сохранены отдельно, общие контакты не распределялись между людьми автоматически.');
        sourceRecordsAddContacts_(null, record.general, group.contacts, null);
      }
      var identities = names.length ? names.map(function (name) { return { name: name, role: roles.join('; ') }; }) : roles.length > 1 ? roles.map(function (role) { return { name: '', role: role }; }) : [{ name: '', role: roles[0] || '' }];
      identities.forEach(function (identity) {
        var person = { name: identity.name, role: identity.role, emails: groupAmbiguous ? [] : group.contacts.emails.slice(), phones: groupAmbiguous ? [] : group.contacts.phones.slice(), telegrams: groupAmbiguous ? [] : group.contacts.telegrams.slice(), source: Object.assign({}, source, { group: group.key, columns: group.columns.slice().sort(function (a, b) { return a - b; }) }), provenance: { name: group.nameRefs.slice(), role: group.roleRefs.slice(), emails: groupAmbiguous ? {} : group.provenance.emails, phones: groupAmbiguous ? {} : group.provenance.phones, telegrams: groupAmbiguous ? {} : group.provenance.telegrams } };
        if (groupAmbiguous) person.ambiguous = true;
        record.people.push(person);
      });
    });
    if (!record.people.length && !sourceRecordsHasContacts_(record.general) && !Object.keys(record.company).some(function (key) { return typeof record.company[key] === 'string' && record.company[key] !== ''; })) {
      record.ambiguous = true; warn('В некоторых непустых строках не распознаны реквизиты компании или ЛПР. Исходные строки сохранены для ручной проверки.');
    }
    records.push(record);
  }
  return { records: records, warnings: warnings };
}

/** A generic job title / matching first name describes the sole named person.
 * Keep separate anonymous people when another name or contact group makes the
 * attribution ambiguous. No contacts or source evidence are discarded.
 */
function sourceRecordsMergeGenericPerson_(groups, columns, rowContacts) {
  var generic = groups.default; if (!generic) return;
  var others = Object.keys(groups).filter(function (key) {
    var group = groups[key]; return key !== 'default' && (group.names.length || group.first.length || group.last.length || group.middle.length || group.roles.length);
  });
  if (others.length !== 1) return;
  var key = others[0], target = groups[key];
  if (target.names.length !== 1 || target.first.length > 1 || target.last.length > 1 || target.middle.length > 1 || generic.first.length > 1 || generic.last.length > 1 || generic.middle.length > 1) return;
  var identity = sourceRecordsKey_(target.names[0]), words = sourceRecordsText_(target.names[0]).split(/[\s,;]+/).map(sourceRecordsKey_).filter(Boolean);
  if (generic.names.some(function (name) { return sourceRecordsKey_(name) !== identity; })) return;
  if (['first', 'last', 'middle'].some(function (part) {
    return generic[part].some(function (value) { return words.indexOf(sourceRecordsKey_(value)) < 0; });
  })) return;
  // Explicit contacts of a different role/number can represent another person,
  // even when that person's name is missing. A plain personal contact can be
  // assigned to the sole named person after this reconciliation.
  if (columns.some(function (column, index) {
    if (column.kind !== 'contact' || !sourceRecordsHasContacts_(rowContacts[index])) return false;
    if (column.number && key !== 'number:' + column.number) return true;
    return column.person && column.group && column.group !== 'personal' && column.group !== 'default' && column.group !== key;
  })) return;
  ['names', 'first', 'last', 'middle', 'roles', 'defaultRoles', 'columns'].forEach(function (field) {
    generic[field].forEach(function (value) { sourceRecordsPush_(target[field], value); });
  });
  target.nameRefs = target.nameRefs.concat(generic.nameRefs); target.roleRefs = target.roleRefs.concat(generic.roleRefs);
  delete groups.default;
}

function sourceRecordsColumns_(headers, section) {
  return headers.map(function (label) {
    var key = sourceRecordsKey_(label), result = { label: String(label || ''), key: key, person: false, kind: '', group: '', number: '' };
    var companyAliases = { id: ['companyid', 'idкомпании', 'идкомпании', 'companykey'], inn: ['инн', 'иннкомпании', 'иннюрлица', 'иннорганизации', 'inn', 'companyinn'], ogrn: ['огрн', 'огрнип', 'ogrn', 'ogrnip', 'companyogrn'], registration: ['инногрн', 'огрнинн'], name: ['название', 'названия', 'названиекомпании', 'названиякомпаний', 'названиеорганизации', 'названиеюрлица', 'компания', 'компании', 'фирма', 'company', 'companyname', 'companytitle', 'organization', 'organizationname', 'organisation', 'организация', 'наименование', 'наименованиеорганизации', 'наименованиекомпании', 'наименованиеюрлица', 'юрлицо'], website: ['сайт', 'сайты', 'сайткомпании', 'сайтыкомпании', 'сайтизисходногосписка', 'website', 'websites', 'site', 'sites', 'companywebsite', 'домен', 'domain'], city: ['город', 'city', 'городкомпании', 'городрегистрации', 'городстрана', 'населенныйпункт', 'населенныепункты'] };
    Object.keys(companyAliases).forEach(function (kind) { if (companyAliases[kind].indexOf(key) !== -1) result.company = kind; });
    if (key === 'name' && section !== 'lpr') result.company = 'name';
    if (result.company) { result.general = true; return result; }
    if (/валид|результат|статус|отправител|sender|провер|колво|количество|дубль|кампан|рассылк/.test(key) || /^(?:переносвлпр|перенесеновлпр|добавленовлпр|idлпр|идлпр|идентификаторлпр)$/.test(key)) { result.ignored = true; return result; }
    var isContact = /email|почт|телефон|phone|mobile|телеграм|telegram|^tg\d*$/.test(key), number = (key.match(/(?:^|[^0-9])(\d+)$/) || [])[1] || '';
    var role = sourceRecordsRole_(key), nameKey = key.replace(/\d+$/, ''), personal = /фио|фамилияимяотчество|полноеимя|fullname|personname|contactname|контактноелицо|лпр|директор|руководител|маркетолог|менеджер|специалист|закупщик|бухгалтер|собственник|владелец|учредител|director|manager|ceo|decisionmaker/.test(key);
    result.general = (/компании|emailадреса|мобильныетелефоны|городскиетелефоны|общ(?:ий|ая|ие|ее)|general|corporate|корпоративн/.test(key) || (isContact && !!role.key)) && !personal;
    var part = /^(?:имя|firstname)\d*$/.test(key) ? 'first' : /^(?:фамилия|lastname|surname)\d*$/.test(key) ? 'last' : /^(?:отчество|patronymic)\d*$/.test(key) ? 'middle' : '';
    var roleField = /^(?:должность|позиция|position|jobtitle)/.test(key) || /(?:должность|jobtitle)$/.test(nameKey) || (section === 'lpr' && /^title\d*$/.test(key));
    if (part || roleField || (!isContact && personal) || (section === 'lpr' && /^name\d*$/.test(key))) {
      result.person = true; result.kind = part || (roleField ? 'role' : 'name');
      result.group = number ? 'number:' + number : role.key ? 'role:' + role.key : 'default'; result.number = number; result.defaultRole = role.label;
    } else if (isContact && !result.general && (personal || /личн|персональн|person|private/.test(key))) {
      result.person = true; result.kind = 'contact'; result.group = number ? 'number:' + number : role.key ? 'role:' + role.key : 'personal'; result.number = number; result.defaultRole = role.label;
    } else if (isContact) { result.kind = 'contact'; result.number = number; }
    return result;
  });
}

function sourceRecordsRole_(key) {
  if (/маркетолог|маркетинг|marketing/.test(key)) return { key: 'marketing', label: 'Маркетинг' };
  if (/продаж|sales/.test(key)) return { key: 'sales', label: 'Продажи' };
  if (/закуп|снабжен|procurement/.test(key)) return { key: 'procurement', label: 'Закупки' };
  if (/коммерческ/.test(key)) return { key: 'commercial', label: 'Коммерческий директор' };
  if (/бухгалтер|accountant/.test(key)) return { key: 'accounting', label: 'Бухгалтер' };
  if (/собственник|владелец|учредител|owner/.test(key)) return { key: 'owner', label: 'Собственник' };
  if (/директор|руководител|director|ceo/.test(key)) return { key: 'director', label: /генеральн|гендиректор|ceo/.test(key) ? 'Генеральный директор' : /директор|director/.test(key) ? 'Директор' : 'Руководитель' };
  return { key: '', label: '' };
}

function sourceRecordsCompany_(record, values, warn) {
  record.company.provenance = {};
  // A real source uses one "ИНН/ОГРН" column. Keep the two identifier types
  // distinct; an invalid or ambiguous value must never become a strong key.
  if (values.registration) {
    var registration = values.registration; delete values.registration;
    record.company.provenance.registration = registration.map(function (entry) { return entry.source; });
    registration.forEach(function (entry) {
      var text = sourceRecordsText_(entry.value), compact = text.replace(/\D/g, '');
      var candidates = /^(?:\d{10}|\d{12}|\d{13}|\d{15})$/.test(compact) ? [compact] : text.match(/\b(?:\d{15}|\d{13}|\d{12}|\d{10})\b/g) || [];
      var valid = candidates.filter(function (candidate) {
        var kind = candidate.length === 10 || candidate.length === 12 ? 'inn' : 'ogrn';
        var identity = kind === 'inn' ? typeof contactPreviewInn_ === 'function' ? contactPreviewInn_(candidate) : '' : sourceRecordsOgrn_(candidate);
        if (!identity) return false;
        if (!values[kind]) values[kind] = []; values[kind].push({ value: identity, source: entry.source }); return true;
      });
      if (!valid.length || valid.length !== candidates.length) {
        record.company.rawRegistration = [record.company.rawRegistration, text].filter(Boolean).join('; ');
        warn('Часть реквизитов из колонки «ИНН/ОГРН» не распознана или не прошла проверку. Исходное значение сохранено для ручной проверки.');
      }
    });
  }
  Object.keys(values).forEach(function (kind) {
    var entries = values[kind], unique = sourceRecordsUnique_(entries.map(function (entry) { return entry.value; }));
    record.company.provenance[kind] = entries.map(function (entry) { return entry.source; });
    if (kind === 'inn') {
      var valid = sourceRecordsUnique_(unique.map(function (value) { return typeof contactPreviewInn_ === 'function' ? contactPreviewInn_(value) : ''; }).filter(Boolean));
      if (valid.length === 1) record.company.inn = valid[0];
      else if (valid.length > 1) { record.ambiguous = true; warn('В некоторых строках указано несколько разных ИНН. Компания требует ручной проверки.'); }
      if (valid.length !== unique.length) { record.company.rawInn = unique.join('; '); warn('Часть ИНН не прошла проверку структуры и контрольных цифр. Исходное значение сохранено для ручной проверки.'); }
    } else if ((kind === 'id' || kind === 'ogrn') && unique.length > 1) {
      record.ambiguous = true; record.company['raw' + (kind === 'id' ? 'Id' : 'Ogrn')] = unique.join('; '); warn('В некоторых строках несколько разных идентификаторов компании. Они не объединяются автоматически.');
    } else if (kind === 'id' && /^\d(?:[.,]\d+)?e[+-]?\d+$/i.test(unique[0])) { record.company.rawId = unique[0]; record.ambiguous = true; warn('Часть идентификаторов компании отображается в научной записи. Они требуют ручной проверки.'); }
    else if (kind === 'ogrn') record.company.ogrn = unique[0].replace(/\s/g, '');
    else record.company[kind] = unique[0] || '';
  });
}

function sourceRecordsOgrn_(value) {
  var digits = String(value || ''); if (!/^(?:\d{13}|\d{15})$/.test(digits) || /^0+$/.test(digits)) return '';
  var divisor = digits.length === 13 ? 11 : 13, remainder = 0;
  for (var index = 0; index < digits.length - 1; index++) remainder = (remainder * 10 + Number(digits.charAt(index))) % divisor;
  return remainder % 10 === Number(digits.charAt(digits.length - 1)) ? digits : '';
}

function sourceRecordsContacts_(value) {
  var result = sourceRecordsEmptyContacts_(); value = value && typeof value === 'object' ? value : {};
  ['emails', 'phones', 'telegrams'].forEach(function (kind) {
    (Array.isArray(value[kind]) ? value[kind] : []).forEach(function (item) {
      var text = sourceRecordsText_(typeof item === 'string' ? item : item && item.value);
      if (!text) return;
      if (kind === 'emails') text = text.toLowerCase();
      if (kind === 'telegrams') text = '@' + text.replace(/^@/, '').toLowerCase();
      sourceRecordsPush_(result[kind], text);
    });
  });
  return result;
}
function sourceRecordsAddContacts_(provenance, target, values, ref) {
  ['emails', 'phones', 'telegrams'].forEach(function (kind) { values[kind].forEach(function (value) {
    if (target) sourceRecordsPush_(target[kind], value);
    if (provenance && ref) { if (!provenance[kind][value]) provenance[kind][value] = []; provenance[kind][value].push(ref); }
  }); });
}
function sourceRecordsRef_(source, column) { return Object.assign({}, source, { column: column }); }
function sourceRecordsEmptyContacts_() { return { emails: [], phones: [], telegrams: [] }; }
function sourceRecordsEmptyProvenance_() { return { emails: Object.create(null), phones: Object.create(null), telegrams: Object.create(null) }; }
function sourceRecordsHasContacts_(values) { return !!values && ['emails', 'phones', 'telegrams'].some(function (kind) { return Array.isArray(values[kind]) && values[kind].length > 0; }); }
function sourceRecordsText_(value) { return String(value === null || value === undefined ? '' : value).trim(); }
function sourceRecordsKey_(value) { return String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, ''); }
function sourceRecordsPush_(values, value) { if (values.indexOf(value) === -1) values.push(value); }
function sourceRecordsUnique_(values) { return values.filter(function (value, index) { return value && values.indexOf(value) === index; }); }
function sourceRecordsSplitNames_(value) { return sourceRecordsUnique_(String(value || '').split(/[;\n\r|]+|\s+\/\s+/).map(function (name) { return name.trim(); })); }
function sourceRecordsCleanName_(value, contacts) {
  var text = String(value || '');
  contacts.emails.forEach(function (email) { text = text.split(email).join(''); });
  text = text.replace(/(?:https?:\/\/|mailto:|tel:|tg:\/\/)[^\s<>]+/gi, '').replace(/[^\s,;<>]+@[^\s,;<>]+/g, '').replace(/(^|\s)@[a-z0-9_]+/gi, '$1').replace(/\+?\d[\d() .-]{5,}\d/g, '');
  return text.replace(/^[\s,–—-]+|[\s,–—-]+$/g, '').replace(/[ \t]+/g, ' ').trim();
}
