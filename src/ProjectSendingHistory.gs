/** Actual send events for the current project's monitored accounts and bound campaigns. */
function projectHistoryWeek_(now) {
  var local = new Date(now + 10800000), today = Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate());
  var monday = today - ((local.getUTCDay() + 6) % 7 + 7) * 86400000;
  return Array.from({length:7},function (_,i) { return new Date(monday + i * 86400000).toISOString().slice(0,10); });
}

function projectHistoryDates_(period,now,weekOf) {
  var today=new Date(now+10800000).toISOString().slice(0,10);
  if(weekOf===undefined)return period==='today'?[today]:projectHistoryWeek_(now);
  if(period==='today'||typeof weekOf!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(weekOf)||weekOf>=today)
    fail_('INVALID_REQUEST','Выберите прошедшую дату для истории отправок.');
  var anchor=Date.parse(weekOf+'T00:00:00Z');
  if(!Number.isFinite(anchor)||new Date(anchor).toISOString().slice(0,10)!==weekOf)
    fail_('INVALID_REQUEST','Дата истории не существует.');
  var monday=anchor-((new Date(anchor).getUTCDay()+6)%7)*86400000;
  return Array.from({length:7},function (_,i){return new Date(monday+i*86400000).toISOString().slice(0,10);})
    .filter(function (date){return date<today;});
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
  var signature = projectMonitoringSignature_(context,monitoring), accounts = [], campaigns = [], planBindings=[];
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
      planBindings.push([id,binding.segmentId,binding.id || '']);
      campaigns.push({id:id, name:projectInfraText_(binding.campaignName,settings.key,500) || id, segmentId:binding.segmentId,segmentName:segments.get(binding.segmentId)});
    });
    campaigns.sort(function (a,b) { return a.id.localeCompare(b.id); });
  }
  var planScope=projectPlanScope_(context,settings,signature,planBindings);
  return {project:project, accounts:accounts,campaigns:campaigns,planScope:planScope,
    token:digest_(JSON.stringify([planScope,days[0],days[days.length-1]]))};
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
  if (sum > expected || next === value.total && sum !== expected)
    fail_('COLDY_HISTORY_TOTALS','Сумма по ящикам в Coldy расходится с дневным числом отправок.');
  return next === value.total ? {done:true,counts:counts} :
    {offset:next,total:value.total,counts:counts,sum:sum,seen:Array.from(seen)};
}

