/** Segment-scoped Coldy campaigns. Upload receipts precede every remote mutation. */
var COLDY_CAMPAIGNS = Object.freeze({ version: 1, batch: 100, reconcile: 5, maxRows: 100000, maxColumns: 512, maxContacts: 20000, previewMillis: 15 * 60 * 1000,
  leaseMillis: 3 * 60 * 1000, headers: ['Coldy: рассылки', 'Coldy: статус', 'Coldy: дата загрузки'] });

function getColdyBindings_(request) {
  return api_(function () {
    var input = segmentInput_(request, ['segmentId']), context = authorize_(), segmentId = id_(input.segmentId);
    coldyCampaignScope_(context, segmentId);
    var settings = coldySettings_(context);
    if (!settings.configured) return { bindings: [], campaigns: [], configured: false, connected: false };
    return locked_(function () {
      coldyCampaignScope_(context, segmentId);
      if (settings.credentialHash !== coldyCredentialHash_(context)) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился. Обновите список рассылок.');
      var registry = coldyCampaignRegistry_(context);
      var own = registry.bindings.filter(function (binding) { return binding.segmentId === segmentId; });
      return { bindings: own.map(coldyCampaignPublicBinding_), campaigns: own.map(function (binding) {
        return { id: binding.campaignId, name: binding.campaignName, status: binding.campaignStatus };
      }), configured: true, connected: coldySettings_(context).connected === true };
    });
  });
}

function saveColdyBinding_(request) {
  return api_(function () {
    var input = segmentInput_(request, ['segmentId', 'campaignId', 'includeCompanies', 'includeLpr', 'autoUpload', 'allowActive', 'preserveExisting', 'requestId']), context = authorize_();
    var segmentId = id_(input.segmentId), campaignId = coldyCampaignId_(input.campaignId), requestId = segmentRequestId_(input.requestId);
    ['includeCompanies', 'includeLpr', 'autoUpload', 'allowActive'].forEach(function (field) { if (typeof input[field] !== 'boolean') fail_('INVALID_REQUEST', 'Укажите источники и параметры загрузки Coldy.'); });
    if (input.preserveExisting !== undefined && typeof input.preserveExisting !== 'boolean') fail_('INVALID_REQUEST', 'Некорректный режим добавления привязки Coldy.');
    if (!input.includeCompanies && !input.includeLpr) fail_('COLDY_SOURCE_REQUIRED', 'Выберите компании или ЛПР.');
    coldyCampaignScope_(context, segmentId);
    var fingerprint = [segmentId, campaignId, input.includeCompanies, input.includeLpr, input.autoUpload, input.allowActive];
    // Keep the classic absent/false fingerprint unchanged for pending request IDs.
    if (input.preserveExisting === true) fingerprint.push('preserveExisting:v1');
    var requestHash = digest_(JSON.stringify(fingerprint));
    var oldReceipt = locked_(function () {
      coldyCampaignScope_(context, segmentId);
      var registry = coldyCampaignRegistry_(context);
      if (typeof registryProjectScoped_ === 'function' && registryProjectScoped_() &&
          !coldyProjectCampaigns_(context, registry.credentialHash, [{id:campaignId}], registry).length)
        fail_('COLDY_CAMPAIGN_BOUND', 'Рассылка недоступна для привязки в этом проекте.');
      return coldyCampaignReceipt_(registry, requestId, requestHash);
    });
    if (oldReceipt) return { binding: oldReceipt.binding };
    var credentialHash = coldyCredentialHash_(context), campaign = coldyCampaignRead_(context, campaignId);
    return locked_(function () {
      if (credentialHash !== coldyCredentialHash_(context)) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился. Обновите настройки.');
      coldyCampaignScope_(context, segmentId);
      var registry = coldyCampaignRegistry_(context);
      var receipt = coldyCampaignReceipt_(registry, requestId, requestHash);
      if (receipt) return { binding: receipt.binding };
      var existing = registry.bindings.filter(function (binding) { return binding.campaignId === campaignId; })[0];
      if (existing && existing.segmentId !== segmentId) fail_('COLDY_CAMPAIGN_BOUND', 'Эта рассылка уже связана с другим сегментом. Для точной аналитики используйте отдельную рассылку.');
      if (existing && input.preserveExisting === true) {
        var preserved = coldyCampaignPublicBinding_(existing);
        coldyCampaignRemember_(registry, requestId, requestHash, { binding: preserved });
        coldyCampaignSaveRegistry_(context, registry);
        return { binding: preserved };
      }
      var binding = { id: existing ? existing.id : digest_('binding|' + Utilities.getUuid()), segmentId: segmentId, campaignId: campaignId, campaignName: campaign.name, campaignStatus: campaign.status,
        includeCompanies: input.includeCompanies, includeLpr: input.includeLpr, autoUpload: input.autoUpload, allowActive: input.allowActive, revision: existing ? existing.revision + 1 : 1, updatedAt: new Date().toISOString() };
      if (existing) registry.bindings = registry.bindings.filter(function (item) { return item.id !== existing.id; });
      if (registry.bindings.length >= 100) fail_('COLDY_BINDING_LIMIT', 'Достигнут лимит связей рассылок.');
      registry.bindings.push(binding); coldyCampaignRemember_(registry, requestId, requestHash, { binding: coldyCampaignPublicBinding_(binding) });
      coldyCampaignSaveRegistry_(context, registry);
      return { binding: coldyCampaignPublicBinding_(binding) };
    });
  });
}

function removeColdyBinding_(request) {
  return api_(function () {
    var input = segmentInput_(request, ['segmentId', 'bindingId', 'requestId']), context = authorize_(), segmentId = id_(input.segmentId), bindingId = coldyCampaignLocalId_(input.bindingId), requestId = segmentRequestId_(input.requestId);
    return locked_(function () {
      coldyCampaignScope_(context, segmentId);
      var registry = coldyCampaignRegistry_(context), hash = digest_('remove|' + segmentId + '|' + bindingId), receipt = coldyCampaignReceipt_(registry, requestId, hash);
      if (receipt) return { removed: true };
      coldyCampaignBinding_(registry, segmentId, bindingId);
      registry.bindings = registry.bindings.filter(function (binding) { return binding.id !== bindingId; });
      coldyCampaignRemember_(registry, requestId, hash, { removed: true }); coldyCampaignSaveRegistry_(context, registry);
      return { removed: true };
    });
  });
}

function previewColdyUpload_(request) {
  return api_(function () {
    var input = segmentInput_(request, ['segmentId', 'bindingId']), context = authorize_(), segmentId = id_(input.segmentId), bindingId = coldyCampaignLocalId_(input.bindingId);
    coldyCampaignScope_(context, segmentId);
    var snapshot = locked_(function () { var binding = coldyCampaignBinding_(coldyCampaignRegistry_(context), segmentId, bindingId); return { binding: binding, ledger: coldyCampaignLedger_(context, binding), credentialHash: coldyCredentialHash_(context) }; });
    var binding = snapshot.binding, campaign = coldyCampaignRead_(context, binding.campaignId), collected = coldyCampaignCollect_(context, binding, snapshot.ledger);
    var token = digest_('preview|' + Utilities.getUuid()), preview = { version: 1, token: token, segmentId: segmentId, bindingId: bindingId, revision: binding.revision, credentialHash: snapshot.credentialHash,
      expiresAt: Date.now() + COLDY_CAMPAIGNS.previewMillis, fingerprint: coldyCampaignFingerprint_(collected), emails: collected.contacts.map(function (contact) { return contact.email; }) };
    locked_(function () {
      coldyCampaignScope_(context, segmentId);
      var current = coldyCampaignBinding_(coldyCampaignRegistry_(context), segmentId, bindingId);
      if (snapshot.credentialHash !== coldyCredentialHash_(context) || current.revision !== binding.revision) fail_('COLDY_SOURCE_CHANGED', 'Настройки Coldy изменились. Обновите предпросмотр.');
      coldySave_(context, 'campaignpreview', coldyCampaignOwner_(context, bindingId), preview);
    });
    var allowed = coldyCampaignCanUpload_(campaign, binding), warnings = collected.warnings.slice();
    if (!allowed) warnings.push(coldyCampaignBlockedMessage_(campaign));
    if (campaign.status === 'Active' && binding.allowActive) warnings.push('Рассылка активна: добавленные контакты могут сразу попасть в отправку по её настройкам.');
    return { previewToken: token, segmentId: segmentId, bindingId: bindingId, campaign: campaign, counts: collected.counts,
      sample: collected.contacts.slice(0, 10).map(function (contact) { return { email: contact.email, company: contact.company || '', name: contact.name || '' }; }), canUpload: allowed && collected.contacts.length > 0, warnings: warnings };
  });
}

