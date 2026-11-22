/** Project ownership is common to the team. Each interactive request carries its own project. */
function registryProjectScoped_() {
  return typeof SHARED_REQUEST_SCOPE_ !== 'undefined' && !!SHARED_REQUEST_SCOPE_ && !!SHARED_REQUEST_SCOPE_.projectId;
}

function registryProjectId_() { return registryProjectScoped_() ? SHARED_REQUEST_SCOPE_.projectId : 'numshield'; }
function registryProjectName_(id) { return id === 'numshield' ? 'Намшилд' : id === 'neosender' ? 'Нео Сендер' : ''; }

function registrySegmentProject_(context, segmentId, snapshot) {
  var key = 'REGISTRY_SEGMENT_PROJECT_' + id_(segmentId), raw = snapshot ? snapshot[key] : context.properties.getProperty(key);
  if (!raw) return null;
  var saved;
  try { saved = JSON.parse(raw); } catch (error) { fail_('PROJECT_STORAGE', 'Проверьте сохранённый проект сегмента.'); }
  if (!saved || saved.rootId !== context.rootId || !registryProjectName_(saved.projectId)) fail_('PROJECT_STORAGE', 'Привязка проекта не относится к текущему реестру.');
  return saved.projectId;
}

function registryRequireSegment_(context, segmentId) {
  if (registryProjectScoped_() && registrySegmentProject_(context, segmentId) !== registryProjectId_()) fail_('OUTSIDE_PROJECT', 'Сегмент не входит в выбранный проект.');
}

function registryProjectOutreach_(context) {
  if (!registryProjectScoped_()) return null;
  var binding = segmentMetadataBinding_(context);
  if (binding.state === 'source_missing') return null;
  if (binding.state !== 'ready') fail_('OUTSIDE_SEGMENTS', 'Проверьте привязку папки сегментов реестра.');
  return binding.folder.getId();
}

/** Generic Drive operations also accept a nested segment folder or file. */
function registryGuardItem_(context, item) {
  var stagingId = context.properties.getProperty('PREPARED_STAGING_FOLDER_ID'), outreachId = registryProjectOutreach_(context);
  if (!outreachId && !stagingId) return null;
  var queue = [item], seen = Object.create(null), examined = 0;
  while (queue.length) {
    var current = queue.shift(), id = current.getId();
    if (stagingId && id === stagingId) fail_('PROTECTED_FILE', 'Служебная папка подготовки доступна только через импорт базы.');
    if (seen[id] || id === context.rootId || id === outreachId) continue;
    seen[id] = true;
    var parents = current.getParents();
    while (parents.hasNext()) {
      if (++examined > REGISTRY_CONFIG.maxAncestryNodes) fail_('REGISTRY_LIMIT', 'Не удалось подтвердить проект этой папки.');
      var parent = parents.next();
      if (parent.isTrashed()) continue;
      if (parent.getId() === outreachId) {
        if (id !== item.getId() || typeof current.getFolders === 'function') registryRequireSegment_(context, id);
      } else queue.push(parent);
    }
  }
  return outreachId;
}

/** Caller holds the registry write lock and has already resolved the real segment folder. */
function registryAssignSegment_(context, segmentId) {
  var existing = registrySegmentProject_(context, segmentId), projectId = registryProjectId_();
  if (existing && existing !== projectId) fail_('OUTSIDE_PROJECT', 'Сегмент уже относится к другому проекту. Обновите список.');
  if (!existing) context.properties.setProperty('REGISTRY_SEGMENT_PROJECT_' + segmentId, JSON.stringify({rootId:context.rootId,projectId:projectId}));
  return projectId;
}

function claimRegistrySegment_(request) {
  return api_(function () {
    var input = segmentInput_(request, ['segmentId','requestId']), segmentId = id_(input.segmentId);
    segmentRequestId_(input.requestId);
    authorize_();
    return locked_(function () {
      var context = authorize_(), folder = segmentFolder_(context, segmentSourceFolder_(context), segmentId);
      segmentRequireStorageWrite_(sourceBasesStorage_(context));
      return {segmentId:folder.getId(),projectId:registryAssignSegment_(context, folder.getId())};
    });
  });
}
