/**
 * Selected-sheet preparation. This module reads values and hyperlinks only;
 * its caller owns authorization, staging membership and every write.
 */
var PREPARED_DATA_LIMITS = Object.freeze({ maxRows: 50000, maxColumns: 100, maxCells: 1000000, chunkCells: 100000, maxMillis: 45000, maxContacts: 100000, maxCellCharacters: 45000, sampleRows: 8 });
var PREPARED_DATA_HEADERS = Object.freeze({
  email: ['Email', 'Компания / ЛПР', 'Исходные строки', 'Проверить принадлежность'],
  phone: ['Телефон', 'Компания / ЛПР', 'Откуда', 'Исходные строки', 'Проверить принадлежность']
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
  var limits = PREPARED_DATA_LIMITS, started = Date.now(), complete = true, warnings = [];
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
    if (Date.now() - started >= limits.maxMillis) { complete = false; warn('Не удалось полностью прочитать лист за отведённое время. Повторите предпросмотр.'); break; }
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
    var reference = preparedDataFormulaReference_(cell.formula), url = reference ? String(values[reference.row - 1] && values[reference.row - 1][reference.column - 1] || '') : '';
    if (url) {
      var run = { start: 0, end: cell.display.length, url: url };
      links.push({ row: cell.row, column: cell.column, text: cell.display, runs: [run] }); cell.snapshot.link = url; cell.snapshot.links = [run];
    } else { complete = false; warn('Не удалось определить адрес одной из формул HYPERLINK. Проверьте её ссылку и повторите предпросмотр.'); }
  });
  var header = displays[0] || [], mapping = preparedDataMapping_(header), sourceRows = 0, firstData = 1, hasHeader = true;
  // A one-column contact list often has no header. This inference is limited
  // to an explicit email/phone/link in the first cell, never arbitrary IDs.
  if (width === 1 && header.length && !mapping.emailColumns.length && !mapping.phoneColumns.length && !mapping.companyColumns.length) {
    var first = String(header[0] || '').trim(), firstEmail = preparedDataEmails_(first), firstPhones = preparedDataPhones_(first), firstUrls = preparedDataTextUrls_(first);
    links.filter(function (cell) { return cell.row === 1 && cell.column === 1; }).forEach(function (cell) { cell.runs.forEach(function (link) { firstUrls.push(link.url); }); });
    var headerlessPhone = /^(?:\+\d[\d ()-]+|[78]\d{10})$/.test(first) && firstPhones.length === 1;
    if (firstEmail.length === 1 && firstEmail[0] === first.toLowerCase()) { mapping.emailColumns.push({ index: 0, label: 'Email' }); hasHeader = false; }
    else if (headerlessPhone || firstUrls.some(function (url) { return preparedDataUrlPhones_(url).length > 0; })) { if (headerlessPhone) mapping.phoneColumns.push({ index: 0, label: 'Телефон' }); hasHeader = false; }
    if (!hasHeader) { firstData = 0; header = ['Столбец A']; }
  }
  if (mapping.ambiguous.length) { complete = false; warn('Не удалось однозначно распознать контактные столбцы: ' + mapping.ambiguous.join(', ') + '. Проверьте названия столбцов.'); }
  var linkIndex = Object.create(null);
  links.forEach(function (cell) { linkIndex[cell.row + ':' + cell.column] = cell.runs; });
  for (var index = firstData; index < displays.length; index++) {
    var cells = displays[index];
    if (!cells.some(function (value) { return String(value).trim() !== ''; })) continue;
    sourceRows++;
    var observation = { localId: '', inn: '', name: '', identityAmbiguous: false, emails: [], phones: [], source: { sheetId: sheetId, sheetName: sheetName, row: index + 1 }, contexts: Object.create(null) };
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
    if (person.ambiguous) warn('В некоторых строках указано несколько ЛПР. Контакты сохранены при компании с отметкой для ручной проверки; люди не объединялись автоматически.');
    var personalContext = [observation.name, person.name].filter(Boolean).join(' — ') + (person.role ? ' (' + person.role + ')' : '');
    mapping.emailColumns.forEach(function (column) {
      var rawEmail = String(cells[column.index] || ''), emailValues = preparedDataEmails_(rawEmail), mailto = [];
      if (/^mailto:/i.test(rawEmail.trim())) mailto = mailto.concat(preparedDataMailto_(rawEmail.trim()));
      (linkIndex[(index + 1) + ':' + (column.index + 1)] || []).forEach(function (link) { mailto = mailto.concat(preparedDataMailto_(link.url)); });
      emailValues = preparedDataUnique_(emailValues.concat(mailto));
      if (contactPreviewHasValue_(rawEmail) && (!emailValues.length || (rawEmail.match(/@/g) || []).length > emailValues.length)) unparsed++;
      emailValues.forEach(function (email) { observation.emails.push(email); observation.contexts['email:' + email] = preparedDataPersonalColumn_(column.label, section) && person.name ? personalContext : context; });
    });
    mapping.phoneColumns.forEach(function (column) {
      var rawPhone = String(cells[column.index] || ''), withoutUrls = preparedDataPlainPhoneText_(rawPhone), phoneValues = preparedDataPhones_(withoutUrls);
      if (contactPreviewHasValue_(withoutUrls) && !phoneValues.length) unparsed++;
      phoneValues.forEach(function (phone) { phone.origin = 'Столбец «' + column.label + '»'; observation.phones.push(phone); observation.contexts['phone:' + phone.value] = preparedDataPersonalColumn_(column.label, section) && person.name ? personalContext : context; });
    });
    for (var columnIndex = 0; columnIndex < cells.length; columnIndex++) {
      var urls = preparedDataTextUrls_(cells[columnIndex]);
      (linkIndex[(index + 1) + ':' + (columnIndex + 1)] || []).forEach(function (link) { if (urls.indexOf(link.url) === -1) urls.push(link.url); });
      urls.forEach(function (url) {
        preparedDataUrlPhones_(url).forEach(function (phone) { observation.phones.push(phone); observation.contexts['phone:' + phone.value] = context || personalContext; });
      });
    }
    observed.push(observation);
  }
  var normalized = preparedDataAggregate_(observed, sourceId, warn);
  if (!mapping.companyColumns.length && !mapping.emailColumns.length && !mapping.phoneColumns.length && !normalized.emailRows.length && !normalized.phoneRows.length && sourceRows) {
    complete = false; warn('Не распознаны столбцы выбранного листа. Укажите понятные заголовки компании, email или телефонов и повторите предпросмотр.');
  }
  if (normalized.partial) { complete = false; warn('В исходнике слишком много контактов для одного полного предпросмотра. Разделите исходный лист.'); }
  if (unparsed) warn('В контактных столбцах есть значения, которые не удалось распознать (' + unparsed + '). Они сохранены в исходном листе; валидация контактов сейчас не выполняется.');
  if (normalized.companyUnknown) warn('У части строк не определена компания (' + normalized.companyUnknown + '). Контакты сохранены с отметкой для ручной проверки.');
  if (normalized.unknownPhones) warn('Часть номеров не имеет однозначного международного формата или типа. Они сохранены без предположения о стране и требуют дальнейшей обработки.');
  guard();
  var counts = { sourceRows: sourceRows, companies: normalized.companies, companyUnknown: normalized.companyUnknown, emails: normalized.emailRows.length, phones: normalized.phoneRows.length, mobiles: normalized.mobiles, sharedEmails: normalized.sharedEmails, sharedPhones: normalized.sharedPhones };
  var source = { sheetId: sheetId, name: sheetName, headers: header, hasHeader: hasHeader, rowCount: lastRow, columnCount: width, sample: displays.slice(firstData, firstData + limits.sampleRows) };
  var email = { headers: PREPARED_DATA_HEADERS.email.slice(), rows: normalized.emailRows, sample: normalized.emailRows.slice(0, limits.sampleRows) };
  var phone = { headers: PREPARED_DATA_HEADERS.phone.slice(), rows: normalized.phoneRows, sample: normalized.phoneRows.slice(0, limits.sampleRows) };
  var fingerprint = preparedDataDigest_(JSON.stringify({ version: 1, sourceId: sourceId, section: section, sheetId: sheetId, sheetName: sheetName, rows: lastRow, columns: width, values: values, display: displays, formulas: formulas, links: links }));
  return { complete: complete, canConfirm: complete && lastRow > 0 && width > 0, fingerprint: fingerprint, sourceHash: fingerprint, counts: counts, source: source, sourceRows: lastRow, sourceCols: width, sourceValues: values, sourceDisplayValues: displays, sourceLinks: links, formulaSnapshots: formulaSnapshots, email: email, phone: phone, emailHeaders: email.headers, emailRows: email.rows, phoneHeaders: phone.headers, phoneRows: phone.rows, warnings: warnings, cellsRead: cellsRead,
    previewSheets: [{ name: 'Исходная база', headers: header, sample: source.sample, rowCount: lastRow }, { name: 'Email', headers: email.headers, sample: email.sample, rowCount: email.rows.length + 1 }, { name: 'Телефоны', headers: phone.headers, sample: phone.sample, rowCount: phone.rows.length + 1 }] };
}

