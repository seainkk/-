/** Segment folders, canonical workbooks and append-only, auditable sheet loads. */
var SEGMENT_ACTIONS_SCHEMA = Object.freeze({
  tablesTab: 'SegmentTables',
  tablesHeaders: ['segmentId', 'kind', 'fileId'],
  loadsTab: 'SegmentLoads',
  loadsHeaders: ['sourceId', 'sourceSheetId', 'segmentId', 'targetKind', 'targetFileId', 'targetSheetId', 'hasHeader', 'requestId', 'stage', 'updatedAt'],
  kinds: ['companies', 'lpr'],
  stages: ['planned', 'copying', 'copied', 'complete'],
  maxLoads: 5,
  maxSheets: 20,
  receiptLimit: 80
});

function getSourceSheets_(request) {
  return api_(function () {
    authorize_();
    var input = segmentInput_(request, ['sourceId', 'expectedRevision']);
    var sourceId = id_(input.sourceId);
    segmentRevision_(input.expectedRevision);
    return locked_(function () {
      var context = authorize_(), storage = sourceBasesStorage_(context);
      var database = sourceBasesReadDatabase_(storage);
      var source = requireReadySourceBase_(context, storage, database, sourceId, input.expectedRevision);
      var book = SpreadsheetApp.openById(sourceId);
      return {
        sourceId: sourceId,
        name: source.file.getName(),
        revision: source.record.revision,
        contents: source.contents.slice(),
        sheets: book.getSheets().map(function (sheet) { return { id: sheet.getSheetId(), name: sheet.getName(), hasHeader: true }; })
      };
    });
  });
}

function createSegment_(request) { return typeof segmentNormalizedMutation_ === 'function' ? segmentNormalizedMutation_('create', request) : segmentMutation_('create', request); }
function updateSegment_(request) { return typeof segmentNormalizedMutation_ === 'function' ? segmentNormalizedMutation_('update', request) : segmentMutation_('update', request); }

function segmentMutation_(kind, request) {
  return api_(function () {
    authorize_();
    var input = segmentMutationInput_(kind, request);
    var name = input.name === undefined && kind === 'update' ? null : itemName_(input.name);
    var segmentId = kind === 'update' ? id_(input.id) : null;
    var requestId = segmentRequestId_(input.requestId), loads = segmentLoadInput_(input.loads);
    var categoryOnly = segmentCategoryOnly_(kind, input, loads);
    if (kind === 'update' && name === null && !categoryOnly && !loads.length) fail_('INVALID_REQUEST', 'Выберите изменение сегмента.');
    var args = { id: segmentId, name: name, loads: loads };
    // Old clients must still be able to retry requests already in the journal.
    if (input.category !== undefined) args.category = input.category;
    if (input.expectedCategory !== undefined) args.expectedCategory = input.expectedCategory;
    return locked_(function () {
      var context = authorize_(), parent = segmentSourceFolder_(context);
      if (kind === 'update' && typeof registryRequireSegment_ === 'function') registryRequireSegment_(context, segmentId);
      var storage = sourceBasesStorage_(context);
      segmentRequireStorageWrite_(storage);
      // Empty segments and name-only changes do not consume source records or
      // relationships. The fixed service file and tracking schemas are still
      // checked below; source readiness is checked whenever loads are present.
      var database = loads.length ? sourceBasesReadDatabase_(storage) : { relations: [] };
      // Every source is revalidated before any folder, workbook or worksheet
      // mutation, including retries whose copies were already acknowledged.
      var plans = segmentPrepareLoads_(context, storage, database, loads);
      var folder = kind === 'update' ? segmentFolder_(context, parent, segmentId) : null;
      var journal = segmentJournal_(context, kind, requestId, args, folder);
      var recovered = journal.existing;
      if (journal.value.segmentId) folder = segmentFolder_(context, parent, journal.value.segmentId);
      if (!folder) {
        var recoveredFolderId = segmentCreateArtifact_(context, parent, 'folder', name, journal, true);
        if (recoveredFolderId) {
          recovered = true;
          journal.value.segmentId = recoveredFolderId;
          delete journal.value.creating.folder;
          segmentSaveJournal_(context, journal);
          folder = segmentFolder_(context, parent, recoveredFolderId);
        }
      }
      if (kind === 'create' && folder && typeof registrySegmentProject_ === 'function') {
        var owner = registrySegmentProject_(context, folder.getId());
        if (owner && owner !== registryProjectId_()) fail_('OUTSIDE_PROJECT', 'Сегмент уже относится к другому проекту.');
        if (!owner && journal.value.creationProjectId !== registryProjectId_()) fail_('SEGMENT_PROJECT_REQUIRED', 'Сначала закрепите существующий сегмент за проектом в разделе «Сегменты».');
      }
      var tracking = categoryOnly ? null : segmentTrackingStorage_(context, storage, true);
      if (!categoryOnly) segmentPreflight_(storage, database, tracking, folder ? folder.getId() : null, plans, requestId);
      try {
        if (categoryOnly) {
          if (journal.value.stage !== 'done') {
            segmentApplyCategory_(context, folder, journal, false);
            journal.value.stage = 'done';
            segmentSaveJournal_(context, journal);
          }
          return { segment: segmentFolderResult_(context, folder), loadedSheets: [], recovered: recovered };
        }
        if (!folder) folder = segmentCreateFolder_(context, parent, name, journal);
        if (kind === 'create' && typeof registryAssignSegment_ === 'function') registryAssignSegment_(context, folder.getId());
        segmentApplyCategory_(context, folder, journal, kind === 'create' && !journal.existing && recovered);
        var desiredName = name === null ? folder.getName() : name;
        var tables = segmentEnsureTables_(context, folder, desiredName, storage, tracking, journal);
        // All target identities are server-resolved and checked again immediately
        // before copying; callers cannot supply a destination file identifier.
        if (folder.getName() !== desiredName) folder.setName(desiredName);
        SEGMENT_ACTIONS_SCHEMA.kinds.forEach(function (targetKind) {
          var target = segmentTargetFile_(context, folder, tables[targetKind]);
          var desiredFileName = segmentTableName_(desiredName, targetKind);
          if (target.getName() !== desiredFileName) target.setName(desiredFileName);
        });
        // The locked action has not changed either tracking tab yet. Reuse its
        // validated snapshot instead of reading both complete journals again.
        segmentRememberTables_(tracking, folder.getId(), tables);
        var loaded = segmentCopyPlans_(context, storage, database, tracking, folder, tables, plans, requestId, journal);
        journal.value.stage = 'done';
        segmentSaveJournal_(context, journal);
        return { segment: segmentActionResult_(context, folder, tables), loadedSheets: loaded, recovered: recovered };
      } catch (error) {
        if (!journal.value.segmentId) throw error;
        var recoveryUrl = segmentFolderUrl_(journal.value.segmentId);
        if (error.registryCode) {
          if (error.message.indexOf(recoveryUrl) === -1) error.message += ' Часть изменений могла сохраниться. Проверьте сегмент: ' + recoveryUrl;
          throw error;
        }
        fail_('SEGMENT_RECOVERY_REQUIRED', 'Google не подтвердил завершение действия. Часть изменений могла сохраниться. Проверьте сегмент: ' + recoveryUrl + '. Повторите действие с теми же параметрами; подтверждённые листы не копируются повторно.');
      }
    });
  });
}

