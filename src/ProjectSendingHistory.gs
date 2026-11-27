/** Actual send events for the previous complete Monday–Sunday, for the current selection. */
function projectHistoryWeek_(now) {
  var local = new Date(now + 10800000), today = Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate());
  var monday = today - ((local.getUTCDay() + 6) % 7 + 7) * 86400000;
  return Array.from({length:7},function (_,i) { return new Date(monday + i * 86400000).toISOString().slice(0,10); });
}

// Within one request, reuse a verified journal only while Drive still confirms its identity and version.
function projectHistoryObserved_(proof,read) {
  if (proof.unchanged && proof.unchanged()) return proof.value;
  delete proof.unchanged;
  proof.value=read(proof);
  return proof.value;
}

function projectHistoryScope_(context, settings, days, reads) {
  var project = registryProjectId_(), monitoring = projectHistoryObserved_(reads.monitoring,function (proof) {
    return projectMonitoringRead_(context,settings,proof);
  });
  var signature = projectMonitoringSignature_(context,monitoring), accounts = [], campaigns = [];
  if (monitoring.accountIds.length) {
    var inventory = !monitoring.accounts && projectHistoryObserved_(reads.inventory,function (proof) {
      return projectInfraRead_(context,settings,proof);
    });
    var byId = new Map((monitoring.accounts || inventory && inventory.accounts || []).map(function (a) { return [String(a.id),a]; }));
    accounts = monitoring.accountIds.map(function (id) {
      var a = byId.get(id) || {};
      return {id:id,email:projectInfraText_(a.email,settings.key,254),name:projectInfraText_(a.name,settings.key,250)};
    });
    var catalog = projectAnalyticsCatalog_(context);
    if (catalog.state !== 'ready') fail_('SOURCE_CHANGED','Не удалось подтвердить список сегментов проекта. Обновите историю отправок.');
    var segments = new Map(catalog.segments.map(function (s) { return [s.id,s.name]; }));
    var registry = projectHistoryObserved_(reads.bindings,function (proof) { return coldyCampaignRegistry_(context,proof); }), seen = new Set();
    if (registry.credentialHash !== settings.credentialHash) fail_('COLDY_CREDENTIAL_CHANGED','Подключение Coldy изменилось.');
    registry.bindings.forEach(function (binding) {
      if (!segments.has(binding.segmentId)) return;
      var id = coldyCampaignId_(binding.campaignId);
      if (seen.has(id)) fail_('COLDY_STORAGE','Обнаружены повторные привязки одной рассылки.');
      seen.add(id);
      campaigns.push({id:id, name:projectInfraText_(binding.campaignName,settings.key,500) || id, segmentId:binding.segmentId,segmentName:segments.get(binding.segmentId)});
    });
    campaigns.sort(function (a,b) { return a.id.localeCompare(b.id); });
  }
  return {project:project, accounts:accounts, campaigns:campaigns, token:digest_(JSON.stringify(
    [context.rootId,project,settings.credentialHash,settings.proofSlot,signature,days[0],campaigns.map(function (c) { return [c.id,c.segmentId]; })]))};
}

function projectHistoryInvalid_() { fail_('COLDY_RESPONSE','Coldy не подтвердил полный состав отправок за день.'); }

// A campaign time series confirms both inclusive calendar dates and the raw total for each day.
// A sender breakdown is accepted only when its paginated total reconciles to that time series.
function projectHistoryTimeline_(value,days) {
  if (!value || JSON.stringify(value.labels) !== JSON.stringify(days) || !Array.isArray(value.series)) projectHistoryInvalid_();
  var sent = value.series.filter(function (s) { return s && s.name === 'sent'; });
  if (sent.length !== 1 || !Array.isArray(sent[0].data) || sent[0].data.length !== days.length ||
      sent[0].data.some(function (n) { return projectInfraCount_(n) === null; })) projectHistoryInvalid_();
  return sent[0].data;
}

