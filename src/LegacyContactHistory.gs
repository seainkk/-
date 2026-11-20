/** Preserve explicit source-side checking and work history during preparation.
 * Pure transformation: no provider requests, storage writes, or invented dates.
 */
var LEGACY_CONTACT_HISTORY = Object.freeze({
  version: 1, reviewStatus: 'Проверить историю контакта',
  emailHeaders: ['Валидация', 'Дата проверки', 'Результат проверки', 'Провайдер', 'Валидатор', 'Статус из источника'],
  phoneHeaders: ['Валидация', 'Дата проверки', 'Результат проверки', 'ID_TG', 'Nickname_TG', 'Active_days_ago', 'Для Telegram', 'Статус из источника']
});

function legacyContactHistoryKey_(value) { return String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, ''); }
function legacyContactHistoryText_(value) { return String(value === null || value === undefined ? '' : value).trim(); }
function legacyContactHistoryEmail_(value) { var text = legacyContactHistoryText_(value).toLowerCase().replace(/^mailto:/, ''); return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(text) && text.length <= 320 ? text : ''; }
function legacyContactHistoryPhone_(value) {
  var text = legacyContactHistoryText_(value); if (!/^\+?[\d ()-]+$/.test(text)) return '';
  var digits = text.replace(/\D/g, ''); if (/^8\d{10}$/.test(digits)) digits = '7' + digits.slice(1);
  return /^[1-9]\d{7,14}$/.test(digits) ? '+' + digits : '';
}
function legacyContactHistoryDays_(value) { var text = legacyContactHistoryText_(value); return /^\d+(?:\.\d+)?$/.test(text) && Number(text) <= 100000 ? Number(text) : null; }
function legacyContactHistoryPick_(row, columns, names) {
  for (var i = 0; i < names.length; i++) {
    var at = columns[legacyContactHistoryKey_(names[i])];
    if (at !== undefined && legacyContactHistoryText_(row[at])) return legacyContactHistoryText_(row[at]);
  }
  return '';
}
function legacyContactHistoryVerdict_(value) {
  var text = legacyContactHistoryText_(value).toLowerCase();
  if (/^(?:valid|deliverable|ok|good|true|yes|да|валиден|валидный|действителен)$/.test(text)) return 'Валиден';
  if (/^(?:invalid|undeliverable|bad|not.?exist|false|no|нет|невалиден|невалидный|не.?существует)$/.test(text)) return 'Невалиден';
  if (/^(?:risky|catch.?all|accept.?all|disposable|рискованный)$/.test(text)) return 'Рискованный';
  if (/^(?:unknown|неизвестно|неизвестен|неизвестный|unverifiable)$/.test(text)) return 'Неизвестно';
  return '';
}
function legacyContactHistoryCompleted_(value) {
  var text = legacyContactHistoryText_(value);
  if (!text || typeof pvPendingStatus_ === 'function' && pvPendingStatus_(text)) return false;
  return !/^(?:not[_ ]?verified|unchecked|pending|new|не\s*проверен[оаы]?|нов[ыао]й?|сбор|подготовка|ожидает\s+проверки|проверяется|нужна\s+оплата|ошибка\s+подключения|проверка\s+не\s+подтверждена|нужен\s+телефон|уточните\s+страну\s+или\s+номер)$/i.test(text);
}
function legacyContactHistoryWork_(value) {
  var text = legacyContactHistoryText_(value), key = text.toLowerCase().replace(/ё/g, 'е');
  if (!text) return '';
  if (/фильтр|нецелев|не\s*совпал|не\s*актуал|не\s*подтвержден|дубль|исключ|невалид|отпис|блокиров|срок\s*>\s*30/.test(key)) return text;
  if (/^(?:рассылка|в\s+рассылке|отправлен[оыа]?|sent|запущен[аоы]?|in\s+campaign|replied|ответил[аи]?|в\s+плане.*)$/.test(key)) return text;
  return '';
}

