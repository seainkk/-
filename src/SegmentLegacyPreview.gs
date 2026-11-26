/** Read-only comparison. No preview ticket, import, initialization or validation is needed. */
var SEGMENT_LEGACY_FIELDS = 'id,name,mimeType,parents,trashed,appProperties,version,modifiedTime';
var SEGMENT_LEGACY_FOLDER = 'application/vnd.google-apps.folder';

function segmentLegacyChildren_(folderId, mimeType) {
  var result = [], page = '', visited = new Set();
  do {
    var options = { q: "'" + id_(folderId) + "' in parents and trashed = false and mimeType = '" + mimeType + "'",
      fields: 'incompleteSearch,nextPageToken,files(' + SEGMENT_LEGACY_FIELDS + ')', pageSize: 100, spaces: 'drive',
      includeItemsFromAllDrives: true, supportsAllDrives: true };
    if (page) options.pageToken = page;
    var response = Drive.Files.list(options);
    if (!response || response.incompleteSearch || !Array.isArray(response.files)) fail_('SOURCE_CHANGED', 'Не удалось подтвердить весь список файлов папки.');
    response.files.forEach(function (file) {
      if (!file.trashed && file.mimeType === mimeType && file.parents && file.parents.length === 1 && file.parents[0] === folderId) result.push(file);
    });
    page = response.nextPageToken;
    if (result.length > 500 || page && visited.has(page)) fail_('SOURCE_LIMIT', 'Слишком много файлов для проверки старых баз.');
    visited.add(page);
  } while (page);
  return result;
}

function segmentLegacyArchives_(context, scope, warn) {
  var folder = scope.folder, name = segmentFolderName_(folder.getName()), outreach = segmentSourceFolder_(context);
  var parent = outreach.getParents();
  if (!parent.hasNext()) return [];
  var common = parent.next();
  if (parent.hasNext() || common.isTrashed() || !insideRegistry_(common, context.rootId)) return [];
  var archives = segmentLegacyChildren_(common.getId(), SEGMENT_LEGACY_FOLDER).filter(function (item) {
    return /^архив сегментов(?:\s+\d{1,2}\.\d{1,2}\.\d{4})?$/.test(segmentFolderName_(item.name));
  });
  if (!archives.length) return [];
  var active = segmentLegacyChildren_(outreach.getId(), SEGMENT_LEGACY_FOLDER).filter(function (item) { return segmentFolderName_(item.name) === name; });
  var project = registrySegmentProject_(context, folder.getId());
  if (active.length !== 1 || active[0].id !== folder.getId() || !project) {
    warn('Для поиска в архиве нужна однозначная связь сегмента с проектом.'); return [];
  }
  var found = [];
  var migrated = archives.filter(function (archive) { return segmentFolderName_(archive.name) === 'архив сегментов 20.11.2026'; });
  if (archives.length > 25) { warn('Архивных папок слишком много для однозначного поиска.'); return found; }
  archives.forEach(function (archive) {
    var matches = segmentLegacyChildren_(archive.id, SEGMENT_LEGACY_FOLDER).filter(function (item) { return segmentFolderName_(item.name) === name; });
    if (matches.length > 1) { warn('В одном архиве несколько одноимённых сегментов. Их содержимое пропущено.'); return; }
    if (!matches.length) return;
    var previous = registrySegmentProject_(context, matches[0].id);
    // Unassigned historical segment folders preceded project separation in Намшилд.
    if (previous === project || !previous && project === 'numshield' && migrated.length === 1 && archive.id === migrated[0].id) found.push(matches[0]);
  });
  return found;
}