function segmentMutationInput_(kind, request) {
  var input = segmentInput_(request, kind === 'create' ? ['name', 'requestId', 'loads', 'category'] : ['id', 'name', 'requestId', 'loads', 'category', 'expectedCategory']);
  [input.category, input.expectedCategory].forEach(function (category) {
    if (category !== undefined && category !== 'partners' && category !== 'clients') {
      fail_('INVALID_REQUEST', 'Выберите раздел «Партнерка» или «Клиенты».');
    }
  });
  return input;
}

function segmentCategoryOnly_(kind, input, loads) {
  return kind === 'update' && input.name === undefined && input.category !== undefined && !loads.length;
}

function segmentPlanCategory_(context, folder, args, journalValue) {
  var category = args.category, previousProperty = null;
  if (folder) {
    var oldName = folder.getName();
    previousProperty = context.properties.getProperty(segmentCategoryKey_(folder.getId()));
    var savedCategory = segmentStoredCategory_(previousProperty), currentCategory = savedCategory || segmentDefaultCategory_(oldName);
    if (args.expectedCategory !== undefined && args.expectedCategory !== currentCategory) segmentCategoryConflict_();
    // Persist the existing legacy category when an application rename would change it.
    if (category === undefined && !savedCategory && args.name !== null && segmentDefaultCategory_(args.name) !== currentCategory) category = currentCategory;
  }
  if (category !== undefined) journalValue.categoryChange = { before: previousProperty, category: category };
}

function segmentApplyCategory_(context, folder, journal, recoveredCreate) {
  var change = journal.value.categoryChange;
  if (!change || journal.value.stage === 'done') return;
  var key = segmentCategoryKey_(folder.getId()), current = context.properties.getProperty(key);
  // The property also records the request so a lost write response can be
  // distinguished from a change made by another request.
  var desired = JSON.stringify({ category: change.category, request: journal.key });
  if (current === desired) return;
  if (current !== change.before) {
    // A recovered folder can outlive the bounded journal of its original create.
    if (recoveredCreate) return;
    segmentCategoryConflict_();
  }
  context.properties.setProperty(key, desired);
}

function segmentCategoryConflict_() {
  fail_('SEGMENT_CATEGORY_CONFLICT', 'Раздел сегмента изменился. Обновите список сегментов и повторите действие.');
}

function segmentInput_(value, keys) {
  var input = object_(value);
  if (Object.keys(input).some(function (key) { return keys.indexOf(key) === -1; })) fail_('INVALID_REQUEST', 'Неизвестные параметры действия с сегментом.');
  return input;
}

function segmentRequestId_(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) fail_('INVALID_REQUEST', 'Откройте форму сегмента ещё раз: отсутствует идентификатор действия.');
  return value;
}

function segmentRevision_(value) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) fail_('INVALID_REQUEST', 'Обновите версию базы перед загрузкой.');
}

