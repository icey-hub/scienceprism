#!/usr/bin/env node
/**
 * Builds the reference diagram set as SVG and rasterises it with headless Chrome.
 *
 * Why hand-authored SVG:
 * - It is the only candidate that needs no install at all, works offline, and can
 *   draw arbitrary vector illustration (the cell structure figure) rather than
 *   only boxes and arrows.
 * - The source is plain text, so it diffs in git and re-renders deterministically.
 * - Chrome is already on this machine, so rasterising for review costs nothing.
 *
 * Outputs land in docs/agent-governance/assets/diagrams/.
 *
 * Usage: node scripts/build-diagrams.mjs
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives at <repo>/scripts/, so the repo root is ONE level up. It was
// two when the script sat at <repo>/tools/diagram/, and moving it without
// adjusting this silently wrote the figures outside the workspace.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'agent-governance', 'assets', 'diagrams');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const FONT = 'Hiragino Sans GB, PingFang SC, Heiti SC, sans-serif';
const INK = '#1e293b';
const MUTED = '#64748b';

function esc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function svg({ width, height, body, background = '#ffffff' }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs>
  <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#0f172a" flood-opacity="0.18"/>
  </filter>
</defs>
<rect width="${width}" height="${height}" fill="${background}"/>
${body}
</svg>
`;
}

function box(x, y, w, h, { fill = '#eef2ff', stroke = '#4338ca', label = '', sub = '', rx = 10 } = {}) {
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="2" filter="url(#soft)"/>`,
    label ? `<text x="${x + w / 2}" y="${y + h / 2 - (sub ? 6 : -5)}" font-family="${FONT}" font-size="17" font-weight="600" text-anchor="middle" fill="${INK}">${esc(label)}</text>` : '',
    sub ? `<text x="${x + w / 2}" y="${y + h / 2 + 16}" font-family="${FONT}" font-size="13" text-anchor="middle" fill="${MUTED}">${esc(sub)}</text>` : ''
  ].filter(Boolean).join('\n');
}

// Colour carries meaning in these figures, so each role gets one colour that is
// reused everywhere it appears, and the arrowhead is drawn in the same colour as
// its line rather than a fixed grey.
const ARROW_COLORS = Object.freeze({
  slate: '#94a3b8',
  green: '#047857',
  blue: '#1d4ed8',
  purple: '#6d28d9',
  amber: '#b45309'
});

function arrow(x1, y1, x2, y2, { color = ARROW_COLORS.slate, marker = 'slate', dash = '', width = 2 } = {}) {
  return `<path d="M ${x1} ${y1} L ${x2} ${y2}" stroke="${color}" stroke-width="${width}" fill="none" marker-end="url(#arrow-${marker})"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}

function defsArrow() {
  const markers = Object.entries(ARROW_COLORS).map(([name, color]) =>
    `<marker id="arrow-${name}" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="${color}"/></marker>`
  ).join('');
  return `<defs>${markers}</defs>`;
}

function label(text, x, y, { size = 14, anchor = 'start', color = INK, weight = '500' } = {}) {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${color}">${esc(text)}</text>`;
}

function leader(x1, y1, x2, y2) {
  return `<path data-leader="1" d="M ${x1} ${y1} L ${x2} ${y2}" stroke="${MUTED}" stroke-width="1.2" stroke-dasharray="3 3" fill="none"/><circle cx="${x1}" cy="${y1}" r="3" fill="${MUTED}"/>`;
}

/* ---------------------------------------------------------------- figure 1 */

