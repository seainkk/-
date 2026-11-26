/** Preview-first, copy-only preparation. Drafts stay outside the visible catalog. */
var PREPARED_IMPORT = Object.freeze({
  version: 1, leaseMillis: 10 * 60 * 1000, releaseGuardMillis: 60 * 1000, ttlMillis: 24 * 60 * 60 * 1000,
  maxDrafts: 60, writeRows: 3000, freezeCells: 150,
  folderProperty: 'PREPARED_STAGING_FOLDER_ID', indexProperty: 'PREPARED_DRAFT_INDEX',
  fields: 'id,name,mimeType,parents,trashed,appProperties,modifiedTime,version,capabilities(canCopy,canEdit,canAddChildren)'
});

function stagePreparedUpload_(form) {
  return api_(function () {
    var context = authorize_(), input = importInput_(form, ['name', 'section', 'routeMode', 'status', 'requestId', 'file', 'flow']);
    if (input.flow !== undefined && input.flow !== 'prepared') fail_('INVALID_REQUEST', 'Неизвестный способ подготовки.');
    var common = preparedCommon_(input), blob = input.file;
    if (!blob || typeof blob.getBytes !== 'function' || typeof blob.getName !== 'function' || typeof blob.setContentType !== 'function') fail_('INVALID_UPLOAD', 'Выберите файл базы.');
    var extension = String(blob.getName()).match(/\.([a-zA-Z0-9]+)$/);
    extension = extension ? extension[1].toLowerCase() : '';
    var mime = SOURCE_IMPORT_CONFIG.uploadTypes[extension];
    if (!mime) fail_('INVALID_UPLOAD', 'Поддерживаются CSV, TSV, XLS, XLSX и ODS.');
    importUploadMime_(blob, extension);
    var bytes = blob.getBytes();
    if (!bytes || !bytes.length || bytes.length > REGISTRY_CONFIG.importMaxBytes) fail_('UPLOAD_LIMIT', 'Нужен непустой файл размером до 10 МиБ.');
    common.kind = 'upload';
    var hash = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)).replace(/=+$/, '');
    common.sourceFingerprint = hash + '|' + mime;
    common.origin = { id: 'upload:' + hash, name: String(blob.getName()).slice(0, 512) };
    preparedSweepExpired_(context);
    var draft = preparedAllocate_(context, common);
    return preparedWithLease_(draft.draftId, function (current, fresh) {
      if (current.state === 'complete') fail_('ALREADY_PREPARED', 'Эта база уже создана: ' + spreadsheetUrl_(current.outputId));
      if (!current.stageFileId) {
        var recovered = preparedFindArtifact_(fresh, current, 'input');
        if (recovered) current.stageFileId = recovered.id;
        else {
          if (current.stageAttempted) fail_('CREATION_UNCERTAIN', 'Google ещё не подтвердил загрузку черновика. Повторите тот же запрос позднее.');
          current.stageAttempted = true; preparedSave_(fresh, current);
          blob.setContentType(mime);
          try {
            var file = Drive.Files.create({ name: current.name, mimeType: REGISTRY_CONFIG.spreadsheetMime, parents: [current.folderId], appProperties: preparedTags_(current, 'input') }, blob, { fields: PREPARED_IMPORT.fields, supportsAllDrives: true });
            current.stageFileId = id_(file.id);
          } catch (error) {
            var found = preparedFindArtifact_(fresh, current, 'input');
            if (!found) fail_('CREATION_UNCERTAIN', 'Google не подтвердил загрузку черновика. Повторите тот же запрос.');
            current.stageFileId = found.id;
          }
        }
        preparedSave_(fresh, current);
      }
      return preparedStageResponse_(fresh, current);
    });
  });
}

/** Clipboard cells use literal Sheets stringValue, including phones beginning with +. */
function stagePreparedRows_(request) {
  return api_(function () {
    var context = authorize_(), input = importInput_(request, ['text', 'name', 'section', 'routeMode', 'status', 'requestId']);
    var common = preparedCommon_(input), rows = preparedPastedRows_(input.text);
    common.kind = 'paste';
    common.sourceFingerprint = digest_(JSON.stringify(rows));
    common.origin = { id: 'upload:' + common.sourceFingerprint, name: 'Вставленные строки' };
    preparedSweepExpired_(context);
    var draft = preparedAllocate_(context, common);
    return preparedWithLease_(draft.draftId, function (current, fresh) {
      if (current.state !== 'staged') fail_('PREVIEW_LOCKED', 'Подготовка уже начата. Откройте текущий предпросмотр.');
      if (!current.stageFileId) {
        var file = preparedFindArtifact_(fresh, current, 'input');
        if (!file) {
          if (current.stageAttempted) fail_('CREATION_UNCERTAIN', 'Google ещё не подтвердил создание черновика. Повторите тот же запрос.');
          current.stageAttempted = true; preparedSave_(fresh, current);
          try {
            file = Drive.Files.create({ name: current.name, mimeType: REGISTRY_CONFIG.spreadsheetMime, parents: [current.folderId], appProperties: preparedTags_(current, 'input') }, null, { fields: PREPARED_IMPORT.fields, supportsAllDrives: true });
          } catch (error) {
            file = preparedFindArtifact_(fresh, current, 'input');
            if (!file) fail_('CREATION_UNCERTAIN', 'Google не подтвердил создание черновика. Повторите тот же запрос.');
          }
        }
        current.stageFileId = id_(file.id); preparedSave_(fresh, current);
      }
      if (!current.rowsStaged) {
        var owned = preparedDraftFile_(fresh, current), sheets = SpreadsheetApp.openById(owned.id).getSheets();
        if (sheets.length !== 1) fail_('PREVIEW_CHANGED', 'Состав черновика изменился.');
        preparedWriteBlock_(sheets[0], 1, rows, rows[0].length);
        if (!current.routeMode) sheets[0].setName(current.section === 'lpr' ? 'ЛПР' : 'Компании');
        current.rowsStaged = true; preparedSave_(fresh, current);
      }
      return preparedStageResponse_(fresh, current);
    });
  });
}

function preparedPastedRows_(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 1000000 || /\u0000/.test(text)) fail_('INVALID_UPLOAD', 'Вставьте до миллиона символов вместе с заголовками.');
  var rows;
  try { rows = Utilities.parseCsv(text.replace(/(?:\r?\n)+$/, ''), '\t'); }
  catch (error) { fail_('INVALID_UPLOAD', 'Не удалось прочитать строки. Скопируйте прямоугольный диапазон из таблицы вместе с заголовками.'); }
  var width = rows.reduce(function (max, row) { return Math.max(max, row.length); }, 0);
  if (rows.length < 2 || !width || rows.length * width > 50000) fail_('INVALID_UPLOAD', 'Нужны заголовки и хотя бы одна строка данных. За раз можно вставить до 50 000 ячеек.');
  return rows.map(function (row) {
    if (row.some(function (cell) { return typeof cell !== 'string' || cell.length > 50000; })) fail_('INVALID_UPLOAD', 'В одной ячейке больше 50 000 символов.');
    return row.concat(Array(width - row.length).fill(''));
  });
}

function stagePreparedBaseLink_(request) {
  return api_(function () {
    var context = authorize_(), input = importInput_(request, ['url', 'name', 'section', 'routeMode', 'status', 'requestId']);
    var link = importSheetLink_(input.url), original = preparedOriginal_(context, link);
    var useOriginalName = input.routeMode === 'auto' && (input.name === undefined || input.name === '');
    if (useOriginalName) input.name = String(original.name || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 100);
    var common = preparedCommon_(input);
    if (useOriginalName) common.useOriginalName = true;
    common.origin = { id: link.id, name: String(original.name).slice(0, 512) };
    common.kind = 'link'; common.original = link;
    common.sourceFingerprint = link.id + '|' + link.resourceKey;
    preparedSweepExpired_(context);
    var draft = preparedAllocate_(context, common);
    return preparedWithLease_(draft.draftId, function (current, fresh) {
      if (current.state === 'complete') fail_('ALREADY_PREPARED', 'Эта база уже создана: ' + spreadsheetUrl_(current.outputId));
      preparedOriginal_(fresh, current.original);
      if (!current.stageFileId) {
        var found = preparedFindArtifact_(fresh, current, 'input');
        if (found) current.stageFileId = found.id;
        else {
          if (current.stageAttempted) fail_('CREATION_UNCERTAIN', 'Google ещё не подтвердил копирование черновика. Повторите тот же запрос позднее.');
          current.stageAttempted = true; preparedSave_(fresh, current);
          try {
            var copy = importCopyFile_(current.original, { name: current.name, parents: [current.folderId], appProperties: preparedTags_(current, 'input') });
            current.stageFileId = id_(copy.id);
          } catch (error) {
            var recovered = preparedFindArtifact_(fresh, current, 'input');
            if (!recovered) fail_('CREATION_UNCERTAIN', 'Google не подтвердил копирование черновика. Повторите тот же запрос.');
            current.stageFileId = recovered.id;
          }
        }
        preparedSave_(fresh, current);
      }
      return preparedStageResponse_(fresh, current);
    });
  });
}

