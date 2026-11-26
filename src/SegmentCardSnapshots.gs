/** A team's rebuildable read model. Sheets and provider journals remain authoritative. */
var SEGMENT_CARD_SNAPSHOT = Object.freeze({
  schema:1, pageSize:60, compactSize:12, dashboardLimit:8, cacheSeconds:21600, maxAge:24 * 3600000,
  dashboardChars:400000, cacheChars:95000
});

function segmentCardSnapshotSlot_(context, segmentId) {
  var projectId = registryProjectId_();
  var owner = digest_(JSON.stringify([context.rootId, projectId, id_(segmentId)]));
  return {owner: owner, projectId: projectId, segmentId: segmentId, key: 'SEGMENT_CARD_PREPARED_' + owner};
}

function segmentCardSnapshotMeta_(context, slot, properties) {
  var raw = properties ? properties[slot.key] : context.properties.getProperty(slot.key);
  if (!raw) return null;
  try {
    var receipt = JSON.parse(raw);
    if (receipt.schema === SEGMENT_CARD_SNAPSHOT.schema && receipt.owner === slot.owner &&
        /^[A-Za-z0-9_-]{43}$/.test(receipt.revision) && /^[A-Za-z0-9_-]{43}$/.test(receipt.contentHash) &&
        Number.isFinite(Date.parse(receipt.checkedAt))) return receipt;
  } catch (ignored) { /* An incomplete derived index can be rebuilt. */ }
  return null;
}

function segmentCardSnapshotFresh_(receipt) {
  var age = Date.now() - Date.parse(receipt.checkedAt);
  return age >= -60000 && age <= SEGMENT_CARD_SNAPSHOT.maxAge;
}

function segmentCardSnapshotFilesKey_(files) {
  return ['companies','lpr'].map(function (kind) {
    var file = files[kind]; if (!file) return null;
    var tags = file.metadata.appProperties || {};
    return [file.id, tags.registryContactRoot || '', tags.registryContactStateId || '', tags.registryContactEmailSheetId || '', tags.registryContactPhoneSheetId || ''];
  });
}

function segmentCardSnapshotAccess_(storageId, files, credential, bindings) {
  var bound = bindings.map(function (b) { return [b.id,b.campaignId,b.revision]; }).sort(function (a,b) { return String(a[0]).localeCompare(String(b[0])); });
  return digest_(JSON.stringify([storageId, segmentCardSnapshotFilesKey_(files), credential, bound]));
}

// The caller provides a registry read under the live provider credential in this invocation.
function segmentCardSnapshotCurrentAccess_(context, segmentId, storageId, files, registry, credential) {
  if (credential && (!registry || credential !== registry.credentialHash || !Array.isArray(registry.bindings))) return null;
  var bound = credential ? registry.bindings.filter(function (b) { return b.segmentId === segmentId; }) : [];
  return segmentCardSnapshotAccess_(storageId, files, credential, bound);
}

function segmentCardSnapshotPublicFiles_(files) {
  var result = {};
  ['companies','lpr'].forEach(function (kind) {
    result[kind] = files[kind] ? {id: files[kind].id, name: files[kind].name} : null;
  });
  return result;
}

function segmentCardSnapshotPage_(snapshot, filter, receipt, segmentId, name, files) {
  var page = segmentCardPage_(snapshot, filter);
  page.rows = page.rows.map(function (row) {
    var copy = Object.assign({}, row);
    // Original references are resolved only on the strict live route, against current membership.
    copy.sources = row.sources.map(function (src) { var source = Object.assign({}, src); delete source.history; return source; });
    return copy;
  });
  page.prepared = true; page.revision = receipt.revision; page.preparedAt = receipt.preparedAt;
  page.checkedAt = receipt.checkedAt; page.segmentId = segmentId; page.name = name; page.files = segmentCardSnapshotPublicFiles_(files);
  return page;
}

function segmentCardSnapshotPack_(value) {
  return Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(JSON.stringify(value), 'application/json', 'card.json')).getBytes());
}

function segmentCardSnapshotUnpack_(encoded) {
  return JSON.parse(Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(encoded), 'application/x-gzip', 'card.json.gz')).getDataAsString('UTF-8'));
}

function segmentCardSnapshotHeadKey_(slot, receipt, legacy) {
  return (legacy ? 'card-first/' : 'card-first-60/') + slot.owner + '/' + receipt.revision;
}

function segmentCardSnapshotCompact_(page) {
  if (page.rows.length <= SEGMENT_CARD_SNAPSHOT.compactSize) return page;
  var rows = page.rows.slice(0, SEGMENT_CARD_SNAPSHOT.compactSize);
  return Object.assign({}, page, {rows:rows, nextOffset:rows.length});
}

