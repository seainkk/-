import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const ROOT='coldy_registry_root_123456', KEY='coldy_fixture_secret_NEVER_IN_RESPONSE', CAMPAIGN='237056d1-20b1-41ab-aa0e-17965cecbe14';
const plain=value=>JSON.parse(JSON.stringify(value));

test('sender inventory permits only exact read-only accounts routes without parameters',()=>{
  const f=fixture();
  for(const path of ['/accounts','/accounts/1','/accounts/9723','/accounts/9007199254740991'])assert.equal(f.c.coldyPath_('GET',path),path);
  for(const path of ['/accounts/0','/accounts/01','/accounts/-1','/accounts/1.5','/accounts/9007199254740992','/accounts/1/tokens','/accounts/1/','/accounts/1/password','/accounts/1?status=Connected','/accounts?limit=100','/accounts/1?fields=password','/accounts/%31','/accounts/../campaigns'])assert.throws(()=>f.c.coldyPath_('GET',path),/INVALID_REQUEST/);
  for(const method of ['POST','PATCH','DELETE'])for(const path of ['/accounts','/accounts/1'])assert.throws(()=>f.c.coldyPath_(method,path),/INVALID_REQUEST/);
  assert.equal(f.calls.fetch.length,0);
});

test('connection saves report credential rotation without treating same-key settings as a new account',()=>{
  const f=fixture();
  assert.equal(f.configure().credentialChanged,true);
  assert.equal(f.configure().credentialChanged,false);
  assert.equal(f.c.configureColdy_({emailValidationProvider:'coldy'}).credentialChanged,false);
  assert.equal(f.c.configureColdy_({clearKey:true}).credentialChanged,true);
  assert.equal(f.c.configureColdy_({clearKey:true}).credentialChanged,false);
  assert.equal(f.calls.fetch.length,0);
});

test('campaign catalog reads use the current project even for an existing provider cache',()=>{
  const extra='710f6f14-1f31-4571-9ca3-d3ec89ba22aa';
  const f=fixture({transport:({response})=>response({items:[{id:CAMPAIGN,name:'Закреплена',status:'Active'},{id:extra,name:'Общая',status:'Draft'}]})});
  f.configure();
  let project='numshield';
  f.c.registryProjectScoped_=()=>true;f.c.registryProjectId_=()=>project;
  f.c.registrySegmentProject_=()=> 'neosender';
  f.c.coldyCampaignId_=id=>id.toLowerCase();
  f.context.properties.getProperties=()=>({});
  f.c.coldyCampaignRegistry_=()=>({credentialHash:f.c.coldyCredentialHash_(f.context),bindings:[{segmentId:'foreign_segment',campaignId:CAMPAIGN}]});
  for(const refresh of [false,true]) assert.deepEqual(plain(f.c.listColdyCampaigns_({refresh})).campaigns.map(item=>item.id),[extra]);
  project='neosender';
  const own=plain(f.c.listColdyCampaigns_({}));assert.equal(own.cached,true);assert.deepEqual(own.campaigns.map(item=>item.id),[CAMPAIGN,extra]);
});



function fixture(options={}) {
  let now=1795089600000, seq=0, locked=false, rootId=ROOT, authorized=true;
  const files=new Map([[ROOT,{id:ROOT,mimeType:'application/vnd.google-apps.folder',parents:['owner_drive_123456'],appProperties:{}}]]), properties=new Map(), calls={fetch:[],creates:[],updates:[],driveReads:[],locks:0};
  const props={getProperty:key=>properties.get(key)??null,setProperty:(key,value)=>properties.set(key,String(value)),deleteProperty:key=>properties.delete(key)};
  const context={rootId:ROOT,properties:props};
  class Clock extends Date { constructor(...args){super(...(args.length?args:[now]));} static now(){return now;} }
  function coded(code,message){const e=new Error(`[${code}] ${message}`);e.registryCode=code;return e;}
  const response=(body,status=200,headers={})=>({getResponseCode:()=>status,getContentText:()=>typeof body==='string'?body:JSON.stringify(body),getAllHeaders:()=>headers});
  const c=vm.createContext({Date:Clock,Math,Number,JSON,Array,Object,
    api_:fn=>fn(),object_:v=>{if(!v||typeof v!=='object'||Array.isArray(v))throw coded('INVALID_REQUEST','Object required');return v;},
    id_:v=>{if(typeof v!=='string'||!/^[A-Za-z0-9_-]{10,200}$/.test(v))throw coded('INVALID_ID','id');return v;},
    fail_:(code,message)=>{throw coded(code,message);},registryError_:coded,
    digest_:v=>crypto.createHash('sha256').update(String(v)).digest('base64url'),
    authorize_:()=>{if(!authorized)throw coded('LINK_ACCESS_REQUIRED','Access revoked');return{rootId,properties:props};},
    locked_:fn=>{assert.equal(locked,false,'No nested operation locks');locked=true;calls.locks++;try{return fn();}finally{locked=false;}},
    Utilities:{newBlob:(text,mime,name)=>({text,mime,name}),getUuid:()=>crypto.randomUUID()},
    DriveApp:{getFileById:id=>({getBlob:()=>({getDataAsString:()=>{calls.driveReads.push(['blob',id]);return files.get(id).body;}})})},
    Drive:{Files:{
      get:id=>{calls.driveReads.push(['get',id]);if(!files.has(id))throw new Error('Missing '+KEY);return plain(files.get(id));},
      list:({q})=>{
        calls.driveReads.push(['list']);
        const parent=q.match(/'([^']+)' in parents/)?.[1],tags=[...q.matchAll(/key='([^']+)' and value='([^']+)'/g)].map(m=>[m[1],m[2]]);
        return{files:[...files.values()].filter(f=>!f.trashed&&(!parent||f.parents?.includes(parent))&&tags.every(([k,v])=>f.appProperties?.[k]===v)).map(plain),...(options.listPageToken?{nextPageToken:'more'}:{})};
      },
      create:(meta,blob)=>{
        assert.ok(locked,'Durable state creates must hold caller lock');
        if(options.beforeCreate)options.beforeCreate({meta,files});
        const id=`coldy_state_${++seq}_123456`, file={...plain(meta),id,body:blob?.text||'',version:'1'};files.set(id,file);calls.creates.push(id);
        if(options.loseFolderAck&&meta.mimeType==='application/vnd.google-apps.folder'||options.loseJsonAck&&meta.mimeType==='application/json')throw new Error('Lost create acknowledgement '+KEY);
        return plain(file);
      },
      update:(meta,id,blob)=>{
        assert.ok(locked,'Durable state updates must hold caller lock');
        const file=files.get(id);if(options.failUpdateBefore)throw new Error('Rejected write '+KEY);
        Object.assign(file,plain(meta));if(blob)file.body=blob.text;file.version=String(Number(file.version||0)+1);calls.updates.push(id);
        if(options.loseUpdateAck)throw new Error('Lost update acknowledgement '+KEY);return plain(file);
      }
    }},
    UrlFetchApp:{fetch:(url,request)=>{
      assert.equal(locked,false,'Provider HTTP must be outside global lock');assert.equal(request.followRedirects,false);calls.fetch.push({url,request:plain(request)});
      if(options.transport)return options.transport({url,request,response,calls,properties,files});
      if(url.endsWith('/leads/reply-tags'))return response([{id:12,name:KEY}]);
      return response({items:[{id:CAMPAIGN,name:'Кухни',status:'Draft',private_provider_data:KEY}]});
    }}
  });
  vm.runInContext(readFileSync(new URL('../src/Coldy.gs',import.meta.url),'utf8'),c);
  const configure=(extra={})=>c.configureColdy_({apiKey:KEY,...extra});
  const withLock=fn=>c.locked_(fn);
  const save=(kind,owner,data)=>withLock(()=>c.coldySave_(context,kind,owner,data));
  const load=(kind,owner)=>withLock(()=>c.coldyLoad_(context,kind,owner));
  return {c,context,properties,files,calls,configure,response,save,load,withLock,tick:ms=>{now+=ms;},revoke:()=>{authorized=false;},switchRoot:id=>{rootId=id;},now:()=>now};
}

