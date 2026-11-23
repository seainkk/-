import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const a='11111111-1111-4111-8111-111111111111', b='22222222-2222-4222-8222-222222222222';
const copy=v=>JSON.parse(JSON.stringify(v));
function fixture(){
  const state={now:Date.now(),key:'verifier',credential:'organization',triggers:[],revision:1,blocked:[],afterRead:null};
  const bindings=[{id:'binding1',segmentId:'kitchens',campaignId:a,includeCompanies:true,includeLpr:false,revision:1},
    {id:'binding2',segmentId:'studios',campaignId:b,includeCompanies:false,includeLpr:true,revision:1}];
  const projects={kitchens:'numshield',studios:'neosender'};
  const data=new Map(),privateFiles=new Map(),paths=[],writes=[],saves=[],versions={companies:'1',lpr:'1'};
  const props={getProperty:k=>data.get(k)||null,setProperty:(k,v)=>data.set(k,v),deleteProperty:k=>data.delete(k),getProperties:()=>Object.fromEntries(data)};
  const context={properties:props,rootId:'root'};
  function fail(code,message){throw Object.assign(new Error(message||code),{registryCode:code});}
  function trigger(id){return {getUniqueId:()=>id,getHandlerFunction:()=>'coldyRecipientTick_'};}
  class Clock extends Date {constructor(...args){super(...(args.length?args:[state.now]));}static now(){return state.now;}}
  let serial=0;
  const r=vm.createContext({Date:Clock,Utilities:{getUuid:()=>String(++serial)},PropertiesService:{getScriptProperties:()=>props},
    LockService:{getUserLock:()=>({
      tryLock(){if(state.ownerLocked)return false;state.ownerLocked=true;state.onOwnerLock?.();return true;},
      releaseLock(){state.ownerLocked=false;}
    })},
    REGISTRY_CONFIG:{defaultRootFolderId:'root'},SHARED_REQUEST_SCOPE_:{keyHash:state.key,projectId:'numshield'},
    ScriptApp:{getProjectTriggers:()=>state.triggers,newTrigger:name=>{
      assert.equal(name,'coldyRecipientTick_');return {timeBased:()=>({everyMinutes:minutes=>{
        assert.equal(minutes,1);return {create(){if(state.consent===false)throw Error('Unapproved');const t=trigger('timer-'+(++serial));state.triggers.push(t);return t;}};
      }})};
    },deleteTrigger:t=>{state.triggers=state.triggers.filter(x=>x!==t);}},
    sharedConfiguredHash_:()=>state.key,authorize_:()=>{if(r.SHARED_REQUEST_SCOPE_?.keyHash!==state.key)fail('LINK_ACCESS_REQUIRED');return context;},
    registryRoot_:()=>{},api_:fn=>fn(),locked_:fn=>fn(),fail_:fail,registryError_:code=>Object.assign(Error(code),{registryCode:code}),
    digest_:s=>createHash('sha256').update(s).digest('base64url'),
    coldyCredentialHash_:()=>state.credential,coldySettings_:()=>({configured:true,credentialHash:state.credential}),coldyInput_:()=>{},coldyGetPause_:()=>null,
    registryProjectId_:()=>r.SHARED_REQUEST_SCOPE_.projectId,registrySegmentProject_:(_c,id)=>projects[id],registryProjectName_:p=>['numshield','neosender'].includes(p)?p:'',
    coldyCampaignScope_:(_c,seg)=>{if(projects[seg]!==r.SHARED_REQUEST_SCOPE_.projectId)fail('COLDY_SCOPE_CHANGED');},
    coldyCampaignRegistry_:()=>({bindings:copy(bindings)}),coldyCampaignBinding_:(registry,seg,id)=>{
      const record=registry.bindings.find(x=>x.id===id&&x.segmentId===seg);if(!record)fail('COLDY_BINDING_CHANGED');return record;
    },
    coldyCampaignDetail_:(_id,v)=>v,coldyCampaignId_:id=>id,coldyUuid_:s=>/^[\da-f-]{36}$/.test(s),coldyEmail_:s=>s,
    coldyLoad_:(_c,kind,owner)=>copy(privateFiles.get(kind+owner)||null),coldySave_:(_c,kind,owner,value)=>{saves.push(kind);privateFiles.set(kind+owner,copy(value));},
    coldyRecipientSheetTarget_:(_c,bind,kind)=>({fileId:bind.segmentId+kind,sheetId:1}),
    coldyRecipientSheetVersion_:(_c,_bind,kind)=>versions[kind],contactSyncMetadata_:()=>({}),
    coldyRecipientSheetWrite_:(_c,bind,kind,target,rows,guard,_before,opts)=>{
      guard();assert.equal(opts.existingOnly,true);assert.equal(projects[bind.segmentId],r.SHARED_REQUEST_SCOPE_.projectId);
      writes.push({id:bind.campaignId,kind,target:copy(target),rows:copy(rows)});
      return {processed:rows.length,existing:rows.length};
    },
    coldyGetBatch_:(_c,list,guard)=>{
      guard();const results=list.map(path=>{
        assert.match(path,/^\/(campaigns\/|leads\/campaign\/)/);paths.push(path);
        const id=path.match(/[\da-f-]{36}/)[0];
        if(state.failure?.id===id)return {error:Object.assign(Error(),{registryCode:state.failure.code,retryAfterMs:state.failure.retry||0})};
        if(path.startsWith('/campaigns/'))return {value:{id,name:'Test',status:'Active'}};
        const offset=Number(path.match(/offset=(\d+)/)[1]),total=state.counts?.[id]??1;
        return {value:{total,offset,limit:200,items:Array.from({length:Math.min(200,total-offset)},(_,i)=>({
          id:offset+i+1,email:'contact'+(offset+i)+'@example.test',campaign_id:id,amount_sequences_sent:state.revision,
          stop_sending:false,status:'Sent',reply_text:null
        }))}};
      });state.afterRead?.();guard();return results;
    }
  });
  for(const name of ['ColdyRecipientData','ColdyRecipientAutomation']){
    vm.runInContext(readFileSync(new URL('../src/'+name+'.gs',import.meta.url),'utf8'),r,{filename:name+'.gs'});
  }
  r.coldyRecipientHistoricalBlocks_=()=>[];
  r.coldyRecipientSuppression_=()=>({hits:state.blocked,nextCursor:null,unavailable:false,retryAfterMs:0});
  const enable=()=>r.enableColdyRecipientSync_({});const tick=(uid=state.triggers[0]?.getUniqueId())=>r.coldyRecipientTick_({triggerUid:uid});
  return {state,bindings,projects,props,data,paths,writes,saves,versions,r,enable,tick,next(){state.now+=60000;tick();}};
}

