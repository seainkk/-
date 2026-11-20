/** Workbook preparation V2. V1 receipts keep their original selected-leaf path. */
function preparedWorkbookStableRead_(context, draft, initialFile) {
  var file = initialFile || preparedDraftFile_(context, draft);
  for (var attempt = 0; attempt < 2; attempt++) {
    var before = attempt ? preparedDraftFile_(context, draft) : file;
    var options = preparedWorkbookSourceOptions_(context, draft), book = SpreadsheetApp.openById(file.id);
    var allSourceSheets = preparedWorkbookSourceSheets_(book, options);
    options.sourceSheetIds = preparedWorkbookSelection_(book, options, draft.sourceSheetIds);
    // A whole historical workbook can need more time than a single changed
    // contact sheet. This server-only deadline remains below the execution
    // limit, and the recognizer still rejects every incomplete result.
    options.deadline = Date.now() + 120000;
    // This is a read transaction over one fixed, app-owned staging workbook.
    // Full Drive ancestry is checked before and after it, before any model can
    // escape into a preview or plan. During bounded reads, revoke a changed
    // access key, root or lease immediately without repeating the same remote
    // original/folder ancestry once for every sheet and API boundary.
    options.guard = function () { preparedWorkbookReadGuard_(context, draft); };
    var model = preparedDataReadWorkbook_(book, file.id, draft.section, options);
    model.allSourceSheets = allSourceSheets;
    // Historical checks, exclusions and mailing marks stay attached to their
    // canonical contacts before the immutable output plan is persisted.
    if (draft.historyReadVersion === 1 && model.complete === true && typeof legacyContactHistoryReadWorkbook_ === 'function') {
      // Unselected archives supply check/work history only. Their contacts and
      // records are never normalized into the selected output. Old managed
      // report tabs may also contain history when re-importing a prepared book.
      var history = legacyContactHistoryReadWorkbook_(book, file.id, draft.section, options.guard, model.models || [], { sourceSheetIds: book.getSheets().map(function (sheet) { return sheet.getSheetId(); }), deadline: options.deadline });
      if (!history || history.complete !== true || typeof history.fingerprint !== 'string') fail_('LEGACY_HISTORY_PARTIAL', 'Не удалось полностью прочитать историю контактов. Повторите предпросмотр.');
      if (typeof legacyContactHistoryEnrich_ === 'function') model = legacyContactHistoryEnrich_(model, history.history);
      model.fingerprint = digest_(JSON.stringify([3, model.fingerprint, history.fingerprint]));
      (history.warnings || []).forEach(function (warning) { if (model.warnings.indexOf(warning) < 0) model.warnings.push(warning); });
    } else if (typeof legacyContactHistoryEnrich_ === 'function') model = legacyContactHistoryEnrich_(model);
    var after = preparedDraftFile_(context, draft), beforeVersion = preparedVersion_(before), afterVersion = preparedVersion_(after);
    if (!beforeVersion || !afterVersion || beforeVersion === afterVersion) return { model: model, version: afterVersion };
  }
  fail_('PREVIEW_CHANGED', 'Черновик продолжает изменяться во время чтения. Пересчитайте предпросмотр.');
}

function preparedWorkbookReadGuard_(context, draft) {
  var current = authorize_();
  if (current.rootId !== context.rootId || current.rootId !== draft.rootId) fail_('SOURCE_CHANGED', 'Корневая папка изменилась.');
  preparedAssertLease_(current, draft);
}

function preparedWorkbookSourceOptions_(context, draft) {
  var options = {};
  // Re-importing a prepared book must not treat managed contact lists as new
  // originals. IDs, rather than user-visible names, identify these lists.
  if (draft.original) {
    var original = preparedOriginal_(context, draft.original), tags = original.appProperties || {};
    if (tags.registryPreparedVersion === '1' && /^\d+$/.test(tags.registryPreparedOriginalSheetId || '')) options.sourceSheetIds = [Number(tags.registryPreparedOriginalSheetId)];
    else options.managedSheetIds = [tags.registryContactEmailSheetId, tags.registryContactPhoneSheetId].filter(function (id) { return /^\d+$/.test(id || ''); }).map(Number);
  }
  return options;
}

