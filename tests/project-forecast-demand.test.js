import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const campaign='da2442fa-8bd5-432a-af9f-1503ee698e0a', other='fe6cf1fa-43c2-445a-8772-af0c6fa546e9';
const script=readFileSync(new URL('../src/ProjectForecastDemand.gs',import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const makeLead=(id,more={})=>({id,campaign_id:campaign,email:'privacy@example.test',first_name:'PrivateContact',
  chosen_sender:12,status:'Not contacted',stop_sending:false,amount_sequences_sent:0,id_previous_sending_sequence:0,...more});

function fixture(leads,options={}){
  const mod=vm.createContext({
    fail_(code){throw new Error(code);},
    digest_:value=>createHash('sha256').update(value).digest('hex'),
    coldyUuid_:value=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  });
  vm.runInContext(script,mod);
  const detail={id:campaign,sequences:[{id:3,delay:4,campaign_id:campaign,body:'PrivateText'},{id:1,delay:0,campaign_id:campaign}],
    sending_priority:'sequence_emails',is_stop_sending_on_reply:true,is_stop_sending_on_company_reply:false};
  const sequence=mod.projectForecastSequence_(detail);
  const page=(offset=0,total=null)=>mod.projectForecastDemandPage_(campaign,offset,total,sequence,
    {total:leads.length,offset,limit:200,items:leads.slice(offset,offset+200),...options.override});
  return {mod,detail,sequence,page};
}

test('reads campaign sequence IDs in documented step order and retains only planning settings',()=>{
  const f=fixture([]);assert.deepEqual(plain(f.sequence),{known:true,steps:[{id:1,delayDays:0},{id:3,delayDays:4}],
    stopOnReply:true,stopOnCompanyReply:false,priority:'sequence_emails'});
  assert.equal(f.mod.projectForecastSequence_({id:campaign}).known,false);
  assert.equal(f.mod.projectForecastSequence_({...f.detail, prioritize_new_leads:true}).priority,'new_leads');
  assert.deepEqual(plain(f.mod.projectForecastSequence_({id:campaign,sequences:[]})).steps,[]);
  for(const steps of [[{id:1,delay:0},{id:1,delay:0}],[{id:1,delay:null}],[null]]){
    const value=f.mod.projectForecastSequence_({id:campaign,sequences:steps});assert.equal(value.known,false);assert.deepEqual(plain(value.steps),[]);
  }
  assert.throws(()=>f.mod.projectForecastSequence_({id:campaign,sequences:[{id:1,delay:0,campaign_id:other}]}),/COLDY_FORECAST_CHANGED/);
});

test('uses confirmed sender, previous step and last-send minute; protected fields never leave the reader',()=>{
  const common={status:'Opened',amount_sequences_sent:1,id_previous_sending_sequence:1};
  const f=fixture([makeLead(1,{...common,date_last_sequence_send:'2026-11-22T12:09:24.987+03:00'}),
    makeLead(2,{...common,date_last_sequence_send:'2026-11-22T09:09:47Z'}),makeLead(3,{chosen_sender:0,sender:'last@example.test'}),
    makeLead(4,{stop_sending:true}),makeLead(5,{status:'Bounce'}),makeLead(6,{...common,reply_text:'PrivateReply'}),
    makeLead(7,{chosen_sender:undefined}),makeLead(8,{status:'Provider extension'}),makeLead(9,{verification_status:'invalid'})]);
  const page=f.page();assert.equal(page.total,9);assert.equal(page.nextOffset,null);
  assert.deepEqual(plain(page.cohorts[0]),{disposition:'eligible',senderId:12,sentSteps:1,previousStepId:1,lastSentAt:'2026-11-22T09:10:00.000Z',count:2});
  const unassigned=page.cohorts.find(item=>item.disposition==='eligible'&&item.sentSteps===0);
  assert.equal(unassigned.senderId,null);assert.equal(unassigned.count,2);
  assert.equal(page.cohorts.find(item=>item.disposition==='stopped').count,4);
  assert.equal(page.cohorts.filter(item=>item.disposition==='unknown').reduce((sum,item)=>sum+item.count,0),1);
  for(const secret of ['privacy@','PrivateContact','PrivateReply','last@example','PrivateText'])assert.equal(JSON.stringify(page).includes(secret),false);
  const replied=makeLead(20,{...common,status:'Replied',reply_text:'PrivateReply'});
  assert.equal(f.mod.projectForecastLeadCohort_(replied,{stopOnReply:false,stopOnCompanyReply:false}).disposition,'eligible');
  assert.equal(f.mod.projectForecastLeadCohort_(replied,{stopOnReply:null,stopOnCompanyReply:false}).disposition,'unknown');
});

test('keeps unassigned first contacts in the eligible pool; partial evidence never invents a future sender or permission',()=>{
  const f=fixture([]),normalize=changes=>plain(f.mod.projectForecastLeadCohort_(makeLead(20,changes),f.sequence));
  assert.equal(normalize({chosen_sender:undefined,amount_sequences_sent:undefined,date_last_sequence_send:''}).disposition,'eligible');
  assert.equal(normalize({chosen_sender:undefined,stop_sending:undefined}).disposition,'unknown');
  assert.equal(normalize({chosen_sender:'bad'}).disposition,'unknown');
  assert.equal(normalize({chosen_sender:undefined,amount_sequences_sent:undefined,id_previous_sending_sequence:undefined}).disposition,'unknown');
  const prior={status:'Sent',id_previous_sending_sequence:1,amount_sequences_sent:undefined,date_last_sequence_send:'2026-11-22T09:09:47Z'};
  assert.equal(normalize(prior).disposition,'eligible');assert.equal(normalize(prior).sentSteps,null);
  assert.equal(normalize({...prior,chosen_sender:undefined}).disposition,'unknown');
  assert.equal(normalize({...prior,amount_sequences_sent:1,id_previous_sending_sequence:'invalid'}).disposition,'unknown');
});

test('cohorts merge only across contiguous verified pages; replay cannot count a recipient twice',()=>{
  const f=fixture(Array.from({length:401},(_,i)=>makeLead(i+1)));
  const first=f.page();let work=f.mod.projectForecastAppendDemand_(null,first);
  assert.equal(work.processed,200);assert.equal(work.seenIds.length,200);
  assert.equal(f.mod.projectForecastAppendDemand_(work,first),work);
  const second=f.page(200,401);
  const duplicate=plain(second);duplicate.leadIds[17]=first.leadIds[88];
  assert.throws(()=>f.mod.projectForecastAppendDemand_(work,duplicate),/COLDY_FORECAST_CHANGED/);
  assert.throws(()=>f.mod.projectForecastAppendDemand_(work,{...second,campaignId:other}),/COLDY_FORECAST_CHANGED/);
  assert.throws(()=>f.mod.projectForecastAppendDemand_(work,f.page(400,401)),/COLDY_FORECAST_CHANGED/);
  work=f.mod.projectForecastAppendDemand_(work,second);
  const finalPage=f.page(400,401);work=f.mod.projectForecastAppendDemand_(work,finalPage);
  assert.equal(work.complete,true);assert.equal(work.processed,401);assert.equal(work.cohorts.length,1);assert.equal(work.cohorts[0].count,401);
  assert.deepEqual(plain(work.seenIds),[]);assert.equal(f.mod.projectForecastAppendDemand_(work,finalPage),work);
  const empty=fixture([]);assert.equal(empty.mod.projectForecastAppendDemand_(null,empty.page()).complete,true);
});

test('rejects changed totals, short pages, other campaigns, duplicate IDs and invalid offsets',()=>{
  const leads=[makeLead(1),makeLead(2)];assert.throws(()=>fixture(leads).page(0,3),/COLDY_FORECAST_CHANGED/);
  for(const override of [{offset:2},{limit:100},{items:[leads[0]]},{items:[leads[0],leads[0]]},{items:[leads[0],makeLead(2,{campaign_id:other})]}])
    assert.throws(()=>fixture(leads,{override}).page(),/COLDY_FORECAST_CHANGED/);
  const f=fixture(leads);assert.throws(()=>f.page(-1),/INVALID_REQUEST/);
});