test('dedicated minute trigger installs once and only accepts its own UID, root and verifier',()=>{
  const f=fixture();f.state.consent=false;assert.equal(f.enable().needsOwnerSetup,true);
  f.state.consent=true;assert.equal(f.enable().enabled,true);assert.equal(f.enable().intervalMinutes,1);
  assert.equal(f.state.triggers.length,1);f.tick('wrong');assert.equal(f.paths.length,0);
  f.data.set('ROOT_FOLDER_ID','elsewhere');f.tick();assert.equal(f.paths.length,0);f.data.delete('ROOT_FOLDER_ID');
  f.state.key='revoked';f.tick();assert.equal(f.paths.length,0);assert.equal(f.writes.length,0);
});

test('both project bindings update enrolled Email rows offline, and manual sheet edits or new provider data invalidate the fast path',()=>{
  const f=fixture();f.enable();f.tick();
  assert.deepEqual(f.writes.map(x=>x.kind).sort(),['companies','lpr']);assert.equal(f.r.SHARED_REQUEST_SCOPE_.projectId,'numshield');
  f.next();assert.equal(f.writes.length,4,'a full negative blacklist observation is distinct from an unchecked email');
  const saves=f.saves.length;f.next();assert.equal(f.writes.length,4);assert.equal(f.saves.length,saves);
  f.versions.companies='2';f.next();assert.equal(f.writes.length,5);assert.equal(f.writes.at(-1).kind,'companies');
  f.state.revision=2;f.next();assert.equal(f.writes.length,7);assert.equal(f.writes.at(-1).rows[0].sentCount,2);
  const rows=[{id:a}];f.r.coldyIncomingDecorate_(f.r.authorize_(),[f.bindings[0]],rows);
  assert.equal(rows[0].recipientSync.state,'synced');assert.ok(rows[0].recipientSync.lastSyncedAt);
});

