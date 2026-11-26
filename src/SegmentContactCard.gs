/** Read-only view of the two registered contact workbooks. No enrollment, provider calls or repair. */
function getSegmentContactCard_(request) {
  return api_(function () {
    var input = segmentInput_(request, ['segmentId', 'channel', 'owner', 'queue', 'query', 'offset', 'limit', 'revision', 'prepared']);
    var context = authorize_(), segmentId = id_(input.segmentId), filter = segmentCardFilter_(input);
    if (input.prepared !== undefined && typeof input.prepared !== 'boolean') fail_('INVALID_REQUEST', 'Некорректный режим чтения карточки.');
    if (input.prepared === true) {
      var prepared = segmentCardPreparedPage_(context, segmentId, filter, input.revision);
      if (prepared) return prepared;
      if (typeof segmentCardMaintenanceRequest_ === 'function') segmentCardMaintenanceRequest_(context, segmentId);
    }
    var data = segmentCardData_(context, segmentId, input.revision), result = segmentCardPage_(data.snapshot, filter);
    segmentCardOriginals_(context, data.scope, result.rows);
    result.segmentId = segmentId; result.name = data.scope.folder.getName(); result.revision = data.revision;
    result.files = {};
    Object.keys(data.scope.files).forEach(function (kind) {
      var file = data.scope.files[kind]; result.files[kind] = file ? {id: file.id, name: file.name} : null;
    });
    return result;
  });
}

function segmentCardData_(context, segmentId, revision, scope, campaigns, deferCache) {
  scope = scope || segmentCardFiles_(context, segmentId);
  campaigns = campaigns || segmentCardCampaigns_(context, segmentId);
  var version = segmentCardRevision_(context, scope, campaigns);
  if (revision !== undefined && revision !== version) segmentCardChanged_();
  var snapshot = segmentCardReadCache_(version);
  if (!snapshot) {
    snapshot = scope.draftSnapshot || segmentCardBuild_(context,scope,campaigns,scope.validation || pvCacheRead_(pvCache_(context,false)));
    // Never cache or serve a mix of revisions if a source changed during the bulk read.
    var latest = segmentCardFiles_(context,segmentId);
    latest.validationMembership = scope.validationMembership;
    latest.revisionDigests = scope.revisionDigests;
    if (version !== segmentCardRevision_(context, latest, segmentCardCampaigns_(context, segmentId))) segmentCardChanged_();
    if (!deferCache) segmentCardWriteCache_(version, snapshot);
  }
  return {scope: scope, campaigns: campaigns, revision: version, snapshot: snapshot};
}

function segmentCardBuild_(context, scope, campaigns, validation, validationKeys) {
  var groups = new Map(), warnings = [], facts = campaigns.bindings.map(segmentCardCampaignFact_);
  ['companies','lpr'].forEach(function (kind) {
    var label = kind === 'companies' ? 'Компании' : 'ЛПР';
    if (!scope.files[kind]) { warnings.push('Рабочая таблица «' + label + '» ещё не подключена.'); return; }
    var tabs = segmentCardTabs_(context,scope,kind);
    ['email','telegram'].forEach(function (channel) {
      if (!tabs[channel]) { warnings.push('В таблице «' + label + '» отсутствует рабочий лист «' + (channel === 'email' ? 'Email' : 'Телефоны') + '».'); return; }
      segmentCardReadSheet_(groups,tabs[channel],channel,kind,scope.files[kind],validation,facts);
    });
  });
  if (validationKeys) groups.forEach(function (group) { validationKeys.push(group.validationKey); });
  return segmentCardSnapshot_(groups,warnings);
}

function segmentCardChanged_() { fail_('SEGMENT_CARD_CHANGED', 'Данные сегмента изменились. Откройте список заново.'); }

function segmentCardFiles_(context, segmentId, includeHistory) {
  registryRequireSegment_(context, segmentId);
  var folder = segmentFolder_(context, segmentSourceFolder_(context), segmentId, true);
  var storage = sourceBasesStorage_(context), storageMeta = contactSyncMetadata_(storage.public.id);
  var tracking = segmentTrackingStorage_(context,storage,false,includeHistory !== true), files = {companies:null,lpr:null};
  tracking.tables.forEach(function (table) {
    if (table.segmentId !== segmentId) return;
    var fileId = table.fileId;
    if (fileId === storage.public.id || fileId === REGISTRY_CONFIG.defaultSourceBasesStorageId)
      fail_('GRID_PROTECTED', 'Служебная таблица не может быть рабочей таблицей сегмента.');
    var meta = contactSyncMetadata_(fileId);
    if (!segmentCardFileMatches_(meta, fileId, segmentId, table.kind, context.rootId))
      fail_('OUTSIDE_SEGMENTS', 'Назначенная рабочая таблица больше не принадлежит этому сегменту.');
    files[table.kind] = {id: fileId, name: meta.name, version: contactSyncVersion_(meta), metadata: meta};
  });
  return {folder:folder,storage:storage,tracking:includeHistory === true ? tracking : null,storageVersion:contactSyncVersion_(storageMeta),files:files};
}

