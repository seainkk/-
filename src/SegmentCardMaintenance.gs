/** Project-owned card snapshots share the existing incoming-only minute timer. */
var SEGMENT_CARD_MAINTENANCE = Object.freeze({
  lease: 'SEGMENT_CARD_REFRESH_LEASE_V1', state: 'SEGMENT_CARD_REFRESH_V1_',
  ownership: 'REGISTRY_SEGMENT_PROJECT_', interval: 5 * 60000, leaseMillis: 5 * 60000
});

function segmentCardMaintenanceState_(raw, root) {
  var state;
  if (raw) { try { state = JSON.parse(raw); } catch (ignored) {} }
  return state && state.root === root ? state : {root:root, next:0};
}

function segmentCardMaintenanceKey_(project, id) {
  return SEGMENT_CARD_MAINTENANCE.state + project + '_' + id;
}

function segmentCardMaintenanceTimer_(context) {
  var marker = coldyIncomingTimer_(context.properties);
  if (marker && marker.uid && marker.rootId === context.rootId && marker.verifier === SHARED_REQUEST_SCOPE_.keyHash) {
    var heartbeat;
    try { heartbeat = JSON.parse(context.properties.getProperty(coldyIncomingHeartbeatKey_(marker)) || 'null'); } catch (ignored) {}
    if (Math.max(Date.parse(heartbeat && heartbeat.at) || 0, marker.checkedAt || 0) > Date.now() - 10 * 60000)
      return {enabled:true, needsOwnerSetup:false};
  }
  return coldyIncomingEnsure_(context, false);
}

// A hint only. A successful import or provider write must survive a failed scheduling hint.
function segmentCardMaintenanceRequest_(context, segmentId) {
  try {
    var project = registrySegmentProject_(context, id_(segmentId));
    if (!registryProjectName_(project) || registryProjectScoped_() && project !== registryProjectId_()) return;
    context.properties.setProperty(segmentCardMaintenanceKey_(project, segmentId) + '_DIRTY', String(Date.now()));
  } catch (ignored) { /* The routine rotation also picks up direct sheet edits and missed hints. */ }
}

function segmentCardMaintenanceDue_(context) {
  var props = context.properties, all = props.getProperties(), items = [], now = Date.now(), prefix = SEGMENT_CARD_MAINTENANCE.ownership;
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(prefix) !== 0) return;
    var id = key.slice(prefix.length), project, state;
    try {
      project = registrySegmentProject_(context, id, all);
      if (!registryProjectName_(project)) return;
      var stateKey = segmentCardMaintenanceKey_(project, id);
      state = segmentCardMaintenanceState_(all[stateKey], context.rootId);
      var dirty = Number(all[stateKey + '_DIRTY']) || 0;
      var due = Number(state.next) || 0;
      if (dirty > (Number(state.attempt) || 0)) due = Math.min(due, Math.max(dirty, (Number(state.attempt) || 0) + 60000));
      if (due <= now) items.push({segmentId:id,project:project,due:due});
    } catch (ignored) { /* Invalid or stale project membership cannot authorize this segment. */ }
  });
  items.sort(function (a, b) { return a.due - b.due || a.segmentId.localeCompare(b.segmentId); });
  return items[0] || null;
}

