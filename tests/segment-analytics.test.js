import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourceDir = fileURLToPath(new URL('../src/', import.meta.url));
const ROOT = 'registry_root_1234567890';
const SOURCE = 'outreach_source_1234567890';
const SEGMENT = 'segment_folder_1234567890';
const SERVICE = 'metadata_service_1234567890';
const MEMBER = 'member@example.com';
const MIME = 'application/vnd.google-apps.spreadsheet';
const plain = value => JSON.parse(JSON.stringify(value));
const iterator = values => { let index = 0; return { hasNext: () => index < values.length, next: () => values[index++] }; };

function fixture(options = {}) {
  const calls = { folders: [], files: [], opened: [], ranges: [], tracking: [], rootFileScans: 0 };
  const propertyValues = new Map(Object.entries({ ROOT_FOLDER_ID: ROOT, SEGMENTS_FOLDER_ID: SOURCE, SOURCE_BASES_STORAGE_ID: SERVICE, ALLOWED_EMAILS: MEMBER, ADMIN_EMAILS: MEMBER, ...options.properties }));
  const propertyStore = { getProperty: key => propertyValues.get(key) ?? null };
  const folderRows = [
    { id: ROOT, name: 'Реестр баз', parents: [] },
    { id: SOURCE, name: 'Аутричи', parents: [ROOT] },
    { id: SEGMENT, name: 'Сегмент', parents: [SOURCE] },
    ...(options.folders || []),
  ];
  const files = options.files || [];
  const folderMap = new Map();
  const fileMap = new Map();
  for (const row of folderRows) folderMap.set(row.id, {
    getId: () => row.id, getName: () => row.name, isTrashed: () => !!row.trashed,
    getParents: () => iterator((row.actualParents || row.parents).map(id => folderMap.get(id)).filter(Boolean)),
    getFolders: () => iterator(folderRows.filter(child => child.parents.includes(row.id)).map(child => folderMap.get(child.id))),
    getFilesByType: () => {
      if (row.id === ROOT) { calls.rootFileScans++; throw new Error('Must not enumerate unrelated root/source bases'); }
      return iterator(files.filter(file => file.parents.includes(row.id) && (file.mime || MIME) === MIME).map(file => fileMap.get(file.id)));
    },
  });
  for (const row of files) fileMap.set(row.id, {
    getId: () => row.id, getName: () => row.name || row.id, getMimeType: () => row.mime || MIME, isTrashed: () => !!row.trashed,
    getParents: () => iterator((row.actualParents || row.parents).map(id => folderMap.get(id)).filter(Boolean)),
  });
  const context = vm.createContext({
    console,
    PropertiesService: { getScriptProperties: () => propertyStore },
    Session: {
      getActiveUser: () => ({ getEmail: () => options.activeEmail ?? MEMBER }),
      getEffectiveUser: () => ({ getEmail: () => options.effectiveEmail ?? options.activeEmail ?? MEMBER }),
    },
    DriveApp: {
      getFolderById: id => { calls.folders.push(id); if (!folderMap.has(id)) throw new Error('Folder missing'); return folderMap.get(id); },
      getFileById: id => { calls.files.push(id); if (!fileMap.has(id)) throw new Error('File missing'); return fileMap.get(id); },
    },
    SpreadsheetApp: {
      openById: id => {
        calls.opened.push(id);
        const file = files.find(file => file.id === id);
        if (!file || file.unreadable) throw new Error('Cannot open');
        return { getSheets: () => (file.sheets || []).map((sheet, index) => ({
          getSheetId: () => sheet.id ?? index,
          getLastRow: () => sheet.lastRow ?? sheet.rows?.length ?? 0,
          getLastColumn: () => sheet.lastColumn ?? Math.max(0, ...(sheet.rows || []).map(row => row.length)),
          getRange: (row, column, rowCount, columnCount) => {
            calls.ranges.push({ fileId: id, sheetId: sheet.id ?? index, row, column, rowCount, columnCount });
            if (sheet.unreadable) throw new Error('Cannot read');
            return { getDisplayValues: () => Array.from({ length: rowCount }, (_, r) => Array.from({ length: columnCount }, (_, c) => sheet.rows?.[row - 1 + r]?.[column - 1 + c] ?? '')) };
          },
        })) };
      },
    },
  });
  const sources = ['Config.gs', 'Code.gs', 'Segments.gs', 'SegmentAnalytics.gs'].map(name => readFileSync(`${sourceDir}${name}`, 'utf8')).join('\n');
  vm.runInContext(sources, context, { filename: 'segment-analytics.gs' });
  context.segmentReadTracking_ = (_context, segmentId) => {
    calls.tracking.push(segmentId);
    if (options.trackingThrows) throw new Error('Tracking unavailable');
    return options.tracking || { available: true, tables: [], loads: [] };
  };
  if (options.limits) context.REGISTRY_CONFIG = Object.freeze({ ...context.REGISTRY_CONFIG, ...options.limits });
  return { context, calls, dashboard: () => plain(context.getSegmentsDashboard()), mailings: id => plain(context.getSegmentMailings({ segmentId: id ?? SEGMENT })) };
}

