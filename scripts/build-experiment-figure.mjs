#!/usr/bin/env node
/**
 * Generate a vector mechanism diagram for the evidence-gate pilot.
 *
 * The results table in the manuscript carries the complete measurements.
 * This diagram explains the code paths and the four interventions without
 * treating accepted output as proof that a citation ID was valid.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHeadlessChrome } from './lib/headless-chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.SCIENCEPRISM_FIGURE_DATA || path.join(ROOT, 'aidoc');
const OUT_DIR = process.env.SCIENCEPRISM_FIGURE_OUT || DATA_DIR;
const data = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'experiment-evidence-gate.json'), 'utf8'));
const FONT = 'PingFang SC, Hiragino Sans GB, Noto Sans CJK SC, sans-serif';
const C = {
  ink: '#172d3d',
  muted: '#536d7c',
  line: '#c9d8de',
  faint: '#eaf0f2',
  teal: '#147b82',
  tealDark: '#0d5962',
  tealPale: '#e9f5f3',
  blue: '#345d8b',
  bluePale: '#edf3f9',
  coral: '#bd4d3e',
  coralPale: '#fff0eb',
  white: '#ffffff'
};
const W = 1000;
const H = 675;

function esc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function text(value, x, y, { size = 16, weight = 400, fill = C.ink, anchor = 'start' } = {}) {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(value)}</text>`;
}
function box(x, y, width, height, { fill = C.white, stroke = C.line, radius = 12, dash = '' } = {}) {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}
function pathLine(d, { stroke = C.blue, width = 2.4, dash = '', marker = true } = {}) {
  return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}${marker ? ` marker-end="url(#arrow-${stroke === C.coral ? 'coral' : stroke === C.teal ? 'teal' : 'blue'})"` : ''}/>`;
}
function labelPill(value, x, y, width, { fill = C.bluePale, ink = C.blue } = {}) {
  return [box(x, y, width, 27, { fill, stroke: fill, radius: 13 }), text(value, x + width / 2, y + 19, { size: 14, weight: 650, fill: ink, anchor: 'middle' })].join('\n');
}
function paperCard(x, y, id, opacity = 1) {
  return `<g opacity="${opacity}">${box(x, y, 92, 89, { fill: C.white, stroke: C.line, radius: 7 })}
    <path d="M ${x + 13} ${y + 38} H ${x + 74} M ${x + 13} ${y + 51} H ${x + 70} M ${x + 13} ${y + 64} H ${x + 58}" stroke="${C.line}" stroke-width="3" stroke-linecap="round"/>
    ${labelPill(id, x + 11, y + 9, 35, { fill: C.tealPale, ink: C.tealDark })}
  </g>`;
}

const arms = [
  { code: 'A', key: 'no-gate', title: '无提示 · 无校验', detail: '证据输入：有' },
  { code: 'B', key: 'prompt-only', title: '提示规则 · 无校验', detail: '证据输入：有' },
  { code: 'C', key: 'enforced', title: '提示 + 代码门禁', detail: '证据输入：有' },
  { code: 'D', key: 'enforced-no-evidence', title: '同 C · 无证据输入', detail: '证据输入：无', red: true }
];

const body = [
  `<defs>
    <marker id="arrow-blue" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${C.blue}"/></marker>
    <marker id="arrow-teal" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${C.teal}"/></marker>
    <marker id="arrow-coral" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${C.coral}"/></marker>
  </defs>`,
  `<rect width="${W}" height="${H}" fill="${C.white}"/>`,
  `<rect x="41" y="31" width="5" height="50" rx="2.5" fill="${C.teal}"/>`,
  text('结构化写作中的证据门禁', 61, 59, { size: 29, weight: 700 }),
  text('C/D 的代码门禁路径：输入证据 → 生成主张 → 校验 → 接受或修复；A/B 为对照', 61, 86, { size: 16, fill: C.muted }),
  `<path d="M 41 108 H 959" stroke="${C.line}" stroke-width="1.5"/>`,

  // Four process compartments.
  box(42, 130, 199, 276, { fill: C.bluePale, stroke: '#dbe5ef' }),
  box(267, 130, 208, 276, { fill: '#f8fbfc', stroke: C.line }),
  box(501, 130, 230, 276, { fill: '#f8fbfc', stroke: C.line }),
  box(757, 130, 201, 276, { fill: C.tealPale, stroke: '#cde4e1' }),
  labelPill('01  INPUT', 57, 145, 100),
  labelPill('02  DRAFT', 282, 145, 110),
  labelPill('03  CHECK', 516, 145, 105),
  labelPill('04  OUTCOME', 772, 145, 125, { fill: '#d8edeb', ink: C.tealDark }),
  text('Evidence Ledger', 60, 200, { size: 18, weight: 700 }),
  text('结构化草稿', 284, 200, { size: 18, weight: 700 }),
  text('代码侧校验', 518, 200, { size: 18, weight: 700 }),
  text('流转结果', 773, 200, { size: 18, weight: 700 }),

  // The input is a stack of actual ledger records rather than decorative bars.
  paperCard(66, 224, 'P3', 0.78),
  paperCard(84, 212, 'P2', 0.88),
  paperCard(102, 202, 'P1'),
  text('A–C：3 篇已确认论文', 61, 329, { size: 14, weight: 600, fill: C.blue }),
  box(61, 346, 160, 41, { fill: C.white, stroke: C.coral, radius: 7, dash: '5 4' }),
  text('D：无可用证据', 141, 372, { size: 15, weight: 650, fill: C.coral, anchor: 'middle' }),

  // The draft object has explicit fields and thin relational links.
  box(289, 218, 165, 163, { fill: C.white, stroke: '#bacbd3', radius: 8 }),
  `<path d="M 289 245 H 454" stroke="${C.line}" stroke-width="1.5"/>`,
  `<circle cx="311" cy="233" r="6" fill="${C.teal}"/>`,
  text('JSON draft', 326, 238, { size: 15, weight: 700 }),
  labelPill('claims[]', 302, 260, 96),
  labelPill('evidenceIds[]', 302, 297, 137),
  labelPill('unsupportedClaims[]', 302, 337, 146, { fill: C.coralPale, ink: C.coral }),
  pathLine('M 399 273 C 425 273 414 307 438 307', { stroke: C.teal, width: 1.4, marker: false }),
  text('主张与引用关联', 289, 399, { size: 13, fill: C.muted }),

  // Validation stages and the disclosed exception are separate decisions.
  box(521, 222, 190, 47, { fill: C.white, stroke: C.line, radius: 8 }),
  labelPill('1', 532, 232, 27, { fill: C.bluePale, ink: C.blue }),
  text('解析引用 ID', 573, 252, { size: 16, weight: 600 }),
  pathLine('M 616 271 V 283', { stroke: C.blue, width: 1.7 }),
  box(521, 287, 190, 47, { fill: C.white, stroke: C.line, radius: 8 }),
  labelPill('2', 532, 297, 27, { fill: C.bluePale, ink: C.blue }),
  text('对照 Ledger', 573, 317, { size: 16, weight: 600 }),
  pathLine('M 616 336 V 348', { stroke: C.blue, width: 1.7 }),
  box(521, 352, 190, 39, { fill: C.coralPale, stroke: '#f2c5bc', radius: 8 }),
  text('例外：明确披露未支持主张', 616, 377, { size: 15, weight: 600, fill: C.coral, anchor: 'middle' }),

  // Outcomes retain the distinction between acceptance and valid citation.
  box(778, 223, 159, 69, { fill: C.white, stroke: '#b9d9d4', radius: 9 }),
  `<circle cx="800" cy="245" r="11" fill="${C.teal}"/>`,
  text('✓', 800, 251, { size: 16, weight: 700, fill: C.white, anchor: 'middle' }),
  text('接受草稿', 821, 251, { size: 17, weight: 700, fill: C.tealDark }),
  text('有效引用 / 明确披露', 790, 277, { size: 13, fill: C.muted }),
  box(778, 313, 159, 69, { fill: C.white, stroke: '#efc4bc', radius: 9 }),
  `<circle cx="800" cy="335" r="11" fill="${C.coral}"/>`,
  text('!', 800, 341, { size: 17, weight: 700, fill: C.white, anchor: 'middle' }),
  text('校验失败', 821, 341, { size: 17, weight: 700, fill: C.coral }),
  text('最多一次修复尝试', 790, 367, { size: 13, fill: C.muted }),

  // Diagram connectors use a single, controlled repair loop.
  pathLine('M 243 274 H 262', { stroke: C.blue }),
  pathLine('M 477 274 H 496', { stroke: C.blue }),
  pathLine('M 733 260 H 752', { stroke: C.teal }),
  pathLine('M 733 349 H 752', { stroke: C.coral }),
  pathLine('M 858 385 V 428 H 371 V 410', { stroke: C.coral, dash: '7 5', width: 2.2 }),
  labelPill('失败后修复一次', 486, 414, 126, { fill: C.coralPale, ink: C.coral }),

  // The crucial counterexample cannot be hidden by the aggregate outcome.
  box(42, 457, 916, 58, { fill: C.coralPale, stroke: '#f3d5ce', radius: 8 }),
  `<rect x="42" y="457" width="5" height="58" rx="2.5" fill="${C.coral}"/>`,
  text('D 臂例外：唯一接受稿引用了不存在的 “none”，因对应主张列入 unsupportedClaims 而放行。', 61, 483, { size: 16, weight: 600 }),
  text('因此，接受并不等于引用 ID 有效；D 臂 7 次修复均未把失败生成变成接受。', 61, 504, { size: 15, fill: C.coral }),

  text(`四臂干预与观测  ·  每臂 ${data.reps} 次生成`, 43, 550, { size: 18, weight: 700 })
];

arms.forEach((arm, index) => {
  const x = 42 + index * 231;
  const s = data.summary[arm.key];
  const accepted = Math.round(s.acceptedRate * data.reps);
  const accent = arm.red ? C.coral : C.teal;
  body.push(box(x, 565, 223, 83, { fill: arm.red ? C.coralPale : C.white, stroke: arm.red ? '#efc5bc' : C.line, radius: 8 }));
  body.push(box(x + 11, 579, 34, 34, { fill: arm.red ? C.coral : C.tealPale, stroke: arm.red ? C.coral : C.tealPale, radius: 7 }));
  body.push(text(arm.code, x + 28, 603, { size: 19, weight: 700, fill: arm.red ? C.white : C.teal, anchor: 'middle' }));
  body.push(text(arm.title, x + 53, 591, { size: 15, weight: 650 }));
  body.push(text(arm.detail, x + 53, 612, { size: 13, fill: C.muted }));
  body.push(text(`接受 ${accepted}/${data.reps}`, x + 13, 636, { size: 14, weight: 700, fill: accent }));
  if (arm.red) body.push(text(`伪造 ID ${s.fabricatedIdsTotal}`, x + 208, 636, { size: 14, weight: 700, fill: C.coral, anchor: 'end' }));
});
body.push(text('来源：aidoc/experiment-evidence-gate.json；机制依据：Evidence Ledger 校验与 Harness 修复路径。', 43, 667, { size: 12, fill: C.muted }));

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="结构化写作中的证据门禁机制框图">
<title>结构化写作中的证据门禁</title>
<desc>证据上下文经结构化草稿进入代码校验；无效引用可触发一次修复，显式披露的未支持主张可按例外路径放行。下方对比四臂干预与接受记录。</desc>
${body.join('\n')}
</svg>
`;
await fs.mkdir(OUT_DIR, { recursive: true });
const svgPath = path.join(OUT_DIR, 'experiment-results.svg');
const pdfPath = path.join(OUT_DIR, 'experiment-results.pdf');
await fs.writeFile(svgPath, svg, 'utf8');
const cacheRoot = path.join(ROOT, '.cache');
await fs.mkdir(cacheRoot, { recursive: true });
const scratch = await fs.mkdtemp(path.join(cacheRoot, 'experiment-figure-'));
const htmlPath = path.join(scratch, 'figure.html');
await fs.writeFile(htmlPath, `<!doctype html><meta charset="utf-8"><style>@page{size:${W}px ${H}px;margin:0}html,body{margin:0;padding:0}svg{display:block}</style><body>${svg}</body>`, 'utf8');
try {
  await runHeadlessChrome(['--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`]);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
console.log(`experiment-results.svg ${(await fs.stat(svgPath)).size} B`);
console.log(`experiment-results.pdf ${(await fs.stat(pdfPath)).size} B`);