test('Coldy is unconfigured with Promouser preference and manual-only validation by default',()=>{
  const f=fixture(),settings=plain(f.c.getColdySettings_({}));
  assert.deepEqual(settings,{configured:false,connected:false,emailValidationProvider:'promouser',autoValidateEmails:false,manualValidation:true,checkedAt:''});
  assert.equal(f.c.listColdyCampaigns_({}).state,'not_configured');assert.equal(f.calls.fetch.length,0);assert.equal(f.calls.creates.length,0);
});

test('key is write-only, blank password retains it, malformed settings do not mutate',()=>{
  const f=fixture();const result=f.configure();assert.equal(result.configured,true);assert.equal(JSON.stringify(result).includes(KEY),false);assert.equal(JSON.stringify(result).includes(f.c.digest_(KEY)),false);
  f.c.configureColdy_({apiKey:''});assert.equal(f.properties.get('COLDY_API_KEY'),KEY);
  for(const input of [{apiKey:'bad\nkey'},{apiKey:'bad key'},{clearKey:'true'},{apiKey:2},{autoValidateEmails:1},{emailValidationProvider:'unknown'},{unknown:true},{apiKey:KEY,clearKey:true}]){
    assert.throws(()=>f.c.configureColdy_(input),/INVALID_REQUEST/);assert.equal(f.properties.get('COLDY_API_KEY'),KEY);
  }
});

test('manual-only policy rejects automatic spending even with a credit acknowledgement',()=>{
  const f=fixture();f.configure({emailValidationProvider:'coldy'});
  assert.throws(()=>f.c.configureColdy_({autoValidateEmails:true,acceptValidationCredits:true}),/COLDY_MANUAL_VALIDATION/);
  f.properties.set('COLDY_AUTO_VALIDATE_EMAILS','true');assert.equal(f.c.getColdySettings_({}).autoValidateEmails,false);
  assert.equal(f.c.configureColdy_({autoValidateEmails:false}).manualValidation,true);
});

test('removing Coldy key pauses its selected provider and never silently activates Promouser',()=>{
  const f=fixture();assert.throws(()=>f.c.configureColdy_({emailValidationProvider:'coldy'}),/COLDY_KEY_REQUIRED/);
  f.configure({emailValidationProvider:'coldy'});const result=f.c.configureColdy_({clearKey:true});
  assert.equal(result.configured,false);assert.equal(result.connected,false);assert.equal(result.emailValidationProvider,'coldy');assert.equal(result.autoValidateEmails,false);
  assert.equal(f.c.configureColdy_({clearKey:true,emailValidationProvider:'coldy'}).emailValidationProvider,'coldy');
  assert.equal(f.c.configureColdy_({emailValidationProvider:'promouser'}).emailValidationProvider,'promouser');
});

