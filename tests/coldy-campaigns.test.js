import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const ROOT = 'registry_root_1234567890', SEGMENT = 'segment_folder_1234567890', SECOND = 'second_segment_1234567890';
const COMPANIES = 'companies_file_1234567890', LPR = 'lpr_file_1234567890';
const CAMPAIGN = '550e8400-e29b-41d4-a716-446655440000', CAMPAIGN2 = '550e8400-e29b-41d4-a716-446655440001';
const plain = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash('sha256').update(value).digest('base64url');
const HEADERS = ['Email', 'Компания / ЛПР', 'Исходные строки', 'Проверить принадлежность', 'Валидация', 'Статус рассылки'];
const valid = (email, extra = {}) => ({ email, owner: 'Кухни', status: 'Валиден', ...extra });

function fixture(options = {}) {
  let uuid = 0, locked = false;
  const calls = { api: [], saves: [], writes: [], guards: [], workspaces: [], folders: [] }, storage = new Map();
  const state = { access: true, rootId: ROOT, credentialHash: 'credential-A', configured: true, connected: true, ...options.state };
  const campaigns = new Map([[CAMPAIGN, { id: CAMPAIGN, name: 'Кухни email', status: options.status || 'Draft', total_sent: 15, replies_emails: 4 }], [CAMPAIGN2, { id: CAMPAIGN2, name: 'Ещё рассылка', status: 'Paused', total_sent: 8, replies_emails: 1 }]]);
  const books = new Map();
  const files = new Map([[COMPANIES, { segmentId: SEGMENT, rootId: ROOT, role: 'segment-companies', canEdit: true, gid: 0 }], [LPR, { segmentId: SEGMENT, rootId: ROOT, role: 'segment-lpr', canEdit: true, gid: 9 }]]);
  const context = vm.createContext({ console, encodeURIComponent, Date, isFinite,
    Utilities: { getUuid: () => 'uuid-' + String(++uuid).padStart(24, '0') },
    SpreadsheetApp: { openById: id => { if (!books.has(id)) throw new Error('missing workbook'); return books.get(id); } },
  });
  for (const filename of ['Code.gs', 'SegmentActions.gs', 'Promouser.gs', 'ColdyCampaigns.gs']) vm.runInContext(readFileSync(new URL('../src/' + filename, import.meta.url), 'utf8'), context, { filename });
  context.authorize_ = () => { if (!state.access) context.fail_('LINK_ACCESS_REQUIRED', 'link revoked'); return { rootId: state.rootId, properties: {} }; };
  context.digest_ = digest;
  const validationCache = options.validationCache || {}; context.pvCache_ = () => validationCache; context.pvCacheRead_ = value => value;
  context.locked_ = fn => { if (locked) throw new Error('nested lock'); locked = true; try { return fn(); } finally { locked = false; } };
  context.coldySettings_ = () => ({ configured: state.configured, connected: state.connected, credentialHash: state.credentialHash });
  context.coldyCredentialHash_ = () => { if (!state.configured) context.fail_('COLDY_NOT_CONFIGURED', 'missing key'); return state.credentialHash; };
  context.coldyLoad_ = (scope, kind, owner) => {
    context.authorize_(); if (scope.rootId !== state.rootId) context.fail_('COLDY_SCOPE_CHANGED', 'root changed');
    return plain(storage.get(scope.rootId + '|' + kind + '|' + owner) ?? null);
  };
  context.coldySave_ = (scope, kind, owner, value) => {
    context.authorize_(); if (scope.rootId !== state.rootId) context.fail_('COLDY_SCOPE_CHANGED', 'root changed');
    calls.saves.push({ kind, value: plain(value) });
    if (options.beforeSave) options.beforeSave({ kind, value, calls, state });
    storage.set(scope.rootId + '|' + kind + '|' + owner, plain(value));
    if (options.afterSave) options.afterSave({ kind, value, calls, state });
    return value;
  };
  context.segmentSourceFolder_ = () => 'outreach_folder_1234567890';
  context.segmentFolder_ = (_scope, _parent, segmentId) => { context.authorize_(); calls.folders.push(segmentId); if (![SEGMENT, SECOND].includes(segmentId) || options.movedSegment) context.fail_('OUTSIDE_SEGMENTS', 'outside'); return { getId: () => segmentId, getName: () => 'Кухни' }; };
  context.segmentRecordsTargets_ = (scope, segmentId) => {
    for (const [id, file] of files) if (file.segmentId !== segmentId || file.rootId !== scope.rootId || file.moved) context.fail_('OUTSIDE_SEGMENTS', 'source moved');
    return { tables: { companies: COMPANIES, lpr: LPR } };
  };
  context.gridFile_ = (id, write, expectedRoot) => {
    context.authorize_(); calls.guards.push({ id, write }); const file = files.get(id);
    if (!file || file.rootId !== state.rootId || expectedRoot && expectedRoot !== state.rootId || file.moved) context.fail_('OUTSIDE_REGISTRY', 'file moved');
    if (write && !file.canEdit) context.fail_('GRID_READ_ONLY', 'read-only'); return { context: context.authorize_(), canEdit: file.canEdit };
  };
  context.getContactWorkspace_ = ({ id }) => {
    context.gridFile_(id, false); calls.workspaces.push(id); const file = files.get(id);
    return { enrolled: file.enrolled !== false, segmentId: file.segmentId, role: file.role, targets: { emailSheetId: file.gid, phoneSheetId: 3 }, job: file.job || null };
  };
  context.gridSheet_ = (book, gid) => { const found = book.getSheets().find(sheet => sheet.getSheetId() === gid); if (!found) context.fail_('GRID_SHEET_MISSING', 'wrong gid'); return found; };
  context.listColdyCampaigns_ = () => { if (locked) throw new Error('list called inside lock'); return { campaigns: [...campaigns.values()].map(({ id, name, status }) => ({ id, name, status })) }; };
  const leads = new Map();
  context.coldyApi_ = (scope, method, path, payload) => {
    assert.equal(locked, false, 'Provider HTTP must never hold the global script lock');
    context.authorize_(); assert.equal(scope.rootId, state.rootId); calls.api.push({ method, path, payload: payload ? plain(payload) : null });
    if (options.api) { const custom = options.api({ method, path, payload, calls, state, campaigns, leads, context }); if (custom !== undefined) return custom; }
    if (method === 'GET' && path.startsWith('/campaigns/')) { const value = campaigns.get(path.split('/').pop()); if (!value) context.fail_('COLDY_NOT_FOUND', 'missing campaign'); return plain(value); }
    if (method === 'GET' && path.startsWith('/analytics/')) return { interested: 2 };
    if (method === 'GET' && path.startsWith('/leads/campaign/')) { const email = decodeURIComponent(path.split('search=')[1]); return { total: leads.has(email) ? 1 : 0, items: leads.has(email) ? [leads.get(email)] : [] }; }
    if (method === 'POST' && path === '/leads/bulk') {
      for (const item of payload.items) leads.set(item.email, { email: item.email, campaign_id: payload.campaign });
      return { created: payload.items.length, skipped: 0, leads: payload.items.map(item => ({ email: item.email, campaign_id: payload.campaign })), skipped_items: [] };
    }
    throw new Error('unexpected API ' + method + path);
  };
  function makeBook(id, gid, entries, extraSheets = []) {
    const data = [HEADERS.slice(), ...entries.map(row => [row.email, row.owner ?? 'Кухни', 'Лист:2', row.review || '', row.status || '', row.manual || 'Не отправляли'])];
    const notes = new Map(entries.map((row, index) => [index + 2, row.note || '']));
    const sheet = { data, notes, getSheetId: () => gid, getLastRow: () => data.length, getLastColumn: () => Math.max(0, ...data.map(row => row.length)), getMaxColumns: () => 100, insertColumnsAfter: () => {},
      getRange: (row, column, rowCount, columnCount) => ({ getDisplayValues: () => Array.from({ length: rowCount }, (_, y) => Array.from({ length: columnCount }, (_, x) => data[row + y - 1]?.[column + x - 1] ?? '')), getNotes: () => Array.from({ length: rowCount }, (_, y) => [notes.get(row + y) || '']) }) };
    books.set(id, { getSheets: () => [sheet, ...extraSheets] }); return sheet;
  }
  const companySheet = makeBook(COMPANIES, 0, options.companies || [valid('hello@example.com')], options.companyExtraSheets || []);
  const lprSheet = makeBook(LPR, 9, options.lpr || []);
  context.sheetWriteRawStrings_ = (id, gid, row, column, values, mask) => {
    context.authorize_(); const sheet = context.gridSheet_(books.get(id), gid); calls.writes.push({ id, gid, row, column, values: plain(values) });
    if (options.beforeWrite) options.beforeWrite({ id, gid, row, column, values, calls, sheet, state });
    for (let y = 0; y < values.length; y++) { sheet.data[row + y - 1] ||= []; for (let x = 0; x < values[y].length; x++) if (!mask || mask[y][x]) sheet.data[row + y - 1][column + x - 1] = values[y][x]; }
    if (options.afterWrite) options.afterWrite({ id, gid, row, column, values, calls, sheet, state });
  };
  function bind(overrides = {}) { return plain(context.saveColdyBinding_({ segmentId: SEGMENT, campaignId: CAMPAIGN, includeCompanies: true, includeLpr: false, autoUpload: false, allowActive: false, requestId: 'binding-request-' + (++uuid), ...overrides })).binding; }
  function preview(binding) { return plain(context.previewColdyUpload_({ segmentId: binding.segmentId, bindingId: binding.id })); }
  function start(binding, previewResult, requestId = 'upload-request-123') { return plain(context.startColdyUpload_({ segmentId: binding.segmentId, bindingId: binding.id, previewToken: previewResult.previewToken, requestId })); }
  function advance(binding, job) { return plain(context.continueColdyUpload_({ segmentId: binding.segmentId, bindingId: binding.id, jobId: job.jobId, requestId: job.requestId })); }
  return { context, calls, state, storage, campaigns, leads, files, books, companySheet, lprSheet, bind, preview, start, advance };
}
const posts = f => f.calls.api.filter(call => call.method === 'POST');

