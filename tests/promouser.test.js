import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const ROOT='validation_root_123456', A='validation_book_a_123456', B='validation_book_b_123456', SERVICE='validation_service_123456';
const KEY='fixture_secret_do_not_echo';
const plain=value=>JSON.parse(JSON.stringify(value));
const EH=['Email','Компания / ЛПР','Исходные строки','Проверить принадлежность'];
const PH=['Телефон','Компания / ЛПР','Откуда','Исходные строки','Проверить принадлежность','Telegram','Тип контакта'];

function fixture(options={}) {
 let now=Date.parse('2026-11-19T12:00:00Z'), seq=0, lock=false, nextOrder=100, allowed=true;
 const properties=new Map(Object.entries(options.properties||{})), files=new Map(), books=new Map(), calls={fetch:[],writes:[],fileWrites:[],locks:0};
 class Clock extends Date { constructor(...args){super(...(args.length?args:[now]));} static now(){return now;} }
 function sheet(id,name,values=[]) {
  const data=values.map(row=>row.map(value=>({value,note:''})));let rows=1000,cols=40;
  const at=(r,c)=>data[r-1]?.[c-1]||{value:'',note:''};
  const put=(r,c,value,note)=>{data[r-1]||=[];data[r-1][c-1]={value,note:note===undefined?at(r,c).note:note};};
  const s={getSheetId:()=>id,getName:()=>name,getLastRow:()=>data.reduce((n,row,i)=>row?.some(cell=>cell?.value!=='')?i+1:n,0),getLastColumn:()=>Math.max(0,...data.map(row=>row.reduce((n,cell,i)=>cell?.value!==''?i+1:n,0))),getMaxRows:()=>rows,getMaxColumns:()=>cols,insertRowsAfter:(_,n)=>{rows+=n;},insertColumnsAfter:(_,n)=>{cols+=n;},setFrozenRows:()=>{},getRange:(r,c,h,w)=>({getDisplayValues:()=>Array.from({length:h},(_,y)=>Array.from({length:w},(_,x)=>String(at(r+y,c+x).value??''))),getValues:()=>Array.from({length:h},(_,y)=>Array.from({length:w},(_,x)=>at(r+y,c+x).value)),getNotes:()=>Array.from({length:h},(_,y)=>Array.from({length:w},(_,x)=>at(r+y,c+x).note)),getFormulas:()=>Array.from({length:h},()=>Array(w).fill(''))}),data,at,put};
  return s;
 }
 function book(id,emailRows,phoneRows) {
  const tabs=[sheet(1,'Email',emailRows),sheet(2,'Телефоны',phoneRows)];
  const result={getId:()=>id,getSheetByName:name=>tabs.find(s=>s.getName()===name),getSheets:()=>tabs,insertSheet:name=>{const s=sheet(tabs.length+1,name);tabs.push(s);return s;},tabs};
  books.set(id,result); files.set(id,{id,mimeType:'application/vnd.google-apps.spreadsheet',parents:['validation_sources_123456'],appProperties:{unrelated:'retained'}});return result;
 }
 const ba=book(A,options.emailRows||[EH,['a@example.test','Company A','Строка 2','']],options.phoneRows||[PH]);
 const bb=book(B,options.otherEmailRows||[EH],options.otherPhoneRows||[PH]);
 const service={getId:()=>SERVICE,tabs:[],getSheets(){return this.tabs;},getSheetByName(name){return this.tabs.find(s=>s.getName()===name);},insertSheet(name){const s=sheet(this.tabs.length+100,name);this.tabs.push(s);return s;}};books.set(SERVICE,service);
 const context={rootId:ROOT,properties:{getProperty:key=>properties.get(key)??null,setProperty:(key,value)=>properties.set(key,value),deleteProperty:key=>properties.delete(key)}};
 const response=(body,status=200)=>({getResponseCode:()=>status,getContentText:()=>typeof body==='string'?body:JSON.stringify(body)});
 const c=vm.createContext({console:{warn(){}},Date:Clock,Math,Number,JSON,Array,
  api_:fn=>fn(),authorize_:()=>{if(!allowed)throw coded('OUTSIDE_REGISTRY','Moved');return context;},object_:value=>{if(!value||typeof value!=='object'||Array.isArray(value))throw coded('INVALID_REQUEST','Bad');return value;},id_:value=>{if(typeof value!=='string'||value.length<10)throw coded('INVALID_REQUEST','id');return value;},fail_:(code,message)=>{throw coded(code,message);},registryError_:coded,digest_:value=>crypto.createHash('sha256').update(String(value)).digest('base64url'),
  locked_:fn=>{assert.equal(lock,false,'No recursive global lock');lock=true;calls.locks++;try{return fn();}finally{lock=false;}},
  gridFile_:(id,writable,expected)=>{if(!allowed||![A,B].includes(id)||expected&&expected!==ROOT)throw coded('OUTSIDE_REGISTRY','Outside');return{context,file:{getId:()=>id},canEdit:true};},
  getContactWorkspace_:()=>({targets:{emailSheetId:1,phoneSheetId:2}}),sourceBasesStorage_:()=>({public:{id:SERVICE},book:service}),SpreadsheetApp:{openById:id=>{if(!books.has(id))throw new Error('Missing book');return books.get(id);},flush(){}},
  Utilities:{getUuid:()=>`request-${++seq}-unique`,newBlob:(text,mime,name)=>({text,mime,name,getDataAsString:()=>text})},
  DriveApp:{getFileById:id=>({getBlob:()=>({getDataAsString:()=>files.get(id).body})})},
  Drive:{Files:{get:id=>{if(!files.has(id))throw new Error('Missing file');return plain(files.get(id));},list:()=>({files:[...files.values()].filter(f=>f.mimeType==='application/vnd.google-apps.folder'&&!f.trashed).map(plain)}),create:(meta,blob)=>{const id=`validation_state_${++seq}_123456`;const f={...plain(meta),id,body:blob?.text||''};files.set(id,f);return plain(f);},update:(meta,id,blob)=>{if(options.stateWriteFail&&blob?.name==='validation.json')throw new Error('Storage lost');const file=files.get(id);Object.assign(file,plain(meta));if(blob)file.body=blob.text;calls.fileWrites.push(id);return plain(file);}}},
  sheetWriteRawStrings_:(id,sheetId,r,col,rows)=>{const s=books.get(id).tabs.find(s=>s.getSheetId()===sheetId);rows.forEach((row,y)=>row.forEach((value,x)=>s.put(r+y,col+x,String(value))));calls.writes.push({id,header:true,r,col,rows:plain(rows)});},
  Sheets:{Spreadsheets:{batchUpdate:(body,id)=>{assert.ok(lock,'Service results/cache writes hold lock');for(const request of body.requests){const u=request.updateCells,s=books.get(id).tabs.find(s=>s.getSheetId()===u.range.sheetId);u.rows.forEach((row,y)=>row.values.forEach((cell,x)=>s.put(u.range.startRowIndex+y+1,u.range.startColumnIndex+x+1,cell.userEnteredValue.stringValue,u.fields.includes('note')?cell.note:undefined)));}calls.writes.push({id,requests:plain(body.requests)});return{spreadsheetId:id,replies:body.requests.map(()=>({}))};}}},
  UrlFetchApp:{fetch:(url,request)=>{assert.equal(lock,false,'No provider HTTP under global lock');assert.equal(request.headers.key,KEY);assert.equal(request.followRedirects,false);calls.fetch.push({url,request});if(options.transport) return options.transport({url,request,response,calls,now});if(url.endsWith('/api/balance'))return response({balance:'100'});if(url.endsWith('/api/order'))return response({order_id:nextOrder++,type:Number(request.payload.type)});if(url.includes('/api/status?'))return response(options.status||{status:'not_ready_unpaid',order_id:Number(url.split('=').pop()),cost:'0.5'});if(url.endsWith('/api/pay')){const p=JSON.parse(request.payload);return response({status:'success',order_id:Number(p.order_id),charged:'0.5',balance:'99.5'});}if(url.includes('/results/'))return response(options.result||'email\tresult\tprovider\na@example.test\tvalid\tExample Mail');throw new Error('Unexpected endpoint');}},
 });
 vm.runInContext(readFileSync(new URL('../src/Promouser.gs',import.meta.url),'utf8'),c);
 function coded(code,message){const e=new Error('['+code+'] '+message);e.registryCode=code;return e;}
 const configure=(extra={})=>c.configurePromouser_({apiKey:KEY,enabled:true,autoPayLimitUsd:0,...extra});
 const queue=(id=A)=>c.queueWorkbookValidation_(context,id,{emailSheetId:1,phoneSheetId:2});
 const start=(id=A,kind='email')=>{const preview=c.previewPromouserValidation_({id,kind});assert.equal(preview.canStart,true,JSON.stringify(preview));return c.startPromouserValidation_({id,kind,previewToken:preview.previewToken,requestId:`start-${++seq}-unique`});};
 const advance=(id=A)=>c.advanceWorkbookValidation_({id,requestId:`advance-${++seq}-unique`});
 const state=(id=A)=>c.getValidationState_({id});
 const ledger=(id=A)=>JSON.parse(files.get(files.get(id).appProperties.registryValidationStateId).body);
 const writeLedger=(value,id=A)=>{files.get(files.get(id).appProperties.registryValidationStateId).body=JSON.stringify(value);};
 const target=(id=A,kind='Email')=>books.get(id).getSheetByName(kind);
 const col=(name,id=A,kind='Email')=>target(id,kind).getRange(1,1,1,target(id,kind).getLastColumn()).getDisplayValues()[0].indexOf(name)+1;
 return{c,context,properties,books,files,calls,ba,bb,response,configure,queue,start,advance,state,ledger,writeLedger,target,col,tick:ms=>{now+=ms;},revoke:()=>{allowed=false;},now:()=>now};
}