test('a timed-out worker exposes its real start and yields the next turn to the other binding',()=>{
  const f=fixture();f.enable();
  function status(binding){
    f.r.SHARED_REQUEST_SCOPE_.projectId=f.projects[binding.segmentId];
    f.r.coldyIncomingDecorate_(f.r.authorize_(),[binding],[]);return binding.recipientSync;
  }
  assert.equal(status(f.bindings[0]).lastTickAt,null);
  let first;
  f.state.afterRead=()=>{
    first=f.bindings.find(binding=>f.paths[0].includes(binding.campaignId));
    assert.equal(status(first).state,'syncing');assert.ok(status(first).lastAttemptAt);
    f.state.afterRead=null;f.state.now+=300001;
  };
  assert.throws(()=>f.tick(),e=>e.registryCode==='COLDY_RECIPIENT_LEASE_EXPIRED');
  const interrupted=status(first);
  assert.equal(interrupted.state,'retrying');assert.equal(interrupted.issue,'timeout');
  assert.ok(interrupted.lastTickAt);assert.equal(interrupted.lastSyncedAt,null);
  const prior=f.paths.length;f.next();
  assert.ok(!f.paths[prior].includes(first.campaignId),'the unattempted binding receives the next slot');
});

test('a busy registry write does not block timer admission; private checkpoints still take the script lock',()=>{
  const f=fixture();f.enable();
  let occupied=true,checkedWrites=0;
  f.r.locked_=fn=>{
    assert.equal(occupied,false,'no script lock while claiming the timer or reading Coldy');
    assert.equal(f.state.ownerLocked,false,'the owner lock is released before any registry operation');
    checkedWrites++;return fn();
  };
  f.state.afterRead=()=>{assert.equal(f.state.ownerLocked,false);occupied=false;};
  f.tick();
  assert.ok(checkedWrites>0);assert.ok(f.saves.length>0);
  assert.deepEqual(f.writes.map(w=>w.kind).sort(),['companies','lpr']);
  assert.equal(f.data.has('COLDY_RECIPIENT_TICK_LEASE'),false);
});

test('a stale timer cannot claim a lease after waiting for the owner lock',()=>{
  const f=fixture();f.enable();
  f.state.onOwnerLock=()=>{
    const marker=JSON.parse(f.data.get('COLDY_RECIPIENT_TIMER_V1'));marker.uid='replacement';
    f.data.set('COLDY_RECIPIENT_TIMER_V1',JSON.stringify(marker));
  };
  assert.throws(()=>f.tick(),e=>e.registryCode==='COLDY_SCOPE_CHANGED');
  assert.equal(f.data.has('COLDY_RECIPIENT_TICK_LEASE'),false);assert.equal(f.paths.length,0);
  assert.equal(f.state.ownerLocked,false);
});

test('a slow discovery still leaves time for the first working cycle',()=>{
  const f=fixture();f.enable();const read=f.r.coldyCampaignRegistry_;
  let first=true;
  f.r.coldyCampaignRegistry_=(...args)=>{if(first){first=false;f.state.now+=46000;}return read(...args);};
  f.tick();assert.deepEqual(f.writes.map(w=>w.kind).sort(),['companies','lpr']);
});