// Credentials, real scope and binding identity are checked on all paths.
test('all campaign RPCs reject a revoked application link before API/storage/workbook access', () => {
  const f = fixture(); f.state.access = false;
  const rpc = [() => f.context.getColdyBindings_({ segmentId: SEGMENT }), () => f.bind(), () => f.context.previewColdyUpload_({ segmentId: SEGMENT, bindingId: 'a'.repeat(43) }), () => f.context.refreshColdyMailings_({ segmentId: SEGMENT }), () => f.context.processColdyCampaignUploads_({ rootId: ROOT }, { id: COMPANIES })];
  for (const call of rpc) assert.throws(call, /LINK_ACCESS_REQUIRED/);
  assert.equal(f.calls.api.length, 0); assert.equal(f.calls.saves.length, 0); assert.equal(f.calls.workspaces.length, 0);
});

test('campaign belongs to one segment only, multiple distinct campaigns may share one segment', () => {
  const f = fixture(), first = f.bind(); f.bind({ campaignId: CAMPAIGN2 });
  assert.equal(f.context.getColdyBindings_({ segmentId: SEGMENT }).bindings.length, 2);
  assert.throws(() => f.bind({ segmentId: SECOND }), /COLDY_CAMPAIGN_BOUND/);
  assert.equal(f.context.getColdyBindings_({ segmentId: SEGMENT }).bindings[0].id, first.id);
});

