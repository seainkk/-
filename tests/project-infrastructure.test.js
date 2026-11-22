import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';

const ROOT = 'infrastructure_root_1234567890';
const KEY = 'infrastructure_fixture_secret_NEVER_PUBLIC';
const plain = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(String(value)).digest('base64url');

function account(id, extra = {}) {
  return { id, email: `sender${id}@example.test`, first_name: 'Sender', last_name: String(id), service: 'google',
    limit: 100, sent_today: id, total_sent: id * 10, tags: [], error_text: null,
    warmup: true, warmup_daily_limit: 20, warmup_sent_today: 3, warmup_start_date: '2026-11-01', ...extra };
}

function fixture(options = {}) {
  let now = Date.UTC(2026, 10, 22, 9), sequence = 0, rootId = ROOT, authorized = true, locked = false;
  let accounts = options.accounts || [account(1)];
  const properties = new Map(), cache = new Map();
  const calls = { http: [], saves: [], loads: [], locks: 0 };
  const root = { id: ROOT, mimeType: 'application/vnd.google-apps.folder', parents: ['owner_drive_1234567890'], trashed: false };
  const props = { getProperty: key => properties.get(key) ?? null, setProperty: (key, value) => properties.set(key, String(value)), deleteProperty: key => properties.delete(key) };
  const coded = (code, message) => { const error = new Error(`[${code}] ${message}`); error.registryCode = code; return error; };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const response = (body, status = 200, headers = {}) => ({ getResponseCode: () => status,
    getContentText: () => typeof body === 'string' ? body : JSON.stringify(body), getAllHeaders: () => headers });
  const c = vm.createContext({ Date: Clock, console, JSON, Math, Number, String, Array, Object,
    api_: callback => callback(),
    object_: value => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw coded('INVALID_REQUEST', 'Object required'); return value; },
    id_: value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(value)) throw coded('INVALID_ID', 'Invalid ID'); return value; },
    fail_: (code, message) => { throw coded(code, message); }, registryError_: coded, digest_: hash,
    authorize_: () => { if (!authorized) throw coded('LINK_ACCESS_REQUIRED', 'Revoked'); return { rootId, properties: props }; },
    locked_: callback => { assert.equal(locked, false, 'No nested locks'); if (options.beforeLock) options.beforeLock(f); locked = true; calls.locks++; try { return callback(); } finally { locked = false; } },
    Utilities: { getUuid: () => `fixture-request-${++sequence}` },
    Drive: { Files: { get: id => { if (id !== root.id) throw coded('OUTSIDE_REGISTRY', 'Wrong root'); return plain(root); } } },
    UrlFetchApp: { fetch: (url, request) => {
      assert.equal(locked, false, 'HTTP must run outside the global lock');
      assert.equal(request.method, 'get', 'Infrastructure cannot mutate senders or send messages');
      assert.equal(request.payload, undefined);
      assert.equal(request.followRedirects, false);
      const path = url.slice('https://developer.coldy.ai/api/v1'.length);
      calls.http.push(path);
      const defaultResponse = () => {
        if (path === '/accounts') return response({ items: plain(accounts) });
        const id = Number(path.match(/^\/accounts\/(\d+)$/)?.[1]);
        const item = accounts.find(value => Number(value.id) === id);
        if (!item) return response({ message: ['Missing'] }, 404);
        const detail = { ...plain(item), provider: item.service, daily_limit: item.limit, status: 'Connected',
          smtp_password: 'smtp_secret_never_public', oauth_token: 'oauth_secret_never_public',
          warmup: { enabled: item.warmup, daily_limit: item.warmup_daily_limit, sent_today: item.warmup_sent_today,
            started_at: item.warmup_start_date, last_scheduled_at: '2026-11-22T08:00:00Z' }, ...item.detail };
        return response(detail);
      };
      return options.transport ? options.transport({ path, request, response, defaultResponse, calls, f }) : defaultResponse();
    } },
  });
  vm.runInContext(readFileSync(new URL('../src/Coldy.gs', import.meta.url), 'utf8'), c);
  c.coldyLoad_ = (context, kind, owner) => {
    c.coldyCurrent_(context, true);
    if (options.movedStore) throw coded('OUTSIDE_REGISTRY', 'Moved store');
    calls.loads.push({ rootId: context.rootId, kind, owner });
    const result = cache.get(`${context.rootId}|${kind}|${owner}`);
    if (options.afterLoad && kind === 'infrastructure') options.afterLoad(f);
    return result ? plain(result) : null;
  };
  c.coldySave_ = (context, kind, owner, value) => {
    assert.equal(locked, true, 'Cache persistence requires a caller lock');
    c.coldyCurrent_(context, true);
    const key = properties.get('COLDY_API_KEY');
    assert.ok(!key || !JSON.stringify(value).includes(key), 'Never persist the current API key');
    calls.saves.push({ kind, owner, value: plain(value) });
    cache.set(`${context.rootId}|${kind}|${owner}`, plain(value));
    if (options.afterSave) options.afterSave(f);
    return value;
  };
  vm.runInContext(readFileSync(new URL('../src/ProjectInfrastructure.gs', import.meta.url), 'utf8'), c);
  vm.runInContext(readFileSync(new URL('../src/ProjectMonitoring.gs', import.meta.url), 'utf8'), c);
  // Small boundary/race scenarios explicitly retain five-detail batches. Large
  // inventory tests below exercise the unchanged production configuration.
  if (options.detailBatch !== undefined) c.PROJECT_INFRASTRUCTURE = Object.freeze({ ...c.PROJECT_INFRASTRUCTURE, batch: options.detailBatch });
  const f = { c, calls, properties, cache, root, response, coded,
    configure: key => {
      const apiKey = key || KEY, result = c.configureColdy_({ apiKey });
      // Pre-existing small scenarios explicitly model a saved selection of
      // their sender fixture. monitoringIds:null exercises the real default.
      const storeKey = `${rootId}|monitoring|${hash(apiKey)}`;
      if (apiKey === KEY && options.monitoringIds !== null && !cache.has(storeKey)) {
        const ids = options.monitoringIds === undefined ? accounts.map(item => String(item.id)) : options.monitoringIds;
        cache.set(storeKey, { version: 1, rootId, credentialHash: hash(apiKey), revision: 1,
          configured: true, accountIds: plain(c.projectMonitoringIds_(ids, 'INVALID_REQUEST')), receipts: [] });
      }
      return result;
    },
    get: () => plain(c.getProjectInfrastructure_({})), refresh: input => plain(c.refreshProjectInfrastructure_(input || {})),
    tick: value => { now += value; }, setAccounts: value => { accounts = value; },
    revoke: () => { authorized = false; }, switchRoot: () => { rootId = 'other_registry_root_1234567890'; },
    state: () => cache.get(`${ROOT}|infrastructure|${hash(properties.get('COLDY_API_KEY') || '')}`),
    select: ids => {
      const credentialHash = hash(properties.get('COLDY_API_KEY') || ''), storeKey = `${rootId}|monitoring|${credentialHash}`;
      if (ids === null) { cache.delete(storeKey); return; }
      const previous = cache.get(storeKey);
      cache.set(storeKey, { version: 1, rootId, credentialHash, revision: (previous?.revision || 0) + 1,
        configured: true, accountIds: plain(c.projectMonitoringIds_(ids, 'INVALID_REQUEST')), receipts: [] });
    },
  };
  return f;
}

