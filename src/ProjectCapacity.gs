/** Read-only account-to-campaign membership and weekly sending windows from Coldy. */
var PROJECT_CAPACITY_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function projectCapacityValidate_(saved) {
  var cap = saved.capacity, work = saved.capacityWork, campaigns = cap && cap.campaigns;
  function invalid() { fail_('COLDY_STORAGE', 'Сохранённая карта занятости почт требует проверки.'); }
  if (work && (typeof work.mapped !== 'boolean' || !Number.isSafeInteger(work.cursor) || work.cursor < 0 ||
      (work.mapped ? !Array.isArray(campaigns) || work.cursor > campaigns.length : work.cursor !== 0))) invalid();
  if (!cap) return;
  if (!Array.isArray(campaigns) || campaigns.length > 100000 || !Number.isFinite(Date.parse(cap.updatedAt)) ||
      typeof cap.stale !== 'boolean' || !cap.assignments || typeof cap.assignments !== 'object' || Array.isArray(cap.assignments)) invalid();
  var ids = new Set(), keys = Object.keys(cap.assignments);
  campaigns.forEach(function (item) {
    if (!item || !coldyUuid_(item.id) || ids.has(item.id) || item.status !== 'Active' || typeof item.name !== 'string' ||
        item.waitSchedule !== null && typeof item.waitSchedule !== 'boolean') invalid();
    if (item.allSendersSelected !== undefined && typeof item.allSendersSelected !== 'boolean') invalid();
    if (item.scheduleUpdatedAt != null && !Number.isFinite(Date.parse(item.scheduleUpdatedAt))) invalid();
    if (item.scheduleCheck !== undefined && ['pending','checked','error','denied','invalid'].indexOf(item.scheduleCheck) < 0) invalid();
    ids.add(item.id);
    var s = item.schedule;
    if (s !== null && (!s || !projectCapacitySchedule_(s, item.id) ||
        Object.keys(s).some(function (key) { return ['from','to','timezone','days','gapStartSeconds','gapEndSeconds'].indexOf(key) === -1; }) ||
        [s.gapStartSeconds, s.gapEndSeconds].some(function (value) { return value !== null && projectInfraCount_(value) === null; }))) invalid();
  });
  if (keys.length > PROJECT_INFRASTRUCTURE.maxAccounts) invalid();
  if (cap.outsideActive && (typeof cap.outsideActive !== 'object' || Array.isArray(cap.outsideActive) ||
      Object.keys(cap.outsideActive).some(function (id) { return !Array.isArray(cap.assignments[id]) || cap.outsideActive[id] !== true; }))) invalid();
  keys.forEach(function (id) {
    var links = cap.assignments[id];
    if (!/^[1-9]\d*$/.test(id) || !Array.isArray(links) || links.length > ids.size ||
        new Set(links).size !== links.length || links.some(function (key) { return !ids.has(key); })) invalid();
  });
  var inactive = cap.inactiveAssignments;
  if (inactive !== undefined) {
    if (!inactive || typeof inactive !== 'object' || Array.isArray(inactive)) invalid();
    var count = 0;
    Object.keys(inactive).forEach(function (id) {
      var links = inactive[id];
      if (!Array.isArray(cap.assignments[id]) || !Array.isArray(links) || (count += links.length) > 100000 ||
          new Set(links).size !== links.length || links.some(function (key) {
            return !coldyUuid_(key) || key !== key.toLowerCase() || ids.has(key);
          })) invalid();
    });
  }
}