function startColdyUpload_(request) {
  return api_(function () {
    var input = segmentInput_(request, ['segmentId', 'bindingId', 'previewToken', 'requestId']), context = authorize_(), segmentId = id_(input.segmentId), bindingId = coldyCampaignLocalId_(input.bindingId), token = coldyCampaignLocalId_(input.previewToken), requestId = segmentRequestId_(input.requestId);
    return coldyCampaignWithLease_(context, segmentId, bindingId, function (binding, ledger) {
      var requestHash = digest_('upload|' + token);
      var previous = coldyCampaignUploadReceipt_(ledger, requestId, requestHash);
      if (previous) return previous;
      if (ledger.job && ledger.job.state === 'processing') fail_('COLDY_UPLOAD_BUSY', 'Продолжите текущую загрузку перед новой.');
      var preview = coldyLoad_(context, 'campaignpreview', coldyCampaignOwner_(context, bindingId));
      if (!preview || preview.token !== token || preview.segmentId !== segmentId || preview.bindingId !== bindingId || preview.revision !== binding.revision || preview.credentialHash !== coldyCredentialHash_(context) || preview.expiresAt < Date.now()) fail_('COLDY_PREVIEW_EXPIRED', 'Откройте новый предпросмотр загрузки Coldy.');
      var collected = coldyCampaignCollect_(context, binding, ledger);
      if (preview.fingerprint !== coldyCampaignFingerprint_(collected)) fail_('COLDY_SOURCE_CHANGED', 'Контакты или результаты проверки изменились. Обновите предпросмотр.');
      coldyCampaignCreateJob_(context, binding, ledger, collected.contacts, requestId, requestHash);
      return coldyCampaignAdvance_(context, binding, ledger, collected);
    });
  });
}

function continueColdyUpload_(request) {
  return api_(function () {
    var input = segmentInput_(request, ['segmentId', 'bindingId', 'jobId', 'requestId']), context = authorize_(), segmentId = id_(input.segmentId), bindingId = coldyCampaignLocalId_(input.bindingId), jobId = coldyCampaignLocalId_(input.jobId), requestId = segmentRequestId_(input.requestId);
    return coldyCampaignWithLease_(context, segmentId, bindingId, function (binding, ledger) {
      var job = ledger.job;
      if (!job || job.id !== jobId || job.requestId !== requestId) {
        var old = (ledger.receipts || []).filter(function (receipt) { return receipt.requestId === requestId && receipt.result.jobId === jobId; })[0];
        if (old) return old.result;
        fail_('COLDY_UPLOAD_MISSING', 'Загрузка не найдена. Откройте состояние рассылки ещё раз.');
      }
      return coldyCampaignAdvance_(context, binding, ledger);
    });
  });
}

function getColdyUploadState_(request) {
  return api_(function () {
    var input = segmentInput_(request, ['segmentId', 'bindingId']), context = authorize_(), segmentId = id_(input.segmentId), bindingId = coldyCampaignLocalId_(input.bindingId);
    return locked_(function () {
      coldyCampaignScope_(context, segmentId);
      var binding = coldyCampaignBinding_(coldyCampaignRegistry_(context), segmentId, bindingId), ledger = coldyCampaignLedger_(context, binding);
      return ledger.job ? coldyCampaignJobDto_(ledger.job) : { state: 'idle' };
    });
  });
}

/** Read cached metrics only. Opening the application never fans out to Coldy. */
function coldySegmentMailings_(context, segmentId) {
  coldyCampaignScope_(context, id_(segmentId));
  var settings = coldySettings_(context), campaigns = [], unknown = { sent: null, replies: null, leads: null };
  if (!settings.configured) return { id: 'coldy', key: 'coldy', name: 'Coldy', channel: 'email', state: 'not_connected', campaigns: [], totals: unknown, message: 'Подключите API Coldy в настройках.', generatedAt: null, cached: true, freshness: 'unknown' };
  var registry = coldyCampaignRegistry_(context), bindings = registry.bindings.filter(function (binding) { return binding.segmentId === segmentId; });
  bindings.forEach(function (binding) {
    var cache = coldyLoad_(context, 'campaignanalytics', coldyCampaignAnalyticsOwner_(context, binding));
    var current = cache && cache.campaignId === binding.campaignId && cache.credentialHash === coldyCredentialHash_(context) ? cache : null;
    campaigns.push({ id: binding.campaignId, name: current ? current.name : binding.campaignName, status: current ? current.status : binding.campaignStatus, sent: current ? coldyCampaignMetric_(current.sent) : null,
      replies: current ? coldyCampaignMetric_(current.replies) : null, leads: current ? coldyCampaignMetric_(current.leads) : null, updatedAt: current ? current.updatedAt || null : null,
      stale: !current || current.stale === true || !current.updatedAt || Date.parse(current.updatedAt) < Date.now() - 300000, lastAttemptAt: current ? current.lastAttemptAt || null : null });
  });
  var complete = campaigns.length > 0 && campaigns.every(function (campaign) { return campaign.sent !== null && campaign.replies !== null && campaign.leads !== null && !campaign.stale; });
  var timestamps = campaigns.map(function (campaign) { return Date.parse(campaign.updatedAt || ''); }).filter(function (time) { return isFinite(time); });
  coldyCampaignScope_(context, segmentId);
  return { id: 'coldy', key: 'coldy', name: 'Coldy', channel: 'email', state: complete ? 'connected' : 'partial', campaigns: campaigns,
    totals: { sent: coldyCampaignSum_(campaigns, 'sent'), replies: coldyCampaignSum_(campaigns, 'replies'), leads: coldyCampaignSum_(campaigns, 'leads') },
    message: !bindings.length ? 'Привяжите существующую рассылку Coldy к сегменту.' : complete ? 'Добавление контакта не означает отправку письма.' : 'Показаны последние сохранённые данные. Часть показателей отсутствует или устарела; обновите Coldy.',
    generatedAt: timestamps.length ? new Date(Math.min.apply(null, timestamps)).toISOString() : null, cached: true, freshness: complete ? 'fresh' : timestamps.length ? 'stale' : 'unknown' };
}