function segmentLegacyCatalog_(context, scope, includeHistory) {
  var segmentId = scope.folder.getId(), sources = new Map(), warnings = [], history = [];
  function warn(message) { if (warnings.indexOf(message) < 0) warnings.push(message); }
  function add(file, location) {
    var tags = file.appProperties || {}, role = tags.registryPreparedRole;
    if (file.trashed || file.mimeType !== REGISTRY_CONFIG.spreadsheetMime || file.id === scope.storage.public.id ||
        tags.registrySegmentMasterSegment && (!file.parents || file.parents.indexOf(tags.registrySegmentMasterSegment) < 0) ||
        ['companies','lpr'].some(function (kind) { return scope.files[kind] && scope.files[kind].id === file.id; }) ||
        role && role !== 'output' || tags.registryPrivateRole || tags.registrySegmentImportRole || tags.registryContactRole ||
        [tags.registryContactRoot, tags.registryPreparedRoot, tags.registrySegmentMasterRoot].some(function (root) { return root && root !== context.rootId; })) return;
    sources.set(id_(file.id), { id: file.id, name: file.name, url: spreadsheetUrl_(file.id), location: location, metadata: file });
  }
  // The canonical table IDs come from the segment journal. Names alone never select a working book.
  if (scope.files.companies && scope.files.lpr) {
    segmentLegacyChildren_(segmentId, REGISTRY_CONFIG.spreadsheetMime).forEach(function (file) { add(file, 'segment'); });
  } else warn('Связь с рабочими таблицами неполная. Файлы из текущей папки не классифицированы.');
  segmentLegacyArchives_(context, scope, warn).forEach(function (folder) {
    segmentLegacyChildren_(folder.id, REGISTRY_CONFIG.spreadsheetMime).forEach(function (file) { add(file, 'archive'); });
  });
  var relations = sourceBasesReadRows_(scope.storage.relationsSheet, SOURCE_BASES_SCHEMA.relationsHeaders).rows
    .filter(function (row) { return row[1] === segmentId; });
  if (relations.length) {
    var binding = sourceBasesSource_(context);
    if (binding.state !== 'ready') warn('Папка связанных исходных баз недоступна.');
    else {
      if (relations.length > 50) warn('Показаны последние 50 связанных исходников.');
      relations.slice(-50).forEach(function (row) {
        try {
          var id = id_(row[0]), item = sourceBasesFile_(context, binding.folder, id);
          if (item.getMimeType() !== REGISTRY_CONFIG.spreadsheetMime) return;
          add(Drive.Files.get(id, { fields: SEGMENT_LEGACY_FIELDS, supportsAllDrives: true }), 'registry');
          if (includeHistory && sources.has(id)) history.push({ name: item.getName(), kind: 'Связана с сегментом', updatedAt: String(row[2] || '') });
        } catch (error) { warn('Часть ранее связанных исходников сейчас недоступна.'); }
      });
    }
  }
  if (includeHistory) {
    var tracking = scope.tracking || segmentTrackingStorage_(context, scope.storage, false);
    tracking.loads.filter(function (load) { return load.segmentId === segmentId; }).forEach(function (load) {
      var source = sources.get(load.sourceId);
      history.push({ name: source ? source.name : 'Импорт листа', kind: (load.targetKind === 'companies' ? 'Компании' : 'ЛПР') +
        (load.stage === 'complete' ? ' · завершён' : ' · в работе'), updatedAt: load.updatedAt });
    });
    var jobs;
    try { jobs = JSON.parse(context.properties.getProperty(SEGMENT_RECORD_IMPORT.indexKey) || '[]'); } catch (error) { jobs = null; }
    if (!Array.isArray(jobs) || jobs.length > SEGMENT_RECORD_IMPORT.maxJobs) warn('Журнал недавних импортов недоступен.');
    else jobs.forEach(function (id) {
      var job;
      try { job = segmentRecordsReadJob_(context, id); } catch (error) { return; }
      if (job.segmentId !== segmentId) return;
      var names = (job.sources || []).filter(function (entry) { return sources.has(entry.id); }).map(function (entry) { return entry.name || sources.get(entry.id).name; });
      history.push({ name: names.join(', ') || 'Импорт контактов', kind: job.state === 'complete' ? 'Завершён' : job.state === 'needs_review' ? 'Требует проверки' : 'В работе', updatedAt: job.completedAt || job.updatedAt || job.startedAt || '' });
    });
  }
  return { sources: sources, history: history.reverse(), warnings: warnings };
}

function segmentLegacyPublic_(file) {
  return { id: file.id, name: file.name, url: file.url, location: file.location };
}

