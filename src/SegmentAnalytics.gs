/**
 * Read-only, bounded contact-presence checks. The general bootstrap remains a
 * metadata-only projection. Values stay on the server and are never returned.
 * Imported sheets use explicit header choices. For legacy sheets a lone first
 * row is ambiguous, so it never proves a segment empty. Coldy mailing metrics
 * are read from the last explicit refresh; NSA and launch detection are pending.
 */
function getSegmentsDashboard_(request) {
  return api_(function () {
    var context = authorize_();
    var input = request === undefined ? {} : object_(request);
    if (Object.keys(input).some(function (key) { return key !== 'includeAnalysis'; }) ||
        (input.includeAnalysis !== undefined && typeof input.includeAnalysis !== 'boolean')) fail_('INVALID_REQUEST', 'Некорректный режим загрузки сегментов.');
    var projection = getSegmentsMetadata_(context, true);
    if (projection.state !== 'ready') return projection;
    if (input.includeAnalysis === false) return segmentDashboardOverview_(context, projection);
    var budget = segmentAnalysisBudget_(), trackingRequest = { loaded: false, snapshot: null };
    projection.items = projection.items.map(function (item) {
      return segmentAnalyzeItem_(context, projection.source, item, budget, trackingRequest);
    });
    projection.generatedAt = new Date().toISOString();
    return projection;
  });
}

/** Render the usable catalog before reading contact-presence data from books. */
function segmentDashboardOverview_(context, projection) {
  var tracking;
  try { tracking = segmentReadTrackingSnapshot_(context); }
  catch (error) { tracking = { available: false, tables: [], loads: [] }; }
  var kinds = Object.create(null);
  if (tracking && tracking.available === true) (tracking.tables || []).forEach(function (table) {
    if (table && (table.kind === 'companies' || table.kind === 'lpr')) kinds[table.segmentId + '|' + table.fileId] = table.kind;
  });
  projection.items.forEach(function (item) {
    (item.files || []).forEach(function (file) {
      var kind = kinds[item.id + '|' + file.id];
      if (kind) file.kind = kind;
    });
    item.overallStatus = null;
    item.contactPresence = 'unknown';
    item.analysis = { state: 'pending', hasContacts: null, warnings: [] };
  });
  // No business-sheet contents or versions are cached. Reject a revoked key,
  // changed registry or moved source before any catalog metadata escapes.
  var fresh = authorize_();
  if (fresh.rootId !== context.rootId) fail_('SOURCE_CHANGED', 'Привязка реестра изменилась. Обновите страницу.');
  registryFolder_(fresh, projection.source.id);
  projection.analysisPending = true;
  projection.generatedAt = new Date().toISOString();
  return projection;
}

function getSegmentMailings_(request) {
  return api_(function () {
    var context = authorize_(), input = object_(request), segmentId = id_(input.segmentId);
    var parent = segmentSourceFolder_(context), folder;
    try { folder = segmentFolder_(context, parent, segmentId); }
    catch (error) {
      if (error.registryCode === 'OUTSIDE_SEGMENTS') throw error;
      fail_('SEGMENT_NOT_FOUND', 'Сегмент недоступен. Обновите список сегментов.');
    }
    var coldy = typeof coldySegmentMailings_ === 'function' ? coldySegmentMailings_(context, segmentId) : segmentDisconnectedMailings_('coldy', 'Coldy', 'email');
    coldy.id = 'coldy';
    var connected = coldy.state !== 'not_connected', services = [coldy, segmentDisconnectedMailings_('nsa', 'NSA', 'telegram')];
    return {
      state: connected ? 'partial' : 'not_connected',
      segment: segmentFolderResult_(context, folder),
      services: services,
      totals: connected ? segmentAggregateMailingMetrics_([coldy.totals], true) : segmentUnknownMailingTotals_(),
      totalsScope: 'connected_channels',
      message: connected ? 'Итоги показаны по подключённым каналам. Coldy — данные последнего обновления; NSA пока не подключён.' : 'Coldy и NSA пока не подключены. Рассылки и показатели появятся после подключения API.'
    };
  });
}

