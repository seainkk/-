import { TEST_ACCESS_KEY, TEST_ACCESS_HASH, SHARED_ACTOR, installSharedApi, runShared } from './helpers/shared-link.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = ['Config.gs', 'Code.gs'].map(name => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8')).join('\n');
const ROOT = 'app_root_1234567890';
function setup({ accessKey = TEST_ACCESS_KEY, trashed = false } = {}) {
  const calls = [];
  const properties = { getProperty: key => ({ ROOT_FOLDER_ID: ROOT, SHARED_ACCESS_KEY_SHA256: TEST_ACCESS_HASH })[key] || '' };
  const account = { getEmail: () => 'member@example.com' };
  const context = vm.createContext({
    console,
    PropertiesService: { getScriptProperties: () => properties },
    Session: { getActiveUser: () => account, getEffectiveUser: () => account },
    DriveApp: { getFolderById(id) {
      calls.push(id);
      assert.equal(id, ROOT);
      return {
        getId: () => ROOT, getName: () => 'Реестр баз', isTrashed: () => trashed,
        getFilesByType: () => { throw new Error('Startup must not enumerate source files'); },
        getFolders: () => { throw new Error('Startup must not traverse folders'); }
      };
    } },
    SpreadsheetApp: { openById: () => { throw new Error('Startup must not read the service book or business cells'); } }
  });
  vm.runInContext(source, context);
  installSharedApi(context, { accessKey: () => accessKey });
  return { context, calls };
}

test('app startup returns identity and registry without a Drive tree or spreadsheet reads', () => {
  const { context, calls } = setup();
  const result = JSON.parse(JSON.stringify(context.getAppBootstrap()));
  assert.deepEqual(result, { user: { email: '', isAdmin: false, accessMode: 'link' }, registry: { id: ROOT, name: 'Реестр баз' } });
  assert.deepEqual(calls, [ROOT]);
});

test('app startup denies callers before resolving the registry', () => {
  const { context, calls } = setup({ accessKey: null });
  assert.throws(() => context.getAppBootstrap(), /LINK_ACCESS_REQUIRED|LINK_ACCESS_INVALID|ACCESS_REQUIRED|INVALID_ACCESS/);
  assert.deepEqual(calls, []);
});

test('app startup rejects a trashed registry rather than showing stale project metadata', () => {
  const { context } = setup({ trashed: true });
  assert.throws(() => context.getAppBootstrap(), /NOT_FOUND/);
});

function directorySetup() {
  const {context}=setup(), source=context.REGISTRY_CONFIG.defaultSegmentsFolderId, mime='application/vnd.google-apps.folder';
  vm.runInContext(readFileSync(new URL('../src/RegistryProjects.gs',import.meta.url),'utf8'),context);
  const props={ROOT_FOLDER_ID:ROOT,SHARED_ACCESS_KEY_SHA256:TEST_ACCESS_HASH};
  const ids=['segment_kitchens','segment_web_studios','segment_neo_only','segment_unassigned'];
  for(const [i,id] of ids.slice(0,3).entries()) props['REGISTRY_SEGMENT_PROJECT_'+id]=JSON.stringify({rootId:ROOT,projectId:i===2?'neosender':'numshield'});
  props['SEGMENT_CATEGORY_'+ids[0]]=JSON.stringify({category:'partners'});
  const storage={getProperties:()=>({...props}),getProperty:k=>props[k]||null};
  context.PropertiesService={getScriptProperties:()=>storage};
  const folder=(id,name,parent)=>({id,name,parents:[parent],mimeType:mime,trashed:false});
  const page={files:[folder(source,'Аутричи',ROOT),...ids.map((id,i)=>folder(id,['Кухни','Веб-студии','Сегмент другого проекта','Без проекта'][i],source)),
    folder('nested_folder_id','Вложенная папка',ids[0]),{...folder('working_file_id','Таблица',source),mimeType:'application/vnd.google-apps.spreadsheet'},
    {...folder('removed_segment','Удалён',source),trashed:true},null]};
  let lists=0;
  context.Drive={Files:{get(id,options){assert.equal(id,ROOT);return {...folder(ROOT,'Реестр','parent'),driveId:'team_drive'};},
    list(options){lists++;assert.equal(options.driveId,'team_drive');assert.match(options.q,/mimeType='application\/vnd.google-apps.folder'/);
      assert.doesNotMatch(options.fields,/appProperties|description|permissions/);return page;}}};
  const call=(method='getSegmentDirectory',payload={},projectId='numshield',accessKey=TEST_ACCESS_KEY)=>JSON.parse(JSON.stringify(context.callApp({method,payload,projectId,accessKey})));
  return {context,page,props,source,ids,call,folder,lists:()=>lists};
}

