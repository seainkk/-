/** Project-wide analytics navigation. Metrics and binding mutations keep their existing APIs. */
function getProjectAnalytics_(request) {
  return api_(function () {
    projectAnalyticsInput_(request, []);
    var context = authorize_(), catalog = projectAnalyticsCatalog_(context), settings = coldySettings_(context);
    projectAnalyticsCurrent_(context, catalog.source);
    return { state: catalog.state, source: catalog.source, segments: catalog.segments,
      coldy: projectAnalyticsConnection_(settings), generatedAt: new Date().toISOString() };
  });
}

/** Existing campaigns annotated with current ownership; no upload or activation is performed. */
function getProjectAnalyticsCampaigns_(request) {
  return api_(function () {
    var input = projectAnalyticsInput_(request, ['segmentId', 'refresh', 'query']), context = authorize_(), segmentId = id_(input.segmentId);
    if (input.refresh !== undefined && typeof input.refresh !== 'boolean') fail_('INVALID_REQUEST', 'Некорректный режим обновления списка рассылок.');
    var query = input.query === undefined ? null : projectAnalyticsSearch_(input.query);
    var scoped = typeof registryProjectScoped_ === 'function' && registryProjectScoped_(), project = scoped ? registryProjectId_() : null;
    if (scoped && registrySegmentProject_(context, segmentId) !== project) fail_('OUTSIDE_SEGMENTS', 'Сегмент недоступен. Обновите список аналитики.');
    var initial = segmentMetadataBinding_(context);
    if (initial.state !== 'ready') fail_('OUTSIDE_SEGMENTS', 'Сегмент недоступен. Обновите список аналитики.');
    var source = initial.folder, selectedFolder;
    try { selectedFolder = segmentFolder_(context, source, segmentId); }
    catch (error) {
      if (['NOT_FOUND','OUTSIDE_REGISTRY','OUTSIDE_SEGMENTS'].indexOf(error.registryCode) < 0) throw error;
      fail_('OUTSIDE_SEGMENTS', 'Сегмент недоступен. Обновите список аналитики.');
    }
    var settings = coldySettings_(context);
    if (!settings.configured) return { state: 'not_configured', segment: segmentFolderResult_(context, selectedFolder), bindings: [], campaigns: [], configured: false, connected: false, generatedAt: null, cached: true };
    if (!query) {
      // The monitoring screen needs only this segment's saved choices. No account-wide API or directory read.
      var saved = coldyCampaignRegistry_(context);
      projectAnalyticsCurrent_(context, { id: source.getId() });
      if (!segmentDirectParent_(selectedFolder, source.getId()) || selectedFolder.isTrashed() ||
          (scoped && registrySegmentProject_(context, segmentId) !== project)) fail_('OUTSIDE_SEGMENTS', 'Сегмент больше недоступен.');
      var currentSettings = coldySettings_(context);
      if (currentSettings.credentialHash !== settings.credentialHash || saved.credentialHash !== settings.credentialHash) fail_('COLDY_CREDENTIAL_CHANGED', 'Подключение Coldy изменилось.');
      var selected = segmentFolderResult_(context, selectedFolder), ids = new Set(), own = saved.bindings.filter(function (binding) {
        var campaignId = coldyCampaignId_(binding.campaignId);
        if (ids.has(campaignId)) fail_('COLDY_STORAGE', 'У рассылки найдены противоречащие привязки. Проверьте журнал Coldy.');
        ids.add(campaignId);
        return binding.segmentId === segmentId;
      });
      var owners = {}; owners[segmentId] = selected;
      return { state: 'ready', segment: selected, bindings: own.map(coldyCampaignPublicBinding_),
        campaigns: own.map(function (binding) { return projectAnalyticsCampaign_({ id: binding.campaignId, name: binding.campaignName, status: binding.campaignStatus }, binding, selected, owners, true); }),
        configured: true, connected: currentSettings.connected === true, generatedAt: null, cached: true };
    }
    var listed;
    if (query.id) listed = { campaigns: [coldyCampaignRead_(context, query.id)], generatedAt: new Date().toISOString(), cached: false };
    else if (input.refresh === true) listed = coldyReadCampaignCatalog_(context, true, settings);
    else {
      var cached = coldyCachedCampaigns_(context, settings);
      listed = { campaigns: cached ? cached.campaigns : [], generatedAt: cached && cached.generatedAt, cached: true };
    }
    var refs = Object.create(null), catalog = projectAnalyticsCatalog_(context, refs);
    if (catalog.state !== 'ready' || catalog.source.id !== source.getId()) fail_('SOURCE_CHANGED', 'Папка сегментов изменилась. Обновите аналитику.');
    var bySegment = Object.create(null), byCampaign = Object.create(null);
    catalog.segments.forEach(function (segment) { bySegment[segment.id] = segment; });
    // The project chooser uses the same binding journal as writes. Enumerate Drive and
    // process the potentially large provider catalog outside the lock.
    var registry = locked_(function () {
      projectAnalyticsCurrent_(context, catalog.source);
      var journal = coldyCampaignRegistry_(context), owners = new Set([segmentId]);
      journal.bindings.forEach(function (binding) {
        var id = coldyCampaignId_(binding.campaignId);
        if (byCampaign[id]) fail_('COLDY_STORAGE', 'У рассылки найдены противоречащие привязки. Проверьте журнал Coldy.');
        byCampaign[id] = binding;
        owners.add(binding.segmentId);
      });
      var properties = scoped ? context.properties.getProperties() : null;
      owners.forEach(function (ownerId) {
        var folder = refs[ownerId];
        if (!folder || folder.isTrashed() || !segmentDirectParent_(folder, catalog.source.id) ||
            (scoped && registrySegmentProject_(context, ownerId, properties) !== project)) delete bySegment[ownerId];
      });
      if (!bySegment[segmentId]) fail_('OUTSIDE_SEGMENTS', 'Сегмент больше не относится к доступной папке.');
      if (journal.credentialHash !== settings.credentialHash) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился. Обновите список рассылок.');
      return journal;
    });
    var current = bySegment[segmentId], seen = Object.create(null), campaigns = [], candidates = 0, matchCount = 0;
    (listed.campaigns || []).forEach(function (campaign) {
      var id = coldyCampaignId_(campaign.id);
      if (seen[id]) fail_('COLDY_RESPONSE', 'Coldy вернул повторяющуюся рассылку.');
      seen[id] = true;
      if (scoped && byCampaign[id] && !bySegment[byCampaign[id].segmentId]) return;
      var name = projectAnalyticsNormalize_(campaign.name);
      var matches = query.id ? id === query.id : query.terms.every(function (term) { return name.indexOf(term) >= 0; });
      if (matches) matchCount++;
      if (!byCampaign[id] || byCampaign[id].segmentId !== segmentId) {
        if (!matches) return;
        if (++candidates > 40) return;
      }
      campaigns.push(projectAnalyticsCampaign_(campaign, byCampaign[id] || null, current, bySegment, true));
    });
    var bindings = registry.bindings.filter(function (binding) { return binding.segmentId === segmentId; });
    bindings.forEach(function (binding) {
      if (!seen[binding.campaignId]) campaigns.push(projectAnalyticsCampaign_({ id: binding.campaignId, name: binding.campaignName, status: binding.campaignStatus }, binding, current, bySegment, !!query.id || input.refresh !== true));
    });
    var collator = new Intl.Collator('ru', { numeric: true });
    campaigns.sort(function (a, b) { return collator.compare(a.name, b.name); });
    var fresh = coldySettings_(context);
    if (settings.credentialHash !== fresh.credentialHash) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился. Обновите список рассылок.');
    return { state: listed.state || 'ready', segment: current, bindings: bindings.map(coldyCampaignPublicBinding_),
      campaigns: campaigns, configured: true, connected: fresh.connected === true,
      generatedAt: listed.generatedAt || null, cached: listed.cached === true, truncated: candidates > 40, matchCount: matchCount };
  });
}

