import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {gzipSync, gunzipSync} from 'node:zlib';
import vm from 'node:vm';

const root = 'registry_root_12345', segment = 'segment_kitchens_12345', service = 'source_registry_12345';
const companies = 'company_contact_12345', lpr = 'people_contact_12345';
const campaignId = '550e8400-e29b-41d4-a716-446655440000';
const digest = value => createHash('sha256').update(value).digest('base64url');
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const c = vm.createContext({});
  for (const file of ['Config', 'Promouser', 'ColdyCampaigns', 'ColdyRecipientSheet', 'SegmentContactCard'])
    vm.runInContext(readFileSync(new URL('../src/' + file + '.gs', import.meta.url), 'utf8'), c);
  const state = {project: 'numshield', permitted: true, sources: [companies, lpr], reads: 0, shared: {}, privateReads: 0};
  const marker = 'registry/coldy-recipient/v1/' + campaignId + '/';
  const headers = ['Email','Компания / ЛПР','Статус рассылки','Валидация','Проверить принадлежность',c.COLDY_CAMPAIGNS.headers[0],
    'Статус контакта · Кухни','Счётчик','Ответ','Лишнее','Исходный столбец email'];
  const phoneHeaders = ['Телефон','Компания / ЛПР','Статус рассылки','Валидация','Telegram','Тип контакта'];
  const books = {}, meta = {};
  const throwCode = (code, message) => {throw Object.assign(new Error(message), {registryCode: code});};
  function sheet(id, name, data, notes = {}) {
    return {getName: () => name, getSheetId: () => id, getLastRow: () => data.length, getLastColumn: () => data[0].length,
      getRange: (row, col, n, width) => {
        const matrix = f => Array.from({length: n}, (_, i) => Array.from({length: width}, (_, j) => f(row+i-1,col+j-1)));
        return {getDisplayValues: () => {state.reads++; return matrix((r,k) => String(data[r]?.[k] ?? ''));},
          getNotes: () => matrix((r,k) => notes[r+':'+k] || '')};
      }};
  }
  function book(id, kind, email, phone) {
    const tabs = [email, phone];
    books[id] = {getSheets: () => tabs};
    meta[id] = {id, name: kind, version: '8', mimeType: 'sheet', parents: [segment], appProperties: {
      registrySegmentMasterRoot: root, registrySegmentMasterSegment: segment, registrySegmentMasterKind: kind,
      registryContactRoot: root, registryContactEmailSheetId:'1', registryContactPhoneSheetId:'2'}};
  }
  const members = 'Кухни [' + campaignId + ']';
  book(companies,'companies',sheet(1,'Email',[headers,
    ['SHARED@example.org','ООО Пример','фильтр','Валиден','',members,'Письмо отправлено',3,'Да','','Рабочая почта'],
    ['prepared@example.org','А','Новый контакт'],
    ['check@example.org','Б','Новый контакт'],
    ['review@example.org','В','Новый контакт','Валиден','Да'],
    ['stale@example.org','Г','Новый контакт','Валиден'],
    ['wait@example.org','Д','Новый контакт']],
    {'0:6':marker+'status','0:7':marker+'sent','0:8':marker+'replied',
      '5:3':c.PROMOUSER.bindingPrefix+digest('foreigncontact')}),
    sheet(2,'Телефоны',[phoneHeaders,['8 (999) 111-22-33','Б','Новый контакт'],['+74951234567','Б','Новый контакт'],
      ['','А','Новый контакт','','@sample_name'],['+79992224455','А','Новый контакт']]));
  book(lpr,'lpr',sheet(1,'Email',[headers,['shared@example.org','Анна','Новый контакт','Валиден'],['prepared@example.org','Пётр','Новый контакт']]),
    sheet(2,'Телефоны',[phoneHeaders]));
  meta[service] = {id:service, version:'2'};
  const cache = new Map();
  const fakeCache = {get:k=>cache.get(k),getAll:ks=>Object.fromEntries(ks.map(k=>[k,cache.get(k)])),
    put:(k,v)=>cache.set(k,v),putAll:data=>Object.entries(data).forEach(([k,v])=>cache.set(k,v))};
  const binding = {id:'binding_id', campaignId, campaignName:'Кухни', segmentId:segment, revision:'a'};
  const privateData = {bindingRevision:'a', lastIdentity:'fingerprint',policy:{identity:digest(JSON.stringify(['shared@example.org'])),emails:['shared@example.org']},checked:{
    companies:{fileId:companies,sheetId:1,version:'8',fingerprint:'fingerprint'}}};
  Object.assign(c,{digest_:digest,fail_:throwCode, api_: f => f(), id_:v=>v,segmentInput_:v=>v, authorize_:()=>({rootId:root,properties:{}}),
    registryRequireSegment_:() => {if (!state.permitted) throwCode('OUTSIDE_PROJECT','outside');},registryProjectId_:()=>state.project,
    registrySegmentProject_:()=>state.project,segmentSourceFolder_:()=>({}),segmentFolder_:()=>({getId:()=>segment,getName:()=>'Кухни'}),
    sourceBasesStorage_:()=>({public:{id:service}}),contactSyncMetadata_:id=>meta[id],contactSyncVersion_:m=>m.version,
    segmentTrackingStorage_:(_ctx,_storage,create)=>{assert.equal(create,false);return {tables:state.sources.map(id=>({fileId:id,segmentId:segment,kind:id===companies?'companies':'lpr'}))};},
    REGISTRY_CONFIG:{spreadsheetMime:'sheet'},CONTACT_SYNC:{maxTargetRows:100000,maxHeaderColumns:512},
    segmentFindSheet_:(book,id)=>book.getSheets().find(sheet=>sheet.getSheetId()===id),
    SpreadsheetApp:{openById:id=>books[id]},spreadsheetUrl_:id=>'https://docs.google.com/spreadsheets/d/'+id+'/edit',
    pvCache_:(_ctx,create)=>{assert.equal(create,false);return state.shared;},pvCacheRead_:mock=>mock,
    coldySettings_:()=>({key:'mock'}),coldyCampaignRegistry_:()=>({bindings:[binding],credentialHash:'scope'}),
    coldyIncomingOwner_:()=> 'owner',coldyIncomingMark_:()=>({state:'synced', lastSyncedAt:'2026-11-26T01:00:00Z'}),
    coldyStoreScope_:()=>({}),coldyFolder_:(_ctx,create)=>{assert.equal(create,false);return {id:'private'};},
    coldyStoreFile_:()=>({id:'private_poll',version:'1'}),coldyReadEnvelope_:()=>{state.privateReads++;return {data:privateData};},
    CacheService:{getScriptCache:()=>fakeCache}});
  state.shared[c.pvKey_('email','prepared@example.org')] = {result:{status:'Валиден'}};
  state.shared[c.pvKey_('email','wait@example.org')] = {pending:{id:'mock'}};
  state.shared[c.pvKey_('telegram','+79992224455')] = {result:{status:'Telegram: активен',eligible:true,idTg:'123'}};
  return {c,state,meta,privateData,run:(options={})=>plain(c.getSegmentContactCard_({segmentId:segment,...options}))};
}

