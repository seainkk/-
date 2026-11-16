import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const client = readFileSync(new URL('../src/Client.html', import.meta.url), 'utf8');
function helper(name) {
  const line = client.split('\n').find(value => value.trimStart().startsWith('function ' + name + '('));
  assert.ok(line, 'Actual import helper exists: ' + name);
  return vm.runInNewContext(line.trim() + ';' + name + ';', { URL });
}

test('supported import files have a bounded nonempty binary payload', () => {
  const invalid = helper('importFileError');
  for (const name of ['base.csv', 'base.TSV', 'base.xls', 'base.xlsx', 'base.ods']) assert.equal(invalid({ name, size: 1 }), null);
  assert.equal(invalid({ name: 'base.csv', size: 10 * 1024 * 1024 }), null);
  for (const file of [null, { name: 'base.txt', size: 1 }, { name: 'base.csv', size: 0 }, { name: 'base.csv', size: 10 * 1024 * 1024 + 1 }]) assert.equal(typeof invalid(file), 'string');
});

test('link imports accept original Google Sheets links and preserve no foreign URL', () => {
  const id = helper('importLinkId');
  assert.equal(id('https://docs.google.com/spreadsheets/d/source_123456/edit?resourcekey=test'), 'source_123456');
  assert.equal(id('https://docs.google.com/spreadsheets/u/0/d/source_123456/edit'), 'source_123456');
  for (const value of ['https://docs.google.com/spreadsheets/d/e/published/edit', 'https://docs.google.com.evil.invalid/spreadsheets/d/source_123456/edit', 'http://docs.google.com/spreadsheets/d/source_123456/edit', 'https://user@docs.google.com/spreadsheets/d/source_123456/edit', 'javascript:alert(1)']) assert.equal(id(value), null);
});

test('the retry fingerprint changes only when import intent or selected file changes', () => {
  const key = helper('importFingerprint');
  const fields = { name: 'База', baseType: 'general', status: 'collection' };
  const file = { name: 'base.csv', size: 12, type: 'text/csv', lastModified: 123 };
  assert.equal(key('file', fields, file, 1), key('file', { ...fields }, { ...file }, 1));
  for (const change of [{ name: 'Другая база' }, { baseType: 'lpr' }, { status: 'ready' }]) assert.notEqual(key('file', fields, file, 1), key('file', { ...fields, ...change }, file, 1));
  assert.notEqual(key('file', fields, file, 1), key('file', fields, file, 2));
  const link = { ...fields, url: 'https://docs.google.com/spreadsheets/d/source_123456/edit', mode: 'copy' };
  assert.notEqual(key('link', link), key('link', { ...link, mode: 'move' }));
});

test('an uncertain import recovery link becomes only a canonical native Sheets ID', () => {
  const recovery = helper('importRecoveryId');
  assert.equal(recovery('Проверьте: https://docs.google.com/spreadsheets/d/source_123456/edit'), 'source_123456');
  assert.equal(recovery('https://docs.google.com.evil.invalid/spreadsheets/d/source_123456/edit'), null);
  assert.equal(recovery('javascript:alert(1)'), null);
});

test('changing source type resets the manual mark until an explicit later check', () => {
  const change = helper('sourceDraftChange');
  const item = { revision: 7, baseType: 'general', formatCheck: 'valid', status: 'collection' };
  const switched = change(item, null, 'baseType', 'lpr');
  assert.equal(switched.values.baseType, 'lpr');
  assert.equal(switched.values.formatCheck, 'unchecked');
  const checked = change(item, switched, 'formatCheck', 'valid');
  assert.equal(checked.values.formatCheck, 'valid');
  assert.equal(checked.expectedRevision, 7);
  assert.equal(switched.values.formatCheck, 'unchecked');
  assert.equal(helper('sourceTypeCriterion')('lpr'), '1 строка = 1 человек (контакты одного человека).');
  assert.equal(helper('sourceTypeLabel')('general'), 'Общая');
});
