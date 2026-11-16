/**
 * Source-file metadata only. The only spreadsheet opened here is the fixed,
 * direct-root service book, after authorization and Drive ancestry checks.
 * Source files themselves are never opened, imported or edited by this module.
 */
var SOURCE_BASES_SCHEMA = Object.freeze({
  basesTab: 'SourceBases',
  basesHeaders: ['fileId', 'fileName', 'mimeType', 'url', 'format', 'status', 'formatCheck', 'revision', 'present', 'updatedAt', 'updatedBy', 'baseType', 'contents'],
  relationsTab: 'SourceBaseSegments',
  relationsHeaders: ['fileId', 'segmentId', 'createdAt', 'createdBy'],
  statuses: ['collection', 'ready', 'rework'],
  checks: ['unchecked', 'valid', 'invalid'],
  baseTypes: ['general', 'lpr', 'mixed'],
  contents: ['companies', 'lpr']
});

function getSourceBases() {
  return api_(function () {
    authorize_();
    return locked_(function () {
      var current = authorize_();
      var binding = sourceBasesSource_(current);
      if (binding.state !== 'ready') return sourceBasesResponse_(binding, null, [], false, false);
      // Discovery and applying its snapshot share one app lock, preventing an
      // older refresh from replacing a newer app refresh. A failed scan exits
      // before opening the service book and can never mark unseen files absent.
      var discovered = sourceBasesDiscover_(current, binding.folder);
      var storageDescriptor = null;
      try {
        var storage = sourceBasesStorage_(current);
        storageDescriptor = storage.public;
        var database = sourceBasesReadDatabase_(storage);
        var records = sourceBasesSync_(current, storage, database, discovered);
        var associations = sourceBasesAssociations_(database.relations, current);
        var items = discovered.map(function (file) { return sourceBaseItem_(file, records[file.id], associations); });
        return sourceBasesResponse_(binding, storage.public, items, true, true);
      } catch (error) {
        if (error.registryCode && ['AUTH_REQUIRED', 'ACCESS_DENIED', 'SETUP_REQUIRED', 'OUTSIDE_REGISTRY', 'BUSY'].indexOf(error.registryCode) !== -1) throw error;
        var descriptor = error.sourceStorage || storageDescriptor;
        var message = error.registryCode && /^STORAGE_/.test(error.registryCode)
          ? error.message.replace(/^\[[A-Z_]+\]\s*/, '')
          : 'Служебный реестр недоступен. Статусы и проверки формата сейчас не сохраняются.';
        if (descriptor) descriptor.message = message;
        var fallback = discovered.map(function (file) { return sourceBaseItem_(file, null, null); });
        var response = sourceBasesResponse_(binding, descriptor, fallback, false, false);
        response.state = 'storage_unavailable';
        response.message = message;
        return response;
      }
    });
  });
}

