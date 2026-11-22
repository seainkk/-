/** Daily sender counters are independent of the organization's billing credits. */
function coldyServiceLimits_(context, settings) {
  var observation = {}, monitoring = projectMonitoringRead_(context,settings,observation), ids = monitoring.accountIds;
  var signature = projectMonitoringSignature_(context,monitoring);
  var guard = projectInfraMonitoringGuard_(context,settings.credentialHash,signature,observation);
  if (!ids.length) {
    guard();
    return coldyLimitsPublic_(null,0,settings);
  }

  // One bounded checkpoint per project. It contains only aggregate counts and the scope digest.
  var slot = 'REGISTRY_COLDY_DAILY_LIMITS_V1_' + registryProjectId_();
  var token = Utilities.getUuid(), deadline = Date.now() + 45000;
  var state = locked_(function () {
    var current = guard(), now = Date.now(), saved = coldyPropertyJson_(current.properties,slot);
    var receipt = coldyPropertyJson_(current.properties,COLDY.connectionProperty);
    var verified = receipt && receipt.version === COLDY.version && receipt.rootId === current.rootId && receipt.credentialHash === settings.credentialHash;
    if (!coldyLimitsCheckpoint_(saved,signature,ids.length,now) || saved.cursor === ids.length && !verified)
      saved = {signature:signature, cursor:0, limit:0, sent:0, remaining:0, firstAt:0, lastAt:0, lease:'', leaseUntil:0, retryAt:0};
    if (saved.retryAt > now) {
      var throttle = registryError_('COLDY_RATE_LIMIT','Coldy просит подождать перед следующим запросом.');
      throttle.retryAfterMs = saved.retryAt - now;
      throw throttle;
    }
    if (saved.cursor === ids.length || saved.leaseUntil > now) return saved;
    saved.lease = token; saved.leaseUntil = now + 120000;
    current.properties.setProperty(slot,JSON.stringify(saved));
    return saved;
  });
  if (state.lease !== token) return coldyLimitsPublic_(state,ids.length,settings);

  var initialCursor = state.cursor, stop = Math.min(ids.length,state.cursor + PROJECT_INFRASTRUCTURE.batch), problem;
  try {
    do {
      var group = ids.slice(state.cursor,Math.min(stop,state.cursor + COLDY.readBatchSize));
      var results = coldyGetBatch_(context,group.map(function (id) { return '/accounts/' + id; }),guard);
      if (results.length !== group.length) fail_('COLDY_RESPONSE','Coldy не подтвердил все выбранные почты.');
      // Honor the longest rate limit in the group before issuing another request.
      var errors = results.filter(function (item) { return !!item.error; }).map(function (item) { return item.error; });
      if (errors.length) {
        var throttled = errors.filter(function (e) { return e.registryCode === 'COLDY_RATE_LIMIT'; });
        if (throttled.length) {
          var error = throttled[0];
          error.retryAfterMs = Math.max.apply(null,throttled.map(function (e) { return Number(e.retryAfterMs) || 0; }));
          throw error;
        }
        throw errors[0];
      }
      var counters = results.map(function (result,index) {
        var item = result.value;
        if (!item || projectInfraId_(item.id) !== group[index]) fail_('COLDY_RESPONSE','Coldy не подтвердил выбранную почту.');
        var limit = projectInfraCount_(item.daily_limit), sent = projectInfraCount_(item.sent_today);
        return {limit:limit, sent:sent, remaining:limit === null || sent === null ? null : Math.max(0,limit - sent)};
      });
      counters.forEach(function (values) {
        ['limit','sent','remaining'].forEach(function (name) {
          state[name] = values[name] === null || state[name] === null ? null : projectInfraCount_(state[name] + values[name]);
        });
      });
      state.lastAt = Date.now();
      if (!state.firstAt) state.firstAt = state.lastAt;
      state.cursor += group.length;
    } while (state.cursor < stop && Date.now() < deadline);
  } catch (error) {
    if (projectInfraScopeError_(error)) throw error;
    problem = error;
    if (error.registryCode === 'COLDY_RATE_LIMIT') state.retryAt = Date.now() + Math.max(60000,Number(error.retryAfterMs) || 0);
  }
  var committed = locked_(function () {
    var current = guard(), saved = coldyPropertyJson_(current.properties,slot);
    if (!saved || saved.signature !== signature || saved.lease !== token)
      return coldyLimitsCheckpoint_(saved,signature,ids.length,Date.now()) ? saved : null;
    state.lease = ''; state.leaseUntil = 0;
    // A long request can cross midnight. Never publish counters collected on different days.
    if (problem && problem.registryCode === 'COLDY_AUTH' || state.firstAt && !coldyLimitsSameDay_(state.firstAt,Date.now())) {
      current.properties.deleteProperty(slot);
      return null;
    }
    current.properties.setProperty(slot,JSON.stringify(state));
    if (!problem && state.cursor > initialCursor) {
      var receipt = coldyPropertyJson_(current.properties,COLDY.connectionProperty);
      if (!receipt || receipt.version !== COLDY.version || receipt.rootId !== current.rootId || receipt.credentialHash !== settings.credentialHash ||
          !(Date.parse(receipt.checkedAt) >= state.lastAt)) {
        current.properties.setProperty(COLDY.connectionProperty,JSON.stringify({version:COLDY.version,rootId:current.rootId,
          credentialHash:settings.credentialHash,checkedAt:new Date(state.lastAt).toISOString()}));
      }
    }
    return state;
  });
  if (problem) throw problem;
  return coldyLimitsPublic_(committed,ids.length,settings);
}

