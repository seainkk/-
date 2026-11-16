import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const client = readFileSync(new URL('../src/Client.html', import.meta.url), 'utf8');
function source(name) {
  const start = client.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'Actual client helper exists: ' + name);
  let depth = 0, quote = null, escaped = false;
  for (let i = client.indexOf('{', start); i < client.length; i++) {
    const c = client[i];
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === String.fromCharCode(96)) { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return client.slice(start, i + 1);
  }
  assert.fail('Complete helper body exists: ' + name);
}
const names = ['normalizeContents', 'sourceAssociationsKnown', 'sourceSearchText', 'sourceFiltersActive', 'sourceMatchesFilters', 'sourceFilterSelection'];
const context = vm.createContext({});
vm.runInContext(names.map(source).join('\n'), context);
const data = {
  associationsAvailable: true,
  items: [
    { id: 'a', name: 'Партнёры Москвы', contents: ['companies'], present: true, segments: [], associationsAvailable: true, revision: 4 },
    { id: 'b', name: 'Партнеры региона', contents: ['companies', 'lpr'], present: true, segments: [{ id: 'segment' }], associationsAvailable: true },
    { id: 'c', name: 'ЛПР региона', contents: ['lpr'], present: true, segments: [], associationsAvailable: true },
    { id: 'd', name: 'ЛПР неизвестные', contents: ['lpr'], present: true, segments: null, associationsAvailable: false },
    { id: 'e', name: 'Ушедшая база', contents: ['companies'], present: false, segments: [] },
  ],
};
const selected = (filters = {}, drafts = []) => context.sourceFilterSelection(data, filters, drafts);
const ids = result => Array.from(result.items, item => item.id);

test('registry name search is trimmed, case-insensitive, literal and tolerant of ё', () => {
  assert.deepEqual(ids(selected({ query: '  ПАРТНЕРЫ ' })), ['a', 'b']);
  assert.deepEqual(ids(selected({ query: 'регион' })), ['b', 'c']);
  assert.deepEqual(ids(selected({ query: '.*' })), []);
  assert.deepEqual(ids(selected({ query: 'a' })), [], 'IDs and file URLs do not become titles');
  assert.equal(context.sourceFiltersActive({ query: '   ' }), false);
});

test('each contents filter includes mixed bases without guessing missing content', () => {
  assert.deepEqual(ids(selected({ contents: 'companies' })), ['a', 'b']);
  assert.deepEqual(ids(selected({ contents: 'lpr' })), ['b', 'c', 'd']);
  assert.deepEqual(ids(selected()), ['a', 'b', 'c', 'd']);
  assert.equal(context.sourceMatchesFilters(data, { name: 'Без наполнения', segments: [] }, { contents: 'companies' }), false);
});

test('only unassigned requires known associations and combines with name and content', () => {
  assert.deepEqual(ids(selected({ onlyUnassigned: true })), ['a', 'c']);
  assert.deepEqual(ids(selected({ query: 'регион', contents: 'lpr', onlyUnassigned: true })), ['c']);
  assert.deepEqual(ids(selected({ query: 'регион', contents: 'companies', onlyUnassigned: true })), []);
  const unavailable = { ...data, associationsAvailable: false };
  assert.deepEqual(Array.from(context.sourceFilterSelection(unavailable, { onlyUnassigned: true }).items), []);
});

test('drafts outside filters stay visible with separate counts and original order', () => {
  const before = JSON.stringify(data), drafts = new Map([['a', { expectedRevision: 4, values: { contents: ['lpr'] } }], ['e', { values: { status: 'ready' } }]]);
  const result = selected({ contents: 'lpr', onlyUnassigned: true }, drafts.keys());
  assert.deepEqual(ids(result), ['a', 'c', 'e']);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.totalCount, 4);
  assert.deepEqual(Array.from(result.pinnedIds), ['a', 'e']);
  assert.equal(JSON.stringify(data), before);
  assert.equal(drafts.get('a').expectedRevision, 4);
  assert.deepEqual(drafts.get('a').values.contents, ['lpr']);
  assert.equal(context.sourceMatchesFilters(data, data.items[0], { contents: 'companies' }), true, 'filtering uses persisted contents');
});

test('unavailable association count respects the other active filters', () => {
  assert.equal(selected({ onlyUnassigned: true }).unknownAssociations, 1);
  assert.equal(selected({ onlyUnassigned: true, contents: 'companies' }).unknownAssociations, 0);
  assert.equal(selected({ onlyUnassigned: true, query: 'неизвестные' }).unknownAssociations, 1);
  assert.equal(selected({ onlyUnassigned: false }).unknownAssociations, 0);
});

test('reset clears only the filters and reveals retained edits', () => {
  const elements = Object.fromEntries(['br-source-search', 'br-source-contents-filter', 'br-source-unassigned-filter'].map(id => [id, { value: 'previous', checked: true, focus() { this.focused = true; } }]));
  const filters = { query: 'список', contents: 'lpr', onlyUnassigned: true }, drafts = new Map([['draft', { expectedRevision: 2 }]]);
  const resetContext = vm.createContext({ sourceFilters: filters, sourceDrafts: drafts, $: id => elements[id], renderSources() {}, updateControls() {} });
  vm.runInContext(source('resetSourceFilters') + ';resetSourceFilters();', resetContext);
  assert.deepEqual(filters, { query: '', contents: '', onlyUnassigned: false });
  assert.equal(elements['br-source-search'].value, '');
  assert.equal(elements['br-source-unassigned-filter'].checked, false);
  assert.equal(elements['br-source-search'].focused, true);
  assert.equal(drafts.get('draft').expectedRevision, 2);
});

test('team entry requires both an administrator session and a confirmed server result', () => {
  const teamContext = vm.createContext({ bootstrap: { user: { isAdmin: true } }, teamData: { canManage: true, members: [] } });
  vm.runInContext(source('teamCanSubmit') + ';', teamContext);
  assert.equal(teamContext.teamCanSubmit(), true);
  teamContext.bootstrap.user.isAdmin = false;
  assert.equal(teamContext.teamCanSubmit(), false);
  teamContext.bootstrap.user.isAdmin = true;
  teamContext.teamData = null;
  assert.equal(teamContext.teamCanSubmit(), false);
  teamContext.teamData = { canManage: false, members: [] };
  assert.equal(teamContext.teamCanSubmit(), false);
});