function previewPreparedBase_(request) {
  return api_(function () {
    var input = importInput_(request, ['draftId', 'sheetId', 'sourceSheetIds', 'comparison']);
    return preparedWithLease_(input.draftId, function (draft, context) {
      if (draft.state !== 'staged') fail_('PREVIEW_LOCKED', 'Подготовка уже начата. Дождитесь результата или продолжите тот же запрос.');
      if (typeof preparedDataReadWorkbook_ === 'function') return preparedWorkbookPreview_(context, draft, preparedSheetId_(input.sheetId), input.sourceSheetIds, input.comparison);
      if (input.sourceSheetIds !== undefined) fail_('PREVIEW_UPDATE_REQUIRED', 'Для выбора исходных листов обновите приложение.');
      var sheetId = preparedSheetId_(input.sheetId), stable = preparedStableRead_(context, draft, sheetId), model = stable.model;
      var token = digest_(JSON.stringify([draft.draftId, sheetId, draft.name, draft.section, draft.status, model.fingerprint]));
      var response = { draftId: draft.draftId, sheetId: sheetId, previewToken: token, canConfirm: model.complete === true && model.canConfirm === true, counts: model.counts, sheets: model.previewSheets || [], warnings: model.warnings || [] };
      if (input.comparison !== undefined) {
        response.segmentDelta = preparedSegmentDelta_(context, model, input.comparison, draft);
        response.canConfirm = response.canConfirm && response.segmentDelta.available;
      }
      draft.sheetId = sheetId; draft.previewToken = token; draft.sourceFingerprint = model.fingerprint; draft.sourceVersion = stable.version;
      draft.canConfirm = response.canConfirm;
      if (response.canConfirm) {
        var plan = {
          version: 1, token: token, fingerprint: model.fingerprint, sheetId: sheetId,
          source: model.source, counts: model.counts, warnings: model.warnings || [],
          email: { headers: model.emailHeaders || model.email.headers, rows: model.emailRows || model.email.rows },
          phone: { headers: model.phoneHeaders || model.phone.headers, rows: model.phoneRows || model.phone.rows },
          formulas: (model.formulaSnapshots || []).map(preparedEncodeFormula_),
          sourceValueSignature: preparedFrozenSourceSignature_(model),
          copySignature: preparedCopySignature_(model.sourceValues || [], model.formulaSnapshots || [])
        };
        var text = JSON.stringify(plan), role = 'plan_' + token.slice(0, 30), artifact = preparedFindArtifact_(context, draft, role);
        if (!artifact) {
          try { artifact = Drive.Files.create({ name: '.prepared-' + draft.draftId + '.json', mimeType: 'application/json', parents: [draft.folderId], appProperties: preparedTags_(draft, role) }, Utilities.newBlob(text, 'application/json', 'plan.json'), { fields: PREPARED_IMPORT.fields, supportsAllDrives: true }); }
          catch (error) { artifact = preparedFindArtifact_(context, draft, role); if (!artifact) fail_('PREVIEW_STORAGE', 'Не удалось сохранить предпросмотр. Повторите расчёт.'); }
        }
        draft.planId = id_(artifact.id); draft.planHash = digest_(text); draft.planRole = role;
      } else { draft.planId = ''; draft.planHash = ''; draft.planRole = ''; }
      preparedSave_(context, draft);
      return response;
    });
  });
}

function preparedDestination_(value, draft) {
  if (value === undefined || value === null) return null;
  var route = importInput_(value, ['kind', 'segmentId', 'name', 'category']);
  var expectedKind = draft.routeMode === 'auto' ? 'auto' : draft.section;
  if (draft.status !== 'ready' || route.kind !== expectedKind || ['auto', 'companies', 'lpr'].indexOf(route.kind) < 0) fail_('INVALID_REQUEST', 'Назначение должно соответствовать типу готовой базы.');
  if (route.segmentId !== undefined) {
    if (typeof route.name !== 'string' || !route.name.trim()) fail_('INVALID_NAME', 'Укажите название выбранного сегмента.');
    return { segmentId: id_(route.segmentId), name: route.name.trim().slice(0, 200), kind: route.kind };
  }
  if (['clients', 'partners'].indexOf(route.category) < 0) fail_('INVALID_REQUEST', 'Выберите раздел нового сегмента.');
  return { name: itemName_(route.name), category: route.category, kind: route.kind };
}

function confirmPreparedBase_(request) {
  return api_(function () {
    var input = importInput_(request, ['draftId', 'sheetId', 'previewToken', 'requestId', 'destination']);
    preparedRequestId_(input.requestId);
    return preparedWithLease_(input.draftId, function (draft, context) {
      if (draft.confirmRequestId && draft.confirmRequestId !== input.requestId) fail_('REQUEST_REUSED', 'Продолжите подтверждение с прежним идентификатором запроса.');
      var destination = preparedDestination_(input.destination, draft);
      if (draft.confirmRequestId && JSON.stringify(destination) !== JSON.stringify(draft.destination || null)) fail_('REQUEST_REUSED', 'Этот запрос уже подтверждён с другим назначением.');
      if (draft.state === 'complete') { var complete = preparedCompleteResponse_(context, draft); if (draft.planVersion === 2) preparedWorkbookEnroll_(context, draft); preparedCleanupComplete_(context, draft); authorize_(); return complete; }
      if (preparedSheetId_(input.sheetId) !== draft.sheetId || typeof input.previewToken !== 'string' || input.previewToken !== draft.previewToken || !draft.canConfirm) fail_('PREVIEW_REQUIRED', 'Сначала получите полный предпросмотр выбранного листа.');
      preparedCheckSnapshot_(context, draft);
      if (!draft.confirmRequestId) {
        if (destination) {
          if (destination.segmentId) preparedCheckSegment_(context, destination.segmentId);
          draft.destination = destination;
        }
        draft.confirmRequestId = input.requestId; draft.state = 'processing'; draft.phase = 'create';
        preparedSave_(context, draft);
      }
      return preparedAdvance_(context, draft);
    });
  });
}

function continuePreparedBase_(request) {
  return api_(function () {
    var input = importInput_(request, ['draftId', 'requestId']); preparedRequestId_(input.requestId);
    return preparedWithLease_(input.draftId, function (draft, context) {
      if (!draft.confirmRequestId || draft.confirmRequestId !== input.requestId) fail_('PREVIEW_REQUIRED', 'Не найдено подтверждение этой подготовки.');
      if (draft.state === 'complete') { var complete = preparedCompleteResponse_(context, draft); if (draft.planVersion === 2) preparedWorkbookEnroll_(context, draft); preparedCleanupComplete_(context, draft); authorize_(); return complete; }
      if (draft.state !== 'processing') fail_('PREVIEW_REQUIRED', 'Сначала подтвердите предпросмотр.');
      preparedCheckSnapshot_(context, draft);
      return preparedAdvance_(context, draft);
    });
  });
}

