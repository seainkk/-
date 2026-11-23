import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const rootId = 'registry_root_123456', segmentId = 'kitchens_segment_123456';
const target = { fileId: 'companies_book_123456', sheetId: 17 };
const binding = { segmentId, campaignId: '550e8400-e29b-41d4-a716-446655440000', campaignName: 'Кухни', campaignStatus: 'Active' };
const digest = key => crypto.createHash('sha256').update(key).digest('base64url');
const plain = obj => JSON.parse(JSON.stringify(obj));
const lead = (email, extra = {}) => ({ email, company: 'Компания', firstName: 'Имя', lastName: 'Фамилия',
  status: 'Not contacted', sentCount: 0, replied: false, bounced: false, doNotSend: false, ...extra });

function fixture() {
  const env = vm.createContext({ console });
  for (const file of ['Config.gs','Code.gs','ContactSync.gs','Promouser.gs','ColdyCampaigns.gs','ColdyRecipientSheet.gs']) {
    vm.runInContext(readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'), env);
  }
  const rows = [['Статус', 'Email', 'Компания', 'Пользовательский расчёт', 'Валидация']];
  const formulas = new Map(), notes = new Map(), validations = [];
  const state = { rootId, segmentId, fileId: target.fileId, targets: { emailSheetId: target.sheetId }, role: 'segment-companies', known: [] };
  let locked = false, version = 1;
  const call = { committed: 0, dropAck: false, scope: true, sheetId: target.sheetId, rowRead: null, lease: true, stateWrites:0, leaseChecks:[] };
  function rectangle(row, column, height, width, get) {
    return Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => get(row + y, column + x)));
  }
  const sheet = {
    getLastColumn: () => rows[0].length, getLastRow: () => rows.length, getMaxColumns: () => 40, getMaxRows: () => 300,
    getSheetId: () => target.sheetId,
    getRange: (r, c, h, w) => ({
      getDisplayValues: () => rectangle(r,c,h,w,(y,x)=>String(rows[y-1]?.[x-1] ?? '')),
      getValues: () => { if (call.rowRead) call.rowRead(); return rectangle(r,c,h,w,(y,x)=>rows[y-1]?.[x-1] ?? ''); },
      getFormulas: () => rectangle(r,c,h,w,(y,x)=>formulas.get(y+':'+x) ?? ''),
      getNotes: () => rectangle(r,c,h,w,(y,x)=>notes.get(y+':'+x) ?? ''),
    }),
  };
  env.digest_=digest;
  env.segmentRecordsTargets_=()=>({tables:{companies:target.fileId,lpr:'lpr_book_123456'}});
  env.getContactWorkspace_=()=>({enrolled:true,canSync:true,role:state.role,segmentId,targets:{emailSheetId:call.sheetId}});
  env.gridFile_=()=>({context:{rootId}});
  env.SpreadsheetApp={openById:()=>({})};
  env.Utilities={getUuid:()=>crypto.randomUUID()};
  env.contactSyncAssertLease_=claim=>{ call.leaseChecks.push(locked); assert.equal(claim.leaseId,state.lease.id); if(!call.lease) throw Error('lease lost'); };
  env.contactSyncMetadata_=()=>({version,id:target.fileId,parents:[segmentId],mimeType:env.REGISTRY_CONFIG.spreadsheetMime,capabilities:{canEdit:true},appProperties:{
    registrySegmentMasterRoot:rootId,registrySegmentMasterSegment:segmentId,registrySegmentMasterKind:'companies',
    registryContactRoot:rootId,registryContactEmailSheetId:String(call.sheetId)
  }});
  env.contactSyncReadState_=()=>state;
  env.gridSheet_=()=>sheet;
  env.contactSyncSaveState_=()=>{call.stateWrites++;};
  env.locked_=cb=>{assert.equal(locked,false); locked=true; try{return cb();}finally{locked=false;}};
  env.sheetRawBatchWrite_=(fileId,requests)=>{
    assert.ok(locked); assert.equal(fileId,target.fileId);
    for(const {updateCells:op,setDataValidation} of requests){
      if(setDataValidation){validations.push(plain(setDataValidation));continue;}
      if(!op)continue;
      for(const [y,line] of op.rows.entries()){
        const r=op.start.rowIndex+y; rows[r]??=[];
        for(const [x,entry] of line.values.entries()){
          const c=op.start.columnIndex+x;
          assert.equal(formulas.has((r+1)+':'+(c+1)), false, 'formula must never be overwritten');
          rows[r][c]=entry.userEnteredValue.stringValue ?? entry.userEnteredValue.numberValue;
          if(entry.note)notes.set((r+1)+':'+(c+1),entry.note);
        }
      }
    }
    version++; call.committed++; if(call.dropAck){call.dropAck=false;throw Error('unknown acknowledgement');}
  };
  const run=(records, config={})=>env.coldyRecipientSheetWrite_({rootId},config.binding||binding,config.kind||'companies',config.target||target,records,
    ()=>{if(!call.scope)throw Error('scope changed');},config.before,config.existingOnly ? {existingOnly:true} : undefined);
  const named=(row,field)=>rows[row-1][rows[0].indexOf(field)];
  const field=(row,key)=>named(row,env.COLDY_RECIPIENT_COLUMNS[key]+' · '+binding.campaignName);
  return {env,rows,formulas,notes,validations,state,call,run,named,field,change:()=>{version++;}};
}

