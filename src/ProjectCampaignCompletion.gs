/** Count email steps, not recipients. Keep only aggregates in the private scan checkpoint. */
function projectCampaignProgressCounts_() {
  return {validContacts:0, sent:0, remaining:0, issue:null};
}

function projectCampaignCountLead_(counts, lead, sequence) {
  var verification = lead.verification_status;
  if (verification !== 'valid') {
    if (['unknown','accept_all','invalid','disposable','not_verified'].indexOf(verification) < 0) counts.issue = 'verification';
    return;
  }
  counts.validContacts++;
  var steps = sequence.known && sequence.steps;
  if (!Array.isArray(steps)) { counts.issue = counts.issue || 'sequence'; return; }
  var sent = lead.amount_sequences_sent;
  var previous = lead.id_previous_sending_sequence, noPrevious = previous == null || previous === 0;
  if (sent == null && noPrevious && previous === 0 && lead.status === 'Not contacted' && !lead.date_last_sequence_send) sent = 0;
  if (!noPrevious) {
    var index = steps.findIndex(function (s) { return s.id === previous; });
    if (index < 0 || sent != null && sent !== index + 1) { counts.issue = counts.issue || 'sequence'; return; }
    sent = index + 1;
  }
  if (!Number.isSafeInteger(sent) || sent < 0 || sent > steps.length ||
      sent === 0 && lead.date_last_sequence_send || sent > 0 && lead.status === 'Not contacted') {
    counts.issue = counts.issue || 'sequence'; return;
  }
  counts.sent += sent;
  if (sent === steps.length || lead.stop_sending === true || lead.status === 'Bounce') return;
  var replied = lead.status === 'Replied' || typeof lead.reply_text === 'string' && !!lead.reply_text.trim();
  if (replied && (sequence.stopOnReply === true || sequence.stopOnCompanyReply === true)) return;
  if (lead.stop_sending !== false || ['Not contacted','Sent','Opened','Replied'].indexOf(lead.status) < 0 ||
      replied && (sequence.stopOnReply !== false || sequence.stopOnCompanyReply !== false)) {
    counts.issue = counts.issue || 'status'; return;
  }
  counts.remaining += steps.length - sent;
}

function projectCampaignMergeCounts_(work, page) {
  if (!work) return page;
  // A page collected before completion tracking was enabled cannot establish an all-recipient denominator.
  var before = work.completion || {validContacts:0, sent:0, remaining:0, issue:'incomplete'};
  return {validContacts:before.validContacts + page.validContacts, sent:before.sent + page.sent,
    remaining:before.remaining + page.remaining, issue:before.issue || page.issue};
}

/** Public percentages use only proven valid leads. Other sendable leads still compete for mailbox slots. */
function projectCampaignCompletions_(infrastructure, demands, nowMs) {
  var reports = {}, needsDates = false;
  Object.keys(demands || {}).forEach(function (id) {
    var demand = demands[id] || {}, counts = demand.completion;
    var item = {sent:null, remaining:null, total:null, percent:null, estimatedDate:null, state:'unknown', reason:'incomplete'};
    reports[id] = item;
    if (!demand.complete || !counts) return;
    if (counts.issue) { item.reason = counts.issue; return; }
    var total = counts.sent + counts.remaining;
    if (![counts.validContacts,counts.sent,counts.remaining,total].every(function (n) { return Number.isSafeInteger(n) && n >= 0; })) return;
    item.sent = counts.sent; item.remaining = counts.remaining; item.total = total;
    if (!total) { item.state = 'empty'; item.reason = counts.validContacts ? 'no_sends' : 'no_contacts'; return; }
    // Keep 100% exclusively for a finished plan, including campaigns with a single outstanding email.
    item.percent = counts.remaining ? Math.min(99, Math.round(100 * counts.sent / total)) : 100;
    if (!counts.remaining) { item.state = 'completed'; item.reason = null; return; }
    var status = String(demand.campaignStatus || '').toLowerCase();
    if (status === 'paused') { item.state = 'paused'; item.reason = 'paused'; return; }
    if (status !== 'active') { item.reason = 'not_active'; return; }
    item.reason = 'capacity'; needsDates = true;
  });
  if (needsDates) projectForecastCalculate_(infrastructure,demands,nowMs,reports);
  return reports;
}

