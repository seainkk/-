import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({
  Date, Intl,COLDY:{cacheMillis:300000},
  coldyUuid_: value => /^[a-f0-9-]{36}$/.test(value),
  fail_(code) { throw new Error(code); },
  digest_: value => createHash('sha256').update(value).digest('hex')
});
for (const name of ['ProjectInfrastructure','ProjectCapacity','ProjectForecastDemand','ProjectForecastCalc','ProjectCampaignCompletion']) {
  vm.runInContext(readFileSync(new URL('../src/'+name+'.gs',import.meta.url),'utf8'), context, {filename:name+'.gs'});
}
const a='11111111-1111-4111-8111-111111111111', b='22222222-2222-4222-8222-222222222222';
const now='2026-11-22T12:00:00Z'; // Sunday, next campaign window is Monday.
const weekdays=['monday','tuesday','wednesday','thursday','friday'];
function recipients(campaign, rows, delays=[0,2], status='Active') {
  const sequence=context.projectForecastSequence_({id:campaign,sequences:delays.map((delay,i)=>({id:i+1,delay})),
    is_stop_sending_on_reply:true,is_stop_sending_on_company_reply:false,sending_priority:'sequence_emails'});
  let work=null;
  for (let start=0; start<rows.length || start===0; start+=200) {
    const items=rows.slice(start,start+200).map((fields,i)=>({
      id:start+i+1,campaign_id:campaign,verification_status:'valid',chosen_sender:1,status:'Not contacted',
      stop_sending:false,amount_sequences_sent:0,id_previous_sending_sequence:0,email:'private@example.test',...fields
    }));
    const page=context.projectForecastDemandPage_(campaign,start,rows.length,sequence,{items,offset:start,total:rows.length,limit:200},true);
    work=context.projectForecastAppendDemand_(work,page);
    assert.strictEqual(context.projectForecastAppendDemand_(work,page),work);
  }
  return {...work,sequence,campaignStatus:status};
}

function calculate(demands, limit=10) {
  const ids=Object.keys(demands);
  const accounts=[{id:'1',status:'Connected',updatedAt:now,dailyLimit:limit,sentToday:0,capacity:{state:'busy',campaignIds:ids}}];
  const campaigns=ids.map(id=>({id,status:demands[id].campaignStatus,allSendersSelected:true,
    schedule:{days:weekdays,from:'09:00',to:'18:00',timezone:'Europe/Moscow',gapStartSeconds:0,gapEndSeconds:0}}));
  return context.projectCampaignCompletions_({accounts, monitoring:{accountIds:['1']},capacity:{updatedAt:now,state:'ready',stale:false,campaigns}},demands, Date.parse(now));
}
const sentOne={status:'Sent',amount_sequences_sent:1,id_previous_sending_sequence:1,date_last_sequence_send:'2026-11-20T10:00:00Z'};

test('completion counts sent messages and all applicable remaining steps for verified contacts',()=>{
  const demand=recipients(a,[sentOne,{}, {...sentOne,status:'Replied'}, {...sentOne,verification_status:'invalid'},
    {...sentOne,verification_status:'not_verified'},{...sentOne,verification_status:'accept_all'}]);
  const result=calculate({[a]:demand})[a];
  assert.deepEqual([result.sent,result.remaining,result.total,result.percent],[2,3,5,40]);
  assert.doesNotMatch(JSON.stringify(result),/private@example|leadIds|seenIds|cohorts/);
});

test('the last follow-up determines the finish even beyond the seven-day forecast',()=>{
  const demand=recipients(a,[{}],[0,9]);
  const result=calculate({[a]:demand})[a];
  assert.deepEqual([result.sent,result.remaining,result.percent],[0,2,0]);
  assert.equal(result.estimatedDate,'2026-12-02');
});

test('two campaigns share their single mailbox quota and use separate working days',()=>{
  const results=calculate({[a]:recipients(a,[{}],[0]),[b]:recipients(b,[{}],[0])},1);
  assert.deepEqual([results[a].estimatedDate,results[b].estimatedDate].sort(),['2026-11-23','2026-11-24']);
});

