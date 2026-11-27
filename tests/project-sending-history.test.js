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
const sources = ['Coldy.gs','ColdyCampaigns.gs','ProjectInfrastructure.gs','ProjectAnalytics.gs','ProjectPlanArchive.gs','ProjectSendingHistory.gs'].map(read);
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

function withHistoryCache(f) {
  const entries=new Map();
  const get=key=>{const item=entries.get(key);return item&&item.expires>f.weekNow?item.value:null;};
  f.c.CacheService={getScriptCache:()=>({get,
    getAll:keys=>Object.fromEntries(keys.map(k=>[k,get(k)]).filter(([,v])=>v!==null)),
    put:(k,value,seconds)=>entries.set(k,{value,expires:f.weekNow+seconds*1000})})};
  return entries;
}

test('a busy shared writer cannot starve a cold weekly history or discard its verified result',()=>{
  const f=fixture();withHistoryCache(f);
  const busy=()=>{throw Object.assign(new Error('locked'),{registryCode:'BUSY'});}, unlocked=f.c.locked_;
  f.c.locked_=busy;
  let r=f.run({cursor:''});
  assert.equal(r.checkedCells.length,12);assert.equal(f.writes,0);
  assert.match(r.nextCursor,/^[\w-]{43}$/);
  r=f.run({cursor:r.nextCursor});
  assert.equal(r.rows[0].sent,5);
  r=f.run({cursor:r.nextCursor});
  assert.ok(r.complete&&r.pending&&r.retryAfterMs>0);
  const gets=f.paths.length;
  f.c.locked_=unlocked;
  r=f.run({cursor:r.nextCursor});
  assert.ok(r.complete&&!r.pending);
  assert.equal(f.paths.length,gets,'save retry must not re-read Coldy');
  assert.equal(f.writes,1);
  assert.deepEqual(f.run(),r,'older tabs reuse the completed durable history');
});

test('a stale cursor cannot resurrect a campaign revoked in a different tab, even on BUSY',()=>{
  const f=fixture();withHistoryCache(f);
  const initial=f.run({cursor:''});assert.ok(initial.campaignTotals.some(c=>c.campaignId===first));
  const fetch=f.fetch;
  f.fetch=url=>{if(url.pathname.includes(first))throw Object.assign(new Error('gone'),{registryCode:'COLDY_FORBIDDEN'});return fetch(url);};
  const unlocked=f.c.locked_;
  f.c.locked_=()=>{throw Object.assign(new Error('locked'),{registryCode:'BUSY'});};
  const revoked=f.run({cursor:initial.nextCursor});
  f.c.locked_=unlocked;f.fetch=fetch;
  assert.ok(!revoked.campaignTotals.some(c=>c.campaignId===first));
  const otherTab=f.run({cursor:initial.nextCursor});
  assert.ok(!otherTab.campaignTotals.some(c=>c.campaignId===first));
  assert.ok(!otherTab.checkedCells.some(c=>c.campaignId===first));
  assert.ok(!f.run({cursor:initial.nextCursor}).campaignTotals.some(c=>c.campaignId===first));
});

test('rate-limit checkpoint survives eviction of the partial cache without losing other dates',()=>{
  const f=fixture(), cache=withHistoryCache(f), a=f.run({cursor:''}), b=f.run({cursor:a.nextCursor});
  f.fetch=()=>{throw Object.assign(new Error('rate'),{registryCode:'COLDY_RATE_LIMIT',retryAfterMs:3600000});};
  const paused=f.run({cursor:b.nextCursor}), calls=f.paths.length;
  assert.equal(paused.retryAfterMs,3600000);assert.equal(f.writes,1);
  cache.clear();f.weekNow+=16*60000;
  const still=f.run({cursor:b.nextCursor});
  assert.deepEqual(still.rows,paused.rows);assert.ok(still.retryAfterMs>0);
  assert.equal(f.paths.length,calls);
});