function createAndQuote(f,id=A){f.configure();f.queue(id);f.start(id);f.advance(id);f.advance(id);f.tick(15000);f.advance(id);return f.state(id).jobs[0];}

test('settings keep the API key write-only and retain it on an empty password field',()=>{
 const f=fixture();const configured=f.configure();assert.equal(configured.configured,true);assert.equal(configured.enabled,true);assert.equal(JSON.stringify(configured).includes(KEY),false);assert.equal(f.c.configurePromouser_({apiKey:'',enabled:false}).configured,true);assert.equal(f.properties.get('PROMOUSER_API_KEY'),KEY);assert.throws(()=>f.c.configurePromouser_({autoPayLimitUsd:-1}),/INVALID_REQUEST/);assert.throws(()=>f.c.configurePromouser_({apiKey:'bad\nsecret'}),/INVALID_REQUEST/);assert.equal(f.c.configurePromouser_({clearKey:true,enabled:false}).configured,false);
});

test('balance probes only the fixed endpoint with a header credential, never query or raw OAuth',()=>{
 const f=fixture();f.configure();assert.deepEqual(plain(f.c.getPromouserBalance_()),{balance:100,currency:'USD'});const call=f.calls.fetch[0];assert.equal(call.url,'https://promouser.com/api/balance');assert.equal(call.url.includes(KEY),false);assert.equal(call.request.method,'get');
});

test('a normal order is a quote-only multipart upload; no force or top-up exists',()=>{
 const f=fixture();f.configure();f.queue();f.start();f.advance();f.advance();const call=f.calls.fetch.find(x=>x.url.endsWith('/api/order'));assert.ok(call);assert.equal(call.request.payload.type,'17');assert.equal(call.request.payload.file.text,'a@example.test\n');assert.equal(call.request.payload.force,undefined);assert.equal(f.calls.fetch.some(x=>x.url.includes('topup')||x.url.includes('/api/pay')),false);
});

test('status polling enforces 15 seconds and all same-order requests enforce 5 seconds',()=>{
 const f=fixture();const j=createAndQuote(f);const n=f.calls.fetch.length;f.advance();f.tick(4999);f.advance();assert.equal(f.calls.fetch.length,n);assert.throws(()=>f.c.payValidationOrder_({id:A,jobId:j.jobId,requestId:'pay-wrong-price',expectedCostUsd:2}),/PV_COST_CHANGED/);f.tick(10000);f.advance();assert.equal(f.calls.fetch.length,n);f.tick(1);f.advance();assert.equal(f.calls.fetch.length,n+1);
});

test('manual payment binds the displayed quote and repeats cannot create a second payment',()=>{
 const f=fixture();const j=createAndQuote(f);f.tick(5000);f.c.payValidationOrder_({id:A,jobId:j.jobId,requestId:'pay-once-request',expectedCostUsd:0.5});assert.equal(f.calls.fetch.filter(x=>x.url.endsWith('/api/pay')).length,1);f.c.payValidationOrder_({id:A,jobId:j.jobId,requestId:'pay-once-request',expectedCostUsd:0.5});assert.equal(f.calls.fetch.filter(x=>x.url.endsWith('/api/pay')).length,1);assert.throws(()=>f.c.payValidationOrder_({id:A,jobId:j.jobId,requestId:'pay-new-request',expectedCostUsd:0.5}),/PV_NOT_PAYABLE/);
});

test('automatic payment happens only within an explicitly configured nonzero limit',()=>{
 const f=fixture();createAndQuote(f);f.tick(5000);f.advance();assert.equal(f.calls.fetch.some(x=>x.url.endsWith('/api/pay')),false);f.c.configurePromouser_({autoPayLimitUsd:0.49});f.advance();assert.equal(f.calls.fetch.some(x=>x.url.endsWith('/api/pay')),false);f.c.configurePromouser_({autoPayLimitUsd:0.5});f.advance();assert.equal(f.calls.fetch.filter(x=>x.url.endsWith('/api/pay')).length,1);
});

test('checked valid and invalid rows are immutable, including manual notes and campaign columns',()=>{
 const f=fixture({emailRows:[[...EH,'Валидация','Провайдер','Дата проверки','Рассылка'],['a@example.test','A','','','Валиден','Old provider','2025-01-01','Запущен'],['b@example.test','B','','','Невалиден','Bad provider','2025-02-01','Не трогать']]});f.target().put(2,5,'Валиден','user note');f.configure();f.queue();const writes=f.calls.writes.filter(w=>w.id===A&&w.requests).flatMap(w=>w.requests);assert.equal(writes.length,0);assert.equal(f.target().at(2,5).note,'user note');assert.equal(f.target().at(2,8).value,'Запущен');assert.equal(f.state().jobs.length,0);f.advance();assert.equal(f.calls.fetch.filter(x=>x.url.endsWith('/api/order')).length,0);
});

test('an unbound legacy checked row stays checked even when its contact was manually changed',()=>{
 const f=fixture({emailRows:[[...EH,'Валидация'],['new@example.test','A','','','Валиден']]});f.configure();f.queue();assert.equal(f.state().jobs.length,0);assert.equal(f.target().at(2,5).value,'Валиден');
});

test('a contact changed under our owned binding becomes new without inheriting its old check',()=>{
 const f=fixture({emailRows:[[...EH,'Валидация','Провайдер','Дата проверки','Рассылка'],['new@example.test','A','','','Валиден','Old provider','2025','Запущен']]});const old=f.c.pvKey_('email','old@example.test');f.target().put(2,5,'Валиден','user note\n'+f.c.PROMOUSER.bindingPrefix+old);f.configure();f.queue();assert.equal(f.state().jobs.length,1);assert.equal(f.target().at(2,5).value,'Ожидает проверки');assert.equal(f.target().at(2,6).value,'');assert.equal(f.target().at(2,8).value,'Запущен');assert.equal(f.target().at(2,5).note.includes('user note'),true);assert.equal(f.c.pvBinding_(f.target().at(2,5).note),f.c.pvKey_('email','new@example.test'));
});

test('checked global cache populates only new rows without another external order',()=>{
 const f=fixture({emailRows:[[...EH,'Валидация','Провайдер'],['a@example.test','A','','','Невалиден','Known']] ,otherEmailRows:[EH,['a@example.test','B','','']]});f.configure();f.queue(A);f.queue(B);assert.equal(f.target(B).at(2,f.col('Валидация',B)).value,'Невалиден');assert.equal(f.target(B).at(2,f.col('Провайдер',B)).value,'Known');assert.equal(f.state(B).jobs.length,0);assert.equal(f.calls.fetch.length,0);
});

test('global pending reservation prevents duplicate provider orders in registry and segment books',()=>{
 const f=fixture({otherEmailRows:[EH,['a@example.test','B','','']]});f.configure();f.queue(A);f.queue(B);f.start(A);f.start(B);f.advance(A);f.advance(A);f.advance(B);assert.equal(f.calls.fetch.filter(x=>x.url.endsWith('/api/order')).length,1);assert.equal(f.state(B).jobs[0].state,'waiting_shared');
});

