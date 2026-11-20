import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const ROOT='coldy_validation_root_12345', A='coldy_validation_book_a_12345', B='coldy_validation_book_b_12345', SERVICE='coldy_validation_service_12345';
const KEY='coldy_fixture_secret_never_echo';
const EH=['Email','Компания / ЛПР','Исходные строки','Проверить принадлежность'];
const plain=v=>JSON.parse(JSON.stringify(v));

function fixture(options={}) {
 let now=Date.parse('2026-11-19T12:00:00Z'), seq=0, locked=false, allowed=true, root=ROOT, key=options.noKey?'':KEY, targetId=0, saveHook=null;
 const ledger=new Map(), books=new Map(), calls={http:[],writes:[],saves:[],reads:0,rows:0}, properties=new Map();
 class Clock extends Date {constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}
 const coded=(code,message)=>Object.assign(new Error(`[${code}] ${message}`),{registryCode:code});
 function sheet(gid,name,values=[]) {
  const data=values.map(line=>line.map(value=>({value,note:''})));let maxRows=1000,maxCols=40;
  const at=(r,col)=>data[r-1]?.[col-1]||{value:'',note:''};
  const put=(r,col,value,note)=>{data[r-1]||=[];data[r-1][col-1]={value,note:note===undefined?at(r,col).note:note};};
  return {getSheetId:()=>gid,getName:()=>name,getLastRow:()=>data.reduce((n,line,y)=>line?.some(c=>c?.value!=='')?y+1:n,0),getLastColumn:()=>Math.max(0,...data.map(line=>line.reduce((n,c,x)=>c?.value!==''?x+1:n,0))),getMaxRows:()=>maxRows,getMaxColumns:()=>maxCols,insertRowsAfter:(_,n)=>{maxRows+=n;},insertColumnsAfter:(_,n)=>{maxCols+=n;},setFrozenRows(){},getRange:(r,col,h,w)=>({getDisplayValues:()=>{calls.rows+=h;return Array.from({length:h},(_,y)=>Array.from({length:w},(_,x)=>String(at(r+y,col+x).value??'')));},getNotes:()=>Array.from({length:h},(_,y)=>Array.from({length:w},(_,x)=>at(r+y,col+x).note))}),data,at,put};
 }
 function book(id,emailRows) {const tabs=[sheet(0,'A renamed email target',emailRows),sheet(1,'Email',[['Not the managed target'],['wrong@example.test']]),sheet(2,'Телефоны',[['Телефон']])];const b={getId:()=>id,tabs,getSheets:()=>tabs,getSheetByName:name=>tabs.find(s=>s.getName()===name),insertSheet:name=>{const s=sheet(tabs.length+100,name);tabs.push(s);return s;}};books.set(id,b);return b;}
 book(A,options.rows||[EH,['a@example.test','Company A','','']]);book(B,options.otherRows||[EH]);
 const service=book(SERVICE,[]);service.tabs=[];service.getSheets=()=>service.tabs;service.getSheetByName=name=>service.tabs.find(s=>s.getName()===name);service.insertSheet=name=>{const s=sheet(100+service.tabs.length,name);service.tabs.push(s);return s;};
 const context={get rootId(){return root;},properties:{getProperty:k=>properties.get(k)??null,setProperty:(k,v)=>properties.set(k,v),deleteProperty:k=>properties.delete(k)}};
 const settings=()=>({key,configured:!!key,connected:!!key,credentialHash:key?digest(key):'',emailValidationProvider:options.preferred||'coldy',autoValidateEmails:false});
 const digest=value=>crypto.createHash('sha256').update(String(value)).digest('base64url');
 const scope=(id,write,expected)=>{calls.reads++;if(!allowed||![A,B].includes(id)||expected&&expected!==root)throw coded('OUTSIDE_REGISTRY','Scope changed');return{context,canEdit:true};};
 const c=vm.createContext({Date:Clock,Math,JSON,Number,Array,console:{warn(){}},
  api_:fn=>fn(),authorize_:()=>{if(!allowed)throw coded('OUTSIDE_REGISTRY','Scope changed');return context;},id_:v=>{if(typeof v!=='string'||v.length<10)throw coded('INVALID_REQUEST','Bad id');return v;},object_:v=>{if(!v||typeof v!=='object'||Array.isArray(v))throw coded('INVALID_REQUEST','Bad input');return v;},fail_:(code,message)=>{throw coded(code,message);},registryError_:coded,digest_:digest,
  locked_:fn=>{assert.equal(locked,false,'One shared global lock, never nested');locked=true;try{return fn();}finally{locked=false;}},gridFile_:scope,
  SpreadsheetApp:{openById:id=>books.get(id),flush(){}},gridSheet_:(b,gid)=>{const s=b.tabs.find(s=>s.getSheetId()===gid);if(!s)throw coded('GRID_SHEET_MISSING','Missing');return s;},getContactWorkspace_:({id})=>{scope(id,false);return{enrolled:true,targets:{emailSheetId:targetId,phoneSheetId:2}};},
  Utilities:{getUuid:()=>`coldy-request-${++seq}-unique`},
  sourceBasesStorage_:()=>({public:{id:SERVICE},book:service}),
  sheetWriteRawStrings_:(id,gid,r,col,values)=>{assert.ok(locked);const s=books.get(id).tabs.find(s=>s.getSheetId()===gid);values.forEach((line,y)=>line.forEach((v,x)=>s.put(r+y,col+x,v)));calls.writes.push({id,header:true,values:plain(values)});},
  Sheets:{Spreadsheets:{batchUpdate:(body,id)=>{assert.ok(locked);if(options.beforeWrite)options.beforeWrite({id,body,fixture:f});for(const request of body.requests){const u=request.updateCells,s=books.get(id).tabs.find(s=>s.getSheetId()===u.range.sheetId);u.rows.forEach((row,y)=>row.values.forEach((cell,x)=>s.put(u.range.startRowIndex+y+1,u.range.startColumnIndex+x+1,cell.userEnteredValue.stringValue,u.fields.includes('note')?cell.note:undefined)));}calls.writes.push({id,requests:plain(body.requests)});if(options.lostWrite&&id===A){options.lostWrite=false;throw new Error('Lost after write');}return{};}}},
  coldySettings_:()=>settings(),coldyCredentialHash_:()=>{if(!key)throw coded('COLDY_KEY_REQUIRED','Missing');return digest(key);},emailValidationProvider_:()=>options.preferred||'coldy',
  coldyLoad_:(ctx,kind,owner)=>{assert.equal(ctx.rootId,root);const value=ledger.get(kind+':'+owner);return value?plain(value):null;},
  coldySave_:(ctx,kind,owner,value)=>{assert.ok(locked);assert.equal(ctx.rootId,root);assert.equal(JSON.stringify(value).includes(KEY),false);ledger.set(kind+':'+owner,plain(value));calls.saves.push(plain(value));if(saveHook)saveHook(value);},
  coldyApi_:(ctx,method,path,payload,httpOptions)=>{assert.equal(locked,false,'No HTTP while lock held');scope(path, false);},
 });
 vm.runInContext(readFileSync(new URL('../src/Promouser.gs',import.meta.url),'utf8'),c);
 vm.runInContext(readFileSync(new URL('../src/ColdyValidation.gs',import.meta.url),'utf8'),c);
 c.coldyApi_=(ctx,method,path,payload,httpOptions)=>{
  assert.equal(locked,false,'No HTTP while lock held');assert.equal(ctx.rootId,ROOT);assert.equal(key,KEY);
  const call={method,path,payload:payload&&plain(payload),options:httpOptions&&plain(httpOptions)};calls.http.push(call);
  if(options.transport)return options.transport({...call,f});
  const state=f.ledger();const job=state.jobs.find(j=>j.dispatch?.token===state.lease?.token);
  if(method==='POST')return{batch_id:'batch-'+job.jobId,status:'queued',reserved_credits:3,item_count:payload.emails.length,unique_email_count:payload.emails.length};
  if(path.endsWith('/results'))return{batch_id:job.batchId,results:job.contacts.map(contact=>({email:contact.value,result:'valid'}))};
  return{batch_id:job.batchId,status:'completed',progress:100,reserved_credits:3,charged_credits:2};
 };
 const target=(id=A)=>books.get(id).tabs[0];
 const col=(name,id=A)=>target(id).getRange(1,1,1,target(id).getLastColumn()).getDisplayValues()[0].indexOf(name)+1;
 const f={c,context,calls,ledger:(id=A)=>plain(ledger.get('validation:'+id)),writeLedger:(state,id=A)=>ledger.set('validation:'+id,plain(state)),target,col,books,
  preview:(id=A)=>c.previewColdyValidation_({id}),queue:(id=A)=>c.queueColdyWorkbookValidation_(context,id),state:(id=A)=>c.getColdyValidationState_({id}),
  start:(preview=f.preview(),id=A,requestId=`start-${++seq}-unique`)=>c.startColdyValidation_({id,previewToken:preview.previewToken,requestId,acceptValidationCredits:true}),
  advance:(id=A)=>c.advanceColdyValidation_({id,requestId:`advance-${++seq}-unique`}),tick:ms=>{now+=ms;},now:()=>now,rotate:newKey=>{key=newKey;},revoke:()=>{allowed=false;},changeRoot:()=>{root='another_registry_root_12345';},targetId:value=>{targetId=value;},onSave:fn=>{saveHook=fn;},
  seed:(email,result)=>c.locked_(()=>{const cache=c.pvCache_(context,true),map=c.pvCacheRead_(cache);c.pvCachePut_(context,cache,map,c.pvKey_('email',email),'email',result);c.pvCacheFlush_(context,cache);}),
  reserve:(email,owner={fileId:B,jobId:'promouser-job',keyHash:'provider-key',at:now})=>c.locked_(()=>{const cache=c.pvCache_(context,true),map=c.pvCacheRead_(cache);c.pvCacheReserve_(cache,map,c.pvKey_('email',email),'email',owner);c.pvCacheFlush_(context,cache);}),
  cache:()=>c.pvCacheRead_(c.pvCache_(context,false)),coded,
 };
 return f;
}