test('connection check makes one small authenticated read without loading the campaign catalog or saving the tags',()=>{
  const f=fixture();f.configure();const result=f.c.testColdyConnection_({});
  assert.deepEqual(Object.keys(result).sort(),['checkedAt','connected']);assert.equal(result.connected,true);assert.equal(f.c.getColdySettings_({}).connected,true);
  assert.equal(f.calls.fetch.length,1);const call=f.calls.fetch[0];assert.equal(call.url,'https://developer.coldy.ai/api/v1/leads/reply-tags');assert.equal(call.request.method,'get');assert.equal(call.request.headers.Authorization,`Bearer ${KEY}`);assert.equal(call.url.includes(KEY),false);assert.equal(call.request.payload,undefined);
  assert.equal(f.calls.creates.length+f.calls.updates.length,0);
  assert.ok(!JSON.stringify(result).includes(KEY));assert.equal(f.c.coldyCachedCampaigns_(f.context),null);
  assert.throws(()=>f.c.coldyPath_('GET','/leads/reply-tags?limit=5'),/INVALID_REQUEST/);
  assert.throws(()=>f.c.coldyPath_('POST','/leads/reply-tags'),/INVALID_REQUEST/);
  for(const body of [[{id:0}],{items:null},{}]){
    const bad=fixture({transport:({response})=>response(body)});bad.configure();assert.throws(()=>bad.c.testColdyConnection_({}),/COLDY_RESPONSE/);assert.equal(bad.c.getColdySettings_({}).connected,false);
  }
});

test('credential rotation cannot return metadata cached under a previous organization',()=>{
  const f=fixture();f.configure();f.c.listColdyCampaigns_({});const first=plain(f.c.coldyCachedCampaigns_(f.context));assert.ok(first);
  const settings=f.c.configureColdy_({apiKey:'second_organization_fixture_secret'});assert.equal(settings.connected,false);assert.equal(f.c.coldyCachedCampaigns_(f.context),null);
  f.c.listColdyCampaigns_({});assert.equal(f.calls.fetch.length,2);assert.equal(f.calls.fetch[1].request.headers.Authorization,'Bearer second_organization_fixture_secret');
  assert.equal(f.c.getColdySettings_({}).connected,true);
});

test('settings can verify Coldy before any mailbox read and reuse only a fresh, current-key receipt',()=>{
  let reject=false;
  const f=fixture({transport:({response})=>response(reject?{}:[],reject?401:200)});
  vm.runInContext(readFileSync(new URL('../src/ServiceSettings.gs',import.meta.url),'utf8'),f.c);
  f.c.registryProjectId_=()=>'numshield';
  f.c.coldyServiceLimits_=()=>assert.fail('The status check must not wait for selected mailbox limits');
  const check=()=>f.c.getServiceLimits_({provider:'coldy',connectionOnly:true});
  assert.equal(check().configured,false);assert.equal(f.calls.fetch.length,0);
  f.configure();const first=check();assert.equal(first.active,true);assert.deepEqual(plain(first.items),[]);
  assert.equal(check().checkedAt,first.checkedAt);assert.equal(f.calls.fetch.length,1);
  f.tick(45001);assert.notEqual(check().checkedAt,first.checkedAt);assert.equal(f.calls.fetch.length,2);
  reject=true;f.c.configureColdy_({apiKey:'new_synthetic_key'});assert.equal(check().active,false);assert.equal(f.calls.fetch.length,3);
  assert.equal(f.c.getColdySettings_({}).connected,false);
});

test('a live connection survives contention on the quota lock and reports the actual observation time',()=>{
  const f=fixture();f.configure();
  vm.runInContext(readFileSync(new URL('../src/ServiceSettings.gs',import.meta.url),'utf8'),f.c);
  f.c.registryProjectId_=()=>'numshield';
  const busy=()=>{throw Object.assign(new Error('Busy'),{registryCode:'BUSY'});};
  f.c.locked_=busy;f.c.coldyServiceLimits_=busy;
  const read=connectionOnly=>f.c.getServiceLimits_(connectionOnly?{provider:'coldy',connectionOnly:true}:{provider:'coldy'});
  const observed=read(true);assert.equal(observed.active,true);f.tick(2200);
  const waiting=read(false);
  assert.equal(waiting.active,true);assert.equal(waiting.checkedAt,observed.checkedAt);
  assert.equal(waiting.pending,true);assert.equal(waiting.busy,true);assert.equal(waiting.retryAfterMs,5000);
  assert.match(waiting.message,/дневные лимиты/);assert.deepEqual(plain(waiting.items),[]);assert.equal(f.calls.fetch.length,1);
});

test('an overlapping 401 invalidates older successful observations and a later real verification can recover',()=>{
  let reject=false,overlap=false;
  const f=fixture({transport:({response})=>{
    if(overlap){overlap=false;reject=true;assert.throws(()=>f.c.testColdyConnection_({}),/COLDY_AUTH/);reject=false;}
    return response(reject?{}:[],reject?401:200);
  }});
  f.configure();f.c.testColdyConnection_({});overlap=true;
  assert.throws(()=>f.c.testColdyConnection_({}),/COLDY_AUTH/);
  assert.equal(f.c.getColdySettings_({}).connected,false);
  assert.equal(f.c.testColdyConnection_({}).connected,true);
  assert.equal(f.c.getColdySettings_({}).connected,true);
});

test('removing and re-adding the same key fences older successes and late 401s from the new connection',()=>{
  for(const status of [200,401]){
    let replace=false;
    const f=fixture({transport:({response})=>{
      if(replace){replace=false;f.c.configureColdy_({clearKey:true});f.configure();f.c.testColdyConnection_({});return response([],status);}
      return response([]);
    }});
    f.configure();replace=true;
    assert.throws(()=>f.c.testColdyConnection_({}),status===401?/COLDY_AUTH/:/COLDY_CREDENTIAL_CHANGED/);
    assert.equal(f.c.getColdySettings_({}).connected,true);
  }
});

test('an organization key changed during a request never records that response as the new connection',()=>{
  const f=fixture({transport:({response,properties})=>{properties.set('COLDY_API_KEY','rotated_during_response');return response([]);}});f.configure();
  assert.throws(()=>f.c.testColdyConnection_({}),/COLDY_CREDENTIAL_CHANGED/);assert.equal(f.c.getColdySettings_({}).connected,false);assert.equal(f.calls.creates.length,0);
});

