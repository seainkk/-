/** Shared sender selection. No provider request or business-sheet write is performed here. */
var PROJECT_MONITORING = Object.freeze({ version: 1, maxAccounts: 5000, maxReceipts: 200 });

// Keep the original journal address and request fingerprints for the first project.
function projectMonitoringOwner_(credentialHash) {
  var project = typeof registryProjectId_ === 'function' ? registryProjectId_() : 'numshield';
  return project === 'numshield' ? credentialHash : credentialHash + ':' + project;
}

function projectMonitoringRead_(context, settings) {
  var owner = projectMonitoringOwner_(settings.credentialHash), state = settings.configured ? coldyLoad_(context, 'monitoring', owner) : null;
  if (owner !== projectMonitoringOwner_(settings.credentialHash)) fail_('COLDY_MONITORING_CHANGED', 'Проект изменился. Обновите выбор почт.');
  if (!state) return { version: PROJECT_MONITORING.version, rootId: context.rootId,
    credentialHash: settings.credentialHash, revision: 0, accountIds: [], configured: false, receipts: [] };
  if (state.version !== PROJECT_MONITORING.version || state.rootId !== context.rootId || state.credentialHash !== settings.credentialHash ||
      !Number.isSafeInteger(state.revision) || state.revision < 0 || state.revision >= Number.MAX_SAFE_INTEGER ||
      typeof state.configured !== 'boolean' || !Array.isArray(state.receipts) || state.receipts.length > PROJECT_MONITORING.maxReceipts ||
      settings.key && JSON.stringify(state).indexOf(settings.key) !== -1) fail_('COLDY_STORAGE', 'Сохранённый выбор ящиков требует проверки.');
  var ids = projectMonitoringIds_(state.accountIds, 'COLDY_STORAGE');
  if (JSON.stringify(ids) !== JSON.stringify(state.accountIds) ||
      !state.configured && (state.revision !== 0 || ids.length || state.receipts.length) ||
      state.configured && state.revision < 1) fail_('COLDY_STORAGE', 'Сохранённый выбор ящиков требует проверки.');
  var seen = Object.create(null);
  state.receipts.forEach(function (receipt) {
    if (!receipt || typeof receipt.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(receipt.requestId) || seen[receipt.requestId] ||
        typeof receipt.requestHash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(receipt.requestHash) ||
        !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || receipt.revision > state.revision) fail_('COLDY_STORAGE', 'Журнал выбора ящиков требует проверки.');
    seen[receipt.requestId] = true;
  });
  return state;
}

function projectMonitoringPublic_(context, state) {
  if (!state || state.rootId !== context.rootId) fail_('COLDY_STORAGE', 'Выбор ящиков относится к другому реестру.');
  return { revision: state.revision, accountIds: state.accountIds.slice(), configured: state.configured,
    scopeToken: digest_(JSON.stringify(['monitoring-scope:v1', context.rootId, projectMonitoringOwner_(state.credentialHash)])) };
}

function projectMonitoringSignature_(context, state) {
  if (!state || state.rootId !== context.rootId) fail_('COLDY_STORAGE', 'Выбор ящиков относится к другому реестру.');
  return digest_(JSON.stringify(['monitoring-selection:v1', context.rootId, projectMonitoringOwner_(state.credentialHash),
    state.revision, state.configured, state.accountIds]));
}

/** Cached picker inventory only; opening the selection does not fan out to Coldy. */
function getProjectInfrastructureSelection_(request) {
  return api_(function () {
    coldyInput_(request === undefined ? {} : request, []);
    var context = authorize_(), settings = coldySettings_(context), state = projectMonitoringRead_(context, settings);
    var inventory = projectInfraRead_(context, settings), accounts = inventory && inventory.inventoryAt ? inventory.accounts : [];
    var result = { configured: settings.configured, selection: projectMonitoringPublic_(context, state),
      accounts: accounts.map(function (item) { return { id: item.id, email: projectInfraEmail_(item.email),
        name: projectInfraText_(item.name, settings.key, 500), provider: projectInfraNullableText_(item.provider, settings.key, 200) }; }),
      availableCount: accounts.length, inventoryAt: inventory && inventory.inventoryAt || null };
    projectInfraCurrent_(context, settings.credentialHash);
    return result;
  });
}