function finish(f) { f.tick(15000); f.advance(); f.tick(15000); return f.advance(); }

test('managed sheet ID zero is used; the similarly named unmanaged tab is ignored',()=>{
 const f=fixture();const p=f.preview();assert.equal(p.counts.new,1);assert.deepEqual(plain(p.sample),['a@example.test']);assert.equal(f.target().getLastColumn(),4);assert.equal(f.calls.http.length,0);
});

test('manual source scanning and idle owner timer never create a paid job',()=>{
 const f=fixture();const s=f.queue();assert.equal(s.state,'awaiting_confirmation');assert.equal(s.jobs.length,0);assert.equal(f.calls.http.length,0);const rows=f.calls.rows;f.c.processColdyWorkbookValidation_(f.context,A);assert.equal(f.calls.rows,rows);assert.equal(f.calls.http.length,0);
});

test('an unconfigured Coldy hook leaves workbooks untouched and does not read contact rows',()=>{
 const f=fixture({noKey:true});const rows=f.calls.rows;const result=f.queue();assert.equal(result.state,'not_configured');assert.equal(f.calls.rows,rows);assert.equal(f.calls.saves.length,0);assert.equal(f.calls.writes.length,0);assert.equal(f.calls.http.length,0);
});

test('explicit credit consent and a current preview are required, without invented USD quotes',()=>{
 const f=fixture();const p=f.preview();assert.match(p.warnings.join(' '),/кредиты Coldy/);assert.equal(p.costUsd,undefined);assert.throws(()=>f.c.startColdyValidation_({id:A,previewToken:p.previewToken,requestId:'no-consent-request'}),/COLDY_CREDIT_CONSENT/);f.tick(15*60*1000);assert.throws(()=>f.start(p),/COLDY_PREVIEW_EXPIRED/);assert.equal(f.calls.http.length,0);
});

