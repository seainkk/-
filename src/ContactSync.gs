/**
 * Incremental, append-only contact lists. Source data and user-added status
 * columns are never rewritten. Durable receipts make an uncertain append
 * recoverable in the same exact range rather than by appending it again.
 */
var CONTACT_SYNC = Object.freeze({
  version: 1, folderProperty: 'CONTACT_SYNC_FOLDER_ID',
  fields: 'id,name,mimeType,parents,trashed,appProperties,version,modifiedTime,capabilities(canEdit,canAddChildren)',
  stateProperty: 'registryContactStateId', mailingStatusProperty: 'registryContactMailingStatusTargets', leaseMillis: 10 * 60 * 1000,
  releaseGuardMillis: 60 * 1000, sourceReadMillis: 120000, writeRows: 1000, maxTargetRows: 100000,
  maxHeaderColumns: 512, maxStateCharacters: 12000000, receiptLimit: 20
});

function getContactWorkspace_(request) {
  return api_(function () {
    var input = contactSyncInput_(request, ['id', 'prepareMailingStatus', 'prepareNewContactStatuses']), scope = gridFile_(input.id, false);
    if (input.prepareMailingStatus !== undefined && typeof input.prepareMailingStatus !== 'boolean') fail_('INVALID_REQUEST', 'Некорректный запрос подготовки статусов контактов.');
    if (input.prepareNewContactStatuses !== undefined && typeof input.prepareNewContactStatuses !== 'boolean') fail_('INVALID_REQUEST', 'Некорректный запрос подготовки новых контактов.');
    var metadata = contactSyncMetadata_(input.id);
    var state = contactSyncReadState_(scope.context, metadata, true), legacy, result, migrated = null;
    if (!state) {
      var book = SpreadsheetApp.openById(input.id);
      legacy = contactSyncLegacy_(book, metadata);
    }
    var prepareMissing = input.prepareMailingStatus && contactSyncMailingStatusNeeded_(metadata.appProperties || {});
    if (scope.canEdit && state && (input.prepareNewContactStatuses || !state.job && prepareMissing)) {
      migrated = contactSyncWithLease_(input.id, function (claim) {
        return contactSyncPrepareManagedMailingStatus_(claim, input.prepareNewContactStatuses === true);
      }, false, {activeJobError:'CONTACT_SYNC_JOB_ACTIVE'});
      if (migrated) {
        state = migrated;
        metadata = contactSyncMetadata_(input.id);
      }
    }
    if (state) {
      gridFile_(input.id, false, scope.context.rootId);
      result = contactSyncWorkspace_(state, scope.canEdit, contactSyncVersion_(metadata));
    }
    else result = { enrolled: false, canSync: scope.canEdit === true, targets: legacy ? legacy.targets : null,
      sourceSheetIds: legacy ? legacy.sourceSheetIds : book.getSheets().map(function (s) { return s.getSheetId(); }),
      role: 'registry', relatedFileId: null, lastSyncAt: null, job: null, warnings: [] };
    if (input.prepareMailingStatus || input.prepareNewContactStatuses) result.mailingStatusChanged = !!migrated;
    return result;
  });
}

function syncWorkbookContacts_(request) {
  return api_(function () {
    var input = contactSyncInput_(request, ['id', 'requestId']); contactSyncRequestId_(input.requestId);
    return contactSyncWithLease_(input.id, function (claim) {
      var state = claim.state, old = contactSyncReceipt_(state, input.requestId);
      if (old && old.status === 'complete') return contactSyncResponse_(state, old, true);
      if (state.job && state.job.requestId !== input.requestId && !state.job.error) return contactSyncProcessing_(state);
      if (state.job && state.job.requestId !== input.requestId) {
        // An old plan may already have appended rows. Settle its exact pending
        // range before a new source snapshot is permitted to supersede it.
        contactSyncSupersedeJob_(claim);
      }
      if (!state.job) contactSyncPlan_(claim, input.requestId);
      return contactSyncAdvance_(claim);
    }, true);
  });
}

function continueContactSync_(request) {
  return api_(function () {
    var input = contactSyncInput_(request, ['id', 'jobId', 'requestId']); contactSyncRequestId_(input.requestId);
    if (typeof input.jobId !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(input.jobId)) fail_('INVALID_REQUEST', 'Некорректный номер обновления контактов.');
    return contactSyncWithLease_(input.id, function (claim) {
      var state = claim.state, old = contactSyncReceipt_(state, input.requestId);
      if (old && old.status === 'complete' && old.jobId === input.jobId) return contactSyncResponse_(state, old, true);
      if (!state.job || state.job.id !== input.jobId || state.job.requestId !== input.requestId) fail_('CONTACT_SYNC_JOB_MISSING', 'Обновление контактов не найдено. Запустите проверку новых контактов ещё раз.');
      return contactSyncAdvance_(claim);
    }, false);
  });
}

function contactSyncSupersedeJob_(claim) {
  var state = claim.state;
  contactSyncRecoverPending_(claim, false);
  contactSyncRemember_(state, state.job.requestId, { status: 'superseded', jobId: state.job.id });
  state.job = null; contactSyncSaveState_(claim.context, state);
}

// A previously started file sync may still own a pending append. Settle one
// step under the file lease before taking a snapshot of the imported master.
function contactSyncAdvancePrevious_(claim) {
  if (!claim.state.job.error) {
    try { contactSyncAdvance_(claim); return; }
    catch (error) { if (!error || error.registryCode !== 'CONTACT_SOURCE_CHANGED') throw error; }
  }
  contactSyncSupersedeJob_(claim);
}

function contactSyncSegmentImportStep_(fileId, kind, segmentId, requestId) {
  return contactSyncWithLease_(fileId, function (claim) {
    var state = claim.state, role = kind === 'companies' ? 'segment-companies' : 'segment-lpr';
    if (state.role !== role || state.segmentId !== segmentId) fail_('SEGMENT_MASTER_CHANGED', 'Привязка контактов к сегменту изменилась.');
    claim.importSegmentId = segmentId; contactSyncCheckSegmentParent_(claim, claim.metadata);
    var receipt = contactSyncReceipt_(state, requestId);
    if (receipt && receipt.status === 'complete') return true;
    try {
      if (state.job && state.job.requestId !== requestId) { contactSyncAdvancePrevious_(claim); return false; }
      if (!state.job) contactSyncPlan_(claim, requestId, true);
      return contactSyncAdvance_(claim).state === 'complete';
    } catch (error) {
      if (error && error.registryCode === 'CONTACT_SNAPSHOT_BUSY') return false;
      throw error;
    }
  }, false);
}

/** Called only by an already-authorized import/segment operation. */
function enrollContactWorkbook_(context, fileId, options) {
  options = options || {};
  var scope = gridFile_(id_(fileId), true, context && context.rootId);
  // Segment previews enroll the same books repeatedly. An unchanged, seeded
  // enrollment needs neither a write lease nor another scan of contact rows.
  // Keep the private-state and ancestry checks fresh before taking this path.
  var metadata = contactSyncMetadata_(fileId), inspected = {};
  var existing = contactSyncReadState_(scope.context, metadata, true, inspected);
  if (contactSyncEnrollmentMatches_(existing, metadata, inspected.metadata, options)) {
    var book = SpreadsheetApp.openById(fileId);
    if (contactSyncEnrollmentSheetsMatch_(existing, book)) {
      gridFile_(fileId, false, scope.context.rootId);
      return contactSyncWorkspace_(existing, true, contactSyncVersion_(metadata));
    }
  }
  return contactSyncWithLease_(fileId, function (claim) {
    var state = claim.state, changed = false;
    if (state.job) return contactSyncWorkspace_(state, true);
    if (options.sourceSheetIds) {
      var ids = contactSyncSheetIds_(options.sourceSheetIds);
      if (JSON.stringify(ids) !== JSON.stringify(state.sourceSheetIds)) { state.sourceSheetIds = ids; changed = true; }
      state.sourceMode = options.sourceMode === 'all' ? 'all' : 'fixed';
    }
    ['role', 'section', 'segmentId', 'relatedFileId'].forEach(function (name) {
      if (options[name] !== undefined) { state[name] = contactSyncOption_(name, options[name]); changed = true; }
    });
    contactSyncEnsureTargets_(claim, options);
    if (!state.seeded || options.seedExisting === true) {
      var current = contactSyncReadTargets_(claim);
      state.known = contactSyncUnion_(state.known, Object.keys(current.hashes)); state.seeded = true; changed = true;
    }
    if (changed) contactSyncSaveState_(claim.context, state);
    gridFile_(fileId, false, scope.context.rootId);
    return contactSyncWorkspace_(state, true);
  }, true, options);
}

function contactSyncEnrollmentMatches_(state, metadata, privateMetadata, options) {
  if (!state || !state.seeded || state.job || state.lease || !state.targets || !state.schemas || Object.keys(state.targetAttempts || {}).length) return false;
  var tags = metadata.appProperties || {}, privateTags = privateMetadata && privateMetadata.appProperties || {};
  var accessHash = typeof SHARED_REQUEST_SCOPE_ !== 'undefined' && SHARED_REQUEST_SCOPE_ ? SHARED_REQUEST_SCOPE_.keyHash : '';
  if (privateTags.registryContactAccessHash !== accessHash || privateTags.registryContactBookRole !== (state.role || 'registry') ||
      privateTags.registryContactSection !== (state.section || 'companies') || privateTags.registryContactRelatedFileId !== (state.relatedFileId || '')) return false;
  if (state.sourceMode !== 'all' && state.sourceMode !== 'fixed') return false;
  if (options.sourceSheetIds) {
    if (JSON.stringify(contactSyncSheetIds_(options.sourceSheetIds)) !== JSON.stringify(state.sourceSheetIds) ||
        state.sourceMode !== (options.sourceMode === 'all' ? 'all' : 'fixed')) return false;
  }
  if (['role', 'section', 'segmentId', 'relatedFileId'].some(function (name) {
    return options[name] !== undefined && contactSyncOption_(name, options[name]) !== state[name];
  })) return false;
  return ['email', 'phone'].every(function (kind) {
    var property = kind + 'SheetId', target = state.targets[property];
    if (!Number.isSafeInteger(target) || target < 0 || tags['registryContact' + (kind === 'email' ? 'Email' : 'Phone') + 'SheetId'] !== String(target)) return false;
    return options[property] === undefined || gridSheetId_(options[property]) === target;
  });
}

function contactSyncEnrollmentSheetsMatch_(state, book) {
  var sheets = book.getSheets(), ids = sheets.map(function (sheet) { return sheet.getSheetId(); });
  var targets = [state.targets.emailSheetId, state.targets.phoneSheetId];
  if (targets[0] === targets[1] || targets.some(function (id) { return ids.indexOf(id) === -1; }) || !Array.isArray(state.sourceSheetIds) ||
      state.sourceSheetIds.some(function (id) { return !Number.isSafeInteger(id) || id < 0 || targets.indexOf(id) !== -1; })) return false;
  var sources = state.sourceMode === 'all' ? ids.filter(function (id) { return targets.indexOf(id) === -1; }) : state.sourceSheetIds;
  if (!sources.length || sources.some(function (id) { return ids.indexOf(id) === -1; })) return false;
  return ['email', 'phone'].every(function (kind) {
    var required = contactSyncHeaders_(kind, state), schema = state.schemas[kind];
    if (!schema || !schema.columns || JSON.stringify(schema.headers) !== JSON.stringify(required)) return false;
    var sheet = sheets[ids.indexOf(state.targets[kind + 'SheetId'])], width = sheet.getLastColumn();
    if (!width || width > CONTACT_SYNC.maxHeaderColumns) return false;
    var header = sheet.getRange(1, 1, 1, width).getDisplayValues()[0].map(contactSyncHeaderKey_);
    return required.every(function (label) {
      var columns = contactSyncHeaderColumns_(header, label);
      return columns.length === 1 && schema.columns[label] === columns[0];
    });
  });
}