function segmentAnalyzeItem_(context, source, item, budget, trackingRequest) {
  var warnings = [], hasContacts = false, unknown = false, tracking;
  var launch = segmentLaunchStatus_();
  item.channels = launch.channels;
  item.companiesInWork = null;
  try {
    segmentAnalyticsFolder_(context, source, item);
  } catch (error) {
    item.overallStatus = null;
    item.contactPresence = 'unknown';
    item.analysis = { state: 'partial', hasContacts: null, warnings: ['Папка больше не относится к доступным сегментам. Обновите список.'] };
    return item;
  }
  try {
    // One validated service-book snapshot belongs only to this dashboard call.
    // Load it after checking the first accessible segment, and remember failure
    // too so a broken journal is not reopened once for every segment.
    if (trackingRequest && !trackingRequest.loaded) {
      trackingRequest.loaded = true;
      trackingRequest.snapshot = { available: false, tables: [], loads: [], warnings: [] };
      trackingRequest.snapshot = segmentReadTrackingSnapshot_(context);
    }
    tracking = segmentReadTracking_(context, item.id, trackingRequest ? trackingRequest.snapshot : undefined);
  } catch (error) {
    tracking = { available: false, tables: [], loads: [] };
    segmentAnalysisWarn_(warnings, 'Не удалось проверить папку сегмента или сведения о заголовках.');
  }
  if (!tracking || tracking.available !== true) {
    segmentAnalysisWarn_(warnings, 'Сведения о заголовках недоступны; заполненная первая строка будет отмечена как непроверенная.');
    tracking = { available: false, tables: [], loads: [] };
  }
  var headerMap = segmentAnalysisHeaders_(tracking, warnings);
  var tableKinds = Object.create(null);
  ((tracking && tracking.tables) || []).forEach(function (table) {
    if (table && (table.kind === 'companies' || table.kind === 'lpr')) tableKinds[table.fileId] = table.kind;
  });
  (item.files || []).forEach(function (file) {
    if (tableKinds[file.id]) file.kind = tableKinds[file.id];
  });
  // Finding one real body cell is enough to establish preparation. Other files
  // are deliberately not opened when their contents cannot change this result.
  for (var index = 0; index < item.files.length && !hasContacts; index++) {
    var outcome = segmentAnalyzeFile_(context, item.id, item.files[index].id, headerMap.values, budget);
    if (outcome.hasContacts === true) hasContacts = true;
    if (outcome.state !== 'ready') {
      unknown = true;
      segmentAnalysisWarn_(warnings, outcome.message);
    }
  }
  item.overallStatus = segmentOverallStatus_(hasContacts ? true : (unknown ? null : false), launch);
  item.contactPresence = hasContacts ? 'has_contacts' : (unknown ? 'unknown' : 'empty');
  item.analysis = { state: unknown || warnings.length ? 'partial' : 'ready', hasContacts: hasContacts ? true : (unknown ? null : false), warnings: warnings };
  return item;
}

function segmentAnalyticsFolder_(context, source, item) {
  var sourceFolder = registryFolder_(context, source.id);
  var segment = registryFolder_(context, item.id);
  if (sourceFolder.getId() === segment.getId() || !segmentHasDirectParent_(segment, sourceFolder.getId())) {
    fail_('OUTSIDE_SEGMENTS', 'Папка больше не относится к списку сегментов. Обновите данные.');
  }
  return segment;
}

function segmentHasDirectParent_(item, parentId) {
  var parents = item.getParents(), count = 0;
  while (parents.hasNext()) {
    if (++count > REGISTRY_CONFIG.maxAncestryNodes) return false;
    var parent = parents.next();
    if (parent.getId() === parentId && !parent.isTrashed()) return true;
  }
  return false;
}

function segmentAnalysisHeaders_(tracking, warnings) {
  var values = Object.create(null), uncertain = false;
  ((tracking && tracking.loads) || []).forEach(function (load) {
    if (!load) return;
    if (load.stage !== 'copied' && load.stage !== 'complete') {
      uncertain = true;
      segmentAnalysisWarn_(warnings, 'В сегменте есть незавершённая загрузка. Проверьте её результат перед повтором.');
      return;
    }
    var sheetId = String(load.targetSheetId);
    if (typeof load.targetFileId !== 'string' || !/^[a-zA-Z0-9_-]{10,200}$/.test(load.targetFileId) || !/^\d+$/.test(sheetId) || typeof load.hasHeader !== 'boolean') {
      uncertain = true;
      segmentAnalysisWarn_(warnings, 'Не удалось проверить сведения о заголовках одного из листов.');
      return;
    }
    var key = load.targetFileId + '|' + sheetId;
    if (Object.prototype.hasOwnProperty.call(values, key) && values[key] !== load.hasHeader) {
      uncertain = true;
      segmentAnalysisWarn_(warnings, 'Для одного из листов сохранены разные настройки заголовков.');
      values[key] = null;
    } else values[key] = load.hasHeader;
  });
  return { values: values, uncertain: uncertain };
}

