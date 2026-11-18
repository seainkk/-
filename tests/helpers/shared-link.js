import crypto from 'node:crypto';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

export const TEST_ACCESS_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
export const TEST_ACCESS_HASH = crypto.createHash('sha256').update(TEST_ACCESS_KEY).digest('base64url');
export const SHARED_ACTOR = 'shared-link';

const modules = [
  ['Segments.gs', 'getSegmentsMetadata_'],
  ['SourceBases.gs', 'getSourceBases_'],
  ['SourceImport.gs', 'importSourceBaseLink_'],
  ['ContactPreview.gs', 'previewSourceBaseContacts_'],
  ['ContactTarget.gs', 'contactPreviewCompareTarget_'],
  ['PreparedData.gs', 'preparedReadSource_'],
  ['PreparedImport.gs', 'stagePreparedUpload_'],
  ['SheetEditor.gs', 'getGridWorkbook_'],
  ['SegmentActions.gs', 'createSegment_'],
  ['SegmentAnalytics.gs', 'getSegmentsDashboard_'],
];
const methods = ['getAppBootstrap', 'getBootstrap', 'createBase', 'createFolder', 'renameItem', 'getSourceBases', 'updateSourceBase', 'importSourceBaseLink', 'getSourceSheets', 'createSegment', 'updateSegment', 'getSegmentsDashboard', 'getSegmentMailings', 'previewSourceBaseContacts', 'stagePreparedBaseLink', 'previewPreparedBase', 'confirmPreparedBase', 'continuePreparedBase', 'cancelPreparedBase', 'listPreparedJobs', 'getGridWorkbook', 'getGridRange', 'saveGridRange', 'appendGridRows', 'appendGridColumns'];

/** Real dispatcher proxies for fixtures; convenience names are never deployed RPCs. */
export function installSharedApi(context, { accessKey = () => TEST_ACCESS_KEY } = {}) {
  const utilities = context.Utilities || (context.Utilities = {});
  utilities.DigestAlgorithm ||= { SHA_256: 'sha256' };
  utilities.Charset ||= { UTF_8: 'utf8' };
  utilities.computeDigest ||= ((algorithm, value) => [...crypto.createHash(algorithm).update(typeof value === 'string' ? value : Buffer.from(value)).digest()]);
  utilities.base64EncodeWebSafe ||= (value => Buffer.from(value).toString('base64url'));
  for (const [name, handler] of modules) if (typeof context[handler] !== 'function') vm.runInContext(readFileSync(new URL('../../src/' + name, import.meta.url), 'utf8'), context, { filename: name });
  vm.runInContext(readFileSync(new URL('../../src/Access.gs', import.meta.url), 'utf8'), context, { filename: 'Access.gs' });
  const key = () => typeof accessKey === 'function' ? accessKey() : accessKey;
  const upload = context.uploadSourceBase;
  for (const method of methods) context[method] = payload => {
    const request = { method, accessKey: key() };
    if (payload !== undefined) request.payload = payload;
    return context.callApp(request);
  };
  context.uploadSourceBase = form => upload(Object.assign({}, form, { accessKey: key() }));
  return context;
}

/** Private-helper unit tests enter the same real, verified request scope. */
export function runShared(context, callback, accessKey = TEST_ACCESS_KEY) {
  return context.withSharedAccess_(accessKey, callback);
}
