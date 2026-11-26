import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function fixture() {
  const c = vm.createContext({});
  for (const file of ['Config','Code','ContactPreview','ContactSync','PreparedData','PreparedImport','SourceRecords','SegmentRecords','SegmentImports','SegmentActions','Promouser','Segments','SegmentLegacyPreview']) {
    vm.runInContext(readFileSync(new URL('../src/' + file + '.gs', import.meta.url), 'utf8'), c);
  }
  const root = 'registry_root_012', outreach = 'outreach_folder_01', archive = 'archive_folder_01', oldFolder = 'archived_segment_01', segment = 'current_segment_01';
  const company = 'working_company_01', lpr = 'working_people_01', old = 'old_company_book01', service = 'service_file_id01';
  const folderMime = 'application/vnd.google-apps.folder', sheetMime = 'application/vnd.google-apps.spreadsheet';
  const meta = new Map(), books = new Map(), projects = new Map([[segment, 'numshield']]), opened = [];
  function add(id, name, parent, mimeType = folderMime) { meta.set(id, { id, name, parents:[parent], mimeType, trashed:false, version:'1', appProperties:{} }); }
  add(root, 'Реестр', 'personal_drive'); add(outreach, 'Аутричи', root); add(archive, 'Архив сегментов 20.11.2026', root);
  add(segment,'Веб-студии',outreach); add(oldFolder,'Веб-студии',archive);
  add(old,'Старая книга',oldFolder,sheetMime); add(company,'Компании',segment,sheetMime); add(lpr,'ЛПР',segment,sheetMime);
  const folder = id => ({getId:()=>id, getName:()=>meta.get(id).name, isTrashed:()=>false, getParents() {
    const ids = meta.get(id).parents.slice(); return {hasNext:()=>!!ids.length, next:()=>folder(ids.shift())};
  }});
  function sheet(name, id, rows) {
    return {getName:()=>name, getSheetId:()=>id, getLastRow:()=>rows.length, getLastColumn:()=>rows[0]?.length || 0,
      getRange(start,col,height,width) { return {getDisplayValues:()=>rows.slice(start-1,start-1+height).map(row=>Array.from({length:width},(_,i)=>String(row[col+i-1]||'')))}; }};
  }
  function book(id, kind, records, email, phones) {
    const fields = JSON.parse(JSON.stringify(c.segmentRecordsSchema_(kind)));
    const main = sheet(kind === 'companies' ? 'Компании' : 'ЛПР', 1, [fields.map(pair=>pair[1]), ...records.map(row=>fields.map(([key])=>row[key] || ''))]);
    const emailSheet = sheet('Email', 2, [['Email','Компания / ЛПР','Провайдер'],...email]);
    const phoneSheet = sheet('Телефоны', 3, [['Телефон','Telegram','ID_TG'],...phones]);
    const tabs = [main,emailSheet,phoneSheet];
    books.set(id, {getSheetByName:name=>tabs.find(s=>s.getName()===name) || null, getSheets:()=>tabs});
  }
  book(company,'companies', [{name:'Первая компания', city:'Москва', emails:'existing@example.test'}], [['existing@example.test']], []);
  book(lpr,'lpr',[],[['existing@example.test']],[]);
  book(old,'companies', [{name:'Первая компания', city:'Москва', emails:'existing@example.test'}, {name:'Вторая компания',city:'Москва',emails:'NEW@example.test; master@example.test'}],
    [['Existing@example.test'],['NEW@example.test','Один','fake@example.test'],['new@example.test','Два']], [['8 (999) 123-45-67','@example_name','999888777666']]);
  const current = { rootId:root, properties:{ getProperty:()=>null } };
  const scope = () => ({folder:folder(segment),storage:{public:{id:service},relationsSheet:{}},tracking:{loads:[]},
    files:Object.fromEntries([['companies',company],['lpr',lpr]].map(([kind,id])=>[kind,{id,version:'1',metadata:meta.get(id)}]))});
  c.digest_ = s=>crypto.createHash('sha256').update(s).digest('base64url');
  c.fail_ = (code,message)=>{throw Object.assign(new Error(message),{registryCode:code});};
  c.id_ = id=>{assert.match(id,/^[a-z0-9_-]{10,}$/);return id;};
  c.spreadsheetUrl_ = id=>'https://docs.google.com/spreadsheets/d/'+id+'/edit';
  c.byName_ = (a,b)=>a.name.localeCompare(b.name);
  c.api_ = fn=>fn(); c.authorize_=()=>current;
  c.registryRequireSegment_=(_,id)=>{if(projects.get(id)!=='numshield') c.fail_('OUTSIDE_PROJECT','wrong project');};
  c.registrySegmentProject_=(_,id)=>projects.get(id)||null;
  c.segmentSourceFolder_=()=>folder(outreach);
  c.insideRegistry_=(f,r)=>f.getId()===r;
  c.segmentCardFiles_=scope;
  c.segmentCardTabs_=(_,scope,kind)=>({email:books.get(scope.files[kind].id).getSheetByName('Email'),telegram:books.get(scope.files[kind].id).getSheetByName('Телефоны')});
  c.Drive={Files:{list(options) {
    const parent=options.q.match(/'([^']+)' in parents/)[1], mime=options.q.match(/mimeType = '([^']+)'/)[1];
    return {files:[...meta.values()].filter(f=>f.parents.includes(parent)&&f.mimeType===mime)};
  }}};
  c.SpreadsheetApp={openById(id) { opened.push(id); assert.ok(books.has(id)); return books.get(id); }};
  c.SOURCE_BASES_SCHEMA={relationsHeaders:[]}; c.sourceBasesReadRows_=()=>({rows:[]});
  const run = args=>JSON.parse(JSON.stringify(c.getSegmentLegacyPreview_({segmentId:segment,...args})));
  return {c,segment,old,company,lpr,root,outreach,oldFolder,projects,meta,opened,add,scope,run};
}