test('unconfigured infrastructure is honest and performs no HTTP, cache creation or sender mutation', () => {
  const f = fixture();
  for (const result of [f.get(), f.refresh()]) {
    assert.equal(result.state, 'not_configured');
    assert.equal(result.configured, false);
    assert.deepEqual(result.accounts, []);
    assert.equal(result.totals.accounts, null);
    assert.equal(result.totals.sentTotal, null);
    assert.equal(result.totals.errorCount, null);
  }
  assert.deepEqual(f.calls.http, []);
  assert.deepEqual(f.calls.saves, []);
});

test('a project without an explicit selection monitors no senders even after listing all 1159 available accounts', () => {
  const f = fixture({ monitoringIds: null, accounts: Array.from({ length: 1159 }, (_, index) => account(index + 1)) });
  f.configure(); const empty = f.get();
  assert.equal(empty.state, 'no_selection'); assert.equal(empty.monitoring.configured, false);
  assert.equal(empty.monitoring.selectedCount, 0); assert.deepEqual(empty.monitoring.accountIds, []);
  assert.equal(empty.availableCount, null); assert.equal(empty.totals.accounts, 0);
  assert.deepEqual(f.calls.http, []);
  const listed = f.refresh();
  assert.equal(listed.state, 'no_selection'); assert.equal(listed.availableCount, 1159);
  assert.deepEqual(listed.accounts, []); assert.equal(listed.nextCursor, null);
  assert.deepEqual(f.state().detailIds, []); assert.deepEqual(f.calls.http, ['/accounts']);
  const requests = f.calls.http.length; f.get(); assert.equal(f.calls.http.length, requests);
  assert.ok(!JSON.stringify(listed).includes('@'), 'The monitoring view does not disclose the unselected inventory');
});

test('only selected senders are returned, counted and fetched while the full inventory remains private for the picker', () => {
  const f = fixture({ monitoringIds: ['2', '4'], accounts: [account(1, { total_sent: 999999, error_text: 'Unselected failure' }), account(2), account(3), account(4)] });
  f.configure(); const result = f.refresh();
  assert.deepEqual(result.accounts.map(item => item.id), ['2', '4']);
  assert.deepEqual(f.calls.http, ['/accounts', '/accounts/2', '/accounts/4']);
  assert.equal(result.state, 'ready'); assert.equal(result.availableCount, 4);
  assert.equal(result.monitoring.selectedCount, 2); assert.equal(result.totals.accounts, 2);
  assert.equal(result.totals.sentTotal, 60); assert.equal(result.totals.sentToday, 6);
  assert.equal(result.totals.dailyLimit, 200); assert.equal(result.totals.accountsWithErrors, 0);
  assert.equal(result.countersScope, 'selected_accounts'); assert.equal(f.state().accounts.length, 4);
  const requests = f.calls.http.length, picker = plain(f.c.getProjectInfrastructureSelection_({}));
  assert.equal(picker.accounts.length, 4); assert.equal(f.calls.http.length, requests);
  assert.equal(f.get().accounts.length, 2); assert.equal(f.calls.http.length, requests);
});

test('explicit inventory-only refresh never fetches sender details and leaves a selected-only continuation', () => {
  const f = fixture({ monitoringIds: ['2', '4'], accounts: [account(1), account(2), account(3), account(4)] });
  f.configure(); const listed = f.refresh({ inventoryOnly: true });
  assert.deepEqual(f.calls.http, ['/accounts']); assert.deepEqual(f.state().detailIds, ['2', '4']);
  assert.deepEqual(listed.detailProgress, { completed: 0, total: 2 }); assert.ok(listed.nextCursor);
  const requests = f.calls.http.length; f.get(); assert.equal(f.calls.http.length, requests);
  const final = f.refresh({ cursor: listed.nextCursor });
  assert.equal(final.state, 'ready'); assert.deepEqual(f.calls.http, ['/accounts', '/accounts/2', '/accounts/4']);
  assert.throws(() => f.refresh({ inventoryOnly: true, cursor: listed.nextCursor }), /INVALID_REQUEST/);
  assert.throws(() => f.refresh({ inventoryOnly: 'yes' }), /INVALID_REQUEST/);
});

