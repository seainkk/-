/** Read-only composition preview. Never imports contacts or changes source cells. */
var CONTACT_PREVIEW_LIMITS = Object.freeze({ maxSheets: 30, maxRows: 50000, maxColumns: 100, maxCells: 1000000, chunkCells: 100000, maxMillis: 20000, maxContacts: 100000, maxConflicts: 10000, maxDetailCharacters: 6000000, maxSources: 20, maxOwners: 30 });

function previewSourceBaseContacts_(request) {
  return api_(function () {
    var context = authorize_(), input = object_(request);
    if (Object.keys(input).some(function (key) { return key !== 'id'; })) fail_('INVALID_REQUEST', 'Для анализа требуется только идентификатор исходной базы.');
    var fileId = id_(input.id), file = contactPreviewFile_(context, fileId);
    var result = { state: 'ready', source: { id: fileId, name: file.getName(), url: spreadsheetUrl_(fileId) }, scannedRows: 0, totalSheets: 0, sheets: [], companies: { unique: 0, unresolvedRows: 0 }, emails: { occurrences: 0, unique: 0, multiCompany: 0, unresolved: 0 }, phones: { occurrences: 0, unique: 0, mobiles: 0, landlines: 0, unknownType: 0, multiCompany: 0, unresolved: 0 }, conflicts: { total: 0, items: [], truncated: false }, warnings: [] };
    var budget = { started: Date.now(), cells: 0, rows: 0, partial: false }, observations = [], unparsed = false;
    var book = SpreadsheetApp.openById(fileId), sheets = contactPreviewSourceSheets_(context, fileId, book.getSheets()), mapped = 0, unmapped = 0;
    result.totalSheets = sheets.length;
    for (var index = 0; index < sheets.length; index++) {
      if (index >= CONTACT_PREVIEW_LIMITS.maxSheets || !contactPreviewTime_(budget)) { budget.partial = true; contactPreviewWarn_(result, 'Достигнут лимит анализа листов или времени. Показаны неполные показатели.'); break; }
      var sheet = sheets[index], lastRow = sheet.getLastRow(), lastColumn = sheet.getLastColumn();
      var meta = { id: sheet.getSheetId(), name: sheet.getName(), rowsScanned: 0, companyColumns: [], emailColumns: [], phoneColumns: [], state: 'ready' };
      result.sheets.push(meta);
      if (!lastRow || !lastColumn) continue;
      if (lastColumn > CONTACT_PREVIEW_LIMITS.maxColumns) { meta.state = 'partial'; meta.reason = 'В листе больше допустимого числа столбцов.'; budget.partial = true; continue; }
      contactPreviewFile_(context, fileId);
      if (budget.cells + lastColumn > CONTACT_PREVIEW_LIMITS.maxCells) { budget.partial = true; meta.state = 'partial'; break; }
      var header = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0]; budget.cells += lastColumn;
      var mapping = contactPreviewMapping_(header);
      ['companyColumns', 'emailColumns', 'phoneColumns'].forEach(function (key) { meta[key] = mapping[key]; });
      if (mapping.unmappedContactColumns.length) { unmapped++; meta.state = 'mapping_required'; meta.reason = 'Часть контактных столбцов требует настройки: ' + mapping.unmappedContactColumns.map(function (column) { return column.label; }).join(', '); }
      if (!mapping.companyColumns.length && !mapping.emailColumns.length && !mapping.phoneColumns.length) {
        if (lastRow > 1) { unmapped++; meta.state = 'mapping_required'; meta.reason = 'Не распознаны столбцы компании, email или телефонов. Нужна настройка соответствия.'; }
        continue;
      }
      mapped++;
      var selected = mapping.companyColumns.concat(mapping.emailColumns, mapping.phoneColumns), first = Math.min.apply(null, selected.map(function (column) { return column.index; })), last = Math.max.apply(null, selected.map(function (column) { return column.index; }));
      var width = last - first + 1, chunk = Math.max(1, Math.floor(CONTACT_PREVIEW_LIMITS.chunkCells / width));
      // Check current membership after reading headers and before any body cells.
      contactPreviewFile_(context, fileId);
      for (var row = 2; row <= lastRow;) {
        var size = Math.min(chunk, lastRow - row + 1, CONTACT_PREVIEW_LIMITS.maxRows - budget.rows, Math.floor((CONTACT_PREVIEW_LIMITS.maxCells - budget.cells) / width));
        if (size < 1 || !contactPreviewTime_(budget)) { budget.partial = true; meta.state = 'partial'; meta.reason = 'Достигнут лимит чтения. Результат неполный.'; break; }
        var values = sheet.getRange(row, first + 1, size, width).getDisplayValues();
        budget.cells += size * width; budget.rows += size;
        for (var offset = 0; offset < values.length; offset++) {
          var cells = values[offset], at = function (column) { return cells[column.index - first]; };
          if (!selected.some(function (column) { return String(at(column) || '').trim() !== ''; })) continue;
          meta.rowsScanned++; result.scannedRows++;
          var observation = { localId: '', inn: '', name: '', emails: [], phones: [], source: { sheetId: meta.id, sheetName: meta.name, row: row + offset } };
          var ids = [], inns = [];
          mapping.companyColumns.forEach(function (column) {
            var value = String(at(column) || '').trim();
            if (column.kind === 'id' && value && value.length <= 512 && !/^\d(?:[.,]\d+)?e[+-]?\d+$/i.test(value) && ids.indexOf(value) === -1) ids.push(value);
            if (column.kind === 'inn') { var validInn = contactPreviewInn_(value); if (validInn && inns.indexOf(validInn) === -1) inns.push(validInn); }
            if (column.kind === 'name' && !observation.name) observation.name = contactPreviewLabel_(value);
          });
          observation.identityAmbiguous = ids.length > 1 || inns.length > 1;
          observation.localId = ids.length === 1 ? ids[0] : '';
          observation.inn = inns.length === 1 ? inns[0] : '';
          mapping.emailColumns.forEach(function (column) { var raw = String(at(column) || ''), parsed = contactPreviewEmails_(raw); if ((contactPreviewHasValue_(raw) && !parsed.length) || (raw.match(/@/g) || []).length !== parsed.length) unparsed = true; observation.emails = observation.emails.concat(parsed); });
          mapping.phoneColumns.forEach(function (column) { var parsed = contactPreviewPhones_(at(column)); if (contactPreviewHasValue_(at(column)) && !parsed.length) unparsed = true; observation.phones = observation.phones.concat(parsed); });
          observations.push(observation);
        }
        row += size;
      }
      if (budget.partial) { contactPreviewWarn_(result, 'Анализ ограничен по объёму или времени. Показатели являются нижней границей, а не полным итогом.'); break; }
    }
    contactPreviewFile_(context, fileId);
    contactPreviewAggregate_(result, observations, fileId, budget);
    if (result.companies.unresolvedRows) contactPreviewWarn_(result, 'Часть строк не имеет однозначного Company_ID или корректного ИНН. Число компаний подтверждено только для распознанных идентификаторов.');
    if (unmapped) contactPreviewWarn_(result, 'Некоторые листы требуют настройки столбцов и не вошли в подсчёт.');
    if (result.phones.unknownType) contactPreviewWarn_(result, 'Тип части телефонов не определён. Они не включены в число мобильных для Telegram.');
    if (unparsed) contactPreviewWarn_(result, 'В контактных столбцах есть значения, из которых не удалось извлечь корректный формат email или телефона. Они требуют ручной проверки и не вошли в число распознанных контактов.');
    result.scanComplete = !budget.partial && !unmapped && !unparsed;
    result.state = !mapped && unmapped ? 'mapping_required' : (budget.partial || unmapped || unparsed || result.companies.unresolvedRows ? 'partial' : 'ready');
    contactPreviewCompareTarget_(context, result, observations, fileId);
    return result;
  });
}

