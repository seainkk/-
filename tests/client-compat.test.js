import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../src/Client.html', import.meta.url), 'utf8');
const client = html.replace(/^<script>\s*/, '').replace(/\s*<\/script>\s*$/, '');
const functionSource = name => {
  const line = client.split('\n').find(value => value.trimStart().startsWith('function ' + name + '('));
  assert.ok(line, 'Actual client function is present: ' + name);
  return line.trim();
};

test('the complete shipped client parses as browser JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(client, { filename: 'Client.html' }));
});

test('actual nativeUrl preserves sheet identifiers and encodes URL components', () => {
  const nativeUrl = vm.runInNewContext(functionSource('nativeUrl') + ';nativeUrl;');
  const base = 'https://docs.google.com/spreadsheets/d/file_123-ABC/edit';
  assert.equal(nativeUrl('file_123-ABC'), base);
  assert.equal(nativeUrl('file_123-ABC', undefined), base);
  assert.equal(nativeUrl('file_123-ABC', 0), base + '#gid=0');
  assert.equal(nativeUrl('file_123-ABC', 123), base + '#gid=123');
  assert.equal(nativeUrl('file_123-ABC', '456'), base + '#gid=456');
  assert.equal(nativeUrl('file_123-ABC', ''), base + '#gid=');
  assert.equal(nativeUrl('file_123-ABC', null), base + '#gid=null');
  assert.equal(nativeUrl('file" /?#', '" /?#'),
    'https://docs.google.com/spreadsheets/d/file%22%20%2F%3F%23/edit#gid=%22%20%2F%3F%23');
});

test('actual notice renders errors as text with a separate trusted native link', () => {
  const node = {
    children: [],
    replaceChildren() { this.children = []; },
    append(child) { this.children.push(child); },
  };
  const context = {
    $: id => { assert.equal(id, 'br-notice'); return node; },
    document: {
      createTextNode: value => ({ nodeType: 3, textContent: value }),
      createElement: tagName => ({ tagName }),
    },
  };
  vm.runInNewContext(functionSource('nativeUrl') + '\n' + functionSource('notice'), context);
  context.notice('<img src=x onerror=alert(1)>', 'error', { id: 'file" 123' });
  assert.equal(node.hidden, false);
  assert.equal(node.className, 'br-notice br-error');
  assert.equal(node.children[0].nodeType, 3);
  assert.equal(node.children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(node.children[1].href, 'https://docs.google.com/spreadsheets/d/file%22%20123/edit');
  assert.equal(node.children[1].target, '_blank');
  assert.equal(node.children[1].rel, 'noopener noreferrer');
  context.notice(null);
  assert.equal(node.hidden, true);
  assert.equal(node.className, 'br-notice');
  assert.equal(node.children.length, 0);
});
