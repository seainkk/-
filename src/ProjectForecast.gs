/** The client chooses a display period. All provider IDs and forecast inputs are resolved on the server. */
function getProjectSendingForecast_(request) {
  return api_(function () {
    projectAnalyticsInput_(request, []);
    var context = authorize_(), settings = coldySettings_(context);
    function empty(state, message) {
      return {state:state, pending:false, retryAfterMs:0, forecast:null, generatedAt:null, message:message};
    }
    if (!settings.configured) return empty('not_configured', 'Подключите Coldy в настройках проекта.');
    var monitoring = projectMonitoringRead_(context, settings);
    var signature = projectMonitoringSignature_(context, monitoring);
    if (!monitoring.accountIds.length) {
      projectInfraMonitoringCurrent_(context, settings.credentialHash, signature);
      return empty('no_selection', 'Для расчёта выберите почты проекта в разделе «Инфраструктура».');
    }

    var owner = projectMonitoringOwner_(settings.credentialHash);
    var saved = coldyLoad_(context, 'sendingforecast', owner);
    var inventory = projectInfraRead_(context, settings);
    var working = saved && saved.selection === signature && saved.work && Date.now() - (saved.touchedAt || saved.startedAt) < 1800000;
    var matching = projectInfraMonitoringMatches_(inventory,signature) && inventory.poolOnly;
    var cursor = matching && inventory.nextCursor, capacity = matching && inventory.capacity;
    var lastChecked = inventory && Date.parse(inventory.updatedAt), recentlyChecked = Date.now() - lastChecked < 60000;
    var expired = !capacity || capacity.stale || Date.now() - Date.parse(capacity.updatedAt) >= PROJECT_INFRASTRUCTURE.cacheMillis;
    var retrying = inventory && (inventory.retryAt > Date.now() || inventory.lastError && recentlyChecked);
    var advance = !retrying && (cursor || !matching || !capacity || !recentlyChecked && (!working || expired));
    // Refresh already verifies ownership and builds the public projection; avoid performing the same
    // Drive reads before every cursor continuation.
    var infra = advance ? refreshProjectInfrastructure_(cursor ? {cursor:cursor} : {includeCapacity:true,live:true}) :
      projectInfraPublic_(context,inventory,signature);
    if (infra.monitoring.revision !== monitoring.revision ||
        JSON.stringify(infra.monitoring.accountIds) !== JSON.stringify(monitoring.accountIds))
      fail_('COLDY_MONITORING_CHANGED','Изменился выбор почт. Обновите прогноз.');
    if (!infra.poolOnly || infra.nextCursor || !infra.capacity.updatedAt || infra.capacity.stale || infra.retryAfterMs) {
      var waiting = empty(infra.error || infra.retryAfterMs ? 'partial' : 'loading',
        infra.error && infra.error.message || 'Обновляем назначения, расписания и лимиты. Проверено почт: ' +
          infra.detailProgress.completed + ' из ' + infra.detailProgress.total + '.');
      waiting.retryAfterMs = infra.retryAfterMs || (infra.error ? 60000 : 0);
      waiting.pending = !waiting.retryAfterMs;
      if (saved && saved.generatedAt && Date.now() - Date.parse(saved.generatedAt) < 1800000 &&
          saved.day === new Date(Date.now() + 10800000).toISOString().slice(0,10) &&
          saved.scope === projectForecastScope_(signature,infra)) {
        waiting.forecast = saved.forecast; waiting.generatedAt = saved.generatedAt;
      }
      return waiting;
    }
    var campaigns = infra.capacity.campaigns, ids = campaigns.map(function (c) { return c.id; }).sort();
    var segments = new Map(campaigns.map(function (campaign) { return [campaign.id,campaign.segmentId]; }));
    var scope = projectForecastScope_(signature, infra);
    var inputs = projectForecastInputStamp_(infra);
    var now = Date.now(), day = new Date(now + 10800000).toISOString().slice(0,10);
    var eligible = saved && saved.scope === scope && saved.day === day;
    if (eligible && (saved.retryAt > now || !saved.work && saved.inputs === inputs && now - Date.parse(saved.generatedAt) < 60000))
      return projectForecastResult_(saved);
    var receipt = saved && saved.revision;
    var previous = eligible && saved.inputs === inputs && saved.forecast;
    var state = eligible && working ? saved : {
      scope:scope, selection:signature, day:day, startedAt:now, generatedAt:previous ? saved.generatedAt : null,
      forecast:previous || null, progress:{campaignsDone:0,campaignsTotal:ids.length,contactsRead:0}, work:{}, retryAt:0
    };
    if (state.inputs && state.inputs !== inputs) { state.forecast = null; state.generatedAt = null; }
    state.inputs = inputs;
    state.retryAt = 0; state.message = '';
    var credential = settings.credentialHash, project = registryProjectId_();
    function guard(id) {
      if (registryProjectId_() !== project || !segments.has(id))
        fail_('COLDY_MONITORING_CHANGED', 'Изменился проект рассылки. Обновите прогноз.');
      var fresh = projectInfraMonitoringCurrent_(context, credential, signature);
      var ownerNow = projectCapacityOwners_(fresh, [id])[id];
      if (!ownerNow || ownerNow.bindingState !== 'linked' || ownerNow.segmentId !== segments.get(id) || ownerNow.segmentProjectId !== project)
        fail_('COLDY_MONITORING_CHANGED', 'Изменилась привязка рассылки. Обновите прогноз.');
    }
    try {
      projectForecastCollect_(context, ids, state, guard);
    } catch (error) {
      if (projectInfraScopeError_(error) || error.registryCode === 'COLDY_CREDENTIAL_CHANGED') throw error;
      if (!error.registryCode) throw error;
      if (error.registryCode === 'COLDY_FORECAST_CHANGED') {
        state.work = {}; state.progress.contactsRead = 0; state.progress.campaignsDone = 0;
      }
      state.message = error.registryCode === 'COLDY_FORECAST_CHANGED' ? 'Состав или настройки рассылки изменились. Расчёт начнётся заново.' : projectInfraError_(error).message;
      state.retryAt = Date.now() + Math.max(15000, Number(error.retryAfterMs) || 60000);
    }
    if (state.progress.campaignsDone === ids.length && !state.retryAt) {
      state.forecast = projectForecastCalculate_(infra, state.work, now);
      state.generatedAt = new Date().toISOString();
      state.work = null;
    } else if (!state.generatedAt) {
      state.forecast = projectForecastCalculate_(infra, state.work, now);
    }
    // Optimistic checkpoint. Competing tabs can read the same page, but only one advances it.
    var committed = locked_(function () {
      var fresh = projectInfraMonitoringCurrent_(context, credential, signature);
      var current = projectInfraPublic_(fresh, projectInfraRead_(fresh, settings), signature);
      if (projectForecastScope_(signature,current) !== scope)
        fail_('COLDY_MONITORING_CHANGED', 'Изменились почты или рассылки проекта. Обновите прогноз.');
      if (!state.work && projectForecastInputStamp_(current) !== inputs)
        fail_('COLDY_MONITORING_CHANGED', 'Изменились счётчики почт. Обновите прогноз.');
      var latest = coldyLoad_(fresh, 'sendingforecast', owner);
      if ((latest && latest.revision) !== receipt) {
        if (latest && latest.scope === scope && latest.day === day) return latest;
        fail_('COLDY_MONITORING_CHANGED', 'Состав проекта изменился во время расчёта. Обновите прогноз.');
      }
      state.revision = Utilities.getUuid();
      state.touchedAt = Date.now();
      return coldySave_(fresh, 'sendingforecast', owner, state);
    });
    return projectForecastResult_(committed);
  });
}