function segmentLoadInput_(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > SEGMENT_ACTIONS_SCHEMA.maxLoads) fail_('SEGMENT_LOAD_LIMIT', 'За одно действие можно добавить не больше пяти баз.');
  var seen = Object.create(null), total = 0;
  var result = value.map(function (raw) {
    var input = segmentInput_(raw, ['sourceId', 'expectedRevision', 'sheets']);
    var sourceId = id_(input.sourceId);
    if (seen[sourceId]) fail_('INVALID_REQUEST', 'Одна исходная база выбрана несколько раз.');
    seen[sourceId] = true;
    segmentRevision_(input.expectedRevision);
    if (!Array.isArray(input.sheets) || !input.sheets.length) fail_('INVALID_REQUEST', 'Выберите хотя бы один лист базы для загрузки.');
    var sheetIds = Object.create(null);
    var sheets = input.sheets.map(function (rawSheet) {
      var sheet = segmentInput_(rawSheet, ['sheetId', 'target', 'hasHeader']);
      if (!Number.isSafeInteger(sheet.sheetId) || sheet.sheetId < 0 || sheetIds[sheet.sheetId]) fail_('INVALID_REQUEST', 'Выберите каждый лист только один раз.');
      sheetIds[sheet.sheetId] = true;
      if (SEGMENT_ACTIONS_SCHEMA.kinds.indexOf(sheet.target) === -1 || typeof sheet.hasHeader !== 'boolean') fail_('INVALID_REQUEST', 'Для каждого листа укажите наполнение и наличие строки заголовков.');
      if (++total > SEGMENT_ACTIONS_SCHEMA.maxSheets) fail_('SEGMENT_LOAD_LIMIT', 'За одно действие можно скопировать не больше двадцати листов.');
      return { sheetId: sheet.sheetId, target: sheet.target, hasHeader: sheet.hasHeader };
    }).sort(function (a, b) { return a.sheetId - b.sheetId; });
    var normalized = { sourceId: sourceId, sheets: sheets };
    if (input.expectedRevision !== undefined) normalized.expectedRevision = input.expectedRevision;
    return normalized;
  });
  return result.sort(function (a, b) { return a.sourceId.localeCompare(b.sourceId); });
}

function segmentSourceFolder_(context) {
  registryRoot_(context);
  var explicit = context.properties.getProperty('SEGMENTS_FOLDER_ID');
  explicit = typeof explicit === 'string' ? explicit.trim() : '';
  var folder = null;
  try { folder = folderById_(explicit || REGISTRY_CONFIG.defaultSegmentsFolderId); }
  catch (error) { if (explicit) throw error; }
  if (!folder && !explicit) {
    var matches = [], children = registryRoot_(context).getFolders();
    while (children.hasNext()) {
      var candidate = children.next();
      if (!candidate.isTrashed() && segmentFolderName_(candidate.getName()) === segmentFolderName_(REGISTRY_CONFIG.segmentsFolderName)) matches.push(candidate);
    }
    if (matches.length > 1) fail_('SEGMENTS_AMBIGUOUS', 'В реестре несколько папок «Аутричи». Уточните привязку у администратора.');
    folder = matches[0];
  }
  if (!folder || folder.isTrashed() || folder.getId() === context.rootId || !insideRegistry_(folder, context.rootId)) fail_('SEGMENTS_UNAVAILABLE', 'Папка «Аутричи» недоступна в этом реестре.');
  return folder;
}

function segmentDirectParent_(item, parentId) {
  var parents = item.getParents();
  while (parents.hasNext()) { var parent = parents.next(); if (parent.getId() === parentId && !parent.isTrashed()) return true; }
  return false;
}

function segmentFolder_(context, parent, segmentId, verifiedParent) {
  // A fresh segmentSourceFolder_ already verified the parent's full ancestry.
  var folder = verifiedParent === true ? folderById_(id_(segmentId)) : registryFolder_(context, segmentId);
  if (verifiedParent === true && folder.isTrashed() || !segmentDirectParent_(folder, parent.getId())) fail_('OUTSIDE_SEGMENTS', 'Эта папка не является отдельным сегментом папки «Аутричи».');
  return folder;
}

function segmentRequireStorageWrite_(storage) {
  if (typeof Drive === 'undefined' || !Drive.Files || typeof Drive.Files.get !== 'function') fail_('DRIVE_API_REQUIRED', 'Для управления сегментами требуется включённый Google Drive API.');
  var file;
  try { file = Drive.Files.get(storage.public.id, { fields: 'capabilities(canEdit)', supportsAllDrives: true }); }
  catch (error) { fail_('STORAGE_WRITE_REQUIRED', 'Не удалось подтвердить права редактора на служебную таблицу.'); }
  if (!file || !file.capabilities || file.capabilities.canEdit !== true) fail_('STORAGE_WRITE_REQUIRED', 'Для управления сегментами нужны права редактора на служебную таблицу.');
}

function segmentPrepareLoads_(context, storage, database, loads) {
  return loads.map(function (load) {
    var source = requireReadySourceBase_(context, storage, database, load.sourceId, load.expectedRevision);
    var book = SpreadsheetApp.openById(load.sourceId), sheets = Object.create(null);
    book.getSheets().forEach(function (sheet) { sheets[sheet.getSheetId()] = sheet; });
    return {
      sourceId: load.sourceId,
      expectedRevision: load.expectedRevision,
      sheets: load.sheets.map(function (choice) {
        if (source.contents.indexOf(choice.target) === -1) fail_('INVALID_SHEET_TARGET', 'Выбранное наполнение листа отсутствует в сохранённом наполнении базы.');
        if (!sheets[choice.sheetId]) fail_('SOURCE_SHEET_CHANGED', 'Выбранный лист исчез из исходной базы. Обновите список листов.');
        return { source: sheets[choice.sheetId], sheetId: choice.sheetId, target: choice.target, hasHeader: choice.hasHeader };
      })
    };
  });
}

