/**
 * Standalone Apps Script web app. Every remote operation verifies the signed-in
 * user and the item's actual Drive ancestry. Drive/Sheets OAuth scopes cover the
 * user's Drive broadly; the application restricts operations to its registry.
 */
function doGet() {
  try {
    authorize_();
    return HtmlService.createTemplateFromFile('Index').evaluate().setTitle(REGISTRY_CONFIG.title);
  } catch (error) {
    var message = error && error.registryCode ? error.message.replace(/^\[[A-Z_]+\]\s*/, '') : 'Не удалось открыть приложение. Обратитесь к администратору.';
    return HtmlService.createHtmlOutput('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Реестр баз</title><body style="font:16px/1.6 system-ui;margin:40px;max-width:650px"><h1>Реестр баз</h1><p>' + escapeHtml_(message) + '</p></body></html>');
  }
}

function include_(name) {
  if (['Styles', 'Client'].indexOf(name) === -1) fail_('INVALID_REQUEST', 'Неизвестный компонент интерфейса.');
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function getBootstrap() {
  return api_(function () {
    var context = authorize_();
    var root = registryRoot_(context);
    var folders = [], files = [], visited = {}, count = 0;
    function visit(folder, depth) {
      if (visited[folder.getId()]) return;
      if (depth > REGISTRY_CONFIG.maxTreeDepth) fail_('REGISTRY_LIMIT', 'Слишком много уровней папок. Откройте нужную базу в Google Диске.');
      visited[folder.getId()] = true;
      var fileIterator = folder.getFilesByType(REGISTRY_CONFIG.spreadsheetMime);
      while (fileIterator.hasNext()) {
        var file = fileIterator.next();
        if (file.isTrashed()) continue;
        count++;
        if (count > REGISTRY_CONFIG.maxTreeEntries) fail_('REGISTRY_LIMIT', 'Реестр превышает лимит первой версии: 500 папок и баз.');
        files.push({ id: file.getId(), name: file.getName(), parentId: folder.getId(), url: spreadsheetUrl_(file.getId()) });
      }
      var folderIterator = folder.getFolders();
      while (folderIterator.hasNext()) {
        var child = folderIterator.next();
        if (child.isTrashed() || visited[child.getId()]) continue;
        count++;
        if (count > REGISTRY_CONFIG.maxTreeEntries) fail_('REGISTRY_LIMIT', 'Реестр превышает лимит первой версии: 500 папок и баз.');
        folders.push({ id: child.getId(), name: child.getName(), parentId: folder.getId() });
        visit(child, depth + 1);
      }
    }
    visit(root, 0);
    folders.sort(byName_);
    files.sort(byName_);
    return { user: { email: context.email, isAdmin: context.isAdmin }, registry: { id: root.getId(), name: root.getName() }, folders: folders, files: files, limits: { rows: REGISTRY_CONFIG.maxWindowRows, columns: REGISTRY_CONFIG.maxWindowColumns } };
  });
}

function loadTable(request) {
  return api_(function () {
    var context = authorize_();
    var input = object_(request);
    var file = registryFile_(context, input.fileId);
    var book = SpreadsheetApp.openById(file.getId());
    var sheet = selectedSheet_(book, input.sheetId);
    var startRow = positiveInteger_(input.startRow === undefined ? 1 : input.startRow, 'Номер строки');
    var startColumn = positiveInteger_(input.startColumn === undefined ? 1 : input.startColumn, 'Номер столбца');
    var rowCount = windowSize_(input.rowCount, REGISTRY_CONFIG.maxWindowRows);
    var columnCount = windowSize_(input.columnCount, REGISTRY_CONFIG.maxWindowColumns);
    var gridRows = sheet.getMaxRows(), gridColumns = sheet.getMaxColumns();
    if (startRow > gridRows || startColumn > gridColumns) fail_('INVALID_RANGE', 'Выбранная область находится за границей листа.');
    rowCount = Math.min(rowCount, gridRows - startRow + 1);
    columnCount = Math.min(columnCount, gridColumns - startColumn + 1);
    var range = sheet.getRange(startRow, startColumn, rowCount, columnCount);
    var display = range.getDisplayValues(), values = range.getValues(), formulas = range.getFormulas();
    var inputs = [], revisions = [];
    for (var row = 0; row < rowCount; row++) {
      inputs[row] = []; revisions[row] = [];
      for (var column = 0; column < columnCount; column++) {
        inputs[row][column] = editableValue_(values[row][column], formulas[row][column], display[row][column]);
        revisions[row][column] = revision_(values[row][column], formulas[row][column]);
      }
    }
    return { fileId: file.getId(), fileName: file.getName(), url: spreadsheetUrl_(file.getId()), sheets: book.getSheets().map(function (item) { return { id: item.getSheetId(), name: item.getName() }; }), sheetId: sheet.getSheetId(), sheetName: sheet.getName(), startRow: startRow, startColumn: startColumn, gridRows: gridRows, gridColumns: gridColumns, values: display, inputs: inputs, revisions: revisions };
  });
}

function writeCell(request) {
  return api_(function () {
    var context = authorize_();
    var input = object_(request);
    var row = positiveInteger_(input.row, 'Номер строки'), column = positiveInteger_(input.column, 'Номер столбца');
    if (typeof input.value !== 'string' || input.value.length > REGISTRY_CONFIG.maxCellLength) fail_('INVALID_VALUE', 'Значение ячейки должно содержать не более 5000 символов.');
    if (typeof input.expected !== 'string' || !input.expected || input.expected.length > 200) fail_('INVALID_REQUEST', 'Сначала обновите данные выбранной ячейки.');
    return locked_(function () {
      var file = registryFile_(context, input.fileId);
      var book = SpreadsheetApp.openById(file.getId());
      var sheet = selectedSheet_(book, input.sheetId);
      var rows = sheet.getMaxRows(), columns = sheet.getMaxColumns();
      if (row > rows + REGISTRY_CONFIG.maxExtraRows || column > columns + REGISTRY_CONFIG.maxExtraColumns) fail_('INVALID_RANGE', 'Выбранная ячейка слишком далеко за границей листа.');
      var exists = row <= rows && column <= columns;
      var cell = exists ? sheet.getRange(row, column) : null;
      var currentRevision = cell ? revision_(cell.getValue(), cell.getFormula()) : revision_('', '');
      if (currentRevision !== input.expected) fail_('CONFLICT', 'Эту ячейку уже изменили. Обновите таблицу перед повторным редактированием.');
      if (!exists) {
        var finalRows = Math.max(row, rows), finalColumns = Math.max(column, columns);
        var total = book.getSheets().reduce(function (sum, item) { return sum + item.getMaxRows() * item.getMaxColumns(); }, 0);
        if (total - rows * columns + finalRows * finalColumns > REGISTRY_CONFIG.maxGridCells) fail_('GRID_LIMIT', 'Достигнут лимит размера Google Таблицы.');
        if (row > rows) sheet.insertRowsAfter(rows, row - rows);
        if (column > columns) sheet.insertColumnsAfter(columns, column - columns);
        cell = sheet.getRange(row, column);
      }
      if (input.value === '') cell.clearContent();
      else if (input.value.charAt(0) === '=') cell.setFormula(input.value);
      else cell.setValue(typedValue_(input.value));
      SpreadsheetApp.flush();
      var value = cell.getValue(), formula = cell.getFormula(), display = cell.getDisplayValue();
      return { row: row, column: column, display: display, input: editableValue_(value, formula, display), revision: revision_(value, formula), gridRows: sheet.getMaxRows(), gridColumns: sheet.getMaxColumns() };
    });
  });
}

function createBase(request) {
  return api_(function () {
    var context = authorize_(), input = object_(request), name = itemName_(input.name);
    return locked_(function () {
      var folder = registryFolder_(context, input.parentId);
      return creation_(context, 'base', input.requestId, [folder.getId(), name], function () {
        var book = SpreadsheetApp.create(name);
        var file;
        try { file = DriveApp.getFileById(book.getId()); file.moveTo(folder); }
        catch (error) {
          if (!file) fail_('CREATION_UNCERTAIN', 'Таблица создана, но Google Диск не подтвердил её перемещение. Проверьте файл: ' + spreadsheetUrl_(book.getId()));
          try { file.setTrashed(true); }
          catch (rollbackError) { fail_('CREATION_UNCERTAIN', 'Таблица создана, но не перемещена в папку реестра. Проверьте файл: ' + spreadsheetUrl_(file.getId())); }
          var reverted = registryError_('CREATE_FAILED', 'Не удалось сохранить базу в выбранной папке. Проверьте права на создание файлов.');
          reverted.creationReverted = true;
          throw reverted;
        }
        return { file: { id: file.getId(), name: file.getName(), parentId: folder.getId(), url: spreadsheetUrl_(file.getId()) } };
      });
    });
  });
}

function createFolder(request) {
  return api_(function () {
    var context = authorize_(), input = object_(request), name = itemName_(input.name);
    return locked_(function () {
      var parent = registryFolder_(context, input.parentId);
      return creation_(context, 'folder', input.requestId, [parent.getId(), name], function () {
        var folder = parent.createFolder(name);
        return { folder: { id: folder.getId(), name: folder.getName(), parentId: parent.getId() } };
      });
    });
  });
}

function renameItem(request) {
  return api_(function () {
    var context = authorize_(), input = object_(request), name = itemName_(input.name);
    if (input.kind !== 'file' && input.kind !== 'folder') fail_('INVALID_REQUEST', 'Неизвестный тип объекта.');
    return locked_(function () {
      var item = input.kind === 'folder' ? registryFolder_(context, input.id) : registryFile_(context, input.id);
      if (item.getId() === context.rootId) fail_('ROOT_PROTECTED', 'Корневую папку реестра переименовывают через Google Диск.');
      item.setName(name);
      return { id: item.getId(), name: item.getName(), kind: input.kind };
    });
  });
}

function authorize_() {
  var properties = PropertiesService.getScriptProperties();
  var allowedRaw = properties.getProperty('ALLOWED_EMAILS');
  if (!allowedRaw) fail_('SETUP_REQUIRED', 'Приложение ещё не настроено. Обратитесь к администратору.');
  var email = normalizeEmail_(Session.getActiveUser().getEmail());
  var effective = normalizeEmail_(Session.getEffectiveUser().getEmail());
  if (!email || email !== effective) fail_('AUTH_REQUIRED', 'Войдите в разрешённый Google-аккаунт. Приложение должно выполняться от имени вошедшего пользователя.');
  if (emailList_(allowedRaw).indexOf(email) === -1) fail_('ACCESS_DENIED', 'У этого Google-аккаунта нет доступа к реестру. Обратитесь к администратору.');
  var rootId = properties.getProperty('ROOT_FOLDER_ID') || REGISTRY_CONFIG.defaultRootFolderId;
  id_(rootId);
  return { email: email, rootId: rootId, isAdmin: emailList_(properties.getProperty('ADMIN_EMAILS') || '').indexOf(email) !== -1, properties: properties };
}

function registryRoot_(context) {
  var folder = folderById_(context.rootId);
  if (folder.isTrashed()) fail_('NOT_FOUND', 'Папка реестра находится в корзине.');
  return folder;
}

function registryFolder_(context, folderId) {
  var folder = folderById_(id_(folderId));
  if (folder.isTrashed() || !insideRegistry_(folder, context.rootId)) fail_('OUTSIDE_REGISTRY', 'Эта папка не относится к выбранному реестру.');
  return folder;
}

function registryFile_(context, fileId) {
  var file;
  try { file = DriveApp.getFileById(id_(fileId)); }
  catch (error) { if (error.registryCode) throw error; fail_('NOT_FOUND', 'Таблица недоступна. Проверьте права Google Диска.'); }
  if (file.isTrashed() || file.getMimeType() !== REGISTRY_CONFIG.spreadsheetMime || !insideRegistry_(file, context.rootId)) fail_('OUTSIDE_REGISTRY', 'Эта таблица не относится к выбранному реестру.');
  return file;
}

function folderById_(folderId) {
  try { return DriveApp.getFolderById(id_(folderId)); }
  catch (error) { if (error.registryCode) throw error; fail_('NOT_FOUND', 'Папка недоступна. Проверьте права Google Диска.'); }
}

function insideRegistry_(item, rootId) {
  if (item.getId() === rootId) return true;
  var queue = [item], visited = {}, examined = 0;
  while (queue.length) {
    var current = queue.shift();
    if (visited[current.getId()]) continue;
    visited[current.getId()] = true;
    if (++examined > REGISTRY_CONFIG.maxAncestryNodes) return false;
    var parents = current.getParents();
    while (parents.hasNext()) {
      var parent = parents.next();
      if (parent.getId() === rootId) return !parent.isTrashed();
      if (!parent.isTrashed() && !visited[parent.getId()]) queue.push(parent);
    }
  }
  return false;
}

function selectedSheet_(book, sheetId) {
  var sheets = book.getSheets();
  if (!sheets.length) fail_('NOT_FOUND', 'В Google Таблице нет доступных листов.');
  if (sheetId === undefined || sheetId === null || sheetId === '') return sheets[0];
  var numericId = Number(sheetId);
  if (!Number.isInteger(numericId) || numericId < 0) fail_('INVALID_REQUEST', 'Некорректный идентификатор листа.');
  for (var index = 0; index < sheets.length; index++) if (sheets[index].getSheetId() === numericId) return sheets[index];
  fail_('NOT_FOUND', 'Выбранный лист больше не существует. Обновите таблицу.');
}

function creation_(context, kind, requestId, args, callback) {
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) fail_('INVALID_REQUEST', 'Не удалось определить запрос создания. Откройте форму ещё раз.');
  var key = 'CREATE_' + digest_(context.email + '|' + kind + '|' + requestId).slice(0,32);
  var fingerprint = JSON.stringify(args);
  var existing = context.properties.getProperty(key);
  if (existing) {
    var receipt;
    try { receipt = JSON.parse(existing); } catch (error) { fail_('CREATION_UNCERTAIN', 'Обновите реестр перед повторным созданием.'); }
    if (receipt.fingerprint !== fingerprint) fail_('REQUEST_REUSED', 'Этот запрос создания уже использован. Откройте форму ещё раз.');
    if (receipt.status === 'done') return receipt.result;
    fail_('CREATION_UNCERTAIN', 'Предыдущий запрос ещё не подтверждён. Обновите реестр перед повторным созданием, чтобы избежать дубликата.');
  }
  var index;
  try { index = JSON.parse(context.properties.getProperty('CREATE_RECEIPT_INDEX') || '[]'); } catch (error) { index = []; }
  if (!Array.isArray(index)) index = [];
  index = index.filter(function (entry) { return entry !== key; });
  while (index.length >= REGISTRY_CONFIG.creationReceiptLimit) context.properties.deleteProperty(index.shift());
  index.push(key);
  context.properties.setProperty('CREATE_RECEIPT_INDEX', JSON.stringify(index));
  context.properties.setProperty(key, JSON.stringify({ fingerprint: fingerprint, status: 'pending' }));
  try {
    var result = callback();
    var done = JSON.stringify({ fingerprint: fingerprint, status: 'done', result: result });
    try { context.properties.setProperty(key, done); } catch (storageError) { console.warn('Creation completed; receipt write failed.'); }
    try { CacheService.getUserCache().put(key, done, 21600); } catch (cacheError) { /* Durable receipt remains authoritative. */ }
    return result;
  } catch (error) {
    if (error.creationReverted) context.properties.deleteProperty(key);
    if (error.registryCode) throw error;
    fail_('CREATION_UNCERTAIN', 'Google не подтвердил создание. Сначала обновите реестр и проверьте папку на Диске.');
  }
}

