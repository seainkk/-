/** Fast change signal for the visible catalogue. It neither opens a sheet nor synchronizes records. */
function getSourceBasesRevision_(request) {
  return api_(function () {
    var input = request === undefined ? {} : object_(request);
    if (Object.keys(input).length) fail_('INVALID_REQUEST','Область реестра определяется выбранным проектом.');
    var current = authorize_(), binding = sourceBasesSource_(current);
    if (binding.state !== 'ready') return {revision:null};
    var files = sourceBasesDiscover_(current,binding.folder);
    return {revision:sourceBasesRevisionToken_(current,binding,files)};
  });
}

/** A hint only. Direct changes to linked segment folders also get reconciled on the full refresh. */
function sourceBasesRevisionToken_(context,binding,files) {
  var fresh = authorize_();
  if (fresh.rootId !== context.rootId) fail_('SOURCE_CHANGED','Папка реестра изменилась. Обновите реестр.');
  if (typeof Drive === 'undefined' || !Drive.Files || typeof Drive.Files.get !== 'function') return null;
  var props = fresh.properties.getProperties();
  var storageId = props.SOURCE_BASES_STORAGE_ID || REGISTRY_CONFIG.defaultSourceBasesStorageId;
  var metadata;
  try { metadata = Drive.Files.get(id_(storageId),{fields:'id,trashed,parents,mimeType,version',supportsAllDrives:true}); }
  catch (error) { return null; }
  if (!metadata || metadata.id !== storageId || metadata.trashed !== false ||
      metadata.mimeType !== REGISTRY_CONFIG.spreadsheetMime || !Array.isArray(metadata.parents) ||
      metadata.parents.length !== 1 || metadata.parents[0] !== fresh.rootId || !/^\d+$/.test(String(metadata.version))) return null;
  var scopes = Object.keys(props).filter(function (key) { return key.indexOf('REGISTRY_SEGMENT_PROJECT_') === 0; })
    .sort().map(function (key) { return [key,props[key]]; });
  var identities = files.map(function (file) { return [file.id,file.name,file.mimeType,file.url]; })
    .sort(function (a,b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  return digest_(JSON.stringify(['catalogue-v1',fresh.rootId,registryProjectId_(),binding.source.id,binding.source.name,
    metadata.id,String(metadata.version),scopes,identities]));
}