test('legacy full-inventory caches do not become an implicit monitoring selection or expose old cursors', () => {
  const f = fixture({ detailBatch: 5, accounts: Array.from({ length: 7 }, (_, index) => account(index + 1)) });
  f.configure(); const legacyCursor = f.refresh().nextCursor;
  delete f.state().detailIds; delete f.state().monitoringSignature; f.select(null);
  const requests = f.calls.http.length, empty = f.get();
  assert.equal(empty.state, 'no_selection'); assert.equal(empty.availableCount, 7);
  assert.deepEqual(empty.accounts, []); assert.equal(empty.nextCursor, null);
  assert.deepEqual(empty.detailProgress, { completed: 0, total: 0 }); assert.equal(f.calls.http.length, requests);
  assert.throws(() => f.refresh({ cursor: legacyCursor }), /COLDY_INFRA_CURSOR_STALE/);
  assert.equal(f.calls.http.length, requests);
  f.select(['2']); const selected = f.get();
  assert.deepEqual(selected.accounts.map(item => item.id), ['2']); assert.equal(selected.totals.sentTotal, 20);
  assert.equal(selected.nextCursor, null); assert.deepEqual(selected.detailProgress, { completed: 0, total: 1 });
  assert.equal(f.calls.http.length, requests);
  f.refresh(); assert.deepEqual(f.calls.http.slice(requests), ['/accounts', '/accounts/2']);
});

test('a monitoring change during inventory or detail reads stops the old job without persistence or later fanout', () => {
  for (const changeAt of ['/accounts', '/accounts/2']) {
    const f = fixture({ monitoringIds: ['2', '4'], accounts: [account(1), account(2), account(3), account(4)],
      transport: ({ path, defaultResponse, f }) => { const result = defaultResponse(); if (path === changeAt) f.select(['4']); return result; } });
    f.configure();
    assert.throws(() => f.refresh(), /COLDY_MONITORING_CHANGED/);
    assert.deepEqual(f.calls.http, changeAt === '/accounts' ? ['/accounts'] : ['/accounts', '/accounts/2']);
    assert.equal(f.calls.saves.length, 0); assert.equal(f.state(), undefined);
    assert.deepEqual(f.get().monitoring.accountIds, ['4']);
  }
});

test('saved and acknowledged cursors become stale after a teammate changes the monitoring selection', () => {
  const f = fixture({ detailBatch: 5, accounts: Array.from({ length: 25 }, (_, index) => account(index + 1)) });
  f.configure(); const first = f.refresh(); f.refresh({ cursor: first.nextCursor });
  f.select(['25']); const requests = f.calls.http.length, current = f.get();
  assert.deepEqual(current.accounts.map(item => item.id), ['25']); assert.equal(current.totals.sentTotal, 250);
  assert.equal(current.nextCursor, null); assert.deepEqual(current.detailProgress, { completed: 0, total: 1 });
  assert.throws(() => f.refresh({ cursor: first.nextCursor }), /COLDY_INFRA_CURSOR_STALE/);
  assert.equal(f.calls.http.length, requests);
  const fresh = f.refresh(); assert.equal(fresh.state, 'ready');
  assert.deepEqual(f.calls.http.slice(requests), ['/accounts', '/accounts/25']);
});

test('selection changes before the final registry lock cannot persist an old monitoring result', () => {
  let armed = false;
  const f = fixture({ monitoringIds: ['2', '4'], accounts: [account(1), account(2), account(3), account(4)],
    beforeLock: current => { if (armed) { armed = false; current.select(['4']); } } });
  f.configure(); armed = true;
  assert.throws(() => f.refresh(), /COLDY_MONITORING_CHANGED/);
  assert.deepEqual(f.calls.http, ['/accounts', '/accounts/2', '/accounts/4']); assert.equal(f.calls.saves.length, 0);
  assert.deepEqual(f.get().monitoring.accountIds, ['4']);
});

test('a failed fresh inventory after changing selection preserves only the current selection and error continuation', () => {
  let unavailable = false;
  const f = fixture({ detailBatch: 5, accounts: Array.from({ length: 7 }, (_, index) => account(index + 1)),
    transport: ({ path, defaultResponse }) => { if (path === '/accounts' && unavailable) throw new Error('Network ' + KEY); return defaultResponse(); } });
  f.configure(); const old = f.refresh(); f.select(['2']); unavailable = true;
  const failed = f.refresh();
  assert.equal(failed.error.code, 'COLDY_NETWORK'); assert.equal(failed.syncPaused, true);
  assert.deepEqual(failed.accounts.map(item => item.id), ['2']); assert.deepEqual(f.state().detailIds, ['2']);
  assert.deepEqual(failed.detailProgress, { completed: 0, total: 1 }); assert.notEqual(failed.nextCursor, old.nextCursor);
  const requests = f.calls.http.length; assert.throws(() => f.refresh({ cursor: old.nextCursor }), /COLDY_INFRA_CURSOR_STALE/);
  assert.equal(f.calls.http.length, requests); assert.ok(!JSON.stringify(failed).includes(KEY));
});