function projectHistoryPage_(value, prior, expected, selected) {
  var offset = prior && prior.offset || 0;
  if (!value || value.offset !== offset || projectInfraCount_(value.total) === null ||
      !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 500 || !Array.isArray(value.items) ||
      value.items.length > value.limit || offset + value.items.length > value.total ||
      !value.items.length && offset < value.total || offset && prior.total !== value.total) projectHistoryInvalid_();
  var counts = Object.assign({},prior && prior.counts), sum = prior && prior.sum || 0;
  // Only opaque hashes of out-of-selection IDs survive between pages, never their addresses or metrics.
  var seen = new Set(prior && prior.seen || []), multi = !!offset || value.items.length < value.total;
  value.items.forEach(function (item) {
    var id = projectInfraId_(item && item.account_id), count = projectInfraCount_(item && item.sent);
    var identity = multi ? digest_(id) : id;
    if (seen.has(identity) || count === null || !Number.isSafeInteger(sum + count)) projectHistoryInvalid_();
    seen.add(identity); sum += count;
    if (count && selected.has(id)) counts[id] = count;
  });
  var next = offset + value.items.length;
  if (sum > expected || next === value.total && sum !== expected) projectHistoryInvalid_();
  return next === value.total ? {done:true,counts:counts} :
    {offset:next,total:value.total,counts:counts,sum:sum,seen:Array.from(seen)};
}

// A checkpoint is derived data. Rebuild it if its scope, counters or cursors no longer verify.
function projectHistoryCheckpoint_(saved,scope) {
  var empty = {token:scope.token,entries:{}};
  if (!saved || saved.token !== scope.token || typeof saved.version !== 'string' || !saved.entries) return empty;
  function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
  function nonnegative(value) { return projectInfraCount_(value) !== null; }
  var campaigns = new Set(scope.campaigns.map(function (c) { return c.id; }));
  var accounts = new Set(scope.accounts.map(function (a) { return a.id; }));
  if (!record(saved.entries) || saved.checkedAt && !(typeof saved.checkedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(saved.checkedAt)) ||
      saved.pauseUntil !== undefined && !nonnegative(saved.pauseUntil)) return empty;
  var valid = Object.keys(saved.entries).every(function (id) {
    var e = saved.entries[id];
    if (!campaigns.has(id) || !record(e) || !record(e.cells) || e.retryAt !== undefined && !nonnegative(e.retryAt) ||
        e.reviewAt !== undefined && !nonnegative(e.reviewAt)) return false;
    if (!e.totals) return !Object.keys(e.cells).length;
    if (!Array.isArray(e.totals) || e.totals.length !== 7 || !e.totals.every(nonnegative)) return false;
    return Object.keys(e.cells).every(function (index) {
      var c = e.cells[index];
      if (!/^[0-6]$/.test(index) || !e.totals[index] || !record(c) || c.retryAt !== undefined && !nonnegative(c.retryAt)) return false;
      if (!c.counts) return !c.done && !c.offset && !!c.retryAt;
      if (!record(c.counts)) return false;
      var sum = 0, inScope = Object.keys(c.counts).every(function (a) {
        if (!accounts.has(a) || !nonnegative(c.counts[a]) || !c.counts[a]) return false;
        sum += c.counts[a]; return sum <= e.totals[index];
      });
      if (!inScope) return false;
      if (c.done === true) return c.offset === undefined;
      return !c.done && nonnegative(c.sum) && c.sum >= sum && c.sum <= e.totals[index] &&
        nonnegative(c.total) && nonnegative(c.offset) && c.offset > 0 && c.offset < c.total &&
        Array.isArray(c.seen) && c.seen.length === c.offset && new Set(c.seen).size === c.offset &&
        c.seen.every(function (hash) { return typeof hash === 'string' && /^[A-Za-z0-9_-]{43}$/.test(hash); });
    });
  });
  return valid ? saved : empty;
}

function projectHistoryJobs_(scope,days,report,now) {
  var pauseUntil = Infinity, missing = false;
  for (var c=0;c<scope.campaigns.length;c++) {
    var id = scope.campaigns[c].id, entry = report.entries[id] || {}, tasks = [], path = '/analytics/campaigns/' + id + '/';
    if (!entry.totals || entry.reviewAt && entry.reviewAt<=now) {
      missing = true;
      if (!(entry.retryAt > now)) return {campaign:id,tasks:[{index:-1,path:path+'events?type=event&start_date='+days[0]+'&end_date='+days[6]}]};
      pauseUntil = Math.min(pauseUntil,entry.retryAt);
      continue;
    }
    for (var i=0;i<days.length;i++) {
      var cell = entry.cells[i] || {};
      if (!entry.totals[i] || cell.done) continue;
      missing = true;
      if (cell.retryAt > now) { pauseUntil=Math.min(pauseUntil,cell.retryAt); continue; }
      tasks.push({index:i,path:path+'by-account?type=event&start_date='+days[i]+'&end_date='+days[i]+
        '&sort_by=email&sort_order=asc&limit=500&offset='+(cell.offset || 0)});
      if (tasks.length === COLDY.readBatchSize) break;
    }
    if (tasks.length) return {campaign:id,tasks:tasks};
  }
  return {tasks:[],waiting:missing,retryAt:Number.isFinite(pauseUntil) ? pauseUntil : 0};
}

