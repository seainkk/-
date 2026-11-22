/** Import into the managed Email GID only. A separate fact column set belongs to each campaign. */
var COLDY_RECIPIENT_COLUMNS = Object.freeze({
  status: 'Статус контакта', campaign: 'Состояние рассылки', sent: 'Автописьма отправлены',
  replied: 'Был ответ', bounced: 'Был баунс', stopped: 'Остановка отправок'
});

function coldyRecipientSheetTarget_(context, binding, kind) {
  if (kind !== 'companies' && kind !== 'lpr') fail_('COLDY_TARGET_CHANGED', 'Выберите таблицу компаний или ЛПР.');
  var targets = segmentRecordsTargets_(context, binding.segmentId, false), fileId = targets.tables[kind];
  var metadata = contactSyncMetadata_(fileId), state = contactSyncReadState_(context, metadata, true);
  if (!state || state.role !== 'segment-' + kind || state.segmentId !== binding.segmentId ||
      !state.targets || !Number.isSafeInteger(state.targets.emailSheetId)) {
    fail_('COLDY_TARGETS_REQUIRED', 'Не удалось подтвердить рабочую вкладку Email выбранной таблицы сегмента.');
  }
  var target = { fileId: fileId, sheetId: state.targets.emailSheetId };
  coldyRecipientSheetVersion_(context, binding, kind, target, metadata);
  return target;
}

// The immutable canonical assignment was resolved when this job was staged.
// Each write revalidates its real parent, master and contact GIDs, and current Drive version.
function coldyRecipientSheetVersion_(context, binding, kind, target, metadata) {
  var tags = metadata.appProperties || {};
  if (metadata.id !== target.fileId || metadata.trashed || metadata.mimeType !== REGISTRY_CONFIG.spreadsheetMime ||
      !metadata.capabilities || !metadata.capabilities.canEdit || !metadata.parents || metadata.parents.length !== 1 ||
      metadata.parents[0] !== binding.segmentId || tags.registrySegmentMasterRoot !== context.rootId ||
      tags.registrySegmentMasterSegment !== binding.segmentId || tags.registrySegmentMasterKind !== kind ||
      tags.registryContactRoot !== context.rootId || tags.registryContactEmailSheetId !== String(target.sheetId)) {
    fail_('COLDY_TARGET_CHANGED', 'Изменилась рабочая таблица или её управляемая вкладка Email.');
  }
  var version = contactSyncVersion_(metadata);
  if (!version) fail_('CONFLICT', 'Google не подтвердил версию таблицы для обновления.');
  return version;
}

/** Stable column notes survive campaign renaming and manual spreadsheet column reordering. */
function coldyRecipientSheetColumns_(headers, notes, binding) {
  var keys = headers.map(contactSyncHeaderKey_), positions = {}, additions = [];
  var marker = 'registry/coldy-recipient/v1/' + coldyCampaignId_(binding.campaignId) + '/';
  function existing(label, required) {
    var matches = contactSyncHeaderColumns_(keys, label);
    if (matches.length > 1 || required && !matches.length) fail_('COLDY_SCHEMA', 'Проверьте заголовок «' + label + '» на вкладке Email.');
    return matches.length ? matches[0] : -1;
  }
  function add(label, note) {
    var index = headers.length + additions.length;
    additions.push({ index: index, label: label, note: note });
    return index;
  }
  positions.email = existing('Email', true);
  positions.workflow = existing(CONTACT_MAILING_STATUS.header, true);
  positions.owner = existing('Компания / ЛПР', false);
  positions.memberships = existing(COLDY_CAMPAIGNS.headers[0], false);
  if (positions.memberships < 0) positions.memberships = add(COLDY_CAMPAIGNS.headers[0], '');
  Object.keys(COLDY_RECIPIENT_COLUMNS).forEach(function (key) {
    var label = COLDY_RECIPIENT_COLUMNS[key] + ' · ' + binding.campaignName;
    var matches = [];
    notes.forEach(function (note, index) { if (note === marker + key) matches.push(index); });
    if (matches.length > 1) fail_('COLDY_SCHEMA', 'Скопированы служебные отметки в заголовках истории рассылок.');
    if (matches.length) positions[key] = matches[0];
    else {
      // A pre-existing user column or another campaign with the same name remains theirs.
      if (keys.indexOf(contactSyncHeaderKey_(label)) >= 0) label += ' [' + binding.campaignId + ']';
      if (keys.indexOf(contactSyncHeaderKey_(label)) >= 0) fail_('COLDY_SCHEMA', 'Проверьте служебные отметки заголовков Coldy перед обновлением.');
      positions[key] = add(label, marker + key);
    }
  });
  if (new Set(Object.keys(positions).map(function (key) { return positions[key]; }).filter(function (index) { return index >= 0; })).size !== Object.keys(positions).filter(function (key) { return positions[key] >= 0; }).length) {
    fail_('COLDY_SCHEMA', 'Колонки истории Coldy совпадают с существующими рабочими полями.');
  }
  return { positions: positions, additions: additions };
}