/** Metadata for all permitted originals; managed contact targets are not selectable. */
function preparedWorkbookSourceSheets_(book, options) {
  return book.getSheets().filter(function (sheet) {
    var id = sheet.getSheetId(); return (!options.sourceSheetIds || options.sourceSheetIds.indexOf(id) >= 0) && (options.managedSheetIds || []).indexOf(id) < 0;
  }).map(function (sheet) { var id = sheet.getSheetId(); return { id: id, sheetId: id, name: sheet.getName(), rowCount: sheet.getLastRow(), columnCount: sheet.getLastColumn() }; });
}

/** Canonical book order makes a set's token independent of checkbox click order. */
function preparedWorkbookSelection_(book, options, requested) {
  var allowed = book.getSheets().map(function (sheet) { return sheet.getSheetId(); }).filter(function (id) { return (!options.sourceSheetIds || options.sourceSheetIds.indexOf(id) >= 0) && (options.managedSheetIds || []).indexOf(id) < 0; });
  if (!allowed.length) fail_('INVALID_SOURCE', 'В исходной книге нет доступных исходных листов.');
  if (requested === undefined) return allowed;
  if (!Array.isArray(requested) || !requested.length || requested.length > 100 || requested.some(function (id) { return !Number.isSafeInteger(id) || id < 0; }) || new Set(requested).size !== requested.length) fail_('INVALID_REQUEST', 'Выберите от одного до ста исходных листов без повторов.');
  if (requested.some(function (id) { return allowed.indexOf(id) < 0; })) fail_('INVALID_SOURCE', 'Выбранный лист не относится к доступным исходным листам этой базы.');
  return allowed.filter(function (id) { return requested.indexOf(id) >= 0; });
}

