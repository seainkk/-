import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const client = readFileSync(new URL('../src/Client.html', import.meta.url), 'utf8');
function source(name) {
  const at = client.indexOf('function ' + name + '(');
  assert.ok(at >= 0);
  const start = client.lastIndexOf('async ', at) === at - 6 ? at - 6 : at;
  let depth = 0, quote = null, escaped = false;
  for (let i = client.indexOf('{', at); i < client.length; i++) {
    const c = client[i];
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return client.slice(start, i + 1);
  }
  assert.fail('Complete function: ' + name);
}

test('contact preview permits native source reads independently of collection status', () => {
  const can = vm.runInNewContext(source('canPreviewContacts') + ';canPreviewContacts;');
  assert.equal(can({ mimeType: 'application/vnd.google-apps.spreadsheet', status: 'collection' }), true);
  assert.equal(can({ mimeType: 'application/vnd.google-apps.spreadsheet', present: false }), false);
  for (const value of [null, {}, { mimeType: 'text/csv' }]) assert.equal(can(value), false);
});

test('manual-review links use canonical source file, sheet and positive row only', () => {
  const url = vm.runInNewContext(source('nativeUrl') + '\n' + source('contactPreviewSourceUrl') + ';contactPreviewSourceUrl;');
  const base = 'https://docs.google.com/spreadsheets/d/source_123456/edit';
  assert.equal(url('source_123456', { sheetId: 0, row: 2 }), base + '#gid=0&range=A2');
  assert.equal(url('source_123456', { sheetId: 10, row: -1 }), base + '#gid=10');
  assert.equal(url('source_123456', { sheetId: 'javascript:alert(1)', row: 1, url: 'https://evil.invalid' }), base);
  assert.equal(url('source_123456', { sheetId: 0, row: '1&other=2' }), base + '#gid=0');
  assert.equal(url('source_123456', { fileId: 'center_123456', sheetId: 20, row: 9 }), 'https://docs.google.com/spreadsheets/d/center_123456/edit#gid=20&range=A9');
  assert.equal(url('source_123456', { fileId: 'https://evil.invalid', sheetId: 0, row: 2 }), base + '#gid=0&range=A2');
});

test('combined counters take precedence including zero, unavailable combined counters preserve source counts', () => {
  const count = vm.runInNewContext(source('contactPreviewCount') + ';contactPreviewCount;');
  assert.equal(count({ multiCompany: 1, multiCompanyCombined: 3 }, 'multiCompanyCombined', 'multiCompany'), 3);
  assert.equal(count({ multiCompany: 1, multiCompanyCombined: 0 }, 'multiCompanyCombined', 'multiCompany'), 0);
  assert.equal(count({ multiCompany: 1, multiCompanyCombined: null }, 'multiCompanyCombined', 'multiCompany'), 1);
  assert.equal(count({ total: 2 }, 'totalCombined', 'total'), 2);
  assert.equal(count({ total: 739, totalCombined: null }, 'totalCombined', 'total'), 739);
  for (const value of [-1, 1.5, Infinity, '3']) assert.equal(count({ total: 2, totalCombined: value }, 'totalCombined', 'total'), 2);
});

function analysisFixture() {
  let resolve, reject;
  const calls = [];
  const first = { source: { id: 'first-source' }, queued: true, loading: false, epoch: 1 };
  const context = vm.createContext({
    contactPreview: first, contactPreviewEpoch: 1, accessReady: true,
    requesting: () => false, renderContactPreview() {}, updateControls() {}, flushPendingView() {},
    failure: error => ({ message: error.message }),
    rpc(name, payload) { calls.push({ name, payload }); return new Promise((yes, no) => { resolve = yes; reject = no; }); },
  });
  vm.runInContext(source('runContactPreview'), context);
  return { context, first, calls, resolve: value => resolve(value), reject: error => reject(error) };
}

test('a queued contact analysis dispatches once and cannot replace a newer preview', async () => {
  const f = analysisFixture(), pending = f.context.runContactPreview();
  await f.context.runContactPreview();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].name, 'previewSourceBaseContacts');
  assert.equal(f.calls[0].payload.id, 'first-source');
  const next = { source: { id: 'next-source' }, queued: true, loading: false, epoch: 2, data: null };
  f.context.contactPreview = next; f.context.contactPreviewEpoch = 2;
  f.resolve({ state: 'ready', companies: { unique: 9 } }); await pending;
  assert.equal(f.context.contactPreview, next);
  assert.equal(next.data, null);
});

test('closing or revoking access during analysis discards its late private result', async () => {
  const f = analysisFixture(), pending = f.context.runContactPreview();
  f.context.accessReady = false; f.context.contactPreview = null; f.context.contactPreviewEpoch++;
  f.resolve({ state: 'ready', conflicts: { items: [{ value: 'private@example.test' }] } }); await pending;
  assert.equal(f.context.contactPreview, null);
  assert.equal(f.first.data, undefined);
});

test('a preview failure stays local to analysis after an acknowledged import', async () => {
  const f = analysisFixture(), pending = f.context.runContactPreview();
  f.reject(new Error('Temporary read error')); await pending;
  assert.equal(f.first.error, 'Temporary read error');
  assert.equal(f.first.loading, false);
  assert.equal(f.first.data, undefined);
});