function coldyLimitsSameDay_(first, last) {
  var day = 86400000, moscow = 10800000;
  return Math.floor(first / day) === Math.floor(last / day) && Math.floor((first + moscow) / day) === Math.floor((last + moscow) / day);
}

function coldyLimitsCheckpoint_(state, signature, count, now) {
  if (!state || state.signature !== signature || projectInfraCount_(state.cursor) === null || state.cursor > count ||
      !['limit','sent','remaining'].every(function (name) { return state[name] === null || projectInfraCount_(state[name]) !== null; }) ||
      !['firstAt','lastAt','retryAt','leaseUntil'].every(function (name) { return projectInfraCount_(state[name]) !== null; }) ||
      typeof state.lease !== 'string' || state.cursor > 0 && !state.firstAt || state.firstAt > state.lastAt || state.lastAt > now) return false;
  if (state.retryAt > now) return true;
  if (state.firstAt && !coldyLimitsSameDay_(state.firstAt,now)) return false;
  return state.cursor < count || now - state.lastAt < 45000;
}

function coldyLimitsPublic_(state, count, settings) {
  var cursor = state ? state.cursor : 0, complete = count > 0 && cursor === count;
  var observed = state && state.lastAt || 0, previous = settings.connected && Date.parse(settings.checkedAt);
  var checked = observed || (previous > 0 && previous <= Date.now() ? previous : 0);
  var message = 'Coldy не предоставляет через API баланс кредитов и остаток тарифа организации.';
  if (!count) message += ' Для дневных лимитов выберите почты в проекте.';
  else if (!complete) message += ' Проверено ' + cursor + ' из ' + count + ' выбранных почт.';
  else {
    message += ' Дневные счётчики относятся к выбранным почтам проекта.';
    if (state.lastAt - state.firstAt >= 60000) {
      function moscowTime(ms) { return new Date(ms + 10800000).toISOString().slice(11,16); }
      message += ' Данные собраны с ' + moscowTime(state.firstAt) + ' до ' + moscowTime(state.lastAt) + ' МСК.';
    }
    if (state.limit === null || state.sent === null) message += ' Coldy вернул не все дневные счётчики.';
  }
  return {provider:'coldy',configured:true,active:checked ? true : null,checkedAt:checked ? new Date(checked).toISOString() : null,
    items:[{label:'Кредиты организации',value:null,unit:'кредитов'},
      {label:'Выбрано почт',value:count,unit:''},
      {label:'Дневной лимит выбранных почт',value:complete ? state.limit : null,unit:'писем'},
      {label:'Отправлено сегодня с выбранных почт',value:complete ? state.sent : null,unit:'писем'},
      {label:'Остаток дневного лимита выбранных почт',value:complete ? state.remaining : null,unit:'писем'}],
    message:message,retryAfterMs:0,pending:count > 0 && !complete};
}
