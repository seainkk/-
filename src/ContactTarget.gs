/** Read-only comparison against one explicitly configured, in-registry Center. */
var CONTACT_TARGET_LIMITS = Object.freeze({ maxRows: 50000, maxCells: 1000000, chunkCells: 25000, maxMillis: 20000 });
var CONTACT_TARGET_HEADERS = Object.freeze({
  base: ['ID компании', 'Компания', 'ИНН', 'Сайт', 'Сегмент', 'Источник', 'Дата загрузки', 'Email — все адреса', 'Telegram — все контакты', 'Комментарий', 'Контроль обработки', 'Дубль', 'Оригинал дубля', 'Телефоны', 'Telegram ID', 'Email — рассылка', 'Telegram — рассылка'],
  email: ['ID контакта', 'ID компании', 'Компания', 'Email', 'Источник', 'Дата загрузки', 'Статус', 'Валидация', 'Кампания', 'Дата запуска', 'Комментарий', 'Дубль', 'Оригинал', 'Контроль контакта'],
  telegram: ['ID контакта', 'ID компании', 'Компания', 'Telegram username', 'Телефон', 'Telegram ID', 'Тип контакта', 'Статус', 'Комментарий', 'Источник', 'Дата загрузки', 'Дата проверки', 'Telegram Premium', 'Последний вход', 'Дней с последней активности', 'Заказ Promouser', 'Тип Telegram']
});

function contactPreviewCompareTarget_(context, result, sourceRows, sourceId) {
  var current = authorize_();
  var originalConflicts = { items: result.conflicts.items, truncated: result.conflicts.truncated };
  contactTargetUnknown_(result);
  if (current.rootId !== context.rootId) fail_('SOURCE_CHANGED', 'Корневая папка изменилась. Повторите анализ.');
  // An unknown owner does not make a complete scan partial. Truncated reads do.
  if (result.scanComplete === false || result.state === 'mapping_required' || (result.state === 'partial' && result.scanComplete !== true)) {
    result.target.message = 'Исходная база прочитана не полностью. Сравнение с Центром пока недоступно.';
    return result;
  }
  try {
    var binding = contactTargetFile_(current, sourceId), budget = { started: Date.now(), rows: 0, cells: 0 };
    var book = SpreadsheetApp.openById(binding.file.getId());
    var sheets = { base: book.getSheetByName('База'), email: book.getSheetByName('Email'), telegram: book.getSheetByName('Telegram') };
    if (!sheets.base || !sheets.email || !sheets.telegram) contactTargetFail_('В Центре должны быть листы «База», «Email» и «Telegram».');
    var targetRows = {};
    ['base', 'email', 'telegram'].forEach(function (kind) {
      targetRows[kind] = contactTargetReadRows_(current, sourceId, binding.id, sheets[kind], kind, budget);
    });
    contactTargetFile_(current, sourceId, binding.id);
    var target = contactTargetIndex_(targetRows, sheets, binding.id);
    var incoming = contactTargetSourceIndex_(sourceRows, sourceId);
    contactTargetApply_(result, incoming, target, binding.id);
    result.target = { state: 'ready', id: binding.id, name: binding.name, url: spreadsheetUrl_(binding.id) };
    return result;
  } catch (error) {
    if (error && ['LINK_ACCESS_REQUIRED', 'LINK_SETUP_REQUIRED', 'SOURCE_CHANGED'].indexOf(error.registryCode) !== -1) throw error;
    contactTargetUnknown_(result); result.conflicts.items = originalConflicts.items; result.conflicts.truncated = originalConflicts.truncated;
    result.target.message = error && error.contactTargetMessage ? error.contactTargetMessage : 'Не удалось полностью проверить Центр баз. Число новых контактов пока неизвестно.';
    contactPreviewWarn_(result, result.target.message);
    return result;
  }
}

function contactTargetUnknown_(result) {
  result.target = { state: 'unavailable', message: 'Центр баз пока не подключён или недоступен.' };
  ['emails', 'phones'].forEach(function (kind) {
    ['existingInTarget', 'newUnique', 'newUnambiguous', 'multiCompanyCombined', 'unresolvedCombined', 'targetConflicts'].forEach(function (key) { result[kind][key] = null; });
  });
  result.companies.existingInTarget = null; result.companies.newUnique = null;
  result.conflicts.totalCombined = null;
}

function contactTargetFail_(message) { var error = new Error(message); error.contactTargetMessage = message; throw error; }

