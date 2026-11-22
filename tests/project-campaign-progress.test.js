import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const a='11111111-1111-4111-8111-111111111111', b='22222222-2222-4222-8222-222222222222';
const c='33333333-3333-4333-8333-333333333333';
const copy=value=>JSON.parse(JSON.stringify(value));
function fixture(){
  const ctx={rootId:'root'}, settings={configured:true, credentialHash:'credential'};
  const stored=new Map(), fetched=[], states={[a]:'Paused',[b]:'Completed',[c]:'Draft'};
  const ownership={first:'numshield',second:'neosender'};
  const bindings=[{id:'one',segmentId:'first',campaignId:a},{id:'two',segmentId:'first',campaignId:b},{id:'three',segmentId:'second',campaignId:c}];
  const environment={project:'numshield',revision:0,serial:0,totals:{[a]:1,[b]:1,[c]:1},afterFetch:null};
  function fail(code,message){const err=new Error(message||code);err.registryCode=code;throw err;}
  const runtime=vm.createContext({
    Date,Intl,api_:callback=>callback(),projectAnalyticsInput_:(v,keys)=>{
      if (Object.keys(v||{}).some(k=>!keys.includes(k))) fail('INVALID_REQUEST');return v||{};
    },fail_:fail,authorize_:()=>ctx,coldySettings_:()=>settings,
    digest_:s=>createHash('sha256').update(s).digest('base64url'),
    COLDY:{cacheMillis:300000},Utilities:{getUuid:()=>String(++environment.serial)},
    locked_:fn=>fn(),coldyUuid_:s=>/^[a-f0-9-]{36}$/.test(s),coldyCampaignId_:s=>s,
    coldyCredentialHash_:()=>settings.credentialHash,projectMonitoringOwner_:key=>key+'-'+environment.project,
    projectMonitoringRead_:()=>({accountIds:environment.senders||[],revision:environment.revision}),projectMonitoringSignature_:(_ctx,m)=>environment.project+'/'+m.revision,
    projectInfraMonitoringGuard_:(_ctx,credential,selection)=>()=>{
      if (settings.credentialHash!==credential || selection!==environment.project+'/'+environment.revision) fail('COLDY_MONITORING_CHANGED');
      return ctx;
    },coldyCampaignRegistry_:()=>({credentialHash:settings.credentialHash,bindings:copy(bindings)}),
    projectCapacityOwners_:(_ctx,ids,observation)=>{
      observation.registry={credentialHash:settings.credentialHash,bindings:copy(bindings)};
      return Object.fromEntries(bindings.filter(x=>ids.includes(x.campaignId)&&ownership[x.segmentId]===environment.project)
        .map(x=>[x.campaignId,{segmentId:x.segmentId,bindingState:'linked'}]));
    },
    coldyLoad_:(_ctx,kind,owner)=>copy(stored.get(kind+owner)||null),
    coldySave_:(_ctx,kind,owner,v)=>{stored.set(kind+owner,copy(v));return v;},
    coldyGetBatch_:(_ctx,paths,guard)=>{
      guard();
      const result=paths.map(path=>{
        const id=path.match(/[a-f0-9-]{36}/)[0];fetched.push(path);
        if (environment.missing===id) return {error:Object.assign(new Error(),{registryCode:'COLDY_NOT_FOUND'})};
        if (path.startsWith('/campaigns/')) return {value:{id,status:states[id],
          is_stop_sending_on_reply:true,is_stop_sending_on_company_reply:false,sequences:[{id:1,delay:0},{id:2,delay:1}]}};
        const offset=Number(path.match(/offset=(\d+)/)[1]),total=environment.totals[id];
        return {value:{offset,total,limit:200,items:Array.from({length:Math.min(200,total-offset)},(_,i)=>({
          id:i+offset+1,campaign_id:id,verification_status:'valid',stop_sending:false,status:'Sent',chosen_sender:1,
          amount_sequences_sent:1,id_previous_sending_sequence:1,date_last_sequence_send:new Date(Date.now()-2*86400000).toISOString(),email:'private@example.test'
        }))}};
      });
      if (environment.afterFetch) environment.afterFetch();
      guard();return result;
    }
  });
  for (const name of ['ProjectForecastDemand','ProjectForecastCalc','ProjectForecast','ProjectCampaignCompletion','ProjectCampaignProgress']){
    vm.runInContext(readFileSync(new URL('../src/'+name+'.gs',import.meta.url),'utf8'),runtime,{filename:name+'.gs'});
  }
  return {runtime,states,environment,fetched,stored,ownership,bindings,get:(input={})=>copy(runtime.getProjectCampaignCompletions_(input))};
}

