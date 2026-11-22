/** One-project sender inventory. Provider reads never create or modify senders. */
var PROJECT_INFRASTRUCTURE = Object.freeze({ version: 1, batch: 5, maxAccounts: 1000, maxReceipts: 201, cacheMillis: 300000, textLimit: 2000 });

/** Cached metadata by default. Explicit diagnostics return only provider structure and counts. */
function getProjectInfrastructure_(request) {
  return api_(function () {
    var input = coldyInput_(request === undefined ? {} : request, ['diagnose']);
    if (input.diagnose !== undefined && typeof input.diagnose !== 'boolean') fail_('INVALID_REQUEST', 'Некорректный режим диагностики почтовой инфраструктуры.');
    var context = authorize_(), settings = coldySettings_(context), saved = projectInfraRead_(context, settings);
    if (input.diagnose === true) {
      var response = coldyApi_(context, 'GET', '/accounts');
      var arrayLength = function (value) { return Array.isArray(value) ? value.length : null; };
      var diagnostics = { itemsIsArray: Array.isArray(response.items), itemsLength: arrayLength(response.items),
        maxSupportedAccounts: PROJECT_INFRASTRUCTURE.maxAccounts,
        reportedTotal: projectInfraCount_(response.total), hasMore: response.has_more === true,
        hasContinuation: !!(response.next_cursor || response.nextPageToken),
        dataArrayLength: arrayLength(response.data), dataItemsLength: arrayLength(response.data && response.data.items),
        accountsArrayLength: arrayLength(response.accounts), resultsArrayLength: arrayLength(response.results) };
      projectInfraCurrent_(context, settings.credentialHash);
      return { diagnostics: diagnostics };
    }
    projectInfraCurrent_(context, settings.credentialHash);
    return projectInfraPublic_(context, saved);
  });
}

/** One inventory request plus at most five account details; later calls continue. */
function refreshProjectInfrastructure_(request) {
  return api_(function () {
    var input = coldyInput_(request === undefined ? {} : request, ['cursor']);
    if (input.cursor !== undefined && (typeof input.cursor !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.cursor))) fail_('INVALID_REQUEST', 'Некорректное продолжение синхронизации почт.');
    var context = authorize_(), settings = coldySettings_(context), before = projectInfraRead_(context, settings), started = Date.now();
    if (!settings.configured) return projectInfraPublic_(context, null);
    projectInfraCurrent_(context, settings.credentialHash);
    if (input.cursor !== undefined) {
      if (!before) fail_('COLDY_INFRA_CURSOR_STALE', 'Обновите список почт перед продолжением.');
      if (before.processedCursors.indexOf(input.cursor) !== -1) return projectInfraPublic_(context, before);
      if (!before.nextCursor || input.cursor !== before.nextCursor) fail_('COLDY_INFRA_CURSOR_STALE', 'Синхронизация почт уже изменилась. Обновите список.');
    }
    if (before && before.retryAt > Date.now()) return projectInfraPublic_(context, before);
    var state;
    try {
      if (input.cursor === undefined) {
        var response = coldyApi_(context, 'GET', '/accounts');
        var accounts = projectInfraInventory_(response, settings.key), now = new Date().toISOString();
        var oldById = Object.create(null);
        if (before) before.accounts.forEach(function (item) { oldById[item.id] = item; });
        accounts.forEach(function (item) {
          var old = oldById[item.id];
          if (old && old.email === item.email) {
            item.status = old.status;
            item.updatedAt = old.updatedAt;
          }
        });
        state = { version: PROJECT_INFRASTRUCTURE.version, rootId: context.rootId, credentialHash: settings.credentialHash,
          generation: digest_('infrastructure|' + Utilities.getUuid() + '|' + started), startedAt: started,
          accounts: accounts, cursorIndex: 0, processedCursors: [], nextCursor: null, inventoryAt: now,
          updatedAt: now, lastAttemptAt: now, retryAt: 0, warnings: [], lastError: null };
      } else state = JSON.parse(JSON.stringify(before));
      projectInfraDetails_(context, settings, state);
    } catch (error) {
      if (projectInfraScopeError_(error)) throw error;
      return projectInfraFailure_(context, settings, started, before, error);
    }
    return locked_(function () {
      var fresh = projectInfraCurrent_(context, settings.credentialHash), latest = projectInfraRead_(fresh, coldySettings_(fresh));
      if (input.cursor !== undefined) {
        if (!latest || latest.generation !== before.generation) fail_('COLDY_INFRA_CURSOR_STALE', 'Список почт изменился. Обновите его перед продолжением.');
        if (latest.processedCursors.indexOf(input.cursor) !== -1) return projectInfraPublic_(fresh, latest);
        if (latest.cursorIndex !== before.cursorIndex || latest.nextCursor !== input.cursor) fail_('COLDY_INFRA_CURSOR_STALE', 'Продолжение уже обработано. Обновите список почт.');
        if (state.cursorIndex > before.cursorIndex) state.processedCursors.push(input.cursor);
      } else if (latest && latest.generation !== (before && before.generation) && latest.startedAt >= started) {
        return projectInfraPublic_(fresh, latest);
      }
      state.processedCursors = state.processedCursors.slice(-PROJECT_INFRASTRUCTURE.maxReceipts);
      state.nextCursor = state.cursorIndex < state.accounts.length ? projectInfraCursor_(state) : null;
      state.updatedAt = new Date().toISOString();
      state.lastAttemptAt = state.updatedAt;
      coldySave_(fresh, 'infrastructure', settings.credentialHash, state);
      // A successful authenticated account read also verifies this connection.
      if (!state.lastError) fresh.properties.setProperty(COLDY.connectionProperty, JSON.stringify({ version: COLDY.version,
        rootId: fresh.rootId, credentialHash: settings.credentialHash, checkedAt: state.updatedAt }));
      return projectInfraPublic_(fresh, state);
    });
  });
}

