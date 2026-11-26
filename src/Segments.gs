/**
 * Private metadata projection over the tree already read by getBootstrap().
 * No spreadsheet values, worksheet names or inferred outreach rules are read.
 * SEGMENTS_FOLDER_ID can override the source using an ID in this registry only.
 */
function buildSegments_(context, registry, folders, files, includePendingImports, includeCardParents) {
  var result = {
    state: 'source_missing',
    source: null,
    generatedAt: new Date().toISOString(),
    rulesConfigured: false,
    items: []
  };
  var folderIndex = Object.create(null);
  folderIndex[registry.id] = registry;
  folders.forEach(function (folder) { folderIndex[folder.id] = folder; });

  var configuredId = context.properties.getProperty('SEGMENTS_FOLDER_ID');
  configuredId = typeof configuredId === 'string' ? configuredId.trim() : '';
  var source;
  if (configuredId) {
    // Never resolve an untrusted/configured ID through Drive or leak its name.
    source = folderIndex[configuredId];
    if (!source) {
      result.state = 'source_outside_registry';
      return result;
    }
  } else {
    source = folderIndex[REGISTRY_CONFIG.defaultSegmentsFolderId];
    if (!source) {
      var expectedName = segmentFolderName_(REGISTRY_CONFIG.segmentsFolderName);
      var candidates = folders.filter(function (folder) {
        return folder.parentId === registry.id && segmentFolderName_(folder.name) === expectedName;
      });
      if (candidates.length > 1) {
        result.state = 'source_ambiguous';
        return result;
      }
      source = candidates[0];
    }
    if (!source) return result;
  }

  result.state = 'ready';
  result.source = { id: source.id, name: source.name, url: segmentFolderUrl_(source.id) };
  var children = Object.create(null);
  folders.forEach(function (folder) {
    if (!children[folder.parentId]) children[folder.parentId] = [];
    children[folder.parentId].push(folder);
  });
  var segments = (children[source.id] || []).slice().sort(byName_);
  var categoryProperties = segments.length ? context.properties.getProperties() : {};
  if (typeof registryProjectScoped_ === 'function' && registryProjectScoped_()) {
    result.unassigned = [];
    segments = segments.filter(function (segment) {
      var owner = registrySegmentProject_(context, segment.id, categoryProperties);
      if (!owner) result.unassigned.push({id:segment.id,name:segment.name});
      return owner === registryProjectId_();
    });
  }
  result.items = segments.map(function (segment) {
    var folderIds = [], queue = [segment.id], visited = Object.create(null);
    while (queue.length) {
      var folderId = queue.shift();
      if (visited[folderId] || folderId === source.id || folderId === registry.id) continue;
      visited[folderId] = true;
      folderIds.push(folderId);
      (children[folderId] || []).forEach(function (child) { queue.push(child.id); });
    }
    var found = Object.create(null);
    var tables = files.filter(function (file) {
      if (!visited[file.parentId] || found[file.id]) return false;
      found[file.id] = true;
      return true;
    }).map(function (file) {
      var item = { id: file.id, name: file.name, url: spreadsheetUrl_(file.id) };
      if (includeCardParents) item.parentId = file.parentId;
      return item;
    }).sort(byName_);
    var item = {
      id: segment.id,
      name: segment.name,
      url: segmentFolderUrl_(segment.id),
      category: segmentCategory_(categoryProperties[segmentCategoryKey_(segment.id)], segment.name),
      folderIds: folderIds,
      files: tables,
      tableCount: tables.length,
      channels: {
        email: { state: 'inactive', inWork: null, configured: false },
        telegram: { state: 'inactive', inWork: null, configured: false },
        retargeting: { state: 'inactive', inWork: null, configured: false }
      },
      overallStatus: null,
      companiesInWork: null
    };
    if (includePendingImports) {
      var pending = segmentDashboardPendingImport_(context, segment.id, categoryProperties);
      if (pending) item.pendingImport = pending;
    }
    return item;
  });
  return result;
}

function segmentDashboardPendingImport_(context, segmentId, properties) {
  var id = properties['SEGMENT_RECORD_ACTIVE_' + segmentId];
  if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  var job;
  try { job = JSON.parse(properties[SEGMENT_RECORD_IMPORT.jobPrefix + id]); } catch (error) { return null; }
  if (!job || job.id !== id || job.rootId !== context.rootId || job.segmentId !== segmentId || job.state !== 'processing' ||
      !(Date.parse(job.expiresAt) > Date.now()) || typeof job.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(job.requestId) ||
      digest_([context.rootId, segmentId, job.requestId].join('|')) !== id) return null;
  return { jobId: id, requestId: job.requestId };
}

function segmentFolderName_(value) {
  return String(value || '').normalize('NFC').trim().toLocaleLowerCase('ru-RU');
}

