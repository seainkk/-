import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = name => readFileSync(new URL('../src/' + name,import.meta.url),'utf8');
const coded = (code,retryAfterMs = 0) => Object.assign(new Error(code),{registryCode:code,retryAfterMs});
function fixture(count,options = {}) {
  let now = Date.UTC(2026,10,22,12), project = 'numshield', revision = 1, key = 'synthetic', serial = 0;
  const selected = Array.from({length:count},(_,index) => String(index + 1));
  const store = new Map(), calls = [], settings = {configured:true,credentialHash:key,connected:false,proofSlot:'COLDY_CONNECTION'};
  const context = {rootId:'synthetic-root',properties:{getProperty:id => store.get(id),setProperty:(id,data) => store.set(id,data),deleteProperty:id => store.delete(id)}};
  let isLocked = false;
  const signature = () => [context.rootId,key,project,revision,selected].join('|');
  class Clock extends Date {constructor(...args) {super(...(args.length ? args : [now]));} static now() {return now;}}
  const c = vm.createContext({Date:Clock,registryError_:coded,fail_:code => {throw coded(code);},Utilities:{getUuid:() => 'request-' + ++serial},
    registryProjectId_:() => project,locked_:fn => {
      assert.equal(isLocked,false); isLocked = true; try {return fn();} finally {isLocked = false;}
    },projectMonitoringSignature_:signature,projectMonitoringRead_:(_context,_settings,observation) => {
      if(options.observe){const initial=signature();observation.unchanged=()=>options.observe()&&initial===signature();}
      return {accountIds:selected.slice()};
    },
    projectInfraMonitoringCurrent_:(_ctx,hash,sig) => {
      if (hash !== key || sig !== signature()) throw coded('COLDY_MONITORING_CHANGED'); return context;
    }});
  for (const file of ['Coldy.gs','ProjectInfrastructure.gs','ColdyServiceLimits.gs']) vm.runInContext(source(file),c);
  c.coldyCurrent_=()=>context;c.coldyCredentialHash_=()=>key;
  c.coldySettings_=()=>{const proof=JSON.parse(store.get(settings.proofSlot)||'null');return {...settings,connected:!!proof,checkedAt:proof?.checkedAt};};
  let journalRechecks=0;
  c.projectInfraMonitoringCurrent_ = (_ctx,hash,sig) => {
    journalRechecks++;
    if (hash !== key || sig !== signature()) throw coded('COLDY_MONITORING_CHANGED'); return context;
  };
  c.coldyGetBatch_ = (_ctx,paths,guard) => {
    assert.equal(isLocked,false);
    guard(); calls.push(Array.from(paths)); const round = calls.length;
    const answers = paths.map(path => {
      const id = path.match(/^\/accounts\/([1-9]\d*)$/)?.[1];
      assert.ok(id && selected.includes(id));
      return options.answer?.(Number(id),round) || {value:{id:Number(id),daily_limit:12,sent_today:3,
        email:'never-disclose@example.test',warmup:{daily_limit:500,sent_today:400}}};
    });
    options.afterBatch?.(round,f); guard(); return answers;
  };
  const f = {read:() => c.coldyServiceLimits_(context,settings),settings,calls,store,selected,connectionKey:c.COLDY.connectionProperty,
    tick:ms => {now += ms;},time:ms => {now = ms;},project:value => {project = value;},revise:() => {revision++;},journalRechecks:()=>journalRechecks};
  return f;
}
const values = result => Array.from(result.items,item => item.value);

test('stable monitored files are read once and a revision change between mailbox batches discards the result',()=>{
  const f=fixture(20,{observe:()=>true});
  assert.equal(f.read().active,true);assert.equal(f.journalRechecks(),0);assert.equal(f.calls.length,4);
  const changed=fixture(20,{observe:()=>true,afterBatch:(round,f)=>{if(round===1)f.revise();}});
  assert.throws(changed.read,{registryCode:'COLDY_MONITORING_CHANGED'});
  assert.equal(changed.journalRechecks(),1);assert.equal(changed.calls.length,1);
});

test('Coldy reads only selected mailbox GETs, clamps remaining per mailbox and never invents billing credits',() => {
  const f = fixture(2,{answer:id => ({value:{id,daily_limit:id === 1 ? 10 : 30,sent_today:id === 1 ? 20 : 4,
    email:'never-disclose@example.test',warmup:{daily_limit:70,sent_today:60}}})});
  const value = f.read();
  assert.deepEqual(values(value),[null,2,40,24,26]); assert.equal(value.active,true); assert.equal(value.pending,false);
  assert.match(value.message,/баланс кредитов/); assert.deepEqual(f.calls,[['/accounts/1','/accounts/2']]);
  const saved = JSON.stringify([...f.store]); assert.doesNotMatch(saved,/never-disclose|warmup/);
  assert.doesNotMatch(JSON.stringify(value),/never-disclose|warmup|synthetic-root/);
  assert.equal(f.read().checkedAt,value.checkedAt); assert.equal(f.calls.length,1);
  f.tick(45001); assert.deepEqual(values(f.read()),[null,2,40,24,26]); assert.equal(f.calls.length,2);
});