test('adds numeric per-recipient statistics, names and statuses, keeping filters, validation and formulas',()=>{
  const f=fixture();
  f.rows.push(['фильтр','SEEN@example.test','Ручное имя','4','Валиден']);
  f.formulas.set('2:4','=2+2');
  f.state.known.push(digest('email:removed@example.test'));
  const records=[lead('seen@example.test',{status:'Replied',sentCount:3,replied:true}),lead('waiting@example.test'),
    lead('blocked@example.test',{bounced:true,doNotSend:true,status:'Bounce',company:'=literal'}),lead('removed@example.test')];
  const result=plain(f.run(records));
  assert.deepEqual(result,{...target,processed:4,appended:2,existing:1,excluded:1});
  assert.deepEqual(f.rows[1].slice(0,5),['фильтр','SEEN@example.test','Ручное имя','4','Валиден']);
  assert.equal(f.field(2,'sent'),3);assert.equal(f.field(2,'replied'),'Да');assert.equal(f.field(3,'status'),'Пока не связались');
  assert.equal(f.field(3,'campaign'),'Активна');assert.equal(f.rows[2][0],'в рассылке');
  assert.equal(f.rows[3][0],'фильтр');assert.equal(f.field(4,'stopped'),'Да');assert.equal(f.field(4,'bounced'),'Да');
  assert.equal(f.rows[3][2],'=literal');assert.equal(f.validations.length,1);
  assert.deepEqual(plain(f.run(records)),{...target,processed:4,appended:0,existing:3,excluded:1});assert.equal(f.call.committed,1);
  assert.equal(f.state.known.includes(digest('email:waiting@example.test')),true);
});

test('retries a lost acknowledgement without duplicate addresses and without losing later manual or provider history',()=>{
  const f=fixture();
  f.call.dropAck=true;
  const item=lead('a@example.test',{status:'Replied',sentCount:4,replied:true});
  assert.throws(()=>f.run([item]),/unknown acknowledgement/);
  const firstCounts=[];const retry=f.run([item],{before:r=>firstCounts.push(r.existing)});
  assert.equal(retry.appended,0);assert.deepEqual(firstCounts,[1]);assert.equal(f.rows.length,2);
  f.rows[1][0]='фильтр';
  f.run([lead(item.email,{sentCount:null,replied:null,bounced:null})]);
  assert.equal(f.rows[1][0],'фильтр');assert.equal(f.field(2,'sent'),4);assert.equal(f.field(2,'replied'),'Да');assert.equal(f.field(2,'status'),'Получен ответ');
});

test('two campaigns targeting the same address retain independently addressable columns, including after a campaign rename',()=>{
  const f=fixture();f.run([lead('a@example.test',{sentCount:4,status:'Sent'})]);
  const oldWidth=f.rows[0].length;
  const second={...binding,campaignId:'550e8400-e29b-41d4-a716-446655440001',campaignName:'Кухни'};
  f.run([lead('a@example.test',{sentCount:2,status:'Sent'})],{binding:second});
  assert.equal(f.rows[0].length,oldWidth+6);assert.equal(f.field(2,'sent'),4);
  assert.equal(f.named(2,'Автописьма отправлены · Кухни ['+second.campaignId+']'),2);
  const count=f.rows[0].length;
  f.run([lead('a@example.test',{sentCount:5,status:'Sent'})],{binding:{...binding,campaignName:'Новое имя'}});
  assert.equal(f.rows[0].length,count);assert.equal(f.field(2,'sent'),5);
  assert.equal(f.named(2,'Coldy: рассылки').split('\n').length,2);
});

