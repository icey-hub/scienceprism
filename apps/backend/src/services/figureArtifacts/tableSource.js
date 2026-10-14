import { ResearchWorkflowError } from '../researchWorkflow/errors.js';
const fail = message => { throw new ResearchWorkflowError(400, 'FIGURE_TABLE_INVALID', message); };
export function parseLatexFigureTable(latex) {
  if (typeof latex !== 'string' || !latex.trim() || latex.length > 200000 || !latex.isWellFormed()) fail('请输入200000字内的真实LaTeX表格。');
  const text = latex.replace(/(?<!\\)%[^\n]*/g, '');
  const tables = [...text.matchAll(/\\begin\{tabular\}\{([lcr|\s]+)\}([\s\S]*?)\\end\{tabular\}/g)];
  if (tables.length !== 1 || (text.match(/\\begin\{tabular/g) || []).length !== 1) fail('仅支持一个常见l/c/r列的tabular；复杂合并、多行和嵌套需先提供明确数值表。');
  const width = tables[0][1].replace(/[|\s]/g, '').length;
  if (width < 2 || width > 13) fail('表格须为一个组别列及1至12个数值列。');
  const content = tables[0][2].replace(/\\(?:toprule|midrule|bottomrule|hline)\b/g, '').replace(/\\addlinespace(?:\[[^\]]*\])?/g, '');
  if (/\\\\\s*\[/.test(content)) fail('不支持未明确处理的行间距命令，请保留完整数值行后移除排版间距。');
  if (/\\(?:multicolumn|multirow|makecell|shortstack|cmidrule|cline)\b/.test(content)) fail('合并单元格或多行含义不明确，不能自动绘图。');
  const pieces = content.split(/\\\\/); if (!pieces.at(-1).trim()) pieces.pop();
  if (pieces.length < 2 || pieces.length > 201 || pieces.some(row => !row.trim())) fail('需有表头及1至200个完整数据行；不能省略空行。');
  const unwrap = raw => {
    let value = raw.trim();
    while (/^\\(?:textbf|textit|textrm|mathrm)\{[\s\S]*\}$/.test(value)) value = value.slice(value.indexOf('{') + 1, -1).trim();
    if (value.startsWith('$') && value.endsWith('$')) value = value.slice(1, -1).trim();
    value = value.replace(/\\([_%&#])/g, '$1');
    if (!value || value.length > 500 || /[\\{}$\x00-\x1f\x7f]/.test(value)) fail('单元格含不支持的命令、表达式或多行文本。');
    return value;
  };
  const rows = pieces.map(piece => {
    const cells = piece.trim().split(/(?<!\\)&/);
    if (cells.length !== width) fail('每行列数必须和tabular声明一致，不会静默吞行。');
    return cells.map(unwrap);
  });
  const headers = rows.shift();
  if (new Set(headers).size !== headers.length) fail('表头名称须唯一，以便明确各数值系列。');
  const series = headers.slice(1).map(name => ({ name, values: [] }));
  for (const row of rows) for (let index = 1; index < width; index++) {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(row[index])) fail('数值需为有限数字；±、范围、脚注、百分号及未定义表达式不能猜测，需先明确数值与单位。');
    const value = Number(row[index]); if (!Number.isFinite(value) || Math.abs(value) > 1e100) fail('数值须有限且绝对值不超过1e100。');
    series[index - 1].values.push(value);
  }
  return { headers, rowLabels: rows.map(row => row[0]), series };
}