function locked_(callback) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) fail_('BUSY', 'Сейчас выполняется другое сохранение. Повторите через несколько секунд.');
  try { return callback(); } finally { lock.releaseLock(); }
}

function revision_(value, formula) {
  var normalized = Object.prototype.toString.call(value) === '[object Date]' ? { date: value.toISOString() } : { type: typeof value, value: value };
  return digest_(JSON.stringify([normalized, formula || '']));
}

function digest_(value) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)).replace(/=+$/, '');
}

function editableValue_(value, formula, display) {
  if (formula) return formula;
  if (Object.prototype.toString.call(value) === '[object Date]') return String(display);
  if (value === null || value === undefined) return '';
  return String(value);
}

function typedValue_(value) {
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^[+-]?(?:(?:0|[1-9]\d*)(?:[.,]\d+)?|[.,]\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    var number = Number(value.replace(',', '.'));
    if (Number.isFinite(number) && (!Number.isInteger(number) || Number.isSafeInteger(number))) return number;
  }
  return value;
}

function itemName_(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\u0000-\u001f]/.test(value)) fail_('INVALID_NAME', 'Введите название от 1 до 100 символов без переносов строк.');
  return value.trim();
}
function id_(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{10,200}$/.test(value)) fail_('INVALID_ID', 'Некорректный идентификатор файла или папки.'); return value; }
function object_(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail_('INVALID_REQUEST', 'Некорректный запрос приложения.'); return value; }
function positiveInteger_(value, label) { if (!Number.isInteger(value) || value < 1 || value > 10000000) fail_('INVALID_RANGE', label + ' должен быть положительным целым числом.'); return value; }
function windowSize_(value, maximum) { if (value === undefined) return maximum; return Math.min(positiveInteger_(value, 'Размер области'), maximum); }
function normalizeEmail_(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
function emailList_(value) { var list; try { list = JSON.parse(value); } catch (error) { list = String(value).split(/[\s,;]+/); } if (!Array.isArray(list)) list = []; return list.map(normalizeEmail_).filter(function (email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }); }
function spreadsheetUrl_(fileId) { return 'https://docs.google.com/spreadsheets/d/' + id_(fileId) + '/edit'; }
function byName_(a, b) { return a.name.localeCompare(b.name, 'ru', { numeric: true }); }
function escapeHtml_(value) { return String(value).replace(/[&<>"']/g, function (character) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]; }); }
function registryError_(code, message) { var error = new Error('[' + code + '] ' + message); error.registryCode = code; return error; }
function fail_(code, message) { throw registryError_(code, message); }
function api_(callback) { try { return callback(); } catch (error) { if (error && error.registryCode) throw error; console.warn('Registry operation failed: ' + (error && error.name ? error.name : 'Error')); throw registryError_('GOOGLE_ERROR', 'Google отклонил операцию. Проверьте права на папку и таблицу, затем обновите данные.'); } }
