import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import vm from 'node:vm';

const first = '00000000-0000-0000-0000-000000000001';
const second = '00000000-0000-0000-0000-000000000002';
const foreign = '00000000-0000-0000-0000-000000000003';
const plain = value => JSON.parse(JSON.stringify(value));
const read = name => readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
const sources = ['Coldy.gs','ColdyCampaigns.gs','ProjectInfrastructure.gs','ProjectAnalytics.gs','ProjectSendingHistory.gs'].map(read);
const hash = input => createHash('sha256').update(input).digest('base64url');

function fixture() {
  const f = {root:'root',project:'numshield',weekNow:Date.parse('2026-11-27T12:00:00+03:00'),keyHash:'hash',
    selected:['1','2'],segments:[{id:'k',name:'Кухни'}],saved:new Map(),paths:[],writes:0,proofSlot:'configured'};
  class Clock extends Date { static now() { return f.weekNow; } }
  const c = vm.createContext({Date:Clock,Utilities:{getUuid:randomUUID}});
  for (const source of sources) vm.runInContext(source,c);
  // Keep the real route validation and bounded, per-campaign GET batching.
  Object.assign(c,{
    api_:fn=>fn(), locked_:fn=>fn(),digest_:hash,
    fail_:(code,message)=>{throw Object.assign(new Error(message),{registryCode:code});},
    object_:value=>value,authorize_:()=>({rootId:f.root}),
    registryProjectId_:()=>f.project,registryProjectScoped_:()=>!!f.project,
    coldySettings_:()=>({configured:!!f.keyHash,credentialHash:f.keyHash,key:'private-api-key',proofSlot:f.proofSlot}),
    coldyCredentialHash_:()=>f.keyHash,projectMonitoringOwner_:key=>key+':'+f.project,
    projectMonitoringRead_:()=>({accountIds:[...f.selected],accounts:f.selected.map(id=>({id,email:'sender'+id+'@example.test',name:'Test '+id}))}),
    projectMonitoringSignature_:(_context,monitoring)=>hash(JSON.stringify(monitoring.accountIds)),
    projectAnalyticsCatalog_:()=>({state:'ready',segments:f.segments}),
    coldyCampaignRegistry_:()=>({credentialHash:f.keyHash,bindings:[
      {campaignId:first,segmentId:'k',campaignName:'Active campaign',campaignStatus:'Active'},
      {campaignId:second,segmentId:'k',campaignName:'Completed campaign',campaignStatus:'Completed'},
      {campaignId:foreign,segmentId:'outside',campaignName:'Foreign campaign'}]}),
    coldyLoad_:(context,kind,owner)=>{const saved=f.saved.get([context.rootId,kind,owner].join('/'));return saved?plain(saved):null;},
    coldySave_:(context,kind,owner,value)=>{f.writes++;f.saved.set([context.rootId,kind,owner].join('/'),plain(value));},
    coldyApi_:(_context,verb,path)=>{assert.equal(verb,'GET');f.paths.push(path);return f.fetch(new URL(path,'https://synthetic.example.test'));},
  });
  f.days=plain(c.projectHistoryWeek_(f.weekNow));
  f.events=(totals)=>({labels:f.days,series:[{name:'sent',data:totals},{name:'replied',data:[0,0,0,0,0,0,0]}]});
  f.page=(offset,total,items,limit=500)=>({offset,total,limit,items:items.map(([account_id,sent])=>({account_id,sent,contacted:1,email:'not-persisted@example.test'}))});
  f.fetch=url=>url.pathname.endsWith('events')?f.events([7,0,0,0,0,0,0]):f.page(0,2,[[1,5],[888,2]]);
  f.run=(options={})=>plain(c.getProjectSendingHistory_(options));
  f.finish=()=>{for(let i=0;i<30;i++){const result=f.run();if(result.complete)return result;}throw new Error('history did not complete');};
  f.c=c;
  return f;
}

test('a completed Moscow Monday–Sunday is selected across a year and the Monday midnight boundary',()=>{
  const c=fixture().c;
  assert.equal(c.projectHistoryWeek_(Date.parse('2027-01-03T20:59:59Z'))[0],'2026-12-21');
  assert.deepEqual(plain(c.projectHistoryWeek_(Date.parse('2027-01-03T21:00:00Z'))),[
    '2026-12-28','2026-12-29','2026-12-30','2026-12-31','2027-01-01','2027-01-02','2027-01-03'
  ]);
});

