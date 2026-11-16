import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function parseJson(text, message) {
  try { return JSON.parse(text); } catch { throw new Error(message); }
}

function commandError(command, output = '') {
  if (/script api not enabled|accessNotConfigured/i.test(output)) {
    return new Error('Включите Apps Script API: https://script.google.com/home/usersettings.');
  }
  if (/invalid_grant|unauthorized|invalid credentials|authentication required|not logged in/i.test(output)) {
    return new Error('Обновите авторизацию через npx clasp login и секрет GitHub CLASPRC_JSON.');
  }
  return new Error(`Команда clasp ${command} не подтверждена. Проверьте доступ Google к проекту, авторизацию и ID развёртывания. Подробный вывод скрыт, чтобы не раскрыть учётные данные.`);
}

async function claspPackage(cwd) {
  let metadata;
  try {
    metadata = JSON.parse(await readFile(path.join(cwd, 'node_modules/@google/clasp/package.json'), 'utf8'));
  } catch {
    throw new Error('Не установлен закреплённый @google/clasp. Выполните npm ci.');
  }
  const bin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.clasp;
  if (!bin || metadata.version !== '3.4.1') throw new Error('Ожидается @google/clasp 3.4.1 из package-lock.json. Выполните npm ci.');
  return { root: path.join(cwd, 'node_modules/@google/clasp'), bin };
}

async function defaultInvoker(args, { cwd, env }) {
  const clasp = await claspPackage(cwd);
  const executable = path.join(clasp.root, clasp.bin);
  const { CLASPRC_JSON: ignored, ...childEnv } = env;
  try {
    const result = await execFileAsync(process.execPath, [executable, ...args], {
      cwd, env: childEnv, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 180000,
    });
    return result.stdout;
  } catch (error) {
    const command = args.find(value => ['push', 'version', 'redeploy'].includes(value)) || 'deploy';
    // Never forward raw CLI errors: OAuth responses and debug output can contain credentials.
    throw commandError(command, `${error.stdout || ''}\n${error.stderr || ''}`);
  }
}

async function defaultDeploymentReader({ cwd, authPath, scriptId, deploymentId }) {
  // clasp's CLI deliberately omits entryPoints from JSON output. Read the same
  // deployment through Google's API, reusing the pinned clasp credential format.
  // Credentials stay in memory/private storage and provider errors never escape.
  const clasp = await claspPackage(cwd);
  const require = createRequire(path.join(clasp.root, 'package.json'));
  const { GoogleAuth } = require('google-auth-library');
  const { FileCredentialStore } = await import(pathToFileURL(path.join(clasp.root, 'build/src/auth/file_credential_store.js')).href);
  const saved = await new FileCredentialStore(authPath || path.join(homedir(), '.clasprc.json')).load('default');
  if (!saved) throw new Error('Deployment credentials unavailable');
  const auth = new GoogleAuth().fromJSON(saved);
  auth.setCredentials(saved);
  // Do not attach a token-saving listener: it could race private-file cleanup.
  const result = await auth.request({
    url: 'https://script.googleapis.com/v1/projects/' + encodeURIComponent(scriptId) + '/deployments/' + encodeURIComponent(deploymentId),
    method: 'GET', timeout: 30000, retry: false,
  });
  return result.data;
}

function verifyPublishedDeployment(published, { scriptId, deploymentId, version }) {
  if (published?.deploymentId !== deploymentId || published?.deploymentConfig?.scriptId !== scriptId || published?.deploymentConfig?.versionNumber !== version) {
    throw new Error('Google не подтвердил ID проекта, существующее развёртывание и опубликованную версию при повторной проверке. Проверьте публикацию в Apps Script.');
  }
  const entryPoints = Array.isArray(published.entryPoints) ? published.entryPoints : [];
  const webApps = entryPoints.filter(entry => entry?.entryPointType === 'WEB_APP');
  const expectedUrl = 'https://script.google.com/macros/s/' + deploymentId + '/exec';
  if (webApps.length !== 1 || webApps[0]?.webApp?.url !== expectedUrl) throw new Error('Google не подтвердил прежний адрес веб-приложения. Новое развёртывание не создавалось; проверьте существующее в Apps Script.');
  const config = webApps[0].webApp.entryPointConfig;
  if (config?.access !== 'ANYONE_ANONYMOUS' || config?.executeAs !== 'USER_DEPLOYING') {
    throw new Error('Версия опубликована, но Google не подтвердил вход без Google-аккаунта и выполнение от владельца. В Apps Script откройте «Развернуть → Управление развертываниями → Изменить»: «Выполнять от моего имени», доступ «Все», включая анонимных пользователей. Сохраните существующее развёртывание и повторите публикацию.');
  }
  return expectedUrl;
}

