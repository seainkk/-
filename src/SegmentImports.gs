/** Previewed, resumable upserts into one companies master and its linked LPR master. */
var SEGMENT_RECORD_IMPORT = Object.freeze({ version: 1, ttlMillis: 24 * 60 * 60 * 1000, leaseMillis: 10 * 60 * 1000, maxJobs: 80, maxPreviews: 128, maxPlanCharacters: 30000000, newRowsPerStep: 1000, changedRowsPerStep: 100, jobPrefix: 'SEGMENT_RECORD_JOB_', previewPrefix: 'SEGMENT_RECORD_PREVIEW_', indexKey: 'SEGMENT_RECORD_JOB_INDEX', previewIndexKey: 'SEGMENT_RECORD_PREVIEW_INDEX' });

function previewSegmentRecords_(request) {
  return api_(function () {
    var context = authorize_(), input = segmentInput_(request, ['segmentId', 'sourceIds', 'loads', 'targetKind']), sources = segmentRecordsInputSources_(input);
    var targetKind = input.targetKind;
    if (targetKind !== undefined && targetKind !== 'companies' && targetKind !== 'lpr') fail_('INVALID_REQUEST', 'Выберите таблицу компаний или ЛПР.');
    var bindings = segmentRecordsReadySources_(context, sources, targetKind);
    var targets = segmentRecordsTargets_(context, id_(input.segmentId), true, true);
    if (bindings.some(function (binding) { return binding.id === targets.tables.companies || binding.id === targets.tables.lpr; })) fail_('SOURCE_IS_TARGET', 'Рабочую таблицу сегмента нельзя загрузить саму в себя как исходную базу.');
    var collected = segmentRecordsCollect_(context, bindings);
    targets.directory = targetKind !== 'lpr' && (targets.directory || collected.records.some(function (record) { return !!record.directory; }));
    ['companies', 'lpr'].forEach(function (kind) { segmentRecordsMaster_(targets, kind, true); });
    segmentRecordsEnroll_(targets, targetKind);
    var masters = segmentRecordsReadMasters_(targets);
    var planned = segmentRecordsPlanner_({ records: collected.records, companies: masters.companies.records, people: masters.lpr.records, targetKind: targetKind, directory: targets.directory });
    var companyStages = segmentRecordsSplitCompanyMarkers_(planned.companies);
    var plan = {
      version: SEGMENT_RECORD_IMPORT.version, rootId: context.rootId, segmentId: targets.folder.getId(),
      segmentName: targets.folder.getName(), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + SEGMENT_RECORD_IMPORT.ttlMillis).toISOString(),
      sources: collected.sources, tables: targets.tables, masters: { companies: masters.companies.descriptor, lpr: masters.lpr.descriptor },
      companies: companyStages.companies, companyMarkers: companyStages.markers, people: planned.people, markers: planned.markers,
      counts: planned.counts, review: planned.review, sample: planned.sample, warnings: collected.warnings, mode: 'registry', materializeContacts: true
    };
    if (Object.keys(collected.history || {}).length) plan.workingHistory = segmentSelectionAccepted_(collected.history, masters, planned);
    if (targets.directory) plan.directory = true;
    if (targetKind) {
      plan.targetKind = targetKind;
      if (Object.keys(planned.linkedCompanies).length) plan.linkedCompanies = planned.linkedCompanies;
      if (plan.workingHistory) delete plan.workingHistory[targetKind === 'companies' ? 'lpr' : 'companies'];
    }
    var saved = segmentRecordsSavePlan_(context, plan);
    return segmentRecordsPreview_(targets, saved.token, plan);
  });
}

function importSegmentRecords_(request) {
  return api_(function () {
    var context = authorize_(), input = segmentInput_(request, ['segmentId', 'planToken', 'requestId']);
    var segmentId = id_(input.segmentId), requestId = segmentRequestId_(input.requestId);
    if (typeof registryRequireSegment_ === 'function') registryRequireSegment_(context, segmentId);
    var plan = segmentRecordsLoadPreview_(context, input.planToken, segmentId);
    var job = segmentRecordsAllocateJob_(context, plan, input.planToken, requestId);
    return segmentRecordsRunJob_(job.id, requestId);
  });
}

function continueSegmentRecords_(request) {
  return api_(function () {
    var context = authorize_(), input = segmentInput_(request, ['segmentId', 'jobId', 'requestId']), job = segmentRecordsReadJob_(context, input.jobId);
    if (job.segmentId !== id_(input.segmentId)) fail_('OUTSIDE_SEGMENTS', 'Эта загрузка относится к другому сегменту.');
    if (typeof registryRequireSegment_ === 'function') registryRequireSegment_(context, job.segmentId);
    if (job.requestId !== segmentRequestId_(input.requestId)) fail_('REQUEST_REUSED', 'Продолжите загрузку с прежним идентификатором запроса.');
    return segmentRecordsRunJob_(job.id, job.requestId);
  });
}

/** Transfer manually added people before deriving company contact lists. */
function syncSegmentPeople_(request) {
  return api_(function () {
    var context = authorize_(), input = segmentInput_(request, ['companyFileId', 'requestId']), companyFileId = id_(input.companyFileId);
    segmentRequestId_(input.requestId);
    var storage = sourceBasesStorage_(context), tracking = segmentTrackingStorage_(context, storage, false);
    var matches = tracking.tables.filter(function (table) { return table.kind === 'companies' && table.fileId === companyFileId; });
    if (matches.length !== 1) fail_('SEGMENT_TABLE_UNKNOWN', 'Таблица не является связанной базой компаний сегмента.');
    var targets = segmentRecordsTargets_(context, matches[0].segmentId, true), active = segmentRecordsActiveJob_(context, targets.folder.getId());
    if (active) return segmentRecordsRunJob_(active.id, active.requestId);
    targets.directory = false; // Manual transfers use only normalized master fields.
    var masters = segmentRecordsReadMasters_(targets), descriptor = masters.companies.descriptor;
    var source = segmentRecordsReadSource_(context, { id: companyFileId, section: 'companies', sheetIds: [descriptor.sheetId], mode: 'segment', expectedRevision: null }, targets);
    var planned = segmentRecordsPlanner_({ records: source.records, companies: masters.companies.records, people: masters.lpr.records });
    var companyStages = segmentRecordsSplitCompanyMarkers_(planned.companies);
    var plan = {
      version: SEGMENT_RECORD_IMPORT.version, rootId: context.rootId, segmentId: targets.folder.getId(), segmentName: targets.folder.getName(),
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + SEGMENT_RECORD_IMPORT.ttlMillis).toISOString(),
      sources: [source.binding], tables: targets.tables, masters: { companies: descriptor, lpr: masters.lpr.descriptor },
      companies: companyStages.companies, companyMarkers: companyStages.markers, people: planned.people, markers: [], counts: planned.counts, review: planned.review, sample: planned.sample,
      warnings: source.warnings, mode: 'segment'
    };
    if (!plan.companies.length && !plan.people.length && !plan.companyMarkers.length) return { state: 'complete', segmentId: plan.segmentId, segment: segmentActionResult_(context, targets.folder, targets.tables), requestId: input.requestId, counts: plan.counts, review: plan.review, warnings: plan.warnings, progress: { phase: 'complete', completed: 0, total: 0, label: 'Новых ЛПР нет.' } };
    var saved = segmentRecordsSavePlan_(context, plan), job = segmentRecordsAllocateJob_(context, plan, saved.token, input.requestId);
    return segmentRecordsRunJob_(job.id, job.requestId);
  });
}

function segmentRecordsInputSources_(input) {
  var seen = Object.create(null), sources = [];
  if (input.sourceIds !== undefined) {
    if (!Array.isArray(input.sourceIds) || input.sourceIds.length > 5) fail_('SEGMENT_LOAD_LIMIT', 'Выберите не больше пяти исходных баз за действие.');
    input.sourceIds.forEach(function (value) { var id = id_(value); if (!seen[id]) { seen[id] = true; sources.push({ id: id, sheetIds: null }); } });
  }
  if (input.loads !== undefined) {
    if (!Array.isArray(input.loads) || input.loads.length > 5) fail_('SEGMENT_LOAD_LIMIT', 'Выберите не больше пяти исходных баз за действие.');
    input.loads.forEach(function (raw) {
      var load = segmentInput_(raw, ['sourceId', 'expectedRevision', 'sheets']), id = id_(load.sourceId); segmentRevision_(load.expectedRevision);
      var sheetIds = null, sheetOptions = null;
      if (load.sheets !== undefined) {
        if (!Array.isArray(load.sheets) || !load.sheets.length || load.sheets.length > 20) fail_('SEGMENT_LOAD_LIMIT', 'Выберите от одного до двадцати исходных листов.');
        var leaves = Object.create(null); sheetOptions = []; sheetIds = load.sheets.map(function (rawSheet) {
          var sheet = segmentInput_(rawSheet, ['sheetId', 'target', 'hasHeader']);
          if (!Number.isSafeInteger(sheet.sheetId) || sheet.sheetId < 0 || leaves[sheet.sheetId]) fail_('INVALID_REQUEST', 'Выберите каждый исходный лист один раз.');
          if (sheet.target !== undefined && ['companies', 'lpr'].indexOf(sheet.target) === -1) fail_('INVALID_REQUEST', 'Неизвестное назначение исходного листа.');
          if (sheet.hasHeader !== undefined && typeof sheet.hasHeader !== 'boolean') fail_('INVALID_REQUEST', 'Укажите, есть ли строка заголовка.');
          leaves[sheet.sheetId] = true; var settings = { sheetId: sheet.sheetId }; if (sheet.target !== undefined) settings.section = sheet.target; if (sheet.hasHeader !== undefined) settings.hasHeader = sheet.hasHeader; sheetOptions.push(settings); return sheet.sheetId;
        });
      }
      if (seen[id]) fail_('INVALID_REQUEST', 'Исходная база выбрана несколько раз.');
      seen[id] = true; sources.push({ id: id, expectedRevision: load.expectedRevision, sheetIds: sheetIds, sheetOptions: sheetOptions });
    });
  }
  if (!sources.length || sources.length > 5) fail_('INVALID_REQUEST', 'Выберите готовые базы из реестра.');
  return sources;
}