function projectCampaignSchedule_(source,demand,now) {
  if (source.schedule) return source.schedule;
  // A directly verified detail can fill a pending schedule, but cannot override a later provider result.
  if (!demand.schedule || !Number.isFinite(demand.scheduleCheckedAt) || now-demand.scheduleCheckedAt>COLDY.cacheMillis ||
      source.scheduleState==='error' || Date.parse(source.scheduleUpdatedAt)>=demand.scheduleCheckedAt) return null;
  return demand.schedule;
}

function projectCampaignHardStop_(campaign) {
  var steps=campaign.sequence && campaign.sequence.steps;
  if (campaign.dailyLimit===0 || campaign.allSelected && campaign.owners.length &&
      campaign.owners.every(function (a) { return a.blocked || a.limit===0; })) return true;
  return Array.isArray(steps) && (campaign.demand.cohorts || []).some(function (group) {
    if (!group.completionValid || group.disposition!=='eligible') return false;
    var index=group.sentSteps;
    if (index==null && group.previousStepId!=null) {
      index=steps.findIndex(function (s) { return s.id===group.previousStepId; })+1;
      if (!index) return false;
    }
    if (index==null || index>=steps.length) return false;
    var owner=campaign.assigned.get(String(group.senderId));
    return !!owner && (owner.blocked || owner.limit===0) || index===0 && campaign.firstDailyLimit===0 ||
      (index>0 || steps.length>1) && campaign.followupDailyLimit===0;
  });
}

/** Count only observed last sends. A recipient's earlier steps have no individual timestamps. */
function projectCampaignObservedRate_(campaign,today) {
  var day=86400000, start=today-14*day;
  var windows=projectForecastWindows_(campaign.schedule,start,today,new Map());
  if (!windows) return 0;
  var totals=windows.map(function () { return 0; });
  campaign.demand.cohorts.forEach(function (group) {
    if (!group.completionValid || !campaign.assigned.has(String(group.senderId)) || !group.lastSentAt ||
        !(group.sentSteps>0 || group.previousStepId>0)) return;
    var at=Date.parse(group.lastSentAt), index=Math.floor((at-start)/day);
    if (index>=0 && index<totals.length && windows[index].some(function (w) { return w[0]<=at && at<w[1]; }))
      totals[index]+=group.count;
  });
  var samples=0, sends=0, openDays=0, idle=0;
  totals.forEach(function (count,i) {
    if (count) { samples++; sends+=count; idle=0; }
    else if (windows[i].length) idle++;
    if (samples && windows[i].length) openDays++;
  });
  return samples>=2 && idle<2 ? Math.floor(sends/openDays) : 0;
}

/** Replay the campaign's queue at its measured whole-campaign pace when full quota modeling is unavailable. */
function projectCampaignObservedFinish_(campaign,row,now,today,horizon,budget) {
  if (!campaign.demand.complete || !campaign.windows || campaign.gap===null || !campaign.owners.length) return;
  var pace=projectCampaignObservedRate_(campaign,today);
  if (!pace) return;
  // The measured throughput already reflects other recipients and campaigns competing for these slots.
  var demand=Object.assign({},campaign.demand,{cohorts:campaign.demand.cohorts.filter(function (g) { return g.completionValid; })});
  var trial=Object.assign({},campaign,{demand:demand,queues:new Map(),reasons:new Set(),trackRemaining:row.remaining,
    completion:{},dailyLimit:Math.min(pace,campaign.dailyLimit===null ? pace : campaign.dailyLimit)});
  projectForecastLoadDemand_(trial,now,{unresolved:0,pendingInitial:0,pendingFollowups:0,unreadCampaigns:0});
  if (trial.reasons.size) return;
  var remaining=0;
  trial.queues.forEach(function (queues) {
    queues.forEach(function (heap) { heap.forEach(function (g) {
      if (g.completionValid) remaining+=g.count*(trial.sequence.steps.length-g.index);
    }); });
  });
  if (remaining!==row.remaining) return;
  var accounts=campaign.owners.filter(function (a) { return !a.blocked && a.limit!==0; }).map(function (a) {
    return {id:a.id,campaigns:[trial],nextAt:now,limit:a.limit};
  });
  if (!accounts.length) return;
  // The observed pace describes complete sending days. Start with the next full day.
  var day=86400000, pool={accounts:accounts};
  budget.tracking=1; budget.deferredToday=true;
  for (var index=1; index<horizon && budget.tracking; index++) {
    var start=today+index*day;
    trial.used=[0,0];
    accounts.forEach(function (a) { a.remaining=a.limit===null ? pace : Math.min(pace,a.limit); });
    if (!projectForecastSimulateDay_(pool,index,start,start+day,{expected:null},budget)) return;
  }
  if (trial.completion.estimatedDate) {
    row.state='estimated'; row.reason='observed_pace'; row.estimatedDate=trial.completion.estimatedDate;
  }
}

