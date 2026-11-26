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
  originsTab: 'SourceBaseOrigins',
  originsHeaders: ['selectionFileId', 'sourceId', 'sourceName', 'criteria'],
  projectsTab: 'SourceBaseProjects',
  projectsHeaders: ['fileId', 'projectIds', 'revision', 'receipts'],
  statuses: ['collection', 'ready', 'rework'],
  checks: ['unchecked', 'valid', 'invalid'],
  baseTypes: ['general', 'lpr', 'mixed'],
  contents: ['companies', 'lpr']
});

function getSourceBases_() {
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
        storage.catalogRows = sourceBasesCatalogRows_(storage);
        var database = sourceBasesReadDatabase_(storage);
        var records = sourceBasesSync_(current, storage, database, discovered);
        var associations = sourceBasesAssociations_(database.relations, current);
        var origins = sourceBaseReadOrigins_(storage);
        var projects = sourceBaseReadProjects_(storage);
        var items = discovered.map(function (file) { return sourceBaseItem_(file, records[file.id], associations, origins, projects); });
        var result = sourceBasesResponse_(binding, storage.public, items, true, true);
        if (typeof sourceBasesRevisionToken_ === 'function') result.revision = sourceBasesRevisionToken_(current, binding, discovered);
        sourceBasesRememberPreviewTypes_(current.rootId, binding.source.id, storage.public.id, items);
        return result;
      } catch (error) {
        if (['AUTH_REQUIRED', 'ACCESS_DENIED', 'SETUP_REQUIRED', 'LINK_ACCESS_REQUIRED', 'LINK_SETUP_REQUIRED',
          'SOURCE_CHANGED', 'OUTSIDE_REGISTRY', 'BUSY'].indexOf(error.registryCode) !== -1) throw error;
        if (authorize_().rootId !== current.rootId) fail_('SOURCE_CHANGED','Папка реестра изменилась. Обновите реестр.');
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

function sourceDirectoryResponse_(context, state, sourceId, files, complete) {
  var items = (files || []).map(function (f) { return {id:f.id,name:f.name,workbook:f.workbook === true}; });
  items.sort(function (a,b) { return byName_(a,b) || a.id.localeCompare(b.id); });
  return {state:state,sourceId:sourceId || null,checkedAt:Date.now(),complete:complete === true,items:items,
    revision:state === 'ready' ? digest_(JSON.stringify([context.rootId,sourceId,complete,items])) : null};
}

/** Full shared catalogue of file names. No service-sheet reads, synchronization or write lock. */
function getSourceDirectory_(request) {
  return api_(function () {
    var context = authorize_();
    if (request !== undefined && Object.keys(object_(request)).length) fail_('INVALID_REQUEST','Область исходных баз задаётся настройками реестра.');
    var storage = context.properties.getProperty('SOURCE_BASES_STORAGE_ID') || REGISTRY_CONFIG.defaultSourceBasesStorageId;
    try {
      var binding = sourceBasesSource_(context);
      if (binding.state !== 'ready') return sourceDirectoryResponse_(context,binding.state);
      var files = sourceBasesDiscover_(context,binding.folder,true);
      var fresh = authorize_();
      if (fresh.rootId !== context.rootId || (fresh.properties.getProperty('SOURCE_BASES_STORAGE_ID') || REGISTRY_CONFIG.defaultSourceBasesStorageId) !== storage)
        fail_('SOURCE_CHANGED','Привязка реестра изменилась. Обновите список.');
      return sourceDirectoryResponse_(fresh,'ready',binding.source.id,files,true);
    } catch (error) {
      if (error.registryCode === 'SOURCE_LIMIT') return sourceDirectoryResponse_(context,'limit');
      if (error.registryCode) throw error;
      return sourceDirectoryResponse_(context,'unavailable');
    }
  });
}

// The preview shares only live names of direct children. A single bounded Drive
// page proves that the sources folder itself belongs to the authorised root.
// Custom nested bindings, large results and subfolders are filled by the full
// catalogue already loading in parallel, without delaying entry for a tree scan.
function sourceBasesStartupPreview_(context, root) {
  var lists = sourceBasesStartupLists_(context,root,{includeSourcePreview:true});
  return lists && lists.catalogPreview || null;
}

function sourceBasesStartupLists_(context, root, options) {
  if (typeof Drive.Files.list !== 'function') return null;
  var props = context.properties;
  var sourceId = (props.getProperty('SOURCE_BASES_FOLDER_ID') || '').trim() || REGISTRY_CONFIG.defaultSourceBasesFolderId;
  var storageId = props.getProperty('SOURCE_BASES_STORAGE_ID') || REGISTRY_CONFIG.defaultSourceBasesStorageId;
  var folderMime = 'application/vnd.google-apps.folder';
  var page;
  try {
    var sourceParent = "'" + id_(sourceId) + "' in parents";
    var rootFolders = "('" + context.rootId + "' in parents and mimeType = '" + folderMime + "')";
    var query = {q:'trashed = false and (' + sourceParent + ' or ' + rootFolders + ')',
      pageSize:200, fields:'nextPageToken,incompleteSearch,files(id,name,mimeType,parents,trashed)', supportsAllDrives:true,
      includeItemsFromAllDrives:true, corpora:root.driveId ? 'drive' : 'user'};
    if (root.driveId) query.driveId = root.driveId;
    page = Drive.Files.list(query);
  } catch (unavailable) { return null; }
  if (!page || page.incompleteSearch || !Array.isArray(page.files)) return null;
  function liveChild(item, parent) {
    return item && item.trashed === false && Array.isArray(item.parents) && item.parents.length === 1 && item.parents[0] === parent;
  }
  if (sourceId !== context.rootId && !page.files.some(function (item) {
    return liveChild(item, context.rootId) && item.id === sourceId && item.mimeType === folderMime;
  })) return null;
  var fresh = authorize_();
  if (fresh.rootId !== context.rootId ||
      ((fresh.properties.getProperty('SOURCE_BASES_FOLDER_ID') || '').trim() || REGISTRY_CONFIG.defaultSourceBasesFolderId) !== sourceId ||
      (fresh.properties.getProperty('SOURCE_BASES_STORAGE_ID') || REGISTRY_CONFIG.defaultSourceBasesStorageId) !== storageId) return null;
  var types = {}, files = [];
  if (options.includeSourcePreview) {
    try {
      var saved = CacheService.getScriptCache().get(sourceBasesPreviewTypesKey_(context.rootId, sourceId, storageId));
      types = JSON.parse(saved) || {};
    } catch (unavailable) { /* The list still works before types are known. */ }
  }
  page.files.forEach(function (item) {
    if (!liveChild(item, sourceId) || !/^[\w-]{10,200}$/.test(item.id) || item.id === storageId ||
        !item.mimeType || item.mimeType === folderMime || typeof item.name !== 'string' || !item.name) return;
    files.push({id:item.id,name:item.name,workbook:item.mimeType === REGISTRY_CONFIG.spreadsheetMime});
  });
  var partial = !!page.nextPageToken || page.files.some(function (item) {
    return liveChild(item,sourceId) && item.mimeType === folderMime;
  });
  var result = {};
  if (options.includeSourceDirectory) result.sourceDirectory = sourceDirectoryResponse_(context,'ready',sourceId,files,!partial);
  if (options.includeSourcePreview && files.length) {
    var items = files.sort(byName_).map(function (file) {
      var bits = types[file.id], contents = [];
      if (bits === 1 || bits === 3) contents.push('companies');
      if (bits === 2 || bits === 3) contents.push('lpr');
      return {name:file.name,contents:contents};
    });
    result.catalogPreview = {items:items,checkedAt:Date.now(),partial:partial};
  }
  return result;
}

function sourceBasesPreviewTypesKey_(rootId, sourceId, storageId) {
  return 'catalog-types-v1-' + digest_(JSON.stringify([rootId,sourceId,storageId]));
}

function sourceBasesRememberPreviewTypes_(rootId, sourceId, storageId, items) {
  try {
    var cache = CacheService.getScriptCache(), types = Object.create(null);
    items.slice(0,200).forEach(function (item) {
      if (!Array.isArray(item.contents)) return;
      types[item.id] = (item.contents.indexOf('companies') >= 0 ? 1 : 0) + (item.contents.indexOf('lpr') >= 0 ? 2 : 0);
    });
    cache.put(sourceBasesPreviewTypesKey_(rootId, sourceId, storageId), JSON.stringify(types), 21600);
  } catch (unavailable) { /* Optional type hints, never a source of permissions or file names. */ }
}

function updateSourceBase_(request) {
  return api_(function () {
    var context = authorize_(), input = object_(request);
    var bindOrigin = Object.prototype.hasOwnProperty.call(input, 'origin');
    var bindProjects = Object.prototype.hasOwnProperty.call(input, 'projectIds');
    var allowedKeys = bindProjects ? ['id', 'expectedRevision', 'expectedProjectsRevision', 'requestId', 'projectIds'] : bindOrigin ? ['id', 'expectedRevision', 'requestId', 'origin'] : ['id', 'status', 'formatCheck', 'baseType', 'contents', 'expectedRevision'];
    if (Object.keys(input).some(function (key) { return allowedKeys.indexOf(key) === -1; })) fail_('INVALID_REQUEST', 'Можно изменить только наполнение базы, статус сбора и ручную проверку формата.');
    var fileId = id_(input.id);
    if (bindProjects && (!Number.isSafeInteger(input.expectedProjectsRevision) || input.expectedProjectsRevision < 0 ||
        typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId))) fail_('INVALID_REQUEST', 'Обновите карточку и повторите сохранение проектов с тем же запросом.');
    var projectIds = bindProjects ? sourceBaseProjectIds_(input.projectIds) : null;
    var origin;
    if (bindOrigin) {
      if (input.requestId !== fileId) fail_('INVALID_REQUEST', 'Повторите привязку с идентификатором этой выборки.');
      var spec = object_(input.origin);
      if (Object.keys(spec).some(function (key) { return ['url', 'name', 'criteria'].indexOf(key) === -1; })) fail_('INVALID_REQUEST', 'Проверьте поля исходной базы.');
      origin = sourceBaseOrigin_(fileId, importSheetLink_(spec.url).id, spec.name, spec.criteria === undefined ? '' : spec.criteria);
    }
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail_('INVALID_REQUEST', 'Сначала обновите сохранённое состояние базы.');
    var hasStatus = Object.prototype.hasOwnProperty.call(input, 'status');
    var hasCheck = Object.prototype.hasOwnProperty.call(input, 'formatCheck');
    var hasType = Object.prototype.hasOwnProperty.call(input, 'baseType');
    var hasContents = Object.prototype.hasOwnProperty.call(input, 'contents');
    if (hasContents && !Array.isArray(input.contents)) fail_('INVALID_CONTENTS', 'Наполнение базы должно содержать компании и/или ЛПР.');
    var contents = hasContents ? sourceBaseContents_(input.contents) : (hasType ? sourceBaseContents_(input.baseType) : null);
    if (hasType && hasContents && sourceBaseLegacyType_(contents) !== input.baseType) fail_('INVALID_CONTENTS', 'Наполнение базы не соответствует указанному типу.');
    if (!bindProjects && !bindOrigin && !hasStatus && !hasCheck && !hasType && !hasContents) fail_('INVALID_REQUEST', 'Не выбрано изменение базы.');
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
      var origins = sourceBaseReadOrigins_(storage);
      var projects = sourceBaseReadProjects_(storage);
      if (bindProjects) {
        sourceBaseCheckProjectScope_(current, storage, fileId);
        sourceBaseChangeProjects_(storage, projects, fileId, projectIds, input.requestId, input.expectedProjectsRevision, input.expectedRevision, stored.revision);
        return { item: sourceBaseItem_(file, stored, sourceBasesAssociations_(database.relations, current), origins, projects) };
      }
      if (bindOrigin) {
        if (file.mimeType !== REGISTRY_CONFIG.spreadsheetMime) fail_('INVALID_FILE_TYPE', 'Выборка должна быть таблицей Google в реестре.');
        if ([current.rootId, storage.public.id, current.properties.getProperty('CONTACT_CENTER_ID') || REGISTRY_CONFIG.defaultContactCenterId].indexOf(origin.id) !== -1) fail_('PROTECTED_FILE', 'Служебный файл нельзя привязать как исходник.');
        if (stored.revision !== input.expectedRevision && !(origins && origins.index[fileId])) fail_('CONFLICT', 'Выборка изменилась. Обновите список перед привязкой.');
        sourceBaseSaveOrigin_(storage, origins, fileId, origin);
        return { item: sourceBaseItem_(file, stored, sourceBasesAssociations_(database.relations, current), origins, projects) };
      }
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
      return { item: sourceBaseItem_(file, record, sourceBasesAssociations_(database.relations, current), origins, projects) };
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

function sourceBasesDiscover_(context, source, namesOnly) {
  var files;
  if (typeof Drive !== 'undefined' && Drive.Files && typeof Drive.Files.list === 'function' && typeof Drive.Files.get === 'function') {
    files = sourceBasesDriveListing_(context, source, namesOnly);
  }
  // A missing files array is not sufficient evidence that a folder is empty.
  if (!files) files = sourceBasesDiscoverLegacy_(context, source, namesOnly);
  var current = authorize_(), binding = sourceBasesSource_(current);
  if (current.rootId !== context.rootId || binding.state !== 'ready' || binding.folder.getId() !== source.getId()) {
    fail_('SOURCE_CHANGED', 'Папка исходных баз изменилась. Обновите реестр.');
  }
  return files;
}

/** One listing returns both metadata and actual parent IDs for every item on the page. */
function sourceBasesDriveListing_(context, source, namesOnly) {
  var sourceId = id_(source.getId()), storageId = context.properties.getProperty('SOURCE_BASES_STORAGE_ID') || REGISTRY_CONFIG.defaultSourceBasesStorageId;
  var root = Drive.Files.get(sourceId, { fields:'id,mimeType,trashed,driveId', supportsAllDrives:true });
  if (!root || root.id !== sourceId || root.trashed || root.mimeType !== 'application/vnd.google-apps.folder') {
    fail_('SOURCE_CHANGED','Папка исходных баз изменилась. Обновите реестр.');
  }
  var files = new Map(), folders = new Set([sourceId]), level = [sourceId], depth = 0;
  function checkFolders(ids) {
    ids.forEach(function (id) {
      if (id === sourceId) return;
      var folder = folderById_(id);
      if (folder.isTrashed() || !insideRegistry_(folder, sourceId)) fail_('SOURCE_CHANGED','Вложенная папка изменилась во время чтения реестра.');
    });
  }
  while (level.length) {
    var children = [];
    for (var start = 0; start < level.length; start += 20) {
      var group = level.slice(start, start + 20), parents = new Set(group), tokens = new Set();
      checkFolders(group);
      var query = { q:"trashed = false and (" + group.map(function (id) { return "'" + id + "' in parents"; }).join(' or ') + ')',
        pageSize:1000, fields:namesOnly ? 'nextPageToken,incompleteSearch,files(id,name,mimeType,parents,trashed)' : 'nextPageToken,incompleteSearch,files(id,name,mimeType,webViewLink,parents,trashed)',
        supportsAllDrives:true, includeItemsFromAllDrives:true, corpora:root.driveId ? 'drive' : 'user' };
      if (root.driveId) query.driveId = root.driveId;
      do {
        var page = Drive.Files.list(query);
        if (!page || page.incompleteSearch) fail_('SOURCE_CHANGED','Google Диск не подтвердил полный список исходных баз.');
        if (!Array.isArray(page.files)) return null;
        page.files.forEach(function (item) {
          if (!item || !Array.isArray(item.parents) || !item.parents.some(function (id) { return parents.has(id); }) ||
              typeof item.name !== 'string' || typeof item.mimeType !== 'string') {
            fail_('SOURCE_CHANGED','Google Диск не подтвердил расположение исходных баз.');
          }
          var id = id_(item.id);
          if (item.trashed || id === storageId) return;
          if (item.mimeType === 'application/vnd.google-apps.folder') {
            if (folders.has(id)) return;
            if (depth >= REGISTRY_CONFIG.maxTreeDepth || folders.size >= REGISTRY_CONFIG.maxSourceFolders)
              fail_('SOURCE_LIMIT','Слишком много папок исходных баз. Список не был сохранён частично.');
            folders.add(id); children.push(id);
          } else if (!files.has(id)) {
            if (files.size >= REGISTRY_CONFIG.maxSourceBaseRows) fail_('SOURCE_LIMIT','Исходных баз больше 5000. Список не был сохранён частично.');
            if (namesOnly) { files.set(id,{id:id,name:item.name,workbook:item.mimeType === REGISTRY_CONFIG.spreadsheetMime}); return; }
            var info = item.webViewLink ? sourceBaseMetadataValues_(id,item.name,item.mimeType,item.webViewLink) :
              sourceBaseMetadata_(sourceBasesFile_(context,source,id));
            files.set(id,info);
          }
        });
        var next = page.nextPageToken;
        if (!next) break;
        if (typeof next !== 'string' || tokens.has(next)) fail_('SOURCE_CHANGED','Google Диск вернул неполный список исходных баз.');
        tokens.add(next); query.pageToken = next;
      } while (true);
      checkFolders(group);
    }
    level = children; depth++;
  }
  return Array.from(files.values()).sort(byName_);
}

function sourceBasesDiscoverLegacy_(context, source, namesOnly) {
  var files = [], seenFiles = Object.create(null), seenFolders = Object.create(null), folderCount = 0;
  var sourceId = source.getId();
  var storageId = context.properties.getProperty('SOURCE_BASES_STORAGE_ID') || REGISTRY_CONFIG.defaultSourceBasesStorageId;
  function visit(folder, depth) {
    var folderId = folder.getId();
    if (seenFolders[folderId]) return;
    if (++folderCount > REGISTRY_CONFIG.maxSourceFolders || depth > REGISTRY_CONFIG.maxTreeDepth) fail_('SOURCE_LIMIT', 'Слишком много папок исходных баз. Список не был сохранён частично.');
    if (!insideRegistry_(folder, sourceId)) fail_('SOURCE_CHANGED', 'Папки исходных баз изменились во время обновления. Повторите обновление.');
    seenFolders[folderId] = true;
    var iterator = folder.getFiles();
    while (iterator.hasNext()) {
      var file = iterator.next(), fileId = file.getId();
      if (file.isTrashed() || fileId === storageId || seenFiles[fileId]) continue;
      if (!insideRegistry_(file, sourceId)) continue;
      var mimeType = file.getMimeType();
      if (mimeType === 'application/vnd.google-apps.folder') continue;
      seenFiles[fileId] = true;
      files.push(namesOnly ? {id:fileId,name:file.getName(),workbook:mimeType === REGISTRY_CONFIG.spreadsheetMime} : sourceBaseMetadata_(file, fileId, mimeType));
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

function sourceBaseMetadata_(file, fileId, mimeType) {
  fileId = id_(fileId === undefined ? file.getId() : fileId);
  mimeType = String(mimeType === undefined ? file.getMimeType() : mimeType);
  return sourceBaseMetadataValues_(fileId, String(file.getName()), mimeType, String(file.getUrl()));
}

function sourceBaseMetadataValues_(fileId, name, mimeType, url) {
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

// Read the four service tabs in one Sheets request on the card-list path.
// Sizes come from the used ranges, so an unexpected column or excess rows
// cannot be hidden by requesting only the expected schema.
function sourceBasesCatalogRows_(storage) {
  if (typeof Sheets === 'undefined' || !Sheets.Spreadsheets || !Sheets.Spreadsheets.get) return null;
  try {
    var schema = SOURCE_BASES_SCHEMA, tabs = Object.create(null), ranges = [], cellCount = 0;
    [schema.basesTab, schema.relationsTab, schema.originsTab, schema.projectsTab].forEach(function (name) {
      var sheet = name === schema.basesTab ? storage.basesSheet :
        name === schema.relationsTab ? storage.relationsSheet : storage.book.getSheetByName(name);
      var lastRow = sheet ? sheet.getLastRow() : 0, lastColumn = lastRow ? sheet.getLastColumn() : 0;
      tabs[name] = { sheet: sheet, lastRow: lastRow, lastColumn: lastColumn };
      if (!lastRow || lastRow > REGISTRY_CONFIG.maxSourceBaseRows + 1 ||
          (name === schema.basesTab ? (lastColumn < 11 || lastColumn > 13) : lastColumn !== 4)) return;
      tabs[name].requested = true;
      ranges.push("'" + name + "'!A1:" + String.fromCharCode(64 + lastColumn) + lastRow);
      cellCount += lastRow * lastColumn;
    });
    // Large registries still use the per-tab reader to bound peak memory.
    if (!ranges.length || cellCount > 30000) return tabs;
    var result = Sheets.Spreadsheets.get(storage.public.id, { ranges: ranges,
      fields: 'spreadsheetId,properties(defaultFormat(numberFormat(type))),sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,effectiveFormat(numberFormat(type))))))' });
    if (!result || result.spreadsheetId !== storage.public.id || !Array.isArray(result.sheets) || result.sheets.length !== ranges.length) return null;
    var seen = Object.create(null);
    for (var i = 0; i < result.sheets.length; i++) {
      var item = result.sheets[i], name = item.properties.title, tab = tabs[name];
      if (seen[name] || !tab || !tab.requested || tab.sheet.getSheetId() !== item.properties.sheetId) return null;
      seen[name] = true;
      if (!Array.isArray(item.data) || item.data.length !== 1) continue;
      var grid = item.data[0];
      if (!grid.startRow && !grid.startColumn && Array.isArray(grid.rowData) && grid.rowData.length === tab.lastRow) {
        var defaultFormat = result.properties && result.properties.defaultFormat;
        tab.cells = sourceBasesGridValues_(grid.rowData, tab.lastColumn, defaultFormat);
      }
    }
    return tabs;
  } catch (error) { return null; }
}

function sourceBasesGridValues_(rows, width, defaultFormat) {
  var values = [];
  for (var r = 0; r < rows.length; r++) {
    var cells = rows[r].values || [], row = [];
    if (cells.length > width) return null;
    for (var c = 0; c < width; c++) {
      var cell = cells[c] || {}, entered = cell.userEnteredValue, value = cell.effectiveValue;
      if (entered && typeof entered.formulaValue === 'string') return { formula: true };
      if (!entered && !value) row.push('');
      else if (value && typeof value.stringValue === 'string') row.push(value.stringValue);
      else if (value && typeof value.boolValue === 'boolean') row.push(value.boolValue);
      else if (value && typeof value.numberValue === 'number') {
        var format = (cell.effectiveFormat && cell.effectiveFormat.numberFormat) || (defaultFormat && defaultFormat.numberFormat);
        // SpreadsheetApp converts dates and times to Date using the book's timezone.
        if (format && ['DATE', 'TIME', 'DATE_TIME', 'DURATION'].indexOf(format.type) >= 0) return null;
        row.push(value.numberValue);
      } else return null;
    }
    values.push(row);
  }
  return { values: values };
}

function sourceBasesReadRows_(sheet, headers, allowLegacyContents, migrationPending, tab) {
  var cells = tab && tab.cells;
  var lastRow = cells ? tab.lastRow : sheet.getLastRow(), lastColumn = cells ? tab.lastColumn : sheet.getLastColumn();
  var legacy = !!allowLegacyContents && lastColumn >= 11 && lastColumn < headers.length;
  if (lastRow < 1 || (!legacy && lastColumn !== headers.length)) fail_('STORAGE_SCHEMA', 'Структура служебного реестра отличается от ожидаемой. Требуется проверка администратора.');
  if (lastRow > REGISTRY_CONFIG.maxSourceBaseRows + 1) fail_('STORAGE_LIMIT', 'Служебный реестр превышает лимит 5000 строк. Данные не были перезаписаны.');
  var range, hasFormula;
  if (cells) hasFormula = cells.formula;
  else {
    range = sheet.getRange(1, 1, lastRow, lastColumn);
    hasFormula = range.getFormulas().some(function (row) { return row.some(function (formula) { return !!formula; }); });
  }
  if (hasFormula) fail_('STORAGE_SCHEMA', 'В служебном реестре обнаружены формулы. Требуется проверка администратора.');
  var values = cells ? cells.values : range.getValues();
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
    var catalog = storage.catalogRows || {};
    var bases = sourceBasesReadRows_(storage.basesSheet, SOURCE_BASES_SCHEMA.basesHeaders, true, migrationPending || oldPending, catalog[SOURCE_BASES_SCHEMA.basesTab]);
    var links = sourceBasesReadRows_(storage.relationsSheet, SOURCE_BASES_SCHEMA.relationsHeaders, false, false, catalog[SOURCE_BASES_SCHEMA.relationsTab]);
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
  if (record.status !== 'ready') fail_('SOURCE_NOT_READY', 'Для добавления контактов выберите исходник со статусом «Готова к добавлению».');
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
  var index = Object.create(null), byFile = Object.create(null), distributed = Object.create(null);
  // Presence in the global relation ledger is enough to remove a source from the inbox.
  // Keep this marker separate from the segment identities visible to the selected project.
  relations.forEach(function (relation) { distributed[relation.fileId] = true; });
  if (!relations.length) return { byFile: byFile, index: index, distributed: distributed };
  try {
    context = context || authorize_();
    var segments = getSegmentNames_(context);
    if (segments.state === 'ready') {
      var scoped = typeof registryProjectScoped_ === 'function' && registryProjectScoped_();
      var properties = scoped ? context.properties.getProperties() : null, hidden = Object.create(null);
      segments.items.forEach(function (segment) {
        if (scoped && registrySegmentProject_(context, segment.id, properties) !== registryProjectId_()) hidden[segment.id] = true;
        else index[segment.id] = { id: segment.id, name: segment.name, url: segment.url };
      });
      if (scoped) relations = relations.filter(function (relation) { return !hidden[relation.segmentId]; });
    }
  } catch (error) { /* Existing links remain stored; their unavailable targets are not guessed. */ }
  relations.forEach(function (relation) {
    if (!byFile[relation.fileId]) byFile[relation.fileId] = [];
    byFile[relation.fileId].push(relation.segmentId);
  });
  return { byFile: byFile, index: index, distributed: distributed };
}

// The service book stores references only. Never fetch external files to render lineage.
function sourceBaseOrigin_(selectionId, id, name, criteria) {
  var upload = typeof id === 'string' && /^upload:[A-Za-z0-9_-]{43}$/.test(id);
  if (!upload) id_(id);
  if (selectionId === id) fail_('INVALID_REQUEST', 'Выборка и исходная база должны быть разными файлами.');
  if (typeof name !== 'string' || !name.trim() || name.length > 2000 || typeof criteria !== 'string' || criteria.length > 2000) fail_('INVALID_REQUEST', 'Укажите название исходника. Название и критерии допускают до 2000 знаков.');
  return { id: id, name: name.trim(), criteria: criteria.trim(), url: upload ? null : spreadsheetUrl_(id) };
}

function sourceBaseReadOrigins_(storage) {
  try {
    var tab = storage.catalogRows && storage.catalogRows[SOURCE_BASES_SCHEMA.originsTab];
    var sheet = tab ? tab.sheet : storage.book.getSheetByName(SOURCE_BASES_SCHEMA.originsTab);
    var result = { sheet: sheet, index: Object.create(null), lastRow: 0 };
    if (!sheet || !(tab ? tab.lastRow : sheet.getLastRow())) return result;
    var data = sourceBasesReadRows_(sheet, SOURCE_BASES_SCHEMA.originsHeaders, false, false, tab);
    result.lastRow = data.lastRow;
    data.rows.forEach(function (row) {
      if (row.every(function (cell) { return cell === ''; })) return;
      var selectionId = id_(row[0]);
      if (result.index[selectionId]) fail_('STORAGE_DUPLICATE', 'В журнале повторилась рабочая выборка.');
      result.index[selectionId] = sourceBaseOrigin_(selectionId, row[1], row[2], row[3]);
    });
    return result;
  } catch (error) {
    // Isolate a damaged optional journal from the existing source catalog.
    return null;
  }
}

function recoverSourceBaseOrigins_(request) {
  return api_(function () {
    authorize_();
    var input = object_(request), seen = Object.create(null);
    if (Object.keys(input).length !== 1 || !Array.isArray(input.items) || !input.items.length || input.items.length > 8) fail_('INVALID_REQUEST', 'Выберите от одной до восьми рабочих баз.');
    var items = input.items.map(function (entry) {
      var item = object_(entry), id = id_(item.id);
      if (Object.keys(item).length !== 3 || item.requestId !== id || seen[id] || !Number.isSafeInteger(item.expectedRevision) || item.expectedRevision < 1) fail_('INVALID_REQUEST', 'Проверьте идентификаторы и версии рабочих баз.');
      seen[id] = true;
      return item;
    });
    return locked_(function () {
      var current = authorize_(), binding = sourceBasesSource_(current), storage = sourceBasesStorage_(current);
      if (binding.state !== 'ready') fail_('SOURCE_UNAVAILABLE', 'Папка исходных баз недоступна.');
      var database = sourceBasesReadDatabase_(storage), origins = sourceBaseReadOrigins_(storage);
      if (!origins) fail_('STORAGE_SCHEMA', 'Журнал источников недоступен. Проверьте вкладку SourceBaseOrigins.');
      var result = { linked: 0, known: 0, unresolved: 0, changed: 0 };
      items.forEach(function (item) {
        var record = database.records[item.id];
        if (!record || !record.present || record.revision !== item.expectedRevision) { result.changed++; return; }
        var file;
        try { file = sourceBasesFile_(current, binding.folder, item.id); }
        catch (error) { if (error.registryCode === 'NOT_FOUND' || error.registryCode === 'OUTSIDE_REGISTRY') { result.changed++; return; } throw error; }
        if (file.getMimeType() !== REGISTRY_CONFIG.spreadsheetMime) { result.unresolved++; return; }
        if (origins.index[item.id]) { result.known++; return; }
        var info = Drive.Files.get(item.id, { fields: 'id,trashed,appProperties', supportsAllDrives: true });
        if (info.id !== item.id || info.trashed) { result.changed++; return; }
        var origin = sourceBaseReceiptOrigin_(current, binding.source.id, item.id, info.appProperties || {}, database.records);
        if (!origin || [current.rootId, storage.public.id, current.properties.getProperty('CONTACT_CENTER_ID') || REGISTRY_CONFIG.defaultContactCenterId].indexOf(origin.id) !== -1) { result.unresolved++; return; }
        sourceBasesFile_(current, binding.folder, item.id);
        sourceBaseSaveOrigin_(storage, origins, item.id, origin);
        result.linked++;
      });
      return result;
    });
  });
}

// Read the single journal addressed by the verified output's private Drive tags.
// Previous uploads and evicted receipts carry no verifiable original spreadsheet ID.
function sourceBaseReceiptOrigin_(current, destination, selectionId, tags, records) {
  var receipt = null, original = null, name = '';
  if (tags.registryPreparedRole === 'output' && tags.registryPreparedRoot === current.rootId && /^[A-Za-z0-9_-]{24,64}$/.test(tags.registryPreparedDraft || '') && typeof tags.registryPreparedFingerprint === 'string' && tags.registryPreparedFingerprint) {
    try { receipt = preparedRead_(current, tags.registryPreparedDraft, true); }
    catch (error) { if (error.registryCode === 'OUTSIDE_REGISTRY' || error.registryCode === 'PREVIEW_STORAGE') return null; throw error; }
    if (receipt && receipt.state === 'complete' && receipt.metadataCommitted === true && receipt.kind === 'link' && receipt.outputId === selectionId && receipt.fingerprint === tags.registryPreparedFingerprint) {
      original = receipt.original;
      if (receipt.origin && original && receipt.origin.id === original.id) name = receipt.origin.name;
    }
  } else if (/^IMPORT_[A-Za-z0-9_-]{32}$/.test(tags.registryImportKey || '') && typeof tags.registryImportFingerprint === 'string' && tags.registryImportFingerprint) {
    try { receipt = importReadReceipt_(current, tags.registryImportKey); }
    catch (error) { if (error.registryCode === 'CREATION_UNCERTAIN') return null; throw error; }
    if (receipt && receipt.status === 'done' && receipt.metadataCommitted === true && receipt.mode === 'copy' && receipt.destination === destination && receipt.fileId === selectionId && receipt.fingerprint === tags.registryImportFingerprint) original = receipt.original;
  }
  if (!original || typeof original.id !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(original.id) || original.id === selectionId) return null;
  name = name || original.name || (records[original.id] && records[original.id].fileName) || 'Исходная Google Таблица';
  return sourceBaseOrigin_(selectionId, original.id, name, '');
}

// Under the app lock, one immutable row per working file is the receipt for all retries.
function sourceBaseSaveOrigin_(storage, origins, selectionId, origin) {
  if (!origins) fail_('STORAGE_SCHEMA', 'Журнал связей недоступен. Проверьте вкладку SourceBaseOrigins в служебной книге.');
  var saved = origins.index[selectionId];
  if (saved) {
    if (saved.id !== origin.id || saved.name !== origin.name || saved.criteria !== origin.criteria) fail_('ORIGIN_CONFLICT', 'У выборки уже сохранена другая привязка. Обновите реестр.');
    return;
  }
  var visited = Object.create(null), parent = origin.id;
  while (parent) {
    if (parent === selectionId || visited[parent]) fail_('ORIGIN_CONFLICT', 'Эта привязка образует замкнутую цепочку выборок.');
    visited[parent] = true; parent = origins.index[parent] && origins.index[parent].id;
  }
  if (origins.lastRow >= REGISTRY_CONFIG.maxSourceBaseRows + 1) fail_('STORAGE_LIMIT', 'В журнале нет места для новой связи.');
  var sheet = origins.sheet || storage.book.insertSheet(SOURCE_BASES_SCHEMA.originsTab);
  var rows = [[id_(selectionId), origin.id, origin.name, origin.criteria]], start = origins.lastRow + 1;
  if (!origins.lastRow) rows.unshift(SOURCE_BASES_SCHEMA.originsHeaders);
  var end = start + rows.length - 1, capacity = sheet.getMaxRows();
  if (end > capacity) sheet.insertRowsAfter(capacity, end - capacity);
  SpreadsheetApp.flush();
  // Write the complete row as literal strings in one API call, including names starting with "=".
  sheetWriteRawStrings_(storage.public.id, sheet.getSheetId(), start, 1, rows);
  origins.sheet = sheet; origins.lastRow = end; origins.index[selectionId] = origin;
}

// A source is shared by default. Each optional row records project choices and
// the receipts for both manual changes and additions from confirmed imports.
function sourceBaseProjectIds_(values) {
  var known = ['numshield', 'neosender'];
  if (!Array.isArray(values) || values.length > known.length || values.some(function (value, i) {
    return known.indexOf(value) < 0 || values.indexOf(value) !== i;
  })) fail_('INVALID_REQUEST', 'Выберите доступные проекты без повторов.');
  return known.filter(function (id) { return values.indexOf(id) >= 0; });
}

function sourceBaseReadProjects_(storage) {
  try {
    var tab = storage.catalogRows && storage.catalogRows[SOURCE_BASES_SCHEMA.projectsTab];
    var sheet = tab ? tab.sheet : storage.book.getSheetByName(SOURCE_BASES_SCHEMA.projectsTab);
    var table = { sheet: sheet, index: Object.create(null), lastRow: 0 };
    if (!sheet || !(tab ? tab.lastRow : sheet.getLastRow())) return table;
    var data = sourceBasesReadRows_(sheet, SOURCE_BASES_SCHEMA.projectsHeaders, false, false, tab);
    table.lastRow = data.lastRow;
    data.rows.forEach(function (row, index) {
      if (row.every(function (cell) { return cell === ''; })) return;
      var fileId = id_(row[0]), ids = sourceBaseProjectIds_(JSON.parse(row[1])), revision = Number(row[2]), receipts = JSON.parse(row[3]);
      var previous = table.index[fileId];
      if (!String(row[2]).match(/^\d+$/) || !Number.isSafeInteger(revision) || revision < 0 ||
          !Array.isArray(receipts) || !receipts.length || receipts.length > 64 ||
          (previous && (previous.receipts.length !== 64 || revision < previous.revision || revision > previous.revision + receipts.length)) ||
          receipts.some(function (receipt) {
            return !Array.isArray(receipt) || receipt.length !== 2 || receipt.some(function (value) { return typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value); });
          })) fail_('STORAGE_SCHEMA', 'Повреждены сохранённые проекты базы.');
      var byRequest = previous ? previous.byRequest : Object.create(null);
      receipts.forEach(function (receipt) {
        if (byRequest[receipt[0]]) fail_('STORAGE_SCHEMA', 'Повторяющаяся операция в журнале проектов.');
        byRequest[receipt[0]] = receipt[1];
      });
      table.index[fileId] = { ids: ids, revision: revision, receipts: receipts, byRequest: byRequest, row: index + 2 };
    });
    return table;
  } catch (error) {
    // The shared catalog and its other metadata stay readable. An unavailable
    // membership is explicitly unknown and cannot be edited until repaired.
    return null;
  }
}

function sourceBaseChangeProjects_(storage, table, fileId, ids, requestId, expectedRevision, expectedBaseRevision, currentBaseRevision) {
  if (!table) fail_('STORAGE_SCHEMA', 'Проекты баз недоступны. Проверьте вкладку SourceBaseProjects.');
  var saved = table.index[fileId] || { ids: [], revision: 0, receipts: [], byRequest: Object.create(null), row: table.lastRow ? table.lastRow + 1 : 2 };
  var add = expectedRevision === undefined, requestKey = digest_(JSON.stringify([add ? 'add' : 'set', requestId]));
  var fingerprint = digest_(JSON.stringify([ids, expectedRevision, expectedBaseRevision]));
  var receipt = saved.byRequest[requestKey];
  if (receipt) {
    if (receipt !== fingerprint) fail_('REQUEST_REUSED', 'Этот запрос уже использован для другого выбора проектов.');
    return;
  }
  if (!add && (expectedRevision !== saved.revision || expectedBaseRevision !== currentBaseRevision)) fail_('CONFLICT', 'Карточка или проекты базы изменились. Обновите её перед сохранением.');
  var nextIds = add ? sourceBaseProjectIds_(saved.ids.concat(ids.filter(function (id) { return saved.ids.indexOf(id) < 0; }))) : ids;
  var revision = saved.revision + (saved.ids.join() !== nextIds.join() ? 1 : 0);
  // Start a new row when the current group of receipts is full. Replays of old
  // imports can still recognize their original request after later removals.
  var full = saved.receipts.length === 64, dataRow = full ? table.lastRow + 1 : saved.row;
  if (!Number.isSafeInteger(revision) || dataRow > REGISTRY_CONFIG.maxSourceBaseRows + 1) fail_('STORAGE_LIMIT', 'Достигнут предел журнала проектов баз.');
  var receipts = (full ? [] : saved.receipts).concat([[requestKey, fingerprint]]);
  var sheet = table.sheet || storage.book.insertSheet(SOURCE_BASES_SCHEMA.projectsTab);
  var start = dataRow, rows = [[id_(fileId), JSON.stringify(nextIds), String(revision), JSON.stringify(receipts)]];
  if (!table.lastRow) { start = 1; rows.unshift(SOURCE_BASES_SCHEMA.projectsHeaders); }
  var end = start + rows.length - 1, capacity = sheet.getMaxRows();
  if (end > capacity) sheet.insertRowsAfter(capacity, end - capacity);
  SpreadsheetApp.flush();
  sheetWriteRawStrings_(storage.public.id, sheet.getSheetId(), start, 1, rows);
  table.sheet = sheet; table.lastRow = Math.max(table.lastRow, end);
  saved.byRequest[requestKey] = fingerprint;
  table.index[fileId] = { ids: nextIds, revision: revision, receipts: receipts, byRequest: saved.byRequest, row: dataRow };
}

function sourceBaseCheckProjectScope_(context, storage, fileId) {
  var current = authorize_(), binding = sourceBasesSource_(current);
  if (current.rootId !== context.rootId || binding.state !== 'ready') fail_('SOURCE_CHANGED', 'Изменилось расположение исходных баз.');
  sourceBasesFile_(current, binding.folder, fileId);
  var checked = sourceBasesStorage_(current);
  if (checked.public.id !== storage.public.id) fail_('SOURCE_CHANGED', 'Служебный реестр изменился.');
  return checked;
}

function sourceBaseAddProject_(context, storage, fileId, projectId, requestId) {
  var checked = sourceBaseCheckProjectScope_(context, storage, fileId);
  sourceBaseChangeProjects_(checked, sourceBaseReadProjects_(checked), fileId, sourceBaseProjectIds_([projectId]), requestId);
}

function sourceBaseItem_(file, record, associations, origins, projects) {
  var item = { id: file.id, name: file.name, fileName: file.fileName, mimeType: file.mimeType, url: file.url, format: file.format, status: record ? record.status : null, formatCheck: record ? record.formatCheck : null, baseType: record ? record.baseType : null, contents: record ? sourceBaseContents_(record.contents || record.baseType) : null, canAddToSegment: !!(record && record.present && record.status === 'ready' && file.mimeType === REGISTRY_CONFIG.spreadsheetMime), revision: record ? record.revision : null, present: true, segments: associations ? [] : null, associationsAvailable: !!associations };
  item.distribution = associations && associations.distributed ? (associations.distributed[file.id] ? 'assigned' : 'unassigned') : 'unknown';
  item.origin = origins && origins.index[file.id] || null;
  item.originAvailable = !!origins;
  var membership = projects && projects.index[file.id];
  item.projectIds = projects ? (membership ? membership.ids.slice() : []) : null;
  item.projectsRevision = projects ? (membership ? membership.revision : 0) : null;
  if (record) { item.updatedAt = record.updatedAt; item.updatedBy = record.updatedBy; }
  if (associations && associations.byFile[file.id]) associations.byFile[file.id].forEach(function (segmentId) {
    if (associations.index[segmentId]) item.segments.push(associations.index[segmentId]);
    else { item.associationsAvailable = false; item.associationWarning = 'Часть связей с сегментами недоступна. Требуется проверка.'; }
  });
  return item;
}

function sourceBasesResponse_(binding, storage, items, canEdit, associationsAvailable) {
  return { state: binding.state, source: binding.source || null, storage: storage, items: items, canEdit: canEdit, associationsAvailable: associationsAvailable, generatedAt: new Date().toISOString() };
}