export async function deploy({ cwd = process.cwd(), env = process.env, invoke = defaultInvoker, readDeployment = defaultDeploymentReader, log = console.log } = {}) {
  const deploymentId = String(env.APPS_SCRIPT_DEPLOYMENT_ID || '').trim();
  if (!deploymentId || !/^[A-Za-z0-9_-]{20,300}$/.test(deploymentId)) {
    throw new Error('Укажите APPS_SCRIPT_DEPLOYMENT_ID существующего web app. Создание нового deployment этим скриптом запрещено.');
  }
  let mapping;
  try { mapping = JSON.parse(await readFile(path.join(cwd, '.clasp.json'), 'utf8')); }
  catch { throw new Error('Не найдена корректная .clasp.json. Выполните npm run configure.'); }
  if (!mapping.scriptId || mapping.rootDir !== 'src') throw new Error('Проверьте .clasp.json: нужны scriptId и rootDir="src".');
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(cwd, 'src/appsscript.json'), 'utf8')); }
  catch { throw new Error('Не найден корректный src/appsscript.json. Публикация остановлена.'); }
  if (manifest.webapp?.access !== 'ANYONE_ANONYMOUS' || manifest.webapp?.executeAs !== 'USER_DEPLOYING') throw new Error('Режим закрытой ссылки требует в манифесте ANYONE_ANONYMOUS и USER_DEPLOYING. Публикация остановлена до загрузки файлов.');

  const rawCredentials = env.CLASPRC_JSON;
  if (env.CI && !rawCredentials?.trim()) throw new Error('В CI требуется GitHub Secret CLASPRC_JSON. Вставьте его в Settings → Secrets and variables → Actions.');
  if (rawCredentials) {
    const credentials = parseJson(rawCredentials, 'CLASPRC_JSON должен содержать корректный JSON из файла авторизации clasp.');
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('CLASPRC_JSON должен содержать JSON-объект авторизации clasp.');
  }

  let authDirectory;
  let authPath;
  try {
    const prefix = [];
    if (rawCredentials) {
      authDirectory = await mkdtemp(path.join(tmpdir(), 'bases-registry-clasp-'));
      authPath = path.join(authDirectory, '.clasprc.json');
      await writeFile(authPath, rawCredentials, { mode: 0o600, flag: 'wx' });
      prefix.push('--auth', authPath);
    }
    prefix.push('--json');
    const execute = async command => {
      try { return await invoke([...prefix, ...command], { cwd, env }); }
      catch (error) {
        // The injected transport used in tests follows the same no-secret logging rule.
        if (invoke !== defaultInvoker) throw commandError(command[0]);
        throw error;
      }
    };
    const commit = /^[a-f\d]{7,64}$/i.test(env.GITHUB_SHA || '') ? env.GITHUB_SHA.slice(0,12) : new Date().toISOString();
    const description = `bases-registry ${commit}`;
    log('Загрузка исходников в настроенный Apps Script-проект…');
    await execute(['push', '--force']);
    const created = parseJson(await execute(['version', description]), 'clasp не вернул номер созданной версии. Рабочее развёртывание не изменено.');
    const version = created?.versionNumber;
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('Получен некорректный номер версии. Рабочее развёртывание не изменено.');
    const updated = parseJson(await execute(['redeploy', deploymentId, '--versionNumber', String(version), '--description', description]), 'Не удалось подтвердить результат публикации. Проверьте существующее развёртывание в Apps Script.');
    if (updated?.deploymentId !== deploymentId || updated?.versionNumber !== version) throw new Error('Google не подтвердил ожидаемые deployment ID и версию. Проверьте публикацию в Apps Script.');
    let published;
    try { published = await readDeployment({ cwd, authPath, scriptId: mapping.scriptId, deploymentId }); }
    catch { throw new Error('Версия отправлена, но не удалось прочитать фактические настройки развёртывания Google. Проверьте авторизацию clasp и доступ к Apps Script API; результат публикации ещё не подтверждён. Подробный ответ скрыт, чтобы не раскрыть учётные данные.'); }
    const url = verifyPublishedDeployment(published, { scriptId: mapping.scriptId, deploymentId, version });
    log(`Существующее развёртывание обновлено до версии ${version}. Его рабочая ссылка сохранена.`);
    log('Google подтвердил выполнение от владельца и открытие без Google-авторизации. Доступ к операциям проверяет серверный ключ ссылки.');
    return { deploymentId, versionNumber: version, url, access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' };
  } finally {
    if (authDirectory) await rm(authDirectory, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) deploy().catch(error => { console.error(error.message); process.exitCode = 1; });