function segmentRecordsReadySources_(context, sources, targetKind) {
  var storage = sourceBasesStorage_(context), database = sourceBasesReadDatabase_(storage);
  return sources.map(function (entry) {
    var source = requireReadySourceBase_(context, storage, database, entry.id, entry.expectedRevision);
    var binding = { id: entry.id, expectedRevision: source.record.revision, section: source.contents.length === 1 ? source.contents[0] : targetKind || 'companies', sheetIds: entry.sheetIds, sheetOptions: entry.sheetOptions || null, mode: 'registry', workingSelectionVersion: 1 };
    if (targetKind === 'lpr' && source.contents.length > 1) binding.mixedSource = true;
    return binding;
  });
}

function segmentRecordsTargets_(context, segmentId, create, deferMasters, newDirectory) {
  if (typeof registryRequireSegment_ === 'function') registryRequireSegment_(context, segmentId);
  var folder = segmentFolder_(context, segmentSourceFolder_(context), segmentId), storage = sourceBasesStorage_(context), tracking = segmentTrackingStorage_(context, storage, false), tables = {};
  tracking.tables.filter(function (table) { return table.segmentId === segmentId; }).forEach(function (table) { tables[table.kind] = table.fileId; });
  if ((!tables.companies || !tables.lpr) && create) {
    segmentMutation_('update', { id: segmentId, name: folder.getName(), loads: [], requestId: 'segment-workspace-' + digest_([segmentId, folder.getName()].join('|')).slice(0, 28) });
    tracking = segmentTrackingStorage_(context, sourceBasesStorage_(context), false); tables = {};
    tracking.tables.filter(function (table) { return table.segmentId === segmentId; }).forEach(function (table) { tables[table.kind] = table.fileId; });
  }
  if (!tables.companies || !tables.lpr || tables.companies === tables.lpr) fail_('SEGMENT_TABLE_UNKNOWN', 'У сегмента должны быть две разные связанные таблицы: компании и ЛПР.');
  var targets = { context: context, folder: folder, tables: tables, directory: !!newDirectory };
  ['companies', 'lpr'].forEach(function (kind) {
    var scope = segmentRecordsTargetGuard_(context, folder, tables[kind]);
    if (kind === 'companies' && (scope.metadata.appProperties || {}).registrySegmentDirectoryMode) targets.directory = true;
  });
  if (create && !deferMasters) {
    ['companies', 'lpr'].forEach(function (kind) { segmentRecordsMaster_(targets, kind, true); });
    segmentRecordsEnroll_(targets);
  }
  return targets;
}

function segmentRecordsTargetGuard_(context, folder, fileId) {
  var current = authorize_(); if (current.rootId !== context.rootId) fail_('SOURCE_CHANGED', 'Привязка реестра изменилась.');
  var service = current.properties.getProperty('SOURCE_BASES_STORAGE_ID') || REGISTRY_CONFIG.defaultSourceBasesStorageId;
  if (fileId === service || fileId === REGISTRY_CONFIG.defaultSourceBasesStorageId) fail_('GRID_PROTECTED', 'Служебный реестр не может быть рабочей базой сегмента.');
  var file = segmentTargetFile_(current, folder, fileId), metadata = Drive.Files.get(fileId, { fields: 'id,mimeType,parents,trashed,appProperties,capabilities(canEdit)', supportsAllDrives: true });
  if (!metadata.capabilities || metadata.capabilities.canEdit !== true) fail_('SEGMENT_WRITE_REQUIRED', 'Нет подтверждённых прав редактирования рабочей таблицы сегмента.');
  return { file: file, metadata: metadata };
}

function segmentRecordsMaster_(targets, kind, create) {
  var scope = segmentRecordsTargetGuard_(targets.context, targets.folder, targets.tables[kind]), tags = scope.metadata.appProperties || {}, book = SpreadsheetApp.openById(scope.file.getId()), sheet = null;
  if (tags.registrySegmentMasterSheetId !== undefined) {
    if (tags.registrySegmentMasterRoot !== targets.context.rootId || tags.registrySegmentMasterSegment !== targets.folder.getId() || tags.registrySegmentMasterKind !== kind) fail_('SEGMENT_MASTER_SCHEMA', 'Связь единой таблицы сегмента требует проверки.');
    sheet = segmentFindSheet_(book, Number(tags.registrySegmentMasterSheetId));
    if (!sheet) fail_('SEGMENT_MASTER_CHANGED', 'Единый рабочий лист удалён. Автоматическая загрузка остановлена.');
  }
  var schema = segmentRecordsSchema_(kind), directory = kind === 'companies' && targets.directory, title = kind === 'companies' ? 'Компании' : 'ЛПР';
  if (!sheet) {
    var candidates = book.getSheets().filter(function (candidate) {
      if (!candidate.getLastRow()) return false;
      var headers = candidate.getRange(1, 1, 1, candidate.getLastColumn()).getDisplayValues()[0].map(segmentRecordsName_);
      return schema.every(function (field) { return headers.indexOf(segmentRecordsName_(field[1])) !== -1; });
    });
    if (candidates.length > 1) fail_('SEGMENT_MASTER_AMBIGUOUS', 'В рабочей таблице несколько листов единого формата. Нужна ручная проверка.');
    sheet = candidates[0] || null;
  }
  if (!sheet && create) {
    var leaves = book.getSheets();
    if (leaves.length === 1 && leaves[0].getLastRow() === 0) sheet = leaves[0].setName(title);
    else { var name = title, suffix = 1; while (book.getSheetByName(name)) name = title + ' — единая база ' + (++suffix); sheet = book.insertSheet(name); }
    var initial = directory ? ['ID компании'].concat(SOURCE_DIRECTORY_FIELDS.map(function (field) { return field[1]; }), schema.slice(1).map(function (field) { return field[0] === 'telegrams' ? 'Telegram для контактов' : field[1]; })) : schema.map(function (field) { return field[1]; });
    if (sheet.getMaxColumns() < initial.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), initial.length - sheet.getMaxColumns());
    segmentRecordsTargetGuard_(targets.context, targets.folder, scope.file.getId());
    sheetWriteRawStrings_(scope.file.getId(), sheet.getSheetId(), 1, 1, [initial]);
    if (typeof sheet.setFrozenRows === 'function') sheet.setFrozenRows(1);
  }
  if (!sheet) fail_('SEGMENT_MASTER_MISSING', 'Единый рабочий лист ещё не создан.');
  var directoryMode = tags.registrySegmentDirectoryMode || '';
  if (directory && create) directoryMode = segmentRecordsEnsureDirectory_(targets, sheet, directoryMode);
  var descriptor = segmentRecordsMasterDescriptor_(sheet, segmentRecordsSchema_(kind, directory), directoryMode);
  if (create && (tags.registrySegmentMasterSheetId === undefined || directoryMode && !tags.registrySegmentDirectoryMode)) {
    var properties = segmentRecordsCopy_(tags); properties.registrySegmentMasterSheetId = String(sheet.getSheetId()); properties.registrySegmentMasterRoot = targets.context.rootId; properties.registrySegmentMasterSegment = targets.folder.getId(); properties.registrySegmentMasterKind = kind;
    if (directoryMode) properties.registrySegmentDirectoryMode = directoryMode;
    segmentRecordsTargetGuard_(targets.context, targets.folder, scope.file.getId());
    Drive.Files.update({ appProperties: properties }, scope.file.getId(), null, { fields: 'id', supportsAllDrives: true });
  }
  return { book: book, sheet: sheet, descriptor: descriptor };
}

function segmentRecordsDirectoryFirst_(headers) {
  return headers.indexOf(segmentRecordsName_('Telegram для контактов')) >= 0 && SOURCE_DIRECTORY_FIELDS.every(function (field) { return headers.indexOf(segmentRecordsName_(field[1])) >= 0; });
}