function projectForecastInputStamp_(infra) {
  var accounts = infra.accounts.map(function (a) {
    return [a.id,a.sentToday,!!a.stale,!!a.syncError,!!(a.errors && a.errors.length)];
  }).sort(function (a,b) { return a[0]-b[0]; });
  return digest_(JSON.stringify([infra.capacity.state,accounts]));
}

function projectForecastScope_(selection, infra) {
  var campaigns = infra.capacity.campaigns.map(function (c) {
    return [c.id, c.segmentId, c.allSendersSelected, c.schedule];
  }).sort(function (a,b) { return a[0].localeCompare(b[0]); });
  var accounts = infra.accounts.map(function (a) {
    return [a.id, a.status, a.dailyLimit, a.capacity.outsideActive, a.capacity.campaignIds.slice().sort()];
  }).sort(function (a,b) { return a[0]-b[0]; });
  return digest_(JSON.stringify([selection,campaigns,accounts]));
}

function projectForecastCollect_(context, ids, state, guard) {
  var deadline = Date.now() + 18000, pages = 0;
  while (pages < 8 && state.progress.campaignsDone < ids.length) {
    var id = coldyCampaignId_(ids[state.progress.campaignsDone]), work = state.work[id];
    var start = work && work.nextOffset || 0, offsets = [start];
    // Only the first page establishes a total. Subsequent offsets must belong to it.
    for (var offset = start + 200; work && offset < work.total && offsets.length < Math.min(5,8-pages); offset += 200) offsets.push(offset);
    var paths = offsets.map(function (offset) { return '/leads/campaign/' + id + '?limit=200&offset=' + offset; });
    if (!work) paths.unshift('/campaigns/' + id);
    var results = coldyGetBatch_(context, paths, function () { guard(id); });
    if (!Array.isArray(results) || results.length !== paths.length) fail_('COLDY_RESPONSE','Coldy не подтвердил все запрошенные страницы.');
    var index = 0, cooldown = results.reduce(function (delay,r) { return Math.max(delay,Number(r && r.error && r.error.retryAfterMs) || 0); },0);
    try {
      if (!work) {
        var detailResult = results[index++];
        if (detailResult && detailResult.error) throw detailResult.error;
        var detail = detailResult && detailResult.value;
        if (!detail || !coldyUuid_(detail.id) || detail.id.toLowerCase() !== id || detail.status !== 'Active')
          fail_('COLDY_FORECAST_CHANGED','Состояние рассылки изменилось. Пересчитываем прогноз по актуальным данным.');
        work = {sequence:projectForecastSequence_(detail)};
        state.work[id] = work;
      }
      // Commit the contiguous prefix only. A retry starts at the first unconfirmed offset.
      offsets.forEach(function (offset) {
        var result = results[index++];
        if (result && result.error) throw result.error;
        var page = projectForecastDemandPage_(id, offset, work.total, work.sequence, result && result.value);
        var next = projectForecastAppendDemand_(work.campaignId ? work : null, page);
        next.sequence = work.sequence;
        state.work[id] = work = next;
        state.progress.contactsRead += page.leadIds.length;
        if (next.complete) state.progress.campaignsDone++;
      });
    } catch (error) {
      if (error.registryCode && cooldown) error.retryAfterMs = Math.max(error.retryAfterMs || 0,cooldown);
      throw error;
    }
    pages += offsets.length;
    if (Date.now() >= deadline) break;
  }
}

function projectForecastResult_(state) {
  var retry = Math.max(0,(state.retryAt || 0) - Date.now());
  return {state:retry ? 'partial' : state.work ? 'loading' :
      state.forecast && state.forecast.periods.some(function (p) { return p.expected === null; }) ? 'partial' : 'ready',
    pending:!!state.work && !retry, retryAfterMs:retry, message:state.message || '', generatedAt:state.generatedAt,
    forecast:state.forecast, progress:state.progress};
}
