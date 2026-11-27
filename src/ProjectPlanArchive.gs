/** Private weekly baselines. Only quantities and provider IDs are retained. */
function projectPlanWeek_(date) {
  var midnight = new Date(date + 'T00:00:00Z');
  return new Date(midnight.getTime() - ((midnight.getUTCDay()+6)%7)*86400000).toISOString().slice(0,10);
}

function projectPlanOwner_(settings,week) {
  return digest_(JSON.stringify(['sending-plan:v1',projectMonitoringOwner_(settings.credentialHash),week]));
}

function projectPlanScope_(context,settings,selection,pairs) {
  return digest_(JSON.stringify([context.rootId,registryProjectId_(),settings.credentialHash,settings.proofSlot,selection,
    pairs.slice().sort(function (a,b) { return a[0].localeCompare(b[0]); })]));
}

function projectPlanCount_(v) { return Number.isSafeInteger(v) && v >= 0; }

// The archive is a Drive document. Validate its numeric projection before exposing it through RPC.
function projectPlanValid_(r) {
  function optional(n) { return n===null || projectPlanCount_(n); }
  function quantities(c) { return Array.isArray(c) && c.length===3 && projectPlanCount_(c[1]) && projectPlanCount_(c[2]) && c[2]<=c[1]; }
  var t=r.totals;
  if (!Array.isArray(t) || t.length!==5 || !t.slice(0,3).every(projectPlanCount_) || !t.slice(3).every(optional) ||
      t[0]!==t[1]+t[2] || !Array.isArray(r.campaigns) || !Array.isArray(r.senders) ||
      !r.campaigns.every(quantities) || new Set(r.campaigns.map(function (c) { return c[0]; })).size!==r.campaigns.length) return false;
  var allocated=r.campaigns.map(function () { return [0,0]; }), total=0, limits=0, unused=0, hasLimits=true, hasUnused=true;
  var consistent=r.senders.every(function (s) {
    if (!Array.isArray(s) || s.length!==5 || !optional(s[1]) || !projectPlanCount_(s[2]) || !optional(s[3]) || !Array.isArray(s[4])) return false;
    var sent=0, seen=new Set();
    if (!s[4].every(function (link) {
      if (!quantities(link) || !projectPlanCount_(link[0]) || link[0]>=allocated.length || seen.has(link[0])) return false;
      seen.add(link[0]); sent+=link[1]; allocated[link[0]][0]+=link[1]; allocated[link[0]][1]+=link[2]; return true;
    }) || sent!==s[2]) return false;
    total+=sent; hasLimits=hasLimits && s[1]!==null; hasUnused=hasUnused && s[3]!==null;
    limits+=s[1] || 0; unused+=s[3] || 0; return true;
  });
  return consistent && t[0]===total && t[3]===(hasLimits?limits:null) && t[4]===(hasUnused?unused:null) &&
    t[1]===allocated.reduce(function (sum,c) { return sum+c[1]; },0) &&
    r.campaigns.every(function (c,i) { return c[1]===allocated[i][0] && c[2]===allocated[i][1]; });
}

function projectPlanDaily_(forecast,day,index) {
  var totals=[day.expected,day.initial,day.followups,day.mailboxLimit,day.unused];
  if (!projectPlanCount_(day.expected)) return null;
  var indices=new Map();
  var campaigns=forecast.campaigns.map(function (c,i) {
    indices.set(c.id,i);
    return [c.id,c.expectedByDay[index],c.initialByDay[index]];
  });
  var senders=forecast.senders.map(function (s) {
    var row=s.days[index], links=s.campaigns.map(function (c) {
      return [indices.get(c.id),c.expectedByDay[index],c.initialByDay[index]];
    });
    return row && row.date===day.date && [s.id,s.dailyLimit,row.expected,row.unused,links];
  });
  var compact={totals:totals,campaigns:campaigns,senders:senders};
  return projectPlanValid_(compact) ? compact : null;
}