function segmentCardSnapshotWarm_(slot, receipt, snapshot, scope) {
  var page = segmentCardSnapshotPage_(snapshot, segmentCardFilter_({limit:SEGMENT_CARD_SNAPSHOT.pageSize}), receipt, slot.segmentId, scope.folder.getName(), scope.files);
  page.preview = true;
  var encoded = JSON.stringify(page).length < SEGMENT_CARD_SNAPSHOT.dashboardChars ? segmentCardSnapshotPack_(page) : '';
  if (!encoded || encoded.length > SEGMENT_CARD_SNAPSHOT.cacheChars) {
    var compact = segmentCardSnapshotCompact_(page);
    if (compact === page || JSON.stringify(compact).length >= SEGMENT_CARD_SNAPSHOT.dashboardChars) return;
    encoded = segmentCardSnapshotPack_(compact);
  }
  if (encoded.length <= SEGMENT_CARD_SNAPSHOT.cacheChars) CacheService.getScriptCache().put(segmentCardSnapshotHeadKey_(slot, receipt), encoded, SEGMENT_CARD_SNAPSHOT.cacheSeconds);
}

function segmentCardSnapshotLoad_(context, slot, receipt) {
  var snapshot = segmentCardReadCache_(receipt.revision);
  if (snapshot) return snapshot;
  var artifact = coldyLoad_(context, 'segmentcard', slot.owner);
  if (!artifact || artifact.revision !== receipt.revision || typeof artifact.body !== 'string' ||
      digest_(artifact.body) !== receipt.contentHash) return null;
  snapshot = segmentCardSnapshotUnpack_(artifact.body);
  if (!snapshot || !Array.isArray(snapshot.rows) || !snapshot.summary) return null;
  segmentCardWriteCache_(receipt.revision,snapshot,SEGMENT_CARD_SNAPSHOT.cacheSeconds,artifact.body);
  return snapshot;
}

/** The maintenance worker owns a per-segment lease. All durable writes target service storage. */
function segmentCardRefreshSnapshot_(context, segmentId, guard, scheduled) {
  var slot = segmentCardSnapshotSlot_(context, segmentId);
  if (typeof guard !== 'function' || registrySegmentProject_(context, segmentId) !== slot.projectId) fail_('OUTSIDE_PROJECT', 'Сегмент не входит в проект фонового задания.');
  guard();
  var stage = guard.stage || function () {};
  stage('files');
  var scope = segmentCardFiles_(context, segmentId);
  stage('campaigns');
  var campaigns = segmentCardCampaigns_(context, segmentId);
  stage('revision');
  var revision = segmentCardRevision_(context, scope, campaigns), previous = segmentCardSnapshotMeta_(context, slot);
  var access = segmentCardSnapshotAccess_(scope.storage.public.id, scope.files, campaigns.credential, campaigns.bindings.map(function (entry) { return entry.binding; }));
  var receipt, snapshot, rebuilt = !(previous && previous.revision === revision && previous.access === access);
  if (!rebuilt) {
    stage('load');
    receipt = previous;
    var head;
    try { head = CacheService.getScriptCache().get(segmentCardSnapshotHeadKey_(slot, receipt)); } catch (ignored) { /* Read the durable copy. */ }
    if (!head) snapshot = segmentCardSnapshotLoad_(context, slot, receipt);
    if (snapshot === null) rebuilt = true;
  }
  if (rebuilt) {
    stage('contacts');
    var data = segmentCardData_(context,segmentId,revision,scope,campaigns,true);
    snapshot = data.snapshot;
    stage('encode');
    var body = segmentCardSnapshotPack_(snapshot);
    receipt = {schema:SEGMENT_CARD_SNAPSHOT.schema, owner:slot.owner, revision:revision, access:access,
      contentHash:digest_(body), preparedAt:new Date().toISOString()};
    guard();
    stage('persist');
    coldySave_(context, 'segmentcard', slot.owner, {revision:revision, body:body});
  }
  guard();
  stage('receipt');
  receipt.checkedAt = new Date().toISOString();
  if (scheduled) receipt.lastBackgroundAt = receipt.checkedAt;
  else if (previous && previous.lastBackgroundAt) receipt.lastBackgroundAt = previous.lastBackgroundAt;
  context.properties.setProperty(slot.key, JSON.stringify(receipt));
  if (snapshot) {
    stage('cache');
    if (rebuilt) segmentCardWriteCache_(revision,snapshot,SEGMENT_CARD_SNAPSHOT.cacheSeconds,body);
    try { segmentCardSnapshotWarm_(slot, receipt, snapshot, scope); } catch (ignored) { /* Drive still holds the snapshot. */ }
  }
  return {revision:revision, checkedAt:receipt.checkedAt, rebuilt:rebuilt};
}

