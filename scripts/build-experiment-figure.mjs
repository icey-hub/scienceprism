#!/usr/bin/env node
/**
 * Draws the results figure for the evidence-gate experiment.
 *
 * The paper shipped with an appendix of unrelated diagrams and no figure of its
 * own results, which is backwards: a results figure is the one figure an
 * empirical paper cannot do without.
 *
 * Reads the experiment JSON and emits an SVG plus a vector PDF into the
 * manuscript's figures directory. Colours follow the style the rest of the set
 * uses: one colour per condition, with the only arm where fabrication was
 * possible highlighted, and every bar labelled with its value so the reader does
 * not have to measure pixels.
 *
 * Usage: node scripts/build-experiment-figure.mjs
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.SCIENCEPRISM_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DATA_DIR = process.env.SCIENCEPRISM_FIGURE_DATA || path.join(REPO_ROOT, 'aidoc');
const DATA = path.join(DATA_DIR, 'experiment-evidence-gate.json');
const OUT_DIR = process.env.SCIENCEPRISM_FIGURE_OUT || DATA_DIR;

const FONT = 'Hiragino Sans GB, PingFang SC, Heiti SC, sans-serif';
const INK = '#1e293b';
const MUTED = '#64748b';
const SERIES = '#1d4ed8';
const HIGHLIGHT = '#b91c1c';

const experiment = JSON.parse(await fs.readFile(DATA, 'utf8'));
const ARMS = [
  { key: 'no-gate', label: 'A 无指令' },
  { key: 'prompt-only', label: 'B 仅指令' },
  { key: 'enforced', label: 'C 强制' },
  { key: 'enforced-no-evidence', label: 'D 强制\n无证据', highlight: true }
];

function esc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function text(value, x, y, { size = 13, anchor = 'start', color = INK, weight = '500' } = {}) {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${color}">${esc(value)}</text>`;
}

/**
 * One panel: a title, a value axis, four bars, and the value written above each
 * bar. Values are printed because the whole point of the figure is the numbers.
 */
function panel({ x, y, w, h, title, unit, values, max, format }) {
  const parts = [];
  const plotTop = y + 34;
  const plotBottom = y + h - 34;
  const plotHeight = plotBottom - plotTop;
  const slot = w / values.length;
  const barWidth = Math.min(46, slot * 0.5);

  parts.push(text(title, x, y + 14, { size: 13, weight: '700' }));
  if (unit) parts.push(text(unit, x + w, y + 14, { size: 11, anchor: 'end', color: MUTED }));

  parts.push(`<path d="M ${x} ${plotBottom} L ${x + w} ${plotBottom}" stroke="#cbd5e1" stroke-width="1"/>`);

  values.forEach((value, index) => {
    const arm = ARMS[index];
    const cx = x + slot * index + slot / 2;
    const barHeight = max > 0 ? Math.max(value > 0 ? 3 : 0, (value / max) * plotHeight) : 0;
    const colour = arm.highlight ? HIGHLIGHT : SERIES;
    if (barHeight > 0) {
      parts.push(`<rect x="${(cx - barWidth / 2).toFixed(1)}" y="${(plotBottom - barHeight).toFixed(1)}" width="${barWidth}" height="${barHeight.toFixed(1)}" rx="3" fill="${colour}"/>`);
    }
    parts.push(text(format(value), cx, plotBottom - barHeight - 7, { size: 12, anchor: 'middle', weight: '700', color: colour }));
    const lines = arm.label.split('\n');
    lines.forEach((line, lineIndex) => {
      parts.push(text(line, cx, plotBottom + 16 + lineIndex * 13, { size: 11.5, anchor: 'middle', color: arm.highlight ? HIGHLIGHT : MUTED }));
    });
  });

  return parts.join('\n');
}

const W = 940;
const H = 470;
const summary = experiment.summary;
const values = (key) => ARMS.map((arm) => summary[arm.key][key]);

const panels = [
  { title: '伪造的证据 id', unit: '个 / 全臂', values: values('fabricatedIdsTotal'), max: Math.max(...values('fabricatedIdsTotal')) || 1, format: (v) => String(v) },
  { title: '被接受率', unit: '比例', values: values('acceptedRate'), max: 1, format: (v) => v.toFixed(2) },
  { title: '声明的不确定性', unit: '均值 / 次', values: values('meanDeclaredUnsupported'), max: Math.max(...values('meanDeclaredUnsupported')) || 1, format: (v) => v.toFixed(2) }
];

const panelW = (W - 90) / 3;
const body = [
  text(`四臂消融：证据门禁是否改变产出（n=${experiment.reps} 次/臂，模型 ${experiment.model}）`, 30, 30, { size: 16, weight: '700' }),
  ...panels.map((panelSpec, index) => panel({ x: 30 + index * panelW, y: 52, w: panelW - 26, h: 300, ...panelSpec })),
  text('A/B/C 的输入里有 3 篇 human-confirmed 论文可引；D 的输入里没有任何证据。只有 D 存在伪造的可能。', 30, 392, { size: 12.5, color: MUTED }),
  text('D 臂：6 个引用 id 全部伪造，门禁拒绝 7/8 次，修复重试触发 7 次但修好 0 次。', 30, 412, { size: 12.5, weight: '700', color: HIGHLIGHT }),
  text('来源：aidoc/experiment-evidence-gate.json（scripts/experiment-evidence-gate.mjs 产出，严格串行）', 30, 440, { size: 11.5, color: MUTED })
].join('\n');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#ffffff"/>
${body}
</svg>
`;

await fs.mkdir(OUT_DIR, { recursive: true });
const svgPath = path.join(OUT_DIR, 'experiment-results.svg');
await fs.writeFile(svgPath, svg, 'utf8');

// Print a vector PDF, same route the other figures use, so it stays sharp.
const scratch = path.join(REPO_ROOT, '.cache', 'experiment-figure');
await fs.mkdir(scratch, { recursive: true });
const htmlPath = path.join(scratch, 'figure.html');
await fs.writeFile(htmlPath, `<!doctype html><meta charset="utf-8"><style>@page{size:${W}px ${H}px;margin:0}html,body{margin:0;padding:0}svg{display:block}</style><body>${svg}</body>`, 'utf8');

const pdfPath = path.join(OUT_DIR, 'experiment-results.pdf');
await new Promise((resolve, reject) => {
  const child = spawn(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`], { stdio: ['ignore', 'ignore', 'ignore'] });
  child.once('error', reject);
  child.once('close', resolve);
});
await fs.rm(scratch, { recursive: true, force: true });

const svgBytes = (await fs.stat(svgPath)).size;
const pdfBytes = (await fs.stat(pdfPath)).size;
console.log(`  experiment-results.svg  ${svgBytes} B`);
console.log(`  experiment-results.pdf  ${pdfBytes} B`);
for (const arm of ARMS) {
  const s = summary[arm.key];
  console.log(`  ${arm.label.replace('\n', ' ').padEnd(14)} fabricated=${s.fabricatedIdsTotal}  accepted=${s.acceptedRate}  declared=${s.meanDeclaredUnsupported}`);
}
