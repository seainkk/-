import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deploy } from '../scripts/deploy.mjs';

const DEPLOYMENT = 'AKfycb-test-existing-deployment-123456789';
const SECRET = '{"tokens":{"default":{"refresh_token":"never-log-this-refresh-token"}}}';
const SHARED_MANIFEST = { webapp: { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' } };

function published(version = 17, changes = {}) {
  return {
    deploymentId: DEPLOYMENT,
    deploymentConfig: { scriptId: 'test-script-id', versionNumber: version },
    entryPoints: [{ entryPointType: 'WEB_APP', webApp: { url: 'https://script.google.com/macros/s/' + DEPLOYMENT + '/exec', entryPointConfig: { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' } } }],
    ...changes,
  };
}

const successfulInvoke = async args => {
  if (args.includes('version')) return '{"versionNumber":17}';
  if (args.includes('redeploy')) return JSON.stringify({ deploymentId: DEPLOYMENT, versionNumber: 17 });
  return '{}';
};

async function project(run) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'bases-deploy-test-'));
  await writeFile(path.join(cwd, '.clasp.json'), JSON.stringify({ scriptId: 'test-script-id', rootDir: 'src' }));
  await mkdir(path.join(cwd, 'src'));
  await writeFile(path.join(cwd, 'src/appsscript.json'), JSON.stringify(SHARED_MANIFEST));
  await writeFile(path.join(cwd, 'src/Index.html'), '<main>Registry</main>\n<?!= include_(\'Client\'); ?>');
  await writeFile(path.join(cwd, 'src/Client.html'), '<script>/* static client */</script>');
  try { await run(cwd); } finally { await rm(cwd, { force: true, recursive: true }); }
}

test('deployment refuses a missing existing ID before touching clasp', async () => {
  let calls = 0;
  await assert.rejects(deploy({ env: { CLASPRC_JSON: SECRET }, invoke: async () => { calls++; } }), /APPS_SCRIPT_DEPLOYMENT_ID/);
  assert.equal(calls, 0);
});

test('deployment updates the existing ID then verifies actual anonymous owner execution with private temporary credentials', async () => {
  await project(async cwd => {
    const calls = [], logs = [];
    let authPath, staging;
    const result = await deploy({ cwd, env: { CI: 'true', CLASPRC_JSON: SECRET, APPS_SCRIPT_DEPLOYMENT_ID: DEPLOYMENT, GITHUB_SHA: 'a'.repeat(40) }, log: message => logs.push(message),
      invoke: async (args, options) => {
        calls.push(args);authPath = args[1];
        assert.equal(args[0], '--auth');assert.equal(args[2], '--json');
        assert.equal(await readFile(authPath, 'utf8'), SECRET);
        // Windows exposes ACL-managed user-temp files as 0666 in fs.stat. CI checks the POSIX permissions.
        if (process.platform !== 'win32') assert.equal((await stat(authPath)).mode & 0o777, 0o600);
        assert.equal(path.dirname(path.dirname(authPath)),tmpdir());
        const command = args[3];
        if (command === 'push') {
          staging = options.cwd;
          assert.notEqual(staging, cwd);
          assert.equal(options.packageDir, cwd, 'use the pinned clasp from the real checkout');
          assert.equal(await readFile(path.join(staging, '.clasp.json'),'utf8'), await readFile(path.join(cwd, '.clasp.json'),'utf8'));
          assert.equal(await readFile(path.join(staging, 'src/appsscript.json'),'utf8'), JSON.stringify(SHARED_MANIFEST));
          assert.equal(await readFile(path.join(staging, 'src/RegistryShell.html'),'utf8'), '<main>Registry</main>\n<script>/* static client */</script>');
          assert.equal(await readFile(path.join(staging, 'src/Index.html'),'utf8'), await readFile(path.join(cwd, 'src/Index.html'),'utf8'));
          assert.ok(path.relative(staging,authPath).startsWith('..'), 'OAuth file is outside the clasp project');
          await assert.rejects(stat(path.join(cwd, 'src/RegistryShell.html')), {code:'ENOENT'});
          return '{}';
        }
        assert.equal(options.cwd,cwd);
        if (command === 'version') return '{"versionNumber":17}';
        if (command === 'redeploy') return JSON.stringify({ deploymentId: DEPLOYMENT, versionNumber:17 });
        throw new Error('Unexpected clasp command');
      },
      readDeployment: async request => {
        assert.deepEqual(request, { cwd, authPath, scriptId: 'test-script-id', deploymentId: DEPLOYMENT });
        assert.equal(await readFile(request.authPath, 'utf8'), SECRET, 'verification uses the still-private credential file');
        return published();
      },
    });
    assert.deepEqual(calls.map(args => args[3]), ['push','version','redeploy']);
    assert.deepEqual(calls[2].slice(3), ['redeploy', DEPLOYMENT, '--versionNumber','17','--description','bases-registry aaaaaaaaaaaa']);
    assert.equal(result.versionNumber,17);
    assert.equal(result.access, 'ANYONE_ANONYMOUS');
    assert.equal(result.executeAs, 'USER_DEPLOYING');
    assert.equal(result.url, 'https://script.google.com/macros/s/' + DEPLOYMENT + '/exec');
    assert.equal(logs.join('\n').includes('never-log-this'),false);
    await assert.rejects(stat(authPath), { code:'ENOENT' });
    await assert.rejects(stat(staging), { code:'ENOENT' });
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

test('an incompatible local manifest stops before credentials are used or any clasp mutation', async () => {
  await project(async cwd => {
    for (const webapp of [{ access: 'ANYONE', executeAs: 'USER_DEPLOYING' }, { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_ACCESSING' }, {}]) {
      await writeFile(path.join(cwd, 'src/appsscript.json'), JSON.stringify({ webapp }));
      let calls = 0;
      await assert.rejects(deploy({ cwd, env: { CLASPRC_JSON: SECRET, APPS_SCRIPT_DEPLOYMENT_ID: DEPLOYMENT }, invoke: async () => { calls++; } }), /ANYONE_ANONYMOUS.*USER_DEPLOYING/);
      assert.equal(calls, 0);
    }
  });
});

test('actual deployed access and executeAs must match even when CLI and the local manifest succeeded', async () => {
  await project(async cwd => {
    for (const config of [{ access: 'MYSELF', executeAs: 'USER_DEPLOYING' }, { access: 'ANYONE', executeAs: 'USER_DEPLOYING' }, { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_ACCESSING' }, undefined]) {
      let authPath;
      const metadata = published();
      metadata.entryPoints[0].webApp.entryPointConfig = config;
      await assert.rejects(deploy({ cwd, env: { CLASPRC_JSON: SECRET, APPS_SCRIPT_DEPLOYMENT_ID: DEPLOYMENT }, log: () => {}, invoke: async args => { authPath = args[1]; return successfulInvoke(args); }, readDeployment: async () => metadata }), /Google не подтвердил вход/);
      await assert.rejects(stat(authPath), { code: 'ENOENT' });
    }
  });
});

test('readback verifies the project, deployment, exact version and unchanged canonical web app URL', async () => {
  await project(async cwd => {
    const variants = [
      published(16),
      published(17, { deploymentId: 'another-deployment' }),
      published(17, { deploymentConfig: { scriptId: 'another-script', versionNumber: 17 } }),
      published(17, { entryPoints: [] }),
      published(17, { entryPoints: [{ entryPointType: 'WEB_APP', webApp: { url: 'https://elsewhere.invalid/', entryPointConfig: SHARED_MANIFEST.webapp } }] }),
      published(17, { entryPoints: [...published().entryPoints, ...published().entryPoints] }),
    ];
    for (const metadata of variants) {
      await assert.rejects(deploy({ cwd, env: { APPS_SCRIPT_DEPLOYMENT_ID: DEPLOYMENT }, log: () => {}, invoke: successfulInvoke, readDeployment: async () => metadata }), /не подтвердил/);
    }
  });
});

test('readback failure never exposes credential or provider output and cleans the private file', async () => {
  await project(async cwd => {
    const logs = []; let authPath;
    let error;
    try {
      await deploy({ cwd, env: { CI: 'true', CLASPRC_JSON: SECRET, APPS_SCRIPT_DEPLOYMENT_ID: DEPLOYMENT }, log: text => logs.push(text), invoke: successfulInvoke, readDeployment: async request => { authPath = request.authPath; throw new Error(SECRET); } });
    } catch (value) { error = value; }
    assert.match(error.message, /фактические настройки/);
    assert.equal((error.message + logs.join('\n')).includes('never-log-this'), false);
    await assert.rejects(stat(authPath), { code: 'ENOENT' });
    assert.equal(logs.some(text => text.includes('Google подтвердил')), false);
  });
});