test('startup and standalone segment directory return only current project folder metadata with one bounded list each',()=>{
  const f=directorySetup(), start=f.call('getAppBootstrap',{includeSegmentDirectory:true}).segmentDirectory;
  assert.equal(f.lists(),1);assert.equal(start.state,'ready');assert.equal(start.projectId,'numshield');assert.equal(start.sourceId,f.source);
  assert.equal(start.complete,true);assert.equal(typeof start.checkedAt,'number');assert.match(start.revision,/^[\w-]{43}$/);
  const initial={workStatus:'working',workStatusRevision:0};
  assert.deepEqual(start.items,[{id:f.ids[1],name:'Веб-студии',category:'partners',...initial},{id:f.ids[0],name:'Кухни',category:'partners',...initial}]);
  assert.equal(f.call().revision,start.revision);assert.equal(f.lists(),2);
  const other=f.call('getSegmentDirectory',{},'neosender');
  assert.deepEqual(other.items,[{id:f.ids[2],name:'Сегмент другого проекта',category:'clients',...initial}]);assert.notEqual(other.revision,start.revision);
  const key=f.context.segmentWorkStatusKey_({rootId:ROOT},f.ids[0]);
  f.props[key]=JSON.stringify({scope:key,status:'paused',revision:1,receipts:[['a'.repeat(43),'paused']]});
  assert.equal(f.call().items.find(i=>i.id===f.ids[0]).workStatus,'paused');assert.notEqual(f.call().revision,start.revision);
  f.page.files.find(file=>file?.id===f.ids[0]).name='Новое имя';
  assert.notEqual(f.call().revision,start.revision);
  delete f.props['REGISTRY_SEGMENT_PROJECT_'+f.ids[1]];
  assert.deepEqual(f.call().items.map(item=>item.id),[f.ids[0]]);
  const before=f.lists();assert.throws(()=>f.call('getSegmentDirectory',{},'numshield','invalid'),/LINK_ACCESS_REQUIRED/);
  assert.throws(()=>f.call('getSegmentDirectory',{sourceId:'another_folder'}),/INVALID_REQUEST/);
  assert.throws(()=>f.call('getAppBootstrap',{includeSegmentDirectory:'true'}),/INVALID_REQUEST/);assert.equal(f.lists(),before);
});

test('a partial or failed directory cannot erase the catalogue, and a changed/revoked root cannot expose names',()=>{
  const f=directorySetup();
  f.page.nextPageToken='more';assert.equal(f.call().complete,false);
  f.page.incompleteSearch=true;assert.deepEqual(f.call().items,[]);assert.equal(f.call().state,'unavailable');
  delete f.page.incompleteSearch;delete f.page.nextPageToken;
  f.context.Drive.Files.list=()=>{f.props.ROOT_FOLDER_ID='different_root';return f.page;};
  assert.throws(()=>f.call(),/SOURCE_CHANGED/);
  f.props.ROOT_FOLDER_ID=ROOT;
  f.context.Drive.Files.list=()=>{f.props.SHARED_ACCESS_KEY_SHA256='a'.repeat(43);return f.page;};
  assert.throws(()=>f.call(),/LINK_ACCESS_REQUIRED/);
});

