import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';

const ROOT='monitoring_root_1234567890', KEY='monitoring_fixture_secret_NEVER_PUBLIC';
const plain=value=>JSON.parse(JSON.stringify(value));
const hash=value=>crypto.createHash('sha256').update(String(value)).digest('base64url');

function fixture(options={}) {
  let authorized=true, rootId=ROOT, locked=false, sequence=0;
  const properties=new Map(), cache=new Map(), calls={loads:[],saves:[],http:[]};
  const props={getProperty:key=>properties.get(key)??null,setProperty:(key,value)=>properties.set(key,String(value)),deleteProperty:key=>properties.delete(key)};
  const coded=(code,message)=>Object.assign(new Error(`[${code}] ${message}`),{registryCode:code});
  const root={id:ROOT,mimeType:'application/vnd.google-apps.folder',parents:['owner_root_1234567890'],trashed:false};
  const c=vm.createContext({Date,console,JSON,Math,Number,String,Array,Object,
    api_:callback=>callback(),object_:value=>{if(!value||typeof value!=='object'||Array.isArray(value))throw coded('INVALID_REQUEST','Object required');return value;},
    fail_:(code,message)=>{throw coded(code,message);},registryError_:coded,digest_:hash,
    id_:value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{10,200}$/.test(value))throw coded('INVALID_ID','Invalid ID');return value;},
    authorize_:()=>{if(!authorized)throw coded('LINK_ACCESS_REQUIRED','Revoked');return{rootId,properties:props};},
    locked_:callback=>{assert.equal(locked,false,'No nested global locks');locked=true;try{return callback();}finally{locked=false;}},
    Utilities:{getUuid:()=>`fixture-request-${++sequence}`},
    Drive:{Files:{get:id=>{if(id!==rootId)throw coded('OUTSIDE_REGISTRY','Wrong root');return{...root,id:rootId};}}},
    UrlFetchApp:{fetch:()=>{calls.http.push('unexpected');throw Error('Monitoring selection must not contact a provider');}},
  });
  for(const name of ['Coldy.gs','ProjectInfrastructure.gs','ProjectMonitoring.gs','ProjectCapacity.gs'])vm.runInContext(readFileSync(new URL('../src/'+name,import.meta.url),'utf8'),c);
  c.coldyLoad_=(context,kind,owner)=>{
    c.coldyCurrent_(context,true);calls.loads.push({rootId:context.rootId,kind,owner});
    const value=cache.get(`${context.rootId}|${kind}|${owner}`);
    if(options.afterLoad)options.afterLoad({f,kind});
    return value?plain(value):null;
  };
  c.coldySave_=(context,kind,owner,value)=>{
    assert.equal(locked,true,'Selection writes require the global lock');
    if(options.beforeSave)options.beforeSave({f,kind,value});
    c.coldyCurrent_(context,true);
    assert.ok(!JSON.stringify(value).includes(properties.get('COLDY_API_KEY')||'impossible-empty-key'));
    calls.saves.push({rootId:context.rootId,kind,owner,value:plain(value)});
    cache.set(`${context.rootId}|${kind}|${owner}`,plain(value));
    if(options.afterSave)options.afterSave({f,kind,value});
    return value;
  };
  const f={c,properties,cache,calls,options,
    configure:key=>c.configureColdy_({apiKey:key||KEY}),
    revoke:()=>{authorized=false;},rotate:key=>properties.set('COLDY_API_KEY',key),switchRoot:()=>{rootId='other_monitoring_root_1234567890';},
    get:()=>plain(c.getProjectInfrastructureSelection_({})),
    save:(accountIds,extra={})=>{
      const selection=f.get().selection;
      return plain(c.saveProjectInfrastructureSelection_({accountIds,expectedRevision:selection.revision,
        scopeToken:selection.scopeToken,requestId:`save-request-${++sequence}`,...extra}));
    },
    monitorState:()=>cache.get(`${rootId}|monitoring|${hash(properties.get('COLDY_API_KEY')||'')}`),
    installInventory:(count=3)=>{
      const at=new Date().toISOString(),credentialHash=hash(properties.get('COLDY_API_KEY')||'');
      const accounts=Array.from({length:count},(_,index)=>({id:String(index+1),email:`sender${index+1}@example.test`,
        name:'Sender '+(index+1),provider:'google',status:'Connected',sentTotal:(index+1)*10,sentToday:index+1,dailyLimit:100,
        errors:[],tags:[],warmup:null,updatedAt:at,stale:false,syncError:null,smtp_password:'smtp-secret-never-public'}));
      cache.set(`${rootId}|infrastructure|${credentialHash}`,{version:1,rootId,credentialHash,generation:hash('inventory'),
        startedAt:Date.now(),accounts,cursorIndex:0,processedCursors:[],nextCursor:null,inventoryAt:at,
        updatedAt:at,lastAttemptAt:at,retryAt:0,warnings:[],lastError:null});
    },
  };
  return f;
}

