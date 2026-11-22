/** Independent reads let each provider appear as soon as it answers. */
function getServiceLimits_(request) {
  return api_(function () {
    var input = object_(request), provider = input.provider;
    var connectionOnly = provider === 'coldy' && input.connectionOnly === true;
    if (['coldy','promouser'].indexOf(provider) < 0 || Object.keys(input).length !== (connectionOnly ? 2 : 1))
      fail_('INVALID_REQUEST','Выберите сервис для просмотра лимитов.');
    var context = authorize_(), project = registryProjectId_(), promo = provider === 'promouser';
    var settings = promo ? pvSettings_(context) : coldySettings_(context);
    var result = {provider:provider, configured:!!settings.key, active:false, checkedAt:null, items:[], message:'', retryAfterMs:0};
    if (!settings.key) return result;
    var scope = digest_(JSON.stringify([context.rootId,provider,settings.key]));
    var slot = 'service-limits-retry-' + scope, cache;
    try { cache = CacheService.getScriptCache(); } catch (unavailable) { /* Optional cross-tab cooldown. */ }
    var until = 0;
    if (cache) { try { until = Number(cache.get(slot)) || 0; } catch (unavailable) {} }
    var retryMessage = 'Сервис просит подождать перед следующим запросом.';
    if (until > Date.now()) {
      result.active = null; result.message = retryMessage; result.retryAfterMs = until - Date.now();
    } else {
      try {
        if (connectionOnly) {
          var verifiedAt = Date.parse(settings.checkedAt), age = Date.now() - verifiedAt;
          result.checkedAt = settings.connected && age >= 0 && age < 45000 ? settings.checkedAt : coldyProbeConnection_(context,settings).checkedAt;
          result.active = true;
        } else {
          result = promo ? pvServiceLimits_(context, settings) : coldyServiceLimits_(context, settings);
        }
      } catch (error) {
        var code = error.registryCode;
        var messages = {
          PV_AUTH:'Promouser отклонил API-ключ.', PV_IP_DENIED:'Promouser отклонил доступ с IP сервиса.',
          PV_PROVIDER:'Promouser не подтвердил баланс.', PV_RESPONSE:'Promouser не подтвердил баланс.',
          PV_NETWORK:'Не удалось получить ответ Promouser.', PV_OWNER_AUTH_REQUIRED:'Google требует разрешение владельца для обращения к Promouser.',
          PV_RATE_LIMIT:retryMessage, COLDY_RATE_LIMIT:retryMessage,
          COLDY_AUTH:'Coldy отклонил API-ключ.', COLDY_FORBIDDEN:'Coldy отклонил доступ к этим данным.',
          COLDY_NOT_FOUND:'Coldy не подтвердил выбранные почты.', COLDY_NETWORK:'Не удалось получить ответ Coldy.',
          COLDY_UNAVAILABLE:'Coldy временно недоступен.', COLDY_RESPONSE:'Coldy не подтвердил сведения о лимитах.',
          COLDY_PROVIDER:'Coldy отклонил запрос сведений о лимитах.',
          COLDY_CONFLICT:'Сведения в Coldy изменились во время проверки лимитов.',
          COLDY_OWNER_AUTH_REQUIRED:'Google требует разрешение владельца для обращения к Coldy.'
        };
        var deferred = !promo && !connectionOnly && code === 'BUSY';
        if (!deferred && !Object.prototype.hasOwnProperty.call(messages,code)) throw error;
        result.active = code === 'PV_AUTH' || code === 'COLDY_AUTH' ? false : null;
        result.message = deferred ? 'Обновляем дневные лимиты выбранных почт. Другая операция ещё выполняется.' : messages[code];
        if (deferred) { result.pending = true; result.busy = true; result.retryAfterMs = 5000; }
        if (code === 'PV_RATE_LIMIT' || code === 'COLDY_RATE_LIMIT') result.retryAfterMs = Math.max(60000,Number(error.retryAfterMs) || 0);
      }
      if (cache && result.retryAfterMs > 0 && !result.pending) {
        try { cache.put(slot,String(Date.now()+result.retryAfterMs),Math.min(21600,Math.ceil(result.retryAfterMs/1000))); } catch (unavailable) {}
      }
    }
    var current = authorize_();
    if (current.rootId !== context.rootId || registryProjectId_() !== project)
      fail_('SOURCE_CHANGED','Область доступа изменилась. Откройте настройки заново.');
    var latest = promo ? pvSettings_(current) : coldySettings_(current);
    if (latest.key !== settings.key || !promo && latest.revision !== settings.revision)
      fail_(promo ? 'PV_CREDENTIAL_CHANGED' : 'COLDY_CREDENTIAL_CHANGED','Ключ сервиса изменился. Обновите настройки.');
    if (promo) {
      var proof = pvConnection_(current);
      if (result.active && (!proof || proof.keyHash !== digest_(latest.key) || proof.rejected)) {
        result.active = proof && proof.rejected ? false : null;
        result.items = []; result.checkedAt = null; result.message = 'Обновите подключение Promouser.';
      }
      result.items.push({label:'Лимит автооплаты за заказ',value:latest.autoPayLimitUsd,unit:'USD'});
    } else if (latest.rejected || result.active && (!latest.connected || latest.proofSlot !== settings.proofSlot)) {
      result.active = latest.rejected ? false : null; result.checkedAt = null; result.items = []; result.pending=false;
      result.message = latest.rejected ? 'Coldy отклонил API-ключ.' : 'Подключение Coldy требует повторной проверки.';
    } else if (result.active === null && latest.connected) {
      // A delayed quota or unavailable mailbox does not undo a just-confirmed credential.
      var proofAge = Date.now() - Date.parse(latest.checkedAt);
      if (proofAge >= 0 && (proofAge < 60000 || result.busy)) { result.active = true; result.checkedAt = latest.checkedAt; }
    }
    return result;
  });
}

function pvServiceLimits_(context, settings) {
  var saved = pvConnection_(context), balance, at = saved && Date.parse(saved.at);
  var age = Date.now() - at;
  if (saved && saved.rootId === context.rootId && saved.keyHash === digest_(settings.key) &&
      age >= 0 && age < 45000 && typeof saved.balance === 'number' && pvMoney_(saved.balance) !== null) {
    balance = saved.balance;
  } else {
    balance = pvProbe_(context, settings).balance;
    at = Date.now();
  }
  return {provider:'promouser',configured:true,active:true,checkedAt:new Date(at).toISOString(),
    items:[{label:'Баланс аккаунта',value:balance,unit:'USD'}],message:'',retryAfterMs:0};
}
