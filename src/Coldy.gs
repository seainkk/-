/** Coldy Public API. Provider credentials stay in Script Properties only. */
var COLDY = Object.freeze({
  base: 'https://developer.coldy.ai/api/v1', version: 1,
  keyProperty: 'COLDY_API_KEY', connectionProperty: 'COLDY_CONNECTION',
  autoProperty: 'COLDY_AUTO_VALIDATE_EMAILS', providerProperty: 'EMAIL_VALIDATION_PROVIDER',
  folderProperty: 'COLDY_STATE_FOLDER_ID', cacheMillis: 300000,
  maxJsonCharacters: 15000000, maxResponseCharacters: 12000000, readBatchSize: 5,
  fields: 'id,mimeType,parents,trashed,appProperties,version'
});

function getColdySettings_(request) {
  return api_(function () { coldyInput_(request || {}, []); return coldySettingsPublic_(coldySettings_(authorize_())); });
}

function configureColdy_(request) {
  return api_(function () {
    var input = coldyInput_(request, ['apiKey', 'clearKey', 'emailValidationProvider', 'autoValidateEmails', 'acceptValidationCredits']);
    return locked_(function () {
      var context = authorize_(), old = coldySettings_(context), properties = context.properties;
      if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 512 || /[\u0000-\u0020\u007f]/.test(input.apiKey))) fail_('INVALID_REQUEST', 'Проверьте API-ключ Coldy.');
      ['clearKey', 'autoValidateEmails', 'acceptValidationCredits'].forEach(function (name) { if (input[name] !== undefined && typeof input[name] !== 'boolean') fail_('INVALID_REQUEST', 'Некорректные настройки Coldy.'); });
      if (input.clearKey && input.apiKey) fail_('INVALID_REQUEST', 'Выберите сохранение или удаление ключа Coldy.');
      var key = input.clearKey ? '' : (input.apiKey || old.key), rotated = key !== old.key;
      var provider = input.emailValidationProvider === undefined ? old.emailValidationProvider : input.emailValidationProvider;
      if (['promouser', 'coldy'].indexOf(provider) === -1) fail_('INVALID_REQUEST', 'Выберите сервис проверки email.');
      // Removing a key pauses Coldy. It must never silently enable paid Promouser work.
      if (input.emailValidationProvider === 'coldy' && !key && !(input.clearKey && old.emailValidationProvider === 'coldy')) fail_('COLDY_KEY_REQUIRED', 'Сначала подключите API-ключ Coldy.');
      if (input.autoValidateEmails === true) fail_('COLDY_MANUAL_VALIDATION', 'Проверка Coldy запускается вручную после предпросмотра новых email.');
      coldyCurrent_(context, false);
      if (key) properties.setProperty(COLDY.keyProperty, key); else properties.deleteProperty(COLDY.keyProperty);
      properties.setProperty(COLDY.providerProperty, provider);
      properties.setProperty(COLDY.autoProperty, 'false');
      if (rotated) properties.deleteProperty(COLDY.connectionProperty);
      var result = coldySettingsPublic_(coldySettings_(context));
      result.credentialChanged = rotated;
      return result;
    });
  });
}

function coldySettings_(context) {
  var current = coldyCurrent_(context, false), properties = current.properties;
  var key = properties.getProperty(COLDY.keyProperty) || '', credentialHash = key ? digest_(key) : '';
  var provider = typeof emailValidationProvider_ === 'function' ? emailValidationProvider_(current) : (properties.getProperty(COLDY.providerProperty) === 'coldy' ? 'coldy' : 'promouser');
  var connection = coldyPropertyJson_(properties, COLDY.connectionProperty);
  var connected = !!key && !!connection && connection.version === COLDY.version && connection.rootId === current.rootId && connection.credentialHash === credentialHash;
  return { key: key, configured: !!key, connected: connected, credentialHash: credentialHash, emailValidationProvider: provider === 'coldy' ? 'coldy' : 'promouser', autoValidateEmails: false, manualValidation: true, checkedAt: connected ? String(connection.checkedAt || '') : '' };
}

function coldySettingsPublic_(settings) {
  return { configured: settings.configured, connected: settings.connected, emailValidationProvider: settings.emailValidationProvider, autoValidateEmails: false, manualValidation: true, checkedAt: settings.checkedAt };
}

function coldyCredentialHash_(context) {
  var settings = coldySettings_(context);
  if (!settings.key) fail_('COLDY_KEY_REQUIRED', 'Подключите API-ключ Coldy в настройках.');
  return settings.credentialHash;
}