function segmentRecordsFieldLabel_(field, directoryFirst) {
  if (directoryFirst && field[0] === 'telegrams') return 'Telegram для контактов';
  if (!directoryFirst && field[0] === 'directoryTelegram') return 'Telegram из исходника';
  return field[1];
}

function segmentRecordsEnsureDirectory_(targets, sheet, mode) {
  return locked_(function () {
    segmentRecordsTargetGuard_(targets.context, targets.folder, targets.tables.companies);
    var width = sheet.getLastColumn(), headers = sheet.getRange(1, 1, 1, width).getDisplayValues()[0].map(segmentRecordsName_);
    var first = mode ? mode === 'originalFirst' : segmentRecordsDirectoryFirst_(headers), missing = [];
    SOURCE_DIRECTORY_FIELDS.forEach(function (field) {
      var label = segmentRecordsFieldLabel_(field, first), key = segmentRecordsName_(label), index = headers.indexOf(key);
      if (index !== headers.lastIndexOf(key)) fail_('SEGMENT_MASTER_SCHEMA', 'В рабочей таблице повторяется заголовок «' + label + '».');
      if (index === -1) missing.push(label);
    });
    if (!missing.length) return first ? 'originalFirst' : 'appended';
    if (mode) fail_('SEGMENT_MASTER_CHANGED', 'Изменилась структура справочника в таблице компаний. Проверьте заголовки.');
    var required = width + missing.length;
    if (sheet.getMaxColumns() < required) sheet.insertColumnsAfter(sheet.getMaxColumns(), required - sheet.getMaxColumns());
    sheetWriteRawStrings_(targets.tables.companies, sheet.getSheetId(), 1, width + 1, [missing]);
    return 'appended';
  });
}

function segmentRecordsMasterDescriptor_(sheet, schema, directoryMode) {
  var width = sheet.getLastColumn(), headers = width ? sheet.getRange(1, 1, 1, width).getDisplayValues()[0] : [], normalized = headers.map(segmentRecordsName_), columns = [];
  var directoryFirst = directoryMode ? directoryMode === 'originalFirst' : segmentRecordsDirectoryFirst_(normalized);
  schema.forEach(function (field) { var wanted = segmentRecordsName_(segmentRecordsFieldLabel_(field, directoryFirst)), found = []; normalized.forEach(function (label, index) { if (label === wanted) found.push(index); }); if (found.length !== 1) fail_('SEGMENT_MASTER_SCHEMA', 'В единой таблице отсутствует или повторяется заголовок «' + field[1] + '».'); columns.push(found[0]); });
  return { sheetId: sheet.getSheetId(), name: sheet.getName(), columns: columns, width: width, headerSignature: digest_(JSON.stringify(columns.map(function (index) { return headers[index]; }))) };
}

function segmentRecordsCell_(value, displayed) { return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : segmentRecordsText_(displayed); }
function segmentRecordsReadMasters_(targets) {
  var result = {};
  ['companies', 'lpr'].forEach(function (kind) {
    var master = segmentRecordsMaster_(targets, kind, false), sheet = master.sheet, schema = segmentRecordsSchema_(kind, targets.directory), records = [], lastRow = sheet.getLastRow();
    if (lastRow > 100001) fail_('SEGMENT_LIMIT', 'В единой таблице превышен лимит 100 000 строк.');
    if (lastRow > 1) {
      var range = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()), values = range.getValues(), display = range.getDisplayValues(), formulas = range.getFormulas();
      values.forEach(function (row, index) {
        var record = { row: index + 2, _formulaFields: {} }, populated = false;
        schema.forEach(function (field, position) { var column = master.descriptor.columns[position]; record[field[0]] = field[0].indexOf('directory') === 0 ? display[index][column] : segmentRecordsCell_(row[column], display[index][column]); populated = populated || record[field[0]] !== ''; if (formulas[index][column]) record._formulaFields[field[0]] = true; });
        if (populated) records.push(record);
      });
    }
    result[kind] = { descriptor: master.descriptor, records: records };
  });
  return result;
}

function segmentRecordsEnroll_(targets, targetKind) {
  if (typeof enrollContactWorkbook_ !== 'function') return;
  (targetKind ? [targetKind] : ['companies', 'lpr']).forEach(function (kind) {
    var master = segmentRecordsMaster_(targets, kind, false);
    enrollContactWorkbook_(targets.context, targets.tables[kind], { sourceSheetIds: [master.sheet.getSheetId()], section: kind, role: kind === 'companies' ? 'segment-companies' : 'segment-lpr', segmentId: targets.folder.getId(), relatedFileId: targets.tables[kind === 'companies' ? 'lpr' : 'companies'], seedExisting: true });
  });
}

function segmentRecordsSourceMetadata_(context, binding, targets) {
  if (binding.mode === 'segment') return segmentRecordsTargetGuard_(context, targets.folder, binding.id).metadata;
  var storage = sourceBasesStorage_(context), database = sourceBasesReadDatabase_(storage);
  requireReadySourceBase_(context, storage, database, binding.id, binding.expectedRevision);
  return Drive.Files.get(binding.id, { fields: 'id,version,modifiedTime,appProperties,capabilities(canEdit)', supportsAllDrives: true });
}

function segmentRecordsSourceSheets_(book, binding, tags) {
  var ids = binding.sheetIds, excluded = [tags.registryContactEmailSheetId, tags.registryContactPhoneSheetId].filter(function (value) { return value !== undefined; }).map(Number);
  if (!excluded.length && !tags.registryPreparedVersion && (!binding.models || binding.workingSelectionVersion === 1)) {
    var selection = workingSelectionTargets_(book.getSheets());
    if (selection) excluded = [selection.targets.emailSheetId, selection.targets.phoneSheetId];
  }
  if (!ids || !ids.length) {
    if (tags.registryPreparedVersion === '1' && tags.registryPreparedOriginalSheetId !== undefined) ids = [Number(tags.registryPreparedOriginalSheetId)];
    else {
      ids = book.getSheets().filter(function (sheet) { return excluded.indexOf(sheet.getSheetId()) === -1; }).map(function (sheet) { return sheet.getSheetId(); });
    }
  }
  if (!ids.length || ids.length > 20) fail_('SEGMENT_LOAD_LIMIT', 'Для одного переноса поддерживается не больше двадцати исходных листов.');
  return ids.map(function (sheetId) { if (excluded.indexOf(sheetId) !== -1) fail_('INVALID_SHEET_TARGET', 'Списки Email и телефонов не загружаются отдельно: выберите исходные листы базы.'); var sheet = segmentFindSheet_(book, sheetId); if (!sheet) fail_('SOURCE_SHEET_CHANGED', 'Исходный лист больше недоступен.'); return sheet; });
}

function segmentRecordsModelFingerprint_(model, tags, sheetId, mode, markerColumn) {
  var rows = model.sourceValues || [], displays = model.sourceDisplayValues || rows, excluded = Object.create(null);
  if (Number.isSafeInteger(markerColumn) && markerColumn > 0) excluded[markerColumn - 1] = true;
  var headerIndex = model.source && Number.isSafeInteger(model.source.headerIndex) ? model.source.headerIndex : 0;
  var ownFields = [];
  if (mode === 'segment') ownFields = ownFields.concat(['ID компании', 'Источники', 'Статус']);
  (displays[headerIndex] || []).forEach(function (value, index) { if (ownFields.map(segmentRecordsName_).indexOf(segmentRecordsName_(value)) !== -1) excluded[index] = true; });
  function filtered(matrix) { return matrix.map(function (row) { return row.filter(function (_value, index) { return !excluded[index]; }); }); }
  var links = (model.sourceLinks || []).filter(function (link) { return !excluded[link.column - 1]; });
  var formulas = (model.formulaSnapshots || []).filter(function (cell) { return !excluded[cell.column - 1]; });
  return digest_(JSON.stringify([model.source && (model.source.sheetName || model.source.name), model.effectiveSection || model.section || '', model.source && model.source.hasHeader, headerIndex, filtered(rows), filtered(displays), links, formulas]));
}

