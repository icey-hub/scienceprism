import assert from 'node:assert/strict';
import test from 'node:test';
import { datasetFilename, previewDataset } from '../src/services/datasets/preview.js';
import { DatasetError } from '../src/services/datasets/download.js';

const preview = (value, filename = 'sample.csv', options = {}) => previewDataset(Buffer.from(value), { filename, ...options });

test('dataset filenames allow data formats and reject paths, hidden names and executable disguises', () => {
  for (const name of ['样本数据.CSV', 'train.tsv', 'records.jsonl', 'data.tar.gz', 'part-001.parquet', 'table.arrow', 'archive.zip']) assert.equal(datasetFilename(name), name);
  for (const name of [undefined, '', '.data.csv', '../data.csv', 'folder/data.csv', 'folder\\data.csv', 'C:data.csv',
    'https://example.org/data.csv', 'data%2Fsample.csv', 'data.csv\0', ' data.csv', 'data.csv ', 'data.exe', 'run.py.csv', 'data.pkl.gz',
    'NUL.csv', 'data.html', 'data', 'x'.repeat(256) + '.csv', '\ud800.csv']) {
    assert.throws(() => datasetFilename(name), error => error instanceof DatasetError && error.code === 'DATASET_FILENAME_INVALID' && error.statusCode === 400);
  }
});

test('CSV parses escaped quotes, commas, CRLF and multiline quoted fields without changing text', () => {
  const actual = preview('\ufeffname,note,empty\r\n"张三","comma, and ""quotes""",\r\nBob,"first\r\nsecond",ok\r\n');
  assert.deepEqual(actual.columns, ['name', 'note', 'empty']);
  assert.deepEqual(actual.rows, [['张三', 'comma, and "quotes"', ''], ['Bob', 'first\r\nsecond', 'ok']]);
  assert.equal(actual.rowCount, 2); assert.equal(actual.truncated, false); assert.equal(actual.split, 'unknown');
});

test('TSV supports quoted tabs and newlines and empty datasets do not invent rows', () => {
  const actual = preview('id\tnote\n1\t"a\tb\nc"\n', 'sample.tsv');
  assert.deepEqual(actual.rows, [['1', 'a\tb\nc']]); assert.equal(actual.rowCount, 1);
  for (const filename of ['empty.csv', 'empty.tsv', 'empty.txt']) {
    const empty = preview('', filename); assert.deepEqual(empty.rows, []); assert.equal(empty.rowCount, 0);
  }
  assert.equal(preview('header\n').rowCount, 0);
});

test('JSON records union observed columns and distinguish missing fields from recorded null and nested values', () => {
  const actual = preview(JSON.stringify([{ id: 1, empty: null, nested: { a: [true, 'x'] } }, { id: 2, label: 'next' }]), 'sample.json');
  assert.deepEqual(actual.columns, ['id', 'empty', 'nested', 'label']);
  assert.deepEqual(actual.rows, [['1', 'null', '{"a":[true,"x"]}', 'unknown'], ['2', 'unknown', 'unknown', 'next']]);
  assert.equal(actual.rowCount, 2); assert.equal(actual.split, 'unknown');
  const values = preview('[1,true,null,"plain",[1,2]]', 'sample.json');
  assert.deepEqual(values.columns, ['value']); assert.deepEqual(values.rows, [['1'], ['true'], ['null'], ['plain'], ['[1,2]']]);
  const unsafeKey = preview('[{"__proto__":"recorded","constructor":3}]', 'sample.json');
  assert.deepEqual(unsafeKey.rows, [['recorded', '3']]); assert.equal({}.recorded, undefined);
});

test('JSONL parses complete UTF-8 records and does not infer a split from the filename', () => {
  const actual = preview('{"text":"中文"}\n\n{"score":3}\r\n', 'train.ndjson');
  assert.equal(actual.format, 'jsonl'); assert.deepEqual(actual.columns, ['text', 'score']);
  assert.deepEqual(actual.rows, [['中文', 'unknown'], ['unknown', '3']]);
  assert.equal(actual.rowCount, 2); assert.equal(actual.split, 'unknown');
});

test('row, column and Unicode field limits return bounded samples without reporting sample length as total rows', () => {
  const csv = 'id\n' + Array.from({ length: 50 }, (_, index) => index).join('\n');
  const rows = preview(csv); assert.equal(rows.rows.length, 20); assert.equal(rows.truncated, true); assert.equal(rows.rowCount, undefined);
  const json = preview(JSON.stringify(Array.from({ length: 21 }, (_, id) => ({ id }))), 'sample.json');
  assert.equal(json.rows.length, 20); assert.equal(json.rowCount, undefined);
  const keys = Object.fromEntries(Array.from({ length: 105 }, (_, index) => [`key${index}`, index]));
  const columns = preview(JSON.stringify([keys]), 'sample.json'); assert.equal(columns.columns.length, 100);
  assert.equal(columns.rows[0].length, 100); assert.equal(columns.rowCount, undefined);
  const header = Array.from({ length: 105 }, (_, index) => `key${index}`).join(',');
  assert.equal(preview(header + '\n' + Array(105).fill('value').join(',')).columns.length, 100);
  for (const filename of ['sample.csv', 'sample.txt']) {
    const long = preview(filename.endsWith('csv') ? `text\n${'😀'.repeat(300)}` : '😀'.repeat(300), filename);
    assert(long.rows[0][0].length <= 256); assert(long.rows[0][0].isWellFormed()); assert.equal(long.truncated, true);
  }
});

