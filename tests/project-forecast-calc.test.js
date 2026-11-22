import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const c=vm.createContext({Date, Intl});
for (const file of ['ProjectInfrastructure.gs','ProjectCapacity.gs','ProjectForecastCalc.gs']) {
  vm.runInContext(readFileSync(new URL('../src/'+file,import.meta.url),'utf8'),c);
}
const sunday='2026-11-22T17:00:00+03:00';
const weekdays=['monday','tuesday','wednesday','thursday','friday'];
function campaign(id, options={}) {
  const {schedule={},...rest}=options;
  return {id,status:'Active',allSendersSelected:true,schedule:{
    days:weekdays,from:'09:00',to:'19:00',timezone:'Europe/Moscow',gapStartSeconds:0,gapEndSeconds:0,...schedule
  },...rest};
}
function account(id,campaignIds,options={}) {
  return {id:String(id),dailyLimit:50,sentToday:0,status:'Connected',updatedAt:sunday,
    capacity:{state:campaignIds.length?'busy':'free',campaignIds},...options};
}
function lead(count,overrides={}) {
  return {count,disposition:'eligible',senderId:null,sentSteps:0,previousStepId:null,lastSentAt:null,...overrides};
}
function demand(cohorts,delays=[0],overrides={}) {
  return {complete:true,cohorts,sequence:{known:true,steps:delays.map((delayDays,i)=>({id:i+1,delayDays})),priority:'sequence_emails'},...overrides};
}
function calc(accounts,campaigns,demands,now=sunday,overrides={}) {
  const data={accounts,monitoring:{accountIds:accounts.map(a=>a.id)},capacity:{state:'ready',stale:false,updatedAt:sunday,campaigns},...overrides};
  return JSON.parse(JSON.stringify(c.projectForecastCalculate_(data,demands,Date.parse(now))));
}

test('Moscow tomorrow, three days and seven days count a shared 20-mailbox pool of 50 just once',()=>{
  const ids=['k','l','w'],accounts=Array.from({length:20},(_,i)=>account(i+1,ids));
  const result=calc(accounts,ids.map(id=>campaign(id)),Object.fromEntries(ids.map(id=>[id,demand([lead(2200)])])));
  assert.equal(result.startDate,'2026-11-23');
  assert.deepEqual(result.periods.map(p=>[p.days,p.from,p.to,p.initial,p.followups,p.expected,p.capacity]),[
    [1,'2026-11-23','2026-11-23',1000,0,1000,1000],
    [3,'2026-11-23','2026-11-25',3000,0,3000,3000],
    [7,'2026-11-23','2026-11-29',5000,0,5000,5000]
  ]);
  assert.deepEqual(result.days.slice(-2).map(d=>d.expected),[0,0]);
});

test('first emails trigger followups on their actual modeled send day plus the next delay; finite demand is not repeated',()=>{
  const r=calc([account(1,['k'],{dailyLimit:2})],[campaign('k')],{k:demand([lead(3)],[0,2])});
  assert.deepEqual(r.days.map(d=>[d.initial,d.followups]),[[2,0],[1,0],[0,2],[0,1],[0,0],[0,0],[0,0]]);
  assert.equal(r.periods[2].capacity,10);
});

test('open Sunday consumes only the remainder of the current quota; calendar rolls over at Moscow midnight',()=>{
  const a=account(1,['k'],{dailyLimit:4,sentToday:2}), k=campaign('k',{schedule:{days:['sunday',...weekdays],from:'00:00',to:'24:00'}});
  const r=calc([a],[k],{k:demand([lead(5)])},'2026-11-22T20:59:00Z');
  assert.equal(r.days[0].initial,3);
  a.sentToday=null;
  const unknown=calc([a],[k],{k:demand([lead(5)])},'2026-11-22T20:59:00Z');
  assert.equal(unknown.days[0].expected,null); assert.ok(unknown.reasons.includes('unknown_today'));
  const late=calc([],[],{},'2026-11-22T21:01:00Z'); assert.equal(late.startDate,'2026-11-24');
});

