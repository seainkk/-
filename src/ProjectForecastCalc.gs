function projectForecastSenderQuota_(sender,now) {
  var day = new Date(now+10800000).toISOString().slice(0,10);
  if (sender.todayQuota !== undefined) {
    var q=sender.todayQuota || {};
    return projectInfraTodayQuota_({dailyLimit:q.limit,dailyLimitAt:q.limitAt,sentToday:q.date===day?q.sent:null,
      sentTodayAt:q.sentAt,syncError:sender.syncError},now);
  }
  // Older callers supplied a single observation time for the entire mailbox.
  var at = Date.parse(sender.updatedAt), fresh = Number.isFinite(at) && !sender.stale && !sender.syncError;
  return {limit:fresh ? projectInfraCount_(sender.dailyLimit) : null,
    sent:fresh && new Date(at+10800000).toISOString().slice(0,10)===day ? projectInfraCount_(sender.sentToday) : null};
}

/** Model the selected sending pool. All queues, dates and allocations are local to this calculation. */
function projectForecastCalculate_(infrastructure, demands, nowMs, completionReports) {
  var day = 86400000, zone = 'Europe/Moscow', now = Number(nowMs), data = infrastructure || {};
  var today = Date.parse(new Date(now + 10800000).toISOString().slice(0, 10) + 'T00:00:00+03:00');
  var horizonDays = completionReports ? 366 : 8;
  var horizon = today + horizonDays * day, zones = new Map(), reasons = new Set(), rows = [], campaigns = new Map();
  var selection = new Set((data.monitoring && data.monitoring.accountIds || []).map(String));
  var membership = data.capacity || {}, observed = new Map((data.accounts || []).map(function (a) { return [String(a.id), a]; }));
  var mappingUnknown = selection.size > 0 && (!membership.updatedAt || membership.stale || membership.state === 'unknown');
  var missing = Array.from(selection).some(function (id) { return !observed.has(id); });
  if (mappingUnknown) reasons.add('stale_membership');
  if (completionReports && (mappingUnknown || missing || !selection.size)) return;
  if (missing) reasons.add('missing_accounts');
  function date(at) { return new Date(at + 10800000).toISOString().slice(0, 10); }
  var queue = {pendingInitial:0,pendingFollowups:0,unresolved:0,unreadCampaigns:0};
  var inactive = new Set();
  for (var i = 0; i < 8; i++) rows.push({date:date(today + i * day), initial:0, followups:0, expected:0, capacity:0,modeled:0});
  (membership.campaigns || []).forEach(function (source) {
    if (String(source.status).toLowerCase() !== 'active' || campaigns.has(source.id)) return;
    var demand = demands && demands[source.id] || {}, schedule = completionReports ? projectCampaignSchedule_(source,demand,now) : source.schedule;
    if (completionReports && demand.complete && demand.campaignStatus && String(demand.campaignStatus).toLowerCase() !== 'active') {
      inactive.add(source.id); return;
    }
    var windows = projectForecastWindows_(schedule, today, horizon, zones);
    var slow = schedule && projectInfraCount_(schedule.gapEndSeconds), fast = schedule && projectInfraCount_(schedule.gapStartSeconds);
    var gap = fast != null && slow != null && slow >= fast ? (fast + slow) * 500 : null;
    campaigns.set(source.id, {id:source.id, name:source.name, segmentId:source.segmentId, segmentName:source.segmentName, expectedByDay:Array(8).fill(0),initialByDay:Array(8).fill(0),
      demand:demand, sequence:demand.sequence, allSelected:demand.allSendersSelected === true || source.allSendersSelected === true,
      dailyLimit:projectInfraCount_(demand.dailyLimit), firstDailyLimit:projectInfraCount_(demand.firstDailyLimit), followupDailyLimit:projectInfraCount_(demand.followupDailyLimit),
      owners:[], senderSelection:selection, assigned:new Map(), schedule:schedule, windows:windows, minGap:fast, gap:gap, reasons:new Set(), queues:new Map(), used:[0,0]});
  });
  var accounts = [];
  selection.forEach(function (id) {
    var source = observed.get(id) || {};
    var cap = source.capacity || {}, status = String(source.status || '').toLowerCase();
    var fresh = !source.stale && !source.syncError && !!source.updatedAt;
    var blocked = fresh && ((source.errors || []).length > 0 || ['failed','error','disabled','paused','disconnected','blocked'].indexOf(status) >= 0);
    var online = fresh && ['connected','active','ready','enabled','ok'].indexOf(status) >= 0;
    var quota = projectForecastSenderQuota_(source,now);
    var account = {id:id, name:source.name || '', email:source.email || '', blocked:blocked, online:online, limit:quota.limit,
      sentToday:quota.sent,
      outside:cap.outsideActive === true, campaigns:[], nextAt:now};
    if (!completionReports) account.allocations = new Map();
    accounts.push(account);
    if (!blocked && cap.state !== 'free' && (cap.state !== 'busy' || !Array.isArray(cap.campaignIds))) mappingUnknown = true;
    (cap.campaignIds || []).forEach(function (key) {
      if (inactive.has(key)) return;
      var c = campaigns.get(key);
      if (!c) { mappingUnknown = true; return; }
      if (!c.assigned.has(id)) {
        account.campaigns.push(c); c.owners.push(account); c.assigned.set(id,account);
        if (account.allocations) account.allocations.set(key,{id:key,expectedByDay:Array(8).fill(0),initialByDay:Array(8).fill(0)});
      }
    });
  });
  if (mappingUnknown) reasons.add('stale_membership');
  if (completionReports && mappingUnknown) return;
  // An uncertainty in one pool can affect any later campaign sharing that mailbox.
  // Separate connected components so a second, independent pool still has its own forecast.
  var visited = new Set(), components = [];
  campaigns.forEach(function (campaign) {
    if (visited.has(campaign) || !campaign.owners.length) return;
    var list = [], senders = new Set(), pending = [campaign];
    while (pending.length) {
      var next = pending.pop();
      if (visited.has(next)) continue;
      visited.add(next); list.push(next);
      next.owners.forEach(function (account) {
        if (account.blocked || senders.has(account)) return;
        senders.add(account);
        account.campaigns.forEach(function (other) { if (!visited.has(other)) pending.push(other); });
      });
    }
    if (senders.size) components.push({campaigns:list,accounts:Array.from(senders)});
  });
  var budget = {sends:0, limit:50000};
  if (completionReports) {
    campaigns.forEach(function (c) {
      var row=completionReports[c.id];
      if (row && row.reason==='capacity' && projectCampaignHardStop_(c)) row.reason='no_capacity';
    });
    components.forEach(function (pool) { projectCampaignEstimatePool_(pool,completionReports,now,today,horizonDays,budget); });
    campaigns.forEach(function (c) {
      var row=completionReports[c.id];
      if (row && ['capacity','shared_capacity'].indexOf(row.reason)>=0)
        projectCampaignObservedFinish_(c,row,now,today,horizonDays,budget);
    });
    return;
  }
  components.forEach(function (pool) {
    projectForecastPool_(pool, rows, reasons, now, today, day, budget, queue);
  });
  var days = rows.slice(1);
  if (mappingUnknown || missing) rows.forEach(function (row) {
    row.capacity = row.expected = row.initial = row.followups = row.modeled = null;
  });
  rows.forEach(function (row) {
    if (row.expected !== null) row.modeled = row.expected;
    else if (!row.modeledEvidence) row.modeled = null;
    delete row.modeledEvidence;
  });
  function sum(period, key) {
    if (period.some(function (row) { return row[key] === null; })) return null;
    var value = period.reduce(function (v, row) { return v + row[key]; }, 0);
    return Number.isSafeInteger(value) ? value : null;
  }
  var senders = accounts.map(function (account) {
    var links = account.campaigns.map(function (campaign) {
      return mappingUnknown || missing ? {id:campaign.id,expectedByDay:Array(8).fill(null),initialByDay:Array(8).fill(null)} : account.allocations.get(campaign.id);
    });
    var days = rows.map(function (row,index) {
      var remaining = index ? account.limit : projectForecastRemaining_(account.limit,account.sentToday);
      var expected = mappingUnknown || missing ? null : 0;
      for (var j=0; expected !== null && j<links.length; j++) {
        var quantity = links[j].expectedByDay[index];
        expected = quantity === null ? null : expected+quantity;
      }
      var unused = account.outside ? null : projectForecastRemaining_(remaining,expected);
      return {date:row.date,remainingLimit:remaining,expected:expected,unused:unused};
    });
    return {id:account.id,name:account.name,email:account.email,dailyLimit:account.limit,days:days,campaigns:links};
  });
  var gross = sum(senders,'dailyLimit');
  rows.forEach(function (row,index) {
    var poolDay = senders.map(function (sender) { return sender.days[index]; });
    row.mailboxLimit = gross;
    row.remainingLimit = sum(poolDay,'remainingLimit');
    row.unused = sum(poolDay,'unused');
  });
  var breakdown = Array.from(campaigns.values()).map(function (c) {
    return {id:c.id, name:c.name || '', segmentId:c.segmentId || '', segmentName:c.segmentName || '',
      expectedByDay:mappingUnknown || missing ? Array(8).fill(null) : c.expectedByDay,initialByDay:mappingUnknown || missing ? Array(8).fill(null) : c.initialByDay};
  });
  return {timezone:zone, today:rows[0], startDate:days[0].date, selectedAccounts:selection.size, activeCampaigns:campaigns.size, campaigns:breakdown, senders:senders, days:days,queue:queue,
    periods:[1,3,7].map(function (length) {
      var period = days.slice(0,length);
      var modeled = sum(period,'modeled');
      if (modeled === null && period.some(function (r) { return r.modeled > 0; }))
        modeled = sum(period.filter(function (r) { return r.modeled !== null; }),'modeled');
      return {days:length,from:period[0].date,to:period[length-1].date,initial:sum(period,'initial'),
        followups:sum(period,'followups'),expected:sum(period,'expected'),capacity:sum(period,'capacity'),modeled:modeled,
        mailboxLimit:sum(period,'mailboxLimit'),remainingLimit:sum(period,'remainingLimit'),unused:sum(period,'unused')};
    }), reasons:Array.from(reasons).sort()};
}

