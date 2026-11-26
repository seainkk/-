import { TEST_ACCESS_KEY, TEST_ACCESS_HASH, SHARED_ACTOR, installSharedApi, runShared } from './helpers/shared-link.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourceDir = fileURLToPath(new URL('../src/', import.meta.url));
const ROOT = 'registry_root_1234567890';
const SOURCE = 'outreach_source_1234567890';
const SEGMENT = 'segment_folder_1234567890';
const SERVICE = 'metadata_service_1234567890';
const MEMBER = 'member@example.com';
const MIME = 'application/vnd.google-apps.spreadsheet';
const plain = value => JSON.parse(JSON.stringify(value));
const iterator = values => { let index = 0; return { hasNext: () => index < values.length, next: () => values[index++] }; };

function fixture(options = {}) {
  const calls = { folders: [], parents: [], files: [], opened: [], ranges: [], tracking: [], trackingSnapshots: 0, metadataScans: [], rootFileScans: 0 };
  const propertyValues = new Map(Object.entries({ ROOT_FOLDER_ID: ROOT, SHARED_ACCESS_KEY_SHA256: TEST_ACCESS_HASH, SEGMENTS_FOLDER_ID: SOURCE, SOURCE_BASES_STORAGE_ID: SERVICE, ALLOWED_EMAILS: MEMBER, ADMIN_EMAILS: MEMBER, ...options.properties }));
  const propertyStore = { getProperty: key => propertyValues.get(key) ?? null, getProperties: () => Object.fromEntries(propertyValues) };
  const folderRows = [
    { id: ROOT, name: 'Реестр баз', parents: [] },
    { id: SOURCE, name: 'Аутричи', parents: [ROOT] },
    { id: SEGMENT, name: 'Сегмент', parents: [SOURCE] },
    ...(options.folders || []),
  ];
  const files = options.files || [];
  const folderMap = new Map();
  const fileMap = new Map();
  for (const row of folderRows) folderMap.set(row.id, {
    getId: () => row.id, getName: () => row.name, isTrashed: () => !!row.trashed,
    getParents: () => { calls.parents.push(row.id); return iterator((row.actualParents || row.parents).map(id => folderMap.get(id)).filter(Boolean)); },
    getFolders: () => iterator(folderRows.filter(child => child.parents.includes(row.id)).map(child => folderMap.get(child.id))),
    getFilesByType: () => {
      calls.metadataScans.push(row.id);
      if (row.id === ROOT) { calls.rootFileScans++; throw new Error('Must not enumerate unrelated root/source bases'); }
      if (options.failMetadataScan) throw new Error('Metadata scan unavailable');
      return iterator(files.filter(file => file.parents.includes(row.id) && (file.mime || MIME) === MIME).map(file => fileMap.get(file.id)));
    },
  });
  for (const row of files) fileMap.set(row.id, {
    getId: () => row.id, getName: () => row.name || row.id, getMimeType: () => row.mime || MIME, isTrashed: () => !!row.trashed,
    getParents: () => iterator((row.actualParents || row.parents).map(id => folderMap.get(id)).filter(Boolean)),
  });
  const context = vm.createContext({
    console,
    PropertiesService: { getScriptProperties: () => propertyStore },
    Session: {
      getActiveUser: () => ({ getEmail: () => options.activeEmail ?? MEMBER }),
      getEffectiveUser: () => ({ getEmail: () => options.effectiveEmail ?? options.activeEmail ?? MEMBER }),
    },
    DriveApp: {
      getFolderById: id => { calls.folders.push(id); if (!folderMap.has(id)) throw new Error('Folder missing'); return folderMap.get(id); },
      getFileById: id => { calls.files.push(id); if (!fileMap.has(id)) throw new Error('File missing'); return fileMap.get(id); },
    },
    SpreadsheetApp: {
      openById: id => {
        calls.opened.push(id);
        const file = files.find(file => file.id === id);
        if (!file || file.unreadable) throw new Error('Cannot open');
        return { getSheets: () => (file.sheets || []).map((sheet, index) => ({
          getSheetId: () => sheet.id ?? index,
          getName: () => sheet.name ?? 'Лист ' + (index + 1),
          getLastRow: () => sheet.lastRow ?? sheet.rows?.length ?? 0,
          getLastColumn: () => sheet.lastColumn ?? Math.max(0, ...(sheet.rows || []).map(row => row.length)),
          getRange: (row, column, rowCount, columnCount) => {
            calls.ranges.push({ fileId: id, sheetId: sheet.id ?? index, row, column, rowCount, columnCount });
            if (sheet.unreadable) throw new Error('Cannot read');
            return { getDisplayValues: () => Array.from({ length: rowCount }, (_, r) => Array.from({ length: columnCount }, (_, c) => sheet.rows?.[row - 1 + r]?.[column - 1 + c] ?? '')) };
          },
        })) };
      },
    },
  });
  const sources = ['Config.gs', 'Code.gs', 'Segments.gs', 'SegmentActions.gs', 'SegmentAnalytics.gs'].map(name => readFileSync(`${sourceDir}${name}`, 'utf8')).join('\n');
  vm.runInContext(sources, context, { filename: 'segment-analytics.gs' });
  installSharedApi(context, { accessKey: () => Object.hasOwn(options, 'accessKey') ? options.accessKey : TEST_ACCESS_KEY });
  context.segmentReadTrackingSnapshot_ = () => {
    calls.trackingSnapshots++;
    if (options.trackingThrows) throw new Error('Tracking unavailable');
    return options.tracking || { available: true, tables: [], loads: [] };
  };
  context.segmentReadTracking_ = (_context, segmentId, snapshot) => {
    calls.tracking.push(segmentId);
    return snapshot || context.segmentReadTrackingSnapshot_();
  };
  if (options.limits) context.REGISTRY_CONFIG = Object.freeze({ ...context.REGISTRY_CONFIG, ...options.limits });
  return { context, calls, folderRows, propertyValues, dashboard: request => plain(context.getSegmentsDashboard(request)), mailings: id => plain(context.getSegmentMailings({ segmentId: id ?? SEGMENT })) };
}