function segmentJournal_(context, kind, requestId, args, folder) {
  var projectSuffix = typeof registryProjectId_ === 'function' && registryProjectId_() === 'neosender' ? '|neosender' : '';
  var key = 'SEGMENT_ACTION_' + digest_(context.email + '|' + kind + '|' + requestId + projectSuffix).slice(0, 32);
  var fingerprint = digest_(JSON.stringify(args)), raw = context.properties.getProperty(key);
  if (raw) {
    var value;
    try { value = JSON.parse(raw); } catch (error) { fail_('SEGMENT_RECOVERY_REQUIRED', 'Журнал предыдущего действия недоступен. Проверьте папку сегмента перед повтором.'); }
    if (value.fingerprint !== fingerprint) fail_('REQUEST_REUSED', 'Этот запрос уже использован с другими параметрами. Откройте новую форму.');
    return { key: key, value: value, existing: true };
  }
  var journal = { key: key, existing: false, value: { fingerprint: fingerprint, segmentId: args.id, stage: 'planned', files: {}, leaves: {}, creating: {} } };
  segmentPlanCategory_(context, folder, args, journal.value);
  var index;
  try { index = JSON.parse(context.properties.getProperty('SEGMENT_ACTION_INDEX') || '[]'); }
  catch (error) { fail_('SEGMENT_RECOVERY_REQUIRED', 'Журнал действий с сегментами требует проверки администратора.'); }
  if (!Array.isArray(index)) fail_('SEGMENT_RECOVERY_REQUIRED', 'Журнал действий с сегментами требует проверки администратора.');
  while (index.length >= SEGMENT_ACTIONS_SCHEMA.receiptLimit) {
    var position = index.findIndex(function (entry) {
      var receipt = context.properties.getProperty(entry);
      if (!receipt) return true;
      try { return JSON.parse(receipt).stage === 'done'; } catch (error) { return false; }
    });
    if (position === -1) fail_('SEGMENT_RECOVERY_REQUIRED', 'Слишком много неподтверждённых действий. Сначала проверьте предыдущие операции.');
    context.properties.deleteProperty(index.splice(position, 1)[0]);
  }
  segmentSaveJournal_(context, journal);
  index.push(key);
  context.properties.setProperty('SEGMENT_ACTION_INDEX', JSON.stringify(index));
  return journal;
}

function segmentSaveJournal_(context, journal) {
  var raw = JSON.stringify(journal.value);
  if (raw.length > 8500) fail_('SEGMENT_LOAD_LIMIT', 'Журнал действия превышает лимит. Добавляйте листы несколькими действиями.');
  context.properties.setProperty(journal.key, raw);
}

function segmentRecovery_(folder, message) {
  fail_('SEGMENT_RECOVERY_REQUIRED', message + ' Проверьте результат на Google Диске: ' + segmentFolderUrl_(folder.getId()) + '. Повторите исходное действие с теми же параметрами; неподтверждённый лист повторно не копируется.');
}

function segmentCreateFolder_(context, parent, name, journal) {
  var folderId = segmentCreateArtifact_(context, parent, 'folder', name, journal);
  journal.value.segmentId = folderId;
  delete journal.value.creating.folder;
  journal.value.stage = 'folder_created';
  segmentSaveJournal_(context, journal);
  return folderById_(folderId);
}

/** The marker and parent are committed atomically by Drive with the artifact. */
function segmentCreateArtifact_(context, parent, role, name, journal, lookupOnly) {
  var marker = journal.key.slice('SEGMENT_ACTION_'.length);
  var mimeType = role === 'folder' ? 'application/vnd.google-apps.folder' : REGISTRY_CONFIG.spreadsheetMime;
  var stage = 'creating_' + role;
  if (!journal.value.creating) journal.value.creating = {};
  // Drive markers outlive the bounded ScriptProperties receipt history, so an
  // old request can still recover its original artifacts after receipt expiry.
  var found = [], pageToken, lookupKey = role + '|' + parent.getId();
  // A create request first checks for recovery before its capacity preflight.
  // Its confirmed miss can be reused only in this invocation, before any
  // attempt to create this role; it is never stored in ScriptProperties.
  try {
    if (!journal.lookupMisses || !journal.lookupMisses[lookupKey]) {
      do {
        var options = { q: "appProperties has { key='registrySegmentAction' and value='" + marker + "' } and appProperties has { key='registrySegmentRole' and value='" + role + "' }", fields: 'files(id,mimeType,trashed,parents,appProperties),nextPageToken', pageSize: 100, spaces: 'drive', includeItemsFromAllDrives: true, supportsAllDrives: true };
        if (pageToken) options.pageToken = pageToken;
        var page = Drive.Files.list(options);
        found = found.concat(page.files || []);
        pageToken = page.nextPageToken;
        if (found.length > 1) break;
      } while (pageToken);
    }
  } catch (error) { segmentRecovery_(parent, 'Не удалось проверить результат предыдущего создания.'); }
  if (found.length) {
    if (found.length !== 1 || found[0].trashed || found[0].mimeType !== mimeType || (found[0].parents || []).indexOf(parent.getId()) === -1) segmentRecovery_(parent, 'Предыдущее создание ещё не подтверждено либо объект перемещён.');
    if (!found[0].appProperties || found[0].appProperties.registrySegmentFingerprint !== journal.value.fingerprint) fail_('REQUEST_REUSED', 'Этот запрос создания уже использован с другими параметрами. Откройте новую форму.');
    return id_(found[0].id);
  }
  if (journal.value.creating[role]) segmentRecovery_(parent, 'Предыдущее создание ещё не найдено в Google Диске.');
  if (lookupOnly) {
    if (!journal.lookupMisses) journal.lookupMisses = Object.create(null);
    journal.lookupMisses[lookupKey] = true;
    return null;
  }
  if (journal.lookupMisses) delete journal.lookupMisses[lookupKey];
  journal.value.stage = stage;
  journal.value.creating[role] = true;
  // A prior request can recover this receipt after Drive creates its folder
  // but before the ownership property is saved. Old folders require a claim.
  if (role === 'folder' && typeof registryProjectId_ === 'function') journal.value.creationProjectId = registryProjectId_();
  segmentSaveJournal_(context, journal);
  var created;
  try {
    created = Drive.Files.create({ name: name, mimeType: mimeType, parents: [parent.getId()], appProperties: { registrySegmentAction: marker, registrySegmentRole: role, registrySegmentFingerprint: journal.value.fingerprint } }, null, { fields: 'id', supportsAllDrives: true });
  } catch (error) { segmentRecovery_(parent, 'Google не подтвердил создание ' + (role === 'folder' ? 'сегмента' : 'вложенной таблицы') + '.'); }
  if (!created || typeof created.id !== 'string') segmentRecovery_(parent, 'Google не вернул идентификатор созданного объекта.');
  return id_(created.id);
}