function testColdyConnection_(request) {
  return api_(function () {
    coldyInput_(request || {}, []);
    var context = authorize_(), hash = coldyCredentialHash_(context), result = coldyCampaignsFetch_(context);
    return { connected: true, campaignCount: coldyProjectCampaigns_(context, hash, result.campaigns).length, checkedAt: result.generatedAt };
  });
}

function listColdyCampaigns_(request) {
  return api_(function () {
    var input = coldyInput_(request || {}, ['refresh']);
    if (input.refresh !== undefined && typeof input.refresh !== 'boolean') fail_('INVALID_REQUEST', 'Некорректный режим обновления Coldy.');
    var context = authorize_(), settings = coldySettings_(context);
    if (!settings.configured) return { state: 'not_configured', campaigns: [], generatedAt: '', cached: false };
    var list = coldyReadCampaignCatalog_(context, input.refresh === true, settings);
    list.campaigns = coldyProjectCampaigns_(context, settings.credentialHash, list.campaigns);
    return list;
  });
}

/** Internal catalog only. Each public caller applies live project ownership before returning it. */
function coldyReadCampaignCatalog_(context, refresh, settings) {
  var saved = !refresh && coldyCachedCampaigns_(context, settings);
  var cached = !!saved && Date.parse(saved.generatedAt) > Date.now() - COLDY.cacheMillis && Date.parse(saved.generatedAt) <= Date.now();
  var list = cached ? saved : coldyCampaignsFetch_(context);
  return { state: 'ready', campaigns: list.campaigns, generatedAt: list.generatedAt, cached: cached };
}

/** The provider catalog is shared. Apply today's ownership before a list leaves the project. */
function coldyProjectCampaigns_(context, credentialHash, campaigns, registry) {
  if (typeof registryProjectScoped_ !== 'function' || !registryProjectScoped_()) return campaigns;
  var current = coldyCurrent_(context, true), projectId = registryProjectId_();
  registry = registry || coldyCampaignRegistry_(current);
  if (registry.credentialHash !== credentialHash || coldyCredentialHash_(current) !== credentialHash) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился. Обновите список рассылок.');
  var properties = current.properties.getProperties(), hidden = new Set();
  registry.bindings.forEach(function (binding) {
    if (registrySegmentProject_(current, binding.segmentId, properties) !== projectId) hidden.add(coldyCampaignId_(binding.campaignId));
  });
  return campaigns.filter(function (campaign) { return !hidden.has(campaign.id.toLowerCase()); });
}

/** Read only, with no HTTP and no internal lock. It may be used by a caller holding its lock. */
function coldyCachedCampaigns_(context, settings) {
  settings = settings || coldySettings_(context);
  if (!settings.configured || !settings.connected) return null;
  var saved = coldyLoad_(context, 'campaigns', settings.credentialHash);
  if (!saved || saved.credentialHash !== settings.credentialHash || saved.rootId !== context.rootId || !Array.isArray(saved.campaigns)) return null;
  return { campaigns: coldyCampaignItems_(saved.campaigns), generatedAt: saved.generatedAt };
}

function coldyCampaignsFetch_(context) {
  var credentialHash = coldyCredentialHash_(context), response = coldyApi_(context, 'GET', '/campaigns');
  if (!response || !Array.isArray(response.items)) fail_('COLDY_RESPONSE', 'Coldy не подтвердил список рассылок.');
  var campaigns = coldyCampaignItems_(response.items), generatedAt = new Date().toISOString();
  return locked_(function () {
    var current = coldyCurrent_(context, true);
    if (coldyCredentialHash_(current) !== credentialHash) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился. Повторите проверку подключения.');
    coldySave_(current, 'campaigns', credentialHash, { rootId: current.rootId, credentialHash: credentialHash, campaigns: campaigns, generatedAt: generatedAt });
    current.properties.setProperty(COLDY.connectionProperty, JSON.stringify({ version: COLDY.version, rootId: current.rootId, credentialHash: credentialHash, checkedAt: generatedAt }));
    return { campaigns: campaigns, generatedAt: generatedAt };
  });
}

function coldyCampaignItems_(items) {
  if (items.length > 20000) fail_('COLDY_RESPONSE', 'Список рассылок Coldy слишком большой.');
  var seen = Object.create(null);
  return items.map(function (item) {
    if (!item || !coldyUuid_(item.id) || typeof item.name !== 'string' || item.name.length > 1000 || typeof item.status !== 'string' || item.status.length > 100 || seen[item.id]) fail_('COLDY_RESPONSE', 'Coldy вернул неподдерживаемые данные рассылок.');
    seen[item.id] = true;
    return { id: item.id, name: item.name, status: item.status };
  });
}

