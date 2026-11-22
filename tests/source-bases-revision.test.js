import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function fixture() {
  const props = {}, files = [{id:'a',name:'А',mimeType:'text/csv',url:'https://drive.google.com/a'},
    {id:'b',name:'Б',mimeType:'text/csv',url:'https://drive.google.com/b'}];
  const meta = {id:'book',mimeType:'sheet',version:'57',parents:['root'],trashed:false};
  const state = {project:'numshield',root:'root',access:true};
  const context = {api_:fn=>fn(), object_:value=>value,
    fail_:(code,msg)=>{throw Error(code+msg);},id_:id=>id,
    authorize_:()=>{if(!state.access)throw Error('LINK_ACCESS_REQUIRED');return {rootId:state.root,properties:{getProperties:()=>props}};},
    registryProjectId_:()=>state.project,REGISTRY_CONFIG:{defaultSourceBasesStorageId:'book',spreadsheetMime:'sheet'},
    Drive:{Files:{get(id){assert.equal(id,'book');return meta;}}},
    digest_:value=>createHash('sha256').update(value).digest('base64url'),
    sourceBasesSource_:()=>({state:'ready',source:{id:'source',name:'Исходники'},folder:{}}),
    sourceBasesDiscover_:()=>files};
  vm.runInNewContext(readFileSync(new URL('../src/SourceBasesRevision.gs',import.meta.url),'utf8'),context);
  return {context,state,props,files,meta,read:()=>context.getSourceBasesRevision_({}).revision};
}

test('the catalogue hint reads no sheet, is order-independent, and changes on file metadata, project ownership and service-book edits',()=>{
  const f=fixture(), original=f.read();assert.match(original,/^[\w-]{43}$/);
  f.files.reverse();assert.equal(f.read(),original);
  f.files[0].name='Переименована';assert.notEqual(f.read(),original);
  f.files[0].name='Б';assert.equal(f.read(),original);
  f.meta.version='58';assert.notEqual(f.read(),original);
  f.meta.version='57';f.props.REGISTRY_SEGMENT_PROJECT_segmentA='neosender';assert.notEqual(f.read(),original);
  delete f.props.REGISTRY_SEGMENT_PROJECT_segmentA;f.state.project='neosender';assert.notEqual(f.read(),original);
  f.files.pop();assert.notEqual(f.read(),original);
});

test('an unusable or moved journal yields no unchanged signal; revoked access and a root change are rejected',()=>{
  const f=fixture();f.meta.parents=['other'];assert.equal(f.read(),null);
  f.meta.parents=['root'];f.meta.version=null;assert.equal(f.read(),null);
  assert.throws(()=>f.context.getSourceBasesRevision_({id:'untrusted'}),/INVALID_REQUEST/);
  f.context.sourceBasesDiscover_=()=>{f.state.root='other';return [];};
  assert.throws(()=>f.read(),/SOURCE_CHANGED/);
  f.state.access=false;assert.throws(()=>f.read(),/LINK_ACCESS_REQUIRED/);
});

test('nearby polls reuse only an opaque revision, with live scope checks and a hard 15-second expiry',()=>{
  const f=fixture(), entries=new Map();
  let now=1800000000000, scans=0;
  f.context.Date={now:()=>now};
  f.context.CacheService={getScriptCache:()=>({
    get:key=>entries.get(key)||null,
    put(key,value,ttl){assert.equal(ttl,15);entries.set(key,value);}
  })};
  f.context.sourceBasesDiscover_=()=>{scans++;return f.files;};
  const original=f.read();
  assert.equal(f.read(),original);
  assert.equal(scans,1);
  const cached=JSON.parse([...entries.values()][0]);
  assert.deepEqual(Object.keys(cached).sort(),['at','proof','token']);
  assert.match(cached.proof,/^[\w-]{43}$/);
  f.files[0].name='Переименована вручную';
  now+=15000;
  assert.notEqual(f.read(),original);
  assert.equal(scans,2);
  f.meta.version='58';f.read();assert.equal(scans,3);
  f.props.REGISTRY_SEGMENT_PROJECT_X='neosender';f.read();assert.equal(scans,4);
  f.state.project='neosender';f.read();assert.equal(scans,5);
  f.meta.parents=['other'];assert.equal(f.read(),null);
  f.meta.parents=['root'];f.context.sourceBasesSource_=()=>({state:'source_missing'});
  assert.equal(f.read(),null);
  f.state.access=false;assert.throws(()=>f.read(),/LINK_ACCESS_REQUIRED/);
});