test('a moved or ambiguous source fails closed; a legacy named source lists only its own direct folders',()=>{
  const f=directorySetup(), fallback='legacy_source_folder';
  const target=f.folder(fallback,'Аутричи',ROOT), first=f.folder(f.ids[0],'Наследованный сегмент',fallback);
  f.page.files[0].parents=['other_root'];
  f.context.segmentMetadataBinding_=()=>({state:'source_outside_registry'});
  assert.deepEqual(f.call().items,[]);assert.equal(f.call().state,'source_outside_registry');
  f.context.segmentMetadataBinding_=()=>({state:'source_ambiguous'});assert.equal(f.call().state,'source_ambiguous');
  f.context.segmentMetadataBinding_=()=>({state:'ready',folder:{getId:()=>fallback,isTrashed:()=>false}});
  f.context.insideRegistry_=()=>true;
  f.context.Drive.Files.list=q=>q.q.includes("'"+fallback+"' in parents")?{files:[first,...f.page.files]}:{files:[target,...f.page.files]};
  const result=f.call();assert.equal(result.sourceId,fallback);assert.deepEqual(result.items.map(item=>item.name),[first.name]);
  f.context.insideRegistry_=()=>false;assert.equal(f.call().state,'source_outside_registry');
});

test('startup reads the exact live Drive folder and its title in one metadata request', () => {
  const { context, calls } = setup();
  const metadata = {id:ROOT, name:'Общие базы', mimeType:'application/vnd.google-apps.folder', trashed:false};
  let gets = 0;
  context.Drive = {Files:{get(id, options) {
    assert.equal(id, ROOT);
    assert.equal(options.fields, 'id,name,mimeType,trashed');
    assert.equal(options.supportsAllDrives, true);
    gets++;
    return metadata;
  }}};
  assert.deepEqual(JSON.parse(JSON.stringify(context.getAppBootstrap().registry)),{id:ROOT,name:'Общие базы'});
  assert.equal(gets,1);
  for(const [key,bad] of [['id','other_root_1234567890'], ['mimeType','application/json'], ['trashed',true]]){
    const before=metadata[key]; metadata[key]=bad;
    assert.throws(()=>context.getAppBootstrap(),/NOT_FOUND/);
    metadata[key]=before;
  }
  assert.deepEqual(calls,[]);
});

function previewSetup(options = {}) {
  const {context} = setup(options);
  const folder = 'application/vnd.google-apps.folder', source = context.REGISTRY_CONFIG.defaultSourceBasesFolderId;
  const storage = context.REGISTRY_CONFIG.defaultSourceBasesStorageId, file = 'listed_file_1234';
  const entry = (id, name, parent, mimeType = 'text/csv') => ({id,name,parents:[parent],mimeType,trashed:false});
  const page = {files:[
    entry(source,'Исходники',ROOT,folder), entry(file,'Новое название',source),
    entry('other_root_file','Приватная таблица',ROOT), entry('child_folder_file','Вложенная база','another_folder'),
    entry(storage,'Служебный журнал',source), {...entry('trashed_file_123','Из корзины',source),trashed:true},
    entry('child_folder_id','Папка',source,folder)
  ]};
  const cache = new Map(), gets = [], lists = [];
  context.CacheService = {getScriptCache:()=>({get:key=>cache.get(key) || null, put:(key,value)=>cache.set(key,value)})};
  context.Drive = {Files:{
    get(id,options){gets.push([id,options]);return {id:ROOT,name:'Наш реестр',mimeType:folder,trashed:false,driveId:'our_drive'};},
    list(options){lists.push(options);return page;}
  }};
  const read = () => JSON.parse(JSON.stringify(context.getAppBootstrap({includeSourcePreview:true})));
  return {context,source,storage,file,entry,page,gets,lists,cache,read};
}