test('saving and removal receipts replay exact requests and reject changed payloads', () => {
  const f = fixture(), input = { requestId: 'same-binding-request' }, first = f.bind(input), saves = f.calls.saves.length;
  assert.deepEqual(f.bind(input), first); assert.equal(f.calls.saves.length, saves);
  assert.throws(() => f.bind({ ...input, includeLpr: true }), /REQUEST_REUSED/);
  const removal = { segmentId: SEGMENT, bindingId: first.id, requestId: 'remove-request-123' };
  assert.equal(f.context.removeColdyBinding_(removal).removed, true); assert.equal(f.context.removeColdyBinding_(removal).removed, true);
  assert.throws(() => f.preview(first), /COLDY_BINDING_MISSING/);
});

test('each binding must select a source and use explicit boolean settings', () => {
  const f = fixture(); assert.throws(() => f.bind({ includeCompanies: false }), /COLDY_SOURCE_REQUIRED/);
  assert.throws(() => f.bind({ allowActive: 'true' }), /INVALID_REQUEST/);
  assert.throws(() => f.bind({ campaignId: '../leads' }), /COLDY_CAMPAIGN_ID/);
});

test('credential rotation isolates bindings, analytics and pending uploads from another organization', () => {
  const f = fixture(), binding = f.bind(), preview = f.preview(binding);
  f.context.refreshColdyMailings_({ segmentId: SEGMENT });
  f.state.credentialHash = 'credential-B';
  assert.equal(f.context.getColdyBindings_({ segmentId: SEGMENT }).bindings.length, 0);
  assert.equal(f.context.coldySegmentMailings_(f.context.authorize_(), SEGMENT).totals.sent, null);
  assert.throws(() => f.start(binding, preview), /COLDY_BINDING_MISSING/); assert.equal(posts(f).length, 0);
});

test('preview is managed-GID based, dedupes emails, excludes unvalidated, invalid and ambiguous ownership', () => {
  const f = fixture({ companies: [valid('HELLO@example.com'), valid('hello@example.com'), valid('new@example.com', { status: '' }), valid('invalid@example.com', { status: 'Невалиден' }), valid('shared@example.com', { review: 'Да' }), valid('unknown@example.com', { status: 'unknown' }), valid('disposable@example.com', { status: 'disposable' })], companyExtraSheets: [{ getSheetId: () => 88, getName: () => 'Email', getRange: () => { throw new Error('wrong title lookup'); } }] });
  const preview = f.preview(f.bind());
  assert.equal(preview.counts.total, 6); assert.equal(preview.counts.eligible, 1); assert.equal(preview.counts.notValidated, 1); assert.equal(preview.counts.invalid, 3); assert.equal(preview.counts.ownershipReview, 1);
  assert.equal(preview.sample[0].email, 'hello@example.com'); assert.equal(preview.canUpload, true);
});

test('changed email retains validation history but is ineligible with an old pvBinding note', () => {
  const f = fixture({ companies: [valid('new@example.com', { note: 'registry-validation:' + digest('old') })] });
  // Use the exact deployed note prefix, not a test-only guess.
  f.companySheet.notes.set(2, f.context.PROMOUSER.bindingPrefix + f.context.pvKey_('email', 'old@example.com'));
  const result = f.preview(f.bind()); assert.equal(result.counts.eligible, 0); assert.equal(result.counts.notValidated, 1);
});

test('conflicting owner labels across Company/LPR are held for manual review', () => {
  const f = fixture({ lpr: [valid('hello@example.com', { owner: 'Иван Иванов' })] });
  const result = f.preview(f.bind({ includeLpr: true })); assert.equal(result.counts.eligible, 0); assert.equal(result.counts.ownershipReview, 1);
});

