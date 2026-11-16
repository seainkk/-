/** Explicit, authenticated imports into the bound source folder. No source cells are read. */
var SOURCE_IMPORT_CONFIG = Object.freeze({
  receiptLimit: 80,
  fields: 'id,name,mimeType,parents,webViewLink,trashed,appProperties,driveId,capabilities(canCopy,canEdit,canRename,canMoveItemWithinDrive,canMoveItemOutOfDrive)',
  keyProperty: 'registryImportKey',
  fingerprintProperty: 'registryImportFingerprint',
  uploadTypes: {
    csv: 'text/csv', tsv: 'text/tab-separated-values',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ods: 'application/vnd.oasis.opendocument.spreadsheet'
  }
});

function uploadSourceBase(form) {
  return api_(function () {
    authorize_();
    var input = importInput_(form, ['name', 'baseType', 'contentsJSON', 'status', 'requestId', 'file']);
    var common = importCommon_(input), blob = input.file;
    if (!blob || typeof blob.getBytes !== 'function' || typeof blob.getName !== 'function' || typeof blob.setContentType !== 'function') fail_('INVALID_UPLOAD', 'Выберите файл CSV, TSV, XLS, XLSX или ODS.');
    var filename = String(blob.getName()), extension = filename.match(/\.([a-zA-Z0-9]+)$/);
    extension = extension ? extension[1].toLowerCase() : '';
    var mimeType = SOURCE_IMPORT_CONFIG.uploadTypes[extension];
    if (!mimeType) fail_('INVALID_UPLOAD', 'Поддерживаются файлы CSV, TSV, XLS, XLSX и ODS.');
    importUploadMime_(blob, extension);
    var bytes = blob.getBytes(), maximum = REGISTRY_CONFIG.importMaxBytes || 10 * 1024 * 1024;
    if (!bytes || !bytes.length) fail_('INVALID_UPLOAD', 'Выбранный файл пуст.');
    if (bytes.length > maximum) fail_('UPLOAD_LIMIT', 'Размер файла превышает 10 МиБ.');
    var hash = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)).replace(/=+$/, '');
    return locked_(function () {
      var preparation = importPrepare_();
      common.kind = 'upload'; common.mode = 'upload'; common.extension = extension; common.mimeType = mimeType;
      common.fingerprintParts = [hash, bytes.length, extension, mimeType];
      return importExecute_(preparation, common, function (receipt, key, fingerprint, beginMutation) {
        blob.setContentType(mimeType);
        importDestinationWritable_(preparation);
        beginMutation();
        return importDriveCall_(function () {
          return Drive.Files.create({ name: common.name, mimeType: REGISTRY_CONFIG.spreadsheetMime, parents: [preparation.binding.source.id], appProperties: importTags_(null, key, fingerprint) }, blob, { fields: SOURCE_IMPORT_CONFIG.fields, supportsAllDrives: true });
        }, 'upload');
      });
    });
  });
}

function importSourceBaseLink(request) {
  return api_(function () {
    authorize_();
    var input = importInput_(request, ['url', 'name', 'baseType', 'contents', 'status', 'mode', 'requestId']);
    var common = importCommon_(input), link = importSheetLink_(input.url);
    if (input.mode !== 'copy' && input.mode !== 'move') fail_('INVALID_MODE', 'Выберите копирование или перемещение исходной таблицы.');
    common.kind = 'link'; common.mode = input.mode; common.link = link;
    common.fingerprintParts = [link.id, link.resourceKey, input.mode];
    return locked_(function () {
      var preparation = importPrepare_();
      importProtectOriginal_(link.id, preparation);
      return importExecute_(preparation, common, function (receipt, key, fingerprint, beginMutation) {
        var original = importGetFile_(link.id, link.resourceKey);
        importNativeSheet_(original);
        if (!receipt.original) {
          receipt.original = { id: original.id, name: String(original.name || ''), parents: (original.parents || []).slice().sort() };
          if (receipt.original.name.length > 2000) fail_('INVALID_NAME', 'Слишком длинное исходное название таблицы. Сначала сократите его в Google Диске.');
          receipt.preActionRevision = common.mode === 'move' && preparation.database.records[original.id] ? preparation.database.records[original.id].revision : 0;
        }
        if (common.mode === 'copy') {
          if (original.capabilities && original.capabilities.canCopy === false) fail_('COPY_ACCESS_REQUIRED', 'Google Диск запрещает копирование исходной таблицы для текущего аккаунта. Попросите владельца разрешить копирование или предоставить подходящий доступ.');
          importDestinationWritable_(preparation);
          beginMutation();
          return importCopyFile_(link, { name: common.name, parents: [preparation.binding.source.id], appProperties: importTags_(null, key, fingerprint) });
        }
        var originalParents = (original.parents || []).slice().sort();
        var ownTag = original.appProperties && original.appProperties[SOURCE_IMPORT_CONFIG.keyProperty] === key;
        if (ownTag || original.name !== receipt.original.name || JSON.stringify(originalParents) !== JSON.stringify(receipt.original.parents)) {
          // A retried move may never silently rename or relocate a file changed
          // since the first attempt, even if the caller still has Drive access.
          fail_('CREATION_UNCERTAIN', 'Состояние исходной таблицы изменилось. Проверьте файл перед повторным перемещением: ' + spreadsheetUrl_(original.id));
        }
        importMoveWritable_(preparation, original, common.name);
        beginMutation();
        return importMoveFile_(link, original, preparation.binding.source.id, common.name, key, fingerprint);
      });
    });
  });
}