test('changed contacts invalidate the preview before any credit reservation or HTTP',()=>{
 const f=fixture();const p=f.preview();f.target().put(2,1,'new@example.test');assert.throws(()=>f.start(p),/COLDY_PREVIEW_CHANGED/);assert.equal(f.calls.http.length,0);assert.equal(Object.values(f.cache()).some(e=>e.pending),false);
});

test('all completed outcomes, manual exclusions, notes and campaign statuses are preserved',()=>{
 const statuses=['Валиден','Невалиден','Неизвестно','Принимает все письма','Одноразовый ящик','Исключено вручную'];
 const f=fixture({rows:[[...EH,'Валидация','Провайдер','Заказ Promouser','Рассылка'],...statuses.map((s,i)=>[`p${i}@example.test`,'A','','',s,'Known provider','old-order','Запущен'])]});
 f.target().put(2,5,'Валиден','manual note');const before=plain(f.target().data);const p=f.preview();assert.equal(p.counts.checked,6);assert.equal(p.counts.new,0);f.queue();assert.equal(f.calls.http.length,0);for(let i=1;i<before.length;i++)assert.deepEqual(f.target().data[i].slice(0,8),before[i]);assert.equal(f.ledger().jobs.length,0);
});

test('legacy completed provider reports and a duplicate checked later in the sheet prevent new billing',()=>{
 const f=fixture({rows:[[...EH,'result','provider'],['a@example.test','A','','','',''],['a@example.test','B','','','invalid','Old']]});const p=f.preview();assert.equal(p.counts.new,0);assert.equal(p.counts.checked,1);f.queue();assert.equal(f.target().at(2,f.col('Валидация')).value,'Невалиден');assert.equal(f.calls.http.length,0);
});

