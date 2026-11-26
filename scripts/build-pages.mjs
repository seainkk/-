import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegistryShell } from './deploy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = ['index.html', 'favicon.png'];

export async function buildPages(destination, firebaseProject = process.env.FIREBASE_DIRECTORY_PROJECT || '') {
  if (firebaseProject && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(firebaseProject)) throw new Error('Некорректный идентификатор проекта Firebase.');
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
  const entry = path.join(root,'entry');
  const [index,reader] = await Promise.all([readFile(path.join(entry,'index.html'),'utf8'),readFile(path.join(entry,'directory.js'),'utf8')]);
  const directoryOrigin = firebaseProject === 'outreach-directory'
    ? 'https://firestore.europe-west3.rep.googleapis.com'
    : 'https://firestore.googleapis.com';
  await Promise.all([
    writeFile(path.join(destination,'index.html'),index
      .replace('<!-- directory preconnect -->',firebaseProject?'<link rel="preconnect" href="'+directoryOrigin+'" crossorigin>':'')
      .replace('/* directory reader bundle */',()=>reader.replace('/* directory service origin */',JSON.stringify(directoryOrigin)))
      .replace('const directoryProject = "";',()=> 'const directoryProject = '+JSON.stringify(firebaseProject)+';')),
    copyFile(path.join(entry,'favicon.png'),path.join(destination,'favicon.png')),
    writeFile(path.join(destination, 'app.html'), app)
  ]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Укажите папку для статического сайта.');
  await buildPages(path.resolve(process.argv[2]));
}
