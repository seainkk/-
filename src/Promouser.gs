/** Promouser validation. Credentials never leave Script Properties or the fixed provider header. */
var PROMOUSER = Object.freeze({
  base: 'https://promouser.com', version: 1, batchSize: 1000,
  orderDelay: 5000, statusDelay: 15000, leaseMillis: 120000, quoteFreshMillis: 60000, consentMillis: 900000, previewMillis: 600000,
  maxRows: 100000, maxColumns: 200, maxCacheRows: 200000, maxLedgerCharacters: 15000000, applyRows: 1000,
  keyProperty: 'PROMOUSER_API_KEY', enabledProperty: 'PROMOUSER_ENABLED',
  limitProperty: 'PROMOUSER_AUTO_PAY_LIMIT_USD', folderProperty: 'PROMOUSER_STATE_FOLDER_ID',
  connectionProperty: 'PROMOUSER_CONNECTION', cacheTab: 'ValidationCache',
  cacheHeaders: ['Key', 'Kind', 'Status', 'CheckedAt', 'Result', 'Provider', 'OrderId', 'DetailsJSON'],
  emailHeaders: ['Валидация', 'Дата проверки', 'Результат проверки', 'Провайдер', 'Заказ Promouser'],
  phoneHeaders: ['Валидация', 'Дата проверки', 'Результат проверки', 'Заказ Promouser', 'ID_TG', 'Nickname_TG', 'Active_days_ago', 'Для Telegram'],
  bindingPrefix: 'registry-promouser-contact:v1:'
});

function getPromouserSettings_() {
  return api_(function () { return pvSettingsPublic_(pvSettings_(authorize_())); });
}

function configurePromouser_(request) {
  return api_(function () {
    var input = pvInput_(request, ['apiKey', 'clearKey', 'enabled', 'autoPayLimitUsd']);
    return locked_(function () {
      var context = authorize_(), properties = context.properties, old = pvSettings_(context);
      if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 512 || /[\u0000-\u0020]/.test(input.apiKey))) fail_('INVALID_REQUEST', 'Проверьте API-ключ Promouser.');
      if (input.clearKey !== undefined && typeof input.clearKey !== 'boolean') fail_('INVALID_REQUEST', 'Некорректный параметр подключения.');
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail_('INVALID_REQUEST', 'Некорректный режим проверки.');
      var key = input.clearKey ? '' : (input.apiKey || old.key), enabled = input.enabled === undefined ? (input.clearKey ? false : old.enabled) : input.enabled;
      var limit = input.autoPayLimitUsd === undefined ? old.autoPayLimitUsd : pvMoney_(input.autoPayLimitUsd);
      if (limit === null || limit > 1000) fail_('INVALID_REQUEST', 'Лимит автооплаты должен быть от 0 до 1000 USD за заказ.');
      if (enabled && !key) fail_('PV_KEY_REQUIRED', 'Сначала подключите API-ключ Promouser.');
      if (key) properties.setProperty(PROMOUSER.keyProperty, key); else properties.deleteProperty(PROMOUSER.keyProperty);
      properties.setProperty(PROMOUSER.enabledProperty, enabled ? 'true' : 'false');
      properties.setProperty(PROMOUSER.limitProperty, String(limit));
      if (key !== old.key) properties.deleteProperty(PROMOUSER.connectionProperty);
      return pvSettingsPublic_(pvSettings_(context));
    });
  });
}

function getPromouserBalance_() {
  return api_(function () {
    var context = authorize_(), settings = pvSettings_(context);
    pvRequireKey_(settings);
    return pvProbe_(context, settings);
  });
}

function getValidationState_(request) {
  return api_(function () {
    var input = pvInput_(request, ['id']), scope = gridFile_(id_(input.id), false);
    var state = pvLedger_(scope.context, input.id, false);
    return pvPublic_(scope.context, state);
  });
}

/** Local-only preview. No provider requests, contact edits or payment consent. */
function previewPromouserValidation_(request) {
  return api_(function () {
    var input = pvInput_(request, ['id', 'kind']), kind = pvValidationKind_(input.kind), scope = gridFile_(id_(input.id), true);
    return locked_(function () {
      var fresh = gridFile_(input.id, true, scope.context.rootId), state = pvLedger_(fresh.context, input.id, true);
      pvUpdateTargets_(state, {});
      var snapshot = pvPreviewSnapshot_(fresh.context, state, kind), token = pvUuid_();
      var preview = { token: token, kind: kind, rootId: fresh.context.rootId, fileId: input.id, sourceHash: snapshot.sourceHash, keys: snapshot.keys, credentialHash: pvSettings_(fresh.context).key ? digest_(pvSettings_(fresh.context).key) : '', createdAt: Date.now(), expiresAt: Date.now() + PROMOUSER.previewMillis };
      state.validationPreviews = (state.validationPreviews || []).filter(function (item) { return item.expiresAt > Date.now(); }).slice(-9).concat([preview]);
      pvSave_(fresh.context, state);
      return { previewToken: token, kind: kind, counts: snapshot.counts, sample: snapshot.sample, canStart: snapshot.canStart };
    });
  });
}

function startPromouserValidation_(request) {
  return api_(function () {
    var input = pvInput_(request, ['id', 'kind', 'previewToken', 'requestId']), kind = pvValidationKind_(input.kind); pvRequestId_(input.requestId);
    var scope = gridFile_(id_(input.id), true);
    var recovered = locked_(function () {
      var state = pvLedger_(scope.context, input.id, false), preview = pvFindPreview_(state, input.previewToken, kind, input.requestId);
      if (preview.started) return pvPublic_(scope.context, state);
      pvCheckPreview_(scope.context, state, preview, kind);
      return null;
    });
    if (recovered) return recovered;
    // Queueing may apply existing cached results, but cannot approve any job.
    queueWorkbookValidation_(scope.context, input.id, {});
    return locked_(function () {
      var fresh = gridFile_(input.id, true, scope.context.rootId), state = pvLedger_(fresh.context, input.id, false), preview = pvFindPreview_(state, input.previewToken, kind, input.requestId);
      if (preview.started) return pvPublic_(fresh.context, state);
      pvCheckPreview_(fresh.context, state, preview, kind);
      var allowed = Object.create(null); preview.keys.forEach(function (key) { allowed[key] = true; });
      var approved = [];
      state.jobs.forEach(function (job) {
        if (job.kind !== kind || job.manualStartApproved || job.paid || pvJobFinished_(job.state) || !job.contacts.length || !job.contacts.every(function (contact) { return allowed[contact.key]; })) return;
        if (['queued', 'waiting_shared', 'awaiting_quote', 'awaiting_payment'].indexOf(job.state) === -1) return;
        job.manualStartApproved = true; job.startApproval = { method: 'preview', requestId: input.requestId, previewToken: preview.token, at: Date.now() }; approved.push(job.jobId);
      });
      preview.started = { requestId: input.requestId, jobIds: approved, at: Date.now() };
      state.validationStarts = (state.validationStarts || []).slice(-99).concat([{ requestId: input.requestId, previewToken: preview.token, kind: kind }]);
      pvSave_(fresh.context, state);
      return pvPublic_(fresh.context, state);
    });
  });
}

function previewPhoneValidation_(request) { var input = pvInput_(request, ['id']); return previewPromouserValidation_({ id: input.id, kind: 'telegram' }); }
function startPhoneValidation_(request) { var input = pvInput_(request, ['id', 'previewToken', 'requestId']); return startPromouserValidation_({ id: input.id, kind: 'telegram', previewToken: input.previewToken, requestId: input.requestId }); }

function pvValidationKind_(value) { if (value !== 'email' && value !== 'telegram') fail_('INVALID_REQUEST', 'Выберите проверку email или телефонов Telegram.'); return value; }
function pvEmailPreferred_(context) { return typeof emailValidationProvider_ === 'function' ? emailValidationProvider_(context) : 'promouser'; }
function pvCancelUnsent_(context, state, cache, map, rows) {
  if (state.lease && state.lease.until > Date.now()) return false;
  var coldEmail = pvEmailPreferred_(context) !== 'promouser', changed = false;
  state.jobs.forEach(function (job) {
    if (job.state !== 'queued' || job.orderId) return;
    var obsolete = rows && !job.manualStartApproved && !pvContactsStillPresent_(rows, job.contacts);
    if (!(job.kind === 'email' && coldEmail) && !obsolete) return;
    job.state = 'cancelled'; job.message = obsolete ? 'Контакты изменились до запуска. Подготовлена новая очередь.' : 'Для новых email выбран другой валидатор.';
    changed = true;
    pvCacheRelease_(cache, map, job.contacts, state.fileId, job.jobId);
  });
  return changed;
}
function pvFindPreview_(state, token, kind, requestId) {
  var prior = state && (state.validationStarts || []).filter(function (item) { return item.requestId === requestId; })[0];
  if (prior && (prior.previewToken !== token || prior.kind !== kind)) fail_('PV_PREVIEW_STALE', 'Этот запрос уже использован для другого предпросмотра.');
  var preview = state && (state.validationPreviews || []).filter(function (item) { return item.token === token && item.kind === kind; })[0];
  if (!preview && prior) return { started: { requestId: requestId } };
  if (!preview) fail_('PV_PREVIEW_STALE', 'Обновите предпросмотр перед запуском проверки.');
  return preview;
}
function pvCheckPreview_(context, state, preview, kind) {
  if (preview.rootId !== context.rootId || preview.fileId !== state.fileId || preview.expiresAt <= Date.now()) fail_('PV_PREVIEW_STALE', 'Предпросмотр устарел. Посмотрите актуальные контакты перед запуском.');
  var settings = pvSettings_(context); pvRequireKey_(settings);
  if (!settings.enabled) fail_('PV_PAUSED', 'Включите подключение Promouser перед запуском проверки.');
  if (preview.credentialHash !== digest_(settings.key)) fail_('PV_PREVIEW_STALE', 'Подключение изменилось. Обновите предпросмотр.');
  if (kind === 'email' && pvEmailPreferred_(context) !== 'promouser') fail_('PV_PROVIDER_CHANGED', 'Для новых email выбран другой валидатор.');
  if (pvPreviewSnapshot_(context, state, kind).sourceHash !== preview.sourceHash) fail_('PV_PREVIEW_STALE', 'Контакты или вкладки изменились. Обновите предпросмотр.');
}
function pvPreviewSnapshot_(context, state, kind) {
  var targets = pvTargets_(context, state, false), cache = pvCache_(context, false), cacheMap = pvCacheRead_(cache), seen = Object.create(null), completed = Object.create(null), pending = Object.create(null), counts = { new: 0, checked: 0, cached: 0, inProgress: 0, unknownCountry: 0, telegramWithoutPhone: 0, invalid: 0 }, keys = [], sample = [], source = [];
  state.jobs.forEach(function (job) { if (job.state !== 'cancelled') job.contacts.forEach(function (contact) { pending[contact.key] = job; }); });
  targets.rows.forEach(function (row) { if (row.completed && !row.changed && !row.invalid) completed[row.key] = true; });
  targets.rows.forEach(function (row) {
    if (kind === 'email' ? row.kind !== 'email' : row.kind === 'email') return;
    var ignored = kind === 'email' ? PROMOUSER.emailHeaders.concat(['Валидатор', 'Проверка Coldy']) : PROMOUSER.phoneHeaders;
    var own = Object.create(null); ignored.forEach(function (header) { if (row.map[pvHeader_(header)] !== undefined) own[row.map[pvHeader_(header)]] = true; });
    source.push([row.sheetId, row.row, row.key, row.value, row.country, !!row.invalid, row.values.filter(function (_, index) { return !own[index]; }), String(row.note || '').split('\n').filter(function (line) { return line.indexOf(PROMOUSER.bindingPrefix) !== 0; }).join('\n')]);
    if (seen[row.key]) return; seen[row.key] = true;
    if (row.invalid) { counts.invalid++; return; }
    if (completed[row.key]) { counts.checked++; return; }
    if (cacheMap[row.key] && cacheMap[row.key].result) { counts.cached++; return; }
    if (row.kind === 'telegram_username') { counts.telegramWithoutPhone++; return; }
    if (kind === 'telegram' && !row.country) { counts.unknownCountry++; return; }
    var job = pending[row.key], reserved = cacheMap[row.key] && cacheMap[row.key].pending;
    if (job && (job.manualStartApproved || job.orderId || job.state !== 'queued') || reserved) counts.inProgress++; else counts.new++;
    var ownReservation = reserved && job && reserved.fileId === state.fileId && reserved.jobId === job.jobId;
    if ((!job || !job.manualStartApproved && !job.paid && !pvJobFinished_(job.state)) && (!reserved || ownReservation)) keys.push(row.key);
    if (sample.length < 8) sample.push(kind === 'email' ? { email: row.value } : { phone: row.value, country: row.country });
  });
  keys.sort();
  var settings = pvSettings_(context);
  return { sourceHash: digest_(JSON.stringify([context.rootId, state.fileId, state.targets, kind, source])), keys: keys, counts: counts, sample: sample, canStart: !!settings.key && settings.enabled && (kind !== 'email' || pvEmailPreferred_(context) === 'promouser') && keys.length > 0 };
}