function contactTargetFile_(context, sourceId, expectedId) {
  var current = authorize_();
  if (current.rootId !== context.rootId) fail_('SOURCE_CHANGED', 'Корневая папка изменилась. Повторите анализ.');
  var id = current.properties.getProperty('CONTACT_CENTER_ID') || REGISTRY_CONFIG.defaultContactCenterId;
  var folderId = current.properties.getProperty('CONTACT_CENTER_FOLDER_ID') || REGISTRY_CONFIG.defaultContactCenterFolderId;
  if (!id || !folderId) contactTargetFail_('Центр баз пока не подключён.');
  id = id_(id); folderId = id_(folderId);
  if (expectedId && id !== expectedId) contactTargetFail_('Центр баз изменился во время чтения. Повторите анализ.');
  var serviceId = current.properties.getProperty('SOURCE_BASES_STORAGE_ID') || REGISTRY_CONFIG.defaultSourceBasesStorageId;
  if (id === sourceId || id === serviceId || id === REGISTRY_CONFIG.defaultSourceBasesStorageId) contactTargetFail_('Исходная и служебная таблицы не могут быть Центром назначения.');
  var folder = registryFolder_(current, folderId);
  if (folder.getId() === current.rootId) contactTargetFail_('Для Центра должна быть указана отдельная папка сегмента.');
  var source = sourceBasesSource_(current);
  if (source.state !== 'ready') contactTargetFail_('Невозможно проверить расположение Центра относительно исходных баз.');
  var file = registryFile_(current, id);
  if (!insideRegistry_(file, folder.getId()) || insideRegistry_(file, source.folder.getId())) contactTargetFail_('Центр должен находиться в своей папке сегмента, отдельно от исходных баз.');
  return { id: id, file: file, name: file.getName() };
}

function contactTargetReadRows_(context, sourceId, targetId, sheet, kind, budget) {
  if (Date.now() - budget.started >= CONTACT_TARGET_LIMITS.maxMillis) contactTargetFail_('Достигнут лимит времени сравнения. Число новых контактов пока неизвестно.');
  var headers = CONTACT_TARGET_HEADERS[kind], lastRow = sheet.getLastRow(), width = sheet.getLastColumn();
  if (width !== headers.length || lastRow < 1) contactTargetFail_('Структура листа Центра отличается от ожидаемой. Нужна проверка заголовков.');
  if (lastRow - 1 + budget.rows > CONTACT_TARGET_LIMITS.maxRows || lastRow * width + budget.cells > CONTACT_TARGET_LIMITS.maxCells) contactTargetFail_('Центр превышает лимит сравнения. Число новых контактов пока неизвестно.');
  var headRange = sheet.getRange(1, 1, 1, width), head = headRange.getDisplayValues()[0], headFormulas = headRange.getFormulas()[0];
  budget.cells += width;
  if (headers.some(function (label, index) { return head[index] !== label || !!headFormulas[index]; })) contactTargetFail_('Заголовки листа Центра изменены. Сравнение остановлено.');
  var rows = [], chunk = Math.max(1, Math.floor(CONTACT_TARGET_LIMITS.chunkCells / width));
  var critical = kind === 'base' ? [0, 1, 2] : kind === 'email' ? [0, 1, 3] : [0, 1, 3, 4, 5];
  for (var row = 2; row <= lastRow; row += chunk) {
    if (Date.now() - budget.started >= CONTACT_TARGET_LIMITS.maxMillis) contactTargetFail_('Достигнут лимит времени сравнения. Число новых контактов пока неизвестно.');
    contactTargetFile_(context, sourceId, targetId);
    var count = Math.min(chunk, lastRow - row + 1), range = sheet.getRange(row, 1, count, width);
    var values = range.getDisplayValues(), formulas = range.getFormulas();
    if (values.length !== count || formulas.length !== count || values.some(function (value) { return value.length !== width; }) || formulas.some(function (value) { return value.length !== width; })) contactTargetFail_('Центр прочитан не полностью. Число новых контактов пока неизвестно.');
    budget.rows += count; budget.cells += count * width;
    values.forEach(function (value, offset) {
      if (critical.some(function (column) { return !!formulas[offset][column]; })) contactTargetFail_('В идентификаторах или контактах Центра обнаружены формулы. Нужна ручная проверка.');
      if (value.every(function (cell) { return String(cell || '').trim() === ''; })) return;
      rows.push({ values: value, row: row + offset });
    });
  }
  return rows;
}

