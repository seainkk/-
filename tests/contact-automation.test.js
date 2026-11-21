import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const ROOT='registry_root_1234567890', HASH='H'.repeat(43);
function fixture(options={}) {
 const map=new Map([['ROOT_FOLDER_ID',ROOT],['HASH',HASH]]), calls={created:0,deleted:0,sync:[],continued:[],people:[],validation:[],lock:[],authorization:[],logs:[]};
 const properties={getProperty:k=>map.get(k)??null,setProperty:(k,v)=>map.set(k,v),deleteProperty:k=>map.delete(k)};
 const triggers=[];let uid=0;
 const context=vm.createContext({console:{warn(){},info(message){calls.logs.push(message)}},JSON,Object,Array,Number,String,Date,Math,Error,REGISTRY_CONFIG:{defaultRootFolderId:ROOT},SHARED_REQUEST_SCOPE_:{keyHash:HASH},
  PropertiesService:{getScriptProperties:()=>properties},Utilities:{getUuid:()=>`request-${++uid}`},
  LockService:{getScriptLock:()=>({tryLock(ms){calls.lock.push(ms);return !options.busy},releaseLock(){}})},
  ScriptApp:{AuthMode:{FULL:'FULL'},requireAllScopes(mode){calls.authorization.push(mode);if(options.partialConsent)throw Error('Authorization is required')},getProjectTriggers(){if(options.noConsent)throw Error('private owner token must never leak');return triggers;},newTrigger(name){return{timeBased(){return this},everyMinutes(n){assert.equal(n,5);return this},create(){calls.created++;const triggerId=`trigger-${++uid}`;const t={getUniqueId:()=>triggerId,getHandlerFunction:()=>name};triggers.push(t);return t}}},deleteTrigger(t){calls.deleted++;if(options.deleteFails)throw Error('private');triggers.splice(triggers.indexOf(t),1)}}});
 context.api_=fn=>fn();context.object_=v=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('INVALID_REQUEST');return v};context.fail_=(c,m)=>{const e=new Error(`[${c}] ${m}`);e.registryCode=c;throw e};
 context.sharedConfiguredHash_=()=>map.get('HASH');
 context.authorize_=()=>{if(context.SHARED_REQUEST_SCOPE_?.keyHash!==map.get('HASH'))context.fail_('LINK_ACCESS_REQUIRED','No access');return{rootId:map.get('ROOT_FOLDER_ID'),properties}};
 context.registryRoot_=()=>({getId:()=>ROOT});
 context.listContactWorkspacesForAutomation_=()=>({items:options.items||[],nextCursor:''});
 context.getContactWorkspace_=({id})=>({job:options.pending?.[id]||null,segmentId:options.segmentIds?.[id]||null,shouldSync:options.unchanged?false:undefined});
 context.segmentRecordsActiveJob_=(_,id)=>options.activeSegments?.includes(id)?{id:'active-segment-job'}:null;
 context.syncWorkbookContacts_=req=>{calls.sync.push(req);if(options.revoke){map.set('HASH','Z'.repeat(43));context.authorize_()}if(options.failId===req.id)context.fail_('OUTSIDE_REGISTRY','private contact@example.test');return options.processing?{state:'processing',jobId:'job',requestId:req.requestId}:{state:'complete'}};
 context.continueContactSync_=req=>{calls.continued.push(req);return{state:options.continueForever?'processing':'complete',jobId:req.jobId,requestId:req.requestId}};
 context.syncSegmentPeople_=req=>{calls.people.push(req);return options.peopleProcessing?{state:'processing',segmentId:'segment',jobId:'people-job',requestId:'people-request'}:{state:'complete'}};context.continueSegmentRecords_=req=>{calls.people.push(req);return{state:options.peopleForever?'processing':'complete'}};
 context.processWorkbookValidation_=(_,id)=>calls.validation.push(id);
 vm.runInContext(readFileSync(new URL('../src/ContactAutomation.gs',import.meta.url),'utf8'),context);
 const enable=()=>context.enableContactAutomation_({});
 const tick=()=>context.contactAutomationTick_({triggerUid:map.get('CONTACT_AUTOMATION_TRIGGER')});
 return{context,map,calls,triggers,enable,tick,options};
}
test('one owner timer covers all workbooks and re-enabling creates no duplicate trigger',()=>{const f=fixture();assert.equal(f.enable().installed,true);assert.equal(f.enable().installed,true);assert.equal(f.calls.created,1);assert.equal(f.map.get('CONTACT_AUTOMATION_VERIFIER'),HASH)});
test('missing owner consent never pretends background processing is active or echoes the error',()=>{const f=fixture({noConsent:true});const s=f.enable();assert.equal(s.installed,false);assert.equal(s.needsOwnerSetup,true);assert.equal(JSON.stringify(s).includes('private owner'),false)});
test('forged trigger IDs, rotated keys and another root cannot enter owner scope',()=>{const f=fixture({items:[{id:'book'}]});f.enable();assert.equal(f.context.contactAutomationTick_({triggerUid:'forged'}),null);f.map.set('HASH','Z'.repeat(43));assert.equal(f.tick(),null);f.map.set('HASH',HASH);f.map.set('ROOT_FOLDER_ID','another_root_1234567890');assert.equal(f.tick(),null);assert.equal(f.calls.sync.length,0)});
test('timer restores previous access scope and uses one bounded lease',()=>{const f=fixture({items:[{id:'book'}]});f.enable();const old={keyHash:'not-public',tag:true};f.context.SHARED_REQUEST_SCOPE_=old;assert.equal(f.tick().processed,1);assert.equal(f.context.SHARED_REQUEST_SCOPE_,old);assert.equal(f.map.has('CONTACT_AUTOMATION_LEASE'),false);assert.equal(f.calls.lock[0],100)});
test('pending work resumes with its exact original request ID before validation',()=>{const f=fixture({items:[{id:'book'}],pending:{book:{jobId:'existing-job',requestId:'same-request'}}});f.enable();f.tick();assert.equal(f.calls.sync.length,0);assert.equal(f.calls.continued[0].requestId,'same-request');assert.deepEqual(f.calls.validation,['book'])});
test('company master transfers people before contact synchronization',()=>{const f=fixture({items:[{id:'companies',role:'segment-companies'}]});f.enable();f.tick();assert.equal(f.calls.people[0].companyFileId,'companies');assert.equal(f.calls.sync[0].id,'companies')});
test('a changed or inaccessible workbook does not block other enrolled books or leak data',()=>{const f=fixture({items:[{id:'bad'},{id:'good'}],failId:'bad'});f.enable();f.tick();assert.equal(f.calls.sync.length,2);assert.deepEqual(f.calls.validation,['good']);assert.equal(f.map.get('CONTACT_AUTOMATION_LAST_ERROR'),'OUTSIDE_REGISTRY');assert.equal(JSON.stringify([...f.map]).includes('contact@example.test'),false)});
test('unfinished synchronization is retained and never starts paid validation',()=>{const f=fixture({items:[{id:'book'}],processing:true,continueForever:true});f.enable();const r=f.tick();assert.equal(r.pending,1);assert.equal(f.calls.validation.length,0);assert.equal(f.calls.continued.length,5)});
test('disabling marker prevents background work even if Google trigger deletion fails',()=>{const f=fixture({items:[{id:'book'}],deleteFails:true});f.enable();const uid=f.map.get('CONTACT_AUTOMATION_TRIGGER');assert.equal(f.context.disableContactAutomation_({}).installed,false);assert.equal(f.context.contactAutomationTick_({triggerUid:uid}),null);assert.equal(f.calls.sync.length,0)});
test('busy lock skips this tick without acquiring workbook or provider data',()=>{const f=fixture({items:[{id:'book'}]});f.enable();f.options.busy=true;assert.equal(f.tick().skipped,'busy');assert.equal(f.calls.sync.length,0);assert.equal(f.calls.validation.length,0)});
test('mid-run key revocation stops subsequent books and clears the owner scope and lease',()=>{const f=fixture({items:[{id:'one'},{id:'two'}],revoke:true});f.enable();const previous=f.context.SHARED_REQUEST_SCOPE_;assert.throws(()=>f.tick(),/LINK_ACCESS_REQUIRED/);assert.equal(f.calls.sync.length,1);assert.equal(f.context.SHARED_REQUEST_SCOPE_,previous);assert.equal(f.map.has('CONTACT_AUTOMATION_LEASE'),false)});
test('editor setup is private and empty requests are required for automation APIs',()=>{const f=fixture();assert.throws(()=>f.context.enableContactAutomation_({other:true}),/INVALID_REQUEST/);f.context.SHARED_REQUEST_SCOPE_=null;assert.equal(f.context.setupContactAutomation_().installed,true);assert.equal(f.context.SHARED_REQUEST_SCOPE_,null)});