function projectAnalyticsNormalize_(name) { return String(name || '').toLowerCase().replace(/ё/g, 'е'); }

function projectAnalyticsSearch_(value) {
  if (typeof value !== 'string' || value.trim().length < 2 || value.length > 500 || /[\u0000-\u001f]/.test(value)) fail_('INVALID_REQUEST', 'Введите минимум два символа названия, ссылку или ID рассылки Coldy.');
  var query = value.trim(), uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  var direct = query.match(new RegExp('^(' + uuid + ')$', 'i'));
  if (!direct && /^https?:\/\//i.test(query)) {
    if (/^https:\/\/(?:[a-z0-9-]+\.)*coldy\.ai\//i.test(query)) direct = query.match(new RegExp('(?:^|[/#?=&])(' + uuid + ')(?=$|[/#?=&])', 'i'));
    if (!direct) fail_('INVALID_REQUEST', 'Вставьте ссылку Coldy с ID рассылки или скопируйте её UUID.');
  }
  return { id: direct ? direct[1].toLowerCase() : null, terms: projectAnalyticsNormalize_(query).split(/\s+/) };
}

function projectAnalyticsInput_(request, allowed) {
  var input = request === undefined ? {} : object_(request);
  if (Object.keys(input).some(function (key) { return allowed.indexOf(key) === -1; })) fail_('INVALID_REQUEST', 'Неизвестные параметры аналитики проекта.');
  return input;
}

function projectAnalyticsConnection_(settings) {
  return { configured: settings.configured === true, connected: settings.connected === true, checkedAt: settings.checkedAt || null };
}

/** Only immediate Outreach folders are needed; no business spreadsheet is opened. */
function projectAnalyticsCatalog_(context, folderRefs) {
  var names = getSegmentNames_(context, folderRefs), properties = context.properties.getProperties(), result = { state: names.state, source: names.source || null, segments: [] };
  if (names.state === 'ready') result.segments = (names.items || []).filter(function (segment) {
    return typeof registryProjectScoped_ !== 'function' || !registryProjectScoped_() || registrySegmentProject_(context, segment.id, properties) === registryProjectId_();
  }).map(function (segment) {
    return { id: segment.id, name: segment.name, url: segment.url,
      category: segmentCategory_(properties[segmentCategoryKey_(segment.id)], segment.name) };
  });
  return result;
}

function projectAnalyticsCurrent_(context, source) {
  var current = authorize_();
  if (current.rootId !== context.rootId) fail_('SOURCE_CHANGED', 'Привязка реестра изменилась. Обновите аналитику.');
  if (source) {
    var binding = segmentMetadataBinding_(current);
    if (binding.state !== 'ready' || binding.folder.getId() !== source.id) fail_('SOURCE_CHANGED', 'Папка сегментов изменилась. Обновите аналитику.');
  }
  return current;
}

function projectAnalyticsCampaign_(campaign, binding, selected, bySegment, available) {
  var own = !!binding && binding.segmentId === selected.id, foreign = !!binding && !own, owner = binding ? bySegment[binding.segmentId] || null : null;
  return { id: coldyCampaignId_(campaign.id), name: String(campaign.name || ''), status: String(campaign.status || ''),
    bindingId: own ? binding.id : null, ownerSegmentId: owner ? owner.id : null, ownerSegmentName: owner ? owner.name : null,
    selected: own, selectable: !foreign && available === true, available: available === true, missing: available !== true, removable: own,
    blockedReason: foreign ? owner ? 'Уже привязана к сегменту «' + owner.name + '».' : 'Уже привязана к другому, недоступному сегменту.' : !available ? 'Рассылка отсутствует в текущем списке Coldy. Сохранённую привязку можно удалить отдельно.' : '' };
}