function segmentCardFileMatches_(meta, fileId, segmentId, kind, rootId) {
  if (!meta || meta.id !== fileId || meta.trashed || meta.mimeType !== REGISTRY_CONFIG.spreadsheetMime ||
      !meta.parents || meta.parents.length !== 1 || meta.parents[0] !== segmentId) return false;
  var tags = meta.appProperties || {};
  return (!tags.registrySegmentMasterRoot || tags.registrySegmentMasterRoot === rootId) &&
    (!tags.registrySegmentMasterSegment || tags.registrySegmentMasterSegment === segmentId) &&
    (!tags.registrySegmentMasterKind || tags.registrySegmentMasterKind === kind) &&
    (!tags.registryContactRoot || tags.registryContactRoot === rootId) && !tags.registryPrivateRole;
}

function segmentCardTabs_(context, scope, kind) {
  var file = scope.files[kind], book = SpreadsheetApp.openById(file.id), tags = file.metadata.appProperties || {};
  function tab(key, name) {
    if (tags[key] === undefined) return tags.registryContactStateId ? null : book.getSheetByName(name);
    if (!/^\d+$/.test(String(tags[key])) || tags.registryContactRoot !== context.rootId) fail_('SEGMENT_TARGET_CHANGED', 'Не удалось подтвердить рабочий лист контактов.');
    return segmentFindSheet_(book, Number(tags[key]));
  }
  var email = tab('registryContactEmailSheetId', 'Email'), phone = tab('registryContactPhoneSheetId', 'Телефоны');
  if (email && phone && email.getSheetId() === phone.getSheetId()) fail_('SEGMENT_TARGET_CHANGED', 'Двум каналам назначен один рабочий лист.');
  return {email: email, telegram: phone};
}

function segmentCardCampaigns_(context, segmentId) {
  var project = registrySegmentProject_(context, segmentId), settings = coldySettings_(context);
  if (!settings.key || !project) return {credential: '', bindings: []};
  var registry = coldyCampaignRegistry_(context), selected = registry.bindings.filter(function (b) { return b.segmentId === segmentId; });
  var folder = selected.length ? coldyFolder_(context, false) : null;
  var bindings = selected.map(function (b) {
    var owner = coldyIncomingOwner_(context, registry.credentialHash, project, b);
    var mark = coldyIncomingMark_(context.properties, owner, b.revision);
    var slot = coldyStoreScope_(context, 'recipientpoll', owner, false);
    var file = folder ? coldyStoreFile_(slot, folder) : null;
    return {binding: b, mark: mark, scope: slot, file: file};
  });
  return {credential: registry.credentialHash, bindings: bindings};
}

function segmentCardCampaignFact_(item) {
  if (item.fact) return item.fact;
  var b = item.binding, state = item.file ? coldyReadEnvelope_(item.scope, item.file).data : null;
  var verified = state && state.bindingRevision === b.revision ? state : {};
  var policy = verified.policy || {}, complete = item.mark.state === 'synced' && !!item.mark.lastSyncedAt &&
    !verified.scan && Array.isArray(policy.emails) && policy.identity === digest_(JSON.stringify(policy.emails)) && verified.lastIdentity;
  item.fact = {binding:b, checked:complete ? verified.checked || {} : {}, fingerprint:verified.lastIdentity,
    known:new Set(policy.emails || []), blocked:new Set((policy.known || []).concat(policy.hits || [])), checkedAt:item.mark.lastSyncedAt || ''};
  return item.fact;
}

// A strong Drive version is a fast way to reuse a digest, not evidence that visible facts changed.
function segmentCardDigestAtVersion_(memo, inputs, compute) {
  var key = 'card-content/' + digest_(JSON.stringify(inputs)), cache, value;
  if (memo.has(key)) return memo.get(key);
  try { cache = CacheService.getScriptCache(); value = cache.get(key); } catch (ignored) {}
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    value = digest_(JSON.stringify(compute()));
    try { if (cache) cache.put(key,value,21600); } catch (ignored) {}
  }
  memo.set(key,value);
  return value;
}