/** One fixed-host request. The caller owns dispatch receipts and recovery, not this HTTP helper. */
function coldyApi_(context, method, path, payload, options) {
  var current = coldyCurrent_(context, true), settings = coldySettings_(current);
  if (!settings.configured) fail_('COLDY_KEY_REQUIRED', 'Подключите API-ключ Coldy в настройках.');
  method = typeof method === 'string' ? method.toUpperCase() : '';
  var address = coldyPath_(method, path), inputOptions = options === undefined ? {} : coldyInput_(options, ['idempotencyKey']);
  var request = coldyRequestOptions_(method, settings.key);
  if (inputOptions.idempotencyKey !== undefined) {
    if (typeof inputOptions.idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{8,200}$/.test(inputOptions.idempotencyKey) || method !== 'POST' || address !== '/email-verifications') fail_('INVALID_REQUEST', 'Некорректный ключ повторного запроса Coldy.');
    request.headers['Idempotency-Key'] = inputOptions.idempotencyKey;
  }
  if (method === 'POST') {
    if (address === '/email-verifications' && !request.headers['Idempotency-Key']) fail_('INVALID_REQUEST', 'Для проверки Coldy нужен сохранённый ключ запроса.');
    request.contentType = 'application/json'; request.payload = JSON.stringify(coldyPayload_(address, payload));
  } else if (payload !== undefined && payload !== null) fail_('INVALID_REQUEST', 'Чтение Coldy не принимает тело запроса.');
  // Check scope and credential again immediately before the external action.
  current = coldyCurrent_(context, true);
  if (coldyCredentialHash_(current) !== settings.credentialHash) fail_('COLDY_CREDENTIAL_CHANGED', 'Ключ Coldy изменился. Повторите действие.');
  var response;
  try {
    response = UrlFetchApp.fetch(COLDY.base + address, request);
  } catch (error) { coldyTransportFailure_(error, method); }
  return coldyResponse_(context, settings, method, response);
}

function coldyRequestOptions_(method, key) {
  return { method:method.toLowerCase(), headers:{Authorization:'Bearer ' + key, Accept:'application/json'}, muteHttpExceptions:true, followRedirects:false };
}

/** A bounded read of verified mailbox IDs or pages of one verified campaign. No writes, redirects or directory queries. */
function coldyGetBatch_(context, paths, guard) {
  if (!Array.isArray(paths) || !paths.length || paths.length > COLDY.readBatchSize || typeof guard !== 'function')
    fail_('INVALID_REQUEST', 'Некорректная группа запросов Coldy.');
  var scope, summaryCampaign, seen = new Set();
  var addresses = paths.map(function (path) {
    var address = coldyPath_('GET',path), accounts = /^\/accounts\/[1-9]\d*$/.test(address);
    var summary = address.match(/^\/analytics\/campaigns\/([\w-]+)\/summary\?period=all&type=event$/);
    if (summary) summaryCampaign = summary[1];
    var campaign = summary || address.match(/^\/campaigns\/([\w-]+)$/) || address.match(/^\/leads\/campaign\/([\w-]+)\?limit=\d+&offset=\d+$/);
    var owner = accounts ? 'accounts' : campaign && campaign[1].toLowerCase();
    if (!owner || scope && owner !== scope || seen.has(address)) fail_('INVALID_REQUEST', 'Запросы Coldy относятся к разным областям или повторяются.');
    scope = owner; seen.add(address); return address;
  });
  if (summaryCampaign && (addresses.length !== 2 || !seen.has('/campaigns/' + summaryCampaign)))
    fail_('INVALID_REQUEST','Сводка должна запрашиваться вместе с данными той же рассылки.');
  function failure(error) {
    if (!error || ['COLDY_RATE_LIMIT','COLDY_NETWORK','COLDY_UNAVAILABLE','COLDY_RESPONSE','COLDY_NOT_FOUND','COLDY_FORBIDDEN','COLDY_CONFLICT','COLDY_PROVIDER'].indexOf(error.registryCode) < 0) throw error;
    return {error:error};
  }
  if (addresses.length === 1 || typeof UrlFetchApp === 'undefined' || typeof UrlFetchApp.fetchAll !== 'function') {
    var pause = null;
    return addresses.map(function (address) {
      if (pause) return pause;
      guard();
      try { return {value:coldyApi_(context,'GET',address)}; }
      catch (error) {
        var result = failure(error);
        if (['COLDY_RATE_LIMIT','COLDY_NETWORK','COLDY_UNAVAILABLE'].indexOf(error.registryCode) >= 0) pause = result;
        return result;
      } finally { guard(); }
    });
  }
  var current = coldyCurrent_(context,true), settings = coldySettings_(current);
  if (!settings.configured) fail_('COLDY_KEY_REQUIRED','Подключите API-ключ Coldy в настройках.');
  var requests = addresses.map(function (address) { return Object.assign({url:COLDY.base + address},coldyRequestOptions_('GET',settings.key)); });
  guard();
  if (coldyCredentialHash_(coldyCurrent_(context,false)) !== settings.credentialHash) fail_('COLDY_CREDENTIAL_CHANGED','Ключ Coldy изменился. Повторите действие.');
  var responses;
  try { responses = UrlFetchApp.fetchAll(requests); }
  catch (error) { coldyTransportFailure_(error,'GET'); }
  finally {
    guard();
    if (coldyCredentialHash_(coldyCurrent_(context,false)) !== settings.credentialHash) fail_('COLDY_CREDENTIAL_CHANGED','Ключ Coldy изменился. Повторите действие.');
  }
  if (!Array.isArray(responses) || responses.length !== addresses.length) fail_('COLDY_NETWORK','Google не подтвердил все ответы Coldy. Повторите чтение позже.');
  return responses.map(function (response) {
    try { return {value:coldyResponse_(context,settings,'GET',response)}; }
    catch (error) { return failure(error); }
  });
}