function preparedWorkbookPreview_(context, draft, sheetId, sourceSheetIds) {
  var file = preparedDraftFile_(context, draft), book = SpreadsheetApp.openById(file.id), options = preparedWorkbookSourceOptions_(context, draft);
  var selectedIds = preparedWorkbookSelection_(book, options, sourceSheetIds === undefined ? draft.sourceSheetIds : sourceSheetIds);
  if (selectedIds.indexOf(sheetId) < 0) fail_('INVALID_SOURCE', 'Лист предпросмотра должен входить в выбранные исходные листы.');
  if (sourceSheetIds !== undefined) draft.sourceSheetIds = selectedIds;
  // Only newly staged previews use the extended selected-source/history
  // envelope. Already confirmed V2 receipts keep their earlier fingerprints.
  draft.historyReadVersion = 1; draft.previewToken = ''; draft.canConfirm = false; draft.planId = ''; draft.planHash = ''; draft.planRole = '';
  preparedSave_(context, draft);
  var stable = preparedWorkbookStableRead_(context, draft), model = stable.model;
  var selected = (model.models || []).filter(function (leaf) { return leaf.source.sheetId === sheetId; })[0];
  if (!selected && model.complete === false) {
    var partial = (model.sourceSheets || []).filter(function (leaf) { return leaf.sheetId === sheetId; })[0];
    if (partial) selected = { source: { sheetId: sheetId, name: partial.name, headers: [], sample: [], rowCount: partial.rowCount } };
  }
  if (!selected) fail_('INVALID_SOURCE', 'Выбранный исходный лист больше недоступен.');
  var names = Object.create(null), sources = (model.models || []).map(function (leaf) {
    var title = model.models.length === 1 ? 'Исходная база' : leaf.source.name;
    title = preparedWorkbookUniqueName_(title, names);
    return { source: leaf.source, name: title, formulas: (leaf.formulaSnapshots || []).map(preparedEncodeFormula_), sourceValueSignature: digest_(JSON.stringify(leaf.sourceValues || [])), copySignature: preparedCopySignature_(leaf.sourceValues || [], leaf.formulaSnapshots || []) };
  });
  var emailName = preparedWorkbookUniqueName_('Email', names), phoneName = preparedWorkbookUniqueName_('Телефоны и Telegram', names);
  var token = digest_(JSON.stringify([2, draft.draftId, sheetId, draft.name, draft.section, draft.status, model.fingerprint]));
  var canConfirm = model.complete === true && model.canConfirm === true;
  var email = { name: emailName, headers: model.email.headers, rows: model.email.rows }, phone = { name: phoneName, headers: model.phone.headers, rows: model.phone.rows };
  var response = { draftId: draft.draftId, sheetId: sheetId, sourceSheetIds: selectedIds, allSourceSheets: model.allSourceSheets || [], previewToken: token, canConfirm: canConfirm, counts: model.counts, sourceSheets: model.sourceSheets || [], sourceSheetCount: (model.sourceSheets || []).length, warnings: model.warnings || [], sheets: [
    { name: (sources.filter(function (source) { return source.source.sheetId === sheetId; })[0] || {}).name || selected.source.name, headers: selected.source.headers || [], sample: selected.source.sample || [], rowCount: selected.source.rowCount },
    { name: emailName, headers: email.headers, sample: email.rows.slice(0, 8), rowCount: email.rows.length + 1 },
    { name: phoneName, headers: phone.headers, sample: phone.rows.slice(0, 8), rowCount: phone.rows.length + 1 }
  ] };
  draft.sheetId = sheetId; draft.planVersion = 2; draft.previewToken = token; draft.sourceFingerprint = model.fingerprint; draft.sourceVersion = stable.version; draft.canConfirm = canConfirm;
  if (canConfirm) {
    var plan = { version: 2, token: token, fingerprint: model.fingerprint, sheetId: sheetId, sources: sources, counts: model.counts, warnings: model.warnings || [], email: email, phone: phone };
    preparedWorkbookValidatePlan_(plan);
    var text = JSON.stringify(plan), role = 'plan_' + token.slice(0, 30), artifact = preparedFindArtifact_(context, draft, role);
    if (!artifact) {
      try { artifact = Drive.Files.create({ name: '.prepared-' + draft.draftId + '.json', mimeType: 'application/json', parents: [draft.folderId], appProperties: preparedTags_(draft, role) }, Utilities.newBlob(text, 'application/json', 'plan.json'), { fields: PREPARED_IMPORT.fields, supportsAllDrives: true }); }
      catch (error) { artifact = preparedFindArtifact_(context, draft, role); if (!artifact) fail_('PREVIEW_STORAGE', 'Не удалось сохранить предпросмотр. Повторите расчёт.'); }
    }
    draft.planId = id_(artifact.id); draft.planHash = digest_(text); draft.planRole = role;
  } else { draft.planId = ''; draft.planHash = ''; draft.planRole = ''; }
  preparedSave_(context, draft); return response;
}

function preparedWorkbookUniqueName_(name, used) {
  var base = String(name || 'Исходная база').slice(0, 100), candidate = base, suffix = 1;
  while (used[candidate.toLowerCase()]) { var ending = ' (' + (++suffix) + ')'; candidate = base.slice(0, 100 - ending.length) + ending; }
  used[candidate.toLowerCase()] = true; return candidate;
}

function preparedWorkbookValidatePlan_(plan) {
  var ids = [], names = Object.create(null);
  if (!Array.isArray(plan.sources) || !plan.sources.length || plan.sources.length > 100) fail_('PREVIEW_CHANGED', 'В плане отсутствует полный список исходных листов.');
  plan.sources.forEach(function (source) {
    if (!source || !source.source || !Number.isSafeInteger(source.source.sheetId) || source.source.sheetId < 0 || ids.indexOf(source.source.sheetId) >= 0 || !Array.isArray(source.formulas) || typeof source.sourceValueSignature !== 'string' || typeof source.copySignature !== 'string') fail_('PREVIEW_CHANGED', 'Список исходных листов повреждён.');
    if (!Number.isSafeInteger(source.source.rowCount) || !Number.isSafeInteger(source.source.columnCount) || source.source.rowCount < 0 || source.source.columnCount < 0) fail_('PREVIEW_CHANGED', 'Размер исходного листа повреждён.');
    ids.push(source.source.sheetId);
    preparedWorkbookCheckName_(source.name, names);
  });
  if (ids.indexOf(plan.sheetId) < 0) fail_('PREVIEW_CHANGED', 'Основной исходный лист отсутствует в плане.');
  ['email', 'phone'].forEach(function (kind) {
    if (!plan[kind] || !Array.isArray(plan[kind].headers) || !plan[kind].headers.length || !Array.isArray(plan[kind].rows)) fail_('PREVIEW_CHANGED', 'Список контактов повреждён.');
    preparedWorkbookCheckName_(plan[kind].name, names);
  });
}

