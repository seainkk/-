import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = path.resolve('src');
const files = readdirSync(source);
let scripts = 0;
for (const name of files) {
  const code = readFileSync(path.join(source, name), 'utf8');
  if (name.endsWith('.gs')) {
    new vm.Script(code, { filename: name });
    scripts++;
  }
  if (name.endsWith('.html')) {
    for (const match of code.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      new vm.Script(match[1], { filename: name });
      scripts++;
    }
    if (/https?:\/\/[^\s"']+\.(?:js|css)(?:[?"'\s])/i.test(code)) {
      throw new Error(`External UI dependency in ${name}: use packaged assets.`);
    }
  }
}
const manifest = JSON.parse(readFileSync(path.join(source, 'appsscript.json'), 'utf8'));
if (manifest.runtimeVersion !== 'V8') throw new Error('V8 runtime required.');
if (manifest.webapp?.executeAs !== 'USER_ACCESSING') throw new Error('Run as accessing user required.');
if (manifest.webapp?.access !== 'ANYONE' && manifest.webapp?.access !== 'DOMAIN') {
  throw new Error('Signed-in access required.');
}
const driveService = manifest.dependencies?.enabledAdvancedServices?.find(item => item.userSymbol === 'Drive');
if (driveService?.serviceId !== 'drive' || driveService?.version !== 'v3') {
  throw new Error('Source imports require the Advanced Drive v3 service.');
}
for (const scope of ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/script.external_request']) {
  if (!manifest.oauthScopes?.includes(scope)) throw new Error('Missing source import scope: ' + scope);
}
const mapping = JSON.parse(readFileSync('.clasp.json', 'utf8'));
if (mapping.rootDir !== 'src' || !mapping.scriptId) throw new Error('Apps Script project mapping missing.');
for (const required of ['Index.html', 'Styles.html', 'Client.html', 'Code.gs', 'Config.gs', 'Segments.gs', 'SourceBases.gs', 'SourceImport.gs', 'SegmentActions.gs', 'SegmentAnalytics.gs', 'TeamAccess.gs']) {
  if (!files.includes(required)) throw new Error(`Missing ${required}.`);
}
console.log(`Validated ${scripts} scripts, HTML assets and Apps Script manifest.`);
