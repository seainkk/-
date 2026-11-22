/** GET /leads/campaign/{id}. Each Coldy sequence step contains a single email. */
function coldyRecipientPage_(context, campaignId, offset) {
  if (!coldyUuid_(campaignId) || !Number.isSafeInteger(offset) || offset < 0) fail_('INVALID_REQUEST', 'Проверьте рассылку и страницу получателей Coldy.');
  campaignId = campaignId.toLowerCase();
  var limit = 200;
  var page = coldyApi_(context, 'GET', '/leads/campaign/' + campaignId + '?limit=' + limit + '&offset=' + offset);
  return coldyRecipientNormalizePage_(campaignId,offset,page);
}

function coldyRecipientNormalizePage_(campaignId,offset,page) {
  var limit = 200;
  if (!coldyUuid_(campaignId) || !Number.isSafeInteger(offset) || offset < 0 ||
      !page || !Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < offset ||
      page.offset !== offset || page.limit !== limit || page.items.length !== Math.min(limit, page.total - offset)) {
    fail_('COLDY_RECIPIENT_LIST_CHANGED', 'Coldy не подтвердил полную страницу получателей. Обновите предпросмотр.');
  }
  var items = page.items.map(function (lead) { return coldyRecipientData_(lead, campaignId.toLowerCase()); });
  var next = offset + items.length;
  return { items: items, total: page.total, nextOffset: next < page.total ? next : null, done: next === page.total };
}

/** Finish reading and validating the full cohort before the caller may update any rows. */
function coldyRecipientSnapshot_(context, campaignId) {
  var credential = coldyCredentialHash_(context), byEmail = new Map(), ids = new Set(), offset = 0, total = null;
  do {
    if (coldyCredentialHash_(context) !== credential) fail_('COLDY_CREDENTIAL_CHANGED', 'Подключение Coldy изменилось. Обновите предпросмотр.');
    var page = coldyRecipientPage_(context, campaignId, offset);
    if (total !== null && total !== page.total) fail_('COLDY_RECIPIENT_LIST_CHANGED', 'Состав рассылки изменился во время чтения. Обновите предпросмотр.');
    total = page.total;
    page.items.forEach(function (lead) {
      if (ids.has(lead.id)) fail_('COLDY_RECIPIENT_LIST_CHANGED', 'Coldy повторил получателя при чтении списка. Обновите предпросмотр.');
      ids.add(lead.id);
      var group = byEmail.get(lead.email);
      if (group) group.push(lead);
      else byEmail.set(lead.email, [lead]);
    });
    offset = page.nextOffset;
  } while (offset !== null);
  if (coldyCredentialHash_(context) !== credential) fail_('COLDY_CREDENTIAL_CHANGED', 'Подключение Coldy изменилось. Обновите предпросмотр.');
  return { items: Array.from(byEmail.values(), coldyRecipientMerge_), total: total };
}

/** The same email may have multiple distinct subscriptions in one Coldy campaign. */
function coldyRecipientMerge_(group) {
  if (group.length === 1) return group[0];
  var merged = Object.assign({}, group[0]);
  merged.id = group.reduce(function (id, lead) { return Math.min(id, lead.id); }, merged.id);
  ['firstName','lastName','company'].forEach(function (key) {
    var names = new Set(group.map(function (lead) { return lead[key]; }).filter(Boolean));
    merged[key] = names.size === 1 ? Array.from(names)[0] : '';
  });
  if (group.some(function (lead) { return lead.status !== merged.status; })) merged.status = null;
  ['replied','bounced','doNotSend'].forEach(function (key) {
    var values = group.map(function (lead) { return lead[key]; });
    merged[key] = values.indexOf(true) >= 0 ? true : values.indexOf(null) >= 0 ? null : false;
  });
  var count = 0;
  group.forEach(function (lead) {
    if (count !== null) count = lead.sentCount !== null && Number.isSafeInteger(count + lead.sentCount) ? count + lead.sentCount : null;
  });
  merged.sentCount = count;
  return merged;
}

function coldyRecipientData_(lead, campaignId) {
  if (!lead || !Number.isSafeInteger(lead.id) || lead.id < 1 || !coldyUuid_(lead.campaign_id) ||
      lead.campaign_id.toLowerCase() !== campaignId) fail_('COLDY_RESPONSE', 'Coldy не подтвердил принадлежность получателя рассылке.');
  var email;
  try { email = coldyEmail_(lead.email); }
  catch (error) { fail_('COLDY_RESPONSE', 'У получателя Coldy отсутствует корректный адрес. Проверьте состав рассылки.'); }
  var status = ['Not contacted','Sent','Opened','Replied','Bounce'].indexOf(lead.status) >= 0 ? lead.status : null;
  var count = lead.amount_sequences_sent;
  var hasReply = typeof lead.reply_text === 'string' && !!lead.reply_text.trim();
  var replyFieldKnown = lead.reply_text === null || typeof lead.reply_text === 'string';
  return {
    id: lead.id, email: email, company: typeof lead.company === 'string' ? lead.company.trim() : '',
    firstName: typeof lead.first_name === 'string' ? lead.first_name.trim() : '',
    lastName: typeof lead.last_name === 'string' ? lead.last_name.trim() : '',
    status: status, sentCount: Number.isSafeInteger(count) && count >= 0 ? count : null,
    replied: hasReply || status === 'Replied' ? true : status && replyFieldKnown ? false : null,
    bounced: status ? status === 'Bounce' : null,
    doNotSend: typeof lead.stop_sending === 'boolean' ? lead.stop_sending : null
  };
}