function segmentLegacySameFiles_(before, after) {
  return ['companies','lpr'].every(function (kind) {
    var first = before.files[kind], last = after.files[kind];
    return first && last ? first.id === last.id && first.version && first.version === last.version : !!first === !!last;
  });
}

function getSegmentLegacyPreview_(request) {
  return api_(function () {
    var context = authorize_(), input = segmentInput_(request, ['segmentId','sourceId']), segmentId = id_(input.segmentId);
    registryRequireSegment_(context, segmentId);
    var scope = segmentCardFiles_(context, segmentId), catalog = segmentLegacyCatalog_(context, scope, !input.sourceId);
    var result = { segmentId: segmentId, sources: Array.from(catalog.sources.values()).map(segmentLegacyPublic_).sort(byName_),
      history: catalog.history, warnings: catalog.warnings, preview: null };
    if (!input.sourceId) return result;
    var source = catalog.sources.get(id_(input.sourceId));
    if (!source) fail_('OUTSIDE_SEGMENTS', 'Файл не входит в список исходников этого сегмента.');
    result.preview = segmentLegacyCompare_(context, scope, source);
    // Bind results to the same accessible files at both ends of a potentially long read.
    var current = authorize_();
    if (current.rootId !== context.rootId) fail_('SOURCE_CHANGED', 'Изменилась привязка реестра.');
    registryRequireSegment_(current, segmentId);
    var latest = segmentCardFiles_(current, segmentId), candidate = segmentLegacyCatalog_(current, latest, false).sources.get(source.id);
    if (!candidate || candidate.location !== source.location || !preparedVersion_(source.metadata) ||
        preparedVersion_(candidate.metadata) !== preparedVersion_(source.metadata) || !segmentLegacySameFiles_(scope, latest))
      fail_('SOURCE_CHANGED', 'Файлы изменились во время сверки. Обновите предпросмотр.');
    return result;
  });
}

function segmentLegacyBucket_() { return { rows: 0, occurrences: 0, keys: new Set(), aliases: new Set() }; }

function segmentLegacyAddRow_(bucket, values) {
  if (!values.length) return;
  bucket.rows++; bucket.occurrences += values.length;
  values.forEach(function (key) { bucket.keys.add(key); });
}

function segmentLegacyKeys_(kind, value) {
  var normalized = kind === 'email' ? preparedDataEmails_(value) : kind === 'phone' ? preparedDataPhones_(value) : preparedDataTelegrams_(value, [], true);
  return normalized.map(function (item) {
    return kind === 'telegram' ? contactSyncKey_('phone', '', item) : contactSyncKey_(kind, typeof item === 'string' ? item : item.value);
  }).filter(Boolean);
}

function segmentLegacyRoom_(sheet, budget) {
  var rows = sheet.getLastRow(), width = sheet.getLastColumn();
  if (rows > 50001 || width > 256 || rows * width > budget.cells || Date.now() >= budget.deadline) return false;
  budget.cells -= rows * width;
  return true;
}

/** Read only contact fields. A Telegram username on a phone row is an alias for that contact. */
function segmentLegacyReport_(sheet, channel, bucket, budget) {
  if (!segmentLegacyRoom_(sheet, budget)) return false;
  if (sheet.getLastRow() === 0) return true;
  var width = sheet.getLastColumn(), header = sheet.getRange(1, 1, 1, width).getDisplayValues()[0].map(pvHeader_);
  function find(labels) {
    var keys = labels.map(pvHeader_), found = [];
    header.forEach(function (label, position) { if (keys.indexOf(label) >= 0) found.push(position); });
    return found.length > 1 ? -1 : found[0];
  }
  var primary = find(channel === 'email' ? ['Email','E-mail','Почта'] : ['Телефон','Мобильный телефон','Phone','Mobile']);
  var handle = channel === 'telegram' ? find(['Telegram','Телеграм']) : undefined;
  if (primary === -1 || handle === -1) return false;
  if (primary === undefined && handle === undefined) return false;
  var columns = [primary, handle].filter(function (i) { return i !== undefined; }), left = Math.min.apply(null, columns), right = Math.max.apply(null, columns);
  var bottom = sheet.getLastRow();
  for (var start = 2; start <= bottom; start += 3000) {
    if (Date.now() >= budget.deadline) return false;
    var rows = sheet.getRange(start, left + 1, Math.min(3000, bottom - start + 1), right - left + 1).getDisplayValues();
    rows.forEach(function (row) {
      var raw = primary === undefined ? '' : row[primary - left], keys = segmentLegacyKeys_(channel === 'email' ? 'email' : 'phone', raw);
      if (channel === 'telegram') {
        var handles = segmentLegacyKeys_('telegram', handle === undefined || !row[handle - left] ? raw : row[handle - left]);
        if (keys.length) handles.forEach(function (key) { bucket.aliases.add(key); }); else keys = handles;
      }
      segmentLegacyAddRow_(bucket, keys);
    });
  }
  return true;
}

