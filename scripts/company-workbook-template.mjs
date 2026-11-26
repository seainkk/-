// Run as the deploying Google owner to provision the private, copyable workbook menu.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const claspRoot = path.resolve('node_modules/@google/clasp');
const require = createRequire(path.join(claspRoot, 'package.json'));
const { GoogleAuth } = require('google-auth-library');
const { FileCredentialStore } = await import(pathToFileURL(path.join(claspRoot, 'build/src/auth/file_credential_store.js')).href);
const saved = await new FileCredentialStore(path.join(homedir(), '.clasprc.json')).load('default');
const auth = new GoogleAuth().fromJSON(saved);
auth.setCredentials(saved);
const drive = 'https://www.googleapis.com/drive/v3/files';
const projects = 'https://script.googleapis.com/v1/projects';
const title = 'Шаблон Центра · Компании';
const marker = 'company-email-menu-v1';
const mimeType = 'application/vnd.google-apps.spreadsheet';
const fileFields = 'id,name,ownedByMe,shared,properties,mimeType';
let step = 'проверка шаблона';
try {
  const { data: list } = await auth.request({ url: drive, params: {
    q: "trashed=false and 'me' in owners and properties has { key='outreachTemplate' and value='" + marker + "' }",
    fields: 'nextPageToken,files(' + fileFields + ')', pageSize: 2
  } });
  if (list.nextPageToken || list.files.length > 1) throw Error('В Диске несколько шаблонов с одинаковой меткой.');
  let file = list.files[0];
  if (!file) {
    step = 'создание пустой книги';
    const created = await auth.request({ method: 'POST', url: drive, params: { fields: fileFields },
      data: { name: title, mimeType, properties: { outreachTemplate: marker } } });
    file = created.data;
  }
  if (!file.ownedByMe || file.shared || file.mimeType !== mimeType || file.properties?.outreachTemplate !== marker) {
    throw Error('Проверьте владельца и закрытый доступ шаблона.');
  }
  let scriptId = file.properties.outreachMenuProject;
  if (!scriptId) {
    step = 'привязка меню к шаблону';
    const created = await auth.request({ method: 'POST', url: projects, data: { title, parentId: file.id } });
    scriptId = created.data.scriptId;
    await auth.request({ method: 'PATCH', url: drive + '/' + encodeURIComponent(file.id),
      data: { properties: { outreachMenuProject: scriptId } } });
  }
  const projectUrl = projects + '/' + encodeURIComponent(scriptId);
  const { data: project } = await auth.request({ url: projectUrl });
  if (project.parentId !== file.id || project.title !== title) throw Error('Не удалось подтвердить привязку меню к шаблону.');
  step = 'обновление меню';
  const menu = await readFile(new URL('../native/CompanyMenu.gs', import.meta.url), 'utf8');
  const files = [{ name: 'appsscript', type: 'JSON', source: JSON.stringify({ timeZone:'Europe/Moscow', runtimeVersion:'V8',
    oauthScopes:['https://www.googleapis.com/auth/spreadsheets.currentonly','https://www.googleapis.com/auth/script.container.ui'] }) },
    { name: 'CompanyMenu', type: 'SERVER_JS', source: menu }];
  await auth.request({ method:'PUT', url:projectUrl + '/content', data:{ files } });
  const published = await auth.request({ url:projectUrl + '/content' });
  if (!published.data.files.some(f => f.name === 'CompanyMenu' && f.source === menu)) throw Error('Не удалось сверить код меню.');
  await auth.request({method:'PATCH', url:drive + '/' + encodeURIComponent(file.id), data:{properties:{outreachMenuVersion:'2'}}});
  console.log('Готов закрытый шаблон: ' + file.id);
} catch (error) {
  // OAuth errors may contain credentials in their request configuration.
  console.error('Операция не завершена (' + step + '): ' + (error.response?.status || error.code || 'ошибка проверки') + '.');
  process.exitCode = 1;
}
