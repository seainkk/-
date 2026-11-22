/** Bounded spreadsheet editing through the same authenticated, root-scoped transport. */
var GRID_EDITOR_LIMITS = Object.freeze({ readCells: 5000, writeCells: 5000, inputCharacters: 250000, readCharacters: 2000000, append: 1000, gridCells: 10000000, receiptLimit: 80, literalRuns: 1000 });

function getGridWorkbook_(request) {
  return api_(function () {
    var input = gridRequest_(request, ['id', 'includeInitialRange']);
    if (input.includeInitialRange !== undefined && typeof input.includeInitialRange !== 'boolean') fail_('INVALID_REQUEST', 'Некорректный запрос начального диапазона.');
    var scope = gridFile_(input.id, false), book = SpreadsheetApp.openById(scope.file.getId()), sheets = book.getSheets(), metadata = sheets.map(gridSheetMetadata_), initial = null;
    if (input.includeInitialRange && sheets.length) {
      var area = gridArea_({ row: 1, column: 1, rowCount: Math.min(80, metadata[0].rowCount), columnCount: Math.min(50, metadata[0].columnCount) }, GRID_EDITOR_LIMITS.readCells);
      gridCheckArea_(sheets[0], area);
      initial = gridRead_(scope.file.getId(), sheets[0], area);
    }
    var name = scope.file.getName();
    // Keep the final access check after all metadata and cell reads.
    scope = gridFile_(input.id, false, scope.context.rootId);
    var result = { id: scope.file.getId(), name: name, url: spreadsheetUrl_(scope.file.getId()), canEdit: scope.canEdit, sheets: metadata };
    if (input.includeInitialRange) {
      if (initial) initial.canEdit = scope.canEdit;
      result.initialRange = initial;
    }
    if (scope.canEdit && typeof contactSyncMailingStatusNeeded_ === 'function' && contactSyncMailingStatusNeeded_(scope.tags)) result.needsMailingStatus = true;
    return result;
  });
}

function getGridRange_(request) {
  return api_(function () {
    var input = gridRequest_(request, ['id', 'sheetId', 'row', 'column', 'rowCount', 'columnCount']);
    var area = gridArea_(input, GRID_EDITOR_LIMITS.readCells), scope = gridFile_(input.id, false);
    var sheet = gridSheet_(SpreadsheetApp.openById(scope.file.getId()), input.sheetId);
    gridCheckArea_(sheet, area);
    var result = gridRead_(scope.file.getId(), sheet, area);
    result.canEdit = gridFile_(input.id, false, scope.context.rootId).canEdit;
    return result;
  });
}

function saveGridRange_(request) {
  return api_(function () {
    var input = gridRequest_(request, ['id', 'sheetId', 'row', 'column', 'values', 'expected', 'requestId']);
    var prepared = gridValues_(input.values), expected = gridExpected_(input.expected, prepared.rows, prepared.columns);
    var area = gridArea_({ row: input.row, column: input.column, rowCount: prepared.rows, columnCount: prepared.columns }, GRID_EDITOR_LIMITS.writeCells);
    gridSheetId_(input.sheetId); gridRequestId_(input.requestId);
    return locked_(function () {
      var scope = gridFile_(input.id, true), sheet = gridSheet_(SpreadsheetApp.openById(scope.file.getId()), input.sheetId);
      gridCheckArea_(sheet, area);
      var fingerprint = digest_(JSON.stringify(['range', input.id, input.sheetId, area, input.values, expected]));
      var receipt = gridReceipt_(scope.context, input.requestId, fingerprint);
      gridFile_(input.id, false, scope.context.rootId);
      var before = gridRead_(input.id, sheet, area);
      if (receipt.value) {
        if (receipt.value.status === 'done') return gridSaved_(before, true);
        if (gridCanonicalHash_(sheet.getRange(area.row, area.column, area.rows, area.columns)) !== prepared.hash) fail_('GRID_UNCERTAIN', 'Результат предыдущего сохранения не подтверждён. Скопируйте свои правки и перечитайте диапазон; повторная запись автоматически не выполняется.');
        gridDone_(scope.context, receipt);
        return gridSaved_(before, true);
      }
      if (before.versions.some(function (row, y) { return row.some(function (version, x) { return version !== expected[y][x]; }); })) fail_('GRID_CONFLICT', 'Диапазон уже изменился в Google Таблице. Ваши правки сохранены в редакторе; скопируйте их и перечитайте ячейки.');
      gridAllocate_(scope.context, receipt, { kind: 'range', id: input.id, sheetId: input.sheetId, area: area });
      var mutationStarted = false;
      try {
        gridFile_(input.id, true, scope.context.rootId);
        mutationStarted = true;
        sheet.getRange(area.row, area.column, area.rows, area.columns).setValues(prepared.values);
        if (prepared.literalRuns.length) {
          gridFile_(input.id, true, scope.context.rootId);
          sheetWriteRawStrings_(input.id, sheet.getSheetId(), area.row, area.column, prepared.strings, prepared.stringMask);
        }
        gridFile_(input.id, false, scope.context.rootId);
        SpreadsheetApp.flush();
        gridDone_(scope.context, receipt);
        gridFile_(input.id, false, scope.context.rootId);
        return gridSaved_(gridRead_(input.id, sheet, area), false);
      } catch (error) {
        if (!mutationStarted && error && error.registryCode === 'GRID_READ_ONLY') throw error;
        if (error && ['LINK_ACCESS_REQUIRED', 'LINK_SETUP_REQUIRED', 'OUTSIDE_REGISTRY', 'GRID_PROTECTED'].indexOf(error.registryCode) !== -1) throw error;
        var diagnostic = error && error.sheetRawDiagnostic ? ' Причина: ' + error.sheetRawDiagnostic + '.' : '';
        fail_('GRID_UNCERTAIN', 'Google не подтвердил сохранение диапазона.' + diagnostic + ' Скопируйте правки перед перечитыванием; повторите тот же запрос, чтобы проверить его результат.');
      }
    });
  });
}

