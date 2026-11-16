import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const client = readFileSync(new URL('../src/Client.html', import.meta.url), 'utf8');
function source(name) {
  const start = client.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'Actual source helper exists: ' + name);
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
  return vm.runInNewContext(dependencies.map(source).join('\n') + '\n' + source(name) + ';' + name + ';');
}

test('source workflow and manual format checks have independent explicit labels', () => {
  const status = helper('sourceStatusLabel'), check = helper('sourceCheckLabel');
  assert.equal(status('collection'), 'Сбор');
  assert.equal(status('ready'), 'Готова');
  assert.equal(status('rework'), 'Доработка');
  assert.equal(check('unchecked'), 'Не проверено');
  assert.equal(check('valid'), 'Корректно');
  assert.equal(check('invalid'), 'Некорректно');
  for (const value of [null, undefined, '', '__proto__', 'unexpected']) {
    assert.equal(status(value), 'Недоступно');
    assert.equal(check(value), 'Недоступно');
  }
});

test('native Sheets keep their native format and fixed original-file destination', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(source('nativeUrl') + '\n' + source('sourceFormatLabel') + '\n' + source('sourceFileUrl'), context);
  const native = { id: 'sheet-id', name: 'Без расширения', mimeType: 'application/vnd.google-apps.spreadsheet', format: 'unexpected' };
  assert.equal(context.sourceFormatLabel(native), 'Google Таблица');
  assert.equal(context.sourceFileUrl(native), 'https://docs.google.com/spreadsheets/d/sheet-id/edit');
  const csv = { id: 'csv" /?#', mimeType: 'text/csv', format: 'CSV', url: 'https://untrusted.invalid/' };
  assert.equal(context.sourceFormatLabel(csv), 'CSV');
  assert.equal(context.sourceFileUrl(csv), 'https://drive.google.com/file/d/csv%22%20%2F%3F%23/view');
  assert.equal(context.sourceFormatLabel({ mimeType: 'application/octet-stream' }), 'Файл');
  const document = { id: 'document-id', mimeType: 'application/vnd.google-apps.document', url: 'https://docs.google.com/document/d/document-id/edit?usp=drivesdk' };
  assert.equal(context.sourceFileUrl(document), document.url);
  assert.equal(context.sourceFileUrl({ ...document, url: 'https://docs.google.com.evil.invalid/document/d/document-id/edit' }), 'https://drive.google.com/file/d/document-id/view');
  assert.equal(context.sourceFileUrl({ ...document, url: 'javascript:alert(1)' }), 'https://drive.google.com/file/d/document-id/view');
});

test('missing storage or a missing revision never enables source metadata edits', () => {
  const editable = helper('sourceCanEdit');
  assert.equal(editable({ canEdit: true }, { revision: 1, present: true }), true);
  for (const revision of [null, undefined, '1', -1, NaN]) assert.equal(editable({ canEdit: true }, { revision }), false);
  assert.equal(editable({ canEdit: false }, { revision: 1 }), false);
  assert.equal(editable({ canEdit: true }, { revision: 1, present: false }), false);
  assert.equal(editable({ canEdit: true }, { revision: 1, canEdit: false }), false);
});

test('refresh cannot silently replace the edit revision or add unedited fields', () => {
  const patch = helper('sourcePatch');
  const refreshedItem = { id: 'source-id', revision: 2, status: 'rework', formatCheck: 'valid', contents: ['companies'] };
  const draft = { expectedRevision: 1, values: { status: 'ready', unexpected: 'ignored' } };
  const pending = patch(refreshedItem, draft, false);
  assert.equal(pending.expectedRevision, 1);
  assert.equal(pending.status, 'ready');
  assert.equal(Object.hasOwn(pending, 'formatCheck'), false);
  assert.equal(Object.hasOwn(pending, 'unexpected'), false);
  assert.equal(patch(refreshedItem, draft, true).expectedRevision, 2);
  assert.equal(draft.expectedRevision, 1);
  const contentsPatch = patch(refreshedItem, { expectedRevision: 1, values: { contents: ['companies', 'lpr'], formatCheck: 'unchecked' } }, false);
  assert.deepEqual(Array.from(contentsPatch.contents), ['companies', 'lpr']);
  assert.equal(contentsPatch.formatCheck, 'unchecked');
});

test('unknown associations never appear as a confirmed empty segment list', () => {
  const known = helper('sourceAssociationsKnown');
  assert.equal(known({ associationsAvailable: true }, { associationsAvailable: true, segments: [] }), true);
  assert.equal(known({ associationsAvailable: true }, { segments: null }), false);
  assert.equal(known({ associationsAvailable: false }, { segments: [] }), false);
  assert.equal(known({ associationsAvailable: true }, { associationsAvailable: false, segments: [] }), false);
});