test('per-campaign overall and first/followup limits and fixed sender do not duplicate quota',()=>{
  const accounts=[account(1,['k']),account(2,['k']),account(3,['k'])];
  const k=campaign('k',{allSendersSelected:false});
  const d=demand([lead(20,{senderId:1}),lead(20,{senderId:1,sentSteps:1,previousStepId:1,lastSentAt:sunday}),
    lead(900,{senderId:999})],[0,2],{dailyLimit:5,firstDailyLimit:2,followupDailyLimit:3});
  const r=calc(accounts,[k],{k:d});
  assert.deepEqual(r.days.slice(0,3).map(row=>[row.initial,row.followups,row.capacity]),[[2,0,5],[2,3,5],[2,3,5]]);
  assert.equal(r.reasons.length,0);
});

test('overnight New York window converts into Moscow Tuesday, and an overlap does not double the mailbox slots',()=>{
  const ny={days:['monday'],from:'23:30',to:'00:30',timezone:'America/New_York',gapStartSeconds:1800,gapEndSeconds:1800};
  const ru={days:['tuesday'],from:'07:30',to:'08:30',timezone:'Europe/Moscow',gapStartSeconds:1800,gapEndSeconds:1800};
  const r=calc([account(1,['k','l'])],[campaign('k',{schedule:ny}),campaign('l',{schedule:ru})],{k:demand([lead(20)]),l:demand([lead(20)])});
  assert.deepEqual(r.days.slice(0,3).map(r=>[r.expected,r.capacity]),[[0,0],[2,2],[0,0]]);
});

test('fall DST transition repeats the local 01:00 hourly window in New York',()=>{
  const s={days:['sunday'],from:'01:00',to:'02:00',timezone:'America/New_York',gapStartSeconds:3600,gapEndSeconds:3600};
  const r=calc([account(1,['k'])],[campaign('k',{schedule:s})],{k:demand([lead(90)])},'2026-10-31T15:00:00Z');
  assert.equal(r.days[0].date,'2026-11-01'); assert.equal(r.days[0].expected,2);assert.equal(r.days[0].capacity,2);
});

test('incomplete evidence preserves a separate quota ceiling, including unknown foreign sender allocation',()=>{
  for (const [code,accounts,camps,demands] of [
    ['incomplete_demand',[account(1,['k'])],[campaign('k')],{}],
    ['unknown_sender',[account(1,['k'])],[campaign('k',{allSendersSelected:false})],{k:demand([lead(90)])}],
    ['unknown_lead',[account(1,['k'])],[campaign('k')],{k:demand([lead(1,{disposition:'unknown'})])}],
    ['unknown_sequence',[account(1,['k'])],[campaign('k')],{k:demand([lead(1,{previousStepId:45})])}],
    ['missing_gap',[account(1,['k'])],[campaign('k',{schedule:{gapStartSeconds:null}})],{k:demand([lead(1)])}],
    ['outside_campaigns',[account(1,['k'],{capacity:{state:'busy',campaignIds:['k'],outsideActive:true}})],[campaign('k')],{k:demand([lead(1)])}],
    ['unknown_status',[account(1,['k'],{status:'unknown'})],[campaign('k')],{k:demand([lead(1)])}]
  ]) {
    const r=calc(accounts,camps,demands);
    assert.equal(r.days[0].expected,null,code); assert.equal(r.days[0].initial,null,code);
    assert.equal(r.days[0].capacity,50,code); assert.equal(r.periods[2].expected,null,code);
    assert.equal(r.days[6].expected,0,code); assert.ok(r.reasons.includes(code),code);
  }
});

test('blocked and unselected mailboxes, stopped leads and paused campaigns cannot add sends or consume demand',()=>{
  const a=account(1,['k']), blocked=account(2,['k'],{status:'Disconnected'}), extra=account(9,['k']);
  const r=calc([a,blocked,extra],[campaign('k'),campaign('paused',{status:'Paused'})],
    {k:demand([lead(8,{senderId:9}),lead(12,{senderId:2}),lead(1,{disposition:'stopped'}),lead(1,{senderId:1})])},
    sunday,{monitoring:{accountIds:['1','2']}});
  assert.equal(r.days[0].expected,1);assert.equal(r.days[0].capacity,50);
  assert.equal(r.activeCampaigns,1);
  const onlyBlocked=calc([blocked],[campaign('k')],{}); assert.equal(onlyBlocked.periods[2].expected,0);
});