function projectForecastRemaining_(limit, consumed) {
  return limit === 0 ? 0 : limit === null || consumed === null ? null : Math.max(0,limit-consumed);
}

/** Intersect the weekly local wall-clock schedule with the requested Moscow calendar days, including overnight/DST. */
function projectForecastWindows_(schedule, from, to, zones) {
  if (!schedule || !Array.isArray(schedule.days) || !schedule.days.length || !schedule.timezone) return null;
  function clock(text, end) {
    if (end && text === '24:00') return 86400000;
    if (typeof text !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) return null;
    return (Number(text.slice(0,2)) * 60 + Number(text.slice(3))) * 60000;
  }
  var start = clock(schedule.from), end = clock(schedule.to, true), day = 86400000, allowed = new Set(schedule.days);
  if (start === null || end === null || start === end || schedule.days.some(function (d) { return PROJECT_CAPACITY_DAYS.indexOf(d) < 0; })) return null;
  if (end < start) end += day;
  var offsets;
  try { offsets = projectCapacityZone_(schedule.timezone, from, to, zones); } catch (error) { return null; }
  var windows = Array.from({length:Math.ceil((to-from)/day)}, function () { return []; });
  offsets.forEach(function (range) {
    var offset = range[2], first = Math.floor((range[0] + offset) / day) * day - day;
    for (var local = first; local <= range[1] + offset; local += day) {
      if (!allowed.has(PROJECT_CAPACITY_DAYS[new Date(local).getUTCDay()])) continue;
      var left = Math.max(range[0], local + start - offset), right = Math.min(range[1], local + end - offset);
      for (var at = left; at < right;) {
        var index = Math.floor((at - from) / day), stop = Math.min(right,from + (index + 1) * day);
        var intervals = windows[index], last = intervals[intervals.length - 1];
        if (last && last[1] === at) last[1] = stop;
        else intervals.push([at,stop]);
        at = stop;
      }
    }
  });
  return windows;
}