/** A recognized canonical master needs only its normalized data columns, including old directory layouts. */
function segmentLegacyMaster_(sheet, kind, budget) {
  if (!sheet || !sheet.getLastRow() || !sheet.getLastColumn() || sheet.getLastColumn() > 256) return null;
  var width = sheet.getLastColumn(), header = sheet.getRange(1, 1, 1, width).getDisplayValues()[0].map(segmentRecordsName_);
  var directoryFirst = kind === 'companies' && segmentRecordsDirectoryFirst_(header);
  var fields = segmentRecordsSchema_(kind), index = [];
  if (!fields.every(function (field) {
    var key = segmentRecordsName_(segmentRecordsFieldLabel_(field, directoryFirst)), position = header.indexOf(key);
    index.push(position); return position >= 0 && position === header.lastIndexOf(key);
  })) return null;
  if (!segmentLegacyRoom_(sheet, budget)) return { complete: false, rows: [] };
  var rows = [], bottom = sheet.getLastRow();
  for (var start = 2; start <= bottom; start += 1500) {
    if (Date.now() >= budget.deadline) return { complete: false, rows: rows };
    sheet.getRange(start, 1, Math.min(1500, bottom - start + 1), width).getDisplayValues().forEach(function (line, offset) {
      if (!index.some(function (i) { return !!line[i]; })) return;
      var record = { row: start + offset };
      fields.forEach(function (field, n) { record[field[0]] = line[index[n]]; });
      rows.push(record);
    });
  }
  return { complete: true, rows: rows };
}

function segmentLegacyMasterRecord_(row, kind, fileId, sheet) {
  var ref = { fileId: fileId, sheetId: sheet.getSheetId(), sheetName: sheet.getName(), row: row.row };
  if (kind === 'lpr') return { routeKind: kind, source: ref, company: { id: row.companyId, name: row.companyName }, people: [row] };
  return { routeKind: kind, source: ref, company: row, people: [] };
}

function segmentLegacyObserve_(collection, emails, phones, telegrams) {
  var emailKeys = [], phoneKeys = [];
  function collect(values, kind, target) {
    (Array.isArray(values) ? values : [values]).forEach(function (item) {
      if (item) target.push.apply(target, segmentLegacyKeys_(kind, typeof item === 'string' ? item : item.value));
    });
  }
  collect(emails, 'email', emailKeys); collect(phones, 'phone', phoneKeys); collect(telegrams, 'telegram', phoneKeys);
  collection.email.push(emailKeys); collection.telegram.push(phoneKeys);
}

/** The same output reports and generated owner IDs that will be saved on confirmation. */
function preparedSegmentReportKeys_(lists) {
  var occurrences = new Map();
  ['email','phone'].forEach(function (kind) {
    var report = lists[kind], headers = report.headers, primary = headers.indexOf(kind === 'email' ? 'Email' : 'Мобильный телефон');
    if (kind === 'phone' && primary < 0) primary = headers.indexOf('Телефон');
    var telegram = headers.indexOf('Telegram');
    if (primary < 0) fail_('SEGMENT_MASTER_SCHEMA', 'Не найден столбец контактов в отчёте импорта.');
    report.rows.forEach(function (line) {
      var key = contactSyncKey_(kind, line[primary], line[telegram]);
      if (key) occurrences.set(key, 1 + (occurrences.get(key) || 0));
    });
  });
  return occurrences;
}