test('a completed Promouser shared cache result is reused without paying Coldy',()=>{
 const f=fixture();f.seed('a@example.test',{status:'Невалиден',raw:'invalid',checkedAt:'2026-01-01',provider:'Known MX',validator:'promouser',orderId:'42'});const p=f.preview();assert.equal(p.counts.cached,1);assert.equal(p.counts.new,0);f.queue();assert.equal(f.target().at(2,f.col('Валидация')).value,'Невалиден');assert.equal(f.target().at(2,f.col('Провайдер')).value,'Known MX');assert.equal(f.target().at(2,f.col('Заказ Promouser')).value,'42');assert.equal(f.calls.http.length,0);
});

test('active Promouser reservations block Coldy even when the pending row looks unvalidated',()=>{
 const f=fixture();f.reserve('a@example.test');const p=f.preview();assert.equal(p.counts.inProgress,1);assert.equal(p.counts.new,0);f.queue();assert.equal(f.ledger().jobs.length,0);assert.equal(f.calls.http.length,0);
});

test('a reservation created after preview invalidates consent and prevents cross-provider duplicate charging',()=>{
 const f=fixture();const p=f.preview();f.reserve('a@example.test');assert.throws(()=>f.start(p),/COLDY_PREVIEW_CHANGED/);assert.equal(f.calls.http.length,0);
});

test('unique normalized contacts are batched at 500 and deterministic keys are persisted before POST',()=>{
 const rows=[EH,...Array.from({length:501},(_,i)=>[`p${i}@example.test`,'A','','']),[' P0@EXAMPLE.TEST ','A','','']];
 const f=fixture({rows,transport:({method,payload,options,f})=>{assert.equal(method,'POST');const job=f.ledger().jobs.find(j=>j.idempotencyKey===options.idempotencyKey);assert.ok(job);assert.equal(job.dispatched,true);assert.ok(job.contacts.length<=500);assert.deepEqual(payload.emails,job.contacts.map(c=>c.value));assert.equal(new Set(payload.emails).size,payload.emails.length);assert.ok(job.contacts.every(c=>f.cache()[c.key].pending.jobId===job.jobId));return{batch_id:'batch-1',status:'queued',reserved_credits:123};}});
 const p=f.preview();assert.equal(p.counts.new,501);f.start(p);assert.deepEqual(f.ledger().jobs.map(j=>j.contacts.length),[500,1]);assert.equal(f.calls.http.length,1);assert.equal(f.state().jobs[0].reservedCredits,123);
});

test('lost creation response retries the exact approved payload and idempotency key',()=>{
 let first=true;const f=fixture({transport:({method,options,payload,f})=>{if(method==='POST'&&first){first=false;throw new Error('Lost AFTER reserve '+KEY);}if(method==='POST')return{batch_id:'recovered-batch',status:'queued',reserved_credits:1};throw new Error('Unexpected');}});
 f.start();assert.equal(f.state().jobs[0].state,'creation_uncertain');const initial=f.calls.http[0];f.advance();assert.equal(f.calls.http.length,1);f.tick(15000);f.advance();assert.equal(f.calls.http.length,2);assert.deepEqual(f.calls.http[1],initial);assert.equal(f.ledger().jobs.length,1);assert.equal(JSON.stringify(f.state()).includes(KEY),false);
});

