/** One-project sender inventory. Provider reads never create or modify senders. */
var PROJECT_INFRASTRUCTURE = Object.freeze({ version: 1, batch: 20, detailBudgetMillis: 12000, maxAccounts: 5000, maxReceipts: 1001, cacheMillis: 300000, textLimit: 2000 });

/** Cached metadata by default. Explicit diagnostics return only provider structure and counts. */
function getProjectInfrastructure_(request) {
  return api_(function () {
    var input = coldyInput_(request === undefined ? {} : request, ['diagnose']);
    if (input.diagnose !== undefined && typeof input.diagnose !== 'boolean') fail_('INVALID_REQUEST', 'Некорректный режим диагностики почтовой инфраструктуры.');
    var context = authorize_(), settings = coldySettings_(context), monitoring = projectMonitoringRead_(context,settings);
    if (input.diagnose === true) {
      var signature = projectMonitoringSignature_(context, monitoring);
      projectInfraMonitoringCurrent_(context, settings.credentialHash, signature);
      var response = coldyApi_(context, 'GET', '/accounts');
      var arrayLength = function (value) { return Array.isArray(value) ? value.length : null; };
      var diagnostics = { itemsIsArray: Array.isArray(response.items), itemsLength: arrayLength(response.items),
        maxSupportedAccounts: PROJECT_INFRASTRUCTURE.maxAccounts,
        reportedTotal: projectInfraCount_(response.total), hasMore: response.has_more === true,
        hasContinuation: !!(response.next_cursor || response.nextPageToken),
        dataArrayLength: arrayLength(response.data), dataItemsLength: arrayLength(response.data && response.data.items),
        accountsArrayLength: arrayLength(response.accounts), resultsArrayLength: arrayLength(response.results) };
      projectInfraMonitoringCurrent_(context, settings.credentialHash, signature);
      return { diagnostics: diagnostics };
    }
    projectInfraCurrent_(context, settings.credentialHash);
    return projectInfraPublic_(context, monitoring.accountIds.length ? projectInfraRead_(context,settings) : null);
  });
}