test('rejects stale IDs, lost access, simultaneous manual edits, invalid pages and tombstone resurrection',()=>{
  const f=fixture(), entry=lead('a@example.test');
  f.call.sheetId=2;assert.throws(()=>f.run([entry]),/COLDY_TARGET_CHANGED/);
  f.call.sheetId=target.sheetId;f.call.scope=false;assert.throws(()=>f.run([entry]),/scope changed/);
  f.call.scope=true;f.call.lease=false;assert.throws(()=>f.run([entry]),/lease lost/);
  f.call.lease=true;assert.throws(()=>f.run([entry,entry]),/COLDY_RESPONSE/);
  f.state.job={};assert.throws(()=>f.run([entry]),/BUSY/);f.state.job=null;
  f.rows.push(['новый',entry.email]);f.call.rowRead=f.change;assert.throws(()=>f.run([entry]),/CONFLICT/);
  assert.equal(f.call.committed,0);
});

test('verifies both the original physical route and a revision change while persisting the expected page counts',()=>{
  const f=fixture();
  assert.deepEqual(plain(f.env.coldyRecipientSheetTarget_({rootId},binding,'companies')),target);
  f.call.sheetId=35;
  assert.throws(()=>f.env.coldyRecipientSheetTarget_({rootId},binding,'companies'),/COLDY_TARGET_CHANGED/);
  f.call.sheetId=target.sheetId;
  assert.throws(()=>f.run([lead('a@example.test')],{before:()=>f.change()}),/CONFLICT/);
  assert.equal(f.call.committed,0);
});

test('existing Coldy updates reuse lease metadata and only query grid bounds for dimensions that grow',()=>{
  const f=fixture(), sheet=f.env.gridSheet_(), entry=lead('growth@example.test');
  const calls={rows:0,cols:0,metadata:0}, extensions=[];
  sheet.getMaxColumns=()=>{calls.cols++;return f.rows[0].length;};
  sheet.getMaxRows=()=>{calls.rows++;return f.rows.length;};
  const metadata=f.env.contactSyncMetadata_,write=f.env.sheetRawBatchWrite_;
  f.env.contactSyncMetadata_=(...args)=>{calls.metadata++;return metadata(...args);};
  f.env.sheetRawBatchWrite_=(id,requests)=>{
    extensions.push(...requests.filter(r=>r.appendDimension).map(r=>plain(r.appendDimension)));
    write(id,requests);
  };
  f.run([entry],{before:()=>{}});
  assert.deepEqual(calls,{rows:1,cols:1,metadata:5});
  assert.deepEqual(extensions,[
    {sheetId:target.sheetId,dimension:'COLUMNS',length:f.rows[0].length-5},
    {sheetId:target.sheetId,dimension:'ROWS',length:1}
  ]);
  f.run([lead(entry.email,{sentCount:1,status:'Sent'})],{existingOnly:true});
  assert.deepEqual(calls,{rows:1,cols:1,metadata:9});
  assert.equal(f.field(2,'sent'),1);
  // The manual journal callback can race a sheet edit even on a retry with nothing to write.
  assert.throws(()=>f.run([lead(entry.email,{sentCount:1,status:'Sent'})],{before:f.change}),/CONFLICT/);
  assert.equal(f.call.committed,2);
});

test('recipient reconciliation waits for an unfinished contact job without taking its lease or changing its checkpoint',()=>{
  for(const existingOnly of [true,false]){
    const f=fixture(), entry=lead('waiting@example.test');
    f.rows.push(['новый',entry.email]);
    f.state.job={requestId:'existing-contact-request',cursor:23,error:'PRIOR_FAILURE'};
    for(const remaining of [-1000,60000]){
      f.state.lease={id:'previous-lease',until:Date.now()+remaining};
      const original=plain(f.state);
      assert.throws(()=>f.run([entry],{existingOnly}),{registryCode:existingOnly?'CONTACT_SYNC_JOB_ACTIVE':'BUSY'});
      assert.deepEqual(f.state,original);
    }
    assert.equal(f.call.stateWrites,0);
    assert.equal(f.call.committed,0);
    f.state.job=null;
    assert.throws(()=>f.run([entry],{existingOnly}),{registryCode:'BUSY'});
    assert.equal(f.call.stateWrites,0);
    delete f.state.lease;
    f.run([entry],{existingOnly});
    assert.equal(f.call.committed,1);
  }
});

