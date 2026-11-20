import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

function fixture(initial={}) {
 const properties=new Map(Object.entries(initial));let locked=false;
 const context={rootId:'policy_registry_root_12345',properties:{getProperty:key=>properties.get(key)??null,setProperty:(key,value)=>properties.set(key,value),deleteProperty:key=>properties.delete(key)}};
 const c=vm.createContext({Date,JSON,Math,Number,Array,console:{warn(){}},
  authorize_:()=>context,api_:fn=>fn(),object_:value=>value,digest_:value=>crypto.createHash('sha256').update(String(value)).digest('base64url'),
  fail_:(code,message)=>{throw Object.assign(new Error(`[${code}] ${message}`),{registryCode:code});},
  locked_:fn=>{assert.equal(locked,false);locked=true;try{return fn();}finally{locked=false;}},
  Drive:{Files:{get(){throw new Error('Provider selection must not inspect Drive or contact data');}}},
  UrlFetchApp:{fetch(){throw new Error('Provider selection must never send or charge');}},
 });
 for(const file of ['ValidationPolicy.gs','Promouser.gs','Coldy.gs','ColdyValidation.gs'])vm.runInContext(readFileSync(new URL('../src/'+file,import.meta.url),'utf8'),c);
 return{c,context,properties};
}

test('adding a Coldy key keeps the existing email provider until an explicit selection',()=>{
 const f=fixture({PROMOUSER_API_KEY:'pv-fixture',PROMOUSER_ENABLED:'true'});
 f.c.configureColdy_({apiKey:'coldy-fixture'});
 const settings=f.c.coldySettings_(f.context);
 assert.equal(settings.configured,true);
 assert.equal(f.c.emailValidationProvider_(f.context),'promouser');
 assert.equal(f.c.pvEmailPreferred_(f.context),'promouser');
 assert.equal(f.c.cvPreferred_(f.context,settings),false);
});

test('removing the selected Coldy key pauses email validation without switching to a paid fallback',()=>{
 const f=fixture({PROMOUSER_API_KEY:'pv-fixture',PROMOUSER_ENABLED:'true'});
 f.c.configureColdy_({apiKey:'coldy-fixture',emailValidationProvider:'coldy'});
 f.c.configureColdy_({clearKey:true});
 const settings=f.c.coldySettings_(f.context);
 assert.equal(settings.configured,false);
 assert.equal(settings.emailValidationProvider,'coldy');
 assert.equal(f.c.pvEmailPreferred_(f.context),'coldy');
 assert.equal(f.c.cvPreferred_(f.context,settings),true);
 assert.equal(f.c.pvSettings_(f.context).enabled,true,'Existing phone service remains configured independently');
});

test('invalid provider configuration fails closed in both integration modules before network or Drive access',()=>{
 for(const value of ['Coldy','unknown',' promouser ','false','null']) {
  const f=fixture({EMAIL_VALIDATION_PROVIDER:value,COLDY_API_KEY:'coldy-fixture',PROMOUSER_API_KEY:'pv-fixture'});
  for(const action of [()=>f.c.emailValidationProvider_(f.context),()=>f.c.pvEmailPreferred_(f.context),()=>f.c.coldySettings_(f.context),()=>f.c.cvPreferred_(f.context,{emailValidationProvider:'coldy'})])assert.throws(action,/VALIDATION_PROVIDER_INVALID/);
 }
});

test('switching providers cancels only unsent email jobs and releases only their own reservation',()=>{
 const f=fixture({EMAIL_VALIDATION_PROVIDER:'coldy'}), state={fileId:'policy_workbook_12345',jobs:[
  {jobId:'unsent',kind:'email',state:'queued',contacts:[{key:'one'},{key:'foreign'}]},
  {jobId:'submitted',kind:'email',state:'awaiting_quote',orderId:'123',contacts:[{key:'two'}]},
  {jobId:'phone',kind:'telegram',state:'queued',contacts:[{key:'three'}]},
  {jobId:'uncertain',kind:'email',state:'creation_uncertain',contacts:[{key:'four'}]},
 ]}, cache={writes:{}}, map={
  one:{row:2,pending:{fileId:state.fileId,jobId:'unsent'}},
  foreign:{row:3,pending:{fileId:'another_workbook_12345',jobId:'another-job'}},
 };
 f.c.pvCancelUnsent_(f.context,state,cache,map,null);
 assert.equal(state.jobs[0].state,'cancelled');
 assert.equal(state.jobs[1].state,'awaiting_quote');
 assert.equal(state.jobs[2].state,'queued');
 assert.equal(state.jobs[3].state,'creation_uncertain');
 assert.equal(map.one,undefined);
 assert.ok(map.foreign.pending);
 assert.equal(Object.keys(cache.writes).length,1);
});

test('provider switching does not cancel or release a job with an active global lease',()=>{
 const f=fixture({EMAIL_VALIDATION_PROVIDER:'coldy'}), state={fileId:'policy_workbook_12345',lease:{token:'active-dispatch',until:Date.now()+60000},jobs:[{jobId:'queued',kind:'email',state:'queued',contacts:[{key:'email'}]}]},cache={writes:{}},map={email:{row:2,pending:{fileId:state.fileId,jobId:'queued'}}};
 f.c.pvCancelUnsent_(f.context,state,cache,map,null);
 assert.equal(state.jobs[0].state,'queued');
 assert.ok(map.email.pending);
 assert.equal(Object.keys(cache.writes).length,0);
});

test('source-created jobs cannot start through the scheduler until approved after preview',()=>{
 const f=fixture(), job={jobId:'queued',kind:'telegram',state:'queued',manualStartApproved:false,contacts:[{key:'phone'}]}, state={jobs:[job]};
 const settings={key:'pv-fixture',enabled:true,autoPayLimitUsd:5};
 assert.equal(f.c.pvChoose_(state,settings,{},Date.now()),null);
 assert.equal(f.c.pvAutomaticHint_(state,settings).canAutoAdvance,false);
 job.manualStartApproved=true;
 assert.equal(f.c.pvChoose_(state,settings,{},Date.now()),job);
 assert.equal(f.c.pvAutomaticHint_(state,settings).canAutoAdvance,true);
});
