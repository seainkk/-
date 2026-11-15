import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

async function defaultInvoker(args, { cwd, env }) {
  let metadata;
  try {
    metadata = JSON.parse(await readFile(path.join(cwd, 'node_modules/@google/clasp/package.json'), 'utf8'));
  } catch {
    throw new Error('Не установлен закреплённый @google/clasp. Выполните npm ci.');
  }
  const bin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.clasp;
  if (!bin || metadata.version !== '3.4.1') throw new Error('Ожидается @google/clasp 3.4.1 из package-lock.json. Выполните npm ci.');
  const executable = path.join(cwd, 'node_modules/@google/clasp', bin);
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

export async function deploy({ cwd = process.cwd(), env = process.env, invoke = defaultInvoker, log = console.log } = {}) {
  const deploymentId = String(env.APPS_SCRIPT_DEPLOYMENT_ID || '').trim();
  if (!deploymentId || !/^[A-Za-z0-9_-]{20,300}$/.test(deploymentId)) {
    throw new Error('Укажите APPS_SCRIPT_DEPLOYMENT_ID существующего web app. Создание нового deployment этим скриптом запрещено.');
  }
  let mapping;
  try { mapping = JSON.parse(await readFile(path.join(cwd, '.clasp.json'), 'utf8')); }
  catch { throw new Error('Не найдена корректная .clasp.json. Выполните npm run configure.'); }
  if (!mapping.scriptId || mapping.rootDir !== 'src') throw new Error('Проверьте .clasp.json: нужны scriptId и rootDir="src".');

  const rawCredentials = env.CLASPRC_JSON;
  if (env.CI && !rawCredentials?.trim()) throw new Error('В CI требуется GitHub Secret CLASPRC_JSON. Вставьте его в Settings → Secrets and variables → Actions.');
  if (rawCredentials) {
    const credentials = parseJson(rawCredentials, 'CLASPRC_JSON должен содержать корректный JSON из файла авторизации clasp.');
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('CLASPRC_JSON должен содержать JSON-объект авторизации clasp.');
  }

  let authDirectory;
  try {
    const prefix = [];
    if (rawCredentials) {
      authDirectory = await mkdtemp(path.join(tmpdir(), 'bases-registry-clasp-'));
      const authPath = path.join(authDirectory, '.clasprc.json');
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
    log(`Существующее развёртывание обновлено до версии ${version}. Его рабочая ссылка сохранена.`);
    return { deploymentId, versionNumber: version };
  } finally {
    if (authDirectory) await rm(authDirectory, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) deploy().catch(error => { console.error(error.message); process.exitCode = 1; });
