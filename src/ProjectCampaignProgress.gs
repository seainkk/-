/** All bound campaigns are included, even when a campaign has no monitored sender. */
function projectCompletionBindings_(context, observation) {
  if (!observation.registry || !observation.unchanged || !observation.unchanged()) {
    delete observation.unchanged;
    observation.registry = coldyCampaignRegistry_(context,observation);
  }
  var registry = observation.registry;
  if (registry.credentialHash !== coldyCredentialHash_(context)) fail_('COLDY_CREDENTIAL_CHANGED','Подключение Coldy изменилось.');
  var ids = registry.bindings.map(function (b) { return coldyCampaignId_(b.campaignId); });
  var owners = projectCapacityOwners_(context,ids,observation);
  return registry.bindings.filter(function (b) {
    var owner = owners[b.campaignId];
    return owner && owner.bindingState === 'linked' && owner.segmentId === b.segmentId;
  }).map(function (b) { return [b.campaignId,b.segmentId,b.id]; })
    .sort(function (a,b) { return a[0].localeCompare(b[0]); });
}

function projectCompletionPublic_(saved,preview,ids) {
  var campaignCompletions = {};
  (ids || []).forEach(function (id) {
    var item = saved && saved.report && saved.report[id];
    if (!item || ['unknown','empty','completed','paused','estimated'].indexOf(item.state) === -1) return;
    var count = function (n) { return Number.isSafeInteger(n) && n >= 0 ? n : null; };
    campaignCompletions[id] = {sent:count(item.sent), remaining:count(item.remaining), total:count(item.total),
      percent:count(item.percent) !== null && item.percent <= 100 ? item.percent : null, state:item.state,
      estimatedDate:/^\d{4}-\d{2}-\d{2}$/.test(item.estimatedDate) ? item.estimatedDate : null,
      reason:typeof item.reason === 'string' && /^[a-z_]{1,45}$/.test(item.reason) ? item.reason : null,
      generatedAt:item.generatedAt || null};
  });
  var age = saved && Date.now() - Date.parse(saved.generatedAt);
  return {campaignCompletions:campaignCompletions,generatedAt:saved && saved.generatedAt || null,
    freshForMs:saved && !saved.work && Number.isFinite(age) && age >= 0 ? Math.max(0,COLDY.cacheMillis-age) : 0,
    pending:!preview && !!(saved && saved.work),retryAfterMs:saved ? Math.max(0,(saved.retryAt || 0)-Date.now()) : 0,
    message:saved && saved.message || ''};
}