/** One inventory plus a bounded detail batch; the saved cursor continues later. */
function refreshProjectInfrastructure_(request) {
  return api_(function () {
    var input = coldyInput_(request === undefined ? {} : request, ['cursor', 'inventoryOnly', 'includeCapacity', 'live']);
    if (input.live !== undefined && (input.live !== true || input.includeCapacity !== true || input.cursor !== undefined)) fail_('INVALID_REQUEST', 'Некорректный режим мониторинга.');
    if (input.cursor !== undefined && (typeof input.cursor !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.cursor))) fail_('INVALID_REQUEST', 'Некорректное продолжение синхронизации почт.');
    if (input.inventoryOnly !== undefined && typeof input.inventoryOnly !== 'boolean' || input.inventoryOnly === true && input.cursor !== undefined) fail_('INVALID_REQUEST', 'Некорректный режим обновления списка почт.');
    if (input.includeCapacity !== undefined && (typeof input.includeCapacity !== 'boolean' || input.cursor !== undefined || input.inventoryOnly === true)) fail_('INVALID_REQUEST', 'Некорректный режим обновления занятости почт.');
    var context = authorize_(), settings = coldySettings_(context), started = Date.now();
    if (!settings.configured) return projectInfraPublic_(context, null);
    var monitoring = projectMonitoringRead_(context, settings), monitoringSignature = projectMonitoringSignature_(context, monitoring);
    if (!monitoring.accountIds.length && input.inventoryOnly !== true && input.cursor === undefined) return projectInfraPublic_(context,null,monitoringSignature);
    var before = projectInfraRead_(context, settings);
    projectInfraMonitoringCurrent_(context, settings.credentialHash, monitoringSignature);
    if (input.cursor !== undefined) {
      if (!before || !projectInfraMonitoringMatches_(before, monitoringSignature)) fail_('COLDY_INFRA_CURSOR_STALE', 'Выбор почт изменился. Начните новую синхронизацию.');
      var allowedIds = new Set(monitoring.accountIds);
      if (before.detailIds.some(function (id) { return !allowedIds.has(id); })) fail_('COLDY_STORAGE', 'Продолжение содержит почту вне выбранного мониторинга.');
      if (before.processedCursors.indexOf(input.cursor) !== -1) return projectInfraPublic_(context, before);
      if (!before.nextCursor || input.cursor !== before.nextCursor) fail_('COLDY_INFRA_CURSOR_STALE', 'Синхронизация почт уже изменилась. Обновите список.');
    }
    if (before && before.retryAt > Date.now()) return projectInfraPublic_(context, before);
    if (input.live && before && before.selectedOnly && before.poolOnly && !before.lastError && projectInfraMonitoringMatches_(before,monitoringSignature) &&
        (before.nextCursor || before.capacity && !before.capacity.stale && Date.parse(before.capacity.updatedAt) > started - 60000)) {
      return projectInfraPublic_(context,before,monitoringSignature);
    }
    var state;
    try {
      if (input.cursor === undefined) {
        projectInfraMonitoringCurrent_(context, settings.credentialHash, monitoringSignature);
        var discover = input.inventoryOnly === true, now = new Date().toISOString();
        var oldById = Object.create(null);
        (monitoring.accounts || []).forEach(function (item) { oldById[item.id] = {id:item.id,email:item.email,name:item.name,provider:item.provider,stale:true}; });
        if (before) before.accounts.forEach(function (item) { oldById[item.id] = item; });
        var accounts;
        if (discover) {
          var response = coldyApi_(context, 'GET', '/accounts');
          projectInfraMonitoringCurrent_(context, settings.credentialHash, monitoringSignature);
          accounts = projectInfraInventory_(response, settings.key);
        } else {
          accounts = monitoring.accountIds.map(function (id) {
            return oldById[id] || { id:id, email:null, name:'', stale:true };
          });
        }
        accounts.forEach(function (item) {
          var old = oldById[item.id];
          if (discover && old && old.email === item.email) {
            item.status = old.status;
            item.updatedAt = old.updatedAt;
            if (input.includeCapacity && old.updatedAt) {
              item.stale = !!old.stale || Date.parse(old.updatedAt) < started - PROJECT_INFRASTRUCTURE.cacheMillis;
              item.syncError = old.syncError || null;
            }
          }
        });
        state = { version: PROJECT_INFRASTRUCTURE.version, rootId: context.rootId, credentialHash: settings.credentialHash,
          generation: digest_('infrastructure|' + Utilities.getUuid() + '|' + started), startedAt: started,
          accounts: accounts, detailIds: projectInfraSelectedIds_(accounts, monitoring.accountIds), monitoringSignature: monitoringSignature, selectedOnly:!discover,
          cursorIndex: 0, processedCursors: [], nextCursor: null, inventoryAt: now,
          updatedAt: now, lastAttemptAt: now, retryAt: 0, warnings: [], lastError: null };
        if (before && before.capacity && projectInfraMonitoringMatches_(before, monitoringSignature)) state.capacity = before.capacity;
        if (input.includeCapacity) {
          state.poolOnly = true;
          if (state.detailIds.length) { state.capacityRequested = true; state.capacityWork = { mapped: false, cursor: 0 }; }
        }
      } else state = JSON.parse(JSON.stringify(before));
      state.lastError = null; state.retryAt = 0; state.warnings = [];
      if (state.selectedOnly && state.capacityWork) {
        projectCapacityAdvance_(context, settings, state);
        if (state.finalCapacityCheck && state.capacity && !state.lastError) state.inventoryAt = state.capacity.updatedAt;
      }
      else {
        if ((!state.poolOnly || state.selectedOnly) && input.inventoryOnly !== true) projectInfraDetails_(context, settings, state);
        if (state.capacityWork && !state.lastError) projectCapacityAdvance_(context, settings, state);
      }
      // A long or throttled run may outlive the original membership snapshot. Recheck it once,
      // keeping the completed sender diagnostics and their individual observation timestamps.
      if (state.selectedOnly && state.poolOnly && state.capacity && !state.capacityWork && !state.lastError &&
          state.cursorIndex === state.detailIds.length && !state.finalCapacityCheck &&
          Math.min(Date.parse(state.inventoryAt),Date.parse(state.capacity.updatedAt)) < Date.now() - PROJECT_INFRASTRUCTURE.cacheMillis) {
        state.finalCapacityCheck = true;
        state.capacityWork = {mapped:false,cursor:0};
      }
    } catch (error) {
      if (projectInfraScopeError_(error)) throw error;
      return projectInfraFailure_(context, settings, started, before, error, monitoringSignature, input.includeCapacity === true);
    }
    var committed = locked_(function () {
      var fresh = projectInfraMonitoringCurrent_(context, settings.credentialHash, monitoringSignature), latest = projectInfraRead_(fresh, coldySettings_(fresh));
      if (input.cursor !== undefined) {
        if (!latest || latest.generation !== before.generation) fail_('COLDY_INFRA_CURSOR_STALE', 'Список почт изменился. Обновите его перед продолжением.');
        if (latest.processedCursors.indexOf(input.cursor) !== -1) return latest;
        if (latest.cursorIndex !== before.cursorIndex || latest.nextCursor !== input.cursor) fail_('COLDY_INFRA_CURSOR_STALE', 'Продолжение уже обработано. Обновите список почт.');
        if (state.cursorIndex > before.cursorIndex || (before.capacityWork && JSON.stringify(state.capacityWork) !== JSON.stringify(before.capacityWork))) state.processedCursors.push(input.cursor);
      } else if (latest && latest.generation !== (before && before.generation) && latest.startedAt >= started) {
        return latest;
      }
      state.processedCursors = state.processedCursors.slice(-PROJECT_INFRASTRUCTURE.maxReceipts);
      state.nextCursor = (!state.poolOnly || state.selectedOnly) && state.cursorIndex < state.detailIds.length || state.capacityWork ? projectInfraCursor_(state) : null;
      state.updatedAt = new Date().toISOString();
      state.lastAttemptAt = state.updatedAt;
      coldySave_(fresh, 'infrastructure', projectMonitoringOwner_(settings.credentialHash), state);
      // A successful authenticated account read also verifies this connection.
      if (!state.lastError && (input.inventoryOnly === true || state.verifiedProvider === true)) fresh.properties.setProperty(COLDY.connectionProperty, JSON.stringify({ version: COLDY.version,
        rootId: fresh.rootId, credentialHash: settings.credentialHash, checkedAt: state.updatedAt }));
      return state;
    });
    return projectInfraPublic_(context, committed, monitoringSignature);
  });
}

