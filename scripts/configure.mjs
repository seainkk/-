import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_SCRIPT_ID = '1FyQVeeqd4X13NqQ7PtRMVg7U8p60yk-tWvgK-9vmPdpQgK-mQE3sL8aH';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('npm run configure -- [--script-id GOOGLE_APPS_SCRIPT_ID]');
  console.log('Записывает только привязку .clasp.json. Авторизацию и публикацию не выполняет.');
} else {
  try {
    if (args.length && (args.length !== 2 || args[0] !== '--script-id')) throw new Error('Используйте --script-id ID или вызов без параметров.');
    const scriptId = args[1] || DEFAULT_SCRIPT_ID;
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(scriptId)) throw new Error('Передайте ID проекта Apps Script, а не URL.');
    const target = path.resolve('.clasp.json');
    let existing;
    try { existing = JSON.parse(await readFile(target, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Существующая .clasp.json повреждена. Проверьте её перед настройкой.');
    }
    if (existing?.scriptId && existing.scriptId !== scriptId && !args.length) throw new Error('Проект уже привязан к другому scriptId. Для намеренной смены используйте --script-id ID.');
    await writeFile(target, JSON.stringify({ ...existing, scriptId, rootDir: 'src' }, null, 2) + '\n');
    console.log(`Проект привязан: ${scriptId}; исходники: src. Авторизация и публикация ещё не выполнялись.`);
  } catch (error) {
    console.error(error.message);process.exitCode=1;
  }
}
