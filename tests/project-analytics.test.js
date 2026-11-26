import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TEST_ACCESS_KEY, TEST_ACCESS_HASH, runShared } from './helpers/shared-link.js';

const ROOT = 'registry_root_1234567890', SOURCE = 'outreach_source_1234567890', A = 'analytics_segment_a_12345', B = 'analytics_segment_b_12345', ARCHIVED = 'archived_segment_123456';
const CAMPAIGN_A = '550e8400-e29b-41d4-a716-446655440000', CAMPAIGN_B = '550e8400-e29b-41d4-a716-446655440001', CAMPAIGN_C = '550e8400-e29b-41d4-a716-446655440002', CAMPAIGN_D = '550e8400-e29b-41d4-a716-446655440003';
const plain = value => JSON.parse(JSON.stringify(value));
const iterator = items => { let cursor = 0; return { hasNext: () => cursor < items.length, next: () => items[cursor++] }; };
const binding = (campaignId, segmentId = A, extra = {}) => ({ id: 'binding_' + campaignId.replaceAll('-', ''), segmentId, campaignId, campaignName: 'Сохранённая рассылка', campaignStatus: 'Paused', includeCompanies: false, includeLpr: true, autoUpload: true, allowActive: true, revision: 9, updatedAt: '2026-11-20T08:00:00.000Z', ...extra });

function fixture(options = {}) {
  let locked = false;
  const calls = { folders: [], list: [], metadata: 0, books: 0, provider: 0, saves: 0, journals: 0, traversalsWhileLocked: 0 }, props = new Map(Object.entries({ ROOT_FOLDER_ID: ROOT, SEGMENTS_FOLDER_ID: SOURCE, SHARED_ACCESS_KEY_SHA256: TEST_ACCESS_HASH, ...options.properties }));
  const state = { credentialHash: 'credential-A', configured: true, connected: true, ...options.state };
  const rows = [{ id: ROOT, name: 'Реестр баз', parents: [] }, { id: SOURCE, name: 'Аутричи', parents: [ROOT] }, { id: A, name: 'Кухни', parents: [SOURCE] }, { id: B, name: 'Веб-студии', parents: [SOURCE] }, ...(options.folders || [])];
  const folders = new Map();
  for (const row of rows) folders.set(row.id, {
    getId: () => row.id, getName: () => row.name, isTrashed: () => row.trashed === true,
    getParents: () => iterator(row.parents.map(id => folders.get(id)).filter(Boolean)),
    getFolders: () => { calls.metadata++; if (locked) calls.traversalsWhileLocked++; return iterator(rows.filter(child => child.parents.includes(row.id)).map(child => folders.get(child.id))); },
    getFilesByType: () => { throw new Error('Analytics must not enumerate spreadsheets'); },
  });
  const propertyStore = { getProperty: key => props.get(key) ?? null, getProperties: () => Object.fromEntries(props) };
  const context = vm.createContext({ console,
    PropertiesService: { getScriptProperties: () => propertyStore },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: (_algorithm, value) => [...crypto.createHash('sha256').update(value).digest()], base64EncodeWebSafe: value => Buffer.from(value).toString('base64url') },
    DriveApp: { getFolderById: id => { calls.folders.push(id); if (!folders.has(id)) throw new Error('missing'); return folders.get(id); }, getFileById: () => { throw new Error('No file reads allowed'); } },
    SpreadsheetApp: { openById: () => { calls.books++; throw new Error('No spreadsheet reads allowed'); } },
  });
  for (const filename of ['Config.gs', 'Code.gs', 'Segments.gs', 'SegmentActions.gs', 'ColdyCampaigns.gs', 'ProjectAnalytics.gs', 'Access.gs']) vm.runInContext(readFileSync(new URL('../src/' + filename, import.meta.url), 'utf8'), context, { filename });
  context.locked_ = callback => { assert.equal(locked, false, 'No nested script lock'); locked = true; try { return callback(); } finally { locked = false; } };
  context.coldySettings_ = scope => { const current = context.authorize_(); if (scope.rootId !== current.rootId) context.fail_('SOURCE_CHANGED', 'Root changed'); return { configured: state.configured, connected: state.connected, checkedAt: '2026-11-20T09:00:00.000Z', credentialHash: state.credentialHash, key: 'secret-that-must-never-be-returned' }; };
  context.coldyCredentialHash_ = scope => { const settings = context.coldySettings_(scope); if (!settings.configured) context.fail_('COLDY_KEY_REQUIRED', 'Missing key'); return settings.credentialHash; };
  const registries = new Map([[ROOT + '|credential-A', { version: 1, credentialHash: 'credential-A', bindings: options.bindings || [], receipts: [] }]]);
  context.coldyLoad_ = (scope, kind, owner) => { calls.journals++; options.onRegistry?.({ rows, props, state }); assert.equal(kind, 'campaignbindings'); return plain(registries.get(scope.rootId + '|' + owner) || null); };
  context.coldySave_ = () => { calls.saves++; throw new Error('Analytics must not mutate bindings'); };
  context.coldyApi_ = () => { calls.provider++; throw new Error('Use existing listing API only'); };
  const readCatalog = refresh => {
    assert.equal(locked, false, 'Campaign catalog reads must run outside global lock'); calls.list.push({ refresh });
    options.onList?.({ state, props, rows, context });
    return { state: 'ready', campaigns: options.campaigns || [{ id: CAMPAIGN_A, name: 'Рассылка Кухни email', status: 'Paused' }, { id: CAMPAIGN_B, name: 'Рассылка Кухни тест', status: 'Active' }, { id: CAMPAIGN_C, name: 'Общая рассылка', status: 'Draft' }], generatedAt: '2026-11-20T09:01:00.000Z', cached: !refresh };
  };
  context.coldyReadCampaignCatalog_ = (_scope,refresh) => { assert.equal(refresh,true,'Provider catalog requires explicit refresh'); return readCatalog(true); };
  context.coldyCachedCampaigns_ = () => readCatalog(false);
  if (options.onNames) {
    const original = context.getSegmentNames_;
    context.getSegmentNames_ = scope => { const result = original(scope); options.onNames({ props, rows, state, context }); return result; };
  }
  return { context, state, props, rows, registries, calls,
    overview: (request = {}) => plain(runShared(context, () => context.getProjectAnalytics_(request))),
    campaigns: (request = { segmentId: A, query: 'Рассылка' }) => plain(runShared(context, () => context.getProjectAnalyticsCampaigns_(request))) };
}