test('paused campaigns retain progress, and a provider status alone cannot imply 100 percent',()=>{
  const result=calculate({[a]:recipients(a,[sentOne],[0,2],'Paused')})[a];
  assert.equal(result.percent,50);
  assert.equal(result.estimatedDate,null);
  const ended=calculate({[a]:recipients(a,[sentOne],[0,2],'Completed')})[a];
  assert.notEqual(ended.percent,100);
});

test('zero eligible messages have no percentage and an outstanding send can never round to 100',()=>{
  const empty=calculate({[a]:recipients(a,[{verification_status:'invalid'}],[0])})[a];
  assert.equal(empty.percent,null);
  assert.equal(empty.estimatedDate,null);
  const almost=recipients(a,[...Array(200).fill(sentOne),{}],[0]);
  const result=calculate({[a]:almost})[a];
  assert.equal(result.total,201);
  assert.equal(result.remaining,1);
  assert.ok(result.percent<100 && result.percent>=99);
  const done=calculate({[a]:recipients(a,[sentOne],[0])})[a];
  assert.equal(done.percent,100);
  assert.equal(done.remaining,0);
});

test('two recent observed working days estimate a finish without a quota and keep actual limits and pauses authoritative',()=>{
  const thursday={...sentOne,date_last_sequence_send:'2026-11-19T09:00:00Z'};
  const recipientsList=[thursday,sentOne,sentOne,sentOne,{},{},{}];
  const d=recipients(a,recipientsList,[0]);
  const measured=calculate({[a]:d},null)[a];
  assert.deepEqual([measured.sent,measured.total,measured.reason,measured.estimatedDate],[4,7,'observed_pace','2026-11-24']);
  assert.equal(calculate({[a]:d},8)[a].estimatedDate,'2026-11-23');
  assert.equal(calculate({[a]:d},1)[a].estimatedDate,'2026-11-25');
  assert.equal(calculate({[a]:d},0)[a].reason,'no_capacity');
  assert.equal(calculate({[a]:{...d,campaignStatus:'Paused'}},null)[a].estimatedDate,null);
  assert.equal(calculate({[a]:recipients(a,[sentOne,sentOne,{}],[0])},null)[a].estimatedDate,null);
  assert.equal(calculate({[a]:recipients(a,[
    {...sentOne,date_last_sequence_send:'2026-11-16T09:00:00Z'},
    {...sentOne,date_last_sequence_send:'2026-11-17T09:00:00Z'},{}],[0])},null)[a].estimatedDate,null);
  const delayed=calculate({[a]:recipients(a,recipientsList,[0,9])},null)[a];
  assert.equal(delayed.reason,'observed_pace');
  assert.ok(delayed.estimatedDate>='2026-12-02');
});

test('a recent campaign detail fills a pending schedule and yields to a subsequent confirmed removal',()=>{
  const observed=Date.parse(now);
  const schedule={timezone:'Europe/Moscow',days:weekdays,from:'09:00',to:'18:00',gapStartSeconds:0,gapEndSeconds:0};
  const demand={schedule,scheduleCheckedAt:observed};
  assert.equal(context.projectCampaignSchedule_({scheduleState:'pending'},demand,observed),schedule);
  assert.equal(context.projectCampaignSchedule_({scheduleState:'unavailable',scheduleUpdatedAt:now},demand,observed),null);
  assert.equal(context.projectCampaignSchedule_({scheduleState:'error'},demand,observed),null);
  assert.equal(context.projectCampaignSchedule_({scheduleState:'pending'},demand,observed+300001),null);
});

test('a recipient that already received the final step does not need a sender assignment to forecast the outstanding queue',()=>{
  const d=recipients(a,[{...sentOne,chosen_sender:undefined},{}],[0]);
  const row=calculate({[a]:d},2)[a];
  assert.deepEqual([row.sent,row.remaining,row.estimatedDate],[1,1,'2026-11-23']);
});