test('missing identity or stale assignment prevents interpreting incomplete selected rows as an empty mailing',()=>{
  const a=account(1,['k']), camp=campaign('k'), d={k:demand([lead(1)])};
  for(const [override,reason] of [[{monitoring:{accountIds:['1','2']}},'missing_accounts'],
    [{capacity:{stale:true,campaigns:[camp],updatedAt:sunday}},'stale_membership']]) {
    const r=calc([a],[camp],d,sunday,override);assert.equal(r.days[0].capacity,null);assert.ok(r.reasons.includes(reason));
  }
  const unknownSchedule=calc([a],[{...camp,schedule:null}],d);
  assert.equal(unknownSchedule.days[0].expected,null); assert.equal(unknownSchedule.days[0].capacity,50);
  const unknownLimit=calc([{...a,dailyLimit:null}],[camp],d);
  assert.equal(unknownLimit.days[0].capacity,null);assert.ok(unknownLimit.reasons.includes('missing_limit'));
  const independent=calc([account(1,['a']),account(2,['b'])],[campaign('a',{schedule:{days:['monday']}}),campaign('b',{schedule:{days:['tuesday']}})],{b:demand([lead(3)])});
  assert.equal(independent.days[0].expected,null);assert.equal(independent.days[1].expected,3);
});

test('unresolved queue keeps a distinct known-subset scenario, never presented as all expected sends',()=>{
  const a=account(1,['k']),k=campaign('k',{allSendersSelected:false});
  const r=calc([a],[k],{k:demand([lead(7,{senderId:1}),lead(820),lead(4,{senderId:1,disposition:'unknown'}),lead(8,{disposition:'stopped'})],[0,2])});
  assert.deepEqual(r.queue,{pendingInitial:7,pendingFollowups:0,unresolved:824,unreadCampaigns:0});
  assert.equal(r.days[0].expected,null);assert.equal(r.days[0].modeled,7);
  assert.equal(r.days[0].capacity,50);assert.equal(r.periods[2].modeled,14);
  const partial=calc([a],[k],{k:demand([lead(7,{senderId:1})],[0],{complete:false})});
  assert.equal(partial.queue.unreadCampaigns,1);assert.equal(partial.days[0].modeled,7);
  const noEvidence=calc([a],[k],{});
  assert.equal(noEvidence.days[0].modeled,null);assert.equal(noEvidence.periods[2].modeled,null);
  const empty=calc([a],[k],{k:demand([])});
  assert.equal(empty.periods[2].expected,0);
  const outside=calc([{...a,capacity:{...a.capacity,outsideActive:true}}],[k],{k:demand([lead(10,{senderId:1})])});
  assert.equal(outside.days[0].expected,null);assert.equal(outside.days[0].modeled,null);
  assert.equal(outside.queue.pendingInitial,10);
});

test('a delayed first step has no enrollment timestamp; a finished sequence has no pending demand',()=>{
  const r=calc([account(1,['k'])],[campaign('k')],{k:demand([lead(10),lead(9,{sentSteps:1,previousStepId:1})],[2])});
  assert.equal(r.days[0].expected,null);assert.equal(r.queue.unresolved,10);assert.equal(r.queue.pendingInitial,0);
  assert.ok(r.reasons.includes('unknown_sequence'));
});

test('a selected but currently unassigned sender cannot silently erase a live queue; an empty sequence confirms zero',()=>{
  const a=[account(1,['k']),account(2,[])],k=campaign('k');
  const r=calc(a,[k],{k:demand([lead(12,{senderId:2}),lead(2,{senderId:1})])});
  assert.equal(r.days[0].expected,null);assert.equal(r.days[0].modeled,2);
  assert.equal(r.queue.unresolved,12);
  const empty=calc(a,[k],{k:demand([lead(10)],[])});
  assert.equal(empty.periods[2].expected,0);assert.equal(empty.queue.unresolved,0);
});