test('expired campaign cache refreshes once; explicit refresh bypasses a fresh cache',()=>{
  const f=fixture();f.configure();f.c.listColdyCampaigns_({});assert.equal(f.calls.fetch.length,1);f.tick(300001);assert.equal(f.c.listColdyCampaigns_({}).cached,false);assert.equal(f.calls.fetch.length,2);
  f.c.listColdyCampaigns_({refresh:true});assert.equal(f.calls.fetch.length,3);
});

test('malformed campaign metadata is not stored as a successful connection',()=>{
  for(const body of [{items:[{id:'bad-id',name:'X',status:'Draft'}]},{items:[{id:CAMPAIGN,name:'X',status:'Draft'},{id:CAMPAIGN,name:'Y',status:'Draft'}]},{items:null}]){
    const f=fixture({transport:({response})=>response(body)});f.configure();assert.throws(()=>f.c.listColdyCampaigns_({}),/COLDY_RESPONSE/);assert.equal(f.c.getColdySettings_({}).connected,false);assert.equal(f.calls.creates.length,0);
  }
});

test('API route allowlist rejects arbitrary hosts, mutations, redirects, path traversal and injected queries',()=>{
  const f=fixture();f.configure();
  for(const [method,path] of [
    ['GET','https://evil.test/campaigns'],['GET','//evil.test/campaigns'],['GET','/campaigns#token'],['GET','/campaigns?api_key=anything'],['GET','/campaigns/../billing'],['GET','/campaigns/%2e%2e'],['GET','/campaigns\\evil'],['POST',`/campaigns/${CAMPAIGN}/activate`],['POST',`/campaigns/${CAMPAIGN}/pause`],['DELETE','/leads'],['POST','/leads'],['POST','/leads/verification/start'],['GET',`/leads/campaign/${CAMPAIGN}?limit=201`],['GET',`/leads/campaign/${CAMPAIGN}?search=a&search=b`],['GET',`/leads/campaign/${CAMPAIGN}?offset=-1`],['GET',`/analytics/campaigns/${CAMPAIGN}/summary?period=forever`],['GET',`/analytics/campaigns/${CAMPAIGN}/summary?type=other`],['GET',`/campaigns/${CAMPAIGN}?authuser=0`]
  ])assert.throws(()=>f.c.coldyApi_(f.context,method,path),/INVALID_REQUEST/,path);
  assert.equal(f.calls.fetch.length,0);
});

test('API reads accept only the documented campaign, analytics, lead page and verification routes',()=>{
  const f=fixture({transport:({response})=>response({ok:true})});f.configure();
  for(const path of [`/campaigns/${CAMPAIGN}`,`/analytics/campaigns/${CAMPAIGN}/summary?period=all&type=event`,`/leads/campaign/${CAMPAIGN}?after_id=100&limit=200&search=Alice%40Example.test`,'/email-verifications/batch_123','/email-verifications/batch_123/results'])assert.equal(f.c.coldyApi_(f.context,'GET',path).ok,true);
  assert.equal(f.calls.fetch.length,5);assert.ok(f.calls.fetch.every(call=>call.url.startsWith('https://developer.coldy.ai/api/v1/')));
  assert.throws(()=>f.c.coldyApi_(f.context,'GET','/campaigns',{private:'body'}),/INVALID_REQUEST/);
});

test('bulk upload enforces bounded canonical new contacts and all three protections',()=>{
  const f=fixture({transport:({response})=>response({created:1,skipped:0,leads:[],skipped_items:[]},201)});f.configure();
  f.c.coldyApi_(f.context,'POST','/leads/bulk',{campaign:CAMPAIGN,items:[{email:' ALICE@Example.test ',first_name:'Alice',custom_variables:{source:'Registry'}}]});
  const payload=JSON.parse(f.calls.fetch[0].request.payload);assert.equal(payload.items[0].email,'alice@example.test');assert.equal(payload.skip_if_in_campaign,true);assert.equal(payload.skip_if_in_workspace,true);assert.equal(payload.skip_if_in_blacklist,true);assert.equal(f.calls.fetch[0].request.contentType,'application/json');
  for(const body of [{campaign:CAMPAIGN,items:[{email:'a@example.test'}],skip_if_in_campaign:false},{campaign:CAMPAIGN,items:[{email:'bad'}]},{campaign:CAMPAIGN,items:[]},{campaign:CAMPAIGN,items:Array.from({length:101},(_,i)=>({email:`a${i}@example.test`}))},{campaign:CAMPAIGN,items:[{email:'a@example.test'},{email:'A@example.test'}]},{campaign:CAMPAIGN,items:[{email:'a@example.test',stop_sending:true}]},{campaign:'not-uuid',items:[{email:'a@example.test'}]}])assert.throws(()=>f.c.coldyApi_(f.context,'POST','/leads/bulk',body),/INVALID_REQUEST/);
  assert.equal(f.calls.fetch.length,1);
});

test('paid verification requires a persisted idempotency key, bounded unique canonical emails and no force flags',()=>{
  const f=fixture({transport:({response})=>response({batch_id:'batch123',status:'queued'},202)});f.configure();
  const input={emails:['Alice@Example.test']};
  assert.throws(()=>f.c.coldyApi_(f.context,'POST','/email-verifications',input),/INVALID_REQUEST/);
  f.c.coldyApi_(f.context,'POST','/email-verifications',input,{idempotencyKey:'saved-request-123'});
  assert.equal(f.calls.fetch[0].request.headers['Idempotency-Key'],'saved-request-123');assert.deepEqual(JSON.parse(f.calls.fetch[0].request.payload),{emails:['alice@example.test']});
  for(const [body,options] of [[{emails:[]},{idempotencyKey:'saved-request-123'}],[{emails:['a@example.test','A@example.test']},{idempotencyKey:'saved-request-123'}],[{emails:Array.from({length:501},(_,i)=>`a${i}@example.test`)},{idempotencyKey:'saved-request-123'}],[{emails:['a@example.test'],force:true},{idempotencyKey:'saved-request-123'}],[input,{idempotencyKey:'bad\nvalue'}],[input,{idempotencyKey:'saved-request-123',url:'https://evil.test'}]])assert.throws(()=>f.c.coldyApi_(f.context,'POST','/email-verifications',body,options),/INVALID_REQUEST/);
  assert.equal(f.calls.fetch.length,1);
});

