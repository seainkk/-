/** New-only Coldy checks. The shared Promouser cache is also the cross-provider billing barrier. */
var COLDY_VALIDATION = Object.freeze({
  version: 1, batchSize: 500, pollMillis: 15000, leaseMillis: 120000,
  previewMillis: 15 * 60 * 1000, maxJobs: 2000, maxAttempts: 5, applyRows: 1000,
  headers: ['Валидация', 'Дата проверки', 'Результат проверки', 'Провайдер', 'Заказ Promouser', 'Валидатор', 'Проверка Coldy'],
  creditWarning: 'Проверка расходует кредиты Coldy. При отправке резервируются кредиты; точную стоимость заранее API не сообщает. Лимит Promouser в USD к Coldy не применяется.'
});

function previewColdyValidation_(request) {
  return api_(function () {
    var input = cvInput_(request, ['id','newContactsOnly']), scope = gridFile_(id_(input.id), true);
    var onlyNew = pvNewOnlyOption_(input.newContactsOnly);
    return locked_(function () {
      var fresh = gridFile_(input.id, true, scope.context.rootId), state = cvState_(fresh.context, input.id, true);
      var settings = coldySettings_(fresh.context);
      if (onlyNew && !cvPreferred_(fresh.context,settings)) fail_('COLDY_PROVIDER_CHANGED','Для новых email выбран другой валидатор. Обновите предпросмотр.');
      var scan = cvScan_(fresh.context, state, false, onlyNew);
      state.preview = { token: pvUuid_(), newContactsOnly:onlyNew, fingerprint: cvFingerprint_(state, scan, settings), credentialHash: settings.credentialHash || '', expiresAt: Date.now() + COLDY_VALIDATION.previewMillis };
      cvSave_(fresh.context, state);
      return { id: input.id, previewToken: state.preview.token, counts: scan.counts, sample: scan.contacts.slice(0, 10).map(function (c) { return c.value; }), plannedCount:scan.contacts.length, canStart: !!settings.configured && scan.contacts.length > 0, warnings: [COLDY_VALIDATION.creditWarning] };
    });
  });
}

function startColdyValidation_(request) {
  return api_(function () {
    var input = cvInput_(request, ['id', 'previewToken', 'requestId', 'acceptValidationCredits']); pvRequestId_(input.requestId);
    if (input.acceptValidationCredits !== true) fail_('COLDY_CREDIT_CONSENT', 'Подтвердите расход кредитов Coldy для новых email из предпросмотра.');
    var scope = gridFile_(id_(input.id), true);
    var started = locked_(function () {
      var fresh = gridFile_(input.id, true, scope.context.rootId), state = cvState_(fresh.context, input.id, true), settings = coldySettings_(fresh.context);
      var prior = state.requests.filter(function (r) { return r.requestId === input.requestId; })[0];
      if (prior) {
        if (prior.previewToken !== input.previewToken) fail_('COLDY_REQUEST_CONFLICT', 'Этот запрос уже использован с другим предпросмотром.');
        return { replay: true, state: state };
      }
      if (!settings.configured) fail_('COLDY_KEY_REQUIRED', 'Сначала подключите API-ключ Coldy.');
      var preview = state.preview;
      if (!preview || preview.token !== input.previewToken || preview.expiresAt <= Date.now()) fail_('COLDY_PREVIEW_EXPIRED', 'Обновите предпросмотр новых email перед проверкой.');
      if (preview.newContactsOnly && !cvPreferred_(fresh.context,settings)) fail_('COLDY_PROVIDER_CHANGED','Для новых email выбран другой валидатор. Обновите предпросмотр.');
      var scan = cvScan_(fresh.context, state, true, preview.newContactsOnly);
      if (preview.fingerprint !== cvFingerprint_(state, scan, settings)) fail_('COLDY_PREVIEW_CHANGED', 'Новые контакты или настройки изменились. Обновите предпросмотр.');
      if (!scan.contacts.length) fail_('COLDY_NOTHING_NEW', 'Новых email для платной проверки нет.');
      cvAddJobs_(state, scan.contacts, settings, input.requestId, 'manual',preview.newContactsOnly);
      state.requests.push({ requestId: input.requestId, previewToken: input.previewToken, at: pvNow_() });
      state.requests = state.requests.slice(-200); delete state.preview;
      cvLocal_(fresh.context, state, scan); cvSave_(fresh.context, state);
      return { replay: false, state: state };
    });
    return started.replay ? cvPublic_(scope.context, started.state) : cvAdvance_(scope.context, input.id);
  });
}