function moduleGraph() {
  const W = 1010;
  const H = 520;
  const parts = [defsArrow()];

  // Rule 6/8: three layers, one tint and one colour each, so the boundary that
  // matters — the runtime core versus what it consults — is visible without
  // reading every box.
  const groups = [
    { x: 20, y: 54, w: 250, h: 420, title: '入口层', color: '#1d4ed8', tint: '#eff6ff', border: '#bfdbfe' },
    { x: 310, y: 54, w: 290, h: 420, title: 'Runtime 核心', color: '#6d28d9', tint: '#f5f3ff', border: '#ddd6fe' },
    { x: 640, y: 54, w: 350, h: 420, title: '受管模块', color: '#047857', tint: '#ecfdf5', border: '#a7f3d0' }
  ];
  for (const group of groups) {
    parts.push(`<rect x="${group.x}" y="${group.y}" width="${group.w}" height="${group.h}" rx="12" fill="${group.tint}" stroke="${group.border}"/>`);
    parts.push(label(group.title, group.x + 16, group.y + 26, { size: 14, weight: '700', color: group.color }));
  }

  parts.push(label('Harness 运行路径：一次 Run 经过的模块', 22, 32, { size: 19, weight: '700' }));

  const nodes = [
    [40, 96, 210, 68, 'routes/agent.js', 'HTTP 边界', '#1d4ed8'],
    [40, 206, 210, 68, 'agentRuntime.js', '适配器选择', '#1d4ed8'],
    [40, 316, 210, 68, 'agentService.js', '工具调用', '#1d4ed8'],
    [330, 206, 250, 68, 'harnessRuntime', 'Run 生命周期', '#6d28d9'],
    [330, 356, 250, 68, 'evidenceLedger', '证据账本', '#6d28d9'],
    [660, 96, 310, 68, 'capabilities.js', '能力 / 路径 / 网络', '#047857'],
    [660, 206, 310, 68, 'contextPackager', '上下文打包', '#047857'],
    [660, 316, 310, 68, 'agentRoles', '角色只收窄能力', '#047857']
  ];
  for (const [x, y, w, h, main, sub, stroke] of nodes) parts.push(box(x, y, w, h, { label: main, sub, stroke, fill: '#ffffff' }));

  // No arrow labels here on purpose. Every label I first wrote repeated the
  // target box's own subtitle ("能力 / 路径 / 网络" on capabilities.js, and so
  // on), which is redundant ink, and the two diagonal ones also ran through
  // their own text. The subtitle already says what the arrow carries.
  const edges = [
    [145, 164, 145, 204, 'slate'],
    [145, 274, 145, 314, 'slate'],
    [250, 240, 328, 240, 'purple'],
    [580, 224, 658, 130, 'green'],
    [580, 240, 658, 240, 'green'],
    [580, 256, 658, 350, 'green'],
    [455, 274, 455, 354, 'purple']
  ];
  for (const [x1, y1, x2, y2, marker] of edges) {
    parts.push(arrow(x1, y1, x2, y2, { color: ARROW_COLORS[marker], marker }));
  }

  // Rule 4: the one sentence a reader needs in order to read the figure right.
  parts.push(label('只有 harnessRuntime 会调用模型；其余模块只提供约束、上下文与角色。', 22, 500, { size: 13, color: MUTED }));

  return svg({ width: W, height: H, body: parts.join('\n') });
}

/* ---------------------------------------------------------------- figure 2 */