test('visible authorization launcher has no application effects even without shared access',()=>{
 const f=fixture(),before=[...f.map];
 for(const scope of [null,{keyHash:'invalid'}]){
  f.context.SHARED_REQUEST_SCOPE_=scope;
  assert.equal(f.context.authorizeGoogleAccess(),undefined);
  assert.equal(f.context.SHARED_REQUEST_SCOPE_,scope);
 }
 assert.deepEqual(f.calls.authorization,['FULL','FULL']);assert.deepEqual([...f.map],before);
 assert.equal(f.calls.created,0);assert.equal(f.calls.deleted,0);assert.equal(f.triggers.length,0);
 assert.equal(f.calls.sync.length,0);assert.equal(f.calls.validation.length,0);
 assert.equal(f.calls.logs.length,2);assert.ok(f.calls.logs.every(message=>!message.includes(HASH)&&!message.includes(ROOT)));
});

test('partial Google consent stops the launcher before reporting success or changing state',()=>{
 const f=fixture({partialConsent:true}),before=[...f.map];f.context.SHARED_REQUEST_SCOPE_=null;
 assert.throws(()=>f.context.authorizeGoogleAccess(),/Authorization is required/);
 assert.deepEqual(f.calls.authorization,['FULL']);assert.equal(f.calls.logs.length,0);
 assert.deepEqual([...f.map],before);assert.equal(f.context.SHARED_REQUEST_SCOPE_,null);
 assert.equal(f.calls.created,0);assert.equal(f.calls.sync.length,0);assert.equal(f.calls.validation.length,0);
});