function cachedMailingsFixture(change) {
  const f = fixture(), c = f.context;
  for (const name of ['Coldy.gs','ColdyCampaigns.gs']) vm.runInContext(readFileSync(sourceDir+name,'utf8'),c);
  const privateFolder = 'coldy_private_123456', registryId = 'binding_journal_123456';
  const root = {id:ROOT,mimeType:'application/vnd.google-apps.folder',parents:[]};
  const folder = {id:privateFolder,mimeType:root.mimeType,parents:[ROOT],appProperties:{registryPrivateRole:'coldy_folder',registryColdyRoot:ROOT}};
  const metadata = new Map([[ROOT,root],[privateFolder,folder]]), files = new Map(), reads = [], gets = [];
  const hash = c.digest_('fake'), bindings = [1,2].map(n => ({id:'binding-'+n,revision:1,segmentId:SEGMENT,
    campaignId:'550e8400-e29b-41d4-a716-44665544000'+n,campaignName:'Test '+n}));
  f.propertyValues.set(c.COLDY.keyProperty,'fake'); f.propertyValues.set(c.COLDY.folderProperty,privateFolder);
  function file(kind,owner,id,data) {
    const index = 'COLDY_JSON_'+c.digest_(JSON.stringify([ROOT,kind,owner]));
    f.propertyValues.set(index,id);
    metadata.set(id,{id,version:'1',mimeType:'application/json',parents:[privateFolder],appProperties:{registryPrivateRole:'coldy_state',
      registryColdyRoot:ROOT,registryColdyKind:kind,registryColdyOwnerHash:c.digest_(owner)}});
    files.set(id,{version:1,rootId:ROOT,kind,owner,data});
  }
  file('campaignbindings',hash,registryId,{credentialHash:hash,bindings,receipts:[]});
  bindings.forEach((binding,index) => file('campaignanalytics',c.digest_(hash+'|'+binding.campaignId),'campaign_counts_000'+index,
    {campaignId:binding.campaignId,credentialHash:hash,sent:10,replies:2,leads:1,updatedAt:new Date().toISOString()}));
  c.Drive = {Files:{get:id=>{gets.push(id);return metadata.get(id);}}};
  c.DriveApp.getFileById = id => ({getBlob:()=>({getDataAsString:()=>{
    const text = JSON.stringify(files.get(id)); reads.push(id);
    if (id === 'campaign_counts_0001' && change) change({f,metadata,files,registryId,privateFolder}); return text;
  }})});
  return {f,reads,gets,registryId};
}

test('the first two saved campaigns need two fresh folder checks, four parent reads and a single bindings blob',() => {
  const {f,reads,gets,registryId} = cachedMailingsFixture();
  const value = f.mailings();
  assert.deepEqual(value.totals,{sent:20,replies:4,leads:2});
  assert.deepEqual(f.calls.folders,[ROOT,SOURCE,SEGMENT,ROOT,SOURCE,SEGMENT]);
  assert.deepEqual(f.calls.parents,[SOURCE,SEGMENT,SOURCE,SEGMENT]);
  assert.deepEqual(reads,[registryId,'campaign_counts_0000','campaign_counts_0001']);
  assert.equal(gets.filter(id=>id===registryId).length,2);
});

test('the cached mailings response rejects an unbound campaign, moved folders, or a revoked key before publication',() => {
  for (const [change,expected] of [
    [({files,metadata,registryId})=>{files.get(registryId).data.bindings.pop();metadata.get(registryId).version='2';},/COLDY_BINDING_CHANGED/],
    [({f})=>{f.folderRows.find(row=>row.id===SEGMENT).parents=[ROOT];},/OUTSIDE_SEGMENTS/],
    [({f})=>{f.folderRows.find(row=>row.id===SOURCE).trashed=true;},/SEGMENTS_UNAVAILABLE/],
    [({metadata,privateFolder})=>{metadata.get(privateFolder).parents=['other_root_123456'];},/OUTSIDE_REGISTRY/],
    [({f})=>f.propertyValues.set('COLDY_API_KEY','changed'),/COLDY_CREDENTIAL_CHANGED/],
    [({f})=>f.propertyValues.set('SHARED_ACCESS_KEY_SHA256','rotated'),/LINK_ACCESS_REQUIRED|LINK_SETUP_REQUIRED/]
  ]) {
    const {f}=cachedMailingsFixture(change);
    assert.throws(f.mailings,expected);
  }
});

test('a concurrent change to another segment rechecks the binding journal and preserves the same selected totals',() => {
  const {f,reads,registryId}=cachedMailingsFixture(({files,metadata,registryId})=>{
    files.get(registryId).data.bindings.push({id:'other',segmentId:'other_segment_123456',campaignId:'550e8400-e29b-41d4-a716-446655440009'});
    metadata.get(registryId).version='2';
  });
  assert.deepEqual(f.mailings().totals,{sent:20,replies:4,leads:2});
  assert.equal(reads.filter(id=>id===registryId).length,2);
});

function sourceFile(id = 'business_sheet_1234567890', sheets = [], extra = {}) {
  return { id, name: id, parents: [SEGMENT], sheets, ...extra };
}

function headers(fileId, sheetId, hasHeader, extra = {}) {
  return { available: true, tables: [], loads: [{ targetFileId: fileId, targetSheetId: sheetId, hasHeader, stage: 'complete', ...extra }] };
}

test('only an opted-in light project dashboard attaches verified card previews and hides internal parent evidence', () => {
  const file = sourceFile(), f = fixture({files:[file]});
  let requests = 0;
  f.context.segmentCardDashboardPreviews_ = (context, projection, tracking) => {
    requests++;
    assert.equal(context.rootId, ROOT);
    assert.equal(projection.items[0].files[0].parentId, SEGMENT);
    assert.equal(tracking.available, true);
    return {[SEGMENT]: {segmentId:SEGMENT, preview:true, rows:[]}};
  };
  assert.equal(f.dashboard({includeAnalysis:false}).cardPreviews, undefined);
  assert.equal(f.dashboard({includeAnalysis:true,includeCardPreview:true}).cardPreviews, undefined);
  const light = f.dashboard({includeAnalysis:false,includeCardPreview:true});
  assert.equal(light.cardPreviews[SEGMENT].preview, true);
  assert.equal(light.items[0].files[0].parentId, undefined);
  assert.equal(requests, 1);
  assert.throws(()=>f.dashboard({includeAnalysis:false,includeCardPreview:'true'}), /INVALID_REQUEST/);
});