function segmentRecordsReadSource_(context, binding, targets) {
  for (var attempt = 0; attempt < 2; attempt++) {
    var before = segmentRecordsSourceMetadata_(context, binding, targets), tags = before.appProperties || {}, book = SpreadsheetApp.openById(binding.id), sheets = segmentRecordsSourceSheets_(book, binding, tags), records = [], warnings = [], models = [], mainModel = null;
    sheets.forEach(function (sheet) {
      var selection = (binding.sheetOptions || []).filter(function (entry) { return entry.sheetId === sheet.getSheetId(); })[0] || {}, options = { guard: function () { segmentRecordsSourceMetadata_(context, binding, targets); }, sectionExplicit: selection.section !== undefined || binding.mode === 'segment' };
      if (binding.mode === 'segment') { options.segmentMasterChannels = true; options.segmentMasterRequired = true; }
      if (binding.mixedSource && !options.sectionExplicit) options.mixedCompanyContext = preparedDataSection_(sheet.getName(), 'companies', {}) === 'companies';
      if (selection.hasHeader !== undefined) { options.hasHeader = selection.hasHeader; if (selection.hasHeader) options.headerIndex = 0; }
      var model = preparedDataRead_(sheet, binding.id, selection.section || binding.section, options);
      if (sheets.length === 1) mainModel = model;
      if (!model.complete || model.canConfirm === false) fail_('SOURCE_PARSE_INCOMPLETE', 'Исходный лист прочитан не полностью. Частичный перенос не выполняется.');
      if (!Array.isArray(model.records)) fail_('SOURCE_PARSE_UNAVAILABLE', 'Для единого формата нужен обновлённый распознаватель компаний и ЛПР.');
      records = records.concat(model.records); warnings = warnings.concat(model.warnings || []);
      var descriptor = { sheetId: sheet.getSheetId(), sheetName: sheet.getName(), hasHeader: !model.source || model.source.hasHeader !== false, headerIndex: model.source && Number.isSafeInteger(model.source.headerIndex) ? model.source.headerIndex : 0 };
      var markerColumn = segmentRecordsMarkerColumn_(sheet, context.rootId, descriptor, false);
      descriptor.fingerprint = segmentRecordsModelFingerprint_(model, tags, sheet.getSheetId(), binding.mode, markerColumn); models.push(descriptor);
    });
    var selection = binding.workingSelectionVersion === 1 && workingSelectionTargets_(book.getSheets()), history = null;
    if (!selection && binding.workingSelectionVersion === 1 &&
        (tags.registryContactRoot === context.rootId || tags.registryPreparedRoot === context.rootId) &&
        /^\d+$/.test(tags.registryContactEmailSheetId || '') && /^\d+$/.test(tags.registryContactPhoneSheetId || '')) {
      selection = { managed: true, targets: { emailSheetId: Number(tags.registryContactEmailSheetId), phoneSheetId: Number(tags.registryContactPhoneSheetId) } };
    }
    if (selection) {
      if (!selection.managed && (sheets.length !== 1 || sheets[0].getSheetId() !== selection.sourceSheetIds[0])) fail_('SOURCE_CHANGED', 'Изменился исходный лист готовой выборки.');
      history = segmentSelectionContacts_(book, selection, records, function () { segmentRecordsSourceMetadata_(context, binding, targets); }, mainModel);
    }
    var after = segmentRecordsSourceMetadata_(context, binding, targets);
    if (!before.version || !after.version || String(before.version) === String(after.version)) {
      var saved = segmentRecordsCopy_(binding); saved.sheetIds = models.map(function (model) { return model.sheetId; }); saved.models = models; saved.fingerprint = digest_(JSON.stringify(models.map(function (model) { return [model.sheetId, model.fingerprint]; }))); saved.version = String(after.version || ''); saved.canMark = !!(after.capabilities && after.capabilities.canEdit === true);
      if (history) saved.fingerprint = digest_(JSON.stringify([saved.fingerprint, history.fingerprint]));
      return { binding: saved, records: records, warnings: warnings, history: history && history.roles };
    }
  }
  fail_('SOURCE_CHANGED', 'Исходная база меняется во время чтения. Повторите предпросмотр.');
}

function segmentRecordsCollect_(context, bindings) {
  var result = { sources: [], records: [], warnings: [], history: {} };
  bindings.forEach(function (binding) {
    var read = segmentRecordsReadSource_(context, binding, null); result.sources.push(read.binding); result.records = result.records.concat(read.records); result.warnings = result.warnings.concat(read.warnings);
    Object.keys(read.history || {}).forEach(function (kind) {
      var merged = result.history[kind] || {};
      segmentSelectionMerge_(merged, read.history[kind]); result.history[kind] = merged;
    });
  });
  return result;
}

/** Every evidence row retains its company, original status and check. A shared
 * address can have more than one owner, validation or mailing decision. */
function segmentSelectionMerge_(merged, additions) {
  Object.keys(additions).forEach(function (key) {
    var rows = merged[key] || (merged[key] = []);
    additions[key].forEach(function (row) {
      if (!rows.some(function (old) { return JSON.stringify(old) === JSON.stringify(row); })) rows.push(row);
    });
  });
}

function segmentSelectionContacts_(book, selection, records, guard, mainModel) {
  var byRow = new Map(), byKey = new Map(), roles = {}, signatures = [], cells = 0;
  records.forEach(function (record) {
    var match = { record: record, people: new Map(), general: new Set() };
    [record.general].concat(record.people || []).forEach(function (target) {
      ['emails', 'phones', 'telegrams'].forEach(function (field) {
        (target[field] || []).forEach(function (value) {
          var key = field === 'telegrams' ? contactSyncKey_('phone', '', value) : contactSyncKey_(field === 'emails' ? 'email' : 'phone', value);
          if (!byKey.has(key)) byKey.set(key, new Set()); byKey.get(key).add(match);
          if (target === record.general) match.general.add(key);
          else { if (!match.people.has(key)) match.people.set(key, []); match.people.get(key).push(target); }
        });
        target[field] = [];
      });
    });
    byRow.set(record.source.sheetId + ':' + record.source.row, match);
  });
  ['email', 'phone'].forEach(function (kind) {
    guard();
    var sheet = segmentFindSheet_(book, selection.targets[kind + 'SheetId']);
    if (!sheet || selection.targets.emailSheetId === selection.targets.phoneSheetId) fail_('SOURCE_CHANGED', 'Рабочие отчёты выборки были перемещены или удалены.');
    var width = sheet.getLastColumn(), height = sheet.getLastRow();
    cells += width * height;
    if (!width || width > PREPARED_DATA_LIMITS.maxColumns || height > PREPARED_DATA_LIMITS.maxRows || cells > PREPARED_DATA_LIMITS.maxCells) fail_('SEGMENT_LOAD_LIMIT', 'Размер отчётов выборки не позволяет прочитать их полностью.');
    var headers = sheet.getRange(1, 1, 1, width).getDisplayValues()[0];
    function col(names) { for (var i = 0; i < names.length; i++) { var position = headers.indexOf(names[i]); if (position >= 0) return position; } return -1; }
    var contact = kind === 'email' ? col(['Email']) : col(['Мобильный телефон', 'Телефон']), telegram = col(['Telegram']), validation = col(['Валидация']);
    if (contact < 0) fail_('SOURCE_CHANGED', 'В отчёте отсутствует колонка контакта.');
    var size = Math.max(1, Math.floor(50000 / width));
    for (var start = 2; start <= height; start += size) {
      guard();
      var count = Math.min(size, height - start + 1), data = sheet.getRange(start, 1, count, width).getDisplayValues();
      var notes = validation >= 0 ? sheet.getRange(start, validation + 1, count, 1).getNotes() : null;
      data.forEach(function (line, index) {
        if (!line[contact] && line.every(function (value) { return !value; })) return;
        var key = contactSyncKey_(kind, line[contact], line[telegram]), handle = key.indexOf('telegram:') === 0;
        var field = kind === 'email' ? 'emails' : handle ? 'telegrams' : 'phones';
        var value = kind === 'email' ? pvEmail_(line[contact]) : handle ? String(line[telegram] || '') : pvPhone_(line[contact]);
        if (selection.managed && !byKey.has(key)) return;
        if (!value || !key) fail_('SOURCE_CHANGED', 'В отчёте выборки есть строка без однозначного контакта. Проверьте строку ' + (start + index) + ' на листе «' + sheet.getName() + '».');
        var refText = String(line[col(['Строки в Лист1', 'Исходные строки'])] || '').trim();
        var fields = {};
        ['Статус', 'Комментарий', 'Компания', 'ID компании', 'Связанные ID компаний', 'Валидация', 'Дата проверки', 'Результат проверки', 'Валидатор', 'Провайдер', 'ID_TG', 'Nickname_TG', 'Active_days_ago', 'Статус из источника'].forEach(function (label) {
          var column = label === 'Статус' ? col(['Статус рассылки', 'Статус']) : label === 'Компания' ? col(['Компания', 'Компания / ЛПР']) : col([label]);
          if (column >= 0 && line[column] !== '') fields[label] = String(line[column]);
        });
        var bound = notes && pvBinding_(notes[index][0]);
        if (bound && bound !== pvKey_(kind === 'email' ? 'email' : handle ? 'telegram_username' : 'telegram', value)) fail_('SOURCE_CHANGED', 'Контакт и сохранённая проверка относятся к разным значениям. Обновите отчёт выборки.');
        var matches;
        if (selection.managed) matches = Array.from(byKey.get(key));
        else {
          if (!/^\d+(?:\s*[,;]\s*\d+)*$/.test(refText)) fail_('SOURCE_CHANGED', 'Проверьте номера исходных строк в отчёте выборки.');
          matches = refText.split(/\s*[,;]\s*/).map(function (row) { return byRow.get(selection.sourceSheetIds[0] + ':' + Number(row)); });
        }
        var applied = false, entries = new Map();
        matches.forEach(function (match) {
          if (!match) fail_('SOURCE_CHANGED', 'Ссылка в отчёте ведёт на отсутствующую строку компании.');
          if (fields['ID компании'] && match.record.company.id && fields['ID компании'] !== match.record.company.id) return;
          if (!selection.managed && !match.general.has(key) && !match.people.has(key)) {
            var dataRow = mainModel && mainModel.sourceDisplayValues[match.record.source.row - 1];
            var confirmed = dataRow && mainModel.source.headers.some(function (label, column) {
              if (kind === 'email') return /email|почт/i.test(label) && preparedDataEmails_(dataRow[column]).indexOf(value) >= 0;
              if (!/телефон|whatsapp|telegram/i.test(label)) return false;
              var phones = preparedDataPhones_(dataRow[column]);
              preparedDataTextUrls_(dataRow[column]).forEach(function (url) { phones = phones.concat(preparedDataUrlPhones_(url)); });
              return phones.some(function (phone) { return contactSyncKey_('phone', phone.value) === key; });
            });
            if (!confirmed) fail_('SOURCE_CHANGED', 'Контакт из отчёта отсутствует в указанных исходных строках. Проверьте связь перед переносом.');
          }
          var ref = match.record.source, evidence = entries.get(ref.sheetId);
          if (!evidence) { evidence = { source: book.getId(), sourceSheet: ref.sheetId, sheet: sheet.getSheetId(), row: start + index, refs: [], fields: fields }; entries.set(ref.sheetId, evidence); }
          evidence.refs.push(ref.row);
          var people = match.people.get(key) || [], targets = people.slice();
          if (!people.length || match.general.has(key)) targets.push(match.record.general);
          targets.forEach(function (target) {
            if (target[field].indexOf(value) < 0) target[field].push(value);
            var role = target === match.record.general ? 'companies' : 'lpr', history = roles[role] || (roles[role] = {}), rows = history[key] || (history[key] = []);
            if (rows.indexOf(evidence) < 0) rows.push(evidence);
          });
          applied = true;
        });
        if (!applied && !selection.managed) fail_('SOURCE_CHANGED', 'ID компании в отчёте не соответствует указанным исходным строкам.');
        entries.forEach(function (evidence) { evidence.refs = evidence.refs.join(', '); signatures.push([key, evidence]); });
      });
    }
  });
  return { roles: roles, fingerprint: digest_(JSON.stringify(signatures)) };
}