function updateSourceBase(request) {
  return api_(function () {
    var context = authorize_(), input = object_(request);
    var allowedKeys = ['id', 'status', 'formatCheck', 'baseType', 'contents', 'expectedRevision'];
    if (Object.keys(input).some(function (key) { return allowedKeys.indexOf(key) === -1; })) fail_('INVALID_REQUEST', 'Можно изменить только наполнение базы, статус сбора и ручную проверку формата.');
    var fileId = id_(input.id);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail_('INVALID_REQUEST', 'Сначала обновите сохранённое состояние базы.');
    var hasStatus = Object.prototype.hasOwnProperty.call(input, 'status');
    var hasCheck = Object.prototype.hasOwnProperty.call(input, 'formatCheck');
    var hasType = Object.prototype.hasOwnProperty.call(input, 'baseType');
    var hasContents = Object.prototype.hasOwnProperty.call(input, 'contents');
    if (hasContents && !Array.isArray(input.contents)) fail_('INVALID_CONTENTS', 'Наполнение базы должно содержать компании и/или ЛПР.');
    var contents = hasContents ? sourceBaseContents_(input.contents) : (hasType ? sourceBaseContents_(input.baseType) : null);
    if (hasType && hasContents && sourceBaseLegacyType_(contents) !== input.baseType) fail_('INVALID_CONTENTS', 'Наполнение базы не соответствует указанному типу.');
    if (!hasStatus && !hasCheck && !hasType && !hasContents) fail_('INVALID_REQUEST', 'Не выбрано изменение базы.');
    if (hasStatus && SOURCE_BASES_SCHEMA.statuses.indexOf(input.status) === -1) fail_('INVALID_STATUS', 'Неизвестный статус сбора.');
    if (hasCheck && SOURCE_BASES_SCHEMA.checks.indexOf(input.formatCheck) === -1) fail_('INVALID_FORMAT_CHECK', 'Неизвестный результат ручной проверки формата.');
    if (hasType && SOURCE_BASES_SCHEMA.baseTypes.indexOf(input.baseType) === -1) fail_('INVALID_BASE_TYPE', 'Неизвестный тип базы.');
    return locked_(function () {
      var current = authorize_();
      var binding = sourceBasesSource_(current);
      if (binding.state !== 'ready') fail_('SOURCE_UNAVAILABLE', 'Папка исходных баз недоступна в реестре.');
      var file = sourceBaseMetadata_(sourceBasesFile_(current, binding.folder, fileId));
      var storage = sourceBasesStorage_(current);
      var database = sourceBasesReadDatabase_(storage);
      var stored = database.records[fileId];
      if (!stored || !stored.present) fail_('CONFLICT', 'Состав исходных баз изменился. Обновите список перед сохранением.');
      if (stored.revision !== input.expectedRevision) fail_('CONFLICT', 'Эту базу уже изменили. Обновите список перед повторным сохранением.');
      var record = sourceBaseCopyRecord_(stored);
      sourceBaseApplyMetadata_(record, file);
      if (hasStatus) record.status = input.status;
      if (contents && JSON.stringify(record.contents) !== JSON.stringify(contents)) {
        record.contents = contents;
        record.baseType = sourceBaseLegacyType_(contents);
        if (!hasCheck) record.formatCheck = 'unchecked';
      }
      if (hasCheck) record.formatCheck = input.formatCheck;
      if (sourceBaseChanged_(stored, record)) {
        sourceBaseBump_(record, current.email);
        sourceBaseWriteRecords_(storage.basesSheet, [record]);
      }
      return { item: sourceBaseItem_(file, record, sourceBasesAssociations_(database.relations, current)) };
    });
  });
}

function sourceBasesSource_(context) {
  var root = registryRoot_(context);
  var explicit = context.properties.getProperty('SOURCE_BASES_FOLDER_ID');
  explicit = typeof explicit === 'string' ? explicit.trim() : '';
  var sourceId = explicit || REGISTRY_CONFIG.defaultSourceBasesFolderId;
  var folder;
  try { folder = folderById_(sourceId); }
  catch (error) {
    if (explicit) return { state: 'source_outside_registry', source: null };
  }
  if (folder && (folder.isTrashed() || !insideRegistry_(folder, context.rootId))) return { state: 'source_outside_registry', source: null };
  if (!folder && !explicit) {
    var matches = [], iterator = root.getFolders();
    while (iterator.hasNext()) {
      var candidate = iterator.next();
      if (!candidate.isTrashed() && segmentFolderName_(candidate.getName()) === segmentFolderName_(REGISTRY_CONFIG.sourceBasesFolderName)) matches.push(candidate);
    }
    if (matches.length > 1) return { state: 'source_ambiguous', source: null };
    folder = matches[0];
  }
  if (!folder) return { state: 'source_missing', source: null };
  if (folder.isTrashed() || !insideRegistry_(folder, context.rootId)) return { state: 'source_outside_registry', source: null };
  return { state: 'ready', source: { id: folder.getId(), name: folder.getName(), url: segmentFolderUrl_(folder.getId()) }, folder: folder };
}