test('network uncertainty never automatically retries a non-idempotent create or echoes credentials',()=>{
  const f=fixture({transport:()=>{throw new Error('accepted create, lost acknowledgement '+KEY+' private@example.test');}});f.configure();
  assert.throws(()=>f.c.coldyApi_(f.context,'POST','/leads/bulk',{campaign:CAMPAIGN,items:[{email:'a@example.test'}]}),e=>e.registryCode==='COLDY_NETWORK'&&!e.message.includes(KEY)&&!e.message.includes('private@example.test'));
  assert.equal(f.calls.fetch.length,1);
});

test('failed connection read can be repeated without claiming a saved upload or changing settings',()=>{
  const f=fixture({transport:()=>{throw new Error('connection reset '+KEY+' private@example.test');}});f.configure();
  assert.throws(()=>f.c.testColdyConnection_({}),error=>{
    assert.equal(error.registryCode,'COLDY_NETWORK');
    assert.match(error.message,/только читает данные.*можно повторить/);
    assert.doesNotMatch(error.message,/Состояние операции сохранено|не создавайте повторную|private@example\.test/);
    assert.equal(error.message.includes(KEY),false);return true;
  });
  assert.equal(f.calls.fetch.length,1);assert.equal(f.calls.fetch[0].request.method,'get');
  assert.equal(f.calls.creates.length,0);assert.equal(f.calls.updates.length,0);
  assert.equal(f.properties.get('COLDY_API_KEY'),KEY);assert.equal(f.c.getColdySettings_({}).connected,false);
});

test('failed read preserves the previously confirmed campaign snapshot and connection timestamp',()=>{
  let unavailable=false;
  const f=fixture({transport:({response})=>{if(unavailable)throw new Error('Timeout '+KEY);return response({items:[{id:CAMPAIGN,name:'Existing',status:'Draft'}]});}});
  f.configure();f.c.listColdyCampaigns_({});
  const cached=plain(f.c.coldyCachedCampaigns_(f.context)),settings=plain(f.c.getColdySettings_({})),writes=f.calls.creates.length+f.calls.updates.length;
  unavailable=true;f.tick(1000);
  assert.throws(()=>f.c.testColdyConnection_({}),/COLDY_NETWORK/);
  assert.deepEqual(plain(f.c.coldyCachedCampaigns_(f.context)),cached);
  assert.deepEqual(plain(f.c.getColdySettings_({})),settings);
  assert.equal(f.calls.creates.length+f.calls.updates.length,writes);assert.equal(f.calls.fetch.length,2);
});

test('English and localized Google consent errors give owner setup instructions without exposing secrets',()=>{
  for(const message of [
    'Authorization is required to perform that action',
    'You do not have permission to call UrlFetchApp.fetch. Required permissions: https://www.googleapis.com/auth/script.external_request',
    'У вас нет разрешения на вызов функции UrlFetchApp.fetch. Необходимые разрешения: https://www.googleapis.com/auth/script.external_request',
    'Недостаточно прав для вызова UrlFetchApp.fetch',
    'Требуется авторизация для выполнения действия',
    'Autorisierung erforderlich: https://www.googleapis.com/auth/script.external_request'
  ]){
    const f=fixture({transport:()=>{throw new Error(message+' '+KEY+' private@example.test');}});f.configure();
    assert.throws(()=>f.c.testColdyConnection_({}),error=>error.registryCode==='COLDY_OWNER_AUTH_REQUIRED'&&/authorizeGoogleAccess/.test(error.message)&&!error.message.includes(KEY)&&!error.message.includes('private@example.test'));
    assert.equal(f.calls.fetch.length,1);assert.equal(f.calls.creates.length,0);assert.equal(f.c.getColdySettings_({}).connected,false);
  }
});

test('network diagnostics use fixed safe messages and do not retry reads or unknown writes',()=>{
  for(const [message,expected] of [
    ['DNS error','определить адрес API'],['SSL certificate error','защищённое соединение'],
    ['Request timed out','время ожидания'],['Превышено время ожидания','время ожидания'],
    ['Service invoked too many times for one day: urlfetch','лимит внешних запросов Google'],
    ['Превышена квота UrlFetch','лимит внешних запросов Google']
  ])for(const method of ['GET','POST']){
    const f=fixture({transport:()=>{throw new Error(message+' '+KEY+' private@example.test');}});f.configure();
    assert.throws(()=>f.c.coldyApi_(f.context,method,method==='GET'?'/campaigns':'/email-verifications',method==='GET'?undefined:{emails:['a@example.test']},method==='GET'?undefined:{idempotencyKey:'persisted-request-123'}),error=>{
      assert.equal(error.registryCode,'COLDY_NETWORK');assert.ok(error.message.includes(expected));
      assert.equal(error.message.includes(KEY),false);assert.equal(error.message.includes('private@example.test'),false);
      if(method==='POST'){assert.match(error.message,/не создавайте повторную загрузку или проверку/);assert.doesNotMatch(error.message,/можно повторить/);}
      return true;
    });
    assert.equal(f.calls.fetch.length,1);
    if(method==='POST')assert.equal(f.calls.fetch[0].request.headers['Idempotency-Key'],'persisted-request-123');
  }
});