function projectInfraDetails_(context, settings, state) {
  var parallel = typeof UrlFetchApp.fetchAll === 'function', groupSize = parallel ? 5 : 1, firstIndex = state.cursorIndex;
  var deadline = Date.now() + (parallel ? 45000 : PROJECT_INFRASTRUCTURE.detailBudgetMillis);
  var indexes = Object.create(null);
  state.accounts.forEach(function (item, index) { indexes[item.id] = index; });
  var stop = Math.min(state.detailIds.length, state.cursorIndex + PROJECT_INFRASTRUCTURE.batch);
  function guard() { projectInfraMonitoringCurrent_(context, settings.credentialHash, state.monitoringSignature); }
  while (state.cursorIndex < stop && (state.cursorIndex === firstIndex || Date.now() < deadline)) {
    var ids = state.detailIds.slice(state.cursorIndex,Math.min(stop,state.cursorIndex + groupSize)), responses;
    try {
      responses = coldyGetBatch_(context,ids.map(function (id) { return '/accounts/' + id; }),guard);
    } catch (error) {
      if (['COLDY_RATE_LIMIT','COLDY_NETWORK','COLDY_UNAVAILABLE'].indexOf(error.registryCode) < 0) throw error;
      responses = [{error:error}];
    }
    // Retain the longest provider cooldown even if several concurrent reads were throttled.
    var retry = responses.reduce(function (ms, r) { return Math.max(ms,r.error && r.error.retryAfterMs || 0); },0);
    for (var n = 0; n < responses.length; n++) {
      var index = indexes[ids[n]], item = state.accounts[index], result = responses[n];
      try {
        if (result.error) throw result.error;
        state.accounts[index] = projectInfraDetail_(item,result.value,settings.key,state.selectedOnly);
        state.verifiedProvider = true;
      } catch (error) {
        item.stale = true;
        item.syncError = projectInfraError_(error);
        if (['COLDY_RATE_LIMIT','COLDY_NETWORK','COLDY_UNAVAILABLE'].indexOf(error.registryCode) >= 0) {
          state.lastError = item.syncError;
          state.retryAt = Date.now() + Math.max(15000,Math.min(86400000,retry));
          state.warnings.push(state.lastError.message);
          return;
        }
      }
      state.cursorIndex++;
    }
  }
  if (state.detailIds.some(function (id) { return !!state.accounts[indexes[id]].syncError; })) state.warnings.push('Часть сведений о выбранных ящиках не обновлена. Сохранённые значения отмечены как устаревшие.');
}

