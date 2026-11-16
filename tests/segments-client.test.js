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

test('only approved actual channel states receive channel labels and indicators', () => {
  const status = actualHelper('channelStatus');
  assert.equal(status('active').id, 'active');
  assert.equal(status('active').label, 'В работе');
  assert.equal(status('inactive').id, 'inactive');
  assert.equal(status('inactive').label, 'Не запущен');
  for (const value of [null, undefined, 'unknown', 'unexpected', '__proto__']) {
    assert.equal(status(value).id, 'unknown');
    assert.equal(status(value).mark, '—');
  }
});

test('unknown overall status never becomes a business status', () => {
  const status = actualHelper('segmentStatus');
  for (const value of [null, undefined, 0, '', 'unexpected', '__proto__']) {
    assert.equal(status(value).id, 'unknown');
    assert.equal(status(value).label, 'Статус ещё не определён');
  }
  assert.equal(status('in_work').label, 'В работе');
  assert.equal(status('preparation').label, 'Подготовка');
  assert.equal(status('no_contacts').label, 'Нет контактов');
});

test('timestamp-only refresh keeps the same segment content identity', () => {
  const key = actualHelper('segmentContentKey');
  const first = { state: 'ready', source: { id: 'source', name: 'Source' }, rulesConfigured: false,
    generatedAt: '2026-11-15T10:00:00Z', items: [{ id: 'segment', companiesInWork: null }] };
  assert.equal(key(first), key({ ...first, generatedAt: '2026-11-15T10:01:00Z' }));
  assert.notEqual(key(first), key({ ...first, items: [{ id: 'segment', companiesInWork: 0 }] }));
  assert.notEqual(key(first), key({ ...first, state: 'source_missing' }));
});