function contactPreviewFile_(context, fileId) {
  var current = authorize_();
  var storageId = current.properties.getProperty('SOURCE_BASES_STORAGE_ID') || REGISTRY_CONFIG.defaultSourceBasesStorageId;
  if (fileId === storageId || fileId === REGISTRY_CONFIG.defaultSourceBasesStorageId) fail_('PROTECTED_FILE', 'Служебная таблица исключена из анализа исходных баз.');
  var centerId = current.properties.getProperty('CONTACT_CENTER_ID') || REGISTRY_CONFIG.defaultContactCenterId;
  if (fileId === centerId || fileId === REGISTRY_CONFIG.defaultContactCenterId) fail_('PROTECTED_FILE', 'Целевой Центр баз исключён из анализа исходных файлов.');
  var binding = sourceBasesSource_(current);
  if (binding.state !== 'ready') fail_('SOURCE_UNAVAILABLE', 'Папка исходных баз недоступна.');
  var file = sourceBasesFile_(current, binding.folder, fileId);
  if (file.getMimeType() !== REGISTRY_CONFIG.spreadsheetMime) fail_('UNSUPPORTED_FORMAT', 'Для анализа нужна Google Таблица. Загруженные файлы сначала преобразуются в Google Таблицы.');
  return file;
}

function contactPreviewHeader_(value) { return String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, ''); }