test('lost create acknowledgements never resend the contact batch',()=>{
 const f=fixture({transport:({url,request,response})=>{if(url.endsWith('/balance'))return response({balance:'5'});if(url.endsWith('/order'))throw new Error('connection lost AFTER create; token '+KEY);throw new Error('unexpected');}});f.configure();f.queue();f.start();f.advance();const state=f.advance();assert.equal(state.jobs[0].state,'creation_uncertain');for(let i=0;i<3;i++){f.tick(60000);f.advance();}assert.equal(f.calls.fetch.filter(x=>x.url.endsWith('/api/order')).length,1);assert.equal(JSON.stringify(f.state()).includes(KEY),false);
});

test('lost payment acknowledgements poll the same order and never repeat the charge',()=>{
 let paid=false;const f=fixture({transport:({url,request,response})=>{if(url.endsWith('/balance'))return response({balance:'10'});if(url.endsWith('/order'))return response({order_id:9,type:17});if(url.includes('/status?'))return response({order_id:9,status:paid?'not_ready_paid':'not_ready_unpaid',cost:'0.5'});if(url.endsWith('/pay')){paid=true;throw new Error('lost response '+KEY);}throw new Error('unexpected');}});const j=createAndQuote(f);f.tick(5000);let s=f.c.payValidationOrder_({id:A,jobId:j.jobId,requestId:'pay-unknown-once',expectedCostUsd:0.5});assert.equal(s.jobs[0].state,'payment_uncertain');f.tick(15000);f.advance();assert.equal(f.state().jobs[0].state,'checking');assert.equal(f.calls.fetch.filter(x=>x.url.endsWith('/api/pay')).length,1);
});

test('credential changes pause existing jobs rather than paying them under another account',()=>{
 const f=fixture();createAndQuote(f);f.c.configurePromouser_({apiKey:'different_fixture_key'});f.properties.set('PROMOUSER_CONNECTION',JSON.stringify({keyHash:f.c.digest_('different_fixture_key')}));f.tick(15000);f.advance();assert.equal(f.state().jobs[0].state,'credential_changed');assert.equal(f.calls.fetch.filter(x=>x.url.endsWith('/api/order')).length,1);
});

test('a missing initial key binds only at first dispatch after configuration',()=>{
 const f=fixture();f.queue();assert.equal(f.ledger().jobs[0].credentialHash,'');f.configure();f.start();f.advance();f.advance();assert.equal(f.state().jobs[0].state,'awaiting_quote');assert.equal(f.ledger().jobs[0].credentialHash,f.c.digest_(KEY));
});

test('phone batches stay in one country and unsupported usernames or landlines are not sent',()=>{
 const f=fixture({emailRows:[EH],phoneRows:[PH,['+79990000001','A','','','','','Телефон'],['+77010000001','B','','','','','Телефон'],['+380501234567','C','','','','','Телефон'],['+74951234567','D','','','','','Телефон'],['','E','','','','@some_person','Telegram']]});f.configure();f.queue();const s=f.state();assert.deepEqual(s.jobs.map(j=>j.country).sort(),['KZ','RU','UA']);assert.equal(f.target(A,'Телефоны').at(6,f.col('Валидация',A,'Телефоны')).value,'Нужен телефон');assert.equal(f.target(A,'Телефоны').at(5,f.col('Валидация',A,'Телефоны')).value,'Уточните страну или номер');
});

test('result parsing uses explicit contacts, preserves providers, and never treats unknown statuses as valid',()=>{
 const f=fixture();const r=plain(f.c.pvParseResults_('почта;результат валидации;провайдер\na@example.test;valid;Example\nb@example.test;invalid;Other\nc@example.test;some-new-status;Other','email'));assert.deepEqual(r.results.map(x=>x.status),['Валиден','Невалиден','Неизвестно']);assert.equal(r.results[0].provider,'Example');assert.equal(f.c.pvParseResults_('status\nvalid','email').results.length,0);
});

test('Telegram result respects exact ID_TG/Nickname_TG/Active_days_ago and 30-day boundary',()=>{
 const f=fixture();const r=plain(f.c.pvParseResults_('phone\tID_TG\tNickname_TG\tActive_days_ago\n79990000001\t123\tperson_a\t30\n79990000002\t124\tperson_b\t31\n79990000003\t125\tperson_c\t\n79990000004\t\t\t','telegram'));assert.equal(r.results[0].eligible,true);assert.equal(r.results[1].eligible,false);assert.equal(r.results[2].eligible,null);assert.equal(r.results[2].status,'Telegram: активность скрыта');assert.equal(r.results[3].status,'Telegram не подтверждён');assert.equal(r.results[3].eligible,null);
});

test('CSV quoted delimiters, BOM, multiline fields and JSON results are parsed without positional guessing',()=>{
 const f=fixture();const r=plain(f.c.pvParseResults_('\uFEFFemail,result,provider\r\na@example.test,valid,"Mail, Ltd"\r\n','email'));assert.equal(r.results[0].provider,'Mail, Ltd');const j=plain(f.c.pvParseResults_(JSON.stringify({results:[{email:'a@example.test',status:'valid',provider:'X'}]}),'email'));assert.equal(j.results[0].status,'Валиден');assert.deepEqual(plain(f.c.pvDelimited_('a;b\n"one\ntwo";"say ""hi"""',';')),[['a','b'],['one\ntwo','say "hi"']]);
});

test('conflicting duplicate result rows become unknown instead of choosing a green verdict',()=>{
 const f=fixture();const r=plain(f.c.pvParseResults_('email\tresult\na@example.test\tvalid\na@example.test\tinvalid','email'));assert.equal(r.results.length,1);assert.equal(r.results[0].status,'Неизвестно');assert.ok(r.warnings.length);
});

test('result download only accepts the fixed provider results path and never follows redirects',()=>{
 const f=fixture();for(const url of ['http://promouser.com/results/a.txt','https://evil.test/results/a.txt','https://promouser.com@evil.test/results/a.txt','https://promouser.com/api/balance','https://promouser.com/results/../api/balance','https://promouser.com/results/%2e%2e/a'])assert.equal(f.c.pvResultUrl_(url),false,url);assert.equal(f.c.pvResultUrl_('https://promouser.com/results/ABC/123.txt'),true);f.configure();f.c.pvDownload_({key:KEY},'https://promouser.com/results/ABC/123.txt');assert.equal(f.calls.fetch[0].request.followRedirects,false);
});

test('provider error bodies and permission exceptions never echo keys or arbitrary private text',()=>{
 for(const failure of [{status:403,body:{error:'private '+KEY}},{status:401,body:{error:'invalid api key '+KEY}},{status:500,body:{error:'customer a@example.test '+KEY}}]){const f=fixture({transport:({response})=>response(failure.body,failure.status)});f.configure();assert.throws(()=>f.c.getPromouserBalance_(),error=>!error.message.includes(KEY)&&!error.message.includes('a@example.test'));}const g=fixture({transport:()=>{throw new Error('Required permissions external_request '+KEY);}});g.configure();assert.throws(()=>g.c.getPromouserBalance_(),/PV_OWNER_AUTH_REQUIRED/);
});

test('a moved workbook is rejected before any provider request or mutation',()=>{
 const f=fixture();f.configure();f.queue();f.revoke();assert.throws(()=>f.advance(),/OUTSIDE_REGISTRY/);assert.equal(f.calls.fetch.length,0);
});

test('an expired in-flight creation lease becomes uncertain, never a new order',()=>{
 const f=fixture();f.configure();f.queue();const state=f.ledger();state.jobs[0].state='creating';state.jobs[0].dispatch={token:'old',action:'create',at:f.now()-180000};state.lease={token:'old',until:f.now()-1000};f.writeLedger(state);f.advance();f.advance();assert.equal(f.state().jobs[0].state,'creation_uncertain');assert.equal(f.calls.fetch.filter(x=>x.url.endsWith('/api/order')).length,0);
});

