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
    var input = projectAnalyticsInput_(request, ['segmentId', 'refresh']), context = authorize_(), segmentId = id_(input.segmentId);
    if (input.refresh !== undefined && typeof input.refresh !== 'boolean') fail_('INVALID_REQUEST', 'Некорректный режим обновления списка рассылок.');
    var catalog = projectAnalyticsCatalog_(context), selected = catalog.segments.filter(function (segment) { return segment.id === segmentId; })[0];
    if (!selected || catalog.state !== 'ready') fail_('OUTSIDE_SEGMENTS', 'Сегмент недоступен. Обновите список аналитики.');
    coldyCampaignScope_(context, segmentId);
    var settings = coldySettings_(context);
    if (!settings.configured) return { state: 'not_configured', segment: selected, bindings: [], campaigns: [], configured: false, connected: false, generatedAt: null, cached: true };
    // The existing list API owns credential-bound caching and explicit refresh.
    // HTTP is deliberately outside the short snapshot lock below.
    var listed = listColdyCampaigns_({ refresh: input.refresh === true });
    var currentCatalog = projectAnalyticsCatalog_(context), current = currentCatalog.segments.filter(function (segment) { return segment.id === segmentId; })[0];
    if (!current || currentCatalog.state !== 'ready') fail_('OUTSIDE_SEGMENTS', 'Сегмент больше не относится к доступной папке.');
    return locked_(function () {
      projectAnalyticsCurrent_(context, catalog.source); coldyCampaignScope_(context, segmentId);
      if (settings.credentialHash !== coldyCredentialHash_(context)) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился. Обновите список рассылок.');
      projectAnalyticsCurrent_(context, catalog.source);
      var registry = coldyCampaignRegistry_(context), bySegment = Object.create(null), byCampaign = Object.create(null), campaigns = [], seen = Object.create(null), ownerChecked = Object.create(null);
      currentCatalog.segments.forEach(function (segment) { bySegment[segment.id] = segment; });
      registry.bindings.forEach(function (binding) {
        if (bySegment[binding.segmentId] && !ownerChecked[binding.segmentId]) {
          ownerChecked[binding.segmentId] = true;
          try { coldyCampaignScope_(context, binding.segmentId); }
          catch (error) {
            if (binding.segmentId === segmentId || ['OUTSIDE_SEGMENTS', 'OUTSIDE_REGISTRY', 'NOT_FOUND'].indexOf(error.registryCode) < 0) throw error;
            delete bySegment[binding.segmentId];
          }
        }
        var id = coldyCampaignId_(binding.campaignId);
        if (byCampaign[id]) fail_('COLDY_STORAGE', 'У рассылки найдены противоречащие привязки. Проверьте журнал Coldy.');
        byCampaign[id] = binding;
      });
      (listed.campaigns || []).forEach(function (campaign) {
        var id = coldyCampaignId_(campaign.id);
        if (seen[id]) fail_('COLDY_RESPONSE', 'Coldy вернул повторяющуюся рассылку.');
        seen[id] = true;
        if (byCampaign[id] && !bySegment[byCampaign[id].segmentId] && typeof registryProjectScoped_ === 'function' && registryProjectScoped_()) return;
        campaigns.push(projectAnalyticsCampaign_(campaign, byCampaign[id] || null, current, bySegment, true));
      });
      // A missing provider campaign must not silently disappear from saved choices.
      registry.bindings.filter(function (binding) { return binding.segmentId === segmentId && !seen[binding.campaignId]; }).forEach(function (binding) {
        campaigns.push(projectAnalyticsCampaign_({ id: binding.campaignId, name: binding.campaignName, status: binding.campaignStatus }, binding, current, bySegment, false));
      });
      campaigns.sort(function (a, b) { return a.name.localeCompare(b.name, 'ru', { numeric: true }); });
      projectAnalyticsCurrent_(context, currentCatalog.source); coldyCampaignScope_(context, segmentId);
      if (settings.credentialHash !== coldyCredentialHash_(context)) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился. Обновите список рассылок.');
      return { state: listed.state || 'ready', segment: current,
        bindings: registry.bindings.filter(function (binding) { return binding.segmentId === segmentId; }).map(coldyCampaignPublicBinding_),
        campaigns: campaigns, configured: true, connected: coldySettings_(context).connected === true,
        generatedAt: listed.generatedAt || null, cached: listed.cached === true };
    });
  });
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
function projectAnalyticsCatalog_(context) {
  var names = getSegmentNames_(context), properties = context.properties.getProperties(), result = { state: names.state, source: names.source || null, segments: [] };
  if (names.state === 'ready') result.segments = (names.items || []).filter(function (segment) {
    return typeof registryProjectScoped_ !== 'function' || !registryProjectScoped_() || registrySegmentProject_(context, segment.id, properties) === registryProjectId_();
  }).map(function (segment) {
    return { id: segment.id, name: segment.name, url: segment.url,
      category: segmentCategory_(properties[segmentCategoryKey_(segment.id)], segment.name) };
  });
  projectAnalyticsCurrent_(context, result.source);
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
