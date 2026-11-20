import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

function fixture(mode) {
  const root='root_registry_1234567890',draft={rootId:root,stageFileId:'stage_book_1234567890',section:'companies'},calls={scope:0,chunks:0,leases:0};
  let revoked=false,moved=false,leaseLost=false,currentRoot=root;
  const fail=(code)=>{const e=new Error(code);e.registryCode=code;throw e;};
  const c=vm.createContext({Date,Object,Array,Number,String,JSON,Math,Error,fail_:fail,
    authorize_:()=>{if(revoked)fail('LINK_ACCESS_REQUIRED');return {rootId:currentRoot};},
    preparedAssertLease_:()=>{calls.leases++;if(leaseLost)fail('BUSY');},
    preparedDraftFile_:()=>{calls.scope++;if(moved)fail('OUTSIDE_REGISTRY');return {id:draft.stageFileId,version:'1'};},
    preparedVersion_:f=>f.version,
    SpreadsheetApp:{openById:id=>{assert.equal(id,draft.stageFileId);return {fixedWorkbook:true,getSheets:()=>[{getSheetId:()=>0,getName:()=>"Исходная",getLastRow:()=>2,getLastColumn:()=>2}]};}},
  });
  vm.runInContext(readFileSync(new URL('../src/PreparedWorkbookImport.gs',import.meta.url),'utf8'),c);
  c.preparedWorkbookSourceOptions_=()=>({});
  c.preparedDataReadWorkbook_=(book,id,section,options)=>{
    assert.equal(book.fixedWorkbook,true);assert.equal(id,draft.stageFileId);
    for(let i=0;i<12;i++){
      options.guard();calls.chunks++;
      if(i===0){if(mode==='key')revoked=true;if(mode==='root')currentRoot='different_root';if(mode==='lease')leaseLost=true;if(mode==='move')moved=true;}
    }
    return {complete:true,canConfirm:true,fingerprint:'stable'};
  };
  return {calls,read:()=>c.preparedWorkbookStableRead_({rootId:root},draft)};
}
test('a bounded fixed-workbook read checks full Drive scope at both transaction boundaries',()=>{
  const f=fixture();assert.equal(f.read().model.complete,true);assert.equal(f.calls.chunks,12);assert.equal(f.calls.scope,2);assert.equal(f.calls.leases,12);
});
test('a staged workbook moved during reading never returns a model for a preview or plan',()=>{
  const f=fixture('move');assert.throws(f.read,/OUTSIDE_REGISTRY/);assert.equal(f.calls.scope,2);
});
for(const [mode,error] of [['key','LINK_ACCESS_REQUIRED'],['root','SOURCE_CHANGED'],['lease','BUSY']])test('mid-read '+mode+' change stops at the next chunk',()=>{
  const f=fixture(mode);assert.throws(f.read,new RegExp(error));assert.equal(f.calls.chunks,1);
});
