/** One owner-installed timer covers all enrolled workbooks; no per-file triggers. */
var CONTACT_AUTOMATION = Object.freeze({
  handler: 'contactAutomationTick_', intervalMinutes: 5, maxMillis: 240000,
  trigger: 'CONTACT_AUTOMATION_TRIGGER', root: 'CONTACT_AUTOMATION_ROOT',
  verifier: 'CONTACT_AUTOMATION_VERIFIER', lastRun: 'CONTACT_AUTOMATION_LAST_RUN',
  lastError: 'CONTACT_AUTOMATION_LAST_ERROR', cursor: 'CONTACT_AUTOMATION_CURSOR',
  remaining: 'CONTACT_AUTOMATION_REMAINING', lease: 'CONTACT_AUTOMATION_LEASE'
});

function contactAutomationInput_(request) {
  var input = request === undefined ? {} : object_(request);
  if (Object.keys(input).length) fail_('INVALID_REQUEST', 'Неизвестные параметры фонового обновления.');
  return authorize_();
}

function contactAutomationPublicState_(properties) {
  var configured = properties.getProperty(CONTACT_AUTOMATION.trigger);
  var installed = !!configured;
  try {
    if (installed && typeof ScriptApp !== 'undefined' && typeof ScriptApp.getProjectTriggers === 'function') {
      installed = ScriptApp.getProjectTriggers().some(function (trigger) {
        return trigger.getUniqueId() === configured && trigger.getHandlerFunction() === CONTACT_AUTOMATION.handler;
      });
    }
  } catch (error) { /* The manual button works even before owner trigger consent. */ }
  return { installed: installed, intervalMinutes: CONTACT_AUTOMATION.intervalMinutes,
    lastRunAt: properties.getProperty(CONTACT_AUTOMATION.lastRun) || null,
    lastError: properties.getProperty(CONTACT_AUTOMATION.lastError) || null,
    needsOwnerSetup: !installed,
    setupUrl: 'https://script.google.com/home/projects/1FyQVeeqd4X13NqQ7PtRMVg7U8p60yk-tWvgK-9vmPdpQgK-mQE3sL8aH/edit',
    setupFunction: 'setupContactAutomation_'
  };
}

function getContactAutomationState_(request) {
  return api_(function () { return contactAutomationPublicState_(contactAutomationInput_(request).properties); });
}

function enableContactAutomation_(request) {
  return api_(function () {
    var context = contactAutomationInput_(request);
    registryRoot_(context);
    try {
      if (typeof ScriptApp === 'undefined') throw new Error('Script service unavailable');
      var existing = ScriptApp.getProjectTriggers().filter(function (trigger) { return trigger.getHandlerFunction() === CONTACT_AUTOMATION.handler; });
      var trigger = existing[0] || ScriptApp.newTrigger(CONTACT_AUTOMATION.handler).timeBased().everyMinutes(CONTACT_AUTOMATION.intervalMinutes).create();
      context.properties.setProperty(CONTACT_AUTOMATION.trigger, trigger.getUniqueId());
      context.properties.setProperty(CONTACT_AUTOMATION.root, context.rootId);
      context.properties.setProperty(CONTACT_AUTOMATION.verifier, SHARED_REQUEST_SCOPE_.keyHash);
      context.properties.deleteProperty(CONTACT_AUTOMATION.lastError);
      return contactAutomationPublicState_(context.properties);
    } catch (error) {
      var state = contactAutomationPublicState_(context.properties);
      state.needsOwnerSetup = true;
      state.message = 'Владелец проекта должен один раз запустить setupContactAutomation_ в редакторе Apps Script и разрешить фоновое обновление. Кнопка проверки контактов уже доступна.';
      return state;
    }
  });
}

function disableContactAutomation_(request) {
  return api_(function () {
    var context = contactAutomationInput_(request), id = context.properties.getProperty(CONTACT_AUTOMATION.trigger);
    // A disabled marker immediately stops the worker even if Google cannot
    // delete the trigger until the owner's next consented editor session.
    context.properties.deleteProperty(CONTACT_AUTOMATION.trigger);
    context.properties.deleteProperty(CONTACT_AUTOMATION.verifier);
    try { ScriptApp.getProjectTriggers().forEach(function (trigger) {
      if (trigger.getUniqueId() === id && trigger.getHandlerFunction() === CONTACT_AUTOMATION.handler) ScriptApp.deleteTrigger(trigger);
    }); } catch (error) { /* The worker also checks the removed marker. */ }
    return contactAutomationPublicState_(context.properties);
  });
}

/** Editor-only setup; underscore functions are never callable by HTML Service. */
function setupContactAutomation_() {
  return contactAutomationOwnerScope_(null, function () { return enableContactAutomation_({}); }, true);
}