test('first-visit preview returns only names from the verified source and optional type hints in one bounded list before Sheets', () => {
  const f = previewSetup();
  assert.deepEqual(f.read().catalogPreview.items,[{name:'Новое название',contents:[]}]);
  assert.equal(f.gets.length,1);
  assert.equal(f.lists.length,1);
  const list = f.lists[0];
  assert.equal(list.corpora,'drive');
  assert.equal(list.driveId,'our_drive');
  assert.match(list.q,new RegExp(f.source));
  assert.match(list.q,new RegExp(ROOT));
  assert.ok(list.pageSize <= 200);
  f.context.sourceBasesRememberPreviewTypes_(ROOT,f.source,f.storage,[
    {id:f.file,name:'Устаревшее название',contents:['lpr']},
    {id:'unrelated_file',name:'Убрана из реестра',contents:['companies']}
  ]);
  assert.ok(![...f.cache.values()].join('').includes('название'));
  const preview = f.read().catalogPreview;
  assert.deepEqual(preview.items,[{name:'Новое название',contents:['lpr']}]);
  assert.ok(Number.isFinite(preview.checkedAt));
  assert.equal(preview.partial,true,'Subfolders are checked by the full catalogue');
  f.page.files=f.page.files.filter(item=>item.id!=='child_folder_id');
  assert.equal(f.read().catalogPreview.partial,false);
  f.page.nextPageToken='next';
  assert.equal(f.read().catalogPreview.partial,true);
  f.page.files.find(x=>x.id===f.file).parents=['moved_outside'];
  assert.equal(f.read().catalogPreview,undefined);
});

test('startup preview fails closed on changed bindings and allows entry when listing is unavailable', () => {
  const f = previewSetup();
  f.page.files[0].parents=['unknown_parent'];
  assert.equal(f.read().catalogPreview,undefined);
  f.page.files[0].parents=[ROOT];
  f.page.incompleteSearch=true;
  assert.equal(f.read().catalogPreview,undefined);
  delete f.page.incompleteSearch;
  const authorize = f.context.authorize_;
  let checks=0;
  f.context.authorize_=()=>{const scope=authorize(); if (++checks===2) scope.rootId='new_root_folder'; return scope;};
  assert.equal(f.read().catalogPreview,undefined);
  f.context.authorize_=authorize;
  f.context.Drive.Files.list=()=>{throw new Error('Drive busy');};
  assert.equal(f.read().user.accessMode,'link');
  const denied=previewSetup({accessKey:null});
  assert.throws(denied.read,/LINK_ACCESS_REQUIRED/);
  assert.equal(denied.gets.length+denied.lists.length,0);
  assert.throws(()=>f.context.getAppBootstrap({sourceId:f.source}),/INVALID_REQUEST/);
});

test('one verified Drive page supplies source directory IDs and the legacy name-only preview, distinguishing empty, partial and unavailable',()=>{
  const f=previewSetup(), read=()=>JSON.parse(JSON.stringify(f.context.getAppBootstrap({includeSourceDirectory:true,includeSourcePreview:true})));
  let result=read();
  assert.deepEqual(result.sourceDirectory.items,[{id:f.file,name:'Новое название',workbook:false}]);
  assert.deepEqual(result.catalogPreview.items,[{name:'Новое название',contents:[]}]);
  assert.equal(f.lists.length,1);assert.equal(result.sourceDirectory.sourceId,f.source);assert.equal(result.sourceDirectory.complete,false);
  const first=result.sourceDirectory.revision;
  f.page.files.find(item=>item.id===f.file).mimeType=f.context.REGISTRY_CONFIG.spreadsheetMime;
  result=read();assert.equal(result.sourceDirectory.items[0].workbook,true);assert.notEqual(result.sourceDirectory.revision,first);
  f.page.files=f.page.files.filter(item=>item.id!=='child_folder_id');
  assert.equal(read().sourceDirectory.complete,true);assert.notEqual(read().sourceDirectory.revision,first);
  f.page.files=f.page.files.filter(item=>item.id!==f.file);
  result=read();assert.deepEqual(result.sourceDirectory.items,[]);assert.equal(result.sourceDirectory.state,'ready');assert.equal(result.sourceDirectory.complete,true);
  assert.equal(result.catalogPreview,undefined);assert.equal(typeof result.sourceDirectory.revision,'string');
  f.page.incompleteSearch=true;result=read();assert.equal(result.sourceDirectory.state,'unavailable');assert.equal(result.sourceDirectory.complete,false);assert.equal(result.sourceDirectory.revision,null);
});