function coldyResponse_(context, settings, method, response) {
  var status, body, parsed;
  try {
    status = response.getResponseCode(); body = response.getContentText();
  } catch (error) { coldyTransportFailure_(error, method); }
  if (status < 200 || status >= 300) {
    if (status === 401) {
      var fresh = coldyCurrent_(context, false);
      if (coldyCredentialHash_(fresh) === settings.credentialHash) fresh.properties.deleteProperty(COLDY.connectionProperty);
      coldyHttpFailure_('COLDY_AUTH', 'Coldy не принял API-ключ. Проверьте ключ выбранной организации.', status, response);
    }
    if (status === 403) coldyHttpFailure_('COLDY_FORBIDDEN', 'Coldy отклонил доступ к действию. Проверьте права организации.', status, response);
    if (status === 404) coldyHttpFailure_('COLDY_NOT_FOUND', 'Объект Coldy не найден в подключённой организации.', status, response);
    if (status === 409) coldyHttpFailure_('COLDY_CONFLICT', method === 'GET' ? 'Coldy пока не подтвердил чтение данных. Повторите обновление позже.' : 'Coldy пока не подтвердил действие: проверьте состояние прежней операции.', status, response);
    if (status === 429) coldyHttpFailure_('COLDY_RATE_LIMIT', 'Coldy просит снизить частоту запросов. Повторите обновление позже.', status, response);
    if (status >= 500) coldyHttpFailure_('COLDY_UNAVAILABLE', method === 'GET' ? 'Coldy временно недоступен. Повторите проверку подключения или обновление позже.' : 'Coldy временно не подтвердил действие. Сначала проверьте состояние операции.', status, response);
    coldyHttpFailure_('COLDY_PROVIDER', 'Coldy отклонил запрос. Проверьте параметры операции.', status, response);
  }
  if (typeof body !== 'string' || body.length > COLDY.maxResponseCharacters) fail_('COLDY_RESPONSE', 'Coldy вернул слишком большой ответ.');
  try { parsed = JSON.parse(body); } catch (error) { fail_('COLDY_RESPONSE', 'Coldy вернул неподдерживаемый ответ.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail_('COLDY_RESPONSE', 'Coldy вернул неподдерживаемый ответ.');
  return parsed;
}

/** Fixed diagnostics only: exceptions can contain credentials and contact data. */
function coldyTransportFailure_(error, method) {
  var message = String(error && error.message || '').slice(0, 4000);
  if (/required permissions|authorization is required|do not have permission|not authorized|insufficient permissions?|script\.external_request|(?:нет|недостаточно) (?:прав|разрешени)|(?:необходимо|необходима|требуется).*авторизац|требуется разрешение/i.test(message)) {
    fail_('COLDY_OWNER_AUTH_REQUIRED', 'Google требует разового разрешения владельца Apps Script на внешние запросы. Откройте проект, выберите файл ContactAutomation.gs, выполните authorizeGoogleAccess и подтвердите доступ, затем повторите проверку подключения. Повторно вводить ключ Coldy не нужно.');
  }
  var reason = '';
  if (/service invoked too many times|quota exceeded|limit exceeded|квот|слишком много (?:раз|запросов)|превышен.*лимит/i.test(message)) reason = 'Достигнут лимит внешних запросов Google. ';
  else if (/timed?\s*out|timeout|время ожидания.*ист[её]к|превышено.*время/i.test(message)) reason = 'Истекло время ожидания ответа. ';
  else if (/dns|name resolution|host not found|не удалось.*имя (?:узла|хоста)/i.test(message)) reason = 'Не удалось определить адрес API Coldy. ';
  else if (/ssl|tls|certificate|сертификат/i.test(message)) reason = 'Не удалось установить защищённое соединение с API Coldy. ';
  var action = method === 'GET' ? 'Этот запрос только читает данные; проверку подключения или обновление можно повторить.' : 'Результат операции может быть неизвестен. Продолжите прежнюю операцию; не создавайте повторную загрузку или проверку.';
  fail_('COLDY_NETWORK', 'Не удалось получить ответ Coldy. ' + reason + action);
}

function coldyHttpFailure_(code, message, status, response) {
  var error = registryError_(code, message), headers = typeof response.getAllHeaders === 'function' ? response.getAllHeaders() : {}, retry = '';
  Object.keys(headers || {}).forEach(function (key) { if (key.toLowerCase() === 'retry-after') retry = String(headers[key]); });
  var delay = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
  error.httpStatus = status; error.retryAfterMs = Number.isFinite(delay) && delay > 0 ? Math.min(86400000, Math.ceil(delay)) : 0;
  throw error;
}

function coldyPath_(method, path) {
  if (['GET', 'POST'].indexOf(method) < 0 || typeof path !== 'string' || path.length > 3000 || /[\u0000-\u0020\u007f#\\]/.test(path) || path.indexOf('://') !== -1 || path.indexOf('..') !== -1 || /%2e|%2f|%5c/i.test(path)) fail_('INVALID_REQUEST', 'Недопустимый адрес API Coldy.');
  var bits = path.split('?'); if (bits.length > 2) fail_('INVALID_REQUEST', 'Некорректные параметры Coldy.');
  var route = bits[0], uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', identifier = '[A-Za-z0-9_-]{1,200}', allowed = null;
  if (method === 'POST') {
    if (route !== '/leads/bulk' && route !== '/email-verifications' || bits.length > 1) fail_('INVALID_REQUEST', 'Неподдерживаемое действие Coldy.');
    return route;
  }
  if (route === '/accounts' || /^\/accounts\/[1-9]\d*$/.test(route)) {
    if (route !== '/accounts' && !Number.isSafeInteger(Number(route.slice('/accounts/'.length)))) fail_('INVALID_REQUEST', 'Некорректный идентификатор ящика Coldy.');
    allowed = [];
  }
  else if (route === '/account-campaign-mappings' || route === '/campaigns' || new RegExp('^/campaigns/' + uuid + '$').test(route) || new RegExp('^/email-verifications/' + identifier + '(?:/results)?$').test(route)) allowed = [];
  else if (new RegExp('^/leads/campaign/' + uuid + '$').test(route)) allowed = ['after_id', 'offset', 'limit', 'search'];
  else if (new RegExp('^/analytics/campaigns/' + uuid + '/(?:summary|events|by-account|by-sequence)$').test(route)) allowed = ['period', 'start_date', 'end_date', 'type', 'event_types'].concat(/\/by-account$/.test(route) ? ['search', 'limit', 'offset', 'sort_by', 'sort_order'] : []);
  if (!allowed) fail_('INVALID_REQUEST', 'Неподдерживаемое действие Coldy.');
  if (bits.length < 2) return route;
  if (!bits[1] || !allowed.length) fail_('INVALID_REQUEST', 'Неподдерживаемые параметры Coldy.');
  var seen = Object.create(null), query = bits[1].split('&').map(function (part) {
    var split = part.split('='); if (split.length !== 2) fail_('INVALID_REQUEST', 'Некорректные параметры Coldy.');
    var name, value; try { name = decodeURIComponent(split[0]); value = decodeURIComponent(split[1].replace(/\+/g, ' ')); } catch (error) { fail_('INVALID_REQUEST', 'Некорректные параметры Coldy.'); }
    if (allowed.indexOf(name) < 0 || seen[name] && name !== 'event_types' || !value || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) fail_('INVALID_REQUEST', 'Некорректные параметры Coldy.');
    seen[name] = true;
    if (['offset', 'after_id', 'limit'].indexOf(name) >= 0 && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < (name === 'offset' ? 0 : 1) || name === 'limit' && Number(value) > (/\/by-account$/.test(route) ? 500 : 200))) fail_('INVALID_REQUEST', 'Некорректный размер страницы Coldy.');
    if (name === 'period' && ['7d', '1m', '3m', '6m', '1y', 'all'].indexOf(value) < 0 || name === 'type' && ['event', 'cohort'].indexOf(value) < 0 || name === 'sort_order' && ['asc', 'desc'].indexOf(value) < 0 || name === 'sort_by' && ['email', 'sender_provider', 'contacted', 'opened', 'replied', 'bounced', 'sent'].indexOf(value) < 0) fail_('INVALID_REQUEST', 'Некорректный фильтр Coldy.');
    return encodeURIComponent(name) + '=' + encodeURIComponent(value);
  });
  return route + '?' + query.join('&');
}

function coldyPayload_(path, payload) {
  var input = coldyInput_(payload, path === '/email-verifications' ? ['emails'] : ['campaign', 'items', 'skip_if_in_campaign', 'skip_if_in_workspace', 'skip_if_in_blacklist']);
  var seen = Object.create(null);
  if (path === '/email-verifications') {
    if (!Array.isArray(input.emails) || !input.emails.length || input.emails.length > 500) fail_('INVALID_REQUEST', 'Проверка Coldy принимает от 1 до 500 новых email.');
    return { emails: input.emails.map(function (value) { var email = coldyEmail_(value); if (seen[email]) fail_('INVALID_REQUEST', 'Повторяющиеся email нельзя отправлять на проверку Coldy.'); seen[email] = true; return email; }) };
  }
  if (!coldyUuid_(input.campaign) || !Array.isArray(input.items) || !input.items.length || input.items.length > 100) fail_('INVALID_REQUEST', 'Загрузка Coldy принимает до 100 контактов в выбранную рассылку.');
  var result = { campaign: input.campaign, items: input.items.map(function (item) {
    var source = coldyInput_(item, ['email', 'first_name', 'last_name', 'company', 'website', 'personalization', 'custom_variables']), target = { email: coldyEmail_(source.email) };
    if (seen[target.email]) fail_('INVALID_REQUEST', 'Загрузка содержит повторяющиеся email.'); seen[target.email] = true;
    ['first_name', 'last_name', 'company', 'website', 'personalization'].forEach(function (name) { if (source[name] !== undefined) { if (typeof source[name] !== 'string' || source[name].length > 5000 || /[\u0000\u007f]/.test(source[name])) fail_('INVALID_REQUEST', 'Некорректные данные контакта Coldy.'); target[name] = source[name]; } });
    if (source.custom_variables !== undefined) {
      object_(source.custom_variables); var names = Object.keys(source.custom_variables);
      if (names.length > 100) fail_('INVALID_REQUEST', 'Слишком много полей контакта Coldy.');
      target.custom_variables = {};
      names.forEach(function (name) { var value = source.custom_variables[name]; if (!/^[A-Za-zА-Яа-яЁё0-9_ -]{1,100}$/.test(name) || ['__proto__', 'constructor', 'prototype'].indexOf(name) >= 0 || typeof value !== 'string' || value.length > 5000 || /[\u0000\u007f]/.test(value)) fail_('INVALID_REQUEST', 'Некорректное дополнительное поле Coldy.'); target.custom_variables[name] = value; });
    }
    return target;
  }) };
  ['skip_if_in_campaign', 'skip_if_in_workspace', 'skip_if_in_blacklist'].forEach(function (name) { if (input[name] !== undefined && input[name] !== true) fail_('INVALID_REQUEST', 'Защита от повторов и чёрного списка Coldy должна быть включена.'); result[name] = true; });
  return result;
}

function coldyEmail_(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@<>;,\u0000-\u001f\u007f]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(value.trim())) fail_('INVALID_REQUEST', 'Некорректный email для Coldy.');
  return value.trim().toLowerCase();
}
function coldyUuid_(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function coldyInput_(value, allowed) { object_(value); if (Object.keys(value).some(function (key) { return allowed.indexOf(key) < 0; })) fail_('INVALID_REQUEST', 'Некорректные параметры Coldy.'); return value; }
function coldyPropertyJson_(properties, key) { try { return JSON.parse(properties.getProperty(key) || 'null'); } catch (error) { return null; } }

/** Callers hold their operation lock/lease. These helpers deliberately do not nest locked_. */
function coldyLoad_(context, kind, owner) {
  // The final state check reads fresh root, folder and file metadata immediately before the blob.
  var scope = coldyStoreScope_(context, kind, owner, false), properties = scope.context.properties;
  var folderId = properties.getProperty(COLDY.folderProperty), fileId = properties.getProperty(scope.indexKey);
  if (fileId != null) id_(fileId);
  var folder = folderId != null ? {id:id_(folderId)} : coldyFolder_(scope.context, false);
  if (!folder) {
    if (fileId != null) fail_('COLDY_STORAGE', 'Не удалось найти служебную папку сохранённого журнала Coldy.');
    return null;
  }
  var file = fileId != null ? coldyStateCheck_(scope, folder, fileId) : coldyStoreFind_(scope, folder);
  return file ? coldyReadEnvelope_(scope, file).data : null;
}

function coldySave_(context, kind, owner, value) {
  object_(value);
  var scope = coldyStoreScope_(context, kind, owner), folder = coldyFolder_(scope.context, true), file = coldyStoreFile_(scope, folder, false);
  var envelope = { version: COLDY.version, rootId: scope.context.rootId, kind: kind, owner: owner, data: value }, text;
  try { text = JSON.stringify(envelope); } catch (error) { fail_('COLDY_STORAGE', 'Не удалось записать журнал Coldy.'); }
  if (!text || text.length > COLDY.maxJsonCharacters) fail_('COLDY_STORAGE_LIMIT', 'Журнал Coldy слишком большой.');
  var key = scope.context.properties.getProperty(COLDY.keyProperty) || '';
  if (key && text.indexOf(key) !== -1) fail_('COLDY_STORAGE', 'Ключ Coldy нельзя сохранять в рабочем журнале.');
  coldyFolderCheck_(scope.context, folder.id);
  if (file) {
    coldyStateCheck_(scope, folder, file.id);
    try { Drive.Files.update({}, file.id, Utilities.newBlob(text, 'application/json', 'coldy.json'), { fields: COLDY.fields, supportsAllDrives: true }); }
    catch (error) {
      var persisted = coldyReadEnvelope_(scope, coldyStateCheck_(scope, folder, file.id));
      if (JSON.stringify(persisted) !== text) fail_('COLDY_STORAGE_UNCERTAIN', 'Google не подтвердил сохранение журнала Coldy. Сначала обновите состояние.');
    }
  } else {
    var metadata = { name: '.coldy-' + kind + '-' + scope.ownerHash + '.json', mimeType: 'application/json', parents: [folder.id], appProperties: coldyStoreTags_(scope) };
    try { file = Drive.Files.create(metadata, Utilities.newBlob(text, 'application/json', 'coldy.json'), { fields: COLDY.fields, supportsAllDrives: true }); }
    catch (error) {
      file = coldyStoreFind_(scope, folder);
      if (!file || JSON.stringify(coldyReadEnvelope_(scope, file)) !== text) fail_('COLDY_STORAGE_UNCERTAIN', 'Google не подтвердил создание журнала Coldy. Повторите чтение состояния.');
    }
    file = coldyStateCheck_(scope, folder, file.id);
  }
  coldyCurrent_(scope.context, false);
  scope.context.properties.setProperty(scope.indexKey, file.id);
  return value;
}

function coldyStoreScope_(context, kind, owner, checkRoot) {
  var current = coldyCurrent_(context, checkRoot !== false);
  if (typeof kind !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(kind) || typeof owner !== 'string' || !owner || owner.length > 200 || /[\u0000-\u001f\u007f]/.test(owner)) fail_('INVALID_REQUEST', 'Некорректный журнал Coldy.');
  return { context: current, kind: kind, owner: owner, ownerHash: digest_(owner), indexKey: 'COLDY_JSON_' + digest_(JSON.stringify([current.rootId, kind, owner])) };
}
function coldyStoreTags_(scope) { return { registryPrivateRole: 'coldy_state', registryColdyRoot: scope.context.rootId, registryColdyKind: scope.kind, registryColdyOwnerHash: scope.ownerHash }; }
function coldyStoreFile_(scope, folder) {
  var stored = scope.context.properties.getProperty(scope.indexKey);
  return stored ? coldyStateCheck_(scope, folder, stored) : coldyStoreFind_(scope, folder);
}
function coldyStoreFind_(scope, folder) {
  coldyFolderCheck_(scope.context, folder.id);
  var tags = coldyStoreTags_(scope), query = "trashed=false and '" + folder.id + "' in parents";
  Object.keys(tags).forEach(function (key) { query += " and appProperties has { key='" + key + "' and value='" + tags[key] + "' }"; });
  var found = Drive.Files.list({ q: query, fields: 'files(' + COLDY.fields + '),nextPageToken', pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true });
  if (found.nextPageToken || (found.files || []).length > 1) fail_('COLDY_STORAGE_UNCERTAIN', 'Найдено несколько одинаковых журналов Coldy.');
  return (found.files || []).length ? coldyStateCheck_(scope, folder, found.files[0].id) : null;
}
function coldyStateCheck_(scope, folder, fileId) {
  coldyFolderCheck_(scope.context, folder.id);
  var file = coldyMetadata_(fileId), tags = file.appProperties || {}, expected = coldyStoreTags_(scope);
  if (file.trashed || file.mimeType !== 'application/json' || !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== folder.id || Object.keys(expected).some(function (key) { return tags[key] !== expected[key]; })) fail_('OUTSIDE_REGISTRY', 'Журнал Coldy перемещён или не принадлежит этому реестру.');
  return file;
}
function coldyReadEnvelope_(scope, file) {
  var text;
  try { text = DriveApp.getFileById(file.id).getBlob().getDataAsString('UTF-8'); } catch (error) { fail_('COLDY_STORAGE', 'Журнал Coldy недоступен.'); }
  if (typeof text !== 'string' || text.length > COLDY.maxJsonCharacters) fail_('COLDY_STORAGE_LIMIT', 'Журнал Coldy слишком большой.');
  var envelope; try { envelope = JSON.parse(text); } catch (error) { fail_('COLDY_STORAGE', 'Журнал Coldy повреждён.'); }
  if (!envelope || envelope.version !== COLDY.version || envelope.rootId !== scope.context.rootId || envelope.kind !== scope.kind || envelope.owner !== scope.owner || !envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) fail_('COLDY_STORAGE', 'Журнал Coldy не соответствует этой операции.');
  return envelope;
}
function coldyFolder_(context, create) {
  var current = coldyCurrent_(context, true), configured = current.properties.getProperty(COLDY.folderProperty), folder;
  if (configured) return coldyFolderCheck_(current, configured);
  var query = "trashed=false and '" + current.rootId + "' in parents and appProperties has { key='registryPrivateRole' and value='coldy_folder' } and appProperties has { key='registryColdyRoot' and value='" + current.rootId + "' }";
  function find() {
    var found = Drive.Files.list({ q: query, fields: 'files(' + COLDY.fields + '),nextPageToken', pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true });
    if (found.nextPageToken || (found.files || []).length > 1) fail_('COLDY_STORAGE_UNCERTAIN', 'Найдено несколько служебных папок Coldy.');
    return (found.files || [])[0] || null;
  }
  folder = find();
  if (!folder && create) {
    coldyCurrent_(current, true);
    try { folder = Drive.Files.create({ name: '_Подключение Coldy', mimeType: 'application/vnd.google-apps.folder', parents: [current.rootId], appProperties: { registryPrivateRole: 'coldy_folder', registryColdyRoot: current.rootId } }, null, { fields: COLDY.fields, supportsAllDrives: true }); }
    catch (error) { folder = find(); if (!folder) fail_('COLDY_STORAGE_UNCERTAIN', 'Google не подтвердил служебную папку Coldy.'); }
  }
  if (!folder) return null;
  folder = coldyFolderCheck_(current, folder.id);
  if (create) current.properties.setProperty(COLDY.folderProperty, folder.id);
  return folder;
}
function coldyFolderCheck_(context, fileId) {
  var current = coldyCurrent_(context, true), file = coldyMetadata_(fileId), tags = file.appProperties || {};
  if (file.id === current.rootId || file.trashed || file.mimeType !== 'application/vnd.google-apps.folder' || !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== current.rootId || tags.registryPrivateRole !== 'coldy_folder' || tags.registryColdyRoot !== current.rootId) fail_('OUTSIDE_REGISTRY', 'Служебная папка Coldy перемещена или не принадлежит реестру.');
  return file;
}
function coldyMetadata_(fileId) {
  try {
    var id = id_(fileId), file = Drive.Files.get(id, { fields: COLDY.fields, supportsAllDrives: true });
    if (!file || file.id !== id) fail_('OUTSIDE_REGISTRY', 'Google не подтвердил запрошенный ID данных Coldy.');
    return file;
  }
  catch (error) { if (error.registryCode) throw error; fail_('COLDY_STORAGE', 'Служебные данные Coldy недоступны.'); }
}
function coldyCurrent_(context, checkRoot) {
  var current = authorize_();
  if (!context || current.rootId !== context.rootId) fail_('SOURCE_CHANGED', 'Привязка реестра изменилась. Повторите действие.');
  if (checkRoot) {
    var root = coldyMetadata_(current.rootId);
    if (!root || root.id !== current.rootId || root.trashed || root.mimeType !== 'application/vnd.google-apps.folder') fail_('OUTSIDE_REGISTRY', 'Корневая папка реестра недоступна.');
  }
  return current;
}