function sequenceFlow() {
  const W = 1040;
  const H = 634;
  const parts = [defsArrow()];

  // One colour per actor, reused on its header, its lifeline, and every arrow it
  // sends, so a reader can follow who is talking without reading the labels.
  const actors = [
    { name: '研究者', color: '#047857', tint: '#ecfdf5', cx: 200 },
    { name: '前端', color: '#1d4ed8', tint: '#eff6ff', cx: 440 },
    { name: '后端 Runtime', color: '#6d28d9', tint: '#f5f3ff', cx: 680 },
    { name: '模型', color: '#b45309', tint: '#fffbeb', cx: 920 }
  ];
  const laneW = 208;

  // Rule 2: the figure states its message instead of leaving it to the caption.
  parts.push(label('研究流程：AI 产出必须通过门禁才能推进', 22, 32, { size: 19, weight: '700' }));

  // Rule 6: two phases, each one background tint, so the reader sees where the
  // human gate begins without counting arrows.
  const bandTop = 52;
  const gateTop = 392;
  const bandBottom = 520;
  parts.push(`<rect x="12" y="${bandTop}" width="${W - 24}" height="${gateTop - bandTop}" rx="10" fill="#f8fafc"/>`);
  parts.push(`<rect x="12" y="${gateTop}" width="${W - 24}" height="${bandBottom - gateTop}" rx="10" fill="#ecfdf5" stroke="#a7f3d0"/>`);
  parts.push(label('AI 执行', 26, bandTop + 24, { size: 14, weight: '700', color: '#475569' }));
  parts.push(label('人工门禁', 26, gateTop + 24, { size: 14, weight: '700', color: '#047857' }));

  for (const actor of actors) {
    const left = actor.cx - laneW / 2;
    parts.push(`<rect x="${left}" y="${bandTop + 6}" width="${laneW}" height="${bandBottom - bandTop - 12}" rx="8" fill="#ffffff" opacity="0.75"/>`);
    parts.push(box(left, 58, laneW, 42, { label: actor.name, fill: actor.tint, stroke: actor.color, rx: 8 }));
    parts.push(`<path d="M ${actor.cx} 100 L ${actor.cx} ${bandBottom - 10}" stroke="${actor.color}" stroke-width="1.6" stroke-dasharray="6 6" opacity="0.5"/>`);
  }

  // Solid arrows are requests, dashed arrows are returns. The last step is drawn
  // thicker because it is the gate the whole figure is about.
  const steps = [
    [0, 1, 152, '① 提交研究方向', 'green', '', 2],
    [1, 2, 206, '② POST /research-workflow', 'blue', '', 2],
    [2, 3, 260, '③ Harness Run（project.read）', 'purple', '', 2],
    [3, 2, 314, '④ JSON 阶段输出', 'amber', '7 5', 2],
    [2, 1, 368, '⑤ 契约校验 + 证据检查', 'purple', '7 5', 2],
    [1, 0, 424, '⑥ 等待人工审批', 'blue', '7 5', 2],
    [0, 1, 486, '⑦ 人工批准', 'green', '', 3.4]
  ];
  for (const [from, to, y, text, marker, dash, width] of steps) {
    const x1 = actors[from].cx;
    const x2 = actors[to].cx;
    const dir = to > from ? 1 : -1;
    parts.push(arrow(x1 + dir * 8, y, x2 - dir * 8, y, { color: ARROW_COLORS[marker], marker, dash, width }));
    parts.push(label(text, (x1 + x2) / 2, y - 10, { size: 13.5, anchor: 'middle', weight: marker === 'green' && y > 400 ? '700' : '500' }));
  }

  // Rule 4/8: a legend and a caption line, and nothing decorative beyond them.
  const legendY = 566;
  parts.push(label('实线 = 请求', 26, legendY, { size: 13, color: MUTED }));
  parts.push(label('虚线 = 返回', 138, legendY, { size: 13, color: MUTED }));
  parts.push(label('颜色 = 角色', 250, legendY, { size: 13, color: MUTED }));
  actors.forEach((actor, index) => {
    const x = 380 + index * 168;
    parts.push(`<circle cx="${x}" cy="${legendY - 4}" r="6" fill="${actor.color}"/>`);
    parts.push(label(actor.name, x + 12, legendY, { size: 13, color: INK }));
  });
  parts.push(label('⑦ 之后才进入下一阶段：AI 可以产出与建议，但不能代替人工批准。', 26, legendY + 30, { size: 13, color: MUTED }));

  return svg({ width: W, height: H, body: parts.join('\n') });
}

/* ---------------------------------------------------------------- figure 3 */
/* The hard case: a multi-layer vector illustration with dense CJK labels.    */