function segmentCardRevision_(context, scope, campaigns) {
  // A fresh scope is always allocated for the independent final check.
  if (scope.revisionCampaigns === campaigns && scope.cardRevision) return scope.cardRevision;
  var files = ['companies', 'lpr'].map(function (kind) {
    var file = scope.files[kind]; if (file && !file.version) segmentCardChanged_(); return file ? [file.id, file.version] : null;
  });
  if (!scope.storageVersion) segmentCardChanged_();
  var scopeKey = [context.rootId,registryProjectId_(),scope.folder.getId(),scope.storage.public.id,files];
  var memo = scope.revisionDigests || (scope.revisionDigests = new Map());
  var validation = segmentCardDigestAtVersion_(memo,['validation',scopeKey,scope.storageVersion],function () {
    scope.validation = pvCacheRead_(pvCache_(context,false));
    if (!Object.keys(scope.validation).length) return [];
    var keys = segmentCardValidationKeys_(context,scope,scopeKey,campaigns);
    return keys.filter(function (key) { return scope.validation[key]; }).map(function (key) {
      var record = scope.validation[key], result = record.result || {};
      return [key,!!record.pending,result.status || '',!!result.review,result.eligible === true,!!result.idTg];
    });
  });
  var states = campaigns.bindings.map(function (entry) {
    var file = entry.file, version = file && contactSyncVersion_(file);
    if (file && !version) segmentCardChanged_();
    var status = segmentCardDigestAtVersion_(memo,['campaign',scopeKey,campaigns.credential,entry.binding,file && [file.id,version],
      entry.mark.state === 'synced' && !!entry.mark.lastSyncedAt],function () {
      var fact = segmentCardCampaignFact_(entry);
      var proofs = ['companies','lpr'].map(function (kind) {
        var proof = fact.checked[kind], target = scope.files[kind];
        return proof && target && proof.fingerprint === fact.fingerprint && proof.fileId === target.id && proof.version === target.version ? proof.sheetId : null;
      });
      return [proofs,proofs.some(function (p) { return p != null; }) ? Array.from(fact.known).sort() : [],Array.from(fact.blocked).sort()];
    });
    return [entry.binding,status];
  });
  scope.cardRevision = digest_(JSON.stringify(['segment-contact-card-v3',scopeKey,validation,campaigns.credential,states]));
  scope.revisionCampaigns = campaigns;
  return scope.cardRevision;
}

function segmentCardValidationKeys_(context, scope, scopeKey, campaigns) {
  var version = digest_(JSON.stringify(['card-validation-keys',scopeKey]));
  if (scope.validationMembership && scope.validationMembership.version === version) return scope.validationMembership.keys;
  var keys = segmentCardReadCache_(version);
  if (!Array.isArray(keys)) {
    // Each contact group already computed its Promouser key. Reuse that same scan for the card.
    keys = [];
    scope.draftSnapshot = segmentCardBuild_(context,scope,campaigns,scope.validation,keys);
    keys.sort();
    segmentCardWriteCache_(version,keys,21600);
  }
  scope.validationMembership = {version:version,keys:keys};
  return keys;
}

function segmentCardFilter_(input) {
  function option(value, allowed, fallback) {
    if (value === undefined) return fallback;
    if (allowed.indexOf(value) < 0) fail_('INVALID_REQUEST', 'Проверьте фильтры карточки сегмента.');
    return value;
  }
  function number(value, fallback, min, max) {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) fail_('INVALID_REQUEST', 'Некорректный размер или номер страницы.');
    return value;
  }
  if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 300)) fail_('INVALID_REQUEST', 'Сократите поисковый запрос.');
  return {channel: option(input.channel, ['all', 'email', 'telegram'], 'all'), owner: option(input.owner, ['all', 'companies', 'lpr'], 'all'),
    queue: option(input.queue, ['all', 'email', 'emailReview', 'telegram', 'ownership', 'ready', 'inCampaign'], 'all'), query: String(input.query || '').trim().toLowerCase(),
    offset: number(input.offset, 0, 0, 1000000), limit: number(input.limit, 50, 1, 200)};
}

