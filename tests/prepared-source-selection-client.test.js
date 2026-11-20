import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const client = readFileSync(new URL('../src/Client.html', import.meta.url), 'utf8');
const html = readFileSync(new URL('../src/Index.html', import.meta.url), 'utf8');

function actualFunction(name) {
  const start = client.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'Actual client function exists: ' + name);
  let depth = 0, quote = null, escaped = false;
  for (let index = client.indexOf('{', start); index < client.length; index++) {
    const character = client[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (['"', "'", '`'].includes(character)) { quote = character; continue; }
    if (character === '{') depth++;
    if (character === '}' && --depth === 0) return client.slice(start, index + 1);
  }
  throw new Error('Unclosed actual function: ' + name);
}

function guard() {
  const context = vm.createContext({});
  vm.runInContext(actualFunction('preparedCanConfirm'), context);
  return context.preparedCanConfirm;
}

const complete = () => ({
  selectedSheetId: 0, sourceSheetIds: [0, 7], previewSelectionKey: '[0,7]',
  preview: { sheetId: 0, sourceSheetIds: [0, 7], canConfirm: true, previewToken: 'selection-bound-snapshot' }
});

test('source selection has a separate checklist, summary and explicit non-submit recalculation control', () => {
  const control = id => {
    const found = (html.match(/<[a-z][^>]*>/gi) || []).filter(tag => new RegExp('\\bid=["\']' + id + '["\']').test(tag));
    assert.equal(found.length, 1, 'Exactly one control: ' + id);
    return found[0];
  };
  assert.match(control('br-prepared-source-fields'), /^<fieldset\b/);
  control('br-prepared-sources');
  control('br-prepared-source-summary');
  assert.match(control('br-prepared-recalculate'), /^<button\b/);
  assert.match(control('br-prepared-recalculate'), /\btype=["']button["']/);
  assert.ok(/preparedSource|prepared-source/.test(client), 'Source checklist is rendered by the client');
});

test('confirmation accepts only the source set whose preview completed', () => {
  const canConfirm = guard(), current = complete();
  assert.equal(canConfirm(current), true);
  assert.equal(canConfirm({ ...current, sourceSheetIds: [7, 0] }), true, 'Selection order has no meaning');
  assert.equal(canConfirm({ ...current, sourceSheetIds: [0] }), false, 'Deselecting a source invalidates the old preview');
  assert.equal(canConfirm({ ...current, previewSelectionKey: null }), false, 'A request without a matching completion cannot confirm');
  assert.equal(canConfirm({ ...current, previewSelectionKey: '[0]' }), false, 'Late completion from an older selection cannot confirm');
  assert.equal(canConfirm({ ...current, preview: { ...current.preview, sourceSheetIds: [0] } }), false, 'The server preview must describe the same source set');
  const { sourceSheetIds: omitted, ...legacyDto } = current.preview;
  assert.equal(canConfirm({ ...current, preview: legacyDto }), true,
    'A locally bound completion remains compatible with a legacy preview DTO');
});

test('empty, duplicate, invalid or excluded source selections cannot confirm', () => {
  const canConfirm = guard(), current = complete();
  for (const ids of [[], [0, 0, 7], [-1, 0], [0, 1.5], [0, '7'], [0, NaN], [0, Infinity]]) {
    assert.equal(canConfirm({ ...current, sourceSheetIds: ids, previewSelectionKey: JSON.stringify(ids) }), false);
  }
  assert.equal(canConfirm({ ...current, selectedSheetId: 9, preview: { ...current.preview, sheetId: 9 } }), false,
    'The displayed sample must belong to a selected source');
});

test('source selection preserves completeness and legacy confirmation guards', () => {
  const canConfirm = guard(), current = complete();
  for (const preview of [null, { ...current.preview, canConfirm: false }, { ...current.preview, sheetId: 7 },
    { ...current.preview, previewToken: null }]) {
    assert.equal(canConfirm({ ...current, preview }), false);
  }
  assert.equal(canConfirm(null), false);
  const legacy = { selectedSheetId: 0, preview: { sheetId: 0, canConfirm: true, previewToken: 'legacy-preview' } };
  assert.equal(canConfirm(legacy), true, 'A restored legacy preview still uses its existing guards');
  assert.equal(canConfirm({ ...legacy, preview: { ...legacy.preview, sheetId: 7 } }), false);
});
