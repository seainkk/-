import { TEST_ACCESS_KEY, TEST_ACCESS_HASH, SHARED_ACTOR, installSharedApi, runShared } from './helpers/shared-link.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourceDir = fileURLToPath(new URL('../src/', import.meta.url));
const ROOT = '1WKcvDDKqYBo94eXsYc5vKp6OPtOzv6Wh';
const SOURCE = '1sQ8WrTgdEOPTPYLIwoBwHb6gL_ULT4yu';
const MEMBER = 'member@example.com';
const registry = { id: ROOT, name: 'Реестр баз' };
const folder = (id, name, parentId = ROOT) => ({ id, name, parentId });
const file = (id, name, parentId) => ({ id, name, parentId, url: `https://docs.google.com/spreadsheets/d/${id}/edit` });
const plain = value => JSON.parse(JSON.stringify(value));
const emptyIterator = () => ({ hasNext: () => false, next: () => { throw new Error('Empty iterator'); } });

function fixture(options = {}) {
  const properties = new Map(Object.entries({ ROOT_FOLDER_ID: ROOT, SHARED_ACCESS_KEY_SHA256: TEST_ACCESS_HASH, ALLOWED_EMAILS: MEMBER, ADMIN_EMAILS: MEMBER, ...options.properties }));
  const driveCalls = [];
  const propertyStore = { getProperty: key => properties.get(key) ?? null, getProperties: () => Object.fromEntries(properties), setProperty: (key, value) => properties.set(key, value) };
  const rootFolder = {
    getId: () => ROOT, getName: () => registry.name, isTrashed: () => false,
    getFolders: emptyIterator, getFilesByType: emptyIterator,
  };
  const context = vm.createContext({
    console,
    PropertiesService: { getScriptProperties: () => propertyStore },
    Session: {
      getActiveUser: () => ({ getEmail: () => options.activeEmail ?? MEMBER }),
      getEffectiveUser: () => ({ getEmail: () => options.effectiveEmail ?? options.activeEmail ?? MEMBER }),
    },
    DriveApp: {
      getFolderById: id => {
        driveCalls.push(id);
        if (id === ROOT && options.allowRootLookup) return rootFolder;
        throw new Error('Unexpected Drive lookup');
      },
      getFileById: id => { driveCalls.push(id); throw new Error('Unexpected file lookup'); },
    },
    SpreadsheetApp: { openById: () => { throw new Error('Segments must never read a spreadsheet'); } },
  });
  const sources = ['Config.gs', 'Code.gs', 'Segments.gs', 'RegistryProjects.gs'].map(name => readFileSync(`${sourceDir}${name}`, 'utf8')).join('\n');
  vm.runInContext(sources, context, { filename: 'segments-backend.gs' });
  installSharedApi(context, { accessKey: () => Object.hasOwn(options, 'accessKey') ? options.accessKey : TEST_ACCESS_KEY });
  return {
    context, driveCalls, propertyStore,
    build: (folders = [], files = []) => plain(context.buildSegments_({ properties: propertyStore }, registry, folders, files)),
  };
}

test('each project has its own partners and clients and can claim the same legacy segment only once', () => {
  const f = fixture(), ctx = { rootId: ROOT, properties: f.propertyStore };
  const studios = 'web_studios_segment_123', kitchens = 'kitchens_segment_123', neo = 'new_clients_segment_123';
  const folders = [folder(SOURCE, 'Аутричи'), folder(studios, 'Веб-студии', SOURCE), folder(kitchens, 'Кухни', SOURCE), folder(neo, 'Другие клиенты', SOURCE)];
  const build = () => plain(f.context.buildSegments_(ctx, registry, folders, [file('kitchens_book_123', 'Компании', kitchens)]));
  const project = id => { f.context.SHARED_REQUEST_SCOPE_ = { projectId: id }; };
  project('numshield');
  assert.deepEqual(build().unassigned.map(it => it.id).sort(), [studios, kitchens, neo].sort());
  f.context.registryAssignSegment_(ctx, studios);
  f.context.registryAssignSegment_(ctx, kitchens);
  assert.equal(f.context.registryAssignSegment_(ctx, kitchens), 'numshield');
  assert.deepEqual(build().items.map(it => [it.name, it.category, it.tableCount]), [['Веб-студии', 'partners', 0], ['Кухни', 'clients', 1]]);
  project('neosender');
  assert.deepEqual(build().items, []);
  assert.deepEqual(build().unassigned.map(it => it.id), [neo]);
  assert.throws(() => f.context.registryAssignSegment_(ctx, studios), /OUTSIDE_PROJECT/);
  assert.throws(() => f.context.registryRequireSegment_(ctx, kitchens), /OUTSIDE_PROJECT/);
  f.context.registryAssignSegment_(ctx, neo);
  assert.deepEqual(build().items.map(it => it.id), [neo]);
});

