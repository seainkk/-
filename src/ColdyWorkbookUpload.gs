/** Explicit ready-contact uploads from the open company workbook. */
function coldyWorkbookScope_(context, fileId) {
  gridFile_(fileId, true, context.rootId);
  var workspace = getContactWorkspace_({id:fileId});
  if (!workspace.enrolled || workspace.role !== 'segment-companies' || !workspace.segmentId || !workspace.targets || !Number.isSafeInteger(workspace.targets.emailSheetId))
    fail_('COLDY_TARGETS_REQUIRED','Откройте лист Email рабочей таблицы компаний сегмента.');
  var segmentId = id_(workspace.segmentId);
  coldyCampaignScope_(context, segmentId);
  if (segmentRecordsTargets_(context,segmentId,false).tables.companies !== fileId) fail_('COLDY_TARGET_CHANGED','Рабочая таблица компаний изменилась.');
  var project = typeof registryProjectId_ === 'function' ? registryProjectId_() : '';
  return {fileId:fileId, segmentId:segmentId, credential: coldyCredentialHash_(context), project:project,
    owner:coldyCampaignOwner_(context,JSON.stringify([project,segmentId,fileId]))};
}

function coldyWorkbookGuard_(context, scope) {
  coldyCampaignScope_(context,scope.segmentId);
  var access = gridFile_(scope.fileId,true,context.rootId);
  if (!segmentDirectParent_(access.file,scope.segmentId)) fail_('OUTSIDE_SEGMENTS','Рабочая таблица перемещена из папки сегмента.');
  if (scope.credential !== coldyCredentialHash_(context)) fail_('COLDY_CREDENTIAL_CHANGED','Изменилось подключение Coldy.');
}

function coldyWorkbookBinding_(context, scope, campaignId) {
  var registry = coldyCampaignRegistry_(context);
  if (registry.credentialHash !== scope.credential) fail_('COLDY_CREDENTIAL_CHANGED','Изменилось подключение Coldy.');
  var binding = registry.bindings.find(function (b) { return b.campaignId === campaignId; });
  if (binding && binding.segmentId !== scope.segmentId) fail_('COLDY_CAMPAIGN_BOUND','Выберите рассылку этого сегмента или свободную рассылку.');
  return binding;
}

function coldyWorkbookBindingView_(scope, campaignId, binding, allowActive) {
  return Object.assign({},binding || {},{segmentId:scope.segmentId, campaignId:campaignId, workbookId:scope.fileId,
    includeCompanies:true, includeLpr:false, allowActive:allowActive === true});
}

// Each workbook owns a private journal. One token authorizes one confirmed operation.
function coldyWorkbookJournal_(context, scope, update) {
  return locked_(function () {
    coldyWorkbookGuard_(context,scope);
    var journal = coldyLoad_(context,'workbookactions',scope.owner) || {plans:[]};
    if (!Array.isArray(journal.plans)) fail_('COLDY_STORAGE','Не удалось прочитать операции таблицы.');
    var result = update(journal.plans);
    coldySave_(context,'workbookactions',scope.owner,journal);
    return result;
  });
}

function previewColdyWorkbookUpload_(request) {
  return api_(function () {
    var input = coldyInput_(request,['id','mode','campaignId','name']), context = authorize_();
    var scope = coldyWorkbookScope_(context,id_(input.id)), campaign, binding;
    if (input.mode === 'new' && input.campaignId === undefined) {
      campaign = {id:null,name:coldyPayload_('/campaigns',{name:input.name}).name,status:'Draft'};
    } else if (input.mode === 'existing' && input.name === undefined) {
      var campaignId = coldyCampaignId_(input.campaignId);
      binding = coldyWorkbookBinding_(context,scope,campaignId);
      campaign = coldyCampaignRead_(context,campaignId);
      if (campaign.status === 'Completed') fail_('COLDY_CAMPAIGN_ACTIVE','Завершённая рассылка не принимает контакты.');
    } else fail_('INVALID_REQUEST','Выберите новую или существующую рассылку.');
    var view = coldyWorkbookBindingView_(scope,campaign.id,binding), ledger = binding ? coldyCampaignLedger_(context,binding) : {emails:{}};
    var collected = coldyCampaignCollect_(context,view,ledger);
    var token = digest_('workbook-preview|' + Utilities.getUuid()), now = Date.now();
    coldyWorkbookJournal_(context,scope,function (plans) {
      for (var i = plans.length - 1; i >= 0; i--) {
        var old = plans[i];
        if (old.creating && !old.campaign.id) continue;
        if (old.expiresAt < now && (!old.requestId || old.expiresAt < now - 7*86400000)) plans.splice(i,1);
      }
      plans.push({token:token,mode:input.mode,campaign:campaign,expiresAt:now + COLDY_CAMPAIGNS.previewMillis,
        fingerprint:coldyCampaignFingerprint_(collected), count:collected.contacts.length, bindingId:binding ? binding.id : null,
        revision:binding ? binding.revision : null});
    });
    return {previewToken:token,segmentId:scope.segmentId,campaign:campaign,counts:collected.counts,canUpload:collected.contacts.length>0,
      sample:collected.contacts.slice(0,10).map(function (c) { return {email:c.email,name:c.name,company:c.company}; }),warnings:collected.warnings};
  });
}