function getColdyValidationState_(request) {
  return api_(function () {
    var input = cvInput_(request, ['id']), scope = gridFile_(id_(input.id), false);
    return cvPublic_(scope.context, cvState_(scope.context, input.id, false));
  });
}

function advanceColdyValidation_(request) {
  return api_(function () {
    var input = cvInput_(request, ['id', 'requestId']); pvRequestId_(input.requestId);
    var scope = gridFile_(id_(input.id), true);
    return cvAdvance_(scope.context, input.id);
  });
}

/** Source hooks are local only: no HTTP, credit reservation or paid start here. */
function queueColdyWorkbookValidation_(context, fileId) {
  var scope = gridFile_(id_(fileId), true, context.rootId);
  if (!coldySettings_(scope.context).configured) return cvPublic_(scope.context, cvState_(scope.context, fileId, false));
  return locked_(function () {
    var fresh = gridFile_(fileId, true, scope.context.rootId), state = cvState_(fresh.context, fileId, true), scan = cvScan_(fresh.context, state, true);
    cvLocal_(fresh.context, state, scan); cvSave_(fresh.context, state);
    return cvPublic_(fresh.context, state);
  });
}

/** Existing owner timer continues approved jobs. Unchanged idle workbooks need no row scan. */
function processColdyWorkbookValidation_(context, fileId) {
  var scope = gridFile_(id_(fileId), true, context.rootId), settings = coldySettings_(scope.context), state = cvState_(scope.context, fileId, false);
  if (!settings.configured || !state || (!state.pendingApplications && !state.jobs.some(function (job) { return !cvTerminal_(job.state); }))) return cvPublic_(scope.context, state);
  return cvAdvance_(scope.context, fileId);
}

function cvState_(context, fileId, create) {
  gridFile_(fileId, !!create, context.rootId);
  var state = coldyLoad_(context, 'validation', fileId);
  if (!state) return create ? { version: COLDY_VALIDATION.version, rootId: context.rootId, fileId: fileId, jobs: [], requests: [], targets: null, pendingApplications: 0, manualPending: 0 } : null;
  if (state.version !== COLDY_VALIDATION.version || state.rootId !== context.rootId || state.fileId !== fileId || !Array.isArray(state.jobs) || !Array.isArray(state.requests) || state.jobs.length > COLDY_VALIDATION.maxJobs) fail_('COLDY_VALIDATION_STORAGE', 'Изменился служебный журнал проверки Coldy.');
  return state;
}

function cvSave_(context, state) {
  gridFile_(state.fileId, true, context.rootId);
  if (state.rootId !== context.rootId || state.jobs.length > COLDY_VALIDATION.maxJobs) fail_('COLDY_VALIDATION_STORAGE', 'Журнал проверки Coldy не соответствует реестру.');
  state.updatedAt = pvNow_(); coldySave_(context, 'validation', state.fileId, state);
}

