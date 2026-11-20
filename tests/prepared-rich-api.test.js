import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';

const FILE='prepared_rich_file_1234567890';
const plain=value=>JSON.parse(JSON.stringify(value));

function fixture(rows,options={}) {
  const calls={api:[],nativeReads:0,nativeMethods:0,guards:0,writes:0,events:[]};
  const width=options.width??Math.max(0,...rows.map(row=>row.length)),gid=options.gid??0,name=options.name??"Сбор O'Brien";
  let allowed=true;
  const cell=(r,c)=>rows[r-1]?.[c-1]??'';
  const shown=(r,c)=>options.display?.[`${r}:${c}`]??String(cell(r,c));
  function native(r,c) {
    const spec=options.rich?.[`${r}:${c}`];if(!spec)return null;
    const runs=spec.runs||[{start:0,text:shown(r,c),url:spec.url}];
    const method=value=>{calls.nativeMethods++;if(options.forbidNativeMethods)throw new Error('Native host-bridge call forbidden');return value;};
    return{getLinkUrl:()=>method(spec.url||null),getRuns:()=>method(runs.map(run=>({getText:()=>method(run.text),getLinkUrl:()=>method(run.url||null),getStartIndex:()=>method(run.start),getEndIndex:()=>method(run.start+run.text.length)})))};
  }
  const c=vm.createContext({console,Date});
  vm.runInContext(['ContactPreview.gs','SourceRecords.gs','PreparedData.gs'].map(file=>readFileSync(new URL('../src/'+file,import.meta.url),'utf8')).join('\n'),c);
  c.digest_=value=>crypto.createHash('sha256').update(value).digest('base64url');
  c.fail_=(code,message)=>{throw Object.assign(new Error(`[${code}] ${message}`),{registryCode:code});};
  if(options.limits)c.PREPARED_DATA_LIMITS={...c.PREPARED_DATA_LIMITS,...options.limits};
  const guard=()=>{calls.guards++;calls.events.push('guard');if(!allowed)throw new Error('[OUTSIDE_REGISTRY] Moved draft');options.guard?.({calls,revoke:()=>{allowed=false;}});};
  const sheet={getSheetId:()=>gid,getName:()=>name,getLastRow:()=>rows.length,getLastColumn:()=>width,
    getRange:(row,column,height,columns)=>{
      const matrix=getter=>Array.from({length:height},(_,y)=>Array.from({length:columns},(_,x)=>getter(row+y,column+x)));
      const range={getValues:()=>matrix(cell),getDisplayValues:()=>matrix(shown),getFormulas:()=>matrix((r,c)=>options.formulas?.[`${r}:${c}`]||''),
        getRichTextValues:()=>{calls.nativeReads++;if(options.forbidNativeReads)throw new Error('Native rich matrix forbidden');return options.shortNative?[]:matrix(native);},
        setValues:()=>{calls.writes++;throw new Error('No writes allowed');}};
      if(options.noNative)delete range.getRichTextValues;return range;
    }};
  if(!options.noApi)c.Sheets={Spreadsheets:{get:(fileId,request)=>{
    calls.api.push({fileId,request:plain(request)});calls.events.push('api');assert.equal(calls.events.at(-2),'guard','scope checked immediately before Advanced Sheets read');
    const match=request.ranges[0].match(/!A(\d+):[A-Z]+(\d+)$/);assert.ok(match);const first=Number(match[1]),height=Number(match[2])-first+1;
    const grid={startRow:first-1,startColumn:0,rowData:Array.from({length:height},(_,y)=>({values:Array.from({length:width},(_,x)=>{
      const r=first+y,co=x+1,value={formattedValue:shown(r,co)};return Object.assign(value,plain(options.apiCells?.[`${r}:${co}`]||{}));
    })}))};
    const response={spreadsheetId:FILE,sheets:[{properties:{sheetId:gid,title:name},data:[grid]}]};
    return options.api?options.api({fileId,request,response,first,height,calls,revoke:()=>{allowed=false;}}):response;
  }}};
  return{c,sheet,calls,guard,revoke:()=>{allowed=false;},read:()=>c.preparedDataRead_(sheet,FILE,options.section||'companies',{guard}),
    grid:(response,first=1,height=rows.length)=>c.preparedDataRichApiGrid_(response,FILE,gid,name,first,height,width,Array.from({length:height},(_,y)=>Array.from({length:width},(_,x)=>shown(first+y,x+1))))};
}