test('dashboard and mailings authorize before Drive or spreadsheet reads', () => {
  for (const options of [{ accessKey: null }, { accessKey: 'wrong' }, { accessKey: 'a'.repeat(43) }]) {
    const f = fixture(options);
    assert.throws(() => f.context.getSegmentsDashboard());
    assert.throws(() => f.context.getSegmentMailings({ segmentId: SEGMENT }));
    assert.deepEqual(f.calls.folders, []);
    assert.deepEqual(f.calls.opened, []);
  }
});

test('light dashboard exposes usable canonical table links without opening business worksheets', () => {
  const file = sourceFile('overview_companies_1234567890', [{ rows: [['PRIVATE BUSINESS CELL']] }], { unreadable: true });
  const f = fixture({ properties: { ['SEGMENT_CATEGORY_' + SEGMENT]: '{"category":"partners"}' }, files: [file], tracking: { available: true, tables: [
    { segmentId: SEGMENT, fileId: file.id, kind: 'companies' },
    { segmentId: 'other_segment_1234567890', fileId: file.id, kind: 'lpr' },
  ], loads: [] } });
  const result = f.dashboard({ includeAnalysis: false });
  assert.equal(result.state, 'ready');
  assert.equal(result.analysisPending, true);
  assert.equal(result.items[0].category, 'partners');
  assert.equal(result.items[0].files[0].kind, 'companies');
  assert.equal(result.items[0].files[0].id, file.id);
  assert.equal(result.items[0].overallStatus, null);
  assert.equal(result.items[0].contactPresence, 'unknown');
  assert.deepEqual(result.items[0].analysis, { state: 'pending', hasContacts: null, warnings: [] });
  assert.deepEqual(f.calls.opened, []);
  assert.deepEqual(f.calls.ranges, []);
  assert.equal(f.calls.trackingSnapshots, 1);
  assert.ok(!JSON.stringify(result).includes('PRIVATE BUSINESS CELL'));
});

test('light dashboard remains unknown and usable when the tracking journal is unavailable', () => {
  const f = fixture({ files: [sourceFile()], trackingThrows: true });
  const result = f.dashboard({ includeAnalysis: false });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].files.length, 1);
  assert.equal(result.items[0].files[0].kind, undefined);
  assert.equal(result.items[0].overallStatus, null);
  assert.equal(result.items[0].analysis.state, 'pending');
  assert.deepEqual(f.calls.opened, []);
});

test('light dashboard batches folders by level, paginates and never enumerates another project’s children', () => {
  const sibling = 'second_segment_123456', other = 'other_project_segment_123456', nested = 'nested_folder_123456';
  const properties = Object.fromEntries([SEGMENT,sibling,other].map(id=>['REGISTRY_SEGMENT_PROJECT_'+id,
    JSON.stringify({rootId:ROOT,projectId:id===other?'neosender':'numshield'})]));
  const f = fixture({properties});
  vm.runInContext(readFileSync(sourceDir+'RegistryProjects.gs','utf8'),f.context);
  const folder = 'application/vnd.google-apps.folder';
  const item = (id,mimeType,parent) => ({id,name:id,mimeType,parents:[parent],trashed:false});
  const queries = [];
  f.context.Drive = {Files:{list:q=>{
    queries.push(q.q);
    if(q.q.includes("'" + SOURCE + "' in parents")) return q.pageToken
      ? {files:[item(other,folder,SOURCE),item(sibling,folder,SOURCE)]}
      : {files:[item(SEGMENT,folder,SOURCE)],nextPageToken:'page-2'};
    if(q.q.includes("'" + nested + "' in parents"))return {files:[item('nested_book_123456',MIME,nested)]};
    assert.ok(q.q.includes("'" + SEGMENT + "' in parents") && q.q.includes("'" + sibling + "' in parents"));
    assert.ok(!q.q.includes(other));
    return {files:[item(nested,folder,SEGMENT),item(SERVICE,MIME,SEGMENT),item('false_parent_123456',MIME,other)]};
  }}};
  const result = f.context.callApp({method:'getSegmentsDashboard',accessKey:TEST_ACCESS_KEY,projectId:'numshield',payload:{includeAnalysis:false}});
  assert.equal(result.items.length,2);
  assert.deepEqual(plain(result.items.find(i=>i.id===SEGMENT).files.map(i=>i.id)),['nested_book_123456']);
  assert.ok(!JSON.stringify(result).includes(other));
  assert.equal(queries.length,4);
  assert.deepEqual(f.calls.metadataScans,[]);
});

test('a failed or incomplete batched listing restarts atomically and a denied listing releases no catalog', () => {
  for (const outcome of ['timeout','incomplete','repeating','denied']) {
    const f = fixture({files:[sourceFile()]});
    const dummy = {id:'discard_partial_123456',name:'partial',parents:[SOURCE],mimeType:'application/vnd.google-apps.folder',trashed:false};
    let reads = 0;
    f.context.Drive = {Files:{list:()=>{
      if(++reads===1)return {files:[dummy],nextPageToken:'more'};
      if(outcome==='timeout')throw new Error('backendError');
      if(outcome==='denied')throw new Error('403 Forbidden');
      if(outcome==='repeating')return {files:[],nextPageToken:'more'};
      return {files:[],incompleteSearch:true};
    }}};
    if(outcome==='denied') {
      assert.throws(()=>f.dashboard({includeAnalysis:false}),/SOURCE_CHANGED/);
      assert.deepEqual(f.calls.metadataScans,[]);
    } else {
      const result = f.dashboard({includeAnalysis:false});
      assert.equal(result.items[0].id, SEGMENT);
      assert.ok(!JSON.stringify(result).includes(dummy.id));
      assert.equal(f.calls.metadataScans.length,2);
    }
  }
});