/** The contact sync calls this only after it has durably completed its own work. */
function queueWorkbookValidation_(context, fileId, options) {
  var scope = gridFile_(id_(fileId), true, context.rootId);
  return locked_(function () {
    var fresh = gridFile_(fileId, true, scope.context.rootId), state = pvLedger_(fresh.context, fileId, true);
    pvUpdateTargets_(state, options || {});
    var targets = pvTargets_(fresh.context, state, true), cache = pvCache_(fresh.context, true), cacheMap = pvCacheRead_(cache);
    var existing = Object.create(null), pending = Object.create(null), collected = Object.create(null), updates = [], settings = pvSettings_(fresh.context);
    pvCancelUnsent_(fresh.context, state, cache, cacheMap, targets.rows);
    state.jobs.forEach(function (job) {
      if (job.state !== 'cancelled') job.contacts.forEach(function (contact) { pending[contact.key] = true; });
    });
    targets.rows.forEach(function (row) {
      if (row.invalid) return;
      if (row.completed && !row.changed) {
        existing[row.key] = true;
        // A checked legacy/manual row is respected, but never silently rewritten.
        var seeded = pvResultFromRow_(row);
        if (seeded) { pvCachePut_(fresh.context, cache, cacheMap, row.key, row.kind, seeded); }
        return;
      }
      if (cacheMap[row.key] && cacheMap[row.key].result) { updates.push({ row: row, result: cacheMap[row.key].result }); return; }
      if (pending[row.key]) return;
      if (row.kind === 'email' && pvEmailPreferred_(fresh.context) !== 'promouser') return;
      if (row.kind === 'telegram_username') {
        updates.push({ row: row, pending: 'Нужен телефон', details: 'Promouser проверяет Telegram по номеру телефона.' }); return;
      }
      if (row.kind === 'telegram' && !row.country) {
        updates.push({ row: row, pending: 'Уточните страну или номер', details: 'Не удалось безопасно определить страну мобильного номера.' }); return;
      }
      var country = row.kind === 'email' ? '' : row.country, group = row.kind + '|' + country;
      if (!existing[group]) existing[group] = [];
      if (!collected[row.key]) { existing[group].push({ key: row.key, value: row.value }); collected[row.key] = true; }
    });
    Object.keys(existing).filter(function (key) { return Array.isArray(existing[key]); }).sort().forEach(function (group) {
      var contacts = existing[group].sort(function (a, b) { return a.key.localeCompare(b.key); }), bits = group.split('|');
      for (var start = 0; start < contacts.length; start += PROMOUSER.batchSize) {
        var part = contacts.slice(start, start + PROMOUSER.batchSize).filter(function (item) { return !cacheMap[item.key] || !cacheMap[item.key].result; });
        if (!part.length) continue;
        var fingerprint = digest_(JSON.stringify([fresh.context.rootId, bits[0], bits[1], part.map(function (item) { return item.key; })]));
        var known = state.jobs.filter(function (job) { return job.fingerprint === fingerprint && job.state !== 'cancelled'; })[0];
        if (!known) {
          state.jobs.push({ jobId: pvUuid_(), fingerprint: fingerprint, kind: bits[0], country: bits[1], type: bits[0] === 'email' ? 17 : 6, contacts: part, credentialHash: settings.key ? digest_(settings.key) : '', manualStartApproved: false, state: 'queued', createdAt: pvNow_(), lastRequestAt: 0, lastStatusAt: 0, orderId: '', cost: null, message: '' });
        }
      }
    });
    var activeKeys = Object.create(null);
    state.jobs.forEach(function (job) { if (!pvJobFinished_(job.state)) job.contacts.forEach(function (contact) { activeKeys[contact.key] = true; }); });
    var updateLocations = Object.create(null); updates.forEach(function (update) { updateLocations[update.row.sheetId + ':' + update.row.row] = true; });
    targets.rows.forEach(function (row) {
      if ((!row.completed || row.changed) && cacheMap[row.key] && cacheMap[row.key].result && !updateLocations[row.sheetId + ':' + row.row]) { updates.push({ row: row, result: cacheMap[row.key].result }); updateLocations[row.sheetId + ':' + row.row] = true; }
      if ((!row.completed || row.changed) && activeKeys[row.key] && !cacheMap[row.key]) updates.push({ row: row, pending: 'Ожидает проверки' });
    });
    updates.forEach(function (update) { if (update.result && cacheMap[update.row.key] && cacheMap[update.row.key].result) update.result = cacheMap[update.row.key].result; });
    updates = updates.filter(function (update) { return pvNeedsUpdate_(update.row, update); });
    state.pendingApplications = Math.max(0, updates.length - PROMOUSER.applyRows);
    state.manualReviewCount = targets.rows.filter(function (row) { return (!row.completed || row.changed) && (row.kind === 'telegram_username' || row.kind === 'telegram' && !row.country); }).length;
    pvCacheFlush_(fresh.context, cache); pvApply_(fresh.context, state, updates.slice(0, PROMOUSER.applyRows));
    state.queuedAt = pvNow_(); pvSave_(fresh.context, state);
    return pvPublic_(fresh.context, state);
  });
}

function advanceWorkbookValidation_(request) {
  return api_(function () {
    var input = pvInput_(request, ['id', 'requestId']); pvRequestId_(input.requestId);
    var scope = gridFile_(id_(input.id), true);
    return processWorkbookValidation_(scope.context, input.id, { forceQueue: true });
  });
}

function refreshWorkbookValidation_(request) { return advanceWorkbookValidation_(request); }

function payValidationOrder_(request) {
  return api_(function () {
    var input = pvInput_(request, ['id', 'jobId', 'requestId', 'expectedCostUsd']); pvRequestId_(input.requestId);
    var expectedCost = pvMoney_(input.expectedCostUsd);
    if (expectedCost === null) fail_('PV_COST_CHANGED', 'Перед оплатой подтвердите показанную стоимость заказа.');
    var scope = gridFile_(id_(input.id), true);
    var started = Date.now(), result = pvAdvance_(scope.context, input.id, { payJobId: String(input.jobId || ''), expectedCost: expectedCost, requestId: input.requestId });
    return pvFinishPayment_(scope.context, input.id, result, started);
  });
}

function processWorkbookValidation_(context, fileId, options) {
  var scope = gridFile_(id_(fileId), true, context.rootId);
  // Contact sync queues changed books. An idle timer need not rescan their sheets;
  // explicit interface commands still queue, including before API configuration.
  if (!options || !options.forceQueue) {
    var settings = pvSettings_(scope.context), state = pvLedger_(scope.context, fileId, false);
    if (state && pvEmailPreferred_(scope.context) !== 'promouser' && !(state.lease && state.lease.until > Date.now()) && state.jobs.some(function (job) { return job.kind === 'email' && job.state === 'queued' && !job.orderId; })) {
      state = locked_(function () {
        var fresh = gridFile_(fileId, true, context.rootId), current = pvLedger_(fresh.context, fileId, false), cache = pvCache_(fresh.context, true), map = pvCacheRead_(cache);
        if (pvCancelUnsent_(fresh.context, current, cache, map, null)) { pvCacheFlush_(fresh.context, cache); pvSave_(fresh.context, current); }
        return current;
      });
    }
    if (!settings.key || !settings.enabled || state && !(state.pendingApplications > 0) && !pvAutomaticHint_(state, settings).canAutoAdvance) return pvPublic_(scope.context, state);
  }
  queueWorkbookValidation_(context, fileId, {});
  var started = Date.now(), result = pvAdvance_(context, fileId, { manualRefresh: !!(options && options.forceQueue) });
  return pvFinishPayment_(context, fileId, result, started);
}

/** A five-minute worker can finish its freshly quoted payment with one bounded follow-up. */
function pvFinishPayment_(context, fileId, result, started) {
  var settings = pvSettings_(authorize_()); if (!settings.key || !settings.enabled) return result;
  gridFile_(fileId, true, context.rootId);
  var state = pvLedger_(context, fileId, false);
  var job = state && state.jobs.filter(function (item) { return item.state === 'awaiting_payment' && item.dispatch && item.dispatch.action === 'status' && item.lastQuotedAt >= started && pvQuoteFresh_(item, Date.now()) && (pvAutoPay_(item, settings) || pvHasConsent_(item, Date.now())); })[0];
  if (!job) return result;
  var delay = Math.max(0, job.lastRequestAt + PROMOUSER.orderDelay - Date.now());
  if (delay > PROMOUSER.orderDelay || (delay > 0 && (typeof Utilities === 'undefined' || typeof Utilities.sleep !== 'function'))) return result;
  if (delay > 0) Utilities.sleep(delay);
  return pvAdvance_(context, fileId, { onlyPaymentJobId: job.jobId });
}