function segmentSelectionAccepted_(history, masters, planned) {
  var result = {};
  Object.keys(history).forEach(function (kind) {
    var schema = segmentRecordsSchema_(kind).map(function (field) { return field[0]; });
    var byRow = new Map(), accepted = new Map();
    masters[kind].records.forEach(function (record) { byRow.set(record.row, segmentRecordsValues_(record, kind)); });
    (kind === 'companies' ? planned.companies : planned.people).forEach(function (action) { byRow.set(action.row, action.after); });
    byRow.forEach(function (row) {
      var refs = String(row[schema.indexOf('sources')] || '').split('\n');
      ['emails', 'phones', 'telegrams'].forEach(function (field) {
        var channel = field === 'emails' ? 'email' : field === 'phones' ? 'phone' : 'telegram';
        segmentRecordsList_(row[schema.indexOf(field)], channel).forEach(function (value) {
          var key = channel === 'telegram' ? contactSyncKey_('phone', '', value) : contactSyncKey_(channel, value); if (!history[kind][key]) return;
          if (!accepted.has(key)) accepted.set(key, new Set());
          refs.forEach(function (ref) { accepted.get(key).add(ref.trim()); });
        });
      });
    });
    Object.keys(history[kind]).forEach(function (key) {
      var refs = accepted.get(key); if (!refs) return;
      var rows = history[kind][key].filter(function (entry) {
        return entry.refs.split(/\s*[,;]\s*/).some(function (row) {
          return refs.has(segmentRecordsSourceLabel_({ fileId: entry.source, sheetId: entry.sourceSheet, row: Number(row) }));
        });
      });
      if (rows.length) { if (!result[kind]) result[kind] = {}; result[kind][key] = rows; }
    });
  });
  return result;
}

function segmentRecordsPreview_(targets, token, plan) {
  return { state: 'preview', segmentId: plan.segmentId, segment: segmentActionResult_(targets.context, targets.folder, targets.tables), targetKind: plan.targetKind || null, planToken: token, counts: plan.counts, sample: plan.sample, headers: { companies: segmentRecordsSchema_('companies', plan.directory).map(function (field) { return segmentRecordsFieldLabel_(field, false); }), people: SEGMENT_RECORDS_SCHEMA.person.map(function (field) { return field[1]; }) }, review: plan.review, warnings: plan.warnings, canConfirm: true };
}

function segmentRecordsSavePlan_(context, plan) {
  var body = JSON.stringify(plan); if (body.length > SEGMENT_RECORD_IMPORT.maxPlanCharacters) fail_('SEGMENT_LOAD_LIMIT', 'План слишком большой. Загрузите исходные базы несколькими действиями.');
  var token = digest_(body), folder = preparedEnsureFolder_(context), name = '.segment-records-' + token + '.json';
  var file = Drive.Files.create({ name: name, mimeType: 'application/json', parents: [folder.getId()], appProperties: { registrySegmentImportRole: 'plan', registrySegmentImportRoot: context.rootId, registrySegmentImportToken: token, registrySegmentImportSegment: plan.segmentId } }, Utilities.newBlob(body, 'application/json', name), { fields: 'id', supportsAllDrives: true });
  var reference = { fileId: id_(file.id), folderId: folder.getId(), rootId: context.rootId, segmentId: plan.segmentId, token: token, expiresAt: plan.expiresAt };
  var removed = locked_(function () {
    var current = authorize_(), index, jobs, protectedTokens = Object.create(null), discarded = [];
    try { index = JSON.parse(current.properties.getProperty(SEGMENT_RECORD_IMPORT.previewIndexKey) || '[]'); jobs = JSON.parse(current.properties.getProperty(SEGMENT_RECORD_IMPORT.indexKey) || '[]'); } catch (error) { fail_('SEGMENT_JOB_MISSING', 'Журнал предпросмотров требует проверки.'); }
    if (!Array.isArray(index) || !Array.isArray(jobs)) fail_('SEGMENT_JOB_MISSING', 'Журнал предпросмотров требует проверки.');
    jobs.forEach(function (id) { try { var job = segmentRecordsReadJob_(current, id); if (Date.parse(job.expiresAt) > Date.now()) protectedTokens[job.planToken] = true; } catch (error) { /* Missing receipts cannot refer to a live plan. */ } });
    function discard(oldToken) { var key = SEGMENT_RECORD_IMPORT.previewPrefix + oldToken, old; try { old = JSON.parse(current.properties.getProperty(key)); } catch (error) { old = null; } if (old) discarded.push(old); current.properties.deleteProperty(key); }
    index = index.filter(function (oldToken) { if (oldToken === token) return false; var old; try { old = JSON.parse(current.properties.getProperty(SEGMENT_RECORD_IMPORT.previewPrefix + oldToken)); } catch (error) { old = null; } if (!old || (!protectedTokens[oldToken] && Date.parse(old.expiresAt) <= Date.now())) { discard(oldToken); return false; } return true; });
    while (index.length >= SEGMENT_RECORD_IMPORT.maxPreviews) { var position = index.findIndex(function (oldToken) { return !protectedTokens[oldToken]; }); if (position < 0) fail_('BUSY', 'Слишком много активных предпросмотров. Продолжите начатые загрузки.'); discard(index.splice(position, 1)[0]); }
    current.properties.setProperty(SEGMENT_RECORD_IMPORT.previewPrefix + token, JSON.stringify(reference)); index.push(token); current.properties.setProperty(SEGMENT_RECORD_IMPORT.previewIndexKey, JSON.stringify(index)); return discarded;
  });
  removed.forEach(function (old) {
    try {
      var metadata = Drive.Files.get(old.fileId, { fields: 'id,mimeType,parents,appProperties,trashed', supportsAllDrives: true }), tags = metadata.appProperties || {};
      if (old.rootId === context.rootId && old.fileId !== reference.fileId && metadata.mimeType === 'application/json' && !metadata.trashed && Array.isArray(metadata.parents) && metadata.parents.length === 1 && metadata.parents[0] === old.folderId && old.folderId === reference.folderId && tags.registrySegmentImportRoot === context.rootId && tags.registrySegmentImportRole === 'plan' && tags.registrySegmentImportToken === old.token && tags.registrySegmentImportSegment === old.segmentId) Drive.Files.update({ trashed: true }, old.fileId, null, { fields: 'id', supportsAllDrives: true });
    } catch (error) { console.warn('Expired segment preview cleanup was deferred.'); }
  });
  return { token: token, reference: reference };
}

