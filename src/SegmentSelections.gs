/** Team filters and immutable export snapshots, persisted in the existing root-scoped private Drive store. */
function segmentSelectionScope_(segmentId, write) {
  var context = authorize_(), project = registryProjectId_();
  if (!project || registrySegmentProject_(context, segmentId) !== project) fail_('OUTSIDE_PROJECT', 'Сегмент не входит в выбранный проект.');
  segmentFolder_(context, segmentSourceFolder_(context), segmentId, true);
  if (write) segmentRequireStorageWrite_(sourceBasesStorage_(context));
  return {context: context, owner: digest_(JSON.stringify([context.rootId, project, segmentId]))};
}

function segmentSelectionIndex_(scope) {
  var index = coldyLoad_(scope.context, 'segmentfilters', scope.owner) || {version: 1, filters: [], exports: []};
  if (index.version !== 1 || !Array.isArray(index.filters) || !Array.isArray(index.exports)) fail_('STORAGE_SCHEMA', 'Не удалось прочитать сохранённые подборки сегмента.');
  return index;
}

function segmentSelectionName_(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 160 || /[\u0000-\u001f\u007f]/.test(name)) fail_('INVALID_REQUEST', 'Введите название длиной до 160 символов.');
  return name.trim();
}

function segmentSelectionFilter_(input) {
  var f = segmentCardFilter_(input);
  return {channel: f.channel, owner: f.owner, queue: f.queue, query: f.query};
}

function segmentSelectionPublic_(entry) {
  var result = {id: entry.id, name: entry.name, createdAt: entry.createdAt};
  if (entry.count !== undefined) {
    result.count = entry.count; result.campaignId = entry.campaignId || ''; result.campaignName = entry.campaignName || '';
  } else Object.assign(result, entry.filter);
  return result;
}

function getSegmentSelections_(request) {
  return api_(function () {
    var input = segmentInput_(request, ['segmentId']), segmentId = id_(input.segmentId), scope = segmentSelectionScope_(segmentId, false), index = segmentSelectionIndex_(scope);
    var campaigns = [], available = true;
    try {
      if (coldySettings_(scope.context).configured) campaigns = coldyCampaignRegistry_(scope.context).bindings
        .filter(function (b) { return b.segmentId === segmentId; }).map(function (b) { return {id:b.campaignId,name:b.campaignName}; });
    } catch (error) { available = false; }
    return {filters: index.filters.map(segmentSelectionPublic_), exports: index.exports.map(segmentSelectionPublic_), campaigns: campaigns, campaignsAvailable: available};
  });
}

function segmentSelectionOperation_(scope, requestId) {
  return digest_(JSON.stringify([scope.owner, segmentRequestId_(requestId)]));
}

function segmentSelectionReplay_(index, id, fingerprint) {
  var entry = index.filters.concat(index.exports).find(function (saved) { return saved.id === id; });
  if (entry && entry.fingerprint !== fingerprint) fail_('REQUEST_ID_REUSED', 'Этот запрос уже использован для другой подборки.');
  return entry ? segmentSelectionPublic_(entry) : null;
}

function saveSegmentFilter_(request) {
  return api_(function () {
    var input = segmentInput_(request, ['segmentId','name','channel','owner','queue','query','requestId']), segmentId = id_(input.segmentId);
    var name = segmentSelectionName_(input.name), filter = segmentSelectionFilter_(input), fingerprint = digest_(JSON.stringify(['filter', name, filter]));
    return locked_(function () {
      var scope = segmentSelectionScope_(segmentId, true), index = segmentSelectionIndex_(scope), id = segmentSelectionOperation_(scope, input.requestId);
      var replay = segmentSelectionReplay_(index, id, fingerprint);
      if (replay) return replay;
      // A previous export may have a durable payload while its directory entry is still pending.
      segmentSelectionPayload_(scope, id, fingerprint);
      var entry = {id: id, name: name, filter: filter, createdAt: new Date().toISOString(), fingerprint: fingerprint};
      index.filters.push(entry);
      coldySave_(scope.context, 'segmentfilters', scope.owner, index);
      return segmentSelectionPublic_(entry);
    });
  });
}

function segmentSelectionRowsDigest_(rows) {
  if (!Array.isArray(rows) || rows.length > CONTACT_SYNC.maxTargetRows * 4) fail_('INVALID_REQUEST', 'Состав выгрузки некорректен.');
  var keys = rows.map(function (row) {
    if (!row || !['email','telegram'].includes(row.channel) || typeof row.value !== 'string' || !row.value || row.value.length > 1024) fail_('INVALID_REQUEST', 'В выгрузке есть некорректный контакт.');
    return JSON.stringify([row.channel, row.value]);
  });
  return digest_(JSON.stringify(keys.sort()));
}