/** Prepared books contain derived lists; never count their contacts a second time. */
function contactPreviewSourceSheets_(context, fileId, sheets) {
  authorize_();
  if (typeof Drive === 'undefined' || !Drive.Files || typeof Drive.Files.get !== 'function') return sheets;
  var metadata = Drive.Files.get(fileId, { fields: 'appProperties', supportsAllDrives: true });
  var properties = metadata && metadata.appProperties || {};
  if (properties.registryPreparedVersion === '2') {
    var emailId = properties.registryContactEmailSheetId, phoneId = properties.registryContactPhoneSheetId;
    if (!/^\d+$/.test(emailId || '') || !/^\d+$/.test(phoneId || '') || emailId === phoneId) fail_('PREPARED_SCHEMA', 'Не удалось определить контактные листы подготовленной базы.');
    if (sheets.filter(function (sheet) { return String(sheet.getSheetId()) === emailId || String(sheet.getSheetId()) === phoneId; }).length !== 2) fail_('PREPARED_SCHEMA', 'Контактные листы подготовленной базы недоступны.');
    return sheets.filter(function (sheet) { var id = String(sheet.getSheetId()); return id !== emailId && id !== phoneId; });
  }
  if (properties.registryPreparedVersion !== '1') return sheets;
  var originalId = properties.registryPreparedOriginalSheetId;
  if (typeof originalId !== 'string' || !/^\d+$/.test(originalId)) fail_('PREPARED_SCHEMA', 'Не удалось определить исходный лист подготовленной базы.');
  var original = sheets.filter(function (sheet) { return String(sheet.getSheetId()) === originalId; });
  if (original.length !== 1) fail_('PREPARED_SCHEMA', 'Исходный лист подготовленной базы недоступен.');
  return original;
}

function contactPreviewMapping_(header) {
  var mapping = { companyColumns: [], emailColumns: [], phoneColumns: [], unmappedContactColumns: [] };
  var emailNames = ['email', 'emails', 'emailадрес', 'emailадреса', 'emailкомпании', 'корпоративныйemail', 'личныйemail', 'рабочийemail', 'почты', 'почта', 'почтаосновная', 'почтадоп', 'почтадополнительная', 'доппочта', 'элпочта', 'электроннаяпочта', 'электронныйадрес', 'email1', 'email2', 'email3', 'emailдоп', 'emailосновной', 'почтыкомпании', 'контактныйemail', 'личнаяпочта', 'корпоративнаяпочта'];
  var phoneNames = ['phone', 'phones', 'mobile', 'mobiles', 'телефон', 'телефоны', 'мобильныйтелефон', 'мобильныетелефоны', 'городскойтелефон', 'городскиетелефоны', 'основнойтелефон', 'дополнительныйтелефон', 'телосновной', 'телдоп', 'телдополнительный', 'доптелефон', 'доптел', 'рабочийтелефонкомпания', 'рабочийтелефон', 'телефоныкомпании', 'мобильный', 'контактныйтелефон', 'номераизссылоксоцсетей'];
  header.forEach(function (label, index) {
    var key = contactPreviewHeader_(String(label || '').replace(/\([^)]*не\s+провер[^)]*\)/gi, '')), column = { index: index, label: contactPreviewLabel_(label) };
    if (['companyid', 'idкомпании', 'идкомпании'].indexOf(key) !== -1) mapping.companyColumns.push({ index: index, label: column.label, kind: 'id' });
    if (['инн', 'иннкомпании', 'иннюрлица', 'inn', 'companyinn'].indexOf(key) !== -1) mapping.companyColumns.push({ index: index, label: column.label, kind: 'inn' });
    if (['название', 'названия', 'названиекомпания', 'названиекомпании', 'компания', 'компании', 'company', 'companyname', 'organization'].indexOf(key) !== -1) mapping.companyColumns.push({ index: index, label: column.label, kind: 'name' });
    if (/валид|результат|статус|отправител|sender|провер|колво|количество|дубль/.test(key)) return;
    var isEmail = emailNames.indexOf(key) !== -1 || (/руководител|лпр|маркетолог/.test(key) && /email|почт/.test(key));
    var isPhone = phoneNames.indexOf(key) !== -1 || /^(?:телефон|мобильный|мобильныйтелефон)[123]$/.test(key) || (/руководител|лпр|маркетолог/.test(key) && /телефон|мобильн/.test(key));
    if (isEmail) mapping.emailColumns.push(column);
    if (isPhone) mapping.phoneColumns.push(column);
    if (!isEmail && !isPhone && /email|почт|телефон|мобильн/.test(key)) mapping.unmappedContactColumns.push(column);
  });
  return mapping;
}