function cancelPreparedBase_(request) {
  return api_(function () {
    var input = importInput_(request, ['draftId']);
    return preparedWithLease_(input.draftId, function (draft, context) {
      if (draft.state === 'complete') return { state: 'complete', file: { id: draft.outputId, name: draft.name, url: spreadsheetUrl_(draft.outputId) } };
      preparedFolder_(context, draft.folderId);
      var files = preparedListArtifacts_(draft.draftId);
      files.forEach(function (file) {
        if (!preparedOwn_(file, draft)) fail_('OUTSIDE_REGISTRY', 'Не удалось подтвердить принадлежность черновика.');
        if ((file.parents || []).indexOf(draft.folderId) === -1) {
          if (file.id === draft.outputId) fail_('CREATION_UNCERTAIN', 'Результат уже опубликован. Продолжите тот же запрос: ' + spreadsheetUrl_(file.id));
          fail_('OUTSIDE_REGISTRY', 'Черновик был перемещён. Автоматическое удаление остановлено.');
        }
      });
      files.forEach(function (file) {
        var fresh = authorize_(); preparedFolder_(fresh, draft.folderId);
        preparedProtectId_(fresh, file.id, draft);
        var latest = Drive.Files.get(file.id, { fields: PREPARED_IMPORT.fields, supportsAllDrives: true });
        if (!preparedOwn_(latest, draft) || (latest.parents || []).length !== 1 || latest.parents[0] !== draft.folderId) fail_('OUTSIDE_REGISTRY', 'Черновик был перемещён. Автоматическое удаление остановлено.');
        Drive.Files.update({ trashed: true }, file.id, null, { fields: 'id,trashed', supportsAllDrives: true });
      });
      draft.state = 'cancelled'; preparedSave_(context, draft); return { state: 'cancelled' };
    }, true);
  });
}

/** A reload can resume confirmed jobs without persisting credentials in a browser. */
function listPreparedJobs_(request) {
  return api_(function () {
    var input = object_(request);
    if (Object.keys(input).length) fail_('INVALID_REQUEST', 'Для списка подготовок параметры не нужны.');
    var context = authorize_(); registryRoot_(context);
    var index;
    try { index = JSON.parse(context.properties.getProperty(sourceImportProjectKey_(PREPARED_IMPORT.indexProperty)) || '[]'); } catch (error) { fail_('PREVIEW_STORAGE', 'Журнал подготовки требует проверки.'); }
    if (!Array.isArray(index) || index.length > PREPARED_IMPORT.maxDrafts) fail_('PREVIEW_STORAGE', 'Журнал подготовки требует проверки.');
    var items = [];
    index.forEach(function (id) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{24,64}$/.test(id)) fail_('PREVIEW_STORAGE', 'Журнал подготовки содержит некорректный идентификатор.');
      var text = context.properties.getProperty(preparedKey_(id)), draft;
      if (!text) return;
      try { draft = JSON.parse(text); } catch (error) { fail_('PREVIEW_STORAGE', 'Журнал черновика повреждён.'); }
      if (!draft || draft.version !== 1 || draft.draftId !== id) fail_('PREVIEW_STORAGE', 'Журнал черновика повреждён.');
      if (draft.rootId !== context.rootId || (draft.projectId || 'numshield') !== sourceImportProjectId_() || draft.state !== 'processing' || !Number.isFinite(Date.parse(draft.expiresAt)) || Date.parse(draft.expiresAt) <= Date.now()) return;
      if (typeof draft.confirmRequestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(draft.confirmRequestId) || !Number.isSafeInteger(draft.sheetId) || draft.sheetId < 0) fail_('PREVIEW_STORAGE', 'У подтверждённой подготовки отсутствуют параметры восстановления.');
      items.push({ draftId: draft.draftId, name: draft.name, section: draft.section, state: 'processing', sheetId: draft.sheetId, requestId: draft.confirmRequestId, expiresAt: draft.expiresAt, progress: { stage: draft.phase, label: 'Подготовка ещё не завершена. Можно продолжить с сохранённого этапа.' } });
      if (draft.destination) items[items.length - 1].destination = draft.destination;
    });
    return { items: items };
  });
}

function preparedCommon_(input) {
  var section = input.section;
  if (section !== 'companies' && section !== 'lpr') fail_('INVALID_CONTENTS', 'Выберите раздел «Компании» или «ЛПР».');
  if (SOURCE_BASES_SCHEMA.statuses.indexOf(input.status) === -1) fail_('INVALID_STATUS', 'Выберите статус базы.');
  preparedRequestId_(input.requestId);
  var common = { name: itemName_(input.name), section: section, status: input.status, requestId: input.requestId };
  if (input.routeMode !== undefined) {
    if (input.routeMode !== 'auto' || input.status !== 'ready') fail_('INVALID_REQUEST', 'Автоматическое распределение доступно для готовой базы.');
    common.routeMode = 'auto';
  }
  return common;
}

function preparedRequestId_(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) fail_('INVALID_REQUEST', 'Отсутствует идентификатор запроса подготовки.'); return value; }
function preparedDraftId_(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{24,64}$/.test(value)) fail_('INVALID_REQUEST', 'Неизвестный черновик подготовки.'); return value; }
function preparedSheetId_(value) { if (!Number.isSafeInteger(value) || value < 0) fail_('INVALID_REQUEST', 'Выберите лист исходной базы.'); return value; }
function preparedVersion_(file) { return file.version !== undefined ? String(file.version) : String(file.modifiedTime || ''); }
function preparedKey_(draftId) { return 'PREPARED_DRAFT_' + preparedDraftId_(draftId); }

function preparedAllocate_(context, common) {
  var draftId = digest_(sourceImportProjectKey_(context.rootId + '|' + context.email + '|prepared|' + common.kind + '|' + common.requestId)).slice(0, 36);
  var parameters = [context.rootId, common.kind, common.useOriginalName ? null : common.name, common.section, common.status, common.sourceFingerprint];
  if (common.routeMode) parameters.push(common.routeMode);
  var fingerprint = digest_(JSON.stringify(parameters));
  return locked_(function () {
    var current = authorize_();
    if (current.rootId !== context.rootId) fail_('SOURCE_CHANGED', 'Корневая папка изменилась. Повторите запрос.');
    var existing = preparedRead_(current, draftId, true);
    if (existing) { if (existing.fingerprint !== fingerprint) fail_('REQUEST_REUSED', 'Запрос подготовки уже использован с другими параметрами.'); return existing; }
    var folder = preparedEnsureFolder_(current), indexKey = sourceImportProjectKey_(PREPARED_IMPORT.indexProperty), index;
    try { index = JSON.parse(current.properties.getProperty(indexKey) || '[]'); } catch (error) { fail_('PREVIEW_STORAGE', 'Журнал подготовки требует проверки.'); }
    if (!Array.isArray(index)) fail_('PREVIEW_STORAGE', 'Журнал подготовки требует проверки.');
    while (index.length >= PREPARED_IMPORT.maxDrafts) {
      var position = -1;
      for (var i = 0; i < index.length; i++) { var old = preparedRead_(current, index[i], true); if (!old || ((old.projectId || 'numshield') === sourceImportProjectId_() && (old.state === 'complete' || old.state === 'cancelled'))) { position = i; break; } }
      if (position < 0) fail_('PREVIEW_BUSY', 'Слишком много незавершённых подготовок. Отмените или завершите прежние черновики.');
      current.properties.deleteProperty(preparedKey_(index.splice(position, 1)[0]));
    }
    var draft = { version: 1, draftId: draftId, rootId: current.rootId, folderId: folder.getId(), fingerprint: fingerprint, kind: common.kind, original: common.original || null, name: common.name, section: common.section, status: common.status, state: 'staged', phase: '', stageFileId: '', stageAttempted: false, outputId: '', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + PREPARED_IMPORT.ttlMillis).toISOString() };
    draft.projectId = sourceImportProjectId_();
    if (common.routeMode) draft.routeMode = common.routeMode;
    if (common.origin) draft.origin = common.origin;
    // A pruned completed receipt must never create a second result.
    var earlier = preparedFindArtifact_(current, draft, 'output');
    if (earlier) fail_('ALREADY_PREPARED', 'Результат этого запроса уже существует: ' + spreadsheetUrl_(earlier.id));
    preparedSave_(current, draft); index.push(draftId); current.properties.setProperty(indexKey, JSON.stringify(index));
    return draft;
  });
}

function preparedRead_(context, draftId, optional) {
  var text = context.properties.getProperty(preparedKey_(draftId));
  if (!text) { if (optional) return null; fail_('DRAFT_NOT_FOUND', 'Черновик не найден. Загрузите базу заново.'); }
  var draft;
  try { draft = JSON.parse(text); } catch (error) { fail_('PREVIEW_STORAGE', 'Журнал черновика повреждён.'); }
  if (!draft || draft.version !== 1 || draft.draftId !== draftId || draft.rootId !== context.rootId) fail_('OUTSIDE_REGISTRY', 'Черновик не относится к текущему реестру.');
  return draft;
}

function preparedSave_(context, draft, claimingLease) {
  if (draft.lease && !claimingLease) preparedAssertLease_(context, draft);
  var text = JSON.stringify(draft);
  if (text.length > 8000) fail_('PREVIEW_STORAGE', 'Слишком длинная запись подготовки.');
  context.properties.setProperty(preparedKey_(draft.draftId), text);
}