test('a light dashboard reads master assignments without historical import rows; a full read still validates both', () => {
  const f = fixture(), schema=f.context.SEGMENT_ACTIONS_SCHEMA, seen=[];
  const storage={public:{id:SERVICE},book:{getSheetByName:name=>({name})}};
  f.context.sourceBasesReadRows_=(sheet)=>{
    seen.push(sheet.name);
    if(sheet.name===schema.loadsTab)throw Error('Historical journal unavailable');
    return {rows:[[SEGMENT,'companies','assigned_book_123456']],lastRow:2};
  };
  const context={properties:f.context.PropertiesService.getScriptProperties()};
  const assignments=f.context.segmentTrackingStorage_(context,storage,false,true);
  assert.equal(assignments.tables[0].fileId,'assigned_book_123456');
  assert.deepEqual(seen,[schema.tablesTab]);
  assert.throws(()=>f.context.segmentTrackingStorage_(context,storage,false),/Historical journal unavailable/);
  assert.deepEqual(seen,[schema.tablesTab,schema.tablesTab,schema.loadsTab]);
});

test('campaign counts use a single journal for visible segments and keep contact and launch metrics independent', () => {
  const other = 'other_project_segment_01', extra = 'second_project_segment_01';
  const f = fixture({
    folders: [other, extra].map(id => ({ id, name: 'Кухни', parents: [SOURCE] })),
    properties: Object.fromEntries([SEGMENT, extra, other].map(id => ['REGISTRY_SEGMENT_PROJECT_' + id, JSON.stringify({ rootId: ROOT, projectId: id === other ? 'neosender' : 'numshield' })])),
  });
  vm.runInContext(readFileSync(new URL('../src/RegistryProjects.gs', import.meta.url), 'utf8'), f.context);
  let reads = 0;
  f.context.coldyCredentialHash_ = () => 'account';
  f.context.coldyCampaignRegistry_ = () => {
    reads++;
    return { credentialHash: 'account', bindings: [
      { segmentId: SEGMENT, campaignStatus: 'Active', campaignName: 'Кухни', id:'private-binding-id' },
      { segmentId: SEGMENT, campaignStatus: 'Completed', campaignName: 'Кухни ЛПР' },
      { segmentId: other, campaignStatus: 'Active', campaignName: 'Рассылка другого проекта' },
      { segmentId: other, campaignStatus: '' },
      ...Array.from({length:12},(_,i)=>({segmentId:extra,campaignStatus:'Draft',campaignName:'Архив '+i})),
    ] };
  };
  const dashboard = (projectId, includeAnalysis) => plain(f.context.callApp({ method: 'getSegmentsDashboard', payload: { includeAnalysis }, accessKey: TEST_ACCESS_KEY, projectId }));
  for (const includeAnalysis of [false, true]) {
    const list = dashboard('numshield', includeAnalysis).items;
    assert.equal(list.length, 2);
    const card = list.find(item => item.id === SEGMENT);
    assert.deepEqual(card.coldyMailings, { linked: 2, activeAtBinding: 1, previewNames:['Кухни','Кухни ЛПР'] });
    assert.ok(!JSON.stringify(list).includes('private-binding-id')&&!JSON.stringify(list).includes('Рассылка другого проекта'));
    assert.equal(card.channels.email.inWork, null);
    assert.notEqual(card.overallStatus, 'in_work');
    assert.deepEqual(list.find(item => item.id === extra).coldyMailings, { linked: 12, activeAtBinding: 0,
      previewNames:Array.from({length:10},(_,i)=>'Архив '+i) });
    const neo = dashboard('neosender', includeAnalysis).items;
    assert.deepEqual(neo.map(item => item.id), [other]);
    assert.deepEqual(neo[0].coldyMailings, { linked: 2, activeAtBinding: null, previewNames:['Рассылка другого проекта'] });
  }
  assert.equal(reads, 4);
  f.context.coldyCampaignRegistry_ = () => { throw Error('Missing journal'); };
  assert.equal(dashboard('numshield', false).items[0].coldyMailings, undefined);
  assert.deepEqual(f.calls.opened, []);
});

test('light dashboard mode is strictly validated before metadata reads', () => {
  for (const request of [null, [], 'fast', { includeAnalysis: 'false' }, { includeAnalysis: 0 }, { skipScope: true }]) {
    const f = fixture();
    assert.throws(() => f.dashboard(request), /INVALID_REQUEST/);
    assert.deepEqual(f.calls.folders, []);
    assert.deepEqual(f.calls.opened, []);
  }
  const unauthorized = fixture({ accessKey: 'a'.repeat(43) });
  assert.throws(() => unauthorized.dashboard({ includeAnalysis: false }), /LINK_ACCESS_REQUIRED/);
  assert.deepEqual(unauthorized.calls.folders, []);
});

test('light dashboard rejects revoked keys and changed roots before returning its projection', () => {
  for (const key of ['ROOT_FOLDER_ID', 'SHARED_ACCESS_KEY_SHA256']) {
    const f = fixture();
    f.context.segmentReadTrackingSnapshot_ = () => {
      const properties = f.context.PropertiesService.getScriptProperties();
      const previous = properties.getProperty;
      properties.getProperty = name => name === key ? (key === 'ROOT_FOLDER_ID' ? 'different_registry_1234567890' : 'b'.repeat(43)) : previous(name);
      return { available: true, tables: [], loads: [] };
    };
    assert.throws(() => f.dashboard({ includeAnalysis: false }), key === 'ROOT_FOLDER_ID' ? /SOURCE_CHANGED/ : /LINK_ACCESS_REQUIRED/);
  }
});

test('a project reassignment after building a preview removes both the list entry and its contacts', () => {
  const prop='REGISTRY_SEGMENT_PROJECT_'+SEGMENT;
  const owned=projectId=>JSON.stringify({rootId:ROOT,projectId});
  const f=fixture({properties:{[prop]:owned('numshield')}});
  vm.runInContext(readFileSync(sourceDir+'RegistryProjects.gs','utf8'),f.context);
  f.context.segmentCardDashboardPreviews_=()=>{
    f.propertyValues.set(prop,owned('neosender'));
    return {[SEGMENT]:{segmentId:SEGMENT,preview:true,rows:[{value:'private@example.test'}]}};
  };
  const result=f.context.callApp({method:'getSegmentsDashboard',accessKey:TEST_ACCESS_KEY,projectId:'numshield',payload:{includeAnalysis:false,includeCardPreview:true}});
  assert.deepEqual(plain(result.items),[]);
  assert.deepEqual(plain(result.cardPreviews),{});
});