/** Look up only the addresses/domains in the confirmed campaign. Keep unrelated blacklist entries out of storage. */
function coldyRecipientSuppression_(context,recipients,guard,cursor) {
  var domains = new Map(), hits = new Set();
  recipients.forEach(function (recipient) {
    var email = coldyEmail_(recipient.email), domain = email.slice(email.lastIndexOf('@')+1);
    if (!domains.has(domain)) domains.set(domain,new Set());
    domains.get(domain).add(email);
  });
  var tasks = [];
  Array.from(domains.keys()).sort().forEach(function (domain) {
    var wanted = domains.get(domain);
    tasks.push({kind:'domains',search:domain,domain:domain,wanted:wanted});
    tasks.push({kind:'emails',search:wanted.size === 1 ? Array.from(wanted)[0] : '@'+domain,domain:domain,wanted:wanted});
  });
  var index = cursor ? cursor.index : 0, after = cursor ? cursor.after : null;
  var visited = cursor && Array.isArray(cursor.visited) ? cursor.visited.slice() : [];
  if (!Number.isSafeInteger(index) || index < 0 || index > tasks.length ||
      after != null && (!Number.isSafeInteger(after) || after < 1)) fail_('INVALID_REQUEST','Некорректное продолжение проверки исключений.');
  var cooldown = 0;
  function result(next,retry,unavailable) { return {hits:Array.from(hits),nextCursor:next,retryAfterMs:Math.max(retry || 0,cooldown),unavailable:!!unavailable}; }
  if (index === tasks.length) return result(null);
  var chunk = tasks.slice(index,index+4);
  var paths = chunk.map(function (task,i) {
    return '/blacklist/'+task.kind+'?search='+encodeURIComponent(task.search)+(i === 0 && after ? '&starting_after='+after : '');
  });
  var responses = coldyGetBatch_(context,paths,guard,'recipient-suppression');
  if (responses.length !== paths.length) return result(null,0,true);
  responses.forEach(function (response) {
    if (response.error && response.error.registryCode === 'COLDY_RATE_LIMIT') cooldown = Math.max(cooldown,response.error.retryAfterMs || 60000);
  });
  for (var i=0;i<chunk.length;i++) {
    var task = chunk[i], response = responses[i], error = response.error;
    if (error) {
      if (['COLDY_RATE_LIMIT','COLDY_NETWORK','COLDY_UNAVAILABLE','COLDY_CONFLICT'].indexOf(error.registryCode) >= 0)
        return result({index:index+i,after:after,visited:visited},Math.max(15000,error.retryAfterMs || 60000));
      return result(null,0,true);
    }
    var page = response.value, values = page && page.items, next = page && page.next_starting_after;
    if (!Array.isArray(values) || next !== null && (!Number.isSafeInteger(next) || next < 1) ||
        values.some(function (entry) { return !entry || typeof entry[task.kind === 'domains' ? 'domain' : 'email'] !== 'string'; }))
      return result(null,0,true);
    var domainHit = false;
    values.forEach(function (entry) {
      if (task.kind === 'domains') { if (entry.domain.trim().toLowerCase() === task.domain) domainHit = true; }
      else {
        var email = entry.email.trim().toLowerCase();
        if (task.wanted.has(email)) hits.add(email);
      }
    });
    if (domainHit) task.wanted.forEach(function (email) { hits.add(email); });
    if (next !== null && !domainHit && !(task.kind === 'emails' && Array.from(task.wanted).every(function (email) { return hits.has(email); }))) {
      if (next === after || visited.indexOf(next) >= 0 || visited.length >= 128) return result(null,0,true);
      if (after !== null) visited.push(after);
      return result({index:index+i,after:next,visited:visited});
    }
    after = null; visited = [];
  }
  var offset = index+chunk.length;
  return result(offset < tasks.length ? {index:offset,after:null} : null);
}

/** A rejected bulk upload never creates a campaign lead. Reconcile those receipts without inventing membership. */
function coldyRecipientHistoricalBlocks_(context,binding,recipients) {
  var present = new Set(recipients.map(function (r) { return r.email; }));
  var ledger = coldyCampaignLedger_(context,binding);
  return Object.keys(ledger.emails || {}).filter(function (email) {
    return ledger.emails[email].outcome === 'blacklist' && !present.has(email);
  }).map(function (email) { return {email:email,suppressionOnly:true,blacklisted:true}; });
}