function refreshColdyMailings_(request) {
  return api_(function () {
    var input = segmentInput_(request, ['segmentId', 'monitor']), context = authorize_(), segmentId = id_(input.segmentId);
    if (input.monitor !== undefined && typeof input.monitor !== 'boolean') fail_('INVALID_REQUEST', 'Неизвестный режим мониторинга.');
    coldyCampaignScope_(context, segmentId);
    var settings = coldySettings_(context);
    if (!settings.configured) return coldySegmentMailings_(context, segmentId);
    var scope = digest_(JSON.stringify([context.rootId, settings.credentialHash]));
    var cooldown = 'COLDY_ANALYTICS_RETRY_' + scope, key = 'COLDY_ANALYTICS_POLL_' + digest_(scope + '|' + segmentId);
    var properties = context.properties, lease = Utilities.getUuid(), retryAt = 0, started = Date.now();
    var claimed = locked_(function () {
      var previous = JSON.parse(properties.getProperty(key) || '{}'), now = Date.now();
      retryAt = Number(properties.getProperty(cooldown)) || 0;
      if (retryAt > now || previous.until > now || (input.monitor && previous.next > now)) return false;
      properties.setProperty(key, JSON.stringify({ lease: lease, until: now + 360000 }));
      return true;
    });
    if (claimed) {
      try { return coldyRefreshBoundMetrics_(context, segmentId); }
      catch (error) {
        if (!error || error.registryCode !== 'COLDY_RATE_LIMIT') throw error;
        retryAt = Date.now() + Math.max(60000, Number(error.retryAfterMs) || 0);
      } finally {
        locked_(function () {
          if (retryAt > Date.now()) properties.setProperty(cooldown, String(Math.max(retryAt, Number(properties.getProperty(cooldown)) || 0)));
          if (JSON.parse(properties.getProperty(key) || '{}').lease === lease) properties.setProperty(key, JSON.stringify({ next: started + 60000 }));
        });
      }
    }
    var saved = coldySegmentMailings_(context, segmentId);
    saved.refreshedCampaigns = 0;
    if (retryAt > Date.now()) {
      saved.retryAfterMs = retryAt - Date.now();
      saved.message = 'Coldy попросил приостановить запросы. Показаны последние сохранённые показатели.';
    }
    return saved;
  });
}

function coldyRefreshBoundMetrics_(context, segmentId) {
  var startedAt = new Date().toISOString();
  var snapshot = locked_(function () {
    coldyCampaignScope_(context, segmentId);
    var registry = coldyCampaignRegistry_(context), all = registry.bindings.filter(function (binding) { return binding.segmentId === segmentId; }).sort(function (a, b) { return a.id.localeCompare(b.id); });
    var cursors = registry.analyticsCursors || {}, cursor = all.length ? (Number(cursors[segmentId]) || 0) % all.length : 0, selected = [];
    for (var index = 0; index < Math.min(10, all.length); index++) selected.push(all[(cursor + index) % all.length]);
    if (all.length > 10) {
      cursors[segmentId] = (cursor + selected.length) % all.length;
      registry.analyticsCursors = cursors; coldyCampaignSaveRegistry_(context, registry);
    }
    return { bindings: selected, total: all.length, credentialHash: registry.credentialHash };
  });
  snapshot.bindings.forEach(function (binding) {
    var old = locked_(function () { coldyCampaignScope_(context, segmentId); return coldyLoad_(context, 'campaignanalytics', coldyCampaignAnalyticsOwner_(context, binding)); });
    var campaign = null, summary = null, campaignError = '', summaryError = '';
    // Provider requests deliberately run outside the global script lock.
    try { campaign = coldyCampaignRead_(context, binding.campaignId); }
    catch (error) { if (coldyCampaignAccessError_(error)) throw error; campaignError = error.registryCode || 'COLDY_RESPONSE'; }
    try { summary = coldyApi_(context, 'GET', '/analytics/campaigns/' + coldyCampaignId_(binding.campaignId) + '/summary?period=all&type=event'); }
    catch (error) { if (coldyCampaignAccessError_(error)) throw error; summaryError = error.registryCode || 'COLDY_RESPONSE'; }
    if (snapshot.credentialHash !== coldyCredentialHash_(context)) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился во время обновления показателей.');
    locked_(function () {
      coldyCampaignScope_(context, segmentId);
      var registry = coldyCampaignRegistry_(context), current = coldyCampaignBinding_(registry, segmentId, binding.id);
      if (snapshot.credentialHash !== coldyCredentialHash_(context)) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился. Повторите обновление показателей.');
      if (current.revision !== binding.revision) fail_('COLDY_BINDING_CHANGED', 'Связь рассылки изменилась. Обновите показатели.');
      var owner = coldyCampaignAnalyticsOwner_(context, binding), latest = coldyLoad_(context, 'campaignanalytics', owner);
      if (latest && latest.lastAttemptAt && latest.lastAttemptAt >= startedAt && JSON.stringify(latest) !== JSON.stringify(old)) return;
      var before = old && old.credentialHash === snapshot.credentialHash ? old : {}, now = new Date().toISOString();
      var sent = campaign ? coldyCampaignMetric_(campaign.total_sent) : null, replies = campaign ? coldyCampaignMetric_(campaign.replies_emails) : null, leads = summary ? coldyCampaignMetric_(summary.interested) : null;
      var sentAt = sent !== null ? now : before.sentUpdatedAt || null, repliesAt = replies !== null ? now : before.repliesUpdatedAt || null, leadsAt = leads !== null ? now : before.leadsUpdatedAt || null;
      var known = [sentAt, repliesAt, leadsAt].filter(Boolean).map(Date.parse), stale = sent === null || replies === null || leads === null;
      coldySave_(context, 'campaignanalytics', owner, { campaignId: binding.campaignId, credentialHash: snapshot.credentialHash,
        name: campaign ? campaign.name : before.name || binding.campaignName, status: campaign ? campaign.status : before.status || binding.campaignStatus,
        sent: sent !== null ? sent : coldyCampaignMetric_(before.sent), replies: replies !== null ? replies : coldyCampaignMetric_(before.replies), leads: leads !== null ? leads : coldyCampaignMetric_(before.leads),
        sentUpdatedAt: sentAt, repliesUpdatedAt: repliesAt, leadsUpdatedAt: leadsAt, updatedAt: known.length ? new Date(Math.min.apply(null, known)).toISOString() : null,
        lastAttemptAt: startedAt, stale: stale, lastError: campaignError || summaryError || (stale ? 'COLDY_RESPONSE' : '') });
    });
  });
  var result = coldySegmentMailings_(context, segmentId); result.refreshedCampaigns = snapshot.bindings.length; result.hasMore = snapshot.total > snapshot.bindings.length;
  if (result.hasMore) result.message += ' За один цикл обновляются до 10 выбранных рассылок.';
  return result;
}

/** Existing owner timer calls this once for a bounded workbook item. */
function processColdyCampaignUploads_(context, item) {
  var current = authorize_();
  if (!context || context.rootId !== current.rootId) fail_('COLDY_SCOPE_CHANGED', 'Привязка реестра изменилась.');
  if (!coldySettings_(current).configured || !item || !item.id) return { processed: 0 };
  var workspace = getContactWorkspace_({ id: id_(item.id) });
  if (!workspace.segmentId || ['segment-companies', 'segment-lpr'].indexOf(workspace.role) === -1) return { processed: 0 };
  var segmentId = workspace.segmentId; coldyCampaignScope_(current, segmentId);
  var bindings = locked_(function () { return coldyCampaignRegistry_(current).bindings.filter(function (binding) { return binding.segmentId === segmentId && binding.autoUpload === true; }); });
  for (var index = 0; index < bindings.length; index++) {
    var result = coldyCampaignWithLease_(current, segmentId, bindings[index].id, function (binding, ledger) {
      if (!binding.autoUpload) return { processed: 0 };
      if (ledger.job && ledger.job.state === 'processing') return coldyCampaignAdvance_(current, binding, ledger);
      var collected = coldyCampaignCollect_(current, binding, ledger);
      if (!collected.contacts.length) return { processed: 0 };
      var campaign = coldyCampaignRead_(current, binding.campaignId);
      if (!coldyCampaignCanUpload_(campaign, binding)) return { processed: 0 };
      coldyCampaignCreateJob_(current, binding, ledger, collected.contacts, 'auto-coldy-' + Utilities.getUuid(), digest_('auto|' + Utilities.getUuid()));
      return coldyCampaignAdvance_(current, binding, ledger, collected);
    });
    if (result.processed !== 0) return result;
  }
  return { processed: 0 };
}

