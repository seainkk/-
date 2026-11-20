/** Public identifiers and a verifier only. The random shared-link credential is never in source. */
var REGISTRY_CONFIG = Object.freeze({
  title: 'Реестр баз',
  sharedAccessKeyHash: 'yiKUzWNsQOzwMnF4Fw2_f-9Esxm9ooCyyptJsjYeBG0',
  defaultRootFolderId: '1WKcvDDKqYBo94eXsYc5vKp6OPtOzv6Wh',
  defaultSegmentsFolderId: '1sQ8WrTgdEOPTPYLIwoBwHb6gL_ULT4yu',
  segmentsFolderName: 'Аутричи',
  defaultSourceBasesFolderId: '1deuP0ovOC70PrElQKZjSjuvSMgPF0J7r',
  sourceBasesFolderName: 'Исходные базы',
  defaultSourceBasesStorageId: '1lzbjoPNnrVn5-8GoAhaLZPS_S8J0lfcaoO8Ybxw396M',
  defaultContactCenterId: '1BZj1HUp6eZnzeG-0hESOMNLyg2E0NobRwdxhj_MMmSw',
  defaultContactCenterFolderId: '1Jv7GxuPDN0IOvL3yIYywVZzm7RGFLQwa',
  maxSourceBaseRows: 5000,
  maxSourceFolders: 500,
  segmentAnalysisMaxFiles: 80,
  segmentAnalysisMaxSheets: 240,
  segmentAnalysisMaxCells: 100000,
  segmentAnalysisChunkCells: 10000,
  segmentAnalysisMaxMillis: 20000,
  importMaxBytes: 10 * 1024 * 1024,
  spreadsheetMime: 'application/vnd.google-apps.spreadsheet',
  maxTreeEntries: 500,
  maxTreeDepth: 10,
  maxAncestryNodes: 100,
  creationReceiptLimit: 80
});

var CONTACT_MAILING_STATUS = Object.freeze({
  header: 'Статус рассылки',
  headers: ['Статус рассылки', 'Статус'],
  initial: 'новый',
  values: ['новый', 'в рассылке', 'фильтр']
});

function contactMailingStatusFromHistory_(history) {
  var statuses = (Array.isArray(history) ? history : String(history || '').split(';')).map(function (value) {
    var status = String(value || '').trim().toLowerCase();
    if (status === 'в рассылке' || status === 'запущен') return 'в рассылке';
    if (status === 'фильтр') return 'фильтр';
    return '';
  }).filter(Boolean);
  return statuses.length && statuses.every(function (value) { return value === statuses[0]; }) ? statuses[0] : CONTACT_MAILING_STATUS.initial;
}

function contactMailingStatusDropdown_(range, preserve) {
  if (typeof SpreadsheetApp.newDataValidation !== 'function') return;
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(CONTACT_MAILING_STATUS.values, true).setAllowInvalid(false).build();
  if (!preserve) { range.setDataValidation(rule); return; }
  var rules = range.getDataValidations(), values = range.getDisplayValues(), changed = false;
  rules.forEach(function (entry, index) {
    var value = values[index][0];
    if (!entry[0] && (!value || CONTACT_MAILING_STATUS.values.indexOf(value) >= 0)) {
      entry[0] = rule; changed = true;
    }
  });
  if (changed) range.setDataValidations(rules);
}

/** Editor-only setup. Email lists from the previous mode are deliberately untouched. */
function setupRegistry_() {
  var properties = PropertiesService.getScriptProperties();
  sharedConfiguredHash_(properties);
  var folderId = properties.getProperty('ROOT_FOLDER_ID') || REGISTRY_CONFIG.defaultRootFolderId;
  var folder = folderById_(folderId);
  if (folder.isTrashed()) fail_('NOT_FOUND', 'Папка реестра находится в корзине.');
  properties.setProperty('ROOT_FOLDER_ID', folderId);
  return { folderId: folderId, folderName: folder.getName(), accessMode: 'link' };
}
