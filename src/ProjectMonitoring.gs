/** Shared sender selection and explicit, bounded mailbox discovery. */
var PROJECT_MONITORING = Object.freeze({ version: 1, maxAccounts: 5000, maxReceipts: 200 });

// Keep the original journal address and request fingerprints for the first project.
function projectMonitoringOwner_(credentialHash) {
  var project = typeof registryProjectId_ === 'function' ? registryProjectId_() : 'numshield';
  return project === 'numshield' ? credentialHash : credentialHash + ':' + project;
}

function projectMonitoringRead_(context, settings, observation) {
  var owner = projectMonitoringOwner_(settings.credentialHash), state = settings.configured ? coldyLoad_(context, 'monitoring', owner, observation) : null;
  if (owner !== projectMonitoringOwner_(settings.credentialHash)) fail_('COLDY_MONITORING_CHANGED', 'Проект изменился. Обновите выбор почт.');
  if (!state) return { version: PROJECT_MONITORING.version, rootId: context.rootId,
    credentialHash: settings.credentialHash, revision: 0, accountIds: [], configured: false, receipts: [] };
  if (state.version !== PROJECT_MONITORING.version || state.rootId !== context.rootId || state.credentialHash !== settings.credentialHash ||
      !Number.isSafeInteger(state.revision) || state.revision < 0 || state.revision >= Number.MAX_SAFE_INTEGER ||
      typeof state.configured !== 'boolean' || !Array.isArray(state.receipts) || state.receipts.length > PROJECT_MONITORING.maxReceipts ||
      settings.key && JSON.stringify(state).indexOf(settings.key) !== -1) fail_('COLDY_STORAGE', 'Сохранённый выбор ящиков требует проверки.');
  var ids = projectMonitoringIds_(state.accountIds, 'COLDY_STORAGE');
  if (state.accounts !== undefined && (!Array.isArray(state.accounts) || state.accounts.length !== ids.length ||
      state.accounts.some(function (item,index) { return !item || item.id !== ids[index] || typeof item.email !== 'string' ||
        !coldyEmail_(item.email) || typeof item.name !== 'string' || item.provider !== null && typeof item.provider !== 'string'; }))) {
    fail_('COLDY_STORAGE','Сохранённые сведения о выбранных ящиках требуют проверки.');
  }
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

/** The picker opens on the selected mailboxes. Provider discovery requires an explicit search. */
function getProjectInfrastructureSelection_(request) {
  return api_(function () {
    var input = coldyInput_(request === undefined ? {} : request, ['query']);
    if (input.query !== undefined && (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 254)) fail_('INVALID_REQUEST', 'Введите ID, название или email ящика.');
    var context = authorize_(), settings = coldySettings_(context), observation = {};
    var state = projectMonitoringRead_(context, settings, observation);
    var selected = new Set(state.accountIds);
    // Modern selections already carry the sender identities. Read the larger
    // infrastructure journal only to recover a legacy selection without them.
    var inventory = selected.size && !Array.isArray(state.accounts) ? projectInfraRead_(context, settings) : null;
    var source = inventory && inventory.inventoryAt ? inventory.accounts.filter(function (item) { return !!item.email; }) : [];
    var chosen = new Map((state.accounts || []).map(function (item) { return [item.id,item]; }));
    source.forEach(function (item) { if (selected.has(item.id)) chosen.set(item.id,item); });
    var accounts = Array.from(chosen.values());
    function choice(item) { return { id:item.id, email:projectInfraEmail_(item.email),
      name:projectInfraText_(item.name, settings.key, 500), provider:projectInfraNullableText_(item.provider, settings.key, 200) }; }
    var matches = [];
    if (input.query !== undefined && settings.configured) {
      var query = input.query.trim().toLowerCase(), signature = projectMonitoringSignature_(context,state);
      var guard = projectInfraMonitoringGuard_(context,settings.credentialHash,signature,observation);
      var owner = projectMonitoringOwner_(settings.credentialHash);
      var candidates = coldyLoad_(context,'mailboxchoices',owner);
      var known = new Map(accounts.map(function (item) { return [item.id,item]; }));
      (candidates && candidates.accounts || []).forEach(function (item) { known.set(item.id,item); });
      var lookup = digest_(JSON.stringify(['mailbox-search:v1',context.rootId,owner,query])), cache, cachedIds;
      try {
        cache=CacheService.getScriptCache();cachedIds=JSON.parse(cache.get(lookup));
      } catch (unavailable) { /* The provider can answer directly when cache is unavailable. */ }
      var numeric=/^[1-9]\d*$/.test(query);
      if(!numeric && query.length<3)fail_('INVALID_REQUEST','Для поиска по названию или email введите минимум три символа.');
      var reusable=Array.isArray(cachedIds)&&cachedIds.length<=50&&cachedIds.every(function(id){return typeof id==='string'&&known.has(id);});
      if(reusable){
        matches=cachedIds.map(function(id){return known.get(id);});
      } else if (numeric) {
        var id = projectInfraId_(query);
        try {
          var detail = coldyApi_(guard(),'GET','/accounts/' + id);
          matches = [projectInfraDetail_({id:id,email:null},detail,settings.key,true)];
        } catch (error) { if (error.registryCode !== 'COLDY_NOT_FOUND') throw error; }
      } else {
        function matching(item) { return [item.name,item.email].some(function (text) { return String(text || '').toLowerCase().indexOf(query) >= 0; }); }
        // A partial local match on a surname must not hide other matching mailboxes.
        matches = Array.from(known.values()).filter(function(item){return item.email===query;});
        if (!matches.length) matches = projectInfraInventory_(coldyApi_(guard(),'GET','/accounts'),settings.key).filter(matching);
      }
      matches = matches.slice(0,50).map(choice);
      var changed=matches.some(function(item){return !known.has(item.id)||JSON.stringify(choice(known.get(item.id)))!==JSON.stringify(item);});
      if (changed) locked_(function () {
        var fresh = guard();
        var previous = coldyLoad_(fresh,'mailboxchoices',owner);
        var found = new Map(previous && Array.isArray(previous.accounts) ? previous.accounts.map(function (account) { return [account.id,account]; }) : []);
        matches.forEach(function (item) { found.delete(item.id); found.set(item.id,item); });
        coldySave_(fresh,'mailboxchoices',owner,{accounts:Array.from(found.values()).slice(-PROJECT_MONITORING.maxAccounts)});
      });
      guard();
      if(cache&&!reusable)try { cache.put(lookup,JSON.stringify(matches.map(function(item){return item.id;})),60); } catch(unavailable) {}
      var ids = new Set(matches.map(function (item) { return item.id; }));
      accounts = accounts.filter(function (item) { return !ids.has(item.id); }).concat(matches);
    }
    var result = { configured: settings.configured, selection: projectMonitoringPublic_(context, state),
      accounts: accounts.map(choice),
      availableCount: accounts.length, inventoryAt: inventory && inventory.inventoryAt || null };
    if(input.query!==undefined)result.matchIds=matches.map(function(item){return item.id;});
    if(input.query===undefined||!settings.configured)projectInfraCurrent_(context, settings.credentialHash);
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
      if (inventory && inventory.inventoryAt) inventory.accounts.forEach(function (item) {
        if (item.email && !(item.syncError && item.syncError.code === 'COLDY_NOT_FOUND')) available[item.id] = item;
      });
      if (accountIds.some(function (id) { return !available[id]; })) {
        var choices = coldyLoad_(fresh,'mailboxchoices',projectMonitoringOwner_(currentSettings.credentialHash));
        if (choices && Array.isArray(choices.accounts)) choices.accounts.forEach(function (item) { if (!available[item.id]) available[item.id] = item; });
        (state.accounts || []).forEach(function (item) { if (!available[item.id]) available[item.id] = item; });
      }
      if (accountIds.some(function (id) { return !available[id]; })) fail_('COLDY_MONITORING_ACCOUNT_MISSING', 'Один из выбранных ящиков недоступен. Обновите список Coldy.');
      var next = { version: PROJECT_MONITORING.version, rootId: fresh.rootId, credentialHash: currentSettings.credentialHash,
        revision: state.revision + 1, accountIds: accountIds, configured: true,
        accounts: accountIds.map(function (id) { var item = available[id]; return { id:id,email:projectInfraEmail_(item.email),
          name:projectInfraText_(item.name,settings.key,500),provider:projectInfraNullableText_(item.provider,settings.key,200) }; }),
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
