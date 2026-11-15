/**
 * Private metadata projection over the tree already read by getBootstrap().
 * No spreadsheet values, worksheet names or inferred outreach rules are read.
 * SEGMENTS_FOLDER_ID can override the source using an ID in this registry only.
 */
function buildSegments_(context, registry, folders, files) {
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
    return {
      id: segment.id,
      name: segment.name,
      url: segmentFolderUrl_(segment.id),
      folderIds: folderIds,
      files: tables,
      tableCount: tables.length,
      channels: {
        email: { state: 'unknown', inWork: null },
        telegram: { state: 'unknown', inWork: null },
        retargeting: { state: 'unknown', inWork: null }
      },
      overallStatus: null,
      companiesInWork: null
    };
  });
  return result;
}

function segmentFolderName_(value) {
  return String(value || '').normalize('NFC').trim().toLocaleLowerCase('ru-RU');
}

function segmentFolderUrl_(folderId) {
  return 'https://drive.google.com/drive/folders/' + id_(folderId);
}