test('the default selection is empty even when a legacy inventory contains every sender',()=>{
  const f=fixture();let dto=f.get();
  assert.equal(dto.configured,false);assert.deepEqual(dto.selection.accountIds,[]);assert.equal(dto.selection.configured,false);
  assert.equal(dto.selection.revision,0);assert.equal(dto.availableCount,0);assert.equal(dto.inventoryAt,null);
  assert.equal(f.calls.loads.length,0);assert.equal(f.calls.saves.length,0);
  f.configure();f.installInventory();dto=f.get();
  assert.equal(dto.availableCount,3);assert.equal(dto.accounts.length,3);assert.deepEqual(dto.selection.accountIds,[]);
  assert.match(dto.selection.scopeToken,/^[A-Za-z0-9_-]{43}$/);
  assert.ok(dto.accounts.every(row=>Object.keys(row).sort().join(',')==='email,id,name,provider'));
  assert.ok(!JSON.stringify(dto).includes(KEY));assert.ok(!JSON.stringify(dto).includes('smtp-secret'));
  assert.deepEqual(f.calls.http,[]);assert.equal(f.calls.saves.length,0);
});

test('selection is shared, canonical and explicit; saving it never mutates the inventory or calls Coldy',()=>{
  const f=fixture();f.configure();f.installInventory();
  const before=f.get(),cacheBefore=plain([...f.cache.values()]),signature=f.c.projectMonitoringSignature_({rootId:ROOT},f.c.projectMonitoringRead_({rootId:ROOT,properties:f.c.authorize_().properties},f.c.coldySettings_(f.c.authorize_())));
  const saved=f.save(['3','1']);
  assert.deepEqual(saved.selection.accountIds,['1','3']);assert.equal(saved.selection.revision,1);assert.equal(saved.selection.configured,true);
  assert.equal(saved.selection.scopeToken,before.selection.scopeToken);assert.deepEqual(f.get().selection,saved.selection);
  assert.notEqual(f.c.projectMonitoringSignature_({rootId:ROOT},f.monitorState()),signature);
  assert.equal(f.calls.saves.length,1);assert.equal(f.calls.saves[0].kind,'monitoring');
  assert.deepEqual(plain(f.cache.get(`${ROOT}|infrastructure|${hash(KEY)}`)),cacheBefore[0]);assert.deepEqual(f.calls.http,[]);
  const cleared=f.save([]);assert.equal(cleared.selection.configured,true);assert.deepEqual(cleared.selection.accountIds,[]);assert.equal(cleared.selection.revision,2);
});

test('lost acknowledgement retries the same request and confirms newer teammate selection without reverting it',()=>{
  let lose=true;
  const f=fixture({afterSave:()=>{if(lose){lose=false;throw Object.assign(new Error('Unknown acknowledgement'),{registryCode:'COLDY_STORAGE_UNCERTAIN'});}}});
  f.configure();f.installInventory();const read=f.get().selection;
  const payload={accountIds:['1'],expectedRevision:0,scopeToken:read.scopeToken,requestId:'stable-lost-ack'};
  assert.throws(()=>f.c.saveProjectInfrastructureSelection_(payload),/Unknown acknowledgement/);
  const recovered=plain(f.c.saveProjectInfrastructureSelection_(payload));assert.equal(recovered.replayed,true);assert.equal(recovered.savedRevision,1);
  assert.equal(f.calls.saves.length,1);assert.deepEqual(recovered.selection.accountIds,['1']);
  f.save(['2']);const writes=f.calls.saves.length;
  const replay=plain(f.c.saveProjectInfrastructureSelection_(payload));assert.deepEqual(replay.selection.accountIds,['2']);assert.equal(replay.selection.revision,2);
  assert.equal(replay.savedRevision,1);assert.equal(replay.replayed,true);assert.equal(f.calls.saves.length,writes);
  assert.throws(()=>f.c.saveProjectInfrastructureSelection_({...payload,accountIds:['3']}),/COLDY_MONITORING_REQUEST_MISMATCH/);
});

test('an optimistic conflict preserves the teammate choice and the selection scope follows root and credential',()=>{
  const f=fixture();f.configure();f.installInventory();const original=f.get().selection;
  f.save(['1']);
  const stale={accountIds:['2'],expectedRevision:0,scopeToken:original.scopeToken,requestId:'stale-choice-001'};
  assert.throws(()=>f.c.saveProjectInfrastructureSelection_(stale),/COLDY_MONITORING_STALE/);assert.deepEqual(f.get().selection.accountIds,['1']);
  f.configure('different-fixture-credential');assert.deepEqual(f.get().selection.accountIds,[]);assert.notEqual(f.get().selection.scopeToken,original.scopeToken);
  assert.throws(()=>f.c.saveProjectInfrastructureSelection_(stale),/COLDY_MONITORING_SCOPE_CHANGED/);
  f.rotate(KEY);f.switchRoot();assert.notEqual(f.get().selection.scopeToken,original.scopeToken);
  assert.throws(()=>f.c.saveProjectInfrastructureSelection_(stale),/COLDY_MONITORING_SCOPE_CHANGED/);
  assert.equal(f.calls.saves.length,1);
});