function segmentAnalyzeFile_(context, segmentId, fileId, headers, budget) {
  try {
    if (!segmentAnalysisTime_(budget) || budget.files >= budget.maxFiles) return segmentAnalysisPartial_('Достигнут лимит проверки. Наличие контактов подтверждено не во всех таблицах.');
    budget.files++;
    var serviceId = context.properties.getProperty('SOURCE_BASES_STORAGE_ID') || REGISTRY_CONFIG.defaultSourceBasesStorageId;
    if (fileId === serviceId) return segmentAnalysisPartial_('Служебная таблица исключена из проверки контактов.');
    var file = registryFile_(context, fileId);
    if (!insideRegistry_(file, segmentId)) return segmentAnalysisPartial_('Одна из таблиц больше не находится в папке сегмента.');
    var book = SpreadsheetApp.openById(file.getId()), sheets = book.getSheets(), partial = null;
    for (var index = 0; index < sheets.length; index++) {
      if (!segmentAnalysisTime_(budget) || budget.sheets >= budget.maxSheets) return segmentAnalysisPartial_('Достигнут лимит проверки листов. Пустой сегмент пока не подтверждён.');
      budget.sheets++;
      var sheet = sheets[index], key = fileId + '|' + String(sheet.getSheetId());
      var hasHeader = Object.prototype.hasOwnProperty.call(headers, key) ? headers[key] : segmentCenterHeader_(context, fileId, sheet, budget);
      var result = segmentAnalyzeSheet_(sheet, hasHeader, budget);
      if (result.hasContacts) return result;
      if (result.state !== 'ready') partial = result;
    }
    return partial || { state: 'ready', hasContacts: false };
  } catch (error) {
    return segmentAnalysisPartial_('Не удалось прочитать одну из таблиц. Проверьте права доступа и обновите данные.');
  }
}

/** Only the explicitly configured Center can infer its exact, packaged headers. */
function segmentCenterHeader_(context, fileId, sheet, budget) {
  var centerId = context.properties.getProperty('CONTACT_CENTER_ID') || REGISTRY_CONFIG.defaultContactCenterId;
  if (fileId !== centerId || typeof CONTACT_TARGET_HEADERS === 'undefined' || typeof sheet.getName !== 'function') return null;
  var kind = { 'База': 'base', 'Email': 'email', 'Telegram': 'telegram' }[sheet.getName()];
  var expected = kind && CONTACT_TARGET_HEADERS[kind];
  if (!expected || sheet.getLastRow() < 1 || sheet.getLastColumn() !== expected.length) return null;
  for (var column = 1; column <= expected.length; column += budget.chunkCells) {
    var count = Math.min(budget.chunkCells, expected.length - column + 1);
    if (!segmentAnalysisTime_(budget) || budget.cells + count > budget.maxCells) return null;
    budget.cells += count;
    var first = sheet.getRange(1, column, 1, count).getDisplayValues();
    if (!first || first.length !== 1 || first[0].length !== count) return null;
    for (var index = 0; index < count; index++) if (first[0][index] !== expected[column - 1 + index]) return null;
  }
  return true;
}