test('nested Drive operations resolve the real project and keep the shared catalog accessible', () => {
  const f = fixture(), ctx = { rootId: ROOT, properties: f.propertyStore };
  function node(id, parent, isFolder = true) {
    return { getId: () => id, isTrashed: () => false, ...(isFolder ? { getFolders: emptyIterator } : {}),
      getParents: () => { const list = parent ? [parent] : []; return { hasNext: () => !!list.length, next: () => list.shift() }; } };
  }
  const root = node(ROOT), source = node(SOURCE, root), shared = node('shared_source_file_123', root, false);
  const segment = node('kitchens_segment_123', source), sub = node('nested_folder_12345', segment), sheet = node('working_file_123456', sub, false);
  f.context.SHARED_REQUEST_SCOPE_ = { projectId: 'numshield' };
  f.context.segmentMetadataBinding_ = () => ({ state: 'ready', folder: source });
  f.context.registryAssignSegment_(ctx, segment.getId());
  assert.equal(f.context.registryGuardItem_(ctx, sheet), SOURCE);
  f.context.SHARED_REQUEST_SCOPE_ = { projectId: 'neosender' };
  for (const item of [segment, sub, sheet]) assert.throws(() => f.context.registryGuardItem_(ctx, item), /OUTSIDE_PROJECT/);
  assert.equal(f.context.registryGuardItem_(ctx, shared), SOURCE);
});

test('the bound default folder ID wins over names and does not require a matching label', () => {
  const f = fixture();
  const result = f.build([
    folder(SOURCE, 'Переименованная папка'),
    folder('other_outreach_1234567890', 'Аутричи'),
    folder('segment_a_1234567890', 'Сегмент A', SOURCE),
  ]);
  assert.equal(result.state, 'ready');
  assert.equal(result.source.id, SOURCE);
  assert.equal(result.source.name, 'Переименованная папка');
  assert.equal(result.items.length, 1);
  assert.equal(f.driveCalls.length, 0);
});

test('an explicit in-registry override takes precedence over the default binding', () => {
  const override = 'override_source_1234567890';
  const f = fixture({ properties: { SEGMENTS_FOLDER_ID: ` ${override} ` } });
  const result = f.build([
    folder(SOURCE, 'Аутричи'), folder(override, 'Другой источник'),
    folder('override_segment_1234567890', 'Сегмент B', override),
  ]);
  assert.equal(result.state, 'ready');
  assert.equal(result.source.id, override);
  assert.equal(result.items[0].id, 'override_segment_1234567890');
});

test('an explicit outside ID is never resolved or leaked', () => {
  const outside = 'outside_source_1234567890';
  const f = fixture({ properties: { SEGMENTS_FOLDER_ID: outside } });
  const result = f.build([folder(SOURCE, 'Аутричи')]);
  assert.equal(result.state, 'source_outside_registry');
  assert.equal(result.source, null);
  assert.deepEqual(result.items, []);
  assert.ok(!JSON.stringify(result).includes(outside));
  assert.deepEqual(f.driveCalls, []);
});

test('a missing source produces an explicit empty state without fabricating segments', () => {
  const result = fixture().build([folder('unrelated_folder_1234567890', 'Продажи')]);
  assert.equal(result.state, 'source_missing');
  assert.equal(result.source, null);
  assert.equal(result.rulesConfigured, false);
  assert.deepEqual(result.items, []);
});

test('name fallback accepts a single normalized root-level Аутричи folder', () => {
  const result = fixture().build([folder('fallback_source_1234567890', '  АУТРИЧИ  ')]);
  assert.equal(result.state, 'ready');
  assert.equal(result.source.id, 'fallback_source_1234567890');
});

test('ambiguous root-level name fallback refuses to guess', () => {
  const result = fixture().build([
    folder('first_source_1234567890', 'Аутричи'), folder('second_source_1234567890', ' аутричи '),
  ]);
  assert.equal(result.state, 'source_ambiguous');
  assert.equal(result.source, null);
  assert.deepEqual(result.items, []);
});

test('a nested folder with the fallback name does not become the source', () => {
  const parent = 'other_parent_1234567890';
  const result = fixture().build([
    folder(parent, 'Операции'), folder('nested_outreach_1234567890', 'Аутричи', parent),
  ]);
  assert.equal(result.state, 'source_missing');
  assert.deepEqual(result.items, []);
});

test('segments are direct child folders; deeper tables are deduplicated into their parent segment', () => {
  const segment = 'segment_a_1234567890', empty = 'empty_segment_1234567890', deep = 'deep_folder_1234567890';
  const result = fixture().build([
    folder(SOURCE, 'Аутричи'), folder(segment, 'Сегмент A', SOURCE),
    folder(empty, 'Пустой сегмент', SOURCE), folder(deep, 'Email', segment),
  ], [
    file('source_sheet_1234567890', 'На уровне источника', SOURCE),
    file('segment_sheet_1234567890', 'Компании', segment),
    file('deep_sheet_1234567890', 'Email 25 компаний', deep),
    file('deep_sheet_1234567890', 'Email 25 компаний', deep),
    file('unrelated_sheet_1234567890', 'Другая база', ROOT),
  ]);
  assert.equal(result.state, 'ready');
  assert.equal(result.items.length, 2);
  const item = result.items.find(item => item.id === segment);
  assert.equal(item.tableCount, 2);
  assert.deepEqual(item.files.map(file => file.id).sort(), ['deep_sheet_1234567890', 'segment_sheet_1234567890'].sort());
  assert.deepEqual(item.folderIds.sort(), [segment, deep].sort());
  assert.equal(result.items.some(item => item.id === deep), false);
  const emptyItem = result.items.find(item => item.id === empty);
  assert.equal(emptyItem.tableCount, 0);
  assert.deepEqual(emptyItem.files, []);
  assert.equal(emptyItem.companiesInWork, null);
  for (const channel of Object.values(emptyItem.channels)) assert.deepEqual(channel, { state: 'inactive', inWork: null, configured: false });
});

