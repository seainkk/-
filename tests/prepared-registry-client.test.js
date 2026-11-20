import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const client=readFileSync(new URL('../src/Client.html',import.meta.url),'utf8');
function source(name){let start=client.indexOf('function '+name+'(');assert.ok(start>=0,name);if(client.slice(start-6,start)==='async ')start-=6;let depth=0,quote=null,escape=false;for(let i=client.indexOf('{',start);i<client.length;i++){const ch=client[i];if(quote){if(escape)escape=false;else if(ch==='\\')escape=true;else if(ch===quote)quote=null;continue;}if(['"',"'",'`'].includes(ch)){quote=ch;continue;}if(ch==='{')depth++;if(ch==='}'&&!--depth)return client.slice(start,i+1);}throw Error('Unclosed '+name);}
test('legacy mixed bases stay in both sections without changing stored metadata',()=>{const ctx=vm.createContext({});vm.runInContext(source('normalizeContents')+'\n'+source('sourceInSection'),ctx);const item={contents:['companies','lpr']};assert.equal(ctx.sourceInSection(item,'companies'),true);assert.equal(ctx.sourceInSection(item,'lpr'),true);assert.equal(ctx.sourceInSection({contents:['companies']},'lpr'),false);assert.equal(ctx.sourceInSection({contents:null},'lpr'),true,'Unavailable metadata never hides a file');assert.deepEqual(item.contents,['companies','lpr']);});
test('creation is permitted only for complete preview of the chosen sheet',()=>{const ctx=vm.createContext({});vm.runInContext(source('preparedCanConfirm'),ctx);const base={selectedSheetId:0,preview:{canConfirm:true,sheetId:0,previewToken:'snapshot'}};assert.equal(ctx.preparedCanConfirm(base),true);for(const preview of [{...base.preview,canConfirm:false},{...base.preview,sheetId:7},{...base.preview,previewToken:null}])assert.equal(ctx.preparedCanConfirm({...base,preview}),false);assert.equal(ctx.preparedCanConfirm(null),false);});
test('a new import offers one section and fixed three-sheet preview, without the move operation',()=>{const html=readFileSync(new URL('../src/Index.html',import.meta.url),'utf8');assert.match(html,/id="br-section-companies"/);assert.match(html,/id="br-section-lpr"/);assert.match(html,/id="br-prepared-preview"/);assert.match(html,/id="br-prepared-confirm"[^>]*disabled/);assert.doesNotMatch(html,/name="br-link-transfer"/);for(const name of ['GridPanel','GridStyles','GridClient'])assert.ok(html.includes("include_('"+name+"')"));});
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(predicate){for(let attempt=0;attempt<100;attempt++){if(predicate())return;await tick();}assert.fail('Expected transport transition did not occur');}
function transportScope(overrides={}){
  const calls=[],held=[],metrics={reads:0,writes:0,maxReads:0,maxWrites:0};
  const ctx=vm.createContext({accessEpoch:2,accessReady:true,workspaceRpcQueue:Promise.resolve(),networkPending:0,readPending:0,busy:false,sourceSaving:null,importing:false,segmentSaving:false,segmentPreviewLoading:false,sourceLoading:false,setTimeout,...overrides});
  ctx.rpc=(method,payload)=>new Promise(resolve=>{const read=ctx.isReadRpc(method);ctx.networkPending++;metrics[read?'reads':'writes']++;metrics.maxReads=Math.max(metrics.maxReads,metrics.reads);metrics.maxWrites=Math.max(metrics.maxWrites,metrics.writes);calls.push({method,payload});held.push({method,done:false,release(){assert.equal(this.done,false);this.done=true;ctx.networkPending--;metrics[read?'reads':'writes']--;resolve({method});}});});
  vm.runInContext(['isReadRpc','readRpc','viewMutationBlocked','workspaceMutationBlocked','workspaceRpc'].map(source).join('\n'),ctx);
  return {ctx,calls,held,metrics,release(method){const item=held.find(call=>!call.done&&call.method===method);assert.ok(item,'Held RPC: '+method);item.release();}};
}
test('independent allowlisted reads bypass catalog waits and stay bounded at two',async()=>{
  const scope=transportScope({sourceLoading:true}),{ctx,calls,metrics}=scope;
  const first=ctx.workspaceRpc('getGridWorkbook',{id:'a'}),second=ctx.workspaceRpc('getPromouserSettings',{}),third=ctx.workspaceRpc('getColdySettings',{});
  await until(()=>calls.length===2);assert.deepEqual(calls.map(call=>call.method),['getGridWorkbook','getPromouserSettings']);assert.equal(metrics.maxReads,2);
  scope.release('getGridWorkbook');await until(()=>calls.length===3);scope.release('getPromouserSettings');scope.release('getColdySettings');await Promise.all([first,second,third]);assert.equal(ctx.readPending,0);assert.equal(ctx.networkPending,0);assert.equal(metrics.maxReads,2);
  for(const method of ['configurePromouser','saveGridRange','startColdyValidation','previewColdyValidation','unexpectedMethod'])assert.equal(ctx.isReadRpc(method),false,method+' stays on the mutation path');
});
test('workspace mutations wait for catalog work, remain serial and can pass background analytics',async()=>{
  const scope=transportScope({sourceLoading:true}),{ctx,calls,metrics}=scope;
  const analytics=ctx.workspaceRpc('getSegmentsDashboard',{includeAnalysis:true});
  const first=ctx.workspaceRpc('configurePromouser',{enabled:false}),second=ctx.workspaceRpc('saveGridRange',{id:'a',requestId:'stable-receipt'});
  await tick();assert.deepEqual(calls.map(call=>call.method),['getSegmentsDashboard']);ctx.sourceLoading=false;
  await until(()=>calls.length===2);assert.equal(calls[1].method,'configurePromouser');assert.equal(metrics.writes,1);scope.release('configurePromouser');await until(()=>calls.length===3);assert.equal(calls[2].method,'saveGridRange');assert.equal(calls[2].payload.requestId,'stable-receipt');scope.release('saveGridRange');scope.release('getSegmentsDashboard');await Promise.all([analytics,first,second]);assert.equal(metrics.maxWrites,1);assert.equal(ctx.networkPending,0);
});
test('queued reads and mutations cannot dispatch after their access epoch is revoked',async()=>{
  const scope=transportScope(),{ctx,calls}=scope;
  const first=ctx.workspaceRpc('getGridWorkbook',{id:'a'}),second=ctx.workspaceRpc('getPromouserSettings',{}),third=ctx.workspaceRpc('getColdySettings',{});
  const rejected=assert.rejects(third,/Доступ/);ctx.accessReady=false;ctx.accessEpoch++;await rejected;assert.equal(calls.length,2);scope.release('getGridWorkbook');scope.release('getPromouserSettings');await Promise.all([first,second]);
  const blocked=transportScope({sourceLoading:true});const pending=blocked.ctx.workspaceRpc('saveGridRange',{id:'a',requestId:'original-receipt'});blocked.ctx.accessReady=false;blocked.ctx.accessEpoch++;await assert.rejects(pending,/Доступ/);assert.equal(blocked.calls.length,0);
});
test('a viewport superseded while waiting for the global read budget never dispatches',async()=>{
  const scope=transportScope(),{ctx,calls}=scope;let allowed=true,settled=false,result;
  const first=ctx.workspaceRpc('getGridWorkbook',{id:'a'}),second=ctx.workspaceRpc('getPromouserSettings',{});
  const viewport=ctx.workspaceRpc('getGridRange',{id:'a',sheetId:0,row:100},()=>allowed).then(value=>{settled=true;result=value;});
  await tick();allowed=false;scope.release('getGridWorkbook');await until(()=>settled||calls.length===3);
  for(const item of scope.held)if(!item.done)item.release();await Promise.all([first,second,viewport]);
  assert.equal(result,null);assert.deepEqual(calls.map(call=>call.method),['getGridWorkbook','getPromouserSettings']);
});

test('a resumed confirmed job can continue without replaying the original preview',()=>{const ctx=vm.createContext({});vm.runInContext(source('preparedCanConfirm')+'\n'+source('preparedCanAdvance'),ctx);assert.equal(ctx.preparedCanAdvance({resumed:true,confirmationRequested:true,confirmRequestId:'stable-confirm-id',preview:null}),true);assert.equal(ctx.preparedCanAdvance({resumed:true,confirmationRequested:false,confirmRequestId:'stable-confirm-id',preview:null}),false);assert.equal(ctx.preparedCanAdvance({resumed:true,confirmationRequested:true,preview:null}),false);});