function segmentRecordsLoadPreview_(context, token, segmentId) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail_('INVALID_REQUEST', 'Получите новый предпросмотр загрузки.');
  var raw = context.properties.getProperty(SEGMENT_RECORD_IMPORT.previewPrefix + token), reference;
  try { reference = JSON.parse(raw); } catch (error) { fail_('SEGMENT_PREVIEW_EXPIRED', 'Предпросмотр недоступен. Выполните его заново.'); }
  if (!reference || reference.rootId !== context.rootId || reference.segmentId !== segmentId || Date.parse(reference.expiresAt) <= Date.now()) fail_('SEGMENT_PREVIEW_EXPIRED', 'Предпросмотр истёк или относится к другому сегменту.');
  var metadata = Drive.Files.get(id_(reference.fileId), { fields: 'id,mimeType,parents,trashed,appProperties', supportsAllDrives: true });
  var tags = metadata.appProperties || {};
  preparedFolder_(context, reference.folderId);
  if (metadata.trashed || metadata.mimeType !== 'application/json' || !Array.isArray(metadata.parents) || metadata.parents.length !== 1 || metadata.parents[0] !== reference.folderId || tags.registrySegmentImportRole !== 'plan' || tags.registrySegmentImportRoot !== context.rootId || tags.registrySegmentImportToken !== token || tags.registrySegmentImportSegment !== segmentId) fail_('OUTSIDE_REGISTRY', 'План переноса был перемещён или заменён.');
  var text = DriveApp.getFileById(reference.fileId).getBlob().getDataAsString();
  if (text.length > SEGMENT_RECORD_IMPORT.maxPlanCharacters || digest_(text) !== token) fail_('SEGMENT_PREVIEW_CHANGED', 'Подтверждённый план изменён. Получите новый предпросмотр.');
  var plan; try { plan = JSON.parse(text); } catch (error) { fail_('SEGMENT_PREVIEW_CHANGED', 'План переноса повреждён.'); }
  if (plan.version !== SEGMENT_RECORD_IMPORT.version || plan.rootId !== context.rootId || plan.segmentId !== segmentId) fail_('OUTSIDE_REGISTRY', 'План переноса не относится к этому реестру.');
  return plan;
}

function segmentRecordsReadJob_(context, jobId) {
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(jobId)) fail_('INVALID_REQUEST', 'Некорректный идентификатор загрузки.');
  var raw = context.properties.getProperty(SEGMENT_RECORD_IMPORT.jobPrefix + jobId), job;
  try { job = JSON.parse(raw); } catch (error) { fail_('SEGMENT_JOB_MISSING', 'Загрузка не найдена.'); }
  if (!job || job.rootId !== context.rootId || job.id !== jobId) fail_('SEGMENT_JOB_MISSING', 'Загрузка недоступна в этом реестре.');
  return job;
}
function segmentRecordsSaveJob_(context, job) { var value = JSON.stringify(job); if (value.length > 8500) fail_('SEGMENT_LOAD_LIMIT', 'Слишком большой журнал загрузки.'); context.properties.setProperty(SEGMENT_RECORD_IMPORT.jobPrefix + job.id, value); }
function segmentRecordsActiveJob_(context, segmentId) {
  var id = context.properties.getProperty('SEGMENT_RECORD_ACTIVE_' + segmentId); if (!id) return null;
  var job; try { job = segmentRecordsReadJob_(context, id); } catch (error) { return null; }
  return job.segmentId === segmentId && job.state === 'processing' && Date.parse(job.expiresAt) > Date.now() ? job : null;
}

function segmentRecordsAllocateJob_(context, plan, token, requestId) {
  return locked_(function () {
    var current = authorize_(), id = digest_([current.rootId, plan.segmentId, requestId].join('|')), oldRaw = current.properties.getProperty(SEGMENT_RECORD_IMPORT.jobPrefix + id);
    if (typeof registryRequireSegment_ === 'function') registryRequireSegment_(current, plan.segmentId);
    if (oldRaw) { var old = segmentRecordsReadJob_(current, id); if (old.planToken !== token) fail_('REQUEST_REUSED', 'Идентификатор загрузки уже использован с другим предпросмотром.'); return old; }
    var active = segmentRecordsActiveJob_(current, plan.segmentId); if (active) fail_('BUSY', 'Предыдущая загрузка в сегмент ещё не завершена. Сначала продолжите её.');
    var index; try { index = JSON.parse(current.properties.getProperty(SEGMENT_RECORD_IMPORT.indexKey) || '[]'); } catch (error) { fail_('SEGMENT_JOB_MISSING', 'Журнал загрузок требует проверки.'); }
    if (!Array.isArray(index)) fail_('SEGMENT_JOB_MISSING', 'Журнал загрузок требует проверки.');
    while (index.length >= SEGMENT_RECORD_IMPORT.maxJobs) {
      var position = index.findIndex(function (jobId) { try { var job = segmentRecordsReadJob_(current, jobId); return job.state !== 'processing' || Date.parse(job.expiresAt) <= Date.now(); } catch (error) { return true; } });
      if (position < 0) fail_('BUSY', 'Слишком много незавершённых загрузок сегментов.');
      current.properties.deleteProperty(SEGMENT_RECORD_IMPORT.jobPrefix + index.splice(position, 1)[0]);
    }
    var job = { id: id, rootId: current.rootId, segmentId: plan.segmentId, planToken: token, requestId: requestId, state: 'processing', phase: plan.targetKind === 'lpr' ? 'people' : 'companies', cursor: 0, pending: null, sourceVersions: {}, expiresAt: plan.expiresAt, warnings: [] };
    segmentRecordsSaveJob_(current, job); index.push(id); current.properties.setProperty(SEGMENT_RECORD_IMPORT.indexKey, JSON.stringify(index)); current.properties.setProperty('SEGMENT_RECORD_ACTIVE_' + plan.segmentId, id); return job;
  });
}

function segmentRecordsRunJob_(jobId, requestId) {
  var claim = locked_(function () {
    var context = authorize_(), job = segmentRecordsReadJob_(context, jobId);
    if (typeof registryRequireSegment_ === 'function') registryRequireSegment_(context, job.segmentId);
    if (job.requestId !== requestId) fail_('REQUEST_REUSED', 'Используйте прежний идентификатор загрузки.');
    if (job.leaseUntil > Date.now()) fail_('BUSY', 'Эта загрузка сейчас выполняется. Повторите проверку через несколько секунд.');
    job.lease = Utilities.getUuid(); job.leaseUntil = Date.now() + SEGMENT_RECORD_IMPORT.leaseMillis; segmentRecordsSaveJob_(context, job); return { context: context, job: job, lease: job.lease };
  });
  try {
    var context = claim.context, job = claim.job, plan = segmentRecordsLoadPreview_(context, job.planToken, job.segmentId), targets = segmentRecordsTargets_(context, job.segmentId, false);
    targets.directory = plan.directory === true;
    if (job.state === 'complete') return segmentRecordsJobResult_(context, targets, job, plan);
    if (job.state !== 'processing' || Date.parse(job.expiresAt) <= Date.now()) fail_('SEGMENT_JOB_EXPIRED', 'Загрузка остановлена. Получите новый предпросмотр.');
    if (targets.tables.companies !== plan.tables.companies || targets.tables.lpr !== plan.tables.lpr) fail_('SEGMENT_MASTER_CHANGED', 'Рабочие таблицы сегмента были перепривязаны.');
    segmentRecordsCheckSources_(context, plan, job, targets);
    if (plan.workingHistory && !job.historyInstalled) {
      var waiting = Object.keys(plan.workingHistory).some(function (kind) {
        segmentRecordsTargetGuard_(context, targets.folder, targets.tables[kind]);
        return contactSyncInstallWorkingHistory_(targets.tables[kind], kind, plan.segmentId, plan.workingHistory[kind], plan.materializeContacts) === false;
      });
      if (waiting) return segmentRecordsJobResult_(context, targets, job, plan);
      job.historyInstalled = true; segmentRecordsSaveJob_(context, job);
    }
    segmentRecordsAdvance_(context, targets, plan, job);
    return segmentRecordsJobResult_(context, targets, job, plan);
  } catch (error) {
    if (error && (['SOURCE_CHANGED', 'SOURCE_SHEET_CHANGED', 'SEGMENT_MASTER_CHANGED', 'SEGMENT_TARGET_CONFLICT', 'SOURCE_NOT_READY', 'CONFLICT'].indexOf(error.registryCode) !== -1 || (plan && plan.materializeContacts && error.registryCode === 'CONTACT_SOURCE_CHANGED'))) {
      try { claim.job.state = 'needs_review'; claim.job.errorCode = 'SEGMENT_PREVIEW_CHANGED'; segmentRecordsSaveJob_(claim.context, claim.job); if (claim.context.properties.getProperty('SEGMENT_RECORD_ACTIVE_' + claim.job.segmentId) === claim.job.id) claim.context.properties.deleteProperty('SEGMENT_RECORD_ACTIVE_' + claim.job.segmentId); } catch (cleanupError) { /* Existing rows stay authoritative if journaling is unavailable. */ }
      fail_('SEGMENT_PREVIEW_CHANGED', 'Данные изменились после предпросмотра. Уже подтверждённые строки сохранены. Обновите предпросмотр перед продолжением.');
    }
    throw error;
  } finally {
    try { var latest = segmentRecordsReadJob_(claim.context, jobId); if (latest.lease === claim.lease && latest.leaseUntil > Date.now() + 60000) { delete latest.lease; delete latest.leaseUntil; segmentRecordsSaveJob_(claim.context, latest); } } catch (error) { console.warn('Segment import lease release was deferred.'); }
  }
}

