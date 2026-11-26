import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';

const A='segment_companies_a', B='segment_partners_b';
function fixture(){
  const data=new Map(), tests={now:1800000000000,root:'root_1234567890',serial:0,builds:[],timerChecks:0};
  const props={getProperty:k=>data.get(k)||null,getProperties:()=>Object.fromEntries(data),setProperty(k,v){data.set(k,String(v));},
    setProperties(values){for(const [key,value] of Object.entries(values))this.setProperty(key,value);},deleteProperty:k=>data.delete(k)};
  const r=vm.createContext({
    Date:class extends Date {constructor(...args){super(...(args.length?args:[tests.now]));}static now(){return tests.now;}},
    PropertiesService:{getScriptProperties:()=>props},
    LockService:{getUserLock:()=>({tryLock:wait=>!tests.denied?.(wait),releaseLock(){}})},
    Utilities:{getUuid:()=>String(++tests.serial)},SHARED_REQUEST_SCOPE_:{keyHash:'known',projectId:'numshield'},
    api_:fn=>fn(),segmentInput_:r=>r,id_:x=>x,digest_:x=>createHash('sha256').update(x).digest('base64url'),
    locked_:()=>{throw new Error('Registry write lock is busy');},segmentSourceFolder_:()=>({}),segmentFolder_:()=>({}),
    fail_:(code,message)=>{throw Object.assign(new Error(message),{registryCode:code});},
    coldyIncomingTimer_:()=>({uid:'timer',verifier:'known',rootId:tests.root,checkedAt:tests.now}),
    coldyIncomingHeartbeatKey_:()=>'heartbeat',
    coldyIncomingEnsure_:()=>{tests.timerChecks++;return {enabled:true,needsOwnerSetup:false};}
  });
  r.authorize_=()=>({properties:props,rootId:tests.root});
  for(const name of ['RegistryProjects','SegmentCardSnapshots','SegmentCardMaintenance']){
    vm.runInContext(readFileSync(new URL('../src/'+name+'.gs',import.meta.url),'utf8'),r,{filename:name});
  }
  function own(id,projectId){props.setProperty('REGISTRY_SEGMENT_PROJECT_'+id, JSON.stringify({rootId:tests.root,projectId}));}
  own(A,'numshield');own(B,'neosender');
  const refresh=r.segmentCardRefreshSnapshot_;
  // Isolate the source read while exercising the production receipt write and scope.
  r.segmentCardFiles_=()=>({storage:{public:{id:'storage'}},files:{},folder:{getName:()=>''}});
  r.segmentCardCampaigns_=()=>({credential:'',bindings:[]});
  r.segmentCardRevision_=()=>r.digest_(String(tests.version||'1'));
  r.segmentCardData_=()=>({snapshot:{rows:[],summary:{}}});
  r.segmentCardSnapshotPack_=()=> 'compressedBody';
  r.coldySave_=()=>{};
  const stages=new Map();
  r.CacheService={getScriptCache:()=>({get:k=>k.startsWith('card-stage/')?stages.get(k)||null:'cached',
    put(k,v,ttl){assert.equal(ttl,900);stages.set(k,v);}})};
  r.segmentCardWriteCache_=()=>{};
  r.segmentCardSnapshotWarm_=()=>{};
  r.segmentCardRefreshSnapshot_=(ctx,id,guard,scheduled)=>{
    tests.builds.push([id,r.registryProjectId_()]);
    tests.onBuild?.(id,guard);guard();
    return refresh(ctx,id,guard,scheduled);
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

test('the committed receipt survives finalizer contention, a lost queue checkpoint and a later manual rebuild',()=>{
  const {r,tests,props,tick}=fixture();
  const key=r.segmentCardMaintenanceKey_('numshield',A), status=()=>r.prepareSegmentCardSnapshot_({segmentId:A,statusOnly:true});
  assert.equal(status().state,'pending');
  tests.denied=wait=>wait===8000;
  tests.onBuild=()=>{assert.equal(status().refreshState,'running');};
  assert.equal(tick().state,'ready');
  const receipt=status();
  assert.equal(receipt.state,'ready'); assert.ok(Date.parse(receipt.lastBackgroundAt)); assert.equal(receipt.queueBusy,true);
  props.deleteProperty(key); // The diagnostic must also work with pre-upgrade/unfinished queue state.
  assert.equal(status().checkedAt,receipt.checkedAt);
  assert.equal(status().lastBackgroundAt,receipt.lastBackgroundAt);
  tests.now+=301000;tests.version=2;delete tests.denied;
  assert.equal(r.prepareSegmentCardSnapshot_({segmentId:A}).state,'ready');
  assert.equal(status().lastBackgroundAt,receipt.lastBackgroundAt,'A manual rebuild retains the last actual timer completion');
  assert.equal(status().queueBusy,false);
});

test('a rate or source failure keeps its code through finalizer contention; a missed completion can retry after expiry',()=>{
  const {r,tests,tick}=fixture(), status=()=>r.prepareSegmentCardSnapshot_({segmentId:A,statusOnly:true});
  tests.onBuild=()=>r.fail_('SEGMENT_CARD_CHANGED','Changed');
  tests.denied=wait=>wait===8000;
  assert.throws(tick,e=>e.registryCode==='SEGMENT_CARD_CHANGED');
  assert.equal(status().state,'pending'); assert.ok(status().attemptAt);
  tests.now+=301000;delete tests.denied;
  assert.equal(status().refreshState,'interrupted');
  assert.throws(()=>r.prepareSegmentCardSnapshot_({segmentId:A}),e=>e.registryCode==='SEGMENT_CARD_CHANGED');
  assert.equal(status().lastError,'SEGMENT_CARD_CHANGED');assert.equal(status().refreshState,'retrying');
  delete tests.onBuild;assert.equal(r.prepareSegmentCardSnapshot_({segmentId:A}).state,'ready');
  assert.equal(status().lastError,null);assert.equal(status().lastBackgroundAt,null);
});

test('status reports only the current attempt stage while a slow service read is running or interrupted',()=>{
  const {r,tests,tick,props}=fixture(), status=()=>r.prepareSegmentCardSnapshot_({segmentId:A,statusOnly:true});
  tests.denied=wait=>wait===8000;
  const name='private@example.org';
  r.segmentCardData_=()=>{
    const during=status();assert.equal(during.stage,'contacts');assert.equal(during.stageStartedAt,during.attemptAt);
    throw new Error(name);
  };
  assert.throws(tick);
  tests.now+=301000;delete tests.denied;
  assert.equal(status().refreshState,'interrupted');assert.equal(status().stage,'contacts');assert.ok(!JSON.stringify(status()).includes(name));
  // A new run must not surface an old attempt when its cache entry is unavailable.
  r.CacheService={getScriptCache:()=>({get(){throw Error('unavailable');},put(){throw Error('unavailable');}})};
  assert.equal(status().stage,null);assert.equal(status().stageStartedAt,null);
  r.segmentCardData_=()=>({snapshot:{rows:[],summary:{}}});
  assert.equal(r.prepareSegmentCardSnapshot_({segmentId:A}).state,'ready');
  const saved=props.getProperty(r.segmentCardMaintenanceKey_('numshield',A));
  tests.now+=301000;
  const builds=tests.builds.length;
  assert.equal(r.segmentCardMaintenanceTick_(r.authorize_,tests.now-1).state,'busy');
  assert.equal(tests.builds.length,builds);
  assert.equal(props.getProperty(r.segmentCardMaintenanceKey_('numshield',A)),saved);
});