function sourceBasesDiscover_(context, source) {
  var files = [], seenFiles = Object.create(null), seenFolders = Object.create(null), folderCount = 0;
  var storageId = context.properties.getProperty('SOURCE_BASES_STORAGE_ID') || REGISTRY_CONFIG.defaultSourceBasesStorageId;
  function visit(folder, depth) {
    if (seenFolders[folder.getId()]) return;
    if (++folderCount > REGISTRY_CONFIG.maxSourceFolders || depth > REGISTRY_CONFIG.maxTreeDepth) fail_('SOURCE_LIMIT', 'Слишком много папок исходных баз. Список не был сохранён частично.');
    if (!insideRegistry_(folder, source.getId())) fail_('SOURCE_CHANGED', 'Папки исходных баз изменились во время обновления. Повторите обновление.');
    seenFolders[folder.getId()] = true;
    var iterator = folder.getFiles();
    while (iterator.hasNext()) {
      var file = iterator.next();
      if (file.isTrashed() || file.getId() === storageId || file.getMimeType() === 'application/vnd.google-apps.folder' || seenFiles[file.getId()]) continue;
      if (!insideRegistry_(file, source.getId())) continue;
      seenFiles[file.getId()] = true;
      files.push(sourceBaseMetadata_(file));
      if (files.length > REGISTRY_CONFIG.maxSourceBaseRows) fail_('SOURCE_LIMIT', 'Исходных баз больше 5000. Список не был сохранён частично.');
    }
    var children = folder.getFolders();
    while (children.hasNext()) {
      var child = children.next();
      if (!child.isTrashed()) visit(child, depth + 1);
    }
  }
  visit(source, 0);
  return files.sort(byName_);
}

function sourceBasesFile_(context, source, fileId) {
  var file;
  try { file = DriveApp.getFileById(id_(fileId)); }
  catch (error) { fail_('NOT_FOUND', 'Исходная база недоступна. Обновите список.'); }
  if (file.isTrashed() || file.getMimeType() === 'application/vnd.google-apps.folder' || !insideRegistry_(file, source.getId()) || !insideRegistry_(file, context.rootId)) fail_('OUTSIDE_REGISTRY', 'Этот файл не относится к папке исходных баз.');
  return file;
}