function preparedSegmentContactKey_(field, value) {
  return field === 'telegrams' ? contactSyncKey_('phone', '', value) : contactSyncKey_(field === 'phones' ? 'phone' : 'email', value);
}

function preparedSegmentAcceptedKeys_(eligible, existing, plan) {
  var accepted = new Set();
  ['companies','lpr'].forEach(function (owner) {
    var fields = segmentRecordsSchema_(owner).map(function (field) { return field[0]; }), rows = new Map();
    existing[owner].forEach(function (row) { rows.set(row.row, segmentRecordsValues_(row, owner)); });
    (owner === 'companies' ? plan.companies : plan.people).forEach(function (action) { rows.set(action.row, action.after); });
    rows.forEach(function (line) {
      var refs = String(line[fields.indexOf('sources')] || '').split('\n');
      ['emails','phones','telegrams'].forEach(function (field) {
        var channel = field === 'emails' ? 'email' : field === 'phones' ? 'phone' : 'telegram';
        segmentRecordsList_(line[fields.indexOf(field)], channel).forEach(function (value) {
          var key = preparedSegmentContactKey_(field, value), sourceRefs = eligible[owner].get(key);
          if (sourceRefs && refs.some(function (ref) { return sourceRefs.has(ref); })) accepted.add(key);
        });
      });
    });
  });
  return accepted;
}

function preparedSegmentTally_(accepted, occurrences, current, existing) {
  ['companies','lpr'].forEach(function (owner) {
    existing[owner].forEach(function (row) {
      ['emails','phones','telegrams'].forEach(function (field) {
        var channel = field === 'emails' ? 'email' : field === 'phones' ? 'phone' : 'telegram';
        var bucket = field === 'emails' ? current.email : current.telegram;
        segmentRecordsList_(row[field], channel).forEach(function (item) { bucket.keys.add(preparedSegmentContactKey_(field, item)); });
      });
    });
  });
  var added = 0, duplicates = 0;
  accepted.forEach(function (key) {
    var bucket = key.indexOf('email:') === 0 ? current.email : current.telegram;
    var present = bucket.keys.has(key) || bucket.aliases.has(key);
    if (!present) added++;
    duplicates += occurrences.get(key) - (present ? 0 : 1);
  });
  return {contactsAdded:added,contactDuplicates:duplicates};
}

/** Reuse the actual accepted post-import plan for previously registered ready sources. */
function preparedSegmentFinalCounts_(context, targets, records, masters, plan, targetKind) {
  var eligible = {companies:new Map(),lpr:new Map()}, evidence = new Map(), occurrences = new Map();
  records.forEach(function (record) {
    var route = targetKind === 'auto' ? record.routeKind : targetKind, ref = segmentRecordsSourceLabel_(record.source);
    function collect(value, owner, provenance) {
      if (!value || route && route !== owner) return;
      ['emails','phones','telegrams'].forEach(function (field) {
        (value[field] || []).forEach(function (item) {
          var key = preparedSegmentContactKey_(field, item); if (!key) return;
          if (!eligible[owner].has(key)) eligible[owner].set(key,new Set());
          eligible[owner].get(key).add(ref);
          if (!evidence.has(key)) evidence.set(key,new Set());
          var cells = provenance && provenance[field] && provenance[field][item] || [];
          if (cells.length) cells.forEach(function (cell) { evidence.get(key).add(ref + '|' + cell.column); });
          else evidence.get(key).add(ref);
        });
      });
    }
    collect(record.general,'companies',record.provenance);
    (record.people || []).forEach(function (person) { collect(person,'lpr',person.provenance); });
  });
  evidence.forEach(function (cells,key) { occurrences.set(key,cells.size); });
  var existing = {companies:masters.companies.records,lpr:masters.lpr.records}, accepted = preparedSegmentAcceptedKeys_(eligible,existing,plan);
  var current = {email:segmentLegacyBucket_(),telegram:segmentLegacyBucket_()}, deadline = Date.now() + 40000;
  for (var i = 0; i < 2; i++) {
    var kind = i ? 'lpr' : 'companies', id = targets.tables[kind]; if (!id) continue;
    var metadata = segmentRecordsTargetGuard_(context,targets.folder,id).metadata, files = {};
    files[kind] = {id:id,metadata:metadata};
    var tabs = segmentCardTabs_(context,{files:files},kind), tags = metadata.appProperties || {}, quota = {cells:600000,deadline:deadline};
    var uncertain = ['email','telegram'].some(function (channel) {
      if (!tabs[channel]) return !!(tags.registryContactStateId || tags[channel === 'email' ? 'registryContactEmailSheetId' : 'registryContactPhoneSheetId'] !== undefined);
      return !segmentLegacyReport_(tabs[channel],channel,current[channel],quota);
    });
    var after = segmentRecordsTargetGuard_(context,targets.folder,id).metadata;
    if (uncertain || String(after.version || after.modifiedTime || '') !== String(metadata.version || metadata.modifiedTime || '')) return {};
  }
  return preparedSegmentTally_(accepted,occurrences,current,existing);
}