function segmentCardReadSheet_(groups, sheet, channel, owner, file, validation, campaigns) {
  var count = sheet.getLastRow() - 1, width = sheet.getLastColumn();
  if (count <= 0) return;
  if (count >= CONTACT_SYNC.maxTargetRows || width > CONTACT_SYNC.maxHeaderColumns) fail_('SEGMENT_CARD_LIMIT', 'Рабочий лист превышает допустимый для чтения размер.');
  var sheetId = sheet.getSheetId(), sheetName = sheet.getName();
  var head = sheet.getRange(1, 1, 1, width), headers = head.getDisplayValues()[0], map = pvHeaderMap_(headers);
  var indices = {};
  function col(key, aliases) { indices[key] = pvFindHeader_(map, aliases); }
  col('value', channel === 'email' ? ['Email','E-mail','Почта'] : ['Телефон','Мобильный телефон','Phone','Mobile']);
  col('handle', ['Telegram','Телеграм']); col('ownerName', ['Компания / ЛПР']); col('company', ['Компания','Название компании']); col('person', ['ФИО','ЛПР','Имя']);
  col('review', ['Проверить принадлежность']); col('validation', ['Валидация']); col('type', ['Тип контакта','Тип телефона']);
  col('origin', ['Исходный столбец email']); col('originRows', ['Исходные строки','Строки в Лист1']); col('history', ['История контакта']);
  indices.companyEmail = channel === 'email' && owner === 'companies' && companyEmailWorkflowHeaders_(headers);
  if (indices.companyEmail) col('rawResult', ['Результат валидации']);
  col('membership', [COLDY_CAMPAIGNS.headers[0]]);
  if (indices.value === undefined && (channel === 'email' || indices.handle === undefined)) fail_('SEGMENT_CARD_SCHEMA', 'В рабочем листе отсутствует столбец контакта.');
  var statusHeaders = indices.companyEmail ? ['Статус'] : CONTACT_MAILING_STATUS.headers;
  var manualCols = statusHeaders.map(function (header) { return map[pvHeader_(header)]; }).filter(function (index) { return index !== undefined; });
  var notes = channel === 'email' && campaigns.length ? head.getNotes()[0] : [];
  var layouts = channel === 'email' ? campaigns.map(function (campaign) {
    var positions = {}, marker = 'registry/coldy-recipient/v1/' + coldyCampaignId_(campaign.binding.campaignId) + '/';
    Object.keys(COLDY_RECIPIENT_COLUMNS).forEach(function (field) {
      var tag = marker + field, index = notes.indexOf(tag);
      if (index >= 0 && index !== notes.lastIndexOf(tag)) fail_('COLDY_SCHEMA', 'На листе дублированы служебные отметки Coldy.');
      if (index >= 0) positions[field] = index;
    });
    var verified = campaign.checked[owner];
    return {campaign: campaign, positions: positions, checked: !!verified && verified.fingerprint === campaign.fingerprint &&
      verified.fileId === file.id && verified.sheetId === sheetId && verified.version === file.version};
  }) : [];
  // Bound each allocation for wide sheets without doing remote reads per contact.
  var stride = Math.max(1, Math.min(2000, Math.floor(80000 / width)));
  for (var start = 2; start < count + 2; start += stride) {
    var n = Math.min(stride, count + 2 - start), values = sheet.getRange(start, 1, n, width).getDisplayValues();
    var noteColumn = indices.validation === undefined ? indices.rawResult : indices.validation;
    var bindings = noteColumn === undefined ? [] : sheet.getRange(start, noteColumn + 1, n, 1).getNotes();
    values.forEach(function (line, index) {
      var source = {id: file.id, row: start + index, sheetId: sheetId, sheetName: sheetName};
      segmentCardGroupRow_(groups, channel, owner, line, map, indices, manualCols, String(bindings[index] && bindings[index][0] || ''), validation, layouts, source);
    });
  }
}

function segmentCardIdentity_(channel, raw, handleCell) {
  raw = String(raw || '').trim();
  var kind = channel === 'email' ? 'email' : 'telegram';
  var value = channel === 'email' ? pvEmail_(raw) : pvPhone_(raw);
  if (!value && channel === 'telegram') {
    handleCell = String(handleCell || '').trim();
    var handle = pvUsername_(handleCell) || pvUsername_(raw);
    if (handle) { kind = 'telegram_username'; value = handle; }
    if (!raw) raw = handleCell;
  }
  return value || raw ? {kind:kind,valid:!!value,value:value || raw} : null;
}