function contactTargetIndex_(rows, sheets, targetId) {
  var target = { companies: Object.create(null), owners: Object.create(null), emails: Object.create(null), phones: Object.create(null), opaqueCompanies: 0 };
  rows.base.forEach(function (row) {
    var data = row.values, id = contactTargetId_(data[0]);
    if (!id || target.companies[id]) contactTargetFail_('В Центре отсутствует или повторяется ID компании. Нужна ручная проверка.');
    var rawInn = String(data[2] || '').trim(), inn = contactPreviewInn_(rawInn), owner;
    if (rawInn && !inn) contactTargetFail_('В Центре есть некорректный ИНН. Однозначное сравнение компаний недоступно.');
    if (inn) owner = 'inn:' + inn;
    else if (/^source:[A-Za-z0-9_-]{10,200}:.+$/.test(id)) owner = id;
    else { owner = 'target:' + targetId + ':' + id; target.opaqueCompanies++; }
    target.companies[id] = owner;
    target.owners[owner] = { key: owner, label: contactPreviewLabel_(data[1] || id) };
  });
  var ids = { emails: Object.create(null), phones: Object.create(null) };
  var add = function (kind, value, data, row, sheet) {
    var id = contactTargetId_(data[0]);
    if (!id) contactTargetFail_('В Центре найден контакт без ID. Нужна ручная проверка.');
    if (ids[kind][id] && ids[kind][id] !== value) contactTargetFail_('Один ID контакта Центра связан с разными значениями.');
    ids[kind][id] = value;
    var owner = target.companies[String(data[1] || '').trim()] || '';
    if (!target[kind][value]) target[kind][value] = { value: value, owners: Object.create(null), unknown: false, sources: [], omittedSources: false };
    var record = target[kind][value]; if (owner) record.owners[owner] = true; else record.unknown = true;
    if (record.sources.length < CONTACT_PREVIEW_LIMITS.maxSources) record.sources.push({ fileId: targetId, sheetId: sheet.getSheetId(), sheetName: sheet.getName(), row: row }); else record.omittedSources = true;
  };
  rows.email.forEach(function (row) {
    var data = row.values, raw = String(data[3] || '').trim(), emails = contactPreviewEmails_(raw);
    if (emails.length !== 1 || emails[0] !== raw.toLowerCase()) contactTargetFail_('В строке Email Центра должна быть одна корректная почта.');
    add('emails', emails[0], data, row.row, sheets.email);
  });
  rows.telegram.forEach(function (row) {
    var data = row.values, raw = String(data[4] || '').trim();
    if (!raw) {
      if (!String(data[3] || '').trim() && !String(data[5] || '').trim()) contactTargetFail_('В строке Telegram Центра отсутствует контакт.');
      var id = contactTargetId_(data[0]);
      if (!id) contactTargetFail_('В Центре найден Telegram-контакт без ID.');
      var value = 'tg:' + String(data[5] || '').trim() + '|username:' + String(data[3] || '').trim();
      if (ids.phones[id] && ids.phones[id] !== value) contactTargetFail_('Один ID Telegram-контакта Центра связан с разными значениями.');
      ids.phones[id] = value;
      return; // Usernames without phones cannot match an incoming phone by guessing.
    }
    var phones = contactPreviewPhones_(raw);
    if (phones.length !== 1) contactTargetFail_('В строке Telegram Центра должен быть один распознаваемый телефон.');
    add('phones', phones[0].value, data, row.row, sheets.telegram);
  });
  return target;
}

function contactTargetId_(value) { var text = String(value || '').trim(); return text && text.length <= 500 && !/[\r\n\u0000]/.test(text) ? text : ''; }

function contactTargetSourceIndex_(rows, fileId) {
  var resolved = contactPreviewResolveOwners_(rows, fileId), source = { owners: resolved.owners, emails: Object.create(null), phones: Object.create(null) };
  rows.forEach(function (row, index) {
    var add = function (kind, value) {
      if (!source[kind][value]) source[kind][value] = { value: value, owners: Object.create(null), unknown: false, sources: [], sourceKeys: Object.create(null), omittedSources: false };
      var record = source[kind][value], owner = resolved.byRow[index];
      if (owner) record.owners[owner] = true; else record.unknown = true;
      var sourceKey = row.source.sheetId + '|' + row.source.row;
      if (!record.sourceKeys[sourceKey]) {
        record.sourceKeys[sourceKey] = true;
        if (record.sources.length < CONTACT_PREVIEW_LIMITS.maxSources) record.sources.push({ fileId: fileId, sheetId: row.source.sheetId, sheetName: row.source.sheetName, row: row.source.row }); else record.omittedSources = true;
      }
    };
    row.emails.forEach(function (email) { add('emails', email); });
    row.phones.forEach(function (phone) { add('phones', phone.value); });
  });
  return source;
}