test('replaying a start request never creates the next batch or reuses consent with other preview',()=>{
 const f=fixture();const p=f.preview();f.start(p,A,'one-start-request');assert.equal(f.calls.http.length,1);f.start(p,A,'one-start-request');assert.equal(f.calls.http.length,1);assert.throws(()=>f.start({previewToken:'other-token'},A,'one-start-request'),/COLDY_REQUEST_CONFLICT/);
});

test('status and result polling both observe the minimum 15-second readiness interval',()=>{
 const f=fixture();f.start();f.advance();f.tick(14999);f.advance();assert.equal(f.calls.http.length,1);f.tick(1);f.advance();assert.equal(f.calls.http.length,2);assert.equal(f.state().jobs[0].state,'results_pending');f.advance();f.tick(14999);f.advance();assert.equal(f.calls.http.length,2);f.tick(1);f.advance();assert.equal(f.calls.http.length,3);assert.equal(f.state().jobs[0].state,'complete');
});

test('approved manual checks continue in the background without approving future new contacts',()=>{
 const f=fixture();f.start();f.target().put(3,1,'later@example.test');f.tick(15000);f.c.processColdyWorkbookValidation_(f.context,A);f.tick(15000);f.c.processColdyWorkbookValidation_(f.context,A);assert.equal(f.state().jobs[0].state,'complete');assert.equal(f.state().jobs.length,1);assert.equal(f.state().state,'awaiting_confirmation');assert.equal(f.calls.http.filter(x=>x.method==='POST').length,1);
});

test('completed Coldy values record provenance separately and preserve mailbox provider, order and user columns',()=>{
 const f=fixture({rows:[[...EH,'Провайдер','Заказ Promouser','Рассылка'],['a@example.test','A','','','Known MX','legacy-order','Запущен']]});f.start();finish(f);assert.equal(f.target().at(2,f.col('Валидация')).value,'Валиден');assert.equal(f.target().at(2,f.col('Провайдер')).value,'Known MX');assert.equal(f.target().at(2,f.col('Заказ Promouser')).value,'legacy-order');assert.equal(f.target().at(2,f.col('Рассылка')).value,'Запущен');assert.equal(f.target().at(2,f.col('Валидатор')).value,'coldy');assert.ok(f.target().at(2,f.col('Проверка Coldy')).value.startsWith('batch-'));assert.equal(f.c.pvBinding_(f.target().at(2,f.col('Валидация')).note),f.c.pvKey_('email','a@example.test'));const before=f.calls.http.length;f.queue();f.tick(60000);f.advance();assert.equal(f.calls.http.length,before);
});

test('a changed contact never inherits the old address result and old manual notes survive',()=>{
 const f=fixture({rows:[[...EH,'Валидация','Провайдер','Рассылка'],['new@example.test','A','','','Валиден','Old MX','Запущен']]});f.target().put(2,5,'Валиден','my note\n'+f.c.PROMOUSER.bindingPrefix+f.c.pvKey_('email','old@example.test'));assert.equal(f.preview().counts.new,1);f.start();assert.equal(f.target().at(2,5).value,'Проверяется');assert.equal(f.target().at(2,6).value,'');assert.equal(f.target().at(2,7).value,'Запущен');assert.match(f.target().at(2,5).note,/my note/);finish(f);assert.equal(f.target().at(2,5).value,'Валиден');
});

test('changing an email during provider work cannot apply an old result to the replacement address',()=>{
 const f=fixture();f.start();f.target().put(2,1,'replacement@example.test');finish(f);assert.equal(f.target().at(2,f.col('Валидация')).value,'Проверяется');assert.equal(f.target().at(2,f.col('Проверка Coldy')).value,'');assert.equal(f.preview().counts.new,1);assert.equal(f.calls.http.filter(x=>x.method==='POST').length,1);
});