function segmentTableName_(name, kind) { return name + (kind === 'companies' ? ': компании' : ': ЛПР'); }

function segmentEnsureTables_(context, folder, desiredName, storage, tracking, journal) {
  var tables = {}, candidatesByKind = null, tracked = tracking.tables.filter(function (table) { return table.segmentId === folder.getId(); });
  SEGMENT_ACTIONS_SCHEMA.kinds.forEach(function (kind) {
    var existing = tracked.filter(function (table) { return table.kind === kind; })[0];
    var fileId = journal.value.files[kind] || (existing ? existing.fileId : null);
    if (!fileId && !(journal.value.creating && journal.value.creating[kind])) {
      if (!candidatesByKind) {
        candidatesByKind = { companies: [], lpr: [] };
        var iterator = folder.getFilesByType(REGISTRY_CONFIG.spreadsheetMime), folderName = folder.getName();
        while (iterator.hasNext()) {
          var candidate = iterator.next();
          if (candidate.isTrashed()) continue;
          var candidateName = candidate.getName();
          SEGMENT_ACTIONS_SCHEMA.kinds.forEach(function (candidateKind) {
            if (candidateName === segmentTableName_(folderName, candidateKind) || candidateName === segmentTableName_(desiredName, candidateKind)) candidatesByKind[candidateKind].push(candidate);
          });
        }
      }
      var candidates = candidatesByKind[kind];
      if (candidates.length > 1) fail_('SEGMENT_TABLE_AMBIGUOUS', 'В сегменте несколько таблиц с одинаковым назначением. Проверьте их в Google Диске.');
      if (candidates.length) fileId = candidates[0].getId();
    }
    if (!fileId) {
      fileId = segmentCreateArtifact_(context, folder, kind, segmentTableName_(desiredName, kind), journal);
      delete journal.value.creating[kind];
    }
    // Store adopted identities before the first rename so retries do not rely
    // on names that may already have changed during a partial rename.
    journal.value.files[kind] = fileId;
    journal.value.stage = 'tables_pending';
    segmentSaveJournal_(context, journal);
    var file;
    try { file = DriveApp.getFileById(id_(fileId)); }
    catch (error) { segmentRecovery_(folder, 'Созданная или связанная таблица сейчас недоступна.'); }
    if (file.isTrashed() || file.getMimeType() !== REGISTRY_CONFIG.spreadsheetMime) fail_('SEGMENT_TABLE_CHANGED', 'Вложенная таблица недоступна или её тип изменился.');
    if (!segmentDirectParent_(file, folder.getId())) fail_('OUTSIDE_SEGMENTS', 'Вложенная таблица была перемещена за пределы своего сегмента.');
    // Validate the object just retrieved, including actual root ancestry.
    // Fetching it again through registryFile_ would repeat the same Drive GET.
    if (!insideRegistry_(file, context.rootId)) fail_('OUTSIDE_REGISTRY', 'Эта таблица не относится к выбранному реестру.');
    tables[kind] = fileId;
  });
  if (tables.companies === tables.lpr) fail_('STORAGE_SCHEMA', 'Компании и ЛПР должны храниться в разных вложенных таблицах.');
  return tables;
}

function segmentTargetFile_(context, folder, fileId) {
  var file = registryFile_(context, fileId);
  if (!segmentDirectParent_(file, folder.getId())) fail_('OUTSIDE_SEGMENTS', 'Вложенная таблица больше не находится непосредственно в папке сегмента.');
  return file;
}

function segmentActionResult_(context, folder, tables) {
  var result = segmentFolderResult_(context, folder);
  result.files = SEGMENT_ACTIONS_SCHEMA.kinds.map(function (kind) {
    var file = segmentTargetFile_(context, folder, tables[kind]);
    return { id: file.getId(), name: file.getName(), url: spreadsheetUrl_(file.getId()), kind: kind };
  });
  return result;
}