/** At most ONE provider operation per invocation; no sleeping and no lock held during HTTP. */
function pvAdvance_(context, fileId, intent) {
  var scope = gridFile_(id_(fileId), true, context.rootId), settings = pvSettings_(scope.context);
  if (!settings.key || !settings.enabled) return pvPublic_(scope.context, pvLedger_(scope.context, fileId, false));
  var initial = pvLedger_(scope.context, fileId, false);
  if (!intent.payJobId && !pvAutomaticHint_(initial, settings).canAutoAdvance && !(intent.manualRefresh && initial && initial.jobs.some(function (job) { return !!job.orderId && !pvJobFinished_(job.state); }))) return pvPublic_(scope.context, initial);
  var claim = locked_(function () {
    var fresh = gridFile_(fileId, true, context.rootId), state = pvLedger_(fresh.context, fileId, false);
    if (!state) return { state: null };
    if (state.lease && state.lease.until > Date.now()) return { state: state };
    delete state.lease;
    var cache = pvCache_(fresh.context, true), cacheMap = pvCacheRead_(cache);
    pvCancelUnsent_(fresh.context, state, cache, cacheMap, null);
    pvCacheFlush_(fresh.context, cache);
    state.jobs.forEach(function (shared) {
      if (shared.state !== 'waiting_shared') return;
      var unresolved = shared.contacts.filter(function (contact) { return !cacheMap[contact.key] || !cacheMap[contact.key].result; });
      if (!unresolved.length) { shared.state = 'complete_shared'; shared.resultCount = shared.contacts.length; shared.completedAt = pvNow_(); shared.message = ''; }
      else if (!unresolved.some(function (contact) { return cacheMap[contact.key] && cacheMap[contact.key].pending && cacheMap[contact.key].pending.jobId !== shared.jobId; })) { shared.contacts = unresolved; shared.state = 'queued'; shared.message = ''; }
    });
    var job = pvChoose_(state, settings, intent, Date.now());
    pvSave_(fresh.context, state);
    if (!job) return { state: state };
    var before = pvTargets_(fresh.context, state, false);
    if ((job.state === 'queued' || job.state === 'awaiting_payment') && !pvContactsStillPresent_(before.rows, job.contacts)) {
      job.state = 'cancelled'; job.message = 'Контакты изменились до отправки или оплаты. Повторите проверку новых контактов.';
      pvCacheRelease_(cache, cacheMap, job.contacts, state.fileId, job.jobId); pvCacheFlush_(fresh.context, cache);
      pvSave_(fresh.context, state); return { state: state };
    }
    var credentialHash = digest_(settings.key);
    if (job.credentialHash && job.credentialHash !== credentialHash) {
      job.message = 'Ключ Promouser изменён. Существующий заказ нужно проверить в исходном аккаунте.'; job.state = 'credential_changed';
      pvSave_(fresh.context, state); return { state: state };
    }
    var action = pvAction_(job, settings, Date.now());
    if (action === 'create') {
      var missing = job.contacts.filter(function (contact) { return !cacheMap[contact.key] || !cacheMap[contact.key].result; });
      if (!missing.length) { job.state = 'complete_shared'; job.resultCount = job.contacts.length; pvSave_(fresh.context, state); return { state: state }; }
      if (missing.some(function (contact) { var entry = cacheMap[contact.key]; return entry && entry.pending && (entry.pending.jobId !== job.jobId || entry.pending.fileId !== state.fileId); })) {
        job.state = 'waiting_shared'; job.message = 'Контакты уже входят в другую проверку. Результат будет использован без повторной оплаты.'; pvSave_(fresh.context, state); return { state: state };
      }
      job.contacts = missing;
    }
    // Cached applications and shared-result reconciliation are local work;
    // only a selected provider operation may require a connection probe.
    var connection = pvConnection_(fresh.context);
    if (!connection || connection.keyHash !== credentialHash) { pvSave_(fresh.context, state); return { state: state, probe: true }; }
    if (action === 'create') {
      missing.forEach(function (contact) { pvCacheReserve_(cache, cacheMap, contact.key, job.kind, { fileId: state.fileId, jobId: job.jobId, keyHash: credentialHash, at: Date.now() }); });
      pvCacheFlush_(fresh.context, cache);
    }
    var token = pvUuid_(); state.lease = { token: token, until: Date.now() + PROMOUSER.leaseMillis };
    job.dispatch = { token: token, action: action, previous: job.state, at: Date.now() };
    job.credentialHash = credentialHash; job.lastRequestAt = Date.now();
    if (action === 'status') job.lastStatusAt = Date.now();
    if (action === 'create') job.state = 'creating';
    if (action === 'pay') { job.state = 'paying'; if (job.manualConsent) job.lastPayRequestId = job.manualConsent.requestId; }
    pvSave_(fresh.context, state);
    return { state: state, job: JSON.parse(JSON.stringify(job)), token: token, action: action, context: fresh.context, requestedPay: !!intent.payJobId };
  });
  if (claim.probe) {
    var probeScope = gridFile_(fileId, true, context.rootId), probeSettings = pvSettings_(probeScope.context);
    if (probeSettings.enabled && probeSettings.key && digest_(probeSettings.key) === digest_(settings.key)) pvProbe_(probeScope.context, probeSettings);
    return pvPublic_(probeScope.context, pvLedger_(probeScope.context, fileId, false));
  }
  if (!claim.job) return pvPublic_(scope.context, claim.state);
  var response, failure = null;
  try {
    gridFile_(fileId, true, context.rootId);
    var dispatchSettings = pvSettings_(authorize_());
    if (!dispatchSettings.enabled) fail_('PV_PAUSED', 'Автоматическая проверка Promouser отключена.');
    if (!dispatchSettings.key || digest_(dispatchSettings.key) !== claim.job.credentialHash) fail_('PV_CREDENTIAL_CHANGED', 'Ключ Promouser изменился перед отправкой запроса.');
    if (claim.action === 'create' && claim.job.kind === 'email' && pvEmailPreferred_(authorize_()) !== 'promouser') fail_('PV_PROVIDER_CHANGED', 'Для новых email выбран другой валидатор.');
    if (claim.action === 'create' && !claim.job.manualStartApproved) fail_('PV_MANUAL_START_REQUIRED', 'Запустите проверку после предпросмотра контактов.');
    var current = pvLedger_(context, fileId, false), currentJob = current && current.jobs.filter(function (item) { return item.jobId === claim.job.jobId; })[0];
    if (!pvLeaseMatches_(current, currentJob, claim.token)) fail_('PV_UNCERTAIN', 'Срок выполнения запроса истёк. Повторное создание или списание отключено.');
    settings = dispatchSettings;
    if (claim.action === 'create') response = pvCreateOrder_(settings, claim.job);
    else if (claim.action === 'pay') response = pvApi_(settings, 'pay', { order_id: claim.job.orderId });
    else if (claim.action === 'status') response = pvApi_(settings, 'status', { order_id: claim.job.orderId });
    else response = pvDownload_(settings, claim.job.resultUrl);
  } catch (error) { failure = error && error.registryCode ? error : registryError_('PV_NETWORK', 'Promouser не подтвердил запрос.'); }
  return locked_(function () {
    var fresh = gridFile_(fileId, true, context.rootId), state = pvLedger_(fresh.context, fileId, false);
    var job = state && state.jobs.filter(function (item) { return item.jobId === claim.job.jobId; })[0];
    if (!pvLeaseMatches_(state, job, claim.token)) fail_('PV_UNCERTAIN', 'Изменилось состояние проверки. Перечитайте таблицу.');
    delete state.lease;
    var currentSettings = pvSettings_(fresh.context);
    if (!currentSettings.key || digest_(currentSettings.key) !== claim.job.credentialHash) {
      if (!failure && claim.action === 'create' && response && pvOrderId_(response.order_id) && Number(response.type) === job.type) job.orderId = String(response.order_id);
      if (!failure && claim.action === 'pay' && response && response.status === 'success' && String(response.order_id) === job.orderId) job.paid = true;
      job.state = 'credential_changed'; job.message = pvFailureMessage_('PV_CREDENTIAL_CHANGED'); pvSave_(fresh.context, state); return pvPublic_(fresh.context, state);
    }
    if (failure) {
      job.state = claim.action === 'create' ? 'creation_uncertain' : (claim.action === 'pay' ? 'payment_uncertain' : claim.job.dispatch.previous);
      if (failure.registryCode === 'PV_PAUSED') job.state = claim.job.dispatch.previous;
      if (failure.registryCode === 'PV_CREDENTIAL_CHANGED') job.state = 'credential_changed';
      if (failure.registryCode === 'PV_PROVIDER_CHANGED' && claim.action === 'create') {
        job.state = 'cancelled'; var cache = pvCache_(fresh.context, true), map = pvCacheRead_(cache); pvCacheRelease_(cache, map, job.contacts, state.fileId, job.jobId); pvCacheFlush_(fresh.context, cache);
      }
      if (claim.action === 'pay' && failure.registryCode === 'PV_FUNDS') { job.state = 'awaiting_payment'; job.blockAutoPay = true; }
      job.message = pvFailureMessage_(failure.registryCode);
      job.lastError = failure.registryCode;
    } else pvAccept_(fresh.context, state, job, claim.action, response);
    pvSave_(fresh.context, state);
    if (claim.requestedPay && job.priceChanged) fail_('PV_COST_CHANGED', 'Promouser изменил стоимость заказа. Подтвердите новую сумму отдельно.');
    return pvPublic_(fresh.context, state);
  });
}