function legacyContactHistoryColumns_(headers) {
  var result = { columns: Object.create(null), email: [], phone: [], work: [], validation: [], history: false };
  var validationNames = ['Валидация', 'Результат валидации', 'Результат проверки', 'Статус email', 'email_status', 'validation', 'Validation result'].map(legacyContactHistoryKey_);
  var historyNames = validationNames.concat(['Дата проверки', 'checked_at', 'validation_date', 'ID_TG', 'Telegram ID', 'Nickname_TG', 'TG username', 'Telegram username', 'Active_days_ago', 'days_offline', 'Как давно был в сети'].map(legacyContactHistoryKey_));
  headers.forEach(function (header, index) {
    var key = legacyContactHistoryKey_(header); if (!key) return;
    if (result.columns[key] === undefined) result.columns[key] = index;
    var meta = /валидац|validation|статус|status|провер|дата|date|count|колво|количество|провайдер|provider|ник|nickname|idtg|telegramid|active|days|давно|строк|источник/.test(key);
    if (!meta && /email|почт|емейл/.test(key)) result.email.push(index);
    if (!meta && (/телефон|phone|mobile|мобильн|^тел|^доптел|numbertg/.test(key)) && !/телеграм|telegram/.test(key)) result.phone.push(index);
    if (/^(?:статус|status|комментарий|коммент|статусподтверждения|статусизисточника)$/.test(key) || /статусрассылки|статусконтакта/.test(key)) result.work.push(index);
    if (validationNames.indexOf(key) >= 0) result.validation.push(index);
    if (historyNames.indexOf(key) >= 0) result.history = true;
  });
  result.history = result.history || result.work.length > 0;
  return result;
}

/** Owned completion notes identify the old contact, never the row's replacement. */
function legacyContactHistoryBindingAllows_(model, row, kind, contact) {
  var bindings = model.cellValidationBindings && model.cellValidationBindings[row];
  if (!bindings || !bindings.length) return true;
  var key = typeof pvKey_ === 'function' ? pvKey_(kind, contact) : typeof digest_ === 'function' ? digest_('promouser-contact-v1|' + kind + '|' + String(contact).toLowerCase()) : '';
  return !!key && bindings.indexOf(key) >= 0;
}
function legacyContactHistoryChannel_(source, schema) {
  var name = legacyContactHistoryKey_(source.name || source.sheetName || '');
  var email = /email|emails|mail|почт|емейл/.test(name), phone = /telegram|телеграм|nsa|телефон|мобильн|phones|phone/.test(name);
  if (email && !phone) return 'email';
  if (phone && !email) return 'telegram';
  // Wide source records can carry an email verdict and an independent paired
  // Telegram report together. TG metadata alone must not erase email history.
  if (schema.email.length && schema.phone.length) return 'mixed';
  if (['ID_TG', 'Telegram ID', 'Nickname_TG', 'Active_days_ago', 'days_offline'].some(function (header) { return schema.columns[legacyContactHistoryKey_(header)] !== undefined; })) return 'telegram';
  if (schema.email.length && !schema.phone.length) return 'email';
  if (schema.phone.length && !schema.email.length) return 'telegram';
  return 'mixed';
}

