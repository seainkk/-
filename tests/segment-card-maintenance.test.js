import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const A='segment_companies_a', B='segment_partners_b';
function fixture(){
  const data=new Map(), tests={now:1800000000000,root:'root_1234567890',serial:0,builds:[],timerChecks:0};
  const props={getProperty:k=>data.get(k)||null,getProperties:()=>Object.fromEntries(data),setProperty(k,v){data.set(k,String(v));},deleteProperty:k=>data.delete(k)};
  const r=vm.createContext({
    Date:class extends Date {static now(){return tests.now;}},
    PropertiesService:{getScriptProperties:()=>props},
    Utilities:{getUuid:()=>String(++tests.serial)},SHARED_REQUEST_SCOPE_:{keyHash:'known',projectId:'numshield'},
    api_:fn=>fn(),segmentInput_:r=>r,id_:x=>x,locked_:fn=>fn(),segmentSourceFolder_:()=>({}),segmentFolder_:()=>({}),
    fail_:(code,message)=>{throw Object.assign(new Error(message),{registryCode:code});},
    coldyIncomingTimer_:()=>({uid:'timer',verifier:'known',rootId:tests.root,checkedAt:tests.now}),
    coldyIncomingHeartbeatKey_:()=>'heartbeat',
    coldyIncomingEnsure_:()=>{tests.timerChecks++;return {enabled:true,needsOwnerSetup:false};}
  });
  r.authorize_=()=>({properties:props,rootId:tests.root});
  for(const name of ['RegistryProjects','SegmentCardMaintenance']){
    vm.runInContext(readFileSync(new URL('../src/'+name+'.gs',import.meta.url),'utf8'),r,{filename:name});
  }
  function own(id,projectId){props.setProperty('REGISTRY_SEGMENT_PROJECT_'+id, JSON.stringify({rootId:tests.root,projectId}));}
  own(A,'numshield');own(B,'neosender');
  r.segmentCardRefreshSnapshot_=(ctx,id,guard)=>{
    tests.builds.push([id,r.registryProjectId_()]);
    tests.onBuild?.(id,guard);guard();
    return {revision:'snapshot',checkedAt:new Date(tests.now).toISOString(),rebuilt:true};
  };
  return {r,props,data,tests,own,ctx:r.authorize_(),tick:()=>r.segmentCardMaintenanceTick_(r.authorize_)};
}

test('the timer rotates through real segments from both projects without a browser session',()=>{
  const {r,tests,ctx,tick,props}=fixture();
  props.setProperty('REGISTRY_SEGMENT_PROJECT_in_another_root',JSON.stringify({rootId:'elsewhere',projectId:'numshield'}));
  props.setProperty(r.segmentCardMaintenanceKey_('numshield',A),'{');
  tick();tick();tick();
  assert.deepEqual(tests.builds,[[A,'numshield'],[B,'neosender']]);
  assert.equal(r.registryProjectId_(),'numshield');
  // A direct sheet edit is observed on the next regular turn even without a dirty hint.
  tests.now+=301000;tick(); assert.equal(tests.builds.length,3);
  tests.now+=61000;r.segmentCardMaintenanceRequest_(ctx,A);tick();tick();
  assert.equal(tests.builds.at(-1)[0],A);
});

test('a changed segment, timed-out worker or racing prime cannot publish the old card',()=>{
  const {r,tests,props,own,tick}=fixture();
  tests.onBuild=(_,guard)=>{
    assert.equal(r.prepareSegmentCardSnapshot_({segmentId:A}).state,'busy');
    own(A,'neosender');assert.throws(guard,e=>e.registryCode==='OUTSIDE_PROJECT');
  };
  assert.throws(tick,e=>e.registryCode==='OUTSIDE_PROJECT');
  assert.equal(props.getProperty(r.SEGMENT_CARD_MAINTENANCE.lease),null);
  assert.throws(()=>r.prepareSegmentCardSnapshot_({segmentId:A}),e=>e.registryCode==='OUTSIDE_PROJECT');
  delete tests.onBuild;
  own(A,'numshield');tests.onBuild=()=>{tests.now+=301000;};
  assert.throws(()=>r.prepareSegmentCardSnapshot_({segmentId:A}),e=>e.registryCode==='BUSY');
});

test('dirty work arriving during a build survives completion; the original campaign result is not needed',()=>{
  const {r,tests,ctx,tick}=fixture();
  tests.onBuild=(id)=>{if(id===A){tests.now+=1000;r.segmentCardMaintenanceRequest_(ctx,id);}};
  tick();tick();delete tests.onBuild;
  tests.now+=61000;tick();
  assert.deepEqual(tests.builds,[[A,'numshield'],[B,'neosender'],[A,'numshield']]);
  assert.equal(tests.timerChecks,0);
  const done=r.prepareSegmentCardSnapshot_({segmentId:A});
  assert.equal(done.state,'ready');assert.equal(done.backgroundEnabled,true);
  const count=tests.builds.length, status=r.prepareSegmentCardSnapshot_({segmentId:A,statusOnly:true});
  assert.equal(status.state,'ready');assert.ok(Date.parse(status.lastBackgroundAt));assert.equal(tests.builds.length,count);
});
