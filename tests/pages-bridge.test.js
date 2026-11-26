import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const src=name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
const script=name=>src(name).match(/<script>([\s\S]*?)<\/script>/)[1];
const pages='https://seainkk.github.io',google='https://app-script.googleusercontent.com',protocol='registry-pages-rpc-v1';
const channel='af640534-378f-451d-b879-68764d56a124',key='x'.repeat(43);

test('bridge routing renders a credential-free public handshake for one canonical channel',()=>{
  const page={setXFrameOptionsMode(mode){assert.equal(mode,'ALLOWALL');return page;}};
  const template={evaluate:()=>page};
  const ctx=vm.createContext({HtmlService:{createTemplateFromFile(name){assert.equal(name,'PagesBridge');return template;},XFrameOptionsMode:{ALLOWALL:'ALLOWALL'}}});
  vm.runInContext(src('Code.gs'),ctx);
  assert.equal(ctx.doGet({parameter:{bridge:'1',channel,access_key:key}}),page);
  assert.equal(template.bridgeSession,channel);
  ctx.doGet({parameter:{bridge:'1',channel:key}});assert.equal(template.bridgeSession,'');
  assert.doesNotMatch(src('PagesBridge.html'),/localStorage|sessionStorage/);
});

function bridgeFixture(ancestors=[google,pages,pages]){
  const messages=[],listeners=new Map(),frames=ancestors.map(()=>({postMessage:(m,origin)=>messages.push([m,origin])}));
  frames.forEach((frame,i)=>frame.parent=frames[i+1]||frame);
  const window={parent:frames[0],location:{ancestorOrigins:ancestors},google:{script:{run:{}}},addEventListener:(t,f)=>listeners.set(t,f)};
  const ctx=vm.createContext({window,document:{getElementById:()=>({dataset:{channel}})},google:window.google});
  vm.runInContext(script('PagesBridge.html'),ctx);
  return {messages,frames,listeners,window};
}
test('a direct bridge, untrusted ancestor or mistaken Pages sibling cannot obtain an RPC port',()=>{
  for(const origins of [[],['https://unrelated.invalid'],[google,'https://seainkk.github.io.example.invalid']]){
    const f=bridgeFixture(origins);assert.equal(f.messages.length,0);assert.equal(f.listeners.has('message'),false);
  }
  const f=bridgeFixture(),sent=[],port={postMessage:m=>sent.push(m)};
  assert.equal(f.messages.length,1);assert.equal(f.messages[0][1],pages);
  const connect=(source,origin,id=channel)=>f.listeners.get('message')({source,origin,data:{protocol,type:'connect',channel:id},ports:[port]});
  connect(f.frames[2],pages);connect({},pages);connect(f.frames[1],'https://unrelated.invalid');connect(f.frames[1],pages,'wrong');
  assert.equal(port.onmessage,undefined);
  connect(f.frames[1],pages);assert.equal(sent[0].type,'connected');assert.equal(typeof port.onmessage,'function');
});

function transportFixture(){
  const listeners=new Map(),timers=new Map(),posted=[],frames=[],pipes=[];
  let ticks=0;
  class Iframe {
    constructor(){this.contentWindow={};this.listeners={};}
    get credentialless(){return true;}set credentialless(value){}
    addEventListener(t,f){this.listeners[t]=f;} setAttribute(){} remove(){this.removed=true;}
  }
  class Channel{
    constructor(){this.port1={postMessage:(m)=>posted.push(m),close(){}};this.port2={close(){}};pipes.push(this);}
  }
  const window={addEventListener:(t,f)=>listeners.set(t,f)};
  const ctx=vm.createContext({window,location:{origin:pages,pathname:'/-/app.html'},document:{body:{append:f=>frames.push(f)},createElement:()=>new Iframe()},
    HTMLIFrameElement:Iframe,crypto:{randomUUID:()=>channel},MessageChannel:Channel,
    setTimeout:(fn,delay)=>{timers.set(++ticks,{fn,delay});return ticks;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(script('PagesTransport.html'),ctx);
  const hello=(source,origin,ch=channel)=>listeners.get('message')({source,origin,data:{protocol,channel:ch,type:'hello'}});
  const reply=data=>pipes[0].port1.onmessage({data:{protocol,channel,...data}});
  return {api:window.RegistryPagesTransport,listeners,timers,frames,posted,pipes,hello,reply};
}
test('credentials and RPC replies travel only on the verified bridge port, resolve by id and time out without replay',async()=>{
  const f=transportFixture();
  const started=f.api.ready(),frame=f.frames[0];
  assert.equal(new URL(frame.src).searchParams.get('bridge'),'1');assert.ok(!frame.src.includes(key));assert.equal(frame.referrerPolicy,'no-referrer');
  const accepted=[],child={parent:frame.contentWindow,postMessage:(m,to,ports)=>accepted.push({m,to,ports})};
  f.hello({},google);f.hello(child,pages);f.hello(child,google,'wrong');assert.equal(f.pipes.length,0);
  f.hello(child,google);assert.equal(accepted.length,1);assert.equal(accepted[0].to,google);assert.equal(JSON.stringify(accepted[0].m).includes(key),false);
  f.reply({type:'connected'});await started;
  const a=f.api.run('getAppBootstrap',undefined,'numshield',key),b=f.api.run('getSourceBases',{},'neosender',key);
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.posted.map(m=>m.projectId),['numshield','neosender']);
  const [first,second]=f.posted;
  f.reply({type:'result',id:second.id+9,ok:true,value:'irrelevant'});
  f.reply({type:'result',id:first.id,channel:'unrelated',ok:true,value:'wrong'});
  f.reply({type:'result',id:second.id,ok:true,value:'second'});assert.equal(await b,'second');
  f.reply({type:'result',id:first.id,ok:false,message:'[SOURCE_CHANGED] Обновите данные.'});await assert.rejects(a,/SOURCE_CHANGED/);
  const pending=f.api.run('updateSourceBase',{requestId:'original-request'},'numshield',key);
  await new Promise(resolve=>setImmediate(resolve));
  [...f.timers.values()].find(t=>t.delay===390000).fn();
  await assert.rejects(pending,/не подтвердил/);assert.equal(f.posted.length,3);assert.equal(frame.removed,true);
  const reconnect=f.api.ready();assert.equal(f.frames.length,2);f.listeners.get('pagehide')();await assert.rejects(reconnect,/не подтвердил/);
});
