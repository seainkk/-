import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

const segment = 'kitchens_segment_id', requestId = 'test_operation_01', campaignId = '550e8400-e29b-41d4-a716-446655440000';
const digest = text => createHash('sha256').update(text).digest('base64url');
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const c = vm.createContext({});
  for (const file of ['SegmentContactCard','SegmentSelections']) vm.runInContext(readFileSync(new URL('../src/'+file+'.gs',import.meta.url),'utf8'),c);
  const state = {version: digest('v1'), project: 'numshield', writes: 0, failIndexOnce: false, rows: [
    {value:'one@example.org',channel:'email',ready:true,owners:['companies'],ownerNames:['А']},
    {value:'two@example.org',channel:'email',ready:false,owners:['companies'],ownerNames:['Б']},
    {value:'three@example.org',channel:'email',ready:true,owners:['lpr'],ownerNames:['В']}]};
  const docs = new Map(), fail = (code,message)=>{throw Object.assign(new Error(message),{registryCode:code});};
  const bindings = [{binding:{campaignName:'Кухни',campaignId}}];
  Object.assign(c,{api_:f=>f(),locked_:f=>f(),fail_:fail,id_:x=>x,digest_:digest,segmentRequestId_:x=>x,
    segmentInput_:(input,keys)=>{if(Object.keys(input).some(k=>!keys.includes(k))) fail('INVALID_REQUEST','keys');return input;},
    authorize_:()=>({rootId:'root1234567'}),registryProjectId_:()=>state.project,registrySegmentProject_:()=> 'numshield',
    segmentFolder_:()=>({}),segmentSourceFolder_:()=>({}),sourceBasesStorage_:()=>({}),segmentRequireStorageWrite_:()=>{},
    segmentCardFiles_:()=>({}),segmentCardCampaigns_:()=>({bindings}),segmentCardRevision_:()=>state.version,
    segmentCardData_:(_context,_segment,revision)=>{if(revision!==state.version)fail('SEGMENT_CARD_CHANGED','updated');
      return {campaigns:{bindings},snapshot:{rows:state.rows}};}, COLDY:{},CONTACT_SYNC:{maxTargetRows:100000},coldyCampaignId_:x=>x,
    coldyLoad_:(_context,kind,owner)=>docs.has(kind+owner)?plain(docs.get(kind+owner)):null,
    coldySave_:(_context,kind,owner,val)=>{
      if(kind==='segmentfilters'&&state.failIndexOnce){state.failIndexOnce=false;throw new Error('storage temporarily unavailable');}
      state.writes++;docs.set(kind+owner,plain(val));}});
  const exportRequest = {segmentId:segment,name:'Кухни · готовые email',filter:{channel:'email',queue:'ready'},revision:state.version,campaignId,requestId};
  return {c,state,exportRequest};
}

test('team filters can be reused and retries return one entry for the original request',()=>{
  const {c,state}=fixture(), input={segmentId:segment,name:'Готовые email',owner:'companies',channel:'email',queue:'ready',requestId};
  const first=c.saveSegmentFilter_(input), replay=c.saveSegmentFilter_(input);
  assert.deepEqual(plain(replay),plain(first));assert.equal(state.writes,1);
  assert.equal(c.getSegmentSelections_({segmentId:segment}).filters[0].queue,'ready');
  assert.throws(()=>c.saveSegmentFilter_({...input,name:'Другая подборка'}),{registryCode:'REQUEST_ID_REUSED'});
  state.project='neosender';assert.throws(()=>c.getSegmentSelections_({segmentId:segment}),{registryCode:'OUTSIDE_PROJECT'});
});

test('saved export uses server-side membership and retains its original contacts after edits',()=>{
  const {c,state,exportRequest}=fixture();
  const saved=c.saveSegmentExport_(exportRequest);assert.equal(saved.count,2);assert.equal(saved.campaignName,'Кухни');
  state.version=digest('updated');state.rows=[];
  const replay=c.saveSegmentExport_(exportRequest);
  assert.equal(replay.id,saved.id);assert.equal(state.writes,2);
  const page=c.getSegmentExport_({segmentId:segment,id:saved.id,limit:1});
  assert.equal(page.nextOffset,1);assert.deepEqual(plain(page.rows),[{channel:'email',value:'one@example.org'}]);
  const end=c.getSegmentExport_({segmentId:segment,id:saved.id,offset:page.nextOffset});
  assert.equal(end.nextOffset,null);assert.equal(end.rows[0].value,'three@example.org');
  assert.equal(c.getSegmentSelections_({segmentId:segment}).exports[0].rows,undefined);
});

test('mismatched or injected contacts, foreign campaigns and stale revisions fail before a write',()=>{
  const {c,state,exportRequest}=fixture();
  assert.throws(()=>c.saveSegmentExport_({...exportRequest,rows:[{channel:'email',value:'outside@example.org'}]}),{registryCode:'SEGMENT_EXPORT_CHANGED'});
  assert.throws(()=>c.saveSegmentExport_({...exportRequest,campaignId:'not-bound'}),{registryCode:'COLDY_BINDING_MISSING'});
  assert.throws(()=>c.saveSegmentExport_({...exportRequest,revision:digest('stale')}),{registryCode:'SEGMENT_CARD_CHANGED'});
  assert.equal(state.writes,0);
});

test('retry after incomplete indexing recovers the same immutable export even after source revisions change',()=>{
  const {c,state,exportRequest}=fixture();state.failIndexOnce=true;
  assert.throws(()=>c.saveSegmentExport_(exportRequest),/temporarily unavailable/);assert.equal(state.writes,1);
  state.version=digest('newer');state.rows=[];
  const recovered=c.saveSegmentExport_(exportRequest);assert.equal(recovered.count,2);assert.equal(state.writes,2);
  assert.equal(c.getSegmentSelections_({segmentId:segment}).exports.length,1);
  const modified={...exportRequest,filter:{owner:'lpr'}};
  assert.throws(()=>c.saveSegmentExport_(modified),{registryCode:'REQUEST_ID_REUSED'});
});