function segmentTrackingStorage_(context, storage, create) {
  var book = storage.book, tablesSheet = book.getSheetByName(SEGMENT_ACTIONS_SCHEMA.tablesTab), loadsSheet = book.getSheetByName(SEGMENT_ACTIONS_SCHEMA.loadsTab);
  var initKey = 'SEGMENT_TRACKING_INIT_' + storage.public.id, pending = context.properties.getProperty(initKey) === 'pending';
  if (!tablesSheet && !loadsSheet && !create) return { tables: [], loads: [], tablesSheet: null, loadsSheet: null };
  if ((!tablesSheet || !loadsSheet) && !create) fail_('STORAGE_SCHEMA', 'Не все служебные листы сегментов доступны.');
  if (create && (!tablesSheet || !loadsSheet || pending)) {
    if ((tablesSheet || loadsSheet) && !pending) fail_('STORAGE_SCHEMA', 'Служебные листы сегментов созданы не полностью. Требуется проверка администратора.');
    if (!pending) { context.properties.setProperty(initKey, 'pending'); pending = true; }
    try {
      if (!tablesSheet) tablesSheet = book.insertSheet(SEGMENT_ACTIONS_SCHEMA.tablesTab);
      if (tablesSheet.getLastRow() === 0) tablesSheet.getRange(1, 1, 1, SEGMENT_ACTIONS_SCHEMA.tablesHeaders.length).setValues([SEGMENT_ACTIONS_SCHEMA.tablesHeaders]);
      if (!loadsSheet) loadsSheet = book.insertSheet(SEGMENT_ACTIONS_SCHEMA.loadsTab);
      if (loadsSheet.getLastRow() === 0) loadsSheet.getRange(1, 1, 1, SEGMENT_ACTIONS_SCHEMA.loadsHeaders.length).setValues([SEGMENT_ACTIONS_SCHEMA.loadsHeaders]);
    } finally { SpreadsheetApp.flush(); }
  }
  var rawTables = sourceBasesReadRows_(tablesSheet, SEGMENT_ACTIONS_SCHEMA.tablesHeaders);
  var rawLoads = sourceBasesReadRows_(loadsSheet, SEGMENT_ACTIONS_SCHEMA.loadsHeaders);
  var pairs = Object.create(null), fileIds = Object.create(null), leaves = Object.create(null), targets = Object.create(null);
  var tables = rawTables.rows.map(function (row, index) {
    if (row.every(function (value) { return value === ''; })) return null;
    var segmentId = id_(row[0]), kind = row[1], fileId = id_(row[2]), key = segmentId + '|' + kind;
    if (SEGMENT_ACTIONS_SCHEMA.kinds.indexOf(kind) === -1 || pairs[key] || fileIds[fileId]) fail_('STORAGE_SCHEMA', 'Служебные назначения таблиц сегмента некорректны.');
    pairs[key] = true; fileIds[fileId] = true;
    return { segmentId: segmentId, kind: kind, fileId: fileId, row: index + 2 };
  }).filter(Boolean);
  var loads = rawLoads.rows.map(function (row, index) {
    if (row.every(function (value) { return value === ''; })) return null;
    var sourceId = id_(row[0]), segmentId = id_(row[2]), targetFileId = id_(row[4]);
    var key = sourceId + '|' + row[1] + '|' + segmentId;
    var validTargetSheet = row[5] === '' || (Number.isSafeInteger(row[5]) && row[5] >= 0);
    if (!Number.isSafeInteger(row[1]) || row[1] < 0 || SEGMENT_ACTIONS_SCHEMA.kinds.indexOf(row[3]) === -1 || !validTargetSheet || typeof row[6] !== 'boolean' || typeof row[7] !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(row[7]) || SEGMENT_ACTIONS_SCHEMA.stages.indexOf(row[8]) === -1 || typeof row[9] !== 'string' || !Number.isFinite(Date.parse(row[9])) || leaves[key]) fail_('STORAGE_SCHEMA', 'Журнал загрузки листов содержит некорректные данные.');
    if ((row[8] === 'copied' || row[8] === 'complete') && row[5] === '') fail_('STORAGE_SCHEMA', 'В журнале отсутствует подтверждённый идентификатор листа.');
    var table = tables.filter(function (candidate) { return candidate.segmentId === segmentId && candidate.kind === row[3]; })[0];
    if (!table || table.fileId !== targetFileId) fail_('STORAGE_SCHEMA', 'Назначение загруженного листа не совпадает с таблицей сегмента.');
    if (row[5] !== '') {
      var targetKey = targetFileId + '|' + row[5];
      if (targets[targetKey]) fail_('STORAGE_SCHEMA', 'Один вложенный лист связан с несколькими исходными листами.');
      targets[targetKey] = true;
    }
    leaves[key] = true;
    return { sourceId: sourceId, sourceSheetId: row[1], segmentId: segmentId, targetKind: row[3], targetFileId: targetFileId, targetSheetId: row[5], hasHeader: row[6], requestId: row[7], stage: row[8], updatedAt: row[9], row: index + 2 };
  }).filter(Boolean);
  if (pending && create) context.properties.deleteProperty(initKey);
  return { tables: tables, loads: loads, tablesSheet: tablesSheet, loadsSheet: loadsSheet, tablesLastRow: rawTables.lastRow, loadsLastRow: rawLoads.lastRow };
}

/** Read-only analytics contract: absence of both tabs means legacy, never init. */
function segmentReadTrackingSnapshot_(context) {
  try {
    var tracking = segmentTrackingStorage_(context, sourceBasesStorage_(context), false);
    return { available: true, tables: tracking.tables, loads: tracking.loads };
  } catch (error) { return { available: false, tables: [], loads: [], warnings: ['Журнал листов сегмента недоступен. Проверка количества контактов ограничена.'] }; }
}

/** A dashboard can share one validated, invocation-local journal snapshot. */
function segmentReadTracking_(context, segmentId, snapshot) {
  var tracking = snapshot || segmentReadTrackingSnapshot_(context);
  if (!tracking.available) return { available: false, tables: [], loads: [], warnings: tracking.warnings.slice() };
  return {
    available: true,
    tables: tracking.tables.filter(function (table) { return table.segmentId === segmentId; }).map(function (table) { return { fileId: table.fileId, kind: table.kind }; }),
    loads: tracking.loads.filter(function (load) { return load.segmentId === segmentId; }).map(function (load) {
      return { sourceId: load.sourceId, sourceSheetId: load.sourceSheetId, targetFileId: load.targetFileId, targetSheetId: load.targetSheetId, hasHeader: load.hasHeader, stage: load.stage };
    })
  };
}

function segmentWriteTrackingRow_(sheet, headers, record) {
  if (record.row > REGISTRY_CONFIG.maxSourceBaseRows + 1) fail_('STORAGE_LIMIT', 'Журнал сегментов превышает лимит 5000 строк.');
  try {
    var capacity = sheet.getMaxRows();
    if (record.row > capacity) sheet.insertRowsAfter(capacity, record.row - capacity);
    sheet.getRange(record.row, 1, 1, headers.length).setValues([headers.map(function (key) { return record[key]; })]);
  } finally { SpreadsheetApp.flush(); }
}