test('one missing provider field makes only the affected totals unknown; zero remains a confirmed count',() => {
  const f = fixture(2,{answer:id => ({value:{id,daily_limit:id === 1 ? 0 : null,sent_today:0}})});
  assert.deepEqual(values(f.read()),[null,2,null,0,null]);
  const invalid = fixture(1,{answer:() => ({value:{id:2,daily_limit:500,sent_today:0}})});
  assert.throws(invalid.read,{registryCode:'COLDY_RESPONSE'});
});

test('a provider credential rejection elsewhere invalidates a recently completed limits sample',() => {
  const f = fixture(2,{answer:(_id,round) => round === 2 ? {error:coded('COLDY_AUTH')} : null});
  f.read(); assert.equal(f.calls.length,1); assert.ok(f.store.has(f.connectionKey));
  f.store.delete(f.connectionKey);
  assert.throws(f.read,{registryCode:'COLDY_AUTH'});
  assert.equal(f.calls.length,2); assert.equal(f.store.size,0);
});

test('large project resumes its own counts without duplicates; partial sums never leave the server',() => {
  const f = fixture(46);
  const first = f.read(); assert.equal(first.pending,true); assert.match(first.message,/20 из 46/);
  assert.deepEqual(values(first),[null,46,null,null,null]); assert.equal(f.calls.length,4);
  f.tick(35000); assert.match(f.read().message,/40 из 46/); f.tick(35000);
  const done = f.read(); assert.equal(done.pending,false); assert.deepEqual(values(done),[null,46,552,138,414]);
  assert.match(done.message,/с 15:00 до 15:01 МСК/); assert.equal(new Set(f.calls.flat()).size,46);
  assert.equal(f.calls.flat().length,46); assert.ok(f.calls.every(group => group.length <= 5));
  assert.deepEqual(values(f.read()),values(done)); assert.equal(f.calls.flat().length,46);
});

test('projects, selection revisions, and a changed Moscow day invalidate cached numbers',() => {
  const f = fixture(1);
  f.time(Date.UTC(2026,10,22,20,59,50)); f.read(); f.tick(20000); f.read(); assert.equal(f.calls.length,2);
  f.project('neosender'); f.read(); assert.equal(f.calls.length,3);
  f.project('numshield'); f.read(); assert.equal(f.calls.length,3);
  f.revise(); f.read(); assert.equal(f.calls.length,4);
  const changed = fixture(2,{afterBatch:(_n,f) => f.revise()}); assert.throws(changed.read,{registryCode:'COLDY_MONITORING_CHANGED'});
  assert.equal(JSON.parse([...changed.store.values()][0]).cursor,0);
});

test('parallel requests reuse the in-flight lease and avoid overlapping mailbox requests',() => {
  let waiting;
  const f = fixture(2,{afterBatch:(round,f) => {if (round === 1) waiting = f.read();}});
  const done = f.read(); assert.equal(f.calls.length,1); assert.equal(waiting.pending,true);
  assert.equal(waiting.active,null); assert.deepEqual(values(waiting),[null,2,null,null,null]);
  assert.equal(done.active,true); assert.equal(done.pending,false);
});

test('a group 429 preserves checked groups, stops later reads and respects the longest Retry-After across callers',() => {
  const f = fixture(16,{answer:(id,round) => round === 2 && (id === 6 || id === 8) ? {error:coded('COLDY_RATE_LIMIT',id === 6 ? 70000 : 90000)} : null});
  assert.throws(f.read,{registryCode:'COLDY_RATE_LIMIT',retryAfterMs:90000}); assert.equal(f.calls.length,2);
  f.tick(80000); assert.throws(f.read,{registryCode:'COLDY_RATE_LIMIT',retryAfterMs:10000}); assert.equal(f.calls.length,2);
  f.tick(10001); const result = f.read(); assert.deepEqual(values(result),[null,16,192,48,144]);
  assert.deepEqual(f.calls[2],f.calls[1]);
});

test('empty monitoring returns zero chosen mailboxes and only a dated connection receipt, with zero Coldy requests',() => {
  const f = fixture(0);
  assert.equal(f.read().active,null); assert.deepEqual(values(f.read()),[null,0,null,null,null]);
  f.settings.connected = true; f.settings.checkedAt = '2026-11-19T12:00:00Z';
  assert.equal(f.read().checkedAt,'2026-11-19T12:00:00.000Z'); assert.equal(f.read().active,true);
  assert.equal(f.calls.length,0); assert.equal(f.store.size,0);
});