test('project overview lists immediate segments and categories without spreadsheets or provider requests', () => {
  const f = fixture({ folders: [{ id: 'nested_segment_1234567890', name: 'Вложенная папка', parents: [A] }, { id: 'trashed_segment_123456789', name: 'Удалённая', parents: [SOURCE], trashed: true }] });
  const result = f.overview(); assert.equal(result.state, 'ready'); assert.equal(result.source.id, SOURCE);
  assert.deepEqual(result.segments.map(segment => [segment.id, segment.category]), [[B, 'partners'], [A, 'clients']]);
  assert.deepEqual(result.coldy, { configured: true, connected: true, checkedAt: '2026-11-20T09:00:00.000Z' });
  assert.equal(f.calls.books, 0); assert.equal(f.calls.list.length, 0); assert.equal(f.calls.provider, 0); assert.equal(f.calls.saves, 0);
  assert.ok(!JSON.stringify(result).includes(ROOT)); assert.ok(!JSON.stringify(result).includes('credential-A')); assert.ok(!JSON.stringify(result).includes('secret-that'));
});

test('configured category overrides folder-name default', () => {
  const f = fixture({ properties: { ['SEGMENT_CATEGORY_' + A]: JSON.stringify({ category: 'partners' }) } });
  assert.equal(f.overview().segments.find(segment => segment.id === A).category, 'partners');
});

test('the scoped overview lists Drive metadata once, excludes other projects and falls back for an incomplete page', () => {
  const f = fixture();
  let lists = 0, partial = false;
  f.context.registryProjectScoped_ = () => true;
  f.context.registryProjectId_ = () => 'numshield';
  f.context.registrySegmentProject_ = (_,id) => id === A ? 'numshield' : 'neosender';
  const folder = row => ({ ...row,trashed:false,mimeType:'application/vnd.google-apps.folder' });
  f.context.Drive = {Files:{
    list:() => { lists++;return {files:f.rows.filter(row=>row.parents.includes(SOURCE)).map(folder),nextPageToken:partial?'next':null}; },
  }};
  const fast = f.overview();
  assert.deepEqual(fast.segments.map(s=>s.id),[A]);assert.equal(fast.source.name,'Аутричи');
  assert.equal(lists,1);assert.equal(f.calls.metadata,0);
  partial=true;
  assert.deepEqual(f.overview().segments,fast.segments);
  assert.ok(f.calls.metadata>0);
});