function projectHistoryApply_(report,job,results,scope,days,now) {
  var entry = report.entries[job.campaign] || {cells:{}}, selected = new Set(scope.accounts.map(function (a) { return a.id; }));
  report.entries[job.campaign] = entry;
  results.forEach(function (result,i) {
    var index = job.tasks[i].index, cell = index < 0 ? entry : entry.cells[index] || {};
    try {
      if (result.error) throw result.error;
      if (index < 0) {
        var totals=projectHistoryTimeline_(result.value,days);
        totals.forEach(function (value,day) {
          if (entry.totals && value!==entry.totals[day]) delete entry.cells[day];
        });
        entry.totals=totals;
        delete entry.retryAt; delete entry.reviewAt;
      }
      else entry.cells[index]=projectHistoryPage_(result.value,cell,entry.totals[index],selected);
      report.checkedAt = new Date(now).toISOString();
    } catch (error) {
      var code = error.registryCode;
      if (['COLDY_NETWORK','COLDY_RATE_LIMIT','COLDY_RESPONSE','COLDY_UNAVAILABLE','COLDY_NOT_FOUND','COLDY_PROVIDER','COLDY_CONFLICT','COLDY_FORBIDDEN'].indexOf(code) === -1) throw error;
      var delay = ['COLDY_RESPONSE','COLDY_NOT_FOUND','COLDY_PROVIDER','COLDY_FORBIDDEN'].indexOf(code) >= 0 ? 3600000 : 60000;
      var retryAt = now + Math.max(delay,error.retryAfterMs || 0);
      if (code === 'COLDY_FORBIDDEN' || code === 'COLDY_NOT_FOUND') {
        // Invalidate this campaign if Coldy no longer permits access to its analytics.
        entry.revoked=true; entry.retryAt=retryAt;
      } else if (index < 0) entry.retryAt=retryAt;
      else if (code === 'COLDY_RESPONSE') {
        entry.cells[index]={retryAt:retryAt};
        // Coldy can correct a past day between GETs. Refresh its reference total before trying again.
        entry.reviewAt=Math.min(entry.reviewAt || retryAt,retryAt);
      }
      else { cell.retryAt=retryAt; entry.cells[index]=cell; }
      if (code === 'COLDY_RATE_LIMIT' || code === 'COLDY_NETWORK' || code === 'COLDY_UNAVAILABLE') report.pauseUntil = Math.max(report.pauseUntil || 0,retryAt);
    }
  });
  if (entry.revoked) report.entries[job.campaign]={cells:{},retryAt:entry.retryAt};
}

function projectHistoryResult_(scope,days,report,state) {
  var now = Date.now(), checked=[], rows=[], pending = projectHistoryJobs_(scope,days,report,now);
  scope.campaigns.forEach(function (campaign) {
    var entry = report.entries[campaign.id];
    if (!entry || !entry.totals) return;
    days.forEach(function (date,i) {
      var cell = entry.cells[i];
      if (entry.totals[i] && !(cell && cell.done)) return;
      checked.push({date:date,campaignId:campaign.id});
      Object.keys(cell && cell.counts || {}).forEach(function (id) { rows.push({date:date,accountId:id,campaignId:campaign.id,sent:cell.counts[id]}); });
    });
  });
  var complete = !state && checked.length === days.length * scope.campaigns.length;
  var retryAfter = Math.max(0,(report.pauseUntil || 0)-now,(pending.retryAt || 0)-now);
  var message = {not_configured:'Подключите Coldy в настройках.',no_accounts:'Выберите почты для мониторинга в этом проекте.',
    no_campaigns:'В сегментах проекта пока нет подключённых рассылок.'}[state] ||
    (complete ? '' : retryAfter ? 'Coldy пока не подтвердил часть данных. Полученные дни сохранены.' : 'Получаем отправки по подключённым рассылкам.');
  return {state:state || (complete?'ready':'partial'),from:days[0],to:days[6],days:days,dayBasis:'coldy_calendar',timeZone:null,
    accounts:scope.accounts,campaigns:scope.campaigns,rows:rows,checkedCells:checked,complete:complete,
    pending:!state&&!complete,retryAfterMs:retryAfter,message:message,checkedAt:report.checkedAt || null};
}

