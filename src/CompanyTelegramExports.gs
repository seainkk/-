/** Both Numshield imports use the supplied UTF-8 BOM, quoted CSV, CRLF template. */
function exportCompanyTelegramCsv_(request) {
  return api_(function () {
    var input = segmentInput_(request,['id','sheetId','mode']), fileId = id_(input.id), sheetId = gridSheetId_(input.sheetId);
    if (input.mode !== 'ready' && input.mode !== 'addressBook') fail_('INVALID_REQUEST','Выберите тип выгрузки Telegram.');
    var context = authorize_(), project = registryProjectId_(), workspace = getContactWorkspace_({id:fileId});
    if (!workspace.enrolled || workspace.role !== 'segment-companies' || workspace.companyTelegramSchema !== 2 || !workspace.segmentId ||
        !workspace.targets || workspace.targets.phoneSheetId !== sheetId)
      fail_('TELEGRAM_TARGET','Откройте вкладку «Телеграм» рабочей таблицы компаний.');
    if (workspace.job && !workspace.job.error) fail_('CONTACT_SYNC_JOB_ACTIVE','Дождитесь завершения распределения контактов.');
    var segmentId = id_(workspace.segmentId);
    function target() {
      var fresh = authorize_();
      if (fresh.rootId !== context.rootId || project !== registryProjectId_() || registrySegmentProject_(fresh,segmentId) !== project)
        fail_('OUTSIDE_PROJECT','Таблица относится к другому проекту.');
      var scope = segmentCardFiles_(fresh,segmentId), file = scope.files.companies;
      var tags = file && file.metadata.appProperties || {};
      if (!file || file.id !== fileId || !file.version || tags.registryContactRoot !== fresh.rootId || tags.registryCompanyTelegramSchema !== '2' ||
          String(tags.registryContactPhoneSheetId) !== String(sheetId))
        fail_('TELEGRAM_TARGET','Назначение рабочего листа изменилось.');
      return file;
    }
    var file = target(), book = SpreadsheetApp.openById(fileId), sheet = gridSheet_(book,sheetId);
    var result = companyTelegramExportRows_(sheet,input.mode);
    var dto = {state:result.rows.length ? 'ready':'empty',mode:input.mode,count:result.rows.length,duplicates:result.duplicates,
      excluded:result.excluded,readyContacts:result.readyContacts,skippedNoPhone:result.skippedNoPhone,
      skippedNoUsername:result.skippedNoUsername,withoutPhone:result.withoutPhone,
      message:result.rows.length ? 'Строк в CSV: ' + result.rows.length : 'Нет подходящих контактов для этой выгрузки.'};
    if (result.rows.length) {
      var tags = file.metadata.appProperties || {}, master = tags.registrySegmentMasterSheetId === undefined ?
        book.getSheetByName('Компании') : gridSheet_(book,gridSheetId_(Number(tags.registrySegmentMasterSheetId)));
      dto.csv = companyTelegramExportCsv_(result.rows,master);
      dto.filename = input.mode === 'ready' ? 'numshield-telegram-ready.csv' : 'numshield-telegram-address-book.csv';
    }
    if (target().version !== file.version) fail_('SOURCE_CHANGED','Таблица изменилась во время подготовки файла. Повторите выгрузку.');
    return dto;
  });
}

function companyTelegramContactCell_(value,type) {
  var contact = contactSyncTelegramContact_(String(value || '').trim());
  return contact && contact.type === String(type || '').trim().toLowerCase() ? contact : null;
}

function companyTelegramCsvUsername_(value) {
  var raw = String(value || '').trim();
  var contact = contactSyncTelegramContact_(raw) || contactSyncTelegramContact_('@' + raw);
  return contact && contact.type === 'юзернейм' ? contact.value.slice(1) : '';
}

