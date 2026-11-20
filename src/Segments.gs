/**
 * Private metadata projection over the tree already read by getBootstrap().
 * No spreadsheet values, worksheet names or inferred outreach rules are read.
 * SEGMENTS_FOLDER_ID can override the source using an ID in this registry only.
 */
function buildSegments_(context, registry, folders, files, includePendingImports) {
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
      return { id: file.id, name: file.name, url: spreadsheetUrl_(file.id) };
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
function getSegmentNames_(context) {
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
    if (direct && !child.isTrashed()) items.push({ id: childId, name: name, url: segmentFolderUrl_(childId) });
  }
  var descriptor = { id: sourceId, name: source.getName(), url: segmentFolderUrl_(sourceId) };
  // A stale child iterator cannot keep associations alive after its source moves.
  if (source.isTrashed() || !insideRegistry_(source, context.rootId)) {
    return { state: 'source_outside_registry', source: null, items: [] };
  }
  return { state: 'ready', source: descriptor, items: items.sort(byName_) };
}

/** Metadata for the Outreach subtree only; a large source catalog is unrelated. */
function getSegmentsMetadata_(context, includePendingImports) {
  context = context || authorize_();
  var binding = segmentMetadataBinding_(context);
  if (binding.state !== 'ready') return binding;
  var registry = binding.registry, source = binding.folder;
  var folders = [{ id: source.getId(), name: source.getName(), parentId: registry.id }], files = [], visited = Object.create(null), count = 0;
  var serviceId = context.properties.getProperty('SOURCE_BASES_STORAGE_ID') || REGISTRY_CONFIG.defaultSourceBasesStorageId;
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
      visit(child, depth + 1);
    }
  }
  visit(source, 0);
  return buildSegments_(context, registry, folders, files, includePendingImports);
}
