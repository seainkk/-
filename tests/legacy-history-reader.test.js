import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';

const FILE='history_input_file_1234567890',PREFIX='registry-promouser-contact:v1:';
const plain=x=>JSON.parse(JSON.stringify(x));
const digest=x=>crypto.createHash('sha256').update(String(x)).digest('base64url');
const key=(kind,value)=>digest('promouser-contact-v1|'+kind+'|'+value.toLowerCase());

function fixture(specs,options={}) {
  let now=100000,allowed=true;const calls={display:[],notes:[],guards:0,heavy:0};
  class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const c=vm.createContext({Date:Clock});vm.runInContext(readFileSync(new URL('../src/LegacyContactHistory.gs',import.meta.url),'utf8'),c);
  c.digest_=digest;c.fail_=(code,message)=>{throw Object.assign(new Error(`[${code}] ${message}`),{registryCode:code});};
  c.preparedDataRead_=()=>{calls.heavy++;throw new Error('No heavy contact normalization');};
  c.preparedDataRichApi_=()=>{calls.heavy++;throw new Error('No rich link grid read');};
  if(options.limits)c.PREPARED_DATA_LIMITS={maxRows:50000,maxColumns:100,maxCells:1000000,chunkCells:100000,...options.limits};
  const sheets=specs.map((spec,index)=>{const id=spec.id??index,width=spec.width??Math.max(0,...spec.rows.map(row=>row.length));return{
    getSheetId:()=>id,getName:()=>spec.name??'Лист '+id,getLastRow:()=>spec.rows.length,getLastColumn:()=>width,
    getRange:(row,column,height,columns)=>{
      const matrix=get=>Array.from({length:height},(_,y)=>Array.from({length:columns},(_,x)=>get(row+y,column+x)));
      const range={getDisplayValues:()=>{calls.display.push({id,row,column,height,columns});options.onDisplay?.({id,row,height,calls,tick:ms=>{now+=ms;},revoke:()=>{allowed=false;}});return options.badDisplay?[]:matrix((r,col)=>String(spec.rows[r-1]?.[col-1]??''));},getNotes:()=>{calls.notes.push({id,row,column,height,columns});return options.badNotes?[]:matrix((r,col)=>spec.notes?.[`${r}:${col}`]||'');},getRichTextValues:()=>{throw new Error('Native rich host bridge forbidden');},getValues:()=>{throw new Error('Raw read forbidden');}};
      if(options.noNotes)delete range.getNotes;return range;
    }};});
  const book={getId:()=>options.bookId||FILE,getSheets:()=>sheets};
  const selected=(ids=[0])=>ids.map(id=>{const spec=specs.find((s,i)=>(s.id??i)===id),headerIndex=spec.headerIndex??0;return{source:{sheetId:id,name:spec.name??'Лист '+id,headers:spec.rows[headerIndex].slice(),headerIndex,hasHeader:true,rowCount:spec.rows.length,columnCount:spec.rows[0].length},sourceDisplayValues:spec.rows.map(r=>r.slice()),cellContacts:spec.cellContacts||null,fingerprint:digest(JSON.stringify(spec.rows))};});
  const guard=()=>{calls.guards++;if(!allowed)throw new Error('[OUTSIDE_REGISTRY] revoked');};
  return{c,calls,selected,specs,read:(models=selected(),extra={})=>c.legacyContactHistoryReadWorkbook_(book,FILE,'companies',guard,models,{deadline:now+120000,...extra}),now:()=>now};
}
function output(emails=[],phones=[]){return{email:{headers:['Email'],rows:emails.map(x=>[x])},phone:{headers:['Телефон'],rows:phones.map(x=>[x])},warnings:[]};}
function cell(list,row,header){return list.rows[row][list.headers.indexOf(header)];}

test('only selected source contacts become output rows, while old Email and Telegram reports supply history',()=>{
  const f=fixture([{id:0,name:'Сбор',rows:[['Компания','Email','Телефон'],['Альфа','current@example.test','+79990000001']]},{id:1,name:'Старая Email',rows:[['Email','Валидация','Провайдер','Статус'],['current@example.test','valid','Yandex','Рассылка'],['archive-only@example.test','invalid','Other','']]},{id:2,name:'TG отчет',rows:[['Телефон','ID_TG','Nickname_TG','Active_days_ago'],['79990000001','123456','some_person','41']]}]);
  const result=f.read(),data=output(['current@example.test'],['+79990000001']);f.c.legacyContactHistoryEnrich_(data,result.history);
  assert.equal(result.complete,true);assert.ok(result.history['email:archive-only@example.test']);assert.equal(data.email.rows.length,1);assert.equal(cell(data.email,0,'Валидация'),'Проверить историю контакта');assert.equal(cell(data.email,0,'Провайдер'),'Yandex');assert.equal(cell(data.phone,0,'ID_TG'),'123456');assert.equal(cell(data.phone,0,'Для Telegram'),'Нет');assert.equal(f.calls.heavy,0);assert.equal(f.calls.display.some(x=>x.id===0),false,'selected raw model reused');
});