function preparedWorkbookCheckName_(name, used) {
  if (typeof name !== 'string' || !name || name.length > 100 || /[\[\]:*?\/\\]/.test(name) || used[name.toLowerCase()]) fail_('PREVIEW_CHANGED', 'Имена листов плана повреждены.');
  used[name.toLowerCase()] = true;
}

function preparedWorkbookAdvance_(context, draft, plan) {
  if (draft.phase === 'create') {
    if (!draft.outputId) {
      var artifact = preparedFindArtifact_(context, draft, 'output');
      if (!artifact) {
        if (draft.outputAttempted) fail_('CREATION_UNCERTAIN', 'Google ещё не подтвердил создание результата. Повторите тот же запрос позднее.');
        draft.outputAttempted = true; preparedSave_(context, draft);
        try { artifact = Drive.Files.create({ name: draft.name, mimeType: REGISTRY_CONFIG.spreadsheetMime, parents: [draft.folderId], appProperties: preparedTags_(draft, 'output') }, null, { fields: PREPARED_IMPORT.fields, supportsAllDrives: true }); }
        catch (error) { artifact = preparedFindArtifact_(context, draft, 'output'); if (!artifact) fail_('CREATION_UNCERTAIN', 'Google не подтвердил создание результата. Продолжите тот же запрос.'); }
      }
      draft.outputId = id_(artifact.id); preparedSave_(context, draft);
    }
    preparedOutput_(context, draft, false);
    var freshBook = SpreadsheetApp.openById(draft.outputId), initial = freshBook.getSheets();
    if (initial.length !== 1 || initial[0].getLastRow() || initial[0].getLastColumn()) fail_('PREVIEW_CHANGED', 'Новая книга результата уже изменена.');
    draft.initialSheetIds = [initial[0].getSheetId()]; draft.copiedSheetIds = []; draft.copyIndex = 0;
    var occupied = Object.create(null); plan.sources.forEach(function (source) { occupied[source.name.toLowerCase()] = true; }); occupied[plan.email.name.toLowerCase()] = true; occupied[plan.phone.name.toLowerCase()] = true;
    initial[0].setName(preparedWorkbookUniqueName_('_Подготовка ' + draft.draftId.slice(0, 12), occupied));
    var inputBook = SpreadsheetApp.openById(draft.stageFileId);
    if (typeof freshBook.setSpreadsheetTimeZone === 'function' && typeof inputBook.getSpreadsheetTimeZone === 'function') freshBook.setSpreadsheetTimeZone(inputBook.getSpreadsheetTimeZone());
    if (typeof freshBook.setSpreadsheetLocale === 'function' && typeof inputBook.getSpreadsheetLocale === 'function') freshBook.setSpreadsheetLocale(inputBook.getSpreadsheetLocale());
    draft.phase = 'copy'; preparedSave_(context, draft); return preparedProcessing_(draft, plan);
  }
  var metadata = preparedOutput_(context, draft, draft.phase === 'publish'), book = SpreadsheetApp.openById(draft.outputId);
  if (draft.phase === 'copy') {
    var index = draft.copyIndex || 0, source = plan.sources[index], copied;
    if (!source) fail_('PREVIEW_STORAGE', 'Неверный этап копирования исходных листов.');
    if (draft.copiedSheetIds[index] !== undefined) copied = preparedSheet_(book, draft.copiedSheetIds[index]);
    else {
      var candidates = preparedWorkbookUnclaimed_(book, draft);
      if (candidates.length > 1) fail_('CREATION_UNCERTAIN', 'Найдено несколько неподтверждённых копий листов.');
      if (candidates.length === 1) {
        if (!preparedCopyMatches_(candidates[0], source)) fail_('PREVIEW_CHANGED', 'Неподтверждённая копия исходного листа изменилась.');
        copied = candidates[0];
      } else {
        if (draft.copyAttempted) fail_('CREATION_UNCERTAIN', 'Google ещё не подтвердил копирование исходного листа. Продолжите тот же запрос позднее.');
        draft.copyAttempted = true; preparedSave_(context, draft); preparedDraftFile_(context, draft);
        try { copied = preparedSheet_(SpreadsheetApp.openById(draft.stageFileId), source.source.sheetId).copyTo(book); }
        catch (error) {
          candidates = preparedWorkbookUnclaimed_(book, draft);
          if (candidates.length !== 1 || !preparedCopyMatches_(candidates[0], source)) fail_('CREATION_UNCERTAIN', 'Google не подтвердил копирование исходного листа. Продолжите тот же запрос.');
          copied = candidates[0];
        }
      }
      draft.copiedSheetIds[index] = copied.getSheetId(); preparedSave_(context, draft);
    }
    copied.setName(source.name);
    if (source.source.sheetId === plan.sheetId) draft.originalSheetId = copied.getSheetId();
    draft.copyIndex = index + 1; draft.copyAttempted = false;
    if (draft.copyIndex >= plan.sources.length) { draft.phase = 'freeze'; draft.freezeSourceIndex = 0; draft.freezeCursor = 0; }
    preparedSave_(context, draft); return preparedProcessing_(draft, plan);
  }
  if (draft.phase === 'freeze') {
    var sourceIndex = draft.freezeSourceIndex || 0, sourcePlan = plan.sources[sourceIndex], original = preparedSheet_(book, draft.copiedSheetIds[sourceIndex]);
    if (original.getName() !== sourcePlan.name) fail_('PREVIEW_CHANGED', 'Исходный лист результата переименован до завершения подготовки.');
    var end = Math.min(sourcePlan.formulas.length, (draft.freezeCursor || 0) + PREPARED_IMPORT.freezeCells);
    preparedFreezeFormulaBlock_(context, book, draft, original, sourcePlan.formulas, draft.freezeCursor || 0, end);
    SpreadsheetApp.flush(); draft.freezeCursor = end;
    if (end >= sourcePlan.formulas.length) { draft.freezeSourceIndex = sourceIndex + 1; draft.freezeCursor = 0; }
    if (draft.freezeSourceIndex >= plan.sources.length) { preparedWorkbookEnsureSheets_(book, draft, plan); draft.phase = 'emails'; draft.writeCursor = 0; }
    preparedSave_(context, draft); return preparedProcessing_(draft, plan);
  }
  if (draft.phase === 'emails' || draft.phase === 'phones') {
    var kind = draft.phase === 'emails' ? 'email' : 'phone', target = preparedSheet_(book, draft[kind + 'SheetId']);
    if (target.getName() !== plan[kind].name) fail_('PREVIEW_CHANGED', 'Лист контактов переименован до завершения подготовки.');
    var cursor = draft.writeCursor || 0, limit = Math.min(plan[kind].rows.length, cursor + PREPARED_IMPORT.writeRows);
    if (limit > cursor) { preparedOutput_(context, draft, false); preparedWriteBlock_(target, cursor + 2, plan[kind].rows.slice(cursor, limit), plan[kind].headers.length); SpreadsheetApp.flush(); }
    draft.writeCursor = limit;
    if (limit >= plan[kind].rows.length) { draft.phase = kind === 'email' ? 'phones' : 'publish'; draft.writeCursor = 0; }
    preparedSave_(context, draft); return preparedProcessing_(draft, plan);
  }
  if (draft.phase === 'publish') {
    if ((metadata.parents || []).indexOf(draft.folderId) >= 0) preparedWorkbookVerifyResult_(context, book, draft, plan);
    else if (!draft.publishAttempted) fail_('OUTSIDE_REGISTRY', 'Результат перемещён до публикации.');
    var complete = preparedPublish_(context, draft, plan, metadata);
    preparedWorkbookEnroll_(context, draft);
    preparedCleanupComplete_(context, draft); authorize_(); return complete;
  }
  fail_('PREVIEW_STORAGE', 'Неизвестный этап подготовки книги.');
}