function preparedSegmentDelta_(context, model, comparison, draft, working) {
  var input = segmentInput_(comparison, ['segmentId','newSegment','targetKind']);
  var kind = draft.routeMode === 'auto' ? 'auto' : draft.section;
  if (input.targetKind !== kind || ['companies','lpr','auto'].indexOf(kind) < 0 ||
      input.segmentId !== undefined && input.newSegment !== undefined || input.segmentId === undefined && input.newSegment !== true)
    fail_('INVALID_REQUEST', 'Укажите одно назначение, соответствующее типу импорта.');
  var segmentId = input.segmentId === undefined ? null : id_(input.segmentId);
  if (segmentId) registryRequireSegment_(context, segmentId);
  function unavailable(reason) { return {available:false, reason:reason}; }
  if (!model.complete || !Array.isArray(model.records)) return unavailable('Исходник прочитан частично. Повторите предпросмотр после полного чтения.');
  var deadline = Date.now() + 60000;
  try {
    var existing = {companies:[],lpr:[]}, current = {email:segmentLegacyBucket_(),telegram:segmentLegacyBucket_()}, scope;
    if (segmentId) {
      scope = segmentCardFiles_(context, segmentId);
      var warnings = [], target = segmentLegacyWorking_(context, scope, deadline, function (message) { warnings.push(message); });
      if (warnings.length) return unavailable(warnings[0]);
      existing = target.existing; current = target.working;
    }
    if (Date.now() >= deadline) return unavailable('Google Таблицы не успели вернуть рабочие листы. Повторите предпросмотр.');
    var reports = preparedSegmentReportKeys_(working || model), routes = new Map();
    (model.sourceSheets || []).forEach(function (leaf) { routes.set(leaf.sheetId, leaf.section); });
    var eligible = {companies:new Map(),lpr:new Map()};
    var records = model.records.map(function (record) {
      var ref = record.source, role = kind === 'auto' ? routes.get(ref.sheetId) : kind;
      if (role !== 'companies' && role !== 'lpr') fail_('SEGMENT_MASTER_SCHEMA', 'Не удалось определить назначение одного из исходных листов.');
      var ids = working && working.sourceIds && working.sourceIds.get(ref.sheetId), personIds = working && working.personIds && working.personIds.get(ref.sheetId);
      function fields(value, owner) {
        var copy = Object.assign({}, value);
        ['emails','phones','telegrams'].forEach(function (field) {
          copy[field] = (copy[field] || []).filter(function (value) {
            var key = preparedSegmentContactKey_(field, value);
            if (!key || !reports.has(key)) return false;
            if (owner === role) {
              var refs = eligible[owner].get(key);
              if (!refs) { refs = new Set(); eligible[owner].set(key, refs); }
              refs.add(segmentRecordsSourceLabel_(ref));
            }
            return true;
          });
        });
        return copy;
      }
      var company = Object.assign({}, record.company);
      if (!company.id && ids) company.id = ids[ref.row-1];
      var people = (record.people || []).map(function (person) { return fields(person, 'lpr'); });
      if (people.length === 1 && !people[0].id && personIds) people[0].id = personIds[ref.row-1];
      return Object.assign({}, record, {routeKind:role, company:company, general:fields(record.general, 'companies'), people:people});
    });
    var plan = segmentRecordsPlanner_({records:records, companies:existing.companies, people:existing.lpr, targetKind:kind});
    var accepted = preparedSegmentAcceptedKeys_(eligible, existing, plan);
    // Reports may already have collapsed repeated contacts at preparation time.
    var review = plan.counts.review;
    (model.contactIndex || []).forEach(function (entry) {
      var key = entry.type === 'telegram' ? contactSyncKey_('phone', '', entry.value) : contactSyncKey_(entry.type, entry.value);
      if (!accepted.has(key)) return;
      if (entry.needsReview) review++;
      reports.set(key, Math.max(reports.get(key), (entry.sourceRefs || []).length));
    });
    var totals = preparedSegmentTally_(accepted,reports,current,existing);
    if (segmentId) {
      var fresh = authorize_();
      if (fresh.rootId !== context.rootId) fail_('OUTSIDE_REGISTRY', 'Привязка реестра изменилась.');
      if (!segmentLegacySameFiles_(scope, segmentCardFiles_(fresh, segmentId))) return unavailable('Рабочие таблицы изменились во время сверки. Пересчитайте предпросмотр.');
    }
    return {available:true, companiesAdded:plan.counts.companiesAdded, companiesUpdated:plan.counts.companiesUpdated,
      peopleAdded:plan.counts.peopleAdded, peopleUpdated:plan.counts.peopleUpdated, contactsAdded:totals.contactsAdded, contactDuplicates:totals.contactDuplicates, review:review};
  } catch (error) {
    if (error.registryCode && /OUTSIDE|UNAUTHORIZED|INVALID_REQUEST|FORBIDDEN|ACCESS|GRID_PROTECTED|PROTECTED_FILE/.test(error.registryCode)) throw error;
    return unavailable('Не удалось полностью сопоставить записи с рабочими листами. Проверьте доступ к таблицам и повторите предпросмотр.');
  }
}