test('losing the response body after dispatch preserves uncertainty for writes and repeatable reads',()=>{
  for(const stage of ['getResponseCode','getContentText'])for(const method of ['GET','POST']){
    const f=fixture({transport:({response})=>({...response({ok:true}),[stage]:()=>{throw new Error('response lost '+KEY);}})});f.configure();
    assert.throws(()=>f.c.coldyApi_(f.context,method,method==='GET'?'/campaigns':'/leads/bulk',method==='GET'?undefined:{campaign:CAMPAIGN,items:[{email:'a@example.test'}]}),error=>error.registryCode==='COLDY_NETWORK'&&!error.message.includes(KEY)&&(method==='GET'?/можно повторить/:/Продолжите прежнюю операцию/).test(error.message));
    assert.equal(f.calls.fetch.length,1);assert.equal(f.calls.creates.length,0);
  }
});

test('unavailable or conflicting GET responses do not describe an uncertain upload',()=>{
  for(const status of [409,500,503]){
    const f=fixture({transport:({response})=>response({error:KEY},status)});f.configure();
    assert.throws(()=>f.c.testColdyConnection_({}),error=>['COLDY_CONFLICT','COLDY_UNAVAILABLE'].includes(error.registryCode)&&/Повторите/.test(error.message)&&!/состояние операции/.test(error.message)&&!error.message.includes(KEY));
    assert.equal(f.calls.fetch.length,1);assert.equal(f.calls.creates.length,0);
  }
});

test('provider failures expose sanitized status and bounded Retry-After, never raw errors',()=>{
  for(const [status,code] of [[400,'COLDY_PROVIDER'],[401,'COLDY_AUTH'],[403,'COLDY_FORBIDDEN'],[404,'COLDY_NOT_FOUND'],[409,'COLDY_CONFLICT'],[429,'COLDY_RATE_LIMIT'],[502,'COLDY_UNAVAILABLE'],[302,'COLDY_PROVIDER']]){
    const f=fixture({transport:({response})=>response('private '+KEY+' a@example.test',status,{'Retry-After':'60'})});f.configure();
    assert.throws(()=>f.c.coldyApi_(f.context,'GET','/campaigns'),e=>e.registryCode===code&&e.httpStatus===status&&e.retryAfterMs===60000&&!e.message.includes(KEY)&&!e.message.includes('a@example.test'));assert.equal(f.calls.fetch.length,1);
  }
  const f=fixture({transport:()=>{throw new Error('Required permissions external_request '+KEY);}});f.configure();assert.throws(()=>f.c.coldyApi_(f.context,'GET','/campaigns'),/COLDY_OWNER_AUTH_REQUIRED/);
});

test('campaign polling, sender monitoring and the recipient timer share the same GET Retry-After across projects',()=>{
  let limit=true;
  const f=fixture({transport:({request,response})=>request.method==='get' && limit
    ? response('private response '+KEY,429,{'retry-after':'7.5'}) : response({ok:true})});
  f.configure();
  const read=path=>f.c.coldyApi_(f.context,'GET',path);
  const leads='/leads/campaign/'+CAMPAIGN+'?limit=200&offset=0';
  assert.throws(()=>read(leads),error=>error.registryCode==='COLDY_RATE_LIMIT'&&error.retryAfterMs===7500);
  const markers=[...f.properties.entries()].filter(([key])=>key.startsWith('COLDY_GET_PAUSE_'));
  assert.equal(markers.length,1);assert.equal(markers[0][1],String(f.now()+7500));
  assert.ok(!JSON.stringify(markers).includes(KEY));
  limit=false;f.tick(1000);
  f.c.registryProjectId_=()=>'neosender';
  let groups=0,guards=0;
  f.c.UrlFetchApp.fetchAll=requests=>{groups++;return requests.map(()=>f.response({ok:true}));};
  const batch=paths=>f.c.coldyGetBatch_(f.context,paths,()=>{guards++;});
  for(const paths of [['/accounts/1','/accounts/2'],['/campaigns/'+CAMPAIGN,leads],[leads]]){
    assert.ok(batch(paths).every(result=>result.error?.httpStatus===429&&result.error.retryAfterMs===6500));
  }
  assert.ok(guards>=3);assert.equal(groups,0);assert.equal(f.calls.fetch.length,1);
  assert.throws(()=>read('/accounts'),error=>error.retryAfterMs===6500);
  f.c.coldyApi_(f.context,'POST','/leads/bulk',{campaign:CAMPAIGN,items:[{email:'synthetic@example.test'}]});
  assert.equal(f.calls.fetch[1].request.method,'post');
  f.tick(6499);assert.throws(()=>read(leads),error=>error.retryAfterMs===1);
  f.tick(1);assert.equal(read(leads).ok,true);assert.ok(batch(['/accounts/1','/accounts/2']).every(result=>result.value.ok));
  assert.equal(groups,1);assert.equal(f.calls.fetch.length,3);
});

test('parallel responses keep the longest absolute deadline, and unrelated roots and credentials may still read',()=>{
  const f=fixture({transport:({response})=>response({ok:true})});f.configure();
  const current=()=>f.c.authorize_();
  f.c.UrlFetchApp.fetchAll=()=>[
    f.response({},429,{'Retry-After':new Date(f.now()+17000).toUTCString()}),
    f.response({},429,{'Retry-After':'2'})];
  const first=f.c.coldyGetBatch_(current(),['/accounts/1','/accounts/2'],()=>{});
  assert.deepEqual(Array.from(first,result=>result.error.retryAfterMs),[17000,17000]);
  const root2='different_registry_root_123456';
  f.files.set(root2,{...f.files.get(ROOT),id:root2});f.switchRoot(root2);
  assert.equal(f.c.coldyApi_(current(),'GET','/campaigns').ok,true);
  f.switchRoot(ROOT);
  assert.throws(()=>f.c.coldyApi_(current(),'GET','/campaigns'),error=>error.retryAfterMs===17000);
  f.c.configureColdy_({apiKey:'second_synthetic_credential'});
  assert.equal(f.c.coldyApi_(current(),'GET','/campaigns').ok,true);
  assert.equal(f.calls.fetch.length,2);
});

