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
  const propertyStore = { getProperty: key => properties.get(key) ?? null };
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
  const sources = ['Config.gs', 'Code.gs', 'Segments.gs'].map(name => readFileSync(`${sourceDir}${name}`, 'utf8')).join('\n');
  vm.runInContext(sources, context, { filename: 'segments-backend.gs' });
  installSharedApi(context, { accessKey: () => Object.hasOwn(options, 'accessKey') ? options.accessKey : TEST_ACCESS_KEY });
  return {
    context, driveCalls,
    build: (folders = [], files = []) => plain(context.buildSegments_({ properties: propertyStore }, registry, folders, files)),
  };
}

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