function appendGridRows_(request) { return gridAppend_(request, 'rows'); }
function appendGridColumns_(request) { return gridAppend_(request, 'columns'); }

function gridAppend_(request, kind) {
  return api_(function () {
    var dimensionKey = kind === 'rows' ? 'expectedRowCount' : 'expectedColumnCount';
    var input = gridRequest_(request, ['id', 'sheetId', 'count', dimensionKey, 'requestId']);
    gridSheetId_(input.sheetId); gridRequestId_(input.requestId);
    var count = gridInteger_(input.count, 1, GRID_EDITOR_LIMITS.append), expected = gridInteger_(input[dimensionKey], 1, GRID_EDITOR_LIMITS.gridCells);
    return locked_(function () {
      var scope = gridFile_(input.id, true), book = SpreadsheetApp.openById(scope.file.getId()), sheet = gridSheet_(book, input.sheetId);
      var fingerprint = digest_(JSON.stringify([kind, input.id, input.sheetId, count, expected])), receipt = gridReceipt_(scope.context, input.requestId, fingerprint);
      if (receipt.value) {
        if (receipt.value.status === 'done') return gridAppendResult_(input.id, sheet, true);
        fail_('GRID_UNCERTAIN', 'Предыдущее добавление строк или столбцов не подтверждено. Перечитайте таблицу и проверьте её размер; автоматическое повторное добавление заблокировано.');
      }
      var actual = kind === 'rows' ? sheet.getMaxRows() : sheet.getMaxColumns();
      if (actual !== expected) fail_('GRID_CONFLICT', 'Размер листа уже изменился. Перечитайте таблицу перед добавлением.');
      var addedCells = count * (kind === 'rows' ? sheet.getMaxColumns() : sheet.getMaxRows());
      var total = book.getSheets().reduce(function (sum, current) { return sum + current.getMaxRows() * current.getMaxColumns(); }, 0);
      if (total + addedCells > GRID_EDITOR_LIMITS.gridCells || (kind === 'columns' && actual + count > 18278)) fail_('GRID_LIMIT', 'Добавление превысит допустимый размер Google Таблицы.');
      gridAllocate_(scope.context, receipt, { kind: kind, id: input.id, sheetId: input.sheetId, before: actual, count: count });
      var mutationStarted = false;
      try {
        gridFile_(input.id, true, scope.context.rootId);
        mutationStarted = true;
        if (kind === 'rows') sheet.insertRowsAfter(actual, count); else sheet.insertColumnsAfter(actual, count);
        gridFile_(input.id, false, scope.context.rootId); SpreadsheetApp.flush();
        gridDone_(scope.context, receipt);
        gridFile_(input.id, false, scope.context.rootId);
        return gridAppendResult_(input.id, sheet, false);
      } catch (error) {
        if (!mutationStarted && error && error.registryCode === 'GRID_READ_ONLY') throw error;
        if (error && ['LINK_ACCESS_REQUIRED', 'LINK_SETUP_REQUIRED', 'OUTSIDE_REGISTRY', 'GRID_PROTECTED'].indexOf(error.registryCode) !== -1) throw error;
        fail_('GRID_UNCERTAIN', 'Google не подтвердил добавление. Перечитайте таблицу перед новым действием; слепой повтор заблокирован.');
      }
    });
  });
}