function importPrepare_() {
  var context = authorize_(), binding = sourceBasesSource_(context);
  if (binding.state !== 'ready') fail_('SOURCE_UNAVAILABLE', 'Папка исходных баз недоступна в реестре.');
  registryFolder_(context, binding.source.id);
  // Validate the fixed service book BEFORE inspecting its writable schema.
  var storage = sourceBasesStorage_(context);
  if (typeof Drive === 'undefined' || !Drive.Files || ['create', 'copy', 'update', 'get', 'list'].some(function (name) { return typeof Drive.Files[name] !== 'function'; })) fail_('DRIVE_SETUP_REQUIRED', 'В проекте Apps Script нужно включить Google Drive API v3. Обратитесь к администратору.');
  var capability = importDriveCall_(function () { return Drive.Files.get(storage.public.id, { fields: 'capabilities(canEdit)', supportsAllDrives: true }); }, 'storage');
  if (!capability || !capability.capabilities || capability.capabilities.canEdit !== true) fail_('STORAGE_WRITE_REQUIRED', 'Для добавления базы нужны права редактора на служебную таблицу. Обратитесь к администратору.');
  // Schema migration may write metadata; it also requires confirmed edit rights.
  var database = sourceBasesReadDatabase_(storage);
  var destination = importDriveCall_(function () { return Drive.Files.get(binding.source.id, { fields: 'id,mimeType,trashed,driveId,capabilities(canAddChildren)', supportsAllDrives: true }); }, 'destination');
  if (!destination || destination.id !== binding.source.id || destination.trashed || destination.mimeType !== 'application/vnd.google-apps.folder') fail_('DESTINATION_ACCESS_REQUIRED', 'Папка «Исходные базы» недоступна. Проверьте привязку папки и доступ текущего аккаунта.');
  return { context: context, binding: binding, storage: storage, database: database, destination: destination };
}

function importDestinationWritable_(preparation) {
  // An unknown capability is left to Google's actual write. A read/recovery
  // path must not require permission to add a file that already exists.
  if (preparation.destination.capabilities && preparation.destination.capabilities.canAddChildren === false) fail_('DESTINATION_ACCESS_REQUIRED', 'У текущего аккаунта нет права добавлять файлы в папку «Исходные базы». Попросите владельца папки предоставить это право.');
}

function importMoveWritable_(preparation, original, name) {
  var capabilities = original.capabilities || {}, changesParent = (original.parents || []).indexOf(preparation.binding.source.id) === -1;
  var sameDrive = String(original.driveId || '') === String(preparation.destination.driveId || '');
  var denied = capabilities.canEdit === false || (original.name !== name && capabilities.canRename === false);
  if (changesParent) {
    importDestinationWritable_(preparation);
    denied = denied || (sameDrive ? capabilities.canMoveItemWithinDrive === false : capabilities.canMoveItemOutOfDrive === false);
  }
  // Ownership is not a prerequisite by itself. Positive capabilities also do
  // not guarantee the new-parent operation; Drive remains authoritative.
  if (denied) fail_('MOVE_ACCESS_REQUIRED', importMoveAccessMessage_());
}

function importMoveAccessMessage_() {
  return 'Google Диск не разрешает текущему аккаунту перенос или переименование исходной таблицы. Право редактирования не всегда даёт право переносить файл между папками. Проверьте права на таблицу и папку «Исходные базы» либо явно выберите «Создать копию».';
}

function importInput_(value, allowed) {
  var input = object_(value);
  if (Object.keys(input).some(function (key) { return allowed.indexOf(key) === -1; })) fail_('INVALID_REQUEST', 'В запросе импорта есть неизвестные поля.');
  return input;
}