function segmentCardGroupRow_(groups, channel, owner, line, map, cols, manualCols, note, validation, layouts, source) {
  function cell(i) { return i === undefined ? '' : String(line[i] || '').trim(); }
  var identity = segmentCardIdentity_(channel,cell(cols.value),cell(cols.handle));
  if (!identity) return;
  var kind = identity.kind, validFormat = identity.valid, value = identity.value;
  var compound = channel + '|' + value.toLowerCase(), group = groups.get(compound);
  if (!group) {
    group = {channel: channel, value: value, owners: new Set(), names: new Set(), manual: new Set(), results: new Set(), pendingLabels: new Set(), facts: new Map(), sources: [],
      validFormat: validFormat, manualNew: true, mobile: false, pending: false, valid: false, invalid: false, review: false, excluded: false, ownership: false, inCampaign: false, blocked: false};
    groups.set(compound, group);
  }
  group.owners.add(owner);
  var names = Array.from(new Set([cols.ownerName, cols.company, cols.person].map(cell).filter(Boolean)));
  names.forEach(function (name) { group.names.add(name); });
  group.sources.push({id: source.id, name: 'Рабочая таблица «' + (owner === 'companies' ? 'Компании' : 'ЛПР') + '» · ' + source.sheetName,
    url: spreadsheetUrl_(source.id) + '#gid=' + source.sheetId + '&range=A' + source.row, owner: owner, ownerNames: names,
    sourceType: 'working', column: cell(cols.origin), sourceRows: cell(cols.originRows), history: !!cell(cols.history)});
  if (!manualCols.length) group.manualNew = false;
  manualCols.forEach(function (i) {
    var status = cell(i), workflow = cols.companyEmail ? companyEmailWorkflowStatus_(status) : null;
    if (status) group.manual.add(status);
    if (!contactMailingStatusIsNew_(status)) group.manualNew = false;
    if (workflow === 'Рассылка') group.inCampaign = true;
    else if (workflow === 'Невалид') group.workflowInvalid = true;
    else if (pvExcludedStatus_(status, true)) group.excluded = true;
  });
  var flag = cell(cols.review);
  group.ownership = group.ownership || !!flag && !/^(?:нет|no|false|0)$/i.test(flag);
  var phoneType = cell(cols.type).toLowerCase(), country = kind === 'telegram' && validFormat ? pvCountry_(value) : '';
  if (country && !/городск|стационар|fixed|landline/i.test(phoneType) && (country === 'RU' || country === 'KZ' || /мобил|mobile/i.test(phoneType))) group.mobile = true;
  var key = group.validationKey || (group.validationKey = pvKey_(kind, value)), bound = pvBinding_(note), status = cell(cols.validation) || cell(cols.rawResult);
  var cached = validation[key];
  if (cols.companyEmail) {
    group.companyEmail = true;
    var manual = cell(manualCols[0]).toLowerCase(), changed = !!bound && bound !== key;
    var readyState = coldyReadyEmailState_(value, manual, cell(cols.rawResult), changed, cached && cached.result);
    if (readyState === 'ready' && validFormat) group.workflowReady = true;
    if (changed) group.workflowStale = true;
    else if (readyState === 'invalid') group.workflowInvalid = true;
    if (contactMailingStatusIsNew_(manual)) group.workflowNew = true;
  }
  var legacy = !bound && !status ? pvLegacyResult_(kind, line, map) : null;
  var rowResult = pvResultFromRow_({kind: kind, map: map, values: line, status: legacy ? legacy.status : status, legacyResult: legacy,
    completed: !!legacy || !!status && !pvPendingStatus_(status), changed: !!bound && bound !== key});
  if (status && (!bound || bound === key) && pvPendingStatus_(status)) {
    group.pendingLabels.add(status); if (cols.companyEmail) group.pending = true;
  }
  if (cached && cached.pending) { group.pending = true; group.pendingLabels.add('Проверка в обработке'); }
  [rowResult, cached && cached.result].forEach(function (result) {
    if (!result || !result.status) return;
    group.results.add(result.status);
    if (result.review && (!cols.companyEmail || cached && cached.result === result)) group.review = true;
    if (cols.companyEmail) return;
    var accepted = channel === 'email' ? pvEmailStatus_(result.status) === 'Валиден' : result.eligible === true && !!result.idTg;
    if (accepted) group.valid = true; else group.invalid = true;
  });
  layouts.forEach(function (layout) {
    var campaign = layout.campaign, b = campaign.binding, p = layout.positions;
    var facts = group.facts.get(b.campaignId);
    if (!facts) {
      facts = {campaign: b.campaignName, statuses: new Set(), present: false, checked: false, checkedAt: campaign.checkedAt,
        sent: null, replied: null, bounced: null, stopped: null};
      group.facts.set(b.campaignId, facts);
    }
    var member = coldyCampaignHasMembership_(cell(cols.membership), b.campaignId), recipient = cell(p.status);
    if (member) { facts.present = true; if (!recipient || recipient === 'Нет данных') facts.statuses.add('Добавлен'); }
    if (recipient && recipient !== 'Нет данных') { facts.present = true; facts.statuses.add(recipient); }
    var sent = cell(p.sent);
    if (/^\d+$/.test(sent) && Number.isSafeInteger(Number(sent))) { facts.sent = Math.max(facts.sent || 0, Number(sent)); if (facts.sent > 0) facts.present = true; }
    [['replied','Получен ответ'], ['bounced','Баунс'], ['stopped','Остановлен']].forEach(function (pair) {
      var field = pair[0], rawFlag = cell(p[field]);
      if (/^(?:да|yes|true|1)$/i.test(rawFlag)) { facts[field] = true; facts.present = true; facts.statuses.add(pair[1]); }
      else if (/^(?:нет|no|false|0)$/i.test(rawFlag) && facts[field] === null) facts[field] = false;
    });
    if (campaign.blocked.has(value) || /не отправля|баунс|останов/i.test(recipient) || facts.statuses.has('Остановлен') || facts.statuses.has('Баунс')) group.blocked = true;
    if (campaign.blocked.has(value)) facts.statuses.add('Не отправляем');
    if (facts.present) group.inCampaign = true;
    if (layout.checked && !campaign.known.has(value)) facts.checked = true;
  });
}