test('sheets with no history columns read a bounded header probe and never their full body',()=>{
  const rows=[['Компания','Сайт'],...Array.from({length:500},(_,i)=>['Архив '+i,'https://example.test'])];
  const f=fixture([{id:0,rows:[['Компания','Email'],['Новая','new@example.test']]},{id:1,rows}]);const r=f.read();assert.equal(Object.keys(r.history).length,0);assert.deepEqual(f.calls.display.filter(x=>x.id===1).map(x=>x.height),[10]);assert.equal(f.calls.notes.length,0);
});

test('header probes find a report header below titles and retain absolute provenance',()=>{
  const f=fixture([{id:0,rows:[['Email'],['one@example.test']]},{id:1,rows:[['Отчет за ноябрь','',''],['Email','Валидация','Провайдер'],['one@example.test','invalid','Other']]}]);const r=f.read();assert.equal(r.history['email:one@example.test'].validation.status,'Невалиден');assert.equal(r.history['email:one@example.test'].evidence[0].row,3);
});

test('conflicting old checks from separate reports are preserved conservatively as review',()=>{
  const f=fixture([{id:0,rows:[['Email'],['one@example.test']]},{id:1,rows:[['Email','Валидация'],['one@example.test','valid']]},{id:2,rows:[['Email','Валидация'],['one@example.test','invalid']]}]);const r=f.read(),data=output(['one@example.test']);f.c.legacyContactHistoryEnrich_(data,r.history);assert.equal(cell(data.email,0,'Валидация'),'Проверить историю контакта');assert.match(cell(data.email,0,'Результат проверки'),/valid; invalid/);
});

test('completed verdict with several candidate emails or phones becomes review instead of new paid work',()=>{
  const f=fixture([{id:0,rows:[['Email'],['one@example.test']]},{id:1,rows:[['Email','Валидация'],['one@example.test; two@example.test','valid']]},{id:2,rows:[['Телефон','ID_TG','Active_days_ago'],['79990000001;79990000002','12345','1']]}]);const r=f.read(),data=output(['one@example.test','two@example.test'],['+79990000001','+79990000002']);f.c.legacyContactHistoryEnrich_(data,r.history);
  assert.ok(data.email.rows.every((_,i)=>cell(data.email,i,'Валидация')==='Проверить историю контакта'));assert.ok(data.phone.rows.every((_,i)=>cell(data.phone,i,'Валидация')==='Проверить историю контакта'));assert.ok(data.phone.rows.every((_,i)=>cell(data.phone,i,'ID_TG')===''));
});

test('changed email with an old owned binding inherits neither completion nor mailing history',()=>{
  const f=fixture([{id:0,rows:[['Email'],['new@example.test']]},{id:1,rows:[['Email','Валидация','Статус'],['new@example.test','valid','Рассылка']],notes:{'2:2':PREFIX+key('email','old@example.test')}}]);const r=f.read();assert.equal(r.history['email:new@example.test'],undefined);
  f.specs[1].rows[1][0]='old@example.test';const current=f.read();assert.equal(current.history['email:old@example.test'].validation.status,'Валиден');assert.deepEqual(plain(current.history['email:old@example.test'].work),['Рассылка']);
});

test('selected normalized source models also read owned note bindings before reusing their status',()=>{
  const f=fixture([{id:0,rows:[['Email','Валидация'],['new@example.test','valid']],notes:{'2:2':PREFIX+key('email','old@example.test')}}]);assert.equal(f.read().history['email:new@example.test'],undefined);assert.equal(f.calls.display.length,0);assert.equal(f.calls.notes.length,1);
});

