/** Read-only inputs to the project forecast. Mailbox quotas belong to the capacity model. */
function projectForecastSequence_(detail) {
  var campaign = detail && detail.id;
  if (!coldyUuid_(campaign)) fail_('COLDY_FORECAST_CHANGED', 'Coldy не подтвердил рассылку для расчёта.');
  var sequence = {
    known: Array.isArray(detail.sequences), steps: [],
    stopOnReply: typeof detail.is_stop_sending_on_reply === 'boolean' ? detail.is_stop_sending_on_reply : null,
    stopOnCompanyReply: typeof detail.is_stop_sending_on_company_reply === 'boolean' ? detail.is_stop_sending_on_company_reply : null,
    priority: typeof detail.prioritize_new_leads === 'boolean' ? (detail.prioritize_new_leads ? 'new_leads' : 'sequence_emails') :
      typeof detail.sending_priority === 'string' && /^[a-z_]{1,80}$/.test(detail.sending_priority) ? detail.sending_priority : null
  };
  if (!sequence.known) return sequence;
  var seen = new Set();
  detail.sequences.forEach(function (step) {
    if (!step || typeof step !== 'object') { sequence.known = false; return; }
    if (step.campaign_id != null && (!coldyUuid_(step.campaign_id) || step.campaign_id.toLowerCase() !== campaign.toLowerCase())) {
      fail_('COLDY_FORECAST_CHANGED', 'Coldy не подтвердил принадлежность шага рассылке.');
    }
    if (!Number.isSafeInteger(step.id) || step.id < 1 || seen.has(step.id) ||
        !Number.isSafeInteger(step.delay) || step.delay < 0) { sequence.known = false; return; }
    seen.add(step.id);
    sequence.steps.push({ id: step.id, delayDays: step.delay });
  });
  // Coldy's by-sequence analytics numbers the current steps in ID order.
  if (sequence.known) sequence.steps.sort(function (a,b) { return a.id-b.id; });
  else sequence.steps = [];
  return sequence;
}

/** Round up, so estimated eligibility is never advanced by rounding a recorded send time. */
function projectForecastLastSend_(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  var at = Date.parse(value);
  return Number.isFinite(at) ? new Date(Math.ceil(at / 60000) * 60000).toISOString() : null;
}

function projectForecastLeadCohort_(lead,sequence) {
  var started = lead.amount_sequences_sent, previous = lead.id_previous_sending_sequence, sender = lead.chosen_sender;
  var sent = Number.isSafeInteger(started) && started >= 0 ? started : null;
  var previousId = Number.isSafeInteger(previous) && previous > 0 ? previous : null;
  var selectedSender = Number.isSafeInteger(sender) && sender > 0 ? sender : null;
  var sentAt = projectForecastLastSend_(lead.date_last_sequence_send);
  var noRecordedSend = lead.date_last_sequence_send == null || lead.date_last_sequence_send === '';
  // Some abbreviated lead records omit the counters. The documented zero previous-step ID
  // and Not contacted status together identify a first send even in that representation.
  if (started == null && lead.status === 'Not contacted' && previous === 0 && noRecordedSend) sent = 0;
  var firstSend = sent === 0 && lead.status === 'Not contacted';
  var hasStep = sent !== null || started == null && previousId !== null;
  var replied = lead.status === 'Replied' || typeof lead.reply_text === 'string' && !!lead.reply_text.trim();
  var disposition = 'eligible';
  if (lead.stop_sending === true || lead.status === 'Bounce' || lead.verification_status === 'invalid' ||
      replied && (sequence.stopOnReply === true || sequence.stopOnCompanyReply === true)) disposition = 'stopped';
  else if (lead.stop_sending !== false || ['Not contacted','Sent','Opened','Replied'].indexOf(lead.status) < 0 ||
      replied && (sequence.stopOnReply === null || sequence.stopOnCompanyReply === null) ||
      !hasStep || (!selectedSender && sender !== null && sender !== 0 && !(sender === undefined && firstSend)) ||
      sent === 0 && (previous != null && previous !== 0 || !noRecordedSend || !firstSend) ||
      (sent > 0 || previousId !== null) && lead.status === 'Not contacted') disposition = 'unknown';
  // Stopped leads have no demand, irrespective of their last step, sender and timestamp.
  if (disposition === 'stopped') return { disposition: 'stopped', senderId: null, sentSteps: null, previousStepId: null, lastSentAt: null };
  return { disposition: disposition, senderId: selectedSender, sentSteps: sent, previousStepId: previousId, lastSentAt: sentAt };
}