function sourceBaseMetadata_(file) {
  var fileId = id_(file.getId()), name = String(file.getName()), mimeType = String(file.getMimeType());
  var url = String(file.getUrl());
  if (!/^https:\/\/(?:docs|drive|script)\.google\.com\//.test(url)) url = 'https://drive.google.com/file/d/' + fileId + '/view';
  var formats = {
    'application/vnd.google-apps.spreadsheet': 'Google Таблицы',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
    'application/vnd.ms-excel': 'XLS',
    'application/vnd.ms-excel.sheet.macroEnabled.12': 'XLSM',
    'text/csv': 'CSV', 'application/csv': 'CSV', 'text/tab-separated-values': 'TSV',
    'application/vnd.oasis.opendocument.spreadsheet': 'ODS',
    'application/pdf': 'PDF',
    'application/vnd.google-apps.document': 'Google Документ',
    'application/vnd.google-apps.presentation': 'Google Презентация',
    'application/vnd.google-apps.shortcut': 'Ярлык'
  };
  var extension = name.match(/\.([a-zA-Z0-9]{1,12})$/);
  return { id: fileId, name: name, fileName: name, mimeType: mimeType, url: url, format: formats[mimeType] || (extension ? extension[1].toUpperCase() : 'Файл') };
}

function sourceBasesStorage_(context) {
  var storageId = context.properties.getProperty('SOURCE_BASES_STORAGE_ID') || REGISTRY_CONFIG.defaultSourceBasesStorageId;
  var descriptor;
  try {
    var file = DriveApp.getFileById(id_(storageId));
    if (file.isTrashed() || file.getMimeType() !== REGISTRY_CONFIG.spreadsheetMime) throw new Error('Invalid service book');
    var parents = file.getParents(), directRoot = false;
    while (parents.hasNext()) if (parents.next().getId() === context.rootId) directRoot = true;
    if (!directRoot) throw new Error('Service book is outside the root');
    descriptor = { id: storageId, url: spreadsheetUrl_(storageId) };
    // Source metadata opens only this fixed service book. Segment loading
    // validates ready source files separately before opening their worksheets.
    var book = SpreadsheetApp.openById(storageId);
    var basesSheet = book.getSheetByName(SOURCE_BASES_SCHEMA.basesTab);
    var relationsSheet = book.getSheetByName(SOURCE_BASES_SCHEMA.relationsTab);
    if (!basesSheet || !relationsSheet) throw new Error('Missing service tabs');
    return { public: descriptor, book: book, basesSheet: basesSheet, relationsSheet: relationsSheet };
  } catch (error) {
    var failure = registryError_('STORAGE_UNAVAILABLE', 'Служебная таблица недоступна или находится вне корня реестра. Статусы сейчас не сохраняются.');
    if (descriptor) failure.sourceStorage = descriptor;
    throw failure;
  }
}

function sourceBasesReadRows_(sheet, headers, allowLegacyContents, migrationPending) {
  var lastRow = sheet.getLastRow(), lastColumn = sheet.getLastColumn();
  var legacy = !!allowLegacyContents && lastColumn >= 11 && lastColumn < headers.length;
  if (lastRow < 1 || (!legacy && lastColumn !== headers.length)) fail_('STORAGE_SCHEMA', 'Структура служебного реестра отличается от ожидаемой. Требуется проверка администратора.');
  if (lastRow > REGISTRY_CONFIG.maxSourceBaseRows + 1) fail_('STORAGE_LIMIT', 'Служебный реестр превышает лимит 5000 строк. Данные не были перезаписаны.');
  var range = sheet.getRange(1, 1, lastRow, lastColumn);
  var formulas = range.getFormulas();
  if (formulas.some(function (row) { return row.some(function (formula) { return !!formula; }); })) fail_('STORAGE_SCHEMA', 'В служебном реестре обнаружены формулы. Требуется проверка администратора.');
  var values = range.getValues();
  var headerLength = lastColumn;
  // A durable marker is the only permission to resume a partially written
  // appended header. Existing A:K headers are never repaired automatically.
  if (allowLegacyContents && migrationPending) while (headerLength > 11 && values[0][headerLength - 1] === '') headerLength--;
  if (headers.slice(0, headerLength).some(function (header, index) { return values[0][index] !== header; })) fail_('STORAGE_SCHEMA', 'Заголовки служебного реестра изменены. Данные не были перезаписаны.');
  return { rows: values.slice(1), lastRow: lastRow, columns: lastColumn, headerLength: headerLength, legacy: legacy || headerLength < headers.length };
}

function sourceBasesReadDatabase_(storage) {
  try {
    var properties = PropertiesService.getScriptProperties();
    var migrationKey = 'SOURCE_BASES_CONTENTS_MIGRATION_' + storage.public.id;
    var oldKey = 'SOURCE_BASES_TYPE_MIGRATION_' + storage.public.id;
    var migrationPending = properties.getProperty(migrationKey) === 'pending';
    var oldPending = properties.getProperty(oldKey) === 'pending';
    var bases = sourceBasesReadRows_(storage.basesSheet, SOURCE_BASES_SCHEMA.basesHeaders, true, migrationPending || oldPending);
    var links = sourceBasesReadRows_(storage.relationsSheet, SOURCE_BASES_SCHEMA.relationsHeaders);
    var records = Object.create(null), relations = [], seenLinks = Object.create(null), missingTypes = [], missingContents = [];
    bases.rows.forEach(function (row, index) {
      if (row.every(function (value) { return value === ''; })) return;
      var fileId = id_(row[0]);
      if (records[fileId]) fail_('STORAGE_DUPLICATE', 'В служебном реестре повторяется ID базы. Требуется проверка администратора.');
      if (SOURCE_BASES_SCHEMA.statuses.indexOf(row[5]) === -1 || SOURCE_BASES_SCHEMA.checks.indexOf(row[6]) === -1 || !Number.isSafeInteger(row[7]) || row[7] < 1 || typeof row[8] !== 'boolean') fail_('STORAGE_SCHEMA', 'Сохранённые статусы или версии базы некорректны. Требуется проверка администратора.');
      var missingType = row[11] === undefined || row[11] === '';
      if ((missingType && bases.headerLength >= 12 && !migrationPending && !oldPending) || (!missingType && SOURCE_BASES_SCHEMA.baseTypes.indexOf(row[11]) === -1)) fail_('STORAGE_SCHEMA', 'Сохранённый тип базы некорректен. Требуется проверка администратора.');
      var baseType = missingType ? 'general' : row[11];
      var missingContent = row[12] === undefined || row[12] === '';
      if (missingContent && bases.headerLength >= 13 && !migrationPending && !oldPending) fail_('STORAGE_SCHEMA', 'Сохранённое наполнение базы отсутствует. Требуется проверка администратора.');
      var contents;
      try { contents = missingContent ? sourceBaseContents_(baseType) : sourceBaseContents_(JSON.parse(row[12])); }
      catch (invalid) { fail_('STORAGE_SCHEMA', 'Сохранённое наполнение базы некорректно. Требуется проверка администратора.'); }
      if (sourceBaseLegacyType_(contents) !== baseType) fail_('STORAGE_SCHEMA', 'Тип и наполнение базы в служебном реестре не совпадают.');
      records[fileId] = { fileId: fileId, fileName: sourceBaseText_(row[1]), mimeType: sourceBaseText_(row[2]), url: sourceBaseText_(row[3]), format: sourceBaseText_(row[4]), status: row[5], formatCheck: row[6], revision: row[7], present: row[8], updatedAt: sourceBaseText_(row[9]), updatedBy: sourceBaseText_(row[10]), baseType: baseType, contents: contents, row: index + 2 };
      if (missingType) missingTypes.push(records[fileId]);
      if (missingContent) missingContents.push(records[fileId]);
    });
    links.rows.forEach(function (row) {
      if (row.every(function (value) { return value === ''; })) return;
      var fileId = id_(row[0]), segmentId = id_(row[1]), key = fileId + '|' + segmentId;
      if (seenLinks[key]) fail_('STORAGE_DUPLICATE', 'В служебном реестре повторяется связь базы и сегмента. Требуется проверка администратора.');
      seenLinks[key] = true;
      relations.push({ fileId: fileId, segmentId: segmentId });
    });
    // Validate both tabs completely before appending L/M. Statuses, revisions,
    // associations and all source files remain untouched by this migration.
    if (bases.legacy || missingTypes.length || missingContents.length || migrationPending || oldPending) sourceBasesMigrateContents_(storage, bases.headerLength, missingTypes, missingContents, properties, migrationKey, oldKey);
    return { records: records, relations: relations, lastRow: bases.lastRow };
  } catch (error) {
    var failure = error.registryCode && /^STORAGE_/.test(error.registryCode) ? error : registryError_('STORAGE_SCHEMA', 'Служебный реестр содержит некорректные данные. Требуется проверка администратора.');
    failure.sourceStorage = storage.public;
    throw failure;
  }
}

function sourceBasesMigrateContents_(storage, headerLength, missingTypes, missingContents, properties, key, oldKey) {
  var sheet = storage.basesSheet;
  properties.setProperty(key, 'pending');
  // Keep an old migration marker, when present, until both new columns flush.
  try {
    var capacity = sheet.getMaxColumns();
    if (capacity < 13) sheet.insertColumnsAfter(capacity, 13 - capacity);
    if (headerLength < 12) sheet.getRange(1, 12).setValue('baseType');
    if (headerLength < 13) sheet.getRange(1, 13).setValue('contents');
    function fill(records, column, valueFor) {
      var groups = [];
      records.slice().sort(function (a, b) { return a.row - b.row; }).forEach(function (record) {
        var group = groups[groups.length - 1];
        if (!group || group[group.length - 1].row + 1 !== record.row) { group = []; groups.push(group); }
        group.push(record);
      });
      groups.forEach(function (group) { sheet.getRange(group[0].row, column, group.length, 1).setValues(group.map(function (record) { return [valueFor(record)]; })); });
    }
    fill(missingTypes, 12, function (record) { return record.baseType; });
    fill(missingContents, 13, function (record) { return JSON.stringify(record.contents); });
  } finally { SpreadsheetApp.flush(); }
  properties.deleteProperty(key);
  properties.deleteProperty(oldKey);
}

/** Canonical, nonempty contents; scalar values are legacy compatibility only. */
function sourceBaseContents_(value) {
  if (typeof value === 'string') {
    if (value === 'general') value = ['companies'];
    else if (value === 'lpr') value = ['lpr'];
    else if (value === 'mixed') value = ['companies', 'lpr'];
    else fail_('INVALID_BASE_TYPE', 'Неизвестное наполнение базы.');
  }
  if (!Array.isArray(value) || !value.length || value.length > 2 || value.some(function (part) { return SOURCE_BASES_SCHEMA.contents.indexOf(part) === -1; }) || (value.length === 2 && value[0] === value[1])) fail_('INVALID_CONTENTS', 'Выберите наполнение базы: компании и/или ЛПР.');
  return SOURCE_BASES_SCHEMA.contents.filter(function (part) { return value.indexOf(part) !== -1; });
}

function sourceBaseLegacyType_(contents) { return contents.length === 2 ? 'mixed' : (contents[0] === 'lpr' ? 'lpr' : 'general'); }

/** Caller owns ScriptLock; validate readiness before opening business cells. */
function requireReadySourceBase_(context, storage, database, fileId, expectedRevision) {
  fileId = id_(fileId);
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) fail_('INVALID_REQUEST', 'Обновите сохранённое состояние исходной базы.');
  var binding = sourceBasesSource_(context);
  if (binding.state !== 'ready') fail_('SOURCE_UNAVAILABLE', 'Папка исходных баз недоступна в реестре.');
  var file = sourceBasesFile_(context, binding.folder, fileId);
  var metadata = sourceBaseMetadata_(file), record = database && database.records && database.records[fileId];
  if (!storage || !record || !record.present) fail_('SOURCE_NOT_READY', 'База отсутствует в актуальном реестре. Обновите список.');
  if (expectedRevision !== undefined && record.revision !== expectedRevision) fail_('CONFLICT', 'Исходная база изменена. Обновите список перед загрузкой в сегмент.');
  if (record.status !== 'ready') fail_('SOURCE_NOT_READY', 'В сегмент можно загрузить только базу со статусом «Готова».');
  if (metadata.mimeType !== REGISTRY_CONFIG.spreadsheetMime) fail_('INVALID_FILE_TYPE', 'Для загрузки листов в сегмент нужна Google Таблица. Сначала загрузите файл через «Загрузить базу».');
  var contents = sourceBaseContents_(record.contents || record.baseType);
  if (sourceBaseLegacyType_(contents) !== record.baseType) fail_('STORAGE_SCHEMA', 'Наполнение исходной базы требует проверки администратора.');
  return { file: file, metadata: metadata, record: record, contents: contents };
}