function preparedWithLease_(draftId, callback, allowExpired) {
  var claim = locked_(function () {
    var context = authorize_(), draft = preparedRead_(context, preparedDraftId_(draftId));
    if ((draft.projectId || 'numshield') !== sourceImportProjectId_()) fail_('OUTSIDE_PROJECT', 'Эта подготовка принадлежит другому проекту.');
    if (draft.state === 'cancelled') { if (allowExpired) return { context: context, draft: draft, cancelled: true }; fail_('DRAFT_CANCELLED', 'Черновик отменён.'); }
    if (!allowExpired && draft.state !== 'complete' && Date.parse(draft.expiresAt) <= Date.now()) fail_('DRAFT_EXPIRED', 'Срок предпросмотра истёк. Загрузите базу заново.');
    if (draft.leaseUntil > Date.now()) fail_('BUSY', 'Эта подготовка ещё выполняется. Повторите запрос через несколько секунд.');
    draft.lease = Utilities.getUuid(); draft.leaseUntil = Date.now() + PREPARED_IMPORT.leaseMillis; preparedSave_(context, draft, true);
    return { context: context, draft: draft, lease: draft.lease };
  });
  if (claim.cancelled) return { state: 'cancelled' };
  try { return callback(claim.draft, claim.context); }
  finally { preparedReleaseLease_(claim); }
}

/** Releasing a private receipt must not wait for unrelated grid saves or mask results. */
function preparedReleaseLease_(claim) {
  function clearOwnLease() {
    var latest = preparedRead_(claim.context, claim.draft.draftId, true);
    if (!latest || latest.lease !== claim.lease) return;
    delete latest.lease; delete latest.leaseUntil; preparedSave_(claim.context, latest);
  }
  try {
    var latest = preparedRead_(claim.context, claim.draft.draftId, true);
    if (!latest || latest.lease !== claim.lease) return;
    // All claimers refuse a live lease. The ten-minute lease exceeds an Apps
    // Script invocation; keep an additional minute before any unlocked release.
    // This updates only the owner's receipt and never the shared draft index.
    if (Number.isFinite(latest.leaseUntil) && latest.leaseUntil > Date.now() + PREPARED_IMPORT.releaseGuardMillis) {
      delete latest.lease; delete latest.leaseUntil; preparedSave_(claim.context, latest); return;
    }
    // Close to expiry, another invocation may claim the receipt. Re-read while
    // holding the global claim lock, or leave cleanup to the lease timeout.
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(100)) return;
    try { clearOwnLease(); } finally { lock.releaseLock(); }
  } catch (error) { console.warn('Preparation lease could not be safely released.'); }
}

function preparedEnsureFolder_(context) {
  var configured = context.properties.getProperty(PREPARED_IMPORT.folderProperty);
  if (configured) return preparedFolder_(context, configured);
  var query = "trashed = false and '" + context.rootId + "' in parents and appProperties has { key='registryPreparedRole' and value='folder' }";
  var found = Drive.Files.list({ q: query, fields: 'files(' + PREPARED_IMPORT.fields + '),nextPageToken', pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true });
  if (found.nextPageToken || (found.files || []).length > 1) fail_('PREVIEW_STORAGE', 'Найдено несколько папок подготовки. Нужна проверка.');
  var file = (found.files || [])[0];
  if (!file) {
    try { file = Drive.Files.create({ name: '_Подготовка баз', mimeType: 'application/vnd.google-apps.folder', parents: [context.rootId], appProperties: { registryPreparedRole: 'folder', registryPreparedRoot: context.rootId } }, null, { fields: PREPARED_IMPORT.fields, supportsAllDrives: true }); }
    catch (error) {
      found = Drive.Files.list({ q: query, fields: 'files(' + PREPARED_IMPORT.fields + '),nextPageToken', pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true });
      if (found.nextPageToken || (found.files || []).length !== 1) fail_('CREATION_UNCERTAIN', 'Не удалось подтвердить папку подготовки. Повторите запрос.');
      file = found.files[0];
    }
  }
  var folder = preparedFolder_(context, file.id); context.properties.setProperty(PREPARED_IMPORT.folderProperty, folder.getId()); return folder;
}

function preparedFolder_(context, folderId) {
  var current = authorize_();
  if (current.rootId !== context.rootId) fail_('SOURCE_CHANGED', 'Корневая папка изменилась.');
  var metadata = Drive.Files.get(id_(folderId), { fields: PREPARED_IMPORT.fields, supportsAllDrives: true });
  if (metadata.trashed || metadata.mimeType !== 'application/vnd.google-apps.folder' || (metadata.parents || []).length !== 1 || metadata.parents[0] !== current.rootId || !metadata.appProperties || metadata.appProperties.registryPreparedRole !== 'folder' || metadata.appProperties.registryPreparedRoot !== current.rootId) fail_('OUTSIDE_REGISTRY', 'Служебная папка подготовки недоступна.');
  var binding = sourceBasesSource_(current);
  var segmentsId = current.properties.getProperty('SEGMENTS_FOLDER_ID') || REGISTRY_CONFIG.defaultSegmentsFolderId;
  if (binding.state !== 'ready' || binding.source.id === current.rootId || binding.source.id === folderId || segmentsId === current.rootId || segmentsId === folderId) fail_('OUTSIDE_REGISTRY', 'Папка подготовки должна находиться отдельно от исходных баз и сегментов.');
  return registryFolder_(current, folderId);
}

function preparedOriginal_(context, link) {
  var current = authorize_(), binding = sourceBasesSource_(current);
  if (binding.state !== 'ready') fail_('SOURCE_UNAVAILABLE', 'Папка исходных баз недоступна.');
  var serviceId = current.properties.getProperty('SOURCE_BASES_STORAGE_ID') || REGISTRY_CONFIG.defaultSourceBasesStorageId;
  var centerId = current.properties.getProperty('CONTACT_CENTER_ID') || REGISTRY_CONFIG.defaultContactCenterId;
  if (link.id === serviceId || link.id === REGISTRY_CONFIG.defaultSourceBasesStorageId || link.id === centerId || link.id === REGISTRY_CONFIG.defaultContactCenterId) fail_('PROTECTED_FILE', 'Служебные таблицы нельзя использовать как исходник подготовки.');
  var original = importScopedOriginal_({ context: current, binding: binding, storage: { public: { id: serviceId } } }, link, 'copy');
  var stagingId = current.properties.getProperty(PREPARED_IMPORT.folderProperty), object = DriveApp.getFileById(original.id);
  if (stagingId && insideRegistry_(object, stagingId)) fail_('PROTECTED_FILE', 'Служебный черновик нельзя использовать как исходную базу.');
  if (original.appProperties && original.appProperties.registryPreparedRole) {
    if (!(original.appProperties.registryPreparedRole === 'output' && ['1', '2'].indexOf(original.appProperties.registryPreparedVersion) >= 0 && insideRegistry_(object, binding.source.id))) fail_('PROTECTED_FILE', 'Служебный черновик нельзя использовать как исходную базу.');
  }
  if (original.capabilities && original.capabilities.canCopy === false) fail_('COPY_ACCESS_REQUIRED', 'Владелец исходной таблицы запретил копирование.');
  return original;
}

function preparedTags_(draft, role) { return { registryPreparedRoot: draft.rootId, registryPreparedDraft: draft.draftId, registryPreparedFingerprint: draft.fingerprint, registryPreparedRole: role }; }
function preparedOwn_(file, draft) { var tags = file.appProperties || {}; return tags.registryPreparedRoot === draft.rootId && tags.registryPreparedDraft === draft.draftId && tags.registryPreparedFingerprint === draft.fingerprint && !file.trashed; }

function preparedListArtifacts_(draftId) {
  var response = Drive.Files.list({ q: "trashed = false and appProperties has { key='registryPreparedDraft' and value='" + preparedDraftId_(draftId) + "' }", fields: 'files(' + PREPARED_IMPORT.fields + '),nextPageToken', pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true });
  if (response.nextPageToken) fail_('PREVIEW_STORAGE', 'У черновика слишком много служебных объектов.');
  return response.files || [];
}