/** Metadata-only enrollment enumeration for the single owner-installed worker. */
function contactSyncListEnrollments_(context, pageToken, limit) {
  var current = authorize_(); if (context && context.rootId !== current.rootId) fail_('SOURCE_CHANGED', 'Привязка реестра изменилась.');
  var folderId = current.properties.getProperty(CONTACT_SYNC.folderProperty);
  if (!folderId) return { items: [], nextPageToken: null };
  contactSyncFolder_(current, folderId);
  var query = "trashed = false and '" + folderId + "' in parents and appProperties has { key='registryContactRole' and value='state' }";
  var args = { q: query, fields: 'files(' + CONTACT_SYNC.fields + '),nextPageToken', pageSize: limit || 100, orderBy: 'name', supportsAllDrives: true, includeItemsFromAllDrives: true };
  if (pageToken) { if (typeof pageToken !== 'string' || pageToken.length > 4000) fail_('INVALID_REQUEST', 'Некорректная страница списка контактов.'); args.pageToken = pageToken; }
  var result = Drive.Files.list(args), items = [];
  (result.files || []).forEach(function (file) {
    var tags = file.appProperties || {};
    if (!contactSyncOwnFile_(file, current, 'state') || !tags.registryContactFileId) return;
    items.push({ fileId: id_(tags.registryContactFileId), id: tags.registryContactFileId, stateFileId: id_(file.id), accessHash: tags.registryContactAccessHash || '', role: tags.registryContactBookRole || 'registry',
      relatedFileId: tags.registryContactRelatedFileId || null, section: tags.registryContactSection || 'companies', lastObservedVersion: tags.registryContactObservedVersion || '', dirty: tags.registryContactDirty === '1' });
  });
  return { items: items, nextPageToken: result.nextPageToken || null };
}
function listContactWorkspacesForAutomation_(context, options) {
  options = options || {}; var limit = options.limit === undefined ? 50 : options.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail_('INVALID_REQUEST', 'Некорректный размер списка обновлений.');
  var found = contactSyncListEnrollments_(context, options.cursor || null, limit);
  return { items: found.items, nextCursor: found.nextPageToken };
}
function markContactWorkbookDirty_(fileId) {
  var scope = gridFile_(id_(fileId), true), metadata = contactSyncMetadata_(fileId), state = contactSyncReadState_(scope.context, metadata, true);
  if (!state) return { enrolled: false };
  gridFile_(fileId, true, scope.context.rootId);
  Drive.Files.update({ appProperties: { registryContactDirty: '1' } }, state.stateFileId, null, { fields: 'id', supportsAllDrives: true });
  return { enrolled: true, dirty: true };
}

function contactSyncInput_(request, fields) {
  authorize_(); var input = object_(request);
  if (Object.keys(input).some(function (name) { return fields.indexOf(name) === -1; })) fail_('INVALID_REQUEST', 'В запросе контактов есть неизвестные поля.');
  id_(input.id); return input;
}
function contactSyncRequestId_(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) fail_('INVALID_REQUEST', 'Некорректный идентификатор проверки контактов.'); return value; }
function contactSyncSheetIds_(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(function (id) { return !Number.isSafeInteger(id) || id < 0; })) fail_('CONTACT_SOURCE_MISSING', 'Нужно выбрать исходные листы.');
  return value.filter(function (id, index) { return value.indexOf(id) === index; });
}
function contactSyncOption_(name, value) {
  if (name === 'section') { if (['companies', 'lpr'].indexOf(value) === -1) fail_('INVALID_REQUEST', 'Неизвестный раздел контактов.'); return value; }
  if (name === 'role') { if (['registry', 'segment-companies', 'segment-lpr'].indexOf(value) === -1) fail_('INVALID_REQUEST', 'Неизвестная роль базы.'); return value; }
  return value === null || value === '' ? '' : id_(value);
}
function contactSyncMetadata_(id) { return Drive.Files.get(id_(id), { fields: CONTACT_SYNC.fields, supportsAllDrives: true }); }
function contactSyncVersion_(file) { return String(file.version || file.modifiedTime || ''); }
function contactSyncTags_(context, kind, fileId) {
  var tags = { registryContactRole: kind, registryContactRoot: context.rootId };
  if (fileId) tags.registryContactFileId = fileId;
  return tags;
}
function contactSyncOwnFile_(file, context, role) {
  var tags = file && file.appProperties || {};
  return !!file && !file.trashed && tags.registryContactRole === role && tags.registryContactRoot === context.rootId;
}

function contactSyncEnsureFolder_(context) {
  var id = context.properties.getProperty(CONTACT_SYNC.folderProperty);
  if (id) return contactSyncFolder_(context, id);
  var q = "trashed = false and '" + context.rootId + "' in parents and appProperties has { key='registryContactRole' and value='folder' }";
  var found = Drive.Files.list({ q: q, fields: 'files(' + CONTACT_SYNC.fields + '),nextPageToken', pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true });
  if (found.nextPageToken || (found.files || []).length > 1) fail_('CONTACT_STORAGE_UNCERTAIN', 'Найдено несколько служебных папок контактов.');
  var file = (found.files || [])[0];
  if (!file) {
    try { file = Drive.Files.create({ name: '_Служебные данные контактов', mimeType: 'application/vnd.google-apps.folder', parents: [context.rootId], appProperties: contactSyncTags_(context, 'folder') }, null, { fields: CONTACT_SYNC.fields, supportsAllDrives: true }); }
    catch (error) {
      found = Drive.Files.list({ q: q, fields: 'files(' + CONTACT_SYNC.fields + '),nextPageToken', pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true });
      if (found.nextPageToken || (found.files || []).length !== 1) fail_('CONTACT_STORAGE_UNCERTAIN', 'Google не подтвердил служебную папку контактов. Повторите проверку.');
      file = found.files[0];
    }
  }
  var folder = contactSyncFolder_(context, file.id); context.properties.setProperty(CONTACT_SYNC.folderProperty, folder.id); return folder;
}
function contactSyncFolder_(context, id) {
  var current = authorize_(); if (current.rootId !== context.rootId) fail_('SOURCE_CHANGED', 'Привязка реестра изменилась.');
  var file = contactSyncMetadata_(id);
  if (!contactSyncOwnFile_(file, current, 'folder') || file.mimeType !== 'application/vnd.google-apps.folder' || (file.parents || []).length !== 1 || file.parents[0] !== current.rootId) fail_('OUTSIDE_REGISTRY', 'Служебная папка контактов перемещена или недоступна.');
  var source = sourceBasesSource_(current), outreach = current.properties.getProperty('SEGMENTS_FOLDER_ID') || REGISTRY_CONFIG.defaultSegmentsFolderId;
  if ((source.state === 'ready' && source.source.id === file.id) || outreach === file.id || file.id === current.rootId) fail_('OUTSIDE_REGISTRY', 'Служебные данные контактов должны храниться отдельно от рабочих баз.');
  return file;
}
function contactSyncReadState_(context, bookMetadata, optional, inspected) {
  var tags = bookMetadata.appProperties || {}, id = tags[CONTACT_SYNC.stateProperty];
  if (!id) { if (optional) return null; fail_('CONTACT_SYNC_NOT_ENROLLED', 'Сначала запустите проверку новых контактов.'); }
  if (tags.registryContactRoot !== context.rootId) fail_('OUTSIDE_REGISTRY', 'Настройки контактов относятся к другому реестру.');
  var file = contactSyncMetadata_(id), folderId = context.properties.getProperty(CONTACT_SYNC.folderProperty);
  if (!folderId) fail_('CONTACT_STORAGE_MISSING', 'Не найдена служебная папка контактов.');
  contactSyncFolder_(context, folderId);
  if (!contactSyncOwnFile_(file, context, 'state') || file.mimeType !== 'application/json' || file.appProperties.registryContactFileId !== bookMetadata.id || (file.parents || []).length !== 1 || file.parents[0] !== folderId) fail_('OUTSIDE_REGISTRY', 'Служебное состояние контактов перемещено или не принадлежит базе.');
  var text = DriveApp.getFileById(file.id).getBlob().getDataAsString('UTF-8'), state;
  if (text.length > CONTACT_SYNC.maxStateCharacters) fail_('CONTACT_SYNC_LIMIT', 'Слишком большой журнал контактов.');
  try { state = JSON.parse(text); } catch (error) { fail_('CONTACT_STORAGE_DAMAGED', 'Журнал контактов повреждён.'); }
  if (!state || state.version !== CONTACT_SYNC.version || state.rootId !== context.rootId || state.fileId !== bookMetadata.id || state.stateFileId !== file.id || !Array.isArray(state.known) || !Array.isArray(state.receipts)) fail_('CONTACT_STORAGE_DAMAGED', 'Журнал контактов не соответствует базе.');
  state.dirty = state.dirty === true || file.appProperties.registryContactDirty === '1';
  if (inspected) inspected.metadata = file;
  return state;
}
function contactSyncSaveState_(context, state, claimingLease) {
  var current = authorize_(); if (current.rootId !== state.rootId || current.rootId !== context.rootId) fail_('SOURCE_CHANGED', 'Привязка реестра изменилась.');
  var file = contactSyncMetadata_(state.stateFileId), folderId = current.properties.getProperty(CONTACT_SYNC.folderProperty);
  contactSyncFolder_(current, folderId);
  if (!contactSyncOwnFile_(file, current, 'state') || file.appProperties.registryContactFileId !== state.fileId || (file.parents || []).length !== 1 || file.parents[0] !== folderId) fail_('OUTSIDE_REGISTRY', 'Служебный журнал контактов перемещён.');
  if (state.lease && !claimingLease) {
    var remote; try { remote = JSON.parse(DriveApp.getFileById(state.stateFileId).getBlob().getDataAsString('UTF-8')); } catch (error) { fail_('CONTACT_STORAGE_DAMAGED', 'Журнал контактов повреждён.'); }
    if (!remote || !remote.lease || remote.lease.id !== state.lease.id || remote.lease.until <= Date.now()) fail_('CONTACT_SYNC_LEASE_LOST', 'Обновление контактов уже выполняется в другом запросе.');
  }
  var text = JSON.stringify(state); if (text.length > CONTACT_SYNC.maxStateCharacters) fail_('CONTACT_SYNC_LIMIT', 'Слишком большой журнал контактов. Разделите исходную базу.');
  var tags = contactSyncTags_(current, 'state', state.fileId);
  tags.registryContactAccessHash = typeof SHARED_REQUEST_SCOPE_ !== 'undefined' && SHARED_REQUEST_SCOPE_ ? SHARED_REQUEST_SCOPE_.keyHash : '';
  tags.registryContactBookRole = state.role || 'registry';
  tags.registryContactRelatedFileId = state.relatedFileId || '';
  tags.registryContactSection = state.section || 'companies';
  tags.registryContactObservedVersion = String(state.lastObservedVersion || '').slice(0, 120);
  tags.registryContactDirty = state.dirty ? '1' : '0';
  Drive.Files.update({ appProperties: tags }, state.stateFileId, Utilities.newBlob(text, 'application/json', 'contacts.json'), { fields: CONTACT_SYNC.fields, supportsAllDrives: true });
}
function contactSyncCreateState_(scope, book, metadata, options) {
  options = options || {}; var context = scope.context, legacy = contactSyncLegacy_(book, metadata), folder = contactSyncEnsureFolder_(context), tags = metadata.appProperties || {};
  // Recover a state-file creation whose acknowledgement was lost, before any
  // second file is created. The exact root + workbook tags are authoritative.
  var q = "trashed = false and '" + folder.id + "' in parents and appProperties has { key='registryContactRole' and value='state' } and appProperties has { key='registryContactFileId' and value='" + metadata.id + "' }";
  var recovered = Drive.Files.list({ q: q, fields: 'files(' + CONTACT_SYNC.fields + '),nextPageToken', pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true });
  if (recovered.nextPageToken || (recovered.files || []).length > 1) fail_('CONTACT_STORAGE_UNCERTAIN', 'У базы несколько неподтверждённых журналов контактов.');
  var state = { version: CONTACT_SYNC.version, rootId: context.rootId, fileId: metadata.id, stateFileId: '', section: options.section || tags.registryPreparedSection || 'companies',
    role: options.role || 'registry', segmentId: options.segmentId || '', relatedFileId: options.relatedFileId || '',
    sourceMode: options.sourceMode === 'all' || (!options.sourceSheetIds && !legacy) ? 'all' : 'fixed',
    sourceSheetIds: options.sourceSheetIds ? contactSyncSheetIds_(options.sourceSheetIds) : legacy ? legacy.sourceSheetIds : book.getSheets().map(function (sheet) { return sheet.getSheetId(); }),
    targets: { emailSheetId: options.emailSheetId !== undefined ? options.emailSheetId : legacy ? legacy.targets.emailSheetId : null, phoneSheetId: options.phoneSheetId !== undefined ? options.phoneSheetId : legacy ? legacy.targets.phoneSheetId : null },
    schemas: {}, targetAttempts: {}, known: [], receipts: [], job: null, seeded: false, lastSyncAt: null, lastFingerprint: '', warnings: legacy && !legacy.workingSelection ? ['Первое обновление включает ранее не распознанные контакты; история ручных удалений до подключения ещё неизвестна.'] : [] };
  if (legacy && legacy.workingSelection) { state.workingSelection = true; state.selectionBaselinePending = true; }
  contactSyncOption_('section', state.section); contactSyncOption_('role', state.role);
  var file = (recovered.files || [])[0];
  if (state.role === 'segment-companies' && (state.targets.emailSheetId == null || tags.registryCompanyEmailSchema === '2')) state.companyEmailSchema = 2;
  if (file) {
    var previousText = DriveApp.getFileById(file.id).getBlob().getDataAsString('UTF-8'), previous;
    try { previous = JSON.parse(previousText); } catch (error) { fail_('CONTACT_STORAGE_DAMAGED', 'Неподтверждённый журнал контактов повреждён.'); }
    if (!previous || previous.fileId !== metadata.id || previous.rootId !== context.rootId || previous.version !== CONTACT_SYNC.version) fail_('OUTSIDE_REGISTRY', 'Неподтверждённый журнал относится к другой базе.');
    state = previous; state.stateFileId = file.id;
  } else {
    var draftTags = contactSyncTags_(context, 'state', metadata.id), body = JSON.stringify(state);
    try { file = Drive.Files.create({ name: '.contacts-' + metadata.id + '.json', mimeType: 'application/json', parents: [folder.id], appProperties: draftTags }, Utilities.newBlob(body, 'application/json', 'contacts.json'), { fields: CONTACT_SYNC.fields, supportsAllDrives: true }); }
    catch (error) { fail_('CONTACT_STORAGE_UNCERTAIN', 'Google не подтвердил создание журнала контактов. Повторите тот же запрос.'); }
    state.stateFileId = id_(file.id);
  }
  contactSyncSaveState_(context, state);
  var pointer = {}; pointer[CONTACT_SYNC.stateProperty] = state.stateFileId; pointer.registryContactRoot = context.rootId;
  Drive.Files.update({ appProperties: pointer }, metadata.id, null, { fields: CONTACT_SYNC.fields, supportsAllDrives: true });
  return state;
}
function contactSyncLegacy_(book, metadata) {
  var tags = metadata.appProperties || {};
  if (!tags.registryPreparedRoot && !tags.registryContactRoot) return workingSelectionTargets_(book.getSheets());
  if (tags.registryPreparedRoot !== (authorize_().rootId) || tags.registryPreparedRole !== 'output' || !/^[12]$/.test(String(tags.registryPreparedVersion || ''))) return null;
  var original = Number(tags.registryPreparedOriginalSheetId), sheets = book.getSheets(), source = sheets.filter(function (sheet) { return sheet.getSheetId() === original; })[0];
  var v2 = tags.registryPreparedVersion === '2';
  if (!source && !v2) fail_('CONTACT_SOURCE_MISSING', 'Исходный лист подготовленной базы удалён. Восстановите его перед обновлением контактов.');
  if (v2 && (tags.registryContactEmailSheetId === undefined || tags.registryContactPhoneSheetId === undefined)) fail_('CONTACT_SCHEMA_CHANGED', 'Не найдены идентификаторы отдельных списков контактов подготовленной книги.');
  var emailId = tags.registryContactEmailSheetId !== undefined ? Number(tags.registryContactEmailSheetId) : null;
  var phoneId = tags.registryContactPhoneSheetId !== undefined ? Number(tags.registryContactPhoneSheetId) : null;
  if ((emailId !== null && (!Number.isSafeInteger(emailId) || emailId < 0)) || (phoneId !== null && (!Number.isSafeInteger(phoneId) || phoneId < 0)) || (emailId !== null && phoneId !== null && emailId === phoneId)) fail_('CONTACT_SCHEMA_CHANGED', 'Некорректные идентификаторы списков контактов.');
  var email = emailId !== null ? sheets.filter(function (s) { return s.getSheetId() === emailId; })[0] : book.getSheetByName('Email');
  var phone = phoneId !== null ? sheets.filter(function (s) { return s.getSheetId() === phoneId; })[0] : book.getSheetByName('Телефоны');
  if ((email && email.getSheetId() === original) || (phone && phone.getSheetId() === original) || (email && phone && email.getSheetId() === phone.getSheetId())) fail_('CONTACT_SCHEMA_CHANGED', 'Исходный лист не может быть отдельным списком контактов.');
  var ids = v2 ? sheets.map(function (s) { return s.getSheetId(); }).filter(function (id) { return id !== emailId && id !== phoneId; }) : [original];
  if (!ids.length) fail_('CONTACT_SOURCE_MISSING', 'В подготовленной книге не осталось исходных листов.');
  var selection = v2 && workingSelectionTargets_(sheets);
  if (selection && selection.targets.emailSheetId === emailId && selection.targets.phoneSheetId === phoneId) return selection;
  return { sourceSheetIds: ids, targets: { emailSheetId: email ? email.getSheetId() : null, phoneSheetId: phone ? phone.getSheetId() : null } };
}