function sourceBasesSync_(context, storage, database, discovered) {
  var records = database.records, changes = [], present = Object.create(null), nextRow = database.lastRow + 1;
  discovered.forEach(function (file) {
    present[file.id] = true;
    var old = records[file.id], record;
    if (!old) {
      record = { fileId: file.id, fileName: file.fileName, mimeType: file.mimeType, url: file.url, format: file.format, status: 'collection', formatCheck: 'unchecked', revision: 1, present: true, updatedAt: new Date().toISOString(), updatedBy: context.email, baseType: 'general', contents: ['companies'], row: nextRow++ };
      records[file.id] = record;
      changes.push(record);
    } else {
      record = sourceBaseCopyRecord_(old);
      sourceBaseApplyMetadata_(record, file);
      record.present = true;
      if (sourceBaseChanged_(old, record)) {
        sourceBaseBump_(record, context.email);
        records[file.id] = record;
        changes.push(record);
      }
    }
  });
  Object.keys(records).forEach(function (fileId) {
    var old = records[fileId];
    if (!present[fileId] && old.present) {
      var record = sourceBaseCopyRecord_(old);
      record.present = false;
      sourceBaseBump_(record, context.email);
      records[fileId] = record;
      changes.push(record);
    }
  });
  if (nextRow > REGISTRY_CONFIG.maxSourceBaseRows + 2) fail_('STORAGE_LIMIT', 'В служебном реестре нет места для всех исходных баз. Частичный список не был сохранён.');
  sourceBaseWriteRecords_(storage.basesSheet, changes);
  return records;
}