function pvChoose_(state, settings, intent, now) {
  var jobs = state.jobs;
  if (intent.onlyPaymentJobId) {
    var payment = jobs.filter(function (job) { return job.jobId === intent.onlyPaymentJobId; })[0];
    return payment && payment.state === 'awaiting_payment' && pvQuoteFresh_(payment, now) && (pvAutoPay_(payment, settings) || pvHasConsent_(payment, now)) && now - payment.lastRequestAt >= PROMOUSER.orderDelay ? payment : null;
  }
  if (intent.payJobId) {
    var requested = jobs.filter(function (job) { return job.jobId === intent.payJobId; })[0];
    if (requested && intent.requestId && requested.lastPayRequestId === intent.requestId && requested.state !== 'awaiting_payment') return null;
    if (!requested || requested.state !== 'awaiting_payment' || requested.cost === null) fail_('PV_NOT_PAYABLE', 'Заказ ещё не готов к оплате.');
    if (requested.cost !== intent.expectedCost) fail_('PV_COST_CHANGED', 'Стоимость заказа изменилась. Обновите статус перед оплатой.');
    requested.manualConsent = { requestId: intent.requestId, expectedCost: intent.expectedCost, expiresAt: now + PROMOUSER.consentMillis };
    requested.manualStartApproved = true; requested.startApproval = { method: 'pay', requestId: intent.requestId, at: now };
    delete requested.priceChanged;
    if (now - requested.lastRequestAt < PROMOUSER.orderDelay) return null;
    if (!pvQuoteFresh_(requested, now) && now - (requested.lastStatusAt || 0) < PROMOUSER.statusDelay) return null;
    return requested;
  }
  var candidates = [];
  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    if (job.manualConsent && job.manualConsent.expiresAt <= now) delete job.manualConsent;
    if ((job.state === 'creating' || job.state === 'paying') && !state.lease) {
      job.state = job.state === 'creating' ? 'creation_uncertain' : 'payment_uncertain';
      job.message = 'Ответ предыдущего запроса не получен. Автоматический повтор списания или создания заказа отключён.';
    }
    if (job.state === 'queued' && job.manualStartApproved) candidates.push({ job: job, priority: 4 });
    if (job.state === 'result_pending' && now - job.lastRequestAt >= PROMOUSER.orderDelay) candidates.push({ job: job, priority: 0 });
    if (job.state === 'awaiting_payment' && (pvAutoPay_(job, settings) || pvHasConsent_(job, now)) && now - job.lastRequestAt >= PROMOUSER.orderDelay && (pvQuoteFresh_(job, now) || now - (job.lastStatusAt || 0) >= PROMOUSER.statusDelay)) candidates.push({ job: job, priority: pvQuoteFresh_(job, now) ? 3 : 2 });
    if (['awaiting_quote', 'checking', 'payment_uncertain'].indexOf(job.state) !== -1 && now - (job.lastStatusAt || 0) >= PROMOUSER.statusDelay && now - (job.lastRequestAt || 0) >= PROMOUSER.orderDelay) candidates.push({ job: job, priority: job.state === 'awaiting_quote' ? 2 : 1 });
    if (job.state === 'awaiting_payment' && !pvHasConsent_(job, now) && !pvAutoPay_(job, settings) && now - (job.lastStatusAt || 0) >= PROMOUSER.statusDelay && now - (job.lastRequestAt || 0) >= PROMOUSER.orderDelay) candidates.push({ job: job, priority: 9 });
  }
  candidates.sort(function (a, b) { return a.priority - b.priority || (a.job.lastRequestAt || 0) - (b.job.lastRequestAt || 0); });
  return candidates.length ? candidates[0].job : null;
}
function pvQuoteFresh_(job, now) { return Number.isFinite(job.lastQuotedAt) && job.lastQuotedAt <= now && now - job.lastQuotedAt <= PROMOUSER.quoteFreshMillis; }
function pvLeaseMatches_(state, job, token) { return !!state && !!state.lease && state.lease.token === token && state.lease.until > Date.now() && !!job && !!job.dispatch && job.dispatch.token === token; }
function pvAction_(job, settings, now) { return job.state === 'queued' ? 'create' : job.state === 'result_pending' ? 'result' : job.state === 'awaiting_payment' && (pvHasConsent_(job, now) || pvAutoPay_(job, settings)) && pvQuoteFresh_(job, now) ? 'pay' : 'status'; }
function pvHasConsent_(job, now) { return !!job.manualConsent && job.manualConsent.expiresAt > now && job.manualConsent.expectedCost === job.cost; }

function pvAccept_(context, state, job, action, response) {
  job.message = ''; delete job.lastError;
  if (action === 'create') {
    if (!response || !pvOrderId_(response.order_id) || Number(response.type) !== job.type) { job.state = 'creation_uncertain'; job.message = 'Promouser не подтвердил номер созданного заказа. Повторное создание отключено.'; return; }
    job.orderId = String(response.order_id); job.state = 'awaiting_quote'; return;
  }
  if (action === 'pay') {
    if (!response || response.status !== 'success' || String(response.order_id) !== job.orderId || pvMoney_(response.charged) === null) { job.state = 'payment_uncertain'; job.message = 'Оплата не подтверждена. Повторная оплата автоматически не выполняется.'; return; }
    job.paid = true; job.charged = pvMoney_(response.charged); job.state = 'checking'; delete job.blockAutoPay; delete job.manualConsent;
    if (job.cost !== null && job.charged !== job.cost) { job.costWarning = 'Списанная Promouser сумма отличается от расчёта. Автооплата отключена; проверьте заказ.'; context.properties.setProperty(PROMOUSER.limitProperty, '0'); }
    return;
  }
  if (action === 'status') {
    if (!response || String(response.order_id) !== job.orderId || typeof response.status !== 'string') { job.message = 'Получен неполный статус заказа.'; return; }
    var status = response.status, cost = pvMoney_(response.cost); if (cost !== null && /^(?:not_ready|ready)_(?:paid|unpaid)$/.test(status)) { job.cost = cost; job.lastQuotedAt = Date.now(); }
    job.providerStatus = status;
    if (/_paid$/.test(status) && !/_unpaid$/.test(status)) { job.paid = true; job.state = 'checking'; }
    else if (/_unpaid$/.test(status)) {
      job.state = job.cost === null ? 'awaiting_quote' : 'awaiting_payment';
      if (job.manualConsent && job.manualConsent.expectedCost !== job.cost) { delete job.manualConsent; job.priceChanged = true; job.message = 'Стоимость изменилась. Подтвердите новую сумму перед оплатой.'; }
    }
    else { job.message = 'Promouser ещё не вернул поддерживаемый статус. Заказ сохранён.'; return; }
    if (status === 'ready_paid') {
      if (!pvResultUrl_(response.result)) { job.state = 'result_error'; job.message = 'Promouser не вернул безопасную ссылку на результат.'; return; }
      job.resultUrl = response.result; job.state = 'result_pending';
      delete job.manualConsent;
    }
    return;
  }
  var parsed = pvParseResults_(response, job.kind), allowed = Object.create(null), cache = pvCache_(context, true), cacheMap = pvCacheRead_(cache), updates = [];
  job.contacts.forEach(function (contact) { allowed[contact.key] = true; });
  parsed.results.forEach(function (item) {
    var key = pvKey_(job.kind, item.contact);
    if (!allowed[key]) return;
    item.orderId = job.orderId; item.checkedAt = pvNow_();
    pvCachePut_(context, cache, cacheMap, key, job.kind, item);
  });
  var current = pvTargets_(context, state, false);
  current.rows.forEach(function (row) {
    if ((!row.completed || row.changed) && allowed[row.key] && cacheMap[row.key] && cacheMap[row.key].result) updates.push({ row: row, result: cacheMap[row.key].result });
  });
  state.pendingApplications = Math.max(state.pendingApplications || 0, updates.length - PROMOUSER.applyRows);
  pvCacheFlush_(context, cache); pvApply_(context, state, updates.slice(0, PROMOUSER.applyRows));
  var found = job.contacts.filter(function (contact) { return !!(cacheMap[contact.key] && cacheMap[contact.key].result); }).length;
  job.completedAt = pvNow_(); job.resultCount = found;
  job.state = found === job.contacts.length ? 'complete' : 'result_review';
  job.message = found === job.contacts.length ? '' : 'Не все строки результата однозначно сопоставлены. Повторная платная проверка отключена; проверьте результат заказа.';
  job.parseWarnings = parsed.warnings;
}

function pvTargets_(context, state, ensure) {
  gridFile_(state.fileId, !!ensure, context.rootId);
  var book = SpreadsheetApp.openById(state.fileId), targets = state.targets || {}, sheets = book.getSheets();
  function byId(value) { return sheets.filter(function (sheet) { return String(sheet.getSheetId()) === String(value); })[0]; }
  var email = byId(targets.emailSheetId), phone = byId(targets.phoneSheetId);
  if (!email || !phone || email.getSheetId() === phone.getSheetId()) fail_('PV_TARGETS_REQUIRED', 'Сначала распределите контакты на вкладки Email и Телефоны.');
  var rows = [], layout = [];
  [{ sheet: email, kind: 'email', wanted: PROMOUSER.emailHeaders }, { sheet: phone, kind: 'telegram', wanted: PROMOUSER.phoneHeaders }].forEach(function (entry) {
    var sheet = entry.sheet, usedRows = sheet.getLastRow(), width = sheet.getLastColumn();
    if (usedRows > PROMOUSER.maxRows || width > PROMOUSER.maxColumns) fail_('PV_LIMIT', 'Таблица контактов превышает лимит одной проверки.');
    var headers = width ? sheet.getRange(1, 1, 1, width).getDisplayValues()[0].map(String) : [], map = pvHeaderMap_(headers);
    var missing = entry.wanted.filter(function (name) { return map[pvHeader_(name)] === undefined; });
    if (ensure && missing.length) {
      var before = headers.length; headers = headers.concat(missing);
      if (headers.length > PROMOUSER.maxColumns) fail_('PV_LIMIT', 'Недостаточно места для колонок проверки.');
      pvEnsureGrid_(sheet, 1, headers.length);
      sheetWriteRawStrings_(state.fileId, sheet.getSheetId(), 1, before + 1, [missing]);
      map = pvHeaderMap_(headers); width = headers.length;
    }
    var emailColumn = pvFindHeader_(map, ['email', 'e-mail', 'почта']), phoneColumn = pvFindHeader_(map, ['телефон', 'phone', 'mobile']), telegramColumn = pvFindHeader_(map, ['telegram', 'телеграм']);
    var statusColumn = map[pvHeader_('Валидация')], count = Math.max(0, usedRows - 1);
    var values = count ? sheet.getRange(2, 1, count, width).getDisplayValues() : [];
    var notes = count && statusColumn !== undefined && typeof sheet.getRange(2, statusColumn + 1, count, 1).getNotes === 'function' ? sheet.getRange(2, statusColumn + 1, count, 1).getNotes() : Array.from({ length: count }, function () { return ['']; });
    layout.push({ sheet: sheet, map: map, width: width, kind: entry.kind });
    values.forEach(function (line, index) {
      var value = '', kind = entry.kind, country = '', rawValue = '';
      if (kind === 'email') { rawValue = emailColumn === undefined ? '' : String(line[emailColumn] || '').trim(); value = pvEmail_(rawValue); }
      else {
        rawValue = phoneColumn === undefined ? '' : String(line[phoneColumn] || '').trim(); value = pvPhone_(rawValue);
        if (value) country = pvCountry_(value);
        else { var rawTelegram = telegramColumn === undefined ? '' : String(line[telegramColumn] || '').trim(); value = pvUsername_(rawTelegram); kind = value ? 'telegram_username' : kind; rawValue = rawValue || rawTelegram; }
      }
      if (!value && !rawValue) return;
      var invalid = !value; if (invalid) value = rawValue;
      var key = pvKey_(kind, value), note = String(notes[index] && notes[index][0] || ''), bound = pvBinding_(note), status = String(line[statusColumn] || '').trim();
      var changed = !!bound && bound !== key, completed = !!status && !pvPendingStatus_(status);
      var legacy = !bound && !status ? pvLegacyResult_(kind, line, map) : null;
      if (legacy) { completed = true; status = legacy.status; }
      rows.push({ fileId: state.fileId, sheetId: sheet.getSheetId(), row: index + 2, value: value, key: key, kind: kind, country: country, invalid: invalid, map: map, status: status, note: note, bound: bound, changed: changed, completed: completed, legacyResult: legacy, values: line });
    });
  });
  return { rows: rows, layout: layout };
}

