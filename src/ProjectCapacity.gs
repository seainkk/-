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
    ids.add(item.id);
    var s = item.schedule;
    if (s !== null && (!s || !projectCapacitySchedule_(s, item.id) ||
        Object.keys(s).some(function (key) { return ['from','to','timezone','days','gapStartSeconds','gapEndSeconds'].indexOf(key) === -1; }) ||
        [s.gapStartSeconds, s.gapEndSeconds].some(function (value) { return value !== null && projectInfraCount_(value) === null; }))) invalid();
  });
  if (keys.length > PROJECT_INFRASTRUCTURE.maxAccounts) invalid();
  keys.forEach(function (id) {
    var links = cap.assignments[id];
    if (!/^[1-9]\d*$/.test(id) || !Array.isArray(links) || links.length > ids.size ||
        new Set(links).size !== links.length || links.some(function (key) { return !ids.has(key); })) invalid();
  });
}

function projectCapacityMappings_(response, selected, key) {
  if (!response || !Array.isArray(response.items) || response.items.length > PROJECT_INFRASTRUCTURE.maxAccounts ||
      response.next_cursor || response.nextCursor || response.nextPageToken || response.has_more || response.hasMore ||
      response.total != null && response.total !== response.items.length) {
    fail_('COLDY_INFRA_INCOMPLETE', 'Coldy не подтвердил полный список назначений почт.');
  }
  var accounts = Object.create(null), used = new Set(), campaigns = new Map(), statuses = new Map(), links = 0;
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
      if (campaign.status !== 'Active') return;
      var name = projectInfraText_(campaign.name, key, 1000);
      if (!name || ++links > 100000) fail_('COLDY_INFRA_INCOMPLETE', 'Карта активных рассылок неполна или слишком велика.');
      accounts[id].push(campaignId);
      if (!campaigns.has(campaignId)) campaigns.set(campaignId, { id: campaignId, name: name, status: 'Active', waitSchedule: null, schedule: null });
    });
  });
  return { assignments: accounts, campaigns: Array.from(campaigns.values()), updatedAt: new Date().toISOString(), stale: false };
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
  var work = state.capacityWork;
  function read(path) {
    projectInfraMonitoringCurrent_(context, settings.credentialHash, state.monitoringSignature);
    var response = coldyApi_(context, 'GET', path);
    projectInfraMonitoringCurrent_(context, settings.credentialHash, state.monitoringSignature);
    return response;
  }
  try {
    if (!work.mapped) {
      state.capacity = projectCapacityMappings_(read('/account-campaign-mappings'), state.detailIds, settings.key);
      work.mapped = true;
    }
    var campaigns = state.capacity.campaigns, deadline = Date.now() + PROJECT_INFRASTRUCTURE.detailBudgetMillis;
    var first = work.cursor, stop = Math.min(first + PROJECT_INFRASTRUCTURE.batch, campaigns.length);
    for (; work.cursor < stop; work.cursor++) {
      if (work.cursor > first && Date.now() >= deadline) break;
      var campaign = campaigns[work.cursor];
      try {
        var detail = read('/campaigns/' + campaign.id);
        if (!detail || !coldyUuid_(detail.id) || detail.id.toLowerCase() !== campaign.id || detail.status !== 'Active')
          fail_('COLDY_INFRA_ACCOUNT_CHANGED', 'Рассылка изменилась после получения карты назначений.');
        campaign.name = projectInfraText_(detail.name, settings.key, 1000) || campaign.name;
        campaign.waitSchedule = typeof detail.wait_schedule === 'boolean' ? detail.wait_schedule : null;
        campaign.schedule = projectCapacitySchedule_(detail.schedule, campaign.id);
      } catch (error) {
        if (error.registryCode !== 'COLDY_NOT_FOUND' && error.registryCode !== 'COLDY_FORBIDDEN') throw error;
        // The complete membership is still evidence of an assignment; the window is unknown.
        campaign.schedule = null;
      }
    }
    if (work.cursor === campaigns.length) delete state.capacityWork;
  } catch (error) {
    if (projectInfraScopeError_(error) || error.registryCode === 'COLDY_CREDENTIAL_CHANGED') throw error;
    if (state.capacity && (!work.mapped || error.registryCode === 'COLDY_INFRA_ACCOUNT_CHANGED' || error.registryCode === 'COLDY_AUTH')) state.capacity.stale = true;
    state.lastError = projectInfraError_(error); state.warnings.push(state.lastError.message);
    if (['COLDY_RATE_LIMIT','COLDY_NETWORK','COLDY_UNAVAILABLE'].indexOf(error.registryCode) !== -1) {
      state.retryAt = Date.now() + Math.max(15000, Math.min(86400000, error.retryAfterMs || 0));
    } else delete state.capacityWork;
  }
}