test('setup instructions point to the visible authorization function without installing the timer',()=>{
 const f=fixture(),state=f.context.getContactAutomationState_({});
 assert.equal(state.setupFunction,'authorizeGoogleAccess');assert.equal(state.setupFunction.endsWith('_'),false);
 assert.equal(typeof f.context[state.setupFunction],'function');assert.equal(state.installed,false);
 f.context[state.setupFunction]();assert.equal(f.context.getContactAutomationState_({}).installed,false);
 assert.equal(f.calls.created,0);
});

test('pending LPR transfer resumes its original job before any contact list writes',()=>{const f=fixture({items:[{id:'companies',role:'segment-companies'}],peopleProcessing:true});f.enable();f.tick();assert.equal(f.calls.people[1].requestId,'people-request');assert.equal(f.calls.people[1].jobId,'people-job');assert.equal(f.calls.sync.length,1)});
test('unfinished LPR transfer keeps the workbook queued and does not validate contacts',()=>{const f=fixture({items:[{id:'companies',role:'segment-companies'}],peopleProcessing:true,peopleForever:true});f.enable();assert.equal(f.tick().pending,1);assert.equal(f.calls.sync.length,0);assert.equal(f.calls.validation.length,0)});
test('unchanged sources skip extraction but continue an existing validation workflow',()=>{const f=fixture({items:[{id:'book'}],unchanged:true});f.enable();f.tick();assert.equal(f.calls.sync.length,0);assert.deepEqual(f.calls.validation,['book'])});
test('an unchanged company master does not replan people or write contact lists on every timer tick',()=>{const f=fixture({items:[{id:'companies',role:'segment-companies'}],unchanged:true});f.enable();assert.equal(f.tick().processed,1);assert.equal(f.calls.people.length,0);assert.equal(f.calls.sync.length,0);assert.deepEqual(f.calls.validation,['companies'])});
test('a pending contact receipt still resumes even when the last source version is unchanged',()=>{const f=fixture({items:[{id:'companies',role:'segment-companies'}],unchanged:true,pending:{companies:{jobId:'pending-contact',requestId:'original-receipt'}}});f.enable();f.tick();assert.equal(f.calls.people.length,0);assert.equal(f.calls.continued[0].requestId,'original-receipt');assert.equal(f.calls.sync.length,0)});
test('an interrupted LPR-only segment import resumes even if its company master has not changed',()=>{const f=fixture({items:[{id:'companies',role:'segment-companies'}],unchanged:true,segmentIds:{companies:'segment'},activeSegments:['segment']});f.enable();assert.equal(f.tick().processed,1);assert.equal(f.calls.people[0].companyFileId,'companies');assert.equal(f.calls.sync.length,0);assert.deepEqual(f.calls.validation,['companies'])});

test('provider failure does not block other approved provider work for the same workbook',()=>{
 const f=fixture({items:[{id:'book'}],unchanged:true}), steps=[];
 f.context.processWorkbookValidation_=()=>f.context.fail_('PV_OWNER_AUTH_REQUIRED','private');
 f.context.processColdyWorkbookValidation_=(_,id)=>steps.push(['validation',id]);
 f.context.processColdyCampaignUploads_=(_,item)=>steps.push(['upload',item.id]);
 f.enable();assert.equal(f.tick().processed,1);assert.deepEqual(steps,[['validation','book'],['upload','book']]);
 assert.equal(f.map.get('CONTACT_AUTOMATION_LAST_ERROR'),'PV_OWNER_AUTH_REQUIRED');
});
test('provider-side access revocation stops later providers and workbooks',()=>{
 const f=fixture({items:[{id:'first'},{id:'second'}],unchanged:true}), steps=[];
 f.context.processWorkbookValidation_=()=>{f.map.set('HASH','Z'.repeat(43));f.context.authorize_()};
 f.context.processColdyWorkbookValidation_=()=>steps.push('must not run');
 f.enable();assert.throws(()=>f.tick(),/LINK_ACCESS_REQUIRED/);assert.deepEqual(steps,[]);
 assert.equal(f.map.has('CONTACT_AUTOMATION_LEASE'),false);
});