function segmentSelectionPayload_(scope, id, fingerprint) {
  var saved = coldyLoad_(scope.context, 'segmentexport', scope.owner + '/' + id);
  if (!saved) return null;
  if (saved.version !== 1 || !saved.entry || saved.entry.id !== id || !Array.isArray(saved.rows) || saved.rows.length !== saved.entry.count ||
      segmentSelectionRowsDigest_(saved.rows) !== saved.entry.rowsDigest) fail_('STORAGE_SCHEMA', 'Состав сохранённой выгрузки требует проверки.');
  if (fingerprint && saved.entry.fingerprint !== fingerprint) fail_('REQUEST_ID_REUSED', 'Этот запрос уже использован для другой выгрузки.');
  return saved;
}

function saveSegmentExport_(request) {
  return api_(function () {
    var input = segmentInput_(request, ['segmentId','name','revision','filter','rows','requestId','campaignId']), segmentId = id_(input.segmentId);
    var name = segmentSelectionName_(input.name), filter = segmentSelectionFilter_(segmentInput_(input.filter || {}, ['channel','owner','queue','query']));
    var campaignId = input.campaignId ? coldyCampaignId_(input.campaignId) : '';
    if (typeof input.revision !== 'string' || !/^[\w-]{43}$/.test(input.revision)) fail_('INVALID_REQUEST', 'Сначала откройте актуальную карточку сегмента.');
    var submitted = input.rows === undefined ? '' : segmentSelectionRowsDigest_(input.rows);
    var fingerprint = digest_(JSON.stringify(['export', name, campaignId, filter, input.revision, submitted]));
    var scope = segmentSelectionScope_(segmentId, true), id = segmentSelectionOperation_(scope, input.requestId);
    var replay = segmentSelectionReplay_(segmentSelectionIndex_(scope), id, fingerprint);
    if (replay) return replay;
    // A prior attempt may have stored the immutable payload before its index write was acknowledged.
    var staged = segmentSelectionPayload_(scope, id, fingerprint), prepared;
    if (!staged) {
      var data = segmentCardData_(scope.context, segmentId, input.revision), campaignName = '';
      if (campaignId) {
        var campaign = data.campaigns.bindings.find(function (item) { return item.binding.campaignId === campaignId; });
        if (!campaign) fail_('COLDY_BINDING_MISSING', 'Выбранная рассылка не подключена к сегменту.');
        campaignName = campaign.binding.campaignName;
      }
      var rows = segmentCardMatchingRows_(data.snapshot, filter).map(function (row) { return {channel: row.channel, value: row.value}; });
      var rowsDigest = segmentSelectionRowsDigest_(rows);
      if (submitted && submitted !== rowsDigest) fail_('SEGMENT_EXPORT_CHANGED', 'Показанный набор контактов отличается от текущей подборки.');
      var entry = {id: id, name: name, campaignId: campaignId, campaignName: campaignName, createdAt: new Date().toISOString(), count: rows.length,
        filter: filter, revision: input.revision, fingerprint: fingerprint, rowsDigest: rowsDigest};
      prepared = {version: 1, entry: entry, rows: rows};
    }
    return locked_(function () {
      var current = segmentSelectionScope_(segmentId, true);
      if (current.owner !== scope.owner) segmentCardChanged_();
      var index = segmentSelectionIndex_(current), replayed = segmentSelectionReplay_(index, id, fingerprint);
      if (replayed) return replayed;
      var payload = segmentSelectionPayload_(current, id, fingerprint);
      if (!payload) {
        if (!prepared || segmentCardRevision_(current.context, segmentCardFiles_(current.context, segmentId), segmentCardCampaigns_(current.context, segmentId)) !== input.revision) segmentCardChanged_();
        payload = prepared;
        coldySave_(current.context, 'segmentexport', current.owner + '/' + id, payload);
      }
      index.exports.push(payload.entry);
      coldySave_(current.context, 'segmentfilters', current.owner, index);
      return segmentSelectionPublic_(payload.entry);
    });
  });
}

function getSegmentExport_(request) {
  return api_(function () {
    var input = segmentInput_(request, ['segmentId','id','offset','limit']), segmentId = id_(input.segmentId), id = id_(input.id);
    var scope = segmentSelectionScope_(segmentId, false), index = segmentSelectionIndex_(scope), page = segmentCardFilter_(input);
    var entry = index.exports.find(function (e) { return e.id === id; });
    if (!entry) fail_('NOT_FOUND', 'Выгрузка в этом сегменте не найдена.');
    var saved = segmentSelectionPayload_(scope, id, entry.fingerprint);
    if (!saved || saved.entry.rowsDigest !== entry.rowsDigest) fail_('STORAGE_SCHEMA', 'Состав сохранённой выгрузки требует проверки.');
    var result = segmentSelectionPublic_(entry), end = page.offset + page.limit;
    result.rows = saved.rows.slice(page.offset, end); result.nextOffset = end < entry.count ? end : null;
    return result;
  });
}