function projectInfraFailure_(context, settings, started, before, error, monitoringSignature, poolOnly) {
  var committed = locked_(function () {
    var fresh = projectInfraMonitoringCurrent_(context, settings.credentialHash, monitoringSignature), latest = projectInfraRead_(fresh, coldySettings_(fresh));
    if (latest && (latest.generation !== (before && before.generation) && latest.startedAt >= started ||
        before && latest.generation === before.generation && (latest.cursorIndex > before.cursorIndex || latest.nextCursor !== before.nextCursor))) return latest;
    var now = new Date().toISOString(), saved = latest || { version: PROJECT_INFRASTRUCTURE.version, rootId: fresh.rootId,
      credentialHash: settings.credentialHash, generation: digest_('infrastructure-error|' + Utilities.getUuid()), startedAt: started,
      accounts: [], cursorIndex: 0, processedCursors: [], nextCursor: null, inventoryAt: null };
    if (!projectInfraMonitoringMatches_(saved, monitoringSignature)) {
      var monitoring = projectMonitoringRead_(fresh, coldySettings_(fresh));
      saved.generation = digest_('infrastructure-error|' + Utilities.getUuid() + '|' + started);
      saved.startedAt = started;
      saved.detailIds = projectInfraSelectedIds_(saved.accounts, monitoring.accountIds);
      delete saved.capacity; delete saved.capacityWork; delete saved.capacityRequested; delete saved.poolOnly;
      saved.monitoringSignature = monitoringSignature;
      saved.cursorIndex = 0; saved.processedCursors = [];
      saved.nextCursor = saved.detailIds.length ? projectInfraCursor_(saved) : null;
    }
    if (poolOnly) {
      // The catalog read failed. A new pool refresh must start with /accounts again.
      saved.poolOnly = true; saved.cursorIndex = 0; saved.nextCursor = null;
      saved.processedCursors = []; delete saved.capacityWork;
    }
    saved.lastError = projectInfraError_(error);
    if (saved.capacity) saved.capacity.stale = true;
    saved.lastAttemptAt = now;
    saved.updatedAt = now;
    saved.warnings = [saved.lastError.message];
    saved.accounts.forEach(function (item) { item.stale = true; });
    if (error.registryCode === 'COLDY_RATE_LIMIT' || error.registryCode === 'COLDY_UNAVAILABLE') saved.retryAt = Date.now() + Math.max(15000, Math.min(86400000, error.retryAfterMs || 0));
    coldySave_(fresh, 'infrastructure', projectMonitoringOwner_(settings.credentialHash), saved);
    return saved;
  });
  return projectInfraPublic_(context, committed, monitoringSignature);
}

function projectInfraCurrent_(context, hash) {
  var current = coldyCurrent_(context, true), settings = coldySettings_(current);
  if (settings.credentialHash !== hash) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился. Повторите синхронизацию почт.');
  return current;
}

function projectInfraMonitoringCurrent_(context, credentialHash, signature) {
  var fresh = projectInfraCurrent_(context, credentialHash), monitoring = projectMonitoringRead_(fresh, coldySettings_(fresh));
  if (projectMonitoringSignature_(fresh, monitoring) !== signature) fail_('COLDY_MONITORING_CHANGED', 'Выбор почт изменился. Обновите данные и начните новую синхронизацию.');
  return fresh;
}
function projectInfraMonitoringMatches_(saved, signature) { return !!saved && saved.monitoringSignature === signature && Array.isArray(saved.detailIds); }
function projectInfraSelectedIds_(accounts, selectedIds) {
  var available = Object.create(null);
  accounts.forEach(function (item) { available[item.id] = true; });
  return selectedIds.filter(function (id) { return !!available[id]; });
}