function getProjectSendingHistory_(request) {
  return api_(function () {
    var input=projectAnalyticsInput_(request,['refresh']);
    if (input.refresh !== undefined && typeof input.refresh !== 'boolean') fail_('INVALID_REQUEST','Некорректный запрос обновления истории.');
    var context=authorize_(), project=registryProjectId_(), settings=coldySettings_(context), now=Date.now(), days=projectHistoryWeek_(now);
    if (!registryProjectScoped_()) fail_('OUTSIDE_PROJECT','Выберите проект для просмотра истории отправок.');
    var reads={monitoring:{},inventory:{},bindings:{},checkpoint:{}};
    var scope=settings.configured ? projectHistoryScope_(context,settings,days,reads) : {accounts:[],campaigns:[]};
    var empty=!settings.configured?'not_configured':!scope.accounts.length?'no_accounts':!scope.campaigns.length?'no_campaigns':null;
    if (empty) return projectHistoryResult_(scope,days,{entries:{}},empty);
    var owner=projectMonitoringOwner_(settings.credentialHash), kind='sendinghistory', saved=coldyLoad_(context,kind,owner,reads.checkpoint);
    var before=saved ? saved.version : null, report=projectHistoryCheckpoint_(saved,scope);
    function current() {
      var fresh=authorize_(), currentSettings=coldySettings_(fresh);
      if (fresh.rootId!==context.rootId || registryProjectId_()!==project || currentSettings.credentialHash!==settings.credentialHash)
        fail_('COLDY_SCOPE_CHANGED','Доступ к отчёту изменился. Откройте его заново.');
      if (currentSettings.proofSlot!==settings.proofSlot) fail_('COLDY_CREDENTIAL_CHANGED','Проверка ключа Coldy изменилась. Обновите историю.');
      return fresh;
    }
    function confirm() {
      var fresh=current(), verified=projectHistoryScope_(fresh,settings,projectHistoryWeek_(Date.now()),reads);
      if (verified.token!==scope.token) fail_('COLDY_MONITORING_CHANGED','Неделя, выбор ящиков или привязки рассылок изменились. Обновите историю.');
      scope=verified;
      return fresh;
    }
    var job=projectHistoryJobs_(scope,days,report,now);
    if (!job.tasks.length && !job.waiting && (input.refresh || now-Date.parse(report.checkedAt) >= 21600000)) {
      report={token:scope.token,entries:{}};
      job=projectHistoryJobs_(scope,days,report,now);
    }
    if (!job.tasks.length || report.pauseUntil>now) {
      confirm();
      return projectHistoryResult_(scope,days,report);
    }
    var results;
    try { results=coldyGetBatch_(context,job.tasks.map(function (task) { return task.path; }),current,'sending-history'); }
    catch (error) {
      if (['COLDY_NETWORK','COLDY_UNAVAILABLE','COLDY_RATE_LIMIT'].indexOf(error.registryCode)<0) throw error;
      results=job.tasks.map(function () { return {error:error}; });
    }
    projectHistoryApply_(report,job,results,scope,days,Date.now());
    // Two browsers can collect the same GET. Only the first verified checkpoint is committed.
    var accepted=locked_(function () {
      var fresh=confirm(), latest=reads.checkpoint.unchanged && reads.checkpoint.unchanged() ? saved : coldyLoad_(fresh,kind,owner);
      if ((latest ? latest.version : null)!==before) {
        if (latest && latest.token===scope.token) return projectHistoryCheckpoint_(latest,scope);
        fail_('COLDY_MONITORING_CHANGED','Состав отчёта изменился. Обновите историю.');
      }
      report.version=Utilities.getUuid(); coldySave_(fresh,kind,owner,report); return report;
    });
    return projectHistoryResult_(scope,days,accepted);
  });
}