function coldyCampaignScope_(context, segmentId) {
  var current = authorize_();
  if (!context || current.rootId !== context.rootId) fail_('COLDY_SCOPE_CHANGED', 'Привязка реестра изменилась.');
  if (typeof registryRequireSegment_ === 'function') registryRequireSegment_(current, segmentId);
  return segmentFolder_(current, segmentSourceFolder_(current), id_(segmentId));
}
function coldyCampaignOwner_(context, value) { return digest_(coldyCredentialHash_(context) + '|' + value); }
function coldyCampaignAnalyticsOwner_(context, binding) {
  var projectId = typeof registrySegmentProject_ === 'function' ? registrySegmentProject_(context, binding.segmentId) : null;
  return coldyCampaignOwner_(context, projectId && projectId !== 'numshield' ? projectId + '|' + binding.campaignId : binding.campaignId);
}
function coldyCampaignRegistry_(context) {
  var hash = coldyCredentialHash_(context), value = coldyLoad_(context, 'campaignbindings', hash);
  if (!value) return { version: 1, credentialHash: hash, bindings: [], receipts: [] };
  if (value.credentialHash !== hash || !Array.isArray(value.bindings) || !Array.isArray(value.receipts)) fail_('COLDY_STORAGE', 'Журнал связей Coldy требует проверки.');
  return value;
}
function coldyCampaignSaveRegistry_(context, registry) { if (registry.credentialHash !== coldyCredentialHash_(context)) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился. Обновите настройки.'); coldySave_(context, 'campaignbindings', registry.credentialHash, registry); }
function coldyCampaignBinding_(registry, segmentId, bindingId) {
  var matches = registry.bindings.filter(function (binding) { return binding.id === bindingId && binding.segmentId === segmentId; });
  if (matches.length !== 1) fail_('COLDY_BINDING_MISSING', 'Связь рассылки не найдена. Обновите настройки сегмента.');
  return matches[0];
}
function coldyCampaignPublicBinding_(binding) { return { id: binding.id, segmentId: binding.segmentId, campaignId: binding.campaignId, campaignName: binding.campaignName, campaignStatus: binding.campaignStatus,
  includeCompanies: binding.includeCompanies, includeLpr: binding.includeLpr, autoUpload: binding.autoUpload, allowActive: binding.allowActive, revision: binding.revision, updatedAt: binding.updatedAt }; }
function coldyCampaignId_(value) { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) fail_('COLDY_CAMPAIGN_ID', 'Выберите существующую рассылку Coldy.'); return value.toLowerCase(); }
function coldyCampaignLocalId_(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(value)) fail_('INVALID_REQUEST', 'Некорректный идентификатор действия Coldy.'); return value; }
function coldyCampaignRead_(context, campaignId) {
  var credentialHash = coldyCredentialHash_(context), value = coldyApi_(context, 'GET', '/campaigns/' + coldyCampaignId_(campaignId));
  if (credentialHash !== coldyCredentialHash_(context)) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился во время чтения рассылки.');
  if (!value || coldyCampaignId_(value.id) !== campaignId || typeof value.name !== 'string' || ['Active', 'Draft', 'Completed', 'Paused'].indexOf(value.status) === -1) fail_('COLDY_RESPONSE', 'Coldy вернул неизвестное состояние рассылки.');
  return { id: campaignId, name: value.name.slice(0, 500), status: value.status, total_sent: value.total_sent, replies_emails: value.replies_emails };
}
function coldyCampaignCanUpload_(campaign, binding) { return ['Draft', 'Paused'].indexOf(campaign.status) !== -1 || campaign.status === 'Active' && binding.allowActive === true; }
function coldyCampaignBlockedMessage_(campaign) { return campaign.status === 'Active' ? 'Рассылка активна. Разрешите добавление в активную рассылку отдельно: это может вызвать отправку писем.' : 'Загрузка разрешена в черновик или приостановленную рассылку Coldy.'; }
function coldyCampaignMetric_(value) { return typeof value === 'number' && isFinite(value) && value >= 0 ? value : null; }
function coldyCampaignSum_(campaigns, field) { return !campaigns.length || campaigns.some(function (campaign) { return campaign[field] === null; }) ? null : campaigns.reduce(function (sum, campaign) { return sum + campaign[field]; }, 0); }
function coldyCampaignAccessError_(error) { return !!error && /^(?:LINK_|OUTSIDE_|COLDY_(?:AUTH|CREDENTIAL|SCOPE|FORBIDDEN|RATE_LIMIT|OWNER_AUTH|KEY_REQUIRED)|SOURCE_CHANGED)/.test(error.registryCode || ''); }
function coldyCampaignReceipt_(registry, requestId, hash) {
  var receipt = registry.receipts.filter(function (item) { return item.requestId === requestId; })[0];
  if (receipt && receipt.hash !== hash) fail_('REQUEST_REUSED', 'Идентификатор действия Coldy уже использован с другими параметрами.');
  return receipt || null;
}
function coldyCampaignRemember_(registry, requestId, hash, result) { registry.receipts.push({ requestId: requestId, hash: hash, binding: result.binding || null, removed: result.removed === true }); while (registry.receipts.length > 30) registry.receipts.shift(); }
function coldyCampaignLedger_(context, binding) {
  var hash = coldyCredentialHash_(context), value = coldyLoad_(context, 'campaignuploads', coldyCampaignOwner_(context, binding.id));
  if (!value) return { version: 1, revision: 0, credentialHash: hash, segmentId: binding.segmentId, bindingId: binding.id, campaignId: binding.campaignId, emails: {}, job: null, receipts: [] };
  if (value.credentialHash !== hash || value.segmentId !== binding.segmentId || value.bindingId !== binding.id || value.campaignId !== binding.campaignId || !value.emails || !Array.isArray(value.receipts)) fail_('COLDY_STORAGE', 'Журнал загрузки Coldy требует проверки.');
  return value;
}
function coldyCampaignWriteLedger_(context, binding, ledger) {
  var persisted = {};
  Object.keys(ledger).forEach(function (key) { if (key !== '_claimId') persisted[key] = ledger[key]; });
  coldySave_(context, 'campaignuploads', coldyCampaignOwner_(context, binding.id), persisted);
}
function coldyCampaignClaimGuard_(context, binding, ledger) {
  coldyCampaignScope_(context, binding.segmentId);
  if (ledger.credentialHash !== coldyCredentialHash_(context)) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился. Старая загрузка остановлена.');
  var currentBinding = coldyCampaignBinding_(coldyCampaignRegistry_(context), binding.segmentId, binding.id);
  if (currentBinding.revision !== binding.revision) fail_('COLDY_BINDING_CHANGED', 'Настройки рассылки изменились. Проверьте прежнюю загрузку.');
  var current = coldyCampaignLedger_(context, binding);
  if (!ledger._claimId || !current.lease || current.lease.id !== ledger._claimId || current.revision !== ledger.revision || current.lease.until < Date.now()) fail_('COLDY_UPLOAD_LEASE', 'Действие уже продолжено другим запросом. Обновите состояние загрузки.');
  return current;
}
function coldyCampaignSaveLedger_(context, binding, ledger) {
  return locked_(function () {
    coldyCampaignClaimGuard_(context, binding, ledger);
    ledger.revision = (ledger.revision || 0) + 1; ledger.lease.until = Date.now() + COLDY_CAMPAIGNS.leaseMillis;
    coldyCampaignWriteLedger_(context, binding, ledger);
  });
}
/** A short script lock claims a durable lease. HTTP and workbook reads never hold it. */
function coldyCampaignWithLease_(context, segmentId, bindingId, callback) {
  var claim = locked_(function () {
    coldyCampaignScope_(context, segmentId);
    var binding = coldyCampaignBinding_(coldyCampaignRegistry_(context), segmentId, bindingId), ledger = coldyCampaignLedger_(context, binding);
    if (ledger.lease && ledger.lease.until > Date.now()) fail_('COLDY_UPLOAD_BUSY', 'Сейчас продолжается эта загрузка Coldy. Повторите через несколько секунд.');
    ledger.lease = { id: digest_('lease|' + Utilities.getUuid()), until: Date.now() + COLDY_CAMPAIGNS.leaseMillis };
    ledger.revision = (ledger.revision || 0) + 1; coldyCampaignWriteLedger_(context, binding, ledger); ledger._claimId = ledger.lease.id;
    return { binding: binding, ledger: ledger };
  });
  try { return callback(claim.binding, claim.ledger); }
  finally {
    // Never release a successor's lease after a timeout or credential/root rotation.
    try { locked_(function () {
      coldyCampaignScope_(context, segmentId);
      if (claim.ledger.credentialHash !== coldyCredentialHash_(context)) return;
      var current = coldyCampaignLedger_(context, claim.binding);
      if (current.lease && current.lease.id === claim.ledger._claimId) { delete current.lease; current.revision = (current.revision || 0) + 1; coldyCampaignWriteLedger_(context, claim.binding, current); }
    }); } catch (error) { /* A durable lease expires; unacknowledged dispatch still only reconciles. */ }
  }
}