function sourceFile(id = 'business_sheet_1234567890', sheets = [], extra = {}) {
  return { id, name: id, parents: [SEGMENT], sheets, ...extra };
}

function headers(fileId, sheetId, hasHeader, extra = {}) {
  return { available: true, tables: [], loads: [{ targetFileId: fileId, targetSheetId: sheetId, hasHeader, stage: 'complete', ...extra }] };
}

test('dashboard and mailings authorize before Drive or spreadsheet reads', () => {
  for (const options of [{ properties: { ALLOWED_EMAILS: '' } }, { activeEmail: 'outsider@example.com' }, { activeEmail: '', effectiveEmail: MEMBER }]) {
    const f = fixture(options);
    assert.throws(() => f.context.getSegmentsDashboard());
    assert.throws(() => f.context.getSegmentMailings({ segmentId: SEGMENT }));
    assert.deepEqual(f.calls.folders, []);
    assert.deepEqual(f.calls.opened, []);
  }
});

test('outreach metadata excludes the unrelated root/source catalog and service book', () => {
  const f = fixture({ files: [sourceFile(SERVICE), sourceFile('business_sheet_1234567890')], folders: [{ id: 'catalog_folder_1234567890', name: 'Исходные базы', parents: [ROOT] }] });
  const metadata = plain(f.context.getSegmentsMetadata_());
  assert.equal(metadata.items.length, 1);
  assert.equal(metadata.items[0].tableCount, 1);
  assert.equal(metadata.items[0].files[0].id, 'business_sheet_1234567890');
  assert.equal(f.calls.rootFileScans, 0);
  assert.deepEqual(f.calls.opened, []);
});

test('empty folders and physically blank default sheets have no contacts', () => {
  for (const files of [[], [sourceFile(undefined, [{ id: 4, rows: [] }])]]) {
    const f = fixture({ files });
    const item = f.dashboard().items[0];
    assert.equal(item.overallStatus, 'no_contacts');
    assert.equal(item.contactPresence, 'empty');
    assert.deepEqual(item.analysis, { state: 'ready', hasContacts: false, warnings: [] });
    assert.deepEqual(f.calls.ranges, []);
  }
});

test('an explicitly marked header-only sheet is empty', () => {
  const file = sourceFile(undefined, [{ id: 6, rows: [['Компания', 'Email']] }]);
  const f = fixture({ files: [file], tracking: headers(file.id, 6, true) });
  assert.equal(f.dashboard().items[0].overallStatus, 'no_contacts');
  assert.deepEqual(f.calls.ranges, []);
});

