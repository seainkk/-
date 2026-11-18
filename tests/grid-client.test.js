import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../src/GridClient.html', import.meta.url), 'utf8');
const client = html.replace(/^<script>\s*/, '').replace(/\s*<\/script>\s*$/, '');
const functionSource = name => {
  const line = client.split('\n').find(value => value.trimStart().startsWith('function ' + name + '('));
  assert.ok(line, 'Actual grid helper exists: ' + name);
  return line.trim();
};
const context = () => {
  const scope = vm.createContext({});
  vm.runInContext(['gridText', 'gridColumnName', 'gridAddress', 'gridParseAddress', 'gridEncodeTsv', 'gridParseTsv', 'gridFailure'].map(functionSource).join('\n'), scope);
  return scope;
};
const plain = value => JSON.parse(JSON.stringify(value));

test('the complete packaged grid client parses as browser JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(client, { filename: 'GridClient.html' }));
});

test('spreadsheet column labels and A1 addresses are reversible without guessed coordinates', () => {
  const c = context();
  for (const [number, label] of [[1, 'A'], [26, 'Z'], [27, 'AA'], [52, 'AZ'], [53, 'BA'], [702, 'ZZ'], [703, 'AAA'], [16384, 'XFD']]) {
    assert.equal(c.gridColumnName(number), label);
    assert.equal(c.gridAddress(120, number), label + '120');
    assert.deepEqual(plain(c.gridParseAddress(label.toLowerCase() + '120')), { row: 120, column: number });
  }
  assert.deepEqual(plain(c.gridParseAddress(' $AB$17 ')), { row: 17, column: 28 });
  for (const value of ['A0', 'A-1', '0A', 'A', '1', 'A1:B3', '<b>A1</b>', 'AAAAA1']) assert.equal(c.gridParseAddress(value), null);
});

test('TSV paste preserves quoted multiline cells, tabs, empty cells and formula text', () => {
  const c = context();
  assert.deepEqual(plain(c.gridParseTsv('Компания\tEmail\r\n"Две\nстроки"\t=SUM(A1:A2)\r\n')), [['Компания', 'Email'], ['Две\nстроки', '=SUM(A1:A2)']]);
  assert.deepEqual(plain(c.gridParseTsv('a\tb\nonly one\n\n')), [['a', 'b'], ['only one', ''], ['', '']]);
  assert.deepEqual(plain(c.gridParseTsv('"a""b"\t\n')), [['a"b', '']]);
  assert.deepEqual(plain(c.gridParseTsv('')), [['']]);
  assert.throws(() => c.gridParseTsv('"unclosed'), /кавычки/);
});

test('copy and paste round trip user content without executing or dropping quotes', () => {
  const c = context();
  const values = [['<img src=x onerror=alert(1)>', '+79990000000', '=A1+1'], ['a\tb', 'two\nlines', '"quoted"']];
  const tsv = c.gridEncodeTsv(values);
  assert.deepEqual(plain(c.gridParseTsv(tsv)), values);
  assert.equal(c.gridText(false), 'false');
  assert.equal(c.gridText(0), '0');
  assert.equal(c.gridText(null), '');
});

test('grid failures distinguish a conflict from an unknown result without losing details', () => {
  const c = context();
  assert.deepEqual(plain(c.gridFailure(new Error('[GRID_CONFLICT] Ячейку уже изменили.'))), { code: 'GRID_CONFLICT', message: 'Ячейку уже изменили.' });
  assert.deepEqual(plain(c.gridFailure({ message: '[GRID_UNCERTAIN] Проверьте результат.\nПовтор безопасно сверит запрос.' })), { code: 'GRID_UNCERTAIN', message: 'Проверьте результат.\nПовтор безопасно сверит запрос.' });
});