/** Select real managed GIDs, not worksheet titles or caller-supplied file IDs. */
function coldyCampaignHasMembership_(value, campaignId) {
  var suffix = '[' + campaignId + ']';
  return String(value || '').split('\n').some(function (label) { return label.trim().endsWith(suffix); });
}

function coldyCampaignCollect_(context, binding, ledger) {
  coldyCampaignScope_(context, binding.segmentId);
  var validationCache = locked_(function () { return coldyCampaignReviewCache_(context); });
  var targets = segmentRecordsTargets_(context, binding.segmentId, false), rows = [], counts = { eligible: 0, alreadyLoaded: 0, notValidated: 0, invalid: 0, ownershipReview: 0, total: 0, workspaceDuplicate: 0, blacklist: 0 }, warnings = [], grouped = Object.create(null);
  ['companies', 'lpr'].forEach(function (kind) {
    if (kind === 'companies' && !binding.includeCompanies || kind === 'lpr' && !binding.includeLpr) return;
    var fileId = targets.tables[kind], workspace = getContactWorkspace_({ id: fileId });
    if (!workspace.enrolled || workspace.role !== 'segment-' + kind || workspace.segmentId !== binding.segmentId || !workspace.targets || !Number.isSafeInteger(workspace.targets.emailSheetId)) fail_('COLDY_TARGETS_REQUIRED', 'Сначала подготовьте списки Email в рабочих таблицах сегмента.');
    if (workspace.job && !workspace.job.error) fail_('COLDY_CONTACT_SYNC_BUSY', 'Дождитесь распределения новых контактов по вкладкам.');
    gridFile_(fileId, false, context.rootId);
    var book = SpreadsheetApp.openById(fileId), sheet = gridSheet_(book, workspace.targets.emailSheetId), width = sheet.getLastColumn(), count = sheet.getLastRow();
    if (width > COLDY_CAMPAIGNS.maxColumns || count > COLDY_CAMPAIGNS.maxRows) fail_('COLDY_UPLOAD_LIMIT', 'Список Email превышает лимит обработки Coldy.');
    var headers = width ? sheet.getRange(1, 1, 1, width).getDisplayValues()[0] : [], map = pvHeaderMap_(headers), emailColumn = pvFindHeader_(map, ['Email', 'e-mail', 'почта']);
    if (emailColumn === undefined) fail_('COLDY_SCHEMA', 'В управляемой вкладке Email отсутствует колонка адреса.');
    var statusColumn = pvFindHeader_(map, ['Валидация']), reviewColumn = pvFindHeader_(map, ['Проверить принадлежность']), ownerColumn = pvFindHeader_(map, ['Компания / ЛПР']), companyColumn = pvFindHeader_(map, ['Компания']), nameColumn = pvFindHeader_(map, ['ФИО', 'Имя', 'ЛПР']);
    if (reviewColumn === undefined) fail_('COLDY_SCHEMA', 'В списке Email отсутствует отметка проверки принадлежности.');
    var columns = {}, rowCount = Math.max(0, count - 1), workflowColumn = pvFindHeader_(map, ['Статус рассылки', 'Статус']);
    var membershipColumn = pvFindHeader_(map, [COLDY_CAMPAIGNS.headers[0]]);
    [emailColumn, statusColumn, reviewColumn, ownerColumn, companyColumn, nameColumn, workflowColumn, membershipColumn].forEach(function (column) { if (column !== undefined && columns[column] === undefined) columns[column] = rowCount ? sheet.getRange(2, column + 1, rowCount, 1).getDisplayValues() : []; });
    var notes = rowCount && statusColumn !== undefined ? sheet.getRange(2, statusColumn + 1, rowCount, 1).getNotes() : [];
    columns[emailColumn].forEach(function (emailCell, index) {
      var email = pvEmail_(emailCell[0]); if (!email) return;
      if (ledger.emails[email]) { (grouped[email] || (grouped[email] = [])).push({ email: email }); return; }
      function cell(column) { return column === undefined ? '' : String(columns[column][index][0] || ''); }
      var status = cell(statusColumn).trim(), bound = pvBinding_(notes[index] && notes[index][0] || ''), changed = !!bound && bound !== pvKey_('email', email);
      var review = cell(reviewColumn).trim(), cached = validationCache[pvKey_('email', email)], cacheReview = !!(cached && cached.result && cached.result.review === true), acceptable = (!review || /^(?:нет|no|false|0)$/i.test(review)) && !cacheReview;
      var valid = !changed && email.length <= 254 && !/[\u0000-\u001f\u007f]/.test(email) && /^(?:валиден|валидный|valid|deliverable)$/i.test(status), completed = !!status && !pvPendingStatus_(status) && !changed;
      var row = { fileId: fileId, sheetId: sheet.getSheetId(), row: index + 2, email: email, valid: valid, completed: completed, review: !acceptable, excluded: pvExcludedStatus_(cell(workflowColumn), true),
        inCampaign: coldyCampaignHasMembership_(cell(membershipColumn), binding.campaignId),
        company: companyColumn === undefined ? kind === 'companies' && ownerColumn !== undefined ? cell(ownerColumn) : '' : cell(companyColumn),
        name: nameColumn === undefined ? '' : cell(nameColumn), ownerLabel: ownerColumn === undefined ? '' : cell(ownerColumn),
        fingerprintSource: JSON.stringify([fileId, sheet.getSheetId(), index + 2, email, status, bound, review]) };
      row.fingerprintSource = JSON.stringify([fileId, sheet.getSheetId(), index + 2, email, status, bound, review, row.company, row.name, row.ownerLabel, cacheReview]);
      rows.push(row); (grouped[email] || (grouped[email] = [])).push(row);
    });
  });
  var contacts = [];
  Object.keys(grouped).sort().forEach(function (email) {
    var entries = grouped[email], old = ledger.emails[email]; counts.total++;
    if (old) { if (old.outcome === 'created' || old.outcome === 'alreadyInCampaign') counts.alreadyLoaded++; else if (old.outcome === 'workspaceDuplicate') counts.workspaceDuplicate++; else if (old.outcome === 'blacklist') counts.blacklist++; else warnings.push('Некоторые контакты требуют проверки предыдущей загрузки; повторная отправка исключена.'); return; }
    if (entries.some(function (entry) { return entry.inCampaign; })) { counts.alreadyLoaded++; return; }
    if (entries.some(function (entry) { return entry.excluded; })) { counts.excluded = (counts.excluded || 0) + 1; return; }
    if (entries.some(function (entry) { return entry.review; })) { counts.ownershipReview++; return; }
    if (entries.some(function (entry) { return entry.completed && !entry.valid; })) { counts.invalid++; return; }
    var validRows = entries.filter(function (entry) { return entry.valid; });
    if (!validRows.length) { counts.notValidated++; return; }
    var owners = {}; entries.forEach(function (entry) { var owner = (entry.ownerLabel || entry.company || entry.name || '').trim().toLowerCase(); if (owner) owners[owner] = true; });
    // The same address in company and person workbooks needs an explicit ownership decision.
    if (Object.keys(owners).length > 1) { counts.ownershipReview++; return; }
    var first = validRows[0]; contacts.push({ email: email, company: first.company.slice(0, 500), name: first.name.slice(0, 500), refs: validRows.map(function (row) { return { fileId: row.fileId, sheetId: row.sheetId, row: row.row, fingerprint: digest_(row.fingerprintSource) }; }) });
  });
  if (contacts.length > COLDY_CAMPAIGNS.maxContacts) fail_('COLDY_UPLOAD_LIMIT', 'За одну загрузку можно подготовить до 20 000 адресов.');
  counts.eligible = contacts.length;
  return { contacts: contacts, rows: rows, counts: counts, warnings: warnings.filter(function (warning, index, all) { return all.indexOf(warning) === index; }) };
}
function coldyCampaignReviewCache_(context) {
  return typeof pvCache_ === 'function' && typeof pvCacheRead_ === 'function' ? pvCacheRead_(pvCache_(context, false)) : {};
}
/** A second, small identity read prevents sending a changed row from a large snapshot. */
function coldyCampaignDispatchRows_(context, binding, contacts) {
  var targets = segmentRecordsTargets_(context, binding.segmentId, false), byFile = {};
  contacts.forEach(function (contact) { contact.refs.forEach(function (ref) { (byFile[ref.fileId] || (byFile[ref.fileId] = [])).push({ contact: contact, ref: ref }); }); });
  Object.keys(byFile).forEach(function (fileId) {
    gridFile_(fileId, false, context.rootId);
    var workspace = getContactWorkspace_({ id: fileId }), kind = fileId === targets.tables.companies ? 'companies' : fileId === targets.tables.lpr ? 'lpr' : '';
    if (!kind || !workspace.enrolled || workspace.segmentId !== binding.segmentId || workspace.role !== 'segment-' + kind) fail_('COLDY_SOURCE_CHANGED', 'Связь базы сегмента изменилась перед загрузкой.');
    var sheet = gridSheet_(SpreadsheetApp.openById(fileId), workspace.targets.emailSheetId), width = sheet.getLastColumn(), headers = sheet.getRange(1, 1, 1, width).getDisplayValues()[0], map = pvHeaderMap_(headers);
    var email = pvFindHeader_(map, ['Email', 'e-mail', 'почта']), status = pvFindHeader_(map, ['Валидация']), review = pvFindHeader_(map, ['Проверить принадлежность']), owner = pvFindHeader_(map, ['Компания / ЛПР']), company = pvFindHeader_(map, ['Компания']), name = pvFindHeader_(map, ['ФИО', 'Имя', 'ЛПР']);
    if (email === undefined || status === undefined || review === undefined) fail_('COLDY_SOURCE_CHANGED', 'Колонки проверки Email изменились перед загрузкой.');
    byFile[fileId].forEach(function (entry) {
      if (entry.ref.sheetId !== sheet.getSheetId() || entry.ref.row > sheet.getLastRow()) fail_('COLDY_SOURCE_CHANGED', 'Строка контакта изменилась перед загрузкой.');
      var line = sheet.getRange(entry.ref.row, 1, 1, width).getDisplayValues()[0], note = sheet.getRange(entry.ref.row, status + 1, 1, 1).getNotes()[0][0], value = pvEmail_(line[email]);
      var companyValue = company === undefined ? kind === 'companies' && owner !== undefined ? String(line[owner] || '') : '' : String(line[company] || '');
      var nameValue = name === undefined ? '' : String(line[name] || ''), ownerLabel = owner === undefined ? '' : String(line[owner] || '');
      var fingerprint = digest_(JSON.stringify([fileId, sheet.getSheetId(), entry.ref.row, value, String(line[status] || '').trim(), pvBinding_(note), String(line[review] || '').trim(), companyValue, nameValue, ownerLabel, false]));
      var memberships = pvFindHeader_(map, [COLDY_CAMPAIGNS.headers[0]]);
      if (coldyCampaignHasMembership_(line[memberships], binding.campaignId) || pvExcludedRow_(line, map, true) || value !== entry.contact.email || fingerprint !== entry.ref.fingerprint) fail_('COLDY_SOURCE_CHANGED', 'Контакт, его принадлежность или результат проверки изменились перед загрузкой.');
    });
  });
}

