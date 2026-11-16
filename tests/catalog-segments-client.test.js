import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const client = readFileSync(new URL('../src/Client.html', import.meta.url), 'utf8');
function source(name) {
  const start = client.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'Actual catalog helper exists: ' + name);
  let depth = 0, quote = null, escaped = false;
  for (let i = client.indexOf('{', start); i < client.length; i++) {
    const character = client[i];
    if (quote) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === quote) quote = null; continue; }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') depth++;
    if (character === '}' && --depth === 0) return client.slice(start, i + 1);
  }
  assert.fail('Complete function body is present: ' + name);
}
function helper(name) {
  const dependencies = ['normalizeContents', 'metricNumber'].filter(value => value !== name && client.includes('function ' + value + '('));
  return vm.runInNewContext(dependencies.map(source).join('\n') + '\n' + source(name) + ';' + name + ';', { URL });
}
const plain = value => JSON.parse(JSON.stringify(value));

test('catalog contents are explicit, canonical, and support one or both kinds', () => {
  const normalize = helper('normalizeContents');
  assert.deepEqual(Array.from(normalize(['lpr', 'companies', 'lpr'])), ['companies', 'lpr']);
  assert.deepEqual(Array.from(normalize(['companies'])), ['companies']);
  assert.deepEqual(Array.from(normalize(['lpr'])), ['lpr']);
  for (const value of [null, undefined, '', 'general', 'mixed', []]) assert.deepEqual(Array.from(normalize(value)), []);
  const label = helper('contentsLabel');
  assert.equal(label(['companies']), 'Компании');
  assert.equal(label(['lpr']), 'ЛПР');
  assert.equal(label(['lpr', 'companies']), 'Компании и ЛПР');
  assert.equal(label([]), 'Не указано');
  const criterion = helper('contentsCriterion');
  assert.match(criterion(['companies']), /1\s*строка\s*=\s*1\s*компания/u);
  assert.match(criterion(['lpr']), /1\s*строка\s*=\s*1\s*человек/u);
  assert.match(criterion(['companies', 'lpr']), /лист/iu);
});

test('only a server-authorized ready native source can enter a segment', () => {
  const ready = helper('readySource');
  const item = { canAddToSegment: true, status: 'ready', present: true, mimeType: 'application/vnd.google-apps.spreadsheet', contents: ['companies'], revision: 1 };
  assert.equal(ready(item), true);
  assert.equal(ready({ ...item, contents: ['companies', 'lpr'] }), true);
  for (const change of [{ canAddToSegment: false }, { canAddToSegment: undefined }, { status: 'collection' }, { status: 'rework' }, { present: false }, { mimeType: 'text/csv' }, { contents: [] }, { contents: null }, { revision: null }]) assert.equal(ready({ ...item, ...change }), false);
});

test('segment mapping copies only checked leaves and preserves a header-free choice', () => {
  const loads = helper('buildSegmentLoads');
  assert.deepEqual(plain(loads([])), []);
  const actual = loads([{ sourceId: 'source-one', revision: 7, contents: ['companies'], sheets: [
    { id: 0, included: true, target: 'companies', hasHeader: false },
    { id: 5, included: false, target: 'lpr', hasHeader: true },
    { id: 8, included: true, target: 'companies', hasHeader: true },
  ] }]);
  assert.deepEqual(plain(actual), [{ sourceId: 'source-one', expectedRevision: 7, sheets: [
    { sheetId: 0, target: 'companies', hasHeader: false },
    { sheetId: 8, target: 'companies', hasHeader: true },
  ] }]);
  const defaultHeader = loads([{ sourceId: 'source-one', revision: 7, contents: ['companies'], sheets: [
    { id: 0, included: true, target: 'companies' },
  ] }]);
  assert.equal(defaultHeader[0].sheets[0].hasHeader, true);
});

test('mixed sources require explicit per-leaf targets and cannot assign one leaf twice', () => {
  const loads = helper('buildSegmentLoads');
  const entry = { sourceId: 'source-one', revision: 7, contents: ['companies', 'lpr'], sheets: [
    { id: 0, included: true, target: '', hasHeader: true },
  ] };
  assert.throws(() => loads([entry]));
  assert.throws(() => loads([{ ...entry, contents: ['companies'], sheets: [{ id: 0, included: true, target: 'lpr', hasHeader: true }] }]));
  assert.throws(() => loads([{ ...entry, sheets: [
    { id: 0, included: true, target: 'companies', hasHeader: true },
    { id: 0, included: true, target: 'lpr', hasHeader: true },
  ] }]));
  assert.throws(() => loads([
    { ...entry, sheets: [{ id: 0, included: true, target: 'companies', hasHeader: true }] },
    { ...entry, sheets: [{ id: 0, included: true, target: 'lpr', hasHeader: true }] },
  ]));
  const distinct = loads([
    { ...entry, sheets: [{ id: 0, included: true, target: 'companies', hasHeader: true }] },
    { ...entry, sourceId: 'source-two', sheets: [{ id: 0, included: true, target: 'lpr', hasHeader: false }] },
  ]);
  assert.equal(distinct.length, 2);
  assert.equal(distinct[1].sheets[0].target, 'lpr');
  assert.equal(distinct[1].sheets[0].hasHeader, false);
});

test('disconnected mailing services never display invented numeric metrics', () => {
  const metric = helper('mailingMetric');
  for (const value of [null, undefined, 0, 5]) assert.equal(metric(value, false), '—');
  assert.equal(metric(null, true), '—');
  assert.equal(metric(0, true), '0');
  assert.equal(metric(12, true), '12');
});