test('a change in project access while waiting for a busy commit fails closed',()=>{
  const f=fixture();
  f.c.locked_=()=>{f.selected=['2'];throw Object.assign(new Error('locked'),{registryCode:'BUSY'});};
  assert.throws(()=>f.run(),e=>e.registryCode==='COLDY_MONITORING_CHANGED');
  assert.equal(f.writes,0);
});

test('a completed Moscow Monday–Sunday is selected across a year and the Monday midnight boundary',()=>{
  const c=fixture().c;
  assert.equal(c.projectHistoryWeek_(Date.parse('2027-01-03T20:59:59Z'))[0],'2026-12-21');
  assert.deepEqual(plain(c.projectHistoryWeek_(Date.parse('2027-01-03T21:00:00Z'))),[
    '2026-12-28','2026-12-29','2026-12-30','2026-12-31','2027-01-01','2027-01-02','2027-01-03'
  ]);
});

test('a confirmed pre-day plan is immutable within its issue day, replaced before the target, and scoped on every history read',()=>{
  const f=fixture(), c=f.c, dayMs=86400000;
  const context={rootId:f.root,properties:{getProperties:()=>({})}}, settings=c.coldySettings_();
  c.registrySegmentProject_=(_ctx,id)=>id==='k'?f.project:'another';
  c.projectCapacityOwners_=(_ctx,ids)=>Object.fromEntries(ids.map(id=>[id,{segmentId:'k',segmentProjectId:f.project,bindingState:'linked'}]));
  function issue(day,expected,partial=false) {
    f.weekNow=Date.parse(day+'T12:30:00+03:00');
    const dates=Array.from({length:8},(_,i)=>new Date(Date.parse(day)+i*dayMs).toISOString().slice(0,10));
    const quantities=dates.map((_,i)=>i===2&&partial?null:i<3?expected:0);
    const days=dates.map((date,i)=>({date,expected:quantities[i],initial:quantities[i],followups:0,mailboxLimit:120,unused:120-quantities[i]}));
    const generatedAt=new Date(f.weekNow).toISOString();
    const forecast={today:days[0],days:days.slice(1),campaigns:[{id:first,segmentId:'k',expectedByDay:quantities,initialByDay:quantities}],
      senders:['1','2'].map((id,j)=>({id,email:'must-not-be-stored@example.test',dailyLimit:60,
        days:dates.map((date,i)=>({date,expected:j?0:quantities[i],unused:j?60:60-quantities[i]})),
        campaigns:j?[]:[{id:first,expectedByDay:quantities,initialByDay:quantities}]}))};
    const state={day,generatedAt,forecast,selection:c.projectMonitoringSignature_(context,{accountIds:f.selected}),demandScope:'test'};
    c.projectPlanCapture_(context,settings,state,f.latest,{},f.selected);
    f.latest=state;
  }
  issue('2026-11-19',3,true);
  const writes=f.writes;assert.equal(writes,2);
  issue('2026-11-19',11,true);
  assert.equal(f.writes,writes,'same-day refresh cannot reset a prior baseline');
  issue('2026-11-20',7);
  assert.equal(f.paths.length,0,'archiving needs no provider requests');
  assert.doesNotMatch(JSON.stringify([...f.saved.values()]),/@|private-api-key|Foreign campaign/);
  f.weekNow=Date.parse('2026-11-27T10:15:00Z');
  const week={weekOf:'2026-11-20'}, history=f.run(week);
  assert.deepEqual(history.plans.map(d=>d.date),['2026-11-20','2026-11-21','2026-11-22']);
  const [closed,updated]=history.plans;
  assert.equal(closed.expected,3,'the issue day cannot revise its own total');
  assert.equal(updated.expected,7);
  assert.equal(updated.generatedAt,'2026-11-20T09:30:00.000Z');
  assert.deepEqual(updated.campaigns,[{id:first,name:'Active campaign',segmentId:'k',segmentName:'Кухни',expected:7,initial:7}]);
  assert.deepEqual(updated.senders[0],{id:'1',dailyLimit:60,expected:7,unused:53,campaigns:[{id:first,expected:7,initial:7}]});
  assert.equal(updated.senders[1].expected,0);
  const next=f.run({weekOf:'2026-11-24'});
  assert.equal(next.plans.find(d=>d.date==='2026-11-23').expected,0,'confirmed zero survives');
  assert.deepEqual(f.run({weekOf:'2026-10-15'}).plans,[],'no invented historical plans');
  assert.deepEqual(f.run({...week,refresh:true}).plans,history.plans);
  f.selected=['2'];assert.deepEqual(f.run(week).plans,[]);f.selected=['1','2'];
  f.proofSlot='rotated';assert.deepEqual(f.run(week).plans,[]);f.proofSlot='configured';
  f.project='other';assert.deepEqual(f.run(week).plans,[]);f.project='numshield';
  const before=c.coldyCampaignRegistry_;
  c.coldyCampaignRegistry_=()=>({...before(),bindings:before().bindings.map(b=>({...b,id:'replacement'}))});
  assert.deepEqual(f.run(week).plans,[],'a replacement binding cannot inherit the old plan');
  c.coldyCampaignRegistry_=before;
  const bucket=[...f.saved.values()].find(value=>value.week==='2026-11-16');
  bucket.days['2026-11-20'].senders[0][0]='foreign-sender';
  bucket.days['2026-11-21'].totals[0]={email:'private@example.test'};
  assert.deepEqual(f.run(week).plans.map(d=>d.date),['2026-11-22'],'a malformed day cannot expose identities or fabricated totals');
});