/** Capacity and earlier receipts are checked before even a folder rename. */
function segmentPreflight_(storage, database, tracking, segmentId, plans, requestId) {
  var newTables = SEGMENT_ACTIONS_SCHEMA.kinds.filter(function (kind) {
    return !tracking.tables.some(function (table) { return table.segmentId === segmentId && table.kind === kind; });
  }).length;
  var newLoads = 0, newRelations = 0;
  plans.forEach(function (plan) {
    if (!database.relations.some(function (relation) { return relation.fileId === plan.sourceId && relation.segmentId === segmentId; })) newRelations++;
    plan.sheets.forEach(function (choice) {
      var old = segmentId ? segmentFindLoad_(tracking, plan.sourceId, choice.sheetId, segmentId) : null;
      if (!old) { newLoads++; return; }
      if (old.targetKind !== choice.target || old.hasHeader !== choice.hasHeader) fail_('SHEET_ALREADY_LOADED', 'Этот лист уже загружен с другим назначением или настройкой заголовка.');
      if (old.requestId !== requestId && old.stage !== 'complete' && old.stage !== 'copied') fail_('SEGMENT_RECOVERY_REQUIRED', 'Предыдущая загрузка листа ещё не подтверждена. Проверьте сегмент: ' + segmentFolderUrl_(segmentId));
    });
  });
  var maximum = REGISTRY_CONFIG.maxSourceBaseRows + 1;
  if (tracking.tablesLastRow + newTables > maximum || tracking.loadsLastRow + newLoads > maximum || storage.relationsSheet.getLastRow() + newRelations > maximum) fail_('STORAGE_LIMIT', 'В служебной таблице недостаточно места для действия с сегментом. Новые файлы и листы не создавались.');
}

function segmentRememberTables_(tracking, segmentId, tables) {
  var additions = [], nextRow = tracking.tablesLastRow;
  SEGMENT_ACTIONS_SCHEMA.kinds.forEach(function (kind) {
    var old = tracking.tables.filter(function (table) { return table.segmentId === segmentId && table.kind === kind; })[0];
    if (old) {
      if (old.fileId !== tables[kind]) fail_('STORAGE_SCHEMA', 'Назначение вложенной таблицы изменилось.');
      return;
    }
    additions.push({ segmentId: segmentId, kind: kind, fileId: tables[kind], row: ++nextRow });
  });
  if (!additions.length) return;
  if (nextRow > REGISTRY_CONFIG.maxSourceBaseRows + 1) fail_('STORAGE_LIMIT', 'Журнал сегментов превышает лимит 5000 строк.');
  // Both canonical assignments are adjacent, so persist them in one write and
  // one flush before any worksheet copy can begin. Per-leaf copy stages still
  // use their individual durable writes.
  try {
    var capacity = tracking.tablesSheet.getMaxRows();
    if (nextRow > capacity) tracking.tablesSheet.insertRowsAfter(capacity, nextRow - capacity);
    tracking.tablesSheet.getRange(additions[0].row, 1, additions.length, SEGMENT_ACTIONS_SCHEMA.tablesHeaders.length).setValues(additions.map(function (record) {
      return SEGMENT_ACTIONS_SCHEMA.tablesHeaders.map(function (key) { return record[key]; });
    }));
  } finally { SpreadsheetApp.flush(); }
  tracking.tablesLastRow = nextRow;
  tracking.tables = tracking.tables.concat(additions);
}

