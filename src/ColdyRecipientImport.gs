/** Copy a verified snapshot of a bound Coldy campaign into one segment Email sheet. */
var COLDY_RECIPIENT_BATCH = 500;

function syncColdyRecipients_(request) {
  return api_(function () {
    var input = coldyInput_(request, ['segmentId', 'bindingId', 'targetKind', 'requestId', 'cursor']);
    var context = authorize_(), project = registryProjectId_(), requestId = segmentRequestId_(input.requestId);
    var segmentId = id_(input.segmentId), bindingId = coldyCampaignLocalId_(input.bindingId), kind = input.targetKind;
    if (kind !== 'companies' && kind !== 'lpr') fail_('INVALID_REQUEST', 'Выберите таблицу компаний или ЛПР.');
    if (input.cursor !== undefined) coldyCampaignLocalId_(input.cursor);
    coldyCampaignScope_(context, segmentId);
    var binding = coldyCampaignBinding_(coldyCampaignRegistry_(context), segmentId, bindingId);
    var fingerprint = digest_(JSON.stringify([context.rootId, project, segmentId, bindingId, binding.campaignId, kind, coldyCredentialHash_(context)]));
    var owner = digest_(JSON.stringify([context.rootId, project, requestId])), jobKey = 'COLDY_RECIPIENT_REQUEST_' + owner;
    var slot = digest_(JSON.stringify([context.rootId, project, segmentId, bindingId, kind])), slotKey = 'COLDY_RECIPIENT_SLOT_' + slot;
    var store = context.properties, lease = Utilities.getUuid();
    function readJob() { return JSON.parse(store.getProperty(jobKey) || 'null'); }
    function saveJob(job) { store.setProperty(jobKey, JSON.stringify(job)); }
    function verified(job) {
      if (!job || job.fingerprint !== fingerprint || job.requestId !== requestId) fail_('REQUEST_REUSED', 'Этот запрос относится к другой рассылке или таблице.');
      return job;
    }
    function activeJob() {
      var job = verified(readJob());
      if (job.lease !== lease || job.until <= Date.now() || store.getProperty(slotKey) !== jobKey) fail_('COLDY_RECIPIENT_BUSY', 'Истекло время выполнения шага или задание продолжается в другом окне. Продолжите тот же перенос.');
      return job;
    }
    function guard() {
      var fresh = authorize_();
      if (fresh.rootId !== context.rootId || registryProjectId_() !== project || coldyCredentialHash_(fresh) !== job.credentialHash) fail_('COLDY_SCOPE_CHANGED', 'Подключение или проект изменились.');
      coldyCampaignScope_(fresh, segmentId);
      var current = coldyCampaignBinding_(coldyCampaignRegistry_(fresh), segmentId, bindingId);
      if (current.campaignId !== binding.campaignId || current.revision !== job.bindingRevision) fail_('SOURCE_CHANGED', 'Привязка рассылки изменилась. Откройте её повторно.');
      activeJob();
    }
    var job = locked_(function () {
      var current = readJob();
      if (!current) {
        var receipt = coldyLoad_(context, 'recipientresult', owner);
        if (receipt) return verified(receipt);
        if (input.cursor !== undefined) fail_('COLDY_RECIPIENT_CURSOR', 'Продолжение импорта не найдено.');
        var previousKey = store.getProperty(slotKey), previous = previousKey && JSON.parse(store.getProperty(previousKey) || 'null');
        if (previous && previous.state !== 'complete' && Date.now() - previous.touched < 86400000) fail_('COLDY_RECIPIENT_BUSY', 'Продолжите начатый перенос этой рассылки в выбранную таблицу.');
        if (previous && previous.state === 'complete') store.deleteProperty(previousKey);
        current = { requestId:requestId, fingerprint:fingerprint, bindingRevision:binding.revision, credentialHash:coldyCredentialHash_(context),
          state:'processing', processed:0, added:0, updated:0, excluded:0, nextCursor:null, touched:Date.now() };
        store.setProperty(slotKey, jobKey);
      }
      verified(current);
      if (current.state === 'complete') return current;
      if (store.getProperty(slotKey) !== jobKey) fail_('COLDY_RECIPIENT_EXPIRED', 'Уже начат новый перенос. Обновите таблицу.');
      if ((input.cursor || null) !== current.nextCursor) {
        // A repeat after the response was lost returns the latest checkpoint.
        if (input.cursor === undefined || current.previousCursor === input.cursor) return current;
        fail_('COLDY_RECIPIENT_CURSOR', 'Это продолжение относится к другому шагу переноса.');
      }
      if (current.lease && current.until > Date.now()) fail_('COLDY_RECIPIENT_BUSY', 'Этот шаг ещё выполняется. Продолжите тот же запрос через несколько секунд.');
      current.lease = lease; current.until = Date.now() + 7 * 60000; current.touched = Date.now();
      saveJob(current);
      return current;
    });
    if (job.lease !== lease || job.state === 'complete') return coldyRecipientResult_(job);
    try {
      var snapshot;
      if (!job.target) {
        var campaign = coldyCampaignRead_(context, binding.campaignId);
        var data = coldyRecipientSnapshot_(context, binding.campaignId);
        if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < data.items.length || (data.total > 0 && !data.items.length)) {
          fail_('COLDY_RESPONSE', 'Coldy не подтвердил список адресатов рассылки.');
        }
        var target = coldyRecipientSheetTarget_(context, binding, kind);
        guard();
        snapshot = { requestId:requestId, fingerprint:fingerprint, campaignStatus:campaign.status, campaignName:campaign.name, items:data.items };
        coldySave_(context, 'recipientsnapshot', slot, snapshot);
        job.target = target; job.total = data.items.length; job.providerTotal = data.total;
        job.asOf = new Date().toISOString();
        locked_(function () { activeJob(); saveJob(job); });
      } else {
        snapshot = coldyLoad_(context, 'recipientsnapshot', slot);
        if (!snapshot || snapshot.fingerprint !== fingerprint || snapshot.requestId !== requestId || !Array.isArray(snapshot.items) || snapshot.items.length !== job.total) fail_('COLDY_STORAGE', 'Снимок рассылки недоступен. Проверьте журнал переноса.');
      }
      binding.campaignStatus = snapshot.campaignStatus; binding.campaignName = snapshot.campaignName;
      var batch = snapshot.items.slice(job.processed, job.processed + COLDY_RECIPIENT_BATCH);
      if (batch.length) {
        var result = coldyRecipientSheetWrite_(context, binding, kind, job.target, batch, guard, function (counts) {
          activeJob();
          if (!job.planned) {
            job.planned = { added:counts.appended, updated:counts.existing, excluded:counts.excluded };
            saveJob(job);
          }
        });
        if (!job.planned || !result || result.processed !== batch.length) fail_('COLDY_STORAGE_UNCERTAIN', 'Таблица не подтвердила все строки. Продолжите тот же запрос.');
      } else guard();
      return locked_(function () {
        activeJob();
        if (job.planned) {
          job.added += job.planned.added; job.updated += job.planned.updated; job.excluded += job.planned.excluded;
          delete job.planned;
        }
        job.processed += batch.length; job.previousCursor = job.nextCursor; job.touched = Date.now();
        delete job.lease; delete job.until;
        if (job.processed === job.total) {
          job.state = 'complete'; job.nextCursor = null;
          coldySave_(context, 'recipientresult', owner, job);
        } else job.nextCursor = digest_(JSON.stringify([owner, job.processed, fingerprint]));
        saveJob(job);
        return coldyRecipientResult_(job);
      });
    } catch (error) {
      // On uncertain Sheet/Drive outcomes preserve the page and original request.
      locked_(function () { var saved = readJob(); if (saved && saved.lease === lease) { delete saved.lease; delete saved.until; saveJob(saved); } });
      throw error;
    }
  });
}

function coldyRecipientResult_(job) {
  return { state:job.state, nextCursor:job.nextCursor, processed:job.processed, total:job.total, providerTotal:job.providerTotal,
    added:job.added, updated:job.updated, excluded:job.excluded, asOf:job.asOf, fileId:job.target && job.target.fileId, sheetId:job.target && job.target.sheetId };
}