function coldyWorkbookPlan_(plans, token) {
  var plan = plans.find(function (item) { return item.token === token; });
  if (!plan) fail_('COLDY_PREVIEW_EXPIRED','Откройте новый предпросмотр загрузки.');
  return plan;
}

function coldyWorkbookCheckContacts_(context, scope, plan, binding, ledger) {
  var view = coldyWorkbookBindingView_(scope,plan.campaign.id,binding,plan.allowActive);
  var collected = coldyCampaignCollect_(context,view,ledger || {emails:{}});
  if (!collected.contacts.length || coldyCampaignFingerprint_(collected) !== plan.fingerprint)
    fail_('COLDY_SOURCE_CHANGED','Состав или статусы контактов изменились. Обновите предпросмотр.');
  return collected;
}

function coldyWorkbookCampaign_(context,scope,plan) {
  if (plan.campaign.id) return coldyCampaignRead_(context,plan.campaign.id);
  coldyWorkbookJournal_(context,scope,function (plans) {
    var current = coldyWorkbookPlan_(plans,plan.token);
    var unresolved = plans.some(function (p) {
      return p.creating && !p.campaign.id && p.campaign.name === current.campaign.name;
    });
    if (unresolved) fail_('COLDY_CREATE_UNCERTAIN','Создание уже запрошено. Обновите список рассылок Coldy и выберите созданную рассылку.');
    current.creating = true;
  });
  coldyWorkbookGuard_(context,scope);
  var campaign;
  try {
    var response = coldyApi_(context,'POST','/campaigns',{name:plan.campaign.name},{expectedCredentialHash:scope.credential});
    campaign = coldyCampaignDetail_(coldyCampaignId_(response.id),response);
    if (campaign.name !== plan.campaign.name) fail_('COLDY_RESPONSE','Название созданной рассылки не подтверждено.');
  } catch (error) {
    // Some failures include an explicit rejection. Other outcomes need a human-selected campaign ID.
    if (error && [400,401,403,429].indexOf(error.httpStatus) !== -1) {
      coldyWorkbookJournal_(context,scope,function (plans) { delete coldyWorkbookPlan_(plans,plan.token).creating; });
      throw error;
    }
    fail_('COLDY_CREATE_UNCERTAIN','Coldy не подтвердил создание. Обновите список рассылок и выберите созданную рассылку, если она появилась.');
  }
  coldyWorkbookJournal_(context,scope,function (plans) { coldyWorkbookPlan_(plans,plan.token).campaign = campaign; });
  return campaign;
}

function coldyWorkbookBind_(context,scope,plan,campaign) {
  return locked_(function () {
    coldyWorkbookGuard_(context,scope);
    var registry = coldyCampaignRegistry_(context), binding = registry.bindings.find(function (b) { return b.campaignId === campaign.id; });
    if (binding && binding.segmentId !== scope.segmentId) fail_('COLDY_CAMPAIGN_BOUND','Рассылка связана с другим сегментом.');
    var journal = coldyLoad_(context,'workbookactions',scope.owner), saved = coldyWorkbookPlan_(journal.plans,plan.token);
    // The binding receipt lives in the same durable write as the binding, including after an ambiguous Drive response.
    var requestKey = digest_('workbook-binding|' + plan.token);
    var receipt = coldyCampaignReceipt_(registry,requestKey,requestKey);
    if (saved.assigned || receipt) {
      var expected = saved.assigned || receipt.binding;
      if (!binding || binding.id !== expected.id || binding.revision !== expected.revision) fail_('COLDY_BINDING_CHANGED','Привязка изменилась. Обновите предпросмотр.');
      if (!saved.assigned) {
        saved.assigned = {id:binding.id,revision:binding.revision};
        coldySave_(context,'workbookactions',scope.owner,journal);
      }
      return binding;
    }
    if (plan.bindingId !== (binding ? binding.id : null) || plan.revision !== (binding ? binding.revision : null))
      fail_('COLDY_BINDING_CHANGED','Привязка изменилась. Обновите предпросмотр.');
    if (!binding) {
      if (registry.bindings.length >= 100) fail_('COLDY_BINDING_LIMIT','Достигнут лимит связей рассылок.');
      binding = {id:digest_('binding|' + Utilities.getUuid()),segmentId:scope.segmentId,campaignId:campaign.id,
        campaignName:campaign.name,campaignStatus:campaign.status,includeCompanies:true,includeLpr:false,autoUpload:false,
        allowActive:false,revision:1,updatedAt:new Date().toISOString()};
      registry.bindings.push(binding);
    } else if (!binding.includeCompanies) {
      binding.includeCompanies = true; binding.workbookOnlyCompanies = true;
      binding.revision++; binding.updatedAt = new Date().toISOString();
    }
    coldyCampaignRemember_(registry,requestKey,requestKey,{binding:coldyCampaignPublicBinding_(binding)});
    coldyCampaignSaveRegistry_(context,registry);
    saved.assigned = {id:binding.id,revision:binding.revision};
    coldySave_(context,'workbookactions',scope.owner,journal);
    return binding;
  });
}