test('manual completed status entered while work is pending is never overwritten by provider results',()=>{
 const f=fixture();f.start();f.target().put(2,f.col('Валидация'),'Исключено вручную','manual note');finish(f);assert.equal(f.target().at(2,f.col('Валидация')).value,'Исключено вручную');assert.equal(f.target().at(2,f.col('Валидация')).note,'manual note');
});

test('all official completed result enums are retained; malformed, conflicting and missing results require review',()=>{
 const outcomes=['valid','invalid','unknown','accept_all','disposable','unexpected'];const rows=[EH,...Array.from({length:8},(_,i)=>[`p${i}@example.test`,'A','',''])];
 const f=fixture({rows,transport:({method,path,f})=>{const j=f.ledger().jobs[0];if(method==='POST')return{batch_id:'outcomes',status:'completed',reserved_credits:5};if(path.endsWith('/results'))return{batch_id:'outcomes',results:[...outcomes.map((result,i)=>({email:`p${i}@example.test`,result})),{email:'p6@example.test',result:'valid'},{email:'p6@example.test',result:'invalid'},{email:'outsider@example.test',result:'valid'}]};throw new Error('Unexpected');}});
 f.start();f.tick(15000);f.advance();const statuses=outcomes.map((_,i)=>f.target().at(i+2,f.col('Валидация')).value);assert.deepEqual(statuses,['Валиден','Невалиден','Неизвестно','Принимает все письма','Одноразовый ящик','Нужна ручная проверка']);assert.equal(f.target().at(8,f.col('Валидация')).value,'Нужна ручная проверка');assert.equal(f.target().at(9,f.col('Валидация')).value,'Нужна ручная проверка');assert.equal(f.state().jobs[0].state,'result_review');assert.equal(f.cache()[f.c.pvKey_('email','outsider@example.test')],undefined);f.queue();assert.equal(f.preview().counts.new,0);assert.equal(f.calls.http.filter(x=>x.method==='POST').length,1);
});

test('a cached Coldy result supplies another workbook without a second order and retains Coldy batch provenance',()=>{
 const f=fixture({otherRows:[EH,['a@example.test','B','','']]});f.start();finish(f);const cache=f.cache()[f.c.pvKey_('email','a@example.test')].result;assert.equal(cache.validator,'coldy');assert.ok(cache.verificationBatchId);assert.equal(cache.orderId,'');f.queue(B);assert.equal(f.target(B).at(2,f.col('Валидация',B)).value,'Валиден');assert.equal(f.target(B).at(2,f.col('Валидатор',B)).value,'coldy');assert.equal(f.target(B).at(2,f.col('Проверка Coldy',B)).value,cache.verificationBatchId);assert.equal(f.calls.http.filter(x=>x.method==='POST').length,1);
});

test('root/file removal and credential rotation stop provider work and preserve reservations',()=>{
 const f=fixture();f.start();f.rotate('new-org-key');f.tick(15000);f.advance();assert.equal(f.state().jobs[0].state,'credential_changed');assert.equal(f.calls.http.length,1);assert.ok(f.cache()[f.c.pvKey_('email','a@example.test')].pending);
 const g=fixture();g.start();g.revoke();g.tick(15000);assert.throws(()=>g.advance(),/OUTSIDE_REGISTRY/);assert.equal(g.calls.http.length,1);
 const h=fixture();h.start();h.changeRoot();h.tick(15000);assert.throws(()=>h.advance(),/COLDY_VALIDATION_STORAGE/);assert.equal(h.calls.http.length,1);
});

test('fresh pre-network credential guard catches rotation after durable dispatch',()=>{
 const f=fixture();f.onSave(state=>{if(state.lease)f.rotate('different-key');});f.start();assert.equal(f.calls.http.length,0);assert.equal(f.state().jobs[0].state,'credential_changed');
});

test('fresh post-network credential guard rejects results from an account whose key changed in flight',()=>{
 const f=fixture({transport:({f})=>{f.rotate('different-key');return{batch_id:'old-org-batch',status:'completed'};}});f.start();assert.equal(f.state().jobs[0].state,'credential_changed');assert.equal(f.target().at(2,f.col('Валидация')).value,'Ожидает проверки');assert.ok(f.cache()[f.c.pvKey_('email','a@example.test')].pending);
});