function contactPreviewInn_(value) {
  var digits = String(value || '').trim().replace(/^ИНН\s*:?\s*/i, '').replace(/\s/g, '');
  if (!/^(?:\d{10}|\d{12})$/.test(digits)) return null;
  var check = function (weights, position) { return weights.reduce(function (sum, weight, index) { return sum + weight * Number(digits[index]); }, 0) % 11 % 10 === Number(digits[position]); };
  if (/^0+$/.test(digits)) return null;
  return digits.length === 10 ? (check([2, 4, 10, 3, 5, 9, 4, 6, 8], 9) ? digits : null) : (check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 10) && check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 11) ? digits : null);
}

function contactPreviewEmails_(value) {
  var text = String(value || ''), pattern = /(^|[\s,;<>"()[\]:])([A-Z0-9.!#$%&'*+\/=\?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,})(?=$|[\s,;<>"()[\]:.])/gi, values = [], match;
  while ((match = pattern.exec(text))) values.push(match[2].toLowerCase());
  return values;
}

function contactPreviewPhones_(value) {
  var text = String(value || '').replace(/(?:доб\.?|ext\.?)\s*\d+/gi, '');
  var candidates = [];
  text.split(/[\r\n;,|]+/).forEach(function (part) {
    var trimmed = part.trim();
    if (/^(?:[78]\d{10}\s+)+[78]\d{10}$/.test(trimmed)) candidates = candidates.concat(trimmed.split(/\s+/));
    else candidates = candidates.concat(part.match(/\+?\d[\d\s().-]{5,}\d/g) || []);
  });
  return candidates.map(function (raw) {
    var digits = raw.replace(/\D/g, ''), number = '', kind = 'unknown';
    if (digits.length < 8 || digits.length > 15) return null;
    if (raw.charAt(0) === '+') number = '+' + digits;
    else if (/^[78]\d{10}$/.test(digits)) number = '+7' + digits.slice(1);
    else number = digits; // Unknown country: never invent +7 for ten-digit numbers.
    if (/^\+79\d{9}$/.test(number)) kind = 'mobile';
    else if (/^\+7[348]\d{9}$/.test(number)) kind = 'landline';
    return { value: number, kind: kind };
  }).filter(Boolean);
}

function contactPreviewResolveOwners_(rows, fileId) {
  var idInns = Object.create(null), owners = Object.create(null), byRow = [], unresolvedRows = 0, ambiguousIds = false;
  rows.forEach(function (row) {
    if (!row.localId || !row.inn || row.identityAmbiguous) return;
    if (!idInns[row.localId]) idInns[row.localId] = Object.create(null);
    idInns[row.localId][row.inn] = true;
  });
  rows.forEach(function (row) {
    var aliases = row.localId && idInns[row.localId] ? Object.keys(idInns[row.localId]) : [], owner = '';
    if (aliases.length > 1) ambiguousIds = true;
    if (row.identityAmbiguous) ambiguousIds = true;
    else if (row.inn) owner = 'inn:' + row.inn;
    else if (row.localId && aliases.length === 1) owner = 'inn:' + aliases[0];
    else if (row.localId && !aliases.length) owner = 'source:' + fileId + ':' + row.localId;
    if (owner) { if (!owners[owner]) owners[owner] = { key: owner, label: row.name || row.localId || row.inn }; }
    else unresolvedRows++;
    byRow.push(owner);
  });
  return { byRow: byRow, owners: owners, unresolvedRows: unresolvedRows, ambiguousIds: ambiguousIds };
}