test('an unmanaged lone first row stays unknown instead of hiding a possible contact', () => {
  const file = sourceFile(undefined, [{ id: 6, rows: [['Company-or-header']] }]);
  const item = fixture({ files: [file] }).dashboard().items[0];
  assert.equal(item.overallStatus, null);
  assert.equal(item.contactPresence, 'unknown');
  assert.equal(item.analysis.state, 'partial');
  assert.match(item.analysis.warnings.join(' '), /заголовок/);
});

test('an explicit no-header choice counts a first-row contact', () => {
  const file = sourceFile(undefined, [{ id: 9, rows: [['Test company', 'contact@example.test']] }]);
  const f = fixture({ files: [file], tracking: headers(file.id, 9, false) });
  const item = f.dashboard().items[0];
  assert.equal(item.overallStatus, 'preparation');
  assert.equal(item.contactPresence, 'has_contacts');
  assert.equal(f.calls.ranges[0].row, 1);
});

test('legacy body data establishes preparation but never activates channels or exposes cells', () => {
  const secret = 'secret-company@example.test';
  const f = fixture({ files: [sourceFile(undefined, [{ id: 1, rows: [['Email'], [secret]] }])] });
  const result = f.dashboard(), item = result.items[0];
  assert.equal(item.overallStatus, 'preparation');
  assert.equal(item.analysis.hasContacts, true);
  for (const channel of Object.values(item.channels)) assert.deepEqual(channel, { state: 'inactive', inWork: null, configured: false });
  assert.equal(item.companiesInWork, null);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('formula display-empty cells and whitespace do not count as contacts', () => {
  const file = sourceFile(undefined, [{ id: 8, rows: [['Header'], [''], ['  ']], lastRow: 3 }]);
  const item = fixture({ files: [file], tracking: headers(file.id, 8, true) }).dashboard().items[0];
  assert.equal(item.overallStatus, 'no_contacts');
});

test('presence scans stop before opening remaining business books', () => {
  const first = sourceFile('first_business_1234567890', [{ id: 1, rows: [['Header'], ['Company']] }], { name: 'A' });
  const next = sourceFile('other_business_1234567890', [{ rows: [['Never read']] }], { name: 'B' });
  const f = fixture({ files: [first, next] });
  assert.equal(f.dashboard().items[0].overallStatus, 'preparation');
  assert.deepEqual(f.calls.opened, [first.id]);
});

test('unreadable files make an otherwise empty segment unknown', () => {
  const f = fixture({ files: [sourceFile(undefined, [], { unreadable: true })] });
  const item = f.dashboard().items[0];
  assert.equal(item.overallStatus, null);
  assert.equal(item.analysis.state, 'partial');
  assert.match(item.analysis.warnings.join(' '), /права доступа/);
});

test('later known contacts still establish preparation after an unreadable file or ambiguous sheet', () => {
  const first = sourceFile('first_business_1234567890', [], { unreadable: true, name: 'A' });
  const next = sourceFile('other_business_1234567890', [{ id: 1, rows: [['Maybe header']] }, { id: 2, rows: [['Header'], ['Contact']] }], { name: 'B' });
  const item = fixture({ files: [first, next] }).dashboard().items[0];
  assert.equal(item.overallStatus, 'preparation');
  assert.equal(item.analysis.state, 'partial');
  assert.equal(item.analysis.hasContacts, true);
});

test('a moved segment is not read even if its files remain in the registry', () => {
  const f = fixture({ folders: [{ id: SEGMENT, name: 'Moved segment', parents: [SOURCE], actualParents: [ROOT] }], files: [sourceFile(undefined, [{ rows: [['Header'], ['Contact']] }])] });
  const item = f.dashboard().items[0];
  assert.equal(item.overallStatus, null);
  assert.deepEqual(f.calls.tracking, []);
  assert.deepEqual(f.calls.opened, []);
  assert.throws(() => f.mailings(), /OUTSIDE_SEGMENTS/);
});

test('a file moved out of its segment is rejected before opening', () => {
  const f = fixture({ files: [sourceFile(undefined, [{ rows: [['Header'], ['Contact']] }], { actualParents: [ROOT] })] });
  assert.equal(f.dashboard().items[0].overallStatus, null);
  assert.deepEqual(f.calls.opened, []);
});

test('service-book protection also holds for the private scan helper', () => {
  const f = fixture({ files: [sourceFile(SERVICE, [{ rows: [['metadata']] }])] });
  const context = f.context.authorize_();
  const result = plain(f.context.segmentAnalyzeFile_(context, SEGMENT, SERVICE, {}, f.context.segmentAnalysisBudget_()));
  assert.equal(result.state, 'partial');
  assert.deepEqual(f.calls.files, []);
  assert.deepEqual(f.calls.opened, []);
});

test('nested Google Sheets are read under their owning direct-child segment', () => {
  const nested = 'nested_folder_1234567890';
  const file = sourceFile(undefined, [{ rows: [['Header'], ['Contact']] }], { parents: [nested] });
  const f = fixture({ folders: [{ id: nested, name: 'Вложенные', parents: [SEGMENT] }], files: [file] });
  const result = f.dashboard();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].overallStatus, 'preparation');
  assert.equal(result.items[0].tableCount, 1);
});