function contactSyncWithLease_(fileId, callback, create, options) {
  var scope = gridFile_(fileId, true), claim = locked_(function () {
    var fresh = gridFile_(fileId, true, scope.context.rootId), book = SpreadsheetApp.openById(fileId), metadata = contactSyncMetadata_(fileId);
    var state = contactSyncReadState_(fresh.context, metadata, true);
    if (!state) { if (!create) fail_('CONTACT_SYNC_NOT_ENROLLED', 'Сначала запустите проверку новых контактов.'); state = contactSyncCreateState_(fresh, book, metadata, options); }
    var activeJobError = options && options.activeJobError;
    if (state.job && (activeJobError === 'BUSY' || activeJobError === 'CONTACT_SYNC_JOB_ACTIVE'))
      fail_(activeJobError, 'Дождитесь окончания текущего обновления контактов этой таблицы.');
    if (state.lease && state.lease.until > Date.now()) fail_('BUSY', 'Контакты этой базы уже обновляются. Повторите через несколько секунд.');
    state.lease = { id: Utilities.getUuid(), until: Date.now() + CONTACT_SYNC.leaseMillis };
    contactSyncSaveState_(fresh.context, state, true);
    return { context: fresh.context, state: state, book: book, metadata: metadata, leaseId: state.lease.id };
  });
  try { return callback(claim); }
  catch (error) {
    if (claim.state.job) {
      claim.state.job.error = error && error.registryCode ? error.registryCode : 'GOOGLE_ERROR';
      try { contactSyncSaveState_(claim.context, claim.state); } catch (ignored) { /* Preserve the original failure. */ }
    }
    throw error;
  } finally { contactSyncRelease_(claim); }
}
function contactSyncRelease_(claim) {
  try {
    var metadata = contactSyncMetadata_(claim.state.fileId), latest = contactSyncReadState_(claim.context, metadata, false);
    if (!latest.lease || latest.lease.id !== claim.leaseId) return;
    if (latest.lease.until <= Date.now() + CONTACT_SYNC.releaseGuardMillis) {
      var lock = LockService.getScriptLock(); if (!lock.tryLock(100)) return;
      try {
        latest = contactSyncReadState_(claim.context, contactSyncMetadata_(claim.state.fileId), false);
        if (!latest.lease || latest.lease.id !== claim.leaseId) return;
        delete latest.lease; contactSyncSaveState_(claim.context, latest);
      } finally { lock.releaseLock(); }
    } else { delete latest.lease; contactSyncSaveState_(claim.context, latest); }
  } catch (error) { console.warn('Contact synchronization lease could not be safely released.'); }
}
function contactSyncAssertLease_(claim) {
  var metadata = contactSyncMetadata_(claim.state.fileId), latest = contactSyncReadState_(claim.context, metadata, false);
  contactSyncCheckSegmentParent_(claim, metadata);
  if (!latest.lease || latest.lease.id !== claim.leaseId || latest.lease.until <= Date.now()) fail_('CONTACT_SYNC_LEASE_LOST', 'Обновление контактов уже выполняется в другом запросе.');
}

function contactSyncCheckSegmentParent_(claim, metadata) {
  var state = claim.state, segmentId = claim.importSegmentId || (state.job && state.job.importOnly && state.segmentId);
  if (segmentId && (metadata.parents || []).indexOf(segmentId) === -1) fail_('SEGMENT_MASTER_CHANGED', 'Рабочая таблица перемещена из папки сегмента.');
}