function preparedFindArtifact_(context, draft, role) {
  var files = preparedListArtifacts_(draft.draftId).filter(function (file) { return (file.appProperties || {}).registryPreparedRole === role; });
  if (files.length > 1) fail_('CREATION_UNCERTAIN', 'Найдено несколько результатов одной подготовки. Нужна проверка.');
  if (!files.length) return null;
  if (!preparedOwn_(files[0], draft) || !insideRegistry_(DriveApp.getFileById(files[0].id), context.rootId)) fail_('OUTSIDE_REGISTRY', 'Черновик был перемещён или изменён.');
  return files[0];
}

function preparedDraftFile_(context, draft) {
  var current = authorize_();
  preparedAssertLease_(current, draft);
  if (current.rootId !== draft.rootId || current.rootId !== context.rootId) fail_('SOURCE_CHANGED', 'Корневая папка изменилась.');
  preparedFolder_(current, draft.folderId);
  preparedProtectId_(current, draft.stageFileId, draft);
  if (draft.original) preparedOriginal_(current, draft.original);
  var file = Drive.Files.get(id_(draft.stageFileId), { fields: PREPARED_IMPORT.fields, supportsAllDrives: true });
  if (!preparedOwn_(file, draft) || file.mimeType !== REGISTRY_CONFIG.spreadsheetMime || (file.parents || []).length !== 1 || file.parents[0] !== draft.folderId || (file.appProperties || {}).registryPreparedRole !== 'input') fail_('OUTSIDE_REGISTRY', 'Исходный черновик перемещён или недоступен.');
  return file;
}

function preparedStageResponse_(context, draft) {
  var file = preparedDraftFile_(context, draft), book = SpreadsheetApp.openById(file.id);
  var options = typeof preparedDataReadWorkbook_ === 'function' ? preparedWorkbookSourceOptions_(context, draft, book) : {};
  var sheets = book.getSheets().filter(function (sheet) { var id = sheet.getSheetId(); return (!options.sourceSheetIds || options.sourceSheetIds.indexOf(id) >= 0) && (options.managedSheetIds || []).indexOf(id) < 0; }).map(function (sheet) { return { id: sheet.getSheetId(), name: sheet.getName(), rows: sheet.getLastRow(), columns: sheet.getLastColumn() }; });
  if (options.sheetRoutes) sheets.forEach(function (sheet) { sheet.section = options.sheetRoutes[sheet.id]; });
  if (!sheets.length) fail_('INVALID_SOURCE', 'В исходной книге нет листов.');
  var selection = typeof preparedWorkbookSelection_ === 'function' ? preparedWorkbookSelection_(book, options, draft.sourceSheetIds) : sheets.map(function (sheet) { return sheet.id; });
  var selectedSheetId = Number.isSafeInteger(draft.sheetId) && selection.indexOf(draft.sheetId) >= 0 ? draft.sheetId : selection[0];
  return { state: 'staged', draftId: draft.draftId, name: draft.name, section: draft.section, status: draft.status, sheets: sheets, sourceSheetIds: selection, selectedSheetId: selectedSheetId, expiresAt: draft.expiresAt };
}

function preparedSheet_(book, sheetId) { var sheets = book.getSheets().filter(function (sheet) { return sheet.getSheetId() === sheetId; }); if (sheets.length !== 1) fail_('INVALID_SOURCE', 'Выбранный лист больше недоступен.'); return sheets[0]; }

function preparedCheckSnapshot_(context, draft) {
  var file = preparedDraftFile_(context, draft), version = preparedVersion_(file);
  if (draft.sourceVersion && version && draft.sourceVersion === version) return;
  // Drive versions also change while an imported workbook finishes initial
  // calculation. A complete content fingerprint remains authoritative.
  var stable = draft.planVersion === 2 ? preparedWorkbookStableRead_(context, draft, file) : preparedStableRead_(context, draft, draft.sheetId, file), model = stable.model;
  var matching = model.fingerprint === draft.sourceFingerprint;
  // The V2 recognizer has a newer fingerprint envelope. A pending V1 receipt
  // still compares the exact old envelope of raw values, display, formulas and
  // links, so a harmless Drive version bump does not invalidate its snapshot.
  if (!matching && draft.planVersion !== 2) matching = preparedLegacyFingerprint_(draft, model) === draft.sourceFingerprint;
  if (!model.complete || !model.canConfirm || !matching) fail_('PREVIEW_CHANGED', 'Исходный лист изменился после предпросмотра. Пересчитайте результат.');
  draft.sourceVersion = stable.version; preparedSave_(context, draft);
}

function preparedStableRead_(context, draft, sheetId, initialFile) {
  var file = initialFile || preparedDraftFile_(context, draft), book = SpreadsheetApp.openById(file.id), sheet = preparedSheet_(book, sheetId);
  for (var attempt = 0; attempt < 2; attempt++) {
    var before = attempt ? preparedDraftFile_(context, draft) : file;
    var model = preparedDataRead_(sheet, draft.stageFileId, draft.section, { guard: function () { preparedDraftFile_(context, draft); } });
    var after = preparedDraftFile_(context, draft), beforeVersion = preparedVersion_(before), afterVersion = preparedVersion_(after);
    if (!beforeVersion || !afterVersion || beforeVersion === afterVersion) return { model: model, version: afterVersion };
    // Discard the changing pass. Only a second independently stable full read
    // can become the preview; continuous changes still fail closed.
  }
  fail_('PREVIEW_CHANGED', 'Черновик продолжает изменяться во время чтения. Пересчитайте предпросмотр.');
}

function preparedLegacyFingerprint_(draft, model) {
  if (!model.source || !Array.isArray(model.sourceValues) || !Array.isArray(model.sourceDisplayValues) || !Array.isArray(model.sourceFormulas) || !Array.isArray(model.sourceLinks)) return '';
  return digest_(JSON.stringify({ version: 1, sourceId: draft.stageFileId, section: draft.section, sheetId: model.source.sheetId, sheetName: model.source.name, rows: model.source.rowCount, columns: model.source.columnCount, values: model.sourceValues, display: model.sourceDisplayValues, formulas: model.sourceFormulas, links: model.sourceLinks }));
}

function preparedPlan_(context, draft) {
  preparedAssertLease_(authorize_(), draft);
  preparedFolder_(context, draft.folderId);
  preparedProtectId_(context, draft.planId, draft);
  var file = Drive.Files.get(id_(draft.planId), { fields: PREPARED_IMPORT.fields, supportsAllDrives: true });
  if (!preparedOwn_(file, draft) || (file.parents || []).length !== 1 || file.parents[0] !== draft.folderId || (file.appProperties || {}).registryPreparedRole !== draft.planRole || file.mimeType !== 'application/json') fail_('OUTSIDE_REGISTRY', 'План подготовки перемещён или недоступен.');
  var text = DriveApp.getFileById(file.id).getBlob().getDataAsString('UTF-8');
  if (digest_(text) !== draft.planHash) fail_('PREVIEW_CHANGED', 'Сохранённый предпросмотр изменён. Подготовка остановлена.');
  var plan;
  try { plan = JSON.parse(text); } catch (error) { fail_('PREVIEW_STORAGE', 'Не удалось прочитать план подготовки.'); }
  if ([1, 2].indexOf(plan.version) === -1 || plan.token !== draft.previewToken || plan.sheetId !== draft.sheetId || plan.fingerprint !== draft.sourceFingerprint || !plan.email || !Array.isArray(plan.email.rows) || !plan.phone || !Array.isArray(plan.phone.rows)) fail_('PREVIEW_CHANGED', 'План не соответствует подтверждённому предпросмотру.');
  if (plan.version === 2) preparedWorkbookValidatePlan_(plan);
  return plan;
}

function preparedOutput_(context, draft, allowPublished) {
  preparedAssertLease_(authorize_(), draft);
  preparedProtectId_(authorize_(), draft.outputId, draft);
  var file = Drive.Files.get(id_(draft.outputId), { fields: PREPARED_IMPORT.fields, supportsAllDrives: true });
  var binding = sourceBasesSource_(authorize_());
  var allowedParent = (file.parents || []).length === 1 && (file.parents[0] === draft.folderId || (allowPublished && binding.state === 'ready' && file.parents[0] === binding.source.id));
  if (!preparedOwn_(file, draft) || file.mimeType !== REGISTRY_CONFIG.spreadsheetMime || !allowedParent || !insideRegistry_(DriveApp.getFileById(file.id), context.rootId)) fail_('OUTSIDE_REGISTRY', 'Результат подготовки перемещён или недоступен.');
  return file;
}