/** Reads the actual managed target, even before validation columns have been added. */
function cvRows_(context, state, ensure) {
  gridFile_(state.fileId, !!ensure, context.rootId);
  var workspace = getContactWorkspace_({ id: state.fileId }), target = workspace && workspace.targets && workspace.targets.emailSheetId;
  if (!Number.isSafeInteger(target) || target < 0) fail_('COLDY_TARGET_REQUIRED', 'Сначала распределите контакты на управляемую вкладку Email.');
  if (state.targets && state.targets.emailSheetId !== target) fail_('COLDY_TARGET_CHANGED', 'Управляемая вкладка Email изменилась. Проверьте существующие задания Coldy.');
  state.targets = { emailSheetId: target };
  var sheet = gridSheet_(SpreadsheetApp.openById(state.fileId), target), width = sheet.getLastColumn(), count = Math.max(0, sheet.getLastRow() - 1);
  if (count > PROMOUSER.maxRows - 1 || width > PROMOUSER.maxColumns) fail_('COLDY_VALIDATION_LIMIT', 'Список email превышает лимит одной проверки.');
  var headers = width ? sheet.getRange(1, 1, 1, width).getDisplayValues()[0].map(String) : [], map = pvHeaderMap_(headers);
  if (ensure) {
    var missing = COLDY_VALIDATION.headers.filter(function (h) { return map[pvHeader_(h)] === undefined; });
    if (headers.length + missing.length > PROMOUSER.maxColumns) fail_('COLDY_VALIDATION_LIMIT', 'Недостаточно места для колонок проверки.');
    if (missing.length) { pvEnsureGrid_(sheet, 1, headers.length + missing.length); sheetWriteRawStrings_(state.fileId, target, 1, headers.length + 1, [missing]); headers = headers.concat(missing); map = pvHeaderMap_(headers); width = headers.length; }
  }
  var emailColumn = pvFindHeader_(map, ['email', 'e-mail', 'почта']);
  if (emailColumn === undefined) fail_('COLDY_EMAIL_COLUMN', 'На управляемой вкладке нет столбца Email.');
  var statusColumn = map[pvHeader_('Валидация')], values = count ? sheet.getRange(2, 1, count, width).getDisplayValues() : [];
  var notes = count && statusColumn !== undefined ? sheet.getRange(2, statusColumn + 1, count, 1).getNotes() : [];
  var excluded = new Set();
  return values.map(function (line, index) {
    var rawEmail = String(line[emailColumn] || '').trim(); if (!rawEmail) return null;
    var value = pvEmail_(rawEmail), key = value ? pvKey_('email', value) : '', note = String(notes[index] && notes[index][0] || ''), bound = pvBinding_(note);
    if (value && pvExcludedRow_(line, map)) excluded.add(key);
    var status = statusColumn === undefined ? '' : String(line[statusColumn] || '').trim(), legacy = !bound && !status ? pvLegacyResult_('email', line, map) : null;
    return { fileId: state.fileId, sheetId: target, row: index + 2, value: value, rawEmail: rawEmail, key: key, kind: 'email', map: map, values: line, note: note, bound: bound, changed: !!bound && bound !== key, completed: !!legacy || !!status && !pvPendingStatus_(status), status: legacy ? legacy.status : status, legacyResult: legacy, invalid: !value };
  }).filter(function (row) { return row && !excluded.has(row.key); });
}

/** All callers hold the same script lock as Promouser when reading/reserving the shared cache. */
function cvScan_(context, state, ensure, onlyNew) {
  var rows = cvRows_(context, state, ensure), cache = pvCache_(context, true), map = pvCacheRead_(cache), completed = Object.create(null), jobs = Object.create(null), seen = Object.create(null);
  state.jobs.forEach(function (job) { if (job.state !== 'cancelled') job.contacts.forEach(function (c) { jobs[c.key] = job; }); });
  rows.forEach(function (row) {
    if (row.invalid || !row.completed || row.changed) return;
    completed[row.key] = true;
    if (!map[row.key]) {
      var result = pvResultFromRow_(row);
      if (result) { result.validator = cvCell_(row, 'Валидатор') || result.validator || (result.orderId ? 'promouser' : ''); result.verificationBatchId = cvCell_(row, 'Проверка Coldy'); pvCachePut_(context, cache, map, row.key, 'email', result); }
    }
  });
  if (onlyNew) rows = pvNewContactRows_(rows,'email');
  var counts = { new: 0, checked: 0, cached: 0, inProgress: 0, invalid: 0 }, contacts = [];
  rows.forEach(function (row) {
    if (row.invalid) { counts.invalid++; return; }
    if (seen[row.key]) return; seen[row.key] = true;
    if (completed[row.key]) { counts.checked++; return; }
    var entry = map[row.key];
    if (entry && entry.result) { counts.cached++; return; }
    if (entry && entry.pending || jobs[row.key]) { counts.inProgress++; return; }
    counts.new++; contacts.push({ key: row.key, value: row.value });
  });
  contacts.sort(function (a, b) { return a.key.localeCompare(b.key); });
  pvCacheFlush_(context, cache);
  return { rows: rows, cache: cache, cacheMap: map, contacts: contacts, counts: counts };
}

function cvFingerprint_(state, scan, settings) { return digest_(JSON.stringify([state.rootId, state.fileId, state.targets, settings.credentialHash || '', scan.contacts.map(function (c) { return c.key; })])); }
function cvCell_(row, header) { var col = row.map[pvHeader_(header)]; return col === undefined ? '' : String(row.values[col] || ''); }

