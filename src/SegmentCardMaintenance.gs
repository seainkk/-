/** Project-owned card snapshots share the existing incoming-only minute timer. */
var SEGMENT_CARD_MAINTENANCE = Object.freeze({
  lease: 'SEGMENT_CARD_REFRESH_LEASE_V1', state: 'SEGMENT_CARD_REFRESH_V1_',
  ownership: 'REGISTRY_SEGMENT_PROJECT_', interval: 5 * 60000, leaseMillis: 5 * 60000,
  stages: ['files','campaigns','revision','load','contacts','encode','persist','receipt','cache','complete']
});

function segmentCardMaintenanceState_(raw, root) {
  var state;
  if (raw) { try { state = JSON.parse(raw); } catch (ignored) {} }
  return state && state.root === root ? state : {root:root, next:0};
}

function segmentCardMaintenanceKey_(project, id) {
  return SEGMENT_CARD_MAINTENANCE.state + project + '_' + id;
}

function segmentCardMaintenanceLease_(properties) {
  try { return JSON.parse(properties.getProperty(SEGMENT_CARD_MAINTENANCE.lease) || 'null'); }
  catch (ignored) { return null; }
}

// The web app and the minute trigger both run as the deployer. Their short lease updates
// can proceed while a registry/sheet writer holds the script lock.
function segmentCardMaintenanceLock_(waitMillis, update) {
  var lock = LockService.getUserLock();
  if (!lock.tryLock(waitMillis)) return false;
  try { return update(); } finally { lock.releaseLock(); }
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
      var due = state.schema === SEGMENT_CARD_SNAPSHOT.schema ? Number(state.next) || 0 : 0;
      if (dirty > (Number(state.attempt) || 0)) due = Math.min(due, Math.max(dirty, (Number(state.attempt) || 0) + 60000));
      if (due <= now) items.push({segmentId:id,project:project,due:due});
    } catch (ignored) { /* Invalid or stale project membership cannot authorize this segment. */ }
  });
  items.sort(function (a, b) { return a.due - b.due || a.segmentId.localeCompare(b.segmentId); });
  return items[0] || null;
}

function segmentCardMaintenanceBuild_(context, segmentId, outerGuard, scheduled, latestStart) {
  var props = context.properties, project = registryProjectId_(), key = segmentCardMaintenanceKey_(project, segmentId);
  var leaseKey = SEGMENT_CARD_MAINTENANCE.lease, id = Utilities.getUuid();
  function scope() {
    var fresh = outerGuard();
    if (fresh.rootId !== context.rootId || !registryProjectScoped_() || registryProjectId_() !== project ||
        registrySegmentProject_(fresh, segmentId) !== project) fail_('OUTSIDE_PROJECT', 'Изменилась принадлежность сегмента к проекту.');
    return fresh;
  }
  function guard() {
    var fresh = scope(), current = segmentCardMaintenanceLease_(props);
    if (!current || current.id !== id || current.until <= Date.now()) fail_('BUSY', 'Другая задача обновляет карточки.');
    return fresh;
  }
  guard.stage = function (name) {
    if (SEGMENT_CARD_MAINTENANCE.stages.indexOf(name) < 0) return;
    try { CacheService.getScriptCache().put('card-stage/' + id, JSON.stringify({name:name, at:Date.now()}), 900); }
    catch (ignored) { /* Optional diagnostics never hold a build. */ }
  };
  var acquired = segmentCardMaintenanceLock_(1500, function () {
    scope();
    var previous = segmentCardMaintenanceLease_(props), now = Date.now();
    if (latestStart && now > latestStart) return false;
    if (previous && previous.until > now) return false;
    var state = segmentCardMaintenanceState_(props.getProperty(key), context.rootId);
    state.schema = SEGMENT_CARD_SNAPSHOT.schema;
    state.attempt = now; state.next = now + SEGMENT_CARD_MAINTENANCE.leaseMillis;
    state.inProgress = true; state.background = !!scheduled; state.attemptId = id;
    var changes = {};
    changes[key] = JSON.stringify(state);
    changes[leaseKey] = JSON.stringify({id:id,key:key,until:state.next});
    props.setProperties(changes);
    return true;
  });
  if (!acquired) return {state:'busy'};
  var result, issue, buildError;
  try {
    result = segmentCardRefreshSnapshot_(guard(), segmentId, guard, scheduled === true);
    guard.stage('complete');
  } catch (error) {
    buildError = error;
    issue = /^[A-Z_]{1,60}$/.test(error.registryCode || '') ? error.registryCode : 'GOOGLE_ERROR';
  }
  try {
    segmentCardMaintenanceLock_(8000, function () {
      var current = segmentCardMaintenanceLease_(props);
      if (!current || current.id !== id) return;
      try {
        scope();
        var state = segmentCardMaintenanceState_(props.getProperty(key), context.rootId);
        state.inProgress = false;
        state.next = Date.now() + (issue === 'SEGMENT_CARD_CHANGED' ? 60000 : SEGMENT_CARD_MAINTENANCE.interval);
        if (issue) state.issue = issue; else {
          delete state.issue; state.checkedAt = result.checkedAt;
          if (scheduled) state.lastBackgroundAt = result.checkedAt;
        }
        props.setProperty(key, JSON.stringify(state));
      } finally { props.deleteProperty(leaseKey); }
    });
  } catch (finishError) {
    // The receipt commits readiness before cache warming and final queue bookkeeping.
    // Preserve the original build error. Rethrow an actual loss of scope on success.
    if (!buildError && finishError.registryCode) throw finishError;
  }
  if (buildError) throw buildError;
  scope();
  return {state:'ready', revision:result.revision, checkedAt:result.checkedAt, rebuilt:result.rebuilt};
}

