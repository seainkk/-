import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deploy } from '../scripts/deploy.mjs';

const DEPLOYMENT = 'AKfycb-test-existing-deployment-123456789';
const SECRET = '{"tokens":{"default":{"refresh_token":"never-log-this-refresh-token"}}}';

async function project(run) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'bases-deploy-test-'));
  await writeFile(path.join(cwd, '.clasp.json'), JSON.stringify({ scriptId: 'test-script-id', rootDir: 'src' }));
  try { await run(cwd); } finally { await rm(cwd, { force: true, recursive: true }); }
}

test('deployment refuses a missing existing ID before touching clasp', async () => {
  let calls = 0;
  await assert.rejects(deploy({ env: { CLASPRC_JSON: SECRET }, invoke: async () => { calls++; } }), /APPS_SCRIPT_DEPLOYMENT_ID/);
  assert.equal(calls, 0);
});

test('deployment pushes, versions and updates exactly the existing deployment with private temporary credentials', async () => {
  await project(async cwd => {
    const calls = [], logs = [];
    let authPath;
    const result = await deploy({ cwd, env: { CI: 'true', CLASPRC_JSON: SECRET, APPS_SCRIPT_DEPLOYMENT_ID: DEPLOYMENT, GITHUB_SHA: 'a'.repeat(40) }, log: message => logs.push(message),
      invoke: async args => {
        calls.push(args);authPath = args[1];
        assert.equal(args[0], '--auth');assert.equal(args[2], '--json');
        assert.equal(await readFile(authPath, 'utf8'), SECRET);
        assert.equal((await stat(authPath)).mode & 0o777, 0o600);
        const command = args[3];
        if (command === 'push') return '{}';
        if (command === 'version') return '{"versionNumber":17}';
        if (command === 'redeploy') return JSON.stringify({ deploymentId: DEPLOYMENT, versionNumber:17 });
        throw new Error('Unexpected clasp command');
      },
    });
    assert.deepEqual(calls.map(args => args[3]), ['push','version','redeploy']);
    assert.deepEqual(calls[2].slice(3), ['redeploy', DEPLOYMENT, '--versionNumber','17','--description','bases-registry aaaaaaaaaaaa']);
    assert.equal(result.versionNumber,17);
    assert.equal(logs.join('\n').includes('never-log-this'),false);
    await assert.rejects(stat(authPath), { code:'ENOENT' });
  });
});

test('malformed version output prevents redeploy and cleans credentials without logging raw CLI data', async () => {
  await project(async cwd => {
    const calls=[];let authPath;
    await assert.rejects(deploy({ cwd, env:{CLASPRC_JSON:SECRET,APPS_SCRIPT_DEPLOYMENT_ID:DEPLOYMENT}, log:()=>{}, invoke:async args=>{
      calls.push(args[3]);authPath=args[1];return args[3]==='push'?'{}':SECRET;
    }}),/номер версии/);
    assert.deepEqual(calls,['push','version']);
    await assert.rejects(stat(authPath), {code:'ENOENT'});
  });
});

test('a failing clasp transport does not expose credentials and always cleans the temporary file', async () => {
  await project(async cwd => {
    let authPath;
    try {
      await deploy({cwd,env:{CLASPRC_JSON:SECRET,APPS_SCRIPT_DEPLOYMENT_ID:DEPLOYMENT},log:()=>{},invoke:async args=>{authPath=args[1];throw new Error(SECRET);}});
      assert.fail('Expected deployment error');
    } catch(error) {
      assert.equal(error.message.includes('never-log-this'),false);
      assert.match(error.message,/clasp push/);
    }
    await assert.rejects(stat(authPath),{code:'ENOENT'});
  });
});

test('CI without credentials refuses publication before any clasp command', async () => {
  await project(async cwd => {
    let calls=0;
    await assert.rejects(deploy({cwd,env:{CI:'true',APPS_SCRIPT_DEPLOYMENT_ID:DEPLOYMENT},invoke:async()=>{calls++;}}),/CLASPRC_JSON/);
    assert.equal(calls,0);
  });
});

test('redeploy response must confirm the configured existing ID and version', async () => {
  await project(async cwd => {
    await assert.rejects(deploy({cwd,env:{APPS_SCRIPT_DEPLOYMENT_ID:DEPLOYMENT},log:()=>{},invoke:async args=>{
      const command=args[1];
      return command==='version'?'{"versionNumber":8}':command==='redeploy'?'{"deploymentId":"different-id","versionNumber":8}':'{}';
    }}),/не подтвердил/);
  });
});