function cvAddJobs_(state, contacts, settings, requestId, consent, onlyNew) {
  for (var i = 0; i < contacts.length; i += COLDY_VALIDATION.batchSize) {
    var part = contacts.slice(i, i + COLDY_VALIDATION.batchSize), jobId = 'cv-' + digest_(JSON.stringify([state.rootId, state.fileId, settings.credentialHash, requestId, part.map(function (c) { return c.key; })]));
    if (state.jobs.some(function (j) { return j.jobId === jobId; })) continue;
    if (state.jobs.length >= COLDY_VALIDATION.maxJobs) fail_('COLDY_VALIDATION_LIMIT', 'Журнал проверки заполнен. Сначала завершите существующие задания.');
    state.jobs.push({ jobId: jobId, contacts: part, newContactsOnly:onlyNew === true, credentialHash: settings.credentialHash, idempotencyKey: 'registry-email-' + digest_(JSON.stringify([state.rootId, state.fileId, jobId, settings.credentialHash, part.map(function (c) { return c.value; })])), consent: consent, state: 'queued', createdAt: pvNow_(), batchId: '', attempts: 0, nextActionAt: 0, reservedCredits: null, chargedCredits: null, progress: 0 });
  }
}

/** Uses cached results without overwriting any completed or manually excluded row. */
function cvLocal_(context, state, scan) {
  var active = Object.create(null), updates = [];
  state.jobs.forEach(function (job) { if (!cvTerminal_(job.state)) job.contacts.forEach(function (c) { active[c.key] = job; }); });
  scan.rows.forEach(function (row) {
    if (row.invalid || row.completed && !row.changed) return;
    var entry = scan.cacheMap[row.key], job = active[row.key], update;
    if (entry && entry.result) update = { row: row, result: entry.result };
    else if (job || entry && entry.pending) update = { row: row, pending: job && job.batchId ? 'Проверяется' : 'Ожидает проверки' };
    if (update && cvNeedsUpdate_(row, update)) updates.push(update);
  });
  state.manualPending = scan.contacts.length;
  state.pendingApplications = updates.length;
  // Persist the application debt before writing: a lost Sheets acknowledgement is safely retried.
  cvSave_(context, state);
  cvApply_(context, state, updates.slice(0, COLDY_VALIDATION.applyRows));
  state.pendingApplications = Math.max(0, updates.length - COLDY_VALIDATION.applyRows);
}

function cvFields_(row, update) {
  var result = update.result, fields = result ? { 'Валидация': result.status, 'Дата проверки': result.checkedAt || '', 'Результат проверки': result.raw || '' } : { 'Валидация': update.pending };
  if (result) {
    if (result.provider || row.changed) fields['Провайдер'] = result.provider || '';
    if (result.orderId || row.changed) fields['Заказ Promouser'] = result.orderId || '';
    if (result.validator || result.orderId || row.changed) fields['Валидатор'] = result.validator || (result.orderId ? 'promouser' : '');
    if (result.verificationBatchId || row.changed) fields['Проверка Coldy'] = result.verificationBatchId || '';
  }
  if (row.changed) COLDY_VALIDATION.headers.forEach(function (h) { if (!Object.prototype.hasOwnProperty.call(fields, h)) fields[h] = ''; });
  return fields;
}
function cvNeedsUpdate_(row, update) { var fields = cvFields_(row, update); return Object.keys(fields).some(function (h) { return row.map[pvHeader_(h)] !== undefined && (cvCell_(row, h) !== String(fields[h]) || h === 'Валидация' && row.note !== pvBoundNote_(row.note, row.key)); }); }