function segmentCardSnapshot_(groups, warnings) {
  var rows = [], summary = {email: {total: 0, ready: 0, toCheck: 0}, telegram: {total: 0, ready: 0, toCheck: 0}, sharedEmail: 0, ownership: 0, inCampaign: 0};
  groups.forEach(function (g) {
    var needsOwnership = g.ownership, blocked = g.excluded || g.blocked, completed = g.results.size > 0;
    var checkable = g.validFormat && (g.channel === 'email' || g.mobile), review = g.review || g.valid && g.invalid;
    var available = g.validFormat && !review && !blocked && !needsOwnership && !g.inCampaign && !g.workflowInvalid && !g.workflowStale;
    var legacyReady = g.valid && !g.invalid && !g.pending;
    var ready = available && (legacyReady || !!g.workflowReady);
    var needsCheck = checkable && !completed && !g.pending && g.manualNew && !needsOwnership && !blocked && !g.inCampaign && !g.workflowInvalid;
    var chooseStatus = !!g.workflowNew && completed && !g.workflowReady && available && !g.pending;
    var readiness = blocked ? 'Исключён' : needsOwnership ? 'Проверить принадлежность' : review ? 'Проверить историю контакта' :
      g.inCampaign ? 'Уже в рассылке' : g.workflowInvalid ? 'Невалид' : ready ? 'Готов' : g.pending ? 'Проверка в обработке' :
      chooseStatus ? 'Выбрать «Готов» или «Фильтр»' : g.workflowStale && !needsCheck ? 'Проверить привязку результата' :
      completed ? g.companyEmail ? 'Проверить ручной статус' : 'Не прошёл проверку' :
      !g.validFormat ? 'Проверить формат' : !checkable ? 'Нужен мобильный телефон' : needsCheck ? 'Требует проверки' : 'Проверить ручной статус';
    var channelFacts = [], statuses = new Set(), campaigns = [];
    g.facts.forEach(function (fact) {
      if (fact.sent !== null && fact.present) fact.statuses.add('Отправлено писем: ' + fact.sent);
      if (!fact.statuses.size) fact.statuses.add(fact.checked ? 'Не найден в проверенной рассылке' : 'Нет данных о сверке');
      var labels = Array.from(fact.statuses); labels.forEach(function (label) { statuses.add(label); });
      if (fact.present) campaigns.push(fact.campaign);
      channelFacts.push({campaign: fact.campaign, statuses: labels, checkedAt: fact.checkedAt, sent: fact.sent, replied: fact.replied, bounced: fact.bounced, stopped: fact.stopped});
    });
    if (g.channel === 'email' && !channelFacts.length) statuses.add('Рассылки не подключены');
    var channel = summary[g.channel]; channel.total++; if (ready) channel.ready++; if (needsCheck) channel.toCheck++;
    if (chooseStatus) channel.toReview = (channel.toReview || 0) + 1;
    if (needsOwnership) summary.ownership++;
    if (g.inCampaign) summary.inCampaign++;
    if (g.channel === 'email' && g.owners.size === 2) summary.sharedEmail++;
    var row = {channel: g.channel, value: g.value, owners: Array.from(g.owners), ownerNames: Array.from(g.names), manualStatuses: Array.from(g.manual),
      validationStatuses: Array.from(completed ? g.results : g.pendingLabels), readiness: readiness, ready: ready, needsCheck: needsCheck,
      needsOwnership: needsOwnership, inCampaign: g.inCampaign, sources: g.sources, coldyStatuses: Array.from(statuses), campaigns: campaigns, channelFacts: channelFacts};
    if (chooseStatus) row.needsStatus = true;
    if (ready && g.companyEmail && g.owners.size === 2 && !(g.workflowReady && legacyReady))
      row.readyOwners = [g.workflowReady ? 'companies' : 'lpr'];
    rows.push(row);
  });
  rows.sort(function (a, b) { return a.channel.localeCompare(b.channel) || a.value.localeCompare(b.value); });
  return {rows: rows, summary: summary, warnings: warnings, checkedAt: new Date().toISOString()};
}