function segmentCardMaintenanceTick_(timerGuard, latestStart) {
  var previous = SHARED_REQUEST_SCOPE_, context = timerGuard(), next = segmentCardMaintenanceDue_(context);
  if (!next) return;
  SHARED_REQUEST_SCOPE_ = Object.assign({}, previous, {projectId:next.project});
  try { return segmentCardMaintenanceBuild_(context, next.segmentId, timerGuard, true, latestStart); }
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
      var key = segmentCardMaintenanceKey_(registryProjectId_(), segmentId), state = segmentCardMaintenanceState_(props.getProperty(key), context.rootId);
      var receipt = segmentCardSnapshotMeta_(context, segmentCardSnapshotSlot_(context, segmentId));
      var lease = segmentCardMaintenanceLease_(props), now = Date.now(), busy = !!lease && lease.until > now;
      var running = busy && lease.key === key, finished = receipt && Date.parse(receipt.checkedAt) >= (state.attempt || 0);
      var stage = null;
      if (state.attemptId) {
        try { stage = JSON.parse(CacheService.getScriptCache().get('card-stage/' + state.attemptId)); } catch (ignored) {}
        if (!stage || SEGMENT_CARD_MAINTENANCE.stages.indexOf(stage.name) < 0 || !Number.isFinite(stage.at)) stage = null;
      }
      return {state:receipt && segmentCardSnapshotFresh_(receipt) ? 'ready' : 'pending', checkedAt:receipt && receipt.checkedAt || null,
        lastBackgroundAt:receipt && receipt.lastBackgroundAt || state.lastBackgroundAt || null, backgroundEnabled:!!current,
        heartbeatAt:beat && beat.at || null, lastError:finished ? null : state.issue || null,
        refreshState:running ? (finished ? 'finishing' : 'running') : finished ? 'idle' : state.inProgress ? 'interrupted' : state.issue ? 'retrying' : 'scheduled',
        attemptAt:state.attempt ? new Date(state.attempt).toISOString() : null, queueBusy:busy,
        stage:stage && stage.name, stageStartedAt:stage && new Date(stage.at).toISOString(),
        nextAttemptAt:state.next ? new Date(state.next).toISOString() : null};
    }
    var timer = segmentCardMaintenanceTimer_(context);
    var result = segmentCardMaintenanceBuild_(context, segmentId, authorize_);
    result.backgroundEnabled = timer.enabled; result.needsOwnerSetup = timer.needsOwnerSetup;
    return result;
  });
}
