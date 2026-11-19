/** A public shell and two credential-checked transports. The raw key lives only in the shared URL. */
var SHARED_REQUEST_SCOPE_ = null;

function callApp(request) {
  return api_(function () {
    var input = object_(request);
    if (Object.keys(input).some(function (name) { return ['method', 'payload', 'accessKey'].indexOf(name) === -1; })) fail_('INVALID_REQUEST', 'В запросе есть неизвестные поля.');
    return withSharedAccess_(input.accessKey, function () {
      var methods = {
        getAppBootstrap: getAppBootstrap_, getBootstrap: getBootstrap_,
        createBase: createBase_, createFolder: createFolder_, renameItem: renameItem_,
        getSourceBases: getSourceBases_, updateSourceBase: updateSourceBase_,
        previewSourceBaseContacts: previewSourceBaseContacts_,
        stagePreparedBaseLink: stagePreparedBaseLink_, previewPreparedBase: previewPreparedBase_,
        confirmPreparedBase: confirmPreparedBase_, continuePreparedBase: continuePreparedBase_, cancelPreparedBase: cancelPreparedBase_, listPreparedJobs: listPreparedJobs_,
        getGridWorkbook: getGridWorkbook_, getGridRange: getGridRange_, saveGridRange: saveGridRange_,
        appendGridRows: appendGridRows_, appendGridColumns: appendGridColumns_,
        importSourceBaseLink: importSourceBaseLink_, getSourceSheets: getSourceSheets_,
        createSegment: createSegment_, updateSegment: updateSegment_,
        getSegmentsDashboard: getSegmentsDashboard_, getSegmentMailings: getSegmentMailings_
      };
      // Explicit optional handlers keep isolated legacy fixtures usable; the
      // release check requires every feature module in the deployed project.
      var contactMethods = {
        getContactWorkspace: typeof getContactWorkspace_ === 'function' ? getContactWorkspace_ : null,
        syncWorkbookContacts: typeof syncWorkbookContacts_ === 'function' ? syncWorkbookContacts_ : null,
        continueContactSync: typeof continueContactSync_ === 'function' ? continueContactSync_ : null,
        getPromouserSettings: typeof getPromouserSettings_ === 'function' ? getPromouserSettings_ : null,
        configurePromouser: typeof configurePromouser_ === 'function' ? configurePromouser_ : null,
        getPromouserBalance: typeof getPromouserBalance_ === 'function' ? getPromouserBalance_ : null,
        getValidationState: typeof getValidationState_ === 'function' ? getValidationState_ : null,
        advanceWorkbookValidation: typeof advanceWorkbookValidation_ === 'function' ? advanceWorkbookValidation_ : null,
        refreshWorkbookValidation: typeof refreshWorkbookValidation_ === 'function' ? refreshWorkbookValidation_ : null,
        payValidationOrder: typeof payValidationOrder_ === 'function' ? payValidationOrder_ : null,
        previewSegmentRecords: typeof previewSegmentRecords_ === 'function' ? previewSegmentRecords_ : null,
        importSegmentRecords: typeof importSegmentRecords_ === 'function' ? importSegmentRecords_ : null,
        continueSegmentRecords: typeof continueSegmentRecords_ === 'function' ? continueSegmentRecords_ : null,
        syncSegmentPeople: typeof syncSegmentPeople_ === 'function' ? syncSegmentPeople_ : null,
        getContactAutomationState: typeof getContactAutomationState_ === 'function' ? getContactAutomationState_ : null,
        enableContactAutomation: typeof enableContactAutomation_ === 'function' ? enableContactAutomation_ : null,
        disableContactAutomation: typeof disableContactAutomation_ === 'function' ? disableContactAutomation_ : null
      };
      Object.keys(contactMethods).forEach(function (name) { if (typeof contactMethods[name] === 'function') methods[name] = contactMethods[name]; });
      if (typeof input.method !== 'string' || !Object.prototype.hasOwnProperty.call(methods, input.method)) fail_('INVALID_REQUEST', 'Неизвестное действие приложения.');
      return methods[input.method](input.payload);
    });
  });
}

/** HTML Service must receive the live upload form as its only argument. */
function uploadSourceBase(form) {
  return api_(function () {
    var input = object_(form);
    return withSharedAccess_(input.accessKey, function () {
      var clean = Object.create(null);
      Object.keys(input).forEach(function (name) { if (name !== 'accessKey') clean[name] = input[name]; });
      if (clean.flow === 'prepared') { delete clean.flow; return stagePreparedUpload_(clean); }
      return uploadSourceBase_(clean);
    });
  });
}

function withSharedAccess_(accessKey, callback) {
  if (typeof accessKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(accessKey)) fail_('LINK_ACCESS_REQUIRED', sharedAccessMessage_());
  var properties = PropertiesService.getScriptProperties(), keyHash = digest_(accessKey);
  if (!sharedHashEqual_(keyHash, sharedConfiguredHash_(properties))) fail_('LINK_ACCESS_REQUIRED', sharedAccessMessage_());
  var previous = SHARED_REQUEST_SCOPE_;
  SHARED_REQUEST_SCOPE_ = { keyHash: keyHash };
  try { return callback(); } finally { SHARED_REQUEST_SCOPE_ = previous; }
}

function sharedConfiguredHash_(properties) {
  var configured = properties.getProperty('SHARED_ACCESS_KEY_SHA256');
  var hash = configured === null ? REGISTRY_CONFIG.sharedAccessKeyHash : configured;
  if (typeof hash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(hash)) fail_('LINK_SETUP_REQUIRED', 'Настройки закрытой ссылки требуют проверки владельца реестра.');
  return hash;
}

function sharedHashEqual_(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== 43 || right.length !== 43) return false;
  var difference = 0;
  for (var index = 0; index < 43; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function sharedAccessMessage_() {
  return 'Для входа нужна действующая закрытая ссылка. Попросите её у владельца реестра.';
}