function segmentCopyPlans_(context, storage, database, tracking, folder, tables, plans, requestId, journal) {
  var results = [], targetBooks = Object.create(null);
  // Preflight every existing receipt before copying any new leaf. A second
  // request cannot bypass an uncertain earlier outcome by changing its UUID.
  plans.forEach(function (plan) { plan.sheets.forEach(function (choice) {
    var old = segmentFindLoad_(tracking, plan.sourceId, choice.sheetId, folder.getId());
    if (!old) return;
    if (old.targetKind !== choice.target || old.hasHeader !== choice.hasHeader) fail_('SHEET_ALREADY_LOADED', 'Этот лист уже загружен с другим назначением или настройкой заголовка. Исходные данные не были скопированы повторно.');
    if (old.requestId !== requestId && old.stage !== 'complete' && old.stage !== 'copied') segmentRecovery_(folder, 'Предыдущая загрузка этого листа ещё не подтверждена.');
  }); });
  plans.forEach(function (plan) {
    plan.sheets.forEach(function (choice) {
      requireReadySourceBase_(context, storage, sourceBasesReadDatabase_(storage), plan.sourceId, plan.expectedRevision);
      var targetFileId = tables[choice.target], leafKey = plan.sourceId + '|' + choice.sheetId;
      segmentTargetFile_(context, folder, targetFileId);
      var record = segmentFindLoad_(tracking, plan.sourceId, choice.sheetId, folder.getId());
      if (!record) {
        record = { sourceId: plan.sourceId, sourceSheetId: choice.sheetId, segmentId: folder.getId(), targetKind: choice.target, targetFileId: targetFileId, targetSheetId: '', hasHeader: choice.hasHeader, requestId: requestId, stage: 'planned', updatedAt: new Date().toISOString(), row: ++tracking.loadsLastRow };
        segmentWriteTrackingRow_(tracking.loadsSheet, SEGMENT_ACTIONS_SCHEMA.loadsHeaders, record);
        tracking.loads.push(record);
      }
      var receipt = journal.value.leaves[leafKey];
      if (record.targetSheetId === '' && receipt && Number.isSafeInteger(receipt.id)) {
        record.targetSheetId = receipt.id; record.stage = 'copied';
        segmentWriteTrackingRow_(tracking.loadsSheet, SEGMENT_ACTIONS_SCHEMA.loadsHeaders, record);
      }
      var target = targetBooks[targetFileId] || (targetBooks[targetFileId] = SpreadsheetApp.openById(targetFileId));
      var copied;
      if (record.targetSheetId !== '') {
        copied = segmentFindSheet_(target, record.targetSheetId);
        if (!copied) segmentRecovery_(folder, 'Подтверждённый вложенный лист удалён или перемещён.');
      } else {
        if (record.stage === 'copying' || (receipt && receipt.stage === 'copying')) segmentRecovery_(folder, 'Google не подтвердил результат предыдущего копирования листа.');
        journal.value.leaves[leafKey] = { stage: 'copying' };
        segmentSaveJournal_(context, journal);
        record.stage = 'copying'; record.updatedAt = new Date().toISOString();
        segmentWriteTrackingRow_(tracking.loadsSheet, SEGMENT_ACTIONS_SCHEMA.loadsHeaders, record);
        try { copied = choice.source.copyTo(target); }
        catch (error) { segmentRecovery_(folder, 'Google не подтвердил копирование листа.'); }
        var copiedId = copied.getSheetId();
        journal.value.leaves[leafKey] = { stage: 'copied', id: copiedId };
        segmentSaveJournal_(context, journal);
        record.targetSheetId = copiedId; record.stage = 'copied'; record.updatedAt = new Date().toISOString();
        segmentWriteTrackingRow_(tracking.loadsSheet, SEGMENT_ACTIONS_SCHEMA.loadsHeaders, record);
      }
      // Keep all worksheets and cells. Naming is cosmetic and only attempted
      // when it cannot conflict with a pre-existing worksheet.
      if (record.stage !== 'complete' && copied.getName() !== choice.source.getName()) {
        var desired = choice.source.getName();
        if (!target.getSheets().some(function (sheet) { return sheet.getSheetId() !== copied.getSheetId() && sheet.getName().toLocaleLowerCase() === desired.toLocaleLowerCase(); })) copied.setName(desired);
      }
      results.push({ sourceId: plan.sourceId, sourceSheetId: choice.sheetId, targetFileId: targetFileId, targetSheetId: record.targetSheetId, target: choice.target, hasHeader: choice.hasHeader });
    });
  });
  // A source/segment association means every leaf requested in THIS action has
  // an acknowledged destination ID. No relationship is invented for a partial
  // or uncertain copy, and retry re-reads/deduplicates existing relationships.
  plans.forEach(function (plan) { segmentRememberRelation_(context, storage, database, plan.sourceId, folder.getId(), requestId); });
  results.forEach(function (result) {
    var record = segmentFindLoad_(tracking, result.sourceId, result.sourceSheetId, folder.getId());
    if (record.stage !== 'complete') {
      record.stage = 'complete'; record.updatedAt = new Date().toISOString();
      segmentWriteTrackingRow_(tracking.loadsSheet, SEGMENT_ACTIONS_SCHEMA.loadsHeaders, record);
    }
  });
  return results;
}

function segmentFindLoad_(tracking, sourceId, sourceSheetId, segmentId) {
  return tracking.loads.filter(function (load) { return load.sourceId === sourceId && load.sourceSheetId === sourceSheetId && load.segmentId === segmentId; })[0] || null;
}

function segmentFindSheet_(book, sheetId) {
  return book.getSheets().filter(function (sheet) { return sheet.getSheetId() === sheetId; })[0] || null;
}

function segmentRememberRelation_(context, storage, database, sourceId, segmentId, operationId) {
  if (typeof registryProjectId_ === 'function') {
    segmentFolder_(context, segmentSourceFolder_(context), segmentId);
    var project = registrySegmentProject_(context, segmentId);
    if (project !== registryProjectId_()) fail_('OUTSIDE_PROJECT', 'Выбранный сегмент не закреплён за текущим проектом.');
    sourceBaseAddProject_(context, storage, sourceId, project, 'segment:' + segmentId + ':' + operationId);
  }
  if (database.relations.some(function (relation) { return relation.fileId === sourceId && relation.segmentId === segmentId; })) return;
  var row = storage.relationsSheet.getLastRow() + 1;
  var record = { fileId: sourceId, segmentId: segmentId, createdAt: new Date().toISOString(), createdBy: context.email, row: row };
  // Team email can start with a formula marker; use the same literal-safe
  // metadata writer as source records rather than exposing it to evaluation.
  try {
    if (row > REGISTRY_CONFIG.maxSourceBaseRows + 1) fail_('STORAGE_LIMIT', 'Журнал связей баз и сегментов превышает лимит.');
    var capacity = storage.relationsSheet.getMaxRows();
    if (row > capacity) storage.relationsSheet.insertRowsAfter(capacity, row - capacity);
    var values = SOURCE_BASES_SCHEMA.relationsHeaders.map(function (key) {
      var value = record[key];
      return typeof value === 'string' && sourceBaseNeedsLiteral_(value) ? "'" + value : value;
    });
    storage.relationsSheet.getRange(row, 1, 1, values.length).setValues([values]);
    SOURCE_BASES_SCHEMA.relationsHeaders.forEach(function (key, index) {
      if (typeof record[key] === 'string' && sourceBaseNeedsLiteral_(record[key])) storage.relationsSheet.getRange(row, index + 1).setRichTextValue(SpreadsheetApp.newRichTextValue().setText(record[key]).build());
    });
  } finally { SpreadsheetApp.flush(); }
  database.relations.push({ fileId: sourceId, segmentId: segmentId });
}