/** Keep only current project bindings. A flag preserves occupancy without storing other campaign names or IDs. */
function projectCapacitySelected_(context, capacity, observation) {
  var candidates = new Set(capacity.campaigns.map(function (item) { return item.id; }));
  Object.values(capacity.inactiveAssignments || {}).forEach(function (links) {
    links.forEach(function (id) { candidates.add(id); });
  });
  var owners = projectCapacityOwners_(context, Array.from(candidates), observation);
  var project = typeof registryProjectId_ === 'function' ? registryProjectId_() : 'numshield';
  function visible(id) {
    var owner = owners[id];
    return owner && owner.bindingState === 'linked' && owner.segmentProjectId === project;
  }
  var outside = Object.assign({}, capacity.outsideActive), assignments = {}, inactive = {};
  Object.keys(capacity.assignments).forEach(function (id) {
    var ids = capacity.assignments[id];
    assignments[id] = ids.filter(visible);
    if (ids.length !== assignments[id].length) outside[id] = true;
    var other = capacity.inactiveAssignments && capacity.inactiveAssignments[id];
    if (other) {
      var linked = other.filter(visible);
      if (linked.length) inactive[id] = linked;
    }
  });
  var scoped = Object.assign({}, capacity, {assignments:assignments, outsideActive:outside,
    campaigns:capacity.campaigns.filter(function (item) { return visible(item.id); })});
  if (capacity.inactiveAssignments) scoped.inactiveAssignments = inactive;
  return {owners:owners, capacity:scoped};
}

function projectCapacityMappings_(response, selected, key, receivedAt) {
  if (!response || !Array.isArray(response.items) || response.items.length > PROJECT_INFRASTRUCTURE.maxAccounts ||
      response.next_cursor || response.nextCursor || response.nextPageToken || response.has_more || response.hasMore ||
      response.total != null && response.total !== response.items.length) {
    fail_('COLDY_INFRA_INCOMPLETE', 'Coldy не подтвердил полный список назначений почт.');
  }
  var accounts = Object.create(null), inactive = Object.create(null), used = new Set(), campaigns = new Map(), statuses = new Map(), links = 0;
  selected.forEach(function (id) { accounts[id] = []; });
  response.items.forEach(function (item) {
    var id = projectInfraId_(item && item.account_id);
    if (used.has(id) || !Array.isArray(item.campaigns)) fail_('COLDY_RESPONSE', 'Некорректная карта назначений почт Coldy.');
    used.add(id);
    if (!accounts[id]) return;
    var seen = new Set();
    item.campaigns.forEach(function (campaign) {
      if (!campaign || !coldyUuid_(campaign.id) || ['Active','Completed','Draft','Paused'].indexOf(campaign.status) === -1)
        fail_('COLDY_RESPONSE', 'Coldy не подтвердил статус или идентификатор рассылки.');
      var campaignId = campaign.id.toLowerCase();
      if (seen.has(campaignId) || statuses.has(campaignId) && statuses.get(campaignId) !== campaign.status)
        fail_('COLDY_RESPONSE', 'Coldy вернул противоречивые назначения одной рассылки.');
      seen.add(campaignId); statuses.set(campaignId, campaign.status);
      if (++links > 100000) fail_('COLDY_INFRA_INCOMPLETE', 'Карта назначений рассылок слишком велика.');
      if (campaign.status !== 'Active') {
        if (!inactive[id]) inactive[id] = [];
        inactive[id].push(campaignId);
        return;
      }
      var name = projectInfraText_(campaign.name, key, 1000);
      if (!name) fail_('COLDY_INFRA_INCOMPLETE', 'Карта активных рассылок неполна.');
      accounts[id].push(campaignId);
      if (!campaigns.has(campaignId)) campaigns.set(campaignId, { id: campaignId, name: name, status: 'Active', waitSchedule: null, schedule: null });
    });
  });
  // Only retain whether the selected pool covers every sender of each visible campaign.
  // No addresses, names or assignments of unselected accounts enter the snapshot.
  campaigns.forEach(function (campaign) { campaign.allSendersSelected = true; });
  response.items.forEach(function (item) {
    if (accounts[item.account_id]) return;
    item.campaigns.forEach(function (link) {
      var campaign = link && typeof link.id === 'string' && campaigns.get(link.id.toLowerCase());
      if (campaign) campaign.allSendersSelected = false;
    });
  });
  return { assignments: accounts, inactiveAssignments: inactive, campaigns: Array.from(campaigns.values()), updatedAt: receivedAt || new Date().toISOString(), stale: false };
}