test('selection accepts only bounded unique current inventory IDs and strict versioned requests',()=>{
  const f=fixture();f.configure();f.installInventory();const selection=f.get().selection;
  const valid={accountIds:['1'],expectedRevision:0,scopeToken:selection.scopeToken,requestId:'valid-save-request'};
  for(const accountIds of [[1],['01'],['0'],['-1'],['1','1'],['9007199254740992'],Array.from({length:5001},(_,i)=>String(i+1)),null])
    assert.throws(()=>f.c.saveProjectInfrastructureSelection_({...valid,accountIds}),/INVALID_REQUEST/);
  for(const extra of [{expectedRevision:-1},{expectedRevision:'0'},{expectedRevision:true},{scopeToken:'wrong'},{requestId:'bad'},{unknown:true}])
    assert.throws(()=>f.c.saveProjectInfrastructureSelection_({...valid,...extra}),/INVALID_REQUEST/);
  assert.throws(()=>f.c.saveProjectInfrastructureSelection_({...valid,accountIds:['999']}),/COLDY_MONITORING_ACCOUNT_MISSING/);
  assert.equal(f.calls.saves.length,0);assert.deepEqual(f.calls.http,[]);
});

test('explicitly empty monitoring can be saved without an inventory; unconfigured writes are rejected',()=>{
  const f=fixture();const selection=f.get().selection;
  assert.throws(()=>f.c.saveProjectInfrastructureSelection_({accountIds:[],expectedRevision:0,scopeToken:selection.scopeToken,requestId:'empty-without-key'}),/COLDY_KEY_REQUIRED/);
  f.configure();assert.throws(()=>f.save(['1']),/COLDY_MONITORING_ACCOUNT_MISSING/);
  assert.deepEqual(f.save([]).selection.accountIds,[]);assert.equal(f.get().selection.configured,true);
  assert.equal(f.calls.saves.length,1);
});

test('read and save boundaries reject revocation, key rotation and root changes without leaking a stale choice',()=>{
  for(const action of ['revoke','key','root']){
    let run=false;
    const f=fixture({afterLoad:({f,kind})=>{if(!run||kind!=='monitoring')return;run=false;if(action==='revoke')f.revoke();else if(action==='key')f.rotate('changed-provider-secret');else f.switchRoot();}});
    f.configure();f.installInventory();run=true;
    assert.throws(()=>f.get(),action==='revoke'?/LINK_ACCESS_REQUIRED/:action==='key'?/COLDY_CREDENTIAL_CHANGED/:/SOURCE_CHANGED/);
    assert.equal(f.calls.saves.length,0);
  }
  let rotate=false;
  const f=fixture({afterSave:({f})=>{if(rotate)f.rotate('changed-after-write');}});f.configure();f.installInventory();rotate=true;
  assert.throws(()=>f.save(['1']),/COLDY_CREDENTIAL_CHANGED/);
  assert.deepEqual(f.get().selection.accountIds,[]);assert.equal(f.calls.saves.length,1);
});

test('malformed private selection or receipts fail closed and never reach the public picker',()=>{
  for(const corrupt of [
    state=>{state.rootId='other-root';},state=>{state.credentialHash='wrong';},state=>{state.accountIds=['01'];},
    state=>{state.configured=false;},state=>{state.receipts[0].requestHash='invalid';},state=>{state.receipts.push(plain(state.receipts[0]));},
    state=>{state.unexpected=KEY;},
  ]){
    const f=fixture();f.configure();f.installInventory();f.save(['1']);corrupt(f.monitorState());
    assert.throws(()=>f.get(),error=>error.registryCode==='COLDY_STORAGE'&&!error.message.includes(KEY));
  }
});

test('the supported 5000-account selection survives canonicalization without truncation',()=>{
  const f=fixture();f.configure();f.installInventory(5000);
  const saved=f.save(Array.from({length:5000},(_,i)=>String(5000-i)));
  assert.equal(saved.selection.accountIds.length,5000);assert.equal(saved.selection.accountIds[0],'1');assert.equal(saved.selection.accountIds.at(-1),'5000');
  assert.equal(f.get().selection.accountIds.length,5000);assert.equal(f.calls.saves.length,1);assert.deepEqual(f.calls.http,[]);
});
