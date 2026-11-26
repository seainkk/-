import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash, createHmac, hkdfSync} from 'node:crypto';

const source = readFileSync(new URL('../src/FirebaseDirectory.gs',import.meta.url),'utf8');
const key = 'k'.repeat(43), root = 'synthetic_registry_root', writer = 'w'.repeat(43);
const hash = createHash('sha256').update(key).digest('base64url');
function fixture() {
  const store = new Map(), calls = [], state = {now:1890000000000,version:'1',timers:0,serial:0,http:200};
  const props = {getProperty:k=>store.get(k)??null, setProperty:(k,v)=>store.set(k,v),
    deleteProperty:k=>store.delete(k), getProperties:()=>Object.fromEntries(store)};
  const ctx = {rootId:root,properties:props};
  const r = vm.createContext({
    Date:class extends Date {static now(){return state.now;}},
    SHARED_REQUEST_SCOPE_:{keyHash:hash,projectId:'numshield'},
    authorize_:()=>ctx,sharedConfiguredHash_:()=>state.overrideHash||hash,
    id_:id=>{assert.match(id,/^[\w-]{10,200}$/);return id;},
    digest_:s=>createHash('sha256').update(s).digest('base64url'),
    segmentCardMaintenanceLock_:(_,callback)=>callback(),
    coldyIncomingEnsure_:()=>{state.timers++;return {enabled:true};},
    Utilities:{newBlob:s=>({getBytes:()=>[...Buffer.from(s)]}),
      computeHmacSha256Signature:(msg,key)=>[...createHmac('sha256',Buffer.from(key)).update(Buffer.from(msg)).digest()],
      base64EncodeWebSafe:a=>Buffer.from(a).toString('base64url'),getUuid:()=>String(++state.serial)},
    Drive:{Files:{get:(id,options)=>{
      if (id==='root') return {id:'owner_home_folder'};
      if (options.fields==='version') return {version:state.version};
      return {id,ownedByMe:true,shared:!!state.shared,trashed:false,mimeType:'application/json',version:state.version,
        parents:[state.parent||'owner_home_folder'],properties:{outreachDirectoryWriter:'outreach-directory'}};
    }}},
    DriveApp:{getFileById:()=>({getBlob:()=>({getDataAsString:()=>JSON.stringify({project:'outreach-directory',root,writer})})})},
    getSourceDirectory_:()=>({state:'ready',complete:true,items:[{id:'catalog_file_id',name:'Каталог',private:'row contents'}]}),
    getSegmentDirectory_:()=>{
      const project=r.SHARED_REQUEST_SCOPE_.projectId;
      state.collect?.(project);
      return {state:'ready',complete:true,projectId:project,
        items:[{id:'segment_'+project,name:'Тест',category:'clients',url:'private link'}]};
    },
    UrlFetchApp:{fetch:(url,options)=>{calls.push({url,options});return {getResponseCode:()=>state.http};}}
  });
  vm.runInContext(source,r);
  return {r,state,calls,store,arm:()=>r.firebaseDirectoryArm_(key),tick:()=>r.firebaseDirectoryTick_(()=>ctx),
    clock:()=>JSON.parse(store.get(r.FIREBASE_DIRECTORY.clock)||'{}')};
}

test('a confirmed login binds only a derived read capability, with bounded timer repair',()=>{
  const {r,state,store,arm,tick}=fixture();
  arm();arm(); assert.equal(state.timers,1);
  const binding=JSON.parse(store.get(r.FIREBASE_DIRECTORY.binding));
  const cap=Buffer.from(hkdfSync('sha256',key,'outreach-center/firebase-directory/v1','outreach-directory',32)).toString('base64url');
  assert.equal(binding.cap,cap);
  assert.ok(!JSON.stringify([...store]).includes(key));
  tick();
  state.now+=310000;arm();assert.equal(state.timers,1);
  state.now+=301000;arm();arm();assert.equal(state.timers,2);
});