function segmentCategoryKey_(segmentId) {
  return 'SEGMENT_CATEGORY_' + segmentId;
}

function segmentDefaultCategory_(name) {
  return /^веб[\s\u002d\u2010-\u2015\u2212]+студии$/.test(segmentFolderName_(name)) ? 'partners' : 'clients';
}

function segmentStoredCategory_(raw) {
  if (raw) {
    try {
      var value = JSON.parse(raw);
      if (value && (value.category === 'partners' || value.category === 'clients')) return value.category;
    } catch (error) { /* Fall back to the legacy folder name if the value is unavailable. */ }
  }
  return null;
}

function segmentCategory_(raw, name) {
  return segmentStoredCategory_(raw) || segmentDefaultCategory_(name);
}

function segmentFolderResult_(context, folder) {
  var id = folder.getId(), name = folder.getName();
  return { id: id, name: name, url: segmentFolderUrl_(id), category: segmentCategory_(context.properties.getProperty(segmentCategoryKey_(id)), name) };
}

function segmentFolderUrl_(folderId) {
  return 'https://drive.google.com/drive/folders/' + id_(folderId);
}

/** A project directory contains only the names of its direct live folders. */
function getSegmentDirectory_(request) {
  if (request !== undefined && Object.keys(object_(request)).length) fail_('INVALID_REQUEST','У списка сегментов нет параметров.');
  return getAppBootstrap_({includeSegmentDirectory:true}).segmentDirectory;
}

function segmentDirectory_(context, root) {
  if (!registryProjectScoped_()) fail_('OUTSIDE_PROJECT','Выберите проект для просмотра сегментов.');
  var project = registryProjectId_(), folderMime = 'application/vnd.google-apps.folder';
  var configured = (context.properties.getProperty('SEGMENTS_FOLDER_ID') || '').trim();
  var expected = configured || REGISTRY_CONFIG.defaultSegmentsFolderId;
  var result = {state:'unavailable',projectId:project,sourceId:null,checkedAt:Date.now(),revision:null,complete:false,items:[]};
  if (expected === context.rootId || !/^[\w-]{10,200}$/.test(expected)) {
    result.state = 'source_outside_registry'; return result;
  }
  if (typeof Drive === 'undefined' || !Drive.Files || typeof Drive.Files.list !== 'function') return result;
  var limit = REGISTRY_CONFIG.maxTreeEntries;
  function list(parents) {
    var membership = parents.map(function (id) { return "'" + id_(id) + "' in parents"; }).join(' or ');
    var query = {q:"trashed=false and mimeType='" + folderMime + "' and (" + membership + ')',
      fields:'nextPageToken,incompleteSearch,files(id,name,mimeType,parents,trashed)',pageSize:1000,
      supportsAllDrives:true,includeItemsFromAllDrives:true,corpora:root.driveId ? 'drive' : 'user'};
    if (root.driveId) query.driveId = root.driveId;
    try {
      var page = Drive.Files.list(query);
      if (page && !page.incompleteSearch && Array.isArray(page.files)) return page;
    } catch (unavailable) { /* A transport failure cannot confirm an empty directory. */ }
    return null;
  }
  function child(file, parent) {
    return file && file.trashed === false && file.mimeType === folderMime && Array.isArray(file.parents) &&
      file.parents.length === 1 && file.parents[0] === parent && typeof file.name === 'string' && file.name.trim() &&
      typeof file.id === 'string' && /^[\w-]{10,200}$/.test(file.id);
  }
  // Prove the normal root -> Outreach -> segment edges together in one bounded metadata response.
  var sourceId = expected, page = list([context.rootId,sourceId]);
  if (!page) return result;
  if (!page.files.some(function (f) { return child(f, context.rootId) && f.id === sourceId; })) {
    // Existing registries may use a nested binding or a uniquely named fallback folder.
    var binding;
    try { binding = segmentMetadataBinding_(context); }
    catch (error) { if (error.registryCode) throw error; return result; }
    if (binding.state !== 'ready') { result.state = binding.state; return result; }
    sourceId = binding.folder.getId();
    if (sourceId !== expected || page.nextPageToken) {
      page = list([sourceId]);
      if (!page) return result;
    }
    if (binding.folder.isTrashed() || !insideRegistry_(binding.folder,context.rootId)) {
      result.state = 'source_outside_registry'; return result;
    }
  }
  var fresh = authorize_(), props = fresh.properties.getProperties();
  if (fresh.rootId !== context.rootId || registryProjectId_() !== project || (props.SEGMENTS_FOLDER_ID || '').trim() !== configured)
    fail_('SOURCE_CHANGED','Привязка сегментов изменилась. Обновите список.');
  var seen = new Set(), items = [];
  page.files.forEach(function (f) {
    if (!child(f,sourceId) || f.id === sourceId || f.id === context.rootId || seen.has(f.id)) return;
    seen.add(f.id);
    if (registrySegmentProject_(fresh,f.id,props) !== project) return;
    items.push({id:f.id,name:f.name,category:segmentCategory_(props[segmentCategoryKey_(f.id)],f.name)});
  });
  items.sort(function (a,b) { return byName_(a,b) || a.id.localeCompare(b.id); });
  result.complete = !page.nextPageToken && items.length <= limit;
  result.items = items.slice(0,limit); result.sourceId = sourceId; result.state = 'ready'; result.checkedAt = Date.now();
  result.revision = digest_(JSON.stringify([context.rootId,sourceId,project,result.complete,result.items]));
  return result;
}