test('discovers an archived namesake without opening prospect sheets, then compares contact reports and master-only additions', () => {
  const f=fixture();
  assert.deepEqual(f.run({}).sources.map(s=>[s.id,s.location]), [[f.old,'archive']]);
  assert.deepEqual(f.opened,[]);
  const result=f.run({sourceId:f.old}).preview;
  assert.equal(result.complete,true);
  assert.deepEqual(result.channels.email,{rows:4,unique:3,duplicates:1,existing:1,added:2});
  assert.deepEqual(result.channels.telegram,{rows:1,unique:1,duplicates:0,existing:0,added:1});
  assert.deepEqual(result.entities,{companies:1,people:0,additions:1,ambiguous:0});
  assert.deepEqual(f.run({sourceId:f.old}).preview,result);
});

test('uncertain or other-project archive provenance prevents reading a selected file', () => {
  const f=fixture();
  f.add('another_project_folder','Веб-студии',f.outreach);
  assert.equal(f.run({}).sources.length,0);
  assert.throws(()=>f.run({sourceId:f.old}),{registryCode:'OUTSIDE_SEGMENTS'});
  f.meta.delete('another_project_folder'); f.projects.set(f.oldFolder,'neosender');
  assert.throws(()=>f.run({sourceId:f.old}),{registryCode:'OUTSIDE_SEGMENTS'});
  f.projects.set(f.segment,'neosender');
  assert.throws(()=>f.run({sourceId:f.old}),{registryCode:'OUTSIDE_PROJECT'});
  assert.deepEqual(f.opened,[]);
});

test('rejects unrelated IDs and active books and detects a changed source before releasing counts', () => {
  const f=fixture();
  assert.throws(()=>f.run({sourceId:'unrelated_book_0123'}),{registryCode:'OUTSIDE_SEGMENTS'});
  assert.throws(()=>f.run({sourceId:f.company}),{registryCode:'OUTSIDE_SEGMENTS'});
  assert.deepEqual(f.opened,[]);
  const read=f.c.segmentLegacyCompare_;
  f.c.segmentLegacyCompare_=(...args)=>{
    const value=read(...args), old=f.meta.get(f.old);
    f.meta.set(f.old,{...old,version:'2'});return value;
  };
  assert.throws(()=>f.run({sourceId:f.old}),{registryCode:'SOURCE_CHANGED'});
});

