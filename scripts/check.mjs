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
if (manifest.webapp?.executeAs !== 'USER_DEPLOYING') throw new Error('Shared-link access must run as the deploying owner.');
if (manifest.webapp?.access !== 'ANYONE_ANONYMOUS') throw new Error('Shared-link access must allow opening without a Google login.');
const driveService = manifest.dependencies?.enabledAdvancedServices?.find(item => item.userSymbol === 'Drive');
if (driveService?.serviceId !== 'drive' || driveService?.version !== 'v3') {
  throw new Error('Source imports require the Advanced Drive v3 service.');
}
const sheetsService = manifest.dependencies?.enabledAdvancedServices?.find(item => item.userSymbol === 'Sheets');
if (sheetsService?.serviceId !== 'sheets' || sheetsService?.version !== 'v4') throw new Error('Contact workspaces require the Advanced Sheets v4 service.');
for (const scope of ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/script.external_request', 'https://www.googleapis.com/auth/script.scriptapp']) {
  if (!manifest.oauthScopes?.includes(scope)) throw new Error('Missing source import scope: ' + scope);
}
const mapping = JSON.parse(readFileSync('.clasp.json', 'utf8'));
if (mapping.rootDir !== 'src' || !mapping.scriptId) throw new Error('Apps Script project mapping missing.');
for (const required of ['Index.html', 'Styles.html', 'Client.html', 'GridPanel.html', 'GridStyles.html', 'GridClient.html', 'Code.gs', 'Config.gs', 'Segments.gs', 'SourceBases.gs', 'SourceImport.gs', 'ContactPreview.gs', 'ContactTarget.gs', 'PreparedData.gs', 'SourceRecords.gs', 'PreparedImport.gs', 'PreparedWorkbookImport.gs', 'SheetEditor.gs', 'SegmentActions.gs', 'SegmentAnalytics.gs', 'SegmentRecords.gs', 'SegmentImports.gs', 'ContactSync.gs', 'ContactAutomation.gs', 'Promouser.gs', 'Access.gs']) {
  if (!files.includes(required)) throw new Error(`Missing ${required}.`);
}
for (const required of ['ValidationPolicy.gs', 'LegacyContactHistory.gs', 'Coldy.gs', 'ColdyCampaigns.gs', 'ColdyValidation.gs', 'ColdyRecipientData.gs', 'ColdyRecipientImport.gs', 'ColdyRecipientSheet.gs', 'RegistryProjects.gs', 'ProjectAnalytics.gs', 'ProjectInfrastructure.gs', 'ProjectMonitoring.gs', 'ProjectCapacity.gs', 'ProjectForecast.gs', 'ProjectForecastCalc.gs', 'ProjectForecastDemand.gs', 'ProjectSendingHistory.gs', 'ProjectClient.html', 'ProjectPanel.html', 'ProjectStyles.html']) {
  if (!files.includes(required)) throw new Error(`Missing ${required}.`);
}
if (files.includes('TeamAccess.gs')) throw new Error('Role-based team administration must not ship in shared-link mode.');
for (const required of ['SegmentContactCard.gs','SegmentCardSnapshots.gs','SegmentCardMaintenance.gs','WorkbookMailingClient.html','ColdyWorkbookUpload.gs','CompanyTelegramExports.gs','SegmentLegacyPreview.gs','SegmentSelections.gs','SegmentCardClient.html','SegmentCardPanel.html','SegmentSelectionsClient.html','ServiceSettings.gs','ColdyServiceLimits.gs','ProjectCampaignCompletion.gs','ProjectCampaignProgress.gs','ColdyRecipientAutomation.gs']) {
  if (!files.includes(required)) throw new Error(`Missing ${required}.`);
}
console.log(`Validated ${scripts} scripts, HTML assets and Apps Script manifest.`);
