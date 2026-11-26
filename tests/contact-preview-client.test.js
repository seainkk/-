import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const client = readFileSync(new URL('../src/Client.html', import.meta.url), 'utf8');
function source(name) {
  const at = client.indexOf('function ' + name + '(');
  assert.ok(at >= 0);
  const start = client.lastIndexOf('async ', at) === at - 6 ? at - 6 : at;
  let depth = 0, quote = null, escaped = false;
  for (let i = client.indexOf('{', at); i < client.length; i++) {
    const c = client[i];
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return client.slice(start, i + 1);
  }
  assert.fail('Complete function: ' + name);
}

test('working tables can be opened by name independently of the base collection status', () => {
  const can = vm.runInNewContext(source('canOpenSourceWorkbook') + ';canOpenSourceWorkbook;');
  for (const status of ['collection','rework','ready']) assert.equal(can({mimeType:'application/vnd.google-apps.spreadsheet',status}),true);
  assert.equal(can({mimeType:'application/vnd.google-apps.spreadsheet',present:false}),false);
  for (const item of [null, {}, {mimeType:'text/csv'}]) assert.equal(can(item),false);
});

test('the catalog and the upload result no longer request a contact-analysis report', () => {
  const html=readFileSync(new URL('../src/Index.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/id="br-contact-preview(?:-|")/);
  assert.doesNotMatch(client,/\bpreviewSourceBaseContacts\b/);
  assert.match(html,/id="br-prepared-preview"/);
  assert.match(html,/id="br-segment-normalized-preview"/);
});

function completedImport() {
  const actions=[], opened=[], calls=[], sync=new Set();
  const context=vm.createContext({
    sourceData:{items:[]}, importOpen:true, preparedJobs:[{draftId:'draft'},{draftId:'another'}],
    preparedEpoch:0, preparedImport:{draftId:'draft'}, importRequests:new Map(), activeView:'sources',
    registrySection:'companies', segmentImportDestination:null, segmentReturnPending:null, lastSourceLoaded:1,
    pendingSyncViews:sync, nativeUrl:id=>'https://docs.google.com/spreadsheets/d/'+id+'/edit',
    $:()=>({reset(){},append(...nodes){actions.push(...nodes);}}), scheduleViewSync:()=>calls.push('sync'),
    clearPreparedPoll(){}, setImportContents(){}, showImportMessage(){}, updateImportView(){},
    renderSources:()=>calls.push('render'), notice:()=>calls.push('notice'), openGridWorkbook:(...args)=>opened.push(args),
    button:(kind,label)=>({label,dataset:{},addEventListener(event,handler){assert.equal(event,'click');this.click=handler;}})
  });
  vm.runInContext(source('finishPreparedBase'),context);
  const file={id:'prepared_sheet_id',name:'Пример'}, current={draftId:'draft',section:'lpr',status:'collection'};
  return {context,actions,opened,calls,sync,file,current,finish:result=>context.finishPreparedBase(result,current)};
}

test('an acknowledged upload offers the working table and validation directly, and refreshing keeps a single base', () => {
  const f=completedImport();
  f.finish({file:f.file});
  assert.equal(f.context.sourceData.items[0].id,f.file.id);
  assert.deepEqual(Array.from(f.context.sourceData.items[0].contents),['lpr']);
  assert.deepEqual(Array.from(f.context.preparedJobs,job=>job.draftId),['another']);
  assert.equal(f.context.importOpen,false);assert.equal(f.context.preparedImport,null);
  assert.deepEqual(f.actions.map(action=>action.label),['Работать с таблицей','Проверить новые контакты']);
  assert.deepEqual(f.opened,[]);for(const action of f.actions)action.click();
  assert.deepEqual(f.opened,[[f.file.id],[f.file.id,true]]);
  assert.deepEqual([...f.sync],['sources']);assert.ok(f.calls.includes('render'));
  f.finish({file:f.file});assert.equal(f.context.sourceData.items.length,1);
});

test('a confirmed upload with a segment destination retains the handoff to the import preview', () => {
  const f=completedImport(), destination={segmentId:'kitchens',name:'Кухни',category:'clients'};
  f.context.segmentImportDestination={returnPoint:{view:'segmentCard'}};
  f.finish({file:f.file,destination});
  assert.equal(f.context.segmentReturnPending.sourceId,f.file.id);
  assert.equal(f.context.segmentReturnPending.segmentId,destination.segmentId);
  assert.equal(f.context.segmentReturnPending.returnPoint.view,'segmentCard');
  assert.equal(f.context.segmentImportDestination,null);
});
