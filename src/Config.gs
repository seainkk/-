/** Public identifiers only. Credentials and team addresses belong in Script Properties. */
var REGISTRY_CONFIG = Object.freeze({
  title: 'Реестр баз',
  defaultRootFolderId: '1WKcvDDKqYBo94eXsYc5vKp6OPtOzv6Wh',
  defaultSegmentsFolderId: '1sQ8WrTgdEOPTPYLIwoBwHb6gL_ULT4yu',
  segmentsFolderName: 'Аутричи',
  defaultSourceBasesFolderId: '1deuP0ovOC70PrElQKZjSjuvSMgPF0J7r',
  sourceBasesFolderName: 'Исходные базы',
  defaultSourceBasesStorageId: '1lzbjoPNnrVn5-8GoAhaLZPS_S8J0lfcaoO8Ybxw396M',
  maxSourceBaseRows: 5000,
  maxSourceFolders: 500,
  importMaxBytes: 10 * 1024 * 1024,
  spreadsheetMime: 'application/vnd.google-apps.spreadsheet',
  maxTreeEntries: 500,
  maxTreeDepth: 10,
  maxAncestryNodes: 100,
  creationReceiptLimit: 80
});

/**
 * Run ONCE from the Apps Script editor before deploying. The trailing underscore
 * makes this function unavailable to google.script.run callers.
 * Add team members to ALLOWED_EMAILS in Project Settings > Script Properties.
 */
function setupRegistry_() {
  var owner = normalizeEmail_(Session.getEffectiveUser().getEmail());
  if (!owner) fail_('AUTH_REQUIRED', 'Не удалось определить аккаунт владельца. Запустите настройку из редактора Apps Script.');
  var properties = PropertiesService.getScriptProperties();
  var folderId = properties.getProperty('ROOT_FOLDER_ID') || REGISTRY_CONFIG.defaultRootFolderId;
  var folder = folderById_(folderId);
  if (folder.isTrashed()) fail_('NOT_FOUND', 'Папка реестра находится в корзине.');
  properties.setProperty('ROOT_FOLDER_ID', folderId);
  if (!properties.getProperty('ALLOWED_EMAILS')) properties.setProperty('ALLOWED_EMAILS', owner);
  if (!properties.getProperty('ADMIN_EMAILS')) properties.setProperty('ADMIN_EMAILS', owner);
  return { folderId: folderId, folderName: folder.getName(), owner: owner };
}