function coldyCampaignFingerprint_(collected) { return digest_(JSON.stringify(collected.contacts)); }
function coldyCampaignCreateJob_(context, binding, ledger, contacts, requestId, requestHash) {
  var hash = coldyCredentialHash_(context), now = new Date().toISOString();
  ledger.job = { id: digest_('job|' + Utilities.getUuid()), state: 'processing', segmentId: binding.segmentId, bindingId: binding.id, campaignId: binding.campaignId, credentialHash: hash,
    bindingRevision: binding.revision, requestId: requestId, requestHash: requestHash, createdAt: now, contacts: contacts, cursor: 0, batch: null,
    counts: { created: 0, alreadyInCampaign: 0, workspaceDuplicate: 0, blacklist: 0, uncertain: 0 }, warnings: [] };
  coldyCampaignSaveLedger_(context, binding, ledger);
}
function coldyCampaignUploadReceipt_(ledger, requestId, hash) {
  var job = ledger.job;
  if (job && job.requestId === requestId) { if (job.requestHash !== hash) fail_('REQUEST_REUSED', 'Идентификатор загрузки использован с другими параметрами.'); return coldyCampaignJobDto_(job); }
  var receipt = ledger.receipts.filter(function (item) { return item.requestId === requestId; })[0];
  if (receipt && receipt.hash !== hash) fail_('REQUEST_REUSED', 'Идентификатор загрузки использован с другими параметрами.');
  return receipt ? receipt.result : null;
}
function coldyCampaignJobDto_(job) {
  return { state: job.state, segmentId: job.segmentId, bindingId: job.bindingId, jobId: job.id, requestId: job.requestId, counts: job.counts,
    nextActionAt: job.nextActionAt || null,
    progress: { completed: job.cursor, total: job.contacts.length, label: job.state === 'complete' ? 'Загрузка в Coldy завершена. Это не подтверждение отправки писем.' : job.state === 'needs_review' ? 'Нужна проверка неопределённого результата; повторная отправка отключена.' : 'Загружаем проверенные контакты в Coldy…' }, warnings: job.warnings || [] };
}