/** Fast browsing deliberately skips validation/campaign-recipient journal reads. */
function segmentCardPreparedPage_(context, segmentId, filter, revision) {
  registryRequireSegment_(context, segmentId);
  if (!registryProjectScoped_()) return null;
  var slot = segmentCardSnapshotSlot_(context, segmentId), receipt = segmentCardSnapshotMeta_(context, slot);
  if (!receipt || !segmentCardSnapshotFresh_(receipt)) return null;
  var scope = segmentCardFiles_(context, segmentId), credential = coldySettings_(context).credentialHash || '';
  var registry = credential ? coldyCampaignRegistry_(context) : null;
  if (receipt.access !== segmentCardSnapshotCurrentAccess_(context,segmentId,scope.storage.public.id,scope.files,registry,credential)) return null;
  if (revision !== undefined && revision !== receipt.revision) segmentCardChanged_();
  var snapshot = segmentCardSnapshotLoad_(context, slot, receipt);
  if (!snapshot) return null;
  var fresh = authorize_();
  if (fresh.rootId !== context.rootId || registrySegmentProject_(fresh, segmentId) !== slot.projectId) fail_('OUTSIDE_PROJECT', 'Доступ к сегменту изменился.');
  if (segmentCardSnapshotCredential_(fresh.properties) !== credential ||
      (fresh.properties.getProperty('SOURCE_BASES_STORAGE_ID') || REGISTRY_CONFIG.defaultSourceBasesStorageId) !== scope.storage.public.id) return null;
  // Recover an evicted dashboard page from the authorized snapshot already in memory.
  if (!filter.offset && !filter.query && filter.channel === 'all' && filter.owner === 'all' && filter.queue === 'all') {
    try {
      if (!CacheService.getScriptCache().get(segmentCardSnapshotHeadKey_(slot, receipt))) {
        segmentCardSnapshotWarm_(slot, receipt, snapshot, scope);
      }
    } catch (ignored) { /* The requested page is still available. */ }
  }
  return segmentCardSnapshotPage_(snapshot, filter, receipt, segmentId, scope.folder.getName(), scope.files);
}

function segmentCardSnapshotCredential_(properties) {
  var key = properties.getProperty(COLDY.keyProperty);
  return key ? digest_(key) : '';
}

/** The existing dashboard already verified the outreach folder, segment folders and current tracking rows.
 * Recheck direct workbook parents/tags in one metadata-only call for all cached first pages.
 * Contacts leave this function only for matching project, registry, master and campaign assignments.
 */