function projectInfraRead_(context, settings) {
  if (!settings.configured) return null;
  var owner = projectMonitoringOwner_(settings.credentialHash), saved = coldyLoad_(context, 'infrastructure', owner);
  if (owner !== projectMonitoringOwner_(settings.credentialHash)) fail_('COLDY_MONITORING_CHANGED', 'Проект изменился. Обновите список почт.');
  if (!saved) return null;
  if (saved.version !== PROJECT_INFRASTRUCTURE.version || saved.rootId !== context.rootId || saved.credentialHash !== settings.credentialHash ||
      saved.poolOnly !== undefined && (saved.poolOnly !== true || !saved.selectedOnly && saved.cursorIndex !== 0) ||
      typeof saved.generation !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(saved.generation) || !Number.isFinite(saved.startedAt) ||
      !Array.isArray(saved.accounts) || saved.accounts.length > PROJECT_INFRASTRUCTURE.maxAccounts ||
      !Number.isSafeInteger(saved.cursorIndex) || saved.cursorIndex < 0 || saved.cursorIndex > saved.accounts.length ||
      !Array.isArray(saved.processedCursors) || saved.processedCursors.length > PROJECT_INFRASTRUCTURE.maxReceipts ||
      saved.processedCursors.some(function (value) { return typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value); }) ||
      saved.nextCursor !== null && (typeof saved.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(saved.nextCursor)) ||
      settings.key && JSON.stringify(saved).indexOf(settings.key) !== -1) fail_('COLDY_STORAGE', 'Сохранённый список почт Coldy требует проверки.');
  var seen = Object.create(null);
  saved.accounts.forEach(function (item) {
    if (!item || typeof item.id !== 'string' || projectInfraId_(item.id) !== item.id || !(saved.selectedOnly === true && item.email === null) && (typeof item.email !== 'string' || !coldyEmail_(item.email)) || seen[item.id]) fail_('COLDY_STORAGE', 'Сохранённые ящики Coldy требуют проверки.');
    seen[item.id] = true;
  });
  if (saved.detailIds !== undefined || saved.monitoringSignature !== undefined) {
    if (!Array.isArray(saved.detailIds) || saved.detailIds.length > PROJECT_INFRASTRUCTURE.maxAccounts ||
        typeof saved.monitoringSignature !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(saved.monitoringSignature) ||
        saved.cursorIndex > saved.detailIds.length) fail_('COLDY_STORAGE', 'Сохранённое продолжение мониторинга почт требует проверки.');
    var detailSeen = Object.create(null);
    saved.detailIds.forEach(function (id) {
      if (typeof id !== 'string' || projectInfraId_(id) !== id || !seen[id] || detailSeen[id]) fail_('COLDY_STORAGE', 'Сохранённый выбор почт требует проверки.');
      detailSeen[id] = true;
    });
  }
  if (saved.capacity || saved.capacityWork) projectCapacityValidate_(saved);
  return saved;
}

function projectInfraInventory_(response, key) {
  if (!response || !Array.isArray(response.items) || response.items.length > PROJECT_INFRASTRUCTURE.maxAccounts ||
      response.next_cursor || response.nextPageToken || response.has_more === true ||
      Number.isSafeInteger(response.total) && response.total > response.items.length) fail_('COLDY_INFRA_INCOMPLETE', 'Coldy вернул неполный или слишком большой список ящиков. Сохранённый список не заменён.');
  var seen = Object.create(null);
  return response.items.map(function (item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail_('COLDY_RESPONSE', 'Coldy не подтвердил сведения о ящиках.');
    var id = projectInfraId_(item.id), email = projectInfraEmail_(item.email);
    if (seen[id]) fail_('COLDY_RESPONSE', 'Coldy вернул повторяющийся идентификатор ящика.');
    seen[id] = true;
    return { id: id, email: email, listedName: item.first_name !== undefined || item.last_name !== undefined, name: [projectInfraText_(item.first_name, key, 200), projectInfraText_(item.last_name, key, 200)].filter(Boolean).join(' '),
      provider: projectInfraNullableText_(item.service, key, 200), status: null, sentTotal: projectInfraCount_(item.total_sent),
      sentToday: projectInfraCount_(item.sent_today), dailyLimit: projectInfraCount_(item.limit), errorCount: null,
      errors: projectInfraProviderErrors_(item.error_text, key), tags: projectInfraTags_(item.tags, key),
      warmup: projectInfraWarmup_(item, false, key), updatedAt: null, stale: true, syncError: null };
  });
}