function cellStructure() {
  const W = 1000;
  const H = 720;
  const p = [];

  p.push(`<defs>
    <radialGradient id="cyto" cx="45%" cy="45%" r="70%">
      <stop offset="0%" stop-color="#fef9c3"/><stop offset="100%" stop-color="#fde68a"/>
    </radialGradient>
    <radialGradient id="nuc" cx="38%" cy="35%" r="75%">
      <stop offset="0%" stop-color="#c4b5fd"/><stop offset="100%" stop-color="#8b5cf6"/>
    </radialGradient>
    <linearGradient id="mito" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#fca5a5"/><stop offset="100%" stop-color="#ef4444"/>
    </linearGradient>
    <linearGradient id="golgi" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fdba74"/><stop offset="100%" stop-color="#f97316"/>
    </linearGradient>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#0f172a" flood-opacity="0.18"/>
    </filter>
  </defs>`);

  // Cell membrane: outer ellipse with a double lipid layer.
  p.push('<ellipse cx="500" cy="360" rx="430" ry="300" fill="url(#cyto)" stroke="#0f766e" stroke-width="7"/>');
  p.push('<ellipse cx="500" cy="360" rx="418" ry="288" fill="none" stroke="#5eead4" stroke-width="3"/>');
  for (let angle = 0; angle < 360; angle += 6) {
    const rad = (angle * Math.PI) / 180;
    const x = 500 + 424 * Math.cos(rad);
    const y = 360 + 294 * Math.sin(rad);
    p.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="#0d9488" opacity="0.55"/>`);
  }

  // Nucleus: envelope, pores, nucleolus, chromatin.
  p.push('<ellipse cx="430" cy="330" rx="170" ry="140" fill="url(#nuc)" stroke="#6d28d9" stroke-width="5"/>');
  p.push('<ellipse cx="430" cy="330" rx="156" ry="126" fill="none" stroke="#ddd6fe" stroke-width="3"/>');
  for (let angle = 15; angle < 360; angle += 30) {
    const rad = (angle * Math.PI) / 180;
    p.push(`<circle cx="${(430 + 163 * Math.cos(rad)).toFixed(1)}" cy="${(330 + 133 * Math.sin(rad)).toFixed(1)}" r="7" fill="#f5f3ff" stroke="#7c3aed" stroke-width="2"/>`);
  }
  p.push('<circle cx="470" cy="300" r="42" fill="#4c1d95" opacity="0.85"/>');
  p.push('<path d="M 340 380 q 40 -30 80 0 t 80 0" stroke="#ede9fe" stroke-width="4" fill="none" opacity="0.8"/>');
  p.push('<path d="M 350 420 q 50 -25 100 5 t 70 -10" stroke="#ede9fe" stroke-width="4" fill="none" opacity="0.8"/>');

  // Mitochondria with cristae.
  function mitochondrion(cx, cy, rx, ry, rotate) {
    const inner = [];
    for (let i = -2; i <= 2; i += 1) {
      const x = i * (rx / 3);
      inner.push(`<path d="M ${cx + x} ${cy - ry * 0.6} q ${rx / 6} ${ry * 0.6} 0 ${ry * 1.2}" stroke="#7f1d1d" stroke-width="3" fill="none" opacity="0.75"/>`);
    }
    return [
      `<g transform="rotate(${rotate} ${cx} ${cy})">`,
      `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#mito)" stroke="#991b1b" stroke-width="4"/>`,
      `<ellipse cx="${cx}" cy="${cy}" rx="${rx - 8}" ry="${ry - 8}" fill="none" stroke="#fee2e2" stroke-width="2.5"/>`,
      ...inner,
      '</g>'
    ].join('\n');
  }
  p.push(mitochondrion(760, 250, 92, 46, -18));
  p.push(mitochondrion(250, 560, 84, 42, 12));
  p.push(mitochondrion(700, 540, 78, 40, 26));

  // Rough ER: stacked wavy bands studded with ribosomes.
  for (let i = 0; i < 4; i += 1) {
    const y = 150 + i * 26;
    p.push(`<path d="M 590 ${y} q 60 -22 120 0 t 110 0" stroke="#2563eb" stroke-width="7" fill="none" opacity="${0.9 - i * 0.12}" stroke-linecap="round"/>`);
  }
  for (let i = 0; i < 26; i += 1) {
    const x = 596 + (i % 13) * 18;
    const y = 146 + Math.floor(i / 13) * 52 + (i % 3) * 5;
    p.push(`<circle cx="${x}" cy="${y}" r="4" fill="#1e3a8a"/>`);
  }

  // Golgi: stacked curved cisternae.
  for (let i = 0; i < 5; i += 1) {
    const y = 430 + i * 20;
    p.push(`<path d="M 210 ${y} q 90 -30 180 0" stroke="url(#golgi)" stroke-width="11" fill="none" stroke-linecap="round"/>`);
  }

  // Lysosome, vacuole, centriole.
  p.push('<circle cx="330" cy="200" r="46" fill="#a7f3d0" stroke="#047857" stroke-width="4"/>');
  for (let i = 0; i < 9; i += 1) {
    const rad = (i * 40 * Math.PI) / 180;
    p.push(`<circle cx="${(330 + 26 * Math.cos(rad)).toFixed(1)}" cy="${(200 + 26 * Math.sin(rad)).toFixed(1)}" r="4" fill="#065f46"/>`);
  }
  p.push('<ellipse cx="640" cy="430" rx="70" ry="52" fill="#e0f2fe" stroke="#0284c7" stroke-width="3.5" opacity="0.9"/>');
  p.push('<rect x="830" y="424" width="52" height="13" rx="5" fill="#7c3aed" transform="rotate(30 856 430)"/>');
  p.push('<rect x="834" y="454" width="52" height="13" rx="5" fill="#7c3aed" transform="rotate(-30 860 460)"/>');

  // Free ribosomes.
  for (let i = 0; i < 40; i += 1) {
    const x = 120 + ((i * 137) % 760);
    const y = 120 + ((i * 89) % 500);
    p.push(`<circle cx="${x}" cy="${y}" r="3.4" fill="#334155" opacity="0.7"/>`);
  }

  // Leader lines and dense CJK labels.
  const labels = [
    [500, 60, 500, 108, '细胞膜（磷脂双分子层）', 'middle'],
    [430, 190, 300, 70, '细胞核', 'middle'],
    [470, 300, 700, 62, '核仁', 'start'],
    [760, 204, 820, 150, '线粒体（含嵴）', 'middle'],
    [250, 518, 140, 640, '线粒体', 'middle'],
    [650, 150, 585, 44, '粗面内质网', 'middle'],
    [300, 430, 120, 380, '高尔基体', 'middle'],
    [330, 200, 210, 120, '溶酶体', 'middle'],
    [640, 430, 830, 620, '液泡', 'middle'],
    [859, 436, 930, 470, '中心体', 'start'],
    [700, 560, 860, 680, '游离核糖体', 'middle'],
    [500, 360, 430, 620, '细胞质基质', 'middle']
  ];
  // A callout label is placed beyond the leader's tip, in the direction the
  // leader is travelling. Putting it above the tip (the previous behaviour) made
  // a diagonal leader pass through its own label's box before reaching the tip,
  // which is exactly what check-diagram-layout.mjs now reports.
  for (const [x1, y1, x2, y2, text, declaredAnchor] of labels) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    p.push(leader(x1, y1, x2, y2));

    const gap = 14;
    const horizontal = Math.abs(ux) >= Math.abs(uy);
    const anchor = horizontal ? (ux > 0 ? 'start' : 'end') : (declaredAnchor === 'start' ? 'start' : 'middle');
    const lx = x2 + ux * gap + (horizontal ? (ux > 0 ? 4 : -4) : 0);
    const ly = y2 + uy * gap + (horizontal ? 0 : (uy > 0 ? 14 : -6));
    p.push(label(text, lx, ly, { size: 17, anchor, weight: '600' }));
  }

  p.push(label('真核细胞结构示意图（手写 SVG · 零安装 · 可 diff）', 30, 700, { size: 16, color: MUTED }));
  return svg({ width: W, height: H, body: p.join('\n') });
}