function pvApply_(context, state, updates) {
  if (!updates.length) return;
  gridFile_(state.fileId, true, context.rootId);
  if (updates.some(function (update) { return update.row.kind === 'email' && update.result && update.result.validator === 'coldy'; })) {
    var book = SpreadsheetApp.openById(state.fileId), sheet = book.getSheets().filter(function (item) { return String(item.getSheetId()) === String(state.targets.emailSheetId); })[0];
    if (!sheet) fail_('PV_TARGETS_REQUIRED', 'Вкладка Email изменилась. Обновите контакты.');
    var width = sheet.getLastColumn(), headers = width ? sheet.getRange(1, 1, 1, width).getDisplayValues()[0] : [], map = pvHeaderMap_(headers);
    var missing = ['Валидатор', 'Проверка Coldy'].filter(function (header) { return map[pvHeader_(header)] === undefined; });
    if (missing.length) { if (width + missing.length > PROMOUSER.maxColumns) fail_('PV_LIMIT', 'Недостаточно места для колонок проверки.'); pvEnsureGrid_(sheet, 1, width + missing.length); sheetWriteRawStrings_(state.fileId, sheet.getSheetId(), 1, width + 1, [missing]); }
  }
  var current = pvTargets_(context, state, false), byLocation = Object.create(null), cells = [], requests = [];
  current.rows.forEach(function (row) { byLocation[row.sheetId + ':' + row.row] = row; });
  updates.forEach(function (update) {
    var wanted = update.row, row = byLocation[wanted.sheetId + ':' + wanted.row];
    if (!row || row.key !== wanted.key || (row.completed && !row.changed)) return;
    var fields = pvUpdateFields_(row, update);
    Object.keys(fields).forEach(function (header) {
      var column = row.map[pvHeader_(header)]; if (column === undefined) return;
      var cell = { userEnteredValue: { stringValue: String(fields[header] === null || fields[header] === undefined ? '' : fields[header]) } }, mask = 'userEnteredValue';
      if (header === 'Валидация') { cell.note = pvBoundNote_(row.note, row.key); mask += ',note'; }
      if (String(row.values[column] || '') === cell.userEnteredValue.stringValue && (header !== 'Валидация' || cell.note === row.note)) return;
      cells.push({ sheetId: row.sheetId, row: row.row, column: column, fields: mask, cell: cell });
    });
  });
  cells.sort(function (a, b) { return a.sheetId - b.sheetId || a.column - b.column || a.fields.localeCompare(b.fields) || a.row - b.row; });
  cells.forEach(function (entry) {
    var last = requests[requests.length - 1], update = last && last.updateCells;
    if (update && update.range.sheetId === entry.sheetId && update.range.startColumnIndex === entry.column && update.fields === entry.fields && update.range.endRowIndex === entry.row - 1) {
      update.range.endRowIndex++; update.rows.push({ values: [entry.cell] });
    } else requests.push({ updateCells: { range: { sheetId: entry.sheetId, startRowIndex: entry.row - 1, endRowIndex: entry.row, startColumnIndex: entry.column, endColumnIndex: entry.column + 1 }, rows: [{ values: [entry.cell] }], fields: entry.fields } });
  });
  if (!requests.length) return;
  if (requests.length > 10000) fail_('PV_LIMIT', 'Слишком много обновлений проверки за один шаг.');
  gridFile_(state.fileId, true, context.rootId); SpreadsheetApp.flush();
  try { Sheets.Spreadsheets.batchUpdate({ requests: requests }, state.fileId); }
  catch (error) { fail_('PV_RESULT_WRITE', 'Результат проверки сохранён в служебном журнале, но Google не подтвердил запись в строки. Повторите обновление статуса.'); }
}

function pvUpdateFields_(row, update) {
  var fields = update.result ? pvResultCells_(row.kind, update.result) : { 'Валидация': update.pending || 'Ожидает проверки', 'Дата проверки': '', 'Результат проверки': update.details || '', 'Заказ Promouser': '' };
  if (row.kind === 'email' && update.result && !update.result.provider && !row.changed) delete fields['Провайдер'];
  if (row.changed) (row.kind === 'email' ? PROMOUSER.emailHeaders.concat(['Валидатор', 'Проверка Coldy']) : PROMOUSER.phoneHeaders).forEach(function (header) { if (!Object.prototype.hasOwnProperty.call(fields, header)) fields[header] = ''; });
  return fields;
}
function pvNeedsUpdate_(row, update) {
  var fields = pvUpdateFields_(row, update);
  return Object.keys(fields).some(function (header) { var column = row.map[pvHeader_(header)]; if (column === undefined) return false; return String(row.values[column] || '') !== String(fields[header] === null || fields[header] === undefined ? '' : fields[header]) || header === 'Валидация' && row.note !== pvBoundNote_(row.note, row.key); });
}

function pvResultCells_(kind, result) {
  var fields = { 'Валидация': result.review === true ? 'Проверить историю контакта' : result.status, 'Дата проверки': result.checkedAt || '', 'Результат проверки': result.raw || '', 'Заказ Promouser': result.orderId || '' };
  if (kind === 'email') { fields['Провайдер'] = result.provider || ''; fields['Валидатор'] = result.validator || 'promouser'; fields['Проверка Coldy'] = result.verificationBatchId || ''; if (result.validator === 'coldy') fields['Заказ Promouser'] = ''; }
  else {
    fields.ID_TG = result.idTg || ''; fields.Nickname_TG = result.nickname || '';
    fields.Active_days_ago = result.days === null || result.days === undefined ? '' : String(result.days);
    fields['Для Telegram'] = result.review === true ? 'Нужна проверка' : result.eligible === true ? 'Да' : result.eligible === false ? 'Нет' : 'Нужна проверка';
  }
  return fields;
}

function pvResultFromRow_(row) {
  if (!row.completed || row.changed) return null;
  if (row.legacyResult) { var legacy = row.legacyResult; if (pvHistoryReview_(legacy.raw, row.status)) { var reviewed = {}; Object.keys(legacy).forEach(function (key) { reviewed[key] = legacy[key]; }); reviewed.review = true; return reviewed; } return legacy; }
  function value(header) { var i = row.map[pvHeader_(header)]; return i === undefined ? '' : String(row.values[i] || ''); }
  var days = pvDays_(value('Active_days_ago')), idTg = value('ID_TG');
  var validator = value('Валидатор').toLowerCase();
  return { status: row.status, checkedAt: value('Дата проверки'), raw: value('Результат проверки'), provider: value('Провайдер'), orderId: validator === 'coldy' ? '' : value('Заказ Promouser'), validator: validator, verificationBatchId: value('Проверка Coldy'), review: pvHistoryReview_(value('Результат проверки'), row.status), idTg: idTg, nickname: value('Nickname_TG'), days: days, eligible: row.kind === 'email' ? null : (!!idTg && days !== null ? days <= 30 : null), imported: true };
}
function pvHistoryReview_(raw, status) {
  if (String(status || '').trim().toLowerCase() === 'проверить историю контакта') return true;
  var match = String(raw || '').match(/^legacy-?history:v1:([\s\S]*)$/); if (!match) return false;
  try { var history = JSON.parse(match[1]); return !!history && (history.conflict === true || Array.isArray(history.work) && history.work.length > 0); }
  catch (error) { return true; }
}

/** Recognize an existing provider report without adding a new verdict to its row. */
function pvLegacyResult_(kind, values, map) {
  function pick(names) { for (var i = 0; i < names.length; i++) { var column = map[pvHeader_(names[i])]; if (column !== undefined && values[column] !== null && values[column] !== undefined && String(values[column]).trim() !== '') return String(values[column]).trim(); } return ''; }
  var raw = pick(['Результат проверки', 'Результат валидации', 'Validation result', 'email_status']), date = pick(['Дата проверки', 'checked_at', 'validation_date']);
  var provider = pick(['Провайдер', 'provider']), idTg = pick(['ID_TG', 'Telegram ID']), days = pvDays_(pick(['Active_days_ago', 'days_offline'])), nickname = pick(['Nickname_TG', 'TG username']);
  if (kind === 'email') {
    if (!raw && provider) raw = pick(['result', 'status']);
    if (!raw && !date) return null;
    return { status: pvEmailStatus_(raw), raw: raw, checkedAt: date, provider: provider, orderId: '', imported: true };
  }
  if (!raw && (map[pvHeader_('ID_TG')] !== undefined || map[pvHeader_('Active_days_ago')] !== undefined)) raw = pick(['result', 'статус проверки']);
  if (!/^[1-9]\d*$/.test(idTg) && days === null && !raw && !date) return null;
  if (!/^[1-9]\d*$/.test(idTg)) idTg = '';
  var eligible = idTg && days !== null ? days <= 30 : null;
  return { status: idTg ? days === null ? 'Telegram: активность скрыта' : eligible ? 'Telegram: активен' : 'Telegram: более 30 дней офлайн' : 'Telegram не подтверждён', raw: raw, checkedAt: date, provider: '', orderId: '', idTg: idTg, nickname: nickname, days: days, eligible: eligible, imported: true };
}

function pvSettings_(context) {
  var props = context.properties, key = props.getProperty(PROMOUSER.keyProperty) || '', limit = pvMoney_(props.getProperty(PROMOUSER.limitProperty) || '0');
  return { key: key, enabled: props.getProperty(PROMOUSER.enabledProperty) === 'true', autoPayLimitUsd: limit === null ? 0 : limit };
}
function pvSettingsPublic_(settings) { return { configured: !!settings.key, enabled: settings.enabled, autoPayLimitUsd: settings.autoPayLimitUsd, mode: 'direct', services: { email: 17, telegram: 6 }, minimumStatusIntervalSeconds: 15 }; }
function pvRequireKey_(settings) { if (!settings.key) fail_('PV_KEY_REQUIRED', 'Подключите API-ключ Promouser в настройках.'); }
function pvConnection_(context) { try { return JSON.parse(context.properties.getProperty(PROMOUSER.connectionProperty) || 'null'); } catch (error) { return null; } }
function pvProbe_(context, settings) {
  var response = pvApi_(settings, 'balance', null), balance = response && pvMoney_(response.balance);
  if (balance === null || balance === undefined) fail_('PV_RESPONSE', 'Promouser не подтвердил баланс аккаунта.');
  authorize_(); context.properties.setProperty(PROMOUSER.connectionProperty, JSON.stringify({ keyHash: digest_(settings.key), at: pvNow_() }));
  return { balance: balance, currency: 'USD' };
}