function projectInfraDetail_(listed, response, key, selectedOnly) {
  if (!response || typeof response !== 'object' || Array.isArray(response) || projectInfraId_(response.id) !== listed.id ||
      listed.email && projectInfraEmail_(response.email) !== listed.email) fail_('COLDY_INFRA_ACCOUNT_CHANGED', 'Сведения о ящике изменились во время синхронизации.');
  return { id: listed.id, email: projectInfraEmail_(response.email),
    name: selectedOnly && (response.first_name !== undefined || response.last_name !== undefined) ? [projectInfraText_(response.first_name,key,200),projectInfraText_(response.last_name,key,200)].filter(Boolean).join(' ') :
      listed.listedName ? listed.name : [projectInfraText_(response.first_name, key, 200), projectInfraText_(response.last_name, key, 200)].filter(Boolean).join(' ') || listed.name,
    provider: projectInfraNullableText_(response.provider, key, 200) || listed.provider,
    status: projectInfraNullableText_(response.status, key, 200),
    sentTotal: response.total_sent === undefined ? listed.sentTotal : projectInfraCount_(response.total_sent),
    sentToday: response.sent_today === undefined ? listed.sentToday : projectInfraCount_(response.sent_today),
    dailyLimit: response.daily_limit === undefined ? listed.dailyLimit : projectInfraCount_(response.daily_limit),
    errorCount: null, errors: response.error_text === undefined ? listed.errors : projectInfraProviderErrors_(response.error_text, key),
    tags: response.tags === undefined ? listed.tags : projectInfraTags_(response.tags, key),
    warmup: response.warmup === undefined ? listed.warmup : projectInfraWarmup_(response.warmup, true, key),
    updatedAt: new Date().toISOString(), stale: false, syncError: null };
}