test('light dashboard rechecks the actual source ancestry after loading canonical assignments', () => {
  const f = fixture({ files: [sourceFile()] });
  f.context.segmentReadTrackingSnapshot_ = () => {
    const previous = f.context.DriveApp.getFolderById;
    f.context.DriveApp.getFolderById = id => id === SOURCE ? { ...previous(id), getParents: () => iterator([]) } : previous(id);
    return { available: true, tables: [], loads: [] };
  };
  assert.throws(() => f.dashboard({ includeAnalysis: false }), /OUTSIDE_REGISTRY/);
  assert.deepEqual(f.calls.opened, []);
});

test('full dashboard proves a populated large sheet with one body row rather than a 10000-cell block', () => {
  const file = sourceFile('large_nonempty_sheet_1234567890', [{ id: 7,
    rows: [Array(24).fill('Header'), ['Company']], lastRow: 50000, lastColumn: 24 }]);
  const f = fixture({ files: [file], tracking: headers(file.id, 7, true) });
  const result = f.dashboard({ includeAnalysis: true });
  assert.equal(result.analysisPending, undefined);
  assert.equal(result.items[0].overallStatus, 'preparation');
  assert.deepEqual(f.calls.ranges.map(range => [range.row, range.rowCount, range.columnCount]), [[2, 1, 24]]);
});

test('a blank first body row still scans remaining data without double-reading cells', () => {
  const rows = Array.from({ length: 302 }, () => ['', '', '']);
  rows[0] = ['Company', 'Email', 'Phone'];
  rows[301] = ['Last company', '', ''];
  const file = sourceFile('late_contact_sheet_1234567890', [{ id: 9, rows }]);
  const f = fixture({ files: [file], tracking: headers(file.id, 9, true) });
  assert.equal(f.dashboard().items[0].overallStatus, 'preparation');
  const seen = new Set();
  for (const range of f.calls.ranges) {
    for (let row = range.row; row < range.row + range.rowCount; row++) {
      for (let column = range.column; column < range.column + range.columnCount; column++) {
        const key = `${row}:${column}`;
        assert.ok(!seen.has(key), 'A blank probe must not consume the scan budget twice');
        seen.add(key);
      }
    }
  }
  assert.equal(seen.size, 301 * 3);
});

test('outreach metadata excludes the unrelated root/source catalog and service book', () => {
  const f = fixture({ files: [sourceFile(SERVICE), sourceFile('business_sheet_1234567890')], folders: [{ id: 'catalog_folder_1234567890', name: 'Исходные базы', parents: [ROOT] }] });
  const metadata = plain(runShared(f.context, () => f.context.getSegmentsMetadata_()));
  assert.equal(metadata.items.length, 1);
  assert.equal(metadata.items[0].tableCount, 1);
  assert.equal(metadata.items[0].files[0].id, 'business_sheet_1234567890');
  assert.equal(f.calls.rootFileScans, 0);
  assert.deepEqual(f.calls.opened, []);
});

test('empty folders and physically blank default sheets have no contacts', () => {
  for (const files of [[], [sourceFile(undefined, [{ id: 4, rows: [] }])]]) {
    const f = fixture({ files });
    const item = f.dashboard().items[0];
    assert.equal(item.overallStatus, 'no_contacts');
    assert.equal(item.contactPresence, 'empty');
    assert.deepEqual(item.analysis, { state: 'ready', hasContacts: false, warnings: [] });
    assert.deepEqual(f.calls.ranges, []);
  }
});

test('dashboard shares one journal snapshot across segments and rereads it next request', () => {
  const second = 'second_segment_1234567890';
  const f = fixture({ folders: [{ id: second, name: 'Другой сегмент', parents: [SOURCE] }] });
  assert.equal(f.dashboard().items.length, 2);
  assert.equal(f.calls.trackingSnapshots, 1);
  assert.deepEqual([...f.calls.tracking].sort(), [SEGMENT, second].sort());
  f.dashboard();
  assert.equal(f.calls.trackingSnapshots, 2);
});

test('an unavailable journal is attempted only once and never hides lone-row contacts', () => {
  const second = 'second_segment_1234567890';
  const f = fixture({
    trackingThrows: true,
    folders: [{ id: second, name: 'Другой сегмент', parents: [SOURCE] }],
    files: [sourceFile(undefined, [{ rows: [['Company or header']] }]), sourceFile('second_file_1234567890', [{ rows: [['Other contact']] }], { parents: [second] })],
  });
  const result = f.dashboard();
  assert.equal(f.calls.trackingSnapshots, 1);
  for (const item of result.items) {
    assert.equal(item.overallStatus, null);
    assert.equal(item.contactPresence, 'unknown');
    assert.equal(item.analysis.state, 'partial');
  }
});

test('an explicitly marked header-only sheet is empty', () => {
  const file = sourceFile(undefined, [{ id: 6, rows: [['Компания', 'Email']] }]);
  const f = fixture({ files: [file], tracking: headers(file.id, 6, true) });
  assert.equal(f.dashboard().items[0].overallStatus, 'no_contacts');
  assert.deepEqual(f.calls.ranges, []);
});

test('an unmanaged lone first row stays unknown instead of hiding a possible contact', () => {
  const file = sourceFile(undefined, [{ id: 6, rows: [['Company-or-header']] }]);
  const item = fixture({ files: [file] }).dashboard().items[0];
  assert.equal(item.overallStatus, null);
  assert.equal(item.contactPresence, 'unknown');
  assert.equal(item.analysis.state, 'partial');
  assert.match(item.analysis.warnings.join(' '), /заголовок/);
});

const CENTER = 'contact_center_1234567890';
function centerSheets() {
  const code = readFileSync(`${sourceDir}ContactTarget.gs`, 'utf8');
  const context = vm.createContext({});
  vm.runInContext(code, context);
  return ['base', 'email', 'telegram'].map((kind, index) => ({ id: index + 100, name: ['База', 'Email', 'Telegram'][index], rows: [plain(context.CONTACT_TARGET_HEADERS[kind])] }));
}