test('changed phone cannot inherit another number Telegram ID, while unchanged bound phone retains it',()=>{
  const f=fixture([{id:0,rows:[['Телефон'],['79990000002']]},{id:1,rows:[['Телефон','ID_TG','Active_days_ago','Валидация'],['79990000002','12345','2','Telegram: активен']],notes:{'2:4':PREFIX+key('telegram','+79990000001')}}]);assert.equal(f.read().history['telegram:+79990000002'],undefined);f.specs[1].rows[1][0]='79990000001';assert.equal(f.read().history['telegram:+79990000001'].validation.idTg,'12345');
});

test('prepared contact reports retain review, exclusions and negative Telegram completion on re-import',()=>{
  const f=fixture([{id:0,rows:[['Email','Телефон'],['one@example.test','79990000001']]},
    {id:1,rows:[['Email','Валидация','Результат проверки','Статус из источника'],['one@example.test','Проверить историю контакта','legacy-history:v1:{"validation":"valid","work":["Фильтр"]}','Фильтр']]},
    {id:2,rows:[['Телефон','Валидация','ID_TG','Active_days_ago'],['79990000001','Telegram не найден','','']]}]);
  const history=f.read().history,data=output(['one@example.test'],['+79990000001']);f.c.legacyContactHistoryEnrich_(data,history);
  assert.equal(cell(data.email,0,'Валидация'),'Проверить историю контакта');assert.equal(cell(data.email,0,'Статус из источника'),'Фильтр');assert.match(cell(data.email,0,'Результат проверки'),/legacy-history/);
  assert.equal(cell(data.phone,0,'Валидация'),'Telegram не найден');assert.equal(cell(data.phone,0,'Для Telegram'),'Нет');assert.equal(cell(data.phone,0,'ID_TG'),'');
});

test('manual completed source statuses remain finished while pending statuses stay new',()=>{
  const statuses=['Исключено вручную','Нужна ручная проверка','Принимает все письма','Одноразовый ящик','not_verified','Не проверено','Ожидает проверки'];
  const f=fixture([{id:0,rows:[['Email'],['one@example.test']]},{id:1,rows:[['Email','Валидация'],...statuses.map((status,i)=>[`p${i}@example.test`,status])]}]);const history=f.read().history;
  statuses.slice(0,4).forEach((status,i)=>assert.equal(history[`email:p${i}@example.test`].validation.status,status));statuses.slice(4).forEach((_,i)=>assert.equal(history[`email:p${i+4}@example.test`],undefined));
});

test('an Email report cannot transfer its validation or mailing work to contextual phone columns',()=>{
  const f=fixture([{id:0,name:'Сбор',rows:[['Email','Телефон'],['one@example.test','79990000001']]},
    {id:1,name:'Email (1)',rows:[['Email','Телефон','Валидация','Статус'],['one@example.test','79990000001','valid','Рассылка']]}]);
  const history=f.read().history;assert.equal(history['email:one@example.test'].validation.status,'Валиден');assert.equal(history['email:one@example.test'].work[0],'Рассылка');assert.equal(history['telegram:+79990000001'],undefined);
});

test('NSA and explicit Telegram report fields cannot transfer phone verdicts to contextual email columns',()=>{
  for(const [name,headers,row] of [['NSA',['Телефон','Email','Валидация'],['79990000001','one@example.test','Невалиден']],
    ['Отчет',['Телефон','Email','ID_TG','Active_days_ago','Валидация'],['79990000001','one@example.test','нет','','Telegram не найден']]]){
    const f=fixture([{id:0,name:'Сбор',rows:[['Email','Телефон'],['one@example.test','79990000001']]},{id:1,name,rows:[headers,row]}]);const history=f.read().history;
    assert.equal(history['email:one@example.test'],undefined);assert.ok(history['telegram:+79990000001'].validation);assert.equal(history['telegram:+79990000001'].validation.status,row.at(-1));
  }
});

test('a generic email verdict in an unknown mixed source does not claim a phone has been checked',()=>{
  const f=fixture([{id:0,name:'Сбор',rows:[['Email','Телефон','Валидация'],['one@example.test','79990000001','valid']]}]);const history=f.read().history;
  assert.equal(history['email:one@example.test'].validation.status,'Валиден');assert.equal(history['telegram:+79990000001'],undefined);
});

test('a wide generic source preserves an email verdict and independently paired Telegram evidence together',()=>{
  const f=fixture([{id:0,name:'Готово',rows:[['Email','Телефон','Валидация','ID_TG','Active_days_ago'],['one@example.test','79990000001','valid','123456','12']]}]);
  const history=f.read().history;assert.equal(history['email:one@example.test'].validation.status,'Валиден');assert.equal(history['telegram:+79990000001'].validation.idTg,'123456');assert.equal(history['telegram:+79990000001'].validation.eligible,true);
});