function contactPreviewAggregate_(result, rows, fileId, budget) {
  var resolved = contactPreviewResolveOwners_(rows, fileId), owners = resolved.owners, emails = Object.create(null), phones = Object.create(null), count = 0, detailCharacters = 0;
  result.companies.unresolvedRows = resolved.unresolvedRows;
  for (var index = 0; index < rows.length; index++) {
    if (index % 500 === 0 && !contactPreviewTime_(budget)) { budget.partial = true; break; }
    var row = rows[index], owner = resolved.byRow[index];
    var stopped = false;
    var add = function (type, contact, kind) {
      var store = type === 'email' ? emails : phones, counters = type === 'email' ? result.emails : result.phones;
      counters.occurrences++;
      if (!Object.prototype.hasOwnProperty.call(store, contact)) {
        if (count >= CONTACT_PREVIEW_LIMITS.maxContacts) { stopped = true; budget.partial = true; return; }
        store[contact] = { value: contact, kind: kind, owners: Object.create(null), unknown: false, sources: [], sourceKeys: Object.create(null), omittedSources: false }; count++;
      }
      var record = store[contact];
      if (owner) record.owners[owner] = true; else record.unknown = true;
      var sourceKey = row.source.sheetId + ':' + row.source.row;
      if (!record.sourceKeys[sourceKey]) {
        record.sourceKeys[sourceKey] = true;
        if (record.sources.length < CONTACT_PREVIEW_LIMITS.maxSources) record.sources.push(row.source); else record.omittedSources = true;
      }
    };
    row.emails.forEach(function (email) { add('email', email, ''); });
    row.phones.forEach(function (phone) { add('phone', phone.value, phone.kind); });
    if (stopped) break;
  }
  result.companies.unique = Object.keys(owners).length;
  if (resolved.ambiguousIds) contactPreviewWarn_(result, 'Идентификаторы компании неоднозначны: один Company_ID связан с разными ИНН или в строке указано несколько идентификаторов. Такие связи не объединены автоматически.');
  var finish = function (store, counters, type) {
    counters.unique = Object.keys(store).length;
    Object.keys(store).sort().forEach(function (key) {
      var contact = store[key], ownerKeys = Object.keys(contact.owners);
      if (contact.unknown) counters.unresolved++;
      if (type === 'phone') { if (contact.kind === 'mobile') counters.mobiles++; else if (contact.kind === 'landline') counters.landlines++; else counters.unknownType++; }
      if (ownerKeys.length < 2) return;
      counters.multiCompany++; result.conflicts.total++;
      if (result.conflicts.items.length >= CONTACT_PREVIEW_LIMITS.maxConflicts) { result.conflicts.truncated = true; return; }
      if (ownerKeys.length > CONTACT_PREVIEW_LIMITS.maxOwners || contact.omittedSources) result.conflicts.truncated = true;
      var detail = { type: type, value: contact.value, companies: ownerKeys.slice(0, CONTACT_PREVIEW_LIMITS.maxOwners).map(function (ownerKey) { return owners[ownerKey]; }), sources: contact.sources };
      var size = JSON.stringify(detail).length;
      if (detailCharacters + size > CONTACT_PREVIEW_LIMITS.maxDetailCharacters) { result.conflicts.truncated = true; return; }
      result.conflicts.items.push(detail); detailCharacters += size;
    });
  };
  finish(emails, result.emails, 'email'); finish(phones, result.phones, 'phone');
  if (result.conflicts.truncated) contactPreviewWarn_(result, 'Список спорных связей показан частично. Полное число найденных конфликтных контактов указано отдельно.');
  if (budget.partial) contactPreviewWarn_(result, 'Показатели неполные: часть данных не была обработана из-за лимита объёма или времени.');
}

function contactPreviewLabel_(value) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180); }
function contactPreviewHasValue_(value) { return !/^(?:\s*|нет|не найден[оы]?|не указан[оы]?|—|-|n\/a|no|0)$/i.test(String(value || '').trim()); }
function contactPreviewTime_(budget) { return Date.now() - budget.started < CONTACT_PREVIEW_LIMITS.maxMillis; }
function contactPreviewWarn_(result, message) { if (result.warnings.indexOf(message) === -1) result.warnings.push(message); }