test('a calendar week includes only closed dates, even when Monday is the sole closed day',()=>{
  const f=fixture();
  f.weekNow=Date.parse('2026-11-24T08:00:00Z');
  const selected={weekOf:'2026-11-23'};
  assert.deepEqual(plain(f.c.projectHistoryDates_('previous_week',f.weekNow,'2026-11-06')),[
    '2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-07','2026-11-08']);
  for (const weekOf of ['2026-11-24','2026-02-30','2026-5-1','later',null,{}])
    assert.throws(()=>f.run({weekOf}),e=>e.registryCode==='INVALID_REQUEST');
  assert.throws(()=>f.run({period:'today',...selected}),e=>e.registryCode==='INVALID_REQUEST');
  f.days=['2026-11-23'];
  f.fetch=url=>{
    assert.ok(url.pathname.endsWith('/events'),'a closed zero day does not need live sender reconciliation');
    return f.events([0]);
  };
  let report;
  for(let i=0;i<4;i++){report=f.run(selected);if(report.complete)break;}
  assert.equal(report.period,'week');
  assert.equal(report.complete,true);
  assert.deepEqual(report.days,f.days);
  const calls=f.paths.length;
  f.run(selected);
  assert.equal(f.paths.length,calls);
  f.weekNow+=86400000;f.days.push('2026-11-24');
  f.fetch=()=>f.events([0,0]);
  assert.deepEqual(f.run(selected).days,f.days);
  assert.ok(f.paths.length>calls,'a new closed date invalidates the shorter checkpoint');
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
  assert.equal(initial.checkedCells.length,12);
  assert.ok(!initial.checkedCells.some(v=>v.campaignId===first&&v.date===f.days[0]));
  assert.ok(f.paths.every(path=>path.includes('/events?')),'all bound weekly timelines share the first request');
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
  const refreshing=f.run({refresh:true});
  assert.equal(refreshing.pending,true);assert.equal(f.paths.length,6);
  assert.deepEqual(refreshing.rows,r.rows,'previously reconciled days stay visible during recheck');
});