test('explicit inventory diagnostics expose only bounded shape metadata without saving or exposing sender data', () => {
  const f = fixture({ transport: ({ response }) => response({
    items: [account(1, { smtp_password: KEY })], total: 7, has_more: true, next_cursor: 'private-cursor-' + KEY,
    data: { items: [account(2), account(3)] }, accounts: [account(4)], results: [account(5)], private_key: KEY,
  }) });
  f.configure(); const properties = [...f.properties];
  const result = plain(f.c.getProjectInfrastructure_({ diagnose: true }));
  assert.deepEqual(result, { diagnostics: { itemsIsArray: true, itemsLength: 1, maxSupportedAccounts: 5000,
    reportedTotal: 7, hasMore: true, hasContinuation: true, dataArrayLength: null, dataItemsLength: 2,
    accountsArrayLength: 1, resultsArrayLength: 1 } });
  assert.deepEqual(f.calls.http, ['/accounts']); assert.deepEqual(f.calls.saves, []);
  assert.deepEqual([...f.properties], properties); assert.equal(f.cache.size, 1, 'Only the preconfigured monitoring fixture exists');
  assert.ok(!JSON.stringify(result).includes(KEY)); assert.ok(!JSON.stringify(result).includes('@'));
  assert.throws(() => f.c.getProjectInfrastructure_({ diagnose: 'yes' }), /INVALID_REQUEST/);
});

test('inventory diagnostics reject stale access or changed credentials after provider reads', () => {
  for (const action of ['revoke', 'rotate', 'root']) {
    const f = fixture({ transport: ({ defaultResponse, f }) => {
      const result = defaultResponse();
      if (action === 'revoke') f.revoke();
      else if (action === 'rotate') f.configure('different-provider-credential');
      else f.switchRoot();
      return result;
    } });
    f.configure();
    assert.throws(() => f.c.getProjectInfrastructure_({ diagnose: true }),
      action === 'revoke' ? /LINK_ACCESS_REQUIRED/ : action === 'rotate' ? /COLDY_CREDENTIAL_CHANGED/ : /SOURCE_CHANGED/);
    assert.deepEqual(f.calls.http, ['/accounts']); assert.deepEqual(f.calls.saves, []);
  }
});

