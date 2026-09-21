import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { ensureDir } from '../utils/fsUtils.js';
import { getEnv } from '../config/constants.js';

function resolvePythonExecutable() {
  if (getEnv('PYTHON')) return getEnv('PYTHON');
  if (process.env.CONDA_PREFIX) return `${process.env.CONDA_PREFIX}/bin/python`;
  return 'python3';
}

export async function runPythonPlot(payload) {
  const runId = crypto.randomUUID();
  const tmpDir = path.join('/tmp', `scienceprism_plot_${runId}`);
  await ensureDir(tmpDir);
  const payloadPath = path.join(tmpDir, 'payload.json');
  await fs.writeFile(payloadPath, JSON.stringify(payload), 'utf8');
  const pythonScript = `
import json, os, sys, re, importlib.util
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HAS_PANDAS = importlib.util.find_spec("pandas") is not None
HAS_SEABORN = importlib.util.find_spec("seaborn") is not None
pd = None
sns = None
if HAS_PANDAS:
    import pandas as pd
if HAS_SEABORN:
    import seaborn as sns


def parse_table(latex):
    m = re.search(r'\\\\begin{tabular}.*?\\\\end{tabular}', latex, re.S)
    if m:
        latex = m.group(0)
    latex = re.sub(r'\\\\begin{tabular}{[^}]*}', '', latex)
    latex = re.sub(r'\\\\end{tabular}', '', latex)
    latex = re.sub(r'\\\\(toprule|midrule|bottomrule|hline)', '', latex)
    latex = latex.replace('\\\\\\n', '\\\\\\\\')
    rows = [r.strip() for r in latex.split('\\\\\\\\') if r.strip()]
    data = []
    for row in rows:
        if row.strip().startswith('%'):
            continue
        # split on unescaped &
        raw_cells = [c.strip() for c in re.split(r'(?<!\\\\)&', row)]
        if len(raw_cells) == 1 and raw_cells[0] == '':
            continue
        expanded = []
        for cell in raw_cells:
            m = re.match(r'\\\\multicolumn\\{(\\d+)\\}\\{[^}]*\\}\\{(.+)\\}', cell)
            if m:
                span = int(m.group(1))
                content = m.group(2).strip()
                expanded.append(content)
                for _ in range(span - 1):
                    expanded.append('')
            else:
                m2 = re.match(r'\\\\multirow\\{[^}]*\\}\\{[^}]*\\}\\{(.+)\\}', cell)
                expanded.append(m2.group(1).strip() if m2 else cell)
        data.append(expanded)
    return data


def is_number(val):
    try:
        float(val)
        return True
    except Exception:
        return False


def pick_col(columns, spec, fallback_idx):
    if spec is not None:
        spec = str(spec).strip()
        if spec.isdigit():
            idx = int(spec) - 1
            if 0 <= idx < len(columns):
                return columns[idx]
        if spec in columns:
            return spec
    if 0 <= fallback_idx < len(columns):
        return columns[fallback_idx]
    return columns[0]


payload = json.load(open(sys.argv[1], 'r', encoding='utf-8'))
latex = payload.get('tableLatex', '')
chart_type = payload.get('chartType', 'bar')
title = payload.get('title', '')
output_path = payload.get('outputPath', '')
plot_code = payload.get('plotCode', '')

if not latex or not output_path:
    raise RuntimeError('Missing input or output path')

data = parse_table(latex)
if not data:
    raise RuntimeError('No table rows parsed')

max_cols = max(len(r) for r in data)
if all(not is_number(c) for c in data[0]):
    header = data[0]
    rows = data[1:]
else:
    header = [f'col{i+1}' for i in range(max_cols)]
    rows = data

if len(header) < max_cols:
    header = header + [f'col{i+1}' for i in range(len(header), max_cols)]
elif len(header) > max_cols:
    header = header[:max_cols]

if not rows:
    raise RuntimeError('No data rows after header')

rows = [(r + [''] * (max_cols - len(r)))[:max_cols] for r in rows]

plt.figure(figsize=(6, 4))
df = None
df_numeric = None
if HAS_PANDAS:
    df = pd.DataFrame(rows, columns=header)
    df_numeric = df.apply(lambda col: pd.to_numeric(col, errors='coerce'))

if not plot_code:
    raise RuntimeError('Missing plot code')

exec(plot_code, {"df": df, "df_numeric": df_numeric, "rows": rows, "header": header, "sns": sns, "plt": plt})

if title:
    plt.title(title)
plt.tight_layout()
os.makedirs(os.path.dirname(output_path), exist_ok=True)
plt.savefig(output_path, dpi=150)
`;
  const scriptPath = path.join(tmpDir, 'plot.py');
  await fs.writeFile(scriptPath, pythonScript, 'utf8');

  return new Promise((resolve) => {
    const pythonBin = resolvePythonExecutable();
    const proc = spawn(pythonBin, [scriptPath, payloadPath], { cwd: tmpDir });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('close', async (code) => {
      await fs.rm(tmpDir, { recursive: true, force: true });
      if (code !== 0) {
        resolve({ ok: false, error: stderr || stdout || `Python exited with ${code} (${pythonBin})` });
        return;
      }
      resolve({ ok: true });
    });
  });
}