test('full paid email lifecycle writes only new validation columns and preserves completed rows and user notes',()=>{
 let paid=false;const f=fixture({emailRows:[[...EH,'Рассылка','Валидация'],['a@example.test','A','','','Запущен',''],['b@example.test','B','','','Новый',''],['old@example.test','Old','','','Запущен','Невалиден']],transport:({url,request,response})=>{
  if(url.endsWith('/balance'))return response({balance:'10'});
  if(url.endsWith('/order'))return response({order_id:44,type:17});
  if(url.includes('/status?'))return response(paid?{order_id:44,status:'ready_paid',cost:'0.5',result:'https://promouser.com/results/test/44.txt'}:{order_id:44,status:'not_ready_unpaid',cost:'0.5'});
  if(url.endsWith('/pay')){paid=true;return response({status:'success',order_id:44,charged:'0.5',balance:'9.5'});}
  if(url.includes('/results/'))return response('email\tresult\tprovider\na@example.test\tvalid\tProvider A\nb@example.test\tinvalid\tProvider B\nnot-requested@example.test\tvalid\tIgnored');
  throw new Error('Unexpected endpoint');
 }});
 f.target().put(2,6,'','manual note stays');const job=createAndQuote(f);f.tick(5000);f.c.payValidationOrder_({id:A,jobId:job.jobId,requestId:'lifecycle-pay-once',expectedCostUsd:0.5});f.tick(15000);f.advance();assert.equal(f.state().jobs[0].state,'result_pending');f.tick(5000);f.advance();assert.equal(f.state().jobs[0].state,'complete');assert.equal(f.target().at(2,f.col('Валидация')).value,'Валиден');assert.equal(f.target().at(3,f.col('Валидация')).value,'Невалиден');assert.equal(f.target().at(4,f.col('Валидация')).value,'Невалиден');assert.equal(f.target().at(2,5).value,'Запущен');assert.equal(f.target().at(2,f.col('Провайдер')).value,'Provider A');assert.ok(f.target().at(2,f.col('Валидация')).note.includes('manual note stays'));const sent=f.calls.fetch.length,writes=f.calls.writes.length;f.tick(60000);f.advance();assert.equal(f.calls.fetch.length,sent);assert.equal(f.calls.writes.slice(writes).filter(x=>x.id===A).length,0,'completed rows never rewritten');const cm=f.c.pvCacheRead_(f.c.pvCache_(f.context,false));assert.equal(cm[f.c.pvKey_('email','not-requested@example.test')],undefined);
});

test('a shared completed result propagates to another workbook without a second provider order',()=>{
 let paid=false;const f=fixture({otherEmailRows:[EH,['a@example.test','B','','']],transport:({url,request,response})=>{
  if(url.endsWith('/balance'))return response({balance:'10'});if(url.endsWith('/order'))return response({order_id:55,type:17});if(url.includes('/status?'))return response(paid?{order_id:55,status:'ready_paid',cost:'0.5',result:'https://promouser.com/results/test/55.txt'}:{order_id:55,status:'not_ready_unpaid',cost:'0.5'});if(url.endsWith('/pay')){paid=true;return response({status:'success',order_id:55,charged:'0.5',balance:'9.5'});}if(url.includes('/results/'))return response('email,result,provider\na@example.test,valid,Shared');throw new Error('unexpected');
 }});f.configure();f.queue(A);f.queue(B);f.start(A);f.start(B);f.advance(A);f.advance(A);f.advance(B);assert.equal(f.state(B).jobs[0].state,'waiting_shared');f.tick(15000);f.advance(A);const j=f.state(A).jobs[0];f.tick(5000);f.c.payValidationOrder_({id:A,jobId:j.jobId,requestId:'shared-pay-once',expectedCostUsd:0.5});f.tick(15000);f.advance(A);f.tick(5000);f.advance(A);f.advance(B);assert.equal(f.state(B).jobs[0].state,'complete_shared');assert.equal(f.target(B).at(2,f.col('Валидация',B)).value,'Валиден');assert.equal(f.calls.fetch.filter(x=>x.url.endsWith('/api/order')).length,1);assert.equal(f.calls.fetch.filter(x=>x.url.endsWith('/api/pay')).length,1);
});

test('changing the contact while the result runs does not apply a stale verdict to the new value',()=>{
 const f=fixture();f.configure();f.queue();const state=f.ledger(),j=state.jobs[0];j.state='result_pending';j.orderId='77';j.resultUrl='https://promouser.com/results/test/77.txt';j.credentialHash=f.c.digest_(KEY);f.writeLedger(state);f.properties.set('PROMOUSER_CONNECTION',JSON.stringify({keyHash:f.c.digest_(KEY)}));f.target().put(2,1,'new@example.test');f.advance();assert.equal(f.target().at(2,1).value,'new@example.test');assert.equal(f.target().at(2,f.col('Валидация')).value,'Ожидает проверки');assert.equal(f.target().at(2,f.col('Провайдер')).value,'');assert.equal(f.ledger().jobs.some(j=>j.contacts.some(c=>c.value==='new@example.test')),true);
});

test('results with missing contacts remain review-only and a later sync never buys another check for them',()=>{
 const f=fixture({result:'email,result\nother@example.test,valid'});f.configure();f.queue();const state=f.ledger();state.jobs[0].state='result_pending';state.jobs[0].orderId='80';state.jobs[0].resultUrl='https://promouser.com/results/test/80.txt';state.jobs[0].credentialHash=f.c.digest_(KEY);f.writeLedger(state);f.properties.set('PROMOUSER_CONNECTION',JSON.stringify({keyHash:f.c.digest_(KEY)}));f.advance();assert.equal(f.state().jobs[0].state,'result_review');f.target().put(3,1,'brandnew@example.test');f.queue();const queued=f.ledger().jobs.filter(j=>j.state==='queued').flatMap(j=>j.contacts.map(c=>c.value));assert.deepEqual(queued,['brandnew@example.test']);
});

test('an unpaid cancelled batch releases its own global reservation so another workbook can continue',()=>{
 const f=fixture({otherEmailRows:[EH,['a@example.test','B','','']]});const j=createAndQuote(f);f.queue(B);f.advance(B);assert.equal(f.state(B).jobs[0].state,'queued');assert.equal(f.c.previewPromouserValidation_({id:B,kind:'email'}).canStart,false);f.target().put(2,1,'');f.tick(15000);f.advance(A);assert.equal(f.state(A).jobs[0].state,'cancelled');f.start(B);f.advance(B);assert.equal(f.calls.fetch.filter(x=>x.url.endsWith('/api/order')).length,2);assert.equal(f.calls.fetch.filter(x=>x.url.endsWith('/api/pay')).length,0);
});

test('existing Telegram provider columns and legacy email report results are already checked even without our status column',()=>{
 const f=fixture({emailRows:[[...EH,'result','provider'],['a@example.test','A','','','invalid','Old']],phoneRows:[[...PH,'ID_TG','Nickname_TG','Active_days_ago'],['+79990000001','A','','','','','Телефон','123','old_user','3']]});f.configure();f.queue();assert.equal(f.state().jobs.length,0,JSON.stringify(f.state().jobs));assert.equal(f.calls.writes.filter(w=>w.id===A&&w.requests).length,0);assert.equal(f.target().at(2,5).value,'invalid');assert.equal(f.target(A,'Телефоны').at(2,8).value,'123');
});

test('a completed duplicate later in the same sheet supplies cache to its new row without a provider job',()=>{
 const f=fixture({emailRows:[[...EH,'Валидация'],['a@example.test','A','','',''],['a@example.test','B','','','Невалиден']]});f.configure();f.queue();assert.equal(f.state().jobs.length,0);assert.equal(f.target().at(2,5).value,'Невалиден');assert.equal(f.target().at(3,5).value,'Невалиден');assert.equal(f.calls.fetch.length,0);
});

test('large initial queues use bounded row applications and compressed status rectangles',()=>{
 const rows=[EH,...Array.from({length:1005},(_,i)=>[`p${i}@example.test`,'Company','',''])];const f=fixture({emailRows:rows});f.configure();const first=f.queue();assert.equal(first.jobs.length,2);assert.equal(f.target().at(1001,f.col('Валидация')).value,'Ожидает проверки');assert.equal(f.target().at(1002,f.col('Валидация')).value,'');const targetCalls=f.calls.writes.filter(w=>w.id===A&&w.requests);assert.equal(targetCalls.length,1);assert.equal(targetCalls[0].requests.length,1,'one contiguous status rectangle, not four thousand cell requests');assert.equal(targetCalls[0].requests[0].updateCells.rows.length,1000);f.queue();assert.equal(f.target().at(1006,f.col('Валидация')).value,'Ожидает проверки');assert.equal(f.calls.fetch.length,0);
});

test('a cleared API key disables validation without requiring another separate settings write',()=>{
 const f=fixture();f.configure();const result=f.c.configurePromouser_({clearKey:true});assert.equal(result.configured,false);assert.equal(result.enabled,false);assert.equal(JSON.stringify(result).includes(KEY),false);
});

test('Telegram zero IDs are not considered registered and yes/no email reports are explicit verdicts',()=>{
 const f=fixture();const r=plain(f.c.pvParseResults_('phone\tID_TG\tActive_days_ago\n79990000001\t0\t0','telegram'));assert.equal(r.results[0].eligible,null);assert.equal(r.results[0].status,'Telegram не подтверждён');assert.equal(f.c.pvEmailStatus_('да'),'Валиден');assert.equal(f.c.pvEmailStatus_('false'),'Невалиден');assert.equal(f.c.pvEmailStatus_('1'),'Неизвестно');
});