function coldyRecipientSheetFacts_(item, binding) {
  function flag(value) { return value === true ? 'Да' : value === false ? 'Нет' : 'Нет данных'; }
  var contact = { 'Not contacted': 'Пока не связались', Sent: 'Письмо отправлено', Opened: 'Письмо открыто', Replied: 'Получен ответ', Bounce: 'Баунс' };
  var campaign = { Active: 'Активна', Paused: 'На паузе', Completed: 'Завершена', Draft: 'Черновик' };
  return {
    status: item.doNotSend === true ? 'Не отправляем' : item.bounced === true ? 'Баунс' :
      item.replied === true ? 'Получен ответ' : contact[item.status] || (item.sentCount > 0 ? 'Письмо отправлено' : 'Нет данных'),
    campaign: campaign[binding.campaignStatus] || 'Нет данных',
    sent: Number.isSafeInteger(item.sentCount) && item.sentCount >= 0 ? item.sentCount : 'Нет данных',
    replied: flag(item.replied), bounced: flag(item.bounced), stopped: flag(item.doNotSend)
  };
}

/** Only the authoritative intake list reaches this helper, already aggregated by email across all lead IDs. */
function coldyRecipientSheetPlan_(binding, kind, recipients, existing, known, lastRow, layout, read) {
  var seen = new Set(), writes = [], hashes = [], next = lastRow + 1;
  var counts = { processed: recipients.length, appended: 0, existing: 0, excluded: 0 };
  var positions = layout.positions, membership = binding.campaignName + ' [' + binding.campaignId + ']';
  recipients.forEach(function (item) {
    var email = pvEmail_(item.email), key = contactSyncKey_('email', email);
    if (!key || seen.has(email)) fail_('COLDY_RESPONSE', 'В порции есть неподтверждённый или повторяющийся адрес.');
    seen.add(email);
    var hash = digest_(key), matched = existing[email] || [];
    if (!matched.length && known.has(hash)) { counts.excluded++; return; }
    if (matched.length) counts.existing++;
    else { counts.appended++; matched = [next++]; }
    hashes.push(hash);
    matched.forEach(function (row) {
      function cell(field) { return read(row, positions[field]); }
      function put(field, value) {
        var old = cell(field);
        if (old.value === value && !old.formula) return;
        if (old.formula) fail_('COLDY_SCHEMA', 'В строке ' + row + ' вкладки Email формула в поле, которое требуется обновить. Проверьте её перед продолжением.');
        writes.push({ row: row, col: positions[field], value: value });
      }
      if (row > lastRow) put('email', email);
      var observed = Object.assign({}, item);
      var savedCount = cell('sent').value;
      if (Number.isSafeInteger(savedCount) && savedCount >= 0) observed.sentCount = Math.max(savedCount, observed.sentCount || 0);
      [['replied','replied'], ['bounced','bounced'], ['stopped','doNotSend']].forEach(function (pair) {
        var storedFlag = cell(pair[0]).value, incoming = observed[pair[1]];
        if (storedFlag === 'Да' && (pair[1] !== 'doNotSend' || incoming === null)) observed[pair[1]] = true;
        if (storedFlag === 'Нет' && incoming === null) observed[pair[1]] = false;
      });
      if (observed.status === 'Not contacted' && observed.sentCount > 0) observed.status = 'Sent';
      var facts = coldyRecipientSheetFacts_(observed, binding);
      var oldStatus = cell('workflow'), workflow = String(oldStatus.value || '').trim().toLowerCase();
      var blocked = observed.bounced === true || observed.doNotSend === true;
      var desired = blocked ? 'фильтр' : 'в рассылке';
      if (!oldStatus.formula && (!workflow || workflow === 'новый' || blocked && workflow === 'в рассылке')) put('workflow', desired);
      else if (blocked && !pvExcludedStatus_(workflow, true)) fail_('COLDY_SCHEMA', 'В строке ' + row + ' проверьте рабочий статус перед записью запрета на отправку.');
      if (positions.owner >= 0 && !cell('owner').value && !cell('owner').formula) {
        var display = kind === 'companies' ? item.company : [item.firstName, item.lastName].filter(Boolean).join(' ');
        if (display) put('owner', display);
      }
      var stored = String(cell('memberships').value || ''), labels = stored.split('\n').filter(Boolean);
      if (!coldyCampaignHasMembership_(stored, binding.campaignId)) put('memberships', labels.concat([membership]).join('\n'));
      Object.keys(facts).forEach(function (field) {
        if (!cell(field).formula) put(field, facts[field]);
      });
    });
  });
  return { writes: writes, counts: counts, hashes: hashes, lastRow: next - 1 };
}

