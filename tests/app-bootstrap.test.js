import { TEST_ACCESS_KEY, TEST_ACCESS_HASH, SHARED_ACTOR, installSharedApi, runShared } from './helpers/shared-link.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = ['Config.gs', 'Code.gs'].map(name => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8')).join('\n');
const ROOT = 'app_root_1234567890';
function setup({ accessKey = TEST_ACCESS_KEY, trashed = false } = {}) {
  const calls = [];
  const properties = { getProperty: key => ({ ROOT_FOLDER_ID: ROOT, SHARED_ACCESS_KEY_SHA256: TEST_ACCESS_HASH })[key] || '' };
  const account = { getEmail: () => 'member@example.com' };
  const context = vm.createContext({
    console,
    PropertiesService: { getScriptProperties: () => properties },
    Session: { getActiveUser: () => account, getEffectiveUser: () => account },
    DriveApp: { getFolderById(id) {
      calls.push(id);
      assert.equal(id, ROOT);
      return {
        getId: () => ROOT, getName: () => 'Реестр баз', isTrashed: () => trashed,
        getFilesByType: () => { throw new Error('Startup must not enumerate source files'); },
        getFolders: () => { throw new Error('Startup must not traverse folders'); }
      };
    } },
    SpreadsheetApp: { openById: () => { throw new Error('Startup must not read the service book or business cells'); } }
  });
  vm.runInContext(source, context);
  installSharedApi(context, { accessKey: () => accessKey });
  return { context, calls };
}

test('app startup returns identity and registry without a Drive tree or spreadsheet reads', () => {
  const { context, calls } = setup();
  const result = JSON.parse(JSON.stringify(context.getAppBootstrap()));
  assert.deepEqual(result, { user: { email: '', isAdmin: false, accessMode: 'link' }, registry: { id: ROOT, name: 'Реестр баз' } });
  assert.deepEqual(calls, [ROOT]);
});

test('app startup denies callers before resolving the registry', () => {
  const { context, calls } = setup({ accessKey: null });
  assert.throws(() => context.getAppBootstrap(), /LINK_ACCESS_REQUIRED|LINK_ACCESS_INVALID|ACCESS_REQUIRED|INVALID_ACCESS/);
  assert.deepEqual(calls, []);
});

test('app startup rejects a trashed registry rather than showing stale project metadata', () => {
  const { context } = setup({ trashed: true });
  assert.throws(() => context.getAppBootstrap(), /NOT_FOUND/);
});
