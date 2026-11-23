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

function projectCompletionQueueHash_(work) {
  var groups=work.cohorts.map(function (c) {return projectForecastCohortKey_(c)+'|'+c.count;});
  return digest_(JSON.stringify(groups.sort()));
}

function projectCompletionPrevious_(item,work) {
  if (!item) return null;
  var prior=item.previousEstimate || (item.state==='estimated' && {date:item.estimatedDate,generatedAt:item.generatedAt});
  if (!prior || !/^\d{4}-\d{2}-\d{2}$/.test(prior.date) || !Number.isFinite(Date.parse(prior.generatedAt))) return null;
  if (work) {
    if (work.unavailable || work.campaignStatus && work.campaignStatus!=='Active') return null;
    var proof=item.estimateInputs, counts=work.completion;
    if (counts && (counts.issue || counts.sent>item.sent || counts.remaining>item.remaining ||
        work.complete && (counts.remaining!==item.remaining || counts.sent!==item.sent || counts.remaining+counts.sent!==item.total))) return null;
    // Legacy estimates still have confirmed counts, but no stored sequence or queue fingerprints.
    if (proof && (work.sequence && digest_(JSON.stringify(work.sequence))!==proof.sequence ||
        Number.isSafeInteger(work.total) && work.total!==proof.contacts ||
        work.complete && projectCompletionQueueHash_(work)!==proof.queue)) return null;
  }
  return {date:prior.date,generatedAt:prior.generatedAt};
}

function projectCompletionPublic_(saved,preview,ids) {
  var campaignCompletions = {};
  var age = saved && Date.now() - Date.parse(saved.generatedAt);
  var refreshing = saved && (!!saved.work || age >= COLDY.cacheMillis);
  (ids || []).forEach(function (id) {
    var item = saved && saved.report && saved.report[id];
    if (!item || ['unknown','empty','completed','paused','estimated'].indexOf(item.state) === -1) return;
    var count = function (n) { return Number.isSafeInteger(n) && n >= 0 ? n : null; };
    var stale=refreshing && item.state==='estimated';
    campaignCompletions[id] = {sent:count(item.sent), remaining:count(item.remaining), total:count(item.total),
      percent:count(item.percent) !== null && item.percent <= 100 ? item.percent : null, state:stale?'unknown':item.state,
      estimatedDate:!refreshing && /^\d{4}-\d{2}-\d{2}$/.test(item.estimatedDate) ? item.estimatedDate : null,
      previousEstimate:refreshing ? projectCompletionPrevious_(item,saved.work && saved.work[id]) : null,
      reason:stale?'incomplete':typeof item.reason === 'string' && /^[a-z_]{1,45}$/.test(item.reason) ? item.reason : null,
      generatedAt:item.generatedAt || null};
  });
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
      var rejectedRequest = error.registryCode === 'COLDY_PROVIDER' && (error.httpStatus === 400 || error.httpStatus === 422);
      if (rejectedRequest || ['COLDY_NOT_FOUND','COLDY_FORBIDDEN','COLDY_FORECAST_CHANGED','COLDY_RESPONSE'].indexOf(error.registryCode) >= 0) {
        // A definitive rejection of one campaign must not hold the cursor on that same page indefinitely.
        var failed = ids[state.progress.campaignsDone];
        var reason = rejectedRequest ? 'bad_request' : error.registryCode === 'COLDY_FORBIDDEN' ? 'forbidden' : 'unavailable';
        state.work[failed] = {unavailable:true,reason:reason};
        delete state.report[failed];
        state.progress.campaignsDone++;
        if (error.retryAfterMs > 0) state.retryAt = Date.now() + error.retryAfterMs;
      } else {
        var messages = {
          COLDY_NETWORK:'Google Apps Script не получил ответ от Coldy. Сверка продолжится с сохранённой страницы.',
          COLDY_UNAVAILABLE:'Сервер Coldy вернул ошибку (HTTP 5xx). Повторим чтение этой страницы.',
          COLDY_RATE_LIMIT:'Coldy ограничил частоту запросов (HTTP 429). Продолжим после паузы.',
          COLDY_CONFLICT:'Данные обновляются в Coldy (HTTP 409). Повторим чтение этой страницы.',
          COLDY_PROVIDER:'Coldy отклонил запрос данных. Повторим сверку после паузы.'
        };
        if (!Object.prototype.hasOwnProperty.call(messages,error.registryCode)) throw error;
        state.message = messages[error.registryCode];
        state.retryAt = Date.now() + Math.max(15000, Number(error.retryAfterMs) || 60000);
      }
    }
    // A confirmed change on an unfinished page also invalidates the stored fallback for later retries.
    ids.forEach(function(id) {
      var work=state.work[id], prior=state.report[id];
      if (work && !work.complete && prior && (prior.estimatedDate || prior.previousEstimate) &&
          !projectCompletionPrevious_(prior,work)) delete state.report[id];
    });
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
        if (!state.retryAt && infra.error && ['BUSY','COLDY_NETWORK','COLDY_RATE_LIMIT','COLDY_UNAVAILABLE','COLDY_CONFLICT'].includes(infra.error.code))
          state.retryAt=Date.now()+60000;
        waiting = !!state.retryAt || !!infra.nextCursor && !infra.error;
        if (waiting) state.message = 'Обновляем расписания и лимиты почт для оценки даты.';
      }
      var report = projectCampaignCompletions_(infra,state.work,now);
      var generated = new Date().toISOString();
      ids.forEach(function (id) {
        if (state.work[id] && (state.work[id].complete || state.work[id].unavailable) && report[id]) {
          if (state.work[id].unavailable) report[id].reason = state.work[id].reason || 'unavailable';
          var row=Object.assign({},report[id],{generatedAt:generated}), work=state.work[id];
          if (!scanned || waiting) {
            var previous=projectCompletionPrevious_(state.report[id],work);
            if (previous) { row.previousEstimate=previous;row.estimateInputs=state.report[id].estimateInputs; }
            if (row.state==='estimated') {row.state='unknown';row.reason='capacity';row.estimatedDate=null;}
          } else if (row.state==='estimated') {
            row.estimateInputs={sequence:digest_(JSON.stringify(work.sequence)),contacts:work.total,queue:projectCompletionQueueHash_(work)};
          }
          state.report[id]=row;
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