function gridRequest_(request, keys) {
  authorize_();
  var input = object_(request);
  if (Object.keys(input).some(function (key) { return keys.indexOf(key) === -1; })) fail_('INVALID_REQUEST', 'В запросе редактора есть неизвестные поля.');
  id_(input.id); return input;
}

function gridFile_(fileId, writable, expectedRoot) {
  var context = authorize_(), id = id_(fileId);
  if (expectedRoot && expectedRoot !== context.rootId) fail_('OUTSIDE_REGISTRY', 'Привязка реестра изменилась. Перечитайте таблицу.');
  var service = context.properties.getProperty('SOURCE_BASES_STORAGE_ID') || REGISTRY_CONFIG.defaultSourceBasesStorageId;
  if (id === service || id === REGISTRY_CONFIG.defaultSourceBasesStorageId) fail_('GRID_PROTECTED', 'Служебная таблица не открывается в редакторе баз.');
  var file = registryFile_(context, id), staging = context.properties.getProperty('PREPARED_STAGING_FOLDER_ID');
  if (staging && insideRegistry_(file, id_(staging))) fail_('GRID_PROTECTED', 'Черновик подготовки можно открыть после подтверждения и завершения создания базы.');
  var source = sourceBasesSource_(context), allowed = source.state === 'ready' && insideRegistry_(file, source.folder.getId());
  if (!allowed) {
    var outreach;
    try { outreach = segmentSourceFolder_(context); } catch (error) { if (error.registryCode === 'LINK_ACCESS_REQUIRED' || error.registryCode === 'LINK_SETUP_REQUIRED') throw error; }
    allowed = !!outreach && gridInsideSegment_(file, outreach.getId(), context);
  }
  if (!allowed) fail_('OUTSIDE_REGISTRY', 'Редактор работает только с исходными базами и таблицами внутри сегментов.');
  var metadata;
  try { metadata = Drive.Files.get(id, { fields: 'capabilities(canEdit),appProperties', supportsAllDrives: true }); }
  catch (error) { fail_('GRID_ACCESS_UNAVAILABLE', 'Не удалось проверить доступ и состояние таблицы. Повторите открытие через несколько секунд.'); }
  if (!metadata || typeof metadata !== 'object') fail_('GRID_ACCESS_UNAVAILABLE', 'Google не подтвердил состояние таблицы.');
  var tags = metadata.appProperties || {}, role = tags.registryPreparedRole;
  if ((role || tags.registryPreparedDraft) && (role !== 'output' || ['1', '2'].indexOf(tags.registryPreparedVersion) === -1 || tags.registryPreparedRoot !== context.rootId)) fail_('GRID_PROTECTED', 'Эта таблица ещё относится к служебной подготовке базы.');
  var canEdit = !!(metadata.capabilities && metadata.capabilities.canEdit === true);
  if (writable && !canEdit) fail_('GRID_READ_ONLY', 'Аккаунт сервиса не имеет подтверждённых прав редактора этой таблицы.');
  return { context: context, file: file, canEdit: canEdit, tags: tags };
}

function gridInsideSegment_(file, outreachId, context) {
  var queue = [file], visited = Object.create(null), examined = 0;
  while (queue.length) {
    var item = queue.shift(); if (visited[item.getId()]) continue; visited[item.getId()] = true;
    if (++examined > REGISTRY_CONFIG.maxAncestryNodes) return false;
    var parents = item.getParents();
    while (parents.hasNext()) {
      var parent = parents.next(); if (parent.isTrashed()) continue;
      if (parent.getId() === outreachId && item.getId() !== file.getId()) {
        if (context && typeof registryRequireSegment_ === 'function') registryRequireSegment_(context, item.getId());
        return true;
      }
      if (parent.getId() !== outreachId) queue.push(parent);
    }
  }
  return false;
}