function cvApply_(context, state, updates) {
  if (!updates.length) return;
  var current = cvRows_(context, state, false), locations = Object.create(null), cells = [], requests = [];
  current.forEach(function (row) { locations[row.sheetId + ':' + row.row] = row; });
  updates.forEach(function (update) {
    var row = locations[update.row.sheetId + ':' + update.row.row];
    if (!row || row.key !== update.row.key || row.completed && !row.changed) return;
    var fields = cvFields_(row, update);
    Object.keys(fields).forEach(function (h) {
      var col = row.map[pvHeader_(h)]; if (col === undefined) return;
      var cell = { userEnteredValue: { stringValue: String(fields[h] === undefined || fields[h] === null ? '' : fields[h]) } }, mask = 'userEnteredValue';
      if (h === 'Валидация') { cell.note = pvBoundNote_(row.note, row.key); mask += ',note'; }
      if (cvCell_(row, h) === cell.userEnteredValue.stringValue && (h !== 'Валидация' || row.note === cell.note)) return;
      cells.push({ row: row.row, col: col, sheetId: row.sheetId, cell: cell, mask: mask });
    });
  });
  cells.sort(function (a, b) { return a.sheetId - b.sheetId || a.col - b.col || a.mask.localeCompare(b.mask) || a.row - b.row; });
  cells.forEach(function (cell) {
    var last = requests[requests.length - 1], update = last && last.updateCells;
    if (update && update.range.sheetId === cell.sheetId && update.range.startColumnIndex === cell.col && update.fields === cell.mask && update.range.endRowIndex === cell.row - 1) { update.range.endRowIndex++; update.rows.push({ values: [cell.cell] }); }
    else requests.push({ updateCells: { range: { sheetId: cell.sheetId, startRowIndex: cell.row - 1, endRowIndex: cell.row, startColumnIndex: cell.col, endColumnIndex: cell.col + 1 }, rows: [{ values: [cell.cell] }], fields: cell.mask } });
  });
  if (!requests.length) return;
  gridFile_(state.fileId, true, context.rootId); SpreadsheetApp.flush();
  try { Sheets.Spreadsheets.batchUpdate({ requests: requests }, state.fileId); }
  catch (error) { fail_('COLDY_VALIDATION_WRITE', 'Результат сохранён в журнале, но Google не подтвердил запись в строки. Повторите обновление.'); }
}