function projectInfraDetails_(context, settings, state) {
  state.lastError = null;
  state.retryAt = 0;
  state.warnings = [];
  var stop = Math.min(state.accounts.length, state.cursorIndex + PROJECT_INFRASTRUCTURE.batch);
  for (; state.cursorIndex < stop; state.cursorIndex++) {
    var item = state.accounts[state.cursorIndex];
    try {
      projectInfraCurrent_(context, settings.credentialHash);
      var detail = coldyApi_(context, 'GET', '/accounts/' + item.id);
      state.accounts[state.cursorIndex] = projectInfraDetail_(item, detail, settings.key);
    } catch (error) {
      if (projectInfraScopeError_(error) || error.registryCode === 'COLDY_AUTH' || error.registryCode === 'COLDY_OWNER_AUTH_REQUIRED') throw error;
      item.stale = true;
      item.syncError = projectInfraError_(error);
      if (['COLDY_RATE_LIMIT', 'COLDY_NETWORK', 'COLDY_UNAVAILABLE'].indexOf(error.registryCode) !== -1) {
        state.lastError = projectInfraError_(error);
        state.retryAt = Date.now() + Math.max(15000, Math.min(86400000, error.retryAfterMs || 0));
        state.warnings.push(state.lastError.message);
        break;
      }
    }
  }
  if (state.accounts.some(function (item) { return !!item.syncError; })) state.warnings.push('Часть сведений о ящиках не обновлена. Сохранённые значения отмечены как устаревшие.');
}

function projectInfraFailure_(context, settings, started, before, error) {
  return locked_(function () {
    var fresh = projectInfraCurrent_(context, settings.credentialHash), latest = projectInfraRead_(fresh, coldySettings_(fresh));
    if (latest && (latest.generation !== (before && before.generation) && latest.startedAt >= started ||
        before && latest.generation === before.generation && latest.cursorIndex > before.cursorIndex)) return projectInfraPublic_(fresh, latest);
    var now = new Date().toISOString(), saved = latest || { version: PROJECT_INFRASTRUCTURE.version, rootId: fresh.rootId,
      credentialHash: settings.credentialHash, generation: digest_('infrastructure-error|' + Utilities.getUuid()), startedAt: started,
      accounts: [], cursorIndex: 0, processedCursors: [], nextCursor: null, inventoryAt: null };
    saved.lastError = projectInfraError_(error);
    saved.lastAttemptAt = now;
    saved.updatedAt = now;
    saved.warnings = [saved.lastError.message];
    saved.accounts.forEach(function (item) { item.stale = true; });
    if (error.registryCode === 'COLDY_RATE_LIMIT' || error.registryCode === 'COLDY_UNAVAILABLE') saved.retryAt = Date.now() + Math.max(15000, Math.min(86400000, error.retryAfterMs || 0));
    coldySave_(fresh, 'infrastructure', settings.credentialHash, saved);
    return projectInfraPublic_(fresh, saved);
  });
}

function projectInfraCurrent_(context, hash) {
  var current = coldyCurrent_(context, true), settings = coldySettings_(current);
  if (settings.credentialHash !== hash) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился. Повторите синхронизацию почт.');
  return current;
}