test('channels stay inactive without launch rules even with channel-like table names', () => {
  const segment = 'segment_a_1234567890';
  const result = fixture().build([folder(SOURCE, 'Аутричи'), folder(segment, 'Активный сегмент', SOURCE)], [
    file('email_sheet_1234567890', 'Email — 100 в работе', segment),
    file('telegram_sheet_1234567890', 'Telegram — готово', segment),
  ]);
  const item = result.items[0];
  assert.equal(result.rulesConfigured, false);
  for (const channel of ['email', 'telegram', 'retargeting']) {
    assert.deepEqual(item.channels[channel], { state: 'inactive', inWork: null, configured: false });
    assert.notEqual(item.channels[channel].inWork, 0);
  }
  assert.equal(item.overallStatus, null);
  assert.equal(item.companiesInWork, null);
});

test('segment payloads have serializable timestamps and metadata-only links', () => {
  const segment = 'segment_a_1234567890';
  const result = fixture().build([folder(SOURCE, 'Аутричи'), folder(segment, 'Сегмент', SOURCE)], [
    file('metadata_sheet_1234567890', 'Компании', segment),
  ]);
  assert.equal(typeof result.generatedAt, 'string');
  assert.match(result.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(!Number.isNaN(Date.parse(result.generatedAt)));
  assert.deepEqual(Object.keys(result.items[0].files[0]).sort(), ['id', 'name', 'url']);
  assert.equal(result.items[0].files[0].url, 'https://docs.google.com/spreadsheets/d/metadata_sheet_1234567890/edit');
  assert.equal(JSON.parse(JSON.stringify(result)).generatedAt, result.generatedAt);
});

test('segment category prefers an explicit ID assignment and falls back to the legacy studio name', () => {
  const assigned = 'assigned_segment_1234567890';
  const f = fixture({ properties: { ['SEGMENT_CATEGORY_' + assigned]: JSON.stringify({ category: 'clients' }) } });
  const names = ['Веб-студии', '  ВЕБ — СТУДИИ ', 'Веб студии', 'Кухни', 'Веб-студии 2'];
  const folders = names.map((name, index) => folder('segment_category_' + index, name, SOURCE));
  const result = f.build([folder(SOURCE, 'Аутричи'), ...folders, folder(assigned, 'Веб-студии', SOURCE)]);
  const categoryById = Object.fromEntries(result.items.map(item => [item.id, item.category]));
  assert.equal(categoryById[assigned], 'clients');
  assert.deepEqual(folders.map(item => categoryById[item.id]), ['partners', 'partners', 'partners', 'clients', 'clients']);
  assert.deepEqual(f.driveCalls, []);
});

test('bootstrap authorizes the caller before any Drive lookup, including a configured outside source', () => {
  for (const options of [
    { accessKey: null, properties: { SEGMENTS_FOLDER_ID: 'outside_source_1234567890' } },
    { accessKey: 'wrong', properties: { SEGMENTS_FOLDER_ID: 'outside_source_1234567890' } },
    { accessKey: 'a'.repeat(43), properties: { SEGMENTS_FOLDER_ID: 'outside_source_1234567890' } },
  ]) {
    const f = fixture(options);
    assert.throws(() => f.context.getBootstrap());
    assert.deepEqual(f.driveCalls, []);
  }
});

test('authorized bootstrap reads only the registry tree and never looks up an outside segments source', () => {
  const outside = 'outside_source_1234567890';
  const f = fixture({ allowRootLookup: true, properties: { SEGMENTS_FOLDER_ID: outside } });
  const result = plain(f.context.getBootstrap());
  assert.equal(result.segments.state, 'source_outside_registry');
  assert.equal(result.segments.source, null);
  assert.deepEqual(f.driveCalls, [ROOT]);
});

test('segment projection adds no public RPC or cell-reading API', () => {
  const source = readFileSync(`${sourceDir}Segments.gs`, 'utf8');
  const functions = [...source.matchAll(/^function\s+([A-Za-z0-9_]+)\s*\(/gm)].map(match => match[1]);
  assert.ok(functions.length > 0);
  assert.ok(functions.every(name => name.endsWith('_')));
  assert.doesNotMatch(source, /SpreadsheetApp\.|DriveApp\.|\.getRange\s*\(|\.getValues\s*\(|\.getSheets\s*\(/);
});