test('an unchanged background batch validates access, lease and version outside the commit lock',()=>{
  const f=fixture(), entry=lead('stable@example.test'), auto={existingOnly:true};
  f.rows.push(['новый',entry.email]);
  assert.equal(f.run([entry],auto).unchangedVersion,undefined);
  assert.deepEqual(f.call.leaseChecks,[true]);
  assert.ok(f.run([entry],auto).unchangedVersion);
  assert.deepEqual(f.call.leaseChecks,[true,false]);
  let journaled=false;
  f.run([entry],{...auto,before:()=>{journaled=true;}});
  assert.equal(journaled,true);assert.equal(f.call.leaseChecks.at(-1),true);
  f.call.lease=false;
  assert.throws(()=>f.run([entry],auto),/lease lost/);
  f.call.lease=true;f.call.rowRead=f.change;
  assert.throws(()=>f.run([entry],auto),/CONFLICT/);
  f.call.rowRead=()=>{f.call.scope=false;};
  assert.throws(()=>f.run([entry],auto),/scope changed/);
  assert.equal(f.call.committed,1);
});

test('background sync only touches matching existing email rows and owned facts, preserving filters, names and formulas',()=>{
  const f=fixture(), auto={existingOnly:true};
  const emptyWidth=f.rows[0].length;
  const miss=f.run([lead('absent@example.test')],auto);
  assert.equal(miss.excluded,1);assert.equal(f.call.committed,0);assert.equal(f.rows[0].length,emptyWidth);
  f.rows.push(['не отправляем','manual@example.test','','','Валиден'],['новый','seen@example.test','Вручную']);
  const suppressed=lead('seen@example.test',{status:'Replied',sentCount:3,replied:true,blacklisted:true});
  f.run([suppressed,lead('manual@example.test'),lead('absent@example.test')],auto);
  assert.equal(f.rows.length,3);assert.equal(f.rows[1][2],'');assert.equal(f.rows[1][0],'не отправляем');
  assert.equal(f.field(2,'status'),'Не отправляем');assert.equal(f.field(3,'status'),'Не отправляем');
  assert.equal(f.field(3,'sent'),3);assert.equal(f.field(3,'replied'),'Да');assert.equal(f.rows[2][0],'фильтр');
  assert.equal(f.env.pvExcludedStatus_('Не отправляем',true),true);
  assert.equal(f.env.pvExcludedStatus_('  Не отправлять '),true);
  const commits=f.call.committed;
  f.run([suppressed],auto);assert.equal(f.call.committed,commits);
  f.run([lead('seen@example.test',{status:'Replied',sentCount:3,replied:true})],auto);
  assert.equal(f.field(3,'status'),'Не отправляем');
  f.run([{...suppressed,blacklisted:false}],auto);
  assert.equal(f.field(3,'status'),'Получен ответ');assert.equal(f.rows[2][0],'фильтр');
  f.formulas.set('3:1','=manual_status()');
  f.run([{...suppressed,doNotSend:true,blacklisted:false}],auto);
  assert.equal(f.field(3,'stopped'),'Да');assert.equal(f.field(3,'status'),'Не отправляем');
});

test('historical blacklist receipts write a suppression without claiming that a rejected contact joined the campaign',()=>{
  const f=fixture(), auto={existingOnly:true};
  f.rows.push(['новый','rejected@example.test','Ручное имя']);
  const rejected={email:'rejected@example.test',suppressionOnly:true,blacklisted:true};
  f.run([lead('unknown@example.test'),rejected],auto);
  assert.equal(f.rows.length,2);assert.equal(f.rows[1][0],'фильтр');
  assert.equal(f.rows[0].includes('Coldy: рассылки'),false);
  assert.match(f.named(2,'Coldy: статус'),/Не отправляем/);
  f.run([rejected],auto);assert.equal(f.call.committed,1);
});
