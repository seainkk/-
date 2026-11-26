import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegistryShell } from './deploy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = ['index.html', 'favicon.png'];

export async function buildPages(destination) {
  const source = path.join(root, 'src');
  const [shell, transport, navigation] = await Promise.all([
    buildRegistryShell(source), readFile(path.join(source, 'PagesTransport.html'), 'utf8'),
    readFile(path.join(source, 'PagesNavigation.html'), 'utf8')
  ]);
  const headEnd = shell.indexOf('</head>');
  const firstScript = shell.search(/<script\b/i);
  if (headEnd < 0 || firstScript < headEnd || /<\?/.test(transport + navigation)) throw new Error('Не удалось собрать статический интерфейс Pages.');
  const app = shell.slice(0, headEnd) + navigation + '\n' + shell.slice(headEnd, firstScript) + transport + '\n' + shell.slice(firstScript);
  await mkdir(destination, { recursive: true });
  const publicFiles = new Set([...assets, 'app.html']);
  if ((await readdir(destination)).some(name => !publicFiles.has(name))) {
    throw new Error('Для публикации нужна отдельная папка только с файлами интерфейса.');
  }
  await Promise.all([
    ...assets.map(name => copyFile(path.join(root, 'entry', name), path.join(destination, name))),
    writeFile(path.join(destination, 'app.html'), app)
  ]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Укажите папку для статического сайта.');
  await buildPages(path.resolve(process.argv[2]));
}