/** A lost batch acknowledgement retries only snapshots that remain formulas. */
function preparedFreezeFormulaBlock_(context, book, draft, sheet, formulas, start, end) {
  var strings = [], typed = [];
  for (var index = start; index < end; index++) {
    var formula = formulas[index], cell = sheet.getRange(formula.row, formula.column), value = preparedDecodeValue_(formula.value), link = formula.link && /^(?:https?:\/\/|mailto:|tel:)/i.test(formula.link) ? formula.link : '';
    if (!cell.getFormula()) {
      if (JSON.stringify(cell.getValue()) !== JSON.stringify(value)) fail_('PREVIEW_CHANGED', 'Значение исходного листа изменено до завершения подготовки.');
      if (typeof value !== 'string' || !value) continue;
      var rich = typeof cell.getRichTextValue === 'function' ? cell.getRichTextValue() : null;
      if (rich && typeof rich.getLinkUrl === 'function' && (rich.getLinkUrl() || '') === link || !rich && !link) continue;
    }
    if (typeof value === 'string') strings.push({ row: formula.row, column: formula.column, value: value, link: link });
    else typed.push({ cell: cell, value: value });
  }
  if (!strings.length && !typed.length) return;
  preparedOutput_(context, draft, false);
  typed.forEach(function (entry) { entry.cell.setValue(entry.value); });
  if (strings.length) sheetWriteRawStringCells_(book.getId(), sheet.getSheetId(), strings, function () { preparedOutput_(context, draft, false); });
  else { SpreadsheetApp.flush(); preparedOutput_(context, draft, false); }
}