test('a caller-supplied total byte length makes complete-looking prefix samples explicitly incomplete', () => {
  const csv = preview('id\n1\n', 'sample.csv', { byteLength: 100 });
  assert.deepEqual(csv.rows, [['1']]); assert.equal(csv.rowCount, undefined); assert.equal(csv.truncated, true); assert.match(csv.warning, /未知/);
  const jsonl = preview('{"id":1}\n{"id":', 'sample.jsonl', { byteLength: 100 });
  assert.deepEqual(jsonl.rows, [['1']]); assert.equal(jsonl.rowCount, undefined);
  const json = preview('[1]', 'sample.json', { byteLength: 100 });
  assert.deepEqual(json.rows, []); assert.equal(json.truncated, true); assert.match(json.warning, /not-previewable/);
  for (const byteLength of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => preview('id\n1', 'sample.csv', { byteLength }), { code: 'DATASET_PREVIEW_INPUT_INVALID' });
  }
});

test('one-MiB parsing cap ignores later bytes and safely handles a UTF-8 codepoint at the boundary', () => {
  const prefix = 'id\n1\n', data = Buffer.concat([Buffer.from(prefix + 'x'.repeat(1024 * 1024 - Buffer.byteLength(prefix) - 1)), Buffer.from('中文\nlate')]);
  const actual = previewDataset(data, { filename: 'large.csv' });
  assert.deepEqual(actual.rows, [['1']]); assert.equal(actual.truncated, true); assert.equal(actual.rowCount, undefined);
  assert.doesNotMatch(actual.warning, /编码|UTF-8/);
  const largeJson = preview('[' + ' '.repeat(1024 * 1024) + '1]', 'large.json');
  assert.equal(largeJson.truncated, true); assert.match(largeJson.warning, /1 MiB/);
});

test('malformed quoted text, JSON, nonfinite numbers and excessive nested structures are not presented as reliable data', () => {
  for (const text of ['id\n"unclosed', 'id\n"closed"tail', 'id\nbad"quote']) assert.match(preview(text).warning, /invalid-data/);
  for (const text of ['[', '{"id":1}', '[1e400]', '[{"nested":{"number":1e400}}]', '["\\ud800"]', '[{"\\ud800":1}]', '[' + '['.repeat(100) + '1' + ']'.repeat(100) + ']']) {
    const actual = preview(text, 'sample.json'); assert.deepEqual(actual.rows, []); assert.equal(actual.rowCount, undefined); assert.match(actual.warning, /invalid-data/);
  }
  assert.match(preview('{"id":1}\nnot-json', 'sample.jsonl').warning, /invalid-data/);
});

test('unsupported binary and compressed formats are never deserialized or decompressed', () => {
  for (const filename of ['data.zip', 'data.gz', 'data.parquet', 'data.arrow', 'data.npy', 'data.xlsx']) {
    const actual = previewDataset(Buffer.from([0x50, 0x4b, 0, 0xff]), { filename });
    assert.deepEqual(actual.columns, []); assert.deepEqual(actual.rows, []); assert.equal(actual.rowCount, undefined); assert.match(actual.warning, /not-previewable/);
  }
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from([0xff, 0xfe, 0x61, 0]), Buffer.from('id\n1\0')]) {
    const actual = previewDataset(bytes, { filename: 'data.csv' }); assert.deepEqual(actual.rows, []); assert.match(actual.warning, /not-previewable/);
  }
  assert.throws(() => previewDataset('id\n1', { filename: 'data.csv' }), { code: 'DATASET_PREVIEW_INPUT_INVALID' });
});

test('text and CSV retain HTML as plain strings and uneven rows expose missing fields honestly', () => {
  const markup = '<script>alert("data")</script>';
  assert.deepEqual(preview(markup, 'data.txt').rows, [[markup]]);
  assert.deepEqual(preview('text\n"<b>data</b>"').rows, [['<b>data</b>']]);
  const missing = preview('id,label\n1\n'); assert.deepEqual(missing.rows, [['1', 'unknown']]); assert.match(missing.warning, /字段数/);
  const extra = preview('id\n1,unmapped\n'); assert.deepEqual(extra.rows, [['1']]); assert.equal(extra.truncated, true); assert.equal(extra.rowCount, undefined);
});