test('one anonymous atomic commit publishes only the names and scoped segment membership',()=>{
  const {r,state,arm,tick,calls,clock}=fixture();
  const before=r.SHARED_REQUEST_SCOPE_;
  arm();tick();tick();
  assert.equal(r.SHARED_REQUEST_SCOPE_,before);
  assert.equal(calls.length,1);
  const {url,options}=calls[0], {writes}=JSON.parse(options.payload);
  assert.equal(url,'https://firestore.googleapis.com/v1/projects/outreach-directory/databases/(default)/documents:commit');
  assert.equal(options.method,'post');assert.equal(options.followRedirects,false);assert.equal(options.headers,undefined);
  assert.equal(writes.length,5);
  assert.ok(writes[0].update.name.endsWith('/directoryWrites/'+writer));
  assert.deepEqual(writes[0].updateTransforms,[{fieldPath:'stamp',setToServerValue:'REQUEST_TIME'}]);
  const gate=writes[1].update.fields;
  assert.equal(gate.verifier.stringValue,hash);
  assert.equal(Date.parse(gate.expiresAt.timestampValue)-Date.parse(gate.generatedAt.timestampValue),600000);
  for(const [i,list] of ['catalog','segments-numshield','segments-neosender'].entries()) {
    const {name,fields}=writes[i+2].update;
    assert.ok(name.endsWith('/directoryViews/'+gate.capability.stringValue+'/lists/'+list));
    assert.deepEqual(Object.keys(fields).sort(),['expiresAt','generatedAt','rowsJson','schema']);
    assert.deepEqual(fields.expiresAt,gate.expiresAt);
    assert.deepEqual(Object.keys(JSON.parse(fields.rowsJson.stringValue)[0]).sort(),i?['id','name','project','section']:['id','name']);
  }
  assert.equal(clock().issue,null);assert.equal(clock().lastSuccess,state.now);
  state.now+=300001; tick();assert.equal(calls.length,2);
});

test('mid-scan changes, stale generations, incomplete results and out-of-scope configurations fail closed',()=>{
  for(const change of ['verifier','scope','file','timeout','acl','location','incomplete','concurrent']){
    const {r,state,arm,tick,calls,store,clock}=fixture();
    arm();
    if(change==='acl') state.shared=true;
    if(change==='location') state.parent='unexpected';
    if(change==='incomplete') r.getSourceDirectory_=()=>({state:'ready',complete:false,items:[]});
    state.collect=()=>{
      if(change==='verifier') state.overrideHash='changed';
      if(change==='scope') store.set('REGISTRY_SEGMENT_PROJECT_synthetic','elsewhere');
      if(change==='file') state.version='2';
      if(change==='timeout') state.now+=181000;
      if(change==='concurrent') store.set(r.FIREBASE_DIRECTORY.clock,JSON.stringify({claim:'other-worker'}));
    };
    tick();assert.equal(calls.length,0,change);assert.equal(r.SHARED_REQUEST_SCOPE_.projectId,'numshield');
    if(change==='concurrent') assert.equal(clock().claim,'other-worker');else assert.ok(clock().issue,change);
  }
});

test('only safe HTTP error codes survive failed publication and a retry can recover',()=>{
  const {state,arm,tick,calls,clock}=fixture();
  arm();state.http=403;tick();
  assert.equal(clock().issue,'http_403');assert.equal(clock().lastSuccess,0);
  assert.ok(!JSON.stringify(clock()).includes(writer));
  state.now+=61000;state.http=200;tick();assert.equal(calls.length,2);
  assert.equal(clock().issue,null);assert.equal(clock().lastSuccess,state.now);
});

test('size, ownership, duplicate IDs and project/category contracts fail before publication',()=>{
  const {r}=fixture();
  const item={id:'synthetic_segment',name:'A',category:'clients'}, base={state:'ready',complete:true,projectId:'numshield',items:[item]};
  for(const directory of [{...base,projectId:'neosender'},{...base,items:[item,item]},
      {...base,items:[{...item,name:' '}]},{...base,items:[{...item,name:'x'.repeat(256)}]},
      {...base,items:[{...item,category:'unexpected'}]},{...base,items:Array(501).fill(item)}]){
    assert.throws(()=>r.firebaseDirectoryRows_(directory,'numshield'));
  }
});