/** Minimal time-ordered heap for due groups and events. Counts stay grouped until a send actually fits. */
function projectForecastEarlier_(a,b) { return a.time < b.time || a.time === b.time && (a.turn || 0) < (b.turn || 0); }
function projectForecastPush_(heap, item) {
  var i = heap.length;
  heap.push(item);
  while (i > 0) {
    var parent = (i - 1) >> 1;
    if (!projectForecastEarlier_(item,heap[parent])) break;
    heap[i] = heap[parent]; i = parent;
  }
  heap[i] = item;
}
function projectForecastPop_(heap) {
  var first = heap[0], tail = heap.pop(), i = 0;
  if (!heap.length) return first;
  while (2 * i + 1 < heap.length) {
    var child = 2 * i + 1;
    if (child + 1 < heap.length && projectForecastEarlier_(heap[child+1],heap[child])) child++;
    if (!projectForecastEarlier_(heap[child],tail)) break;
    heap[i] = heap[child]; i = child;
  }
  heap[i] = tail;
  return first;
}
function projectForecastQueue_(c, sender) {
  if (!c.queues.has(sender)) c.queues.set(sender,[[],[]]);
  return c.queues.get(sender);
}

function projectForecastLoadDemand_(c, now, queue) {
  var demand = c.demand, sequence = c.sequence, steps = sequence && sequence.steps;
  if (!demand.complete || !Array.isArray(demand.cohorts)) { c.reasons.add('incomplete_demand'); queue.unreadCampaigns++; }
  (demand.cohorts || []).forEach(function (g) {
    var assigned = g.senderId == null ? null : String(g.senderId), count = projectInfraCount_(g.count);
    function unknown(reason) { c.reasons.add(reason); queue.unresolved += count || 0; }
    if (count === 0 || g.disposition === 'stopped') return;
    // A completed recipient consumes no future slots, even when Coldy omits its former sender.
    if (count!==null && sequence && sequence.known && Array.isArray(steps) && steps.length &&
        (g.sentSteps===steps.length && (g.previousStepId==null || g.previousStepId===steps[steps.length-1].id) ||
         g.sentSteps==null && g.previousStepId===steps[steps.length-1].id)) return;
    if (assigned !== null) {
      var owner = c.assigned.get(assigned);
      if (!owner && c.senderSelection.has(assigned)) { unknown('unknown_sender'); return; }
      if (!owner || owner.blocked) return;
    }
    if (count === null || g.disposition !== 'eligible') { unknown('unknown_lead'); return; }
    if (!sequence || !sequence.known || !Array.isArray(steps) ||
        steps.some(function (step) { return !step || projectInfraCount_(step.delayDays) === null; })) { unknown('unknown_sequence'); return; }
    if (!steps.length) return;
    var index = projectInfraCount_(g.sentSteps);
    if (g.previousStepId != null) {
      var previous = steps.findIndex(function (step) { return String(step.id) === String(g.previousStepId); });
      if (previous < 0 || index !== null && previous + 1 !== index) { unknown('unknown_sequence'); return; }
      index = previous + 1;
    }
    if (index === null || index > steps.length) { unknown('unknown_sequence'); return; }
    if (index === steps.length) return;
    // A delayed first step needs the lead's enrollment time, which the source does not expose.
    if (index === 0 && steps[0].delayDays > 0) { unknown('unknown_sequence'); return; }
    if (assigned === null && !c.allSelected) { unknown('unknown_sender'); return; }
    var delay = steps[index].delayDays * 86400000, previousAt = Date.parse(g.lastSentAt);
    if (index && delay && !Number.isFinite(previousAt)) { unknown('unknown_sequence'); return; }
    var due = index && Number.isFinite(previousAt) ? Math.max(now, previousAt + delay) : now;
    if (index) queue.pendingFollowups += count;
    else queue.pendingInitial += count;
    c.measuredDemand = true;
    projectForecastPush_(projectForecastQueue_(c,assigned)[index ? 1 : 0],{time:due,count:count,index:index,completionValid:g.completionValid});
  });
}

