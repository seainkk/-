import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const campaign = '237056d1-20b1-41ab-aa0e-17965cecbe14';
function lead(id, changes = {}) {
  return { id, campaign_id: campaign, email: 'Lead' + id + '@example.test', first_name: 'Иван',
    status: 'Sent', stop_sending: false, amount_sequences_sent: 1, reply_text: null, ...changes };
}
function fixture(leads, alter = () => {}) {
  const calls = [], context = {};
  let credential = 'confirmed';
  const c = vm.createContext({
    fail_(code) { throw new Error(code); },
    coldyCredentialHash_: () => credential,
    coldyApi_(scope, method, path) {
      assert.equal(scope, context);
      assert.equal(method, 'GET');
      assert.equal(c.coldyPath_(method, path), path);
      const url = new URL('https://developer.coldy.ai' + path);
      assert.equal(url.pathname, '/leads/campaign/' + campaign);
      const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
      assert.equal(limit, 200);
      calls.push(offset);
      const page = { items: leads.slice(offset, offset + limit), offset, limit, total: leads.length };
      alter(page, () => { credential = 'rotated'; });
      return page;
    }
  });
  const transport = c.coldyApi_;
  for (const file of ['Coldy.gs','ColdyRecipientData.gs']) {
    vm.runInContext(readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'), c, {filename: file});
  }
  c.coldyCredentialHash_ = () => credential;
  c.coldyApi_ = transport;
  return { snapshot: () => JSON.parse(JSON.stringify(c.coldyRecipientSnapshot_(context, campaign))), calls };
}

test('reads each page and reports individual sequence emails and provider outcomes', () => {
  const f = fixture([lead(1, { status: 'Replied', amount_sequences_sent: 3, reply_text: 'private reply' }),
    lead(2, { status: 'Bounce', stop_sending: true }), lead(3, { status: 'Not contacted', amount_sequences_sent: 0 }),
    ...Array.from({length: 211}, (_, n) => lead(500 - n))]);
  const result = f.snapshot();
  assert.deepEqual(f.calls, [0, 200]);
  assert.equal(result.total, 214);
  assert.equal(result.items.length, result.total);
  assert.deepEqual(result.items.slice(0,3).map(it => [it.email,it.sentCount,it.replied,it.bounced,it.doNotSend]), [
    ['lead1@example.test',3,true,false,false], ['lead2@example.test',1,false,true,true],
    ['lead3@example.test',0,false,false,false]]);
  assert.ok(!JSON.stringify(result).includes('private reply'));
});

test('missing, novel and null fields never become a count of zero or a confirmed negative', () => {
  const [unknown, reply] = fixture([lead(13, { status: 'new provider enum', stop_sending: null, amount_sequences_sent: null }),
    lead(14, { status: 'Opened', reply_text: 'actual response', amount_sequences_sent: undefined })]).snapshot().items;
  assert.deepEqual([unknown.sentCount,unknown.status,unknown.bounced,unknown.replied,unknown.doNotSend], [null,null,null,null,null]);
  assert.deepEqual([reply.sentCount,reply.replied], [null,true]);
  assert.deepEqual(fixture([]).snapshot(), {items:[],total:0});
});

test('duplicates spanning pages contribute each distinct lead id once to the same email', () => {
  const inputs = Array.from({length: 202}, (_, n) => lead(n + 1));
  inputs[200] = lead(201, { email: 'LEAD1@EXAMPLE.TEST', first_name: 'Пётр', amount_sequences_sent: 2,
    status: 'Bounce', stop_sending: true });
  inputs[201] = lead(202, { email: 'lead2@example.test', amount_sequences_sent: null, stop_sending: null });
  const result = fixture(inputs).snapshot();
  assert.equal(result.total, 202);
  assert.equal(result.items.length, 200);
  assert.deepEqual(result.items.slice(0,2).map(it => [it.firstName,it.sentCount,it.status,it.bounced,it.doNotSend]),
    [['',3,null,true,true],['Иван',null,'Sent',false,null]]);
});

test('list drift, malformed page, credential change or a wrong campaign preclude a snapshot', () => {
  const rows = Array.from({length:201}, (_, n) => lead(n + 1));
  for (const alter of [
    page => { if (page.offset) page.total--; }, page => { page.items.pop(); },
    page => { page.offset = -1; }, page => { page.limit = 100; },
    page => { if (page.offset) page.items[0] = rows[0]; },
    page => { page.items[0] = lead(1, { campaign_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }); },
    page => { page.items[0] = lead(1, { email: '' }); },
    (_page, changeCredential) => changeCredential()
  ]) assert.throws(() => fixture(rows, alter).snapshot(), /COLDY_/);
});

test('targeted blacklist checks use exact addresses and domains; paginated searches resume without unrelated contacts',()=>{
  const env=vm.createContext({fail_(code){throw new Error(code);}});
  for(const name of ['Coldy','ColdyRecipientData'])
    vm.runInContext(readFileSync(new URL('../src/'+name+'.gs',import.meta.url),'utf8'),env);
  const rows=['one@agency.test','two@agency.test','lead@vendor.test'].map(email=>({email})), calls=[];
  env.coldyGetBatch_=(_,paths,guard,mode)=>{
    assert.equal(mode,'recipient-suppression');guard();calls.push(...paths);
    return paths.map(path=>{
      const url=new URL('https://example.test'+env.coldyPath_('GET',path)), search=url.searchParams.get('search');
      if(url.pathname.endsWith('domains'))return {value:{items:[{domain:search==='vendor.test'?'Vendor.Test':'not-agency.test'}],next_starting_after:null}};
      if(search==='@agency.test')return url.searchParams.has('starting_after')?{value:{items:[{email:'One@Agency.Test'}],next_starting_after:null}}:
        {value:{items:[{email:'outsider@agency.test'}],next_starting_after:7}};
      return {value:{items:[],next_starting_after:null}};
    });
  };
  let a=env.coldyRecipientSuppression_({},rows,()=>{},null);assert.equal(a.unavailable,false);
  assert.equal(a.nextCursor.after,7);
  const b=env.coldyRecipientSuppression_({},rows,()=>{},a.nextCursor);
  assert.equal(b.nextCursor,null);assert.deepEqual(Array.from(b.hits).sort(),['lead@vendor.test','one@agency.test']);
  assert.ok(calls.every(p=>p.includes('search=')));
  assert.throws(()=>env.coldyPath_('GET','/blacklist/emails'),/INVALID_REQUEST/);
  assert.throws(()=>env.coldyPath_('GET','/blacklist/domains?search=test.com&starting_after=0'),/INVALID_REQUEST/);

  env.coldyGetBatch_=(_,paths)=>paths.map(()=>({error:{registryCode:'COLDY_RATE_LIMIT',retryAfterMs:68000}}));
  const deferred=env.coldyRecipientSuppression_({},rows,()=>{},null);
  assert.equal(deferred.retryAfterMs,68000);assert.equal(deferred.nextCursor.index,0);assert.deepEqual(Array.from(deferred.hits),[]);
});