function gridSheetMetadata_(sheet) { return { id: sheet.getSheetId(), name: sheet.getName(), rowCount: sheet.getMaxRows(), columnCount: sheet.getMaxColumns(), usedRows: sheet.getLastRow(), usedColumns: sheet.getLastColumn() }; }
function gridSheetId_(value) { if (!Number.isSafeInteger(value) || value < 0) fail_('INVALID_REQUEST', 'Некорректный идентификатор листа.'); return value; }
function gridSheet_(book, id) { gridSheetId_(id); var sheet = book.getSheets().filter(function (candidate) { return candidate.getSheetId() === id; })[0]; if (!sheet) fail_('GRID_SHEET_MISSING', 'Лист больше не существует. Перечитайте таблицу.'); return sheet; }
function gridInteger_(value, minimum, maximum) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail_('GRID_LIMIT', 'Размер диапазона или количество строк некорректно.'); return value; }
function gridArea_(input, maximum) { var area = { row: gridInteger_(input.row, 1, GRID_EDITOR_LIMITS.gridCells), column: gridInteger_(input.column, 1, 18278), rows: gridInteger_(input.rowCount, 1, maximum), columns: gridInteger_(input.columnCount, 1, maximum) }; if (area.rows * area.columns > maximum) fail_('GRID_LIMIT', 'Выберите меньший диапазон ячеек.'); return area; }
function gridCheckArea_(sheet, area) { if (area.row + area.rows - 1 > sheet.getMaxRows() || area.column + area.columns - 1 > sheet.getMaxColumns()) fail_('GRID_BOUNDS', 'Диапазон выходит за границы листа. Сначала добавьте строки или столбцы.'); }

function gridCanonical_(value, formula) {
  if (formula) return ['formula', formula];
  if (Object.prototype.toString.call(value) === '[object Date]') return ['date', value.getTime()];
  return [typeof value, value === null || value === undefined ? '' : value];
}
function gridCanonicalHash_(range) { var values = range.getValues(), formulas = range.getFormulas(); return digest_(JSON.stringify(values.map(function (row, y) { return row.map(function (value, x) { return gridCanonical_(value, formulas[y][x]); }); }))); }

function gridInput_(value) {
  if (value.charAt(0) === "'") return { value: value, canonical: ['string', value.slice(1)], literal: value.slice(1) };
  if (value.charAt(0) === '=') return { value: value, canonical: ['formula', value] };
  if (/^(?:TRUE|FALSE)$/i.test(value)) return { value: /^TRUE$/i.test(value), canonical: ['boolean', /^TRUE$/i.test(value)] };
  if (/^[+-]?(?:0|[1-9]\d{0,8})(?:[.,]\d+)?$/.test(value) && !/^\+\d{8,}/.test(value)) { var number = Number(value.replace(',', '.')); if (Number.isFinite(number)) return { value: number, canonical: ['number', number] }; }
  if (/^[+-]?(?:\d+(?:[.]\d+)?)[eE][+-]?\d+$/.test(value)) { var scientific = Number(value); if (Number.isFinite(scientific)) return { value: scientific, canonical: ['number', scientific] }; }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) { var date = new Date(value); if (Number.isFinite(date.getTime())) return { value: date, canonical: ['date', date.getTime()] }; }
  return { value: value, canonical: ['string', value] };
}