function pvApi_(settings, operation, payload) {
  pvRequireKey_(settings);
  if (['balance', 'order', 'status', 'pay'].indexOf(operation) === -1) fail_('INVALID_REQUEST', 'Неподдерживаемое действие Promouser.');
  var address = PROMOUSER.base + '/api/' + operation, options = { method: operation === 'balance' || operation === 'status' ? 'get' : 'post', headers: { key: settings.key }, muteHttpExceptions: true, followRedirects: false };
  if (operation === 'status') { if (!payload || !pvOrderId_(payload.order_id)) fail_('INVALID_REQUEST', 'Некорректный номер проверки.'); address += '?order_id=' + encodeURIComponent(String(payload.order_id)); }
  if (operation === 'pay') { options.contentType = 'application/json'; options.payload = JSON.stringify({ order_id: String(payload.order_id) }); }
  if (operation === 'order') options.payload = payload;
  var response = pvFetch_(address, options), status = response.getResponseCode(), parsed;
  try { parsed = JSON.parse(response.getContentText()); } catch (error) { fail_('PV_RESPONSE', 'Promouser вернул неподдерживаемый ответ.'); }
  if (status < 200 || status >= 300 || !parsed || typeof parsed !== 'object' || parsed.error) pvProviderFailure_(status, parsed && parsed.error);
  return parsed;
}
function pvCreateOrder_(settings, job) {
  var values = job.contacts.map(function (item) { return job.kind === 'email' ? item.value : item.value.replace(/^\+/, ''); });
  var blob = Utilities.newBlob(values.join('\n') + '\n', 'text/plain', job.kind === 'email' ? 'emails.txt' : 'phones.txt');
  return pvApi_(settings, 'order', { file: blob, type: String(job.type) });
}
function pvFetch_(address, options) {
  authorize_();
  try { return UrlFetchApp.fetch(address, options); }
  catch (error) {
    var message = String(error && error.message || '');
    if (/required permissions|authorization is required|do not have permission|not authorized/i.test(message)) fail_('PV_OWNER_AUTH_REQUIRED', 'Владельцу Apps Script нужно один раз разрешить внешние запросы Promouser.');
    fail_('PV_NETWORK', 'Нет подтверждения ответа Promouser. Проверьте подключение и разрешённые IP.');
  }
}
function pvProviderFailure_(status, providerError) {
  var text = typeof providerError === 'string' ? providerError : '';
  if (/insufficient funds/i.test(text)) fail_('PV_FUNDS', 'На балансе Promouser недостаточно средств.');
  if (/order not ready|has no price/i.test(text)) fail_('PV_NOT_PAYABLE', 'Promouser ещё рассчитывает стоимость заказа.');
  if (status === 401 || /invalid.*key|unauthorized|api.?key/i.test(text)) fail_('PV_AUTH', 'Promouser не принял API-ключ.');
  if (status === 403) fail_('PV_IP_DENIED', 'Promouser отклонил доступ. Проверьте разрешение для IP Google Apps Script.');
  if (status === 429) fail_('PV_RATE_LIMIT', 'Promouser просит снизить частоту запросов. Повторите обновление позже.');
  fail_('PV_PROVIDER', 'Promouser не подтвердил действие. Заказ сохранён без повторного списания.');
}
function pvResultUrl_(value) { return typeof value === 'string' && /^https:\/\/promouser\.com\/results\/[A-Za-z0-9_./%-]+(?:\?[A-Za-z0-9_=&%-]*)?$/.test(value) && value.indexOf('..') === -1 && !/%2e|%2f|%5c/i.test(value); }
function pvDownload_(settings, url) {
  if (!pvResultUrl_(url)) fail_('PV_RESULT_URL', 'Ссылка на результат не относится к Promouser.');
  var response = pvFetch_(url, { method: 'get', headers: { key: settings.key }, muteHttpExceptions: true, followRedirects: false });
  if (response.getResponseCode() !== 200) fail_('PV_RESULT_DOWNLOAD', 'Promouser пока не отдал результат проверки.');
  var text = response.getContentText();
  if (typeof text !== 'string' || text.length > 8000000) fail_('PV_RESULT_FORMAT', 'Результат проверки слишком большой или недоступен.');
  return text;
}

function pvParseResults_(text, kind) {
  var warnings = [], objects = null;
  if (typeof text !== 'string') text = JSON.stringify(text);
  text = text.replace(/^\uFEFF/, '').trim();
  if (!text) return { results: [], warnings: ['Promouser вернул пустой результат.'] };
  if (/^[\[{]/.test(text)) {
    try { var parsed = JSON.parse(text); objects = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.results) ? parsed.results : (Array.isArray(parsed.data) ? parsed.data : null)); } catch (error) { /* CSV fallback below. */ }
  }
  if (!objects) {
    var first = text.split(/\r?\n/, 1)[0], separators = ['\t', ';', ',', '|'];
    separators.sort(function (a, b) { return pvSplit_(first, b).length - pvSplit_(first, a).length; });
    var rows = pvDelimited_(text, separators[0]), headers = rows.shift() || [], keys = headers.map(pvHeader_);
    var contact = pvFindResultHeader_(keys, kind === 'email' ? ['email', 'почта', 'emailaddress', 'адрес', 'e-mail'] : ['phone', 'telephone', 'mobile', 'телефон', 'номер', 'номер телефона', 'msisdn']);
    if (contact < 0) return { results: [], warnings: ['В результате не найден столбец с исходным email или телефоном. Автоматическое сопоставление по порядку строк не выполняется.'] };
    objects = rows.map(function (row) { var object = {}; headers.forEach(function (header, index) { object[header] = row[index] === undefined ? '' : row[index]; }); return object; });
  }
  var results = [], seen = Object.create(null);
  objects.forEach(function (object) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return;
    var mapped = {}; Object.keys(object).forEach(function (key) { mapped[pvHeader_(key)] = object[key]; });
    function pick(names) { for (var i = 0; i < names.length; i++) { var key = pvHeader_(names[i]); if (Object.prototype.hasOwnProperty.call(mapped, key) && mapped[key] !== null && mapped[key] !== undefined && String(mapped[key]).trim() !== '') return mapped[key]; } return ''; }
    var contact = kind === 'email' ? pvEmail_(pick(['email', 'почта', 'emailaddress', 'адрес'])) : pvPhone_(pick(['phone', 'telephone', 'mobile', 'телефон', 'номер', 'номер телефона', 'msisdn']));
    if (!contact) return;
    var result = { contact: contact, status: 'Неизвестно', raw: '', provider: '', checkedAt: '', orderId: '', idTg: '', nickname: '', days: null, eligible: null };
    if (kind === 'email') {
      result.raw = pvSafeText_(pick(['status', 'result', 'validationresult', 'результат валидации', 'результат', 'статус']), 1000);
      result.provider = pvSafeText_(pick(['provider', 'провайдер', 'emailprovider', 'mailprovider']), 500);
      result.status = pvEmailStatus_(result.raw);
    } else {
      result.idTg = pvSafeText_(pick(['ID_TG', 'tg_id', 'telegramid', 'idtelegram']), 100);
      if (!/^[1-9]\d*$/.test(result.idTg)) result.idTg = '';
      result.nickname = pvSafeText_(pick(['Nickname_TG', 'nickname', 'username', 'tgusername']), 100);
      result.days = pvDays_(pick(['Active_days_ago', 'days_offline', 'daysago', 'дней офлайн', 'сколько дней оффлайн']));
      result.raw = pvSafeText_(pick(['status', 'result', 'статус', 'результат']), 1000);
      if (result.idTg && result.days !== null) { result.eligible = result.days <= 30; result.status = result.eligible ? 'Telegram: активен' : 'Telegram: более 30 дней офлайн'; }
      else if (result.idTg) result.status = 'Telegram: активность скрыта';
      else if (/^(?:no|false|not.?registered|нет|не.?зарегистрирован)$/i.test(result.raw.trim())) { result.status = 'Нет Telegram'; result.eligible = false; }
      else result.status = 'Telegram не подтверждён';
    }
    var identity = pvKey_(kind, contact);
    if (seen[identity]) {
      var previous = results[seen[identity] - 1];
      if (JSON.stringify(previous) !== JSON.stringify(result)) { previous.status = 'Неизвестно'; previous.raw = 'В ответе противоречивые строки для одного контакта.'; previous.eligible = null; warnings.push('В результате есть противоречивые дубли.'); }
    } else { seen[identity] = results.length + 1; results.push(result); }
  });
  if (!results.length) warnings.push('Не удалось однозначно прочитать контакты и статусы результата.');
  return { results: results, warnings: warnings };
}

function pvDelimited_(text, separator) {
  var rows = [], row = [], value = '', quoted = false;
  for (var i = 0; i < text.length; i++) {
    var c = text.charAt(i);
    if (c === '"') { if (quoted && text.charAt(i + 1) === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === separator && !quoted) { row.push(value); value = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && text.charAt(i + 1) === '\n') i++; row.push(value); if (row.some(function (cell) { return cell.trim() !== ''; })) rows.push(row); row = []; value = ''; }
    else value += c;
  }
  row.push(value); if (row.some(function (cell) { return cell.trim() !== ''; })) rows.push(row);
  return rows;
}
function pvSplit_(value, separator) { return pvDelimited_(value, separator)[0] || []; }
function pvFindResultHeader_(keys, names) { for (var i = 0; i < names.length; i++) { var at = keys.indexOf(pvHeader_(names[i])); if (at >= 0) return at; } return -1; }
function pvEmailStatus_(value) {
  var text = String(value || '').trim().toLowerCase();
  if (/^(?:valid|deliverable|ok|good|true|yes|да|валиден|валидный|действителен)$/.test(text)) return 'Валиден';
  if (/^(?:invalid|undeliverable|bad|not.?exist|false|no|нет|невалиден|невалидный|не.?существует)$/.test(text)) return 'Невалиден';
  if (/^(?:risky|catch.?all|accept.?all|disposable|рискованный)$/.test(text)) return 'Рискованный';
  return 'Неизвестно';
}
function pvDays_(value) { if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null; var text = String(value).trim(); return /^\d+(?:\.\d+)?$/.test(text) && Number(text) <= 100000 ? Number(text) : null; }