function projectCapacitySchedule_(value, campaignId) {
  if (!value || value.campaign_id && (!coldyUuid_(value.campaign_id) || value.campaign_id.toLowerCase() !== campaignId) || !Array.isArray(value.days) ||
      !value.days.length || value.days.length > 7 || value.days.some(function (day) { return PROJECT_CAPACITY_DAYS.indexOf(day) < 0; }) ||
      typeof value.timezone !== 'string' || !/^[A-Za-z0-9_+/-]{1,80}$/.test(value.timezone)) return null;
  function clock(value, end) {
    if (typeof value !== 'string') return null;
    var match = value.match(/^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/);
    return match ? match[1] + ':' + match[2] : end && /^24:00(?::00)?$/.test(value) ? '24:00' : null;
  }
  var from = clock(value.from, false), to = clock(value.to, true);
  if (!from || !to || from === to) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }); } catch (error) { return null; }
  return { days: Array.from(new Set(value.days)), from: from, to: to, timezone: value.timezone,
    gapStartSeconds: projectInfraCount_(value.gap_start), gapEndSeconds: projectInfraCount_(value.gap_end) };
}

function projectCapacityAdvance_(context, settings, state) {
  var work = state.capacityWork, receivedAt;
  function read(path) {
    projectInfraMonitoringCurrent_(context, settings.credentialHash, state.monitoringSignature);
    var response = coldyApi_(context, 'GET', path);
    receivedAt = new Date().toISOString();
    projectInfraMonitoringCurrent_(context, settings.credentialHash, state.monitoringSignature);
    return response;
  }
  try {
    if (!work.mapped) {
      var response = read('/account-campaign-mappings');
      var mapping = projectCapacityMappings_(response, state.detailIds, settings.key, receivedAt);
      state.verifiedProvider = true;
      var selected = projectCapacitySelected_(context, mapping).capacity;
      var confirmation = state.finalCapacityCheck && state.selectedOnly && state.cursorIndex === state.detailIds.length;
      var previous = new Map((state.capacity ? state.capacity.campaigns : []).map(function (c) { return [c.id,c]; }));
      selected.campaigns.forEach(function (c) {
        var old = previous.get(c.id);
        if (old) {
          c.schedule = old.schedule;
          c.waitSchedule = old.waitSchedule;
          c.scheduleUpdatedAt = old.scheduleUpdatedAt === undefined && old.schedule ? state.capacity.updatedAt : old.scheduleUpdatedAt || null;
        }
        c.scheduleCheck = confirmation && old ? old.scheduleCheck || 'checked' : 'pending';
      });
      state.capacity = selected;
      if (confirmation) {
        state.inventoryAt = selected.updatedAt;
        state.finalMembershipConfirmed = true;
        delete state.capacityWork;
        return;
      }
      work.mapped = true;
      // Publish assignments before waiting for any individual campaign schedule.
      if (state.poolOnly && state.capacity.campaigns.length) return;
    }
    var campaigns = state.capacity.campaigns, scoped = projectCapacitySelected_(context,state.capacity);
    var visibleIds = new Set(scoped.capacity.campaigns.map(function (campaign) { return campaign.id; }));
    var project = typeof registryProjectId_ === 'function' ? registryProjectId_() : 'numshield';
    var parallel = typeof UrlFetchApp !== 'undefined' && typeof UrlFetchApp.fetchAll === 'function';
    var deadline = Date.now() + PROJECT_INFRASTRUCTURE.detailBudgetMillis;
    var first = work.cursor, stop = Math.min(first + PROJECT_INFRASTRUCTURE.batch, campaigns.length);
    function finished(c) { return ['checked','denied','invalid'].indexOf(c.scheduleCheck) >= 0; }
    while (work.cursor < stop && (work.cursor === first || Date.now() < deadline)) {
      var end = Math.min(stop, work.cursor + (parallel ? COLDY.readBatchSize : 1));
      var group = campaigns.slice(work.cursor,end).filter(function (c) {
        return visibleIds.has(c.id) && !finished(c);
      });
      var ids = group.map(function (c) { return c.id; });
      function guard() {
        // The last guard starts on receipt, before potentially slow Drive ownership checks.
        receivedAt = new Date().toISOString();
        var fresh = projectInfraMonitoringCurrent_(context,settings.credentialHash,state.monitoringSignature);
        var owners = projectCapacityOwners_(fresh,ids);
        if ((typeof registryProjectId_ === 'function' && registryProjectId_() !== project) || ids.some(function (id) {
          var owner = owners[id];
          return !owner || owner.bindingState !== 'linked' || owner.segmentProjectId !== project || owner.segmentId !== scoped.owners[id].segmentId;
        })) fail_('COLDY_MONITORING_CHANGED','Изменилась привязка рассылки к сегменту. Обновите данные.');
      }
      var responses = ids.length ? coldyGetBatch_(context,ids.map(function (id) { return '/campaigns/' + id; }),guard,true) : [];
      var retry = null;
      group.forEach(function (campaign,index) {
        var error = responses[index].error;
        if (error) {
          campaign.scheduleCheck = 'error';
          if (error.registryCode === 'COLDY_NOT_FOUND' || error.registryCode === 'COLDY_FORBIDDEN') {
            campaign.scheduleCheck = 'denied'; campaign.schedule = null; campaign.scheduleUpdatedAt = null; campaign.waitSchedule = null;
            return;
          }
          if (['COLDY_RATE_LIMIT','COLDY_NETWORK','COLDY_UNAVAILABLE'].indexOf(error.registryCode) < 0) throw error;
          if (!retry || (error.retryAfterMs || 0) > (retry.retryAfterMs || 0)) retry = error;
          return;
        }
        var detail = responses[index].value;
        if (!detail || !coldyUuid_(detail.id) || detail.id.toLowerCase() !== campaign.id || detail.status !== 'Active')
          fail_('COLDY_INFRA_ACCOUNT_CHANGED', 'Рассылка изменилась после получения карты назначений.');
        campaign.name = projectInfraText_(detail.name, settings.key, 1000) || campaign.name;
        campaign.waitSchedule = typeof detail.wait_schedule === 'boolean' ? detail.wait_schedule : null;
        var schedule = projectCapacitySchedule_(detail.schedule, campaign.id);
        if (detail.schedule != null && !schedule) {
          campaign.scheduleCheck = 'invalid';
          return;
        }
        campaign.schedule = schedule;
        campaign.scheduleUpdatedAt = receivedAt;
        campaign.scheduleCheck = 'checked';
      });
      while (work.cursor < end && (!visibleIds.has(campaigns[work.cursor].id) || finished(campaigns[work.cursor]))) work.cursor++;
      if (retry) throw retry;
    }
    if (work.cursor === campaigns.length) delete state.capacityWork;
  } catch (error) {
    if (projectInfraScopeError_(error) || error.registryCode === 'COLDY_CREDENTIAL_CHANGED') throw error;
    (group || []).forEach(function (campaign) {
      if (['checked','denied','invalid'].indexOf(campaign.scheduleCheck) < 0) campaign.scheduleCheck = 'error';
    });
    if (state.capacity && (!work.mapped || error.registryCode === 'COLDY_INFRA_ACCOUNT_CHANGED' || error.registryCode === 'COLDY_AUTH')) state.capacity.stale = true;
    state.lastError = projectInfraError_(error); state.warnings.push(state.lastError.message);
    if (['COLDY_RATE_LIMIT','COLDY_NETWORK','COLDY_UNAVAILABLE'].indexOf(error.registryCode) !== -1) {
      state.retryAt = Date.now() + Math.max(15000, Math.min(86400000, error.retryAfterMs || 0));
    } else delete state.capacityWork;
  }
}