test('the configured Center exact header-only working tabs are empty without import tracking', () => {
  const f = fixture({ files: [sourceFile(CENTER, centerSheets())], properties: { CONTACT_CENTER_ID: CENTER } });
  const item = f.dashboard().items[0];
  assert.equal(item.overallStatus, 'no_contacts');
  assert.equal(item.contactPresence, 'empty');
  assert.equal(item.analysis.state, 'ready');
  assert.deepEqual(f.calls.opened, [CENTER]);
  assert.equal(f.calls.ranges.length, 3);
  assert.ok(f.calls.ranges.every(range => range.row === 1 && range.rowCount === 1));
});

test('the default configured Center also recognizes exact headers and reads body contacts', () => {
  const tabs = centerSheets(); tabs[1].rows.push(['contact-1', 'company-1', 'Компания', 'someone@example.test']);
  const f = fixture({ files: [sourceFile(CENTER, tabs)], limits: { defaultContactCenterId: CENTER } });
  const item = f.dashboard().items[0];
  assert.equal(item.overallStatus, 'preparation');
  assert.equal(item.analysis.hasContacts, true);
  assert.ok(f.calls.ranges.some(range => range.sheetId === 101 && range.row === 2));
  assert.equal(JSON.stringify(item).includes('someone@example.test'), false);
});

test('changed Center headers, extra header cells and unrelated matching headers stay unknown', () => {
  const changed = centerSheets(); changed[0].rows[0][0] = 'Possible first contact';
  const extra = centerSheets(); extra[0].rows[0].push('Possible first contact');
  for (const tabs of [changed, extra]) {
    const item = fixture({ files: [sourceFile(CENTER, tabs)], properties: { CONTACT_CENTER_ID: CENTER } }).dashboard().items[0];
    assert.equal(item.overallStatus, null);
    assert.equal(item.contactPresence, 'unknown');
  }
  const other = 'other_center_1234567890';
  const item = fixture({ files: [sourceFile(other, centerSheets())], properties: { CONTACT_CENTER_ID: CENTER } }).dashboard().items[0];
  assert.equal(item.overallStatus, null);
  assert.equal(item.contactPresence, 'unknown');
});

test('explicit contradictory tracking does not get replaced by Center header inference', () => {
  const tabs = centerSheets(), tracking = headers(CENTER, tabs[0].id, false);
  tracking.loads.push({ ...tracking.loads[0], hasHeader: true });
  const item = fixture({ files: [sourceFile(CENTER, tabs)], properties: { CONTACT_CENTER_ID: CENTER }, tracking }).dashboard().items[0];
  assert.equal(item.overallStatus, null);
  assert.equal(item.analysis.state, 'partial');
});

test('Center header inference respects scan budgets and cannot open a moved file', () => {
  const f = fixture({ files: [sourceFile(CENTER, centerSheets())], properties: { CONTACT_CENTER_ID: CENTER }, limits: { segmentAnalysisMaxCells: 10, segmentAnalysisChunkCells: 3 } });
  assert.equal(f.dashboard().items[0].overallStatus, null);
  assert.ok(f.calls.ranges.every(range => range.rowCount * range.columnCount <= 3));
  assert.ok(f.calls.ranges.reduce((sum, range) => sum + range.rowCount * range.columnCount, 0) <= 10);
  const moved = fixture({ files: [sourceFile(CENTER, centerSheets(), { actualParents: [ROOT] })], properties: { CONTACT_CENTER_ID: CENTER } });
  assert.equal(moved.dashboard().items[0].overallStatus, null);
  assert.deepEqual(moved.calls.opened, []);
  assert.deepEqual(moved.calls.ranges, []);
});

test('recognizing configured Center headers never bypasses shared-link authorization', () => {
  const f = fixture({ files: [sourceFile(CENTER, centerSheets())], properties: { CONTACT_CENTER_ID: CENTER }, accessKey: 'wrong' });
  assert.throws(() => f.dashboard(), /LINK_ACCESS_REQUIRED/);
  assert.deepEqual(f.calls.opened, []);
  assert.deepEqual(f.calls.ranges, []);
});

test('an explicit no-header choice counts a first-row contact', () => {
  const file = sourceFile(undefined, [{ id: 9, rows: [['Test company', 'contact@example.test']] }]);
  const f = fixture({ files: [file], tracking: headers(file.id, 9, false) });
  const item = f.dashboard().items[0];
  assert.equal(item.overallStatus, 'preparation');
  assert.equal(item.contactPresence, 'has_contacts');
  assert.equal(f.calls.ranges[0].row, 1);
});