/** Caller owns ScriptLock and has validated destination and service storage. */
function registerImportedSourceBase_(context, storage, database, file, baseType, status, options) {
  var fileId = id_(file.id), contents = sourceBaseContents_(baseType);
  baseType = sourceBaseLegacyType_(contents);
  if (SOURCE_BASES_SCHEMA.statuses.indexOf(status) === -1) fail_('INVALID_STATUS', 'Неизвестный статус сбора.');
  if (file.mimeType !== REGISTRY_CONFIG.spreadsheetMime) fail_('INVALID_FILE_TYPE', 'После загрузки должна быть создана Google Таблица.');
  var stored = database.records[fileId], record;
  if (stored) {
    record = sourceBaseCopyRecord_(stored);
    sourceBaseApplyMetadata_(record, file);
    record.present = true;
    // Replayed imports must not overwrite a teammate's later manual edits.
    // A fresh move of an already-known file may explicitly bind the pre-action
    // revision in its durable receipt to apply the selected initial fields once.
    if (options && Number.isSafeInteger(options.expectedRevision) && options.expectedRevision === stored.revision) {
      record.baseType = baseType;
      record.contents = contents;
      record.status = status;
      record.formatCheck = 'unchecked';
    }
    if (!sourceBaseChanged_(stored, record)) return stored;
    sourceBaseBump_(record, context.email);
  } else {
    var row = database.lastRow + 1;
    if (row > REGISTRY_CONFIG.maxSourceBaseRows + 1) fail_('STORAGE_LIMIT', 'В служебном реестре нет места для новой базы.');
    record = { fileId: fileId, fileName: file.fileName, mimeType: file.mimeType, url: file.url, format: file.format,
      baseType: baseType, contents: contents, status: status, formatCheck: 'unchecked', revision: 1, present: true,
      updatedAt: new Date().toISOString(), updatedBy: context.email, row: row };
  }
  sourceBaseWriteRecords_(storage.basesSheet, [record]);
  database.records[fileId] = record;
  database.lastRow = Math.max(database.lastRow, record.row);
  return record;
}