/** A verdict is attached only to an unambiguous contact, never to an entire company. */
function legacyContactHistoryCollect_(modelOrModels) {
  var leaves = Array.isArray(modelOrModels) ? modelOrModels : modelOrModels && Array.isArray(modelOrModels.models) ? modelOrModels.models : [modelOrModels];
  var result = Object.create(null);
  leaves.filter(Boolean).forEach(function (model) {
    var source = model.source || {}, headers = source.headers || [], rows = model.sourceDisplayValues || model.sourceValues || [];
    if (source.hasHeader === false || !headers.length || !rows.length) return;
    var schema = legacyContactHistoryColumns_(headers), columns = schema.columns, emailColumns = schema.email, phoneColumns = schema.phone, workColumns = schema.work;
    var first = Number.isSafeInteger(source.headerIndex) ? source.headerIndex + 1 : 1;
    rows.slice(first).forEach(function (row, offset) {
      var absolute = first + offset + 1, emails = [], phones = [];
      emailColumns.forEach(function (column) {
        var parsed = model.cellContacts && model.cellContacts[absolute + ':' + (column + 1)];
        var found = parsed && Array.isArray(parsed.emails) ? parsed.emails : legacyContactHistoryText_(row[column]).match(/[^\s,;<>]+@[^\s,;<>]+\.[^\s,;<>]+/g) || [];
        found.forEach(function (value) { var email = legacyContactHistoryEmail_(value); if (email && emails.indexOf(email) < 0) emails.push(email); });
      });
      phoneColumns.forEach(function (column) {
        var parsed = model.cellContacts && model.cellContacts[absolute + ':' + (column + 1)], found;
        if (parsed && Array.isArray(parsed.phones)) found = parsed.phones.map(function (item) { return typeof item === 'string' ? item : item && item.value; });
        else found = legacyContactHistoryText_(row[column]).split(/[;,\n]+/);
        found.forEach(function (value) { var phone = legacyContactHistoryPhone_(value); if (phone && phones.indexOf(phone) < 0) phones.push(phone); });
      });
      // The prepared parser also recognizes contacts in unnamed cells and
      // social links. Reuse those grounded contacts, rather than guessing IDs.
      row.forEach(function (_, column) {
        var parsed = model.cellContacts && model.cellContacts[absolute + ':' + (column + 1)]; if (!parsed) return;
        (parsed.emails || []).forEach(function (value) { var email = legacyContactHistoryEmail_(value); if (email && emails.indexOf(email) < 0) emails.push(email); });
        (parsed.phones || []).forEach(function (value) { var phone = legacyContactHistoryPhone_(typeof value === 'string' ? value : value && value.value); if (phone && phones.indexOf(phone) < 0) phones.push(phone); });
      });
      var works = workColumns.map(function (column) { return legacyContactHistoryWork_(row[column]); }).filter(Boolean);
      works = works.filter(function (text, index) { return works.indexOf(text) === index; });
      var rawEmail = legacyContactHistoryPick_(row, columns, ['Валидация', 'Результат валидации', 'Результат проверки', 'Статус email', 'email_status', 'validation', 'Validation result']);
      var verdict = legacyContactHistoryVerdict_(rawEmail), canonicalEmailVerdict = verdict, date = legacyContactHistoryPick_(row, columns, ['Дата проверки', 'checked_at', 'validation_date']);
      var completed = model.preserveAmbiguousHistory === true && legacyContactHistoryCompleted_(rawEmail);
      var rawResult = legacyContactHistoryPick_(row, columns, ['Результат проверки', 'Результат валидации', 'Validation result']);
      if (completed && !verdict && !/telegram|телеграм/i.test(rawEmail)) verdict = rawEmail;
      var allowEmailHistory = model.historyChannel !== 'telegram', allowPhoneHistory = model.historyChannel !== 'email';
      var provider = legacyContactHistoryPick_(row, columns, ['Провайдер', 'provider']);
      var evidence = { sheetId: source.sheetId, sheetName: source.name || source.sheetName || '', row: absolute };
      emails.forEach(function (email) {
        if (!allowEmailHistory) return;
        if (!legacyContactHistoryBindingAllows_(model, absolute, 'email', email)) return;
        var validation = emails.length === 1 && verdict ? { status: verdict, raw: rawResult || rawEmail, checkedAt: date, provider: provider } : null;
        if (!validation && emails.length > 1 && verdict && model.preserveAmbiguousHistory === true) validation = { status: LEGACY_CONTACT_HISTORY.reviewStatus, raw: 'Неоднозначная прежняя проверка нескольких email: ' + rawEmail, checkedAt: date, provider: provider };
        if (validation || works.length) legacyContactHistoryAdd_(result, 'email', email, validation, works, evidence);
      });
      var idTg = legacyContactHistoryPick_(row, columns, ['ID_TG', 'Telegram ID']), nickname = legacyContactHistoryPick_(row, columns, ['Nickname_TG', 'TG username', 'Telegram username']);
      var days = legacyContactHistoryDays_(legacyContactHistoryPick_(row, columns, ['Active_days_ago', 'days_offline', 'Как давно был в сети']));
      var hasId = /^[1-9]\d*$/.test(idTg), explicitNo = /^(?:нет|no|false|not\s*found|не\s*найден(?:о)?)$/i.test(idTg);
      var tgIndex = columns[legacyContactHistoryKey_('ID_TG')]; if (tgIndex === undefined) tgIndex = columns[legacyContactHistoryKey_('Telegram ID')];
      // Reports commonly contain personal and company numbers together. The
      // report's adjacent phone is authoritative; additional numbers stay new.
      var paired = '';
      if ((hasId || explicitNo || days !== null) && tgIndex !== undefined && phoneColumns.length) {
        var preceding = phoneColumns.filter(function (column) { return column < tgIndex; });
        var candidates = preceding.length ? preceding.sort(function (a, b) { return b - a; }) : phoneColumns.slice().sort(function (a, b) { return Math.abs(a - tgIndex) - Math.abs(b - tgIndex); });
        paired = legacyContactHistoryPhone_(row[candidates[0]]);
      }
      phones.forEach(function (phone) {
        if (!legacyContactHistoryBindingAllows_(model, absolute, 'telegram', phone)) return;
        var validation = null;
        if (phone === paired && (hasId || explicitNo || days !== null)) {
          var eligible = hasId && days !== null ? days <= 30 : explicitNo ? false : null;
          validation = { status: explicitNo ? 'Telegram не найден' : hasId ? days === null ? 'Telegram: активность скрыта' : eligible ? 'Telegram: активен' : 'Telegram: более 30 дней офлайн' : 'Telegram не подтверждён', checkedAt: date, raw: '', provider: '', idTg: hasId ? idTg : '', nickname: nickname, days: days, eligible: eligible };
        }
        var genericPhoneCompletion = completed && allowPhoneHistory && (!canonicalEmailVerdict || model.historyChannel === 'telegram');
        if (!validation && genericPhoneCompletion && phones.length === 1) validation = { status: rawEmail, checkedAt: date, raw: rawResult || rawEmail, provider: '', idTg: '', nickname: nickname, days: null, eligible: /(?:telegram|телеграм).*(?:не найден|нет)|нет\s+(?:telegram|телеграм)/i.test(rawEmail) ? false : null };
        if (!validation && genericPhoneCompletion && phones.length > 1 && model.preserveAmbiguousHistory === true) validation = { status: LEGACY_CONTACT_HISTORY.reviewStatus, checkedAt: date, raw: rawResult || rawEmail, provider: '', idTg: '', nickname: '', days: null, eligible: null };
        if (!validation && !paired && phones.length > 1 && (hasId || explicitNo || days !== null) && model.preserveAmbiguousHistory === true) validation = { status: LEGACY_CONTACT_HISTORY.reviewStatus, raw: 'Неоднозначная прежняя проверка нескольких телефонов.', checkedAt: date, provider: '', idTg: '', nickname: '', days: null, eligible: null };
        var phoneWorks = allowPhoneHistory ? works : [];
        if (validation || phoneWorks.length) legacyContactHistoryAdd_(result, 'telegram', phone, validation, phoneWorks, evidence);
      });
    });
  });
  return result;
}