test('first synchronization exposes the complete inventory and a finite first detail batch', () => {
  const f = fixture({ detailBatch: 5, accounts: Array.from({ length: 7 }, (_, index) => account(index + 1)) });
  f.configure();
  const result = f.refresh();
  assert.equal(result.accounts.length, 7);
  assert.equal(result.state, 'partial');
  assert.equal(result.syncPaused, false);
  assert.equal(result.error, null);
  assert.equal(result.countersScope, 'selected_accounts');
  assert.equal(result.connected, true);
  assert.deepEqual(result.detailProgress, { completed: 5, total: 7 });
  assert.match(result.nextCursor, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(f.calls.http, ['/accounts', '/accounts/1', '/accounts/2', '/accounts/3', '/accounts/4', '/accounts/5']);
  assert.equal(result.accounts[0].status, 'Connected');
  assert.equal(result.accounts[5].status, null);
  assert.equal(result.accounts[5].stale, true);
  assert.equal(result.totals.sentTotal, 280);
  assert.equal(result.totals.sentToday, 28);
  assert.equal(result.totals.errorCount, null);
  assert.equal(result.accounts[0].warmup.dailyLimit, 20);
  assert.equal(result.accounts[0].warmup.repliesToday, null);
  assert.equal(result.accounts[6].warmup.startedAt, '2026-11-01');
});

test('continuation completes remaining details without another inventory request and safely replays an acknowledged cursor', () => {
  const f = fixture({ detailBatch: 5, accounts: Array.from({ length: 7 }, (_, index) => account(index + 1)) });
  f.configure();
  const first = f.refresh(), cursor = first.nextCursor;
  const final = f.refresh({ cursor });
  assert.equal(final.state, 'ready');
  assert.equal(final.nextCursor, null);
  assert.deepEqual(final.detailProgress, { completed: 7, total: 7 });
  assert.equal(f.calls.http.filter(path => path === '/accounts').length, 1);
  assert.equal(f.calls.http.length, 8);
  const before = f.calls.http.length;
  assert.deepEqual(f.refresh({ cursor }), final);
  assert.equal(f.calls.http.length, before);
  assert.throws(() => f.refresh({ cursor: 'A'.repeat(43) }), /COLDY_INFRA_CURSOR_STALE/);
});

test('production batches synchronize all 1159 senders with one inventory read and bounded continuations', () => {
  const f = fixture({ accounts: Array.from({ length: 1159 }, (_, index) => account(index + 1)) });
  assert.equal(f.c.PROJECT_INFRASTRUCTURE.batch, 20);
  assert.equal(f.c.PROJECT_INFRASTRUCTURE.maxAccounts, 5000);
  assert.equal(f.c.PROJECT_INFRASTRUCTURE.maxReceipts, 1001);
  f.configure(); let result = f.refresh(), batches = 1;
  assert.equal(result.accounts.length, 1159); assert.equal(result.totals.accounts, 1159);
  assert.deepEqual(result.detailProgress, { completed: 20, total: 1159 });
  assert.equal(f.calls.http.length, 21);
  const firstCursor = result.nextCursor;
  while (result.nextCursor) {
    const previous = result.detailProgress.completed, requests = f.calls.http.length;
    result = f.refresh({ cursor: result.nextCursor }); batches++;
    assert.ok(result.detailProgress.completed > previous);
    assert.ok(result.detailProgress.completed - previous <= 20);
    assert.ok(f.calls.http.length - requests <= 20);
    assert.ok(batches <= 58, 'Large inventories must finish within their bounded batch count');
  }
  assert.equal(batches, 58); assert.equal(result.state, 'ready');
  assert.deepEqual(result.detailProgress, { completed: 1159, total: 1159 });
  assert.equal(result.accounts[1158].status, 'Connected');
  assert.equal(f.calls.http.filter(path => path === '/accounts').length, 1);
  const details = f.calls.http.filter(path => path.startsWith('/accounts/'));
  assert.equal(details.length, 1159); assert.equal(new Set(details).size, 1159);
  assert.deepEqual(details, Array.from({ length: 1159 }, (_, index) => '/accounts/' + (index + 1)));
  const requests = f.calls.http.length;
  assert.deepEqual(f.refresh({ cursor: firstCursor }), result);
  assert.equal(f.calls.http.length, requests, 'Acknowledged continuation replay never repeats provider reads');
});

test('the 5000-sender bound accepts a complete inventory and refuses 5001 without replacing it', () => {
  const f = fixture({ accounts: Array.from({ length: 5000 }, (_, index) => account(index + 1)) });
  f.configure(); const good = f.refresh();
  assert.equal(good.accounts.length, 5000); assert.equal(good.totals.accounts, 5000);
  assert.equal(good.accounts[4999].id, '5000'); assert.equal(good.detailProgress.completed, 20);
  const requests = f.calls.http.length;
  f.tick(1); f.setAccounts(Array.from({ length: 5001 }, (_, index) => account(index + 1)));
  const refused = f.refresh();
  assert.equal(refused.error.code, 'COLDY_INFRA_INCOMPLETE');
  assert.equal(refused.accounts.length, 5000); assert.equal(refused.lastSyncAt, good.lastSyncAt);
  assert.equal(refused.nextCursor, good.nextCursor); assert.equal(refused.detailProgress.completed, 20);
  assert.equal(f.calls.http.length, requests + 1, 'No detail reads occur for a refused inventory');
});

test('detail deadlines reset on continuation and a slow first request still advances without skips', () => {
  for (const [delay, perBatch] of [[7000, 2], [13000, 1]]) {
    const f = fixture({ accounts: Array.from({ length: 5 }, (_, index) => account(index + 1)),
      transport: ({ path, defaultResponse, f }) => {
        const result = defaultResponse(); if (path.startsWith('/accounts/')) f.tick(delay); return result;
      } });
    f.configure(); let result = f.refresh();
    assert.equal(result.detailProgress.completed, perBatch);
    assert.equal(result.syncPaused, false); assert.equal(result.error, null);
    while (result.nextCursor) {
      const previous = result.detailProgress.completed, cursor = result.nextCursor;
      result = f.refresh({ cursor });
      assert.equal(result.detailProgress.completed, Math.min(5, previous + perBatch));
      const requests = f.calls.http.length;
      assert.deepEqual(f.refresh({ cursor }), result); assert.equal(f.calls.http.length, requests);
    }
    assert.equal(result.state, 'ready'); assert.equal(result.detailProgress.completed, 5);
    assert.deepEqual(f.calls.http, ['/accounts', '/accounts/1', '/accounts/2', '/accounts/3', '/accounts/4', '/accounts/5']);
  }
});

test('deadline progress includes a missing sender while rate limits keep their cursor and cooldown', () => {
  let limited = true;
  const f = fixture({ accounts: [account(1), account(2), account(3)],
    transport: ({ path, response, defaultResponse, f }) => {
      if (!path.startsWith('/accounts/')) return defaultResponse();
      f.tick(13000);
      if (path === '/accounts/1') return response({}, 404);
      if (path === '/accounts/3' && limited) return response({}, 429, { 'Retry-After': '30' });
      return defaultResponse();
    } });
  f.configure(); const first = f.refresh();
  assert.equal(first.detailProgress.completed, 1); assert.equal(first.syncPaused, false);
  assert.equal(first.accounts[0].syncError.code, 'COLDY_NOT_FOUND');
  const second = f.refresh({ cursor: first.nextCursor });
  assert.equal(second.detailProgress.completed, 2);
  const paused = f.refresh({ cursor: second.nextCursor });
  assert.equal(paused.detailProgress.completed, 2); assert.equal(paused.nextCursor, second.nextCursor);
  assert.equal(paused.syncPaused, true); assert.equal(paused.retryAfterMs, 30000);
  assert.equal(paused.error.code, 'COLDY_RATE_LIMIT');
  const requests = f.calls.http.length;
  f.refresh({ cursor: paused.nextCursor }); assert.equal(f.calls.http.length, requests);
  f.tick(30001); limited = false;
  const final = f.refresh({ cursor: paused.nextCursor });
  assert.equal(final.detailProgress.completed, 3); assert.equal(final.nextCursor, null);
  assert.equal(final.error, null); assert.equal(final.syncPaused, false);
  assert.equal(final.state, 'partial', 'The missing first sender remains honestly stale');
  assert.deepEqual(f.calls.http, ['/accounts', '/accounts/1', '/accounts/2', '/accounts/3', '/accounts/3']);
});

test('cached reads never access Coldy or rewrite state, including aged data', () => {
  const f = fixture(); f.configure(); const first = f.refresh();
  const requests = f.calls.http.length, writes = f.calls.saves.length;
  assert.equal(f.get().state, 'ready');
  f.tick(300001);
  const old = f.get();
  assert.equal(old.state, 'partial');
  assert.equal(old.stale, true);
  assert.equal(old.accounts[0].stale, true);
  assert.equal(old.accounts[0].sentTotal, first.accounts[0].sentTotal);
  assert.equal(old.lastSyncAt, first.lastSyncAt);
  assert.equal(f.calls.http.length, requests);
  assert.equal(f.calls.saves.length, writes);
});

test('only whitelisted account fields survive and provider error text is scrubbed before persistence', () => {
  const errorText = `Authentication ${KEY}; password=smtp_secret_never_public access_token=oauth_secret_never_public; smtp://user:url_secret@host; Bearer bearer_secret; Authorization: Basic dXNlcjpwYXNz; {"password":"json_secret_never_public","apiKey":"json_api_key_secret"}`;
  const f = fixture({ accounts: [account(1, { error_text: errorText, signature: KEY, private_data: KEY,
    detail: { error_text: errorText, api_key: KEY, secret: KEY, imap_password: 'imap_secret_never_public' } })] });
  f.configure();
  const result = f.refresh(), serialized = JSON.stringify({ result, saved: f.calls.saves });
  for (const secret of [KEY, 'smtp_secret_never_public', 'oauth_secret_never_public', 'url_secret', 'bearer_secret', 'imap_secret_never_public', 'dXNlcjpwYXNz', 'json_secret_never_public', 'json_api_key_secret']) assert.ok(!serialized.includes(secret), secret);
  for (const privateField of ['smtp_password', 'imap_password', 'oauth_token', 'api_key', 'signature', 'private_data']) assert.ok(!Object.hasOwn(result.accounts[0], privateField));
  assert.ok(!JSON.stringify(result).includes(hash(KEY)));
  assert.equal(result.accounts[0].errorCount, null);
  assert.match(result.accounts[0].errors[0].message, /Authentication/);
  assert.equal(result.totals.accountsWithErrors, 1);
});

test('unknown, invalid and absent metrics remain null instead of inventing zero', () => {
  const f = fixture({ accounts: [account(1, { limit: '100', total_sent: -1, sent_today: null,
    detail: { status: undefined, total_sent: undefined, sent_today: false, daily_limit: Infinity, error_text: null, warmup: null } })] });
  f.configure(); const result = f.refresh(), item = result.accounts[0];
  assert.equal(item.status, null);
  assert.equal(item.sentTotal, null);
  assert.equal(item.sentToday, null);
  assert.equal(item.dailyLimit, null);
  assert.equal(item.errorCount, null);
  assert.equal(item.warmup.enabled, null);
  assert.equal(item.warmup.sentToday, null);
  assert.deepEqual(item.errors, []);
  assert.equal(result.totals.sentTotal, null);
  assert.equal(result.totals.errorCount, null);
});

test('empty confirmed inventory has zero account counters, while an unavailable inventory does not', () => {
  const f = fixture({ accounts: [] }); f.configure(); const empty = f.refresh();
  assert.equal(empty.state, 'no_selection'); assert.equal(empty.totals.accounts, 0);
  assert.equal(empty.totals.sentTotal, 0); assert.equal(empty.totals.errorCount, null);
  assert.deepEqual(f.calls.http, ['/accounts']);
  const bad = fixture({ transport: ({ response }) => response({ message: [KEY] }, 500) }); bad.configure();
  const failed = bad.refresh(); assert.equal(failed.state, 'error');
  assert.equal(failed.totals.accounts, null); assert.equal(failed.totals.sentTotal, null);
  assert.ok(!JSON.stringify(failed).includes(KEY));
});

test('inventory errors retain last-good data and its successful timestamp with a stale warning', () => {
  let failing = false;
  const f = fixture({ transport: ({ path, response, defaultResponse }) => failing && path === '/accounts' ? response({ error: KEY }, 500) : defaultResponse() });
  f.configure(); const good = f.refresh(); f.tick(1000); failing = true;
  const bad = f.refresh();
  assert.equal(bad.state, 'partial'); assert.equal(bad.stale, true);
  assert.equal(bad.lastSyncAt, good.lastSyncAt); assert.notEqual(bad.updatedAt, good.updatedAt);
  assert.deepEqual(bad.accounts.map(item => [item.id, item.email, item.sentTotal]), good.accounts.map(item => [item.id, item.email, item.sentTotal]));
  assert.ok(bad.warnings.length); assert.ok(!JSON.stringify(bad).includes(KEY));
});

test('rate limits are enforced server-side for initial refresh and cursor refresh without a retry loop', () => {
  let limited = true;
  const f = fixture({ detailBatch: 5, accounts: Array.from({ length: 7 }, (_, index) => account(index + 1)),
    transport: ({ path, response, defaultResponse }) => path === '/accounts/2' && limited ? response({}, 429, { 'Retry-After': '30' }) : defaultResponse() });
  f.configure(); const first = f.refresh();
  assert.deepEqual(first.detailProgress, { completed: 1, total: 7 });
  assert.equal(first.retryAfterMs, 30000);
  assert.equal(first.syncPaused, true);
  assert.equal(first.error.code, 'COLDY_RATE_LIMIT');
  const count = f.calls.http.length;
  f.refresh(); f.refresh({ cursor: first.nextCursor });
  assert.equal(f.calls.http.length, count, 'A fresh refresh must not bypass a detail cooldown');
  f.tick(30001); limited = false;
  const next = f.refresh({ cursor: first.nextCursor });
  assert.deepEqual(next.detailProgress, { completed: 6, total: 7 });
  assert.equal(next.retryAfterMs, 0);
  assert.equal(next.syncPaused, false);
  assert.equal(next.error, null);
  assert.notEqual(next.nextCursor, first.nextCursor);
  assert.equal(next.accounts[1].syncError, null);
  const final = f.refresh({ cursor: next.nextCursor });
  assert.equal(final.state, 'ready'); assert.equal(final.nextCursor, null);
});

test('an inventory 429 also blocks repeated initial refreshes until Retry-After', () => {
  let limited = true;
  const f = fixture({ transport: ({ path, response, defaultResponse }) => path === '/accounts' && limited ? response({}, 429, { 'retry-after': '20' }) : defaultResponse() });
  f.configure(); const first = f.refresh(); assert.equal(first.state, 'error'); assert.equal(first.retryAfterMs, 20000);
  f.refresh(); f.get(); assert.equal(f.calls.http.length, 1);
  f.tick(20001); limited = false; assert.equal(f.refresh().state, 'ready');
});

test('a changed account identity is not attached to the listed sender', () => {
  const f = fixture({ transport: ({ path, response, defaultResponse }) => path === '/accounts/1' ? response({ id: 1, email: 'another@example.test', status: 'Connected', total_sent: 999 }) : defaultResponse() });
  f.configure(); const result = f.refresh();
  assert.equal(result.state, 'partial'); assert.equal(result.nextCursor, null);
  assert.equal(result.accounts[0].email, 'sender1@example.test');
  assert.equal(result.accounts[0].sentTotal, 10);
  assert.equal(result.accounts[0].status, null);
  assert.equal(result.accounts[0].syncError.code, 'COLDY_INFRA_ACCOUNT_CHANGED');
  assert.equal(result.syncPaused, false, 'One account discrepancy does not block later accounts');
});

test('provider authentication and owner-consent failures stay explicit without leaking provider bodies', () => {
  let failAuth = false;
  const f = fixture({ transport: ({ path, response, defaultResponse }) => failAuth && path === '/accounts' ? response({ error: KEY }, 401) : defaultResponse() });
  f.configure(); const first = f.refresh(); assert.equal(first.connected, true);
  f.tick(1); failAuth = true; const lastRequests = f.calls.http.length;
  const failed = f.refresh();
  assert.equal(failed.connected, false);
  assert.equal(failed.syncPaused, true);
  assert.equal(failed.error.code, 'COLDY_AUTH');
  assert.equal(failed.lastSyncAt, first.lastSyncAt);
  assert.equal(f.calls.http.length, lastRequests + 1);
  assert.ok(!JSON.stringify(failed).includes(KEY));
  const owner = fixture({ transport: () => { throw new Error('Authorization is required ' + KEY); } });
  owner.configure(); const consent = owner.refresh();
  assert.equal(consent.state, 'error'); assert.equal(consent.error.code, 'COLDY_OWNER_AUTH_REQUIRED');
  assert.equal(consent.syncPaused, true); assert.equal(consent.totals.accounts, null);
  assert.ok(!JSON.stringify(consent).includes(KEY));
});

test('an initial failure pauses old pending details instead of inviting an automatic continuation loop', () => {
  let failing = false;
  const f = fixture({ detailBatch: 5, accounts: Array.from({ length: 7 }, (_, index) => account(index + 1)),
    transport: ({ path, defaultResponse }) => { if (failing && path === '/accounts') throw new Error('Network ' + KEY); return defaultResponse(); } });
  f.configure(); const first = f.refresh(); assert.ok(first.nextCursor);
  f.tick(1); failing = true; const failed = f.refresh();
  assert.equal(failed.nextCursor, first.nextCursor);
  assert.equal(failed.syncPaused, true); assert.equal(failed.error.code, 'COLDY_NETWORK');
  assert.equal(failed.detailProgress.completed, 5);
});

test('a malformed cache containing a credential cannot be returned even in an identity field', () => {
  const f = fixture(); f.configure(); f.refresh();
  f.state().accounts[0].email = `${KEY}@example.test`;
  assert.throws(() => f.get(), /COLDY_STORAGE/);
});

test('a missing account stays visible as stale until a complete later inventory removes it', () => {
  let missing = false;
  const f = fixture({ transport: ({ path, response, defaultResponse }) => missing && path === '/accounts/1' ? response({}, 404) : defaultResponse() });
  f.configure(); f.refresh(); missing = true;
  const partial = f.refresh();
  assert.equal(partial.accounts[0].status, 'Connected'); assert.equal(partial.accounts[0].stale, true);
  assert.equal(partial.accounts[0].syncError.code, 'COLDY_NOT_FOUND');
  f.setAccounts([]); const removed = f.refresh(); assert.equal(removed.accounts.length, 0); assert.equal(removed.state, 'partial');
  assert.deepEqual(removed.monitoring.accountIds, ['1']); assert.deepEqual(removed.monitoring.missingAccountIds, ['1']);
  assert.equal(removed.totals.accounts, 1); assert.equal(removed.totals.sentTotal, null); assert.ok(removed.warnings.length);
});

test('malformed or incomplete inventory cannot replace the last complete sender list', () => {
  for (const malformed of [null, {}, { items: null }, { items: [account(1), account(1)] },
    { items: [account(0)] }, { items: [account(-1)] }, { items: [account('01')] }, { items: [account(Number.MAX_SAFE_INTEGER + 1)] },
    { items: [account(2, { email: 'invalid' })] }, { items: [], next_cursor: 'next' }, { items: [], total: 1 },
    { items: Array.from({ length: 5001 }, (_, index) => account(index + 1)) }]) {
    let bad = false;
    const f = fixture({ transport: ({ path, response, defaultResponse }) => path === '/accounts' && bad ? response(malformed) : defaultResponse() });
    f.configure(); const original = f.refresh(); bad = true;
    const result = f.refresh();
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0].id, original.accounts[0].id);
    assert.equal(result.lastSyncAt, original.lastSyncAt);
    assert.equal(result.stale, true);
  }
});