function segmentLegacyWorking_(context, scope, deadline, warn) {
  var channels = ['email','telegram'], kinds = ['companies','lpr'];
  var working = { email: segmentLegacyBucket_(), telegram: segmentLegacyBucket_() }, known = {email:true,telegram:true};
  var existing = { companies: [], lpr: [] }, entitiesKnown = true;
  kinds.forEach(function (kind) {
    var file = scope.files[kind];
    if (!file) {
      entitiesKnown = false;
      channels.forEach(function (channel) { known[channel] = false; });
      warn('К сегменту привязаны не обе рабочие таблицы.'); return;
    }
    var tabs = segmentCardTabs_(context, scope, kind), quota = { cells:600000, deadline:deadline };
    channels.forEach(function (channel) {
      if (!tabs[channel] || !segmentLegacyReport_(tabs[channel], channel, working[channel], quota)) {
        known[channel] = false; warn('Один из рабочих контактных листов недоступен для полной сверки.');
      }
    });
    var book = SpreadsheetApp.openById(file.id), tags = file.metadata.appProperties || {};
    var master = tags.registrySegmentMasterSheetId === undefined ? book.getSheetByName(kind === 'companies' ? 'Компании' : 'ЛПР') : segmentFindSheet_(book, Number(tags.registrySegmentMasterSheetId));
    var read = segmentLegacyMaster_(master, kind, quota);
    if (read && read.complete) existing[kind] = read.rows;
    else { entitiesKnown = false; warn('Строки рабочего справочника не удалось полностью сопоставить.'); }
  });
  return { working:working, known:known, existing:existing, entitiesKnown:entitiesKnown };
}