test('all new handlers reject missing, wrong and revoked shared access before any file/provider reads', () => {
  const f = fixture(); assert.throws(() => f.context.getProjectAnalytics_(), /LINK_ACCESS_REQUIRED/);
  assert.throws(() => f.context.getProjectAnalyticsCampaigns_({ segmentId: A }), /LINK_ACCESS_REQUIRED/);
  f.props.set('SHARED_ACCESS_KEY_SHA256', crypto.createHash('sha256').update('different-key').digest('base64url'));
  assert.throws(() => f.overview(), /LINK_ACCESS_REQUIRED/); assert.equal(f.calls.folders.length, 0); assert.equal(f.calls.list.length, 0);
});

test('missing or outside Outreach source returns no invented segments', () => {
  const f = fixture({ properties: { SEGMENTS_FOLDER_ID: 'outside_folder_123456789' } }), result = f.overview();
  assert.equal(result.state, 'source_outside_registry'); assert.deepEqual(result.segments, []); assert.equal(result.source, null);
  assert.throws(() => f.campaigns(), /OUTSIDE_SEGMENTS/); assert.equal(f.calls.list.length, 0);
});

test('root or source rebinding during direct-folder metadata reads prevents stale metadata escape', () => {
  for (const change of ['root', 'source']) {
    const f = fixture({ onNames: ({ props }) => props.set(change === 'root' ? 'ROOT_FOLDER_ID' : 'SEGMENTS_FOLDER_ID', change === 'root' ? 'another_root_1234567890' : A) });
    assert.throws(() => f.overview(), /SOURCE_CHANGED/);
  }
});

test('chooser shows current/foreign ownership and leaves existing upload/active settings unchanged', () => {
  const original = binding(CAMPAIGN_A), foreign = binding(CAMPAIGN_B, B);
  const f = fixture({ bindings: [original, foreign] }), result = f.campaigns();
  const own = result.campaigns.find(campaign => campaign.id === CAMPAIGN_A), other = result.campaigns.find(campaign => campaign.id === CAMPAIGN_B), free = result.campaigns.find(campaign => campaign.id === CAMPAIGN_C);
  assert.equal(own.selected, true); assert.equal(own.selectable, true); assert.equal(own.bindingId, original.id);
  assert.equal(other.selected, false); assert.equal(other.selectable, false); assert.equal(other.ownerSegmentId, B); assert.equal(other.ownerSegmentName, 'Веб-студии'); assert.equal(other.bindingId, null);
  assert.equal(free.selected, false); assert.equal(free.selectable, true); assert.equal(free.ownerSegmentId, null);
  assert.deepEqual(result.bindings, [original]); assert.equal(f.calls.saves, 0); assert.deepEqual(f.calls.list, [{ refresh: false }]);
  assert.equal(result.cached, true); assert.equal(result.generatedAt, '2026-11-20T09:01:00.000Z'); assert.equal(f.calls.provider, 0);
});

test('manual campaign refresh delegates the exact existing safe listing path outside script lock', () => {
  const f = fixture(), result = f.campaigns({ segmentId: A, refresh: true, query: 'Кухни' });
  assert.deepEqual(f.calls.list, [{ refresh: true }]); assert.equal(result.cached, false); assert.equal(f.calls.provider, 0); assert.equal(f.calls.saves, 0);
});

test('ordinary project monitoring and manual metric refresh never read the workspace catalog', () => {
  const f = fixture({bindings:[binding(CAMPAIGN_A),binding(CAMPAIGN_B,B)]});
  for (const refresh of [false,true]) {
    const result=f.campaigns({segmentId:A,refresh});
    assert.deepEqual(result.campaigns.map(row=>row.id),[CAMPAIGN_A]);
    assert.equal(result.campaigns[0].bindingId,binding(CAMPAIGN_A).id);
  }
  assert.equal(f.calls.list.length,0); assert.equal(f.calls.provider,0); assert.equal(f.calls.metadata,0);
  for(const query of ['', ' ', 'а', 'https://example.test/'+CAMPAIGN_A])assert.throws(()=>f.campaigns({segmentId:A,query}),/INVALID_REQUEST/);
  assert.equal(f.calls.list.length,0);
});