function pvLedger_(context, fileId, create) {
  var metadata = Drive.Files.get(fileId, { fields: 'id,appProperties', supportsAllDrives: true }), tags = metadata.appProperties || {}, stateId = tags.registryValidationStateId;
  if (stateId) {
    var file = pvStateFile_(context, stateId, fileId), text = DriveApp.getFileById(file.id).getBlob().getDataAsString();
    if (text.length > PROMOUSER.maxLedgerCharacters) fail_('PV_LIMIT', 'Журнал проверки слишком большой.');
    var state; try { state = JSON.parse(text); } catch (error) { fail_('PV_STORAGE', 'Журнал проверки повреждён.'); }
    if (!state || state.version !== PROMOUSER.version || state.rootId !== context.rootId || state.fileId !== fileId || !Array.isArray(state.jobs)) fail_('PV_STORAGE', 'Журнал проверки не принадлежит этой базе.');
    state.stateId = file.id; return state;
  }
  if (!create) return null;
  var folderId = pvFolder_(context), state = { version: PROMOUSER.version, rootId: context.rootId, fileId: fileId, stateId: '', targets: {}, jobs: [], createdAt: pvNow_() };
  var file = Drive.Files.create({ name: '.validation-' + fileId + '.json', mimeType: 'application/json', parents: [folderId], appProperties: { registryValidationRoot: context.rootId, registryValidationBook: fileId, registryPrivateRole: 'validation_state' } }, Utilities.newBlob(JSON.stringify(state), 'application/json', 'validation.json'), { fields: 'id', supportsAllDrives: true });
  state.stateId = id_(file.id);
  var next = {}; Object.keys(tags).forEach(function (key) { next[key] = tags[key]; }); next.registryValidationStateId = state.stateId; next.registryValidationRoot = context.rootId;
  gridFile_(fileId, true, context.rootId);
  Drive.Files.update({ appProperties: next }, fileId, null, { fields: 'id', supportsAllDrives: true });
  pvSave_(context, state); return state;
}
function pvSave_(context, state) {
  gridFile_(state.fileId, true, context.rootId); pvStateFile_(context, state.stateId, state.fileId);
  if (state.jobs.length > 300) {
    var cutoff = state.jobs.length - 100;
    state.jobs = state.jobs.filter(function (job, index) { return index >= cutoff || ['complete', 'complete_shared', 'cancelled'].indexOf(job.state) === -1; });
  }
  var text = JSON.stringify(state); if (text.length > PROMOUSER.maxLedgerCharacters) fail_('PV_LIMIT', 'Журнал проверки слишком большой.');
  Drive.Files.update({}, state.stateId, Utilities.newBlob(text, 'application/json', 'validation.json'), { fields: 'id', supportsAllDrives: true });
}
function pvStateFile_(context, stateId, fileId) {
  var folderId = pvFolder_(context, false), file = Drive.Files.get(id_(stateId), { fields: 'id,mimeType,parents,trashed,appProperties', supportsAllDrives: true }), tags = file.appProperties || {};
  if (file.trashed || file.mimeType !== 'application/json' || !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== folderId || tags.registryPrivateRole !== 'validation_state' || tags.registryValidationRoot !== context.rootId || tags.registryValidationBook !== fileId) fail_('PV_STORAGE', 'Журнал проверки был перемещён или не принадлежит базе.');
  return file;
}
function pvFolder_(context, create) {
  var configured = context.properties.getProperty(PROMOUSER.folderProperty), folder;
  if (configured) folder = Drive.Files.get(id_(configured), { fields: 'id,mimeType,parents,trashed,appProperties', supportsAllDrives: true });
  else {
    var found = Drive.Files.list({ q: "trashed=false and '" + context.rootId + "' in parents and appProperties has { key='registryPrivateRole' and value='validation_folder' }", fields: 'files(id,mimeType,parents,trashed,appProperties),nextPageToken', pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true });
    if (found.nextPageToken || (found.files || []).length > 1) fail_('PV_STORAGE', 'Найдено несколько служебных папок проверки.');
    folder = (found.files || [])[0];
    if (!folder && create !== false) folder = Drive.Files.create({ name: '_Проверка контактов', mimeType: 'application/vnd.google-apps.folder', parents: [context.rootId], appProperties: { registryPrivateRole: 'validation_folder', registryValidationRoot: context.rootId } }, null, { fields: 'id,mimeType,parents,trashed,appProperties', supportsAllDrives: true });
  }
  var tags = folder && folder.appProperties || {};
  if (!folder || folder.trashed || folder.mimeType !== 'application/vnd.google-apps.folder' || !folder.parents || folder.parents.length !== 1 || folder.parents[0] !== context.rootId || tags.registryPrivateRole !== 'validation_folder' || tags.registryValidationRoot !== context.rootId) fail_('PV_STORAGE', 'Служебная папка проверки находится вне корня реестра.');
  if (create !== false) context.properties.setProperty(PROMOUSER.folderProperty, folder.id); return folder.id;
}
function pvUpdateTargets_(state, options) {
  if (options.emailSheetId !== undefined && options.phoneSheetId !== undefined) {
    if (!Number.isSafeInteger(options.emailSheetId) || !Number.isSafeInteger(options.phoneSheetId) || options.emailSheetId < 0 || options.phoneSheetId < 0 || options.emailSheetId === options.phoneSheetId) fail_('PV_TARGETS_REQUIRED', 'Некорректные вкладки контактов.');
    state.targets = { emailSheetId: options.emailSheetId, phoneSheetId: options.phoneSheetId };
  } else if ((!state.targets || state.targets.emailSheetId === undefined) && typeof getContactWorkspace_ === 'function') {
    var workspace = getContactWorkspace_({ id: state.fileId }); if (workspace && workspace.targets) state.targets = workspace.targets;
  }
}

function pvCache_(context, create) {
  var storage = sourceBasesStorage_(context), sheet = storage.book.getSheetByName(PROMOUSER.cacheTab);
  if (!sheet && create) { sheet = storage.book.insertSheet(PROMOUSER.cacheTab); pvEnsureGrid_(sheet, 1, PROMOUSER.cacheHeaders.length); sheetWriteRawStrings_(storage.public.id, sheet.getSheetId(), 1, 1, [PROMOUSER.cacheHeaders.slice()]); sheet.setFrozenRows(1); }
  if (!sheet) return null;
  var headers = sheet.getRange(1, 1, 1, PROMOUSER.cacheHeaders.length).getDisplayValues()[0];
  if (JSON.stringify(headers) !== JSON.stringify(PROMOUSER.cacheHeaders)) fail_('PV_STORAGE', 'Формат общего журнала проверок изменён.');
  return { id: storage.public.id, sheet: sheet };
}
function pvCacheRead_(cache) {
  var map = Object.create(null); if (!cache) return map;
  var count = cache.sheet.getLastRow() - 1; if (count > PROMOUSER.maxCacheRows) fail_('PV_LIMIT', 'Общий журнал проверок превышает лимит.');
  cache.nextRow = count + 2; cache.writes = Object.create(null);
  var rows = count > 0 ? cache.sheet.getRange(2, 1, count, PROMOUSER.cacheHeaders.length).getDisplayValues() : [];
  rows.forEach(function (row, index) {
    if (!row[0]) return;
    if (!/^[A-Za-z0-9_-]{43}$/.test(row[0]) || map[row[0]]) fail_('PV_STORAGE', 'В журнале проверок есть повторяющиеся ключи.');
    var details; try { details = JSON.parse(row[7] || '{}'); } catch (error) { fail_('PV_STORAGE', 'Повреждён результат проверки.'); }
    map[row[0]] = details.pending ? { row: index + 2, kind: row[1], details: details, pending: details.pending, result: null } : { row: index + 2, kind: row[1], details: details, result: { status: row[2], checkedAt: row[3], raw: row[4], provider: row[5], orderId: details.validator === 'coldy' ? '' : row[6], validator: details.validator || '', verificationBatchId: details.verificationBatchId || '', review: details.review === true, idTg: details.idTg || '', nickname: details.nickname || '', days: details.days === undefined ? null : details.days, eligible: typeof details.eligible === 'boolean' ? details.eligible : null } };
  });
  return map;
}
function pvCachePut_(context, cache, map, key, kind, result) {
  if (map[key] && map[key].result) {
    if (result.review !== true || map[key].result.review === true) return;
    var merged = {}; Object.keys(map[key].result).forEach(function (name) { merged[name] = map[key].result[name]; }); merged.review = true; result = merged; kind = map[key].kind;
  }
  if (result.validator === 'coldy' && result.orderId) { var normalized = {}; Object.keys(result).forEach(function (name) { normalized[name] = result[name]; }); normalized.orderId = ''; result = normalized; }
  var row = map[key] ? map[key].row : cache.nextRow++; if (row > PROMOUSER.maxCacheRows + 1) fail_('PV_LIMIT', 'Общий журнал проверок заполнен.');
  var details = {}; if (map[key] && map[key].details) Object.keys(map[key].details).forEach(function (name) { if (name !== 'pending') details[name] = map[key].details[name]; });
  details.validator = result.validator || ''; details.verificationBatchId = result.verificationBatchId || ''; details.review = result.review === true; details.idTg = result.idTg || ''; details.nickname = result.nickname || ''; details.days = result.days === undefined ? null : result.days; details.eligible = result.eligible === true ? true : result.eligible === false ? false : null;
  var values = [key, kind, result.status, result.checkedAt || '', result.raw || '', result.provider || '', result.validator === 'coldy' ? '' : result.orderId || '', JSON.stringify(details)];
  cache.writes[row] = values;
  map[key] = { row: row, kind: kind, details: details, result: result };
}
function pvCacheReserve_(cache, map, key, kind, owner) {
  if (map[key]) return;
  var row = cache.nextRow++; if (row > PROMOUSER.maxCacheRows + 1) fail_('PV_LIMIT', 'Общий журнал проверок заполнен.');
  cache.writes[row] = [key, kind, 'Ожидает проверки', '', '', '', '', JSON.stringify({ pending: owner })];
  map[key] = { row: row, kind: kind, result: null, pending: owner };
}
function pvCacheRelease_(cache, map, contacts, fileId, jobId) {
  contacts.forEach(function (contact) {
    var entry = map[contact.key];
    if (entry && entry.pending && entry.pending.fileId === fileId && entry.pending.jobId === jobId) {
      cache.writes[entry.row] = PROMOUSER.cacheHeaders.map(function () { return ''; }); delete map[contact.key];
    }
  });
}
function pvCacheFlush_(context, cache) {
  var indexes = Object.keys(cache.writes || {}).map(Number).sort(function (a, b) { return a - b; });
  if (!indexes.length) return;
  sourceBasesStorage_(context); pvEnsureGrid_(cache.sheet, indexes[indexes.length - 1], PROMOUSER.cacheHeaders.length);
  var groups = [];
  indexes.forEach(function (row) { var group = groups[groups.length - 1]; if (!group || group[group.length - 1] + 1 !== row || group.length >= 3000) { group = []; groups.push(group); } group.push(row); });
  var requests = groups.map(function (group) { return { updateCells: { range: { sheetId: cache.sheet.getSheetId(), startRowIndex: group[0] - 1, endRowIndex: group[group.length - 1], startColumnIndex: 0, endColumnIndex: PROMOUSER.cacheHeaders.length }, rows: group.map(function (row) { return { values: cache.writes[row].map(function (text) { return { userEnteredValue: { stringValue: String(text) } }; }) }; }), fields: 'userEnteredValue' } }; });
  SpreadsheetApp.flush();
  try { Sheets.Spreadsheets.batchUpdate({ requests: requests }, cache.id); }
  catch (error) { fail_('PV_STORAGE', 'Google не подтвердил запись общего журнала проверок. Новые платные запросы не отправлены.'); }
  cache.writes = Object.create(null);
}