test('invalid success response cannot leak arbitrary provider data',()=>{
  for(const body of ['private '+KEY,'null','[]']){const f=fixture({transport:({response})=>response(body)});f.configure();assert.throws(()=>f.c.coldyApi_(f.context,'GET','/campaigns'),e=>e.registryCode==='COLDY_RESPONSE'&&!e.message.includes(KEY));}
});

test('documented 400 Invalid API key is an authentication failure, ordinary 400 remains a request error',()=>{
  let kind='Invalid API key';
  const f=fixture({transport:({response})=>response({error:kind,message:[KEY]},400)});
  f.configure();
  const fetch=()=>f.c.coldyApi_(f.context,'GET','/campaigns');
  assert.throws(fetch,e=>e.registryCode==='COLDY_AUTH'&&e.httpStatus===400&&!e.message.includes(KEY));
  assert.equal(f.c.getColdySettings_({}).connected,false);
  kind='Bad Request';assert.throws(fetch,e=>e.registryCode==='COLDY_PROVIDER'&&e.httpStatus===400&&!e.message.includes(KEY));
});

test('private JSON state is bound to exact registry, kind, owner and role without nested locks',()=>{
  const f=fixture();f.save('validation','workbook_123456',{jobs:[],status:'queued'});
  assert.deepEqual(plain(f.load('validation','workbook_123456')),{jobs:[],status:'queued'});assert.equal(f.load('validation','another_book_123456'),null);assert.equal(f.load('uploads','workbook_123456'),null);
  const journal=[...f.files.values()].find(file=>file.mimeType==='application/json');assert.equal(journal.appProperties.registryColdyRoot,ROOT);assert.equal(journal.appProperties.registryColdyKind,'validation');assert.equal(journal.appProperties.registryColdyOwnerHash,f.c.digest_('workbook_123456'));
  const envelope=JSON.parse(journal.body);envelope.owner='different';journal.body=JSON.stringify(envelope);assert.throws(()=>f.load('validation','workbook_123456'),/COLDY_STORAGE/);
});

test('indexed journal reads verify root, exact folder and file directly before a single blob read',()=>{
  const f=fixture();f.save('validation','workbook_123456',{jobs:[]});
  const folder=f.properties.get('COLDY_STATE_FOLDER_ID');
  const file=[...f.files.values()].find(item=>item.mimeType==='application/json').id;
  f.calls.driveReads.length=0;
  assert.deepEqual(plain(f.load('validation','workbook_123456')),{jobs:[]});
  assert.deepEqual(f.calls.driveReads,[['get',ROOT],['get',folder],['get',file],['blob',file]]);
});

test('an invalid or inaccessible configured Coldy ID never triggers discovery or a blob read',()=>{
  for(const change of ['invalid file ID','missing folder','foreign folder','foreign owner','wrong folder ID','wrong file ID','trashed root']){
    const f=fixture();f.save('validation','workbook_123456',{jobs:[]});
    const pointer=[...f.properties.keys()].find(name=>name.startsWith('COLDY_JSON_'));
    const folder=f.files.get(f.properties.get('COLDY_STATE_FOLDER_ID')), file=f.files.get(f.properties.get(pointer));
    if(change==='invalid file ID')f.properties.set(pointer,'');
    if(change==='missing folder')f.properties.set('COLDY_STATE_FOLDER_ID','missing_folder_123456');
    if(change==='foreign folder')folder.parents=['another_registry_root'];
    if(change==='foreign owner')file.appProperties.registryColdyOwnerHash=f.c.digest_('another_book');
    if(change==='wrong folder ID')folder.id='different_folder_123456';
    if(change==='wrong file ID')file.id='different_file_123456';
    if(change==='trashed root')f.files.get(ROOT).trashed=true;
    f.calls.driveReads.length=0;
    assert.throws(()=>f.load('validation','workbook_123456'),/INVALID_ID|COLDY_STORAGE|OUTSIDE_REGISTRY/,change);
    assert.ok(f.calls.driveReads.every(([method])=>method==='get'),change);
  }
});

test('Coldy discovery is used only for absent pointers and still verifies the envelope and current scope',()=>{
  for(const absent of ['folder','file','both']){
    const f=fixture();f.save('validation','workbook_123456',{jobs:[]});
    const pointer=[...f.properties.keys()].find(name=>name.startsWith('COLDY_JSON_'));
    if(absent!=='file')f.properties.delete('COLDY_STATE_FOLDER_ID');
    if(absent!=='folder')f.properties.delete(pointer);
    f.calls.driveReads.length=0;
    assert.deepEqual(plain(f.load('validation','workbook_123456')),{jobs:[]});
    assert.equal(f.calls.driveReads.filter(([method])=>method==='list').length,absent==='both'?2:1);
    const journal=[...f.files.values()].find(file=>file.mimeType==='application/json');
    journal.body=JSON.stringify({...JSON.parse(journal.body),kind:'bindings'});
    assert.throws(()=>f.load('validation','workbook_123456'),/COLDY_STORAGE/);
  }
  const orphan=fixture();orphan.save('validation','workbook_123456',{jobs:[]});
  orphan.files.delete(orphan.properties.get('COLDY_STATE_FOLDER_ID'));orphan.properties.delete('COLDY_STATE_FOLDER_ID');
  orphan.calls.driveReads.length=0;
  assert.throws(()=>orphan.load('validation','workbook_123456'),/COLDY_STORAGE/);
  assert.equal(orphan.calls.driveReads.some(([method])=>method==='blob'),false);
  for(const transition of ['revoke','switch']){
    const f=fixture();f.save('validation','workbook_123456',{jobs:[]});
    const original=f.context.properties.getProperty;
    f.context.properties.getProperty=key=>{
      const value=original(key);
      if(key.startsWith('COLDY_JSON_')){
        if(transition==='revoke')f.revoke();else f.switchRoot('another_root_123456');
      }
      return value;
    };
    f.calls.driveReads.length=0;
    assert.throws(()=>f.load('validation','workbook_123456'),/SOURCE_CHANGED|LINK_ACCESS_REQUIRED/);
    assert.deepEqual(f.calls.driveReads,[]);
  }
});