/** Resolve ownership against today's segment folders even when provider data is cached. */
function projectCapacityOwners_(context, ids, observation) {
  var owners = Object.create(null), folders = Object.create(null), wanted = new Set(ids);
  if (!ids.length) return owners;
  var projectId = registryProjectId_(), properties = context.properties.getProperties(), parent;
  // A forecast can check the same journal before and after several bounded provider reads.
  // Retain its parsed data only within this execution and only at the same live Drive version.
  var registry;
  if (observation && observation.registry && observation.unchanged && observation.unchanged()) {
    registry = observation.registry;
  } else {
    if (observation) delete observation.unchanged;
    registry = coldyCampaignRegistry_(context,observation);
    if (observation) observation.registry = registry;
  }
  registry.bindings.forEach(function (binding) {
    if (!wanted.has(binding.campaignId) || registrySegmentProject_(context,binding.segmentId,properties) !== projectId) return;
    if (owners[binding.campaignId]) fail_('COLDY_STORAGE', 'У рассылки несколько сегментов.');
    if (!folders[binding.segmentId]) {
      try {
        if (!parent) parent = segmentSourceFolder_(context);
        var folder = segmentFolder_(context, parent, id_(binding.segmentId), true);
        folders[binding.segmentId] = { bindingState: 'linked', segmentId: folder.getId(), segmentName: folder.getName(),
          segmentProjectId: projectId, segmentProjectName: registryProjectName_(projectId) };
      } catch (error) {
        if (['OUTSIDE_SEGMENTS','OUTSIDE_REGISTRY','NOT_FOUND'].indexOf(error.registryCode) < 0) throw error;
        folders[binding.segmentId] = { bindingState: 'unknown', segmentId: null, segmentName: null };
      }
    }
    owners[binding.campaignId] = folders[binding.segmentId];
  });
  return owners;
}