test('completed hidden-link or unparseable contact identities fail closed rather than losing old checks',()=>{
  for(const report of [[['Email','Валидация'],['Написать','valid']],[['Телефон','ID_TG'],['https://wa.me/79990000001','12345']]]){const f=fixture([{id:0,rows:[['Email'],['new@example.test']]},{id:1,rows:report}]);assert.throws(()=>f.read(),/LEGACY_HISTORY_PARTIAL/);}
  const unchecked=fixture([{id:0,rows:[['Email'],['new@example.test']]},{id:1,rows:[['Email','Валидация'],['Написать','not_verified']]}]);assert.equal(Object.keys(unchecked.read().history).length,0);
});

test('selected-model contacts already grounded in hidden links keep their manual exclusions',()=>{
  const f=fixture([{id:0,rows:[['Данные','Статус'],['Написать','Фильтр']],cellContacts:{'2:1':{emails:['hidden@example.test'],phones:[]}}}]);const r=f.read();assert.equal(r.history['email:hidden@example.test'].work[0],'Фильтр');
});

test('deadline, data-shape and note-shape failures cannot return a partial history map',()=>{
  for(const extra of [{badDisplay:true},{badNotes:true},{noNotes:true},{onDisplay:({tick})=>tick(120001)}]){
    const f=fixture([{id:0,rows:[['Email'],['one@example.test']]},{id:1,rows:[['Email','Валидация'],['one@example.test','valid']]}],extra);assert.throws(()=>f.read(),/LEGACY_HISTORY_PARTIAL/);
  }
  const cap=fixture([{id:0,rows:[['Email'],['one@example.test']]},{id:1,rows:[['Email','Валидация'],['one@example.test','valid']]}],{onDisplay:({tick})=>tick(120001)});assert.throws(()=>cap.read(undefined,{deadline:cap.now()+3600000}),/LEGACY_HISTORY_PARTIAL/);
});

test('scope revocation after a read aborts immediately, and mismatched book or allowed leaf IDs fail',()=>{
  const specs=[{id:0,rows:[['Email'],['one@example.test']]},{id:1,rows:[['Email','Валидация'],['one@example.test','valid']]}];
  const moved=fixture(specs,{onDisplay:({revoke})=>revoke()});assert.throws(()=>moved.read(),/OUTSIDE_REGISTRY/);
  assert.throws(()=>fixture(specs,{bookId:'another_book_123456'}).read(),/LEGACY_HISTORY_PARTIAL/);assert.throws(()=>fixture(specs).read(undefined,{sourceSheetIds:[99]}),/LEGACY_HISTORY_PARTIAL/);assert.throws(()=>fixture(specs).read(undefined,{sourceSheetIds:[1]}),/LEGACY_HISTORY_PARTIAL/);
});

test('history/contact changes and owned-note changes participate in the snapshot fingerprint',()=>{
  const f=fixture([{id:0,rows:[['Email'],['one@example.test']]},{id:1,rows:[['Email','Валидация'],['one@example.test','valid']],notes:{'2:2':PREFIX+key('email','one@example.test')}}]);const a=f.read();assert.equal(f.read().fingerprint,a.fingerprint);f.specs[1].rows[1][1]='invalid';const b=f.read();assert.notEqual(b.fingerprint,a.fingerprint);f.specs[1].notes['2:2']=PREFIX+key('email','other@example.test');assert.notEqual(f.read().fingerprint,b.fingerprint);
});

test('bounded reads account for selected source data, report values and notes without native host scans',()=>{
  const f=fixture([{id:0,rows:[['Email'],['one@example.test']]},{id:1,rows:[['Email','Валидация'],...Array.from({length:12},(_,i)=>[`p${i}@example.test`,'valid'])]}],{limits:{chunkCells:4}});const r=f.read();assert.equal(Object.keys(r.history).length,12);assert.ok(f.calls.display.filter(x=>x.row>1).every(x=>x.height*x.columns<=4));assert.equal(f.calls.heavy,0);
  assert.throws(()=>fixture([{id:0,rows:[['Email'],['one@example.test']]},{id:1,rows:[['Email','Валидация'],['one@example.test','valid']]}],{limits:{maxCells:3}}).read(),/LEGACY_HISTORY_PARTIAL/);
});