test('source moved, unenrolled, unmanaged role, changed segment or active sync prevents preview', () => {
  for (const mutate of [f => { f.files.get(COMPANIES).moved = true; }, f => { f.files.get(COMPANIES).enrolled = false; }, f => { f.files.get(COMPANIES).role = 'registry'; }, f => { f.files.get(COMPANIES).segmentId = SECOND; }, f => { f.files.get(COMPANIES).job = { jobId: 'working' }; }]) {
    const f = fixture(), binding = f.bind(); mutate(f); assert.throws(() => f.preview(binding)); assert.equal(posts(f).length, 0);
  }
});

test('preview cannot be used after source edits, by another binding, or after expiration', () => {
  const f = fixture(), binding = f.bind(), preview = f.preview(binding);
  f.companySheet.data[1][4] = 'Невалиден'; assert.throws(() => f.start(binding, preview), /COLDY_SOURCE_CHANGED/);
  f.companySheet.data[1][4] = 'Валиден'; const another = f.bind({ campaignId: CAMPAIGN2 }); assert.throws(() => f.start(another, preview), /COLDY_PREVIEW_EXPIRED/);
  for (const [key, value] of f.storage) if (key.includes('|campaignpreview|')) value.expiresAt = 0;
  assert.throws(() => f.start(binding, preview), /COLDY_PREVIEW_EXPIRED/); assert.equal(posts(f).length, 0);
});

test('Draft upload uses all three dedupe flags and records confirmed upload without changing sent/manual statuses', () => {
  const f = fixture({ companies: [valid('hello@example.com', { manual: 'Не трогать статус' })] }), binding = f.bind(), preview = f.preview(binding), job = f.start(binding, preview);
  assert.equal(job.state, 'complete'); assert.equal(job.counts.created, 1); assert.equal(job.progress.completed, 1);
  assert.deepEqual(posts(f)[0].payload, { campaign: CAMPAIGN, items: [{ email: 'hello@example.com', company: 'Кухни' }], skip_if_in_campaign: true, skip_if_in_workspace: true, skip_if_in_blacklist: true });
  assert.equal(f.companySheet.data[1][5], 'Не трогать статус'); assert.match(f.companySheet.data[1][6], /Кухни email/); assert.equal(f.companySheet.data[1][7], 'Загружен в Coldy');
  assert.deepEqual(f.start(binding, preview), job); assert.deepEqual(f.advance(binding, job), job); assert.equal(posts(f).length, 1);
  assert.equal(f.preview(binding).counts.alreadyLoaded, 1); assert.equal(f.preview(binding).counts.eligible, 0);
});

test('batches are bounded to 100 and continuation uses the original job/request', () => {
  const f = fixture({ companies: Array.from({ length: 103 }, (_, index) => valid('a' + index + '@example.com')) }), binding = f.bind(), job = f.start(binding, f.preview(binding));
  assert.equal(job.state, 'processing'); assert.equal(job.progress.completed, 100); assert.equal(posts(f)[0].payload.items.length, 100);
  assert.throws(() => f.context.continueColdyUpload_({ segmentId: SEGMENT, bindingId: binding.id, jobId: job.jobId, requestId: 'different-request' }), /COLDY_UPLOAD_MISSING/);
  const done = f.advance(binding, job); assert.equal(done.state, 'complete'); assert.equal(done.counts.created, 103); assert.equal(posts(f)[1].payload.items.length, 3);
});

test('campaign Active status is checked fresh immediately before upload and requires explicit saved opt-in', () => {
  const f = fixture(), binding = f.bind(), preview = f.preview(binding); f.campaigns.get(CAMPAIGN).status = 'Active';
  assert.throws(() => f.start(binding, preview), /COLDY_CAMPAIGN_ACTIVE/); assert.equal(posts(f).length, 0);
  const g = fixture({ status: 'Active' }), activeBinding = g.bind({ allowActive: true }), activePreview = g.preview(activeBinding);
  assert.match(activePreview.warnings.join(' '), /сразу/); assert.equal(g.start(activeBinding, activePreview).state, 'complete');
  assert.equal(g.calls.api.some(call => /activate|start|status/.test(call.path)), false);
});

test('Completed campaigns cannot receive uploads even with Active opt-in', () => {
  const f = fixture({ status: 'Completed' }), binding = f.bind({ allowActive: true }); assert.equal(f.preview(binding).canUpload, false);
  assert.throws(() => f.start(binding, f.preview(binding)), /COLDY_CAMPAIGN_ACTIVE/); assert.equal(posts(f).length, 0);
});

test('provider skips distinguish selected campaign presence, workspace duplicate and blacklist', () => {
  const f = fixture({ companies: [valid('a@example.com'), valid('b@example.com'), valid('c@example.com')], api: ({ method }) => method === 'POST' ? { created: 0, leads: [], skipped_items: [{ index: 0, email: 'a@example.com', reason: 'campaign_duplicate' }, { index: 1, email: 'b@example.com', reason: 'workspace_duplicate' }, { index: 2, email: 'c@example.com', reason: 'blacklist' }] } : undefined });
  const binding = f.bind(), job = f.start(binding, f.preview(binding));
  assert.deepEqual(job.counts, { created: 0, alreadyInCampaign: 1, workspaceDuplicate: 1, blacklist: 1, uncertain: 0 });
  assert.match(f.companySheet.data[1][6], /Кухни email/); assert.equal(f.companySheet.data[2][6], undefined); assert.match(f.companySheet.data[2][7], /не подтверждена/); assert.match(f.companySheet.data[3][7], /не подтверждена/); assert.equal(f.companySheet.data[2][8], undefined); assert.equal(f.companySheet.data[3][8], undefined);
  const preview = f.preview(binding); assert.equal(preview.counts.alreadyLoaded, 1); assert.equal(preview.counts.workspaceDuplicate, 1); assert.equal(preview.counts.blacklist, 1); assert.equal(preview.counts.eligible, 0);
});