function preparedAdvance_(context, draft) {
  var plan = preparedPlan_(context, draft);
  if (plan.version === 2) return preparedWorkbookAdvance_(context, draft, plan);
  if (draft.phase === 'create') {
    if (!draft.outputId) {
      var artifact = preparedFindArtifact_(context, draft, 'output');
      if (artifact) draft.outputId = artifact.id;
      else {
        if (draft.outputAttempted) fail_('CREATION_UNCERTAIN', 'Google ещё не подтвердил создание результата. Повторите тот же запрос позднее.');
        draft.outputAttempted = true; preparedSave_(context, draft);
        try { artifact = Drive.Files.create({ name: draft.name, mimeType: REGISTRY_CONFIG.spreadsheetMime, parents: [draft.folderId], appProperties: preparedTags_(draft, 'output') }, null, { fields: PREPARED_IMPORT.fields, supportsAllDrives: true }); }
        catch (error) { artifact = preparedFindArtifact_(context, draft, 'output'); if (!artifact) fail_('CREATION_UNCERTAIN', 'Google не подтвердил создание результата. Продолжите тот же запрос.'); }
        draft.outputId = id_(artifact.id);
      }
      preparedSave_(context, draft);
    }
    preparedOutput_(context, draft, false);
    var output = SpreadsheetApp.openById(draft.outputId);
    draft.initialSheetIds = output.getSheets().map(function (sheet) { return sheet.getSheetId(); });
    draft.phase = 'copy'; preparedSave_(context, draft);
    return preparedProcessing_(draft, plan);
  }
  var metadata = preparedOutput_(context, draft, draft.phase === 'publish');
  var book = SpreadsheetApp.openById(draft.outputId);
  if (draft.phase === 'copy') {
    var original;
    if (draft.originalSheetId !== undefined) original = preparedSheet_(book, draft.originalSheetId);
    else {
      var candidates = book.getSheets().filter(function (sheet) { return (draft.initialSheetIds || []).indexOf(sheet.getSheetId()) === -1; });
      if (candidates.length > 1) fail_('CREATION_UNCERTAIN', 'В результате несколько неподтверждённых копий исходного листа.');
      if (candidates.length === 1) {
        if (!preparedCopyMatches_(candidates[0], plan)) fail_('PREVIEW_CHANGED', 'Неподтверждённая копия исходного листа изменилась.');
        original = candidates[0];
      } else {
        if (draft.copyAttempted) fail_('CREATION_UNCERTAIN', 'Google ещё не подтвердил копирование исходного листа. Продолжите тот же запрос позднее.');
        draft.copyAttempted = true; preparedSave_(context, draft);
        var input = preparedSheet_(SpreadsheetApp.openById(draft.stageFileId), draft.sheetId);
        preparedDraftFile_(context, draft);
        try { original = input.copyTo(book); }
        catch (error) {
          candidates = book.getSheets().filter(function (sheet) { return (draft.initialSheetIds || []).indexOf(sheet.getSheetId()) === -1; });
          if (candidates.length !== 1 || !preparedCopyMatches_(candidates[0], plan)) fail_('CREATION_UNCERTAIN', 'Google не подтвердил копирование исходного листа. Продолжите тот же запрос.');
          original = candidates[0];
        }
      }
      draft.originalSheetId = original.getSheetId(); preparedSave_(context, draft);
    }
    original.setName('Исходная база');
    var sourceBook = SpreadsheetApp.openById(draft.stageFileId);
    if (typeof book.setSpreadsheetTimeZone === 'function' && typeof sourceBook.getSpreadsheetTimeZone === 'function') book.setSpreadsheetTimeZone(sourceBook.getSpreadsheetTimeZone());
    if (typeof book.setSpreadsheetLocale === 'function' && typeof sourceBook.getSpreadsheetLocale === 'function') book.setSpreadsheetLocale(sourceBook.getSpreadsheetLocale());
    draft.freezeCursor = draft.freezeCursor || 0; draft.phase = 'freeze'; preparedSave_(context, draft);
    return preparedProcessing_(draft, plan);
  }
  var originalSheet = preparedSheet_(book, draft.originalSheetId);
  if (originalSheet.getName() !== 'Исходная база') fail_('PREVIEW_CHANGED', 'Название исходного листа результата изменено во время подготовки.');
  if (draft.phase === 'freeze') {
    var end = Math.min(plan.formulas.length, draft.freezeCursor + PREPARED_IMPORT.freezeCells);
    preparedFreezeFormulaBlock_(context, book, draft, originalSheet, plan.formulas, draft.freezeCursor, end);
    SpreadsheetApp.flush(); draft.freezeCursor = end;
    if (end >= plan.formulas.length) {
      preparedEnsureSheets_(book, draft, plan); draft.phase = 'emails'; draft.writeCursor = 0;
    }
    preparedSave_(context, draft); return preparedProcessing_(draft, plan);
  }
  if (draft.phase === 'emails' || draft.phase === 'phones') {
    var kind = draft.phase === 'emails' ? 'email' : 'phone', title = kind === 'email' ? 'Email' : 'Телефоны';
    var sheet = preparedSheet_(book, draft[kind + 'SheetId']);
    if (sheet.getName() !== title) fail_('PREVIEW_CHANGED', 'Рабочий лист переименован до завершения подготовки.');
    var rows = plan[kind].rows, cursor = draft.writeCursor || 0, limit = Math.min(rows.length, cursor + PREPARED_IMPORT.writeRows);
    if (limit > cursor) { preparedOutput_(context, draft, false); preparedWriteBlock_(sheet, cursor + 2, rows.slice(cursor, limit), plan[kind].headers.length); SpreadsheetApp.flush(); }
    draft.writeCursor = limit;
    if (limit >= rows.length) { draft.phase = kind === 'email' ? 'phones' : 'publish'; draft.writeCursor = 0; }
    preparedSave_(context, draft); return preparedProcessing_(draft, plan);
  }
  if (draft.phase === 'publish') {
    if ((metadata.parents || []).indexOf(draft.folderId) !== -1) preparedVerifyResult_(context, book, draft, plan);
    else if (!draft.publishAttempted) fail_('OUTSIDE_REGISTRY', 'Черновик результата был перемещён до публикации.');
    var complete = preparedPublish_(context, draft, plan, metadata);
    preparedCleanupComplete_(context, draft); authorize_(); return complete;
  }
  fail_('PREVIEW_STORAGE', 'Неизвестный этап подготовки.');
}

function preparedEnsureSheets_(book, draft, plan) {
  ['email', 'phone'].forEach(function (kind) {
    var name = kind === 'email' ? 'Email' : 'Телефоны', sheet;
    if (draft[kind + 'SheetId'] !== undefined) sheet = preparedSheet_(book, draft[kind + 'SheetId']);
    else {
      sheet = book.getSheetByName(name);
      if (!sheet && kind === 'email') {
        var initial = book.getSheets().filter(function (candidate) { return candidate.getSheetId() !== draft.originalSheetId && (draft.initialSheetIds || []).indexOf(candidate.getSheetId()) !== -1; });
        if (initial.length === 1 && initial[0].getLastRow() === 0) sheet = initial[0].setName(name);
      }
      if (!sheet) sheet = book.insertSheet(name);
      draft[kind + 'SheetId'] = sheet.getSheetId();
    }
    var headers = plan[kind].headers;
    preparedWriteBlock_(sheet, 1, [headers], headers.length);
    var statusColumn = headers.indexOf(CONTACT_MAILING_STATUS.header);
    if (statusColumn >= 0 && sheet.getMaxRows() > 1) contactMailingStatusDropdown_(sheet.getRange(2, statusColumn + 1, sheet.getMaxRows() - 1, 1), false);
    sheet.setFrozenRows(1);
  });
  if (book.getSheets().length !== 3) fail_('PREVIEW_CHANGED', 'В результате появились дополнительные листы. Автоматическая подготовка остановлена.');
  [draft.originalSheetId, draft.emailSheetId, draft.phoneSheetId].forEach(function (id, index) { book.setActiveSheet(preparedSheet_(book, id)); book.moveActiveSheet(index + 1); });
  book.setActiveSheet(preparedSheet_(book, draft.originalSheetId));
}