test('an unassigned destination and a provider cooldown have distinct public diagnostics',()=>{
  const f=fixture();f.enable();f.bindings[0].includeCompanies=false;f.tick();
  f.r.coldyIncomingDecorate_(f.r.authorize_(),[f.bindings[0]],[]);
  assert.equal(f.bindings[0].recipientSync.state,'no_target');assert.equal(f.bindings[0].recipientSync.lastSyncedAt,null);
  f.state.failure={id:a,code:'COLDY_RATE_LIMIT',retry:180000};f.next();f.next();
  f.r.coldyIncomingDecorate_(f.r.authorize_(),[f.bindings[0]],[]);
  assert.equal(f.bindings[0].recipientSync.issue,'rate_limit');assert.ok(f.bindings[0].recipientSync.nextRetryAt);
});

test('large campaign resumes, a failing campaign cannot block the other project, and 429 respects its retry deadline',()=>{
  const f=fixture();f.enable();f.state.counts={[a]:1001};
  f.state.failure={id:b,code:'COLDY_NOT_FOUND'};f.tick();assert.equal(f.writes.length,0);
  f.next();assert.ok(f.writes.length>0);const rows=f.writes.flatMap(x=>x.rows);assert.equal(rows.length,1001);
  const offsets=f.paths.filter(p=>p.includes(a)&&p.includes('/leads/'));
  assert.equal(new Set(offsets).size,6);
  f.state.failure={id:a,code:'COLDY_RATE_LIMIT',retry:180000};f.next();const before=f.paths.length;
  f.next();f.next();assert.equal(f.paths.length,before);delete f.state.failure;f.next();assert.ok(f.paths.length>before);
});

test('after mixed replies a 1267-recipient campaign keeps the contiguous prefix, waits for the longest 429 and probes only the missing page',()=>{
  const f=fixture();f.bindings.splice(1);f.enable();f.state.counts={[a]:1267};
  const read=f.r.coldyGetBatch_,batches=[];
  let limited=true;
  f.r.coldyGetBatch_=(context,paths,guard)=>{
    const result=read(context,paths,guard);
    const offsets=Array.from(paths,path=>path.startsWith('/campaigns/')?'detail':Number(path.match(/offset=(\d+)/)[1]));
    batches.push(offsets);
    return result.map((entry,i)=>{
      if(limited && [400,800].includes(offsets[i])) return {error:{registryCode:'COLDY_RATE_LIMIT',retryAfterMs:offsets[i]===800?180000:60000}};
      return entry;
    });
  };
  f.tick();
  assert.deepEqual(batches,[['detail',0],[200,400,600,800]]);
  assert.equal(f.writes.length,0);assert.equal(f.saves.length,1);
  f.r.coldyIncomingDecorate_(f.r.authorize_(),[f.bindings[0]],[]);
  assert.equal(Date.parse(f.bindings[0].recipientSync.nextRetryAt),f.state.now+180000);
  assert.deepEqual(copy(f.bindings[0].recipientSync.progress),{phase:'read',read:400,total:1267});
  f.next();f.next();assert.equal(batches.length,2);
  f.next();assert.deepEqual(batches[2],[400]);assert.equal(f.writes.length,0);
  f.r.coldyIncomingDecorate_(f.r.authorize_(),[f.bindings[0]],[]);
  assert.deepEqual(copy(f.bindings[0].recipientSync.progress),{phase:'read',read:400,total:1267});
  limited=false;f.next();assert.deepEqual(batches[3],[400]);assert.equal(f.writes.length,0);
  f.r.coldyIncomingDecorate_(f.r.authorize_(),[f.bindings[0]],[]);
  assert.deepEqual(copy(f.bindings[0].recipientSync.progress),{phase:'read',read:600,total:1267});
  f.next();assert.deepEqual(batches[4],[600,800,1000,1200]);
  const rows=f.writes.flatMap(w=>w.rows);
  assert.equal(rows.length,1267);assert.equal(new Set(rows.map(r=>r.email)).size,1267);
  assert.deepEqual(rows.map(r=>r.id).sort((x,y)=>x-y),Array.from({length:1267},(_,i)=>i+1));
  f.r.coldyIncomingDecorate_(f.r.authorize_(),[f.bindings[0]],[]);
  assert.equal(f.bindings[0].recipientSync.state,'synced');
  assert.equal(f.bindings[0].recipientSync.progress,null);
});