test('a timed-out POST is reconciled by exact canonical email and never repeated', () => {
  const f = fixture({ api: ({ method, payload, leads }) => { if (method === 'POST') { leads.set(payload.items[0].email, { email: 'HELLO@example.com', campaign_id: CAMPAIGN }); const error = new Error('timeout'); error.registryCode = 'COLDY_NETWORK'; throw error; } } });
  const binding = f.bind(), job = f.start(binding, f.preview(binding)); assert.equal(job.state, 'processing'); assert.equal(f.calls.writes.length, 0);
  const done = f.advance(binding, job); assert.equal(done.state, 'complete'); assert.equal(done.counts.alreadyInCampaign, 1); assert.equal(posts(f).length, 1); assert.match(f.companySheet.data[1][7], /Уже в выбранной/);
});

test('substring search results and another campaign never confirm an uncertain upload', () => {
  const f = fixture({ api: ({ method, path, context }) => { if (method === 'POST') context.fail_('COLDY_NETWORK', 'unknown'); if (path.startsWith('/leads/campaign/')) return { items: [{ email: 'prefix-hello@example.com', campaign_id: CAMPAIGN }, { email: 'hello@example.com', campaign_id: CAMPAIGN2 }] }; } });
  const binding = f.bind(), job = f.start(binding, f.preview(binding)), done = f.advance(binding, job);
  assert.equal(done.state, 'needs_review'); assert.equal(done.counts.uncertain, 1); assert.equal(f.calls.writes.length, 0);
  assert.equal(f.preview(binding).counts.eligible, 0); assert.equal(posts(f).length, 1);
});

test('uncertain reconciliation is bounded and preserves progress over continuation', () => {
  const f = fixture({ companies: Array.from({ length: 8 }, (_, index) => valid('a' + index + '@example.com')), api: ({ method, context }) => { if (method === 'POST') context.fail_('COLDY_NETWORK', 'unknown'); } });
  const binding = f.bind(), job = f.start(binding, f.preview(binding)), middle = f.advance(binding, job);
  assert.equal(middle.state, 'processing'); assert.equal(f.calls.api.filter(call => call.path.startsWith('/leads/campaign/')).length, 5);
  assert.equal(f.advance(binding, middle).state, 'needs_review'); assert.equal(posts(f).length, 1);
});

test('incomplete or malformed provider acknowledgement is reconciled rather than counted as success', () => {
  for (const response of [{ created: 1 }, { leads: [{ email: 'foreign@example.com' }], skipped_items: [] }, { leads: [], skipped_items: [{ index: 99, email: 'hello@example.com', reason: 'campaign_duplicate' }] }]) {
    const f = fixture({ api: ({ method }) => method === 'POST' ? response : undefined }), binding = f.bind(), job = f.start(binding, f.preview(binding));
    assert.equal(job.state, 'processing'); assert.equal(job.counts.created, 0); assert.equal(f.calls.writes.length, 0); assert.equal(f.advance(binding, job).state, 'needs_review'); assert.equal(posts(f).length, 1);
  }
});

test('dispatch journal saved before remote upload; a lost journal acknowledgement performs no POST', () => {
  let thrown = false;
  const f = fixture({ afterSave: ({ kind, value }) => { if (!thrown && kind === 'campaignuploads' && value.job?.batch?.state === 'dispatching') { thrown = true; throw new Error('lost save ack'); } } });
  const binding = f.bind(), preview = f.preview(binding); assert.throws(() => f.start(binding, preview)); assert.equal(posts(f).length, 0);
  const job = plain(f.context.getColdyUploadState_({ segmentId: SEGMENT, bindingId: binding.id }));
  assert.equal(f.advance(binding, job).state, 'needs_review'); assert.equal(posts(f).length, 0);
});

test('confirmed API response saved before row writes, a lost cell acknowledgement never reposts', () => {
  let thrown = false;
  const f = fixture({ afterWrite: ({ row }) => { if (row > 1 && !thrown) { thrown = true; throw new Error('lost cell ack'); } } });
  const binding = f.bind(), preview = f.preview(binding); assert.throws(() => f.start(binding, preview)); assert.equal(posts(f).length, 1);
  const pending = plain(f.context.getColdyUploadState_({ segmentId: SEGMENT, bindingId: binding.id })), done = f.advance(binding, pending);
  assert.equal(done.state, 'complete'); assert.equal(done.counts.created, 1); assert.equal(posts(f).length, 1);
  assert.equal(f.companySheet.data[1][6].split('\n').length, 1);
});

