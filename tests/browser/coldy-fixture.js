/* Local Coldy RPC fakes. Layer after performance-fixture.js or grid-fixture.js.
 * Secrets, payments and uploads below never leave the browser. */
(() => {
  const copy = value => structuredClone(value);
  const state = window.coldyBackend = {
    calls: [], active: 0, pending: [], holdMethods: [], failures: {}, receipts: new Map(),
    key: 'stored-coldy-fixture-key', settings: {
      configured: true, connected: true, emailValidationProvider: 'promouser',
      autoValidateEmails: false, checkedAt: '2026-11-19T10:00:00Z'
    },
    campaigns: [
      { id: 'campaign-draft', name: 'Черновик <img src=x onerror=alert(1)>', status: 'Draft' },
      { id: 'campaign-active', name: 'Рабочая кампания', status: 'Active' }
    ],
    bindings: [], uploadRuns: 0, validationRuns: 0, phoneRuns: 0, pvEmailRuns: 0,
    uploadState: 'complete', validationState: 'complete', validationAutoAdvance: false,
    validationJobs: [], failAfterUpload: false, failAfterValidation: false
  };
  const publicSettings = () => copy(state.settings);
  const requestReceipt = p => {
    if (!p || typeof p.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(p.requestId))
      throw new Error('[INVALID_REQUEST] Нужен идентификатор запроса.');
    const previous = state.receipts.get(p.requestId);
    if (previous && JSON.stringify(previous.payload) !== JSON.stringify(p))
      throw new Error('[REQUEST_REUSED] Повтор должен сохранить исходный запрос.');
    return previous;
  };
  const validationDto = () => ({
    configured: state.settings.configured, enabled: true,
    preferred: state.settings.emailValidationProvider === 'coldy', state: state.validationState,
    counts: { queued: 3, processing: state.validationJobs.length ? 3 : 0, checked: 2, review: 1 },
    jobs: copy(state.validationJobs), canAutoAdvance: state.validationAutoAdvance,
    nextActionAt: state.validationNextActionAt || Date.now() + 1000, warnings: []
  });
  const uploadDto = p => ({
    state: state.uploadState, segmentId: p.segmentId, bindingId: p.bindingId,
    jobId: 'upload-job-1', requestId: state.uploadRequestId || p.requestId,
    counts: { created: 1, alreadyInCampaign: 1, workspaceDuplicate: 1, blacklist: 0, uncertain: 0 },
    progress: { completed: state.uploadState === 'complete' ? 3 : 1, total: 3, label: 'Подтверждаем загрузку' },
    warnings: []
  });
  const methods = {
    getColdySettings: publicSettings,
    configureColdy(p) {
      if (p.autoValidateEmails === true && p.acceptValidationCredits !== true)
        throw new Error('[COLDY_CREDITS_CONSENT_REQUIRED] Подтвердите расход кредитов Coldy.');
      if (p.clearKey) state.key = '';
      else if (p.apiKey) state.key = p.apiKey;
      state.settings = { ...state.settings, configured: !!state.key,
        emailValidationProvider: p.emailValidationProvider ?? state.settings.emailValidationProvider,
        autoValidateEmails: p.autoValidateEmails ?? state.settings.autoValidateEmails };
      return publicSettings();
    },
    testColdyConnection() {
      return { connected: true, campaignCount: state.campaigns.length, checkedAt: '2026-11-19T10:00:00Z' };
    },
    listColdyCampaigns() {
      return { state: 'ready', campaigns: copy(state.campaigns), cached: true, generatedAt: '2026-11-19T10:00:00Z' };
    },
    getColdyBindings() {
      return { bindings: copy(state.bindings), campaigns: copy(state.campaigns), configured: true, connected: true };
    },
    saveColdyBinding(p) {
      requestReceipt(p);
      if (!p.includeCompanies && !p.includeLpr) throw new Error('[INVALID_SOURCE] Выберите компании или ЛПР.');
      const campaign = state.campaigns.find(item => item.id === p.campaignId);
      if (!campaign) throw new Error('[COLDY_CAMPAIGN_MISSING] Кампания недоступна.');
      const binding = { ...copy(p), id: 'binding-' + p.campaignId, bindingId: 'binding-' + p.campaignId,
        campaignName: campaign.name, campaignStatus: campaign.status, campaign: copy(campaign) };
      const index = state.bindings.findIndex(item => item.campaignId === p.campaignId);
      if (index < 0) state.bindings.push(binding); else state.bindings[index] = binding;
      return { binding: copy(binding) };
    },
    removeColdyBinding(p) {
      requestReceipt(p);
      state.bindings = state.bindings.filter(item => item.id !== p.bindingId);
      return { removed: true };
    },
    previewColdyUpload(p) {
      const binding = state.bindings.find(item => item.id === p.bindingId);
      const campaign = state.campaigns.find(item => item.id === binding?.campaignId) || state.campaigns[0];
      return { ...copy(p), previewToken: 'upload-preview-1', campaign: copy(campaign),
        counts: { eligible: 3, alreadyLoaded: 2, notValidated: 4, invalid: 1, ownershipReview: 1, total: 11 },
        sample: [{ email: 'safe@example.test', company: '<img src=x onerror=alert(1)>', name: 'Тестовый контакт' }],
        canUpload: state.canUpload !== false, warnings: ['Загрузка контактов не подтверждает отправку писем.'] };
    },
    startColdyUpload(p) {
      const previous = requestReceipt(p);
      if (!previous) {
        state.receipts.set(p.requestId, { payload: copy(p) });
        state.uploadRequestId = p.requestId;
        state.uploadRuns++;
      }
      if (state.failAfterUpload) {
        state.failAfterUpload = false;
        throw new Error('[COLDY_UPLOAD_UNCERTAIN] Ответ потерялся. Продолжите тот же запрос.');
      }
      return uploadDto(p);
    },
    continueColdyUpload(p) {
      if (p.jobId !== 'upload-job-1' || p.requestId !== state.uploadRequestId)
        throw new Error('[REQUEST_REUSED] Нужен идентификатор задания загрузки.');
      if (state.failContinueUpload) {
        state.failContinueUpload = false;
        throw new Error('[COLDY_UPLOAD_UNCERTAIN] Ответ продолжения потерялся.');
      }
      state.uploadState = 'complete';
      return uploadDto(p);
    },
    getColdyUploadState(p) { return state.uploadRuns ? uploadDto(p) : { state: 'idle' }; },
    refreshColdyMailings() { return {
      key: 'coldy', name: 'Coldy', channel: 'email', state: 'connected',
      campaigns: [{ ...state.campaigns[0], sent: 0, replies: null, leads: null }],
      totals: { sent: 0, replies: null, leads: null }, generatedAt: '2026-11-19T10:00:00Z'
    }; },
    previewColdyValidation(p) {
      return { id: p.id, previewToken: 'validation-preview-1',
        counts: { new: 3, checked: 2, cached: 1, inProgress: 1, invalid: 1 },
        sample: ['new@example.test'], canStart: state.canValidate !== false,
        warnings: ['Будут использованы кредиты Coldy. Ранее проверенные адреса сохраняются.'] };
    },
    startColdyValidation(p) {
      const previous = requestReceipt(p);
      if (p.acceptValidationCredits !== true) throw new Error('[COLDY_CREDITS_CONSENT_REQUIRED] Подтвердите кредиты.');
      if (p.previewToken !== 'validation-preview-1') throw new Error('[PREVIEW_STALE] Повторите предпросмотр.');
      if (!previous) { state.receipts.set(p.requestId, { payload: copy(p) }); state.validationRuns++; }
      if (state.failAfterValidation) {
        state.failAfterValidation = false;
        throw new Error('[COLDY_VALIDATION_UNCERTAIN] Ответ потерялся. Повторите тот же запрос.');
      }
      return validationDto();
    },
    getColdyValidationState: validationDto,
    advanceColdyValidation(p) { requestReceipt(p); return validationDto(); },
    previewPhoneValidation(p) {
      return { id: p.id, previewToken: 'phone-preview-1',
        counts: { new: 2, checked: 2, cached: 1, inProgress: 1, unknownCountry: 1, telegramWithoutPhone: 1, invalid: 1 },
        sample: [{ phone: '+14155550101', country: 'US' }, { phone: '+79990000001', country: 'RU' }],
        canStart: state.canValidatePhones !== false, warnings: [] };
    },
    startPhoneValidation(p) {
      const previous = requestReceipt(p);
      if (p.previewToken !== 'phone-preview-1') throw new Error('[PREVIEW_STALE] Повторите предпросмотр.');
      if (!previous) { state.receipts.set(p.requestId, { payload: copy(p) }); state.phoneRuns++; }
      if (state.failAfterPhone) {
        state.failAfterPhone = false;
        throw new Error('[PV_UNCERTAIN] Ответ проверки потерялся.');
      }
      return { configured: true, enabled: true, state: 'complete',
        counts: { queued: 0, processing: 0, checked: 2, review: 0 }, jobs: [], warnings: [], canAutoAdvance: false };
    },
    previewPromouserValidation(p) {
      if (p.kind === 'telegram') return methods.previewPhoneValidation(p);
      return { id: p.id, kind: p.kind, previewToken: 'pv-email-preview-1',
        counts: { new: 2, checked: 2, cached: 1, inProgress: 1, invalid: 1 },
        sample: [{ email: 'new-pv@example.test' }], canStart: true, warnings: [] };
    },
    startPromouserValidation(p) {
      if (p.kind === 'telegram') return methods.startPhoneValidation(p);
      const previous = requestReceipt(p);
      if (p.kind !== 'email' || p.previewToken !== 'pv-email-preview-1')
        throw new Error('[PREVIEW_STALE] Повторите предпросмотр email.');
      if (!previous) { state.receipts.set(p.requestId, { payload: copy(p) }); state.pvEmailRuns++; }
      if (state.failAfterPvEmail) {
        state.failAfterPvEmail = false;
        throw new Error('[PV_UNCERTAIN] Ответ проверки email потерялся.');
      }
      return { configured: true, enabled: true, state: 'complete',
        counts: { queued: 0, processing: 0, checked: 2, review: 0 }, jobs: [], warnings: [], canAutoAdvance: false };
    }
  };
  if (window.backend) {
    Object.assign(api, methods);
    const originalMailings = api.getSegmentMailings;
    api.getSegmentMailings = p => {
      const dto = originalMailings(p);
      if (state.mailingsConnected) {
        dto.state = 'connected';
        dto.services[0] = methods.refreshColdyMailings();
        dto.totals = { sent: 0, replies: null, leads: null };
      }
      return dto;
    };
  }
  if (window.gridBackend) {
    const originalRpc = window.fakeGridRpc;
    window.fakeGridRpc = (method, payload) => {
      if (!(method in methods)) return originalRpc(method, payload);
      return new Promise((resolve, reject) => {
        gridBackend.calls.push({ method, payload: copy(payload), at: Date.now() });
        state.calls.push({ method, payload: copy(payload), at: Date.now() });
        state.active++; gridBackend.active++;
        gridBackend.maxActive = Math.max(gridBackend.maxActive, gridBackend.active);
        const run = () => {
          try {
            const failure = state.failures[method]?.shift();
            if (failure) throw new Error('[' + failure + '] Проверочная ошибка.');
            const value = methods[method](payload);
            state.active--; gridBackend.active--; resolve(copy(value));
          } catch (error) { state.active--; gridBackend.active--; reject(error); }
        };
        if (state.holdMethods.includes(method)) state.pending.push({ method, run });
        else setTimeout(run, 8);
      });
    };
  }
  window.releaseColdyRpc = method => {
    const index = state.pending.findIndex(item => item.method === method);
    if (index < 0) throw new Error('No held Coldy method: ' + method);
    state.pending.splice(index, 1)[0].run();
  };
  // Exercise throttling without sleeping for real provider poll intervals.
  window.installColdyTimers = () => {
    let now = Date.now();
    const originalSet = window.setTimeout, originalClear = window.clearTimeout;
    Date.now = () => now;
    window.coldyTimers = [];
    window.setTimeout = (fn, delay, ...args) => {
      if (delay >= 15000) {
        const timer = { fn: () => fn(...args), delay, active: true, id: originalSet(() => {}, 3600000) };
        coldyTimers.push(timer);
        return timer.id;
      }
      return originalSet(fn, delay, ...args);
    };
    window.clearTimeout = id => {
      const timer = coldyTimers.find(item => item.id === id);
      if (timer) timer.active = false;
      originalClear(id);
    };
    window.deliverColdyTimer = () => {
      const timer = coldyTimers.find(item => item.active);
      if (!timer) throw new Error('No active Coldy timer.');
      timer.active = false; originalClear(timer.id); now += timer.delay; timer.fn();
    };
  };
})();