function segmentAnalyzeSheet_(sheet, hasHeader, budget) {
  if (hasHeader === null) {
    var body = segmentAnalyzeSheet_(sheet, true, budget);
    if (body.hasContacts || body.state !== 'ready') return body;
    var first = segmentAnalyzeFirstRow_(sheet, budget);
    if (first.hasContacts) return segmentAnalysisPartial_('Для старого листа не указано, есть ли заголовок. Единственная заполненная строка может быть контактом.');
    return first;
  }
  var lastRow = sheet.getLastRow(), lastColumn = sheet.getLastColumn(), firstRow = hasHeader ? 2 : 1;
  if (lastRow < firstRow || lastColumn < 1) return { state: 'ready', hasContacts: false };
  var rowsPerChunk = Math.max(1, Math.floor(budget.chunkCells / Math.min(lastColumn, budget.chunkCells)));
  for (var row = firstRow; row <= lastRow;) {
    // Most working books have data in their first body row. A one-row probe
    // proves presence without transferring up to 10,000 cells. Blank probes
    // continue the same bounded complete scan, without reading cells twice.
    var rowCount = row === firstRow ? 1 : Math.min(rowsPerChunk, lastRow - row + 1);
    var columnsPerChunk = Math.max(1, Math.floor(budget.chunkCells / rowCount));
    for (var column = 1; column <= lastColumn; column += columnsPerChunk) {
      var columnCount = Math.min(columnsPerChunk, lastColumn - column + 1), cellCount = rowCount * columnCount;
      if (!segmentAnalysisTime_(budget) || budget.cells + cellCount > budget.maxCells) return segmentAnalysisPartial_('Достигнут лимит чтения. Пустой сегмент пока не подтверждён.');
      budget.cells += cellCount;
      var values = sheet.getRange(row, column, rowCount, columnCount).getDisplayValues();
      for (var r = 0; r < values.length; r++) {
        for (var c = 0; c < values[r].length; c++) {
          if (String(values[r][c] === null || values[r][c] === undefined ? '' : values[r][c]).trim() !== '') return { state: 'ready', hasContacts: true };
        }
      }
    }
    row += rowCount;
  }
  return { state: 'ready', hasContacts: false };
}

function segmentAnalyzeFirstRow_(sheet, budget) {
  var lastColumn = sheet.getLastColumn();
  if (sheet.getLastRow() < 1 || lastColumn < 1) return { state: 'ready', hasContacts: false };
  for (var column = 1; column <= lastColumn; column += budget.chunkCells) {
    var count = Math.min(budget.chunkCells, lastColumn - column + 1);
    if (!segmentAnalysisTime_(budget) || budget.cells + count > budget.maxCells) return segmentAnalysisPartial_('Достигнут лимит чтения. Пустой сегмент пока не подтверждён.');
    budget.cells += count;
    var values = sheet.getRange(1, column, 1, count).getDisplayValues();
    for (var index = 0; index < values[0].length; index++) {
      if (String(values[0][index] === null || values[0][index] === undefined ? '' : values[0][index]).trim() !== '') return { state: 'ready', hasContacts: true };
    }
  }
  return { state: 'ready', hasContacts: false };
}

function segmentAnalysisBudget_() {
  return {
    files: 0, sheets: 0, cells: 0, startedAt: Date.now(),
    maxFiles: REGISTRY_CONFIG.segmentAnalysisMaxFiles || 80,
    maxSheets: REGISTRY_CONFIG.segmentAnalysisMaxSheets || 240,
    maxCells: REGISTRY_CONFIG.segmentAnalysisMaxCells || 100000,
    chunkCells: REGISTRY_CONFIG.segmentAnalysisChunkCells || 10000,
    maxMillis: REGISTRY_CONFIG.segmentAnalysisMaxMillis || 20000
  };
}

function segmentAnalysisTime_(budget) { return Date.now() - budget.startedAt < budget.maxMillis; }
function segmentAnalysisPartial_(message) { return { state: 'partial', hasContacts: null, message: message }; }
function segmentAnalysisWarn_(warnings, message) { if (message && warnings.indexOf(message) === -1) warnings.push(message); }

function segmentLaunchStatus_() {
  return {
    configured: false,
    hasLaunchedContacts: null,
    channels: {
      email: { state: 'inactive', inWork: null, configured: false },
      telegram: { state: 'inactive', inWork: null, configured: false },
      retargeting: { state: 'inactive', inWork: null, configured: false }
    }
  };
}

function segmentOverallStatus_(hasContacts, launch) {
  if (launch.configured === true && launch.hasLaunchedContacts === true) return 'in_work';
  return hasContacts === true ? 'preparation' : (hasContacts === false ? 'no_contacts' : null);
}

function segmentDisconnectedMailings_(id, name, channel) {
  return { id: id, name: name, channel: channel, state: 'not_connected', campaigns: [], totals: segmentUnknownMailingTotals_() };
}

function segmentUnknownMailingTotals_() { return { sent: null, replies: null, leads: null }; }

/** For future connected adapters: any unknown metric keeps its total unknown. */
function segmentAggregateMailingMetrics_(entries, connected) {
  var result = segmentUnknownMailingTotals_();
  if (connected !== true) return result;
  ['sent', 'replies', 'leads'].forEach(function (key) {
    var total = 0, known = true;
    (entries || []).forEach(function (entry) {
      var value = entry && entry[key];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total + value)) known = false;
      else total += value;
    });
    result[key] = known ? total : null;
  });
  return result;
}
