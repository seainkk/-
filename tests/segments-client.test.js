import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const client = readFileSync(new URL('../src/Client.html', import.meta.url), 'utf8');
function actualHelper(name) {
  const source = client.split('\n').find(line => line.trimStart().startsWith('function ' + name + '('));
  assert.ok(source, 'Actual helper exists: ' + name);
  return vm.runInNewContext(source.trim() + ';' + name + ';');
}

test('segment metrics distinguish unknown values from confirmed zero', () => {
  const metric = actualHelper('metricNumber');
  for (const value of [null, undefined, '', '0', false, -1, 0.5, NaN, Infinity]) assert.equal(metric(value), '—');
  assert.equal(metric(0), '0');
  assert.equal(metric(12), '12');
});

test('only a confirmed manual status is visible, and the newest revision of this segment wins', () => {
  const start=client.indexOf('const workStatusLabels='),end=client.indexOf('function mountWorkStatus(',start);
  assert.ok(start>=0&&end>start);
  const dashboard={items:[{id:'segment',workStatus:'working',workStatusRevision:0}]};
  const segmentDirectory={items:[{id:'other',workStatus:'stopped',workStatusRevision:9}]};
  const read=vm.runInNewContext(client.slice(start,end)+';segmentStatusItem',{dashboard,segmentDirectory});
  assert.equal(read('segment').workStatus,'working');
  const newer={id:'segment',workStatus:'paused',workStatusRevision:1};
  segmentDirectory.items.push(newer);
  assert.equal(read('segment'),newer);
  dashboard.items[0]={id:'segment',workStatus:'stopped',workStatusRevision:2};
  assert.equal(read('segment'),dashboard.items[0]);
  segmentDirectory.items=[];
  for(const item of [{id:'segment',overallStatus:'in_work'},{id:'segment',workStatus:'paused'},
      {id:'segment',workStatus:'__proto__',workStatusRevision:1}]) {
    dashboard.items=[item];
    assert.equal(read('segment'),undefined);
  }
});

test('timestamp-only refresh keeps the same segment content identity', () => {
  const key = actualHelper('segmentContentKey');
  const first = { state: 'ready', source: { id: 'source', name: 'Source' }, rulesConfigured: false,
    generatedAt: '2026-11-15T10:00:00Z', items: [{ id: 'segment', workStatus:'working', workStatusRevision:0 }] };
  assert.equal(key(first), key({ ...first, generatedAt: '2026-11-15T10:01:00Z' }));
  assert.notEqual(key(first), key({ ...first, items: [{ id: 'segment', workStatus:'paused', workStatusRevision:1 }] }));
  assert.notEqual(key(first), key({ ...first, state: 'source_missing' }));
});