function contactSyncHeaders_(kind, state) {
  var base = typeof PREPARED_DATA_HEADERS !== 'undefined' ? PREPARED_DATA_HEADERS[kind] :
    (kind === 'email' ? ['Email', 'Компания / ЛПР', 'Исходные строки', 'Проверить принадлежность'] : ['Телефон', 'Компания / ЛПР', 'Откуда', 'Исходные строки', 'Проверить принадлежность', 'Telegram', 'Тип контакта']);
  var headers = base.concat(CONTACT_MAILING_STATUS.header);
  if (kind === 'email') headers.push('Исходный столбец email');
  headers = headers.concat(WORKING_CONTACT_COLUMNS[kind].filter(function (label) { return headers.indexOf(label) < 0; }));
  if (state && (state.role === 'segment-companies' || state.role === 'segment-lpr')) {
    headers = WORKING_CONTACT_COLUMNS[kind].concat(headers.filter(function (label) { return WORKING_CONTACT_COLUMNS[kind].indexOf(label) < 0; }));
    if (state.workingHistoryEnabled || state.workingHistory) ['Валидация', 'Дата проверки', 'Результат проверки', 'Валидатор', 'Статус из источника', 'История контакта'].forEach(function (label) {
      if (headers.indexOf(label) < 0) headers.push(label);
    });
    if ((state.workingHistoryEnabled || state.workingHistory) && kind === 'phone' && headers.indexOf('Для Telegram') < 0) headers.push('Для Telegram');
  }
  if (kind === 'email' && state && state.companyEmailSchema === 2) {
    var front = ['ID компании','Почт на компанию','Email','Комментарий',CONTACT_MAILING_STATUS.header,'Провайдер','Результат проверки'];
    return front.concat(headers.filter(function (label) { return front.indexOf(label) < 0; }));
  }
  return headers;
}
function contactSyncEnsureTargets_(claim, options) {
  options = options || {}; var state = claim.state, book = claim.book, changed = false;
  var tags = contactSyncMetadata_(state.fileId).appProperties || {}, stamp = contactSyncMailingTargetsStamp_(state.targets);
  var statusPrepared = !!stamp && tags[CONTACT_SYNC.mailingStatusProperty] === stamp &&
    tags.registryContactEmailSheetId === String(state.targets.emailSheetId) &&
    tags.registryContactPhoneSheetId === String(state.targets.phoneSheetId);
  ['email', 'phone'].forEach(function (kind) {
    var property = kind + 'SheetId';
    if (options[property] !== undefined) {
      gridSheetId_(options[property]);
      if (state.targets[property] !== null && state.targets[property] !== options[property]) fail_('CONTACT_SCHEMA_CHANGED', 'Нельзя автоматически заменить уже подключённый лист контактов.');
      state.targets[property] = options[property];
    }
    var sheet = state.targets[property] !== null && state.targets[property] !== undefined ? gridSheet_(book, state.targets[property]) : null;
    if (!sheet) {
      var attempt = state.targetAttempts[kind];
      if (!attempt) {
        var preferred = kind === 'email' ? 'Email' : state.companyEmailSchema === 2 ? 'Телеграм' : 'Телефоны', name = preferred, suffix = 1;
        while (book.getSheetByName(name)) { name = preferred + ' — контакты' + (suffix > 1 ? ' ' + suffix : ''); suffix++; }
        attempt = { name: name, before: book.getSheets().map(function (s) { return s.getSheetId(); }) }; state.targetAttempts[kind] = attempt; contactSyncSaveState_(claim.context, state);
      } else {
        var found = book.getSheetByName(attempt.name);
        if (found) {
          if (attempt.before.indexOf(found.getSheetId()) !== -1 || found.getLastRow() !== 0) fail_('CONTACT_STORAGE_UNCERTAIN', 'Не удалось подтвердить новый лист контактов. Проверьте его в Google Таблицах.');
          sheet = found;
        }
      }
      if (!sheet) {
        gridFile_(state.fileId, true, state.rootId);
        contactSyncAssertLease_(claim);
        try { sheet = book.insertSheet(attempt.name); }
        catch (error) { fail_('CONTACT_STORAGE_UNCERTAIN', 'Google не подтвердил создание листа контактов. Повторите тот же запрос.'); }
      }
      state.targets[property] = sheet.getSheetId(); delete state.targetAttempts[kind]; changed = true;
      contactSyncSaveState_(claim.context, state);
    }
    if (state.sourceSheetIds.indexOf(sheet.getSheetId()) !== -1 || (kind === 'phone' && sheet.getSheetId() === state.targets.emailSheetId)) fail_('CONTACT_SCHEMA_CHANGED', 'Исходные данные и списки контактов должны находиться на разных листах.');
    var previous = state.schemas[kind], schema = contactSyncEnsureHeaders_(claim, sheet, kind, previous);
    if (!previous && kind === 'email' && state.companyEmailSchema === 2 && sheet.getLastRow() === 1 && sheet.getMaxRows() > 1) {
      gridFile_(state.fileId, true, state.rootId); contactSyncAssertLease_(claim);
      contactMailingStatusDropdown_(sheet.getRange(2, schema.columns[CONTACT_MAILING_STATUS.header] + 1, sheet.getMaxRows() - 1, 1), true, null, true);
    }
    if (!statusPrepared || options.prepareNewContactStatuses) contactSyncBackfillMailingStatus_(claim, sheet, kind, schema, statusPrepared);
    state.schemas[kind] = schema; changed = true;
  });
  var pointer = {};
  if (state.companyEmailSchema === 2 && tags.registryCompanyEmailSchema !== '2') pointer.registryCompanyEmailSchema = '2';
  if (tags.registryContactEmailSheetId !== String(state.targets.emailSheetId)) pointer.registryContactEmailSheetId = String(state.targets.emailSheetId);
  if (tags.registryContactPhoneSheetId !== String(state.targets.phoneSheetId)) pointer.registryContactPhoneSheetId = String(state.targets.phoneSheetId);
  if (!statusPrepared) pointer[CONTACT_SYNC.mailingStatusProperty] = contactSyncMailingTargetsStamp_(state.targets);
  if (Object.keys(pointer).length) contactSyncRememberMailingStatus_(claim, pointer);
  if (changed) contactSyncSaveState_(claim.context, state);
}
function contactSyncHeaderKey_(value) { return String(value || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/[\s_-]+/g, ' '); }
function contactSyncHeaderColumns_(keys, label) {
  var aliases = { 'Результат проверки': 'Результат валидации', 'Телефон': 'Мобильный телефон', 'Компания / ЛПР': 'Компания', 'Исходные строки': 'Строки в Лист1' };
  var names = label === CONTACT_MAILING_STATUS.header ? CONTACT_MAILING_STATUS.headers : aliases[label] ? [label, aliases[label]] : [label];
  for (var i = 0; i < names.length; i++) {
    var key = contactSyncHeaderKey_(names[i]), columns = [];
    keys.forEach(function (value, index) { if (value === key) columns.push(index); });
    if (columns.length) return columns;
  }
  return [];
}
function contactSyncMailingTargetsStamp_(targets) {
  if (!targets || !Number.isSafeInteger(targets.emailSheetId) || targets.emailSheetId < 0 ||
      !Number.isSafeInteger(targets.phoneSheetId) || targets.phoneSheetId < 0 || targets.emailSheetId === targets.phoneSheetId) return '';
  return '1:' + targets.emailSheetId + ':' + targets.phoneSheetId;
}
function contactSyncMailingStatusNeeded_(tags) {
  if (!tags || !tags[CONTACT_SYNC.stateProperty]) return false;
  if (!/^\d+$/.test(tags.registryContactEmailSheetId || '') || !/^\d+$/.test(tags.registryContactPhoneSheetId || '')) return false;
  var stamp = contactSyncMailingTargetsStamp_({ emailSheetId: Number(tags.registryContactEmailSheetId), phoneSheetId: Number(tags.registryContactPhoneSheetId) });
  return !!stamp && tags[CONTACT_SYNC.mailingStatusProperty] !== stamp;
}
function contactSyncRememberMailingStatus_(claim, pointer) {
  var state = claim.state;
  gridFile_(state.fileId, true, state.rootId); contactSyncAssertLease_(claim);
  Drive.Files.update({ appProperties: pointer }, state.fileId, null, { fields: 'id', supportsAllDrives: true });
}
function contactSyncMailingLayouts_(book, workspace) {
  if (!contactSyncMailingTargetsStamp_(workspace.targets)) return null;
  var kinds = ['email', 'phone'], layouts = [];
  // Validate both known targets before writing either of the contact tabs.
  // In a legacy v1 book the names alone are not sufficient evidence.
  for (var i = 0; i < kinds.length; i++) {
    var kind = kinds[i], id = workspace.targets[kind + 'SheetId'];
    if (workspace.sourceSheetIds.indexOf(id) !== -1) return null;
    var sheet = gridSheet_(book, id), width = sheet.getLastColumn();
    if (!width || width > CONTACT_SYNC.maxHeaderColumns || sheet.getLastRow() > CONTACT_SYNC.maxTargetRows + 1) return null;
    var header = sheet.getRange(1, 1, 1, width).getDisplayValues()[0].map(contactSyncHeaderKey_);
    var main = kind === 'email' ? 'Email' : 'Телефон', allowed = contactSyncHeaderColumns_(header, main);
    var telegram = kind === 'phone' ? contactSyncHeaderColumns_(header, 'Telegram') : [];
    var status = contactSyncHeaderColumns_(header, CONTACT_MAILING_STATUS.header);
    if (allowed.length !== 1 || telegram.length > 1 || status.length > 1 || !status.length && width === CONTACT_SYNC.maxHeaderColumns) return null;
    var columns = {};
    columns[main] = allowed[0]; columns.Telegram = telegram[0];
    columns[CONTACT_MAILING_STATUS.header] = status.length ? status[0] : width;
    layouts.push({ kind: kind, sheet: sheet, columns: columns, addStatus: !status.length, header: header });
  }
  return layouts;
}
function contactSyncPrepareManagedMailingStatus_(claim, includeManual) {
  var state = claim.state, tags = contactSyncMetadata_(state.fileId).appProperties || {};
  var stamp = contactSyncMailingTargetsStamp_(state.targets);
  var prepared = stamp && tags[CONTACT_SYNC.mailingStatusProperty] === stamp;
  if (state.job || !stamp || prepared && !includeManual) return null;
  var layouts = contactSyncMailingLayouts_(claim.book, state);
  if (!layouts) return null;
  var changed = false;
  layouts.forEach(function (schema) {
    var sheet = schema.sheet;
    if (schema.addStatus) {
      var column = schema.columns[CONTACT_MAILING_STATUS.header] + 1;
      gridFile_(state.fileId, true, state.rootId); contactSyncAssertLease_(claim);
      var current = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(contactSyncHeaderKey_);
      if (JSON.stringify(current) !== JSON.stringify(schema.header)) fail_('CONTACT_SCHEMA_CHANGED', 'Заголовки списка изменились во время подготовки статусов. Откройте таблицу заново.');
      if (column > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), 1);
      sheetWriteRawStrings_(state.fileId, sheet.getSheetId(), 1, column, [[CONTACT_MAILING_STATUS.header]]);
    }
    if (contactSyncBackfillMailingStatus_(claim, sheet, schema.kind, schema, !!prepared)) changed = true;
  });
  if (prepared) return changed ? state : null;
  var pointer = { registryContactEmailSheetId: String(state.targets.emailSheetId), registryContactPhoneSheetId: String(state.targets.phoneSheetId) };
  pointer[CONTACT_SYNC.mailingStatusProperty] = stamp;
  contactSyncRememberMailingStatus_(claim, pointer);
  return state;
}
function contactSyncEnsureHeaders_(claim, sheet, kind, previous) {
  var width = Math.max(0, sheet.getLastColumn()), required = contactSyncHeaders_(kind, claim.state);
  if (width > CONTACT_SYNC.maxHeaderColumns) fail_('CONTACT_SYNC_LIMIT', 'В листе контактов слишком много столбцов.');
  var header = width ? sheet.getRange(1, 1, 1, width).getDisplayValues()[0] : [], keys = header.map(contactSyncHeaderKey_), mapping = {}, additions = [];
  required.forEach(function (label) {
    var positions = contactSyncHeaderColumns_(keys, label);
    if (positions.length > 1) fail_('CONTACT_SCHEMA_CHANGED', 'В листе контактов повторяется заголовок «' + label + '».');
    if (positions.length) mapping[label] = positions[0];
    else {
      if (previous && previous.columns && previous.columns[label] !== undefined) fail_('CONTACT_SCHEMA_CHANGED', 'Заголовок «' + label + '» изменён. Восстановите его перед обновлением контактов.');
      var physical = label;
      if (kind === 'email' && claim.state.companyEmailSchema === 2) {
        if (label === CONTACT_MAILING_STATUS.header) physical = 'Статус';
        if (label === 'Результат проверки') physical = 'Результат валидации';
      }
      mapping[label] = header.length; header.push(physical); additions.push({ column: header.length, label: physical });
    }
  });
  if (header.length > CONTACT_SYNC.maxHeaderColumns) fail_('CONTACT_SYNC_LIMIT', 'В листе контактов слишком много столбцов.');
  var companyActions = kind === 'email' && claim.state.companyEmailSchema === 2, linkVersion = companyActions ? 2 : 1;
  if (!previous || !(previous.validationLinkVersion >= linkVersion)) contactSyncAddValidationLink_(claim, sheet, header, additions, companyActions);
  if (header.length > sheet.getMaxColumns()) {
    gridFile_(claim.state.fileId, true, claim.state.rootId); contactSyncAssertLease_(claim);
    sheet.insertColumnsAfter(sheet.getMaxColumns(), header.length - sheet.getMaxColumns());
  }
  if (additions.length) {
    gridFile_(claim.state.fileId, true, claim.state.rootId);
    contactSyncAssertLease_(claim);
    sheetWriteRawStrings_(claim.state.fileId, sheet.getSheetId(), 1, additions[0].column, [additions.map(function (entry) { return entry.label; })],
      null,[additions.map(function (entry) { return entry.link || ''; })]);
  }
  if (additions.length && typeof sheet.setFrozenRows === 'function') { gridFile_(claim.state.fileId, true, claim.state.rootId); contactSyncAssertLease_(claim); sheet.setFrozenRows(1); }
  return { headers: required, columns: mapping, validationLinkVersion: linkVersion };
}

function contactSyncAddValidationLink_(claim, sheet, header, additions, companyActions) {
  var prefix = 'https://seainkk.github.io/-/?validate=', link = prefix + encodeURIComponent(claim.state.fileId);
  if (!companyActions) { add('Проверить новые контакты', link); return; }
  var parents = contactSyncMetadata_(claim.state.fileId).parents || [];
  var project = parents.length === 1 ? registrySegmentProject_(claim.context, parents[0]) : null;
  var projectQuery = project ? '&project=' + encodeURIComponent(project) : '';
  add('Проверить новые email в Promouser', link + '&action=email' + projectQuery);
  add('Загрузить готовые контакты в рассылку', link + '&action=mailing' + projectQuery);

  function add(base, link) {
    var label = base;
    for (var suffix = 2; header.indexOf(label) >= 0; suffix++) {
      var index = header.indexOf(label), cell = sheet.getRange(1, index + 1);
      var version = contactSyncVersion_(contactSyncMetadata_(claim.state.fileId));
      if (cell.getDisplayValues()[0][0] !== label) fail_('BUSY', 'Заголовок листа изменился. Повторите подключение таблицы.');
      var rich = cell.getRichTextValues()[0][0], uri = rich && rich.getLinkUrl();
      var hasPartialLink = !uri && rich && rich.getRuns().some(function (run) { return !!run.getLinkUrl(); });
      var serviceLink = uri && uri.indexOf(prefix) === 0 && /^[A-Za-z0-9_-]{10,200}(?:&action=(?:email|mailing)(?:&project=(?:numshield|neosender))?)?$/.test(uri.slice(prefix.length));
      if (header.lastIndexOf(label) === index && !cell.getFormulas()[0][0] && (serviceLink || !uri && !hasPartialLink)) {
        if (uri !== link) {
          gridFile_(claim.state.fileId, true, claim.state.rootId); contactSyncAssertLease_(claim);
          if (version !== contactSyncVersion_(contactSyncMetadata_(claim.state.fileId))) fail_('BUSY', 'Заголовок листа изменился. Повторите подключение таблицы.');
          sheetWriteRawStrings_(claim.state.fileId, sheet.getSheetId(), 1, index + 1, [[label]], null, [[link]]);
        }
        return;
      }
      label = base + ' (' + suffix + ')';
    }
    if (header.length < CONTACT_SYNC.maxHeaderColumns) {
      header.push(label);
      additions.push({column: header.length, label: label, link: link});
    } else if (companyActions) {
      fail_('CONTACT_SYNC_LIMIT', 'В листе Email недостаточно свободных столбцов для действий.');
    }
  }
}