function segmentCardMatchingRows_(snapshot, filter) {
  return snapshot.rows.filter(function (r) {
    return (filter.channel === 'all' || r.channel === filter.channel) && (filter.owner === 'all' || r.owners.indexOf(filter.owner) >= 0) &&
      (filter.queue === 'all' || filter.queue === 'ownership' && r.needsOwnership ||
        filter.queue === 'ready' && r.ready && (!r.readyOwners || filter.owner === 'all' || r.readyOwners.indexOf(filter.owner) >= 0) ||
        filter.queue === 'emailReview' && r.needsStatus && filter.owner !== 'lpr' ||
        filter.queue === 'inCampaign' && r.inCampaign || filter.queue === r.channel && r.needsCheck) &&
      (!filter.query || [r.value].concat(r.ownerNames).some(function (value) { return value.toLowerCase().includes(filter.query); }));
  });
}

function segmentCardPage_(snapshot, filter) {
  var rows = segmentCardMatchingRows_(snapshot, filter);
  var end = filter.offset + filter.limit, page = rows.slice(filter.offset,end);
  if (filter.owner !== 'all' || filter.queue === 'emailReview') page = page.map(function (row) {
    if (!row.readyOwners || filter.owner !== 'all' && row.readyOwners.indexOf(filter.owner) >= 0 && filter.queue !== 'emailReview') return row;
    var readiness = row.needsStatus && filter.owner !== 'lpr' ? 'Выбрать «Готов» или «Фильтр»' :
      'Готов в таблице «' + (row.readyOwners[0] === 'companies' ? 'Компании' : 'ЛПР') + '»';
    return Object.assign({},row,{ready:false,readiness:readiness});
  });
  return {rows: page, offset: filter.offset, nextOffset: end < rows.length ? end : null,
    total: rows.length, summary: snapshot.summary, warnings: snapshot.warnings, checkedAt: snapshot.checkedAt};
}