function segmentCardDashboardPreviews_(context, projection, tracking, registry) {
  var result = Object.create(null);
  if (!tracking || !tracking.available || projection.state !== 'ready' || !registryProjectScoped_()) return result;
  var properties = context.properties.getProperties(), projectId = registryProjectId_(), candidates = [];
  projection.items.some(function (item) {
    if (registrySegmentProject_(context,item.id,properties) !== projectId) return false;
    var slot = segmentCardSnapshotSlot_(context,item.id), receipt = segmentCardSnapshotMeta_(context,slot,properties);
    if (receipt && segmentCardSnapshotFresh_(receipt)) candidates.push({item:item,receipt:receipt,
      key:segmentCardSnapshotHeadKey_(slot,receipt),legacyKey:segmentCardSnapshotHeadKey_(slot,receipt,true)});
    return candidates.length === SEGMENT_CARD_SNAPSHOT.dashboardLimit;
  });
  if (!candidates.length) return result;
  var heads;
  var keys = [];
  candidates.forEach(function (c) { keys.push(c.key,c.legacyKey); });
  try { heads = CacheService.getScriptCache().getAll(keys); }
  catch (ignored) { return result; }
  candidates = candidates.filter(function (c) { return !!(heads[c.key] || heads[c.legacyKey]); });
  if (!candidates.length) return result;
  var storageId = properties.SOURCE_BASES_STORAGE_ID || REGISTRY_CONFIG.defaultSourceBasesStorageId;
  var key = properties[COLDY.keyProperty], credential = key ? digest_(key) : '';
  if (credential && (!registry || registry.credentialHash !== credential)) return result;
  var parents = candidates.map(function (c) { return "'" + id_(c.item.id) + "' in parents"; });
  var folderMime = 'application/vnd.google-apps.folder', sourceId = id_(projection.source.id);
  var foldersQuery = "(mimeType='" + folderMime + "' and '" + sourceId + "' in parents)";
  var filesQuery = "(mimeType='" + REGISTRY_CONFIG.spreadsheetMime + "' and (" + parents.join(' or ') + '))';
  var response;
  try {
    response = Drive.Files.list({q:'trashed=false and (' + foldersQuery + ' or ' + filesQuery + ')',
      fields:'files(id,name,mimeType,trashed,parents,appProperties),incompleteSearch',pageSize:1000,
      supportsAllDrives:true,includeItemsFromAllDrives:true});
  } catch (ignored) { return result; }
  if (!response || response.incompleteSearch || !Array.isArray(response.files)) return result;
  var metas = new Map(response.files.map(function (f) { return [f.id,f]; }));
  var fresh = authorize_();
  if (fresh.rootId !== context.rootId || registryProjectId_() !== projectId) fail_('OUTSIDE_PROJECT', 'Доступ к проекту изменился.');
  if (segmentCardSnapshotCredential_(fresh.properties) !== credential ||
      (fresh.properties.getProperty('SOURCE_BASES_STORAGE_ID') || REGISTRY_CONFIG.defaultSourceBasesStorageId) !== storageId) return result;
  var choices = [];
  candidates.forEach(function (c) {
    if (registrySegmentProject_(fresh,c.item.id) !== projectId) return;
    var folder = metas.get(c.item.id);
    if (!folder || folder.trashed || folder.mimeType !== folderMime || !folder.parents || folder.parents.length !== 1 || folder.parents[0] !== sourceId) return;
    var files = {companies:null,lpr:null}, liveIds = new Set(c.item.files.filter(function (f) { return f.parentId === c.item.id; }).map(function (f) { return f.id; }));
    var valid = tracking.tables.filter(function (t) { return t.segmentId === c.item.id; }).every(function (table) {
      var meta = metas.get(table.fileId);
      if (!Object.prototype.hasOwnProperty.call(files,table.kind) || files[table.kind] || table.fileId === storageId ||
          !liveIds.has(table.fileId) || !segmentCardFileMatches_(meta,table.fileId,c.item.id,table.kind,context.rootId)) return false;
      files[table.kind] = {id:meta.id,name:meta.name,metadata:meta}; return true;
    });
    if (!valid || segmentCardSnapshotCurrentAccess_(context,c.item.id,storageId,files,registry,credential) !== c.receipt.access) return;
    var page;
    try { page = segmentCardSnapshotUnpack_(heads[c.key] || heads[c.legacyKey]); } catch (ignored) { return; }
    if (!segmentCardSnapshotValidHead_(page,c.item.id,c.receipt,files)) return;
    page.checkedAt = c.receipt.checkedAt; page.name = c.item.name; page.files = segmentCardSnapshotPublicFiles_(files);
    choices.push(page);
  });
  return segmentCardSnapshotFit_(choices, SEGMENT_CARD_SNAPSHOT.dashboardChars - JSON.stringify(projection).length - 20);
}

function segmentCardSnapshotValidHead_(page, segmentId, receipt, files) {
  if (!page || !page.prepared || !page.preview || page.segmentId !== segmentId || page.revision !== receipt.revision ||
      page.offset !== 0 || !Number.isSafeInteger(page.total) || page.total < 0 || !Array.isArray(page.rows)) return false;
  var count = page.rows.length;
  if (count !== Math.min(page.total,SEGMENT_CARD_SNAPSHOT.pageSize) && count !== Math.min(page.total,SEGMENT_CARD_SNAPSHOT.compactSize)) return false;
  if (page.nextOffset !== (count < page.total ? count : null)) return false;
  return page.rows.every(function (row) {
    return row && (row.channel === 'email' || row.channel === 'telegram') && typeof row.value === 'string' &&
      Array.isArray(row.sources) && row.sources.length && row.sources.every(function (source) {
        if (!source || source.sourceType !== 'working' || (source.owner !== 'companies' && source.owner !== 'lpr') ||
            !files[source.owner] || source.id !== files[source.owner].id || typeof source.url !== 'string') return false;
        var base = spreadsheetUrl_(source.id);
        return source.url.indexOf(base) === 0 && /^#gid=\d+&range=A[1-9]\d*$/.test(source.url.slice(base.length));
      });
  });
}

// Allocate a compact page to as many segments as possible before expanding any one of them.
function segmentCardSnapshotFit_(pages, budget) {
  var result = Object.create(null), upgrades = [];
  var choices = pages.map(function (page) {
    var compact = segmentCardSnapshotCompact_(page);
    var compactChars = JSON.stringify(compact).length, extra = compact === page ? 0 : JSON.stringify(page).length - compactChars;
    return {page:page, compact:compact, compactChars:compactChars, extra:extra};
  }).sort(function (a,b) { return a.compactChars - b.compactChars; });
  choices.forEach(function (choice) {
    var id = choice.page.segmentId, cost = id.length + 4 + choice.compactChars;
    if (cost > budget) return;
    result[id] = choice.compact; budget -= cost;
    if (choice.extra > 0) upgrades.push(choice);
  });
  upgrades.sort(function (a,b) { return a.extra - b.extra; }).forEach(function (choice) {
    if (choice.extra > budget) return;
    result[choice.page.segmentId] = choice.page; budget -= choice.extra;
  });
  return result;
}