function contactSyncBackfillMailingStatus_(claim, sheet, kind, schema, manualOnly) {
  var state = claim.state, columns = schema.columns, statusColumn = columns[CONTACT_MAILING_STATUS.header] + 1;
  var mainLabel = kind === 'email' ? 'Email' : 'Телефон', mainColumn = columns[mainLabel] + 1, telegramColumn = kind === 'phone' ? columns.Telegram + 1 : null;
  var last = sheet.getLastRow(), headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(contactSyncHeaderKey_);
  function assertHeader(live) {
    var labels = [mainLabel,CONTACT_MAILING_STATUS.header];
    if (telegramColumn) labels.push('Telegram');
    if (labels.some(function (label) { var matches = contactSyncHeaderColumns_(live,label); return matches.length !== 1 || matches[0] !== columns[label]; }) ||
        JSON.stringify(live) !== JSON.stringify(headers))
      fail_('CONTACT_SCHEMA_CHANGED','Столбцы списка контактов изменились. Перечитайте таблицу перед заполнением статусов.');
  }
  assertHeader(headers);
  var historyColumns = contactSyncHeaderColumns_(headers, 'Статус из источника'), changed = false, lastPreparedRow = 0;
  var protectedColumns = headers.map(function (name,index) {
    return /^(?:валидация|дата проверки|результат проверки|результат валидации|провайдер|валидатор|проверка coldy|заказ promouser|история контакта|для telegram|id tg|nickname tg|active days ago)$|^coldy[: ·]/.test(name) ? index : -1;
  }).filter(function (index) {return index >= 0;});
  var known = manualOnly && new Set(state.known || []);
  if (last > CONTACT_SYNC.maxTargetRows + 1) fail_('CONTACT_SYNC_LIMIT', 'Список контактов превышает лимит обновления.');
  for (var row = 2; row <= last; row += CONTACT_SYNC.writeRows) {
    var count = Math.min(CONTACT_SYNC.writeRows, last - row + 1);
    var status = sheet.getRange(row, statusColumn, count, 1);
    if (manualOnly && status.getValues().every(function (line) { return line[0] !== ''; })) continue;
    var version = contactSyncVersion_(contactSyncMetadata_(state.fileId)), values = status.getValues(), formulas = status.getFormulas();
    if (values.every(function(line,i) { return line[0] !== '' || formulas[i][0]; })) continue;
    var main = sheet.getRange(row, mainColumn, count, 1).getDisplayValues();
    var telegram = telegramColumn ? sheet.getRange(row, telegramColumn, count, 1).getDisplayValues() : [];
    var history = historyColumns.length === 1 ? sheet.getRange(row, historyColumns[0] + 1, count, 1).getDisplayValues() : [];
    var ownerCol = kind === 'email' && state.companyEmailSchema === 2 ? contactSyncHeaderColumns_(headers,'ID компании')[0] : undefined;
    var owners = ownerCol === undefined ? [] : sheet.getRange(row,ownerCol+1,count,1).getDisplayValues();
    var mask = main.map(function (line, index) {
      if (values[index][0] !== '' || formulas[index][0]) return [false];
      var keys = contactSyncRowKeys_(kind, line[0], telegram[index] && telegram[index][0]);
      return [keys.length > 0 && !(known && keys.some(function (key) { return known.has(contactSyncOwnerHash_(key,owners[index] && owners[index][0])) || state.workingHistory && state.workingHistory[key]; }))];
    });
    if (!mask.some(function (line) { return line[0]; })) continue;
    var defaults = mask.map(function (line, index) {
      var value = line[0] ? contactMailingStatusFromHistory_(history[index] && history[index][0]) : '';
      return [value && kind === 'email' && state.companyEmailSchema === 2 ? companyEmailWorkflowStatus_(value) : value];
    });
    protectedColumns.forEach(function (column) {
      var range = sheet.getRange(row, column + 1, count, 1), evidence = range.getDisplayValues();
      var notes = headers[column] === 'валидация' ? range.getNotes() : null;
      mask.forEach(function (line,i) {
        if (defaults[i][0] === CONTACT_MAILING_STATUS.initial && (evidence[i][0] || notes && notes[i][0])) line[0] = false;
      });
    });
    if (!mask.some(function (line) { return line[0]; })) continue;
    gridFile_(state.fileId, true, state.rootId); contactSyncAssertLease_(claim);
    assertHeader(sheet.getRange(1,1,1,sheet.getLastColumn()).getDisplayValues()[0].map(contactSyncHeaderKey_));
    if (version && version !== contactSyncVersion_(contactSyncMetadata_(state.fileId))) {
      fail_('CONTACT_SYNC_CONFLICT', 'Список контактов изменился во время заполнения статусов. Повторите обновление.');
    }
    // Older prepared workbooks have a strict dropdown on future rows. Upgrade that rule before writing the new label.
    if (contactMailingStatusDropdown_(status,true,mask,kind === 'email' && state.companyEmailSchema === 2)) {
      if (lastPreparedRow === row) fail_('CONTACT_SYNC_CONFLICT','Правила рабочего статуса меняются. Повторите проверку.');
      SpreadsheetApp.flush(); lastPreparedRow = row; row -= CONTACT_SYNC.writeRows; continue;
    }
    gridFile_(state.fileId, true, state.rootId); contactSyncAssertLease_(claim);
    if (version && version !== contactSyncVersion_(contactSyncMetadata_(state.fileId))) fail_('CONTACT_SYNC_CONFLICT','Контакты изменились во время подготовки статусов. Повторите проверку.');
    sheetWriteRawStrings_(state.fileId, sheet.getSheetId(), row, statusColumn, defaults, mask);
    changed = true;
  }
  if (last > 1 && !manualOnly) {
    gridFile_(state.fileId, true, state.rootId); contactSyncAssertLease_(claim);
    contactMailingStatusDropdown_(sheet.getRange(2, statusColumn, last - 1, 1), true, null, kind === 'email' && state.companyEmailSchema === 2);
  }
  return changed;
}
function contactSyncSources_(state, book) {
  var managed = [state.targets.emailSheetId, state.targets.phoneSheetId], ids = state.sourceMode === 'all' ? book.getSheets().map(function (s) { return s.getSheetId(); }).filter(function (id) { return managed.indexOf(id) === -1; }) : state.sourceSheetIds.slice();
  if (!ids.length || ids.some(function (id) { return managed.indexOf(id) !== -1; })) fail_('CONTACT_SOURCE_MISSING', 'Не найден исходный лист базы.');
  ids.forEach(function (id) { gridSheet_(book, id); }); return ids;
}
function contactSyncReadTargets_(claim) {
  var state = claim.state, answer = { hashes: Object.create(null), email: null, phone: null, duplicates: 0, invalid: 0 };
  ['email', 'phone'].forEach(function (kind) {
    var sheet = gridSheet_(claim.book, state.targets[kind + 'SheetId']), schema = state.schemas[kind], last = sheet.getLastRow();
    if (last > CONTACT_SYNC.maxTargetRows + 1) fail_('CONTACT_SYNC_LIMIT', 'Список контактов превышает лимит обновления.');
    var count = Math.max(0, last - 1), first = schema.columns[kind === 'email' ? 'Email' : 'Телефон'], extra = kind === 'phone' ? schema.columns.Telegram : null;
    var main = count ? sheet.getRange(2, first + 1, count, 1).getDisplayValues() : [];
    var tg = kind === 'phone' && count && extra !== undefined ? sheet.getRange(2, extra + 1, count, 1).getDisplayValues() : [];
    var owners = state.companyEmailSchema === 2 && kind === 'email' && count ?
      sheet.getRange(2, schema.columns['ID компании'] + 1, count, 1).getDisplayValues() : [];
    var keys = Object.create(null), hashes = Object.create(null);
    for (var i = 0; i < count; i++) {
      var rowKeys = contactSyncRowKeys_(kind, main[i][0], tg[i] && tg[i][0]);
      if (!rowKeys.length) { if (String(main[i][0] || '').trim() || (tg[i] && String(tg[i][0] || '').trim())) answer.invalid++; continue; }
      rowKeys.forEach(function (key) {
        var hash = contactSyncOwnerHash_(key, owners[i] && owners[i][0]);
        if (hashes[hash]) answer.duplicates++;
        keys[key] = i + 2; hashes[hash] = true; answer.hashes[hash] = true;
      });
    }
    answer[kind] = { keys: keys, hashes: hashes, lastRow: last, sheet: sheet, schema: schema };
  });
  return answer;
}
function contactSyncOwnerHash_(key, id) {
  return digest_(id ? JSON.stringify(['company-email',String(id),key]) : key);
}