test('stale manual quotes are refreshed before payment and a changed price needs new consent',()=>{
 let cost='0.5';const f=fixture({transport:({url,request,response})=>{if(url.endsWith('/balance'))return response({balance:'10'});if(url.endsWith('/order'))return response({order_id:91,type:17});if(url.includes('/status?'))return response({order_id:91,status:'not_ready_unpaid',cost});if(url.endsWith('/pay'))return response({status:'success',order_id:91,charged:cost,balance:'8'});throw new Error('unexpected');}});const j=createAndQuote(f);f.tick(120000);cost='2';assert.throws(()=>f.c.payValidationOrder_({id:A,jobId:j.jobId,requestId:'stale-price-consent',expectedCostUsd:0.5}),/PV_COST_CHANGED/);assert.equal(f.calls.fetch.filter(x=>x.url.endsWith('/pay')).length,0);assert.equal(f.state().jobs[0].cost,2);assert.equal(f.state().jobs[0].canPay,true);f.tick(5000);f.c.payValidationOrder_({id:A,jobId:j.jobId,requestId:'new-price-consent',expectedCostUsd:2});assert.equal(f.calls.fetch.filter(x=>x.url.endsWith('/pay')).length,1);
});

test('stale automatic quotes are refreshed and a new amount above the cap is not paid',()=>{
 let cost='0.5';const f=fixture({transport:({url,request,response})=>{if(url.endsWith('/balance'))return response({balance:'10'});if(url.endsWith('/order'))return response({order_id:92,type:17});if(url.includes('/status?'))return response({order_id:92,status:'not_ready_unpaid',cost});if(url.endsWith('/pay'))throw new Error('Must not pay changed price');throw new Error('unexpected');}});createAndQuote(f);f.c.configurePromouser_({autoPayLimitUsd:1});f.tick(120000);cost='2';f.advance();assert.equal(f.calls.fetch.filter(x=>x.url.endsWith('/pay')).length,0);assert.equal(f.state().jobs[0].cost,2);assert.equal(f.state().canAutoAdvance,false);assert.equal(f.state().jobs[0].canPay,true);
});

test('the five-minute worker can finish a fresh automatic quote in a bounded second operation outside locks',()=>{
 const f=fixture();f.configure({autoPayLimitUsd:1});f.queue();f.start();f.advance();f.advance();f.tick(15000);let slept=0;f.c.Utilities.sleep=ms=>{assert.ok(ms>0&&ms<=5000);slept+=ms;f.tick(ms);};const before=f.calls.fetch.length;f.advance();assert.equal(f.calls.fetch.length-before,2);assert.equal(f.calls.fetch.at(-2).url.includes('/status?'),true);assert.equal(f.calls.fetch.at(-1).url.endsWith('/pay'),true);assert.equal(slept,5000);assert.equal(f.state().jobs[0].state,'checking');
});

test('manual stale consent with an unchanged quote advances safely on the next operation',()=>{
 const f=fixture();const j=createAndQuote(f);f.tick(120000);const response=f.c.payValidationOrder_({id:A,jobId:j.jobId,requestId:'same-price-consent',expectedCostUsd:0.5});assert.equal(f.calls.fetch.filter(x=>x.url.endsWith('/pay')).length,0);assert.equal(response.canAutoAdvance,true);assert.equal(response.jobs[0].canPay,false);f.tick(5000);f.advance();assert.equal(f.calls.fetch.filter(x=>x.url.endsWith('/pay')).length,1);assert.equal(f.state().jobs[0].state,'checking');
});

test('disabling validation during a bounded payment wait prevents the charge',()=>{
 const f=fixture();f.configure({autoPayLimitUsd:1});f.queue();f.start();f.advance();f.advance();f.tick(15000);f.c.Utilities.sleep=ms=>{f.tick(ms);f.c.configurePromouser_({enabled:false});};f.advance();assert.equal(f.calls.fetch.filter(x=>x.url.endsWith('/pay')).length,0);assert.equal(f.state().state,'disabled');
});

test('a contact changed during the bounded wait is not charged as the old contact',()=>{
 const f=fixture();f.configure({autoPayLimitUsd:1});f.queue();f.start();f.advance();f.advance();f.tick(15000);f.c.Utilities.sleep=ms=>{f.tick(ms);f.target().put(2,1,'changed-during-wait@example.test');};f.advance();assert.equal(f.calls.fetch.filter(x=>x.url.endsWith('/pay')).length,0);assert.equal(f.state().jobs[0].state,'cancelled');
});

test('automatic hints distinguish manual payment, cached applications and explicitly budgeted payment',()=>{
 const f=fixture();const state={jobs:[{state:'awaiting_payment',manualStartApproved:true,cost:1,lastRequestAt:f.now(),lastStatusAt:f.now()}]};assert.equal(f.c.pvAutomaticHint_(state,{key:KEY,enabled:true,autoPayLimitUsd:0}).canAutoAdvance,false);assert.equal(f.c.pvAutomaticHint_(state,{key:KEY,enabled:true,autoPayLimitUsd:5}).canAutoAdvance,true);assert.equal(f.c.pvAutomaticHint_({jobs:[],pendingApplications:5},{key:KEY,enabled:true,autoPayLimitUsd:0}).canAutoAdvance,true);assert.equal(f.c.pvAutomaticHint_({jobs:[],pendingApplications:5},{key:KEY,enabled:false,autoPayLimitUsd:5}).canAutoAdvance,false);
});

test('disabled and unconfigured background validation reads no target rows and performs no writes or HTTP',()=>{
 for(const configured of [false,true]){const f=fixture();if(configured){f.configure();f.queue();f.c.configurePromouser_({enabled:false});}const writes=f.calls.writes.length,fileWrites=f.calls.fileWrites.length;f.c.queueWorkbookValidation_=()=>assert.fail('Idle worker must not queue');f.c.pvTargets_=()=>assert.fail('Idle worker must not read target rows');const result=f.c.processWorkbookValidation_(f.context,A);assert.equal(result.state,configured?'disabled':'not_configured');assert.equal(f.calls.writes.length,writes);assert.equal(f.calls.fileWrites.length,fileWrites);assert.equal(f.calls.fetch.length,0);f.revoke();assert.throws(()=>f.c.processWorkbookValidation_(f.context,A),/OUTSIDE_REGISTRY/);}
});

test('settled background validation skips scanning while an explicit command still queues new contacts',()=>{
 const f=fixture();f.configure();f.queue();const state=f.ledger();state.jobs.forEach(job=>{job.state='complete';job.resultCount=job.contacts.length;});state.pendingApplications=0;f.writeLedger(state);f.target().put(3,1,'new@example.test');let queues=0,targets=0;const queue=f.c.queueWorkbookValidation_,readTargets=f.c.pvTargets_;f.c.queueWorkbookValidation_=(...args)=>{queues++;return queue(...args);};f.c.pvTargets_=(...args)=>{targets++;return readTargets(...args);};const writes=f.calls.writes.length,fileWrites=f.calls.fileWrites.length;assert.equal(f.c.processWorkbookValidation_(f.context,A).state,'complete');assert.equal(queues,0);assert.equal(targets,0);assert.equal(f.calls.writes.length,writes);assert.equal(f.calls.fileWrites.length,fileWrites);assert.equal(f.calls.fetch.length,0);f.advance();assert.equal(queues,1);assert.ok(targets>0);assert.ok(f.state().jobs.some(job=>job.state==='queued'&&job.contacts===1));
});

test('background validation continues cached result applications even with no unfinished jobs',()=>{
 const rows=[[...EH,'Валидация'],...Array.from({length:1005},()=>['a@example.test','Company','','','']),['a@example.test','Company','','','Валиден']];const f=fixture({emailRows:rows});f.configure();f.c.getPromouserBalance_();f.queue();assert.equal(f.state().jobs.length,0);assert.equal(f.ledger().pendingApplications,5);assert.equal(f.target().at(1006,f.col('Валидация')).value,'');const calls=f.calls.fetch.length;f.c.processWorkbookValidation_(f.context,A);assert.equal(f.target().at(1006,f.col('Валидация')).value,'Валиден');assert.equal(f.ledger().pendingApplications,0);assert.equal(f.calls.fetch.length,calls);
});