test('lost folder and JSON creation acknowledgements recover the same exact tags without duplicates',()=>{
  const f=fixture({loseFolderAck:true,loseJsonAck:true});f.save('validation','workbook_123456',{jobs:[{jobId:'saved'}]});f.save('validation','workbook_123456',{jobs:[{jobId:'saved',state:'complete'}]});
  assert.equal(f.calls.creates.length,2);assert.deepEqual(plain(f.load('validation','workbook_123456')),{jobs:[{jobId:'saved',state:'complete'}]});
});

test('lost JSON update acknowledgements verify the persisted value before returning success',()=>{
  const f=fixture({loseUpdateAck:true});f.save('bindings','segment_123456',{items:[]});f.save('bindings','segment_123456',{items:[{id:'binding123'}]});assert.deepEqual(plain(f.load('bindings','segment_123456')),{items:[{id:'binding123'}]});assert.equal(f.calls.creates.length,2);
  const g=fixture({failUpdateBefore:true});g.save('bindings','segment_123456',{items:[]});assert.throws(()=>g.save('bindings','segment_123456',{items:[{id:'unknown'}]}),/COLDY_STORAGE_UNCERTAIN/);assert.equal(g.calls.creates.length,2);
});

test('an unindexed JSON state is recovered by exact tags, while duplicate candidates stop safely',()=>{
  const f=fixture();f.save('validation','workbook_123456',{jobs:[]});for(const key of f.properties.keys())if(key.startsWith('COLDY_JSON_'))f.properties.delete(key);
  assert.deepEqual(plain(f.load('validation','workbook_123456')),{jobs:[]});f.save('validation','workbook_123456',{jobs:[{state:'known'}]});assert.equal(f.calls.creates.length,2);
  for(const key of f.properties.keys())if(key.startsWith('COLDY_JSON_'))f.properties.delete(key);const source=[...f.files.values()].find(file=>file.mimeType==='application/json');f.files.set('coldy_duplicate_123456',{...plain(source),id:'coldy_duplicate_123456'});
  assert.throws(()=>f.load('validation','workbook_123456'),/COLDY_STORAGE_UNCERTAIN/);
});

test('state and service folder moves or role changes are rejected before writes',()=>{
  for(const mutation of ['file-parent','file-role','folder-parent','folder-root','file-mime','file-trash']){
    const f=fixture();f.save('validation','workbook_123456',{jobs:[]});const journal=[...f.files.values()].find(file=>file.mimeType==='application/json'),folder=f.files.get(f.properties.get('COLDY_STATE_FOLDER_ID'));
    if(mutation==='file-parent')journal.parents=['outside_folder_123456'];if(mutation==='file-role')journal.appProperties.registryPrivateRole='foreign';if(mutation==='folder-parent')folder.parents=['outside_folder_123456'];if(mutation==='folder-root')folder.appProperties.registryColdyRoot='another_root_123456';if(mutation==='file-mime')journal.mimeType='text/plain';if(mutation==='file-trash')journal.trashed=true;
    const writes=f.calls.updates.length;assert.throws(()=>f.save('validation','workbook_123456',{jobs:[{state:'new'}]}),/OUTSIDE_REGISTRY/,mutation);assert.equal(f.calls.updates.length,writes);
  }
});

test('changed registry binding, trashed root and revoked shared access stop HTTP and durable writes',()=>{
  for(const mode of ['changed','trashed','revoked']){
    const f=fixture();f.configure();if(mode==='changed')f.switchRoot('another_root_123456');if(mode==='trashed')f.files.get(ROOT).trashed=true;if(mode==='revoked')f.revoke();
    assert.throws(()=>f.c.coldyApi_(f.context,'GET','/campaigns'),/SOURCE_CHANGED|OUTSIDE_REGISTRY|LINK_ACCESS_REQUIRED/);assert.throws(()=>f.save('validation','workbook_123456',{jobs:[]}),/SOURCE_CHANGED|OUTSIDE_REGISTRY|LINK_ACCESS_REQUIRED/);assert.equal(f.calls.fetch.length,0);assert.equal(f.calls.creates.length,0);
  }
});

test('storage validates identifiers and refuses credentials inside working JSON files',()=>{
  const f=fixture();f.configure();for(const [kind,owner] of [['bad/kind','book'],['validation',''],['validation','x'.repeat(201)]]){
    assert.throws(()=>f.save(kind,owner,{jobs:[]}),/INVALID_REQUEST/);
  }
  assert.throws(()=>f.save('validation','workbook_123456',{apiKey:KEY}),/COLDY_STORAGE/);assert.equal([...f.files.values()].filter(file=>file.mimeType==='application/json').length,0);
  f.save('validation',"owner'quotes-safe-in-hash",{jobs:[]});assert.deepEqual(plain(f.load('validation',"owner'quotes-safe-in-hash")),{jobs:[]});
});