function contactSyncKey_(kind, value, telegram) {
  var text = String(value === null || value === undefined ? '' : value).trim();
  if (kind === 'email') {
    text = text.replace(/^mailto:/i, '').toLowerCase();
    return /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(text) ? 'email:' + text : '';
  }
  if (text) {
    var number = text.replace(/[()\s.-]/g, '');
    if (/^8\d{10}$/.test(number)) number = '+7' + number.slice(1);
    else if (/^7\d{10}$/.test(number)) number = '+' + number;
    if (/^\+?\d{7,15}$/.test(number)) return 'phone:' + number.replace(/^\+/, '');
    var local = contactLocalPhone_(text);
    if (local) return 'local-phone:' + local;
    if (!telegram) telegram = text;
  }
  var username = String(telegram || '').trim().replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i, '').replace(/^@/, '');
  return /^[A-Za-z0-9_]{4,32}$/.test(username) && /[A-Za-z]/.test(username) ? 'telegram:' + username.toLowerCase() : '';
}
function contactSyncRowKeys_(kind, value, telegram) {
  var key = contactSyncKey_(kind, value, telegram), keys = key ? [key] : [];
  if (kind === 'phone' && telegram) { var handle = contactSyncKey_('phone', '', telegram); if (handle && keys.indexOf(handle) === -1) keys.push(handle); }
  return keys;
}
function contactSyncStableModel_(claim) {
  var state = claim.state, ids = contactSyncSources_(state, claim.book), before = contactSyncMetadata_(state.fileId), deadline = Date.now() + CONTACT_SYNC.sourceReadMillis;
  for (var attempt = 0; attempt < 2; attempt++) {
    if (attempt) before = contactSyncMetadata_(state.fileId);
    var sheetRoutes = {};
    if (state.role === 'registry' && (before.appProperties || {}).registryRoutes0) ids.forEach(function (id) {
      var kind = preparedSavedRoute_(before.appProperties, id);
      if (kind) sheetRoutes[id] = kind;
    });
    var model = preparedDataReadWorkbook_(claim.book, state.fileId, state.section, { sourceSheetIds: ids, sheetRoutes: sheetRoutes, mainTelegram: (before.appProperties || {}).registryMainTelegramHistory === '1', managedSheetIds: [state.targets.emailSheetId, state.targets.phoneSheetId],
      // One bounded budget for every leaf/chunk, including a source-version retry.
      deadline: deadline,
      sectionExplicit: state.sourceMode === 'fixed' && (state.role === 'segment-companies' || state.role === 'segment-lpr'),
      segmentMasterChannels: state.role === 'segment-companies' || state.role === 'segment-lpr',
      segmentMasterRequired: !!(before.appProperties && before.appProperties.registrySegmentMasterRoot === state.rootId && before.appProperties.registrySegmentMasterSheetId !== undefined),
      guard: function () { gridFile_(state.fileId, false, state.rootId); } });
    var after = contactSyncMetadata_(state.fileId);
    if (!model || model.complete !== true) fail_('CONTACT_SOURCE_INCOMPLETE', 'Исходная база прочитана не полностью. Новые контакты не записывались.');
    if (!contactSyncVersion_(before) || contactSyncVersion_(before) === contactSyncVersion_(after)) return { model: model, version: contactSyncVersion_(after), sourceSheetIds: ids };
  }
  if (claim.importSegmentId || (state.job && state.job.importOnly)) fail_('CONTACT_SNAPSHOT_BUSY', 'Таблица обновляется во время чтения. Продолжите тот же запрос.');
  fail_('CONTACT_SOURCE_CHANGED', 'Исходная база меняется во время чтения. Повторите проверку новых контактов.');
}
// Google can automatically decorate a literal URL/email or split the same link
// into styled runs after a RAW master write. Keep the cells, distinct hidden
// destinations and resulting contact-to-owner mappings in the import snapshot.
function contactSyncMasterFingerprint_(model) {
  if (!Array.isArray(model.models)) return model.fingerprint;
  var leaves = model.models.map(function (leaf) {
    var hidden = [];
    (leaf.sourceLinks || []).forEach(function (cell) {
      var visible = String(cell.text || '').split(/[\s,;]+/).filter(Boolean);
      var urls = Array.from(new Set(cell.runs.map(function (run) { return run.url; }))).sort();
      urls = urls.filter(function (url) {
        return !visible.some(function (token) {
          if (token === url) return true;
          if (/^mailto:/i.test(url)) return token.toLowerCase() === url.slice(7).toLowerCase();
          if (/^https?:\/\//i.test(token) && token + '/' === url) return true;
          return false;
        });
      });
      if (urls.length) hidden.push([cell.row, cell.column, urls]);
    });
    hidden.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    return [leaf.source.sheetId, leaf.source.name, leaf.source.headerIndex, leaf.section,
      leaf.sourceValues, leaf.sourceDisplayValues, leaf.sourceFormulas, hidden];
  });
  var contacts = (model.contactIndex || []).map(function (entry) {
    var refs = (entry.sourceRefs || []).map(function (ref) { return [ref.sheetId, ref.row, ref.column]; });
    return [entry.type, entry.value, entry.owners, entry.needsReview, refs];
  });
  return digest_(JSON.stringify([leaves, contacts]));
}

function contactSyncMatchesSnapshot_(stable, job) {
  if (JSON.stringify(stable.sourceSheetIds) !== JSON.stringify(job.sourceSheetIds)) return false;
  if (job.importMasterFingerprint) return contactSyncMasterFingerprint_(stable.model) === job.importMasterFingerprint;
  return stable.model.fingerprint === job.sourceFingerprint;
}
function contactSyncPlan_(claim, requestId, importOnly) {
  var state = claim.state; contactSyncEnsureTargets_(claim,{prepareNewContactStatuses:true});
  var existing = contactSyncReadTargets_(claim);
  if (!state.seeded) { state.known = contactSyncUnion_(state.known, Object.keys(existing.hashes)); state.seeded = true; }
  var stable = contactSyncStableModel_(claim), model = stable.model, known = contactSyncSet_(state.known), warnings = (state.warnings || []).concat(model.warnings || []);
  var groups = typeof preparedWorkingLists_ === 'function' ? preparedWorkingLists_(model) : model;
  if (state.workingSelection) groups = contactSyncSelectionChannels_(model, groups);
  if (state.role === 'segment-companies') {
    groups = contactSyncCompanyModel_({ records: model.records, email: groups.email, phone: groups.phone });
    if (state.companyEmailSchema === 2) groups.email = contactSyncCompanyEmails_(groups.email, model.records);
  }
  var counts = { addedEmail: 0, addedPhone: 0, addedTelegram: 0, existing: 0, excluded: 0, newEmail: 0, newPhone: 0, newTelegram: 0 };
  var plan = { version: 1, rootId: state.rootId, fileId: state.fileId, sourceFingerprint: model.fingerprint, sourceSheetIds: stable.sourceSheetIds, knownHashes: [], warnings: warnings, email: { rows: [] }, phone: { rows: [] } };
  var candidateHashes = Object.create(null);
  ['email', 'phone'].forEach(function (kind) {
    var group = groups[kind] || {}, headers = group.headers || contactSyncHeaders_(kind), rows = group.rows || [];
    if (!Array.isArray(rows)) fail_('CONTACT_SOURCE_INCOMPLETE', 'Не удалось прочитать контакты исходной базы.');
    var phoneColumn = headers.indexOf('Телефон'), tgColumn = headers.indexOf('Telegram'), emailColumn = headers.indexOf('Email');
    rows.forEach(function (row) {
      var key = contactSyncKey_(kind, row[kind === 'email' ? emailColumn : phoneColumn], tgColumn >= 0 ? row[tgColumn] : '');
      if (!key) { warnings.push('Некоторые распознанные строки не удалось однозначно отнести к email, телефону или Telegram.'); return; }
      var idColumn = kind === 'email' && state.companyEmailSchema === 2 ? headers.indexOf('ID компании') : -1;
      var hash = contactSyncOwnerHash_(key, idColumn >= 0 ? row[idColumn] : ''); if (candidateHashes[hash]) return; candidateHashes[hash] = true; plan.knownHashes.push(hash);
      if (existing.hashes[hash]) { counts.existing++; return; }
      // A supplied selection is already curated. Learn its original baseline
      // without bringing back contacts the operator left out of the two lists.
      if (state.selectionBaselinePending) { counts.excluded++; return; }
      if (known[hash]) { counts.excluded++; return; }
      var values = {};
      headers.forEach(function (label, index) {
        // Leave the default status out of durable plans so plans written by
        // an earlier release can still be recovered with their original ID.
        if (label !== CONTACT_MAILING_STATUS.header) values[label] = String(row[index] === null || row[index] === undefined ? '' : row[index]);
      });
      if (state.workingHistory && state.workingHistory[key]) Object.assign(values, contactSyncWorkingFields_(state.workingHistory[key], idColumn >= 0 ? row[idColumn] : undefined));
      if (kind === 'email' && state.companyEmailSchema === 2 && values[CONTACT_MAILING_STATUS.header]) {
        values[CONTACT_MAILING_STATUS.header] = companyEmailWorkflowStatus_(values[CONTACT_MAILING_STATUS.header]);
      }
      if (kind === 'email' && state.emailOrigins) {
        var origin = state.emailOrigins[idColumn >= 0 && row[idColumn] && state.emailOriginsByCompany ? JSON.stringify([row[idColumn], key]) : key];
        if (origin) values['Исходный столбец email'] = origin;
      }
      plan[kind].rows.push({ key: key, hash: hash, values: values });
      if (kind === 'email') counts.newEmail++; else if (key.indexOf('telegram:') === 0) counts.newTelegram++; else counts.newPhone++;
    });
  });
  if (existing.duplicates) warnings.push('В существующих списках есть повторяющиеся контакты. Они сохранены; новые повторы не добавлялись.');
  if (existing.invalid) warnings.push('В существующих списках есть неоднозначные значения. Они оставлены для ручной проверки.');
  if (counts.excluded) warnings.push('Ранее удалённые из отдельных списков контакты не возвращались автоматически.');
  plan.warnings = contactSyncUnique_(warnings);
  var jobId = digest_(JSON.stringify([state.rootId, state.fileId, requestId])), folder = contactSyncEnsureFolder_(claim.context);
  var artifact = contactSyncFindPlan_(claim.context, folder.id, state.fileId, jobId), content = JSON.stringify(plan);
  if (content.length > CONTACT_SYNC.maxStateCharacters) fail_('CONTACT_SYNC_LIMIT', 'Слишком много новых контактов для одного обновления. Разделите исходную базу.');
  if (!artifact) {
    var tags = contactSyncTags_(claim.context, 'plan', state.fileId); tags.registryContactJobId = jobId;
    try { artifact = Drive.Files.create({ name: '.contact-plan-' + jobId + '.json', mimeType: 'application/json', parents: [folder.id], appProperties: tags }, Utilities.newBlob(content, 'application/json', 'contact-plan.json'), { fields: CONTACT_SYNC.fields, supportsAllDrives: true }); }
    catch (error) { artifact = contactSyncFindPlan_(claim.context, folder.id, state.fileId, jobId); if (!artifact) fail_('CONTACT_STORAGE_UNCERTAIN', 'Google не подтвердил план обновления. Повторите тот же запрос.'); }
  } else {
    var recovered = DriveApp.getFileById(artifact.id).getBlob().getDataAsString('UTF-8');
    if (recovered !== content) fail_('CONTACT_SOURCE_CHANGED', 'Исходная база изменилась до сохранения плана. Начните новую проверку.');
  }
  state.known = contactSyncUnion_(state.known, Object.keys(existing.hashes));
  state.job = { id: jobId, requestId: requestId, phase: 'email', cursor: 0, planId: artifact.id, planHash: digest_(content), sourceFingerprint: model.fingerprint, expectedVersion: stable.version, sourceSheetIds: stable.sourceSheetIds, counts: counts, warnings: plan.warnings, pending: null, error: null };
  if (importOnly) { state.job.importOnly = true; state.job.importMasterFingerprint = contactSyncMasterFingerprint_(model); }
  contactSyncSaveState_(claim.context, state);
}
function contactSyncFindPlan_(context, folderId, fileId, jobId) {
  var q = "trashed = false and '" + folderId + "' in parents and appProperties has { key='registryContactRole' and value='plan' } and appProperties has { key='registryContactFileId' and value='" + fileId + "' } and appProperties has { key='registryContactJobId' and value='" + jobId + "' }";
  var result = Drive.Files.list({ q: q, fields: 'files(' + CONTACT_SYNC.fields + '),nextPageToken', pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true });
  if (result.nextPageToken || (result.files || []).length > 1) fail_('CONTACT_STORAGE_UNCERTAIN', 'Найдено несколько планов одного обновления.');
  var file = (result.files || [])[0]; if (file && !contactSyncOwnFile_(file, context, 'plan')) fail_('OUTSIDE_REGISTRY', 'План не принадлежит реестру.'); return file;
}
function contactSyncReadPlan_(claim) {
  var job = claim.state.job, file = contactSyncMetadata_(job.planId), folder = contactSyncEnsureFolder_(claim.context);
  if (!contactSyncOwnFile_(file, claim.context, 'plan') || file.appProperties.registryContactFileId !== claim.state.fileId || file.appProperties.registryContactJobId !== job.id || (file.parents || []).length !== 1 || file.parents[0] !== folder.id) fail_('OUTSIDE_REGISTRY', 'План обновления контактов перемещён.');
  var text = DriveApp.getFileById(file.id).getBlob().getDataAsString('UTF-8');
  if (text.length > CONTACT_SYNC.maxStateCharacters || digest_(text) !== job.planHash) fail_('CONTACT_STORAGE_DAMAGED', 'План обновления контактов изменён.');
  var plan; try { plan = JSON.parse(text); } catch (error) { fail_('CONTACT_STORAGE_DAMAGED', 'План обновления контактов повреждён.'); }
  if (!plan || plan.rootId !== claim.state.rootId || plan.fileId !== claim.state.fileId || !plan.email || !plan.phone || !Array.isArray(plan.email.rows) || !Array.isArray(plan.phone.rows)) fail_('CONTACT_STORAGE_DAMAGED', 'План контактов не соответствует базе.');
  return plan;
}
function contactSyncCheckSnapshot_(claim) {
  var state = claim.state, job = state.job, metadata = contactSyncMetadata_(state.fileId);
  if (job.expectedVersion && contactSyncVersion_(metadata) === job.expectedVersion) return;
  var stable = contactSyncStableModel_(claim);
  if (!contactSyncMatchesSnapshot_(stable, job)) fail_('CONTACT_SOURCE_CHANGED', 'Исходная база изменилась. Запустите новую проверку; уже добавленные контакты и статусы сохранятся.');
  job.expectedVersion = stable.version; contactSyncSaveState_(claim.context, state);
}
function contactSyncAdvance_(claim) {
  var state = claim.state, job = state.job, plan = contactSyncReadPlan_(claim);
  // Older pending writes still use an exact header hash. Settle them before
  // adding a status column or changing the target schema.
  contactSyncRecoverPending_(claim, true);
  contactSyncEnsureTargets_(claim);
  if (job.phase === 'complete') return contactSyncComplete_(claim, plan);
  contactSyncCheckSnapshot_(claim);
  var kind = job.phase, rows = plan[kind].rows;
  if (job.cursor >= rows.length) {
    job.phase = kind === 'email' ? 'phone' : 'complete'; job.cursor = 0; job.error = null; contactSyncSaveState_(claim.context, state);
    return job.phase === 'complete' ? contactSyncComplete_(claim, plan) : contactSyncProcessing_(state);
  }
  var existing = contactSyncReadTargets_(claim), target = existing[kind], schema = state.schemas[kind], width = target.sheet.getLastColumn();
  var batchSize = Math.max(1, Math.min(CONTACT_SYNC.writeRows, Math.floor(50000 / Math.max(1, width))));
  var batch = rows.slice(job.cursor, job.cursor + batchSize), additions = batch.filter(function (entry) { return !existing.hashes[entry.hash]; });
  var skipped = batch.length - additions.length;
  if (!additions.length) { job.cursor += batch.length; job.counts.existing += skipped; contactSyncSaveState_(claim.context, state); return contactSyncProcessing_(state); }
  var height = additions.length, start = Math.max(1, target.sheet.getLastRow()) + 1;
  if (start + height - 1 > CONTACT_SYNC.maxTargetRows + 1) fail_('CONTACT_SYNC_LIMIT', 'Список контактов слишком большой для этого обновления.');
  var values = [], mask = [];
  additions.forEach(function (entry) {
    var line = Array(width).fill(''), selected = Array(width).fill(false);
    schema.headers.forEach(function (label) {
      var column = schema.columns[label];
      line[column] = String(entry.values[label] || (label === CONTACT_MAILING_STATUS.header ? CONTACT_MAILING_STATUS.initial : ''));
      selected[column] = true;
    });
    values.push(line); mask.push(selected);
  });
  job.pending = { kind: kind, startRow: start, width: width, values: values, mask: mask, hashes: additions.map(function (entry) { return entry.hash; }), keys: additions.map(function (entry) { return entry.key; }), advance: batch.length, skipped: skipped, sheetId: target.sheet.getSheetId(), headerHash: contactSyncHeaderHash_(target.sheet), statusColumn: schema.columns[CONTACT_MAILING_STATUS.header], status: 'pending' };
  contactSyncSaveState_(claim.context, state);
  contactSyncWritePending_(claim);
  contactSyncConfirmPending_(claim);
  return contactSyncProcessing_(state);
}
function contactSyncHeaderHash_(sheet) { var width = sheet.getLastColumn(); return digest_(JSON.stringify(width ? sheet.getRange(1, 1, 1, width).getDisplayValues()[0] : [])); }

function contactSyncWorkingFields_(evidence, companyId) {
  var companyEmail = companyId !== undefined;
  if (companyEmail) evidence = evidence.filter(function (entry) {
    return !entry.fields['ID компании'] || entry.fields['ID компании'] === companyId;
  });
  if (!evidence.length) return {};
  var fields = {}, statuses = [], originals = [];
  evidence.forEach(function (entry) {
    var raw = entry.fields['Статус'] || '', mapped = workingSelectionStatus_(raw);
    // This source has an explicit campaign flag: its other text describes a
    // workflow stage and must never be interpreted as a confirmed mailing.
    var explicitCampaign = String(entry.fields['Результат проверки'] || '').indexOf('legacy-history:v1:{"primaryTelegram":true,') === 0;
    if (!explicitCampaign && mapped === CONTACT_MAILING_STATUS.initial && entry.fields['Статус из источника']) mapped = contactMailingStatusFromHistory_(entry.fields['Статус из источника']);
    if (companyEmail) {
      var canonical = companyEmailWorkflowStatus_(raw);
      mapped = !raw || COMPANY_EMAIL_STATUS.values.indexOf(canonical) < 0 ? companyEmailWorkflowStatus_(mapped) : canonical;
    }
    if (statuses.indexOf(mapped) < 0) statuses.push(mapped);
    var original = entry.fields['Статус из источника'] || raw;
    if (original && originals.indexOf(original) < 0) originals.push(original);
  });
  fields[CONTACT_MAILING_STATUS.header] = statuses.indexOf('фильтр') >= 0 ? 'фильтр' : statuses.indexOf('в рассылке') >= 0 ? 'в рассылке' : CONTACT_MAILING_STATUS.initial;
  if (companyEmail) {
    var priority = ['Фильтр','Невалид','Рассылка','Готов'];
    fields[CONTACT_MAILING_STATUS.header] = priority.find(function (value) { return statuses.indexOf(value) >= 0; }) || CONTACT_MAILING_STATUS.initial;
  }
  if (originals.length) fields['Статус из источника'] = originals.join('; ');
  ['Комментарий', 'Валидация', 'Дата проверки', 'Результат проверки', 'Валидатор', 'Провайдер', 'ID_TG', 'Nickname_TG', 'Active_days_ago', 'Для Telegram'].forEach(function (label) {
    var unique = [];
    evidence.forEach(function (row) { var text = row.fields[label]; if (text && unique.indexOf(text) < 0) unique.push(text); });
    if (unique.length === 1) fields[label] = unique[0];
    if (unique.length > 1 && ['Валидация', 'ID_TG', 'Nickname_TG', 'Active_days_ago'].indexOf(label) >= 0) {
      fields['Валидация'] = 'Проверить историю контакта'; fields[CONTACT_MAILING_STATUS.header] = companyEmail ? 'Фильтр' : 'фильтр';
    }
  });
  fields['История контакта'] = evidence.map(function (row) {
    return 'https://docs.google.com/spreadsheets/d/' + row.source + '/edit#gid=' + row.sheet + '&range=A' + row.row + '\n' +
      ['Исходные строки — ' + row.refs].concat(Object.keys(row.fields).map(function (label) { return label + ' — ' + row.fields[label]; })).join('\n');
  }).join('\n\n');
  if (fields['История контакта'].length > 45000) fail_('SEGMENT_LOAD_LIMIT', 'История одного контакта превышает размер ячейки. Разделите загрузку.');
  return fields;
}

/** Install the immutable evidence before the first company/LPR batch. Replays
 * fill only blank cells or the initial mailing status. Later manual edits win. */
function contactSyncInstallWorkingHistory_(fileId, kind, segmentId, history, settlePrevious, origins) {
  return contactSyncWithLease_(fileId, function (claim) {
    var state = claim.state, expectedRole = kind === 'companies' ? 'segment-companies' : 'segment-lpr';
    if (state.role !== expectedRole || state.segmentId !== segmentId) fail_('SEGMENT_MASTER_CHANGED', 'Привязка контактов к сегменту изменилась.');
    if (settlePrevious) { claim.importSegmentId = segmentId; contactSyncCheckSegmentParent_(claim, claim.metadata); }
    if (state.job) {
      if (settlePrevious) { contactSyncAdvancePrevious_(claim); return false; }
      fail_('BUSY', 'Дождитесь завершения текущего обновления контактов сегмента.');
    }
    var previous = state.workingHistory || {}, merged = JSON.parse(JSON.stringify(previous));
    segmentSelectionMerge_(merged, history);
    var hasHistory=Object.keys(history).length>0, emailOrigins=Object.assign({},state.emailOrigins || {});
    function mergeLabels(current,addition) {
      var labels = new Set([current,addition].filter(Boolean).join('\n').split('\n').filter(Boolean));
      var value=Array.from(labels).join('\n');
      if (value.length>45000) fail_('SEGMENT_LOAD_LIMIT','Список исходных столбцов одного адреса превышает размер ячейки.');
      return value;
    }
    var ownerOrigins = state.companyEmailSchema === 2 && Object.keys(origins || {}).some(function (key) { return key.charAt(0) === '['; });
    if (ownerOrigins) state.emailOriginsByCompany = true;
    Object.keys(origins || {}).forEach(function (key) {
      if (ownerOrigins || key.charAt(0) !== '[') emailOrigins[key] = mergeLabels(emailOrigins[key], origins[key]);
    });
    if (hasHistory) state.workingHistoryEnabled = true;
    contactSyncEnsureTargets_(claim);
    (hasHistory ? ['email','phone'] : ['email']).forEach(function (channel) {
      var sheet = gridSheet_(claim.book, state.targets[channel + 'SheetId']), columns = state.schemas[channel].columns;
      var width = sheet.getLastColumn(), height = sheet.getLastRow(), size = Math.max(1, Math.floor(50000 / width));
      for (var start = 2; start <= height; start += size) {
        var version = contactSyncVersion_(contactSyncMetadata_(fileId)), count = Math.min(size, height - start + 1);
        var range = sheet.getRange(start, 1, count, width), values = range.getDisplayValues(), formulas = range.getFormulas(), changed = false;
        var masks = values.map(function (line, index) {
          var mask = Array(width).fill(false), key = contactSyncKey_(channel, line[columns[channel === 'email' ? 'Email' : 'Телефон']]);
          var owner = channel === 'email' && line[columns['ID компании']];
          var originKey = ownerOrigins && owner ? JSON.stringify([owner, key]) : key;
          var origin = channel==='email' && origins && origins[originKey], originCol=columns['Исходный столбец email'];
          if (origin && originCol!==undefined && !formulas[index][originCol]) {
            var next=mergeLabels(line[originCol],emailOrigins[originKey]);
            if (line[originCol]!==next) { line[originCol]=next; mask[originCol]=true; changed=true; }
          }
          if (!history[key] || JSON.stringify(previous[key]) === JSON.stringify(merged[key])) return mask;
          var id = channel === 'email' && state.companyEmailSchema === 2 ? line[columns['ID компании']] : undefined;
          var fields = contactSyncWorkingFields_(merged[key],id), status = CONTACT_MAILING_STATUS.header, current = line[columns[status]];
          var oldFields = previous[key] && contactSyncWorkingFields_(previous[key],id);
          if (current && !contactMailingStatusIsNew_(current) && current !== fields[status] && String(fields[status]).toLowerCase() === 'фильтр') fail_('SEGMENT_TARGET_CONFLICT', 'В сегменте и выборке разные решения по рассылке контакта. Сверьте рабочие статусы перед продолжением.');
          if (fields['Валидация'] && line[columns['Валидация']] && fields['Валидация'] !== line[columns['Валидация']] && String(current).toLowerCase() !== 'фильтр') fail_('SEGMENT_TARGET_CONFLICT', 'В сегменте и выборке различаются результаты проверки контакта. Сверьте результаты перед продолжением.');
          Object.keys(fields).forEach(function (label) {
            var column = columns[label]; if (column === undefined || formulas[index][column] || line[column] === fields[label]) return;
            if (line[column] && !(label === status && contactMailingStatusIsNew_(line[column]) && !contactMailingStatusIsNew_(fields[label])) &&
                !(label === 'История контакта' && oldFields && line[column] === oldFields[label])) return;
            line[column] = fields[label]; mask[column] = true; changed = true;
          });
          return mask;
        });
        if (changed) {
          gridFile_(fileId, true, state.rootId); contactSyncAssertLease_(claim);
          if (version !== contactSyncVersion_(contactSyncMetadata_(fileId))) fail_('BUSY', 'Рабочие контакты изменились. Продолжите прежний запрос.');
          sheetWriteRawStrings_(fileId, sheet.getSheetId(), start, 1, values, masks);
        }
      }
    });
    if (hasHistory) state.workingHistory = merged;
    if (origins) state.emailOrigins = emailOrigins;
    state.dirty = true; contactSyncSaveState_(claim.context, state); return true;
  }, false);
}
function contactSyncRecoverPending_(claim, retryEmpty) {
  var pending = claim.state.job && claim.state.job.pending; if (!pending) return;
  var result = contactSyncPendingState_(claim);
  if (result === 'complete') { contactSyncConfirmPending_(claim); return; }
  if (result !== 'empty') fail_('CONTACT_SYNC_CONFLICT', 'Подготовленные строки контактов изменились. Ваши данные не перезаписывались; проверьте незавершённое обновление.');
  if (!retryEmpty) { claim.state.job.pending = null; contactSyncSaveState_(claim.context, claim.state); return; }
  contactSyncCheckSnapshot_(claim);
  contactSyncWritePending_(claim); contactSyncConfirmPending_(claim);
}
function contactSyncPendingState_(claim) {
  var pending = claim.state.job.pending, sheet = gridSheet_(claim.book, pending.sheetId);
  if (contactSyncHeaderHash_(sheet) !== pending.headerHash) fail_('CONTACT_SCHEMA_CHANGED', 'Столбцы списка изменились во время добавления. Повторная запись остановлена.');
  var readableRows = Math.max(0, Math.min(pending.values.length, sheet.getMaxRows() - pending.startRow + 1));
  var readableColumns = Math.min(pending.width, sheet.getMaxColumns()), actual = [], formulas = [], same = true, empty = true;
  if (readableRows && readableColumns) { var range = sheet.getRange(pending.startRow, 1, readableRows, readableColumns); actual = range.getDisplayValues(); formulas = range.getFormulas(); }
  pending.values.forEach(function (line, y) { line.forEach(function (expected, x) {
    var value = actual[y] && actual[y][x] || '', formula = formulas[y] && formulas[y][x] || '';
    if (String(value) !== '' || formula) empty = false;
    if (pending.mask[y][x] && (String(value) !== expected || formula)) same = false;
  }); });
  return same ? 'complete' : empty ? 'empty' : 'conflict';
}
function contactSyncWritePending_(claim) {
  var state = claim.state, pending = state.job.pending, sheet = gridSheet_(claim.book, pending.sheetId);
  gridFile_(state.fileId, true, state.rootId);
  contactSyncAssertLease_(claim);
  if (contactSyncHeaderHash_(sheet) !== pending.headerHash) fail_('CONTACT_SCHEMA_CHANGED', 'Столбцы списка изменились во время добавления.');
  var result = contactSyncPendingState_(claim); if (result === 'complete') return;
  if (result !== 'empty') fail_('CONTACT_SYNC_CONFLICT', 'Строки списка уже заняты. Автоматическая запись остановлена.');
  var end = pending.startRow + pending.values.length - 1;
  if (end > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), end - sheet.getMaxRows());
  if (pending.width > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), pending.width - sheet.getMaxColumns());
  if (Number.isSafeInteger(pending.statusColumn) && pending.values.some(function (line) { return line[pending.statusColumn] === CONTACT_MAILING_STATUS.initial; })) {
    gridFile_(state.fileId, true, state.rootId); contactSyncAssertLease_(claim);
    if (contactMailingStatusDropdown_(sheet.getRange(pending.startRow, pending.statusColumn + 1, pending.values.length, 1),true,null,pending.kind === 'email' && state.companyEmailSchema === 2) && contactSyncPendingState_(claim) !== 'empty')
      fail_('CONTACT_SYNC_CONFLICT', 'Строки списка изменились во время подготовки статусов.');
  }
  gridFile_(state.fileId, true, state.rootId);
  sheetWriteRawStrings_(state.fileId, pending.sheetId, pending.startRow, 1, pending.values, pending.mask);
  SpreadsheetApp.flush();
  if (contactSyncPendingState_(claim) !== 'complete') fail_('CONTACT_SYNC_UNCERTAIN', 'Google ещё не подтвердил добавленные контакты. Повторите тот же запрос для сверки результата.');
}
function contactSyncConfirmPending_(claim) {
  var state = claim.state, job = state.job, pending = job.pending;
  if (!pending) return;
  if (contactSyncPendingState_(claim) !== 'complete') fail_('CONTACT_SYNC_UNCERTAIN', 'Добавленные контакты пока не подтверждены.');
  if (Number.isSafeInteger(pending.statusColumn)) {
    gridFile_(state.fileId, true, state.rootId); contactSyncAssertLease_(claim);
    var sheet = gridSheet_(claim.book, pending.sheetId);
    contactMailingStatusDropdown_(sheet.getRange(pending.startRow, pending.statusColumn + 1, pending.values.length, 1), true,null,pending.kind === 'email' && state.companyEmailSchema === 2);
  }
  pending.keys.forEach(function (key) { if (key.indexOf('email:') === 0) job.counts.addedEmail++; else if (key.indexOf('telegram:') === 0) job.counts.addedTelegram++; else job.counts.addedPhone++; });
  state.known = contactSyncUnion_(state.known, pending.hashes);
  job.cursor += pending.advance; job.counts.existing += pending.skipped; job.pending = null; job.error = null;
  job.expectedVersion = contactSyncVersion_(contactSyncMetadata_(state.fileId));
  contactSyncSaveState_(claim.context, state);
}
function contactSyncComplete_(claim, plan) {
  var state = claim.state, job = state.job, importedSnapshot;
  if (job.importOnly) {
    // The enclosing segment publishes its relation after this receipt. Check
    // the actual master before the receipt can survive a lost response.
    importedSnapshot = contactSyncStableModel_(claim);
    if (!contactSyncMatchesSnapshot_(importedSnapshot, job)) fail_('CONTACT_SOURCE_CHANGED', 'Во время пополнения изменился основной лист сегмента. Обновите предпросмотр.');
    contactSyncAssertLease_(claim);
  }
  if (state.companyEmailSchema === 2) contactSyncCompanyCounts_(claim);
  state.known = contactSyncUnion_(state.known, plan.knownHashes); state.lastSyncAt = new Date().toISOString(); state.lastFingerprint = importedSnapshot ? importedSnapshot.model.fingerprint : job.sourceFingerprint; state.lastCounts = job.counts; state.dirty = false;
  delete state.selectionBaselinePending;
  var receipt = { status: 'complete', jobId: job.id, requestId: job.requestId, counts: job.counts, warnings: job.warnings, completedAt: state.lastSyncAt };
  contactSyncRemember_(state, job.requestId, receipt); state.job = null; state.warnings = [];
  contactSyncSaveState_(claim.context, state);
  var answer = contactSyncResponse_(state, receipt, false);
  if (!job.importOnly && typeof queueWorkbookValidation_ === 'function') {
    try { answer.validation = queueWorkbookValidation_(claim.context, state.fileId, { emailSheetId: state.targets.emailSheetId, phoneSheetId: state.targets.phoneSheetId, reason: 'sync_complete' }); }
    catch (error) { answer.validation = { state: 'error', message: 'Контакты разнесены. Подключение валидации требует проверки.' }; }
  } else answer.validation = { state: 'not_configured' };
  if (!job.importOnly && typeof queueColdyWorkbookValidation_ === 'function' && typeof emailValidationProvider_ === 'function' && emailValidationProvider_(claim.context) === 'coldy') {
    try { answer.coldyValidation = queueColdyWorkbookValidation_(claim.context, state.fileId); }
    catch (error) { answer.coldyValidation = { state: 'error', message: 'Контакты разнесены. Откройте подключение Coldy для проверки настроек.' }; }
  }
  // A Drive version observed after our own target append can also include a
  // simultaneous native source edit. Re-read the source once at completion,
  // even when the last observed version appears unchanged, before declaring
  // the workbook fully synchronized.
  try {
    var stable = importedSnapshot || contactSyncStableModel_(claim);
    state.dirty = !importedSnapshot && !contactSyncMatchesSnapshot_(stable, job);
    state.lastObservedVersion = state.dirty ? '' : stable.version;
  } catch (error) { state.dirty = true; state.lastObservedVersion = ''; }
  if (state.dirty) { answer.sourceChanged = true; answer.warnings = contactSyncUnique_((answer.warnings || []).concat(['Исходная база дополнена во время обновления. Запустите проверку новых контактов ещё раз.'])); }
  contactSyncSaveState_(claim.context, state);
  try {
    var artifact = contactSyncMetadata_(job.planId), folderId = claim.context.properties.getProperty(CONTACT_SYNC.folderProperty);
    if (contactSyncOwnFile_(artifact, claim.context, 'plan') && artifact.appProperties.registryContactFileId === state.fileId && (artifact.parents || []).length === 1 && artifact.parents[0] === folderId) Drive.Files.update({ trashed: true }, artifact.id, null, { fields: 'id,trashed', supportsAllDrives: true });
  } catch (error) { console.warn('Completed contact plan could not be safely cleaned.'); }
  gridFile_(state.fileId, false, state.rootId); return answer;
}
function contactSyncWorkspace_(state, canEdit, fileVersion) {
  return { enrolled: true, canSync: canEdit === true, targets: state.targets, sourceSheetIds: state.sourceSheetIds, section: state.section, role: state.role || 'registry', companyEmailSchema: state.companyEmailSchema || null,
    segmentId: state.segmentId || null, relatedFileId: state.relatedFileId || null, stateFileId: state.stateFileId, lastSyncAt: state.lastSyncAt, counts: state.lastCounts || null, warnings: state.warnings || [],
    fileVersion: fileVersion || '', lastObservedVersion: state.lastObservedVersion || '', shouldSync: !!state.job || !!state.dirty || !state.lastObservedVersion || !fileVersion || fileVersion !== state.lastObservedVersion,
    job: state.job ? { jobId: state.job.id, requestId: state.job.requestId, progress: contactSyncProgress_(state.job), error: state.job.error || null } : null };
}
function contactSyncProgress_(job) {
  return { stage: job.phase, completed: job.counts.addedEmail + job.counts.addedPhone + job.counts.addedTelegram, total: job.counts.newEmail + job.counts.newPhone + job.counts.newTelegram, label: job.phase === 'email' ? 'Добавляем новые email…' : job.phase === 'phone' ? 'Добавляем новые телефоны и Telegram…' : 'Обновление контактов завершено.' };
}
function contactSyncProcessing_(state) { return { state: 'processing', jobId: state.job.id, requestId: state.job.requestId, targets: state.targets, counts: state.job.counts, warnings: state.job.warnings, progress: contactSyncProgress_(state.job), canRestart: !!state.job.error }; }
function contactSyncResponse_(state, receipt, replayed) { return { state: 'complete', jobId: receipt.jobId, requestId: receipt.requestId, targets: state.targets, counts: receipt.counts, warnings: receipt.warnings || [], lastSyncAt: receipt.completedAt, replayed: replayed === true }; }
function contactSyncReceipt_(state, requestId) { return (state.receipts || []).filter(function (entry) { return entry.requestId === requestId; })[0] || null; }
function contactSyncRemember_(state, requestId, receipt) {
  state.receipts = state.receipts.filter(function (entry) { return entry.requestId !== requestId; }); receipt.requestId = requestId; state.receipts.push(receipt);
  while (state.receipts.length > CONTACT_SYNC.receiptLimit) state.receipts.shift();
}
function contactSyncSet_(values) { var answer = Object.create(null); (values || []).forEach(function (value) { answer[value] = true; }); return answer; }
function contactSyncUnion_(left, right) { return Object.keys(contactSyncSet_((left || []).concat(right || []))); }
function contactSyncUnique_(values) { return values.filter(function (value, index) { return values.indexOf(value) === index; }); }
// Count the addresses actually present after append/deletion, including old rows from earlier imports.
function contactSyncCompanyCounts_(claim) {
  var state = claim.state, columns = state.schemas.email.columns, sheet = gridSheet_(claim.book,state.targets.emailSheetId);
  var height = sheet.getLastRow()-1;
  if (height <= 0 || columns['Почт на компанию'] === undefined || columns['ID компании'] === undefined) return;
  var countCol = columns['Почт на компанию']+1, totals = new Map(), version = contactSyncVersion_(contactSyncMetadata_(state.fileId));
  var ids = sheet.getRange(2,columns['ID компании']+1,height,1).getDisplayValues();
  var addresses = sheet.getRange(2,columns.Email+1,height,1).getDisplayValues();
  var countRange = sheet.getRange(2,countCol,height,1), counts = countRange.getDisplayValues(), formulas = countRange.getFormulas();
  ids.forEach(function (row,i) {
    var id = row[0], key = contactSyncKey_('email',addresses[i][0]);
    if (!id || !key) return;
    if (!totals.has(id)) totals.set(id,new Set());
    totals.get(id).add(key);
  });
  var changed = false, mask = ids.map(function (row,i) {
    if (!totals.has(row[0]) || !contactSyncKey_('email',addresses[i][0])) return [false];
    var next = String(totals.get(row[0]).size);
    if (formulas[i][0] || counts[i][0] === next) return [false];
    counts[i][0] = next; changed = true; return [true];
  });
  if (!changed) return;
  for (var offset = 0; offset < height; offset += CONTACT_SYNC.writeRows) {
    var selected = mask.slice(offset, offset + CONTACT_SYNC.writeRows);
    if (!selected.some(function (cell) { return cell[0]; })) continue;
    gridFile_(state.fileId, true, state.rootId); contactSyncAssertLease_(claim);
    if (version !== contactSyncVersion_(contactSyncMetadata_(state.fileId))) fail_('CONTACT_SYNC_CONFLICT', 'Email изменились во время подсчёта. Продолжите тот же запрос.');
    sheetWriteRawStrings_(state.fileId, sheet.getSheetId(), offset + 2, countCol, counts.slice(offset, offset + selected.length), selected);
    SpreadsheetApp.flush();
    version = contactSyncVersion_(contactSyncMetadata_(state.fileId));
  }
}