/** Formula strings and quoted sheet names do not invoke cross-document functions. */
function gridExternalFormula_(formula) {
  var visible = '', quote = '';
  for (var index = 0; index < formula.length; index++) {
    var character = formula.charAt(index);
    if (quote) {
      if (character === quote) { if (formula.charAt(index + 1) === quote) index++; else quote = ''; }
      continue;
    }
    if (character === '"' || character === "'") { quote = character; visible += ' '; }
    else visible += character;
  }
  return /\bIMPORTRANGE\s*\(/i.test(visible);
}

function gridValues_(values) {
  if (!Array.isArray(values) || !values.length || !Array.isArray(values[0]) || !values[0].length) fail_('INVALID_REQUEST', 'Передайте прямоугольный диапазон значений.');
  var rows = values.length, columns = values[0].length, characters = 0, literals = [], canonical = [], strings = [], stringMask = [];
  if (rows * columns > GRID_EDITOR_LIMITS.writeCells) fail_('GRID_LIMIT', 'За одно сохранение можно изменить не более 5000 ячеек.');
  var prepared = values.map(function (row, y) {
    if (!Array.isArray(row) || row.length !== columns) fail_('INVALID_REQUEST', 'Диапазон значений должен быть прямоугольным.');
    canonical[y] = []; strings[y] = []; stringMask[y] = []; var lastRun = null;
    return row.map(function (input, x) {
      if (typeof input !== 'string' || input.length > 50000 || /\u0000/.test(input)) fail_('INVALID_REQUEST', 'Ячейка содержит недопустимое значение.');
      if (input.charAt(0) === '=' && gridExternalFormula_(input)) fail_('GRID_FORMULA_UNSUPPORTED', 'Межфайловые подключения настраиваются в Google Таблицах по ссылке.');
      characters += input.length; if (characters > GRID_EDITOR_LIMITS.inputCharacters) fail_('GRID_LIMIT', 'Вставляемый текст слишком большой. Разделите его на меньшие диапазоны.');
      var typed = gridInput_(input); canonical[y][x] = typed.canonical;
      if (typed.canonical[0] === 'string') {
        var text = typed.canonical[1]; strings[y][x] = text; stringMask[y][x] = true;
        if (!lastRun || lastRun.column + lastRun.texts.length !== x) { lastRun = { row: y, column: x, texts: [] }; literals.push(lastRun); }
        lastRun.texts.push(text);
        // Protect the first SDK write as well: no string is temporarily parsed
        // as a formula before the explicit RAW value is applied.
        return "'" + text;
      }
      strings[y][x] = ''; stringMask[y][x] = false;
      return typed.value;
    });
  });
  var groups = [], lastByShape = Object.create(null);
  literals.forEach(function (run) {
    var key = run.column + ':' + run.texts.length, previous = lastByShape[key];
    if (previous && previous.row + previous.values.length === run.row) previous.values.push(run.texts);
    else { previous = { row: run.row, column: run.column, values: [run.texts] }; lastByShape[key] = previous; groups.push(previous); }
  });
  if (groups.length > GRID_EDITOR_LIMITS.literalRuns) fail_('GRID_LIMIT', 'Слишком много раздельных текстовых диапазонов. Вставляйте меньшими частями.');
  return { rows: rows, columns: columns, values: prepared, strings: strings, stringMask: stringMask, literalRuns: groups, hash: digest_(JSON.stringify(canonical)) };
}

/**
 * Shared literal writer for generated tables and the editor. RichText setters
 * have native coercion for formula-like text; stringValue is unambiguously RAW.
 * Coordinates are ONE-BASED. False mask cells are never part of an API range.
 * The caller owns the scope/receipt; this helper never accepts an arbitrary URL.
 */
function sheetWriteRawStrings_(fileId, sheetId, row, column, values, mask, links) {
  authorize_(); id_(fileId); gridSheetId_(sheetId);
  gridInteger_(row, 1, GRID_EDITOR_LIMITS.gridCells); gridInteger_(column, 1, 18278);
  if (!Array.isArray(values) || !values.length || !Array.isArray(values[0]) || !values[0].length) fail_('INVALID_REQUEST', 'Некорректный текстовый диапазон.');
  var height = values.length, width = values[0].length, characters = 0, groups = [], lastByShape = Object.create(null);
  if (height * width > 50000 || column + width - 1 > 18278) fail_('GRID_LIMIT', 'Текстовый диапазон слишком большой.');
  if (mask && (!Array.isArray(mask) || mask.length !== height)) fail_('INVALID_REQUEST', 'Некорректная маска текстового диапазона.');
  if (links && (!Array.isArray(links) || links.length !== height)) fail_('INVALID_REQUEST', 'Некорректные ссылки текстового диапазона.');
  values.forEach(function (line, y) {
    if (!Array.isArray(line) || line.length !== width || (mask && (!Array.isArray(mask[y]) || mask[y].length !== width)) || (links && (!Array.isArray(links[y]) || links[y].length !== width))) fail_('INVALID_REQUEST', 'Текстовый диапазон должен быть прямоугольным.');
    var start = -1;
    for (var x = 0; x <= width; x++) {
      var active = x < width && (!mask || mask[y][x] === true);
      if (x < width && mask && typeof mask[y][x] !== 'boolean') fail_('INVALID_REQUEST', 'Некорректная маска текстового диапазона.');
      if (active) {
        if (typeof line[x] !== 'string' || line[x].length > 50000 || /\u0000/.test(line[x])) fail_('INVALID_REQUEST', 'Недопустимое текстовое значение.');
        characters += line[x].length;
        if (characters > 5000000) fail_('GRID_LIMIT', 'В текстовом диапазоне слишком много данных.');
        if (links) {
          var link = links[y][x];
          if (typeof link !== 'string' || (link && (link.length > 4000 || /[\u0000-\u001f]/.test(link) || !/^(?:https?:\/\/|mailto:|tel:)/i.test(link)))) fail_('INVALID_REQUEST', 'Недопустимая ссылка ячейки.');
        }
        if (start < 0) start = x;
      }
      if ((!active || x === width) && start >= 0) {
        var key = start + ':' + (x - start), previous = lastByShape[key];
        if (previous && previous.row + previous.height === y) previous.height++;
        else { previous = { row: y, column: start, height: 1, width: x - start }; groups.push(previous); lastByShape[key] = previous; }
        start = -1;
      }
    }
  });
  if (!groups.length) return { spreadsheetId: fileId, requests: 0 };
  if (groups.length > 1000) fail_('GRID_LIMIT', 'Слишком много раздельных текстовых диапазонов.');
  var requests = groups.map(function (group) {
    var rows = [];
    for (var y = group.row; y < group.row + group.height; y++) {
      var cells = [];
      for (var x = group.column; x < group.column + group.width; x++) {
        var text = values[y][x], uri = links && links[y][x];
        var cell = { userEnteredValue: { stringValue: text }, textFormatRuns: [], userEnteredFormat: { textFormat: {} } };
        if (uri && text) cell.textFormatRuns = [{ startIndex: 0, format: { link: { uri: uri } } }];
        cells.push(cell);
      }
      rows.push({ values: cells });
    }
    return { updateCells: { range: { sheetId: sheetId, startRowIndex: row - 1 + group.row, endRowIndex: row - 1 + group.row + group.height, startColumnIndex: column - 1 + group.column, endColumnIndex: column - 1 + group.column + group.width }, rows: rows, fields: 'userEnteredValue,textFormatRuns,userEnteredFormat.textFormat.link' } };
  });
  return sheetRawBatchWrite_(fileId, requests);
}

/** Sparse formula snapshots stay literal without one Sheets API call per cell. */
function sheetWriteRawStringCells_(fileId, sheetId, cells, guard) {
  authorize_(); id_(fileId); gridSheetId_(sheetId);
  if (!Array.isArray(cells) || cells.length > 1000 || guard !== undefined && typeof guard !== 'function') fail_('INVALID_REQUEST', 'Некорректный список текстовых ячеек.');
  var characters = 0, seen = Object.create(null), sorted = cells.slice();
  sorted.forEach(function (cell) {
    if (!cell || typeof cell !== 'object') fail_('INVALID_REQUEST', 'Некорректная текстовая ячейка.');
    gridInteger_(cell.row, 1, GRID_EDITOR_LIMITS.gridCells); gridInteger_(cell.column, 1, 18278);
    if (typeof cell.value !== 'string' || cell.value.length > 50000 || /\u0000/.test(cell.value)) fail_('INVALID_REQUEST', 'Недопустимое текстовое значение.');
    characters += cell.value.length; if (characters > 5000000) fail_('GRID_LIMIT', 'В текстовых ячейках слишком много данных.');
    var link = cell.link === undefined ? '' : cell.link;
    if (typeof link !== 'string' || link.length > 4000 || /[\u0000-\u001f]/.test(link) || link && !/^(?:https?:\/\/|mailto:|tel:)/i.test(link)) fail_('INVALID_REQUEST', 'Недопустимая ссылка ячейки.');
    var key = cell.row + ':' + cell.column; if (seen[key]) fail_('INVALID_REQUEST', 'Текстовая ячейка указана повторно.'); seen[key] = true;
  });
  sorted.sort(function (a, b) { return a.column - b.column || a.row - b.row; });
  var requests = [];
  sorted.forEach(function (source) {
    var cell = { userEnteredValue: { stringValue: source.value }, textFormatRuns: [], userEnteredFormat: { textFormat: {} } };
    if (source.link && source.value) cell.textFormatRuns = [{ startIndex: 0, format: { link: { uri: source.link } } }];
    var last = requests[requests.length - 1], previous = last && last.updateCells;
    if (previous && previous.range.startColumnIndex === source.column - 1 && previous.range.endRowIndex === source.row - 1) { previous.range.endRowIndex++; previous.rows.push({ values: [cell] }); }
    else requests.push({ updateCells: { range: { sheetId: sheetId, startRowIndex: source.row - 1, endRowIndex: source.row, startColumnIndex: source.column - 1, endColumnIndex: source.column }, rows: [{ values: [cell] }], fields: 'userEnteredValue,textFormatRuns,userEnteredFormat.textFormat.link' } });
  });
  return sheetRawBatchWrite_(fileId, requests, guard);
}

function sheetRawBatchWrite_(fileId, requests, guard) {
  if (!requests.length) return { spreadsheetId: fileId, requests: 0 };
  if (guard) guard();
  // Make SDK-created sheets/grid sizes visible and prevent queued SDK writes
  // from overwriting the subsequent explicit Sheets API values.
  SpreadsheetApp.flush(); authorize_();
  if (guard) guard();
  if (typeof Sheets === 'undefined' || !Sheets.Spreadsheets || typeof Sheets.Spreadsheets.batchUpdate !== 'function') sheetRawFailure_('ADVANCED_SERVICE_UNAVAILABLE');
  var result;
  try {
    result = Sheets.Spreadsheets.batchUpdate({ requests: requests }, fileId);
  } catch (error) { sheetRawFailure_(sheetRawServiceReason_(error)); }
  if (!result || result.spreadsheetId !== fileId || !Array.isArray(result.replies) || result.replies.length !== requests.length) sheetRawFailure_('INCOMPLETE_ACKNOWLEDGEMENT');
  if (guard) guard();
  return { spreadsheetId: fileId, requests: requests.length };
}

/** Return only controlled diagnostic labels; never echo provider text or IDs. */
function sheetRawServiceReason_(error) {
  var details = error && error.details && typeof error.details === 'object' ? error.details : {};
  var data = details.error && typeof details.error === 'object' ? details.error : details;
  var code = Number(data.code || (error && error.code)), labels = [], reason = '';
  if (Array.isArray(data.details)) data.details.forEach(function (item) { if (item && typeof item.reason === 'string') labels.push(item.reason); });
  if (Array.isArray(data.errors)) data.errors.forEach(function (item) { if (item && typeof item.reason === 'string') labels.push(item.reason); });
  labels.push(typeof data.status === 'string' ? data.status : '');
  var joined = labels.join('|'), message = typeof data.message === 'string' ? data.message.slice(0, 4096) : (error && typeof error.message === 'string' ? error.message.slice(0, 4096) : '');
  if (/SERVICE_DISABLED|API_DISABLED|accessNotConfigured/i.test(joined) || /has not been used|api[^.]*is disabled|service[^.]*disabled/i.test(message)) reason = 'SERVICE_DISABLED';
  else if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions|insufficientAuthenticationScopes/i.test(joined) || /insufficient authentication scopes|required permissions|authorization is required|not authorized to call/i.test(message)) reason = 'INSUFFICIENT_SCOPES';
  else if (/RATE_LIMIT|QUOTA_EXCEEDED|rateLimitExceeded|dailyLimitExceeded/i.test(joined) || code === 429) reason = 'RATE_LIMITED';
  else if (/invalid[^.]{0,120}field|unknown name|cannot find field|field mask/i.test(message)) reason = 'INVALID_FIELD_MASK';
  else if (/beyond (?:max|the)|exceeds grid limits|out of bounds/i.test(message)) reason = 'GRID_BOUNDS';
  else if (code === 400 || /INVALID_ARGUMENT/i.test(joined)) reason = 'INVALID_ARGUMENT';
  else if (code === 403 || /PERMISSION_DENIED|forbidden|accessDenied/i.test(joined) || /caller does not have permission|permission denied|do not have permission/i.test(message)) reason = 'PERMISSION_DENIED';
  else if (code === 401) reason = 'AUTH_REQUIRED';
  else if (code === 404) reason = 'NOT_FOUND';
  else if (code >= 500) reason = 'GOOGLE_UNAVAILABLE';
  else reason = 'ADVANCED_SERVICE_ERROR';
  return (Number.isInteger(code) && code >= 100 && code <= 599 ? 'HTTP ' + code + ', ' : '') + reason;
}