test('all bound campaigns get valid-email progress without a mailbox selection; warm reads and project switches respect scope',()=>{
  const f=fixture();assert.deepEqual(f.get({preview:true}).campaignCompletions,{});assert.equal(f.fetched.length,0);
  const result=f.get();
  assert.deepEqual(Object.keys(result.campaignCompletions),[a,b]);assert.equal(result.pending,false);
  assert.equal(result.campaignCompletions[a].percent,50);assert.equal(result.campaignCompletions[a].state,'paused');
  assert.equal(result.campaignCompletions[b].estimatedDate,null);assert.equal(result.campaignCompletions[b].percent,50);
  assert.ok(result.freshForMs>0);
  const count=f.fetched.length;
  assert.equal(f.get({preview:true}).campaignCompletions[a].percent,50);assert.equal(f.get().pending,false);
  assert.equal(f.fetched.length,count);
  f.environment.project='neosender';assert.deepEqual(f.get({preview:true}).campaignCompletions,{});
  assert.deepEqual(Object.keys(f.get().campaignCompletions),[c]);
  f.ownership.second='numshield';assert.deepEqual(f.get({preview:true}).campaignCompletions,{});
  assert.ok(!JSON.stringify([...f.stored.values()]).includes('private@example.test'));
});

test('bounded pages resume from the last proven offset; one missing campaign leaves the others readable',()=>{
  const f=fixture();f.environment.totals[a]=1601;f.environment.missing=b;
  const first=f.get();assert.equal(first.pending,true);assert.equal(first.freshForMs,0);
  assert.equal(first.campaignCompletions[a],undefined);
  const last=f.get();
  assert.equal(last.pending,false);assert.equal(last.campaignCompletions[a].total,3202);
  assert.equal(last.campaignCompletions[b].percent,null);assert.equal(last.campaignCompletions[b].reason,'unavailable');
  const pages=f.fetched.filter(path=>path.includes('/leads/')&&path.includes(a));
  assert.equal(new Set(pages).size,9);assert.equal(pages.length,9);
});

test('changing a mailbox selection or moving the bound segment during a provider read prevents checkpoint and exposure',()=>{
  for(const change of [f=>f.environment.revision++,f=>{f.ownership.first='neosender';}]){
    const f=fixture();f.environment.afterFetch=()=>change(f);
    assert.throws(()=>f.get(),e=>e.registryCode==='COLDY_MONITORING_CHANGED');assert.equal(f.stored.size,0);
  }
});

test('an active bound campaign obtains its estimated date from the verified project sender capacity',()=>{
  const f=fixture();f.states[a]='Active';f.environment.senders=[1];
  const capacity=vm.createContext({Date,Intl});
  vm.runInContext(readFileSync(new URL('../src/ProjectCapacity.gs',import.meta.url),'utf8'),capacity);
  f.runtime.projectCapacityZone_=capacity.projectCapacityZone_;
  f.runtime.PROJECT_CAPACITY_DAYS=capacity.PROJECT_CAPACITY_DAYS;
  f.runtime.projectInfraCount_=v=>Number.isSafeInteger(v)&&v>=0?v:null;
  const stamp=new Date().toISOString();
  f.runtime.projectInfraRead_=()=>({});
  f.runtime.projectInfraPublic_=()=>({monitoring:{accountIds:[1],revision:0},poolOnly:true,
    accounts:[{id:1,status:'Connected',dailyLimit:8,sentToday:0,updatedAt:stamp,capacity:{state:'busy',campaignIds:[a]}}],
    capacity:{updatedAt:stamp,state:'ready',stale:false,campaigns:[{id:a,status:'Active',allSendersSelected:true,
      schedule:{days:['monday','tuesday','wednesday','thursday','friday','saturday','sunday'],from:'08:00',to:'19:00',
        gapStartSeconds:60,gapEndSeconds:120,timezone:'Europe/Moscow'}}]}});
  const report=f.get().campaignCompletions[a];
  assert.equal(report.percent,50);assert.equal(report.state,'estimated');assert.match(report.estimatedDate,/^\d{4}-\d{2}-\d{2}$/);
});