test('pagination reconciles raw sends across every sender and never publishes partial counters',()=>{
  const f=fixture();
  f.fetch=url=>{
    if (url.pathname.endsWith('/events')) return f.events(url.pathname.includes(first)?[6,0,0,0,0,0,0]:Array(7).fill(0));
    const offset=Number(url.searchParams.get('offset'));
    return offset===0?f.page(0,3,[[1,2],[888,3]],2):f.page(2,3,[[2,1]],2);
  };
  f.run();const partial=f.run();
  assert.deepEqual(partial.rows,[]);assert.equal(partial.checkedCells.length,13);
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
  assert.equal(f.paths.length,previous+2);
  f.finish();const fresh=f.paths.length;f.weekNow+=6*3600000;
  assert.equal(f.run().pending,true);assert.equal(f.paths.length,fresh+2);
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

test('weekly campaign batch accepts only distinct events queries with identical calendar dates',()=>{
  const f=fixture(), from=f.days[0],to=f.days.at(-1);
  const timeline=id=>'/analytics/campaigns/'+id+'/events?type=event&start_date='+from+'&end_date='+to;
  const run=paths=>f.c.coldyGetBatch_({},paths,()=>{},'sending-week-timelines');
  assert.equal(run([timeline(first),timeline(second)]).length,2);
  const invalid=[
    [timeline(first),timeline(first)],
    [timeline(first),timeline(second).replace('end_date='+to,'end_date='+from)],
    [timeline(first),'/accounts/42'],
    [timeline(first).replace('/events?', '/by-account?')]
  ];
  for(const paths of invalid)assert.throws(()=>run(paths),e=>e.registryCode==='INVALID_REQUEST');
});

test('today uses only the selected project and senders, has its own dated cache, and refreshes after a minute',()=>{
  const f=fixture(),week=f.finish(),date='2026-11-27',empty={labels:[date],series:[{name:'sent',data:[0]}]};
  const query={period:'today'};let rawTotal=7;
  f.paths.length=0;
  f.fetch=url=>{
    assert.equal(url.searchParams.get('start_date'),date);assert.equal(url.searchParams.get('end_date'),date);
    assert.ok(!url.pathname.includes(foreign));
    if(url.pathname.endsWith('events'))return url.pathname.includes(first)?{labels:[date],series:[{name:'sent',data:[rawTotal]}]}:empty;
    return url.pathname.includes(first)?f.page(0,2,[[1,rawTotal-2],[888,2]]):f.page(0,0,[]);
  };
  assert.equal(f.run(query).pending,true);
  const today=f.run(query);assert.equal(today.complete,true);assert.equal(today.period,'today');
  assert.deepEqual([today.from,today.to,today.days],[date,date,[date]]);
  assert.deepEqual(today.rows,[{date,accountId:'1',campaignId:first,sent:5}]);assert.equal(today.checkedCells.length,2);
  assert.equal(f.paths.length,4);assert.deepEqual(f.run(),week);
  rawTotal=11;f.weekNow+=59999;assert.deepEqual(f.run(query),today);
  f.weekNow++;assert.equal(f.run(query).rows[0].sent,9);assert.equal(f.run(query).complete,true);
  assert.equal(f.paths.length,8);assert.deepEqual(f.run(),week);assert.equal(f.saved.size,2);
  assert.throws(()=>f.run({period:'custom'}),e=>e.registryCode==='INVALID_REQUEST');
});

test('today retries a moving zero total and sender pages in seconds, observing the documented provider cooldown',()=>{
  const f=fixture(),date='2026-11-27';let reference=0;
  f.fetch=url=>{
    const campaign=url.pathname.includes(first);
    if(url.pathname.endsWith('events'))return {labels:[date],series:[{name:'sent',data:[campaign?reference:0]}]};
    return campaign?f.page(0,1,[[2,1]]):f.page(0,0,[]);
  };
  const query={period:'today'};let r=f.run(query);
  assert.equal(r.checkedCells.length,0);assert.equal(r.pending,true);r=f.run(query);
  assert.equal(r.checkedCells.length,1);assert.equal(r.retryAfterMs,15000);assert.deepEqual(r.rows,[]);
  reference=1;f.weekNow+=14999;f.run(query);assert.equal(f.paths.length,4);
  f.weekNow++;r=f.run(query);assert.equal(r.complete,true);assert.equal(r.rows[0].sent,1);
  assert.equal(r.rows[0].accountId,'2');
  f.fetch=()=>{throw Object.assign(new Error('rate'),{registryCode:'COLDY_RATE_LIMIT',retryAfterMs:180000});};
  assert.equal(f.run({...query,refresh:true}).retryAfterMs,180000);
});

test('today drops an in-flight read at Moscow midnight and never reuses the previous day',()=>{
  const f=fixture(),query={period:'today'};
  f.weekNow=Date.parse('2026-11-27T20:59:50Z');
  const timeline=url=>({labels:[url.searchParams.get('start_date')],series:[{name:'sent',data:[0]}]});
  f.fetch=url=>{f.weekNow=Date.parse('2026-11-27T21:00:00Z');return url.pathname.endsWith('events')?timeline(url):f.page(0,0,[]);};
  assert.throws(()=>f.run(query),e=>e.registryCode==='COLDY_MONITORING_CHANGED');
  assert.equal(f.writes,0);f.run(query);assert.equal(f.run(query).from,'2026-11-28');
  f.weekNow+=86400000;f.fetch=url=>url.pathname.endsWith('events')?timeline(url):f.page(0,0,[]);
  const newDay=f.run(query);assert.equal(newDay.from,'2026-11-29');assert.equal(newDay.pending,true);
});

test('today keeps refreshing confirmed campaigns while another campaign is unavailable',()=>{
  const f=fixture(),date='2026-11-27';let total=2;
  f.fetch=url=>{
    if(url.pathname.includes(second))throw Object.assign(new Error('no access'),{registryCode:'COLDY_FORBIDDEN'});
    return url.pathname.endsWith('events')?{labels:[date],series:[{name:'sent',data:[total]}]}:f.page(0,1,[[1,total]]);
  };
  const q={period:'today'};f.run(q);const partial=f.run(q);
  assert.equal(partial.retryAfterMs,60000);assert.equal(partial.rows[0].sent,2);assert.equal(partial.checkedCells.length,1);
  total=4;f.weekNow+=60000;assert.equal(f.run(q).rows[0].sent,4);
});

test('weekly event totals are scoped to allowed campaigns independently of sender attribution',()=>{
  const f=fixture(), observedAt=new Date(f.weekNow).toISOString();
  const fetch=f.fetch;
  f.fetch=url=>{
    if(url.pathname.includes(second))throw Object.assign(new Error('no campaign access'),{registryCode:'COLDY_FORBIDDEN'});
    return fetch(url);
  };
  const summary=f.run();
  const expected=f.days.map((date,i)=>({date,campaignId:first,sent:i===0?7:0}));
  assert.deepEqual(summary.campaignTotals,expected);
  assert.equal(summary.campaignTotalsCheckedAt,observedAt);
  assert.deepEqual(summary.rows,[]);
  f.weekNow+=5000;
  const attributed=f.run();
  assert.deepEqual(attributed.rows,[{date:f.days[0],accountId:'1',campaignId:first,sent:5}]);
  assert.deepEqual(attributed.campaignTotals,expected);
  assert.equal(attributed.campaignTotalsCheckedAt,observedAt,'reading sender details does not advance the timeline timestamp');
  assert.notEqual(attributed.checkedAt,observedAt);
  f.selected=[];
  assert.deepEqual(f.run().campaignTotals,[]);
  assert.equal(f.run().campaignTotalsCheckedAt,null);
  assert.equal('campaignTotals' in f.run({period:'today'}),false);
});

test('a revoked weekly timeline is removed, and a legacy checkpoint has no inferred timeline timestamp',()=>{
  const f=fixture(), initial=f.finish();
  assert.equal(initial.campaignTotals.length,14);
  for(const value of f.saved.values()) for(const entry of Object.values(value.entries))delete entry.timelineCheckedAt;
  const cached=f.run();
  assert.deepEqual(cached.campaignTotals,initial.campaignTotals);
  assert.equal(cached.campaignTotalsCheckedAt,null);
  const fetch=f.fetch;
  f.fetch=url=>{
    if(url.pathname.includes(first))throw Object.assign(new Error('no access'),{registryCode:'COLDY_NOT_FOUND'});
    return fetch(url);
  };
  const refreshed=f.run({refresh:true});
  assert.ok(refreshed.campaignTotals.length);
  assert.ok(refreshed.campaignTotals.every(r=>r.campaignId===second));
});
