/**
 * Standalone Apps Script web app. Every remote operation verifies the shared
 * link credential and the item's actual Drive ancestry. The catalog stores workflow data
 * in a fixed, root-validated service book. Segment actions copy selected sheets
 * from ready source files; analytics reads bounded contact-presence data only.
 * Prepared imports preserve their inputs. The explicit in-app editor writes
 * bounded, version-checked ranges only in registered working spreadsheets.
 */
function doGet(e) {
  // Only a static shell is public. The fragment credential is checked by every RPC.
  try {
    var page;
    if (e && e.parameter && e.parameter.bridge === '1') {
      var bridge = HtmlService.createTemplateFromFile('PagesBridge');
      var channel = e.parameter.channel;
      bridge.bridgeSession = typeof channel === 'string' && channel.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(channel) ? channel : '';
      return bridge.evaluate().setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }
    try { page = HtmlService.createHtmlOutputFromFile('RegistryShell'); }
    catch (noBundle) { page = HtmlService.createTemplateFromFile('Index').evaluate(); } // Direct clasp push from src.
    page.setFaviconUrl('https://seainkk.github.io/-/favicon.png');
    return page.setTitle(REGISTRY_CONFIG.title).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  catch (error) { return HtmlService.createHtmlOutput('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Центр мультиканального аутрича</title><body style="font:16px/1.6 system-ui;margin:40px;max-width:650px"><h1>Центр мультиканального аутрича</h1><p>Не удалось открыть интерфейс. Обратитесь к владельцу сервиса.</p></body></html>'); }
}

function include_(name) {
  if (['Styles', 'Client', 'GridPanel', 'GridStyles', 'WorkbookMailingClient', 'GridClient', 'ProjectPanel', 'ProjectStyles', 'ProjectClient', 'SegmentCardPanel', 'SegmentCardClient', 'SegmentSelectionsClient'].indexOf(name) === -1) fail_('INVALID_REQUEST', 'Неизвестный компонент интерфейса.');
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Minimal app startup: the former Drive-tree screen is no longer rendered. */
function getAppBootstrap_(request) {
  return api_(function () {
    var context = authorize_(), registry;
    var options = request === undefined ? {} : object_(request);
    if (Object.keys(options).some(function (key) { return key !== 'includeSourcePreview'; }) ||
        (options.includeSourcePreview !== undefined && typeof options.includeSourcePreview !== 'boolean')) {
      fail_('INVALID_REQUEST', 'Неизвестные параметры загрузки реестра.');
    }
    if (typeof Drive !== 'undefined' && Drive.Files && typeof Drive.Files.get === 'function') {
      var folder;
      var fields = options.includeSourcePreview ? 'id,name,mimeType,trashed,driveId' : 'id,name,mimeType,trashed';
      try { folder = Drive.Files.get(context.rootId, {fields:fields, supportsAllDrives:true}); }
      catch (error) { fail_('NOT_FOUND', 'Корневая папка реестра недоступна.'); }
      if (!folder || folder.id !== context.rootId || folder.trashed !== false || folder.mimeType !== 'application/vnd.google-apps.folder' || typeof folder.name !== 'string')
        fail_('NOT_FOUND', 'Корневая папка реестра недоступна.');
      registry = {id:folder.id, name:folder.name};
    } else {
      var root = registryRoot_(context);
      registry = {id:root.getId(), name:root.getName()};
    }
    var result = {
      user: { email: '', isAdmin: false, accessMode: 'link' },
      registry: registry
    };
    if (options.includeSourcePreview && folder && typeof sourceBasesStartupPreview_ === 'function') {
      var preview = sourceBasesStartupPreview_(context, folder);
      if (preview) result.catalogPreview = preview;
    }
    return result;
  });
}

function getBootstrap_() {
  return api_(function () {
    var context = authorize_();
    var root = registryRoot_(context);
    var serviceId = context.properties.getProperty('SOURCE_BASES_STORAGE_ID') || REGISTRY_CONFIG.defaultSourceBasesStorageId;
    var stagingId = context.properties.getProperty('PREPARED_STAGING_FOLDER_ID');
    var folders = [], files = [], visited = {}, count = 0;
    function visit(folder, depth) {
      if (visited[folder.getId()]) return;
      if (depth > REGISTRY_CONFIG.maxTreeDepth) fail_('REGISTRY_LIMIT', 'Слишком много уровней папок. Откройте нужную базу в Google Диске.');
      visited[folder.getId()] = true;
      var fileIterator = folder.getFilesByType(REGISTRY_CONFIG.spreadsheetMime);
      while (fileIterator.hasNext()) {
        var file = fileIterator.next();
        if (file.isTrashed() || file.getId() === serviceId) continue;
        count++;
        if (count > REGISTRY_CONFIG.maxTreeEntries) fail_('REGISTRY_LIMIT', 'Реестр превышает лимит первой версии: 500 папок и баз.');
        files.push({ id: file.getId(), name: file.getName(), parentId: folder.getId(), url: spreadsheetUrl_(file.getId()) });
      }
      var folderIterator = folder.getFolders();
      while (folderIterator.hasNext()) {
        var child = folderIterator.next();
        if (child.isTrashed() || child.getId() === stagingId || visited[child.getId()]) continue;
        count++;
        if (count > REGISTRY_CONFIG.maxTreeEntries) fail_('REGISTRY_LIMIT', 'Реестр превышает лимит первой версии: 500 папок и баз.');
        folders.push({ id: child.getId(), name: child.getName(), parentId: folder.getId() });
        visit(child, depth + 1);
      }
    }
    visit(root, 0);
    var registry = { id: root.getId(), name: root.getName() };
    var segments = buildSegments_(context, registry, folders, files);
    if (typeof registryProjectScoped_ === 'function' && registryProjectScoped_()) {
      if (segments.source) {
        var allowed = new Set(segments.items.map(function (item) { return item.id; })), hidden = new Set();
        // The traversal emits parents before descendants.
        folders = folders.filter(function (folder) {
          if (hidden.has(folder.parentId) || (folder.parentId === segments.source.id && !allowed.has(folder.id))) hidden.add(folder.id);
          return !hidden.has(folder.id);
        });
        files = files.filter(function (file) { return !hidden.has(file.parentId); });
      } else if (segments.state !== 'source_missing') { folders = []; files = []; }
    }
    folders.sort(byName_);
    files.sort(byName_);
    return { user: { email: '', isAdmin: false, accessMode: 'link' }, registry: registry, folders: folders, files: files, segments: segments };
  });
}

function createBase_(request) {
  return api_(function () {
    var context = authorize_(), input = object_(request), name = itemName_(input.name);
    return locked_(function () {
      var folder = registryFolder_(context, input.parentId);
      if (typeof registryGuardItem_ === 'function') registryGuardItem_(context, folder);
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

function createFolder_(request) {
  return api_(function () {
    var context = authorize_(), input = object_(request), name = itemName_(input.name);
    return locked_(function () {
      var parent = registryFolder_(context, input.parentId);
      var outreachId = typeof registryGuardItem_ === 'function' ? registryGuardItem_(context, parent) : null;
      return creation_(context, 'folder', input.requestId, [parent.getId(), name], function () {
        var folder = parent.createFolder(name);
        if (parent.getId() === outreachId) registryAssignSegment_(context, folder.getId());
        return { folder: { id: folder.getId(), name: folder.getName(), parentId: parent.getId() } };
      });
    });
  });
}

function renameItem_(request) {
  return api_(function () {
    var context = authorize_(), input = object_(request), name = itemName_(input.name);
    if (input.kind !== 'file' && input.kind !== 'folder') fail_('INVALID_REQUEST', 'Неизвестный тип объекта.');
    return locked_(function () {
      var item = input.kind === 'folder' ? registryFolder_(context, input.id) : registryFile_(context, input.id);
      if (item.getId() === context.rootId) fail_('ROOT_PROTECTED', 'Корневую папку реестра переименовывают через Google Диск.');
      if (typeof registryGuardItem_ === 'function') registryGuardItem_(context, item);
      item.setName(name);
      return { id: item.getId(), name: item.getName(), kind: input.kind };
    });
  });
}

function authorize_() {
  if (typeof SHARED_REQUEST_SCOPE_ === 'undefined' || !SHARED_REQUEST_SCOPE_) fail_('LINK_ACCESS_REQUIRED', sharedAccessMessage_());
  var properties = PropertiesService.getScriptProperties();
  if (!sharedHashEqual_(SHARED_REQUEST_SCOPE_.keyHash, sharedConfiguredHash_(properties))) fail_('LINK_ACCESS_REQUIRED', sharedAccessMessage_());
  var rootId = properties.getProperty('ROOT_FOLDER_ID') || REGISTRY_CONFIG.defaultRootFolderId;
  id_(rootId);
  return { email: 'shared-link', rootId: rootId, isAdmin: false, accessMode: 'link', properties: properties };
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

function creation_(context, kind, requestId, args, callback) {
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) fail_('INVALID_REQUEST', 'Не удалось определить запрос создания. Откройте форму ещё раз.');
  var projectSuffix = typeof registryProjectId_ === 'function' && registryProjectId_() === 'neosender' ? '|neosender' : '';
  var key = 'CREATE_' + digest_(context.email + '|' + kind + '|' + requestId + projectSuffix).slice(0,32);
  var fingerprint = JSON.stringify(args);
  var existing = context.properties.getProperty(key);
  if (existing) {
    var receipt;
    try { receipt = JSON.parse(existing); } catch (error) { fail_('CREATION_UNCERTAIN', 'Обновите реестр перед повторным созданием.'); }
    if (receipt.fingerprint !== fingerprint) fail_('REQUEST_REUSED', 'Этот запрос создания уже использован. Откройте форму ещё раз.');
    if (receipt.status === 'done') {
      if (typeof registryGuardItem_ === 'function') {
        var artifact = kind === 'folder' ? registryFolder_(context, receipt.result.folder.id) : registryFile_(context, receipt.result.file.id);
        registryGuardItem_(context, artifact);
      }
      return receipt.result;
    }
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

function locked_(callback, waitMillis) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMillis === undefined ? 10000 : waitMillis)) fail_('BUSY', 'Сейчас выполняется другое сохранение. Повторите через несколько секунд.');
  try { return callback(); } finally { lock.releaseLock(); }
}

function digest_(value) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)).replace(/=+$/, '');
}

function itemName_(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\u0000-\u001f]/.test(value)) fail_('INVALID_NAME', 'Введите название от 1 до 100 символов без переносов строк.');
  return value.trim();
}
function id_(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{10,200}$/.test(value)) fail_('INVALID_ID', 'Некорректный идентификатор файла или папки.'); return value; }
function object_(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail_('INVALID_REQUEST', 'Некорректный запрос приложения.'); return value; }
function normalizeEmail_(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
function emailList_(value) { var list; try { list = JSON.parse(value); } catch (error) { list = String(value).split(/[\s,;]+/); } if (!Array.isArray(list)) list = []; return list.map(normalizeEmail_).filter(function (email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }); }
function spreadsheetUrl_(fileId) { return 'https://docs.google.com/spreadsheets/d/' + id_(fileId) + '/edit'; }
function byName_(a, b) { return a.name.localeCompare(b.name, 'ru', { numeric: true }); }
function escapeHtml_(value) { return String(value).replace(/[&<>"']/g, function (character) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]; }); }
function registryError_(code, message) { var error = new Error('[' + code + '] ' + message); error.registryCode = code; return error; }
function fail_(code, message) { throw registryError_(code, message); }
function api_(callback) { try { return callback(); } catch (error) { if (error && error.registryCode) throw error; console.warn('Registry operation failed: ' + (error && error.name ? error.name : 'Error')); throw registryError_('GOOGLE_ERROR', 'Google отклонил операцию. Проверьте права на папку и таблицу, затем обновите данные.'); } }
