/** A completed report is historical evidence while current counters and recipients refresh. */
function projectForecastArchive_(saved) {
  if (!saved) return null;
  if (!saved.generatedAt || !saved.forecast) return saved.lastReport || null;
  return {selection:saved.selection, demandScope:saved.demandScope, day:saved.day, forecast:saved.forecast, generatedAt:saved.generatedAt};
}

function projectForecastPreviewRange_(archive,day) {
  if (!archive || !archive.forecast || !archive.generatedAt) return null;
  if (archive.day === day) return archive.forecast;
  var delta = Date.parse(day) - Date.parse(archive.day);
  if (delta !== 86400000 || !Array.isArray(archive.forecast.days)) return null;
  var report = archive.forecast, byDate = new Map(report.days.map(function (row) { return [row.date,row]; }));
  var days = [];
  for (var i=1;i<=7;i++) {
    var date = new Date(Date.parse(day) + i*86400000).toISOString().slice(0,10);
    days.push(byDate.get(date) || {date:date,initial:null,followups:null,expected:null,capacity:null,modeled:null,
      mailboxLimit:null,remainingLimit:null,unused:null});
  }
  var periods = [1,3,7].map(function (count) {
    var rows = days.slice(0,count), result = {days:count,from:rows[0].date,to:rows[count-1].date};
    ['initial','followups','expected','capacity','modeled','mailboxLimit','remainingLimit','unused'].forEach(function (field) {
      result[field] = rows.every(function (r) { return Number.isSafeInteger(r[field]); }) ?
        rows.reduce(function (total,r) { return total+r[field]; },0) : null;
    });
    return result;
  });
  // Yesterday's plan for a whole day cannot stand in for the remaining sends today.
  var aligned = Object.assign({},report,{today:null,days:days,periods:periods,startDate:days[0].date,
    reasons:(report.reasons || []).concat('previous_horizon')});
  function alignCampaign(c) { return Object.assign({},c,{expectedByDay:[null].concat(c.expectedByDay.slice(2),null)}); }
  if (Array.isArray(report.campaigns)) aligned.campaigns = report.campaigns.map(alignCampaign);
  if (Array.isArray(report.senders)) aligned.senders = report.senders.map(function (sender) {
    function unknown(date) { return {date:date,remainingLimit:null,expected:null,unused:null}; }
    return Object.assign({},sender,{days:[unknown(day)].concat(sender.days.slice(2),unknown(days[6].date)),
      campaigns:sender.campaigns.map(alignCampaign)});
  });
  return aligned;
}