test('physical empty sheets are provably empty even when tracking is incomplete or unavailable', () => {
  for (const tracking of [{ available: false, tables: [], loads: [] }, headers('business_sheet_1234567890', 1, true, { stage: 'copying' })]) {
    const item = fixture({ files: [sourceFile(undefined, [{ id: 1, rows: [] }])], tracking }).dashboard().items[0];
    assert.equal(item.overallStatus, 'no_contacts');
    assert.equal(item.analysis.hasContacts, false);
    assert.equal(item.analysis.state, 'partial');
  }
});

test('confirmed header choices and canonical file kinds come from tracking only', () => {
  const file = sourceFile(undefined, [{ id: 4, rows: [['Company']] }]);
  const tracking = headers(file.id, 4, false); tracking.tables.push({ fileId: file.id, kind: 'companies' });
  const item = fixture({ files: [file], tracking }).dashboard().items[0];
  assert.equal(item.files[0].kind, 'companies');
  assert.equal(item.overallStatus, 'preparation');
});

test('conflicting header choices do not silently make a lone first row empty', () => {
  const file = sourceFile(undefined, [{ id: 4, rows: [['Company']] }]);
  const tracking = headers(file.id, 4, false); tracking.loads.push({ ...tracking.loads[0], hasHeader: true });
  const item = fixture({ files: [file], tracking }).dashboard().items[0];
  assert.equal(item.overallStatus, null);
  assert.equal(item.analysis.state, 'partial');
});

test('cell and file limits return unknown rather than false empty and ranges stay bounded', () => {
  const file = sourceFile(undefined, [{ id: 3, rows: [['H'], [''], [''], ['']], lastRow: 50, lastColumn: 5 }]);
  const f = fixture({ files: [file], tracking: headers(file.id, 3, true), limits: { segmentAnalysisMaxCells: 10, segmentAnalysisChunkCells: 5 } });
  const item = f.dashboard().items[0];
  assert.equal(item.overallStatus, null);
  assert.ok(f.calls.ranges.every(range => range.rowCount * range.columnCount <= 5));
  assert.ok(f.calls.ranges.reduce((sum, range) => sum + range.rowCount * range.columnCount, 0) <= 10);
  const f2 = fixture({ files: [sourceFile('first_business_1234567890'), sourceFile('other_business_1234567890')], limits: { segmentAnalysisMaxFiles: 1 } });
  assert.equal(f2.dashboard().items[0].overallStatus, null);
  assert.equal(f2.calls.opened.length, 1);
});

test('wide worksheets are read in bounded horizontal chunks', () => {
  const file = sourceFile(undefined, [{ id: 3, rows: [['H'], ['', '', '', '', '', '', 'Contact']], lastColumn: 7 }]);
  const f = fixture({ files: [file], tracking: headers(file.id, 3, true), limits: { segmentAnalysisChunkCells: 3 } });
  assert.equal(f.dashboard().items[0].overallStatus, 'preparation');
  assert.deepEqual(f.calls.ranges.map(range => range.column), [1, 4, 7]);
  assert.ok(f.calls.ranges.every(range => range.rowCount * range.columnCount <= 3));
});