function sourceBaseWriteRecords_(sheet, records) {
  if (!records.length) return;
  var sorted = records.slice().sort(function (a, b) { return a.row - b.row; });
  var highest = sorted[sorted.length - 1].row, usedRows = Object.create(null);
  sorted.forEach(function (record) {
    if (!Number.isSafeInteger(record.row) || record.row < 2 || record.row > REGISTRY_CONFIG.maxSourceBaseRows + 1 || usedRows[record.row]) fail_('STORAGE_LIMIT', 'Некорректная область записи служебного реестра. Данные не были перезаписаны.');
    usedRows[record.row] = true;
  });
  try {
    var capacity = sheet.getMaxRows();
    if (highest > capacity) sheet.insertRowsAfter(capacity, highest - capacity);
    var groups = [];
    sorted.forEach(function (record) {
      var group = groups[groups.length - 1];
      if (!group || group[group.length - 1].row + 1 !== record.row) { group = []; groups.push(group); }
      group.push(record);
    });
    groups.forEach(function (group) { sourceBaseWriteGroup_(sheet, group); });
  }
  finally {
    // Apps Script may buffer writes. Flush once while the caller still holds
    // ScriptLock, including after partial write errors, before another writer.
    SpreadsheetApp.flush();
  }
}

function sourceBaseWriteGroup_(sheet, records) {
  var literalColumns = Object.create(null);
  var escaped = records.map(function (record) {
    return SOURCE_BASES_SCHEMA.basesHeaders.map(function (header, index) {
      var value = header === 'contents' ? JSON.stringify(sourceBaseContents_(record.contents || record.baseType)) : record[header];
      if (typeof value === 'string' && sourceBaseNeedsLiteral_(value)) {
        if (!literalColumns[index]) literalColumns[index] = [];
        literalColumns[index].push({ row: record.row, text: value });
        return "'" + value;
      }
      return value;
    });
  });
  // Prefixes protect the initial write too: no transient formula is evaluated.
  sheet.getRange(records[0].row, 1, records.length, SOURCE_BASES_SCHEMA.basesHeaders.length).setValues(escaped);
  Object.keys(literalColumns).forEach(function (column) {
    var cells = literalColumns[column], groups = [];
    cells.forEach(function (cell) {
      var group = groups[groups.length - 1];
      if (!group || group[group.length - 1].row + 1 !== cell.row) { group = []; groups.push(group); }
      group.push(cell);
    });
    groups.forEach(function (group) {
      var rich = group.map(function (cell) { return [SpreadsheetApp.newRichTextValue().setText(cell.text).build()]; });
      var range = sheet.getRange(group[0].row, Number(column) + 1, group.length, 1);
      if (group.length === 1) range.setRichTextValue(rich[0][0]);
      else range.setRichTextValues(rich);
    });
  });
}