/** Exactly one provider request per call, outside the global lock; never sleeps. */
function cvAdvance_(context, fileId) {
  var scope = gridFile_(fileId, true, context.rootId), settings = coldySettings_(scope.context);
  if (!settings.configured) return cvPublic_(scope.context, cvState_(scope.context, fileId, false));
  var claim = locked_(function () {
    var fresh = gridFile_(fileId, true, context.rootId), state = cvState_(fresh.context, fileId, false);
    if (!state) return { state: null };
    if (!state.pendingApplications && !state.jobs.some(function (job) { return !cvTerminal_(job.state); })) return { state: state };
    if (state.lease && state.lease.until > Date.now()) return { state: state };
    if (state.lease) {
      state.jobs.forEach(function (j) { if (j.dispatch && j.dispatch.token === state.lease.token) j.state = j.dispatch.action === 'create' ? 'creation_uncertain' : j.dispatch.previous; });
      delete state.lease;
    }
    var scan = cvScan_(fresh.context, state, true); cvLocal_(fresh.context, state, scan);
    settings = coldySettings_(fresh.context);
    var jobs = state.jobs.filter(function (j) { return !cvTerminal_(j.state) && (j.nextActionAt || 0) <= Date.now(); });
    jobs.sort(function (a, b) { return cvPriority_(a) - cvPriority_(b); });
    var job = jobs[0];
    if (!job) { cvSave_(fresh.context, state); return { state: state }; }
    if (job.credentialHash !== settings.credentialHash) { job.state = 'credential_changed'; cvSave_(fresh.context, state); return { state: state }; }
    var action = job.batchId ? job.state === 'results_pending' ? 'results' : 'status' : 'create';
    if (action === 'create') {
      var checked = job.contacts.filter(function (c) { return scan.cacheMap[c.key] && scan.cacheMap[c.key].result; });
      if (!job.dispatched && checked.length === job.contacts.length) { job.state = 'complete_shared'; job.resultCount = job.contacts.length; cvSave_(fresh.context, state); return { state: state }; }
      if (checked.length || job.newContactsOnly && !cvPreferred_(fresh.context,settings) ||
          !pvContactsStillPresent_(scan.rows,job.contacts,job.newContactsOnly && 'email')) {
        job.state = job.dispatched ? 'needs_review' : 'cancelled';
        if (!job.dispatched) { pvCacheRelease_(scan.cache, scan.cacheMap, job.contacts, fileId, job.jobId); pvCacheFlush_(fresh.context, scan.cache); }
        cvSave_(fresh.context, state); return { state: state };
      }
      if (job.contacts.some(function (c) { var e = scan.cacheMap[c.key]; return e && e.pending && !cvOwnReservation_(e, state, job); })) { job.state = 'waiting_shared'; job.nextActionAt = Date.now() + COLDY_VALIDATION.pollMillis; cvSave_(fresh.context, state); return { state: state }; }
      job.contacts.forEach(function (c) { pvCacheReserve_(scan.cache, scan.cacheMap, c.key, 'email', { fileId: fileId, jobId: job.jobId, keyHash: job.credentialHash, validator: 'coldy', at: Date.now() }); });
      pvCacheFlush_(fresh.context, scan.cache);
    }
    var token = pvUuid_(); state.lease = { token: token, until: Date.now() + COLDY_VALIDATION.leaseMillis };
    job.dispatch = { token: token, action: action, previous: job.state, at: Date.now() };
    job.state = action === 'create' ? 'creating' : action === 'results' ? 'downloading' : 'polling'; job.nextActionAt = Date.now() + COLDY_VALIDATION.pollMillis;
    if (action === 'create') { job.dispatched = true; job.attempts++; }
    cvSave_(fresh.context, state);
    return { state: state, job: JSON.parse(JSON.stringify(job)), token: token, action: action, context: fresh.context };
  });
  if (!claim.job) return cvPublic_(scope.context, claim.state);
  var response, failure = null;
  try {
    cvGuardDispatch_(context, fileId, claim);
    response = claim.action === 'create' ? coldyApi_(claim.context, 'POST', '/email-verifications', { emails: claim.job.contacts.map(function (c) { return c.value; }) }, { idempotencyKey: claim.job.idempotencyKey }) : coldyApi_(claim.context, 'GET', '/email-verifications/' + encodeURIComponent(claim.job.batchId) + (claim.action === 'results' ? '/results' : ''));
  } catch (error) { failure = error && error.registryCode ? error : registryError_('COLDY_NETWORK', 'Coldy не подтвердил запрос.'); }
  return locked_(function () {
    var fresh = gridFile_(fileId, true, context.rootId), state = cvState_(fresh.context, fileId, false), job = state && state.jobs.filter(function (j) { return j.jobId === claim.job.jobId; })[0];
    if (!job || !state.lease || state.lease.token !== claim.token || state.lease.until <= Date.now() || !job.dispatch || job.dispatch.token !== claim.token) fail_('COLDY_VALIDATION_LEASE', 'Изменилось состояние проверки. Обновите статус.');
    delete state.lease;
    var currentSettings = coldySettings_(fresh.context);
    if (!currentSettings.configured || currentSettings.credentialHash !== job.credentialHash) { job.state = 'credential_changed'; cvSave_(fresh.context, state); return cvPublic_(fresh.context, state); }
    if (claim.action === 'create' && job.newContactsOnly && job.attempts === 1 && failure &&
        ['COLDY_CONTACT_CHANGED','COLDY_PROVIDER_CHANGED'].indexOf(failure.registryCode) >= 0) {
      // The first pre-dispatch guard rejected this order before the provider received the POST.
      var cache = pvCache_(fresh.context,true), map = pvCacheRead_(cache);
      pvCacheRelease_(cache,map,job.contacts,fileId,job.jobId); pvCacheFlush_(fresh.context,cache);
      job.state = 'cancelled'; job.lastError = failure.registryCode;
    } else if (failure) cvFailure_(job, claim.action, failure);
    else {
      try { cvAccept_(fresh.context, state, job, claim.action, response); }
      catch (error) { if (error && error.registryCode === 'COLDY_VALIDATION_RESPONSE') cvFailure_(job, claim.action, error); else throw error; }
    }
    cvSave_(fresh.context, state);
    var scan = cvScan_(fresh.context, state, true); cvLocal_(fresh.context, state, scan); cvSave_(fresh.context, state);
    return cvPublic_(fresh.context, state);
  });
}