/** Resolve current Outreach binding without reading the files below it. */
function segmentMetadataBinding_(context) {
  var root = registryRoot_(context), registry = { id: root.getId(), name: root.getName() };
  var empty = { state: 'source_missing', source: null, generatedAt: new Date().toISOString(), rulesConfigured: false, items: [] };
  var configured = context.properties.getProperty('SEGMENTS_FOLDER_ID');
  configured = typeof configured === 'string' ? configured.trim() : '';
  var source = null;
  if (configured) {
    try { source = registryFolder_(context, configured); }
    catch (error) { empty.state = 'source_outside_registry'; return empty; }
    if (source.getId() === context.rootId) { empty.state = 'source_outside_registry'; return empty; }
  } else {
    try { source = registryFolder_(context, REGISTRY_CONFIG.defaultSegmentsFolderId); }
    catch (error) { /* A renamed/missing binding may use a unique root-level folder. */ }
    if (!source) {
      var candidates = [], iterator = root.getFolders();
      while (iterator.hasNext()) {
        var candidate = iterator.next();
        if (!candidate.isTrashed() && segmentFolderName_(candidate.getName()) === segmentFolderName_(REGISTRY_CONFIG.segmentsFolderName)) candidates.push(candidate);
      }
      if (candidates.length > 1) { empty.state = 'source_ambiguous'; return empty; }
      source = candidates[0] || null;
    }
    if (!source) return empty;
    if (source.getId() === context.rootId) { empty.state = 'source_outside_registry'; return empty; }
  }
  return { state: 'ready', registry: registry, folder: source };
}

/** Source cards need only direct segment names, not every Outreach spreadsheet. */
function getSegmentNames_(context, folderRefs) {
  context = context || authorize_();
  var binding = segmentMetadataBinding_(context);
  if (binding.state !== 'ready') return binding;
  var source = binding.folder, sourceId = source.getId(), items = [], seen = Object.create(null);
  var children = source.getFolders(), count = 0;
  while (children.hasNext()) {
    var child = children.next(), childId = child.getId();
    if (seen[childId] || child.isTrashed() || childId === sourceId || childId === context.rootId) continue;
    if (++count > REGISTRY_CONFIG.maxTreeEntries) fail_('REGISTRY_LIMIT', 'В папке сегментов превышен лимит папок.');
    seen[childId] = true;
    var name = child.getName(), parents = child.getParents(), direct = false, examined = 0;
    while (parents.hasNext()) {
      if (++examined > REGISTRY_CONFIG.maxAncestryNodes) break;
      var parent = parents.next();
      if (parent.getId() === sourceId && !parent.isTrashed()) { direct = true; break; }
    }
    if (direct && !child.isTrashed()) {
      items.push({ id: childId, name: name, url: segmentFolderUrl_(childId) });
      if (folderRefs) folderRefs[childId] = child;
    }
  }
  var descriptor = { id: sourceId, name: source.getName(), url: segmentFolderUrl_(sourceId) };
  // A stale child iterator cannot keep associations alive after its source moves.
  if (source.isTrashed() || !insideRegistry_(source, context.rootId)) {
    return { state: 'source_outside_registry', source: null, items: [] };
  }
  return { state: 'ready', source: descriptor, items: items.sort(byName_) };
}