test('new email and phone queues require manual preview and start even with the five-dollar limit',()=>{
 const f=fixture({phoneRows:[PH,['+79990000001','A','','','','','Телефон']]});f.configure({autoPayLimitUsd:5});f.queue();
 assert.deepEqual(plain(f.state().pendingCounts),{email:1,telegram:1});assert.equal(f.state().manualStartRequired,true);assert.equal(f.state().canAutoAdvance,false);
 for(let i=0;i<3;i++){f.advance();f.tick(60000);}assert.equal(f.calls.fetch.length,0);
 const writes=f.calls.writes.length,fileWrites=f.calls.fileWrites.length;f.c.queueWorkbookValidation_=()=>assert.fail('Unapproved worker must stay idle');f.c.pvTargets_=()=>assert.fail('Unapproved worker must not read targets');f.c.processWorkbookValidation_(f.context,A);assert.equal(f.calls.writes.length,writes);assert.equal(f.calls.fileWrites.length,fileWrites);assert.equal(f.calls.fetch.length,0);
});

test('phone preview is local, deduplicates aliases and distinguishes unsupported and already checked contacts',()=>{
 const f=fixture({emailRows:[EH],phoneRows:[[...PH,'Валидация'],['+79990000001','A','','','','','Телефон',''],['8 (999) 000-00-01','A','','','','','Телефон',''],['+77010000001','B','','','','','Телефон',''],['+74951234567','D','','','','','Телефон',''],['','E','','','','@some_person','Telegram',''],['not a phone','F','','','','','Телефон',''],['+79990000002','G','','','','','Телефон','Telegram не подтверждён']]});f.configure();const writes=f.calls.writes.length;
 const result=f.c.previewPhoneValidation_({id:A});assert.deepEqual(plain(result.counts),{new:2,checked:1,cached:0,inProgress:0,unknownCountry:1,telegramWithoutPhone:1,invalid:1});assert.equal(result.canStart,true);assert.deepEqual(plain(result.sample.map(item=>item.country).sort()),['KZ','RU']);assert.equal(f.calls.fetch.length,0);assert.equal(f.calls.writes.length,writes,'preview does not add headers or edit cells');assert.equal(f.state().jobs.length,0,'preview does not queue paid work');
});

test('phone start approves its exact contact set only, and duplicate requests cannot approve later phones or email',()=>{
 const f=fixture({phoneRows:[PH,['+79990000001','A','','','','','Телефон']]});f.configure({autoPayLimitUsd:5});const preview=f.c.previewPhoneValidation_({id:A});const input={id:A,previewToken:preview.previewToken,requestId:'phone-explicit-start'};
 let state=f.c.startPhoneValidation_(input);assert.equal(state.jobs.find(job=>job.kind==='telegram').manualStartRequired,false);assert.equal(state.jobs.find(job=>job.kind==='email').manualStartRequired,true);
 f.target(A,'Телефоны').put(3,1,'+79990000002');f.advance();f.c.startPhoneValidation_(input);f.c.startPhoneValidation_({...input,requestId:'same-preview-other-id'});f.advance();
 const orders=f.calls.fetch.filter(call=>call.url.endsWith('/api/order'));assert.equal(orders.length,1);assert.equal(orders[0].request.payload.type,'6');assert.equal(orders[0].request.payload.file.text,'79990000001\n');state=f.state();assert.equal(state.pendingCounts.telegram,1);assert.equal(state.pendingCounts.email,1);assert.equal(f.ledger().jobs.find(job=>job.contacts.some(contact=>contact.value==='+79990000002')).manualStartApproved,false);
});

test('preview rejects stale source contacts, source fields, target IDs, expiry, key changes and cross-book reuse',()=>{
 const changes=[f=>f.target().put(3,1,'new@example.test'),f=>f.target().put(2,1,'changed@example.test'),f=>f.target().put(2,2,'Changed company'),f=>{const state=f.ledger();state.targets={emailSheetId:2,phoneSheetId:1};f.writeLedger(state);},f=>f.tick(600001),f=>f.c.configurePromouser_({apiKey:'rotated-fixture-key'})];
 for(const change of changes){const f=fixture();f.configure();const p=f.c.previewPromouserValidation_({id:A,kind:'email'});change(f);assert.throws(()=>f.c.startPromouserValidation_({id:A,kind:'email',previewToken:p.previewToken,requestId:'stale-explicit-start'}),/PV_PREVIEW_STALE/);assert.equal(f.calls.fetch.length,0);assert.equal(f.ledger().jobs.some(job=>job.manualStartApproved),false);}
 const f=fixture();f.configure();const p=f.c.previewPhoneValidation_({id:A});assert.throws(()=>f.c.startPhoneValidation_({id:B,previewToken:p.previewToken,requestId:'cross-book-start'}),/PV_PREVIEW_STALE/);assert.equal(f.calls.fetch.length,0);
});

test('a started request recovers after its preview expires or is pruned without approving new contacts',()=>{
 const f=fixture();f.configure();const preview=f.c.previewPromouserValidation_({id:A,kind:'email'}),input={id:A,kind:'email',previewToken:preview.previewToken,requestId:'recover-start-request'};f.c.startPromouserValidation_(input);f.tick(600001);f.target().put(3,1,'later@example.test');f.c.previewPromouserValidation_({id:A,kind:'email'});f.c.startPromouserValidation_(input);assert.equal(f.ledger().jobs.length,1);assert.deepEqual(f.ledger().jobs[0].contacts.map(contact=>contact.value),['a@example.test']);assert.throws(()=>f.c.startPromouserValidation_({...input,kind:'telegram'}),/PV_PREVIEW_STALE/);assert.equal(f.calls.fetch.length,0);
});

test('manual start uses cached outcomes and checked duplicates without buying another validation',()=>{
 const f=fixture({emailRows:[[...EH,'Валидация'],['a@example.test','A','','',''],['a@example.test','B','','','Невалиден'],['b@example.test','C','','',''],['c@example.test','D','','','']]});f.configure();f.c.locked_(()=>{const cache=f.c.pvCache_(f.context,true),map=f.c.pvCacheRead_(cache);f.c.pvCachePut_(f.context,cache,map,f.c.pvKey_('email','b@example.test'),'email',{status:'Неизвестно',raw:'unknown',validator:'coldy',verificationBatchId:'coldy-batch-17',orderId:''});f.c.pvCacheFlush_(f.context,cache);});
 const p=f.c.previewPromouserValidation_({id:A,kind:'email'});assert.deepEqual(plain(p.counts),{new:1,checked:1,cached:1,inProgress:0,unknownCountry:0,telegramWithoutPhone:0,invalid:0});f.c.startPromouserValidation_({id:A,kind:'email',previewToken:p.previewToken,requestId:'cache-aware-start'});assert.deepEqual(f.ledger().jobs.map(job=>job.contacts.map(contact=>contact.value)),[['c@example.test']]);assert.equal(f.target().at(2,f.col('Валидация')).value,'Невалиден');assert.equal(f.target().at(4,f.col('Валидация')).value,'Неизвестно');assert.equal(f.calls.fetch.length,0);
});

test('legacy submitted unpaid jobs cannot use the automatic limit until their own explicit payment approval',()=>{
 const f=fixture({phoneRows:[PH,['+79990000001','A','','','','','Телефон']]});const job=createAndQuote(f);const ledger=f.ledger();delete ledger.jobs.find(item=>item.jobId===job.jobId).manualStartApproved;delete ledger.jobs.find(item=>item.jobId===job.jobId).startApproval;f.writeLedger(ledger);f.c.configurePromouser_({autoPayLimitUsd:5});f.tick(15000);f.advance();assert.equal(f.calls.fetch.filter(call=>call.url.endsWith('/pay')).length,0);assert.equal(f.state().jobs.find(item=>item.jobId===job.jobId).manualStartRequired,true);f.tick(5000);f.c.payValidationOrder_({id:A,jobId:job.jobId,requestId:'legacy-own-payment',expectedCostUsd:0.5});assert.equal(f.calls.fetch.filter(call=>call.url.endsWith('/pay')).length,1);assert.equal(f.ledger().jobs.find(item=>item.kind==='telegram').manualStartApproved,false);
});