test('a busy sheet retains only its confirmed checked and matched counts, scoped to this target and revision',()=>{
  const f=fixture();f.bindings.splice(1);const binding=f.bindings[0];
  binding.includeLpr=true;f.state.counts={[a]:670};f.enable();
  const write=f.r.coldyRecipientSheetWrite_,status=()=>{
    const load=f.r.coldyLoad_;
    try{
      f.r.coldyLoad_=()=>assert.fail('Rendering status must not load the private recipient snapshot');
      f.r.coldyIncomingDecorate_(f.r.authorize_(),[binding],[]);return binding.recipientSync;
    }finally{f.r.coldyLoad_=load;}
  };
  const calls={companies:0,lpr:0};
  f.r.coldyRecipientSheetWrite_=(...args)=>{
    const kind=args[2];
    if(++calls[kind]===2)f.r.fail_(kind==='companies'?'BUSY':'CONTACT_SYNC_JOB_ACTIVE');
    const result=write(...args);
    result.existing=Math.min(result.processed,kind==='companies'?123:17);return result;
  };
  f.tick();
  assert.equal(status().issue,'busy');
  assert.deepEqual(copy(status().progress),{phase:'write',kind:'companies',total:670,checked:300,matched:123});
  f.next();
  assert.equal(status().issue,'contact_job');
  assert.deepEqual(copy(status().progress),{phase:'write',kind:'lpr',total:670,checked:300,matched:17});
  binding.revision++;
  assert.equal(status().progress,null,'A newly configured binding cannot publish the prior snapshot');
  f.state.counts[a]=1;f.next();
  assert.equal(status().state,'synced');assert.equal(status().progress,null);
});

test('a throttled first lead page retains the confirmed campaign detail and completes a short campaign on its retry',()=>{
  const f=fixture();f.bindings.splice(1);f.enable();
  const read=f.r.coldyGetBatch_;
  f.r.coldyGetBatch_=(...args)=>{const [detail]=read(...args);return [detail,{error:{registryCode:'COLDY_RATE_LIMIT',retryAfterMs:60000}}];};
  f.tick();assert.equal(f.writes.length,0);assert.equal(f.saves.length,1);
  f.r.coldyGetBatch_=read;const before=f.paths.length;f.next();
  assert.deepEqual(f.paths.slice(before),['/leads/campaign/'+a+'?limit=200&offset=0']);
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].rows.length,1);
});

test('contradictory membership beyond a gap discards the entire prefix and never writes recipient rows',()=>{
  const f=fixture();f.bindings.splice(1);f.enable();f.state.counts={[a]:1201};
  const read=f.r.coldyGetBatch_;
  f.r.coldyGetBatch_=(...args)=>{
    const result=read(...args);
    if(args[1][0].endsWith('offset=200')){
      result[1]={error:{registryCode:'COLDY_RATE_LIMIT',retryAfterMs:180000}};
      result[2].value.items[0].id=1;
    }
    return result;
  };
  f.tick();assert.equal(f.saves.length,0);assert.equal(f.writes.length,0);
  f.r.coldyGetBatch_=read;const before=f.paths.length;f.next();f.next();assert.equal(f.paths.length,before);f.next();
  assert.equal(f.paths[before],'/campaigns/'+a);
});