function segmentCardMaintenanceBuild_(context, segmentId, outerGuard, scheduled) {
  var props = context.properties, project = registryProjectId_(), key = segmentCardMaintenanceKey_(project, segmentId);
  var leaseKey = SEGMENT_CARD_MAINTENANCE.lease, id = Utilities.getUuid(), started = Date.now();
  function scope() {
    var fresh = outerGuard();
    if (fresh.rootId !== context.rootId || !registryProjectScoped_() || registryProjectId_() !== project ||
        registrySegmentProject_(fresh, segmentId) !== project) fail_('OUTSIDE_PROJECT', 'Изменилась принадлежность сегмента к проекту.');
    return fresh;
  }
  function claim() { return JSON.parse(props.getProperty(leaseKey) || 'null'); }
  function guard() {
    var fresh = scope(), current = claim();
    if (!current || current.id !== id || current.until <= Date.now()) fail_('BUSY', 'Другая задача обновляет карточки.');
    return fresh;
  }
  var acquired = locked_(function () {
    scope();
    var previous = claim();
    if (previous && previous.until > started) return false;
    var state = segmentCardMaintenanceState_(props.getProperty(key), context.rootId);
    state.attempt = started; state.next = started + SEGMENT_CARD_MAINTENANCE.leaseMillis;
    props.setProperty(leaseKey, JSON.stringify({id:id, until:state.next}));
    props.setProperty(key, JSON.stringify(state));
    return true;
  }, 1000);
  if (!acquired) return {state:'busy'};
  var result, issue;
  try {
    result = segmentCardRefreshSnapshot_(guard(), segmentId, guard);
    return {state:'ready', revision:result.revision, checkedAt:result.checkedAt, rebuilt:result.rebuilt};
  } catch (error) {
    issue = /^[A-Z_]{1,60}$/.test(error.registryCode || '') ? error.registryCode : 'GOOGLE_ERROR';
    throw error;
  } finally {
    locked_(function () {
      var current = claim();
      if (!current || current.id !== id) return;
      try {
        scope();
        var state = segmentCardMaintenanceState_(props.getProperty(key), context.rootId);
        state.next = Date.now() + (issue === 'SEGMENT_CARD_CHANGED' ? 60000 : SEGMENT_CARD_MAINTENANCE.interval);
        if (issue) state.issue = issue; else {
          delete state.issue; state.checkedAt = result.checkedAt;
          if (scheduled) state.lastBackgroundAt = new Date(Date.now()).toISOString();
        }
        props.setProperty(key, JSON.stringify(state));
      } finally { props.deleteProperty(leaseKey); }
    }, 1000);
  }
}

function segmentCardMaintenanceTick_(timerGuard) {
  var previous = SHARED_REQUEST_SCOPE_, context = timerGuard(), next = segmentCardMaintenanceDue_(context);
  if (!next) return;
  SHARED_REQUEST_SCOPE_ = Object.assign({}, previous, {projectId:next.project});
  try { return segmentCardMaintenanceBuild_(context, next.segmentId, timerGuard, true); }
  finally { SHARED_REQUEST_SCOPE_ = previous; }
}

function prepareSegmentCardSnapshot_(request) {
  return api_(function () {
    var input = segmentInput_(request, ['segmentId','statusOnly']), segmentId = id_(input.segmentId), context = authorize_();
    if (input.statusOnly !== undefined && typeof input.statusOnly !== 'boolean') fail_('INVALID_REQUEST', 'Неизвестный режим проверки карточки.');
    registryRequireSegment_(context, segmentId);
    segmentFolder_(context, segmentSourceFolder_(context), segmentId, true);
    if (input.statusOnly) {
      var props = context.properties, marker = coldyIncomingTimer_(props), beat = {};
      var current = marker && marker.uid && marker.rootId === context.rootId && marker.verifier === SHARED_REQUEST_SCOPE_.keyHash;
      if (current) { try { beat = JSON.parse(props.getProperty(coldyIncomingHeartbeatKey_(marker)) || '{}'); } catch (ignored) {} }
      var state = segmentCardMaintenanceState_(props.getProperty(segmentCardMaintenanceKey_(registryProjectId_(), segmentId)), context.rootId);
      return {state:state.checkedAt ? 'ready' : 'pending', checkedAt:state.checkedAt || null, lastBackgroundAt:state.lastBackgroundAt || null,
        backgroundEnabled:!!current, heartbeatAt:beat && beat.at || null, lastError:state.issue || null};
    }
    var timer = segmentCardMaintenanceTimer_(context);
    var result = segmentCardMaintenanceBuild_(context, segmentId, authorize_);
    result.backgroundEnabled = timer.enabled; result.needsOwnerSetup = timer.needsOwnerSetup;
    return result;
  });
}