function projectInfraRead_(context, settings) {
  if (!settings.configured) return null;
  var saved = coldyLoad_(context, 'infrastructure', settings.credentialHash);
  if (!saved) return null;
  if (saved.version !== PROJECT_INFRASTRUCTURE.version || saved.rootId !== context.rootId || saved.credentialHash !== settings.credentialHash ||
      typeof saved.generation !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(saved.generation) || !Number.isFinite(saved.startedAt) ||
      !Array.isArray(saved.accounts) || saved.accounts.length > PROJECT_INFRASTRUCTURE.maxAccounts ||
      !Number.isSafeInteger(saved.cursorIndex) || saved.cursorIndex < 0 || saved.cursorIndex > saved.accounts.length ||
      !Array.isArray(saved.processedCursors) || saved.processedCursors.length > PROJECT_INFRASTRUCTURE.maxReceipts ||
      saved.processedCursors.some(function (value) { return typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value); }) ||
      saved.nextCursor !== null && (typeof saved.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(saved.nextCursor)) ||
      settings.key && JSON.stringify(saved).indexOf(settings.key) !== -1) fail_('COLDY_STORAGE', 'Сохранённый список почт Coldy требует проверки.');
  var seen = Object.create(null);
  saved.accounts.forEach(function (item) {
    if (!item || typeof item.id !== 'string' || projectInfraId_(item.id) !== item.id || typeof item.email !== 'string' || !coldyEmail_(item.email) || seen[item.id]) fail_('COLDY_STORAGE', 'Сохранённые ящики Coldy требуют проверки.');
    seen[item.id] = true;
  });
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
    return { id: id, email: email, name: [projectInfraText_(item.first_name, key, 200), projectInfraText_(item.last_name, key, 200)].filter(Boolean).join(' '),
      provider: projectInfraNullableText_(item.service, key, 200), status: null, sentTotal: projectInfraCount_(item.total_sent),
      sentToday: projectInfraCount_(item.sent_today), dailyLimit: projectInfraCount_(item.limit), errorCount: null,
      errors: projectInfraProviderErrors_(item.error_text, key), tags: projectInfraTags_(item.tags, key),
      warmup: projectInfraWarmup_(item, false, key), updatedAt: null, stale: true, syncError: null };
  });
}

function projectInfraDetail_(listed, response, key) {
  if (!response || typeof response !== 'object' || Array.isArray(response) || projectInfraId_(response.id) !== listed.id || projectInfraEmail_(response.email) !== listed.email) fail_('COLDY_INFRA_ACCOUNT_CHANGED', 'Сведения о ящике изменились во время синхронизации.');
  return { id: listed.id, email: listed.email,
    name: [projectInfraText_(response.first_name, key, 200), projectInfraText_(response.last_name, key, 200)].filter(Boolean).join(' ') || listed.name,
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

function projectInfraPublic_(context, saved) {
  var settings = coldySettings_(context), known = !!saved && !!saved.inventoryAt, stale = !saved || !saved.inventoryAt || Date.parse(saved.inventoryAt) < Date.now() - PROJECT_INFRASTRUCTURE.cacheMillis;
  var accounts = known ? saved.accounts.map(function (item) {
    return { id: item.id, email: item.email, name: projectInfraText_(item.name, settings.key, 500), provider: projectInfraNullableText_(item.provider, settings.key, 200),
      status: projectInfraNullableText_(item.status, settings.key, 200), sentTotal: projectInfraCount_(item.sentTotal), sentToday: projectInfraCount_(item.sentToday), dailyLimit: projectInfraCount_(item.dailyLimit),
      errorCount: null, errors: projectInfraErrorsPublic_(item.errors, settings.key), tags: projectInfraTags_(item.tags, settings.key),
      warmup: projectInfraWarmupPublic_(item.warmup, settings.key), updatedAt: item.updatedAt || null, stale: stale || item.stale === true,
      syncError: item.syncError ? { code: projectInfraText_(item.syncError.code, settings.key, 100), message: projectInfraText_(item.syncError.message, settings.key) } : null };
  }) : [];
  var state = !settings.configured ? 'not_configured' : !known ? (saved && saved.lastError ? 'error' : 'not_synced') :
    stale || saved.lastError || saved.nextCursor || accounts.some(function (item) { return item.stale || item.syncError; }) ? 'partial' : 'ready';
  var result = { state: state, configured: settings.configured, connected: settings.connected, accounts: accounts,
    totals: projectInfraTotals_(accounts, known), lastSyncAt: saved && saved.inventoryAt || null, updatedAt: saved && saved.updatedAt || null,
    lastAttemptAt: saved && saved.lastAttemptAt || null, warnings: (saved && saved.warnings || []).map(function (message) { return projectInfraText_(message, settings.key); }),
    nextCursor: saved && saved.nextCursor || null, detailProgress: { completed: known ? saved.cursorIndex : 0, total: known ? accounts.length : 0 },
    retryAfterMs: saved && Number.isFinite(saved.retryAt) ? Math.max(0, saved.retryAt - Date.now()) : 0,
    syncPaused: !!(saved && (saved.lastError || saved.retryAt > Date.now())),
    error: saved && saved.lastError ? { code: projectInfraText_(saved.lastError.code, settings.key, 100), message: projectInfraText_(saved.lastError.message, settings.key) } : null,
    stale: stale || !!(saved && saved.lastError), countersScope: 'organization_accounts', cached: !!saved };
  projectInfraCurrent_(context, settings.credentialHash);
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

function projectInfraCursor_(state) { return digest_(JSON.stringify(['infrastructure-cursor', state.rootId, state.credentialHash, state.generation, state.cursorIndex])); }
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
function projectInfraScopeError_(error) { return !!error && ['LINK_ACCESS_REQUIRED', 'LINK_SETUP_REQUIRED', 'SOURCE_CHANGED', 'OUTSIDE_REGISTRY', 'COLDY_CREDENTIAL_CHANGED'].indexOf(error.registryCode) !== -1; }
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