function preparedFixture() {
  const f = fixture(), {c,state,meta} = f;
  vm.runInContext(readFileSync(new URL('../src/SegmentCardSnapshots.gs', import.meta.url), 'utf8'), c);
  const values = {COLDY_API_KEY:'mock', SOURCE_BASES_STORAGE_ID:service}, cache = new Map(), disk = new Map();
  const properties = {getProperties:()=>({...values}), getProperty:k=>values[k] ?? null, setProperty:(k,v)=>{values[k]=v;}};
  const context = {rootId:root, properties}, binding = c.coldyCampaignRegistry_().bindings[0];
  const blob = data=>({getBytes:()=>Buffer.from(data), getDataAsString:()=>Buffer.from(data).toString('utf8')});
  state.diskReads=0; state.diskWrites=0; state.metadataLists=0; state.hints=0; state.bound=true; state.ownedBy='numshield';
  Object.assign(c,{
    authorize_:()=>context, registryProjectScoped_:()=>true, registrySegmentProject_:()=>state.ownedBy,
    COLDY:{keyProperty:'COLDY_API_KEY'}, coldySettings_:()=>({key:values.COLDY_API_KEY,credentialHash:digest(values.COLDY_API_KEY)}),
    coldyCampaignRegistry_:()=>({credentialHash:digest(values.COLDY_API_KEY),bindings:state.bound?[binding]:[]}),
    segmentCardMaintenanceRequest_:()=>{state.hints++;},
    CacheService:{getScriptCache:()=>({get:k=>cache.get(k),getAll:ks=>Object.fromEntries(ks.map(k=>[k,cache.get(k)])),
      put:(k,v)=>cache.set(k,v),putAll:data=>Object.entries(data).forEach(([k,v])=>cache.set(k,v))})},
    Utilities:{newBlob:blob,gzip:b=>blob(gzipSync(b.getBytes())),ungzip:b=>blob(gunzipSync(b.getBytes())),
      base64Encode:bytes=>Buffer.from(bytes).toString('base64'),base64Decode:text=>Buffer.from(text,'base64')},
    Drive:{Files:{list:({q})=>{assert.ok(q.includes("'"+segment+"' in parents")); state.metadataLists++;
      return {files:[{id:segment,mimeType:'application/vnd.google-apps.folder',parents:[state.folderParent || root]},meta[companies],meta[lpr]]};}}},
    coldySave_:(ctx,kind,owner,body)=>{assert.equal(ctx,context);assert.equal(kind,'segmentcard');state.diskWrites++;disk.set(owner,plain(body));},
    coldyLoad_:(ctx,kind,owner)=>{assert.equal(ctx,context);assert.equal(kind,'segmentcard');state.diskReads++;return disk.get(owner);}
  });
  const dashboard=()=>plain(c.segmentCardDashboardPreviews_(context,
    {state:'ready',source:{id:root},items:[{id:segment,name:'Кухни',files:state.sources.map(id=>({id,parentId:segment}))}]},
    {available:true,tables:c.segmentTrackingStorage_(context,null,false).tables}, c.coldyCampaignRegistry_()));
  return {...f,values,cache,disk,context,dashboard,rebuild:(guard=()=>context)=>plain(c.segmentCardRefreshSnapshot_(context,segment,guard))};
}