test('fresh file write capability and contact identity protect confirmation cells after API response', () => {
  const f = fixture({ api: ({ method, payload }) => { if (method === 'POST') { f.companySheet.data[1][0] = 'replacement@example.com'; return { leads: payload.items.map(item => ({ email: item.email })), skipped_items: [] }; } } });
  const binding = f.bind(); assert.equal(f.start(binding, f.preview(binding)).state, 'complete'); assert.equal(f.calls.writes.filter(write => write.row > 1).length, 0); assert.equal(f.companySheet.data[1][5], 'Не отправляли');
  const g = fixture({ api: ({ method, payload }) => { if (method === 'POST') { g.files.get(COMPANIES).canEdit = false; return { leads: payload.items.map(item => ({ email: item.email })), skipped_items: [] }; } } });
  const second = g.bind(); assert.throws(() => g.start(second, g.preview(second)), /GRID_READ_ONLY/); assert.equal(g.calls.writes.length, 0); assert.equal(posts(g).length, 1);
});

test('new source changes during a continued batch are excluded before remote mutation', () => {
  const f = fixture({ companies: Array.from({ length: 101 }, (_, index) => valid('a' + String(index).padStart(3, '0') + '@example.com')) }), binding = f.bind(), job = f.start(binding, f.preview(binding));
  f.companySheet.data[101][4] = 'Невалиден';
  const done = f.advance(binding, job); assert.equal(done.state, 'complete'); assert.equal(done.counts.created, 100); assert.equal(posts(f).length, 1); assert.match(done.warnings.join(' '), /не отправлены/);
});

test('binding edits and removal invalidate old pending jobs without uploading further contacts', () => {
  const f = fixture({ companies: Array.from({ length: 101 }, (_, index) => valid('a' + index + '@example.com')) }), binding = f.bind(), job = f.start(binding, f.preview(binding));
  f.bind({ includeLpr: true }); assert.throws(() => f.advance(binding, job), /COLDY_BINDING_CHANGED/); assert.equal(posts(f).length, 1);
  f.context.removeColdyBinding_({ segmentId: SEGMENT, bindingId: binding.id, requestId: 'remove-pending-request' }); assert.throws(() => f.advance(binding, job), /COLDY_BINDING_MISSING/);
});

test('analytics reads cache without API fanout, refresh uses documented sent/replies/interested and preserves unknowns', () => {
  const f = fixture(), binding = f.bind(); let before = f.calls.api.length;
  const empty = plain(f.context.coldySegmentMailings_(f.context.authorize_(), SEGMENT)); assert.deepEqual(empty.totals, { sent: null, replies: null, leads: null }); assert.equal(f.calls.api.length, before);
  const loaded = plain(f.context.refreshColdyMailings_({ segmentId: SEGMENT })); assert.deepEqual(loaded.totals, { sent: 15, replies: 4, leads: 2 }); assert.equal(loaded.state, 'connected');
  before = f.calls.api.length; const cached = plain(f.context.coldySegmentMailings_(f.context.authorize_(), SEGMENT)); assert.deepEqual(cached.totals, loaded.totals); assert.equal(f.calls.api.length, before);
  f.bind({ campaignId: CAMPAIGN2 }); assert.deepEqual(plain(f.context.coldySegmentMailings_(f.context.authorize_(), SEGMENT).totals), { sent: null, replies: null, leads: null });
  f.context.removeColdyBinding_({ segmentId: SEGMENT, bindingId: binding.id, requestId: 'remove-analytics-binding' }); assert.equal(f.context.coldySegmentMailings_(f.context.authorize_(), SEGMENT).campaigns.length, 1);
});

test('provider failures do not turn analytics into fake zeroes or leak old successful values as fresh', () => {
  let failSummary = false;
  const f = fixture({ api: ({ path, context }) => { if (failSummary && path.startsWith('/analytics/')) context.fail_('COLDY_UNAVAILABLE', 'provider unavailable'); } });
  f.bind(); f.context.refreshColdyMailings_({ segmentId: SEGMENT }); failSummary = true;
  const result = plain(f.context.refreshColdyMailings_({ segmentId: SEGMENT })); assert.equal(result.state, 'partial'); assert.equal(result.totals.leads, 2); assert.equal(result.totals.sent, 15); assert.equal(result.campaigns[0].stale, true); assert.equal(result.freshness, 'stale');
});

test('automation does nothing without explicit autoUpload, works with new-only eligible contacts and never activates campaigns', () => {
  const f = fixture(), binding = f.bind(); let before = f.calls.api.length;
  assert.equal(f.context.processColdyCampaignUploads_(f.context.authorize_(), { id: COMPANIES }).processed, 0); assert.equal(f.calls.api.length, before);
  f.bind({ autoUpload: true }); const done = plain(f.context.processColdyCampaignUploads_(f.context.authorize_(), { id: COMPANIES })); assert.equal(done.state, 'complete'); assert.equal(done.counts.created, 1);
  assert.equal(f.context.processColdyCampaignUploads_(f.context.authorize_(), { id: COMPANIES }).processed, 0); assert.equal(posts(f).length, 1);
  f.companySheet.data.push(['new@example.com', 'Кухни', 'Лист:3', '', 'Валиден', 'Ручной статус']);
  const newJob = plain(f.context.processColdyCampaignUploads_(f.context.authorize_(), { id: COMPANIES })); assert.equal(newJob.counts.created, 1); assert.equal(posts(f).length, 2); assert.equal(f.companySheet.data[1][5], 'Не отправляли');
  assert.equal(f.calls.api.some(call => /activate/.test(call.path)), false); assert.equal(binding.autoUpload, false);
});