function preparedWriteBlock_(sheet, firstRow, rows, width, firstColumn) {
  if (!rows.length) return;
  firstColumn = firstColumn || 1;
  var maximumRows = typeof sheet.getMaxRows === 'function' ? sheet.getMaxRows() : firstRow + rows.length;
  if (firstRow + rows.length - 1 > maximumRows) sheet.insertRowsAfter(maximumRows, firstRow + rows.length - 1 - maximumRows);
  var maximumColumns = typeof sheet.getMaxColumns === 'function' ? sheet.getMaxColumns() : width;
  if (firstColumn + width - 1 > maximumColumns) sheet.insertColumnsAfter(maximumColumns, firstColumn + width - 1 - maximumColumns);
  var range = sheet.getRange(firstRow, firstColumn, rows.length, width), existing = range.getDisplayValues(), formulas = range.getFormulas();
  rows.forEach(function (row, i) {
    if (!Array.isArray(row) || row.length !== width) fail_('PREVIEW_STORAGE', 'План содержит некорректные строки.');
    row.forEach(function (value, j) { var old = String(existing[i][j] || ''); if (formulas[i][j] || (old !== '' && old !== String(value === null || value === undefined ? '' : value))) fail_('PREVIEW_CHANGED', 'Результат изменён вручную до завершения подготовки.'); });
  });
  // Native Apps Script RichText can turn a leading + into a literal =+.
  // Explicit Sheets API stringValue keeps every character without evaluating it.
  var text = rows.map(function (row) { return row.map(function (value) { return String(value === null || value === undefined ? '' : value); }); });
  sheetWriteRawStrings_(sheet.getParent().getId(), sheet.getSheetId(), firstRow, firstColumn, text);
}

function preparedVerifyResult_(context, book, draft, plan) {
  var sheets = book.getSheets(), names = sheets.map(function (sheet) { return sheet.getName(); }).sort();
  if (sheets.length !== 3 || JSON.stringify(names) !== JSON.stringify(['Email', 'Исходная база', 'Телефоны'].sort())) fail_('PREVIEW_CHANGED', 'Результат должен содержать ровно три рабочих листа.');
  if (JSON.stringify(book.getSheets().map(function (sheet) { return sheet.getName(); })) !== JSON.stringify(['Исходная база', 'Email', 'Телефоны'])) fail_('PREVIEW_CHANGED', 'Порядок рабочих листов изменён до завершения подготовки.');
  var original = preparedSheet_(book, draft.originalSheetId);
  if (original.getLastRow() !== plan.source.rowCount || original.getLastColumn() !== plan.source.columnCount) fail_('PREVIEW_CHANGED', 'Размер исходного листа результата изменён.');
  preparedOutput_(context, draft, false);
  var sourceRange = original.getRange(1, 1, plan.source.rowCount, plan.source.columnCount);
  if (digest_(JSON.stringify(sourceRange.getValues())) !== plan.sourceValueSignature || sourceRange.getFormulas().some(function (row) { return row.some(Boolean); })) fail_('PREVIEW_CHANGED', 'Исходный лист результата отличается от подтверждённого снимка.');
  ['email', 'phone'].forEach(function (kind) {
    var sheet = preparedSheet_(book, draft[kind + 'SheetId']), headers = plan[kind].headers;
    if (sheet.getLastRow() !== plan[kind].rows.length + 1 || sheet.getLastColumn() !== headers.length) fail_('PREVIEW_CHANGED', 'Количество строк результата изменилось. Подготовка остановлена.');
    var head = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
    if (headers.some(function (label, index) { return head[index] !== String(label); })) fail_('PREVIEW_CHANGED', 'Заголовки результата изменились.');
    for (var start = 0; start < plan[kind].rows.length; start += PREPARED_IMPORT.writeRows) {
      preparedOutput_(context, draft, false);
      var expected = plan[kind].rows.slice(start, start + PREPARED_IMPORT.writeRows), range = sheet.getRange(start + 2, 1, expected.length, headers.length);
      var actual = range.getDisplayValues(), expressions = range.getFormulas();
      if (expressions.some(function (row) { return row.some(Boolean); }) || expected.some(function (row, index) { return row.some(function (value, column) { return String(value === null || value === undefined ? '' : value) !== actual[index][column]; }); })) fail_('PREVIEW_CHANGED', 'Контакты результата изменены до завершения подготовки.');
    }
  });
}

function preparedCheckSegment_(context, segmentId) {
  segmentFolder_(context, segmentSourceFolder_(context), segmentId);
  if (typeof registryProjectId_ === 'function' && registrySegmentProject_(context, segmentId) !== registryProjectId_()) fail_('OUTSIDE_PROJECT', 'Выбранный сегмент не закреплён за текущим проектом.');
}

function preparedPublish_(context, draft, plan, metadata) {
  return locked_(function () {
    var preparation = importPrepare_(), current = preparation.context;
    if (current.rootId !== draft.rootId) fail_('SOURCE_CHANGED', 'Корневая папка изменилась.');
    if ((draft.projectId || 'numshield') !== sourceImportProjectId_()) fail_('OUTSIDE_PROJECT', 'Эта подготовка принадлежит другому проекту.');
    if (draft.destination && draft.destination.segmentId) preparedCheckSegment_(current, draft.destination.segmentId);
    var file = preparedOutput_(current, draft, true), record = preparation.database.records[file.id];
    if (!record && preparation.database.lastRow >= REGISTRY_CONFIG.maxSourceBaseRows + 1) fail_('STORAGE_LIMIT', 'В реестре нет места для новой базы.');
    var origins = sourceBaseReadOrigins_(preparation.storage);
    if (draft.origin && !origins) fail_('STORAGE_SCHEMA', 'Журнал источников недоступен. Проверьте вкладку SourceBaseOrigins.');
    if ((file.parents || []).indexOf(preparation.binding.source.id) === -1) {
      importDestinationWritable_(preparation);
      draft.publishAttempted = true; preparedSave_(current, draft);
      var tags = preparedTags_(draft, 'output'); tags.registryPreparedVersion = String(plan.version); tags.registryPreparedSourceSheetId = String(draft.sheetId); tags.registryPreparedOriginalSheetId = String(draft.originalSheetId); tags.registryPreparedSection = draft.section;
      if (plan.version === 2) { tags.registryContactEmailSheetId = String(draft.emailSheetId); tags.registryContactPhoneSheetId = String(draft.phoneSheetId); }
      if (draft.routeMode === 'auto') {
        Object.assign(tags, preparedRouteTags_(plan.sources, draft.copiedSheetIds));
        if (draft.mainTelegramHistory) tags.registryMainTelegramHistory = '1';
      }
      try { Drive.Files.update({ appProperties: tags }, file.id, null, { addParents: preparation.binding.source.id, removeParents: draft.folderId, fields: PREPARED_IMPORT.fields, supportsAllDrives: true }); }
      catch (error) { var recovered = preparedOutput_(current, draft, true); if ((recovered.parents || []).indexOf(preparation.binding.source.id) === -1) fail_('CREATION_UNCERTAIN', 'Google не подтвердил публикацию. Продолжите тот же запрос.'); }
    }
    file = preparedOutput_(current, draft, true);
    var descriptor = { id: file.id, name: file.name, fileName: file.name, mimeType: file.mimeType, format: 'Google Таблицы', url: spreadsheetUrl_(file.id) };
    var options;
    if (!draft.metadataCommitted && record && record.revision === 1 && record.baseType === 'general' && record.status === 'collection' && record.formatCheck === 'unchecked') options = { expectedRevision: 1 };
    var contents = draft.routeMode === 'auto' ? sourceBaseContents_(Array.from(new Set(plan.sources.map(function (source) { return source.source.section; })))) : [draft.section];
    registerImportedSourceBase_(current, preparation.storage, preparation.database, descriptor, contents, draft.status, options);
    if (draft.origin) {
      var selected = plan.sources || (plan.source ? [plan.source] : []);
      var names = selected.map(function (entry) { return (entry.source || entry).name; }).filter(Boolean);
      var criteria = names.length ? 'Выбранные листы: ' + names.join(', ') : '';
      if (criteria.length > 2000) criteria = 'Выбрано листов: ' + names.length;
      var origin = sourceBaseOrigin_(file.id, draft.origin.id, draft.origin.name, criteria);
      sourceBaseSaveOrigin_(preparation.storage, origins, file.id, origin);
    }
    if (draft.destination) sourceBaseAddProject_(current, preparation.storage, file.id, draft.projectId || 'numshield', 'prepare:' + draft.draftId);
    draft.metadataCommitted = true; draft.state = 'complete'; draft.phase = 'done'; preparedSave_(current, draft);
    return preparedCompleteResponse_(current, draft, preparation, origins);
  });
}