function startColdyWorkbookUpload_(request) {
  return api_(function () {
    var input = coldyInput_(request,['id','requestId','previewToken','allowActive']), context = authorize_();
    var scope = coldyWorkbookScope_(context,id_(input.id)), token = coldyCampaignLocalId_(input.previewToken), requestId = segmentRequestId_(input.requestId);
    if (typeof input.allowActive !== 'boolean') fail_('INVALID_REQUEST','Подтвердите условия загрузки.');
    var plan = coldyWorkbookJournal_(context,scope,function (plans) {
      var p = coldyWorkbookPlan_(plans,token);
      if (plans.some(function (item) { return item.token !== token && item.requestId === requestId; }) ||
          p.requestId && (p.requestId !== requestId || p.allowActive !== input.allowActive)) fail_('REQUEST_REUSED','Подтверждение относится к другой операции.');
      if (!p.requestId && p.expiresAt < Date.now()) fail_('COLDY_PREVIEW_EXPIRED','Откройте новый предпросмотр загрузки.');
      if (!p.count) fail_('COLDY_SOURCE_CHANGED','В предпросмотре нет готовых контактов.');
      if (p.campaign.status === 'Active' && !input.allowActive) fail_('COLDY_CAMPAIGN_ACTIVE',coldyCampaignBlockedMessage_(p.campaign));
      if (input.allowActive && p.campaign.status !== 'Active') fail_('INVALID_REQUEST','Подтверждать отправку можно только для активной рассылки.');
      p.requestId = requestId; p.allowActive = input.allowActive; return p;
    });
    if (plan.assigned) {
      var registered = coldyCampaignBinding_(coldyCampaignRegistry_(context),scope.segmentId,plan.assigned.id);
      var replay = coldyCampaignUploadReceipt_(coldyCampaignLedger_(context,registered),requestId,digest_('workbook-upload|' + token));
      if (replay) return replay;
    }
    if (plan.creating && !plan.campaign.id)
      fail_('COLDY_CREATE_UNCERTAIN','Создание уже запрошено. Проверьте список существующих рассылок в Coldy.');
    // A stale preview must not create a campaign or change a segment binding.
    // Once the binding is recorded, upload receipts govern retries (including an already completed job).
    if (!plan.assigned) {
      var current = plan.campaign.id && coldyWorkbookBinding_(context,scope,plan.campaign.id);
      coldyWorkbookCheckContacts_(context,scope,plan,current,current && coldyCampaignLedger_(context,current));
    }
    var campaign = coldyWorkbookCampaign_(context,scope,plan);
    if (!coldyCampaignCanUpload_(campaign,{allowActive:plan.allowActive}) && !plan.assigned) fail_('COLDY_CAMPAIGN_ACTIVE',coldyCampaignBlockedMessage_(campaign));
    var binding = coldyWorkbookBind_(context,scope,plan,campaign);
    if (typeof coldyIncomingEnsure_ === 'function') coldyIncomingEnsure_(context,false);
    return coldyCampaignWithLease_(context,scope.segmentId,binding.id,function (live,ledger) {
      if (live.revision !== binding.revision) fail_('COLDY_BINDING_CHANGED','Привязка рассылки изменилась.');
      var hash = digest_('workbook-upload|' + token), previous = coldyCampaignUploadReceipt_(ledger,requestId,hash);
      if (previous) return previous;
      if (ledger.job && ledger.job.state === 'processing') fail_('COLDY_UPLOAD_BUSY','Дождитесь текущей загрузки в рассылку.');
      plan.campaign = campaign;
      var collected = coldyWorkbookCheckContacts_(context,scope,plan,live,ledger);
      coldyCampaignCreateJob_(context,live,ledger,collected.contacts,requestId,hash,{id:scope.fileId,allowActive:plan.allowActive});
      return coldyCampaignAdvance_(context,live,ledger,collected);
    });
  });
}