function segmentRecordsCheckSources_(context, plan, job, targets) {
  plan.sources.forEach(function (binding) {
    var metadata = segmentRecordsSourceMetadata_(context, binding, targets), version = String(metadata.version || '');
    if (version && (job.sourceVersions[binding.id] || binding.version) === version) return;
    var read = segmentRecordsReadSource_(context, binding, targets);
    if (read.binding.fingerprint !== binding.fingerprint) fail_('SOURCE_CHANGED', 'Исходная база изменена после предпросмотра. Уже добавленные строки сохранены; получите новый предпросмотр для продолжения.');
    job.sourceVersions[binding.id] = read.binding.version;
  });
}

function segmentRecordsAdvance_(context, targets, plan, job) {
  if (job.phase === 'companies' || job.phase === 'people' || job.phase === 'companyMarkers') {
    var kind = job.phase === 'people' ? 'lpr' : 'companies', actions = job.phase === 'companies' ? plan.companies : job.phase === 'people' ? plan.people : plan.companyMarkers || [], master = segmentRecordsMaster_(targets, kind, false), expected = plan.masters[kind];
    if (master.sheet.getSheetId() !== expected.sheetId || master.descriptor.headerSignature !== expected.headerSignature || JSON.stringify(master.descriptor.columns) !== JSON.stringify(expected.columns)) fail_('SEGMENT_MASTER_CHANGED', 'Столбцы единой таблицы изменены. Перенос остановлен.');
    if (plan.linkedCompanies && kind === 'lpr') {
      var companyMaster = segmentRecordsMaster_(targets, 'companies', false);
      var ids = Object.keys(plan.linkedCompanies), column = companyMaster.descriptor.columns[0] + 1;
      var count = companyMaster.sheet.getLastRow() - 1;
      var currentIds = count ? companyMaster.sheet.getRange(2, column, count, 1).getDisplayValues() : [];
      var seen = new Set(), repeated = new Set();
      currentIds.forEach(function (row) { if (seen.has(row[0])) repeated.add(row[0]); else seen.add(row[0]); });
      if (ids.some(function (id) { return !seen.has(id) || repeated.has(id); })) fail_('SEGMENT_MASTER_CHANGED', 'Изменились компании, указанные в предпросмотре ЛПР. Обновите предпросмотр.');
    }
    if (job.pending) {
      var pending = actions.slice(job.pending.start, job.pending.start + job.pending.count);
      var check = segmentRecordsApplyActions_(context, targets, kind, master, pending, true);
      if (check === 'before') segmentRecordsApplyActions_(context, targets, kind, master, pending, false);
      else { job.cursor = job.pending.start + job.pending.count; job.pending = null; segmentRecordsSaveJob_(context, job); }
      if (job.pending) return;
    }
    if (job.cursor >= actions.length) { job.phase = plan.targetKind ? (plan.materializeContacts ? 'contacts' : 'relations') : job.phase === 'companies' ? 'people' : job.phase === 'people' ? 'companyMarkers' : 'markers'; job.cursor = 0; segmentRecordsSaveJob_(context, job); return; }
    var first = actions[job.cursor], limit = first.added ? SEGMENT_RECORD_IMPORT.newRowsPerStep : SEGMENT_RECORD_IMPORT.changedRowsPerStep;
    var batch = actions.slice(job.cursor, job.cursor + limit);
    while (batch.length > 1 && ((batch[batch.length - 1].row - batch[0].row + 1) * master.descriptor.width > 50000 || (first.added && batch.some(function (action, index) { return !action.added || action.row !== first.row + index; })))) batch.pop();
    job.pending = { start: job.cursor, count: batch.length }; segmentRecordsSaveJob_(context, job);
    segmentRecordsApplyActions_(context, targets, kind, master, batch, false); return;
  }
  if (job.phase === 'markers') {
    segmentRecordsMarkSources_(context, targets, plan, job);
    job.phase = plan.materializeContacts ? 'contacts' : 'relations'; job.cursor = 0; segmentRecordsSaveJob_(context, job); return;
  }
  if (job.phase === 'contacts') {
    var kinds = plan.targetKind ? [plan.targetKind] : ['companies', 'lpr'], contactKind = kinds[job.cursor];
    segmentRecordsTargetGuard_(context, targets.folder, targets.tables[contactKind]);
    var contactRequest = digest_(JSON.stringify(['segment-contacts', job.id, contactKind]));
    if (contactSyncSegmentImportStep_(targets.tables[contactKind], contactKind, plan.segmentId, contactRequest)) {
      job.cursor++;
      if (job.cursor === kinds.length) { job.phase = 'relations'; job.cursor = 0; }
      segmentRecordsSaveJob_(context, job);
    }
    return;
  }
  if (job.phase === 'relations') {
    locked_(function () {
      var fresh = authorize_(), storage = sourceBasesStorage_(fresh), database = sourceBasesReadDatabase_(storage);
      if (plan.mode === 'registry') plan.sources.forEach(function (binding) {
        requireReadySourceBase_(fresh, storage, database, binding.id, binding.expectedRevision);
        segmentRememberRelation_(fresh, storage, database, binding.id, plan.segmentId, job.id);
      });
    });
    segmentRecordsEnroll_(targets, plan.targetKind); job.state = 'complete'; job.phase = 'complete'; segmentRecordsSaveJob_(context, job);
    if (context.properties.getProperty('SEGMENT_RECORD_ACTIVE_' + job.segmentId) === job.id) context.properties.deleteProperty('SEGMENT_RECORD_ACTIVE_' + job.segmentId);
    return;
  }
  fail_('SEGMENT_JOB_MISSING', 'Неизвестный этап нормализованной загрузки.');
}

function segmentRecordsApplyActions_(context, targets, kind, master, actions, verifyOnly) {
  if (!actions.length) return 'after';
  var sheet = master.sheet, columns = master.descriptor.columns, start = actions[0].row, end = actions[actions.length - 1].row, width = Math.max(sheet.getLastColumn(), master.descriptor.width);
  if ((end - start + 1) * width > 50000) fail_('SEGMENT_LOAD_LIMIT', 'Изменяемые строки расположены слишком далеко друг от друга.');
  if (end > sheet.getMaxRows()) { if (verifyOnly) return 'before'; sheet.insertRowsAfter(sheet.getMaxRows(), end - sheet.getMaxRows()); }
  var range = sheet.getRange(start, 1, end - start + 1, width), raw = range.getValues(), display = range.getDisplayValues(), formulas = range.getFormulas(), values = [], masks = [], allAfter = true, anyBefore = false;
  for (var i = 0; i < raw.length; i++) { values.push(Array(width).fill('')); masks.push(Array(width).fill(false)); }
  actions.forEach(function (action) {
    var index = action.row - start, current = columns.map(function (column, position) { return kind === 'companies' && position >= SEGMENT_RECORDS_SCHEMA.company.length ? display[index][column] : segmentRecordsCell_(raw[index][column], display[index][column]); });
    var changed = action.after.map(function (value, position) { return !action.before.length || value !== action.before[position]; });
    if (current[0] && current[0] !== action.id) fail_('SEGMENT_TARGET_CONFLICT', 'Строки рабочей таблицы изменены или отсортированы после предпросмотра. Правки пользователя сохранены.');
    var isAfter = changed.every(function (flag, position) { return !flag || (!formulas[index][columns[position]] && current[position] === action.after[position]); });
    var isBefore = changed.every(function (flag, position) { return !flag || (!formulas[index][columns[position]] && current[position] === (action.before[position] || '')); });
    if (action.added && !isAfter && raw[index].some(function (value) { return value !== '' && value !== null; })) isBefore = false;
    if (!isAfter && !isBefore) fail_('SEGMENT_TARGET_CONFLICT', 'Значение рабочей таблицы изменено после предпросмотра. Ваши данные не перезаписывались.');
    allAfter = allAfter && isAfter; anyBefore = anyBefore || !isAfter;
    if (!isAfter) changed.forEach(function (flag, position) { if (flag) { values[index][columns[position]] = action.after[position]; masks[index][columns[position]] = true; } });
  });
  if (allAfter) return 'after';
  if (verifyOnly) return anyBefore ? 'before' : 'after';
  segmentRecordsTargetGuard_(context, targets.folder, targets.tables[kind]);
  sheetWriteRawStrings_(targets.tables[kind], sheet.getSheetId(), start, 1, values, masks); return 'written';
}