test('an unassigned archive cannot be adopted by Neo Sender even with a unique active segment name', () => {
  const f=fixture();
  f.projects.set(f.segment,'neosender');
  f.c.registryRequireSegment_=(_,id)=>assert.equal(f.projects.get(id),'neosender');
  assert.equal(f.run({}).sources.length,0);
  f.projects.set(f.oldFolder,'neosender');
  assert.deepEqual(f.run({}).sources.map(source=>source.id),[f.old]);
});

test('a missing working book keeps existing and new totals unknown and still shows recognized source rows', () => {
  const f=fixture();
  f.c.segmentCardFiles_=()=>{const scope=f.scope();scope.files.lpr=null;return scope;};
  const result=f.run({sourceId:f.old}).preview;
  assert.equal(result.complete,false);
  assert.equal(result.channels.email.unique,3);
  assert.equal(result.channels.email.existing,null);assert.equal(result.channels.email.added,null);
  assert.equal(result.entities.companies,null);
});

test('draft comparison honors canonical output, existing contacts in either working list and repeats in initial rows', () => {
  const f=fixture(), ctx=f.c.authorize_(), draft={section:'companies'};
  const model={
    complete:true, sourceSheets:[{sheetId:7,section:'companies'}],
    records:[
      { source:{fileId:f.old,sheetId:7,row:2}, company:{name:'Новая',city:'Москва'}, people:[],
        general:{emails:['EXISTING@example.test','fresh@example.test','outside-report@example.test'],phones:[],telegrams:[]} },
      { source:{fileId:f.old,sheetId:7,row:3},company:{name:'Вторая',city:'Москва'},people:[],
        general:{emails:['fresh@example.test'],phones:[],telegrams:[]} }
    ],
    email:{headers:['Email','Валидация'],rows:[['existing@example.test',''],['fresh@example.test','']]},
    phone:{headers:['Телефон','Telegram'],rows:[]},
    contactIndex:[{type:'email',value:'fresh@example.test',sourceRefs:[{row:2},{row:3}],needsReview:true}]
  };
  const compare=target=>JSON.parse(JSON.stringify(f.c.preparedSegmentDelta_(ctx,model,{...target,targetKind:'companies'},draft)));
  const result=compare({segmentId:f.segment});
  assert.deepEqual(result,{available:true,companiesAdded:2,companiesUpdated:0,peopleAdded:0,peopleUpdated:0,contactsAdded:1,contactDuplicates:2,review:1});
  const empty=compare({newSegment:true});
  assert.equal(empty.contactsAdded,2);assert.equal(empty.contactDuplicates,1);
  assert.equal(model.records[0].general.emails.length,3);
  assert.throws(()=>compare({newSegment:true,segmentId:f.segment}),{registryCode:'INVALID_REQUEST'});
});

test('auto-route draft keeps a named person without contacts and rejects other-project targets', () => {
  const f=fixture(), ctx=f.c.authorize_();
  const model={complete:true,records:[{source:{fileId:f.old,sheetId:4,row:2},company:{name:'Заказчик'},general:{},
    people:[{name:'Имя Фамилия',role:'Директор'}]}],sourceSheets:[{sheetId:4,section:'lpr'}],
    email:{headers:['Email'],rows:[]},phone:{headers:['Телефон','Telegram'],rows:[]}};
  const draft={routeMode:'auto'}, delta=(from,target)=>f.c.preparedSegmentDelta_(ctx,from,{...target,targetKind:'auto'},draft);
  assert.equal(delta(model,{newSegment:true}).peopleAdded,1);
  assert.equal(delta({...model,complete:false},{newSegment:true}).available,false);
  f.projects.set(f.segment,'neosender');
  assert.throws(()=>delta(model,{segmentId:f.segment}),{registryCode:'OUTSIDE_PROJECT'});
});