function contactTargetApply_(result, incoming, target, targetId) {
  var targetOwnerKeys = Object.keys(target.owners), incomingOwnerKeys = Object.keys(incoming.owners), knownTarget = Object.create(null);
  targetOwnerKeys.forEach(function (key) { knownTarget[key] = true; });
  result.companies.existingInTarget = incomingOwnerKeys.filter(function (key) { return !!knownTarget[key]; }).length;
  result.companies.newUnique = target.opaqueCompanies || result.companies.unresolvedRows ? null : incomingOwnerKeys.filter(function (key) { return !knownTarget[key]; }).length;
  if (target.opaqueCompanies) contactPreviewWarn_(result, 'У части компаний Центра нет ИНН или связи с исходным ID. Число новых компаний пока неизвестно.');
  if (result.companies.unresolvedRows) contactPreviewWarn_(result, 'Идентификаторы части исходных компаний не определены. Полное число новых компаний пока неизвестно.');
  var combinedItems = [], combinedTotal = 0, detailCharacters = 0;
  ['emails', 'phones'].forEach(function (kind) {
    var counters = result[kind]; counters.existingInTarget = 0; counters.newUnique = 0; counters.newUnambiguous = 0; counters.multiCompanyCombined = 0; counters.unresolvedCombined = 0; counters.targetConflicts = 0;
    Object.keys(incoming[kind]).sort().forEach(function (value) {
      var contact = incoming[kind][value], old = target[kind][value], owners = Object.create(null), unknown = contact.unknown || !!(old && old.unknown);
      Object.keys(contact.owners).forEach(function (key) { owners[key] = incoming.owners[key]; });
      if (old) { counters.existingInTarget++; Object.keys(old.owners).forEach(function (key) { owners[key] = target.owners[key]; }); } else counters.newUnique++;
      var ownerKeys = Object.keys(owners), multiple = ownerKeys.length > 1;
      if (!old && ownerKeys.length === 1 && !unknown) counters.newUnambiguous++;
      if (multiple) counters.multiCompanyCombined++;
      if (unknown) counters.unresolvedCombined++;
      if (!multiple && !unknown) return;
      if (old) counters.targetConflicts++;
      combinedTotal++;
      if (combinedItems.length >= CONTACT_PREVIEW_LIMITS.maxConflicts) return;
      // Preserve a clickable target location even when incoming provenance
      // already fills the per-contact display limit.
      var sources = old ? contact.sources.slice(0, 1).concat(old.sources, contact.sources.slice(1)) : contact.sources.slice(), seen = Object.create(null);
      sources = sources.filter(function (item) { var key = item.fileId + '|' + item.sheetId + '|' + item.row; if (seen[key]) return false; seen[key] = true; return true; });
      var item = { type: kind === 'emails' ? 'email' : 'phone', value: value, companies: ownerKeys.slice(0, CONTACT_PREVIEW_LIMITS.maxOwners).map(function (key) { return owners[key]; }), sources: sources.slice(0, CONTACT_PREVIEW_LIMITS.maxSources), reason: multiple ? 'multiple_companies' : 'unknown_owner', scope: old ? 'source_and_target' : 'source' };
      var size = JSON.stringify(item).length;
      if (detailCharacters + size > CONTACT_PREVIEW_LIMITS.maxDetailCharacters) { result.conflicts.truncated = true; return; }
      combinedItems.push(item); detailCharacters += size;
      if (ownerKeys.length > CONTACT_PREVIEW_LIMITS.maxOwners || sources.length > CONTACT_PREVIEW_LIMITS.maxSources || contact.omittedSources || (old && old.omittedSources)) result.conflicts.truncated = true;
    });
  });
  result.conflicts.totalCombined = combinedTotal;
  result.conflicts.items = combinedItems;
  if (combinedTotal > combinedItems.length) result.conflicts.truncated = true;
  if (result.emails.unresolvedCombined || result.phones.unresolvedCombined) contactPreviewWarn_(result, 'Принадлежность части контактов не подтверждена. Эти контакты требуют ручной проверки.');
}
