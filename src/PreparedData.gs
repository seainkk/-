/**
 * Selected-sheet preparation. This module reads values and hyperlinks only;
 * its caller owns authorization, staging membership and every write.
 */
var PREPARED_DATA_LIMITS = Object.freeze({ maxRows: 50000, maxColumns: 100, maxCells: 1000000, chunkCells: 100000, maxMillis: 45000, maxContacts: 100000, maxCellCharacters: 45000, sampleRows: 8 });
var PREPARED_DATA_HEADERS = Object.freeze({
  email: ['Email', 'Компания / ЛПР', 'Исходные строки', 'Проверить принадлежность'],
  phone: ['Телефон', 'Компания / ЛПР', 'Откуда', 'Исходные строки', 'Проверить принадлежность', 'Telegram', 'Тип контакта']
});

/** Internal convenience wrapper; callers must supply their staging guard. */
function preparedReadSource_(context, fileId, sheetId, section, options) {
  if (!options || typeof options.guard !== 'function') fail_('INVALID_REQUEST', 'Для чтения черновика нужна проверка его расположения.');
  options.guard();
  var book = SpreadsheetApp.openById(fileId), sheet = book.getSheets().filter(function (item) { return String(item.getSheetId()) === String(sheetId); })[0];
  if (!sheet) fail_('SHEET_NOT_FOUND', 'Выбранный лист недоступен. Обновите предпросмотр.');
  return preparedDataRead_(sheet, fileId, section, options);
}