function segmentRecordsMarkSources_(context, targets, plan, job) {
  if (plan.mode !== 'registry') return;
  plan.sources.forEach(function (binding) {
    var marks = plan.markers.filter(function (marker) { return marker.source.fileId === binding.id; }); if (!marks.length) return;
    var metadata = segmentRecordsSourceMetadata_(context, binding, targets);
    if (!metadata.capabilities || metadata.capabilities.canEdit !== true) { var warning = 'ЛПР перенесены, но нет прав отметить исходную базу: ' + binding.id; if (job.warnings.indexOf(warning) === -1) job.warnings.push(warning); return; }
    segmentRecordsWithMarkerLease_(context, binding.id, function () {
      var book = SpreadsheetApp.openById(binding.id), tags = metadata.appProperties || {}, nextTags = segmentRecordsCopy_(tags);
      binding.models.forEach(function (model) {
      var entries = marks.filter(function (marker) { return marker.source.sheetId === model.sheetId; }); if (!entries.length) return;
      var sheet = segmentFindSheet_(book, model.sheetId); if (!sheet) fail_('SOURCE_SHEET_CHANGED', 'Исходный лист исчез до пометки переноса.');
      var column = segmentRecordsMarkerColumn_(sheet, context.rootId, model, true);
      nextTags['registryLprMarker_' + model.sheetId] = String(column); nextTags.registryLprMarkerRoot = context.rootId;
      Drive.Files.update({ appProperties: nextTags }, binding.id, null, { fields: 'id', supportsAllDrives: true });
      var first = Math.min.apply(null, entries.map(function (marker) { return marker.source.row; })), last = Math.max.apply(null, entries.map(function (marker) { return marker.source.row; }));
      var existing = sheet.getRange(first, column, last - first + 1, 1).getDisplayValues(), values = existing.map(function (row) { return [String(row[0] || '')]; }), mask = existing.map(function () { return [false]; });
      var line = 'Перенесено в ЛПР — ' + plan.segmentName + ' (' + spreadsheetUrl_(targets.tables.lpr) + ')';
      entries.forEach(function (marker) { var index = marker.source.row - first, old = values[index][0]; if (old.indexOf(line) === -1) { var text = old ? old + '\n' + line : line; if (text.length > 45000) fail_('SOURCE_MARKER_LIMIT', 'Пометка переноса слишком длинная. Данные ЛПР уже сохранены.'); values[index][0] = text; mask[index][0] = true; } });
      segmentRecordsSourceMetadata_(context, binding, targets);
      if (segmentRecordsMarkerColumn_(sheet, context.rootId, model, false) !== column) fail_('SOURCE_CHANGED', 'Столбцы исходной базы перемещены. Пометка не записывалась в чужие ячейки.');
      sheetWriteRawStrings_(binding.id, model.sheetId, first, column, values, mask);
      });
    });
  });
}

/** Header names and column-bound metadata move with user edits; stale numeric hints are never trusted. */
function segmentRecordsMarkerColumn_(sheet, rootId, model, create) {
  if (model.hasHeader) {
    var width = sheet.getLastColumn(), headerRow = model.headerIndex + 1, headers = width ? sheet.getRange(headerRow, 1, 1, width).getDisplayValues()[0] : [], found = [];
    headers.forEach(function (label, index) { if (segmentRecordsName_(label) === segmentRecordsName_(SEGMENT_RECORDS_SCHEMA.markerHeader)) found.push(index + 1); });
    if (found.length > 1) fail_('SOURCE_MARKER_AMBIGUOUS', 'Столбец «Перенос в ЛПР» повторяется. Пометка не записывалась в неоднозначный столбец.');
    if (found.length) return found[0];
    if (!create) return 0;
    var column = width + 1; if (column > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), column - sheet.getMaxColumns());
    sheetWriteRawStrings_(sheet.getParent().getId(), sheet.getSheetId(), headerRow, column, [[SEGMENT_RECORDS_SCHEMA.markerHeader]]); return column;
  }
  var matches = [], key = 'registry_lpr_transfer';
  if (typeof sheet.createDeveloperMetadataFinder === 'function') {
    sheet.createDeveloperMetadataFinder().withKey(key).withValue(rootId).find().forEach(function (metadata) { var location = metadata.getLocation(), range = location && location.getColumn(); if (range && range.getSheet().getSheetId() === sheet.getSheetId() && matches.indexOf(range.getColumn()) === -1) matches.push(range.getColumn()); });
  }
  if (matches.length > 1) fail_('SOURCE_MARKER_AMBIGUOUS', 'В исходном листе несколько связанных столбцов переноса.');
  if (matches.length) return matches[0];
  if (!create) return 0;
  if (typeof sheet.createDeveloperMetadataFinder !== 'function') fail_('SOURCE_MARKER_BINDING_REQUIRED', 'Google не подтвердил безопасную привязку столбца листа без заголовка. ЛПР сохранены; исходные ячейки не заменялись.');
  var column = sheet.getLastColumn() + 1; if (column > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), column - sheet.getMaxColumns());
  var range = sheet.getRange(1, column, sheet.getMaxRows(), 1);
  if (typeof range.addDeveloperMetadata !== 'function') fail_('SOURCE_MARKER_BINDING_REQUIRED', 'Не удалось безопасно привязать столбец пометки.');
  range.addDeveloperMetadata(key, rootId);
  return column;
}

function segmentRecordsWithMarkerLease_(context, fileId, callback) {
  var key = 'SEGMENT_MARKER_LEASE_' + fileId, token = Utilities.getUuid();
  locked_(function () {
    var raw = context.properties.getProperty(key), old = null; try { old = raw ? JSON.parse(raw) : null; } catch (error) { fail_('BUSY', 'Журнал пометок исходной базы требует проверки.'); }
    if (old && old.until > Date.now()) fail_('BUSY', 'Эта исходная база сейчас отмечается другим переносом. Повторите продолжение через несколько секунд.');
    context.properties.setProperty(key, JSON.stringify({ token: token, until: Date.now() + SEGMENT_RECORD_IMPORT.leaseMillis }));
  });
  try { return callback(); }
  finally { try { var raw = context.properties.getProperty(key), latest = raw ? JSON.parse(raw) : null; if (latest && latest.token === token && latest.until > Date.now() + 60000) context.properties.deleteProperty(key); } catch (error) { console.warn('Segment source marker lease release was deferred.'); } }
}

function segmentRecordsJobResult_(context, targets, job, plan) {
  var total = plan.companies.length + plan.people.length + (plan.companyMarkers || []).length, completed = job.phase === 'companies' ? job.cursor : job.phase === 'people' ? plan.companies.length + job.cursor : job.phase === 'companyMarkers' ? plan.companies.length + plan.people.length + job.cursor : total;
  var labels = { companies: 'Дополняем единую базу компаний…', people: 'Дополняем связанную базу ЛПР…', companyMarkers: 'Подтверждаем перенос в таблице компаний…', markers: 'Отмечаем перенос в исходных строках…', contacts: 'Заполняем вкладки Email и телефонов в таблице ' + (plan.targetKind === 'lpr' || job.cursor === 1 ? 'ЛПР…' : 'компаний…'), relations: 'Сохраняем связи с исходными базами…', complete: 'Базы сегмента обновлены.' };
  return { state: job.state, segmentId: job.segmentId, segment: segmentActionResult_(context, targets.folder, targets.tables), targetKind: plan.targetKind || null, jobId: job.id, requestId: job.requestId, counts: plan.counts, review: plan.review, warnings: (plan.warnings || []).concat(job.warnings || []), progress: { phase: job.phase, completed: completed, total: total, label: labels[job.phase] || 'Продолжаем загрузку…' } };
}

/** A transfer marker becomes true only after all corresponding person writes were verified. */
function segmentRecordsSplitCompanyMarkers_(actions) {
  var index = SEGMENT_RECORDS_SCHEMA.company.map(function (field) { return field[0]; }).indexOf('transferred'), companies = [], markers = [];
  actions.forEach(function (action) {
    var base = segmentRecordsCopy_(action); base.before = action.before.slice(); base.after = action.after.slice();
    var beforeMarker = action.before[index] || '', afterMarker = action.after[index] || '';
    if (afterMarker !== beforeMarker) {
      base.after[index] = beforeMarker;
      markers.push({ row: action.row, id: action.id, before: base.after.slice(), after: action.after.slice(), added: false });
    }
    if (action.added || JSON.stringify(base.before) !== JSON.stringify(base.after)) companies.push(base);
  });
  return { companies: companies, markers: markers };
}

/** Compatibility for old open clients: source loads are normalized, never copied as extra leaves. */
function segmentNormalizedMutation_(kind, request) {
  var input = segmentMutationInput_(kind, request), loads = input.loads || [];
  if (loads.length) segmentRecordsReadySources_(authorize_(), segmentRecordsInputSources_({ loads: loads }));
  var empty = segmentRecordsCopy_(input); empty.loads = [];
  if (kind === 'update' && loads.length && input.name === undefined) {
    var existingContext = authorize_(); empty.name = segmentFolder_(existingContext, segmentSourceFolder_(existingContext), id_(input.id)).getName();
  }
  var result = segmentMutation_(kind, empty);
  if (segmentCategoryOnly_(kind, input, loads)) return result;
  var context = authorize_(), targets = segmentRecordsTargets_(context, result.segment.id, true, false, kind === 'create');
  result.segment = segmentActionResult_(context, targets.folder, targets.tables); result.loadedSheets = [];
  if (loads.length) {
    var preview = previewSegmentRecords_({ segmentId: result.segment.id, loads: loads });
    result.normalizedImport = importSegmentRecords_({ segmentId: result.segment.id, planToken: preview.planToken, requestId: input.requestId });
  }
  return result;
}