test('binding or key revocation during provider reading prevents sheet writes',()=>{
  const f=fixture();f.enable();f.state.afterRead=()=>{f.state.key='different';};
  assert.throws(()=>f.tick(),e=>e.registryCode==='LINK_ACCESS_REQUIRED');assert.equal(f.writes.length,0);
  const g=fixture();g.enable();g.state.afterRead=()=>{g.bindings.length=0;};
  g.tick();assert.equal(g.writes.length,0);assert.equal(g.saves.length,0);
  const h=fixture();h.bindings.splice(1);h.enable();h.state.counts={[a]:1201};
  const read=h.r.coldyGetBatch_;
  h.r.coldyGetBatch_=(...args)=>{
    const results=read(...args);
    if(args[1][0].endsWith('offset=200')){
      results[1]={error:{registryCode:'COLDY_RATE_LIMIT',retryAfterMs:60000}};
      h.bindings[0].revision++;
    }
    return results;
  };
  h.tick();assert.equal(h.writes.length,0);assert.equal(h.saves.length,0);
});

test('legacy manual import enrolls only its recorded managed Email GID; an unrelated replacement is never claimed',()=>{
  const f=fixture();f.bindings.splice(1);const binding=f.bindings[0];
  delete binding.includeCompanies;delete binding.includeLpr;
  function storeReceipt(kind,sheetId){
    const key='old-request-'+kind;
    const slot=f.r.digest_(JSON.stringify(['root','numshield',binding.segmentId,binding.id,kind]));
    f.data.set('COLDY_RECIPIENT_SLOT_'+slot,key);
    f.data.set(key,JSON.stringify({state:'complete',target:{fileId:binding.segmentId+kind,sheetId},
      fingerprint:f.r.digest_(JSON.stringify(['root','numshield',binding.segmentId,binding.id,binding.campaignId,kind,'organization']))}));
  }
  storeReceipt('companies',1);storeReceipt('lpr',702);
  f.enable();f.tick();
  assert.deepEqual(f.writes.map(write=>write.kind),['companies']);
  f.next();const before={saves:f.saves.length,writes:f.writes.length};
  f.next();assert.equal(f.saves.length,before.saves);assert.equal(f.writes.length,before.writes);
});

test('a shared Coldy cooldown leaves campaign attempts and checkpoints untouched until both cooldowns expire',()=>{
  const f=fixture();f.enable();
  const context=f.r.authorize_(),binding=f.bindings[0];
  const markKey='COLDY_INCOMING_'+f.r.coldyIncomingOwner_(context,f.state.credential,'numshield',binding);
  const previous=JSON.stringify({attempt:f.state.now-1000,state:'syncing'});
  f.data.set(markKey,previous);
  const marker=f.r.coldyIncomingTimer_(f.props),clockKey=f.r.coldyIncomingHeartbeatKey_(marker);
  const localKey='COLDY_INCOMING_PAUSE_'+f.r.digest_(context.rootId+'|'+f.state.credential);
  const sharedUntil=f.state.now+180000;
  f.r.coldyGetPause_=(current,settings)=>{
    assert.equal(current.rootId,context.rootId);assert.equal(settings.credentialHash,f.state.credential);
    return sharedUntil>f.state.now?{retryAfterMs:sharedUntil-f.state.now}:null;
  };
  const registry=f.r.coldyCampaignRegistry_,read=f.r.coldyLoad_;
  f.r.coldyCampaignRegistry_=()=>assert.fail('Do not open the binding registry during a shared cooldown');
  f.r.coldyLoad_=()=>assert.fail('Do not open a campaign checkpoint during a shared cooldown');
  f.tick();assert.equal(JSON.parse(f.data.get(clockKey)).retryAt,sharedUntil);
  const localUntil=sharedUntil+60000;f.data.set(localKey,String(localUntil));
  f.next();f.next();f.next();
  const clock=JSON.parse(f.data.get(clockKey));
  assert.deepEqual([clock.issue,clock.retryAt],['rate_limit',localUntil]);
  assert.equal(f.data.get(markKey),previous);assert.deepEqual(f.paths,[]);assert.deepEqual(f.saves,[]);
  f.r.coldyCampaignRegistry_=registry;f.r.coldyLoad_=read;f.next();assert.ok(f.paths.length);
});