function preparedDataRead_(sheet, sourceId, section, options) {
  options = options || {};
  var guard = typeof options.guard === 'function' ? options.guard : function () {};
  var limits = PREPARED_DATA_LIMITS, started = Date.now(), deadline = Number.isFinite(options.deadline) ? options.deadline : started + limits.maxMillis, complete = true, warnings = [];
  var warn = function (text) { if (warnings.indexOf(text) === -1) warnings.push(text); };
  guard();
  var lastRow = sheet.getLastRow(), width = sheet.getLastColumn(), sheetId = sheet.getSheetId(), sheetName = sheet.getName();
  var values = [], displays = [], formulas = [], links = [], formulaSnapshots = [], unresolvedLinks = [], observed = [], unparsed = 0, cellsRead = 0;
  if (width > limits.maxColumns || lastRow > limits.maxRows || width * lastRow > limits.maxCells) {
    complete = false; warn('Лист превышает лимит полного предпросмотра. Создание таблицы недоступно до уменьшения исходного листа.');
  }
  var readableWidth = Math.min(width, limits.maxColumns), readableRows = Math.min(lastRow, limits.maxRows, readableWidth ? Math.floor(limits.maxCells / readableWidth) : 0);
  var chunk = Math.max(1, Math.floor(limits.chunkCells / Math.max(1, readableWidth)));
  for (var firstRow = 1; firstRow <= readableRows; firstRow += chunk) {
    if (Date.now() >= deadline) { complete = false; warn('Не удалось полностью прочитать лист за отведённое время. Повторите предпросмотр.'); break; }
    guard();
    var count = Math.min(chunk, readableRows - firstRow + 1), range = sheet.getRange(firstRow, 1, count, readableWidth);
    var raw = range.getValues(), shown = range.getDisplayValues(), expression = range.getFormulas();
    var rich = typeof range.getRichTextValues === 'function' ? range.getRichTextValues() : null;
    if (!rich) { complete = false; warn('Не удалось проверить ссылки, скрытые за текстом ячеек. Повторите предпросмотр.'); }
    if (!preparedDataRectangle_(raw, count, readableWidth) || !preparedDataRectangle_(shown, count, readableWidth) || !preparedDataRectangle_(expression, count, readableWidth) || (rich && !preparedDataRectangle_(rich, count, readableWidth))) {
      complete = false; warn('Google вернул неполный диапазон. Частичный результат нельзя использовать для создания базы.'); break;
    }
    for (var y = 0; y < count; y++) {
      var absoluteRow = firstRow + y;
      values.push(raw[y]); displays.push(shown[y].map(function (v) { return String(v === null || v === undefined ? '' : v); })); formulas.push(expression[y]);
      for (var x = 0; x < readableWidth; x++) {
        var cellLinks = preparedDataRichLinks_(rich && rich[y][x], shown[y][x]);
        var literalLink = preparedDataFormulaLink_(expression[y][x]);
        if (literalLink && cellLinks.every(function (link) { return link.url !== literalLink; })) cellLinks.push({ start: 0, end: String(shown[y][x] || '').length, url: literalLink });
        if (cellLinks.length) links.push({ row: absoluteRow, column: x + 1, text: String(shown[y][x] || ''), runs: cellLinks });
        if (expression[y][x]) {
          var snapshot = { row: absoluteRow, column: x + 1, value: raw[y][x], display: String(shown[y][x] || '') };
          if (Object.prototype.toString.call(raw[y][x]) === '[object Date]') { snapshot.valueType = 'date'; snapshot.value = raw[y][x].toISOString(); }
          if (cellLinks.length) { snapshot.link = cellLinks[0].url; snapshot.links = cellLinks; }
          formulaSnapshots.push(snapshot);
          if (/^\s*=\s*(?:HYPERLINK|ГИПЕРССЫЛКА)\s*\(/i.test(expression[y][x]) && !cellLinks.length) unresolvedLinks.push({ row: absoluteRow, column: x + 1, formula: expression[y][x], display: String(shown[y][x] || ''), snapshot: snapshot });
        }
      }
    }
    cellsRead += count * readableWidth;
    guard();
  }
  unresolvedLinks.forEach(function (cell) {
    if (Date.now() >= deadline) { complete = false; warn('Не удалось полностью прочитать ссылки за отведённое время. Частичный результат нельзя применять автоматически.'); return; }
    var reference = preparedDataFormulaReference_(cell.formula), url = reference && !reference.sheetName ? String(values[reference.row - 1] && values[reference.row - 1][reference.column - 1] || '') : '';
    if (!url && reference && typeof options.resolveLinkReference === 'function') { guard(); url = String(options.resolveLinkReference(reference) || ''); guard(); }
    if (url) {
      var run = { start: 0, end: cell.display.length, url: url };
      links.push({ row: cell.row, column: cell.column, text: cell.display, runs: [run] }); cell.snapshot.link = url; cell.snapshot.links = [run];
    } else { complete = false; warn('Не удалось определить адрес одной из формул HYPERLINK. Проверьте её ссылку и повторите предпросмотр.'); }
  });
  if (options.hasHeader !== undefined && typeof options.hasHeader !== 'boolean') fail_('INVALID_REQUEST', 'Признак строки заголовков должен быть логическим значением.');
  if (options.headerIndex !== undefined && (!Number.isSafeInteger(options.headerIndex) || options.headerIndex < 0 || options.headerIndex >= Math.max(1, lastRow) || options.headerIndex >= limits.maxRows)) fail_('INVALID_REQUEST', 'Некорректный номер строки заголовков.');
  var detected = preparedDataHeader_(displays, values, links, section);
  if (options.hasHeader !== undefined) {
    var explicitHeader = options.hasHeader ? (options.headerIndex === undefined ? 0 : options.headerIndex) : -1;
    var labels = options.hasHeader ? (displays[explicitHeader] || []).slice() : Array.from({ length: readableWidth }, function (_, index) { return 'Столбец ' + preparedDataColumn_(index + 1); });
    detected = { index: explicitHeader, hasHeader: options.hasHeader, header: labels, mapping: preparedDataMapping_(options.hasHeader ? labels : []) };
    if (typeof sourceRecordsColumns_ === 'function') detected.mapping.recordColumns = sourceRecordsColumns_(options.hasHeader ? labels : [], section);
  }
  var header = detected.header, mapping = detected.mapping;
  var firstData = detected.hasHeader ? detected.index + 1 : 0, hasHeader = detected.hasHeader, sourceRows = 0, cellContacts = Object.create(null);
  if (detected.index > 0 && hasHeader) warn('Заголовок распознан в строке ' + (detected.index + 1) + '; строки оформления перед ним остаются в исходном листе.');
  if (!hasHeader && lastRow) warn('Заголовки не определены однозначно. Контакты распознаются по содержимому ячеек, первая строка сохранена как данные.');
  if (mapping.ambiguous.length) warn('Неоднозначные поля идентификаторов не считаются контактами: ' + mapping.ambiguous.join(', ') + '. Исходные значения сохранены.');
  mapping.cellPolicies = Array.from({ length: readableWidth }, function (_, index) { var label = hasHeader ? String(header[index] || '') : ''; return { excluded: preparedDataExcludedColumn_(label), email: mapping.emailColumns.some(function (column) { return column.index === index; }), phone: mapping.phoneColumns.some(function (column) { return column.index === index; }), telegram: mapping.telegramColumns.some(function (column) { return column.index === index; }) }; });
  var linkIndex = Object.create(null);
  links.forEach(function (cell) { linkIndex[cell.row + ':' + cell.column] = cell.runs; });
  for (var index = firstData; index < displays.length; index++) {
    if (index % 250 === 0 && Date.now() >= deadline) { complete = false; warn('Не удалось полностью распознать данные за отведённое время. Частичный результат нельзя использовать для создания базы.'); break; }
    var cells = displays[index];
    if (!cells.some(function (value) { return String(value).trim() !== ''; })) continue;
    sourceRows++;
    var observation = { localId: '', inn: '', name: '', identityAmbiguous: false, emails: [], phones: [], telegrams: [], source: { fileId: sourceId, sheetId: sheetId, sheetName: sheetName, row: index + 1 }, contexts: Object.create(null), contactSources: Object.create(null) };
    var localIds = [], inns = [];
    mapping.companyColumns.forEach(function (column) {
      var value = String(cells[column.index] || '').trim();
      if (column.kind === 'id' && value && value.length <= 512 && !/^\d(?:[.,]\d+)?e[+-]?\d+$/i.test(value) && localIds.indexOf(value) === -1) localIds.push(value);
      if (column.kind === 'inn') { var inn = contactPreviewInn_(value); if (inn && inns.indexOf(inn) === -1) inns.push(inn); }
      if (column.kind === 'name' && !observation.name) observation.name = value;
    });
    observation.identityAmbiguous = localIds.length > 1 || inns.length > 1;
    observation.localId = localIds.length === 1 ? localIds[0] : '';
    observation.inn = inns.length === 1 ? inns[0] : '';
    var person = preparedDataPerson_(cells, mapping.personColumns), context = observation.name;
    observation.personAmbiguous = person.ambiguous;
    var personalContext = [observation.name, person.name].filter(Boolean).join(' — ') + (person.role ? ' (' + person.role + ')' : '');
    for (var columnIndex = 0; columnIndex < cells.length; columnIndex++) {
      var label = hasHeader ? String(header[columnIndex] || '') : '', key = (index + 1) + ':' + (columnIndex + 1);
      var rawValue = values[index] && values[index][columnIndex], text = String(cells[columnIndex] || '');
      var entry = preparedDataCellContacts_(text, rawValue, label, linkIndex[key] || [], mapping, columnIndex);
      if (entry.emails.length || entry.phones.length || entry.telegrams.length) cellContacts[key] = entry;
      if (entry.unparsed) unparsed++;
      var source = { fileId: sourceId, sheetId: sheetId, sheetName: sheetName, row: index + 1, column: columnIndex + 1 };
      var personal = preparedDataPersonalColumn_(label, section) && person.name;
      entry.emails.forEach(function (email) {
        observation.emails.push(email); observation.contexts['email:' + email] = personal ? personalContext : context;
        preparedDataAddSource_(observation, 'email', email, source);
      });
      entry.phones.forEach(function (phone) {
        observation.phones.push(phone); observation.contexts['phone:' + phone.value] = personal ? personalContext : context;
        preparedDataAddSource_(observation, 'phone', phone.value, source);
      });
      entry.telegrams.forEach(function (telegram) {
        observation.telegrams.push({ value: telegram, origin: 'Telegram' }); observation.contexts['telegram:' + telegram] = personal ? personalContext : context;
        preparedDataAddSource_(observation, 'telegram', telegram, source);
      });
    }
    observed.push(observation);
  }
  var recordsResult = typeof sourceRecordsBuild_ === 'function' ? sourceRecordsBuild_(displays, { fileId: sourceId, sheetId: sheetId, sheetName: sheetName, section: section, headerIndex: detected.index, hasHeader: hasHeader, header: header, rawRows: values, cellContacts: cellContacts }) : { records: [], warnings: [] };
  (recordsResult.warnings || []).forEach(warn);
  var records = recordsResult.records || [];
  if (records.length) preparedDataApplyRecordContexts_(observed, records);
  var normalized = preparedDataAggregate_(observed, sourceId, warn);
  if (Date.now() >= deadline) { complete = false; warn('Нормализация строк превысила время полного чтения. Частичные результаты нельзя применять автоматически.'); }
  if (!normalized.emailRows.length && !normalized.phoneRows.length && sourceRows) warn('В исходнике не найдены однозначные email, телефоны или Telegram. Исходные строки и данные компаний/ЛПР сохранены; неизвестные значения не выдаются за контакты.');
  if (normalized.partial) { complete = false; warn('В исходнике слишком много контактов для одного полного предпросмотра. Разделите исходный лист.'); }
  if (unparsed) warn('В контактных полях есть значения, которые не удалось распознать (' + unparsed + '). Они сохранены в исходном листе; валидация контактов сейчас не выполняется.');
  if (normalized.companyUnknown) warn('У части строк не определена компания (' + normalized.companyUnknown + '). Контакты сохранены с отметкой для ручной проверки.');
  if (normalized.unknownPhones) warn('Часть номеров не имеет однозначного международного формата или типа. Они сохранены без предположения о стране и требуют дальнейшей обработки.');
  guard();
  var counts = { sourceRows: sourceRows, companies: normalized.companies, companyUnknown: normalized.companyUnknown, emails: normalized.emailRows.length, phones: normalized.phoneCount, mobiles: normalized.mobiles, sharedEmails: normalized.sharedEmails, sharedPhones: normalized.sharedPhones, telegrams: normalized.telegrams, sharedTelegrams: normalized.sharedTelegrams };
  var source = { id: sheetId, sheetId: sheetId, name: sheetName, headers: header, hasHeader: hasHeader, headerIndex: detected.index, rowCount: lastRow, columnCount: width, sample: displays.slice(firstData, firstData + limits.sampleRows) };
  var email = { headers: PREPARED_DATA_HEADERS.email.slice(), rows: normalized.emailRows, sample: normalized.emailRows.slice(0, limits.sampleRows) };
  var phone = { headers: PREPARED_DATA_HEADERS.phone.slice(), rows: normalized.phoneRows, sample: normalized.phoneRows.slice(0, limits.sampleRows) };
  var fingerprint = preparedDataDigest_(JSON.stringify({ version: 2, sourceId: sourceId, section: section, headerIndex: detected.index, hasHeader: hasHeader, sheetId: sheetId, sheetName: sheetName, rows: lastRow, columns: width, values: values, display: displays, formulas: formulas, links: links }));
  var legacyFingerprint = preparedDataDigest_(JSON.stringify({ version: 1, sourceId: sourceId, section: section, sheetId: sheetId, sheetName: sheetName, rows: lastRow, columns: width, values: values, display: displays, formulas: formulas, links: links }));
  return { complete: complete, canConfirm: complete && lastRow > 0 && width > 0, fingerprint: fingerprint, legacyFingerprint: legacyFingerprint, sourceHash: fingerprint, counts: counts, source: source, sourceRows: lastRow, sourceCols: width, sourceValues: values, sourceDisplayValues: displays, sourceLinks: links, sourceFormulas: formulas, formulas: formulas, formulaSnapshots: formulaSnapshots, email: email, phone: phone, emailHeaders: email.headers, emailRows: email.rows, phoneHeaders: phone.headers, phoneRows: phone.rows, warnings: warnings, cellsRead: cellsRead, records: records, observations: observed, mapping: mapping, cellContacts: cellContacts, contactIndex: normalized.contactIndex,
    previewSheets: [{ name: 'Исходная база', headers: header, sample: source.sample, rowCount: lastRow }, { name: 'Email', headers: email.headers, sample: email.sample, rowCount: email.rows.length + 1 }, { name: 'Телефоны', headers: phone.headers, sample: phone.sample, rowCount: phone.rows.length + 1 }] };
}

function preparedDataRectangle_(rows, height, width) { return Array.isArray(rows) && rows.length === height && rows.every(function (row) { return Array.isArray(row) && row.length === width; }); }
function preparedDataDigest_(value) { return digest_(value); }
function preparedDataLiteral_(value) { if (typeof value !== 'string') return value; return /^(?:'|\s*[=+\-@])/.test(value) ? "'" + value : value; }

/** Header semantics enrich context; strong contacts never depend on a known label. */
function preparedDataHeader_(rows, rawRows, links, section) {
  var best = -1, bestScore = 0;
  for (var index = 0; index < Math.min(20, rows.length); index++) {
    var row = rows[index], mapping = preparedDataMapping_(row), known = Object.create(null);
    mapping.companyColumns.concat(mapping.emailColumns, mapping.phoneColumns, mapping.personColumns, mapping.telegramColumns).forEach(function (column) { known[column.index] = true; });
    if (typeof sourceRecordsColumns_ === 'function') sourceRecordsColumns_(row, section).forEach(function (column, index) { if (column.company || column.person) known[index] = true; });
    var score = Object.keys(known).length, contacts = 0;
    row.forEach(function (value, column) {
      var text = String(value || '').trim();
      if (preparedDataEmails_(text).length || preparedDataTelegrams_(text, [], false).length || preparedDataStrongPhones_(text, rawRows[index] && rawRows[index][column], false).length) contacts++;
    });
    if (score && !contacts && score > bestScore) { best = index; bestScore = score; }
  }
  var hasHeader = best >= 0, header = hasHeader ? rows[best].slice() : Array.from({ length: rows[0] ? rows[0].length : 0 }, function (_, i) { return 'Столбец ' + preparedDataColumn_(i + 1); });
  var result = preparedDataMapping_(hasHeader ? header : []);
  if (typeof sourceRecordsColumns_ === 'function') result.recordColumns = sourceRecordsColumns_(hasHeader ? header : [], section);
  return { index: hasHeader ? best : -1, hasHeader: hasHeader, header: header, mapping: result };
}
function preparedDataColumn_(column) { var label = ''; for (var value = column; value; value = Math.floor((value - 1) / 26)) label = String.fromCharCode(65 + (value - 1) % 26) + label; return label; }
function preparedDataExcludedColumn_(label) {
  var key = contactPreviewHeader_(label);
  return /валид|результат|статус|отправител|sender|провер|колво|количество|дубль|повтор|кампан|рассылк|reply/.test(key) || /^(?:переносвлпр|перенесеновлпр|добавленовлпр|idлпр|идлпр|идентификаторлпр)$/.test(key) || /^(?:id|ид)(?:$|[a-zа-я])|(?:id|ид)$/.test(key) || /^(?:инн|inn|огрн|огрнип|ogrn|ogrnip|кпп|окпо|бик|счет|расчетныйсчет|индекс|дата|датасоздания|датарождения|date|birthdate|count|companyid|personid)/.test(key);
}
function preparedDataDateLike_(value) {
  var match = String(value || '').trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/);
  if (match) return Number(match[1]) >= 1 && Number(match[1]) <= 31 && Number(match[2]) >= 1 && Number(match[2]) <= 12;
  var iso = String(value || '').trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:[.]\d+)?Z?)?$/);
  return !!iso && Number(iso[2]) >= 1 && Number(iso[2]) <= 12 && Number(iso[3]) >= 1 && Number(iso[3]) <= 31;
}
function preparedDataStrongPhones_(display, raw, telegramColumn) {
  if (Object.prototype.toString.call(raw) === '[object Date]' || preparedDataDateLike_(display)) return [];
  var text = preparedDataPlainPhoneText_(display), trimmed = text.trim();
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && /^[\d., ]+[eE][+-]?\d+$/.test(trimmed)) text = String(raw);
  var strong = /\+\d[\d ().-]{6,}\d/.test(text) || (!telegramColumn && /(?:^|[^\p{L}\p{N}])(?:[78]\d{10}|[78]\s*\(?\d{3}\)?[\d ().-]{6,}\d)(?=$|[^\p{L}\p{N}])/u.test(text));
  if (!strong) return [];
  return preparedDataPhones_(text).filter(function (phone) { return /^\+\d{8,15}$/.test(phone.value); });
}
function preparedDataCellContacts_(display, raw, label, links, mapping, index) {
  var result = { emails: [], phones: [], telegrams: [], unparsed: false };
  if (!String(display || '').trim() && !links.length) return result;
  var policy = mapping.cellPolicies && mapping.cellPolicies[index];
  if ((policy && policy.excluded) || (!policy && preparedDataExcludedColumn_(label))) return result;
  var emailColumn = policy ? policy.email : mapping.emailColumns.some(function (column) { return column.index === index; });
  var phoneColumn = policy ? policy.phone : mapping.phoneColumns.some(function (column) { return column.index === index; });
  var telegramColumn = policy ? policy.telegram : mapping.telegramColumns.some(function (column) { return column.index === index; });
  var urls = /[.:/]/.test(String(display)) || links.length ? preparedDataTextUrls_(display) : [];
  links.forEach(function (link) { if (urls.indexOf(link.url) < 0) urls.push(link.url); });
  result.emails = String(display).indexOf('@') >= 0 ? preparedDataEmails_(display) : [];
  urls.forEach(function (url) { result.emails = result.emails.concat(preparedDataMailto_(url)); result.phones = result.phones.concat(preparedDataUrlPhones_(url)); });
  result.emails = preparedDataUnique_(result.emails);
  var source = String(display || ''), date = Object.prototype.toString.call(raw) === '[object Date]' || preparedDataDateLike_(source);
  if (!date && /\d/.test(source)) {
    if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && /^[\d., ]+[eE][+-]?\d+$/.test(source.trim())) source = String(raw);
    var plain = phoneColumn ? preparedDataPhones_(source) : preparedDataStrongPhones_(source, raw, telegramColumn);
    plain.forEach(function (phone) { if (!phoneColumn && /^[78]\d{10}$/.test(String(source).trim())) phone.needsReview = true; phone.origin = label ? 'Столбец «' + label + '»' : 'Ячейка ' + preparedDataColumn_(index + 1); result.phones.push(phone); });
  }
  if (telegramColumn || String(display).indexOf('@') >= 0 || /(?:t\.me|telegram\.me|telegram\.dog|tg:\/\/|телеграм|telegram\s*[:=])/i.test(String(display)) || urls.some(function (url) { return /(?:t\.me|telegram\.me|telegram\.dog|tg:\/\/)/i.test(url); })) result.telegrams = preparedDataTelegrams_(display, urls, telegramColumn);
  if (emailColumn && contactPreviewHasValue_(display) && (!result.emails.length || (String(display).match(/@/g) || []).length > result.emails.length)) result.unparsed = true;
  if (phoneColumn && contactPreviewHasValue_(preparedDataPlainPhoneText_(display)) && !result.phones.length) result.unparsed = true;
  if (telegramColumn && contactPreviewHasValue_(display) && !result.telegrams.length && !result.phones.length) result.unparsed = true;
  return result;
}
function preparedDataTelegramName_(value) {
  var name = String(value || '').trim().replace(/^@/, '');
  if (!/^[a-z0-9_]{4,32}$/i.test(name) || !/[a-z]/i.test(name)) return '';
  if (/^(?:joinchat|share|addstickers|addemoji|proxy|socks|iv|login|contact|giftcode|boost|setlanguage|confirmphone|addlist|invoice|bg|m|c|s)$/i.test(name)) return '';
  return '@' + name.toLowerCase();
}
function preparedDataTelegrams_(value, urls, allowBare) {
  var text = String(value || ''), found = [], match;
  var pattern = /(^|[\s([{:;,])@([a-z0-9_]{4,32})(?=$|[\s,;:!?()[\]{}<>]|[.](?=$|\s))/gi;
  while ((match = pattern.exec(text))) { var named = preparedDataTelegramName_(match[2]); if (named) found.push(named); }
  var list = (urls || []).concat(preparedDataTextUrls_(text));
  var bareUrls = text.match(/(?:^|[\s(<])(?:t\.me|telegram\.me|telegram\.dog)\/[a-z0-9_/?#=+.-]+/gi) || [];
  bareUrls.forEach(function (url) { list.push('https://' + url.trim().replace(/^[<(]/, '')); });
  list.forEach(function (raw) {
    var url = preparedDataDecode_(String(raw || '').trim()), name = '';
    if (/^tg:\/\/resolve(?:[/?#]|$)/i.test(url)) name = preparedDataQuery_(url, 'domain');
    else { var profile = url.match(/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/([a-z0-9_]{4,32})\/?(?:[?#][^\s]*)?$/i); if (profile) name = profile[1]; }
    var valid = preparedDataTelegramName_(name); if (valid) found.push(valid);
  });
  var prefixed = text.match(/(?:телеграм|telegram|tg)\s*[:=]\s*@?([a-z0-9_]{4,32})(?=$|[^a-z0-9_])/i);
  if (prefixed) { var contact = preparedDataTelegramName_(prefixed[1]); if (contact) found.push(contact); }
  if (allowBare) { var plain = preparedDataTelegramName_(text); if (plain) found.push(plain); }
  return preparedDataUnique_(found);
}
function preparedDataAddSource_(observation, kind, value, source) {
  var key = kind + ':' + value;
  if (!observation.contactSources[key]) observation.contactSources[key] = [];
  observation.contactSources[key].push(source);
}

function preparedDataMapping_(headers) {
  var existing = contactPreviewMapping_(headers), result = { companyColumns: existing.companyColumns, emailColumns: [], phoneColumns: [], personColumns: [], telegramColumns: [], ambiguous: [] };
  headers.forEach(function (label, index) {
    var key = contactPreviewHeader_(String(label || '').replace(/\([^)]*не\s+провер[^)]*\)/gi, ''));
    if (/^(?:фио\d*|фамилияимяотчество|руководитель\d*|фиоруководителя|имя|фамилия|отчество|должность\d*|директор|генеральныйдиректор|владелец|собственник|ceo)$/.test(key) || /^(?:фио|должность)(?:лпр|маркетолога|руководителя)$/.test(key) || /^лпр(?:маркетинг|маркетолог|продажи|закупки)?$/.test(key)) result.personColumns.push({ index: index, label: String(label || ''), kind: /должност/.test(key) ? 'role' : key });
    if (['наименование','наименованиеорганизации','юридическоенаименование','названиеорганизации','организация','работодатель','предприятие','фирма','названиефирмы'].indexOf(key) >= 0 && !result.companyColumns.some(function (column) { return column.index === index; })) result.companyColumns.push({ index: index, label: String(label || ''), kind: 'name' });
    if (/telegram|телеграм/.test(key) || /^(?:tg|тг)\d*$/.test(key)) result.telegramColumns.push({ index: index, label: String(label || '') });
    if (/валид|результат|статус|отправител|sender|провер|колво|количество|дубль|повтор|кампан|рассылк|reply/.test(key)) return;
    if (/email|почт|телефон|phone|mobile/.test(key) && (/^(?:id|ид)/.test(key) || /(?:id|ид)$/.test(key))) { result.ambiguous.push(String(label || '')); return; }
    var combined = /^(?:контакты|контакт|контактныеданные|контактнаяинформация|contact|contacts)$/.test(key);
    var isEmail = combined || existing.emailColumns.some(function (column) { return column.index === index; }) || /email|почт|электронн.*адрес/.test(key);
    var isPhone = combined || existing.phoneColumns.some(function (column) { return column.index === index; }) || /телефон|мобильн/.test(key) || /^(?:phone|phones|mobile|mobiles|телосновной|телдоп)$/.test(key);
    if (isEmail && !/^(?:id|ид)/.test(key)) result.emailColumns.push({ index: index, label: String(label || '') });
    if (isPhone && !/(?:id|ид)$/.test(key)) result.phoneColumns.push({ index: index, label: String(label || '') });
    if ((isEmail && /^(?:id|ид)/.test(key)) || (isPhone && /(?:id|ид)$/.test(key))) result.ambiguous.push(String(label || ''));
  });
  return result;
}

function preparedDataPersonalColumn_(label, section) {
  var key = contactPreviewHeader_(label);
  if (/компании|emailадреса|мобильныетелефоны|городскиетелефоны/.test(key)) return false;
  return section === 'lpr' || /личн|персон|основн|доп|лпр|руковод|маркетолог/.test(key);
}

function preparedDataPerson_(cells, columns) {
  var full = [], parts = [], roles = [], partValues = Object.create(null);
  columns.forEach(function (column) {
    var value = String(cells[column.index] || '').trim(); if (!value) return;
    if (column.kind === 'role') roles.push(value);
    else if (/^(?:имя|фамилия|отчество)$/.test(column.kind)) { parts.push(value); if (!partValues[column.kind]) partValues[column.kind] = []; if (partValues[column.kind].indexOf(value) === -1) partValues[column.kind].push(value); }
    else full.push(value);
  });
  var uniqueFull = preparedDataUnique_(full), ambiguous = uniqueFull.length > 1 || Object.keys(partValues).some(function (key) { return partValues[key].length > 1; });
  return { name: ambiguous ? '' : preparedDataUnique_(full.length ? full : parts).join(' '), role: ambiguous ? '' : preparedDataUnique_(roles).join('; '), ambiguous: ambiguous };
}

function preparedDataMailto_(value) { var url = preparedDataDecode_(String(value || '')); return /^mailto:/i.test(url) ? preparedDataEmails_(url.slice(7).split('?')[0]) : []; }

function preparedDataEmails_(value) {
  var text = String(value || '').replace(/mailto:/gi, ''), result = [], pattern = /(^|[\s,;<>"()[\]:])([^\s,@<>"()[\]:;]+@[^\s,@<>"()[\]:;]+)(?=$|[\s,;<>"()[\]:])/g, match;
  while ((match = pattern.exec(text))) {
    var email = match[2].replace(/[.!?]+$/, '');
    if (/^[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}$/u.test(email)) result.push(email.toLowerCase());
  }
  return result;
}

function preparedDataPhones_(value) {
  var text = preparedDataPlainPhoneText_(value).replace(/(?:доб\.?|ext\.?)\s*\d+/gi, ''), values = [];
  text.split(/[\r\n;,|]+/).forEach(function (part) {
    var trimmed = part.trim();
    if (/^(?:[78]\d{10}\s+)+[78]\d{10}$/.test(trimmed)) values = values.concat(trimmed.split(/\s+/));
    else {
      var pattern = /(^|[^\p{L}\p{N}_])(\+?\d[\d\s().-]{3,}\d)(?=$|[^\p{L}\p{N}_])/gu, match;
      while ((match = pattern.exec(trimmed))) values.push(match[2]);
    }
  });
  return values.filter(function (raw) { return !preparedDataDateLike_(raw); }).map(function (raw) { return preparedDataPhone_(raw, false); }).filter(Boolean);
}

function preparedDataPhone_(raw, international) {
  raw = String(raw || '').trim();
  var digits = raw.replace(/\D/g, '');
  if (digits.length < (international ? 8 : 5) || digits.length > 15 || /^0+$/.test(digits)) return null;
  var value = international || raw.charAt(0) === '+' ? '+' + digits : /^[78]\d{10}$/.test(digits) ? '+7' + digits.slice(1) : digits;
  var kind = /^\+79\d{9}$/.test(value) ? 'mobile' : /^\+7[348]\d{9}$/.test(value) ? 'landline' : 'unknown';
  return { value: value, kind: kind };
}

function preparedDataTextUrls_(value) {
  var text = String(value || ''), formattedTel = text.match(/tel:\+?\d[\d ().-]{5,}\d(?:;ext=\d+)?/gi) || [];
  var urls = formattedTel.concat(text.match(/(?:https?:\/\/|tg:\/\/|viber:\/\/|tel:)[^\s<>"';]+/gi) || []);
  var bareText = text.replace(/(?:https?:\/\/|tg:\/\/|viber:\/\/|tel:)[^\s<>"']+/gi, ' '), barePattern = /(^|[\s(<:;])((?:wa\.me|t\.me|telegram\.me|telegram\.dog)\/[^\s<>"';]+)/gi, match;
  while ((match = barePattern.exec(bareText))) urls.push('https://' + match[2]);
  return preparedDataUnique_(urls.map(function (url) { return url.replace(/[.,;]+$/, ''); }));
}
function preparedDataStripUrls_(value) { return String(value || '').replace(/tel:\+?\d[\d ().-]{5,}\d(?:;ext=\d+)?/gi, '').replace(/(?:https?:\/\/|tg:\/\/|viber:\/\/|tel:)[^\s<>"']+/gi, '').replace(/(?:wa\.me|t\.me)\/[^\s<>"']+/gi, '').replace(/\b(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"']+/gi, ''); }
function preparedDataPlainPhoneText_(value) { return preparedDataStripUrls_(value).replace(/[^\s,;<>"()[\]]*@[^\s,;<>"()[\]]*/g, '').replace(/(?:^|[^\p{L}\p{N}])(?:id|ид|инн|огрн|огрнип|кпп)\s*[:=№#]?\s*\d[\d .-]{4,}\d/giu, ''); }
function preparedDataDecode_(value) { try { return decodeURIComponent(String(value || '').replace(/&amp;/gi, '&')); } catch (ignored) { return String(value || ''); } }

function preparedDataUrlPhones_(value) {
  var url = preparedDataDecode_(String(value || '').trim()), raw = '', origin = '';
  if (/^tel:/i.test(url)) { raw = url.slice(4).split(/[;?]/)[0]; origin = 'Ссылка tel:'; }
  else if (/^https?:\/\/wa\.me\/[+\d() .-]+(?:[/?#].*)?$/i.test(url)) { raw = (url.match(/^https?:\/\/wa\.me\/([^/?#]+)/i) || [])[1] || ''; origin = 'WhatsApp'; }
  else if (/^https?:\/\/(?:api\.|web\.)?whatsapp\.com\/send(?:[/?#]|$)/i.test(url)) { raw = preparedDataQuery_(url, 'phone'); origin = 'WhatsApp'; }
  else if (/^tg:\/\/resolve(?:[/?#]|$)/i.test(url)) { raw = preparedDataQuery_(url, 'phone'); origin = 'Telegram-ссылка'; }
  else if (/^https?:\/\/t\.me\/\+\d{8,15}(?:[/?#].*)?$/i.test(url)) { raw = '+' + (url.match(/^https?:\/\/t\.me\/\+(\d{8,15})/i) || [])[1]; origin = 'Telegram-ссылка'; }
  else if (/^viber:\/\/(?:chat|add)(?:[/?#]|$)/i.test(url)) { raw = preparedDataQuery_(url, 'number') || preparedDataQuery_(url, 'phone'); origin = 'Viber'; }
  if (!raw || !/^[+\d() .-]+$/.test(raw)) return [];
  var phone = preparedDataPhone_(raw, true);
  if (!phone) return [];
  phone.origin = origin;
  return [phone];
}
function preparedDataQuery_(url, key) { var match = String(url).match(new RegExp('[?&]' + key + '=([^&#]*)', 'i')); return match ? preparedDataDecode_(match[1]) : ''; }

function preparedDataRichLinks_(rich, shown) {
  if (!rich) return [];
  var links = [], offset = 0, runs = typeof rich.getRuns === 'function' ? rich.getRuns() : [];
  runs.forEach(function (run) {
    var text = typeof run.getText === 'function' ? run.getText() : '', url = typeof run.getLinkUrl === 'function' ? run.getLinkUrl() : null;
    var start = typeof run.getStartIndex === 'function' ? run.getStartIndex() : offset, end = typeof run.getEndIndex === 'function' ? run.getEndIndex() : start + text.length;
    if (url) links.push({ start: start, end: end, url: String(url) }); offset = end;
  });
  var url = typeof rich.getLinkUrl === 'function' ? rich.getLinkUrl() : null;
  if (url && links.every(function (link) { return link.url !== String(url); })) links.push({ start: 0, end: String(shown || '').length, url: String(url) });
  return links;
}
function preparedDataFormulaLink_(formula) { var match = String(formula || '').match(/^\s*=\s*(?:HYPERLINK|ГИПЕРССЫЛКА)\s*\(\s*"((?:[^"]|"")*)"\s*[,;]/i); return match ? match[1].replace(/""/g, '"') : ''; }
function preparedDataFormulaReference_(formula) {
  var match = String(formula || '').match(/^\s*=\s*(?:HYPERLINK|ГИПЕРССЫЛКА)\s*\(\s*(?:(?:'((?:[^']|'')+)'|([\p{L}\p{N}_.]+))!)?\$?([A-Z]+)\$?(\d+)\s*[,;]/iu);
  if (!match) return null;
  var column = 0; match[3].toUpperCase().split('').forEach(function (letter) { column = column * 26 + letter.charCodeAt(0) - 64; });
  return { row: Number(match[4]), column: column, sheetName: match[1] ? match[1].replace(/''/g, "'") : match[2] || '' };
}
function preparedDataUnique_(values) { return values.filter(function (value, index) { return values.indexOf(value) === index; }); }

/** Human labels follow the same explicit person groups as normalized records. */
function preparedDataApplyRecordContexts_(observations, records) {
  var bySource = Object.create(null);
  records.forEach(function (record) { bySource[[record.source.sheetId, record.source.row].join(':')] = record; });
  observations.forEach(function (observation) {
    var record = bySource[[observation.source.sheetId, observation.source.row].join(':')];
    if (!record) return;
    observation.personAmbiguous = !!record.ambiguous;
    if (!observation.localId && record.company.id) observation.localId = record.company.id;
    if (!observation.inn && record.company.inn) observation.inn = record.company.inn;
    if (!observation.name && record.company.name) observation.name = record.company.name;
    var company = record.company.name || observation.name || observation.localId || observation.inn;
    [['email', 'emails'], ['phone', 'phones'], ['telegram', 'telegrams']].forEach(function (pair) {
      var kind = pair[0], field = pair[1], values = kind === 'email' ? observation.emails : observation[field].map(function (contact) { return typeof contact === 'string' ? contact : contact.value; });
      preparedDataUnique_(values).forEach(function (value) {
        var contexts = [];
        if (record.general[field].indexOf(value) >= 0 && company) contexts.push(company);
        record.people.forEach(function (person) {
          if (person[field].indexOf(value) < 0) return;
          var label = [company, person.name].filter(Boolean).join(' — ') + (person.role ? ' (' + person.role + ')' : '');
          if (label && contexts.indexOf(label) < 0) contexts.push(label);
          if (person.ambiguous) observation.personAmbiguous = true;
        });
        observation.contexts[kind + ':' + value] = contexts.join('; ') || company;
      });
    });
  });
}

function preparedDataAggregate_(observations, sourceId, warn, options) {
  options = options || {};
  var resolved = contactPreviewResolveOwners_(observations, sourceId), stores = { email: Object.create(null), phone: Object.create(null), telegram: Object.create(null) }, total = 0, partial = false;
  observations.forEach(function (row, index) {
    var owner = resolved.byRow[index];
    var add = function (kind, value, phoneKind, origin, needsReview) {
      var store = stores[kind];
      if (!Object.prototype.hasOwnProperty.call(store, value)) {
        if (total >= PREPARED_DATA_LIMITS.maxContacts) { partial = true; return; }
        store[value] = { value: value, kind: phoneKind, contexts: Object.create(null), owners: Object.create(null), unknown: false, personAmbiguous: false, parseAmbiguous: false, sources: Object.create(null), origins: Object.create(null) }; total++;
      }
      var record = store[value];
      if (owner) record.owners[owner] = true; else record.unknown = true;
      if (row.personAmbiguous) record.personAmbiguous = true;
      if (needsReview) record.parseAmbiguous = true;
      var context = row.contexts[kind + ':' + value] || row.name || row.localId || row.inn;
      if (context) record.contexts[context] = true;
      var refs = row.contactSources && row.contactSources[kind + ':' + value];
      if (!refs || !refs.length) refs = [row.source];
      refs.forEach(function (ref) { record.sources[[ref.fileId || sourceId, ref.sheetId, ref.row, ref.column || 0].join(':')] = ref; });
      if (origin) record.origins[origin] = true;
      if (phoneKind === 'mobile') record.kind = 'mobile';
    };
    row.emails.forEach(function (value) { add('email', value, '', ''); });
    row.phones.forEach(function (phone) { add('phone', phone.value, phone.kind, phone.origin, phone.needsReview); });
    (row.telegrams || []).forEach(function (contact) { add('telegram', typeof contact === 'string' ? contact : contact.value, '', typeof contact === 'string' ? 'Telegram' : contact.origin); });
  });
  var sharedEmails = 0, sharedPhones = 0, sharedTelegrams = 0, mobiles = 0, unknownPhones = 0, contactIndex = [];
  var rows = function (kind) { return Object.keys(stores[kind]).sort().map(function (key) {
    var record = stores[kind][key], shared = Object.keys(record.owners).length > 1, review = shared || record.unknown || record.personAmbiguous || record.parseAmbiguous;
    if (shared) { if (kind === 'email') sharedEmails++; else if (kind === 'phone') sharedPhones++; else sharedTelegrams++; }
    if (kind === 'phone') { if (record.kind === 'mobile') mobiles++; if (record.kind === 'unknown') unknownPhones++; }
    var context = preparedDataFit_(Object.keys(record.contexts).join('; '), warn), refs = Object.keys(record.sources).map(function (key) { return record.sources[key]; });
    var sources = preparedDataFit_(preparedDataSourceLabel_(refs, options.includeSheetNames), warn);
    contactIndex.push({ type: kind, value: record.value, sourceRefs: refs, owners: Object.keys(record.owners), needsReview: review });
    if (kind === 'email') return [record.value, context, sources, review ? 'Да' : ''];
    return [kind === 'phone' ? record.value : '', context, Object.keys(record.origins).join('; '), sources, review ? 'Да' : '', kind === 'telegram' ? record.value : '', kind === 'telegram' ? 'Telegram' : 'Телефон'];
  }); };
  var emailRows = rows('email'), onlyPhones = rows('phone'), telegramRows = rows('telegram');
  return { emailRows: emailRows, phoneRows: onlyPhones.concat(telegramRows), telegramRows: telegramRows, phoneCount: onlyPhones.length, telegrams: telegramRows.length, companies: Object.keys(resolved.owners).length, companyUnknown: resolved.unresolvedRows, sharedEmails: sharedEmails, sharedPhones: sharedPhones, sharedTelegrams: sharedTelegrams, mobiles: mobiles, unknownPhones: unknownPhones, partial: partial, contactIndex: contactIndex };
}
function preparedDataSourceLabel_(refs, includeSheetNames) {
  var sheets = Object.create(null);
  refs.forEach(function (ref) { var id = String(ref.sheetId); if (!sheets[id]) sheets[id] = { name: ref.sheetName || 'Лист ' + id, rows: Object.create(null) }; sheets[id].rows[ref.row] = true; });
  var ids = Object.keys(sheets);
  if (!includeSheetNames && ids.length === 1) return 'Строки ' + preparedDataRowList_(Object.keys(sheets[ids[0]].rows).map(Number));
  return ids.map(function (id) { return sheets[id].name + ': строки ' + preparedDataRowList_(Object.keys(sheets[id].rows).map(Number)); }).join('; ');
}

/** Read every explicitly selected source leaf; callers identify generated targets by IDs. */
function preparedDataReadWorkbook_(book, fileId, section, options) {
  options = options || {};
  var guard = typeof options.guard === 'function' ? options.guard : function () {}, started = Date.now(), deadline = started + PREPARED_DATA_LIMITS.maxMillis;
  guard();
  var available = book.getSheets(), selected = available.slice(), explicit = options.sourceSheetIds;
  if (explicit !== undefined) {
    if (!Array.isArray(explicit) || explicit.some(function (id) { return !Number.isSafeInteger(id) || id < 0; }) || new Set(explicit).size !== explicit.length) fail_('INVALID_REQUEST', 'Некорректный список исходных листов.');
    selected = explicit.map(function (id) { var sheet = available.filter(function (candidate) { return candidate.getSheetId() === id; })[0]; if (!sheet) fail_('SOURCE_CHANGED', 'Один из исходных листов больше недоступен. Перечитайте базу.'); return sheet; });
  }
  var managed = options.managedSheetIds || [];
  if (!Array.isArray(managed) || managed.some(function (id) { return !Number.isSafeInteger(id) || id < 0; })) fail_('INVALID_REQUEST', 'Некорректный список служебных листов.');
  if (explicit && explicit.some(function (id) { return managed.indexOf(id) >= 0; })) fail_('INVALID_REQUEST', 'Служебный лист нельзя использовать как исходную базу.');
  selected = selected.filter(function (sheet) { return managed.indexOf(sheet.getSheetId()) < 0; });
  var referenceCache = Object.create(null);
  var resolveReference = function (reference) {
    var source = selected.filter(function (sheet) { return sheet.getName() === reference.sheetName; })[0];
    if (!source || reference.row < 1 || reference.column < 1 || reference.row > PREPARED_DATA_LIMITS.maxRows || reference.column > PREPARED_DATA_LIMITS.maxColumns || reference.row > source.getLastRow() || reference.column > source.getLastColumn()) return '';
    if (Date.now() >= deadline) return '';
    var key = source.getSheetId() + ':' + reference.column;
    // A URL column is loaded once, rather than one API call for every HYPERLINK.
    if (!Object.prototype.hasOwnProperty.call(referenceCache, key)) { guard(); referenceCache[key] = source.getRange(1, reference.column, source.getLastRow(), 1).getValues(); guard(); }
    return referenceCache[key][reference.row - 1] && referenceCache[key][reference.row - 1][0];
  };
  var complete = true, models = [], sourceSheets = [], observations = [], records = [], warnings = [], cells = 0, physicalRows = 0;
  var warn = function (message) { if (warnings.indexOf(message) < 0) warnings.push(message); };
  selected.forEach(function (sheet, index) {
    guard();
    var height = sheet.getLastRow(), width = sheet.getLastColumn();
    sourceSheets.push({ id: sheet.getSheetId(), sheetId: sheet.getSheetId(), name: sheet.getName(), rowCount: height, columnCount: width });
    if (!complete && models.length < index) return;
    if (index >= 100 || Date.now() >= deadline || cells + height * width > PREPARED_DATA_LIMITS.maxCells || physicalRows + height > PREPARED_DATA_LIMITS.maxRows) { complete = false; warn('Книга превышает общий лимит полного чтения по листам, строкам, ячейкам или времени. Частичные списки нельзя использовать автоматически.'); return; }
    var model = preparedDataRead_(sheet, fileId, section, { guard: guard, deadline: deadline, resolveLinkReference: resolveReference });
    models.push(model); cells += model.cellsRead; physicalRows += height;
    observations = observations.concat(model.observations || []); records = records.concat(model.records || []);
    var descriptor = sourceSheets[sourceSheets.length - 1]; descriptor.hasHeader = model.source.hasHeader; descriptor.headerIndex = model.source.headerIndex; descriptor.headers = model.source.headers;
    if (!model.complete) complete = false;
    (model.warnings || []).forEach(warn);
  });
  var normalized = preparedDataAggregate_(observations, fileId, warn, { includeSheetNames: true });
  if (normalized.partial) { complete = false; warn('В исходной книге слишком много контактов для одного полного чтения.'); }
  var counts = { sourceRows: models.reduce(function (total, model) { return total + model.counts.sourceRows; }, 0), companies: normalized.companies, companyUnknown: normalized.companyUnknown, emails: normalized.emailRows.length, phones: normalized.phoneCount, mobiles: normalized.mobiles, sharedEmails: normalized.sharedEmails, sharedPhones: normalized.sharedPhones, telegrams: normalized.telegrams, sharedTelegrams: normalized.sharedTelegrams };
  var first = models[0], email = { headers: PREPARED_DATA_HEADERS.email.slice(), rows: normalized.emailRows, sample: normalized.emailRows.slice(0, PREPARED_DATA_LIMITS.sampleRows) }, phone = { headers: PREPARED_DATA_HEADERS.phone.slice(), rows: normalized.phoneRows, sample: normalized.phoneRows.slice(0, PREPARED_DATA_LIMITS.sampleRows) };
  guard();
  return { complete: complete && models.length === selected.length, canConfirm: complete && models.length === selected.length && models.some(function (model) { return model.source.rowCount > 0 && model.source.columnCount > 0; }), fingerprint: preparedDataDigest_(JSON.stringify({ version: 2, fileId: fileId, section: section, sourceSheets: sourceSheets.map(function (sheet) { return sheet.sheetId; }), models: models.map(function (model) { return model.fingerprint; }) })), counts: counts, records: records, models: models, sourceSheets: sourceSheets, sourceSheetIds: sourceSheets.map(function (sheet) { return sheet.sheetId; }), email: email, phone: phone, emailHeaders: email.headers, emailRows: email.rows, phoneHeaders: phone.headers, phoneRows: phone.rows, warnings: warnings, cellsRead: cells, contactIndex: normalized.contactIndex, observations: observations, source: first ? first.source : null, sourceValues: first ? first.sourceValues : [], sourceDisplayValues: first ? first.sourceDisplayValues : [], sourceLinks: first ? first.sourceLinks : [], formulaSnapshots: first ? first.formulaSnapshots : [], sourceRows: physicalRows, sourceCols: first ? first.sourceCols : 0, previewSheets: [{ name: 'Исходная база', headers: first ? first.source.headers : [], sample: first ? first.source.sample : [], rowCount: physicalRows }, { name: 'Email', headers: email.headers, sample: email.sample, rowCount: email.rows.length + 1 }, { name: 'Телефоны', headers: phone.headers, sample: phone.sample, rowCount: phone.rows.length + 1 }] };
}
function preparedDataRowList_(rows) {
  rows.sort(function (a, b) { return a - b; });
  var parts = [], first = null, previous = null;
  rows.forEach(function (row) { if (first === null) first = previous = row; else if (row === previous + 1) previous = row; else { parts.push(first === previous ? String(first) : first + '–' + previous); first = previous = row; } });
  if (first !== null) parts.push(first === previous ? String(first) : first + '–' + previous);
  return parts.join(', ');
}
function preparedDataFit_(value, warn) {
  if (value.length <= PREPARED_DATA_LIMITS.maxCellCharacters) return value;
  warn('У некоторых контактов слишком много связей для одной ячейки. Список сокращён; все исходные данные сохранены на первом листе.');
  return value.slice(0, PREPARED_DATA_LIMITS.maxCellCharacters - 80) + '… Подробности — в исходной базе.';
}