// The deduplication unit in the company workbook is the owner/address pair.
function contactSyncCompanyEmails_(list, records) {
  var columns = list.headers, idCol = columns.indexOf('ID компании'), emailCol = columns.indexOf('Email');
  if (idCol < 0) return list;
  var nameCol = columns.indexOf('Компания / ЛПР'), sitesCol = columns.indexOf('Сайты');
  var rowsCol = columns.indexOf('Исходные строки'), reviewCol = columns.indexOf('Проверить принадлежность');
  var groups = new Map(), unresolved = new Set();
  records.forEach(function (record) {
    var company = record.company || {};
    (record.general.emails || []).forEach(function (email) {
      var key = contactSyncKey_('email', email);
      if (!key) return;
      if (record.ambiguous || !company.id) unresolved.add(key);
      if (!company.id) return;
      if (!groups.has(key)) groups.set(key, new Map());
      var owners = groups.get(key);
      if (!owners.has(company.id)) owners.set(company.id, {name: company.name, rows: new Set(), sites: new Set()});
      var owner = owners.get(company.id);
      owner.rows.add(record.source.row);
      if (company.website) owner.sites.add(company.website);
    });
  });
  var rows = [];
  list.rows.forEach(function (line) {
    var key = contactSyncKey_('email', line[emailCol]), owners = groups.get(key);
    if (!owners) { rows.push(line); return; }
    owners.forEach(function (owner, id) {
      var row = line.slice();
      row[idCol] = id;
      if (nameCol >= 0) row[nameCol] = owner.name;
      if (sitesCol >= 0) row[sitesCol] = Array.from(owner.sites).join('; ');
      if (rowsCol >= 0) row[rowsCol] = Array.from(owner.rows).join(', ');
      if (reviewCol >= 0 && owners.size > 1 && !unresolved.has(key)) row[reviewCol] = 'Нет';
      rows.push(row);
    });
  });
  return {headers: columns, rows: rows};
}