function pvPublic_(context, state) {
  var settings = pvSettings_(context), jobs = state ? state.jobs : [], counts = { queued: 0, processing: 0, checked: 0, review: 0 }, pendingCounts = { email: 0, telegram: 0 }, pendingKeys = Object.create(null);
  jobs.forEach(function (job) {
    if (pvNeedsManualStart_(job)) job.contacts.forEach(function (contact) { if (!pendingKeys[contact.key]) { pendingKeys[contact.key] = true; pendingCounts[job.kind]++; } });
    if (job.state === 'complete' || job.state === 'complete_shared') counts.checked += job.resultCount || 0;
    else if (job.state === 'result_review') { counts.checked += job.resultCount || 0; counts.review += Math.max(0, job.contacts.length - (job.resultCount || 0)); }
    else if (job.state === 'queued') counts.queued += job.contacts.length;
    else if (['creation_uncertain', 'credential_changed', 'result_error'].indexOf(job.state) !== -1) counts.review += job.contacts.length;
    else if (!pvJobFinished_(job.state)) counts.processing += job.contacts.length;
  });
  counts.review += state ? state.manualReviewCount || 0 : 0;
  var hint = pvAutomaticHint_(state, settings);
  return { configured: !!settings.key, enabled: settings.enabled, autoPayLimitUsd: settings.autoPayLimitUsd, manualStartRequired: pendingCounts.email + pendingCounts.telegram > 0, pendingCounts: pendingCounts, canAutoAdvance: hint.canAutoAdvance, nextActionAt: hint.nextActionAt, state: !settings.key ? 'not_configured' : !settings.enabled ? 'disabled' : jobs.some(function (job) { return !pvJobFinished_(job.state); }) || state && state.pendingApplications > 0 ? 'pending' : 'complete', counts: counts, jobs: jobs.slice(-100).map(function (job) { return { jobId: job.jobId, kind: job.kind, country: job.country || '', state: job.state, orderId: job.orderId || '', cost: job.cost, contacts: job.contacts.length, checked: job.resultCount || 0, manualStartRequired: pvNeedsManualStart_(job), nextPollAt: pvNextAt_(job), canPay: job.state === 'awaiting_payment' && job.cost !== null && !pvHasConsent_(job, Date.now()), message: job.message || job.costWarning || '' }; }), warnings: !settings.key ? ['Подключите Promouser: существующие контакты и статусы сохранены.'] : [] };
}
function pvAutomaticHint_(state, settings) {
  if (!settings.key || !settings.enabled || !state) return { canAutoAdvance: false, nextActionAt: null };
  var actions = [];
  if (state.pendingApplications > 0) actions.push(Date.now());
  state.jobs.forEach(function (job) {
    if (job.state === 'queued' && job.manualStartApproved || job.state === 'waiting_shared') actions.push(job.state === 'queued' ? Date.now() : Date.now() + PROMOUSER.statusDelay);
    else if (['awaiting_quote', 'checking', 'payment_uncertain', 'result_pending'].indexOf(job.state) !== -1) actions.push(pvNextAt_(job));
    else if (job.state === 'awaiting_payment' && (pvAutoPay_(job, settings) || pvHasConsent_(job, Date.now()))) actions.push(pvNextAt_(job));
    else if (job.state === 'creating' || job.state === 'paying') actions.push(state.lease && state.lease.until > Date.now() ? state.lease.until : Date.now());
  });
  if (!actions.length) return { canAutoAdvance: false, nextActionAt: null };
  var next = Math.min.apply(null, actions);
  if (state.lease && state.lease.until > Date.now()) next = Math.max(next, state.lease.until);
  return { canAutoAdvance: true, nextActionAt: Math.max(Date.now(), next) };
}
function pvNextAt_(job) { return Math.max((job.lastRequestAt || 0) + PROMOUSER.orderDelay, (job.lastStatusAt || 0) + PROMOUSER.statusDelay); }
function pvJobFinished_(state) { return ['complete', 'complete_shared', 'result_review', 'cancelled', 'creation_uncertain', 'credential_changed', 'result_error'].indexOf(state) !== -1; }
function pvContactsStillPresent_(rows, contacts) { var keys = Object.create(null); rows.forEach(function (row) { if (!row.completed || row.changed) keys[row.key] = true; }); return contacts.every(function (contact) { return keys[contact.key]; }); }
function pvNeedsManualStart_(job) { return !job.manualStartApproved && !job.paid && ['queued', 'waiting_shared', 'awaiting_quote', 'awaiting_payment'].indexOf(job.state) !== -1; }
function pvAutoPay_(job, settings) { return job.manualStartApproved === true && !job.blockAutoPay && settings.autoPayLimitUsd > 0 && job.cost !== null && job.cost <= settings.autoPayLimitUsd && job.state === 'awaiting_payment'; }
function pvPendingStatus_(value) { return ['Ожидает проверки', 'Проверяется', 'Нужна оплата', 'Ошибка подключения', 'Проверка не подтверждена', 'Нужен телефон', 'Уточните страну или номер'].indexOf(String(value).trim()) !== -1; }
function pvFailureMessage_(code) { var messages = { PV_PAUSED: 'Проверка Promouser отключена. Запрос не отправлен.', PV_CREDENTIAL_CHANGED: 'Ключ Promouser изменился. Старый заказ приостановлен.', PV_FUNDS: 'Недостаточно средств в Promouser.', PV_AUTH: 'API-ключ Promouser отклонён.', PV_IP_DENIED: 'Promouser не разрешил доступ с текущего IP.', PV_RATE_LIMIT: 'Достигнут лимит частоты запросов. Обновите позже.', PV_OWNER_AUTH_REQUIRED: 'Владельцу Apps Script нужно разрешить внешние запросы.', PV_RESULT_FORMAT: 'Не удалось прочитать формат результата.', PV_RESULT_DOWNLOAD: 'Результат ещё не скачан. Обновите позже.', PV_NOT_PAYABLE: 'Заказ ещё не готов к оплате.' }; return messages[code] || 'Нет подтверждения ответа Promouser. Заказ сохранён; повторное создание или списание отключено.'; }
function pvBinding_(note) { var pattern = new RegExp('(?:^|\\n)' + PROMOUSER.bindingPrefix + '([A-Za-z0-9_-]{43})(?=\\n|$)'), match = String(note || '').match(pattern); return match ? match[1] : ''; }
function pvBoundNote_(note, key) { return String(note || '').split('\n').filter(function (line) { return line.indexOf(PROMOUSER.bindingPrefix) !== 0; }).concat([PROMOUSER.bindingPrefix + key]).join('\n').replace(/^\n+/, ''); }
function pvHeader_(value) { return String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/[\s_\-().:/]+/g, ''); }
function pvHeaderMap_(headers) { var map = Object.create(null); headers.forEach(function (name, index) { var key = pvHeader_(name); if (!key) return; if (map[key] !== undefined) fail_('PV_SCHEMA', 'В листе повторяются названия колонок. Уточните заголовки перед проверкой.'); map[key] = index; }); return map; }
function pvFindHeader_(map, names) { for (var i = 0; i < names.length; i++) if (map[pvHeader_(names[i])] !== undefined) return map[pvHeader_(names[i])]; return undefined; }
function pvEmail_(value) { var text = String(value || '').trim().replace(/^mailto:/i, '').toLowerCase(); return text.length <= 320 && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(text) ? text : ''; }
function pvPhone_(value) { var text = String(value || '').trim(); if (!/^\+?[\d ()-]+$/.test(text)) return ''; var digits = text.replace(/\D/g, ''); if (/^8\d{10}$/.test(digits)) digits = '7' + digits.slice(1); return /^[1-9]\d{7,14}$/.test(digits) ? '+' + digits : ''; }
function pvUsername_(value) { var text = String(value || '').trim(); return /^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(text) ? text.toLowerCase() : ''; }
function pvCountry_(phone) {
  var digits = phone.replace(/^\+/, '');
  if (/^79\d{9}$/.test(digits)) return 'RU';
  if (/^7(?:700|701|702|705|706|707|708|747|750|751|760|761|762|763|764|771|775|776|777|778)\d{7}$/.test(digits)) return 'KZ';
  if (/^7/.test(digits)) return '';
  var prefixes = [['380', 'UA'], ['375', 'BY'], ['44', 'GB'], ['49', 'DE'], ['33', 'FR'], ['48', 'PL'], ['370', 'LT'], ['371', 'LV'], ['372', 'EE'], ['373', 'MD'], ['374', 'AM'], ['995', 'GE'], ['994', 'AZ'], ['996', 'KG'], ['998', 'UZ'], ['992', 'TJ'], ['90', 'TR'], ['91', 'IN'], ['39', 'IT'], ['34', 'ES'], ['31', 'NL'], ['32', 'BE'], ['46', 'SE'], ['47', 'NO'], ['45', 'DK'], ['358', 'FI'], ['420', 'CZ'], ['421', 'SK'], ['36', 'HU'], ['40', 'RO'], ['359', 'BG'], ['30', 'GR'], ['351', 'PT'], ['353', 'IE'], ['61', 'AU'], ['64', 'NZ'], ['81', 'JP'], ['82', 'KR'], ['86', 'CN'], ['55', 'BR'], ['52', 'MX'], ['972', 'IL']];
  for (var i = 0; i < prefixes.length; i++) if (digits.indexOf(prefixes[i][0]) === 0 && digits.length >= prefixes[i][0].length + 7) return prefixes[i][1];
  return '';
}
function pvKey_(kind, value) { return digest_('promouser-contact-v1|' + kind + '|' + String(value).toLowerCase()); }
function pvMoney_(value) { if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null; if (typeof value !== 'string' || !/^\d+(?:\.\d{1,8})?$/.test(value.trim())) return null; var number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null; }
function pvInput_(value, allowed) { authorize_(); var input = object_(value || {}); if (Object.keys(input).some(function (key) { return allowed.indexOf(key) === -1; })) fail_('INVALID_REQUEST', 'В запросе проверки есть неизвестные поля.'); return input; }
function pvRequestId_(value) { if (typeof value !== 'string' || value.length < 8 || value.length > 120 || !/^[A-Za-z0-9_-]+$/.test(value)) fail_('INVALID_REQUEST', 'Нужен идентификатор запроса проверки.'); return value; }
function pvOrderId_(value) { return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)); }
function pvSafeText_(value, limit) { return String(value === null || value === undefined ? '' : value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, limit); }
function pvEnsureGrid_(sheet, rows, columns) { if (rows > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows()); if (columns > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), columns - sheet.getMaxColumns()); }
function pvNow_() { return new Date().toISOString(); }
function pvUuid_() { return typeof Utilities !== 'undefined' && Utilities.getUuid ? Utilities.getUuid() : String(Date.now()) + '-' + Math.random().toString(36).slice(2); }