test('prepared card survives cache eviction and serves the same filtered pages without reading contact sheets or campaign recipients',()=>{
  const f=preparedFixture(), baseline=f.run(), result=f.rebuild();
  const reads=f.state.reads, recipients=f.state.privateReads;
  assert.equal(result.rebuilt,true);assert.equal(result.revision,baseline.revision);
  assert.equal(f.state.diskWrites,1);assert.equal(f.rebuild().rebuilt,false);assert.equal(f.state.diskWrites,1);
  const preview=f.dashboard()[segment];
  assert.equal(preview.preview,true);assert.equal(preview.prepared,true);assert.deepEqual(preview.summary,baseline.summary);
  assert.equal(preview.rows.length,baseline.rows.length);assert.equal(f.state.metadataLists,1);
  assert.equal(f.state.diskReads,0);assert.equal(f.state.reads,reads);
  f.cache.clear();
  assert.deepEqual(f.dashboard(),{});assert.equal(f.state.diskReads,0);
  const page=f.run({prepared:true,channel:'email',offset:2,limit:1,revision:result.revision});
  assert.equal(page.prepared,true);assert.ok(Date.parse(page.checkedAt));assert.deepEqual(page.summary,baseline.summary);
  assert.equal(page.rows[0].value,baseline.rows[2].value);assert.ok(page.rows[0].sources.every(s=>s.sourceType==='working'));
  assert.equal(f.state.diskReads,1);assert.equal(f.state.reads,reads);assert.equal(f.state.privateReads,recipients);
  assert.equal(f.rebuild().rebuilt,false);assert.equal(f.state.diskWrites,1);assert.equal(f.dashboard()[segment].revision,result.revision);
  assert.doesNotMatch(JSON.stringify(f.values),/@example/);
});

test('prepared browsing enforces current ownership, master tags, provider assignment and scope when cache is warm',()=>{
  const f=preparedFixture(), revision=f.rebuild().revision;
  f.state.folderParent='outside';assert.deepEqual(f.dashboard(),{});f.state.folderParent=root;
  f.meta[companies].parents=[root];assert.deepEqual(f.dashboard(),{});
  assert.throws(()=>f.run({prepared:true}),{registryCode:'OUTSIDE_SEGMENTS'});f.meta[companies].parents=[segment];
  f.meta[lpr].appProperties.registryPrivateRole='private';assert.deepEqual(f.dashboard(),{});
  delete f.meta[lpr].appProperties.registryPrivateRole;
  f.meta[lpr].appProperties.registryContactEmailSheetId='33';assert.deepEqual(f.dashboard(),{});
  f.meta[lpr].appProperties.registryContactEmailSheetId='1';
  f.state.bound=false;assert.deepEqual(f.dashboard(),{});
  assert.throws(()=>f.run({prepared:true,revision}),{registryCode:'SEGMENT_CARD_CHANGED'});f.state.bound=true;
  f.values.COLDY_API_KEY='another';assert.deepEqual(f.dashboard(),{});f.values.COLDY_API_KEY='mock';
  f.state.project='neosender';assert.deepEqual(f.dashboard(),{});assert.throws(()=>f.rebuild(),{registryCode:'OUTSIDE_PROJECT'});
  f.state.project='numshield';f.state.permitted=false;
  assert.throws(()=>f.run({prepared:true}),{registryCode:'OUTSIDE_PROJECT'});
});