test('seven daily event totals, selected sender IDs and all bound campaigns including completed campaigns',()=>{
  const f=fixture();
  f.fetch=url=>{
    assert.equal(url.searchParams.get('type'),'event');
    if (url.pathname.endsWith('/events')) {
      assert.deepEqual([url.searchParams.get('start_date'),url.searchParams.get('end_date')],[f.days[0],f.days[6]]);
      return f.events(url.pathname.includes(first)?[7,0,0,0,0,0,0]:[0,0,4,0,0,0,0]);
    }
    const date=url.searchParams.get('start_date');
    assert.equal(url.searchParams.get('end_date'),date);
    return date===f.days[0]?f.page(0,2,[[1,5],[888,2]]):f.page(0,1,[[2,4]]);
  };
  const initial=f.run();
  assert.equal(initial.state,'partial');
  assert.deepEqual(initial.rows,[]);
  assert.equal(initial.checkedCells.length,6);
  assert.ok(!initial.checkedCells.some(v=>v.date===f.days[0]));
  const r=f.finish();
  assert.equal(r.timeZone,null);assert.equal(r.dayBasis,'coldy_calendar');
  assert.deepEqual(r.accounts.map(a=>a.id),['1','2']);
  assert.deepEqual(r.campaigns.map(c=>[c.id,c.segmentName]),[[first,'Кухни'],[second,'Кухни']]);
  assert.deepEqual(r.rows,[{date:f.days[0],accountId:'1',campaignId:first,sent:5},{date:f.days[2],accountId:'2',campaignId:second,sent:4}]);
  assert.equal(r.checkedCells.length,14);assert.equal(r.pending,false);
  assert.ok(f.paths.every(path=>!path.includes(foreign)));
  assert.equal(f.paths.length,4);
  assert.doesNotMatch(JSON.stringify([r,...f.saved.values()]),/not-persisted|888|private-api-key/);
  assert.deepEqual(f.run(),r);assert.equal(f.paths.length,4);
  assert.equal(f.run({refresh:true}).pending,true);assert.equal(f.paths.length,5);
});

test('pagination reconciles raw sends across every sender and never publishes partial counters',()=>{
  const f=fixture();
  f.fetch=url=>{
    if (url.pathname.endsWith('/events')) return f.events(url.pathname.includes(first)?[6,0,0,0,0,0,0]:Array(7).fill(0));
    const offset=Number(url.searchParams.get('offset'));
    return offset===0?f.page(0,3,[[1,2],[888,3]],2):f.page(2,3,[[2,1]],2);
  };
  f.run();const partial=f.run();
  assert.deepEqual(partial.rows,[]);assert.equal(partial.checkedCells.length,6);
  assert.doesNotMatch(JSON.stringify([...f.saved.values()]),/not-persisted|888/);
  const complete=f.finish();assert.equal(complete.checkedCells.length,14);
  assert.deepEqual(complete.rows.map(row=>[row.accountId,row.sent]),[['1',2],['2',1]]);
});

test('inconsistent or duplicated sender pages never become a confirmed zero, and other campaigns continue',()=>{
  for(const mode of ['sum','duplicate','offset','empty','unknown','null']) {
    const f=fixture();
    f.fetch=url=>{
      if (url.pathname.endsWith('/events')) return f.events(url.pathname.includes(first)?[6,0,0,0,0,0,0]:Array(7).fill(0));
      if (mode==='null') return {limit:500,offset:0,total:1,items:[null]};
      if (mode==='unknown') return f.page(0,1,[[null,6]]);
      if (mode==='empty') return f.page(0,1,[]);
      if (mode==='sum') return f.page(0,1,[[1,2]]);
      if (mode==='offset') return f.page(1,2,[[1,6]]);
      return Number(url.searchParams.get('offset'))===0?f.page(0,2,[[1,3]],1):f.page(1,2,[[1,3]],1);
    };
    let r;for(let i=0;i<5;i++)r=f.run();
    assert.equal(r.pending,true,mode);
    assert.equal(r.checkedCells.length,13,mode);assert.equal(r.rows.length,0);
    assert.ok(r.retryAfterMs>0,mode);
    assert.ok(!r.checkedCells.some(v=>v.campaignId===first&&v.date===f.days[0]),mode);
  }
});