function sheetRawFailure_(diagnostic) {
  var error = registryError_('SHEETS_RAW_UNCERTAIN', 'Google не подтвердил точную запись текста (' + diagnostic + '). Проверьте результат и подключение Google Sheets API.');
  error.sheetRawDiagnostic = diagnostic;
  throw error;
}

function gridExpected_(expected, rows, columns) {
  if (!Array.isArray(expected) || expected.length !== rows || expected.some(function (row) { return !Array.isArray(row) || row.length !== columns || row.some(function (version) { return typeof version !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(version); }); })) fail_('INVALID_REQUEST', 'Сначала прочитайте текущие версии всех изменяемых ячеек.');
  return expected;
}

function gridRead_(id, sheet, area) {
  var range = sheet.getRange(area.row, area.column, area.rows, area.columns), values = range.getValues(), formulas = range.getFormulas(), display = range.getDisplayValues(), characters = 0;
  var versions = [], versionCache = Object.create(null), inputs = values.map(function (row, y) {
    versions[y] = [];
    return row.map(function (value, x) {
      var formula = formulas[y][x], canonical = gridCanonical_(value, formula), input;
      var canonicalKey = JSON.stringify(canonical);
      if (!Object.prototype.hasOwnProperty.call(versionCache, canonicalKey)) versionCache[canonicalKey] = digest_(canonicalKey);
      versions[y][x] = versionCache[canonicalKey];
      if (formula) input = formula;
      else if (Object.prototype.toString.call(value) === '[object Date]') input = value.toISOString();
      else if (typeof value === 'string') { input = value; if (gridInput_(value).canonical[0] !== 'string' || /^[=']/.test(value)) input = "'" + value; }
      else input = value === null || value === undefined ? '' : String(value);
      characters += input.length + String(display[y][x] || '').length;
      if (characters > GRID_EDITOR_LIMITS.readCharacters) fail_('GRID_LIMIT', 'В диапазоне слишком много текста. Откройте меньший диапазон.');
      return input;
    });
  });
  return { id: id, sheetId: sheet.getSheetId(), row: area.row, column: area.column, rowCount: area.rows, columnCount: area.columns, totalRows: sheet.getMaxRows(), totalColumns: sheet.getMaxColumns(), values: display, inputs: inputs, versions: versions };
}

function gridSaved_(range, recovered) { range.state = 'saved'; range.recovered = recovered; return range; }
function gridAppendResult_(id, sheet, recovered) { return { state: 'saved', recovered: recovered, id: id, sheetId: sheet.getSheetId(), rowCount: sheet.getMaxRows(), columnCount: sheet.getMaxColumns() }; }
function gridRequestId_(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) fail_('INVALID_REQUEST', 'Не определён идентификатор сохранения. Повторите действие из редактора.'); return value; }

function gridReceipt_(context, requestId, fingerprint) {
  var key = 'GRID_' + digest_(context.rootId + '|' + requestId).slice(0, 32), raw = context.properties.getProperty(key), value = null;
  if (raw) {
    try { value = JSON.parse(raw); } catch (error) { fail_('GRID_UNCERTAIN', 'Повреждена запись предыдущего сохранения. Перечитайте таблицу.'); }
    if (!value || value.version !== 1 || ['pending', 'done'].indexOf(value.status) === -1) fail_('GRID_UNCERTAIN', 'Запись сохранения требует проверки.');
    if (value.fingerprint !== fingerprint) fail_('REQUEST_REUSED', 'Идентификатор сохранения уже использован с другими данными.');
  }
  return { key: key, fingerprint: fingerprint, value: value };
}

function gridAllocate_(context, receipt, metadata) {
  var key = 'GRID_RECEIPT_INDEX', raw = context.properties.getProperty(key), index;
  try { index = raw ? JSON.parse(raw) : []; } catch (error) { fail_('GRID_UNCERTAIN', 'Журнал сохранений требует проверки.'); }
  if (!Array.isArray(index) || index.some(function (entry) { return typeof entry !== 'string' || !/^GRID_[A-Za-z0-9_-]{32}$/.test(entry); })) fail_('GRID_UNCERTAIN', 'Журнал сохранений повреждён.');
  index = index.filter(function (entry) { return entry !== receipt.key; });
  while (index.length >= GRID_EDITOR_LIMITS.receiptLimit) {
    var removable = -1;
    for (var n = 0; n < index.length; n++) {
      var stored = context.properties.getProperty(index[n]), saved;
      if (!stored) { removable = n; break; }
      try { saved = JSON.parse(stored); } catch (error) { fail_('GRID_UNCERTAIN', 'Повреждена запись прежнего сохранения. Журнал требует проверки.'); }
      if (!saved || saved.version !== 1 || ['pending', 'done'].indexOf(saved.status) === -1 || typeof saved.fingerprint !== 'string') fail_('GRID_UNCERTAIN', 'Не удалось подтвердить состояние прежнего сохранения.');
      if (saved.status === 'done') { removable = n; break; }
    }
    if (removable < 0) fail_('GRID_JOURNAL_LIMIT', 'Слишком много неподтверждённых сохранений. Проверьте их результаты перед новыми изменениями.');
    context.properties.deleteProperty(index.splice(removable, 1)[0]);
  }
  receipt.value = { version: 1, status: 'pending', fingerprint: receipt.fingerprint, metadata: metadata, createdAt: new Date().toISOString() };
  index.push(receipt.key);
  context.properties.setProperty(key, JSON.stringify(index));
  context.properties.setProperty(receipt.key, JSON.stringify(receipt.value));
}

function gridDone_(context, receipt) {
  receipt.value.status = 'done'; receipt.value.finishedAt = new Date().toISOString();
  try { context.properties.setProperty(receipt.key, JSON.stringify(receipt.value)); } catch (error) { console.warn('Grid save completed; durable completion receipt could not be updated.'); }
}