test('automation refuses an Active campaign unless separately opted in, and stops on revoked link/root change', () => {
  const f = fixture({ status: 'Active' }); f.bind({ autoUpload: true }); assert.equal(f.context.processColdyCampaignUploads_(f.context.authorize_(), { id: COMPANIES }).processed, 0); assert.equal(posts(f).length, 0);
  f.state.access = false; assert.throws(() => f.context.processColdyCampaignUploads_({ rootId: ROOT }, { id: COMPANIES }), /LINK_ACCESS_REQUIRED/);
  f.state.access = true; f.state.rootId = 'different_root_1234567890'; assert.throws(() => f.context.processColdyCampaignUploads_({ rootId: ROOT }, { id: COMPANIES }), /COLDY_SCOPE_CHANGED/);
});

test('slow provider HTTP leaves the global lock available and a durable lease rejects concurrent advancement', () => {
  let binding, attempted = false;
  const f = fixture({ api: ({ method }) => {
    if (method === 'POST' && !attempted) {
      attempted = true;
      const job = plain(f.context.getColdyUploadState_({ segmentId: SEGMENT, bindingId: binding.id }));
      assert.throws(() => f.advance(binding, job), /COLDY_UPLOAD_BUSY/);
      // Unrelated state reads can take their own short lock during the HTTP wait.
      assert.equal(f.context.getColdyBindings_({ segmentId: SEGMENT }).bindings.length, 1);
    }
  } });
  binding = f.bind(); assert.equal(f.start(binding, f.preview(binding)).state, 'complete'); assert.equal(posts(f).length, 1); assert.equal(attempted, true);
});

test('credential change while provider responds prevents stale response application or commit to the new organization', () => {
  let rotate = false;
  const f = fixture({ api: ({ method, path, state }) => { if (rotate && method === 'GET' && path.startsWith('/campaigns/')) state.credentialHash = 'credential-B'; } });
  f.bind(); rotate = true; assert.throws(() => f.context.refreshColdyMailings_({ segmentId: SEGMENT }), /COLDY_CREDENTIAL_CHANGED/);
  assert.equal([...f.storage.keys()].some(key => key.includes('|campaignanalytics|')), false); assert.equal(posts(f).length, 0);
});

test('rate-limited uncertain POST honors Retry-After before attempting reconciliation', () => {
  const f = fixture({ api: ({ method, context }) => { if (method === 'POST') { const error = context.registryError_('COLDY_RATE_LIMIT', 'wait'); error.retryAfterMs = 60000; throw error; } } });
  const binding = f.bind(); assert.throws(() => f.start(binding, f.preview(binding)), /COLDY_RATE_LIMIT/);
  const job = plain(f.context.getColdyUploadState_({ segmentId: SEGMENT, bindingId: binding.id })), reads = f.calls.api.length;
  assert.ok(job.nextActionAt > Date.now()); assert.throws(() => f.advance(binding, job), /COLDY_RATE_LIMIT/); assert.equal(f.calls.api.length, reads); assert.equal(posts(f).length, 1);
});

test('acknowledgements for another campaign or contradictory counters cannot mark a row loaded', () => {
  for (const response of [{ leads: [{ email: 'hello@example.com', campaign_id: CAMPAIGN2 }], skipped_items: [] }, { created: 9, skipped: 0, leads: [{ email: 'hello@example.com', campaign_id: CAMPAIGN }], skipped_items: [] }]) {
    const f = fixture({ api: ({ method }) => method === 'POST' ? response : undefined }), binding = f.bind(), job = f.start(binding, f.preview(binding));
    assert.equal(job.state, 'processing'); assert.equal(job.counts.created, 0); assert.equal(f.calls.writes.length, 0); assert.equal(f.advance(binding, job).state, 'needs_review');
  }
});

test('analytics round-robin refresh reaches campaigns beyond the first ten', () => {
  const f = fixture();
  for (let index = 0; index < 12; index++) {
    const id = '550e8400-e29b-41d4-a716-' + String(index + 100).padStart(12, '0');
    f.campaigns.set(id, { id, name: 'Рассылка ' + index, status: 'Paused', total_sent: index, replies_emails: 0 }); f.bind({ campaignId: id });
  }
  const first = plain(f.context.refreshColdyMailings_({ segmentId: SEGMENT })); assert.equal(first.refreshedCampaigns, 10); assert.equal(first.hasMore, true); assert.equal(first.totals.sent, null);
  const second = plain(f.context.refreshColdyMailings_({ segmentId: SEGMENT })); assert.equal(second.campaigns.every(campaign => campaign.updatedAt), true); assert.equal(second.totals.sent, 66); assert.equal(second.totals.replies, 0);
});