test('credential rotation and clearing cannot expose another organization cache or cursor', () => {
  const f = fixture({ detailBatch: 5, accounts: Array.from({ length: 6 }, (_, index) => account(index + 1)) });
  f.configure(); const old = f.refresh();
  f.configure('second_organization_fixture_secret');
  const fresh = f.get(); assert.equal(fresh.state, 'no_selection'); assert.deepEqual(fresh.accounts, []);
  assert.equal(fresh.monitoring.configured, false);
  assert.throws(() => f.refresh({ cursor: old.nextCursor }), /COLDY_INFRA_CURSOR_STALE/);
  f.c.configureColdy_({ clearKey: true }); assert.equal(f.get().state, 'not_configured');
  assert.deepEqual(f.get().accounts, []);
});

test('a key change during provider reads rejects the response without persisting it', () => {
  let rotate = true;
  const f = fixture({ transport: ({ path, defaultResponse, f }) => {
    const result = defaultResponse();
    if (path === '/accounts/1' && rotate) { rotate = false; f.configure('other_organization_fixture_secret'); }
    return result;
  } });
  f.configure(); assert.throws(() => f.refresh(), /COLDY_CREDENTIAL_CHANGED/);
  assert.equal(f.calls.saves.length, 0); assert.deepEqual(f.get().accounts, []);
});