function projectCapacityPublic_(context, settings, saved, result) {
  var cap = saved && saved.capacity, work = saved && saved.capacityWork, now = Date.now();
  var stale = !cap || cap.stale || !Number.isFinite(Date.parse(cap.updatedAt)) ||
    Date.parse(cap.updatedAt) < now - PROJECT_INFRASTRUCTURE.cacheMillis ||
    work && !work.mapped || !saved.inventoryAt || Date.parse(saved.inventoryAt) < now - PROJECT_INFRASTRUCTURE.cacheMillis;
  var scoped = cap ? projectCapacitySelected_(context,cap) : null;
  var owners = scoped ? scoped.owners : {};
  cap = scoped && scoped.capacity;
  var campaigns = cap ? cap.campaigns : [], byId = new Map(), idle = new Map(), zones = new Map();
  var list = campaigns.map(function (item) {
    var owner = owners[item.id] || { bindingState: 'unlinked', segmentId: null, segmentName: null };
    var observed = Date.parse(item.scheduleUpdatedAt);
    // In older snapshots schedules were fetched after that snapshot's membership map. Its date
    // is a lower bound for freshness, never an invented timestamp for the individual schedule.
    if (item.scheduleUpdatedAt === undefined && item.schedule && !saved.finalMembershipConfirmed) observed = Date.parse(cap.updatedAt);
    var checking = item.scheduleCheck === 'pending' || work && !work.mapped;
    var failed = ['error','denied','invalid'].indexOf(item.scheduleCheck) >= 0;
    var expired = !Number.isFinite(observed) || observed < now - PROJECT_INFRASTRUCTURE.cacheMillis;
    var scheduleStale = !!(checking || failed || expired || stale);
    var scheduleState = failed ? 'error' : checking ? 'pending' : expired && item.schedule ? 'stale' :
      item.schedule ? (stale ? 'stale' : 'ready') : Number.isFinite(observed) ? 'unavailable' : saved.lastError ? 'error' : 'pending';
    var current = { id: item.id, name: projectInfraText_(item.name, settings.key, 1000), status: item.status, allSendersSelected: item.allSendersSelected === true,
      waitSchedule: scheduleStale ? null : item.waitSchedule, schedule: scheduleStale ? null : item.schedule,
      lastKnownSchedule:scheduleStale ? item.schedule : null, scheduleUpdatedAt:item.scheduleUpdatedAt || null,
      scheduleStale:scheduleStale, scheduleState:scheduleState, endAt: null,
      bindingState: owner.bindingState, segmentId: owner.segmentId, segmentName: owner.segmentName,
      segmentProjectId: owner.segmentProjectId || null, segmentProjectName: owner.segmentProjectName || null };
    byId.set(item.id,current);
    return current;
  });
  var partial = list.some(function (item) { return !item.schedule || item.bindingState === 'unknown'; });
  result.capacity = { state: !cap ? 'unknown' : stale || partial || work ? 'partial' : 'ready', stale: !!stale,
    updatedAt: cap ? cap.updatedAt : null, campaigns: list };
  result.accounts.forEach(function (account) {
    var ids = cap && cap.assignments[account.id], outside = !!(cap && cap.outsideActive[account.id]);
    var state = stale || !Array.isArray(ids) ? 'unknown' : ids.length || outside ? 'busy' :
      saved.selectedOnly && (!account.updatedAt || account.stale || account.syncError) ? 'unknown' : 'free';
    var value = { state: state, campaignIds: ids || [], inactiveCampaignIds:ids && cap.inactiveAssignments ? cap.inactiveAssignments[account.id] || [] : null,
      outsideActive:outside, availableAt: null, idleFrom: null, idleUntil: null };
    if (state === 'busy' && !outside) {
      var key = ids.slice().sort().join('|');
      if (!idle.has(key)) idle.set(key, projectCapacityIdle_(ids.map(function (id) { return byId.get(id).schedule; }), now, zones));
      Object.assign(value, idle.get(key));
    }
    account.capacity = value;
  });
  if (saved && saved.capacityRequested) {
    var mapped = (work ? work.mapped : !!cap) ? 1 : 0;
    result.syncProgress = { completed: (saved.poolOnly && !saved.selectedOnly ? 0 : result.detailProgress.completed) + mapped + (work ? work.cursor : campaigns.length),
      total: (saved.poolOnly && !saved.selectedOnly ? 0 : result.detailProgress.total) + 1 + (mapped ? campaigns.length : 0) };
    if (work && work.confirmOnly || saved.finalMembershipConfirmed) {
      var checked = result.detailProgress.completed + 1 + (saved.schedulesBeforeConfirmation || 0);
      result.syncProgress = {completed: checked + (saved.finalMembershipConfirmed ? 1 : 0), total:checked + 1};
    }
  }
}