test('stale snapshots are excluded, strict reads see edits immediately, and a lost lease leaves the receipt unpublished',()=>{
  const f=preparedFixture(), first=f.rebuild(), slot=f.c.segmentCardSnapshotSlot_(f.context,segment), originally=f.values[slot.key];
  f.meta[lpr].version='9';
  assert.equal(f.run({prepared:true}).revision,first.revision);
  assert.throws(()=>f.run({revision:first.revision}),{registryCode:'SEGMENT_CARD_CHANGED'});
  let n=0;
  assert.throws(()=>f.rebuild(()=>{if(++n===2) throw new Error('lease');return f.context;}),/lease/);
  assert.equal(f.state.diskWrites,1);assert.equal(f.values[slot.key],originally);
  const expired=JSON.parse(originally);expired.checkedAt=new Date(Date.now()-86460000).toISOString();
  f.values[slot.key]=JSON.stringify(expired);assert.deepEqual(f.dashboard(),{});
  const current=f.run({prepared:true});assert.notEqual(current.prepared,true);assert.notEqual(current.revision,first.revision);assert.equal(f.state.hints,1);
});

test('a corrupted or superseded artifact never supplies contacts to the prepared route',()=>{
  const f=preparedFixture();f.rebuild();f.cache.clear();
  const [artifact]=f.disk.values();artifact.body='invalid';
  assert.notEqual(f.run({prepared:true}).prepared,true);assert.equal(f.state.hints,1);
  f.cache.clear();assert.equal(f.rebuild().rebuilt,true);assert.equal(f.state.diskWrites,2);
});

test('a successful poll with unchanged recipients keeps the prepared content version',()=>{
  const f=preparedFixture(), version=f.rebuild().revision;
  f.c.coldyIncomingMark_=()=>({state:'synced',lastSyncedAt:'2026-11-27T00:00:00Z'});
  assert.equal(f.rebuild().rebuilt,false);assert.equal(f.state.diskWrites,1);
  f.c.coldyStoreFile_=()=>({id:'private_poll',version:'2'});
  assert.notEqual(f.rebuild().revision,version);assert.equal(f.state.diskWrites,2);
});