/** Optimistic, idempotent project selection; no provider calls or cursor mutations. */
function saveProjectInfrastructureSelection_(request) {
  return api_(function () {
    var input = coldyInput_(request, ['accountIds', 'expectedRevision', 'scopeToken', 'requestId']);
    var accountIds = projectMonitoringIds_(input.accountIds, 'INVALID_REQUEST');
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
        typeof input.scopeToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.scopeToken) ||
        typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId)) fail_('INVALID_REQUEST', 'Обновите форму выбора ящиков.');
    var context = authorize_(), settings = coldySettings_(context);
    if (!settings.configured) fail_('COLDY_KEY_REQUIRED', 'Сначала подключите Coldy.');
    var requestHash = digest_(JSON.stringify(['monitoring-save:v1', input.scopeToken, input.expectedRevision, accountIds]));
    var confirmation = locked_(function () {
      var fresh = projectInfraCurrent_(context, settings.credentialHash), currentSettings = coldySettings_(fresh);
      var state = projectMonitoringRead_(fresh, currentSettings), publicState = projectMonitoringPublic_(fresh, state);
      if (input.scopeToken !== publicState.scopeToken) fail_('COLDY_MONITORING_SCOPE_CHANGED', 'Подключение или реестр изменились. Обновите выбор ящиков.');
      var receipt = state.receipts.filter(function (item) { return item.requestId === input.requestId; })[0];
      if (receipt) {
        if (receipt.requestHash !== requestHash) fail_('COLDY_MONITORING_REQUEST_MISMATCH', 'Этот запрос уже использован для другого выбора. Продолжите прежний запрос.');
        return { replayed: true, savedRevision: receipt.revision };
      }
      if (input.expectedRevision !== state.revision) fail_('COLDY_MONITORING_STALE', 'Выбор ящиков уже изменён коллегой. Обновите список и проверьте отметки.');
      if (state.revision >= Number.MAX_SAFE_INTEGER - 1) fail_('COLDY_STORAGE', 'Версия выбора ящиков требует проверки.');
      var inventory = projectInfraRead_(fresh, currentSettings), available = Object.create(null);
      if (inventory && inventory.inventoryAt) inventory.accounts.forEach(function (item) { available[item.id] = true; });
      if (accountIds.some(function (id) { return !available[id]; })) fail_('COLDY_MONITORING_ACCOUNT_MISSING', 'Один из выбранных ящиков недоступен. Обновите список Coldy.');
      var next = { version: PROJECT_MONITORING.version, rootId: fresh.rootId, credentialHash: currentSettings.credentialHash,
        revision: state.revision + 1, accountIds: accountIds, configured: true,
        receipts: state.receipts.concat([{ requestId: input.requestId, requestHash: requestHash, revision: state.revision + 1 }]).slice(-PROJECT_MONITORING.maxReceipts) };
      projectInfraCurrent_(fresh, currentSettings.credentialHash);
      coldySave_(fresh, 'monitoring', projectMonitoringOwner_(currentSettings.credentialHash), next);
      return { replayed: false, savedRevision: next.revision };
    });
    var current = projectInfraCurrent_(context, settings.credentialHash);
    var data = projectInfraPublic_(current, projectInfraRead_(current, settings));
    if (data.monitoring.scopeToken !== input.scopeToken) fail_('COLDY_MONITORING_SCOPE_CHANGED', 'Проект или подключение изменились. Обновите выбор ящиков.');
    var selection = { revision: data.monitoring.revision, accountIds: data.monitoring.accountIds,
      configured: data.monitoring.configured, scopeToken: data.monitoring.scopeToken };
    return { selection: selection, infrastructure: data, replayed: confirmation.replayed, savedRevision: confirmation.savedRevision };
  });
}

function projectMonitoringIds_(input, code) {
  if (!Array.isArray(input) || input.length > PROJECT_MONITORING.maxAccounts) fail_(code, 'Выберите не больше 5000 ящиков.');
  var seen = Object.create(null);
  var ids = input.map(function (value) {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || seen[value]) fail_(code, 'Некорректный или повторяющийся идентификатор ящика.');
    seen[value] = true; return value;
  });
  return ids.sort(function (a, b) { return Number(a) - Number(b); });
}