/** Read only the existing rows whose addresses occur in this batch, in bounded rectangles. */
function coldyRecipientSheetRead_(sheet, width, lastRow, layout, recipients) {
  var existing = Object.create(null), rows = [], emails = Object.create(null), data = Object.create(null);
  var wanted = new Set(recipients.map(function (item) { return pvEmail_(item.email); }));
  if (lastRow > 1) sheet.getRange(2, layout.positions.email + 1, lastRow - 1, 1).getDisplayValues().forEach(function (line, index) {
    var email = pvEmail_(line[0]);
    if (!email || !wanted.has(email)) return;
    (existing[email] || (existing[email] = [])).push(index + 2); rows.push(index + 2); emails[index + 2] = email;
  });
  var start = 0;
  while (start < rows.length) {
    var end = start + 1;
    while (end < rows.length && rows[end] - rows[start] < 250 && rows[end] - rows[end - 1] <= 30) end++;
    var range = sheet.getRange(rows[start], 1, rows[end - 1] - rows[start] + 1, width);
    var values = range.getValues(), formulas = range.getFormulas();
    for (var i = start; i < end; i++) {
      var relative = rows[i] - rows[start];
      if (pvEmail_(values[relative][layout.positions.email]) !== emails[rows[i]]) fail_('CONFLICT', 'Строки вкладки Email изменились. Продолжите тот же импорт.');
      data[rows[i]] = { values: values[relative], formulas: formulas[relative] };
    }
    start = end;
  }
  return { existing: existing, cell: function (row, col) {
    var d = data[row]; return !d || col >= width ? { value: '', formula: '' } : { value: d.values[col], formula: d.formulas[col] };
  } };
}

function coldyRecipientSheetRequests_(sheet, width, lastRow, layout, plan) {
  var id = sheet.getSheetId(), requests = [], maxCols = sheet.getMaxColumns(), maxRows = sheet.getMaxRows();
  if (width + layout.additions.length > maxCols) requests.push({ appendDimension: { sheetId: id, dimension: 'COLUMNS', length: width + layout.additions.length - maxCols } });
  if (plan.lastRow > maxRows) requests.push({ appendDimension: { sheetId: id, dimension: 'ROWS', length: plan.lastRow - maxRows } });
  if (layout.additions.length) requests.push({ updateCells: { start: { sheetId: id, rowIndex: 0, columnIndex: width }, fields: 'userEnteredValue,note', rows: [{ values: layout.additions.map(function (field) {
    return { userEnteredValue: { stringValue: field.label }, note: field.note };
  }) }] } });
  plan.writes.sort(function (a, b) { return a.col - b.col || a.row - b.row; });
  var group = null, previous = null;
  plan.writes.forEach(function (write) {
    if (previous === null || previous.col !== write.col || previous.row + 1 !== write.row) {
      group = { start: { sheetId: id, rowIndex: write.row - 1, columnIndex: write.col }, fields: 'userEnteredValue', rows: [] };
      requests.push({ updateCells: group });
    }
    var value = typeof write.value === 'number' ? { numberValue: write.value } : { stringValue: write.value };
    group.rows.push({ values: [{ userEnteredValue: value }] }); previous = write;
  });
  if (plan.lastRow > lastRow) requests.push({ setDataValidation: {
    range: { sheetId: id, startRowIndex: lastRow, endRowIndex: plan.lastRow, startColumnIndex: layout.positions.workflow, endColumnIndex: layout.positions.workflow + 1 },
    rule: { condition: { type: 'ONE_OF_LIST', values: CONTACT_MAILING_STATUS.values.map(function (s) { return { userEnteredValue: s }; }) }, showCustomUi: true, strict: true }
  } });
  return requests;
}

