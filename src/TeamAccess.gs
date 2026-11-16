/** Team access is private configuration; no addresses belong in source control. */
var TEAM_ACCESS_CONFIG = Object.freeze({ maxMembers: 100, maxPermissionPages: 10, permissionFields: 'id,type,role,emailAddress,deleted' });

function getTeamAccess() {
  return api_(function () {
    var context = teamAdmin_(), state = teamState_(context), root = registryRoot_(context);
    return { members: state.allowed.slice().sort().map(function (email) { return { email: email, role: state.admins.indexOf(email) === -1 ? 'member' : 'admin' }; }), currentUser: { email: context.email, role: 'admin' }, registry: { id: root.getId(), name: root.getName() }, canManage: true };
  });
}

function addTeamMember(request) {
  return api_(function () {
    teamAdmin_();
    var input = object_(request);
    if (Object.keys(input).some(function (key) { return ['email', 'role'].indexOf(key) === -1; })) fail_('INVALID_REQUEST', 'В запросе доступа есть неизвестные поля.');
    var email = teamEmail_(input.email);
    if (input.role !== 'member' && input.role !== 'admin') fail_('INVALID_ROLE', 'Выберите участника или администратора.');
    return locked_(function () {
      var context = teamAdmin_(), state = teamState_(context), alreadyAllowed = state.allowed.indexOf(email) !== -1;
      if ((!alreadyAllowed && state.allowed.length >= TEAM_ACCESS_CONFIG.maxMembers) || (input.role === 'admin' && state.admins.indexOf(email) === -1 && state.admins.length >= TEAM_ACCESS_CONFIG.maxMembers)) fail_('TEAM_LIMIT', 'В приложении можно настроить до 100 участников и 100 адресов администраторов.');
      if (JSON.stringify(state.allowed.concat(alreadyAllowed ? [] : [email])).length > 8000 || JSON.stringify(state.admins.concat(input.role === 'admin' && state.admins.indexOf(email) === -1 ? [email] : [])).length > 8000) fail_('TEAM_LIMIT', 'В настройках доступа недостаточно места для ещё одного адреса. Обратитесь к администратору.');
      var root = registryRoot_(context);
      teamService_();
      var metadata = teamDrive_(function () { return Drive.Files.get(context.rootId, { fields: 'id,mimeType,trashed,capabilities(canEdit,canShare)', supportsAllDrives: true }); });
      if (!metadata || metadata.id !== root.getId() || metadata.mimeType !== 'application/vnd.google-apps.folder' || metadata.trashed) fail_('TEAM_ROOT_INVALID', 'Папка реестра недоступна. Проверьте её привязку.');
      if (!metadata.capabilities || metadata.capabilities.canEdit !== true) fail_('TEAM_SHARING_REQUIRED', 'Для добавления участника нужны права редактировать папку реестра. Выполните действие под аккаунтом владельца папки.');
      var key = 'TEAM_ACCESS_' + digest_(context.rootId + '|' + email).slice(0, 32), pending = teamPending_(context, key, email);
      var permission = teamFindPermission_(context.rootId, email);
      if (!permission && pending && pending.state === 'pending') fail_('TEAM_ACCESS_PARTIAL', teamPartialMessage_());
      if (!permission || !teamWritableRole_(permission.role)) {
        if (metadata.capabilities.canShare !== true) fail_('TEAM_SHARING_REQUIRED', 'У текущего аккаунта нет права предоставлять доступ к папке реестра. Попросите владельца выдать нужному адресу право редактора на папку и повторите добавление.');
        teamSavePending_(context, key, email, 'pending');
        try {
          permission = permission ? Drive.Permissions.update({ role: 'writer' }, context.rootId, permission.id, { supportsAllDrives: true, fields: TEAM_ACCESS_CONFIG.permissionFields }) : Drive.Permissions.create({ type: 'user', role: 'writer', emailAddress: email }, context.rootId, { supportsAllDrives: true, sendNotificationEmail: false, fields: TEAM_ACCESS_CONFIG.permissionFields });
        } catch (error) {
          var recovered;
          try { recovered = teamFindPermission_(context.rootId, email); } catch (ignored) { /* The pending marker prevents another blind creation. */ }
          if (recovered && teamWritableRole_(recovered.role)) permission = recovered;
          else {
            if (teamDefiniteRejection_(error)) {
              try { context.properties.deleteProperty(key); } catch (ignored) { /* Retry can still recover an existing grant. */ }
              fail_('TEAM_DRIVE_ACCESS_REQUIRED', 'Google Диск отклонил выдачу доступа. Проверьте адрес Google-аккаунта и право делиться папкой реестра, затем повторите действие.');
            }
            fail_('TEAM_ACCESS_PARTIAL', teamPartialMessage_());
          }
        }
      }
      var verified;
      try {
        if (!permission || typeof permission.id !== 'string') throw new Error('Missing permission');
        verified = Drive.Permissions.get(context.rootId, permission.id, { supportsAllDrives: true, fields: TEAM_ACCESS_CONFIG.permissionFields });
        if (!verified || verified.type !== 'user' || verified.deleted || teamEmail_(verified.emailAddress) !== email || !teamWritableRole_(verified.role)) throw new Error('Unconfirmed permission');
      } catch (error) { fail_('TEAM_ACCESS_PARTIAL', teamPartialMessage_()); }
      teamSavePending_(context, key, email, 'verified');
      // The Script lock serializes app changes. Re-read configuration after the
      // network request so a manual configuration change is never overwritten.
      var current = teamAdmin_();
      if (current.rootId !== context.rootId) fail_('TEAM_ACCESS_PARTIAL', 'Привязка папки изменилась во время выдачи доступа. Проверьте настройки и повторите действие.');
      var latest = teamState_(current), allowed = latest.allowed.slice(), admins = latest.admins.slice();
      if (allowed.indexOf(email) === -1) {
        if (allowed.length >= TEAM_ACCESS_CONFIG.maxMembers) fail_('TEAM_ACCESS_PARTIAL', 'Доступ к папке подтверждён, но список участников заполнен. Освободите место в настройках и повторите действие.');
        allowed.push(email);
      }
      if (input.role === 'admin' && admins.indexOf(email) === -1) admins.push(email);
      if (admins.length > TEAM_ACCESS_CONFIG.maxMembers || JSON.stringify(allowed).length > 8000 || JSON.stringify(admins).length > 8000) fail_('TEAM_ACCESS_PARTIAL', 'Доступ к папке подтверждён, но настройки доступа заполнены. Обратитесь к администратору и повторите добавление того же адреса.');
      try {
        if (JSON.stringify(allowed) !== JSON.stringify(latest.allowed) || JSON.stringify(admins) !== JSON.stringify(latest.admins)) current.properties.setProperties({ ALLOWED_EMAILS: JSON.stringify(allowed), ADMIN_EMAILS: JSON.stringify(admins) });
        var saved = teamState_(current);
        if (saved.allowed.indexOf(email) === -1 || (input.role === 'admin' && saved.admins.indexOf(email) === -1)) throw new Error('Unconfirmed configuration');
      } catch (error) { fail_('TEAM_ACCESS_PARTIAL', 'Доступ к папке Google Диска подтверждён, но сохранение доступа к приложению не подтверждено. Повторите добавление того же адреса: второй доступ к папке создаваться не будет.'); }
      try { current.properties.deleteProperty(key); } catch (ignored) { console.warn('Team access completed; recovery marker remains.'); }
      return { email: email, role: saved.admins.indexOf(email) === -1 ? 'member' : 'admin', driveAccess: verified.role, alreadyAllowed: alreadyAllowed };
    });
  });
}