test('a single bounded Sheets JSON read replaces every native RichTextValue method and matrix read',()=>{
  const f=fixture([['Company_ID','Компания','Ссылка'],['A','Альфа','Связаться']],{forbidNativeReads:true,forbidNativeMethods:true,apiCells:{'2:3':{hyperlink:'https://wa.me/79991234567'}}});
  const result=f.read();assert.equal(result.complete,true);assert.equal(result.canConfirm,true);assert.equal(result.counts.phones,1);assert.equal(result.phoneRows[0][0],'+79991234567');
  assert.equal(f.calls.api.length,1);assert.equal(f.calls.nativeReads,0);assert.equal(f.calls.nativeMethods,0);assert.equal(f.calls.writes,0);
  assert.equal(f.calls.api[0].fileId,FILE);assert.equal(f.calls.api[0].request.ranges[0],"'Сбор O''Brien'!A1:C2");assert.match(f.calls.api[0].request.fields,/textFormatRuns\(startIndex,format\(link\)\)/);assert.match(f.calls.api[0].request.fields,/formattedValue/);
  assert.ok(f.calls.events.indexOf('api')>=1);assert.equal(f.calls.events[f.calls.events.indexOf('api')+1],'guard');
});

test('multi-link runs keep UTF-16 offsets and reveal hidden emails and phones behind labels',()=>{
  const text='😀 TG Email',runStart=6;
  const f=fixture([['Company_ID','Контакты'],['A',text]],{forbidNativeReads:true,apiCells:{'2:2':{textFormatRuns:[{startIndex:0,format:{link:{uri:'https://wa.me/79991234567'}}},{startIndex:runStart,format:{link:{uri:'mailto:sales@example.test'}}}]}}});
  const r=f.read();assert.equal(r.complete,true);assert.equal(r.counts.phones,1);assert.equal(r.counts.emails,1);
  assert.deepEqual(plain(r.sourceLinks[0].runs),[{start:0,end:6,url:'https://wa.me/79991234567'},{start:6,end:text.length,url:'mailto:sales@example.test'}]);
});

test('whole-cell links, inherited run links, explicit clears and unique hyperlink supplements match native semantics',()=>{
  const f=fixture([['Email']]);const parse=(cell,text='abcdef')=>plain(f.c.preparedDataRichApiLinks_(cell,text));
  assert.deepEqual(parse({userEnteredFormat:{textFormat:{link:{uri:'mailto:a@example.test'}}}}),[{start:0,end:6,url:'mailto:a@example.test'}]);
  assert.deepEqual(parse({effectiveFormat:{textFormat:{link:{uri:'tel:+79991234567'}}},textFormatRuns:[{startIndex:0,format:{}},{startIndex:2,format:{link:{}}},{startIndex:4,format:{link:{uri:'https://wa.me/79997654321'}}}]}),[{start:0,end:2,url:'tel:+79991234567'},{start:4,end:6,url:'https://wa.me/79997654321'}]);
  assert.deepEqual(parse({hyperlink:'mailto:a@example.test',textFormatRuns:[{startIndex:2,format:{link:{uri:'mailto:a@example.test'}}}]}),[{start:2,end:6,url:'mailto:a@example.test'}]);
  assert.deepEqual(parse({hyperlink:'mailto:a@example.test'}),[{start:0,end:6,url:'mailto:a@example.test'}]);
});

test('formula snapshots and raw Date values retain SpreadsheetApp types while link metadata comes from JSON',()=>{
  const date=new Date('2026-11-20T00:00:00Z');
  const f=fixture([['Company_ID','Дата','Действие'],['A',date,'Позвонить']],{forbidNativeReads:true,display:{'2:2':'20.11.2026'},formulas:{'2:2':'=DATE(2026,11,20)','2:3':'=HYPERLINK("tel:+79991234567";"Позвонить")'},apiCells:{'2:3':{hyperlink:'tel:+79991234567'}}});
  const r=f.read();assert.equal(r.complete,true);assert.equal(r.sourceValues[1][1],date);assert.equal(r.sourceFormulas[1][2],'=HYPERLINK("tel:+79991234567";"Позвонить")');assert.equal(r.formulaSnapshots[0].valueType,'date');assert.equal(r.formulaSnapshots[0].value,'2026-11-20T00:00:00.000Z');assert.equal(r.counts.phones,1);
});

test('the API fast path and native implementation produce identical source/link fingerprints and extracted data',()=>{
  const rows=[['Company_ID','Компания','Контакты'],['A','Альфа','Почта Телефон']];
  const rich={'2:3':{runs:[{start:0,text:'Почта ',url:'mailto:a@example.test'},{start:6,text:'Телефон',url:'https://wa.me/79991234567'}]}};
  const native=fixture(rows,{noApi:true,rich}).read();
  const api=fixture(rows,{rich,forbidNativeReads:true,apiCells:{'2:3':{textFormatRuns:[{startIndex:0,format:{link:{uri:'mailto:a@example.test'}}},{startIndex:6,format:{link:{uri:'https://wa.me/79991234567'}}}]}}}).read();
  assert.equal(api.fingerprint,native.fingerprint);assert.equal(api.legacyFingerprint,native.legacyFingerprint);assert.deepEqual(plain(api.counts),plain(native.counts));assert.deepEqual(plain(api.sourceLinks),plain(native.sourceLinks));assert.deepEqual(plain(api.records),plain(native.records));
});