/** Caller journals each provider page before acknowledgement. The atomic batch writes literal values only. */
function coldyRecipientSheetWrite_(context, binding, kind, target, recipients, guard, beforeApply) {
  if (!Array.isArray(recipients) || recipients.length > 1000 || typeof guard !== 'function') fail_('INVALID_REQUEST', 'Некорректная порция контактов рассылки.');
  function currentVersion() {
    return coldyRecipientSheetVersion_(context, binding, kind, target, contactSyncMetadata_(target.fileId));
  }
  guard(); currentVersion();
  return contactSyncWithLease_(target.fileId, function (claim) {
    var state = claim.state;
    if (state.rootId !== context.rootId || state.segmentId !== binding.segmentId || state.role !== 'segment-' + kind || state.targets.emailSheetId !== target.sheetId) fail_('COLDY_TARGET_CHANGED', 'Не удалось подтвердить рабочую вкладку сегмента.');
    if (state.job) fail_('BUSY', 'Дождитесь окончания текущего обновления контактов этой таблицы.');
    claim.importSegmentId = binding.segmentId;
    var sheet = gridSheet_(claim.book, target.sheetId), width = sheet.getLastColumn(), lastRow = sheet.getLastRow();
    if (!width || !lastRow || width > COLDY_CAMPAIGNS.maxColumns || lastRow > COLDY_CAMPAIGNS.maxRows) fail_('COLDY_SCHEMA', 'Проверьте размер и заголовки рабочей вкладки Email.');
    var version = currentVersion();
    var header = sheet.getRange(1, 1, 1, width);
    var layout = coldyRecipientSheetColumns_(header.getDisplayValues()[0], header.getNotes()[0], binding);
    var snapshot = coldyRecipientSheetRead_(sheet, width, lastRow, layout, recipients);
    var plan = coldyRecipientSheetPlan_(binding, kind, recipients, snapshot.existing, new Set(state.known), lastRow, layout, snapshot.cell);
    if (width + layout.additions.length > COLDY_CAMPAIGNS.maxColumns || plan.lastRow > COLDY_CAMPAIGNS.maxRows) fail_('COLDY_SCHEMA', 'Недостаточно места для истории контактов рассылки.');
    var requests = coldyRecipientSheetRequests_(sheet, width, lastRow, layout, plan);
    var result = Object.assign({ fileId: target.fileId, sheetId: target.sheetId }, plan.counts);
    locked_(function () {
      guard(); contactSyncAssertLease_(claim);
      if (version !== currentVersion()) fail_('CONFLICT', 'Таблица изменилась во время чтения. Продолжите тот же импорт.');
      if (beforeApply) beforeApply(result);
      if (requests.length) {
        if (version !== currentVersion()) fail_('CONFLICT', 'Таблица изменилась до сохранения страницы. Продолжите тот же импорт.');
        sheetRawBatchWrite_(target.fileId, requests);
      }
    });
    // Remember successfully imported recipients so a later manual deletion remains effective.
    var known = contactSyncUnion_(state.known, plan.hashes);
    if (known.length !== state.known.length) { state.known = known; contactSyncSaveState_(claim.context, state); }
    return result;
  }, false);
}