function preparedWorkbookUnclaimed_(book, draft) {
  return book.getSheets().filter(function (sheet) { var id = sheet.getSheetId(); return (draft.initialSheetIds || []).indexOf(id) < 0 && (draft.copiedSheetIds || []).indexOf(id) < 0; });
}

function preparedWorkbookEnsureSheets_(book, draft, plan) {
  ['email', 'phone'].forEach(function (kind) {
    var target;
    if (draft[kind + 'SheetId'] !== undefined) target = preparedSheet_(book, draft[kind + 'SheetId']);
    else {
      target = book.getSheetByName(plan[kind].name);
      if (target && draft.copiedSheetIds.indexOf(target.getSheetId()) >= 0) fail_('PREVIEW_CHANGED', 'Лист контактов совпал с исходным листом.');
      if (!target && kind === 'email') {
        target = preparedSheet_(book, draft.initialSheetIds[0]);
        if (target.getLastRow() || target.getLastColumn()) fail_('PREVIEW_CHANGED', 'Пустой лист результата изменён.');
        target.setName(plan[kind].name);
      }
      if (!target) target = book.insertSheet(plan[kind].name);
      draft[kind + 'SheetId'] = target.getSheetId();
    }
    if (target.getName() !== plan[kind].name) fail_('PREVIEW_CHANGED', 'Название листа контактов изменено.');
    preparedWriteBlock_(target, 1, [plan[kind].headers], plan[kind].headers.length); target.setFrozenRows(1);
  });
  var order = draft.copiedSheetIds.concat([draft.emailSheetId, draft.phoneSheetId]);
  if (book.getSheets().length !== order.length || new Set(order).size !== order.length) fail_('PREVIEW_CHANGED', 'В результате появились посторонние листы.');
  order.forEach(function (id, index) { book.setActiveSheet(preparedSheet_(book, id)); book.moveActiveSheet(index + 1); });
  book.setActiveSheet(preparedSheet_(book, draft.originalSheetId));
}