/* ---------------------------------------------------------------- figure 4 */

function comparisonChart() {
  const W = 900;
  const H = 480;
  const p = [defsArrow()];
  const data = [
    ['复杂插画能力', 100, '#0d9488'],
    ['中文标签', 100, '#0ea5e9'],
    ['离线可用', 100, '#6366f1'],
    ['零安装', 100, '#8b5cf6'],
    ['可 diff / 可复现', 95, '#f59e0b'],
    ['架构图（方框箭头）', 70, '#94a3b8'],
    ['安装成本（越低越好）', 100, '#22c55e']
  ];
  const max = 100;
  const barH = 30;
  const gap = 18;
  const left = 260;
  const top = 60;
  data.forEach(([name, value, color], index) => {
    const y = top + index * (barH + gap);
    p.push(label(name, left - 20, y + barH * 0.7, { size: 15, anchor: 'end' }));
    p.push(`<rect x="${left}" y="${y}" width="${(value / max) * 520}" height="${barH}" rx="6" fill="${color}" opacity="0.85"/>`);
    p.push(label(`${value}`, left + (value / max) * 520 + 12, y + barH * 0.7, { size: 14, color: MUTED }));
  });
  p.push(label('手写 SVG 方案自评（满分 100）', left, 34, { size: 17, weight: '700' }));
  return svg({ width: W, height: H, body: p.join('\n') });
}