function contactSyncCompanyModel_(model) {
  if (!Array.isArray(model.records)) fail_('CONTACT_SOURCE_INCOMPLETE', 'Не удалось отделить общие контакты компаний от контактов ЛПР.');
  var allowed = Object.create(null);
  model.records.forEach(function (record) {
    var general = record.general || {};
    (general.emails || []).forEach(function (value) { var key = contactSyncKey_('email', value); if (key) allowed[key] = true; });
    (general.phones || []).forEach(function (value) { var key = contactSyncKey_('phone', value); if (key) allowed[key] = true; });
    (general.telegrams || []).forEach(function (value) { var key = contactSyncKey_('phone', '', value); if (key) allowed[key] = true; });
  });
  var filtered = { email: { headers: model.email.headers, rows: [] }, phone: { headers: model.phone.headers, rows: [] }, fingerprint: model.fingerprint };
  ['email', 'phone'].forEach(function (kind) {
    var columns = model[kind].headers, phone = columns.indexOf('Телефон'), telegram = columns.indexOf('Telegram'), email = columns.indexOf('Email');
    filtered[kind].rows = model[kind].rows.filter(function (row) { return !!allowed[contactSyncKey_(kind, row[kind === 'email' ? email : phone], telegram >= 0 ? row[telegram] : '')]; });
  });
  return filtered;
}

/** Curated mobile lists only receive numbers from mobile columns in the primary data. */
function contactSyncSelectionChannels_(model, groups) {
  var headers = new Map((model.models || []).map(function (leaf) { return [leaf.source.sheetId, leaf.source.headers]; }));
  var allowed = new Set();
  (model.contactIndex || []).forEach(function (contact) {
    var columnType = contact.type === 'email' ? /^(?:email|emailадреса|электроннаяпочта)$/ : contact.type === 'phone' ? /^мобильны[ей]телефон[ы]?$/ : null;
    if (columnType && contact.sourceRefs.some(function (ref) { return columnType.test(contactPreviewHeader_((headers.get(ref.sheetId) || [])[ref.column - 1])); })) allowed.add(contact.type + ':' + contact.value);
  });
  ['email', 'phone'].forEach(function (kind) {
    var group = groups[kind], column = group.headers.indexOf(kind === 'email' ? 'Email' : 'Телефон');
    group.rows = group.rows.filter(function (row) { return allowed.has(kind + ':' + row[column]); });
  });
  return groups;
}