function contactAutomationOwnerScope_(event, callback, editorSetup) {
  var properties = PropertiesService.getScriptProperties();
  var verifier = sharedConfiguredHash_(properties), root = properties.getProperty('ROOT_FOLDER_ID') || REGISTRY_CONFIG.defaultRootFolderId;
  if (!editorSetup) {
    if (!event || typeof event.triggerUid !== 'string' || event.triggerUid !== properties.getProperty(CONTACT_AUTOMATION.trigger)) return null;
    if (properties.getProperty(CONTACT_AUTOMATION.root) !== root || properties.getProperty(CONTACT_AUTOMATION.verifier) !== verifier) return null;
  }
  var previous = SHARED_REQUEST_SCOPE_;
  SHARED_REQUEST_SCOPE_ = { keyHash: verifier, automation: true };
  try { return callback(); } finally { SHARED_REQUEST_SCOPE_ = previous; }
}

function contactAutomationTick_(event) {
  return contactAutomationOwnerScope_(event, function () {
    var started = Date.now(), context = authorize_(), properties = context.properties;
    var lock = LockService.getScriptLock(), claim = null;
    if (!lock.tryLock(100)) return { skipped: 'busy' };
    try {
      var old;
      try { old = JSON.parse(properties.getProperty(CONTACT_AUTOMATION.lease) || 'null'); } catch (error) { old = null; }
      if (old && old.until > started) return { skipped: 'busy' };
      claim = { id: Utilities.getUuid(), until: started + CONTACT_AUTOMATION.maxMillis + 60000 };
      properties.setProperty(CONTACT_AUTOMATION.lease, JSON.stringify(claim));
    } finally { lock.releaseLock(); }
    try {
      registryRoot_(context);
      if (typeof listContactWorkspacesForAutomation_ !== 'function') return { processed: 0 };
      var remaining;
      try { remaining = JSON.parse(properties.getProperty(CONTACT_AUTOMATION.remaining) || '[]'); } catch (error) { remaining = []; }
      if (!Array.isArray(remaining)) remaining = [];
      if (!remaining.length) {
        var page = listContactWorkspacesForAutomation_(context, { cursor: properties.getProperty(CONTACT_AUTOMATION.cursor) || '', limit: 10 });
        remaining = Array.isArray(page.items) ? page.items : [];
        properties.setProperty(CONTACT_AUTOMATION.cursor, page.nextCursor || '');
      }
      var processed = 0, hadError = false;
      while (remaining.length && Date.now() - started < CONTACT_AUTOMATION.maxMillis - 20000) {
        var item = remaining[0];
        try {
          authorize_();
          if (item.role === 'segment-companies' && typeof syncSegmentPeople_ === 'function') {
            var people = syncSegmentPeople_({ companyFileId: item.id, requestId: 'auto-person-' + Utilities.getUuid() }), personSteps = 0;
            while (people && people.state === 'processing' && personSteps++ < 5 && Date.now() - started < CONTACT_AUTOMATION.maxMillis - 20000) {
              people = continueSegmentRecords_({ segmentId: people.segmentId, jobId: people.jobId, requestId: people.requestId });
            }
            if (people && people.state === 'processing') break;
          }
          var workspace = getContactWorkspace_({ id: item.id }), result;
          if (workspace.job && workspace.job.jobId) result = continueContactSync_({ id: item.id, jobId: workspace.job.jobId, requestId: workspace.job.requestId });
          else if (workspace.shouldSync === false) result = { state: 'complete' };
          else result = syncWorkbookContacts_({ id: item.id, requestId: 'auto-sync-' + Utilities.getUuid() });
          var steps = 0;
          while (result.state === 'processing' && steps++ < 5 && Date.now() - started < CONTACT_AUTOMATION.maxMillis - 20000) {
            result = continueContactSync_({ id: item.id, jobId: result.jobId, requestId: result.requestId });
          }
          if (result.state === 'processing') break;
          if (typeof processWorkbookValidation_ === 'function' && Date.now() - started < CONTACT_AUTOMATION.maxMillis - 15000) processWorkbookValidation_(authorize_(), item.id);
          remaining.shift(); processed++;
          properties.setProperty(CONTACT_AUTOMATION.remaining, JSON.stringify(remaining));
        } catch (error) {
          // One inaccessible or manually changed workbook cannot block all others.
          var code = error && typeof error.registryCode === 'string' ? error.registryCode : 'AUTOMATION_ERROR';
          hadError = true;
          properties.setProperty(CONTACT_AUTOMATION.lastError, code);
          if (code === 'LINK_ACCESS_REQUIRED' || code === 'LINK_SETUP_REQUIRED') throw error;
          remaining.shift(); processed++;
          properties.setProperty(CONTACT_AUTOMATION.remaining, JSON.stringify(remaining));
        }
      }
      properties.setProperty(CONTACT_AUTOMATION.remaining, JSON.stringify(remaining));
      properties.setProperty(CONTACT_AUTOMATION.lastRun, new Date().toISOString());
      if (!hadError) properties.deleteProperty(CONTACT_AUTOMATION.lastError);
      return { processed: processed, pending: remaining.length };
    } finally {
      var latest;
      try { latest = JSON.parse(properties.getProperty(CONTACT_AUTOMATION.lease) || 'null'); } catch (error) { latest = null; }
      if (latest && latest.id === claim.id) properties.deleteProperty(CONTACT_AUTOMATION.lease);
    }
  });
}
