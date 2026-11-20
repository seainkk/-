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
function legacyContactHistoryWork_(value) {
  var text = legacyContactHistoryText_(value), key = text.toLowerCase().replace(/ё/g, 'е');
  if (!text) return '';
  if (/фильтр|нецелев|не\s*совпал|не\s*актуал|не\s*подтвержден|дубль|исключ|невалид|отпис|блокиров|срок\s*>\s*30/.test(key)) return text;
  if (/^(?:рассылка|в\s+рассылке|отправлен[оыа]?|sent|запущен[аоы]?|in\s+campaign|replied|ответил[аи]?|в\s+плане.*)$/.test(key)) return text;
  return '';
}

/** A verdict is attached only to an unambiguous contact, never to an entire company. */
function legacyContactHistoryCollect_(modelOrModels) {
  var leaves = Array.isArray(modelOrModels) ? modelOrModels : modelOrModels && Array.isArray(modelOrModels.models) ? modelOrModels.models : [modelOrModels];
  var result = Object.create(null);
  leaves.filter(Boolean).forEach(function (model) {
    var source = model.source || {}, headers = source.headers || [], rows = model.sourceDisplayValues || model.sourceValues || [];
    if (source.hasHeader === false || !headers.length || !rows.length) return;
    var columns = Object.create(null), emailColumns = [], phoneColumns = [], workColumns = [];
    headers.forEach(function (header, index) {
      var key = legacyContactHistoryKey_(header); if (!key) return;
      if (columns[key] === undefined) columns[key] = index;
      var meta = /валидац|validation|статус|status|провер|дата|date|count|колво|количество|провайдер|provider|ник|nickname|idtg|telegramid|active|days|давно|строк|источник/.test(key);
      if (!meta && /email|почт|емейл/.test(key)) emailColumns.push(index);
      if (!meta && (/телефон|phone|mobile|мобильн|^тел|^доптел|numbertg/.test(key)) && !/телеграм|telegram/.test(key)) phoneColumns.push(index);
      if (/^(?:статус|status|комментарий|коммент|статусподтверждения)$/.test(key) || /статусрассылки|статусконтакта/.test(key)) workColumns.push(index);
    });
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
      var verdict = legacyContactHistoryVerdict_(rawEmail), date = legacyContactHistoryPick_(row, columns, ['Дата проверки', 'checked_at', 'validation_date']);
      var provider = legacyContactHistoryPick_(row, columns, ['Провайдер', 'provider']);
      var evidence = { sheetId: source.sheetId, sheetName: source.name || source.sheetName || '', row: absolute };
      emails.forEach(function (email) {
        var validation = emails.length === 1 && verdict ? { status: verdict, raw: rawEmail, checkedAt: date, provider: provider } : null;
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
        var validation = null;
        if (phone === paired && (hasId || explicitNo || days !== null)) {
          var eligible = hasId && days !== null ? days <= 30 : explicitNo ? false : null;
          validation = { status: explicitNo ? 'Telegram не найден' : hasId ? days === null ? 'Telegram: активность скрыта' : eligible ? 'Telegram: активен' : 'Telegram: более 30 дней офлайн' : 'Telegram не подтверждён', checkedAt: date, raw: '', provider: '', idTg: hasId ? idTg : '', nickname: nickname, days: days, eligible: eligible };
        }
        if (validation || works.length) legacyContactHistoryAdd_(result, 'telegram', phone, validation, works, evidence);
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
function legacyContactHistoryEnrich_(model) {
  if (!model || !model.email || !model.phone) return model;
  var history = legacyContactHistoryCollect_(model), enriched = 0;
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