test('rate-limited requests resume after the shared pause and malformed timelines cannot imply zeros',()=>{
  const f=fixture(), normal=f.fetch;
  f.fetch=()=>{throw Object.assign(new Error('provider throttled'),{registryCode:'COLDY_RATE_LIMIT',retryAfterMs:120000});};
  const r=f.run();assert.equal(r.retryAfterMs,120000);assert.equal(r.checkedCells.length,0);
  f.fetch=normal;f.run();assert.equal(f.paths.length,1);
  f.weekNow+=120001;assert.equal(f.finish().complete,true);
  f.fetch=()=>({labels:f.days.slice(1),series:[{name:'sent',data:Array(6).fill(0)}]});
  const bad=f.run({refresh:true});assert.equal(bad.checkedCells.length,0);assert.equal(bad.complete,false);
});

test('a provider correction of an earlier day recovers by rereading both the reference total and the senders',()=>{
  const f=fixture();let reference=4;
  f.fetch=url=>url.pathname.endsWith('/events')?f.events(url.pathname.includes(first)?[reference,0,0,0,0,0,0]:Array(7).fill(0)):f.page(0,1,[[1,6]]);
  f.run();f.run();const partial=f.run();assert.equal(partial.checkedCells.length,13);
  reference=6;f.weekNow+=3600000;
  const complete=f.finish();assert.equal(complete.rows[0].sent,6);
  assert.equal(f.paths.filter(path=>path.includes(first+'/events?')).length,2);
});

test('no provider call for empty or unscoped selections, no stale result after a selection/segment change',()=>{
  const f=fixture();f.selected=[];assert.equal(f.run().state,'no_accounts');
  f.selected=['2'];f.segments=[];assert.equal(f.run().state,'no_campaigns');
  f.keyHash='';assert.equal(f.run().state,'not_configured');assert.equal(f.paths.length,0);
  f.project='';assert.throws(()=>f.run(),e=>e.registryCode==='OUTSIDE_PROJECT');
  for(const change of [f=>{f.selected=['2'];},f=>{f.segments=[];},f=>{f.project='other';},f=>{f.keyHash='other';}]) {
    const local=fixture(), original=local.fetch;
    local.fetch=url=>{change(local);return original(url);};
    assert.throws(()=>local.run(),e=>['COLDY_SCOPE_CHANGED','COLDY_MONITORING_CHANGED'].includes(e.registryCode));assert.equal(local.writes,0);
  }
  const scoped=fixture();scoped.finish();scoped.selected=['2'];
  assert.equal(scoped.run().rows.length,0);assert.equal(scoped.finish().rows.length,0);
  scoped.segments=[];assert.deepEqual(scoped.run().campaigns,[]);
});

test('a late caller cannot overwrite a concurrent checkpoint and a rotated credential cannot reuse past counts',()=>{
  const f=fixture(), original=f.c.locked_;
  f.c.locked_=cb=>{f.c.locked_=original;f.run();f.run();return cb();};
  const firstRead=f.run();assert.equal(f.writes,2);
  assert.deepEqual(firstRead.rows.map(v=>v.sent),[5]);
  f.finish();const previous=f.paths.length;f.proofSlot='rotated';assert.equal(f.run().rows.length,0);
  assert.equal(f.paths.length,previous+1);
  f.finish();const fresh=f.paths.length;f.weekNow+=6*3600000;
  assert.equal(f.run().pending,true);assert.equal(f.paths.length,fresh+1);
});

test('a corrupted checkpoint cannot disclose other sender IDs or stale cells',()=>{
  const f=fixture();f.finish();
  const stored=[...f.saved.values()][0];stored.entries[first].cells[0].counts.unselected=99;
  const result=f.run();assert.deepEqual(result.rows,[]);assert.equal(result.complete,false);
  assert.ok(!JSON.stringify(result).includes('unselected'));
});

test('history batching only accepts canonical event and same-day account GETs for a single campaign',()=>{
  const f=fixture(), base='/analytics/campaigns/'+first+'/',d=f.days[0];
  const query='by-account?type=event&start_date='+d+'&end_date='+d+'&sort_by=email&sort_order=asc&limit=500&offset=0';
  const run=paths=>f.c.coldyGetBatch_({},paths,()=>{},'sending-history');
  assert.equal(run([base+query]).length,1);
  for(const paths of [[base+query,base+query],[base+query,(base+query).replace(first,second)],
    [(base+query).replace('end_date='+d,'end_date='+f.days[1])],['/accounts/42'],[base+'summary?period=all&type=event']])
    assert.throws(()=>run(paths),e=>e.registryCode==='INVALID_REQUEST');
});