function cvGuardDispatch_(context, fileId, claim) {
  var fresh = gridFile_(fileId, true, context.rootId), state = cvState_(fresh.context, fileId, false), current = coldyCredentialHash_(fresh.context);
  if (current !== claim.job.credentialHash) fail_('COLDY_CREDENTIAL_CHANGED', 'API-ключ Coldy изменился.');
  if (!state || !state.lease || state.lease.token !== claim.token || state.lease.until <= Date.now()) fail_('COLDY_VALIDATION_LEASE', 'Истёк срок выполнения шага проверки.');
  var job = state.jobs.filter(function (j) { return j.jobId === claim.job.jobId; })[0];
  if (!job || !job.dispatch || job.dispatch.token !== claim.token) fail_('COLDY_VALIDATION_LEASE', 'Шаг проверки изменился.');
  if (claim.action === 'create') {
    if (job.newContactsOnly && !cvPreferred_(fresh.context,coldySettings_(fresh.context)))
      fail_('COLDY_PROVIDER_CHANGED','Для новых email выбран другой валидатор.');
    var rows = cvRows_(fresh.context, state, false);
    if (!pvContactsStillPresent_(rows,job.contacts,job.newContactsOnly && 'email')) fail_('COLDY_CONTACT_CHANGED', 'Контакты изменились перед отправкой. Обновите предпросмотр.');
  }
}

function cvAccept_(context, state, job, action, response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) fail_('COLDY_VALIDATION_RESPONSE', 'Не подтверждён формат ответа Coldy.');
  if (action === 'results') { cvResults_(context, state, job, response); return; }
  var batchId = String(response.batch_id === undefined ? '' : response.batch_id);
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(batchId) || job.batchId && job.batchId !== batchId || ['queued', 'running', 'completed', 'failed'].indexOf(response.status) === -1) fail_('COLDY_VALIDATION_RESPONSE', 'Не подтверждено задание проверки Coldy.');
  job.batchId = batchId;
  if (cvNumber_(response.reserved_credits) !== null) job.reservedCredits = cvNumber_(response.reserved_credits);
  if (cvNumber_(response.charged_credits) !== null) job.chargedCredits = cvNumber_(response.charged_credits);
  job.progress = response.status === 'completed' ? 100 : cvNumber_(response.progress) !== null && response.progress <= 100 ? response.progress : null;
  job.state = response.status === 'failed' ? 'result_review' : response.status === 'completed' ? 'results_pending' : 'processing';
  job.failures = 0; job.lastError = ''; job.nextActionAt = Date.now() + COLDY_VALIDATION.pollMillis;
}

function cvResults_(context, state, job, response) {
  if (String(response.batch_id) !== job.batchId || !Array.isArray(response.results) || response.results.length > COLDY_VALIDATION.batchSize * 4) fail_('COLDY_VALIDATION_RESPONSE', 'Не подтверждён результат задания Coldy.');
  var requested = Object.create(null), found = Object.create(null), cache = pvCache_(context, true), map = pvCacheRead_(cache), review = 0;
  job.contacts.forEach(function (c) { requested[c.key] = c; });
  response.results.forEach(function (item) {
    if (!item || typeof item !== 'object') return;
    var email = pvEmail_(item.email), key = email ? pvKey_('email', email) : ''; if (!requested[key]) return;
    var valid = ['valid', 'invalid', 'unknown', 'accept_all', 'disposable'].indexOf(item.result) !== -1 && !item.error;
    var raw = valid ? item.result : 'unconfirmed';
    if (found[key] && found[key] !== raw) raw = 'unconfirmed';
    found[key] = raw;
  });
  var labels = { valid: 'Валиден', invalid: 'Невалиден', unknown: 'Неизвестно', accept_all: 'Принимает все письма', disposable: 'Одноразовый ящик', unconfirmed: 'Нужна ручная проверка' };
  job.contacts.forEach(function (c) {
    var raw = found[c.key] || 'unconfirmed', entry = map[c.key];
    if (raw === 'unconfirmed') review++;
    if (entry && entry.pending && !cvOwnReservation_(entry, state, job)) { review++; return; }
    pvCachePut_(context, cache, map, c.key, 'email', { status: labels[raw], raw: raw, checkedAt: pvNow_(), provider: '', validator: 'coldy', verificationBatchId: job.batchId, orderId: '', review: raw === 'unconfirmed' });
  });
  pvCacheFlush_(context, cache);
  job.resultCount = job.contacts.length - review; job.reviewCount = review; job.progress = 100; job.completedAt = pvNow_(); job.state = review ? 'result_review' : 'complete'; job.failures = 0;
}