function preparedDataRectangle_(rows, height, width) { return Array.isArray(rows) && rows.length === height && rows.every(function (row) { return Array.isArray(row) && row.length === width; }); }
function preparedDataDigest_(value) { return digest_(value); }
function preparedDataLiteral_(value) { if (typeof value !== 'string') return value; return /^(?:'|\s*[=+\-@])/.test(value) ? "'" + value : value; }

function preparedDataMapping_(headers) {
  var existing = contactPreviewMapping_(headers), result = { companyColumns: existing.companyColumns, emailColumns: [], phoneColumns: [], personColumns: [], ambiguous: [] };
  headers.forEach(function (label, index) {
    var key = contactPreviewHeader_(String(label || '').replace(/\([^)]*не\s+провер[^)]*\)/gi, ''));
    if (/^(?:фио|фамилияимяотчество|руководитель|фиоруководителя|имя|фамилия|отчество|должность)$/.test(key) || /^(?:фио|должность)(?:лпр|маркетолога|руководителя)$/.test(key) || /^лпр(?:маркетинг|маркетолог|продажи|закупки)?$/.test(key)) result.personColumns.push({ index: index, label: String(label || ''), kind: /должност/.test(key) ? 'role' : key });
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
  return values.map(function (raw) { return preparedDataPhone_(raw, false); }).filter(Boolean);
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
  var urls = formattedTel.concat(text.match(/(?:https?:\/\/|tg:\/\/|viber:\/\/|tel:)[^\s<>"']+/gi) || []);
  if (/^(?:wa\.me|t\.me)\//i.test(text.trim())) urls.push('https://' + text.trim());
  return preparedDataUnique_(urls.map(function (url) { return url.replace(/[.,]+$/, ''); }));
}
function preparedDataStripUrls_(value) { return String(value || '').replace(/tel:\+?\d[\d ().-]{5,}\d(?:;ext=\d+)?/gi, '').replace(/(?:https?:\/\/|tg:\/\/|viber:\/\/|tel:)[^\s<>"']+/gi, '').replace(/(?:wa\.me|t\.me)\/[^\s<>"']+/gi, ''); }
function preparedDataPlainPhoneText_(value) { return preparedDataStripUrls_(value).replace(/[^\s,;<>"()[\]]*@[^\s,;<>"()[\]]*/g, ''); }
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
  var match = String(formula || '').match(/^\s*=\s*(?:HYPERLINK|ГИПЕРССЫЛКА)\s*\(\s*\$?([A-Z]+)\$?(\d+)\s*[,;]/i);
  if (!match) return null;
  var column = 0; match[1].toUpperCase().split('').forEach(function (letter) { column = column * 26 + letter.charCodeAt(0) - 64; });
  return { row: Number(match[2]), column: column };
}
function preparedDataUnique_(values) { return values.filter(function (value, index) { return values.indexOf(value) === index; }); }

function preparedDataAggregate_(observations, sourceId, warn) {
  var resolved = contactPreviewResolveOwners_(observations, sourceId), stores = { email: Object.create(null), phone: Object.create(null) }, total = 0, partial = false;
  observations.forEach(function (row, index) {
    var owner = resolved.byRow[index];
    var add = function (kind, value, phoneKind, origin) {
      var store = stores[kind];
      if (!Object.prototype.hasOwnProperty.call(store, value)) {
        if (total >= PREPARED_DATA_LIMITS.maxContacts) { partial = true; return; }
        store[value] = { value: value, kind: phoneKind, contexts: Object.create(null), owners: Object.create(null), unknown: false, personAmbiguous: false, rows: Object.create(null), origins: Object.create(null) }; total++;
      }
      var record = store[value];
      if (owner) record.owners[owner] = true; else record.unknown = true;
      if (row.personAmbiguous) record.personAmbiguous = true;
      var context = row.contexts[kind + ':' + value] || row.name || row.localId || row.inn;
      if (context) record.contexts[context] = true;
      record.rows[row.source.row] = true;
      if (origin) record.origins[origin] = true;
      if (phoneKind === 'mobile') record.kind = 'mobile';
    };
    row.emails.forEach(function (value) { add('email', value, '', ''); });
    row.phones.forEach(function (phone) { add('phone', phone.value, phone.kind, phone.origin); });
  });
  var sharedEmails = 0, sharedPhones = 0, mobiles = 0, unknownPhones = 0;
  var rows = function (kind) { return Object.keys(stores[kind]).sort().map(function (key) {
    var record = stores[kind][key], shared = Object.keys(record.owners).length > 1, review = shared || record.unknown || record.personAmbiguous;
    if (shared) { if (kind === 'email') sharedEmails++; else sharedPhones++; }
    if (kind === 'phone') { if (record.kind === 'mobile') mobiles++; if (record.kind === 'unknown') unknownPhones++; }
    var context = preparedDataFit_(Object.keys(record.contexts).join('; '), warn), sources = preparedDataFit_('Строки ' + preparedDataRowList_(Object.keys(record.rows).map(Number)), warn);
    return kind === 'email' ? [record.value, context, sources, review ? 'Да' : ''] : [record.value, context, Object.keys(record.origins).join('; '), sources, review ? 'Да' : ''];
  }); };
  var emailRows = rows('email'), phoneRows = rows('phone');
  return { emailRows: emailRows, phoneRows: phoneRows, companies: Object.keys(resolved.owners).length, companyUnknown: resolved.unresolvedRows, sharedEmails: sharedEmails, sharedPhones: sharedPhones, mobiles: mobiles, unknownPhones: unknownPhones, partial: partial };
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