function companyTelegramExportRows_(sheet,mode) {
  var width = sheet.getLastColumn(), height = sheet.getLastRow();
  if (!width || width > CONTACT_SYNC.maxHeaderColumns || height > CONTACT_SYNC.maxTargetRows) fail_('TELEGRAM_SCHEMA','Проверьте размер рабочего листа «Телеграм».');
  var headers = sheet.getRange(1,1,1,width).getDisplayValues()[0], map = pvHeaderMap_(headers);
  if (!companyTelegramWorkflowHeaders_(headers)) fail_('TELEGRAM_SCHEMA','На листе отсутствуют рабочие колонки Telegram.');
  var wanted = mode === 'ready' ? 'Готов':'Записная книжка', groups = new Map(), invalid = 0;
  var chunk = Math.max(1,Math.min(2000,Math.floor(80000/width)));
  var index = {};
  ['Контакт','Тип контакта','Статус','ID компании','ID_TG','Nickname_TG','Имя','Проверить принадлежность'].forEach(function (name) {
    index[name] = map[pvHeader_(name)];
  });
  for (var start = 2; start <= height; start += chunk) {
    var values = sheet.getRange(start,1,Math.min(chunk,height-start+1),width).getDisplayValues();
    values.forEach(function (line) {
      function cell(name) {return String(line[index[name]] || '').trim();}
      var status = companyTelegramWorkflowStatus_(cell('Статус')), contact = companyTelegramContactCell_(cell('Контакт'),cell('Тип контакта'));
      if (!contact) { if (status === wanted) invalid++; return; }
      var group = groups.get(contact.key);
      if (!group) {
        group = {contact:contact,refs:0,ids:new Set(),names:new Set(),tgIds:new Set(),nicks:new Set()};
        groups.set(contact.key,group);
      }
      var review = cell('Проверить принадлежность');
      if (['Невалид','Не активен > 30 дней'].indexOf(status) >= 0 || pvExcludedStatus_(status,true) ||
          review && !/^(?:нет|no|false|0)$/i.test(review)) group.blocked = true;
      if (status === 'Готов') group.ready = true;
      if (status === 'Записная книжка') group.addressBook = true;
      if (status !== wanted) return;
      group.refs++;
      if (cell('ID компании')) group.ids.add(cell('ID компании'));
      if (cell('Имя')) group.names.add(cell('Имя'));
      if (mode !== 'ready') return;
      if (/^[1-9]\d*$/.test(cell('ID_TG'))) group.tgIds.add(cell('ID_TG'));
      var nick = companyTelegramCsvUsername_(cell('Nickname_TG'));
      if (nick) group.nicks.add(nick);
      if (contact.type === 'юзернейм') group.nicks.add(contact.value.slice(1).toLowerCase());
    });
  }
  var rows = [], recipients = new Map(), excluded = invalid, duplicates = 0, skippedNoPhone = 0, skippedNoUsername = 0, withoutPhone = 0, readyContacts = 0;
  function unique(set) {return set.size === 1 ? set.values().next().value : '';}
  groups.forEach(function (g) {
    if (!g.refs) return;
    duplicates += g.refs-1;
    if (g.blocked || g.ready && g.addressBook || g.tgIds.size > 1 || g.nicks.size > 1) {excluded++;return;}
    readyContacts++;
    var phone = g.contact.type === 'телефон' && /^\+79\d{9}$/.test(g.contact.value) ? g.contact.value:'';
    if (mode === 'addressBook') {
      if (phone) rows.push({phone:phone,companyId:unique(g.ids)});
      else skippedNoPhone++;
      return;
    }
    var username = unique(g.nicks);
    if (!username) {skippedNoUsername++;return;}
    var recipient = recipients.get(username);
    if (!recipient) {
      recipient = {phones:new Set(),ids:new Set(),names:new Set(),tgIds:new Set()};
      recipients.set(username,recipient);
    } else duplicates++;
    if (phone) recipient.phones.add(phone);
    ['ids','names','tgIds'].forEach(function (key) {g[key].forEach(function (val) {recipient[key].add(val);});});
  });
  recipients.forEach(function (r,username) {
    if (r.tgIds.size > 1) {excluded++;return;}
    var phone = unique(r.phones);
    if (!phone) withoutPhone++;
    rows.push({username:username,phone:phone,name:unique(r.names),companyId:unique(r.ids),telegramId:unique(r.tgIds)});
  });
  rows.sort(function (a,b) {return (a.username || a.phone).localeCompare(b.username || b.phone);});
  return {rows:rows,duplicates:duplicates,excluded:excluded,readyContacts:readyContacts,
    skippedNoPhone:skippedNoPhone,skippedNoUsername:skippedNoUsername,withoutPhone:withoutPhone};
}

function companyTelegramExportCsv_(rows,master) {
  var fields = ['Username','Telegram ID','Имя','Телефон','Компания','Сайт','ИНН'];
  function quoted(value,phone) {
    var s = String(value || '');
    if (!(phone && /^\+79\d{9}$/.test(s)) && /^(?:[\s\uFEFF]*[=+@-]|[\t\r\n])/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g,'""') + '"';
  }
  var companies = new Map(), wanted = new Set(rows.map(function (r) { return r.companyId; }).filter(Boolean));
  if (master && wanted.size && master.getLastRow() > 1) {
    var width = master.getLastColumn(), height = master.getLastRow();
    if (width > CONTACT_SYNC.maxHeaderColumns || height > CONTACT_SYNC.maxTargetRows) fail_('TELEGRAM_SCHEMA','Лист компаний превышает допустимый размер.');
    var map = pvHeaderMap_(master.getRange(1,1,1,width).getDisplayValues()[0]);
    var ids = pvFindHeader_(map,['ID компании']), name = pvFindHeader_(map,['Компания','Название компании']), site = pvFindHeader_(map,['Сайт']), inn = pvFindHeader_(map,['ИНН']);
    var step = Math.max(1,Math.min(2000,Math.floor(80000/width)));
    for (var start = 2; ids !== undefined && start <= height; start += step) {
      master.getRange(start,1,Math.min(step,height-start+1),width).getDisplayValues().forEach(function (line) {
        var id = String(line[ids] || '').trim();
        if (!wanted.has(id)) return;
        var details = [line[name] || '',line[site] || '',line[inn] || ''];
        if (!companies.has(id)) companies.set(id,details);
        else if (JSON.stringify(companies.get(id)) !== JSON.stringify(details)) companies.set(id,null);
      });
    }
  }
  var lines = [fields.map(function (v) {return quoted(v);}).join(',')];
  rows.forEach(function (r) {
    lines.push([r.username,r.telegramId,r.name,r.phone].concat(companies.get(r.companyId) || ['','','']).map(function (value,i) {return quoted(value,i===3);}).join(','));
  });
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