function segmentLegacyCompare_(context, scope, source) {
  var channels = ['email','telegram'], warnings = [], complete = true, deadline = Date.now() + 70000;
  function warn(message) { complete = false; if (warnings.indexOf(message) < 0) warnings.push(message); }
  var current = segmentLegacyWorking_(context, scope, deadline, warn);
  var working = current.working, known = current.known, existing = current.existing, entitiesKnown = current.entitiesKnown;
  var old = { email: segmentLegacyBucket_(), telegram: segmentLegacyBucket_() }, observations = { email: [], telegram: [] };
  var records = [], hasEntitySource = false;
  var book = SpreadsheetApp.openById(source.id), tags = source.metadata.appProperties || {}, quota = { cells:600000, deadline:deadline };
  var sheets = book.getSheets(), scanned = 0;
  if (sheets.length > 50) warn('Прочитаны только первые 50 листов старой базы.');
  sheets.slice(0, 50).forEach(function (sheet) {
    if (!sheet.getLastRow()) return;
    var name = segmentFolderName_(sheet.getName()), gid = String(sheet.getSheetId());
    var channel = gid === String(tags.registryContactEmailSheetId) || /^(?:e[ -]?mails?|почты|почта)$/.test(name) ? 'email' :
      gid === String(tags.registryContactPhoneSheetId) || /^(?:телефоны|telegram|телеграм|phones?)$/.test(name) ? 'telegram' : '';
    if (channel) {
      scanned++;
      if (!segmentLegacyReport_(sheet, channel, old[channel], quota)) warn('Контактный лист «' + sheet.getName() + '» прочитан не полностью.');
      return;
    }
    // Statistics, validation logs and mailing sheets must never become prospect lists.
    var kind = preparedAutoRoute_(sheet, tags);
    if (!kind) { warn('Лист «' + sheet.getName() + '» пропущен: наполнение не распознано как компании или ЛПР.'); return; }
    scanned++; hasEntitySource = true;
    var canonical = segmentLegacyMaster_(sheet, kind, quota);
    if (canonical) {
      if (!canonical.complete) { entitiesKnown = false; warn('Лист «' + sheet.getName() + '» прочитан не полностью.'); }
      canonical.rows.forEach(function (row) {
        records.push(segmentLegacyMasterRecord_(row, kind, source.id, sheet));
        segmentLegacyObserve_(observations, row.emails, row.phones, row.telegrams);
      });
      return;
    }
    if (!segmentLegacyRoom_(sheet, quota)) { entitiesKnown = false; warn('Исходный лист превышает лимит предпросмотра.'); return; }
    var model = preparedDataRead_(sheet, source.id, kind, { deadline: deadline, sectionExplicit: true, routeKind: kind });
    if (!model.complete) { entitiesKnown = false; warn('Исходный лист прочитан частично.'); }
    model.observations.forEach(function (row) { segmentLegacyObserve_(observations, row.emails, row.phones, row.telegrams); });
    model.records.forEach(function (row) { row.routeKind = kind; records.push(row); });
  });
  if (!scanned) warn('В этой книге не найдены листы с распознаваемыми контактами.');
  var counts = {};
  channels.forEach(function (channel) {
    var sourceSet = old[channel], reported = new Set(sourceSet.keys), added = 0, matched = 0;
    // Contact reports and masters often reflect the same rows. Count the report once,
    // then include only addresses unique to the underlying master.
    observations[channel].forEach(function (keys) {
      segmentLegacyAddRow_(sourceSet, keys.filter(function (key) { return !reported.has(key) && !sourceSet.aliases.has(key); }));
    });
    sourceSet.keys.forEach(function (key) { if (working[channel].keys.has(key) || working[channel].aliases.has(key)) matched++; else added++; });
    counts[channel] = { rows: sourceSet.rows, unique: sourceSet.keys.size, duplicates: sourceSet.occurrences - sourceSet.keys.size,
      existing: known[channel] ? matched : null, added: known[channel] ? added : null };
  });
  var entities = { companies:null, people:null, additions:null, ambiguous:null };
  if (entitiesKnown && hasEntitySource && records.length + existing.companies.length + existing.lpr.length <= 10000 && Date.now() < deadline) {
    var plan = segmentRecordsPlanner_({ records: records, companies: existing.companies, people: existing.lpr, targetKind: 'auto' });
    entities = { companies:plan.counts.companiesAdded, people:plan.counts.peopleAdded,
      additions:plan.counts.companiesUpdated + plan.counts.peopleUpdated, ambiguous:plan.counts.review };
  } else if (hasEntitySource && entitiesKnown) warn('Число строк или время проверки превышает лимит сопоставления компаний и ЛПР.');
  return { source: segmentLegacyPublic_(source), complete: complete, channels: counts, entities: entities, warnings: warnings };
}