function importCommon_(input) {
  var name = itemName_(input.name);
  var hasContents = Object.prototype.hasOwnProperty.call(input, 'contents');
  var hasJSON = Object.prototype.hasOwnProperty.call(input, 'contentsJSON');
  if (hasContents && !Array.isArray(input.contents)) fail_('INVALID_CONTENTS', 'Наполнение базы должно содержать компании и/или ЛПР.');
  var selected = hasContents ? input.contents : input.baseType;
  if (hasJSON) {
    if (typeof input.contentsJSON !== 'string' || input.contentsJSON.length > 100) fail_('INVALID_CONTENTS', 'Выберите наполнение базы: компании и/или ЛПР.');
    try { selected = JSON.parse(input.contentsJSON); } catch (error) { fail_('INVALID_CONTENTS', 'Не удалось прочитать наполнение базы.'); }
    if (!Array.isArray(selected)) fail_('INVALID_CONTENTS', 'Наполнение базы должно содержать компании и/или ЛПР.');
  }
  var contents = sourceBaseContents_(selected), baseType = sourceBaseLegacyType_(contents);
  if (input.baseType !== undefined && (hasContents || hasJSON) && input.baseType !== baseType) fail_('INVALID_CONTENTS', 'Наполнение базы не соответствует указанному типу.');
  if (SOURCE_BASES_SCHEMA.statuses.indexOf(input.status) === -1) fail_('INVALID_STATUS', 'Выберите допустимый статус сбора.');
  if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.requestId)) fail_('INVALID_REQUEST', 'Не удалось определить запрос импорта. Откройте форму заново.');
  return { name: name, baseType: baseType, contents: contents, status: input.status, requestId: input.requestId };
}

function importUploadMime_(blob, extension) {
  var declared = typeof blob.getContentType === 'function' ? String(blob.getContentType() || '').split(';')[0].trim().toLowerCase() : '';
  if (!declared || declared === 'application/octet-stream') return;
  var allowed = {
    csv: ['text/csv', 'application/csv', 'text/plain', 'text/comma-separated-values', 'application/vnd.ms-excel'],
    tsv: ['text/tab-separated-values', 'text/tsv', 'text/plain'],
    xls: ['application/vnd.ms-excel', 'application/msexcel', 'application/x-ole-storage'],
    xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'],
    ods: ['application/vnd.oasis.opendocument.spreadsheet', 'application/zip']
  };
  if (allowed[extension].indexOf(declared) === -1) fail_('INVALID_UPLOAD', 'Тип выбранного файла не соответствует CSV, TSV, XLS, XLSX или ODS.');
}