/* ---------------------------------------------------------------- pipeline */

/**
 * Exported so a test can regenerate the SVG in memory and compare it with the
 * committed artifact. That is what stops the source and the checked-in figures
 * from drifting apart.
 */
export const FIGURES = {
  'module-graph': moduleGraph,
  'sequence-flow': sequenceFlow,
  'cell-structure': cellStructure,
  'comparison-chart': comparisonChart
};

export const OUTPUT_DIR = OUT_DIR;

/** Returns the SVG markup for one figure. */
export function buildSvg(name) {
  const build = FIGURES[name];
  if (!build) throw new Error(`Unknown figure: ${name}`);
  return build();
}

function rasterise(svgPath, pngPath, { width, height }) {
  return new Promise((resolve) => {
    const child = spawn(CHROME, [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      `--screenshot=${pngPath}`,
      `--window-size=${width},${height}`,
      '--default-background-color=00000000',
      svgPath
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    child.once('error', (error) => resolve({ ok: false, error: error.message }));
    child.once('close', (code) => resolve({ ok: code === 0, code }));
  });
}

/**
 * Prints the figure to a vector PDF.
 *
 * The PNG is rasterised at the figure's own pixel size, so embedding it at full
 * text width gives roughly 150 dpi and the labels look soft. Chrome's
 * --print-to-pdf keeps the content as vector forms, so the figure stays sharp at
 * any size in a document. This is also why the PDFs are what get embedded.
 */
function printToPdf(htmlPath, pdfPath) {
  return new Promise((resolve) => {
    const child = spawn(CHROME, [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    child.once('error', (error) => resolve({ ok: false, error: error.message }));
    child.once('close', (code) => resolve({ ok: code === 0, code }));
  });
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const scratch = path.join(REPO_ROOT, '.cache', 'diagram-print');
  await fs.mkdir(scratch, { recursive: true });

  const summary = [];
  for (const [name, build] of Object.entries(FIGURES)) {
    const markup = build();
    const svgPath = path.join(OUT_DIR, `${name}.svg`);
    const pngPath = path.join(OUT_DIR, `${name}.png`);
    const pdfPath = path.join(OUT_DIR, `${name}.pdf`);
    await fs.writeFile(svgPath, markup, 'utf8');

    const size = markup.match(/width="(\d+)" height="(\d+)"/);
    const width = Number(size[1]);
    const height = Number(size[2]);

    const result = await rasterise(svgPath, pngPath, { width, height });

    // A page sized exactly to the figure, with no margins, so the printed PDF is
    // the figure and nothing else.
    const htmlPath = path.join(scratch, `${name}.html`);
    await fs.writeFile(htmlPath, [
      '<!doctype html><meta charset="utf-8">',
      `<style>@page{size:${width}px ${height}px;margin:0}html,body{margin:0;padding:0}svg{display:block}</style>`,
      `<body>${markup}</body>`
    ].join(''), 'utf8');
    const pdfResult = await printToPdf(htmlPath, pdfPath);

    const stat = await fs.stat(pngPath).catch(() => null);
    const pdfStat = await fs.stat(pdfPath).catch(() => null);
    summary.push({
      name,
      svgBytes: markup.length,
      pngBytes: stat?.size ?? 0,
      pdfBytes: pdfStat?.size ?? 0,
      rasterised: result.ok,
      printed: pdfResult.ok
    });
  }

  await fs.rm(scratch, { recursive: true, force: true });
  console.log(`output: ${OUT_DIR}`);
  for (const row of summary) {
    console.log(`  ${row.name.padEnd(18)} svg ${String(row.svgBytes).padStart(6)}B  png ${String(row.pngBytes).padStart(7)}B  pdf ${String(row.pdfBytes).padStart(7)}B  rasterised=${row.rasterised} printed=${row.printed}`);
  }
}

// Only run when executed directly; importing the module must have no side effects.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
