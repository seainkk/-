/** Public identifiers and a verifier only. The random shared-link credential is never in source. */
var REGISTRY_CONFIG = Object.freeze({
  title: 'Центр мультиканального аутрича',
  sharedAccessKeyHash: 'yiKUzWNsQOzwMnF4Fw2_f-9Esxm9ooCyyptJsjYeBG0',
  defaultRootFolderId: '1WKcvDDKqYBo94eXsYc5vKp6OPtOzv6Wh',
  defaultSegmentsFolderId: '1sQ8WrTgdEOPTPYLIwoBwHb6gL_ULT4yu',
  companyWorkbookTemplateId: '1KxI1gZCsT9g5LC3skxyxaINvbcY4FaLa_2C28EJlS8I',
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
  initial: 'Новый контакт',
  values: ['Новый контакт', 'в рассылке', 'фильтр']
});

var COMPANY_EMAIL_STATUS = Object.freeze({
  values: ['Новый контакт', 'Готов', 'Рассылка', 'Фильтр', 'Невалид']
});

var COMPANY_TELEGRAM_STATUS = Object.freeze({
  values: ['Новый контакт', 'Готов', 'Записная книжка', 'Не активен > 30 дней', 'Ручная проверка', 'Невалид']
});

/** DEF 940 belongs to Abkhazia within the shared +7 numbering plan. */
function companyTelegramAbkhazMobile_(compact) {
  return /^(?:\+?7|8)?940\d{7}$/.test(compact);
}

function companyTelegramRussianMobile_(value) {
  var compact = String(value == null ? '' : value).trim().replace(/[()\s.-]/g, '');
  if (!/^(?:\+?7|8)?9\d{9}$/.test(compact) || companyTelegramAbkhazMobile_(compact)) return '';
  return '+7' + compact.slice(-10);
}

function companyTelegramWorkflowHeaders_(headers) {
  return CONTACT_MAILING_STATUS.headers.some(function (name) { return headers.indexOf(name) >= 0; }) &&
    ['Контакт', 'Тип контакта', 'ID компании', 'Валидация', 'ID_TG', 'Nickname_TG', 'Active_days_ago'].every(function (name) { return headers.indexOf(name) >= 0; });
}

function companyTelegramWorkflowStatus_(value) {
  var original = String(value == null ? '' : value).trim(), lower = original.toLowerCase();
  if (!lower || contactMailingStatusIsNew_(lower)) return CONTACT_MAILING_STATUS.initial;
  return COMPANY_TELEGRAM_STATUS.values.filter(function (item) { return item.toLowerCase() === lower; })[0] || original;
}

function companyTelegramStatusDropdown_(range, preserve, mask) {
  return contactMailingStatusDropdown_(range, preserve, mask, 'telegram');
}

function companyEmailWorkflowHeaders_(headers) {
  return ['ID компании', 'Почт на компанию', 'Email', 'Статус', 'Результат валидации'].every(function (name) { return headers.indexOf(name) >= 0; });
}

function companyEmailWorkflowStatus_(value) {
  var original = String(value == null ? '' : value).trim(), lower = original.toLowerCase();
  if (!lower || contactMailingStatusIsNew_(lower)) return CONTACT_MAILING_STATUS.initial;
  if (lower === 'в рассылке' || lower === 'запущен') return 'Рассылка';
  return COMPANY_EMAIL_STATUS.values.filter(function (item) { return item.toLowerCase() === lower; })[0] || original;
}

/** Visible working fields; technical ownership fields are retained after these. */
var WORKING_CONTACT_COLUMNS = Object.freeze({
  email: ['Статус рассылки', 'Комментарий', 'Почт на компанию', 'Исходные строки', 'Компания / ЛПР', 'Email', 'Валидация', 'Провайдер', 'Сайты', 'ID компании'],
  phone: ['Статус рассылки', 'Исходные строки', 'Компания / ЛПР', 'Телефон', 'ID_TG', 'Nickname_TG', 'Active_days_ago', 'Сайты', 'ID компании']
});

function contactMailingStatusIsNew_(value) {
  var status = String(value || '').trim().toLowerCase();
  return status === 'новый контакт' || status === 'новый';
}

/** Local subscriber numbers have no dialling code. Keep their leading zeroes. */
function contactLocalPhone_(value) {
  var text = String(value == null ? '' : value).trim();
  if (!/^(?:\d{5,7}|\d{1,3}[- ]\d{2}[- ]\d{2})$/.test(text)) return '';
  var digits = text.replace(/[- ]/g, '');
  return /^0+$/.test(digits) ? '' : digits;
}

function workingSelectionStatus_(value) {
  var status = String(value || '').trim().toLowerCase();
  if (!status || contactMailingStatusIsNew_(status)) return CONTACT_MAILING_STATUS.initial;
  if (status === 'рассылка' || status === 'в рассылке' || status === 'запущен') return 'в рассылке';
  return 'фильтр';
}

function contactMailingStatusFromHistory_(history) {
  var statuses = (Array.isArray(history) ? history : String(history || '').split(';')).map(function (value) {
    var status = String(value || '').trim().toLowerCase();
    if (/^(?:рассылка|в рассылке(?: нса)?|запущен[аоы]?|отправлен[аоы]?|sent|in campaign|replied|ответил[аи]?)$/.test(status)) return 'в рассылке';
    if (/фильтр|нецелев|не\s*совпал|не\s*актуал|не\s*подтвержден|не\s+отправл(?:яем|ять)|дубль|исключ|невалид|отпис|блокиров|срок\s*>\s*30/.test(status) || status === 'в плане запис книжка') return 'фильтр';
    return '';
  }).filter(Boolean);
  return statuses.indexOf('фильтр') >= 0 ? 'фильтр' : statuses.indexOf('в рассылке') >= 0 ? 'в рассылке' : CONTACT_MAILING_STATUS.initial;
}

function contactMailingStatusDropdown_(range, preserve, mask, companyEmail) {
  if (typeof SpreadsheetApp.newDataValidation !== 'function') return;
  var allowed = companyEmail === 'telegram' ? COMPANY_TELEGRAM_STATUS.values : companyEmail ? COMPANY_EMAIL_STATUS.values : CONTACT_MAILING_STATUS.values;
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(allowed, true).setAllowInvalid(false).build();
  if (!preserve) { range.setDataValidation(rule); return; }
  var rules = range.getDataValidations(), values = range.getDisplayValues(), formulas = range.getFormulas(), changed = false;
  rules.forEach(function (entry, index) {
    var value = values[index][0];
    if (mask && !mask[index][0] || formulas[index][0] || value && allowed.indexOf(value) < 0) return;
    var old = entry[0];
    var legacy = old && typeof old.getCriteriaType === 'function' &&
      old.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST && !old.getAllowInvalid() &&
      !old.getHelpText() && (JSON.stringify(old.getCriteriaValues()[0]) === JSON.stringify(['новый','в рассылке','фильтр']) ||
        companyEmail && JSON.stringify(old.getCriteriaValues()[0]) === JSON.stringify(CONTACT_MAILING_STATUS.values)) && old.getCriteriaValues()[1] !== false;
    if (!old || legacy) {
      entry[0] = rule; changed = true;
    }
  });
  if (changed) range.setDataValidations(rules);
  return changed;
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