function preparedWorkbookVerifyResult_(context, book, draft, plan) {
  var order = draft.copiedSheetIds.concat([draft.emailSheetId, draft.phoneSheetId]);
  if (book.getSheets().length !== plan.sources.length + 2 || JSON.stringify(book.getSheets().map(function (sheet) { return sheet.getSheetId(); })) !== JSON.stringify(order)) fail_('PREVIEW_CHANGED', 'Количество или порядок листов результата изменён.');
  plan.sources.forEach(function (source, index) {
    preparedOutput_(context, draft, false);
    var original = preparedSheet_(book, draft.copiedSheetIds[index]), rows = source.source.rowCount, columns = source.source.columnCount;
    if (original.getName() !== source.name || original.getLastRow() !== rows || original.getLastColumn() !== columns) fail_('PREVIEW_CHANGED', 'Исходный лист результата отличается от снимка.');
    var range = rows && columns ? original.getRange(1, 1, rows, columns) : null;
    if (digest_(JSON.stringify(range ? range.getValues() : [])) !== source.sourceValueSignature || (range && range.getFormulas().some(function (row) { return row.some(Boolean); }))) fail_('PREVIEW_CHANGED', 'Исходный лист результата отличается от подтверждённого снимка.');
  });
  ['email', 'phone'].forEach(function (kind) {
    var sheet = preparedSheet_(book, draft[kind + 'SheetId']), expected = [plan[kind].headers].concat(plan[kind].rows), width = plan[kind].headers.length;
    if (sheet.getName() !== plan[kind].name || sheet.getLastRow() !== expected.length || sheet.getLastColumn() !== width) fail_('PREVIEW_CHANGED', 'Размер листа контактов изменён.');
    for (var cursor = 0; cursor < expected.length; cursor += PREPARED_IMPORT.writeRows) {
      preparedOutput_(context, draft, false);
      var block = expected.slice(cursor, cursor + PREPARED_IMPORT.writeRows), range = sheet.getRange(cursor + 1, 1, block.length, width), actual = range.getDisplayValues();
      if (range.getFormulas().some(function (row) { return row.some(Boolean); }) || block.some(function (row, r) { return row.some(function (value, c) { return String(value === null || value === undefined ? '' : value) !== actual[r][c]; }); })) fail_('PREVIEW_CHANGED', 'Лист контактов изменён до завершения подготовки.');
    }
  });
}

/** Enrollment and queueing only. No provider request or payment occurs here. */
function preparedWorkbookEnroll_(context, draft) {
  if (draft.planVersion !== 2 || draft.state !== 'complete') return;
  try {
    if (!draft.contactsEnrolled && typeof enrollContactWorkbook_ === 'function') {
      enrollContactWorkbook_(context, draft.outputId, { sourceSheetIds: draft.copiedSheetIds.slice(), sourceMode: 'all', emailSheetId: draft.emailSheetId, phoneSheetId: draft.phoneSheetId, section: draft.section, role: 'registry', seedExisting: true });
      draft.contactsEnrolled = true; preparedSave_(context, draft);
    }
    if (!draft.validationQueued && typeof queueWorkbookValidation_ === 'function') {
      queueWorkbookValidation_(context, draft.outputId, { emailSheetId: draft.emailSheetId, phoneSheetId: draft.phoneSheetId, reason: 'upload' });
      draft.validationQueued = true; preparedSave_(context, draft);
    }
    if (!draft.coldyValidationQueued && typeof queueColdyWorkbookValidation_ === 'function' && typeof emailValidationProvider_ === 'function' && emailValidationProvider_(context) === 'coldy') {
      queueColdyWorkbookValidation_(context, draft.outputId);
      draft.coldyValidationQueued = true; preparedSave_(context, draft);
    }
  } catch (error) { console.warn('New prepared workbook automation enrollment is pending.'); }
}