function projectForecastCohortKey_(cohort) {
  return JSON.stringify([cohort.disposition,cohort.senderId,cohort.sentSteps,cohort.previousStepId,cohort.lastSentAt]);
}

/** Never store message subjects, bodies, identities or addresses in forecast state. */
function projectForecastDemandPage_(context,campaignId,offset,guard,expectedTotal,sequence) {
  if (!coldyUuid_(campaignId) || !Number.isSafeInteger(offset) || offset < 0 || typeof guard !== 'function' ||
      expectedTotal != null && (!Number.isSafeInteger(expectedTotal) || expectedTotal < 0)) {
    fail_('INVALID_REQUEST', 'Проверьте параметры расчёта получателей.');
  }
  campaignId = campaignId.toLowerCase();
  sequence = sequence || {stopOnReply:null, stopOnCompanyReply:null};
  var limit = 200;
  guard(campaignId);
  var page = coldyApi_(context, 'GET', '/leads/campaign/' + campaignId + '?limit=' + limit + '&offset=' + offset);
  guard(campaignId);
  if (!page || !Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < offset ||
      page.offset !== offset || page.limit !== limit || page.items.length !== Math.min(limit, page.total-offset) ||
      expectedTotal != null && expectedTotal !== page.total) {
    fail_('COLDY_FORECAST_CHANGED', 'Список адресатов изменился во время расчёта. Обновите прогноз.');
  }
  var ids = new Set(), byCohort = new Map();
  page.items.forEach(function (lead) {
    if (!lead || !Number.isSafeInteger(lead.id) || lead.id < 1 || ids.has(lead.id) ||
        !coldyUuid_(lead.campaign_id) || lead.campaign_id.toLowerCase() !== campaignId) {
      fail_('COLDY_FORECAST_CHANGED', 'Coldy не подтвердил адресатов выбранной рассылки.');
    }
    ids.add(lead.id);
    var cohort = projectForecastLeadCohort_(lead,sequence), key = projectForecastCohortKey_(cohort);
    if (!byCohort.has(key)) { cohort.count = 0; byCohort.set(key,cohort); }
    byCohort.get(key).count++;
  });
  var next = offset + page.items.length;
  return { campaignId: campaignId, offset: offset, nextOffset: next < page.total ? next : null, total: page.total,
    leadIds: Array.from(ids), cohorts: Array.from(byCohort.values()) };
}

/** Merge verified pages by lead ID. Only unfinished scans need the IDs for overlap detection. */
function projectForecastAppendDemand_(work,page) {
  if (!page || !Array.isArray(page.leadIds) || !Array.isArray(page.cohorts)) fail_('COLDY_FORECAST_CHANGED', 'Страница прогноза недоступна.');
  var hash = digest_(JSON.stringify(page));
  if (work && work.campaignId === page.campaignId && work.lastPageOffset === page.offset && work.lastPageHash === hash) return work;
  if (work ? work.campaignId !== page.campaignId || work.complete || work.total !== page.total || work.nextOffset !== page.offset : page.offset !== 0) {
    fail_('COLDY_FORECAST_CHANGED', 'Страница относится к другому состоянию рассылки.');
  }
  var ids = new Set(work && work.seenIds || []), groups = new Map();
  page.leadIds.forEach(function (id) {
    if (ids.has(id)) fail_('COLDY_FORECAST_CHANGED', 'Coldy повторил адресата на разных страницах.');
    ids.add(id);
  });
  (work && work.cohorts || []).concat(page.cohorts).forEach(function (cohort) {
    var key = projectForecastCohortKey_(cohort);
    if (!groups.has(key)) groups.set(key,Object.assign({},cohort,{count:0}));
    groups.get(key).count += cohort.count;
  });
  var processed = page.offset + page.leadIds.length, complete = page.nextOffset === null;
  if (complete && processed !== page.total || !complete && page.nextOffset !== processed || ids.size !== processed) {
    fail_('COLDY_FORECAST_CHANGED', 'Coldy не подтвердил полноту списка адресатов.');
  }
  return { campaignId: page.campaignId, total: page.total, processed: processed, nextOffset: page.nextOffset, complete: complete,
    cohorts: Array.from(groups.values()), seenIds: complete ? [] : Array.from(ids), lastPageOffset: page.offset, lastPageHash: hash };
}