function coldyCampaignAdvance_(context, binding, ledger, initialCollected) {
  var job = ledger.job;
  coldyCampaignScope_(context, binding.segmentId);
  if (job.credentialHash !== coldyCredentialHash_(context)) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился. Старая загрузка остановлена.');
  if (job.bindingRevision !== binding.revision) fail_('COLDY_BINDING_CHANGED', 'Настройки рассылки изменились. Проверьте прежнюю загрузку перед продолжением.');
  if (job.state !== 'processing') return coldyCampaignJobDto_(job);
  if (job.nextActionAt && job.nextActionAt > Date.now()) fail_('COLDY_RATE_LIMIT', 'Coldy просит подождать перед продолжением. Состояние загрузки сохранено.');
  // A dispatch without acknowledgement is read-only reconciled, never repeated.
  if (job.batch && ['dispatching', 'uncertain'].indexOf(job.batch.state) !== -1) return coldyCampaignReconcile_(context, binding, ledger);
  if (job.batch && job.batch.state === 'acknowledged') return coldyCampaignSettle_(context, binding, ledger);
  if (job.cursor >= job.contacts.length) return coldyCampaignFinish_(context, binding, ledger);
  var campaign = coldyCampaignRead_(context, binding.campaignId);
  if (!coldyCampaignCanUpload_(campaign, binding)) fail_('COLDY_CAMPAIGN_ACTIVE', coldyCampaignBlockedMessage_(campaign));
  // Re-read source, validation and contact ownership immediately before POST.
  var fresh = initialCollected || coldyCampaignCollect_(context, binding, ledger), available = Object.create(null), selected = job.contacts.slice(job.cursor, job.cursor + COLDY_CAMPAIGNS.batch), items = [];
  fresh.contacts.forEach(function (contact) { available[contact.email] = contact; });
  selected.forEach(function (contact) {
    if (available[contact.email] && JSON.stringify(contact.refs) === JSON.stringify(available[contact.email].refs)) items.push(contact);
    else { job.warnings.push('Изменённые или исключённые контакты не отправлены.'); }
  });
  if (!items.length) { job.cursor += selected.length; coldyCampaignSaveLedger_(context, binding, ledger); return job.cursor >= job.contacts.length ? coldyCampaignFinish_(context, binding, ledger) : coldyCampaignJobDto_(job); }
  // Recheck external campaign state after potentially slow Google Sheets reads.
  campaign = coldyCampaignRead_(context, binding.campaignId);
  if (!coldyCampaignCanUpload_(campaign, binding)) fail_('COLDY_CAMPAIGN_ACTIVE', coldyCampaignBlockedMessage_(campaign));
  coldyCampaignDispatchRows_(context, binding, items);
  job.batch = { state: 'dispatching', campaignId: binding.campaignId, contacts: items, span: selected.length, reconcileIndex: 0, outcomes: {}, dispatchedAt: new Date().toISOString() };
  coldyCampaignSaveLedger_(context, binding, ledger);
  // Fresh key/root/binding/campaign checks also protect a key rotation during slow reads.
  coldyCampaignScope_(context, binding.segmentId);
  if (job.credentialHash !== coldyCredentialHash_(context)) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился. Загрузка остановлена.');
  var payload = { campaign: binding.campaignId, items: items.map(function (contact) { var lead = { email: contact.email }; if (contact.company) lead.company = contact.company; if (contact.name) lead.first_name = contact.name; return lead; }),
    skip_if_in_campaign: true, skip_if_in_workspace: true, skip_if_in_blacklist: true }, result;
  var excluded = locked_(function () {
    coldyCampaignClaimGuard_(context, binding, ledger);
    var cache = coldyCampaignReviewCache_(context), seenFiles = {};
    items.forEach(function (contact) { contact.refs.forEach(function (ref) { if (!seenFiles[ref.fileId]) { seenFiles[ref.fileId] = true; gridFile_(ref.fileId, false, context.rootId); } }); });
    return items.some(function (contact) { var known = cache[pvKey_('email', contact.email)]; return known && known.result && known.result.review === true; });
  });
  if (excluded) { job.batch = null; job.warnings.push('Контакт получил отметку ручной проверки; загрузка остановлена до повторного отбора.'); coldyCampaignSaveLedger_(context, binding, ledger); return coldyCampaignJobDto_(job); }
  try { result = coldyApi_(context, 'POST', '/leads/bulk', payload); }
  catch (error) {
    job.batch.state = 'uncertain';
    if (error && error.registryCode === 'COLDY_RATE_LIMIT') job.nextActionAt = Date.now() + Math.max(1000, Number(error.retryAfterMs) || 30000);
    job.warnings.push('Нет подтверждения загрузки. Сначала проверим наличие адресов в выбранной рассылке; повторный POST отключён.');
    coldyCampaignSaveLedger_(context, binding, ledger);
    if (coldyCampaignAccessError_(error)) throw error;
    return coldyCampaignJobDto_(job);
  }
  coldyCampaignReadAcknowledgement_(job.batch, result);
  coldyCampaignSaveLedger_(context, binding, ledger);
  return job.batch.state === 'acknowledged' ? coldyCampaignSettle_(context, binding, ledger) : coldyCampaignJobDto_(job);
}

function coldyCampaignReadAcknowledgement_(batch, response) {
  var allowed = Object.create(null), outcomes = Object.create(null), malformed = false;
  batch.contacts.forEach(function (contact) { allowed[contact.email] = true; });
  if (!response || !Array.isArray(response.leads) || !Array.isArray(response.skipped_items)) { batch.outcomes = {}; batch.state = 'uncertain'; return; }
  response.leads.forEach(function (lead) {
    var email = pvEmail_(lead && lead.email);
    if (!allowed[email] || outcomes[email] || lead.campaign_id !== undefined && (typeof lead.campaign_id !== 'string' || lead.campaign_id.toLowerCase() !== batch.campaignId)) { malformed = true; return; }
    outcomes[email] = 'created';
  });
  response.skipped_items.forEach(function (item) {
    var email = pvEmail_(item && item.email), contact = item && Number.isSafeInteger(item.index) ? batch.contacts[item.index] : null;
    if (!contact || contact.email !== email || !allowed[email] || outcomes[email] || ['blacklist', 'workspace_duplicate', 'campaign_duplicate'].indexOf(item.reason) === -1) { malformed = true; return; }
    outcomes[email] = { blacklist: 'blacklist', workspace_duplicate: 'workspaceDuplicate', campaign_duplicate: 'alreadyInCampaign' }[item.reason];
  });
  if (response.created !== undefined && (!Number.isSafeInteger(response.created) || response.created !== response.leads.length) || response.skipped !== undefined && (!Number.isSafeInteger(response.skipped) || response.skipped !== response.skipped_items.length)) malformed = true;
  if (malformed) { batch.outcomes = {}; batch.state = 'uncertain'; return; }
  batch.outcomes = outcomes;
  batch.state = batch.contacts.every(function (contact) { return !!outcomes[contact.email]; }) ? 'acknowledged' : 'uncertain';
}

function coldyCampaignReconcile_(context, binding, ledger) {
  var job = ledger.job, batch = job.batch, count = 0;
  batch.state = 'uncertain';
  while (batch.reconcileIndex < batch.contacts.length && count++ < COLDY_CAMPAIGNS.reconcile) {
    var contact = batch.contacts[batch.reconcileIndex];
    if (batch.outcomes[contact.email]) { batch.reconcileIndex++; continue; }
    coldyCampaignScope_(context, binding.segmentId);
    if (job.credentialHash !== coldyCredentialHash_(context)) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился. Старая загрузка остановлена.');
    // Provider search is substring matching. Only a canonical exact match counts.
    var response;
    try { response = coldyApi_(context, 'GET', '/leads/campaign/' + binding.campaignId + '?limit=200&offset=0&search=' + encodeURIComponent(contact.email)); }
    catch (error) {
      if (error && error.registryCode === 'COLDY_RATE_LIMIT') { job.nextActionAt = Date.now() + Math.max(1000, Number(error.retryAfterMs) || 30000); coldyCampaignSaveLedger_(context, binding, ledger); }
      throw error;
    }
    if (!response || !Array.isArray(response.items)) fail_('COLDY_RESPONSE', 'Coldy не подтвердил результат поиска контакта.');
    var matches = response.items.filter(function (lead) { return pvEmail_(lead && lead.email) === contact.email && (lead.campaign_id === undefined || typeof lead.campaign_id === 'string' && lead.campaign_id.toLowerCase() === binding.campaignId); });
    batch.outcomes[contact.email] = matches.length ? 'alreadyInCampaign' : 'uncertain';
    batch.reconcileIndex++; coldyCampaignSaveLedger_(context, binding, ledger);
  }
  if (batch.reconcileIndex < batch.contacts.length) return coldyCampaignJobDto_(job);
  batch.state = 'acknowledged'; coldyCampaignSaveLedger_(context, binding, ledger);
  return coldyCampaignSettle_(context, binding, ledger);
}