test('cached analytics display the oldest real successful timestamp and retain it on provider failure', () => {
  let fail = false;
  const f = fixture({ api: ({ path, context }) => { if (fail && path.startsWith('/analytics/')) context.fail_('COLDY_UNAVAILABLE', 'unavailable'); } });
  f.bind(); f.context.refreshColdyMailings_({ segmentId: SEGMENT });
  const old = '2020-01-02T03:04:05.000Z';
  for (const [key, value] of f.storage) if (key.includes('|campaignanalytics|')) { value.updatedAt = old; value.sentUpdatedAt = old; value.repliesUpdatedAt = old; value.leadsUpdatedAt = old; }
  const cached = plain(f.context.coldySegmentMailings_(f.context.authorize_(), SEGMENT)); assert.equal(cached.generatedAt, old); assert.equal(cached.cached, true); assert.equal(cached.freshness, 'stale'); assert.equal(cached.id, 'coldy');
  fail = true; const next = plain(f.context.refreshColdyMailings_({ segmentId: SEGMENT })); assert.equal(next.generatedAt, old); assert.equal(next.totals.leads, 2); assert.equal(next.campaigns[0].stale, true);
});

test('metadata confirmations batch rows and preserve unrelated cells between selected contacts', () => {
  const f = fixture({ companies: [valid('a@example.com'), valid('bad@example.com', { status: 'Невалиден', manual: 'Чужой статус' }), valid('z@example.com')] }), binding = f.bind();
  assert.equal(f.start(binding, f.preview(binding)).state, 'complete');
  assert.equal(f.calls.writes.length, 4); assert.equal(f.companySheet.data[2][5], 'Чужой статус'); assert.equal(f.companySheet.data[2][7], undefined); assert.equal(f.companySheet.data[1][7], 'Загружен в Coldy'); assert.equal(f.companySheet.data[3][7], 'Загружен в Coldy');
});

test('creating another preview supersedes the old token without accumulating preview files', () => {
  const f = fixture(), binding = f.bind(), first = f.preview(binding), second = f.preview(binding);
  assert.notEqual(first.previewToken, second.previewToken); assert.throws(() => f.start(binding, first), /COLDY_PREVIEW_EXPIRED/);
  assert.equal([...f.storage.keys()].filter(key => key.includes('|campaignpreview|')).length, 1); assert.equal(f.start(binding, second).state, 'complete');
});

test('unsupported overlength addresses are held rather than dispatched to a rejecting provider', () => {
  const f = fixture({ companies: [valid('a'.repeat(245) + '@example.com')] }), binding = f.bind(), preview = f.preview(binding);
  assert.equal(preview.counts.eligible, 0); assert.equal(preview.counts.invalid, 1); assert.equal(f.start(binding, preview).state, 'complete'); assert.equal(posts(f).length, 0);
});

test('completed empty uploads keep their request receipt when subsequent contacts are added', () => {
  const f = fixture({ companies: [] }), binding = f.bind(), preview = f.preview(binding), first = f.start(binding, preview, 'empty-upload-request');
  assert.equal(first.state, 'complete'); f.companySheet.data.push(['new@example.com', 'Кухни', 'Лист:2', '', 'Валиден', 'Ручной статус']);
  const another = f.start(binding, f.preview(binding), 'second-upload-request'); assert.equal(another.counts.created, 1);
  assert.deepEqual(f.start(binding, preview, 'empty-upload-request'), first); assert.equal(posts(f).length, 1);
});

test('global validation review excludes an apparently valid segment row and invalidates an earlier preview', () => {
  const cache = {}, f = fixture({ validationCache: cache }), binding = f.bind(), before = f.preview(binding);
  cache[f.context.pvKey_('email', 'hello@example.com')] = { result: { status: 'Валиден', review: true } };
  assert.throws(() => f.start(binding, before), /COLDY_SOURCE_CHANGED/);
  const blocked = f.preview(binding); assert.equal(blocked.counts.eligible, 0); assert.equal(blocked.counts.ownershipReview, 1); assert.equal(blocked.canUpload, false);
  assert.throws(() => f.start(binding, before), /COLDY_PREVIEW_EXPIRED/); assert.equal(posts(f).length, 0);
});

test('review discovered after the large collection stops dispatch before POST and later completes without a retry', () => {
  const cache = {}; let read = 0, armed = false;
  const f = fixture({ validationCache: cache, api: ({ path, method }) => { if (armed && method === 'GET' && path.startsWith('/campaigns/') && ++read === 2) cache[f.context.pvKey_('email', 'hello@example.com')] = { result: { status: 'Валиден', review: true } }; } });
  const binding = f.bind(), preview = f.preview(binding); armed = true;
  const pending = f.start(binding, preview); assert.equal(pending.state, 'processing'); assert.equal(posts(f).length, 0);
  const done = f.advance(binding, pending); assert.equal(done.state, 'complete'); assert.equal(done.counts.created, 0); assert.equal(posts(f).length, 0);
});

test('company label changed during the final campaign read cannot upload stale ownership details', () => {
  let read = 0, armed = false;
  const f = fixture({ api: ({ path, method }) => { if (armed && method === 'GET' && path.startsWith('/campaigns/') && ++read === 2) f.companySheet.data[1][1] = 'Другая компания'; } });
  const binding = f.bind(), preview = f.preview(binding); armed = true;
  assert.throws(() => f.start(binding, preview), /COLDY_SOURCE_CHANGED/); assert.equal(posts(f).length, 0);
});