function cvFailure_(job, action, error) {
  var code = error && error.registryCode || 'COLDY_NETWORK'; job.lastError = code; job.failures = (job.failures || 0) + 1;
  var terminal = ['COLDY_CREDENTIAL_CHANGED', 'COLDY_KEY_REQUIRED', 'COLDY_AUTH', 'COLDY_FORBIDDEN', 'COLDY_NOT_FOUND', 'COLDY_PROVIDER', 'INVALID_REQUEST', 'COLDY_CONTACT_CHANGED', 'COLDY_PROVIDER_CHANGED', 'COLDY_VALIDATION_LEASE'].indexOf(code) !== -1 || action === 'create' && code === 'COLDY_CONFLICT';
  job.state = code === 'COLDY_CREDENTIAL_CHANGED' || code === 'COLDY_KEY_REQUIRED' ? 'credential_changed' : terminal || job.failures >= COLDY_VALIDATION.maxAttempts ? 'needs_review' : action === 'create' ? 'creation_uncertain' : job.dispatch.previous;
  var retry = Number(error && error.retryAfterMs); if (!Number.isFinite(retry) || retry < 0) retry = 0;
  job.nextActionAt = Date.now() + Math.max(COLDY_VALIDATION.pollMillis * Math.min(8, Math.pow(2, job.failures - 1)), Math.min(retry, 24 * 60 * 60 * 1000));
}

function cvOwnReservation_(entry, state, job) { return !!entry.pending && entry.pending.fileId === state.fileId && entry.pending.jobId === job.jobId && entry.pending.keyHash === job.credentialHash; }
function cvNumber_(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
function cvTerminal_(state) { return ['complete', 'complete_shared', 'result_review', 'needs_review', 'credential_changed', 'cancelled'].indexOf(state) !== -1; }
function cvPriority_(job) { return job.state === 'results_pending' ? 0 : job.batchId ? 1 : 2; }
function cvPreferred_(context, settings) { return typeof emailValidationProvider_ === 'function' ? emailValidationProvider_(context) === 'coldy' : settings.emailValidationProvider === 'coldy'; }

function cvPublic_(context, state) {
  var settings = coldySettings_(context), jobs = state ? state.jobs : [], counts = { queued: 0, processing: 0, checked: 0, review: 0 }, next = [], warnings = [];
  jobs.forEach(function (job) {
    if (job.state === 'cancelled') return;
    if (job.state === 'complete' || job.state === 'complete_shared') counts.checked += job.contacts.length;
    else if (cvTerminal_(job.state)) { counts.review += job.reviewCount || job.contacts.length; counts.checked += job.resultCount || 0; }
    else { if (!job.batchId) counts.queued += job.contacts.length; else counts.processing += job.contacts.length; if (settings.configured && job.credentialHash === settings.credentialHash) next.push(job.nextActionAt || 0); }
  });
  if (state && state.pendingApplications) next.push(0);
  if (state && state.lease && state.lease.until > Date.now()) next = next.map(function (at) { return Math.max(at, state.lease.until); });
  if (counts.review) warnings.push('Часть проверок требует проверки вручную. Повторные платные задания для этих контактов не создаются.');
  if (state && state.manualPending) warnings.push('Есть новые email. Для платной проверки откройте предпросмотр и подтвердите расход кредитов Coldy.');
  if (!settings.configured) warnings.push('Подключите API-ключ Coldy. Существующие результаты сохраняются.');
  return { configured: !!settings.configured, enabled: !!settings.configured, preferred: cvPreferred_(context, settings), state: !settings.configured ? 'not_configured' : counts.queued || counts.processing || state && state.pendingApplications ? 'pending' : counts.review ? 'needs_review' : state && state.manualPending ? 'awaiting_confirmation' : 'complete', counts: counts,
    jobs: jobs.slice(-100).map(function (j) { return { jobId: j.jobId, batchId: j.batchId || '', state: j.state, contacts: j.contacts.length, reservedCredits: j.reservedCredits, chargedCredits: j.chargedCredits, progress: j.progress }; }), canAutoAdvance: !!settings.configured && next.length > 0, nextActionAt: next.length ? Math.max(Date.now(), Math.min.apply(null, next)) : null, warnings: warnings };
}

function cvInput_(value, allowed) { authorize_(); var input = object_(value || {}); if (Object.keys(input).some(function (k) { return allowed.indexOf(k) === -1; })) fail_('INVALID_REQUEST', 'В запросе Coldy есть неизвестные поля.'); return input; }