function projectInfraPublic_(context, saved, expectedSignature) {
  var settings = coldySettings_(context), monitoring = projectMonitoringRead_(context, settings), signature = projectMonitoringSignature_(context, monitoring);
  if (saved && saved.credentialHash !== settings.credentialHash) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился. Обновите данные.');
  if (expectedSignature && expectedSignature !== signature) fail_('COLDY_MONITORING_CHANGED', 'Выбор почт изменился. Обновите данные.');
  var known = !!saved && !!saved.inventoryAt, inventoryStale = !known || Date.parse(saved.inventoryAt) < Date.now() - PROJECT_INFRASTRUCTURE.cacheMillis;
  var selected = Object.create(null), available = Object.create(null), jobMatches = projectInfraMonitoringMatches_(saved, signature);
  var poolOnly = !!(jobMatches && saved.poolOnly);
  monitoring.accountIds.forEach(function (id) { selected[id] = true; });
  if (known) saved.accounts.forEach(function (item) { if (item.email) available[item.id] = true; });
  var missing = known ? monitoring.accountIds.filter(function (id) { return !available[id]; }) : [];
  var selectedAccounts = known ? saved.accounts.filter(function (item) { return selected[item.id] && available[item.id]; }) : [];
  var accounts = selectedAccounts.map(function (item) {
    return { id: item.id, email: item.email, name: projectInfraText_(item.name, settings.key, 500), provider: projectInfraNullableText_(item.provider, settings.key, 200),
      status: projectInfraNullableText_(item.status, settings.key, 200), sentTotal: projectInfraCount_(item.sentTotal), sentToday: projectInfraCount_(item.sentToday), dailyLimit: projectInfraCount_(item.dailyLimit),
      errorCount: null, errors: projectInfraErrorsPublic_(item.errors, settings.key), tags: projectInfraTags_(item.tags, settings.key),
      warmup: projectInfraWarmupPublic_(item.warmup, settings.key), updatedAt: item.updatedAt || null, stale: inventoryStale || item.stale === true ||
        poolOnly && (!item.updatedAt || Date.parse(item.updatedAt) < Date.now() - PROJECT_INFRASTRUCTURE.cacheMillis),
      syncError: item.syncError ? { code: projectInfraText_(item.syncError.code, settings.key, 100), message: projectInfraText_(item.syncError.message, settings.key) } : null };
  });
  var activeError = jobMatches && saved.lastError, nextCursor = jobMatches ? saved.nextCursor : null;
  var retryAfterMs = saved && Number.isFinite(saved.retryAt) ? Math.max(0, saved.retryAt - Date.now()) : 0;
  var warnings = (jobMatches && saved.warnings || []).map(function (message) { return projectInfraText_(message, settings.key); });
  if (missing.length) warnings.push('Не найдено в текущем списке Coldy выбранных ящиков: ' + missing.length + '. Выбор сохранён; проверьте список почт.');
  var emptySelection = settings.configured && monitoring.accountIds.length === 0;
  var totals = projectInfraTotals_(accounts, emptySelection || known && !missing.length);
  if (known && monitoring.accountIds.length) totals.accounts = monitoring.accountIds.length;
  var state = !settings.configured ? 'not_configured' : emptySelection ? 'no_selection' : !known ? (activeError ? 'error' : 'not_synced') :
    inventoryStale || activeError || nextCursor || missing.length || !poolOnly && accounts.some(function (item) { return item.stale || item.syncError; }) ? 'partial' : 'ready';
  var publicMonitoring = projectMonitoringPublic_(context, monitoring);
  publicMonitoring.selectedCount = monitoring.accountIds.length; publicMonitoring.missingAccountIds = missing;
  var result = { state: state, configured: settings.configured, connected: settings.connected, accounts: accounts,
    totals: totals, availableCount: known ? saved.accounts.length : null, monitoring: publicMonitoring,
    lastSyncAt: saved && saved.inventoryAt || null, updatedAt: saved && saved.updatedAt || null,
    lastAttemptAt: saved && saved.lastAttemptAt || null, warnings: warnings,
    poolOnly: poolOnly, nextCursor: nextCursor, detailProgress: { completed: known && jobMatches ? saved.cursorIndex : 0,
      total: known ? (jobMatches ? saved.detailIds.length : selectedAccounts.length) : monitoring.accountIds.length },
    retryAfterMs: retryAfterMs, syncPaused: !!activeError || retryAfterMs > 0,
    error: activeError ? { code: projectInfraText_(activeError.code, settings.key, 100), message: projectInfraText_(activeError.message, settings.key) } : null,
    stale: !emptySelection && (inventoryStale || !!activeError || missing.length > 0), countersScope: 'selected_accounts', cached: !!saved };
  projectCapacityPublic_(context, settings, jobMatches ? saved : null, result);
  projectInfraMonitoringCurrent_(context, settings.credentialHash, signature);
  return result;
}

function projectInfraTotals_(accounts, known) {
  function total(field) {
    if (!known || accounts.some(function (item) { return item[field] === null; })) return null;
    var value = accounts.reduce(function (sum, item) { return sum + item[field]; }, 0);
    return Number.isSafeInteger(value) ? value : null;
  }
  return { accounts: known ? accounts.length : null, sentTotal: total('sentTotal'), sentToday: total('sentToday'), dailyLimit: total('dailyLimit'),
    errorCount: null, accountsWithErrors: known ? accounts.filter(function (item) { return item.errors.length > 0; }).length : null };
}