test('during a shared GET pause only an authorized saved Email write resumes, without lead or suppression requests',()=>{
  const f=fixture();f.enable();f.state.counts={[a]:680};
  const ctx=f.r.authorize_();
  const owners=f.bindings.map(bind=>f.r.coldyIncomingOwner_(ctx,f.state.credential,f.projects[bind.segmentId],bind));
  const keys=owners.map(owner=>'COLDY_INCOMING_'+owner);
  const write=f.r.coldyRecipientSheetWrite_;
  let slices=0;
  f.r.coldyRecipientSheetWrite_=(...args)=>{
    if(args[1].campaignId===a&&++slices===2) f.r.fail_('BUSY');
    return write(...args);
  };
  f.tick();
  assert.equal(JSON.parse(f.data.get(keys[0])).progress.checked,300);
  const other=f.data.get(keys[1]), priorRequests=f.paths.length;
  f.r.coldyGetPause_=()=>({retryAfterMs:300000});
  f.r.coldyGetBatch_=()=>assert.fail('No Coldy recipient HTTP during the write');
  f.r.coldyRecipientSuppression_=()=>assert.fail('No Coldy blacklist HTTP during the write');
  const load=f.r.coldyLoad_;
  f.r.coldyLoad_=(context,kind,owner)=>{assert.equal(owner,owners[0]);return load(context,kind,owner);};
  f.next();
  const rows=f.writes.filter(w=>w.id===a).flatMap(w=>w.rows);
  assert.equal(rows.length,680);assert.equal(new Set(rows.map(row=>row.id)).size,680);
  assert.equal(JSON.parse(f.data.get(keys[0])).state,'synced');
  assert.equal(f.data.get(keys[1]),other);assert.equal(f.paths.length,priorRequests);
  const marker=f.r.coldyIncomingTimer_(f.props),clock=JSON.parse(f.data.get(f.r.coldyIncomingHeartbeatKey_(marker)));
  assert.deepEqual([clock.issue,clock.retryAt],['rate_limit',f.state.now+300000]);
  f.r.coldyCampaignRegistry_=()=>assert.fail('No pending local write: do not discover campaigns again');
  f.r.coldyLoad_=()=>assert.fail('No pending local write: do not reopen the scan');
  const oldWrites=f.writes.length;f.next();assert.equal(f.writes.length,oldWrites);
});

test('a stale write-progress hint cannot start a provider read, revive an old revision, or consume a campaign attempt',()=>{
  for(const stale of ['read','revision','scope']){
    const f=fixture();f.enable();const ctx=f.r.authorize_(),bind=f.bindings[0];
    const original=f.r.coldyIncomingOwner_(ctx,f.state.credential,f.projects[bind.segmentId],bind);
    const key='COLDY_INCOMING_'+original;
    const oldMark=JSON.stringify({attempt:10,progress:{phase:'write',checked:300},progressRevision:bind.revision});
    f.data.set(key,oldMark);
    if(stale==='scope')f.projects[bind.segmentId]='neosender';
    f.r.coldyGetPause_=()=>({retryAfterMs:120000});
    f.r.coldyGetBatch_=f.r.coldyRecipientSuppression_=()=>assert.fail('Never enter provider work from a stale hint');
    f.r.coldyLoad_=(_context,_kind,owner)=>{
      assert.notEqual(stale,'scope');assert.equal(owner,original);
      return {bindingRevision:stale==='revision'?bind.revision-1:bind.revision,scan:{phase:stale==='read'?'read':'write'}};
    };
    f.tick();
    assert.equal(f.data.get(key),oldMark);assert.deepEqual(f.writes,[]);assert.deepEqual(f.saves,[]);
  }
});
