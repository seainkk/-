import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const client = readFileSync(new URL('../src/Client.html', import.meta.url), 'utf8');
function source(name) {
  const start = client.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'Actual import helper exists: ' + name);
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
  const dependencies = ['normalizeContents'].filter(value => value !== name && client.includes('function ' + value + '('));
  return vm.runInNewContext(dependencies.map(source).join('\n') + '\n' + source(name) + ';' + name + ';', { URL });
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
  const fields = { name: 'База', contents: ['companies'], status: 'collection' };
  const file = { name: 'base.csv', size: 12, type: 'text/csv', lastModified: 123 };
  assert.equal(key('file', fields, file, 1), key('file', { ...fields }, { ...file }, 1));
  for (const change of [{ name: 'Другая база' }, { contents: ['lpr'] }, { contents: ['companies', 'lpr'] }, { status: 'ready' }]) assert.notEqual(key('file', fields, file, 1), key('file', { ...fields, ...change }, file, 1));
  assert.notEqual(key('file', fields, file, 1), key('file', fields, file, 2));
  const link = { ...fields, url: 'https://docs.google.com/spreadsheets/d/source_123456/edit', mode: 'copy' };
  assert.notEqual(key('link', link), key('link', { ...link, mode: 'move' }));
  assert.equal(key('file', { ...fields, contents: ['companies', 'lpr'] }, file, 1), key('file', { ...fields, contents: ['lpr', 'companies'] }, file, 1));
});

test('an uncertain import recovery link becomes only a canonical native Sheets ID', () => {
  const recovery = helper('importRecoveryId');
  assert.equal(recovery('Проверьте: https://docs.google.com/spreadsheets/d/source_123456/edit'), 'source_123456');
  assert.equal(recovery('https://docs.google.com.evil.invalid/spreadsheets/d/source_123456/edit'), null);
  assert.equal(recovery('javascript:alert(1)'), null);
});

test('changing source contents resets the manual mark until an explicit later check', () => {
  const change = helper('sourceDraftChange');
  const item = { revision: 7, contents: ['companies'], formatCheck: 'valid', status: 'collection' };
  const switched = change(item, null, 'contents', ['companies', 'lpr']);
  assert.deepEqual(Array.from(switched.values.contents), ['companies', 'lpr']);
  assert.equal(switched.values.formatCheck, 'unchecked');
  const checked = change(item, switched, 'formatCheck', 'valid');
  assert.equal(checked.values.formatCheck, 'valid');
  assert.equal(checked.expectedRevision, 7);
  assert.equal(switched.values.formatCheck, 'unchecked');
  assert.match(helper('contentsCriterion')(['lpr']), /1\s*строка\s*=\s*1\s*человек/u);
  assert.equal(helper('contentsLabel')(['companies']), 'Компании');
});

test('the live file form has only the agreed Blob-transfer field names', () => {
  const index = readFileSync(new URL('../src/Index.html', import.meta.url), 'utf8');
  const form = index.match(/<form\b[^>]*\bid="br-import-file-form"[^>]*>[\s\S]*?<\/form>/);
  assert.ok(form, 'The actual import file form is present');
  const names = Array.from(form[0].matchAll(/\bname="([^"]+)"/g), match => match[1]).sort();
  assert.deepEqual(names, ['contentsJSON', 'file', 'name', 'requestId', 'status']);
});