/** Enumerate only previously verified parents. A whole level usually fits in one Drive request. */
function segmentDashboardTree_(context, sourceId, ownership, serviceId) {
  if (typeof Drive === 'undefined' || !Drive.Files || typeof Drive.Files.list !== 'function') return null;
  var folderMime = 'application/vnd.google-apps.folder', bookMime = REGISTRY_CONFIG.spreadsheetMime;
  var folders = [], books = [], visited = new Set([sourceId]), parents = [sourceId], depth = 0, count = 0;
  while (parents.length) {
    if (depth > REGISTRY_CONFIG.maxTreeDepth) fail_('REGISTRY_LIMIT', 'Слишком много уровней папок внутри сегментов.');
    var next = [];
    for (var start = 0; start < parents.length; start += 40) {
      var group = parents.slice(start, start + 40), allowed = new Set(group);
      var parentQuery = group.map(function (id) { return "'" + id_(id) + "' in parents"; }).join(' or ');
      var query = {q:"trashed=false and (mimeType='" + folderMime + "' or mimeType='" + bookMime + "') and (" + parentQuery + ')',
        fields:'nextPageToken,incompleteSearch,files(id,name,mimeType,parents,trashed)',pageSize:1000,
        supportsAllDrives:true,includeItemsFromAllDrives:true};
      var tokens = new Set();
      for (;;) {
        var page;
        try { page = Drive.Files.list(query); }
        catch (error) {
          // Retry incomplete listings with folder iterators. Propagate permission failures.
          if (/forbidden|permission|unauthori[sz]ed|not found|access denied|insufficient authentication|\b(401|403|404)\b/i.test(String(error.message || error)))
            fail_('SOURCE_CHANGED', 'Доступ к папкам сегментов изменился. Обновите список.');
          return null;
        }
        if (!page || page.incompleteSearch || !Array.isArray(page.files)) return null;
        for (var i = 0; i < page.files.length; i++) {
          var file = page.files[i];
          if (!file || file.trashed !== false || (file.mimeType !== folderMime && file.mimeType !== bookMime)) continue;
          // DriveApp preserves historical multi-parent behavior for older items.
          if (!Array.isArray(file.parents) || file.parents.length !== 1) return null;
          var parent = file.parents[0];
          if (!allowed.has(parent) || visited.has(file.id) || file.id === serviceId) continue;
          if (++count > REGISTRY_CONFIG.maxTreeEntries) fail_('REGISTRY_LIMIT', 'В папке сегментов превышен лимит папок и таблиц.');
          visited.add(file.id);
          var row = {id:id_(file.id),name:file.name,parentId:parent};
          if (file.mimeType === bookMime) books.push(row);
          else {
            folders.push(row);
            if (depth || !ownership || registrySegmentProject_(context, row.id, ownership) === registryProjectId_()) next.push(row.id);
          }
        }
        if (!page.nextPageToken) break;
        if (typeof page.nextPageToken !== 'string' || tokens.has(page.nextPageToken)) return null;
        query.pageToken = page.nextPageToken; tokens.add(page.nextPageToken);
      }
    }
    parents = next; depth++;
  }
  return {folders:folders,files:books};
}

/** Metadata for the Outreach subtree only; a large source catalog is unrelated. */
function getSegmentsMetadata_(context, includePendingImports, includeCardParents, batch) {
  context = context || authorize_();
  var binding = segmentMetadataBinding_(context);
  if (binding.state !== 'ready') return binding;
  var registry = binding.registry, source = binding.folder;
  var folders = [{ id: source.getId(), name: source.getName(), parentId: registry.id }], files = [], visited = Object.create(null), count = 0;
  var ownership = typeof registryProjectScoped_ === 'function' && registryProjectScoped_() ? context.properties.getProperties() : null;
  var serviceId = context.properties.getProperty('SOURCE_BASES_STORAGE_ID') || REGISTRY_CONFIG.defaultSourceBasesStorageId;
  if (batch) {
    var tree = segmentDashboardTree_(context, source.getId(), ownership, serviceId);
    if (tree) return buildSegments_(context, registry, folders.concat(tree.folders), tree.files, includePendingImports, includeCardParents);
  }
  function visit(folder, depth) {
    if (visited[folder.getId()]) return;
    if (depth > REGISTRY_CONFIG.maxTreeDepth) fail_('REGISTRY_LIMIT', 'Слишком много уровней папок внутри сегментов.');
    visited[folder.getId()] = true;
    var books = folder.getFilesByType(REGISTRY_CONFIG.spreadsheetMime);
    while (books.hasNext()) {
      var file = books.next();
      if (file.isTrashed() || file.getId() === serviceId) continue;
      if (++count > REGISTRY_CONFIG.maxTreeEntries) fail_('REGISTRY_LIMIT', 'В папке сегментов превышен лимит папок и таблиц.');
      files.push({ id: file.getId(), name: file.getName(), parentId: folder.getId(), url: spreadsheetUrl_(file.getId()) });
    }
    var children = folder.getFolders();
    while (children.hasNext()) {
      var child = children.next();
      if (child.isTrashed() || visited[child.getId()]) continue;
      if (++count > REGISTRY_CONFIG.maxTreeEntries) fail_('REGISTRY_LIMIT', 'В папке сегментов превышен лимит папок и таблиц.');
      folders.push({ id: child.getId(), name: child.getName(), parentId: folder.getId() });
      if (depth === 0 && ownership && registrySegmentProject_(context, child.getId(), ownership) !== registryProjectId_()) continue;
      visit(child, depth + 1);
    }
  }
  visit(source, 0);
  return buildSegments_(context, registry, folders, files, includePendingImports, includeCardParents);
}
