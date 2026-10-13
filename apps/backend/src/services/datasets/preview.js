import { DatasetError } from './download.js';

const MAX_BYTES = 1024 * 1024, MAX_ROWS = 20, MAX_COLUMNS = 100, MAX_FIELD = 256;
const extensions = new Set(['csv', 'tsv', 'json', 'jsonl', 'ndjson', 'txt', 'parquet', 'arrow', 'feather', 'zip', 'gz', 'gzip', 'bz2', 'xz', 'zst', 'tar', 'npy', 'npz', 'h5', 'hdf5', 'xlsx', 'xls']);
const executable = /\.(?:js|mjs|cjs|ts|py|pyc|sh|bash|zsh|bat|cmd|ps1|exe|dll|com|scr|jar|wasm|app|pkl|pickle)(?:\.|$)/i;

/** A display/storage filename, never a filesystem path or an executable. */
export function datasetFilename(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || value !== value.trim() || !value
    || value.startsWith('.') || /[\x00-\x1f\x7f/\\:%<>|?*]/.test(value) || Buffer.byteLength(value) > 255
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) || executable.test(value)
    || !extensions.has(value.split('.').at(-1).toLowerCase())) {
    throw new DatasetError('DATASET_FILENAME_INVALID', '数据文件名必须是普通数据格式的文件名，不能包含路径、隐藏名称或可执行扩展名。');
  }
  return value;
}

function clip(value, state) {
  if (value.length > MAX_FIELD) {
    state.truncated = true;
    let end = MAX_FIELD;
    if (/[\uD800-\uDBFF]/.test(value[end - 1])) end--;
    value = value.slice(0, end);
  }
  if (!value.isWellFormed()) throw new Error('文本包含无效的 Unicode 字符。');
  return value;
}

function cell(value, state) {
  if (value === undefined) return 'unknown';
  if (value === null) return 'null';
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('JSON 包含不能准确表示的非有限数值。');
  if (typeof value !== 'object') return clip(String(value), state);
  let count = 0;
  const depths = new WeakMap();
  const encoded = JSON.stringify(value, function (key, current) {
    if (++count > 2000) throw new Error('嵌套字段超过预览结构限制。');
    if (typeof current === 'number' && !Number.isFinite(current)) throw new Error('JSON 包含不能准确表示的非有限数值。');
    if (current && typeof current === 'object') {
      const depth = key === '' && this[key] === value ? 0 : (depths.get(this) || 0) + 1;
      if (depth > 32) throw new Error('嵌套字段超过预览深度限制。');
      depths.set(current, depth);
    }
    return current;
  });
  return clip(encoded, state);
}

function table(records, state) {
  const keys = [], seen = new Set();
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  for (const record of records) {
    for (const key of object(record) ? Object.keys(record) : ['value']) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (keys.length === MAX_COLUMNS) { state.truncated = true; continue; }
      keys.push(key);
    }
  }
  return { columns: keys.map(key => clip(key, state)), rows: records.map(record => keys.map(key =>
    cell(object(record) ? (Object.hasOwn(record, key) ? record[key] : undefined) : key === 'value' ? record : undefined, state))) };
}

function delimited(text, delimiter, state, inputTruncated) {
  const records = []; let row = [], field = '', column = 0, quoted = false, closed = false, touched = false, more = false;
  const append = character => { touched = true; if (field.length <= MAX_FIELD) field += character; else state.truncated = true; };
  const finishCell = () => {
    if (column < MAX_COLUMNS) row.push(clip(field, state)); else state.truncated = true;
    column++; field = ''; closed = false;
  };
  const finishRow = () => {
    finishCell(); records.push(row); row = []; column = 0; touched = false;
    if (records.length > MAX_ROWS + 1) { more = true; state.truncated = true; return true; }
    return false;
  };
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (character === '"') {
        if (text[i + 1] === '"') { append('"'); i++; }
        else { quoted = false; closed = true; }
      } else append(character);
    } else if (character === delimiter) { touched = true; finishCell(); }
    else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[i + 1] === '\n') i++;
      if (finishRow()) break;
    } else if (character === '"' && !field && !closed) { quoted = true; touched = true; }
    else if (closed || character === '"') throw new Error('分隔文本的引号格式无效。');
    else append(character);
  }
  if (!more && !inputTruncated) {
    if (quoted) throw new Error('分隔文本包含未闭合的引号。');
    if (touched || row.length || column) finishRow();
  }
  const columns = records.shift() || [], rows = records.slice(0, MAX_ROWS);
  if (rows.some(record => record.length !== columns.length)) state.warning = '样本行的字段数与表头不同；缺少的字段显示为 unknown，额外字段不展示。';
  if (rows.some(record => record.length > columns.length)) state.truncated = true;
  return { columns, rows: rows.map(record => columns.map((_, index) => record[index] ?? 'unknown')), count: rows.length };
}