test('sheet and elapsed-time limits also stop reads with an explicit unknown result', () => {
  const file = sourceFile(undefined, [{ rows: [] }, { rows: [] }]);
  const f = fixture({ files: [file], limits: { segmentAnalysisMaxSheets: 1 } });
  assert.equal(f.dashboard().items[0].overallStatus, null);
  const budget = f.context.segmentAnalysisBudget_();
  budget.startedAt = 0;
  const opened = f.calls.opened.length;
  const result = plain(f.context.segmentAnalyzeFile_(f.context.authorize_(), SEGMENT, file.id, {}, budget));
  assert.equal(result.state, 'partial');
  assert.equal(f.calls.opened.length, opened);
});

test('mailings are disconnected readonly screens with no fabricated campaigns or zeros', () => {
  const f = fixture({ files: [sourceFile(undefined, [{ rows: [['Never read contacts']] }])] });
  const result = f.mailings();
  assert.equal(result.state, 'not_connected');
  assert.equal(result.segment.id, SEGMENT);
  assert.deepEqual(result.totals, { sent: null, replies: null, leads: null });
  assert.deepEqual(result.services.map(service => [service.id, service.name, service.channel]), [['coldy', 'Coldy', 'email'], ['nsa', 'NSA', 'telegram']]);
  for (const service of result.services) {
    assert.deepEqual(service.campaigns, []);
    assert.deepEqual(service.totals, { sent: null, replies: null, leads: null });
  }
  assert.deepEqual(f.calls.opened, []);
  assert.throws(() => f.mailings('outside_segment_1234567890'), /SEGMENT_NOT_FOUND/);
});

test('future mailing aggregation handles multiple campaigns and independently unknown metrics', () => {
  const f = fixture();
  const entries = [{ sent: 10, replies: 3, leads: 1 }, { sent: 5, replies: null, leads: 2 }];
  assert.deepEqual(plain(f.context.segmentAggregateMailingMetrics_(entries, true)), { sent: 15, replies: null, leads: 3 });
  assert.deepEqual(plain(f.context.segmentAggregateMailingMetrics_(entries, false)), { sent: null, replies: null, leads: null });
  assert.deepEqual(plain(f.context.segmentAggregateMailingMetrics_([], true)), { sent: 0, replies: 0, leads: 0 });
  assert.deepEqual(plain(f.context.segmentAggregateMailingMetrics_([{ sent: -1, replies: 1.5, leads: Number.MAX_SAFE_INTEGER }, { sent: 1, replies: 2, leads: 1 }], true)), { sent: null, replies: null, leads: null });
});

test('future positive launch adapter can express in_work without deriving it from mailing counts', () => {
  const f = fixture();
  assert.equal(f.context.segmentOverallStatus_(true, { configured: false, hasLaunchedContacts: true }), 'preparation');
  assert.equal(f.context.segmentOverallStatus_(true, { configured: true, hasLaunchedContacts: true }), 'in_work');
  assert.equal(f.context.segmentOverallStatus_(null, { configured: false, hasLaunchedContacts: null }), null);
});

test('analytics exposes only the two authenticated readonly RPCs', () => {
  const source = readFileSync(`${sourceDir}SegmentAnalytics.gs`, 'utf8');
  const publicFunctions = [...source.matchAll(/^function\s+([A-Za-z0-9_]+)\s*\(/gm)].map(match => match[1]).filter(name => !name.endsWith('_'));
  assert.deepEqual(publicFunctions, ['getSegmentsDashboard', 'getSegmentMailings']);
  assert.doesNotMatch(source, /UrlFetchApp|\.setValue\s*\(|\.setValues\s*\(|\.clear\s*\(|\.appendRow\s*\(/);
});