function teamAdmin_() {
  var context = authorize_();
  if (!context.isAdmin) fail_('ADMIN_REQUIRED', 'Управлять доступом команды может только администратор приложения.');
  return context;
}

function teamEmail_(value) {
  var email = normalizeEmail_(value);
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(email)) fail_('INVALID_EMAIL', 'Введите полный адрес Google-аккаунта, например name@gmail.com.');
  return email;
}

function teamList_(raw) {
  if (typeof raw !== 'string' || raw.length > 8000) fail_('TEAM_CONFIG_INVALID', 'Список доступа требует проверки администратора.');
  var text = raw.trim(), values;
  if (text.charAt(0) === '[') {
    try { values = JSON.parse(text); } catch (error) { fail_('TEAM_CONFIG_INVALID', 'Список доступа имеет повреждённый формат. Настройки не изменены.'); }
    if (!Array.isArray(values)) fail_('TEAM_CONFIG_INVALID', 'Список доступа имеет повреждённый формат. Настройки не изменены.');
  } else values = text ? text.split(/[\s,;]+/) : [];
  var result = [];
  values.forEach(function (value) {
    var email;
    try { email = teamEmail_(value); } catch (error) { fail_('TEAM_CONFIG_INVALID', 'В списке доступа есть некорректный адрес. Настройки не изменены.'); }
    if (result.indexOf(email) !== -1) fail_('TEAM_CONFIG_INVALID', 'В списке доступа есть повторяющиеся адреса. Настройки не изменены.');
    result.push(email);
  });
  if (result.length > TEAM_ACCESS_CONFIG.maxMembers) fail_('TEAM_LIMIT', 'В списке доступа больше 100 адресов. Обратитесь к администратору.');
  return result;
}

function teamState_(context) {
  // Historical admins outside ALLOWED_EMAILS stay disabled; adding somebody
  // must never implicitly authorize those old addresses again.
  return { allowed: teamList_(context.properties.getProperty('ALLOWED_EMAILS') || ''), admins: teamList_(context.properties.getProperty('ADMIN_EMAILS') || '') };
}