test('legacy body data establishes preparation but never activates channels or exposes cells', () => {
  const secret = 'secret-company@example.test';
  const f = fixture({ files: [sourceFile(undefined, [{ id: 1, rows: [['Email'], [secret]] }])] });
  const result = f.dashboard(), item = result.items[0];
  assert.equal(item.overallStatus, 'preparation');
  assert.equal(item.analysis.hasContacts, true);
  for (const channel of Object.values(item.channels)) assert.deepEqual(channel, { state: 'inactive', inWork: null, configured: false });
  assert.equal(item.companiesInWork, null);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('formula display-empty cells and whitespace do not count as contacts', () => {
  const file = sourceFile(undefined, [{ id: 8, rows: [['Header'], [''], ['  ']], lastRow: 3 }]);
  const item = fixture({ files: [file], tracking: headers(file.id, 8, true) }).dashboard().items[0];
  assert.equal(item.overallStatus, 'no_contacts');
});

test('presence scans stop before opening remaining business books', () => {
  const first = sourceFile('first_business_1234567890', [{ id: 1, rows: [['Header'], ['Company']] }], { name: 'A' });
  const next = sourceFile('other_business_1234567890', [{ rows: [['Never read']] }], { name: 'B' });
  const f = fixture({ files: [first, next] });
  assert.equal(f.dashboard().items[0].overallStatus, 'preparation');
  assert.deepEqual(f.calls.opened, [first.id]);
});

test('unreadable files make an otherwise empty segment unknown', () => {
  const f = fixture({ files: [sourceFile(undefined, [], { unreadable: true })] });
  const item = f.dashboard().items[0];
  assert.equal(item.overallStatus, null);
  assert.equal(item.analysis.state, 'partial');
  assert.match(item.analysis.warnings.join(' '), /права доступа/);
});

test('later known contacts still establish preparation after an unreadable file or ambiguous sheet', () => {
  const first = sourceFile('first_business_1234567890', [], { unreadable: true, name: 'A' });
  const next = sourceFile('other_business_1234567890', [{ id: 1, rows: [['Maybe header']] }, { id: 2, rows: [['Header'], ['Contact']] }], { name: 'B' });
  const item = fixture({ files: [first, next] }).dashboard().items[0];
  assert.equal(item.overallStatus, 'preparation');
  assert.equal(item.analysis.state, 'partial');
  assert.equal(item.analysis.hasContacts, true);
});

test('a moved segment is not read even if its files remain in the registry', () => {
  const f = fixture({ folders: [{ id: SEGMENT, name: 'Moved segment', parents: [SOURCE], actualParents: [ROOT] }], files: [sourceFile(undefined, [{ rows: [['Header'], ['Contact']] }])] });
  const item = f.dashboard().items[0];
  assert.equal(item.overallStatus, null);
  assert.deepEqual(f.calls.tracking, []);
  assert.equal(f.calls.trackingSnapshots, 0);
  assert.deepEqual(f.calls.opened, []);
  assert.throws(() => f.mailings(), /OUTSIDE_SEGMENTS/);
});

test('sharing a journal snapshot never caches segment membership between requests', () => {
  const folder = { id: SEGMENT, name: 'Сегмент', parents: [SOURCE] };
  const f = fixture({ folders: [folder], files: [sourceFile(undefined, [{ rows: [['Header'], ['Contact']] }])] });
  assert.equal(f.dashboard().items[0].overallStatus, 'preparation');
  folder.actualParents = [ROOT];
  f.calls.opened.length = 0;
  f.calls.tracking.length = 0;
  assert.equal(f.dashboard().items[0].contactPresence, 'unknown');
  assert.equal(f.calls.trackingSnapshots, 1);
  assert.deepEqual(f.calls.tracking, []);
  assert.deepEqual(f.calls.opened, []);
});

test('a file moved out of its segment is rejected before opening', () => {
  const f = fixture({ files: [sourceFile(undefined, [{ rows: [['Header'], ['Contact']] }], { actualParents: [ROOT] })] });
  assert.equal(f.dashboard().items[0].overallStatus, null);
  assert.deepEqual(f.calls.opened, []);
});

test('service-book protection also holds for the private scan helper', () => {
  const f = fixture({ files: [sourceFile(SERVICE, [{ rows: [['metadata']] }])] });
  const result = plain(runShared(f.context, () => f.context.segmentAnalyzeFile_(f.context.authorize_(), SEGMENT, SERVICE, {}, f.context.segmentAnalysisBudget_())));
  assert.equal(result.state, 'partial');
  assert.deepEqual(f.calls.files, []);
  assert.deepEqual(f.calls.opened, []);
});

test('nested Google Sheets are read under their owning direct-child segment', () => {
  const nested = 'nested_folder_1234567890';
  const file = sourceFile(undefined, [{ rows: [['Header'], ['Contact']] }], { parents: [nested] });
  const f = fixture({ folders: [{ id: nested, name: 'Вложенные', parents: [SEGMENT] }], files: [file] });
  const result = f.dashboard();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].overallStatus, 'preparation');
  assert.equal(result.items[0].tableCount, 1);
});

test('physical empty sheets are provably empty even when tracking is incomplete or unavailable', () => {
  for (const tracking of [{ available: false, tables: [], loads: [] }, headers('business_sheet_1234567890', 1, true, { stage: 'copying' })]) {
    const item = fixture({ files: [sourceFile(undefined, [{ id: 1, rows: [] }])], tracking }).dashboard().items[0];
    assert.equal(item.overallStatus, 'no_contacts');
    assert.equal(item.analysis.hasContacts, false);
    assert.equal(item.analysis.state, 'partial');
  }
});

test('confirmed header choices and canonical file kinds come from tracking only', () => {
  const file = sourceFile(undefined, [{ id: 4, rows: [['Company']] }]);
  const tracking = headers(file.id, 4, false); tracking.tables.push({ fileId: file.id, kind: 'companies' });
  const item = fixture({ files: [file], tracking }).dashboard().items[0];
  assert.equal(item.files[0].kind, 'companies');
  assert.equal(item.overallStatus, 'preparation');
});

test('conflicting header choices do not silently make a lone first row empty', () => {
  const file = sourceFile(undefined, [{ id: 4, rows: [['Company']] }]);
  const tracking = headers(file.id, 4, false); tracking.loads.push({ ...tracking.loads[0], hasHeader: true });
  const item = fixture({ files: [file], tracking }).dashboard().items[0];
  assert.equal(item.overallStatus, null);
  assert.equal(item.analysis.state, 'partial');
});

test('cell and file limits return unknown rather than false empty and ranges stay bounded', () => {
  const file = sourceFile(undefined, [{ id: 3, rows: [['H'], [''], [''], ['']], lastRow: 50, lastColumn: 5 }]);
  const f = fixture({ files: [file], tracking: headers(file.id, 3, true), limits: { segmentAnalysisMaxCells: 10, segmentAnalysisChunkCells: 5 } });
  const item = f.dashboard().items[0];
  assert.equal(item.overallStatus, null);
  assert.ok(f.calls.ranges.every(range => range.rowCount * range.columnCount <= 5));
  assert.ok(f.calls.ranges.reduce((sum, range) => sum + range.rowCount * range.columnCount, 0) <= 10);
  const f2 = fixture({ files: [sourceFile('first_business_1234567890'), sourceFile('other_business_1234567890')], limits: { segmentAnalysisMaxFiles: 1 } });
  assert.equal(f2.dashboard().items[0].overallStatus, null);
  assert.equal(f2.calls.opened.length, 1);
});