function coldyCampaignSettle_(context, binding, ledger) {
  var job = ledger.job, batch = job.batch;
  if (job.credentialHash !== coldyCredentialHash_(context)) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился. Результат другой организации не применяется.');
  // Save confirmed/uncertain outcomes before any cell write. A failed row write is safely replayed.
  batch.contacts.forEach(function (contact) {
    var outcome = batch.outcomes[contact.email] || 'uncertain';
    if (!ledger.emails[contact.email]) ledger.emails[contact.email] = { outcome: outcome, at: new Date().toISOString() };
  });
  coldyCampaignSaveLedger_(context, binding, ledger);
  locked_(function () { coldyCampaignClaimGuard_(context, binding, ledger); coldyCampaignApplyRows_(context, binding, ledger, batch.contacts); });
  batch.contacts.forEach(function (contact) { var outcome = ledger.emails[contact.email].outcome; if (Object.prototype.hasOwnProperty.call(job.counts, outcome)) job.counts[outcome]++; });
  job.cursor += batch.span; job.batch = null;
  coldyCampaignSaveLedger_(context, binding, ledger);
  return job.cursor >= job.contacts.length ? coldyCampaignFinish_(context, binding, ledger) : coldyCampaignJobDto_(job);
}
function coldyCampaignFinish_(context, binding, ledger) {
  var job = ledger.job; job.state = job.counts.uncertain ? 'needs_review' : 'complete'; job.completedAt = new Date().toISOString();
  if (job.counts.uncertain) job.warnings.push('Часть адресов не подтверждена в рассылке. Они не будут загружаться повторно автоматически.');
  job.warnings = job.warnings.filter(function (value, index, all) { return all.indexOf(value) === index; });
  var result = coldyCampaignJobDto_(job);
  ledger.receipts = ledger.receipts.filter(function (receipt) { return receipt.requestId !== job.requestId; });
  ledger.receipts.push({ requestId: job.requestId, hash: job.requestHash, result: result }); while (ledger.receipts.length > 20) ledger.receipts.shift();
  coldyCampaignSaveLedger_(context, binding, ledger); return result;
}

/** Never write generic campaign/sent statuses or claim workspace duplicates are loaded. */
function coldyCampaignApplyRows_(context, binding, ledger, contacts) {
  var targets = segmentRecordsTargets_(context, binding.segmentId, false), allowedFiles = {}, byFile = Object.create(null);
  if (binding.includeCompanies) allowedFiles[targets.tables.companies] = true;
  if (binding.includeLpr) allowedFiles[targets.tables.lpr] = true;
  contacts.forEach(function (contact) {
    var record = ledger.emails[contact.email];
    if (!record || ['created', 'alreadyInCampaign', 'workspaceDuplicate', 'blacklist'].indexOf(record.outcome) === -1) return;
    contact.refs.forEach(function (ref) {
      if (!allowedFiles[ref.fileId]) return;
      if (!byFile[ref.fileId]) byFile[ref.fileId] = [];
      byFile[ref.fileId].push({ ref: ref, email: contact.email, record: record });
    });
  });
  Object.keys(byFile).forEach(function (fileId) {
    coldyCampaignScope_(context, binding.segmentId); gridFile_(fileId, true, context.rootId);
    var workspace = getContactWorkspace_({ id: fileId }), refs = byFile[fileId];
    if (!workspace.enrolled || workspace.segmentId !== binding.segmentId || !workspace.targets || refs.some(function (entry) { return workspace.targets.emailSheetId !== entry.ref.sheetId; })) fail_('COLDY_TARGET_CHANGED', 'Связь вкладки Email изменилась. Отметки загрузки не записаны.');
    var book = SpreadsheetApp.openById(fileId), sheet = gridSheet_(book, workspace.targets.emailSheetId), width = sheet.getLastColumn(), lastRow = sheet.getLastRow();
    if (width > COLDY_CAMPAIGNS.maxColumns || lastRow > COLDY_CAMPAIGNS.maxRows) fail_('COLDY_SCHEMA', 'Список Email превышает лимит отметок Coldy.');
    var headers = width ? sheet.getRange(1, 1, 1, width).getDisplayValues()[0] : [], map = pvHeaderMap_(headers), emailColumn = pvFindHeader_(map, ['Email', 'e-mail', 'почта']);
    if (emailColumn === undefined) fail_('COLDY_SCHEMA', 'В списке Email отсутствует колонка адреса.');
    var missing = COLDY_CAMPAIGNS.headers.filter(function (header) { return map[pvHeader_(header)] === undefined; });
    if (headers.length + missing.length > COLDY_CAMPAIGNS.maxColumns) fail_('COLDY_SCHEMA', 'Недостаточно места для отметок Coldy.');
    if (missing.length) {
      if (sheet.getMaxColumns() < headers.length + missing.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length + missing.length - sheet.getMaxColumns());
      sheetWriteRawStrings_(fileId, sheet.getSheetId(), 1, headers.length + 1, [missing]); headers = headers.concat(missing); map = pvHeaderMap_(headers);
    }
    var groups = [], rows = Object.create(null);
    refs.forEach(function (entry) { if (entry.ref.row <= lastRow) rows[entry.ref.row] = entry; });
    Object.keys(rows).map(Number).sort(function (a, b) { return a - b; }).forEach(function (row) {
      var group = groups[groups.length - 1];
      if (!group || row - group.end > 25 || row - group.start >= 5000) groups.push({ start: row, end: row });
      else group.end = row;
    });
    var columns = COLDY_CAMPAIGNS.headers.map(function (header) { return map[pvHeader_(header)]; });
    groups.forEach(function (group) {
      var height = group.end - group.start + 1, current = columns.map(function (column) { return sheet.getRange(group.start, column + 1, height, 1).getDisplayValues(); });
      // Read identity last. A moved/changed email never receives another contact's receipt.
      coldyCampaignScope_(context, binding.segmentId); gridFile_(fileId, true, context.rootId);
      var emails = sheet.getRange(group.start, emailColumn + 1, height, 1).getDisplayValues(), values = [[], [], []], masks = [[], [], []];
      for (var index = 0; index < height; index++) {
        var entry = rows[group.start + index], eligible = !!entry && pvEmail_(emails[index][0]) === entry.email;
        var old = current.map(function (column) { return String(column[index][0] || ''); }), wanted = old.slice();
        if (eligible) {
          var present = entry.record.outcome === 'created' || entry.record.outcome === 'alreadyInCampaign', names = old[0].split('\n').filter(Boolean), label = binding.campaignName + ' [' + binding.campaignId + ']';
          if (present && names.indexOf(label) === -1) names.push(label);
          wanted[0] = names.join('\n'); wanted[1] = { created: 'Загружен в Coldy', alreadyInCampaign: 'Уже в выбранной рассылке Coldy', workspaceDuplicate: 'Уже в рабочем пространстве Coldy; загрузка в выбранную рассылку не подтверждена', blacklist: 'Чёрный список Coldy; загрузка не подтверждена' }[entry.record.outcome]; wanted[2] = present ? entry.record.at : old[2];
        }
        columns.forEach(function (_column, position) { values[position].push([wanted[position]]); masks[position].push([eligible && wanted[position] !== old[position]]); });
      }
      columns.forEach(function (column, position) { if (masks[position].some(function (line) { return line[0]; })) sheetWriteRawStrings_(fileId, sheet.getSheetId(), group.start, column + 1, values[position], masks[position]); });
    });
  });
}