function projectForecastPool_(pool, rows, reasons, now, today, day, budget, queue) {
  pool.campaigns.forEach(function (c) { projectForecastLoadDemand_(c, now, queue); });
  var uncertain = false, cannotModel = false, measured = pool.campaigns.some(function (c) { return c.measuredDemand; });
  for (var index = 0; index < rows.length; index++) {
    var start = Math.max(now,today + index * day), end = today + (index + 1) * day;
    var daily = rows[index], uncertainNow = false, blockedNow = false, capAccounts = 0, capCampaigns = 0, unknownBalance = false;
    pool.campaigns.forEach(function (c) {
      c.hasQueue = Array.from(c.queues.values()).some(function (queues) { return queues[0].length || queues[1].length; });
    });
    var hasDemand = pool.campaigns.some(function (c) { return c.hasQueue || c.reasons.size; });
    function warn(code, queueOnly) {
      reasons.add(code);
      if (hasDemand) { uncertainNow = true; if (!queueOnly) blockedNow = true; }
    }
    function open(c) { return !c.windows || c.windows[index].some(function (w) { return w[1] > start; }); }
    pool.campaigns.forEach(function (c) {
      c.used = [0,0];
      if (!open(c)) return;
      var limit = c.dailyLimit == null ? Infinity : c.dailyLimit;
      if (c.firstDailyLimit !== null && c.followupDailyLimit !== null) limit = Math.min(limit,c.firstDailyLimit + c.followupDailyLimit);
      capCampaigns += limit;
      if (limit === 0) return;
      c.reasons.forEach(function (code) { warn(code,true); });
      if (!c.windows) warn('missing_schedule');
      if (c.gap === null && c.hasQueue) warn('missing_gap');
      // Coldy has no campaign-wide current-day counters in the public snapshot.
      if (!index && (c.dailyLimit !== null || c.firstDailyLimit !== null || c.followupDailyLimit !== null)) {
        unknownBalance = true;
        if (c.hasQueue) warn('unknown_today');
      }
    });
    pool.accounts.forEach(function (a) {
      a.remaining = a.limit;
      var active = a.campaigns.filter(open);
      if (!active.length) return;
      if (!index && a.remaining !== null && a.sentToday !== null) a.remaining = Math.max(0,a.remaining - a.sentToday);
      if (a.remaining === 0) return;
      if (!a.online) warn('unknown_status');
      if (a.limit === null) warn('missing_limit');
      if (a.outside) warn('outside_campaigns');
      if (!index && a.sentToday === null) {
        unknownBalance = true;
        if (active.some(function (c) { return c.hasQueue; })) warn('unknown_today');
      }
      var slots = projectForecastSlotBound_(active,index,start);
      capAccounts += Math.min(a.remaining === null ? Infinity : a.remaining,slots);
    });
    var bound = Math.min(capAccounts,capCampaigns);
    if (bound !== 0 && uncertainNow) uncertain = true;
    if (bound !== 0 && blockedNow) cannotModel = true;
    if ((bound === 0 || !unknownBalance) && Number.isSafeInteger(bound) && daily.capacity !== null && Number.isSafeInteger(daily.capacity + bound)) daily.capacity += bound;
    else daily.capacity = null;
    if (bound === 0) continue;
    var estimate = {expected:0,initial:0,followups:0};
    if (!cannotModel && !projectForecastSimulateDay_(pool,index,start,end,estimate,budget)) {
      reasons.add('model_limit'); uncertain = cannotModel = true;
    }
    if (!cannotModel && measured) { daily.modeled += estimate.expected; daily.modeledEvidence = true; }
    pool.campaigns.forEach(function (c) {
      var unknown = uncertain && open(c) && c.dailyLimit !== 0 && (c.firstDailyLimit !== 0 || c.followupDailyLimit !== 0);
      c.expectedByDay[index] = unknown ? null : c.used[0] + c.used[1];
      c.initialByDay[index] = unknown ? null : c.used[0];
      if (unknown) c.owners.forEach(function (a) {
        if (!a.blocked && a.limit !== 0 && (index || projectForecastRemaining_(a.limit,a.sentToday) !== 0))
          a.allocations.get(c.id).expectedByDay[index] = a.allocations.get(c.id).initialByDay[index] = null;
      });
    });
    if (uncertain) daily.expected = daily.initial = daily.followups = null;
    else if (daily.expected !== null) {
      daily.expected += estimate.expected; daily.initial += estimate.initial; daily.followups += estimate.followups;
    }
  }
}

