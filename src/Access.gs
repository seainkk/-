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
        importSourceBaseLink: importSourceBaseLink_, getSourceSheets: getSourceSheets_,
        createSegment: createSegment_, updateSegment: updateSegment_,
        getSegmentsDashboard: getSegmentsDashboard_, getSegmentMailings: getSegmentMailings_
      };
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