test('working card keeps manual marks, sheet evidence, ownership and Coldy facts separate across both lists', () => {
  const f=fixture(), result=f.run(), shared=result.rows.find(row=>row.value==='shared@example.org');
  assert.equal(result.summary.email.total,6);
  assert.equal(result.summary.sharedEmail,2);
  assert.deepEqual(shared.manualStatuses,['фильтр','Новый контакт']);
  assert.deepEqual(shared.validationStatuses,['Валиден']);
  assert.deepEqual(shared.owners,['companies','lpr']);
  assert.equal(shared.ready,false);
  assert.deepEqual(shared.coldyStatuses,['Письмо отправлено','Получен ответ','Отправлено писем: 3']);
  assert.equal(shared.channelFacts[0].sent,3);assert.equal(shared.channelFacts[0].replied,true);
  assert.equal(shared.sources[0].column,'Рабочая почта');
  assert.match(shared.sources[0].url,/#gid=1&range=A2$/);
  assert.deepEqual(shared.sources.map(r=>r.ownerNames),[['ООО Пример'],['Анна']]);
  assert.deepEqual(f.run({queue:'inCampaign'}).rows.map(r=>r.value),['shared@example.org']);
});

test('saved, pending, mismatched and ambiguous results are excluded from inappropriate queues', () => {
  const {run}=fixture(), email = run({queue:'email'}), mobile = run({queue:'telegram'});
  assert.deepEqual(email.rows.map(row=>row.value),['check@example.org','stale@example.org']);
  assert.deepEqual(mobile.rows.map(row=>row.value),['+79991112233']);
  assert.deepEqual(run({queue:'ownership'}).rows.map(row=>row.value),['review@example.org']);
  assert.deepEqual(run({queue:'ready',channel:'email'}).rows.map(row=>row.value),['prepared@example.org']);
  const tg=run({queue:'ready',channel:'telegram'}).rows[0];
  assert.deepEqual(tg.channelFacts,[]);assert.deepEqual(tg.coldyStatuses,[]);
  assert.equal(tg.value,'+79992224455');
});

test('confirmed absence requires a complete matching recipient snapshot for this target and revision', () => {
  const f = fixture();
  assert.deepEqual(f.run({query:'check@example'}).rows[0].coldyStatuses,['Не найден в проверенной рассылке']);
  f.meta[companies].version = '9';
  assert.deepEqual(f.run({query:'check@example'}).rows[0].coldyStatuses,['Нет данных о сверке']);
  f.meta[companies].version='10';f.privateData.bindingRevision='detached';
  assert.deepEqual(f.run({query:'check@example'}).rows[0].coldyStatuses,['Нет данных о сверке']);
});

test('pagination and export share a scoped revision and never reuse revoked permissions or moved workbooks', () => {
  const f=fixture(), first=f.run({limit:1}), reads=f.state.reads;
  const second=f.run({offset:first.nextOffset,revision:first.revision,limit:1});
  assert.equal(f.state.reads,reads);assert.equal(f.state.privateReads,1);
  assert.notEqual(first.rows[0].value,second.rows[0].value);
  f.meta[lpr].version='9';
  assert.throws(()=>f.run({revision:first.revision}),{registryCode:'SEGMENT_CARD_CHANGED'});
  f.state.permitted=false;assert.throws(()=>f.run(),{registryCode:'OUTSIDE_PROJECT'});
  f.state.permitted=true;f.meta[lpr].parents=[root];assert.throws(()=>f.run(),{registryCode:'OUTSIDE_SEGMENTS'});
});

test('missing workbooks remain uncreated, and source mutations during the read fail before results are served', () => {
  const f=fixture();f.state.sources=[];
  const empty=f.run();assert.deepEqual(empty.rows,[]);assert.equal(empty.warnings.length,2);
  assert.deepEqual(empty.files,{companies:null,lpr:null});
  f.state.sources=[companies];
  const old=f.c.pvCacheRead_;f.c.pvCacheRead_=(v)=>{f.meta[companies].version='11';return old(v);};
  assert.throws(()=>f.run(),{registryCode:'SEGMENT_CARD_CHANGED'});
});

test('original row links require structured history, the enrolled owner, a live sheet and an authorized original',()=>{
  const {c,meta}=fixture(), original='original_source_12345', foreign='foreign_source_12345';
  for(const id of [original,foreign])meta[id]={id,name:'Исходник',parents:[id===original?segment:'other_segment'],mimeType:'sheet'};
  meta[companies].appProperties.registryContactStateId='private_journal';
  const scope={folder:{getId:()=>segment},storage:{public:{id:service}},files:{companies:{id:companies,metadata:meta[companies]},lpr:null}};
  const ctx={rootId:root};
  const local={id:companies,owner:'companies',ownerNames:['А'],sourceType:'working',history:true,url:'https://docs.google.com/spreadsheets/d/'+companies+'/edit#gid=1&range=A2'};
  const project=()=>{const rows=[{value:'a@example.org',channel:'email',sources:[{...local}]}];c.segmentCardOriginals_(ctx,scope,rows);return plain(rows[0].sources);};
  Object.assign(c,{contactSyncKey_:(_channel,value)=>'email:'+value,SOURCE_BASES_SCHEMA:{relationsHeaders:[]},sourceBasesReadRows_:()=>({rows:[]}),
    contactSyncReadState_:()=>({segmentId:segment,role:'segment-companies',targets:{emailSheetId:1},workingHistory:{
      'email:a@example.org':[{source:original,sourceSheet:4,refs:'6, 200'}, {source:original,sourceSheet:99,refs:'5'},
        {source:foreign,sourceSheet:4,refs:'9'}, {source:service,sourceSheet:4,refs:'9'}]}}),
    SpreadsheetApp:{openById:id=>{assert.equal(id,original);return {getSheets:()=>[{getName:()=>'Лист',getSheetId:()=>4,getLastRow:()=>12}]};}}});
  const links=project();
  assert.equal(links.length,2);assert.equal(links[0].sourceType,'source');assert.match(links[0].url,/#gid=4&range=A6$/);
  assert.equal(links[1].sourceType,'working');assert.equal(links[1].history,undefined);
  meta[original].parents=['moved_outside'];assert.deepEqual(project().map(e=>e.sourceType),['working']);
});