function importSheetLink_(value) {
  if (typeof value !== 'string' || value.length > 4096) fail_('INVALID_LINK', 'Вставьте ссылку на исходную Google Таблицу.');
  var text = value.trim();
  if (/^[a-zA-Z0-9_-]{10,200}$/.test(text)) return { id: text, resourceKey: '' };
  var match = text.match(/^https:\/\/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{10,200})(?:\/(?:edit|view|preview))?\/?(?:\?([^#\s]*))?(?:#[^\s]*)?$/);
  if (!match) fail_('INVALID_LINK', 'Нужна ссылка вида docs.google.com/spreadsheets/d/ID/edit, а не опубликованная страница таблицы.');
  var resourceKey = '', count = 0;
  try {
    (match[2] || '').split('&').forEach(function (part) {
      if (!part) return;
      var separator = part.indexOf('='), key = decodeURIComponent(separator < 0 ? part : part.slice(0, separator));
      if (key.toLowerCase() !== 'resourcekey') return;
      count++;
      resourceKey = decodeURIComponent(separator < 0 ? '' : part.slice(separator + 1));
    });
  } catch (error) { fail_('INVALID_LINK', 'Ссылка на таблицу содержит некорректные параметры.'); }
  if (count > 1 || (count && !/^[a-zA-Z0-9_-]{10,200}$/.test(resourceKey))) fail_('INVALID_LINK', 'Параметр resourcekey в ссылке некорректен.');
  return { id: id_(match[1]), resourceKey: resourceKey };
}

function importProtectOriginal_(fileId, preparation) {
  var protectedIds = [preparation.context.rootId, preparation.binding.source.id, preparation.storage.public.id, REGISTRY_CONFIG.defaultSourceBasesStorageId];
  if (protectedIds.indexOf(fileId) !== -1) fail_('PROTECTED_FILE', 'Служебную таблицу и папки реестра нельзя использовать как исходную базу.');
}

function importExecute_(preparation, common, action) {
  var context = preparation.context, destination = preparation.binding.source.id;
  var key = 'IMPORT_' + digest_(context.email + '|' + common.kind + '|' + common.requestId).slice(0, 32);
  var fingerprint = digest_(JSON.stringify([context.rootId, destination, common.kind, common.mode, common.name, common.baseType, common.status, common.fingerprintParts]));
  var receipt = importReadReceipt_(context, key);
  if (receipt && receipt.fingerprint !== fingerprint) fail_('REQUEST_REUSED', 'Этот запрос импорта уже использован с другими параметрами. Откройте форму заново.');
  var existed = !!receipt;
  if (!receipt) {
    receipt = { version: 1, fingerprint: fingerprint, mode: common.mode, destination: destination, status: 'pending', attempted: false, fileId: '', preActionRevision: 0, metadataCommitted: false, createdAt: new Date().toISOString() };
    importAllocateReceipt_(context, key, receipt);
  }
  var recovered = existed;
  var mutationStartedThisInvocation = false;
  var previousMutationUncertain = !!receipt.attempted && receipt.status !== 'retryable';
  try {
    if (!receipt.fileId) {
      var found = importRecoverFile_(key, fingerprint);
      if (found) {
        receipt.fileId = id_(found.id);
        receipt.status = 'file_ready';
        // A tagged artifact without its older journal may be a replay long
        // after import; preserve any metadata that users have since changed.
        if (!existed) receipt.metadataCommitted = true;
        recovered = true;
        importSaveReceipt_(context, key, receipt, false);
      } else if (receipt.attempted && receipt.status !== 'retryable' && common.mode !== 'move') {
        fail_('CREATION_UNCERTAIN', 'Предыдущий импорт ещё не подтверждён. Обновите исходные базы и проверьте Диск перед новым импортом.');
      }
    }
    if (!receipt.fileId) {
      // For a move the explicit original ID allows an exact recovery check.
      if (common.mode === 'move' && receipt.original) {
        var moved = importGetFile_(common.link.id, common.link.resourceKey);
        importNativeSheet_(moved);
        if (moved.appProperties && moved.appProperties[SOURCE_IMPORT_CONFIG.keyProperty] === key && moved.appProperties[SOURCE_IMPORT_CONFIG.fingerprintProperty] === fingerprint) {
          receipt.fileId = moved.id;
          receipt.status = 'file_ready';
          recovered = true;
          importSaveReceipt_(context, key, receipt, false);
        }
      }
      if (!receipt.fileId) {
        // Capture the original move snapshot durably before the API action.
        if (common.mode === 'move' && !receipt.original) {
          var original = importGetFile_(common.link.id, common.link.resourceKey);
          importNativeSheet_(original);
          receipt.original = { id: original.id, name: String(original.name || ''), parents: (original.parents || []).slice().sort() };
          if (receipt.original.name.length > 2000) fail_('INVALID_NAME', 'Слишком длинное исходное название таблицы. Сначала сократите его в Google Диске.');
          receipt.preActionRevision = preparation.database.records[original.id] ? preparation.database.records[original.id].revision : 0;
        }
        var output = action(receipt, key, fingerprint, function () {
          // Validation and source metadata reads are not mutations. Mark the
          // uncertain boundary only immediately before sending a Drive write.
          var needsRow = common.mode !== 'move' || !preparation.database.records[common.link.id];
          if (needsRow && preparation.database.lastRow >= REGISTRY_CONFIG.maxSourceBaseRows + 1) fail_('STORAGE_LIMIT', 'Служебный реестр заполнен. Новый файл не был создан или перемещён.');
          receipt.attempted = true;
          receipt.status = 'pending';
          importSaveReceipt_(context, key, receipt, true);
          mutationStartedThisInvocation = true;
        });
        receipt.fileId = id_(output.id);
        receipt.status = 'file_ready';
        importSaveReceipt_(context, key, receipt, false);
      }
    }
    return importFinalize_(preparation, common, key, receipt, recovered);
  } catch (error) {
    if (!receipt.attempted && !receipt.fileId) {
      receipt.status = 'retryable';
      importSaveReceipt_(context, key, receipt, false);
      if (error.registryCode) throw error;
      fail_('IMPORT_FAILED', 'Не удалось проверить исходную таблицу. Проверьте доступ и повторите импорт.');
    }
    if (error.driveDefiniteFailure && mutationStartedThisInvocation && !previousMutationUncertain && !receipt.fileId) {
      receipt.status = 'retryable';
      receipt.attempted = false;
      importSaveReceipt_(context, key, receipt, false);
      throw error;
    }
    if (!receipt.fileId && receipt.attempted) {
      try {
        var recovery = importRecoverFile_(key, fingerprint);
        if (recovery) {
          receipt.fileId = id_(recovery.id);
          receipt.status = 'file_ready';
          importSaveReceipt_(context, key, receipt, false);
          return importFinalize_(preparation, common, key, receipt, true);
        }
      } catch (recoveryError) { /* Keep the durable pending receipt, never create another file. */ }
    }
    if (receipt.fileId) fail_('CREATION_UNCERTAIN', 'Файл уже существует, но сохранение его состояния не подтверждено. Повторите тот же запрос для восстановления записи: ' + spreadsheetUrl_(receipt.fileId));
    if (error.registryCode) throw error;
    fail_('CREATION_UNCERTAIN', 'Google не подтвердил импорт. Обновите исходные базы и проверьте Диск перед новым импортом.');
  }
}

function importFinalize_(preparation, common, key, receipt, recovered) {
  var context = authorize_(), binding = sourceBasesSource_(context);
  if (binding.state !== 'ready' || binding.source.id !== receipt.destination || context.rootId !== preparation.context.rootId) fail_('SOURCE_CHANGED', 'Папка исходных баз изменилась во время импорта.');
  registryFolder_(context, binding.source.id);
  var file = importGetFile_(receipt.fileId, common.mode === 'move' && common.link ? common.link.resourceKey : '', 'result');
  importNativeSheet_(file);
  if ((file.parents || []).indexOf(binding.source.id) === -1) fail_('OUTSIDE_REGISTRY', 'Ранее импортированный файл находится в другой папке.');
  var storage = sourceBasesStorage_(context), database = sourceBasesReadDatabase_(storage);
  var metadata = { id: id_(file.id), name: String(file.name), fileName: String(file.name), mimeType: REGISTRY_CONFIG.spreadsheetMime, format: 'Google Таблицы', url: spreadsheetUrl_(file.id) };
  var options, current = database.records[file.id];
  if (!receipt.metadataCommitted && receipt.preActionRevision > 0) options = { expectedRevision: receipt.preActionRevision };
  else if (!receipt.metadataCommitted && receipt.preActionRevision === 0 && current && current.revision === 1 && current.baseType === 'general' && current.status === 'collection' && current.formatCheck === 'unchecked') options = { expectedRevision: 1 };
  var record = registerImportedSourceBase_(context, storage, database, metadata, common.contents, common.status, options);
  receipt.status = 'done'; receipt.metadataCommitted = true;
  importSaveReceipt_(context, key, receipt, false);
  return { item: sourceBaseItem_(metadata, record, sourceBasesAssociations_(database.relations, context)), file: { id: metadata.id, name: metadata.name, url: metadata.url, mimeType: metadata.mimeType }, mode: common.mode, recovered: !!recovered };
}

function importReadReceipt_(context, key) {
  var raw = context.properties.getProperty(key);
  if (!raw) return null;
  try {
    var receipt = JSON.parse(raw);
    if (!receipt || receipt.version !== 1 || typeof receipt.fingerprint !== 'string') throw new Error('Invalid receipt');
    return receipt;
  } catch (error) { fail_('CREATION_UNCERTAIN', 'Журнал предыдущего импорта требует проверки администратора. Новый файл не был создан.'); }
}

function importAllocateReceipt_(context, key, receipt) {
  var index;
  try { index = JSON.parse(context.properties.getProperty('IMPORT_RECEIPT_INDEX') || '[]'); } catch (error) { fail_('IMPORT_STORAGE', 'Журнал импорта требует проверки администратора.'); }
  if (!Array.isArray(index)) fail_('IMPORT_STORAGE', 'Журнал импорта требует проверки администратора.');
  index = index.filter(function (entry) { return entry !== key; });
  while (index.length >= SOURCE_IMPORT_CONFIG.receiptLimit) {
    var removable = -1;
    for (var position = 0; position < index.length; position++) {
      var old = importReadReceipt_(context, index[position]);
      if (!old || old.status === 'done' || old.status === 'retryable') { removable = position; break; }
    }
    if (removable < 0) fail_('IMPORT_BUSY', 'Есть неподтверждённые импорты. Сначала восстановите их записи.');
    context.properties.deleteProperty(index.splice(removable, 1)[0]);
  }
  index.push(key);
  importSaveReceipt_(context, key, receipt, true);
  context.properties.setProperty('IMPORT_RECEIPT_INDEX', JSON.stringify(index));
}

function importSaveReceipt_(context, key, receipt, required) {
  try {
    var encoded = JSON.stringify(receipt);
    if (encoded.length > 8000) throw new Error('Receipt too large');
    context.properties.setProperty(key, encoded);
  } catch (error) {
    if (required) fail_('IMPORT_STORAGE', 'Не удалось сохранить журнал импорта. Файл не был создан или перемещён.');
    console.warn('Import receipt update failed; tagged artifact remains recoverable.');
  }
}

function importTags_(original, key, fingerprint) {
  var tags = Object.create(null);
  Object.keys(original || {}).forEach(function (name) { tags[name] = original[name]; });
  tags[SOURCE_IMPORT_CONFIG.keyProperty] = key;
  tags[SOURCE_IMPORT_CONFIG.fingerprintProperty] = fingerprint;
  return tags;
}

function importRecoverFile_(key, fingerprint) {
  var result = importDriveCall_(function () {
    return Drive.Files.list({ q: "appProperties has { key='" + SOURCE_IMPORT_CONFIG.keyProperty + "' and value='" + key + "' }", fields: 'files(' + SOURCE_IMPORT_CONFIG.fields + '),nextPageToken', pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true });
  }, 'recovery');
  var files = result.files || [];
  if (files.length > 1 || result.nextPageToken) fail_('CREATION_UNCERTAIN', 'Найдено несколько результатов предыдущего импорта. Требуется проверка администратора.');
  if (!files.length) return null;
  var file = files[0];
  if (!file.appProperties || file.appProperties[SOURCE_IMPORT_CONFIG.fingerprintProperty] !== fingerprint) fail_('CREATION_UNCERTAIN', 'Результат предыдущего импорта не совпадает с параметрами запроса.');
  return file;
}

function importNativeSheet_(file) {
  if (!file || file.trashed || file.mimeType !== REGISTRY_CONFIG.spreadsheetMime) fail_('INVALID_SOURCE', 'Нужна доступная исходная Google Таблица. Файлы XLSX и CSV загружают через вкладку файла.');
  id_(file.id);
  return file;
}

function importGetFile_(fileId, resourceKey, stage) {
  id_(fileId);
  if (resourceKey) return importRest_('get', '/' + fileId, null, { fields: SOURCE_IMPORT_CONFIG.fields, supportsAllDrives: true }, fileId, resourceKey, stage || 'source');
  return importDriveCall_(function () { return Drive.Files.get(fileId, { fields: SOURCE_IMPORT_CONFIG.fields, supportsAllDrives: true }); }, stage || 'source');
}

function importCopyFile_(link, metadata) {
  if (link.resourceKey) return importRest_('post', '/' + link.id + '/copy', metadata, { fields: SOURCE_IMPORT_CONFIG.fields, supportsAllDrives: true }, link.id, link.resourceKey, 'copy');
  return importDriveCall_(function () { return Drive.Files.copy(metadata, link.id, { fields: SOURCE_IMPORT_CONFIG.fields, supportsAllDrives: true }); }, 'copy');
}

function importMoveFile_(link, original, destination, name, key, fingerprint) {
  var options = { fields: SOURCE_IMPORT_CONFIG.fields, supportsAllDrives: true };
  var parents = original.parents || [], remove = parents.filter(function (parent) { return parent !== destination; });
  if (parents.indexOf(destination) === -1) options.addParents = destination;
  if (remove.length) options.removeParents = remove.join(',');
  var metadata = { appProperties: importTags_(original.appProperties, key, fingerprint) };
  if (original.name !== name) metadata.name = name;
  if (link.resourceKey) return importRest_('patch', '/' + link.id, metadata, options, link.id, link.resourceKey, 'move');
  return importDriveCall_(function () { return Drive.Files.update(metadata, link.id, null, options); }, 'move');
}

function importRest_(method, path, metadata, query, fileId, resourceKey, stage) {
  if (!/^[a-zA-Z0-9_-]{10,200}$/.test(resourceKey) || !/^\/[a-zA-Z0-9_-]{10,200}(?:\/copy)?$/.test(path) || ['get', 'post', 'patch'].indexOf(method) === -1) fail_('INVALID_LINK', 'Некорректные параметры ссылки на таблицу.');
  if (typeof UrlFetchApp === 'undefined' || typeof ScriptApp === 'undefined') fail_('DRIVE_SETUP_REQUIRED', 'Для ссылок с resourcekey нужно обновить разрешения приложения. Обратитесь к администратору.');
  var address = 'https://www.googleapis.com/drive/v3/files' + path + '?' + Object.keys(query).map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(String(query[key])); }).join('&');
  var options = { method: method, muteHttpExceptions: true, followRedirects: false, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Goog-Drive-Resource-Keys': id_(fileId) + '/' + resourceKey } };
  if (metadata) { options.contentType = 'application/json'; options.payload = JSON.stringify(metadata); }
  var response;
  try { response = UrlFetchApp.fetch(address, options); }
  catch (error) { throw importDriveFailure_(0, '', stage); }
  var status = response.getResponseCode(), body;
  try { body = JSON.parse(response.getContentText()); } catch (error) { throw importDriveFailure_(status >= 400 ? status : 0, '', stage); }
  if (status < 200 || status >= 300) {
    var reason = body && body.error && body.error.errors && body.error.errors[0] ? body.error.errors[0].reason : '';
    if (!reason && body && body.error && /SERVICE_DISABLED|accessNotConfigured/.test(JSON.stringify(body.error.details || []))) reason = 'SERVICE_DISABLED';
    throw importDriveFailure_(status, reason, stage);
  }
  return body;
}

function importDriveCall_(callback, stage) {
  try { return callback(); }
  catch (error) {
    if (error.registryCode) throw error;
    var evidence = importDriveEvidence_(error);
    var reason = evidence.reason;
    var status = evidence.status;
    throw importDriveFailure_(Number.isFinite(status) ? status : 0, reason, stage);
  }
}

function importDriveEvidence_(error) {
  var details = error && error.details;
  if (typeof details === 'string') { try { details = JSON.parse(details); } catch (ignored) { details = null; } }
  if (details && details.error) details = details.error;
  var first = details && details.errors && details.errors[0] ? details.errors[0] : Array.isArray(details) ? details[0] : null;
  var status = Number(error && (error.driveStatus || error.status || error.code) || details && details.code);
  var reason = String(error && error.reason || details && details.reason || first && first.reason || '');
  var message = String(error && error.message || '');
  if (/SERVICE_DISABLED|accessNotConfigured|Drive API has not been used|Drive API.*not.*enabled/i.test(message) || reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED') return { status: 403, reason: 'SERVICE_DISABLED' };
  var reasons = { insufficientPermissions: 403, insufficientFilePermissions: 403, forbidden: 403, cannotCopyFile: 403, notFound: 404, rateLimitExceeded: 429, userRateLimitExceeded: 429, dailyLimitExceeded: 429, storageQuotaExceeded: 403, domainPolicy: 403, fileOwnerNotMemberOfTeamDrive: 403, fileWriterTeamDriveMoveInDisabled: 403, teamDriveMembershipRequired: 403, badRequest: 400, invalid: 400 };
  if (!status && reasons[reason]) status = reasons[reason];
  // Apps Script GoogleJsonResponseException often omits numeric fields. Only
  // known Drive API rejection prefixes count as definite failures; transport
  // and internal errors stay uncertain and never trigger another creation.
  var rejection = message.match(/^(?:GoogleJsonResponseException:\s*)?API call to drive\.files\.(?:get|list|create|copy|update) failed with error:\s*([\s\S]*)$/i);
  if (!status && rejection) {
    var text = rejection[1];
    if (/^The user's (?:Drive )?storage quota has been exceeded/i.test(text)) { status = 403; reason = 'storageQuotaExceeded'; }
    else if (/^Cannot move a file into a shared drive as a writer when the owner of the file is not a member/i.test(text)) { status = 403; reason = 'fileOwnerNotMemberOfTeamDrive'; }
    else if (/^The domain administrator has not allowed writers to move items into a shared drive/i.test(text)) { status = 403; reason = 'fileWriterTeamDriveMoveInDisabled'; }
    else if (/^(?:The user does not have sufficient permissions for (?:this file|file)|Insufficient Permission|Insufficient permissions|You do not have permission to|This file cannot be copied by the user|Copying this file is not allowed)/i.test(text)) status = 403;
    else if (/^File not found(?::|\.|$)/i.test(text)) { status = 404; reason = 'notFound'; }
    else if (/^(?:Rate Limit Exceeded|User Rate Limit Exceeded|Quota exceeded|Daily Limit Exceeded|Too Many Requests)/i.test(text)) { status = 429; reason = 'rateLimitExceeded'; }
    else if (/^(?:Invalid Value|Invalid argument|Bad Request|Unsupported (?:file|mime|conversion)|Conversion of the uploaded content to the requested output type is not supported|The file is too large|Upload limit exceeded)/i.test(text)) status = 400;
  }
  return { status: Number.isFinite(status) ? status : 0, reason: reason };
}

function importDriveFailure_(status, reason, stage) {
  var error;
  if (reason === 'SERVICE_DISABLED' || reason === 'accessNotConfigured') error = registryError_('DRIVE_SETUP_REQUIRED', 'В проекте Apps Script нужно включить Google Drive API v3. Обратитесь к администратору.');
  else if (status === 401) error = registryError_('AUTH_REQUIRED', 'Google просит повторно подтвердить доступ к Диску. Откройте приложение заново.');
  else if (reason === 'insufficientPermissions') error = registryError_('DRIVE_AUTH_REQUIRED', 'Google не предоставил приложению нужные разрешения Диска. Откройте приложение заново и подтвердите доступ; если ошибка повторится, обратитесь к администратору.');
  else if (reason === 'storageQuotaExceeded') error = registryError_('DRIVE_STORAGE_FULL', 'Google Диск отклонил импорт: закончилось место в хранилище аккаунта. Освободите место или увеличьте объём хранилища.');
  else if (['domainPolicy', 'fileOwnerNotMemberOfTeamDrive', 'fileWriterTeamDriveMoveInDisabled', 'teamDriveMembershipRequired'].indexOf(reason) !== -1) error = registryError_('DRIVE_POLICY_REQUIRED', 'Google Диск отклонил действие из-за правил организации или общего диска. Попросите администратора проверить участие владельца файла и текущего аккаунта в общем диске и разрешение на перенос.');
  else if (status === 429 || ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'sharingRateLimitExceeded'].indexOf(reason) !== -1) error = registryError_('DRIVE_BUSY', 'Google временно ограничил запросы. Повторите импорт позже.');
  else if (status === 404) {
    var missing = stage === 'destination' ? ['DESTINATION_NOT_FOUND', 'Google не нашёл папку «Исходные базы» либо она недоступна текущему аккаунту. Проверьте привязку папки и доступ.'] : stage === 'source' || stage === 'copy' || stage === 'move' ? ['SOURCE_NOT_FOUND', stage === 'source' ? 'Google не нашёл исходную таблицу либо она недоступна аккаунту, открывшему приложение. Проверьте ссылку и доступ именно этого Google-аккаунта.' : 'Google не нашёл исходную таблицу или папку назначения либо доступ к ним изменился. Проверьте ссылку, папку «Исходные базы» и доступ текущего аккаунта.'] : ['DRIVE_NOT_FOUND', 'Google не нашёл файл или папку на этапе проверки импорта. Проверьте доступ текущего аккаунта.'];
    error = registryError_(missing[0], missing[1]);
  }
  else if (status === 403) {
    var denied = {
      source: ['SOURCE_ACCESS_REQUIRED', 'Исходная таблица недоступна аккаунту, открывшему приложение. Откройте её под тем же Google-аккаунтом и проверьте выданный доступ.'],
      destination: ['DESTINATION_ACCESS_REQUIRED', 'У текущего аккаунта нет доступа к папке «Исходные базы». Попросите владельца проверить доступ к папке.'],
      upload: ['DESTINATION_ACCESS_REQUIRED', 'Google Диск запретил создание файла в папке «Исходные базы». Проверьте право текущего аккаунта добавлять туда файлы.'],
      copy: ['COPY_ACCESS_REQUIRED', 'Google Диск запретил копирование таблицы. Проверьте разрешение на копирование исходника и добавление файлов в папку «Исходные базы».'],
      move: ['MOVE_ACCESS_REQUIRED', importMoveAccessMessage_()],
      storage: ['STORAGE_WRITE_REQUIRED', 'Служебная таблица недоступна текущему аккаунту. Попросите администратора проверить права редактора.'],
      recovery: ['IMPORT_RECOVERY_ACCESS_REQUIRED', 'Google Диск не разрешил проверить результат предыдущего импорта. Повторное создание заблокировано до проверки результата; проверьте доступ текущего аккаунта и повторите тот же запрос.']
    };
    var detail = denied[stage] || ['DRIVE_ACCESS_REQUIRED', 'Google Диск не разрешил проверку файла или папки. Проверьте доступ текущего аккаунта.'];
    error = registryError_(detail[0], detail[1]);
  }
  else if (status >= 400 && status < 500) error = registryError_('IMPORT_FAILED', 'Google Диск отклонил импорт. Проверьте формат файла и права на таблицу.');
  else error = registryError_('DRIVE_UNCERTAIN', 'Google не подтвердил операцию с файлом. Проверьте предыдущий импорт перед новым запросом.');
  error.driveDefiniteFailure = reason === 'SERVICE_DISABLED' || reason === 'accessNotConfigured' || (status >= 400 && status < 500);
  return error;
}