test('revocation, root change and root trash after reads stop cache writes and returned data', () => {
  for (const change of ['revoke', 'switchRoot', 'trash']) {
    const f = fixture({ transport: ({ path, defaultResponse, f }) => {
      const result = defaultResponse();
      if (path === '/accounts/1') { if (change === 'trash') f.root.trashed = true; else f[change](); }
      return result;
    } });
    f.configure(); assert.throws(() => f.refresh(), change === 'revoke' ? /LINK_ACCESS_REQUIRED/ : change === 'switchRoot' ? /SOURCE_CHANGED/ : /OUTSIDE_REGISTRY/);
    assert.equal(f.calls.saves.length, 0);
  }
});

test('pure cache reads also reject revoked access and moved state instead of falling back to data', () => {
  const options = {}, f = fixture(options); f.configure(); f.refresh();
  options.movedStore = true; assert.throws(() => f.get(), /OUTSIDE_REGISTRY/);
  options.movedStore = false; options.afterLoad = current => current.revoke();
  assert.throws(() => f.get(), /LINK_ACCESS_REQUIRED/);
});

test('older initial inventory responses cannot overwrite a newer completed synchronization', () => {
  let nested = false;
  const f = fixture({ monitoringIds: ['1', '2', '3'], accounts: [account(1)], transport: ({ path, defaultResponse, f }) => {
    const old = defaultResponse();
    if (path === '/accounts' && !nested) {
      nested = true; f.tick(1); f.setAccounts([account(2), account(3)]); f.refresh();
    }
    return old;
  } });
  f.configure(); const result = f.refresh();
  assert.deepEqual(result.accounts.map(item => item.id), ['2', '3']);
  assert.deepEqual(f.get().accounts.map(item => item.id), ['2', '3']);
  assert.equal(f.calls.saves.length, 1);
});

