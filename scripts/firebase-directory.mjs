// Owner-only setup. No contacts, shared link, credentials or capability paths are printed.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const project='outreach-directory', p='projects/'+project, db=p+'/databases/(default)', doc=db+'/documents/directoryAdmin/publisher';
const store='https://firestore.googleapis.com/v1/', rules='https://firebaserules.googleapis.com/v1/', drive='https://www.googleapis.com/drive/v3/files';
const check=(condition,message)=>{if(!condition)throw new Error(message);};
const field=(d,k)=>d?.fields?.[k]?.stringValue;
let stage='arguments';
async function main() {
  const cmd=process.argv[2]||'status', args=process.argv.slice(3);
  check(['provision','status','disable','enable','set-verifier'].includes(cmd),'unknown action');
  const local=await readFile('src/Config.gs','utf8'), defaultHash=local.match(/sharedAccessKeyHash:\s*'([^']+)'/)?.[1];
  const root=process.env.FIREBASE_DIRECTORY_ROOT_ID||local.match(/defaultRootFolderId:\s*'([^']+)'/)?.[1], verifier=process.env.FIREBASE_DIRECTORY_VERIFIER||defaultHash;
  check(/^[\w-]{10,200}$/.test(root) && /^[\w-]{43}$/.test(verifier),'invalid root or verifier');
  const dep=path.resolve('node_modules/@google/clasp'), req=createRequire(path.join(dep,'package.json'));
  const {GoogleAuth}=req('google-auth-library');
  const {FileCredentialStore}=await import(pathToFileURL(path.join(dep,'build/src/auth/file_credential_store.js')).href);
  stage='private owner authentication';
  const saved=await new FileCredentialStore(path.join(homedir(),'.clasprc.json')).load('default');
  const auth=new GoogleAuth().fromJSON(saved);auth.setCredentials(saved);
  async function request(method,url,data,params,headers) {
    const options={method,url,timeout:30000,retry:false};
    if(data!==undefined)options.data=data;if(params)options.params=params;
    options.headers={...(url.startsWith(store)||url.startsWith(rules)?{'x-goog-user-project':project}:{}),...headers};
    return (await auth.request(options)).data;
  }
  async function find(url,params){try{return await request('GET',url,undefined,params);}catch(e){if(e.response?.status===404)return null;throw e;}}
  stage='verify dedicated database';
  const database=await request('GET',store+db,undefined,{fields:'name,type,locationId'});
  check(database.name===db && database.type==='FIRESTORE_NATIVE','unexpected database');
  let admin=await find(store+doc);
  async function update(fields,additional=[]) {
    const write={update:{name:doc,fields},currentDocument:admin?{updateTime:admin.updateTime}:{exists:false}};
    if(admin)write.updateMask={fieldPaths:Object.keys(fields)};
    await request('POST',store+db+'/documents:commit',{writes:[write,...additional]});admin=await find(store+doc);
  }
  if(cmd==='status')return {database:database.locationId,initialized:!!admin,enabled:admin?.fields?.enabled?.booleanValue===true,configId:field(admin,'fileId')||null};
  if(cmd!=='provision'){
    check(admin && field(admin,'root')===root,'publisher not initialized for this root');
    stage='confirm owner control';
    if(cmd==='set-verifier'){
      check(admin.fields.enabled.booleanValue===false && args.length===1 && /^[\w-]{43}$/.test(args[0]),'disable first and provide the new verifier');
      await update({verifier:{stringValue:args[0]}});
    }else{
      check(args.length===0,'unexpected arguments');
      const remove=[];
      if(cmd==='disable'){
        const gate=await find(store+db+'/documents/directoryControl/active'), cap=field(gate,'capability');
        if(gate){
          check(/^[\w-]{43}$/.test(cap),'invalid active generation');
          remove.push({delete:gate.name,currentDocument:{updateTime:gate.updateTime}});
          for(const name of ['catalog','segments-numshield','segments-neosender'])
            remove.push({delete:db+'/documents/directoryViews/'+cap+'/lists/'+name});
        }
      }else{
        check(admin.fields.pending?.booleanValue!==true,'run provision first');
      }
      await update({enabled:{booleanValue:cmd==='enable'}},remove);
    }
    return {updated:cmd,enabled:admin.fields.enabled.booleanValue};
  }
  check(args.length===0,'unexpected arguments');
  stage='verify and install dedicated rules';
  const normalized=text=>text.replace(/\r\n/g,'\n');
  const content=normalized(await readFile('firebase/firestore.rules','utf8')), release=p+'/releases/cloud.firestore';
  const published=await find(rules+release);
  if(published){
    const active=await request('GET',rules+published.rulesetName);
    const files=active?.source?.files||[], prior=normalized(files[0]?.content||'');
    const compact=prior.replace(/\/\/[^\r\n]*/g,'').replace(/\s+/g,'');
    const locked=/^(?:rules_version='2';)?servicecloud\.firestore\{match\/databases\/\{database\}\/documents\{match\/\{[a-zA-Z_]+=[*][*]\}\{allowread,write:iffalse;\}\}\}$/.test(compact);
    check(files.length===1 && (prior===content||locked),'existing rules are neither this release nor the deny-all default');
    if(prior!==content){
      const next=await request('POST',rules+p+'/rulesets',{source:{files:[{name:'firestore.rules',content}]}});
      await request('PATCH',rules+release,{release:{name:release,rulesetName:next.name},updateMask:'rulesetName'});
    }
  }else{
    const next=await request('POST',rules+p+'/rulesets',{source:{files:[{name:'firestore.rules',content}]}});
    await request('POST',rules+p+'/releases',{name:release,rulesetName:next.name});
  }
  const activeRules=await request('GET',rules+(await request('GET',rules+release)).rulesetName);
  check(activeRules.source.files.length===1 && normalized(activeRules.source.files[0].content)===content,'rules receipt mismatch');
  const denied=await fetch(store+db+'/documents:batchGet',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({documents:[doc]})});
  check(denied.status===403,'private administrative document is readable or inaccessible for an unexpected reason');
  stage='reserve private owner configuration';
  if(!admin){
    const allocated=await request('GET',drive+'/generateIds',undefined,{count:1,space:'drive',type:'files'});
    await update({writer:{stringValue:randomBytes(32).toString('base64url')},fileId:{stringValue:allocated.ids[0]},
      verifier:{stringValue:verifier},root:{stringValue:root},enabled:{booleanValue:false},pending:{booleanValue:true}});
  }
  const writer=field(admin,'writer'),id=field(admin,'fileId');
  check(/^[\w-]{43}$/.test(writer)&&/^[\w-]{10,200}$/.test(id)&&field(admin,'root')===root&&field(admin,'verifier')===verifier,'control identity mismatch');
  const params={fields:'id,ownedByMe,shared,trashed,mimeType,parents,properties'}, home=await request('GET',drive+'/root',undefined,{fields:'id'});
  check(home.id!==root,'the registry cannot be My Drive itself');
  const cfg={project,root,writer}, url=drive+'/'+encodeURIComponent(id);
  let file=await find(url,params);
  if(!file){
    const boundary='directory_'+randomBytes(16).toString('hex'), meta={id,name:'.outreach-directory-publisher.json',mimeType:'application/json',parents:[home.id],properties:{outreachDirectoryWriter:project}};
    const body='--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(meta)+'\r\n--'+boundary+'\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify(cfg)+'\r\n--'+boundary+'--\r\n';
    file=await request('POST','https://www.googleapis.com/upload/drive/v3/files',body,{...params,uploadType:'multipart'},{'Content-Type':'multipart/related; boundary='+boundary});
  }
  check(file.id===id && file.ownedByMe===true && file.shared===false && file.trashed===false &&
    file.mimeType==='application/json' && file.parents?.length===1 && file.parents[0]===home.id && file.properties?.outreachDirectoryWriter===project,'configuration ACL or location mismatch');
  let body=await request('GET',url,undefined,{alt:'media'});if(typeof body==='string')body=JSON.parse(body);
  check(body.project===project&&body.root===root&&body.writer===writer,'configuration content mismatch');
  if(admin.fields.pending?.booleanValue===true)await update({enabled:{booleanValue:true},pending:{booleanValue:false}});
  return {project,location:database.locationId,configId:id,private:true,enabled:admin.fields.enabled.booleanValue,rulesVerified:true};
}
try { console.log(JSON.stringify(await main())); }
catch(e){console.error('Firebase directory setup stopped at '+stage+' ('+(e.response?.status||'validation')+').');process.exitCode=1;}
