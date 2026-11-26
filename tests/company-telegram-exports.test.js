import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const FILE='companies_111111111111', SEG='segment_111111111111';
const columns=['Статус','ID_TG','ID компании','Контакт','Тип контакта','Валидация','Active_days_ago','Nickname_TG','Имя'];
const header='"Username","Telegram ID","Имя","Телефон","Компания","Сайт","ИНН"';
const record=(contact,workflow='Готов',extra={})=>({
  'Контакт':contact,'Тип контакта':contact.startsWith('@')?'юзернейм':'телефон','Статус':workflow,...extra
});
function sheet(values) {
  return {getLastColumn:()=>values[0].length,getLastRow:()=>values.length,getRange:(row,col,n,w)=>({
    getDisplayValues:()=>values.slice(row-1,row-1+n).map(line=>line.slice(col-1,col-1+w))
  })};
}
function fixture(entries) {
  const c=vm.createContext({});
  for(const name of ['Config','PreparedData','Promouser','ContactSync','SegmentRecords','SheetEditor','CompanyTelegramExports'])
    vm.runInContext(readFileSync(new URL('../src/'+name+'.gs',import.meta.url),'utf8'),c,{filename:name});
  const s={root:'root',project:'own',workspaceRole:'segment-companies',telegramSchema:2,schemaTag:'2',folder:SEG,file:FILE,version:'1',attempts:0,run:()=>{}};
  const grid=[columns,...entries.map(row=>columns.map(key=>row[key]??''))], contacts=sheet(grid);
  const master=sheet([['ID компании','Компания','Сайт','ИНН'],['a','=Company','https://example.test','00123'],['b','Другая','example.test','00124']]);
  const context={rootId:'root'};
  const book={getSheets:()=>[Object.assign(contacts,{getSheetId:()=>0}),Object.assign(master,{getSheetId:()=>3})]};
  Object.assign(c,{authorize_:()=>({...context,rootId:s.root}),api_:fn=>fn(),registryProjectId_:()=>s.project,registrySegmentProject_:()=> 'own',
    id_:value=>value,segmentInput_:value=>value,fail_:(code,msg)=>{throw Object.assign(new Error(msg),{code});},
    getContactWorkspace_:()=>({enrolled:true,segmentId:SEG,role:s.workspaceRole,companyTelegramSchema:s.telegramSchema,targets:{phoneSheetId:0}}),
    segmentCardFiles_:()=>{s.run(++s.attempts);return {files:{companies:{id:s.file,version:s.version,
      metadata:{appProperties:{registryContactRoot:'root',registryCompanyTelegramSchema:s.schemaTag,registryContactPhoneSheetId:'0',registrySegmentMasterSheetId:'3'}}}}};},
    SpreadsheetApp:{openById:()=>book}});
  return {c,s,grid,run:(mode='ready',payload={})=>c.exportCompanyTelegramCsv_({id:FILE,sheetId:0,mode,...payload})};
}

test('a new username with manual validation enters the mailing CSV only after explicit approval',()=>{
  const f=fixture([record('@AuthorName','Новый контакт',{'Валидация':'Ручная проверка'})]);
  assert.equal(f.run().state,'empty');
  f.grid[1][columns.indexOf('Статус')]='Готов'; f.s.version='2';
  const csv=f.run();
  assert.equal(csv.count,1);assert.equal(csv.withoutPhone,1);assert.ok(csv.csv.includes('"authorname","","","","","",""'));
  assert.equal(f.grid[1][columns.indexOf('Валидация')],'Ручная проверка');
});

test('both exports use the supplied Numshield header, encoding, line endings and explicit status',()=>{
  const f=fixture([
    record('89991002030','Готов',{'ID_TG':'123456789012','ID компании':'a','Nickname_TG':'@NickName','Имя':'=1+1'}),
    record('+7 (999) 100-20-30','Готов',{'ID компании':'a'}),
    record('+79991002031','Записная книжка',{'ID_TG':'995','ID компании':'b','Nickname_TG':'@mustnotappear'}),
    record('+79991002032','Новый контакт'),record('+79991002033','Ручная проверка'),record('+79991002034','Не активен > 30 дней'),
    record('@WithoutPhone'),record('@NICKNAME'),record('+12025550123'),record('+74950000005'),
    record('+79991002039','Готов',{'ID компании':'a'})
  ]);
  const ready=f.run();assert.equal(ready.state,'ready');assert.equal(ready.count,2);assert.equal(ready.duplicates,2);
  assert.equal(ready.withoutPhone,1);assert.equal(ready.skippedNoUsername,1);
  assert.equal(ready.csv,'\uFEFF'+header+'\r\n"nickname","123456789012","\'=1+1","+79991002030","\'=Company","https://example.test","00123"\r\n"withoutphone","","","","","",""\r\n');
  const book=f.run('addressBook');assert.equal(book.count,1);
  assert.equal(book.csv,'\uFEFF'+header+'\r\n"","","","+79991002031","Другая","example.test","00124"\r\n');
});

test('duplicates never borrow an arbitrary company, held or contradictory rows are not exported',()=>{
  const f=fixture([
    record('+79991111111','Готов',{'ID компании':'a','Nickname_TG':'@testnick'}),record('+79991111111','Готов',{'ID компании':'b'}),
    record('+79991111112','Готов'),record('+79991111112','Невалид'),
    record('+79991111113','Записная книжка'),record('+79991111113','Готов'),
    record('@NoNumber','Записная книжка'),record('+79991111114','Готов',{'Тип контакта':'юзернейм'})
  ]);
  const ready=f.run();assert.equal(ready.count,1);assert.ok(ready.csv.includes('"+79991111111","","",""'));
  const book=f.run('addressBook');assert.equal(book.state,'empty');assert.equal(book.csv,undefined);assert.equal(book.filename,undefined);
});

test('export is tied to its current project, registered companies workbook, tab and stable source version',()=>{
  const f=fixture([record('+79991002030')]);
  assert.throws(()=>f.run('anything'),{code:'INVALID_REQUEST'});
  assert.throws(()=>f.run('ready',{sheetId:3}),{code:'TELEGRAM_TARGET'});
  assert.throws(()=>f.run('ready',{id:'another'}),{code:'TELEGRAM_TARGET'});
  f.s.workspaceRole='segment-lpr';assert.throws(()=>f.run(),{code:'TELEGRAM_TARGET'});
  f.s.workspaceRole='segment-companies';f.s.project='other';assert.throws(()=>f.run(),{code:'OUTSIDE_PROJECT'});
  f.s.project='own';f.s.telegramSchema=1;assert.throws(()=>f.run(),{code:'TELEGRAM_TARGET'});
  f.s.telegramSchema=2;f.s.schemaTag='';assert.throws(()=>f.run(),{code:'TELEGRAM_TARGET'});
  const legacy=fixture([record('@Username')]);legacy.grid[0]=legacy.grid[0].map(header=>header==='Контакт'?'Телефон':header);
  assert.throws(()=>legacy.run(),{code:'TELEGRAM_SCHEMA'});
  const moved=fixture([record('+79991002030')]);moved.s.run=n=>{if(n===2)moved.s.version='2';};
  assert.throws(()=>moved.run(),{code:'SOURCE_CHANGED'});
});