/** Offset ranges let wall-clock schedules handle skipped and repeated DST hours exactly. */
function projectCapacityZone_(zone, now, horizon, cached) {
  if (cached.has(zone)) return cached.get(zone);
  var format = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  var minute = 60000, start = Math.floor(now / minute) * minute, ranges = [];
  function offset(at) {
    var parts = {};
    format.formatToParts(new Date(at)).forEach(function (part) { parts[part.type] = part.value; });
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute) - Math.floor(at / minute) * minute;
  }
  var current = offset(start), left = start;
  for (var t = start; t < horizon;) {
    var next = Math.min(t + 12 * 3600000, horizon), nextOffset = offset(next);
    if (nextOffset !== current) {
      var lo = t, hi = Math.floor(next / minute) * minute;
      while (hi - lo > minute) {
        var mid = Math.floor((lo + hi) / 2 / minute) * minute;
        if (offset(mid) === current) lo = mid; else hi = mid;
      }
      ranges.push([left, hi, current]); left = hi; current = nextOffset;
    }
    t = next;
  }
  ranges.push([left, horizon, current]); cached.set(zone, ranges); return ranges;
}

function projectCapacityIdle_(schedules, now, cached) {
  var unknown = { idleFrom: null, idleUntil: null };
  if (!schedules.length || schedules.some(function (item) { return !item; })) return unknown;
  var day = 86400000, horizon = now + 9 * day, intervals = [];
  cached = cached || new Map();
  function clockMs(value) { return (Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))) * 60000; }
  schedules.forEach(function (schedule) {
    var start = clockMs(schedule.from), end = clockMs(schedule.to), days = new Set(schedule.days);
    if (end < start) end += day;
    projectCapacityZone_(schedule.timezone, now, horizon, cached).forEach(function (range) {
      var offset = range[2], first = Math.floor((range[0] + offset) / day) * day - day;
      for (var date = first; date <= range[1] + offset; date += day) {
        if (!days.has(PROJECT_CAPACITY_DAYS[new Date(date).getUTCDay()])) continue;
        var from = Math.max(range[0], date + start - offset, now), to = Math.min(range[1], date + end - offset);
        if (to > from) intervals.push([from, to]);
      }
    });
  });
  intervals.sort(function (a, b) { return a[0] - b[0]; });
  var idleFrom = now;
  for (var i = 0; i < intervals.length; i++) {
    if (intervals[i][0] > idleFrom) return { idleFrom: new Date(idleFrom).toISOString(), idleUntil: new Date(intervals[i][0]).toISOString() };
    idleFrom = Math.max(idleFrom, intervals[i][1]);
  }
  return unknown;
}