test('already paid legacy jobs continue to fetch and apply results without a new start',()=>{
 let paid=false;const f=fixture({transport:({url,request,response})=>{if(url.endsWith('/balance'))return response({balance:'10'});if(url.endsWith('/order'))return response({order_id:107,type:17});if(url.includes('/status?'))return response(paid?{order_id:107,status:'ready_paid',cost:'0.5',result:'https://promouser.com/results/test/107.txt'}:{order_id:107,status:'not_ready_unpaid',cost:'0.5'});if(url.endsWith('/pay')){paid=true;return response({status:'success',order_id:107,charged:'0.5',balance:'9.5'});}if(url.includes('/results/'))return response('email,result\na@example.test,invalid');throw new Error('unexpected');}});const job=createAndQuote(f);f.tick(5000);f.c.payValidationOrder_({id:A,jobId:job.jobId,requestId:'paid-legacy-payment',expectedCostUsd:0.5});const ledger=f.ledger();delete ledger.jobs[0].manualStartApproved;f.writeLedger(ledger);f.tick(15000);f.c.processWorkbookValidation_(f.context,A);f.tick(5000);f.c.processWorkbookValidation_(f.context,A);assert.equal(f.state().jobs[0].state,'complete');assert.equal(f.target().at(2,f.col('Валидация')).value,'Невалиден');assert.equal(f.calls.fetch.filter(call=>call.url.endsWith('/order')).length,1);assert.equal(f.calls.fetch.filter(call=>call.url.endsWith('/pay')).length,1);
});

test('Coldy preference cancels only safe unsent email work and never starts another Promouser email order',()=>{
 const f=fixture({phoneRows:[PH,['+79990000001','A','','','','','Телефон']]});f.configure();f.queue();const email=f.ledger().jobs.find(job=>job.kind==='email');f.c.locked_(()=>{const cache=f.c.pvCache_(f.context,true),map=f.c.pvCacheRead_(cache);f.c.pvCacheReserve_(cache,map,email.contacts[0].key,'email',{fileId:A,jobId:email.jobId,keyHash:f.c.digest_(KEY)});f.c.pvCacheFlush_(f.context,cache);});f.c.emailValidationProvider_=()=> 'coldy';f.queue();assert.equal(f.state().jobs.find(job=>job.kind==='email').state,'cancelled');assert.equal(f.c.pvCacheRead_(f.c.pvCache_(f.context,false))[email.contacts[0].key],undefined);assert.equal(f.state().pendingCounts.email,0);assert.equal(f.state().pendingCounts.telegram,1);assert.equal(f.c.previewPromouserValidation_({id:A,kind:'email'}).canStart,false);f.advance();assert.equal(f.calls.fetch.length,0);
 const active=fixture();active.configure();active.queue();const ledger=active.ledger();ledger.lease={token:'active',until:active.now()+10000};active.writeLedger(ledger);active.c.emailValidationProvider_=()=> 'coldy';active.queue();assert.equal(active.state().jobs[0].state,'queued','an active lease is not cancelled underneath an in-flight worker');
});

test('the last dispatch guard stops a preferred-provider change after manual start and releases its reservation',()=>{
 const f=fixture();f.configure();f.queue();f.start();f.advance();const original=f.c.gridFile_;let switched=false;f.c.gridFile_=(...args)=>{const result=original(...args);if(f.ledger().jobs[0].state==='creating'){switched=true;f.c.emailValidationProvider_=()=> 'coldy';}return result;};f.advance();assert.equal(switched,true);assert.equal(f.calls.fetch.filter(call=>call.url.endsWith('/order')).length,0);assert.equal(f.state().jobs[0].state,'cancelled');assert.equal(f.c.pvCacheRead_(f.c.pvCache_(f.context,false))[f.c.pvKey_('email','a@example.test')],undefined);
});

test('shared cache retains Coldy provenance and never represents a Coldy batch as a Promouser order',()=>{
 const f=fixture({emailRows:[[...EH,'Провайдер'],['a@example.test','A','','','Known mailbox provider']]});f.configure();f.c.locked_(()=>{const cache=f.c.pvCache_(f.context,true),map=f.c.pvCacheRead_(cache);f.c.pvCachePut_(f.context,cache,map,f.c.pvKey_('email','a@example.test'),'email',{status:'Валиден',provider:'',raw:'valid',validator:'coldy',verificationBatchId:'batch-abc',orderId:'must-not-be-a-promouser-order',review:true});f.c.pvCacheFlush_(f.context,cache);});const cached=f.c.pvCacheRead_(f.c.pvCache_(f.context,false))[f.c.pvKey_('email','a@example.test')].result;assert.equal(cached.validator,'coldy');assert.equal(cached.verificationBatchId,'batch-abc');assert.equal(cached.review,true);assert.equal(cached.orderId,'');f.queue();assert.equal(f.target().at(2,f.col('Заказ Promouser')).value,'');assert.equal(f.target().at(2,f.col('Валидатор')).value,'coldy');assert.equal(f.target().at(2,f.col('Проверка Coldy')).value,'batch-abc');assert.equal(f.target().at(2,f.col('Провайдер')).value,'Known mailbox provider');assert.equal(f.state().jobs.length,0);assert.equal(f.calls.fetch.length,0);
});

test('a completed ambiguous provider result is not offered as new manual work',()=>{
 const f=fixture({result:'email,result\nother@example.test,valid'});const job=createAndQuote(f);const state=f.ledger();state.jobs[0].state='result_pending';state.jobs[0].resultUrl='https://promouser.com/results/test/review.txt';state.jobs[0].orderId='80';f.writeLedger(state);f.tick(5000);f.advance();assert.equal(f.state().jobs[0].state,'result_review');const preview=f.c.previewPromouserValidation_({id:A,kind:'email'});assert.equal(preview.counts.new,0);assert.equal(preview.counts.inProgress,1);assert.equal(preview.canStart,false);assert.equal(f.calls.fetch.filter(call=>call.url.endsWith('/order')).length,1);
});

test('the background provider switch releases only its unsent reservation without scanning targets',()=>{
 const f=fixture();f.configure();f.queue();const job=f.ledger().jobs[0];f.c.locked_(()=>{const cache=f.c.pvCache_(f.context,true),map=f.c.pvCacheRead_(cache);f.c.pvCacheReserve_(cache,map,job.contacts[0].key,'email',{fileId:A,jobId:job.jobId});f.c.pvCacheFlush_(f.context,cache);});f.c.emailValidationProvider_=()=> 'coldy';f.c.queueWorkbookValidation_=()=>assert.fail('No queue rescan on provider switch');f.c.pvTargets_=()=>assert.fail('No target reads on provider switch');f.c.processWorkbookValidation_(f.context,A);assert.equal(f.state().jobs[0].state,'cancelled');assert.equal(f.c.pvCacheRead_(f.c.pvCache_(f.context,false))[job.contacts[0].key],undefined);assert.equal(f.calls.fetch.length,0);
});

test('a late provider acknowledgement cannot delete the lease of a newer worker',()=>{
 const f=fixture({transport:({url,response})=>{if(url.endsWith('/balance'))return response({balance:'10'});if(url.endsWith('/order')){f.tick(120001);const state=f.ledger();state.lease={token:'new-worker-token',until:f.now()+120000};f.writeLedger(state);return response({order_id:55,type:17});}throw new Error('unexpected');}});f.configure();f.queue();f.start();f.advance();assert.throws(()=>f.advance(),/PV_UNCERTAIN/);assert.equal(f.ledger().lease.token,'new-worker-token');assert.equal(f.ledger().jobs[0].state,'creating');assert.equal(f.calls.fetch.filter(call=>call.url.endsWith('/order')).length,1);
});

test('a credential change during result download pauses the old order without writing its result',()=>{
 let paid=false;const f=fixture({transport:({url,response})=>{if(url.endsWith('/balance'))return response({balance:'10'});if(url.endsWith('/order'))return response({order_id:205,type:17});if(url.includes('/status?'))return response(paid?{order_id:205,status:'ready_paid',cost:'0.5',result:'https://promouser.com/results/test/205.txt'}:{order_id:205,status:'not_ready_unpaid',cost:'0.5'});if(url.endsWith('/pay')){paid=true;return response({status:'success',order_id:205,charged:'0.5'});}if(url.includes('/results/')){f.c.configurePromouser_({apiKey:'changed-during-download'});return response('email,result\na@example.test,valid');}throw new Error('unexpected');}});const job=createAndQuote(f);f.tick(5000);f.c.payValidationOrder_({id:A,jobId:job.jobId,requestId:'before-key-change-pay',expectedCostUsd:0.5});f.tick(15000);f.advance();f.tick(5000);f.advance();assert.equal(f.state().jobs[0].state,'credential_changed');assert.equal(f.state().jobs[0].orderId,'205');assert.equal(f.target().at(2,f.col('Валидация')).value,'Ожидает проверки');assert.equal(f.c.pvCacheRead_(f.c.pvCache_(f.context,false))[f.c.pvKey_('email','a@example.test')].result,null);
});