test('explicit lookup by Coldy link or UUID reads precisely one campaign', () => {
  const f=fixture(),ids=[];
  f.context.coldyCampaignRead_=(_scope,id)=>{ids.push(id);return {id,name:'Одна рассылка',status:'Draft'};};
  for(const query of [CAMPAIGN_B,'https://app.coldy.ai/campaigns/'+CAMPAIGN_B+'/settings']) {
    const result=f.campaigns({segmentId:A,query});
    assert.deepEqual(result.campaigns.map(row=>row.id),[CAMPAIGN_B]);
  }
  assert.deepEqual(ids,[CAMPAIGN_B,CAMPAIGN_B]);assert.equal(f.calls.list.length,0);
});

test('a large catalog takes a single Drive enumeration outside the lock and reads bindings once', () => {
  const campaigns = Array.from({length: 1200}, (_, n) => ({
    id: '550e8400-e29b-41d4-a716-' + String(n).padStart(12, '0'), name: 'Кампания ' + n, status: 'Active'
  }));
  const f = fixture({ campaigns, bindings: campaigns.map(campaign => binding(campaign.id, B)) });
  const result = f.campaigns({ segmentId:A, query:'Кампания' }); assert.equal(result.campaigns.length, 40); assert.equal(result.truncated, true);
  assert.equal(f.calls.list.length, 1);
  assert.equal(f.calls.journals, 1);
  assert.equal(f.calls.metadata, 1);
  assert.equal(f.calls.traversalsWhileLocked, 0);
  assert.equal(f.calls.folders.filter(id => id === B).length, 0);
  assert.equal(f.calls.books, 0);
});

test('the detailed chooser exposes unassigned campaigns and only bindings belonging to the selected project', () => {
  const f=fixture({bindings:[binding(CAMPAIGN_A),binding(CAMPAIGN_B,B)]});
  let project='numshield';
  f.context.registryProjectScoped_=()=>true;
  f.context.registryProjectId_=()=>project;
  f.context.registrySegmentProject_=(_,id)=>id===A?'numshield':'neosender';
  for(const refresh of [false,true]) {
    const result=f.campaigns({segmentId:A,refresh,query:'Рассылка'});
    assert.deepEqual(result.campaigns.map(item=>item.id).sort(),[CAMPAIGN_A,CAMPAIGN_C].sort());
    assert.deepEqual(result.bindings.map(item=>item.campaignId),[CAMPAIGN_A]);
    assert.throws(()=>f.campaigns({segmentId:B,refresh}),/OUTSIDE_SEGMENTS/);
  }
  project='neosender';
  assert.deepEqual(f.campaigns({segmentId:B,query:'Рассылка'}).campaigns.map(item=>item.id).sort(),[CAMPAIGN_B,CAMPAIGN_C].sort());
});

test('an archived/outside owner stays blocked without revealing inaccessible folder metadata', () => {
  const f = fixture({ bindings: [binding(CAMPAIGN_A, ARCHIVED)] }), choice = f.campaigns().campaigns.find(campaign => campaign.id === CAMPAIGN_A);
  assert.equal(choice.selected, false); assert.equal(choice.selectable, false); assert.equal(choice.ownerSegmentId, null); assert.equal(choice.ownerSegmentName, null); assert.equal(choice.bindingId, null);
  assert.match(choice.blockedReason, /недоступному/); assert.ok(!JSON.stringify(choice).includes(ARCHIVED));
});

test('saved campaigns absent from provider list remain selected for explicit removal', () => {
  const missing = binding(CAMPAIGN_D), f = fixture({ bindings: [missing] }), result = f.campaigns({segmentId:A,query:'рассылка',refresh:true}), choice = result.campaigns.find(campaign => campaign.id === CAMPAIGN_D);
  assert.equal(choice.available, false); assert.equal(choice.selected, true); assert.equal(choice.selectable, false); assert.equal(choice.missing, true); assert.equal(choice.removable, true); assert.equal(choice.bindingId, missing.id); assert.match(choice.blockedReason, /отсутствует/); assert.deepEqual(result.bindings, [missing]);
});

