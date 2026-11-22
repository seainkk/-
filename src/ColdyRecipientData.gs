/** GET /leads/campaign/{id}. Each Coldy sequence step contains a single email. */
function coldyRecipientPage_(context, campaignId, offset) {
  if (!coldyUuid_(campaignId) || !Number.isSafeInteger(offset) || offset < 0) fail_('INVALID_REQUEST', 'Проверьте рассылку и страницу получателей Coldy.');
  campaignId = campaignId.toLowerCase();
  var limit = 200;
  var page = coldyApi_(context, 'GET', '/leads/campaign/' + campaignId + '?limit=' + limit + '&offset=' + offset);
  if (!page || !Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < 0 ||
      page.offset !== offset || page.limit !== limit || page.items.length !== Math.min(limit, page.total - offset)) {
    fail_('COLDY_RECIPIENT_LIST_CHANGED', 'Coldy не подтвердил полную страницу получателей. Обновите предпросмотр.');
  }
  var items = page.items.map(function (lead) { return coldyRecipientData_(lead, campaignId); });
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