test('clearing the API key during a provider response pauses the batch without applying or throwing secrets',()=>{
 const f=fixture({transport:({f})=>{f.rotate('');return{batch_id:'old-org-batch',status:'completed'};}});const result=f.start();assert.equal(result.state,'not_configured');assert.equal(f.ledger().jobs[0].state,'credential_changed');assert.equal(f.target().at(2,f.col('Валидация')).value,'Ожидает проверки');
});

test('expired in-flight POST recovers only by the same idempotency key',()=>{
 const f=fixture();const p=f.preview();f.onSave(state=>{if(state.lease)throw f.coded('SIMULATED_TERMINATION','Process terminated before network');});assert.throws(()=>f.start(p),/SIMULATED_TERMINATION/);const key=f.ledger().jobs[0].idempotencyKey;assert.equal(f.calls.http.length,0);f.onSave(null);f.tick(120001);f.advance();assert.equal(f.calls.http.length,1);assert.equal(f.calls.http[0].options.idempotencyKey,key);assert.equal(f.ledger().jobs.length,1);
});

test('a stale lease cannot apply its late provider response',()=>{
 const f=fixture({transport:({f})=>{f.tick(120001);return{batch_id:'too-late',status:'completed'};}});assert.throws(()=>f.start(),/COLDY_VALIDATION_LEASE/);assert.equal(f.target().at(2,f.col('Валидация')).value,'Ожидает проверки');assert.ok(f.cache()[f.c.pvKey_('email','a@example.test')].pending);
});

test('429 Retry-After is honored without sleeps or additional immediate requests',()=>{
 const f=fixture({transport:({f})=>{throw Object.assign(f.coded('COLDY_RATE_LIMIT','Limited'),{retryAfterMs:60000});}});f.start();assert.equal(f.state().nextActionAt,f.now()+60000);f.tick(59999);f.advance();assert.equal(f.calls.http.length,1);f.tick(1);f.advance();assert.equal(f.calls.http.length,2);
});

test('repeated uncertain responses stop after bounded attempts and never create a new job/key',()=>{
 const f=fixture({transport:()=>{throw new Error('network secret '+KEY);}});f.start();for(let n=0;n<10;n++){f.tick(300000);f.advance();}assert.equal(f.calls.http.length,5);assert.equal(new Set(f.calls.http.map(c=>c.options.idempotencyKey)).size,1);assert.equal(f.state().jobs[0].state,'needs_review');assert.equal(f.preview().counts.new,0);assert.equal(JSON.stringify(f.state()).includes(KEY),false);
});

test('bounded result application resumes from shared cache after unknown Sheets acknowledgement',()=>{
 const f=fixture();f.start();f.tick(15000);f.advance();const saved=f.c.cvApply_;let fail=true;f.c.cvApply_=(context,state,updates)=>{saved(context,state,updates);if(fail&&updates.some(u=>u.result)){fail=false;throw f.coded('COLDY_VALIDATION_WRITE','Lost write acknowledgement');}};f.tick(15000);assert.throws(()=>f.advance(),/COLDY_VALIDATION_WRITE/);const sent=f.calls.http.length;assert.equal(f.target().at(2,f.col('Валидация')).value,'Валиден');f.c.cvApply_=saved;f.advance();assert.equal(f.calls.http.length,sent);assert.equal(f.state().state,'complete');
});

test('large cached applications are bounded and complete locally without provider calls',()=>{
 const rows=[EH,...Array.from({length:1005},()=>['same@example.test','A','',''])];const f=fixture({rows});f.seed('same@example.test',{status:'Невалиден',raw:'invalid',validator:'promouser',orderId:'1'});f.queue();assert.equal(f.target().at(1001,f.col('Валидация')).value,'Невалиден');assert.equal(f.target().at(1002,f.col('Валидация')).value,'');assert.equal(f.ledger().pendingApplications,5);f.c.processColdyWorkbookValidation_(f.context,A);assert.equal(f.target().at(1006,f.col('Валидация')).value,'Невалиден');assert.equal(f.ledger().pendingApplications,0);assert.equal(f.calls.http.length,0);
});