// Cache only a finished report with project campaign labels and counts. Recipient cohorts, provider records,
// per-mailbox metrics and intermediate calculations never enter the cache.
function projectForecastCachedArchive_(archive) {
  var f = archive.forecast, counts = ['initial','followups','expected','capacity','modeled'];
  function count(n) { return Number.isSafeInteger(n) && n >= 0; }
  function date(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function totals(row, output) {
    counts.forEach(function (field) { output[field] = row[field]; });
    ['mailboxLimit','remainingLimit','unused'].forEach(function (field) {
      if (row[field] === null || count(row[field])) output[field] = row[field];
    });
    return output;
  }
  if (!f || f.timezone !== 'Europe/Moscow' || !date(archive.day) || !Number.isFinite(Date.parse(archive.generatedAt)) ||
      !date(f.startDate) || !count(f.selectedAccounts) || !count(f.activeCampaigns) ||
      !Array.isArray(f.days) || f.days.length !== 7 || !Array.isArray(f.periods) || f.periods.length !== 3 ||
      !Array.isArray(f.reasons) || f.reasons.length ||
      !f.days.every(function (r) { return r && date(r.date) && counts.every(function (k) { return count(r[k]); }); }) ||
      !f.periods.every(function (r,i) { return r && r.days === [1,3,7][i] && date(r.from) && date(r.to) && counts.every(function (k) { return count(r[k]); }); })) return null;
  var queue = {}, fields = ['pendingInitial','pendingFollowups','unresolved','unreadCampaigns'];
  if (!f.queue || !fields.every(function (k) { return count(f.queue[k]); })) return null;
  fields.forEach(function (k) { queue[k] = f.queue[k]; });
  var compact = {timezone:'Europe/Moscow', today:f.today && f.today.date === archive.day && counts.every(function(k){return count(f.today[k]);}) ? totals(f.today,{date:f.today.date}) : null,
      startDate:f.startDate, selectedAccounts:f.selectedAccounts, activeCampaigns:f.activeCampaigns, reasons:[], queue:queue,
      days:f.days.map(function (r) { return totals(r,{date:r.date}); }),periods:f.periods.map(function (r) { return totals(r,{days:r.days,from:r.from,to:r.to}); })};
  if (Array.isArray(f.campaigns)) {
    if (!f.campaigns.every(function (c) { return c && coldyUuid_(c.id) && typeof c.name === 'string' && typeof c.segmentName === 'string' &&
      Array.isArray(c.expectedByDay) && c.expectedByDay.length === 8 && c.expectedByDay.every(count); })) return null;
    compact.campaigns = f.campaigns.map(function (c) {return {id:c.id,name:c.name,segmentName:c.segmentName,expectedByDay:c.expectedByDay};});
  }
  return {day:archive.day,generatedAt:archive.generatedAt,demandScope:archive.demandScope,forecast:compact};
}

// One root lookup and one bounded membership listing cover the four journals,
// the private store, the outreach folder and every segment in this aggregate.
function projectForecastPreviewProof_(context,settings,owner,files,segments) {
  if (!Array.isArray(segments) || segments.length > 100 || typeof Drive === 'undefined' || !Drive.Files || typeof Drive.Files.list !== 'function') return false;
  var kinds = ['monitoring','campaignbindings','infrastructure','sendingforecast'];
  if (!kinds.every(function (kind) { return files[kind] && /^\d+$/.test(files[kind].version); })) return false;
  var folder = files.monitoring.folderId, root = context.rootId, project = registryProjectId_(), mime = 'application/vnd.google-apps.folder';
  var props = context.properties.getProperties(), outreach = (props.SEGMENTS_FOLDER_ID || '').trim() || REGISTRY_CONFIG.defaultSegmentsFolderId;
  if (!/^[\w-]{10,200}$/.test(folder) || !/^[\w-]{10,200}$/.test(outreach)) return false;
  var scopes = kinds.map(function (kind) { return coldyStoreScope_(context,kind,kind === 'campaignbindings' ? settings.credentialHash : owner,false); });
  function current(properties) {
    return properties[COLDY.folderProperty] === folder && ((properties.SEGMENTS_FOLDER_ID || '').trim() || REGISTRY_CONFIG.defaultSegmentsFolderId) === outreach &&
      scopes.every(function (scope) { return files[scope.kind].folderId === folder && properties[scope.indexKey] === files[scope.kind].id; }) &&
      segments.every(function (id) { return registrySegmentProject_(context,id,properties) === project; });
  }
  if (!current(props)) return false;
  var folderQuery = "mimeType = '" + mime + "' and ('" + root + "' in parents or '" + outreach + "' in parents)";
  var journalQuery = "'" + folder + "' in parents and (" + kinds.map(function (kind) {
    return "appProperties has { key='registryColdyKind' and value='" + kind + "' }";
  }).join(' or ') + ')';
  var page;
  try {
    var rootFile = Drive.Files.get(root,{fields:'id,trashed,mimeType,driveId',supportsAllDrives:true});
    if (!rootFile || rootFile.id !== root || rootFile.trashed !== false || rootFile.mimeType !== mime) return false;
    var query = {q:'trashed = false and ((' + folderQuery + ') or (' + journalQuery + '))', pageSize:300,
      fields:'nextPageToken,incompleteSearch,files(' + COLDY.fields + ')',supportsAllDrives:true, includeItemsFromAllDrives:true, corpora:rootFile.driveId ? 'drive' : 'user'};
    if (rootFile.driveId) query.driveId = rootFile.driveId;
    page = Drive.Files.list(query);
  } catch (unavailable) { return false; }
  if (!page || page.incompleteSearch || page.nextPageToken || !Array.isArray(page.files)) return false;
  var byId = new Map(page.files.filter(Boolean).map(function (file) { return [file.id,file]; }));
  function child(id,parent,type) {
    var file = byId.get(id);
    return file && file.trashed === false && file.mimeType === type && Array.isArray(file.parents) && file.parents.length === 1 && file.parents[0] === parent;
  }
  if (!child(folder,root,mime) || !child(outreach,root,mime) || !segments.every(function (id) { return child(id,outreach,mime); })) return false;
  var tags = byId.get(folder).appProperties || {};
  if (tags.registryPrivateRole !== 'coldy_folder' || tags.registryColdyRoot !== root) return false;
  if (!scopes.every(function (scope) {
    var stamp = files[scope.kind], meta = byId.get(stamp.id);
    if (!child(stamp.id,folder,'application/json') || String(meta.version) !== stamp.version) return false;
    var expected = coldyStoreTags_(scope), actual = meta.appProperties || {};
    return Object.keys(expected).every(function (key) { return actual[key] === expected[key]; });
  })) return false;
  var fresh = coldyCurrent_(context,false);
  return projectMonitoringOwner_(coldyCredentialHash_(fresh)) === owner && registryProjectId_() === project && current(fresh.properties.getProperties());
}

function getProjectForecastPreview_(request) {
  return api_(function () {
    projectAnalyticsInput_(request, []);
    var context = authorize_(), settings = coldySettings_(context);
    if (!settings.configured) return null;
    var owner = projectMonitoringOwner_(settings.credentialHash);
    var day = new Date(Date.now() + 10800000).toISOString().slice(0,10);
    var key = 'forecast-preview-v1-' + digest_(JSON.stringify([context.rootId,owner])), cache, cached;
    try { cache = CacheService.getScriptCache(); cached = JSON.parse(cache.get(key)); } catch (unavailable) {}
    function result(archive,report) { return {forecast:report,generatedAt:archive.generatedAt,previewScope:archive.demandScope,day:day}; }
    if (cached && cached.archive && cached.files && cached.cachedAt <= Date.now() && Date.now()-cached.cachedAt < 21600000) {
      var prior = projectForecastPreviewRange_(cached.archive,day);
      if (prior && projectForecastPreviewProof_(context,settings,owner,cached.files,cached.segments) &&
          new Date(Date.now()+10800000).toISOString().slice(0,10) === day) return result(cached.archive,prior);
    }
    var reportRead = {}, monitoringRead = {}, inventoryRead = {}, bindingsRead = {};
    var saved = projectForecastArchive_(coldyLoad_(context,'sendingforecast',owner,reportRead));
    var forecast = projectForecastPreviewRange_(saved,day);
    if (!forecast || !saved.demandScope) return null;
    var monitoring = projectMonitoringRead_(context,settings,monitoringRead), signature = projectMonitoringSignature_(context,monitoring);
    if (!monitoring.accountIds.length || saved.selection !== signature) return null;
    var inventory = projectInfraRead_(context,settings,inventoryRead);
    if (!projectInfraMonitoringMatches_(inventory,signature) || !inventory.capacity) return null;
    function membershipOf(fresh,inventory) {
      var visible = projectCapacitySelected_(fresh,inventory.capacity,bindingsRead);
      return visible.capacity.campaigns.map(function (c) { return {id:c.id,segmentId:visible.owners[c.id].segmentId}; });
    }
    var membership = membershipOf(context,inventory);
    function matches(items) { return projectForecastDemandScope_(signature,{capacity:{campaigns:items}}) === saved.demandScope; }
    if (!matches(membership)) return null;
    var files = {monitoring:monitoringRead.file,campaignbindings:bindingsRead.file,infrastructure:inventoryRead.file,sendingforecast:reportRead.file};
    var segments = Array.from(new Set(membership.map(function (c) { return c.segmentId; })));
    if (membership.length === inventory.capacity.campaigns.length && projectForecastPreviewProof_(context,settings,owner,files,segments)) {
      var compact = cache && projectForecastCachedArchive_(saved);
      if (compact) try {
        var stored = JSON.parse(cache.get(key));
        if (!stored || !(Date.parse(stored.archive.generatedAt)>Date.parse(compact.generatedAt))) {
          cache.put(key,JSON.stringify({archive:compact,files:files,segments:segments,cachedAt:Date.now()}),21600);
        }
      } catch (unavailable) {}
    } else {
      // Nested/custom Drive folders and changed versions use optimistic verification
      // of their actual journals and scope. Reading a prior report never waits on a writer lock.
      var guard = projectInfraMonitoringGuard_(context,settings.credentialHash,signature,monitoringRead), fresh = guard();
      if (!reportRead.unchanged || !reportRead.unchanged()) {
        var latest = projectForecastArchive_(coldyLoad_(fresh,'sendingforecast',owner));
        if (!latest || latest.selection !== signature || latest.demandScope !== saved.demandScope ||
            latest.day !== saved.day || latest.generatedAt !== saved.generatedAt) return null;
        forecast = projectForecastPreviewRange_(latest,day);
        if (!forecast) return null;
      }
      if (!inventoryRead.unchanged || !inventoryRead.unchanged()) inventory = projectInfraRead_(fresh,settings);
      if (!projectInfraMonitoringMatches_(inventory,signature) || !inventory.capacity || !matches(membershipOf(fresh,inventory))) return null;
      guard();
      if (bindingsRead.unchanged && !bindingsRead.unchanged()) return null;
    }
    if (new Date(Date.now()+10800000).toISOString().slice(0,10) !== day) return null;
    return result(saved,forecast);
  });
}

/** The client chooses a display period. All provider IDs and forecast inputs are resolved on the server. */
function getProjectSendingForecast_(request) {
  return api_(function () {
    projectAnalyticsInput_(request, []);
    var context = authorize_(), settings = coldySettings_(context);
    function empty(state, message) {
      return {state:state, pending:false, retryAfterMs:0, forecast:null, generatedAt:null, message:message};
    }
    if (!settings.configured) return empty('not_configured', 'Подключите Coldy в настройках проекта.');
    var observation = {}, monitoring = projectMonitoringRead_(context, settings, observation);
    var signature = projectMonitoringSignature_(context, monitoring);
    var checkSelection = projectInfraMonitoringGuard_(context,settings.credentialHash,signature,observation);
    if (!monitoring.accountIds.length) {
      checkSelection();
      return empty('no_selection', 'Для расчёта выберите почты проекта в разделе «Инфраструктура».');
    }

    var owner = projectMonitoringOwner_(settings.credentialHash);
    var saved = coldyLoad_(context, 'sendingforecast', owner);
    var inventory = projectInfraRead_(context, settings);
    var checked = Date.now(), day = new Date(checked + 10800000).toISOString().slice(0,10);
    var working = saved && saved.selection === signature && saved.day === day && saved.work &&
      checked - (saved.touchedAt || saved.startedAt) < 1800000;
    var collecting = working && saved.progress.campaignsDone < saved.progress.campaignsTotal;
    var matching = projectInfraMonitoringMatches_(inventory,signature) && inventory.poolOnly;
    var cursor = matching && inventory.nextCursor, capacity = matching && inventory.capacity;
    var recentlyChecked = inventory && checked - Date.parse(inventory.updatedAt) < 60000;
    var observedAt = capacity && Math.min(Date.parse(capacity.updatedAt),Date.parse(inventory.inventoryAt));
    var expired = !capacity || capacity.stale || !Number.isFinite(observedAt) || checked - observedAt >= PROJECT_INFRASTRUCTURE.cacheMillis;
    var retrying = inventory && (inventory.retryAt > checked || inventory.lastError && recentlyChecked);
    var forecastPaused = saved && saved.retryAt > checked;
    var infra, continueRecipients = false;
    // A mailbox observation may age while scanning recipients. It can identify a campaign
    // already under review, but cannot supply a quota for the finished forecast.
    if (collecting && matching && capacity && !capacity.stale && !inventory.lastError && !retrying &&
        (!inventory.capacityWork || inventory.capacityWork.mapped)) {
      infra = projectInfraPublic_(context,inventory,signature);
      continueRecipients = projectForecastSameDemand_(saved,signature,infra);
    }
    if (!continueRecipients && !retrying && !forecastPaused &&
        (cursor || !matching || !capacity || !recentlyChecked && (!working || expired || inventory.lastError))) {
      infra = refreshProjectInfrastructure_(cursor ? {cursor:cursor} : {includeCapacity:true,live:true});
    }
    if (!infra) infra = projectInfraPublic_(context,inventory,signature);
    if (infra.monitoring.revision !== monitoring.revision ||
        JSON.stringify(infra.monitoring.accountIds) !== JSON.stringify(monitoring.accountIds))
      fail_('COLDY_MONITORING_CHANGED','Изменился выбор почт. Обновите прогноз.');
    var ready = projectForecastInfrastructureReady_(infra);
    var sameDemand = working && projectForecastSameDemand_(saved,signature,infra);
    if (forecastPaused) {
      if (sameDemand && ready && saved.scope === projectForecastScope_(signature,infra) && saved.inputs === projectForecastInputStamp_(infra))
        return projectForecastResult_(saved);
      var paused = empty('partial',sameDemand && saved.message || 'Следующее обновление будет доступно после паузы.');
      paused.day = day;
      paused.retryAfterMs = Math.max(0,saved.retryAt - Date.now());
      if (sameDemand) paused.progress = saved.progress;
      if (infra.poolOnly && infra.capacity.updatedAt) paused.previewScope = projectForecastDemandScope_(signature,infra);
      return paused;
    }
    if (!ready && !continueRecipients) {
      var waiting = empty(infra.error || infra.retryAfterMs ? 'partial' : 'loading',
        infra.error && infra.error.message || 'Обновляем назначения, расписания и лимиты. Проверено почт: ' +
          infra.detailProgress.completed + ' из ' + infra.detailProgress.total + '.');
      waiting.retryAfterMs = infra.retryAfterMs || (infra.error ? 60000 : 0);
      waiting.day = day;
      waiting.pending = !waiting.retryAfterMs;
      if (sameDemand) waiting.progress = saved.progress;
      if (infra.poolOnly && infra.capacity.updatedAt) waiting.previewScope = projectForecastDemandScope_(signature,infra);
      var reportAge = saved && checked - Date.parse(saved.generatedAt);
      // A pending diagnostics cursor can coexist with a verified map and still-fresh mailbox observations.
      if (saved && saved.forecast && saved.generatedAt && saved.selection === signature && saved.day === day &&
          reportAge >= 0 && reportAge < 1800000 && infra.poolOnly && infra.nextCursor && !infra.stale && !infra.error &&
          !infra.retryAfterMs && infra.capacity.state === 'ready' && !infra.capacity.stale &&
          infra.accounts.every(function (a) { return a.updatedAt && !a.stale && !a.syncError && !(a.errors || []).length; }) &&
          saved.scope === projectForecastScope_(signature,infra) && saved.inputs === projectForecastInputStamp_(infra)) {
        waiting.forecast = saved.forecast; waiting.generatedAt = saved.generatedAt;
        waiting.message += ' Ниже показан последний подтверждённый расчёт.';
      }
      return waiting;
    }
    var campaigns = infra.capacity.campaigns, ids = campaigns.map(function (c) { return c.id; }).sort();
    var segments = new Map(campaigns.map(function (campaign) { return [campaign.id,campaign.segmentId]; }));
    var scope = projectForecastScope_(signature, infra);
    var demandScope = projectForecastDemandScope_(signature,infra);
    var inputs = projectForecastInputStamp_(infra);
    var now = Date.now(), eligible = saved && saved.scope === scope && saved.day === day;
    if (ready && eligible && !saved.work && saved.forecast && saved.forecast.today && Array.isArray(saved.forecast.senders) &&
        saved.inputs === inputs && now - Date.parse(saved.generatedAt) < 60000) return projectForecastResult_(saved);
    var receipt = saved && saved.revision;
    var previous = ready && eligible && saved.inputs === inputs && saved.forecast;
    var state = sameDemand ? saved : {
      scope:scope, selection:signature, day:day, startedAt:now, generatedAt:previous ? saved.generatedAt : null,
      forecast:previous || null, progress:{campaignsDone:0,campaignsTotal:ids.length,contactsRead:0}, work:{}, retryAt:0
    };
    var archive = projectForecastArchive_(saved);
    if (archive && archive.selection === signature && archive.demandScope === demandScope &&
        (archive.day === day || Date.parse(day)-Date.parse(archive.day) === 86400000))
      state.lastReport = archive;
    else delete state.lastReport;
    if (!ready || state.scope !== scope || state.inputs && state.inputs !== inputs) { state.forecast = null; state.generatedAt = null; }
    state.demandScope = demandScope; state.scope = scope;
    state.inputs = inputs;
    state.retryAt = 0; state.message = '';
    var project = registryProjectId_(), bindingsObservation = {};
    function guard(id) {
      if (registryProjectId_() !== project || !segments.has(id))
        fail_('COLDY_MONITORING_CHANGED', 'Изменился проект рассылки. Обновите прогноз.');
      var fresh = checkSelection();
      var ownerNow = projectCapacityOwners_(fresh, [id], bindingsObservation)[id];
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
    var collected = state.work;
    if (ready && state.progress.campaignsDone === ids.length && !state.retryAt) {
      state.forecast = projectForecastCalculate_(infra, state.work, now);
      state.generatedAt = new Date().toISOString();
      state.work = null;
    } else if (ready && !state.generatedAt) {
      state.forecast = projectForecastCalculate_(infra, state.work, now);
    } else if (!ready && state.progress.campaignsDone === ids.length && !state.retryAt) {
      state.message = 'Адресаты проверены. Обновляем расписания и лимиты для итогового прогноза.';
    }
    // Optimistic checkpoint. Competing tabs can read the same page, but only one advances it.
    var committed = locked_(function () {
      var fresh = checkSelection();
      var current = projectInfraPublic_(fresh, projectInfraRead_(fresh, settings), signature);
      if (new Date(Date.now() + 10800000).toISOString().slice(0,10) !== day || projectForecastDemandScope_(signature,current) !== demandScope)
        fail_('COLDY_MONITORING_CHANGED', 'Изменились почты или рассылки проекта. Обновите прогноз.');
      var currentScope = projectForecastScope_(signature,current), currentInputs = projectForecastInputStamp_(current);
      var currentReady = projectForecastInfrastructureReady_(current);
      if (!currentReady || currentScope !== scope || currentInputs !== inputs) {
        state.work = collected; state.forecast = null; state.generatedAt = null;
      }
      if (!state.work) delete state.lastReport;
      var latest = coldyLoad_(fresh, 'sendingforecast', owner);
      if ((latest && latest.revision) !== receipt) {
        if (latest && latest.day === day && projectForecastSameDemand_(latest,signature,current)) {
          if (currentReady && latest.scope === currentScope && latest.inputs === currentInputs) return latest;
          return Object.assign({},latest,{work:latest.work || {},forecast:null,generatedAt:null});
        }
        fail_('COLDY_MONITORING_CHANGED', 'Состав проекта изменился во время расчёта. Обновите прогноз.');
      }
      state.revision = Utilities.getUuid();
      state.touchedAt = Date.now();
      return coldySave_(fresh, 'sendingforecast', owner, state);
    });
    return projectForecastResult_(committed);
  });
}

function projectForecastInfrastructureReady_(infra) {
  return !!(infra.poolOnly && !infra.nextCursor && !infra.error && !infra.retryAfterMs && infra.capacity.updatedAt && !infra.capacity.stale);
}

// Quotas, schedules and today's counters can change without invalidating previously read recipients.
function projectForecastDemandScope_(selection,infra) {
  var ids = infra.capacity.campaigns.map(function (c) { return [c.id,c.segmentId]; })
    .sort(function (a,b) { return a[0].localeCompare(b[0]); });
  return digest_(JSON.stringify([selection,ids]));
}

function projectForecastSameDemand_(saved,selection,infra) {
  return saved.demandScope ? saved.demandScope === projectForecastDemandScope_(selection,infra) :
    saved.scope === projectForecastScope_(selection,infra);
}

function projectForecastInputStamp_(infra) {
  var accounts = infra.accounts.map(function (a) {
    return [a.id,a.name || '',a.email || '',a.sentToday,!!a.stale,!!a.syncError,!!(a.errors && a.errors.length)];
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

function projectForecastCollect_(context, ids, state, guard, withCompletion) {
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
        var validStatus = detail && (withCompletion ? ['Active','Draft','Paused','Completed'].indexOf(detail.status) >= 0 : detail.status === 'Active');
        if (!detail || !coldyUuid_(detail.id) || detail.id.toLowerCase() !== id || !validStatus)
          fail_('COLDY_FORECAST_CHANGED','Состояние рассылки изменилось. Пересчитываем прогноз по актуальным данным.');
        work = {sequence:projectForecastSequence_(detail)};
        if (withCompletion) {
          work.campaignStatus = detail.status;
          if (detail.schedule) {
            work.schedule = projectCapacitySchedule_(detail.schedule,id);
            work.scheduleCheckedAt=Date.now();
          }
        }
        state.work[id] = work;
      }
      // Commit the contiguous prefix only. A retry starts at the first unconfirmed offset.
      offsets.forEach(function (offset) {
        var result = results[index++];
        if (result && result.error) throw result.error;
        var page = projectForecastDemandPage_(id, offset, work.total, work.sequence, result && result.value, withCompletion);
        var next = projectForecastAppendDemand_(work.campaignId ? work : null, page);
        next.sequence = work.sequence;
        if (withCompletion) {
          next.campaignStatus = work.campaignStatus;
          next.schedule = work.schedule || null;
          next.scheduleCheckedAt=work.scheduleCheckedAt || null;
        }
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
    forecast:state.forecast, progress:state.progress, previewScope:state.demandScope, day:state.day};
}