function projectInfraCursor_(state) {
  var parts = ['infrastructure-cursor', state.rootId, state.credentialHash, state.generation, state.monitoringSignature, state.cursorIndex];
  if (state.capacityWork) parts.push(state.capacityWork.mapped, state.capacityWork.cursor);
  return digest_(JSON.stringify(parts));
}
function projectInfraId_(value) {
  var text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text)) || String(Number(text)) !== text) fail_('COLDY_RESPONSE', 'Coldy вернул неподдерживаемый идентификатор ящика.');
  return text;
}
function projectInfraEmail_(value) { if (typeof value !== 'string') fail_('COLDY_RESPONSE', 'Coldy не подтвердил адрес ящика.'); return coldyEmail_(value); }
function projectInfraCount_(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function projectInfraText_(value, key, limit) {
  if (typeof value !== 'string') return '';
  var text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (key) text = text.split(key).join('[скрыто]');
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9_.~+/=-]+/gi, '$1 [скрыто]')
    .replace(/(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[скрыто]@');
  text = text.replace(/(["']?)\b(password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|token|access_token|refresh_token|authorization)\1\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$2=[скрыто]');
  return text.trim().slice(0, limit || PROJECT_INFRASTRUCTURE.textLimit);
}
function projectInfraNullableText_(value, key, limit) { return projectInfraText_(value, key, limit) || null; }
function projectInfraTags_(values, key) { return Array.isArray(values) ? values.slice(0, 100).filter(function (value) { return typeof value === 'string'; }).map(function (value) { return projectInfraText_(value, key, 200); }) : []; }
function projectInfraProviderErrors_(value, key) { var message = projectInfraText_(value, key); return message ? [{ code: 'COLDY_ACCOUNT_ERROR', message: message }] : []; }
function projectInfraErrorsPublic_(values, key) { return Array.isArray(values) ? values.slice(0, 10).map(function (item) { return { code: projectInfraText_(item && item.code, key, 100), message: projectInfraText_(item && item.message, key) }; }).filter(function (item) { return !!item.message; }) : []; }
function projectInfraWarmup_(source, detail, key) {
  source = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  var enabled = detail ? source.enabled : source.warmup;
  return { enabled: typeof enabled === 'boolean' ? enabled : null, status: detail ? projectInfraNullableText_(source.status, key, 100) : null,
    sentToday: projectInfraCount_(detail ? source.sent_today : source.warmup_sent_today), repliesToday: null,
    dailyLimit: projectInfraCount_(detail ? source.daily_limit : source.warmup_daily_limit),
    startedAt: projectInfraNullableText_(detail ? source.started_at : source.warmup_start_date, key, 100),
    lastScheduledAt: detail ? projectInfraNullableText_(source.last_scheduled_at, key, 100) : null };
}
function projectInfraWarmupPublic_(source, key) {
  source = source && typeof source === 'object' ? source : {};
  return { enabled: typeof source.enabled === 'boolean' ? source.enabled : null, status: projectInfraNullableText_(source.status, key, 100),
    sentToday: projectInfraCount_(source.sentToday), repliesToday: null, dailyLimit: projectInfraCount_(source.dailyLimit),
    startedAt: projectInfraNullableText_(source.startedAt, key, 100), lastScheduledAt: projectInfraNullableText_(source.lastScheduledAt, key, 100) };
}
function projectInfraScopeError_(error) { return !!error && ['LINK_ACCESS_REQUIRED', 'LINK_SETUP_REQUIRED', 'SOURCE_CHANGED', 'OUTSIDE_REGISTRY', 'COLDY_CREDENTIAL_CHANGED', 'COLDY_MONITORING_CHANGED'].indexOf(error.registryCode) !== -1; }
function projectInfraError_(error) {
  var code = error && typeof error.registryCode === 'string' && /^[A-Z_]{1,100}$/.test(error.registryCode) ? error.registryCode : 'COLDY_INFRA_REFRESH';
  var messages = { COLDY_AUTH: 'Coldy не принял API-ключ. Проверьте подключение.', COLDY_FORBIDDEN: 'Coldy не разрешил прочитать сведения о ящике.',
    COLDY_NOT_FOUND: 'Ящик больше не найден в Coldy. Обновите общий список.', COLDY_RATE_LIMIT: 'Coldy просит подождать перед следующим запросом.',
    COLDY_NETWORK: 'Нет подтверждённого ответа Coldy. Сохранённые сведения могут быть устаревшими.', COLDY_UNAVAILABLE: 'Coldy временно недоступен. Повторите синхронизацию позже.',
    COLDY_OWNER_AUTH_REQUIRED: 'Владельцу Apps Script нужно один раз разрешить внешние запросы Coldy.',
    COLDY_INFRA_INCOMPLETE: 'Список почт получен не полностью. Прежние сведения сохранены.', COLDY_INFRA_ACCOUNT_CHANGED: 'Сведения о ящике изменились во время синхронизации.',
    COLDY_RESPONSE: 'Coldy не подтвердил формат сведений о ящике.' };
  return { code: code, message: messages[code] || 'Не удалось обновить сведения о ящиках. Прежние значения сохранены.' };
}