/** Simulate each connected mailbox pool once. Eligible leads of every competing campaign consume slots. */
function projectCampaignEstimatePool_(pool,reports,now,today,horizonDays,budget) {
  var targets = pool.campaigns.filter(function (c) {
    c.completion = reports[c.id];
    return c.completion && c.completion.remaining > 0 && c.completion.reason === 'capacity';
  });
  if (!targets.length) return;
  function unavailable(reason) { targets.forEach(function (c) { c.completion.reason = reason; }); }
  var counts = {pendingInitial:0,pendingFollowups:0,unresolved:0,unreadCampaigns:0};
  pool.campaigns.forEach(function (c) { projectForecastLoadDemand_(c,now,counts); });
  // If a competitor's queue is not known, its share of the same mailbox limit cannot be allocated.
  if (pool.campaigns.some(function (c) { return c.reasons.size; })) {
    var own = targets.length === 1 && pool.campaigns.length === 1 ? targets[0].reasons : null;
    unavailable(own && own.has('unknown_sequence') ? 'sequence' : pool.campaigns.length > 1 ? 'shared_capacity' : 'capacity');
    return;
  }
  var active = pool.campaigns.filter(function (c) { return c.measuredDemand; });
  if (active.some(function (c) { return !c.windows || c.gap === null; })) { unavailable('schedule'); return; }
  if (pool.accounts.some(function (a) { return a.outside && a.limit !== 0; })) { unavailable('shared_capacity'); return; }
  if (pool.accounts.some(function (a) { return !a.online || a.limit === null; })) return;

  budget.tracking = 0; budget.deferredToday = false;
  targets.forEach(function (c) {
    var modeled = 0;
    c.queues.forEach(function (queues,sender) {
      // A known zero limit on the lead's assigned sender prevents that lead from finishing.
      if (sender !== null && c.assigned.get(sender).limit === 0) return;
      queues.forEach(function (heap) { heap.forEach(function (g) {
        if (g.completionValid) modeled += g.count * (c.sequence.steps.length - g.index);
      }); });
    });
    if (modeled !== c.completion.remaining || !c.owners.some(function (a) { return !a.blocked && a.limit > 0; }) || c.dailyLimit === 0) return;
    c.trackRemaining = modeled; c.completion.reason = 'horizon'; budget.tracking++;
  });

  var day = 86400000;
  for (var index = 0; budget.tracking && index < horizonDays; index++) {
    var start = Math.max(now,today + index*day), end = today + (index+1)*day;
    if (!index) {
      var unknownBalance = active.some(function (c) {
        return c.windows[0].some(function (w) { return w[1] > start; }) &&
          (c.dailyLimit !== null || c.firstDailyLimit !== null || c.followupDailyLimit !== null ||
          c.owners.some(function (a) { return !a.blocked && a.limit > 0 && a.sentToday === null; }));
      });
      // Coldy does not always expose the remaining balance for today. Start this pool on its next day.
      if (unknownBalance) { budget.deferredToday = true; continue; }
    }
    active.forEach(function (c) { c.used = [0,0]; });
    pool.accounts.forEach(function (a) {
      a.remaining = a.limit;
      if (!index) a.remaining = Math.max(0,a.limit - (a.sentToday || 0));
    });
    var daily = {expected:0,initial:0,followups:0};
    if (!projectForecastSimulateDay_(pool,index,start,end,daily,budget)) return;
  }
}