/** Coldy defines the gap per campaign but does not specify a cross-campaign timer on a shared mailbox. */
function projectForecastSlotBound_(campaigns, index, start) {
  var slots = 0;
  for (var i = 0; i < campaigns.length; i++) {
    var c = campaigns[i];
    if (!c.windows || c.minGap == null || c.minGap === 0) return Infinity;
    c.windows[index].forEach(function (w) {
      if (w[1] > start) slots += Math.ceil((w[1] - Math.max(start,w[0])) / (c.minGap * 1000));
    });
  }
  return slots;
}

function projectForecastSimulateDay_(pool, index, start, end, daily, budget) {
  var events = [];
  // Coldy chooses unassigned recipients' senders at dispatch. Model simultaneous
  // slots round-robin so equal schedules do not favor incidental heap order.
  if (pool.nextTurn === undefined) {
    pool.nextTurn = pool.accounts.length;
    pool.accounts.forEach(function (a,i) { a.turn = i; });
  }
  function enqueue(a,time) { projectForecastPush_(events,{time:time,turn:a.turn,account:a}); }
  pool.accounts.forEach(function (a) { if (a.remaining > 0 && a.nextAt < end) enqueue(a,Math.max(start,a.nextAt)); });
  while (events.length) {
    var event = projectForecastPop_(events), a = event.account, best = null, earliest = end;
    a.campaigns.forEach(function (c) {
      if (c.dailyLimit !== null && c.used[0] + c.used[1] >= c.dailyLimit) return;
      var firstFirst = c.sequence && c.sequence.priority === 'new_leads';
      [a.id,null].forEach(function (sender) {
        var queues = c.queues.get(sender); if (!queues) return;
        queues.forEach(function (heap, kind) {
          var limit = kind ? c.followupDailyLimit : c.firstDailyLimit;
          if (!heap.length || limit !== null && c.used[kind] >= limit) return;
          var group = heap[0], ready = Math.max(event.time,group.time);
          var window = c.windows[index].find(function (w) { return w[1] > ready; });
          if (!window) return;
          var at = Math.max(ready,window[0]);
          if (at > event.time) { earliest = Math.min(earliest,at); return; }
          var rank = kind === (firstFirst ? 0 : 1) ? 0 : 1;
          if (!best || rank < best.rank || rank === best.rank && (group.time < best.group.time ||
              group.time === best.group.time && (c.lastAllocation || 0) < (best.c.lastAllocation || 0)))
            best = {c:c,heap:heap,group:group,kind:kind,rank:rank};
        });
      });
    });
    if (!best) {
      if (earliest < end) enqueue(a,earliest);
      continue;
    }
    if (++budget.sends > budget.limit) return false;
    var c = best.c, group = best.group, next = group.index + 1;
    if (--group.count === 0) projectForecastPop_(best.heap);
    c.used[best.kind]++; a.remaining--; c.lastAllocation = budget.sends;
    a.turn = pool.nextTurn++;
    if (a.allocations) {
      var attribution=a.allocations.get(c.id);attribution.expectedByDay[index]++;
      if(!best.kind)attribution.initialByDay[index]++;
    }
    if (daily.expected !== null) { daily.expected++; if (best.kind) daily.followups++; else daily.initial++; }
    if (next < c.sequence.steps.length) {
      var due = event.time + c.sequence.steps[next].delayDays * 86400000;
      projectForecastPush_(projectForecastQueue_(c,a.id)[1],{time:due,count:1,index:next,completionValid:group.completionValid});
    }
    if (budget.tracking) {
      if (c.trackRemaining > 0 && group.completionValid && --c.trackRemaining === 0) {
        c.completion.state = 'estimated'; c.completion.reason = budget.deferredToday ? 'from_tomorrow' : null;
        c.completion.estimatedDate = new Date(event.time + 10800000).toISOString().slice(0,10);
        if (--budget.tracking === 0) return true;
      }
    }
    a.nextAt = event.time + c.gap;
    if (a.remaining > 0 && a.nextAt < end) enqueue(a,a.nextAt);
  }
  return true;
}