function teamService_() {
  if (typeof Drive === 'undefined' || !Drive.Files || typeof Drive.Files.get !== 'function' || !Drive.Permissions || ['list', 'get', 'create', 'update'].some(function (name) { return typeof Drive.Permissions[name] !== 'function'; })) fail_('DRIVE_SETUP_REQUIRED', 'Для управления доступом нужен сервис Google Drive API v3 в Apps Script. Обратитесь к администратору.');
}

function teamWritableRole_(role) { return ['owner', 'organizer', 'fileOrganizer', 'writer'].indexOf(role) !== -1; }

function teamFindPermission_(rootId, email) {
  var token, found = null, seenTokens = {}, count = 0;
  do {
    if (++count > TEAM_ACCESS_CONFIG.maxPermissionPages || (token && seenTokens[token])) fail_('TEAM_PERMISSIONS_INVALID', 'Не удалось полностью проверить доступ к папке. Изменения остановлены.');
    if (token) seenTokens[token] = true;
    var options = { pageSize: 100, supportsAllDrives: true, fields: 'permissions(' + TEAM_ACCESS_CONFIG.permissionFields + '),nextPageToken' };
    if (token) options.pageToken = token;
    var result = teamDrive_(function () { return Drive.Permissions.list(rootId, options); });
    if (!result || !Array.isArray(result.permissions) || (result.nextPageToken !== undefined && typeof result.nextPageToken !== 'string')) fail_('TEAM_PERMISSIONS_INVALID', 'Google вернул неполные сведения о доступе. Изменения остановлены.');
    result.permissions.forEach(function (permission) {
      if (!permission || permission.deleted || permission.type !== 'user') return;
      if (normalizeEmail_(permission.emailAddress) !== email) return;
      if (found || typeof permission.id !== 'string' || !permission.id || ['owner', 'organizer', 'fileOrganizer', 'writer', 'commenter', 'reader'].indexOf(permission.role) === -1) fail_('TEAM_PERMISSIONS_INVALID', 'Для адреса найдены неоднозначные сведения о доступе. Изменения остановлены.');
      found = permission;
    });
    token = result.nextPageToken;
  } while (token);
  return found;
}

function teamPending_(context, key, email) {
  var raw = context.properties.getProperty(key);
  if (!raw) return null;
  var value;
  try { value = JSON.parse(raw); } catch (error) { fail_('TEAM_ACCESS_PARTIAL', 'Журнал выдачи доступа требует проверки администратора.'); }
  if (!value || value.version !== 1 || value.rootId !== context.rootId || value.email !== email || ['pending', 'verified'].indexOf(value.state) === -1) fail_('TEAM_ACCESS_PARTIAL', 'Журнал выдачи доступа требует проверки администратора.');
  return value;
}

function teamSavePending_(context, key, email, state) {
  try { context.properties.setProperty(key, JSON.stringify({ version: 1, rootId: context.rootId, email: email, state: state })); }
  catch (error) { fail_('TEAM_ACCESS_PARTIAL', 'Не удалось сохранить журнал доступа. Продолжение операции остановлено; проверьте текущие права и повторите добавление того же адреса.'); }
}

function teamDrive_(callback) {
  try { return callback(); }
  catch (error) {
    if (error && error.registryCode) throw error;
    fail_('TEAM_DRIVE_ACCESS_REQUIRED', 'Не удалось проверить права Google Диска. Откройте приложение под аккаунтом владельца папки реестра и повторите действие.');
  }
}

function teamDefiniteRejection_(error) {
  var details = error && error.details;
  if (typeof details === 'string') { try { details = JSON.parse(details); } catch (ignored) { details = null; } }
  if (details && details.error) details = details.error;
  var status = Number(error && (error.status || error.code) || details && details.code);
  if (status >= 400 && status < 500) return true;
  var rejection = String(error && error.message || '').match(/^(?:GoogleJsonResponseException:\s*)?API call to drive\.permissions\.(?:create|update) failed with error:\s*([\s\S]*)$/i);
  return !!(rejection && /^(?:The user does not have sufficient permissions|Insufficient Permission|Insufficient permissions|You do not have permission|Forbidden|Bad Request|Invalid Value|Invalid argument|Rate Limit Exceeded|User Rate Limit Exceeded)/i.test(rejection[1]));
}

function teamPartialMessage_() {
  return 'Google не подтвердил выдачу доступа к папке. Повторное создание доступа заблокировано до проверки результата. Проверьте права указанного адреса на папку реестра; если доступ уже выдан, повторите добавление того же адреса. Если доступа нет, владелец может предоставить право редактора на папку вручную и повторить добавление.';
}