function legacyContactHistoryAdd_(map, kind, contact, validation, work, source) {
  var key = kind + ':' + contact, entry = map[key];
  if (!entry) entry = map[key] = { kind: kind, contact: contact, validation: null, work: [], evidence: [], conflict: false };
  if (validation) {
    if (!entry.validation) entry.validation = validation;
    else {
      var before = entry.validation;
      if (before.status !== validation.status || String(before.idTg || '') !== String(validation.idTg || '')) entry.conflict = true;
      if (before.days !== null && before.days !== undefined && validation.days !== null && validation.days !== undefined) before.days = Math.max(before.days, validation.days);
      if (!before.provider && validation.provider) before.provider = validation.provider;
      if (before.raw !== validation.raw && validation.raw) before.raw = [before.raw, validation.raw].filter(Boolean).join('; ');
    }
  }
  work.forEach(function (status) { if (entry.work.indexOf(status) < 0) entry.work.push(status); });
  if (entry.evidence.length < 8) entry.evidence.push(source);
}

/** Finished row status blocks new paid checks, including ambiguous old reports. */
function legacyContactHistoryFields_(entry) {
  var validation = entry.validation || {}, review = entry.conflict || entry.work.length > 0;
  var raw = 'legacy-history:v1:' + JSON.stringify({ validation: validation.raw || validation.status || '', work: entry.work, conflict: entry.conflict, source: entry.evidence });
  var fields = { 'Валидация': review ? LEGACY_CONTACT_HISTORY.reviewStatus : validation.status,
    'Дата проверки': validation.checkedAt || '', 'Результат проверки': raw, 'Статус из источника': entry.work.join('; ') };
  if (entry.kind === 'email') { fields['Провайдер'] = validation.provider || ''; fields['Валидатор'] = 'источник'; }
  else {
    fields.ID_TG = validation.idTg || ''; fields.Nickname_TG = validation.nickname || '';
    fields.Active_days_ago = validation.days === null || validation.days === undefined ? '' : String(validation.days);
    fields['Для Telegram'] = review ? 'Нужна проверка' : validation.eligible === true ? 'Да' : validation.eligible === false ? 'Нет' : 'Нужна проверка';
  }
  return fields;
}