test('API errors fall back to the complete native rich-text read',()=>{
  const f=fixture([['Company_ID','Ссылка'],['A','Написать']],{rich:{'2:2':{url:'https://wa.me/79991234567'}},api:()=>{throw new Error('Advanced service unavailable');}});
  const r=f.read();assert.equal(r.complete,true);assert.equal(r.counts.phones,1);assert.equal(f.calls.api.length,1);assert.equal(f.calls.nativeReads,1);assert.ok(f.calls.nativeMethods>0);
});

test('missing or malformed API identity, range or populated cells never turn an incomplete link read into success',()=>{
  for(const mutate of [r=>{r.spreadsheetId='other_file_123456';},r=>{r.sheets[0].properties.sheetId=99;},r=>{r.sheets[0].properties.title='Wrong leaf';},r=>{r.sheets[0].data[0].startRow=1;},r=>{r.sheets[0].data[0].startColumn=1;},r=>{r.sheets[0].data=[];},r=>{r.sheets[0].data[0].rowData.pop();},r=>{delete r.sheets[0].data[0].rowData[1].values[1].formattedValue;},r=>{r.sheets[0].data[0].rowData[1].values[1].formattedValue='Changed display';},r=>{r.sheets.push(r.sheets[0]);}]){
    const f=fixture([['Company_ID','Ссылка'],['A','Написать']],{noNative:true,api:({response})=>{mutate(response);return response;}});const r=f.read();assert.equal(r.complete,false);assert.equal(r.canConfirm,false);assert.ok(r.warnings.some(w=>w.includes('ссылки')));
  }
});

test('sparse trailing blank cells and rows are accepted only where display values are actually blank',()=>{
  const f=fixture([['Company_ID','Ссылка',''],['A','Написать',''],['','','']],{forbidNativeReads:true,apiCells:{'2:2':{hyperlink:'https://wa.me/79991234567'}},api:({response})=>{
    for(const row of response.sheets[0].data[0].rowData)row.values.pop();response.sheets[0].data[0].rowData.pop();delete response.sheets[0].data[0].startRow;delete response.sheets[0].data[0].startColumn;return response;
  }});const r=f.read();assert.equal(r.complete,true);assert.equal(r.counts.sourceRows,1);assert.equal(r.counts.phones,1);assert.equal(f.calls.nativeReads,0);
});

test('smart chips and malformed run metadata fall back for that cell without native methods on ordinary cells',()=>{
  const f=fixture([['Company_ID','Ссылка','Другая ссылка'],['A','Человек','Другой канал']],{apiCells:{'2:2':{chipRuns:[{startIndex:0}]},'2:3':{hyperlink:'https://wa.me/79997654321'}},rich:{'2:2':{url:'mailto:person@example.test'},'2:3':{url:'should-not-read-native'}}});
  const r=f.read();assert.equal(r.complete,true);assert.equal(r.counts.emails,1);assert.equal(r.counts.phones,1);assert.equal(f.calls.nativeReads,1);assert.equal(r.sourceLinks.find(c=>c.column===3).runs[0].url,'https://wa.me/79997654321');
  const invalid=fixture([['Company_ID','Ссылка'],['A','Написать']],{apiCells:{'2:2':{textFormatRuns:[{startIndex:1000,format:{link:{uri:'https://wa.me/79997654321'}}}]}},rich:{'2:2':{url:'mailto:a@example.test'}}});const rr=invalid.read();assert.equal(rr.complete,true);assert.equal(rr.counts.emails,1);assert.equal(rr.counts.phones,0);
});

test('scope failures before or after the advanced read propagate instead of falling back',()=>{
  const before=fixture([['Email'],['a@example.test']]);before.revoke();assert.throws(()=>before.read(),/OUTSIDE_REGISTRY/);assert.equal(before.calls.api.length,0);assert.equal(before.calls.nativeReads,0);
  for(const throwsApi of [false,true]){const f=fixture([['Email'],['a@example.test']],{api:({response,revoke})=>{revoke();if(throwsApi)throw new Error('API failed too');return response;}});assert.throws(()=>f.read(),/OUTSIDE_REGISTRY/);assert.equal(f.calls.nativeReads,0);}
});

test('large ranges use one bounded API request per existing chunk with correct offsets and no host bridge calls',()=>{
  const rows=[['Company_ID','Компания','Email'],...Array.from({length:10},(_,i)=>[String(i),'Компания',`p${i}@example.test`])];
  const f=fixture(rows,{forbidNativeReads:true,limits:{chunkCells:9}});const r=f.read();assert.equal(r.complete,true);assert.equal(r.counts.emails,10);assert.equal(f.calls.api.length,4);assert.deepEqual(f.calls.api.map(c=>c.request.ranges[0]),["'Сбор O''Brien'!A1:C3","'Сбор O''Brien'!A4:C6","'Сбор O''Brien'!A7:C9","'Сбор O''Brien'!A10:C11"]);assert.equal(f.calls.nativeMethods,0);
});

test('the existing native fallback still marks a malformed rich matrix as partial',()=>{
  const f=fixture([['Email'],['a@example.test']],{shortNative:true,api:()=>{throw new Error('Try native');}});const r=f.read();assert.equal(r.complete,false);assert.equal(r.canConfirm,false);
});