/** Resolve ownership against today's segment folders even when provider data is cached. */
function projectCapacityOwners_(context, ids) {
  var owners = Object.create(null), folders = Object.create(null), wanted = new Set(ids);
  if (!ids.length) return owners;
  coldyCampaignRegistry_(context).bindings.forEach(function (binding) {
    if (!wanted.has(binding.campaignId)) return;
    if (owners[binding.campaignId]) fail_('COLDY_STORAGE', 'У рассылки несколько сегментов.');
    if (!folders[binding.segmentId]) {
      try {
        var folder = segmentFolder_(context, segmentSourceFolder_(context), id_(binding.segmentId));
        var project = registrySegmentProject_(context, binding.segmentId);
        folders[binding.segmentId] = { bindingState: 'linked', segmentId: folder.getId(), segmentName: folder.getName(),
          segmentProjectId: project, segmentProjectName: project ? registryProjectName_(project) : null };
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
  var campaigns = cap ? cap.campaigns : [], byId = new Map(), idle = new Map(), zones = new Map();
  var owners = projectCapacityOwners_(context, campaigns.map(function (item) { return item.id; }));
  var list = campaigns.map(function (item) {
    byId.set(item.id, item);
    var owner = owners[item.id] || { bindingState: 'unlinked', segmentId: null, segmentName: null };
    return { id: item.id, name: projectInfraText_(item.name, settings.key, 1000), status: item.status,
      waitSchedule: item.waitSchedule, schedule: item.schedule, endAt: null,
      bindingState: owner.bindingState, segmentId: owner.segmentId, segmentName: owner.segmentName,
      segmentProjectId: owner.segmentProjectId || null, segmentProjectName: owner.segmentProjectName || null };
  });
  var partial = list.some(function (item) { return !item.schedule || item.bindingState === 'unknown'; });
  result.capacity = { state: !cap ? 'unknown' : stale || partial || work ? 'partial' : 'ready', stale: !!stale,
    updatedAt: cap ? cap.updatedAt : null, campaigns: list };
  result.accounts.forEach(function (account) {
    var ids = cap && cap.assignments[account.id], state = stale || !Array.isArray(ids) ? 'unknown' : ids.length ? 'busy' : 'free';
    var value = { state: state, campaignIds: ids || [], availableAt: null, idleFrom: null, idleUntil: null };
    if (state === 'busy') {
      var key = ids.slice().sort().join('|');
      if (!idle.has(key)) idle.set(key, projectCapacityIdle_(ids.map(function (id) { return byId.get(id).schedule; }), now, zones));
      Object.assign(value, idle.get(key));
    }
    account.capacity = value;
  });
  if (saved && saved.capacityRequested) {
    var mapped = (work ? work.mapped : !!cap) ? 1 : 0;
    result.syncProgress = { completed: result.detailProgress.completed + mapped + (work ? work.cursor : campaigns.length),
      total: result.detailProgress.total + 1 + (mapped ? campaigns.length : 0) };
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