/** Called on the full stable workbook model before the immutable import plan. */
function legacyContactHistoryEnrich_(model, historyMap) {
  if (!model || !model.email || !model.phone) return model;
  var history = historyMap || legacyContactHistoryCollect_(model), enriched = 0;
  [{ kind: 'email', list: model.email, wanted: LEGACY_CONTACT_HISTORY.emailHeaders }, { kind: 'telegram', list: model.phone, wanted: LEGACY_CONTACT_HISTORY.phoneHeaders }].forEach(function (entry) {
    var originalHeaders = entry.list.headers.slice(), keyColumn = originalHeaders.map(legacyContactHistoryKey_).indexOf(entry.kind === 'email' ? 'email' : 'телефон');
    if (keyColumn < 0) return;
    var matched = entry.list.rows.some(function (row) { var contact = entry.kind === 'email' ? legacyContactHistoryEmail_(row[keyColumn]) : legacyContactHistoryPhone_(row[keyColumn]); return !!history[entry.kind + ':' + contact]; });
    if (!matched) return;
    var headers = originalHeaders.slice();
    entry.wanted.forEach(function (header) { if (headers.map(legacyContactHistoryKey_).indexOf(legacyContactHistoryKey_(header)) < 0) headers.push(header); });
    var map = Object.create(null); headers.forEach(function (header, index) { map[legacyContactHistoryKey_(header)] = index; });
    entry.list.rows = entry.list.rows.map(function (original) {
      var row = original.slice(); while (row.length < headers.length) row.push('');
      var contact = entry.kind === 'email' ? legacyContactHistoryEmail_(row[keyColumn]) : legacyContactHistoryPhone_(row[keyColumn]), old = history[entry.kind + ':' + contact];
      if (!old) return row;
      var status = legacyContactHistoryText_(row[map[legacyContactHistoryKey_('Валидация')]]);
      // Existing completion belongs to the target row and is never rewritten.
      if (status && !(typeof pvPendingStatus_ === 'function' && pvPendingStatus_(status))) return row;
      var fields = legacyContactHistoryFields_(old);
      Object.keys(fields).forEach(function (header) { var index = map[legacyContactHistoryKey_(header)]; if (index !== undefined) row[index] = fields[header]; });
      enriched++; return row;
    });
    entry.list.headers = headers; entry.list.sample = entry.list.rows.slice(0, 8);
    if (entry.kind === 'email') { model.emailHeaders = headers; model.emailRows = entry.list.rows; }
    else { model.phoneHeaders = headers; model.phoneRows = entry.list.rows; }
  });
  if (enriched) {
    model.legacyHistory = { contacts: enriched };
    var warning = 'Сохранена история проверки и работы контактов из исходных листов. Ранее проверенные и исключённые контакты не будут проверяться повторно; спорная история требует ручной проверки.';
    model.warnings = model.warnings || []; if (model.warnings.indexOf(warning) < 0) model.warnings.push(warning);
  }
  return model;
}