test('unconfigured Coldy returns an honest connection state and does not fetch campaigns', () => {
  const f = fixture({ state: { configured: false, connected: false } }), result = f.campaigns();
  assert.equal(result.state, 'not_configured'); assert.equal(result.configured, false); assert.deepEqual(result.bindings, []); assert.deepEqual(result.campaigns, []); assert.equal(f.calls.list.length, 0); assert.equal(f.calls.saves, 0);
});

test('switching organization uses only credential-bound bindings', () => {
  const f = fixture({ bindings: [binding(CAMPAIGN_A)] }); f.state.credentialHash = 'credential-B';
  const result = f.campaigns(); assert.deepEqual(result.bindings, []); assert.equal(result.campaigns.find(campaign => campaign.id === CAMPAIGN_A).selected, false);
});

test('credential rotation or root change during provider listing rejects the stale combined response', () => {
  for (const change of ['credential', 'root']) {
    const f = fixture({ onList: ({ props, state }) => { if (change === 'credential') state.credentialHash = 'credential-B'; else props.set('ROOT_FOLDER_ID', 'another_root_1234567890'); } });
    assert.throws(() => f.campaigns(), change === 'credential' ? /COLDY_CREDENTIAL_CHANGED/ : /SOURCE_CHANGED/); assert.equal(f.calls.saves, 0);
  }
});

test('a moved selected segment or revoked link during listing cannot expose chooser data', () => {
  for (const change of ['move', 'revoke']) {
    const f = fixture({ onList: ({ rows, props }) => { if (change === 'move') rows.find(row => row.id === A).parents = [ROOT]; else props.set('SHARED_ACCESS_KEY_SHA256', crypto.createHash('sha256').update('revoked-key').digest('base64url')); } });
    assert.throws(() => f.campaigns(), change === 'move' ? /OUTSIDE_SEGMENTS/ : /LINK_ACCESS_REQUIRED/); assert.equal(f.calls.saves, 0);
  }
});

test('duplicate campaign assignments fail closed rather than presenting a campaign as free', () => {
  const f = fixture({ bindings: [binding(CAMPAIGN_A, A), binding(CAMPAIGN_A, B)] }); assert.throws(() => f.campaigns(), /COLDY_STORAGE/); assert.equal(f.calls.saves, 0);
});

test('unknown project parameters and arbitrary selected folder IDs are rejected', () => {
  const f = fixture(); assert.throws(() => f.overview({ segmentId: A }), /INVALID_REQUEST/); assert.throws(() => f.campaigns({ segmentId: A, refresh: 'yes' }), /INVALID_REQUEST/); assert.throws(() => f.campaigns({ segmentId: ROOT }), /OUTSIDE_SEGMENTS/); assert.equal(f.calls.list.length, 0);
});

test('foreign owner moved after catalog discovery stays blocked and its folder metadata is withheld', () => {
  const f = fixture({ bindings: [binding(CAMPAIGN_B, B)], onRegistry: ({ rows }) => { rows.find(row => row.id === B).parents = [ROOT]; } });
  const choice = f.campaigns().campaigns.find(campaign => campaign.id === CAMPAIGN_B);
  assert.equal(choice.selectable, false); assert.equal(choice.ownerSegmentName, null); assert.equal(choice.ownerSegmentId, null); assert.match(choice.blockedReason, /недоступному/);
});

test('chooser DTO discards provider extras and never exposes key fingerprints or registry root', () => {
  const f = fixture({ bindings: [binding(CAMPAIGN_A)], campaigns: [{ id: CAMPAIGN_A, name: 'Email', status: 'Paused', secret: 'private-extra', credentialHash: 'private-hash', rootId: ROOT }] });
  const result = f.campaigns(), encoded = JSON.stringify(result);
  for (const privateValue of ['private-extra', 'private-hash', 'credential-A', ROOT, 'secret-that-must-never-be-returned']) assert.ok(!encoded.includes(privateValue));
  assert.equal(result.campaigns[0].selected, true); assert.equal(f.calls.saves, 0);
});