function sourceBaseNeedsLiteral_(value) { return /^(?:'|\s*[=+\-@])/.test(value); }
function sourceBaseText_(value) { return Object.prototype.toString.call(value) === '[object Date]' ? value.toISOString() : String(value === null || value === undefined ? '' : value); }
function sourceBaseCopyRecord_(record) { var copy = {}; Object.keys(record).forEach(function (key) { copy[key] = key === 'contents' && Array.isArray(record[key]) ? record[key].slice() : record[key]; }); return copy; }
function sourceBaseApplyMetadata_(record, file) { ['fileName', 'mimeType', 'url', 'format'].forEach(function (key) { record[key] = file[key]; }); }
function sourceBaseChanged_(before, after) { return ['fileName', 'mimeType', 'url', 'format', 'status', 'formatCheck', 'present', 'baseType'].some(function (key) { return before[key] !== after[key]; }) || JSON.stringify(before.contents) !== JSON.stringify(after.contents); }
function sourceBaseBump_(record, email) { if (record.revision >= Number.MAX_SAFE_INTEGER) fail_('STORAGE_LIMIT', 'Достигнут предел версии записи. Требуется проверка администратора.'); record.revision++; record.updatedAt = new Date().toISOString(); record.updatedBy = email; }

function sourceBasesAssociations_(relations, context) {
  var index = Object.create(null);
  if (!relations.length) return { relations: relations, index: index };
  try {
    var segments = getSegmentsMetadata_(context || authorize_());
    if (segments.state === 'ready') segments.items.forEach(function (segment) { index[segment.id] = { id: segment.id, name: segment.name, url: segment.url }; });
  } catch (error) { /* Existing links remain stored; their unavailable targets are not guessed. */ }
  return { relations: relations, index: index };
}

function sourceBaseItem_(file, record, associations) {
  var item = { id: file.id, name: file.name, fileName: file.fileName, mimeType: file.mimeType, url: file.url, format: file.format, status: record ? record.status : null, formatCheck: record ? record.formatCheck : null, baseType: record ? record.baseType : null, contents: record ? sourceBaseContents_(record.contents || record.baseType) : null, canAddToSegment: !!(record && record.present && record.status === 'ready' && file.mimeType === REGISTRY_CONFIG.spreadsheetMime), revision: record ? record.revision : null, present: true, segments: associations ? [] : null, associationsAvailable: !!associations };
  if (record) { item.updatedAt = record.updatedAt; item.updatedBy = record.updatedBy; }
  if (associations) associations.relations.forEach(function (relation) {
    if (relation.fileId !== file.id) return;
    if (associations.index[relation.segmentId]) item.segments.push(associations.index[relation.segmentId]);
    else { item.associationsAvailable = false; item.associationWarning = 'Часть связей с сегментами недоступна. Требуется проверка.'; }
  });
  return item;
}

function sourceBasesResponse_(binding, storage, items, canEdit, associationsAvailable) {
  return { state: binding.state, source: binding.source || null, storage: storage, items: items, canEdit: canEdit, associationsAvailable: associationsAvailable, generatedAt: new Date().toISOString() };
}