/**
 * Read history from all original input leaves without turning archive/report
 * contacts into new source records. Selected normalized models are reused.
 * The caller owns full before/after staging ancestry and Drive-version checks.
 */
function legacyContactHistoryReadWorkbook_(book, fileId, section, guard, selectedModels, options) {
  options = typeof options === 'number' ? { deadline: options } : options || {};
  if (typeof guard !== 'function' || !Array.isArray(selectedModels)) return legacyContactHistoryReadFail_('Для истории нужна проверка области доступа.');
  var started = Date.now(), deadline = Number.isFinite(options.deadline) ? Math.min(options.deadline, started + 120000) : started + 120000;
  var limits = typeof PREPARED_DATA_LIMITS === 'object' ? PREPARED_DATA_LIMITS : { maxRows: 50000, maxColumns: 100, maxCells: 1000000, chunkCells: 100000 };
  var cellsRead = 0, rowsRead = 0, signatures = [], leaves = [], warnings = [], selected = Object.create(null);
  function check() { guard(); if (Date.now() >= deadline) legacyContactHistoryReadFail_('Не удалось полностью прочитать прежние проверки за отведённое время. Частичный импорт отключён.'); }
  function reserve(height, width, physical) {
    cellsRead += height * width; if (physical) rowsRead += height;
    if (cellsRead > limits.maxCells || rowsRead > limits.maxRows) legacyContactHistoryReadFail_('История проверок превышает лимит полного чтения. Частичный импорт отключён.');
  }
  function display(sheet, first, height, width) {
    check(); reserve(height, width, true);
    var values = sheet.getRange(first, 1, height, width).getDisplayValues(); check();
    if (!legacyContactHistoryRectangle_(values, height, width)) legacyContactHistoryReadFail_('Google вернул неполную историю проверок.');
    return values.map(function (row) { return row.map(function (value) { return String(value === null || value === undefined ? '' : value); }); });
  }
  check();
  if (!book || typeof book.getId !== 'function' || book.getId() !== fileId) legacyContactHistoryReadFail_('История относится к другой исходной книге.');
  var sheets = book.getSheets();
  if (!Array.isArray(sheets) || sheets.length > 100) legacyContactHistoryReadFail_('Слишком много исходных листов для полного чтения истории.');
  var allowed = options.sourceSheetIds;
  if (allowed !== undefined && (!Array.isArray(allowed) || allowed.some(function (id, index) { return !Number.isSafeInteger(id) || id < 0 || allowed.indexOf(id) !== index; }))) legacyContactHistoryReadFail_('Некорректный список исходных листов истории.');
  var byId = Object.create(null);
  sheets.forEach(function (sheet) { var id = sheet.getSheetId(); if (!Number.isSafeInteger(id) || id < 0 || byId[id]) legacyContactHistoryReadFail_('Не удалось однозначно определить исходные листы истории.'); byId[id] = sheet; });
  if (allowed && allowed.some(function (id) { return !byId[id]; })) legacyContactHistoryReadFail_('Один из исходных листов истории недоступен.');
  selectedModels.forEach(function (model) {
    var id = model && model.source && model.source.sheetId;
    if (!Number.isSafeInteger(id) || !byId[id] || selected[id] || allowed && allowed.indexOf(id) < 0) legacyContactHistoryReadFail_('Выбранная база не соответствует исходной книге истории.');
    selected[id] = model;
  });
  sheets.forEach(function (sheet) {
    check(); var id = sheet.getSheetId(); if (allowed && allowed.indexOf(id) < 0) return;
    var height = sheet.getLastRow(), width = sheet.getLastColumn(), name = sheet.getName();
    if (!Number.isSafeInteger(height) || !Number.isSafeInteger(width) || height < 0 || width < 0 || width > limits.maxColumns) legacyContactHistoryReadFail_('Размер исходного листа истории превышает лимит.');
    if (!height || !width) { signatures.push([id, name, height, width, 'empty']); return; }
    var cached = selected[id], values, source, schema;
    if (cached) {
      values = cached.sourceDisplayValues || cached.sourceValues || [];
      if (!legacyContactHistoryRectangle_(values, height, width)) legacyContactHistoryReadFail_('Выбранный исходный лист изменился во время чтения истории.');
      reserve(height, width, true); source = Object.assign({}, cached.source); schema = legacyContactHistoryColumns_(source.headers || []);
    } else {
      var probe = display(sheet, 1, Math.min(10, height), width), header = legacyContactHistoryReadHeader_(probe, section);
      source = { sheetId: id, name: name, headers: header.header, hasHeader: header.hasHeader, headerIndex: header.index, rowCount: height, columnCount: width };
      schema = legacyContactHistoryColumns_(source.headers);
      if (!source.hasHeader || !schema.history || !schema.email.length && !schema.phone.length) { signatures.push([id, name, height, width, 'no_contact_history', probe]); return; }
      values = probe.slice();
      var chunk = Math.max(1, Math.floor(limits.chunkCells / width));
      for (var first = probe.length + 1; first <= height; first += chunk) values = values.concat(display(sheet, first, Math.min(chunk, height - first + 1), width));
    }
    if (source.hasHeader === false || !schema.history || !cached && !schema.email.length && !schema.phone.length) { signatures.push([id, name, height, width, 'selected_no_contact_history', cached && cached.fingerprint || '']); return; }
    var bindings = Object.create(null), firstData = Number.isSafeInteger(source.headerIndex) ? source.headerIndex + 2 : 2;
    schema.validation.forEach(function (column) {
      var chunk = Math.max(1, Math.floor(limits.chunkCells));
      for (var first = firstData; first <= height; first += chunk) {
        check(); var count = Math.min(chunk, height - first + 1); reserve(count, 1, false);
        var range = sheet.getRange(first, column + 1, count, 1);
        if (typeof range.getNotes !== 'function') legacyContactHistoryReadFail_('Не удалось проверить привязку прежних результатов к контактам.');
        var notes = range.getNotes(); check();
        if (!legacyContactHistoryRectangle_(notes, count, 1)) legacyContactHistoryReadFail_('Google вернул неполные отметки прежних проверок.');
        notes.forEach(function (row, index) {
          var note = String(row[0] || ''), binding = typeof pvBinding_ === 'function' ? pvBinding_(note) : legacyContactHistoryReadBinding_(note);
          if (binding) { var at = first + index; if (!bindings[at]) bindings[at] = []; if (bindings[at].indexOf(binding) < 0) bindings[at].push(binding); }
        });
      }
    });
    var leaf = { source: source, sourceDisplayValues: values, cellContacts: cached && cached.cellContacts || null, cellValidationBindings: bindings, preserveAmbiguousHistory: true, historyChannel: legacyContactHistoryChannel_(source, schema) };
    legacyContactHistoryReadValidate_(leaf, schema);
    leaves.push(leaf);
    signatures.push([id, name, height, width, source.headerIndex, source.headers, values, bindings]);
  });
  check(); var history = legacyContactHistoryCollect_(leaves); check();
  return { history: history, fingerprint: digest_(JSON.stringify({ version: 1, fileId: fileId, leaves: signatures })), warnings: warnings, complete: true, cellsRead: cellsRead };
}