function preparedCompleteResponse_(context, draft, preparation, origins) {
  var file = preparedOutput_(context, draft, true), binding = sourceBasesSource_(authorize_());
  if ((file.parents || []).indexOf(binding.source.id) === -1) fail_('OUTSIDE_REGISTRY', 'Готовая база больше не находится в реестре.');
  var storage = preparation ? preparation.storage : sourceBasesStorage_(context), database = sourceBasesReadDatabase_(storage);
  var record = database.records[file.id], metadata = { id: file.id, name: file.name, fileName: file.name, mimeType: file.mimeType, format: 'Google Таблицы', url: spreadsheetUrl_(file.id) };
  if (!record) fail_('CREATION_UNCERTAIN', 'Файл создан, но его запись в реестре ещё не подтверждена. Продолжите тот же запрос.');
  var relations = database.relations.filter(function (relation) { return relation.fileId === file.id; });
  var result = { state: 'complete', draftId: draft.draftId, jobId: draft.draftId, file: { id: file.id, name: file.name, url: metadata.url }, item: sourceBaseItem_(metadata, record, sourceBasesAssociations_(relations, context), origins === undefined ? sourceBaseReadOrigins_(storage) : origins, sourceBaseReadProjects_(storage)) };
  if (draft.destination) result.destination = draft.destination;
  return result;
}

function preparedProcessing_(draft, plan) {
  var labels = { copy: 'Копируем исходный лист…', freeze: 'Сохраняем значения исходной базы…', emails: 'Записываем email…', phones: 'Записываем телефоны…', publish: 'Публикуем готовую базу…' };
  if (plan.version === 2) {
    labels.copy = 'Копируем исходные листы: ' + (draft.copyIndex || 0) + ' из ' + plan.sources.length + '…';
    labels.freeze = 'Сохраняем исходные листы: ' + (draft.freezeSourceIndex || 0) + ' из ' + plan.sources.length + '…';
    labels.phones = 'Записываем телефоны и Telegram…';
  }
  var completed = draft.phase === 'phones' ? (plan.email.rows.length + (draft.writeCursor || 0)) : draft.phase === 'emails' ? (draft.writeCursor || 0) : draft.phase === 'publish' ? plan.email.rows.length + plan.phone.rows.length : 0;
  return { state: 'processing', draftId: draft.draftId, jobId: draft.draftId, progress: { stage: draft.phase, completed: completed, total: plan.email.rows.length + plan.phone.rows.length, label: labels[draft.phase] || 'Готовим базу…' } };
}

function preparedFrozenSourceSignature_(model) {
  var values = (model.sourceValues || []).slice(), changedRows = new Set();
  (model.formulaSnapshots || []).forEach(function (cell) {
    if (!cell.literalPhoneText) return;
    var index = cell.row - 1;
    if (!changedRows.has(index)) { values[index] = values[index].slice(); changedRows.add(index); }
    values[index][cell.column - 1] = cell.literalPhoneText;
  });
  return digest_(JSON.stringify(values));
}

function preparedEncodeFormula_(cell) {
  if (cell.literalPhoneText) return {row: cell.row, column: cell.column, value: cell.literalPhoneText, link: ''};
  var value = cell.value;
  return { row: cell.row, column: cell.column, value: cell.valueType === 'date' ? { preparedDate: String(value) } : Object.prototype.toString.call(value) === '[object Date]' ? { preparedDate: value.toISOString() } : value, link: cell.link || '' };
}
function preparedDecodeValue_(value) { return value && typeof value === 'object' && typeof value.preparedDate === 'string' ? new Date(value.preparedDate) : value; }
function preparedCopySignature_(values, formulas) { var ignored = Object.create(null); formulas.forEach(function (cell) { ignored[cell.row + ':' + cell.column] = true; }); return digest_(JSON.stringify(values.map(function (row, r) { return row.map(function (value, c) { return ignored[(r + 1) + ':' + (c + 1)] ? { formula: true } : value; }); }))); }
function preparedCopyMatches_(sheet, plan) { var rows = plan.source.rowCount, columns = plan.source.columnCount; if (sheet.getLastRow() !== rows || sheet.getLastColumn() !== columns) return false; var values = rows && columns ? sheet.getRange(1, 1, rows, columns).getValues() : []; return preparedCopySignature_(values, plan.formulas || []) === plan.copySignature; }

function preparedProtectId_(context, fileId, draft) {
  var service = context.properties.getProperty('SOURCE_BASES_STORAGE_ID') || REGISTRY_CONFIG.defaultSourceBasesStorageId;
  var center = context.properties.getProperty('CONTACT_CENTER_ID') || REGISTRY_CONFIG.defaultContactCenterId;
  if (fileId === context.rootId || fileId === service || fileId === REGISTRY_CONFIG.defaultSourceBasesStorageId || fileId === center || fileId === REGISTRY_CONFIG.defaultContactCenterId || (draft.original && fileId === draft.original.id)) fail_('PROTECTED_FILE', 'Исходные и служебные файлы нельзя изменять как черновики.');
}

function preparedAssertLease_(context, draft) {
  if (!draft.lease) return;
  var current = preparedRead_(context, draft.draftId, true);
  if (!current || current.lease !== draft.lease || current.leaseUntil <= Date.now()) fail_('BUSY', 'Этап подготовки уже выполняется другим запросом. Повторите прежний запрос позднее.');
}

/** Durable completion precedes cleanup; failures here can never undo a result. */
function preparedCleanupComplete_(context, draft) {
  if (draft.state !== 'complete' || !draft.metadataCommitted || !draft.outputId) return;
  var started = Date.now();
  try {
    preparedOutput_(context, draft, true); preparedFolder_(context, draft.folderId);
    var files = preparedListArtifacts_(draft.draftId).filter(function (file) { var role = (file.appProperties || {}).registryPreparedRole; return file.id !== draft.outputId && (role === 'input' || /^plan_/.test(role || '')); });
    for (var i = 0; i < files.length && i < 5 && Date.now() - started < 5000; i++) {
      var current = authorize_(); preparedFolder_(current, draft.folderId); preparedProtectId_(current, files[i].id, draft);
      var latest = Drive.Files.get(files[i].id, { fields: PREPARED_IMPORT.fields, supportsAllDrives: true }), role = (latest.appProperties || {}).registryPreparedRole;
      if (!preparedOwn_(latest, draft) || (latest.parents || []).length !== 1 || latest.parents[0] !== draft.folderId || !(role === 'input' || /^plan_/.test(role || ''))) continue;
      Drive.Files.update({ trashed: true }, latest.id, null, { fields: 'id,trashed', supportsAllDrives: true });
    }
  } catch (error) { console.warn('Completed preparation scratch could not be safely cleaned.'); }
}

/** Bounded housekeeping of abandoned, never-confirmed scratch files only. */
function preparedSweepExpired_(context) {
  var text = context.properties.getProperty(sourceImportProjectKey_(PREPARED_IMPORT.indexProperty)), index;
  if (!text) return;
  try { index = JSON.parse(text); } catch (error) { fail_('PREVIEW_STORAGE', 'Журнал подготовки требует проверки.'); }
  if (!Array.isArray(index) || index.length > PREPARED_IMPORT.maxDrafts) fail_('PREVIEW_STORAGE', 'Журнал подготовки требует проверки.');
  var cleaned = 0;
  for (var i = 0; i < index.length && cleaned < 3; i++) {
    var draft;
    try { draft = preparedRead_(authorize_(), index[i], true); }
    catch (error) { if (error.registryCode === 'OUTSIDE_REGISTRY') continue; throw error; }
    if (!draft || (draft.projectId || 'numshield') !== sourceImportProjectId_() || draft.state !== 'staged' || draft.confirmRequestId || draft.outputId || draft.leaseUntil > Date.now() || !Number.isFinite(Date.parse(draft.expiresAt)) || Date.parse(draft.expiresAt) > Date.now()) continue;
    try { cancelPreparedBase_({ draftId: draft.draftId }); cleaned++; }
    catch (error) {
      if (error.registryCode === 'LINK_ACCESS_REQUIRED' || error.registryCode === 'LINK_SETUP_REQUIRED') throw error;
      // A moved or uncertain artifact is left intact, never removed by guess.
      console.warn('Expired preparation scratch could not be safely cleaned.');
    }
  }
}