test('concurrent identical continuations use their receipt instead of overwriting newer progress', () => {
  let nested = false, cursor;
  const f = fixture({ detailBatch: 5, accounts: Array.from({ length: 7 }, (_, index) => account(index + 1)), transport: ({ path, defaultResponse, f }) => {
    const response = defaultResponse();
    if (path === '/accounts/6' && !nested && cursor) { nested = true; f.refresh({ cursor }); }
    return response;
  } });
  f.configure(); cursor = f.refresh().nextCursor;
  const result = f.refresh({ cursor });
  assert.equal(result.state, 'ready'); assert.equal(result.detailProgress.completed, 7);
  assert.equal(f.calls.saves.length, 2, 'Only initial and winning continuation persist');
});

test('new inventories invalidate obsolete continuation tokens rather than mixing sender snapshots', () => {
  const f = fixture({ detailBatch: 5, accounts: Array.from({ length: 6 }, (_, index) => account(index + 1)) }); f.configure();
  const first = f.refresh(); f.tick(1); f.setAccounts([account(9)]); f.refresh();
  const requests = f.calls.http.length;
  assert.throws(() => f.refresh({ cursor: first.nextCursor }), /COLDY_INFRA_CURSOR_STALE/);
  assert.equal(f.calls.http.length, requests);
});

test('unknown and overflowed sums remain unavailable, while zero is retained as a known value', () => {
  const f = fixture({ accounts: [account(1, { total_sent: Number.MAX_SAFE_INTEGER, sent_today: 0 }), account(2, { total_sent: 1, sent_today: 0 })] });
  f.configure(); const result = f.refresh();
  assert.equal(result.totals.sentTotal, null); assert.equal(result.totals.sentToday, 0);
  assert.equal(result.accounts[0].sentToday, 0);
});

test('infrastructure parameters are strict and cannot carry arbitrary routes, account IDs or cursors', () => {
  const f = fixture(); f.configure();
  for (const input of [null, [], { id: 1 }, { url: 'https://outside.example' }, { cursor: '' }, { cursor: 1 }, { cursor: '../other' }]) assert.throws(() => f.c.refreshProjectInfrastructure_(input), /INVALID_REQUEST/);
  for (const input of [null, [], { refresh: true }, { cursor: 'A'.repeat(43) }]) assert.throws(() => f.c.getProjectInfrastructure_(input), /INVALID_REQUEST/);
  assert.deepEqual(f.calls.http, []); assert.deepEqual(f.calls.saves, []);
});
