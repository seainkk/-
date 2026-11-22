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
