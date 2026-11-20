import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = name => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8');
const registry = read('Index.html'), grid = read('GridPanel.html');
const client = read('Client.html'), gridClient = read('GridClient.html');
const tag = (source, id) => {
  const tags = source.match(/<[a-z][^>]*>/gi) || [];
  const found = tags.filter(value => new RegExp('\\bid=["\']' + id + '["\']').test(value));
  assert.equal(found.length, 1, 'Exactly one static control: ' + id);
  return found[0];
};

test('Coldy clients remain valid browser JavaScript in their packaged script elements', () => {
  for (const [name, html] of [['Client.html', client], ['GridClient.html', gridClient]]) {
    const script = html.replace(/^\s*<script>\s*/, '').replace(/\s*<\/script>\s*$/, '');
    assert.doesNotThrow(() => new vm.Script(script, { filename: name }));
  }
});

test('the global Coldy key has a write-only password control and starts empty', () => {
  assert.match(tag(registry, 'br-coldy-dialog'), /^<dialog\b/);
  assert.match(tag(registry, 'br-coldy-key'), /\btype=["']password["']/);
  assert.doesNotMatch(tag(registry, 'br-coldy-key'), /\bvalue=["'][^"']+/);
  for (const id of ['br-coldy-open', 'br-coldy-save', 'br-coldy-test', 'br-coldy-configured', 'br-coldy-message']) tag(registry, id);
});

test('provider choice stays separate from manual credits and the existing Promouser dollar budget', () => {
  assert.match(tag(registry, 'br-coldy-provider'), /^<select\b/);
  const providers = registry.match(/<select\b[^>]*id=["']br-coldy-provider["'][^>]*>([\s\S]*?)<\/select>/i)?.[1] || '';
  assert.match(providers, /value=["']promouser["']/);
  assert.match(providers, /value=["']coldy["']/);
  assert.doesNotMatch(registry, /\bid=["']br-coldy-auto["']/);
  assert.doesNotMatch(registry, /\bid=["']br-coldy-credit-consent["']/);
  tag(registry, 'br-provider-dialog');
  tag(registry, 'br-provider-limit');
});

test('Coldy readiness polling has a 15 second floor and stops when the server disallows continuation', () => {
  const helper = gridClient.split('\n').find(line => line.trimStart().startsWith('function coldyValidationPollDelay('));
  assert.ok(helper, 'Actual Coldy polling helper exists');
  const time = gridClient.split('\n').find(line => line.trimStart().startsWith('function validationTime('));
  const scope = vm.createContext({});
  vm.runInContext(time + '\n' + helper, scope);
  const now = 2000000000000;
  const dto = { configured: true, enabled: true, state: 'processing', canAutoAdvance: true,
    nextActionAt: now - 1000, jobs: [{ state: 'processing' }] };
  assert.equal(scope.coldyValidationPollDelay(dto, now), 15000);
  assert.equal(scope.coldyValidationPollDelay({ ...dto, nextActionAt: now + 20000 }, now), 20000);
  assert.equal(scope.coldyValidationPollDelay({ ...dto, nextActionAt: new Date(now + 20000).toISOString() }, now), 20000);
  assert.equal(scope.coldyValidationPollDelay({ ...dto, canAutoAdvance: false }, now), null);
  assert.equal(scope.coldyValidationPollDelay({ ...dto, configured: false }, now), null);
  assert.equal(scope.coldyValidationPollDelay({ configured: true, state: 'pending', jobs: [] }, now), null);
});

test('campaign and validation actions expose a preview before an explicit mutation', () => {
  for (const id of ['br-coldy-bindings-panel', 'br-coldy-campaign', 'br-coldy-companies', 'br-coldy-lpr',
    'br-coldy-autoupload', 'br-coldy-active-consent', 'br-coldy-binding-save', 'br-coldy-upload-preview',
    'br-coldy-upload-start', 'br-coldy-upload-retry']) tag(registry, id);
  assert.match(tag(registry, 'br-coldy-active-consent'), /\btype=["']checkbox["']/);
  assert.doesNotMatch(tag(registry, 'br-coldy-active-consent'), /\bchecked(?:[\s=>]|$)/);
  for (const id of ['rg-grid-coldy-preview', 'rg-grid-coldy-credit-consent', 'rg-grid-coldy-start',
    'rg-grid-coldy-refresh', 'rg-grid-coldy-retry', 'rg-grid-coldy-message', 'rg-grid-coldy-counts', 'rg-grid-coldy-jobs']) tag(grid, id);
  assert.match(tag(grid, 'rg-grid-coldy-credit-consent'), /\btype=["']checkbox["']/);
  assert.doesNotMatch(tag(grid, 'rg-grid-coldy-credit-consent'), /\bchecked(?:[\s=>]|$)/);
  for (const id of ['rg-grid-phone-preview', 'rg-grid-phone-start', 'rg-grid-phone-retry',
    'rg-grid-phone-counts', 'rg-grid-phone-sample', 'rg-grid-phone-message']) tag(grid, id);
  for (const id of ['rg-grid-pv-email-section', 'rg-grid-pv-email-preview', 'rg-grid-pv-email-start',
    'rg-grid-pv-email-retry', 'rg-grid-pv-email-counts', 'rg-grid-pv-email-sample', 'rg-grid-pv-email-message']) tag(grid, id);
});