test('manual phone validation writes detailed Telegram data while preserving user campaign columns',()=>{
 let paid=false;const f=fixture({emailRows:[EH],phoneRows:[[...PH,'Рассылка'],['+79990000001','A','','','','','Телефон','Не менять']],transport:({url,request,response})=>{if(url.endsWith('/balance'))return response({balance:'10'});if(url.endsWith('/order')){assert.equal(request.payload.type,'6');return response({order_id:306,type:6});}if(url.includes('/status?'))return response(paid?{order_id:306,status:'ready_paid',cost:'0.5',result:'https://promouser.com/results/test/306.txt'}:{order_id:306,status:'not_ready_unpaid',cost:'0.5'});if(url.endsWith('/pay')){paid=true;return response({status:'success',order_id:306,charged:'0.5'});}if(url.includes('/results/'))return response('phone\tID_TG\tNickname_TG\tActive_days_ago\n79990000001\t12345\tperson_test\t30');throw new Error('unexpected');}});f.configure({autoPayLimitUsd:5});f.queue();f.advance();assert.equal(f.calls.fetch.length,0);f.start(A,'telegram');f.advance();f.advance();f.tick(15000);f.advance();f.tick(5000);f.advance();f.tick(15000);f.advance();f.tick(5000);f.advance();const phone=f.target(A,'Телефоны');assert.equal(phone.at(2,f.col('Валидация',A,'Телефоны')).value,'Telegram: активен');assert.equal(phone.at(2,f.col('ID_TG',A,'Телефоны')).value,'12345');assert.equal(phone.at(2,f.col('Nickname_TG',A,'Телефоны')).value,'person_test');assert.equal(phone.at(2,f.col('Active_days_ago',A,'Телефоны')).value,'30');assert.equal(phone.at(2,f.col('Для Telegram',A,'Телефоны')).value,'Да');assert.equal(phone.at(2,8).value,'Не менять');assert.equal(f.calls.fetch.filter(call=>call.url.endsWith('/pay')).length,1);
});

test('a later imported exclusion adds permanent review without replacing an earlier valid cached verdict or checked rows',()=>{
 const validRaw='provider-valid-original';const history='legacy-history:v1:'+JSON.stringify({validation:'valid',work:['Нецелевой'],conflict:false,source:['old source']});
 const f=fixture({emailRows:[[...EH,'Валидация','Дата проверки','Результат проверки','Провайдер','Валидатор','Проверка Coldy'],['a@example.test','Old company','','','Валиден','2025-02-03',validRaw,'Yandex','coldy','old-batch']],otherEmailRows:[[...EH,'Валидация','Дата проверки','Результат проверки','Провайдер','Валидатор'],['a@example.test','New company','','','Проверить историю контакта','2026-04-05',history,'Other','источник']]});f.configure();f.target().put(2,5,'Валиден','old user note');f.queue(A);const key=f.c.pvKey_('email','a@example.test'),before=f.c.pvCacheRead_(f.c.pvCache_(f.context,false))[key].result;const writes=f.calls.writes.length;f.queue(B);let cached=f.c.pvCacheRead_(f.c.pvCache_(f.context,false))[key].result;assert.equal(cached.review,true);assert.deepEqual({...plain(cached),review:false},plain(before));assert.equal(f.target(A).at(2,5).value,'Валиден');assert.equal(f.target(A).at(2,5).note,'old user note');assert.equal(f.target(B).at(2,5).value,'Проверить историю контакта');assert.equal(f.target(B).at(2,7).value,history);assert.equal(f.calls.writes.slice(writes).filter(call=>(call.id===A||call.id===B)&&call.requests).length,0,'completed rows are never rewritten');
 f.target(B).put(3,1,'a@example.test');f.target(B).put(3,2,'New segment contact');f.queue(B);assert.equal(f.target(B).at(3,f.col('Валидация',B)).value,'Проверить историю контакта');assert.equal(f.target(B).at(3,f.col('Дата проверки',B)).value,'2025-02-03');assert.equal(f.target(B).at(3,f.col('Результат проверки',B)).value,validRaw);assert.equal(f.target(B).at(3,f.col('Провайдер',B)).value,'Yandex');assert.equal(f.target(B).at(3,f.col('Валидатор',B)).value,'coldy');assert.equal(f.target(B).at(3,f.col('Проверка Coldy',B)).value,'old-batch');assert.equal(f.target(B).at(3,f.col('Заказ Promouser',B)).value,'');f.queue(A);cached=f.c.pvCacheRead_(f.c.pvCache_(f.context,false))[key].result;assert.equal(cached.review,true,'an old clean row cannot remove a later exclusion');assert.equal(cached.status,'Валиден');assert.equal(f.calls.fetch.length,0);assert.equal(f.state(B).jobs.length,0);
});

test('history review is detected from work, conflicts and the explicit review status without treating clean validation history as review',()=>{
 const cases=[{status:'Валиден',raw:'legacy-history:v1:'+JSON.stringify({validation:'valid',work:[],conflict:false}),review:false},{status:'Валиден',raw:'legacy-history:v1:'+JSON.stringify({validation:'valid',work:['Рассылка'],conflict:false}),review:true},{status:'Валиден',raw:'legacyhistory:v1:'+JSON.stringify({validation:'valid',work:[],conflict:true}),review:true},{status:'Проверить историю контакта',raw:'an old annotation',review:true},{status:'Валиден',raw:'legacy-history:v1:{damaged',review:true}];
 for(const item of cases){const f=fixture({emailRows:[[...EH,'Валидация','Результат проверки'],['a@example.test','A','','',item.status,item.raw]]});f.configure();f.queue();assert.equal(f.c.pvCacheRead_(f.c.pvCache_(f.context,false))[f.c.pvKey_('email','a@example.test')].result.review,item.review);assert.equal(f.target().at(2,5).value,item.status);assert.equal(f.calls.fetch.length,0);}
});

test('an exclusion later in the same worksheet supersedes an earlier cached application without rewriting completed contacts',()=>{
 const history='legacy-history:v1:'+JSON.stringify({work:['Фильтр'],conflict:false});const f=fixture({emailRows:[[...EH,'Валидация','Результат проверки'],['a@example.test','New','','','', ''],['a@example.test','Imported','','','Проверить историю контакта',history]]});f.configure();f.c.locked_(()=>{const cache=f.c.pvCache_(f.context,true),map=f.c.pvCacheRead_(cache);f.c.pvCachePut_(f.context,cache,map,f.c.pvKey_('email','a@example.test'),'email',{status:'Валиден',raw:'valid',checkedAt:'2025'});f.c.pvCacheFlush_(f.context,cache);});f.queue();assert.equal(f.target().at(2,5).value,'Проверить историю контакта');assert.equal(f.target().at(2,6).value,'valid');assert.equal(f.target().at(3,6).value,history);assert.equal(f.calls.fetch.length,0);
});

test('review cache merges preserve provider fields, unknown stored metadata and Telegram eligibility while preventing green reuse',()=>{
 const f=fixture({emailRows:[EH],phoneRows:[PH,['+79990000001','New','','','','','Телефон']]});f.configure();const key=f.c.pvKey_('telegram','+79990000001');f.c.locked_(()=>{const cache=f.c.pvCache_(f.context,true),map=f.c.pvCacheRead_(cache);f.c.pvCachePut_(f.context,cache,map,key,'telegram',{status:'Telegram: активен',raw:'original',checkedAt:'2024',idTg:'123',nickname:'original_name',days:1,eligible:true,orderId:'provider-order'});f.c.pvCacheFlush_(f.context,cache);const row=map[key].row;const original=cache.sheet.at(row,8).value;cache.sheet.put(row,8,JSON.stringify({...JSON.parse(original),futureMetadata:{retained:true}}));const fresh=f.c.pvCacheRead_(cache);f.c.pvCachePut_(f.context,cache,fresh,key,'telegram',{status:'Невалиден',raw:'must not replace',checkedAt:'2026',orderId:'different-order',review:true});f.c.pvCacheFlush_(f.context,cache);assert.equal(JSON.parse(cache.sheet.at(row,8).value).futureMetadata.retained,true);});f.queue();const result=f.c.pvCacheRead_(f.c.pvCache_(f.context,false))[key].result;assert.equal(result.status,'Telegram: активен');assert.equal(result.raw,'original');assert.equal(result.checkedAt,'2024');assert.equal(result.orderId,'provider-order');assert.equal(result.eligible,true);assert.equal(result.review,true);assert.equal(f.target(A,'Телефоны').at(2,f.col('Валидация',A,'Телефоны')).value,'Проверить историю контакта');assert.equal(f.target(A,'Телефоны').at(2,f.col('Для Telegram',A,'Телефоны')).value,'Нужна проверка');assert.equal(f.calls.fetch.length,0);
});