/** Historical references are resolved only for a visible page, after the cache, against current file membership. */
function segmentCardOriginals_(context, scope, rows) {
  var segmentId = scope.folder.getId(), states = new Map(), files = new Map(), related, sourceFolder;
  function stateFor(kind) {
    if (states.has(kind)) return states.get(kind);
    var file = scope.files[kind], state = null;
    if (file && (file.metadata.appProperties || {}).registryContactStateId) {
      try { state = contactSyncReadState_(context, file.metadata, true); } catch (unavailable) { state = null; }
    }
    if (!state || state.segmentId !== segmentId || state.role !== 'segment-' + kind) state = null;
    states.set(kind, state); return state;
  }
  function original(fileId) {
    if (files.has(fileId)) return files.get(fileId);
    files.set(fileId, null);
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId) || fileId === scope.storage.public.id ||
      ['companies','lpr'].some(function (kind) { return scope.files[kind] && scope.files[kind].id === fileId; })) return null;
    try {
      var meta = contactSyncMetadata_(fileId), tags = meta.appProperties || {};
      if (meta.id !== fileId || meta.trashed || meta.mimeType !== REGISTRY_CONFIG.spreadsheetMime || !meta.parents || meta.parents.length !== 1 ||
          tags.registryPrivateRole || tags.registrySegmentImportRole || tags.registryContactRole || tags.registryPreparedRole && tags.registryPreparedRole !== 'output' ||
          [tags.registryContactRoot,tags.registryPreparedRoot,tags.registrySegmentMasterRoot].some(function (root) { return root && root !== context.rootId; })) return null;
      if (meta.parents[0] !== segmentId) {
        if (!related) related = new Set(sourceBasesReadRows_(scope.storage.relationsSheet, SOURCE_BASES_SCHEMA.relationsHeaders).rows
          .filter(function (line) { return line[1] === segmentId; }).map(function (line) { return line[0]; }));
        if (!related.has(fileId)) return null;
        if (!sourceFolder) sourceFolder = sourceBasesSource_(context);
        if (sourceFolder.state !== 'ready') return null;
        sourceBasesFile_(context, sourceFolder.folder, fileId);
      }
      var sheets = new Map(SpreadsheetApp.openById(fileId).getSheets().map(function (sheet) { return [sheet.getSheetId(), sheet]; }));
      var entry = {name: meta.name, sheets: sheets, ranges: new Map()}; files.set(fileId, entry); return entry;
    } catch (unavailable) { return null; }
  }
  rows.forEach(function (row) {
    var seen = new Set(), refs = [];
    row.sources.forEach(function (src) {
      if (!src.history) return;
      var state = stateFor(src.owner);
      if (!state || !state.workingHistory) return;
      var sheetId = state.targets && state.targets[row.channel === 'email' ? 'emailSheetId' : 'phoneSheetId'];
      if (!Number.isSafeInteger(sheetId) || !src.url.includes('#gid=' + sheetId + '&range=')) return;
      var key = row.channel === 'email' ? contactSyncKey_('email', row.value) : contactSyncKey_('phone', row.value);
      var history = state.workingHistory[key];
      if (!Array.isArray(history)) return;
      history.forEach(function (record) {
        if (!record || typeof record.source !== 'string' || !Number.isSafeInteger(record.sourceSheet) || record.sourceSheet < 0 || !/^\d+(?:\s*[,;]\s*\d+)*$/.test(record.refs)) return;
        var file = original(record.source), gid = record.sourceSheet, sheet = file && file.sheets.get(gid);
        if (!sheet) return;
        if (!file.ranges.has(gid)) {
          try { file.ranges.set(gid, {name: sheet.getName(), end: sheet.getLastRow()}); } catch (unavailable) { file.ranges.set(gid, null); }
        }
        var tab = file.ranges.get(gid); if (!tab) return;
        String(record.refs).split(/\s*[,;]\s*/).forEach(function (raw) {
          var n = Number(raw); if (!Number.isSafeInteger(n) || n < 1 || n > tab.end) return;
          var url = spreadsheetUrl_(record.source) + '#gid=' + gid + '&range=A' + n, key = JSON.stringify([url,src.owner,src.ownerNames]);
          if (seen.has(key)) return; seen.add(key);
          refs.push({id:record.source,name:file.name + ' · ' + tab.name,url:url,owner:src.owner,ownerNames:src.ownerNames,sourceType:'source',sourceRows:String(n),column:''});
        });
      });
    });
    row.sources = refs.concat(row.sources.map(function (src) { var clean = Object.assign({}, src); delete clean.history; return clean; }));
  });
}

// Cache entries are best effort. The SHA-256 key includes the access scope and checked source versions.
// Split on UTF-16 boundaries well below CacheService's 100KB-per-value limit, including non-ASCII text.
function segmentCardReadCache_(revision) {
  try {
    var cache = CacheService.getScriptCache(), key = 'segment-card/' + revision, count = Number(cache.get(key));
    if (!Number.isSafeInteger(count) || count < 1 || count > 160) return null;
    var keys = Array.from({length: count}, function (_, i) { return key + '/' + i; });
    var parts = cache.getAll(keys); if (keys.some(function (name) { return typeof parts[name] !== 'string'; })) return null;
    var content = keys.map(function (name) { return parts[name]; }).join('');
    if (content.charAt(0) === 'z') content = Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(content.slice(1)), 'application/x-gzip', 'segment.json.gz')).getDataAsString('UTF-8');
    return JSON.parse(content);
  } catch (error) { return null; }
}

function segmentCardWriteCache_(revision, snapshot, ttl, packed) {
  try {
    var cache = CacheService.getScriptCache(), key = 'segment-card/' + revision;
    var json = packed ? 'z' + packed : JSON.stringify(snapshot), size = packed ? 70000 : 20000;
    if (!packed && json.length > 80000) {
      json = 'z' + Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(json, 'application/json', 'segment.json')).getBytes());
      size = 70000;
    }
    var count = Math.ceil(json.length / size);
    if (count > 160) return;
    var batch = {};
    for (var i = 0; i < count; i++) batch[key + '/' + i] = json.slice(i * size, (i + 1) * size);
    cache.putAll(batch, ttl || 180); cache.put(key, String(count), ttl || 180);
  } catch (error) { /* A cache eviction or size limit does not affect the read. */ }
}