// A checkpoint is derived data. Rebuild it if its scope, counters or cursors no longer verify.
function projectHistoryCheckpoint_(saved,scope,dayCount) {
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
        e.reviewAt !== undefined && !nonnegative(e.reviewAt) || e.verifiedAt !== undefined && !nonnegative(e.verifiedAt)) return false;
    if (!e.totals) return !Object.keys(e.cells).length;
    if (!Array.isArray(e.totals) || e.totals.length !== dayCount || !e.totals.every(nonnegative)) return false;
    return Object.keys(e.cells).every(function (index) {
      var c = e.cells[index];
      if (!/^[0-6]$/.test(index) || Number(index)>=dayCount || scope.period!=='today' && !e.totals[index] || !record(c) || c.retryAt !== undefined && !nonnegative(c.retryAt)) return false;
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
  var pauseUntil = Infinity, missing = false, oldest = null;
  function accountTask(index,path,offset) {
    return {index:index,path:path+'by-account?type=event&start_date='+days[index]+'&end_date='+days[index]+
      '&sort_by=email&sort_order=asc&limit=500&offset='+offset};
  }
  function summaryTasks(path) {
    var tasks=[{index:-1,path:path+'events?type=event&start_date='+days[0]+'&end_date='+days[days.length-1]}];
    // Read both views of a changing day together to minimize drift between their timestamps.
    if(scope.period==='today')tasks.push(accountTask(0,path,0));
    return tasks;
  }
  if (scope.period!=='today') {
    // A single weekly GET proves all zero days for its campaign. Collect those first across the project.
    var summaries=[];
    scope.campaigns.some(function (campaign) {
      var entry=report.entries[campaign.id];
      if (!entry || !(entry.retryAt>now) && (!entry.totals || entry.reviewAt<=now)) {
        var task=summaryTasks('/analytics/campaigns/'+campaign.id+'/')[0];
        task.campaign=campaign.id;summaries.push(task);
      }
      return summaries.length===COLDY.readBatchSize;
    });
    if (summaries.length) return {timelines:true,tasks:summaries};
  }
  for (var c=0;c<scope.campaigns.length;c++) {
    var id = scope.campaigns[c].id, entry = report.entries[id] || {}, tasks = [], path = '/analytics/campaigns/' + id + '/';
    if (!entry.totals || entry.reviewAt && entry.reviewAt<=now) {
      missing = true;
      if (!(entry.retryAt > now)) return {campaign:id,tasks:summaryTasks(path)};
      pauseUntil = Math.min(pauseUntil,entry.retryAt);
      continue;
    }
    for (var i=0;i<days.length;i++) {
      var cell = entry.cells[i] || {};
      if (scope.period!=='today' && !entry.totals[i] || cell.done && !cell.recheck) continue;
      missing = true;
      if (cell.retryAt > now) { pauseUntil=Math.min(pauseUntil,cell.retryAt); continue; }
      tasks.push(accountTask(i,path,cell.offset || 0));
      if (tasks.length === COLDY.readBatchSize) break;
    }
    if (tasks.length) return {campaign:id,tasks:tasks};
    if(scope.period==='today' && entry.cells[0]?.done) {
      var observed=entry.verifiedAt || 0;
      if(observed+60000>now)pauseUntil=Math.min(pauseUntil,observed+60000);
      else if(!oldest || observed<oldest.at)oldest={campaign:id,path:path,at:observed};
    }
  }
  // A delayed campaign must not freeze the other senders' counters. A completed pass has its own TTL.
  if(missing && oldest)return {campaign:oldest.campaign,tasks:summaryTasks(oldest.path)};
  return {tasks:[],waiting:missing,retryAt:missing && Number.isFinite(pauseUntil) ? pauseUntil : 0};
}

function projectHistoryApply_(report,job,results,scope,days,now) {
  if (job.timelines) {
    job.tasks.forEach(function (task,i) {
      projectHistoryApply_(report,{campaign:task.campaign,tasks:[task]},[results[i]],scope,days,now);
    });
    return;
  }
  var entry = report.entries[job.campaign] || {cells:{}}, selected = new Set(scope.accounts.map(function (a) { return a.id; }));
  var verifyingPair=job.tasks.length===2 && job.tasks[0].index<0, freshTimeline=false;
  report.entries[job.campaign] = entry;
  results.forEach(function (result,i) {
    var index = job.tasks[i].index, cell = index < 0 ? entry : entry.cells[index] || {};
    if(verifyingPair && index===0 && !freshTimeline){
      if(!result.error)return;
      index=-1;cell=entry;
    }
    try {
      if (result.error) throw result.error;
      if (index < 0) {
        var totals=projectHistoryTimeline_(result.value,days);
        totals.forEach(function (value,day) {
          if (entry.totals && value!==entry.totals[day]) delete entry.cells[day];
        });
        entry.totals=totals; freshTimeline=true;
        if (scope.period!=='today') entry.timelineCheckedAt=new Date(now).toISOString();
        if(verifyingPair)delete entry.cells[0]; // The paired account request starts on the first page.
        delete entry.retryAt; delete entry.reviewAt;
      }
      else {
        entry.cells[index]=projectHistoryPage_(result.value,cell.recheck ? null : cell,entry.totals[index],selected);
        if(scope.period==='today' && entry.cells[index].done)entry.verifiedAt=now;
      }
      report.checkedAt = new Date(now).toISOString();
    } catch (error) {
      var code = error.registryCode;
      if (['COLDY_NETWORK','COLDY_RATE_LIMIT','COLDY_RESPONSE','COLDY_HISTORY_TOTALS','COLDY_UNAVAILABLE','COLDY_NOT_FOUND','COLDY_PROVIDER','COLDY_CONFLICT','COLDY_FORBIDDEN'].indexOf(code) === -1) throw error;
      var inconsistency=code==='COLDY_RESPONSE'||code==='COLDY_HISTORY_TOTALS';
      var delay = scope.period==='today' && inconsistency ? 15000 : code==='COLDY_HISTORY_TOTALS' ? 60000 :
        ['COLDY_RESPONSE','COLDY_NOT_FOUND','COLDY_PROVIDER','COLDY_FORBIDDEN'].indexOf(code) >= 0 ? 3600000 : 60000;
      var retryAt = now + Math.max(delay,error.retryAfterMs || 0);
      if (code === 'COLDY_FORBIDDEN' || code === 'COLDY_NOT_FOUND') {
        // Invalidate this campaign if Coldy no longer permits access to its analytics.
        entry.revoked=true; entry.retryAt=retryAt;
      } else if (index < 0) {
        entry.retryAt=Math.max(entry.retryAt || 0,retryAt);
        if(verifyingPair || code==='COLDY_RESPONSE'){delete entry.totals;entry.cells={};}
      }
      else if (inconsistency) {
        entry.cells[index]={retryAt:retryAt,issue:code==='COLDY_HISTORY_TOTALS'?'totals':'account_format'};
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
  var historical=scope.period!=='today', campaignTotals=[], timelineTimes=[], totalsDiffer=false;
  scope.campaigns.forEach(function (campaign) {
    var entry = report.entries[campaign.id];
    if (!entry || !entry.totals || entry.revoked) return;
    if (historical) timelineTimes.push(entry.timelineCheckedAt);
    days.forEach(function (date,i) {
      if (historical) campaignTotals.push({date:date,campaignId:campaign.id,sent:entry.totals[i]});
      var cell = entry.cells[i];
      if (cell && cell.issue==='totals') totalsDiffer=true;
      if ((scope.period==='today' || entry.totals[i]) && !(cell && cell.done)) return;
      var verified={date:date,campaignId:campaign.id};
      if(scope.period==='today' && entry.verifiedAt)verified.checkedAt=new Date(entry.verifiedAt).toISOString();
      checked.push(verified);
      Object.keys(cell && cell.counts || {}).forEach(function (id) { rows.push({date:date,accountId:id,campaignId:campaign.id,sent:cell.counts[id]}); });
    });
  });
  var complete = !state && !pending.tasks.length && !pending.waiting && checked.length === days.length * scope.campaigns.length;
  var retryAfter = Math.max(0,(report.pauseUntil || 0)-now,(pending.retryAt || 0)-now);
  var message = {not_configured:'Подключите Coldy в настройках.',no_accounts:'Выберите почты для мониторинга в этом проекте.',
    no_campaigns:'В сегментах проекта пока нет подключённых рассылок.'}[state] ||
    (complete ? '' : totalsDiffer ? 'По части дней сумма по ящикам расходится с итогом Coldy по рассылке. Повторяем сверку.' :
     retryAfter ? 'Coldy пока не подтвердил часть данных. Повторим сверку автоматически.' : 'Получаем отправки по подключённым рассылкам.');
  var result={state:state || (complete?'ready':'partial'),period:scope.period,from:days[0],to:days[days.length-1],days:days,dayBasis:'coldy_calendar',timeZone:null,
    accounts:scope.accounts,campaigns:scope.campaigns,rows:rows,checkedCells:checked,complete:complete,
    pending:!state&&!complete,retryAfterMs:retryAfter,message:message,checkedAt:report.checkedAt || null};
  if (historical) {
    result.campaignTotals=campaignTotals;
    // A by-account read can happen much later than the campaign's event summary.
    result.campaignTotalsCheckedAt=timelineTimes.length && timelineTimes.every(function (t) {
      return typeof t==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(t) && Number.isFinite(Date.parse(t));
    }) ? timelineTimes.sort()[0] : null;
  }
  return result;
}

function getProjectSendingHistory_(request) {
  return api_(function () {
    var input=projectAnalyticsInput_(request,['refresh','period','weekOf','cursor']), period=input.period===undefined?'previous_week':input.period;
    if(period!=='previous_week' && period!=='today')fail_('INVALID_REQUEST','Неизвестный период истории отправок.');
    if (input.refresh !== undefined && typeof input.refresh !== 'boolean') fail_('INVALID_REQUEST','Некорректный запрос обновления истории.');
    if(input.cursor!==undefined && (period==='today'||typeof input.cursor!=='string'||input.cursor!==''&&!/^[A-Za-z0-9_-]{43}$/.test(input.cursor)))
      fail_('INVALID_REQUEST','Некорректный курсор истории отправок.');
    var context=authorize_(), project=registryProjectId_(), settings=coldySettings_(context), now=Date.now(), days=projectHistoryDates_(period,now,input.weekOf);
    if (!registryProjectScoped_()) fail_('OUTSIDE_PROJECT','Выберите проект для просмотра истории отправок.');
    var reads={monitoring:{},inventory:{},bindings:{},checkpoint:{}};
    var scope=settings.configured ? projectHistoryScope_(context,settings,days,reads) : {accounts:[],campaigns:[]};
    scope.period=input.weekOf===undefined?period:'week';
    var empty=!settings.configured?'not_configured':!scope.accounts.length?'no_accounts':!scope.campaigns.length?'no_campaigns':null;
    if (empty){
      if(days.join()!==projectHistoryDates_(period,Date.now(),input.weekOf).join())fail_('COLDY_MONITORING_CHANGED','Дата отчёта изменилась. Обновите историю.');
      return Object.assign(projectHistoryResult_(scope,days,{entries:{}},empty),{plans:[]});
    }
    var owner=projectMonitoringOwner_(settings.credentialHash), kind=period==='today'?'sendinghistorytoday':'sendinghistory';
    if(input.weekOf!==undefined && days[0]!==projectHistoryWeek_(now)[0])owner=digest_(owner+'|week|'+days[0]);
    var saved=coldyLoad_(context,kind,owner,reads.checkpoint);
    var before=saved ? saved.version : null, report=projectHistoryCheckpoint_(saved,scope,days.length);
    // A weekly read can take many provider pages. Keep progress per verified scope and exact
    // durable version so simultaneous analytics/Drive writes cannot starve a read-only report.
    var cache, cached=false, cacheKey='sending-history-work:'+digest_(JSON.stringify([scope.token,kind,owner,before]))+':';
    if (period!=='today') try {
      cache=CacheService.getScriptCache();
      var raw=input.cursor && cache.get(cacheKey+input.cursor), work=raw && digest_(raw)===input.cursor && JSON.parse(raw);
      if (work && projectHistoryCheckpoint_(work,scope,days.length)===work) { report=work;cached=true; }
    } catch (unavailable) {}
    // A denied campaign must also disappear from still-valid cursors in other tabs,
    // even while a writer prevents committing the revocation to Drive.
    var denialPrefix='history-denied:'+scope.planScope+':';
    function respectDenials(candidate) {
      if (!cache) return candidate;
      var blocked=cache.getAll(scope.campaigns.map(function (c){return denialPrefix+c.id;}));
      scope.campaigns.forEach(function (c) {
        var until=Number(blocked[denialPrefix+c.id]);
        if (until>Date.now())candidate.entries[c.id]={cells:{},retryAt:until,issue:'access'};
      });
      return candidate;
    }
    function keepWork() {
      if (!cache || input.cursor===undefined) return null;
      try {
        var raw=JSON.stringify(Object.assign({version:'progress'},report));
        if (raw.length>90000) return null;
        var cursor=digest_(raw);
        cache.put(cacheKey+cursor,raw,Math.max(900,Math.min(21600,Math.ceil((report.pauseUntil-Date.now())/1000)||0)));
        return cursor;
      } catch (unavailable) { return null; }
    }
    var plans=period==='today'?[]:projectPlanRead_(context,settings,scope,days);
    function current() {
      var fresh=authorize_(), currentSettings=coldySettings_(fresh);
      if (fresh.rootId!==context.rootId || registryProjectId_()!==project || currentSettings.credentialHash!==settings.credentialHash)
        fail_('COLDY_SCOPE_CHANGED','Доступ к отчёту изменился. Откройте его заново.');
      if (currentSettings.proofSlot!==settings.proofSlot) fail_('COLDY_CREDENTIAL_CHANGED','Проверка ключа Coldy изменилась. Обновите историю.');
      return fresh;
    }
    function confirm() {
      var fresh=current(), verified=projectHistoryScope_(fresh,settings,projectHistoryDates_(period,Date.now(),input.weekOf),reads);
      if (verified.token!==scope.token) fail_('COLDY_MONITORING_CHANGED','Период, выбор ящиков или привязки рассылок изменились. Обновите историю.');
      verified.period=scope.period;scope=verified;
      return fresh;
    }
    function concurrent(fresh) {
      if(reads.checkpoint.unchanged && reads.checkpoint.unchanged())return null;
      var latest=coldyLoad_(fresh,kind,owner);
      if((latest ? latest.version : null)===before)return null;
      if(!latest || latest.token!==scope.token)fail_('COLDY_MONITORING_CHANGED','Состав отчёта изменился. Обновите историю.');
      return projectHistoryCheckpoint_(latest,scope,days.length);
    }
    respectDenials(report);
    var job=projectHistoryJobs_(scope,days,report,now);
    if (!job.tasks.length && !job.waiting && (input.refresh || now-Date.parse(report.checkedAt) >= (period==='today'?60000:21600000))) {
      if(period==='today')report={token:scope.token,entries:{}};
      else Object.keys(report.entries).forEach(function (id) {
        var entry=report.entries[id];
        entry.reviewAt=now;
        Object.keys(entry.cells).forEach(function (day) { if(entry.cells[day].done)entry.cells[day].recheck=true; });
      });
      job=projectHistoryJobs_(scope,days,report,now);
    }
    if ((!job.tasks.length || report.pauseUntil>now) && !cached) {
      return Object.assign(projectHistoryResult_(scope,days,respectDenials(concurrent(confirm())||report)),{plans:plans});
    }
    var needsSave=false;
    if(job.tasks.length && !(report.pauseUntil>now)){
      var results;
      try { results=coldyGetBatch_(context,job.tasks.map(function (task) { return task.path; }),current,job.timelines?'sending-week-timelines':'sending-history'); }
      catch (error) {
        if (['COLDY_NETWORK','COLDY_UNAVAILABLE','COLDY_RATE_LIMIT'].indexOf(error.registryCode)<0) throw error;
        results=job.tasks.map(function () { return {error:error}; });
      }
      projectHistoryApply_(report,job,results,scope,days,Date.now());
      needsSave=results.some(function (r){return !!r.error;});
      if(cache && needsSave)results.forEach(function (r,i){
        if(!r.error || !['COLDY_FORBIDDEN','COLDY_NOT_FOUND'].includes(r.error.registryCode))return;
        var id=job.tasks[i].campaign||job.campaign, until=report.entries[id].retryAt;
        cache.put(denialPrefix+id,String(until),Math.min(21600,Math.max(1,Math.ceil((until-Date.now())/1000))));
      });
    }
    var cursor=null;
    if (cache && input.cursor!==undefined && !needsSave) {
      var partial=projectHistoryResult_(scope,days,report);
      if (partial.pending && !partial.retryAfterMs) {
        var latest=concurrent(confirm());
        if(latest)return Object.assign(projectHistoryResult_(scope,days,respectDenials(latest)),{plans:plans});
        respectDenials(report);
        cursor=keepWork();
        if(cursor)return Object.assign(projectHistoryResult_(scope,days,report),{plans:plans,nextCursor:cursor});
      }
    }
    // Two browsers can collect the same GET. Only the first verified checkpoint is committed.
    function save() {
      var fresh=confirm(),latest=concurrent(fresh);
      if(latest)return latest;
      respectDenials(report);
      report.version=Utilities.getUuid(); coldySave_(fresh,kind,owner,report); return report;
    }
    var accepted;
    try { accepted=locked_(save,period==='today'?10000:500); }
    catch(error) {
      if(error.registryCode!=='BUSY' || period==='today')throw error;
      accepted=concurrent(confirm())||report;
      if(accepted===report)cursor=keepWork();
    }
    var response=Object.assign(projectHistoryResult_(scope,days,respectDenials(accepted)),{plans:plans});
    if(cursor) {
      response.nextCursor=cursor;
      if(response.complete) {
        response.pending=true;response.retryAfterMs=3500;
        response.message='Факт получен. Сохраняем историю отправок.';
      }
    }
    return response;
  });
}