test('wide worksheets are read in bounded horizontal chunks', () => {
  const file = sourceFile(undefined, [{ id: 3, rows: [['H'], ['', '', '', '', '', '', 'Contact']], lastColumn: 7 }]);
  const f = fixture({ files: [file], tracking: headers(file.id, 3, true), limits: { segmentAnalysisChunkCells: 3 } });
  assert.equal(f.dashboard().items[0].overallStatus, 'preparation');
  assert.deepEqual(f.calls.ranges.map(range => range.column), [1, 4, 7]);
  assert.ok(f.calls.ranges.every(range => range.rowCount * range.columnCount <= 3));
});

test('sheet and elapsed-time limits also stop reads with an explicit unknown result', () => {
  const file = sourceFile(undefined, [{ rows: [] }, { rows: [] }]);
  const f = fixture({ files: [file], limits: { segmentAnalysisMaxSheets: 1 } });
  assert.equal(f.dashboard().items[0].overallStatus, null);
  const budget = f.context.segmentAnalysisBudget_();
  budget.startedAt = 0;
  const opened = f.calls.opened.length;
  const result = plain(runShared(f.context, () => f.context.segmentAnalyzeFile_(f.context.authorize_(), SEGMENT, file.id, {}, budget)));
  assert.equal(result.state, 'partial');
  assert.equal(f.calls.opened.length, opened);
});

test('mailings validate their folder without scanning unrelated segments or business files', () => {
  const f = fixture({ failMetadataScan: true, files: [sourceFile(undefined, [{ rows: [['Never read contacts']] }])] });
  const result = f.mailings();
  assert.equal(result.state, 'not_connected');
  assert.equal(result.segment.id, SEGMENT);
  assert.equal(result.segment.category, 'clients');
  assert.deepEqual(result.totals, { sent: null, replies: null, leads: null });
  assert.deepEqual(result.services.map(service => [service.id, service.name, service.channel]), [['coldy', 'Coldy', 'email'], ['nsa', 'NSA', 'telegram']]);
  for (const service of result.services) {
    assert.deepEqual(service.campaigns, []);
    assert.deepEqual(service.totals, { sent: null, replies: null, leads: null });
  }
  assert.deepEqual(f.calls.metadataScans, []);
  assert.deepEqual(f.calls.opened, []);
  assert.equal(f.calls.trackingSnapshots, 0);
  assert.throws(() => f.mailings('outside_segment_1234567890'), /SEGMENT_NOT_FOUND/);
});

test('segment analytics includes cached Coldy metrics with an explicit connected-channel total', () => {
  const f=fixture();let reads=0;
  f.context.coldySegmentMailings_=(context,id)=>{reads++;assert.equal(context.rootId,ROOT);assert.equal(id,SEGMENT);return {key:'coldy',name:'Coldy',channel:'email',state:'connected',cached:true,generatedAt:'2026-11-19T10:00:00.000Z',campaigns:[{id:'campaign',sent:120,replies:7,leads:2}],totals:{sent:120,replies:7,leads:2}}};
  const result=f.mailings();assert.equal(reads,1);assert.equal(result.services[0].id,'coldy');assert.deepEqual(result.totals,{sent:120,replies:7,leads:2});assert.equal(result.totalsScope,'connected_channels');assert.equal(result.services[1].state,'not_connected');assert.equal(f.calls.opened.length,0);
});
test('unknown Coldy metrics remain unknown in segment totals', () => {
  const f=fixture();f.context.coldySegmentMailings_=()=>({state:'partial',totals:{sent:120,replies:null,leads:0}});
  assert.deepEqual(f.mailings().totals,{sent:120,replies:null,leads:0});
});

test('mailings reject nested, trashed and outside-root folders before reading workbooks', () => {
  const candidate = 'invalid_segment_1234567890';
  for (const entry of [
    { parents: [SEGMENT] },
    { parents: [SOURCE], trashed: true },
    { parents: [] },
  ]) {
    const f = fixture({ folders: [{ id: candidate, name: 'Недоступный сегмент', ...entry }] });
    assert.throws(() => f.mailings(candidate), /OUTSIDE_SEGMENTS|SEGMENT_NOT_FOUND/);
    assert.deepEqual(f.calls.metadataScans, []);
    assert.deepEqual(f.calls.opened, []);
  }
});

test('future mailing aggregation handles multiple campaigns and independently unknown metrics', () => {
  const f = fixture();
  const entries = [{ sent: 10, replies: 3, leads: 1 }, { sent: 5, replies: null, leads: 2 }];
  assert.deepEqual(plain(f.context.segmentAggregateMailingMetrics_(entries, true)), { sent: 15, replies: null, leads: 3 });
  assert.deepEqual(plain(f.context.segmentAggregateMailingMetrics_(entries, false)), { sent: null, replies: null, leads: null });
  assert.deepEqual(plain(f.context.segmentAggregateMailingMetrics_([], true)), { sent: 0, replies: 0, leads: 0 });
  assert.deepEqual(plain(f.context.segmentAggregateMailingMetrics_([{ sent: -1, replies: 1.5, leads: Number.MAX_SAFE_INTEGER }, { sent: 1, replies: 2, leads: 1 }], true)), { sent: null, replies: null, leads: null });
});

test('future positive launch adapter can express in_work without deriving it from mailing counts', () => {
  const f = fixture();
  assert.equal(f.context.segmentOverallStatus_(true, { configured: false, hasLaunchedContacts: true }), 'preparation');
  assert.equal(f.context.segmentOverallStatus_(true, { configured: true, hasLaunchedContacts: true }), 'in_work');
  assert.equal(f.context.segmentOverallStatus_(null, { configured: false, hasLaunchedContacts: null }), null);
});

test('analytics handlers stay private behind the shared dispatcher', () => {
  const source = readFileSync(`${sourceDir}SegmentAnalytics.gs`, 'utf8');
  const publicFunctions = [...source.matchAll(/^function\s+([A-Za-z0-9_]+)\s*\(/gm)].map(match => match[1]).filter(name => !name.endsWith('_'));
  assert.deepEqual(publicFunctions, []);
  assert.doesNotMatch(source, /UrlFetchApp|\.setValue\s*\(|\.setValues\s*\(|\.clear\s*\(|\.appendRow\s*\(/);
});