// Called inside the forecast's optimistic commit. One baseline per target day, refreshed by the
// first complete calculation on each later Moscow day before that target. Same-day polls are free.
function projectPlanCapture_(context,settings,state,latest,observation,selectedIds) {
  var forecast=state.forecast, date=state.day;
  if (state.work || !forecast || !state.generatedAt || !forecast.today || forecast.today.date!==date ||
      !Array.isArray(forecast.senders) || forecast.senders.length!==selectedIds.length ||
      new Set(forecast.senders.map(function (s) { return s.id; })).size!==selectedIds.length) return;
  var selected=new Set(selectedIds);
  if (!forecast.senders.every(function (s) { return selected.has(s.id); })) return;
  var eligible=forecast.days.filter(function (d) { return projectPlanCount_(d.expected); });
  if (!eligible.length) return;
  var registry=observation.registry && observation.unchanged && observation.unchanged() ? observation.registry : coldyCampaignRegistry_(context);
  if (registry.credentialHash!==settings.credentialHash) fail_('COLDY_CREDENTIAL_CHANGED','Подключение Coldy изменилось.');
  var properties=context.properties.getProperties(), project=registryProjectId_();
  var bindings=registry.bindings.filter(function (b) { return registrySegmentProject_(context,b.segmentId,properties)===project; });
  var pairs=bindings.map(function (b) { return [b.campaignId,b.segmentId,b.id || '']; });
  var scope=projectPlanScope_(context,settings,state.selection,pairs);
  var mark=digest_(JSON.stringify([date,scope,state.demandScope,eligible.map(function (d) { return d.date; })]));
  if (latest && latest.planCapture===mark) { state.planCapture=mark; return; }
  var owners=projectCapacityOwners_(context,pairs.map(function (b) { return b[0]; }),observation);
  pairs=pairs.filter(function (b) {
    var o=owners[b[0]]; return o && o.bindingState==='linked' && o.segmentId===b[1] && o.segmentProjectId===project;
  });
  var bound=new Map(pairs.map(function (b) { return [b[0],b[1]]; }));
  if (!pairs.length || !forecast.campaigns.every(function (c) { return bound.get(c.id)===c.segmentId; })) return;
  scope=projectPlanScope_(context,settings,state.selection,pairs);
  var buckets=new Map(), written=0;
  forecast.days.forEach(function (d,i) {
    if (d.date!==new Date(Date.parse(date)+(i+1)*86400000).toISOString().slice(0,10)) return;
    var compact=projectPlanDaily_(forecast,d,i+1);
    // Seven bounded days plus metadata fit in the existing 15M-character Coldy journal.
    if (!compact || JSON.stringify(compact).length>1800000) return;
    var week=projectPlanWeek_(d.date), bucket=buckets.get(week);
    if (!bucket) {
      var owner=projectPlanOwner_(settings,week), stored=coldyLoad_(context,'sendingplanweek',owner);
      if (stored && (stored.version!==1 || stored.week!==week || !stored.days))
        fail_('COLDY_STORAGE','Сохранённый недельный план требует проверки.');
      bucket={owner:owner,data:stored || {version:1,week:week,days:{}}}; buckets.set(week,bucket);
    }
    var previous=bucket.data.days[d.date];
    if (!previous || previous.scope!==scope || previous.sourceDay<date) {
      bucket.data.days[d.date]=Object.assign(compact,{scope:scope,sourceDay:date,generatedAt:state.generatedAt});
      bucket.changed=true;
    }
    written++;
  });
  buckets.forEach(function (bucket) {
    if (date!==new Date(Date.now()+10800000).toISOString().slice(0,10))
      fail_('COLDY_MONITORING_CHANGED','Наступил новый день. Обновите прогноз.');
    if (bucket.changed) coldySave_(context,'sendingplanweek',bucket.owner,bucket.data);
  });
  if (written===eligible.length && bound.size===bindings.length) state.planCapture=mark;
}

function projectPlanRead_(context,settings,scope,dates) {
  var week=projectPlanWeek_(dates[0]), saved=coldyLoad_(context,'sendingplanweek',projectPlanOwner_(settings,week));
  if (!saved || saved.version!==1 || saved.week!==week || !saved.days) return [];
  var campaigns=new Map(scope.campaigns.map(function (c) { return [c.id,c]; })), accounts=new Set(scope.accounts.map(function (a) { return a.id; }));
  return dates.reduce(function (out,date) {
    var row=saved.days[date];
    if (!row || row.scope!==scope.planScope || row.sourceDay>=date || Date.parse(date)-Date.parse(row.sourceDay)>7*86400000 ||
        typeof row.generatedAt!=='string' || !Number.isFinite(Date.parse(row.generatedAt)) ||
        new Date(Date.parse(row.generatedAt)).toISOString()!==row.generatedAt ||
        new Date(Date.parse(row.generatedAt)+10800000).toISOString().slice(0,10)!==row.sourceDay ||
        !projectPlanValid_(row) || row.senders.length!==accounts.size || !row.senders.every(function (s) { return accounts.has(s[0]); }) ||
        new Set(row.senders.map(function (s) { return s[0]; })).size!==accounts.size ||
        !row.campaigns.every(function (c) { return campaigns.has(c[0]); })) return out;
    function link(entry) {
      return {id:row.campaigns[entry[0]][0],expected:entry[1],initial:entry[2]};
    }
    out.push({date:date,generatedAt:row.generatedAt,expected:row.totals[0],initial:row.totals[1],followups:row.totals[2],
      mailboxLimit:row.totals[3],unused:row.totals[4],campaigns:row.campaigns.map(function (c) {
        return Object.assign({},campaigns.get(c[0]),{expected:c[1],initial:c[2]});
      }),senders:row.senders.map(function (s) {
        return {id:s[0],dailyLimit:s[1],expected:s[2],unused:s[3],campaigns:s[4].map(link)};
      })});
    return out;
  },[]);
}