/** Decode at most 1 MiB. Preview counts describe complete data only; no
 * compression, binary deserialization, code execution or HTML rendering. */
export function previewDataset(bytes, { filename, byteLength = bytes?.byteLength } = {}) {
  const name = datasetFilename(filename), extension = name.split('.').at(-1).toLowerCase();
  const format = extension === 'ndjson' ? 'jsonl' : extension;
  if (!(bytes instanceof Uint8Array)) throw new DatasetError('DATASET_PREVIEW_INPUT_INVALID', '预览输入必须是数据文件字节。');
  if (!Number.isSafeInteger(byteLength) || byteLength < bytes.byteLength) throw new DatasetError('DATASET_PREVIEW_INPUT_INVALID', '原始文件长度必须是不小于预览字节数的安全整数。');
  const state = { truncated: byteLength > Math.min(bytes.byteLength, MAX_BYTES) };
  const empty = warning => ({ format, columns: [], rows: [], truncated: state.truncated, warning, split: 'unknown' });
  if (!['csv', 'tsv', 'json', 'jsonl', 'txt'].includes(format)) return empty('not-previewable: 当前格式不支持文本预览；文件不会被解压或执行。');
  const sample = bytes.subarray(0, MAX_BYTES);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: state.truncated }); }
  catch { return empty('not-previewable: 文件不是有效 UTF-8 文本，当前不转换其编码。'); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return empty('not-previewable: 文件包含二进制或不支持的控制字符。');
  const inputTruncated = state.truncated;
  try {
    let result;
    if (format === 'csv' || format === 'tsv') result = delimited(text, format === 'csv' ? ',' : '\t', state, inputTruncated);
    else if (format === 'json') {
      if (inputTruncated) return empty('not-previewable: JSON 超过 1 MiB 解析上限，未将不完整内容解释为完整数据。');
      const records = JSON.parse(text);
      if (!Array.isArray(records)) throw new Error('JSON 预览需要记录或值的数组。');
      if (records.length > MAX_ROWS) state.truncated = true;
      result = { ...table(records.slice(0, MAX_ROWS), state), count: records.length };
    } else {
      let lines = text ? text.split(/\r\n|\n|\r/) : [];
      if (inputTruncated || lines.at(-1) === '') lines.pop();
      if (format === 'jsonl') lines = lines.filter(line => line.trim());
      if (lines.length > MAX_ROWS) state.truncated = true;
      const sampleLines = lines.slice(0, MAX_ROWS);
      result = format === 'jsonl' ? { ...table(sampleLines.map(line => JSON.parse(line)), state), count: lines.length }
        : { columns: ['text'], rows: sampleLines.map(line => [clip(line, state)]), count: lines.length };
    }
    if (state.truncated && !state.warning) state.warning = '仅展示有界样本，字段或内容可能截断；数据总行数未知。';
    return { format, columns: result.columns, rows: result.rows, truncated: state.truncated,
      ...(!state.truncated ? { rowCount: result.count } : {}), ...(state.warning ? { warning: state.warning } : {}), split: 'unknown' };
  } catch (error) { return empty(`invalid-data: ${error instanceof SyntaxError ? '数据格式无效，无法可靠预览。' : error.message}`); }
}