function legacyContactHistoryReadHeader_(rows, section) {
  if (typeof preparedDataHeader_ === 'function') return preparedDataHeader_(rows, rows, [], section);
  var best = -1, score = 0;
  rows.forEach(function (row, index) {
    var schema = legacyContactHistoryColumns_(row), current = schema.email.length + schema.phone.length + schema.work.length + schema.validation.length;
    if (current > score && !row.some(function (value) { return !!legacyContactHistoryEmail_(value) || !!legacyContactHistoryPhone_(value); })) { best = index; score = current; }
  });
  return { hasHeader: best >= 0, index: best, header: best >= 0 ? rows[best].slice() : [] };
}
function legacyContactHistoryReadBinding_(note) { var match = String(note || '').match(/(?:^|\n)registry-promouser-contact:v1:([A-Za-z0-9_-]{43})(?=\n|$)/); return match ? match[1] : ''; }
function legacyContactHistoryRectangle_(values, height, width) { return Array.isArray(values) && values.length === height && values.every(function (row) { return Array.isArray(row) && row.length === width; }); }
function legacyContactHistoryReadFail_(message) { if (typeof fail_ === 'function') fail_('LEGACY_HISTORY_PARTIAL', message); var error = new Error('[LEGACY_HISTORY_PARTIAL] ' + message); error.registryCode = 'LEGACY_HISTORY_PARTIAL'; throw error; }

