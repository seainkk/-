// Run against a fresh local Firestore emulator started with firebase/firestore.rules.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import vm from 'node:vm';

const host=process.env.FIRESTORE_EMULATOR_HOST;
assert.match(host||'',/^127\.0\.0\.1:\d{1,5}$/,'Provide a local Firestore emulator');
const project='demo-directory', base='projects/'+project+'/databases/(default)/documents', origin='http://'+host+'/v1/';
const cap=randomBytes(32).toString('base64url'), writer=randomBytes(32).toString('base64url'), verifier='v'.repeat(43);
const gate=base+'/directoryControl/active', admin=base+'/directoryAdmin/publisher';
async function call(path,method,body,owner=false){
  const res=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...(owner?{Authorization:'Bearer owner'}:{})},
    body:body===undefined?undefined:JSON.stringify(body)});
  const json=await res.json();
  return {status:json?.error?.code||json?.[0]?.error?.code||res.status,json};
}
const stored=(name,fields)=>({update:{name,fields}});
const commit=(writes,owner)=>call(base+':commit','POST',{writes},owner);
const get=(...documents)=>call(base+':batchGet','POST',{documents});
const view=base+'/directoryViews/'+cap+'/lists/';
const adminFields={enabled:{booleanValue:true},verifier:{stringValue:verifier},writer:{stringValue:writer}};
assert.equal((await commit([stored(admin,adminFields)],true)).status,200);
let writes;
const r=vm.createContext({UrlFetchApp:{fetch:(_,opts)=>{writes=JSON.parse(opts.payload).writes;return {getResponseCode:()=>200};}}});
vm.runInContext(readFileSync(new URL('../src/FirebaseDirectory.gs',import.meta.url),'utf8'),r);
r.FIREBASE_DIRECTORY={project,lifetime:600000};
function prepare(at=Date.now()){
  r.firebaseDirectoryCommit_({hash:verifier,cap},{writer},{catalog:'[]','segments-numshield':'[]','segments-neosender':'[]'},at);
}
async function expect(operation,status,label) {
  const response=await operation;
  assert.equal(response.status,status,label);
}
prepare();
await expect(commit(writes),200,'writer can publish a cold generation');
await expect(get(view+'catalog',view+'segments-numshield'),200,'reader can batch-get the exact documents');
await expect(get(admin),403,'admin stays closed'); await expect(get(gate),403,'gate stays closed');
await expect(get(base+'/directoryWrites/'+writer),403,'receipt stays closed');
await expect(call(view.slice(0,-1),'GET'),403,'views cannot be enumerated');
await expect(get(base+'/directoryViews/'+randomBytes(32).toString('base64url')+'/lists/catalog'),403,'different reader denied');
prepare(); await expect(commit(writes.slice(1)),403,'reader cannot publish using a past receipt');
await expect(commit(writes),200,'writer can renew');
prepare(Date.now()-2000);await expect(commit(writes),403,'older generation cannot overwrite a fresh one');
prepare(Date.now()-610000);await expect(commit(writes),403,'expired generation denied');
await expect(commit([stored(admin,{...adminFields,enabled:{booleanValue:false}})],true),200,'owner can revoke');
await expect(get(view+'catalog'),403,'active lease is revoked immediately');
prepare();await expect(commit(writes),403,'revoked writer cannot republish');
console.log('Local Firestore Rules accepted atomic publication and renewal, exact batch reads, revocation and denial cases.');