/** Read-only provider requests advance a private, versioned checkpoint shared by all project views. */
function getProjectCampaignCompletions_(request) {
  return api_(function () {
    var input = projectAnalyticsInput_(request,['preview']);
    if (input.preview !== undefined && typeof input.preview !== 'boolean') fail_('INVALID_REQUEST','Проверьте режим чтения прогресса.');
    var context = authorize_(), settings = coldySettings_(context);
    if (!settings.configured) return projectCompletionPublic_(null,true);
    var owner = projectMonitoringOwner_(settings.credentialHash), monitoringRead = {}, bindingsRead = {};
    var saved = coldyLoad_(context,'campaignprogress',owner), receipt = saved && saved.revision;
    if (input.preview && !saved) return projectCompletionPublic_(null,true);
    var monitoring = projectMonitoringRead_(context,settings,monitoringRead);
    var signature = projectMonitoringSignature_(context,monitoring);
    var checkSelection = projectInfraMonitoringGuard_(context,settings.credentialHash,signature,monitoringRead);
    var bindings = projectCompletionBindings_(context,bindingsRead);
    var scope = digest_(JSON.stringify([signature,bindings]));
    var ids = bindings.map(function (b) { return b[0]; });
    function checkScope() {
      var fresh = checkSelection();
      if (scope !== digest_(JSON.stringify([signature,projectCompletionBindings_(fresh,bindingsRead)])))
        fail_('COLDY_MONITORING_CHANGED','Изменились привязки рассылок. Обновите прогресс.');
      return fresh;
    }
    if (!ids.length) return projectCompletionPublic_(null,true);
    if (typeof coldyIncomingEnsure_ === 'function') coldyIncomingEnsure_(context,false);
    var matching = saved && saved.scope === scope ? saved : null, now = Date.now();
    if (input.preview || matching && (matching.retryAt > now ||
        !matching.work && now - Date.parse(matching.generatedAt) < COLDY.cacheMillis)) {
      // All current campaign folders were verified after loading this read-only snapshot.
      checkSelection();
      return projectCompletionPublic_(matching,input.preview,ids);
    }
    var state = matching && matching.work && now - matching.touchedAt < 1800000 ? matching :
      {scope:scope,work:{},progress:{campaignsDone:0,campaignsTotal:ids.length,contactsRead:0},
       report:matching && matching.report || {},generatedAt:matching && matching.generatedAt || null};
    state.retryAt = 0; state.message = '';
    var selected = new Map(bindings.map(function (b) { return [b[0],b]; }));
    function guard(id) {
      var fresh = checkSelection(), expected = selected.get(id);
      var current = projectCapacityOwners_(fresh,[id],bindingsRead)[id];
      if (!expected || !current || current.bindingState !== 'linked' || current.segmentId !== expected[1] ||
          !bindingsRead.registry.bindings.some(function (b) { return b.id === expected[2] && b.campaignId === id && b.segmentId === expected[1]; }))
        fail_('COLDY_MONITORING_CHANGED','Привязка рассылки изменилась. Обновите прогресс.');
    }
    var before = state.progress.campaignsDone;
    try {
      if (before < ids.length) projectForecastCollect_(context,ids,state,guard,true);
    } catch (error) {
      if (['COLDY_NOT_FOUND','COLDY_FORBIDDEN','COLDY_FORECAST_CHANGED','COLDY_RESPONSE'].indexOf(error.registryCode) >= 0) {
        // One deleted or changing campaign must not prevent the other campaigns from being scanned.
        var failed = ids[state.progress.campaignsDone];
        state.work[failed] = {unavailable:true};
        delete state.report[failed];
        state.progress.campaignsDone++;
        if (error.retryAfterMs > 0) state.retryAt = Date.now() + error.retryAfterMs;
      } else {
        if (['COLDY_NETWORK','COLDY_UNAVAILABLE','COLDY_RATE_LIMIT','COLDY_CONFLICT','COLDY_PROVIDER'].indexOf(error.registryCode) < 0) throw error;
        state.message = 'Coldy временно отложил получение данных. Сохранили позицию в списке адресатов.';
        state.retryAt = Date.now() + Math.max(15000, Number(error.retryAfterMs) || 60000);
      }
    }
    var scanned = state.progress.campaignsDone === ids.length;
    if (scanned || state.progress.campaignsDone > before) {
      var infra = {accounts:[],monitoring:{accountIds:[]},capacity:{campaigns:[],stale:true}};
      var waiting = false;
      if (scanned && monitoring.accountIds.length && ids.some(function (id) { return state.work[id].campaignStatus === 'Active'; })) {
        var inventory = projectInfraRead_(context,settings);
        infra = projectInfraPublic_(context,inventory,signature);
        var oldFailure = !infra.lastAttemptAt || now - Date.parse(infra.lastAttemptAt) >= 60000;
        if (!projectForecastInfrastructureReady_(infra) && !infra.retryAfterMs && (!infra.error || oldFailure)) {
          try {
            infra = refreshProjectInfrastructure_(infra.nextCursor ? {cursor:infra.nextCursor} : {includeCapacity:true,live:true});
          } catch (error) {
            if (['BUSY','COLDY_NETWORK','COLDY_UNAVAILABLE','COLDY_RATE_LIMIT','COLDY_CONFLICT'].indexOf(error.registryCode) < 0) throw error;
            state.retryAt = Date.now() + Math.max(15000,Number(error.retryAfterMs) || 60000);
          }
        }
        if (infra.monitoring.revision !== monitoring.revision ||
            JSON.stringify(infra.monitoring.accountIds) !== JSON.stringify(monitoring.accountIds))
          fail_('COLDY_MONITORING_CHANGED','Выбор почт проекта изменился во время расчёта.');
        if (infra.retryAfterMs > 0) state.retryAt = Math.max(state.retryAt,Date.now() + infra.retryAfterMs);
        waiting = !!state.retryAt || !!infra.nextCursor && !infra.error;
        if (waiting) state.message = 'Обновляем расписания и лимиты почт для оценки даты.';
      }
      var report = projectCampaignCompletions_(infra,state.work,now);
      var generated = new Date().toISOString();
      ids.forEach(function (id) {
        if (state.work[id] && (state.work[id].complete || state.work[id].unavailable) && report[id]) {
          if (state.work[id].unavailable) report[id].reason = 'unavailable';
          state.report[id] = Object.assign({},report[id],{generatedAt:generated});
        }
      });
      state.generatedAt = generated;
      if (scanned && !waiting) state.work = null;
    }
    return locked_(function () {
      var fresh = checkScope(), latest = coldyLoad_(fresh,'campaignprogress',owner);
      if ((latest && latest.revision) !== receipt) {
        if (!latest || latest.scope !== scope) fail_('COLDY_MONITORING_CHANGED','Состав проекта изменился. Обновите прогресс.');
        return projectCompletionPublic_(latest,false,ids);
      }
      state.revision = Utilities.getUuid(); state.touchedAt = Date.now();
      return projectCompletionPublic_(coldySave_(fresh,'campaignprogress',owner,state),false,ids);
    });
  });
}