/** Unreadable old completion identities must never silently become new paid work. */
function legacyContactHistoryReadValidate_(model, schema) {
  var first = Number.isSafeInteger(model.source.headerIndex) ? model.source.headerIndex + 1 : 1;
  model.sourceDisplayValues.slice(first).forEach(function (row, offset) {
    var number = first + offset + 1, work = schema.work.some(function (column) { return !!legacyContactHistoryWork_(row[column]); });
    var rawValidation = legacyContactHistoryPick_(row, schema.columns, ['Валидация', 'Результат валидации', 'Результат проверки', 'Статус email', 'email_status', 'validation', 'Validation result']);
    var verdict = legacyContactHistoryCompleted_(rawValidation);
    var id = legacyContactHistoryPick_(row, schema.columns, ['ID_TG', 'Telegram ID']), days = legacyContactHistoryDays_(legacyContactHistoryPick_(row, schema.columns, ['Active_days_ago', 'days_offline', 'Как давно был в сети']));
    var telegram = /^[1-9]\d*$/.test(id) || /^(?:нет|no|false|not\s*found|не\s*найден(?:о)?)$/i.test(id) || days !== null;
    function meaningful(value) { return !/^(?:\s*|нет|не найден[оы]?|не указан[оы]?|—|-|n\/a|no|0)$/i.test(String(value || '').trim()); }
    if (model.historyChannel !== 'telegram' && (work || verdict)) schema.email.forEach(function (column) {
      if (!meaningful(row[column])) return;
      var parsed = model.cellContacts && model.cellContacts[number + ':' + (column + 1)], emails = parsed && parsed.emails || (String(row[column]).match(/[^\s,;<>]+@[^\s,;<>]+\.[^\s,;<>]+/g) || []).map(legacyContactHistoryEmail_).filter(Boolean);
      if (!emails.length) legacyContactHistoryReadFail_('В прежней проверке email не удалось прочитать сам контакт. Нужна ручная проверка исходного отчёта.');
    });
    var canonicalEmailVerdict = legacyContactHistoryVerdict_(rawValidation);
    if (telegram || model.historyChannel !== 'email' && (work || verdict && (!canonicalEmailVerdict || model.historyChannel === 'telegram'))) schema.phone.forEach(function (column) {
      if (!meaningful(row[column])) return;
      var parsed = model.cellContacts && model.cellContacts[number + ':' + (column + 1)], phones = parsed && parsed.phones || String(row[column]).split(/[;,\n]+/).map(legacyContactHistoryPhone_).filter(Boolean);
      if (!phones.length) legacyContactHistoryReadFail_('В прежней проверке Telegram не удалось прочитать номер телефона. Нужна ручная проверка исходного отчёта.');
    });
  });
}
