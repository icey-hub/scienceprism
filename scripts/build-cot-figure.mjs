#!/usr/bin/env node
/**
 * Results figure for the chain-of-thought experiment.
 *
 * Three panels, each answering one question the paper asks:
 *   (a) does any condition beat another        -> accuracy by condition
 *   (b) do the conditions disagree per item    -> paired outcome breakdown
 *   (c) is the answer or the reasoning right   -> answer-vs-reasoning agreement
 *
 * Colours follow the set's convention: neutral blue for the conditions, red only
 * where the point of the panel is a deficit.
 *
 * Usage: node scripts/build-cot-figure.mjs
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.SCIENCEPRISM_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const experiment = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'aidoc', 'experiment-cot-gsm8k.json'), 'utf8'));
const analysis = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'aidoc', 'experiment-cot-gsm8k-analysis.json'), 'utf8'));
const artifacts = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'aidoc', 'experiment-cot-gsm8k-artifacts.json'), 'utf8'));

const FONT = 'Hiragino Sans GB, PingFang SC, Heiti SC, sans-serif';
const INK = '#1e293b';
const MUTED = '#64748b';
const SERIES = '#1d4ed8';
const ACCENT = '#b45309';
const DEFICIT = '#b91c1c';

const W = 1000;
const H = 470;
const parts = [];

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (v, x, y, { size = 13, anchor = 'start', color = INK, weight = '500' } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${color}">${esc(v)}</text>`;

const conditions = ['direct', 'cot', 'format'];
const LABELS = { direct: 'direct', cot: 'CoT', format: 'format' };

parts.push(text(`GSM8K 上的思维链消融（n=${analysis.n} 题 × 3 条件，模型 ${experiment.model}）`, 28, 30, { size: 16, weight: '700' }));

/* Panel (a): accuracy by condition, exact-match vs numerically corrected */
{
  const x = 28;
  const y = 54;
  const w = 300;
  const h = 250;
  const plotBottom = y + h - 34;
  const plotTop = y + 40;
  const plotHeight = plotBottom - plotTop;
  const max = 1;

  parts.push(text('(a) 各条件准确率', x, y + 14, { size: 13.5, weight: '700' }));
  parts.push(text('越接近 1 越好', x + w, y + 14, { size: 11, anchor: 'end', color: MUTED }));
  parts.push(`<path d="M ${x} ${plotBottom} L ${x + w} ${plotBottom}" stroke="#cbd5e1"/>`);

  const slot = w / conditions.length;
  conditions.forEach((condition, index) => {
    const strict = experiment.summary[condition].declaredAccuracy;
    const corrected = artifacts.correctedAccuracy[condition].numericCorrected;
    const cx = x + slot * index + slot / 2;
    const barW = 34;
    const hStrict = (strict / max) * plotHeight;
    const hCorrected = (corrected / max) * plotHeight;
    parts.push(`<rect x="${cx - barW - 2}" y="${plotBottom - hStrict}" width="${barW}" height="${hStrict}" rx="3" fill="${SERIES}"/>`);
    parts.push(`<rect x="${cx + 2}" y="${plotBottom - hCorrected}" width="${barW}" height="${hCorrected}" rx="3" fill="${ACCENT}"/>`);
    parts.push(text(strict.toFixed(3), cx - barW / 2 - 2, plotBottom - hStrict - 6, { size: 11.5, anchor: 'middle', weight: '700', color: SERIES }));
    parts.push(text(corrected.toFixed(3), cx + barW / 2 + 2, plotBottom - hCorrected - 6, { size: 11.5, anchor: 'middle', weight: '700', color: ACCENT }));
    parts.push(text(LABELS[condition], cx, plotBottom + 17, { size: 12, anchor: 'middle', color: MUTED }));
  });
  parts.push(`<rect x="${x}" y="${y + h + 2}" width="10" height="10" rx="2" fill="${SERIES}"/>`);
  parts.push(text('exact-match', x + 15, y + h + 11, { size: 11, color: MUTED }));
  parts.push(`<rect x="${x + 92}" y="${y + h + 2}" width="10" height="10" rx="2" fill="${ACCENT}"/>`);
  parts.push(text('数值等价修正后', x + 107, y + h + 11, { size: 11, color: MUTED }));
}

/* Panel (b): paired outcomes, direct vs cot */
{
  const x = 360;
  const y = 54;
  const w = 280;
  const h = 250;
  const plotBottom = y + h - 34;
  const plotTop = y + 40;
  const plotHeight = plotBottom - plotTop;

  const paired = analysis.paired.direct_vs_cot;
  const bars = [
    { label: '两者都对', value: paired.both, color: SERIES },
    { label: '仅 direct 对', value: paired.onlyA, color: ACCENT },
    { label: '仅 CoT 对', value: paired.onlyB, color: ACCENT },
    { label: '两者都错', value: paired.neither, color: DEFICIT }
  ];
  const max = Math.max(...bars.map((b) => b.value));

  parts.push(text('(b) direct vs CoT：逐题配对', x, y + 14, { size: 13.5, weight: '700' }));
  parts.push(text('同一批题', x + w, y + 14, { size: 11, anchor: 'end', color: MUTED }));
  parts.push(`<path d="M ${x} ${plotBottom} L ${x + w} ${plotBottom}" stroke="#cbd5e1"/>`);

  const slot = w / bars.length;
  bars.forEach((bar, index) => {
    const cx = x + slot * index + slot / 2;
    const height = (bar.value / max) * plotHeight;
    parts.push(`<rect x="${cx - 22}" y="${plotBottom - height}" width="44" height="${height}" rx="3" fill="${bar.color}"/>`);
    parts.push(text(String(bar.value), cx, plotBottom - height - 6, { size: 12, anchor: 'middle', weight: '700', color: bar.color }));
    parts.push(text(bar.label, cx, plotBottom + 17, { size: 11.5, anchor: 'middle', color: MUTED }));
  });
  parts.push(text('不一致仅 2 题：CoT 净增益为 0', x, y + h + 13, { size: 11.5, weight: '700', color: MUTED }));
}

/* Panel (c): answer vs reasoning agreement */
{
  const x = 672;
  const y = 54;
  const w = 300;
  const h = 250;
  const plotBottom = y + h - 34;
  const plotTop = y + 40;
  const plotHeight = plotBottom - plotTop;

  const r = analysis.reasoningVsAnswer;
  const bars = [
    { label: '两者都对', value: r.bothRight, color: SERIES },
    { label: '仅答案对', value: r.ansOnly, color: DEFICIT },
    { label: '仅推理对', value: r.reaOnly, color: ACCENT },
    { label: '都错', value: r.bothWrong, color: '#94a3b8' }
  ];
  const max = Math.max(...bars.map((b) => b.value));

  parts.push(text('(c) 隐藏推理 vs 可见答案', x, y + 14, { size: 13.5, weight: '700' }));
  parts.push(text('三条件合计', x + w, y + 14, { size: 11, anchor: 'end', color: MUTED }));
  parts.push(`<path d="M ${x} ${plotBottom} L ${x + w} ${plotBottom}" stroke="#cbd5e1"/>`);

  const slot = w / bars.length;
  bars.forEach((bar, index) => {
    const cx = x + slot * index + slot / 2;
    const height = (bar.value / max) * plotHeight;
    parts.push(`<rect x="${cx - 24}" y="${plotBottom - height}" width="48" height="${height}" rx="3" fill="${bar.color}"/>`);
    parts.push(text(String(bar.value), cx, plotBottom - height - 6, { size: 12, anchor: 'middle', weight: '700', color: bar.color }));
    parts.push(text(bar.label, cx, plotBottom + 17, { size: 11.5, anchor: 'middle', color: MUTED }));
  });
  parts.push(text('答案正确而推理末数错误 25 次，反向仅 1 次', x, y + h + 13, { size: 11.5, weight: '700', color: DEFICIT }));
}

parts.push(text(`判分伪影：${artifacts.gradingArtifact.numericallyEqualButMarkedWrong} 次数值相等但字符串不同（如 12 vs 12.00），另 ${artifacts.gradingArtifact.parseFailures} 次解析失败。`, 28, 380, { size: 12.5, color: MUTED }));
parts.push(text('结论：对推理模型而言，提示方式几乎不改变结果；主要误差来自题目难度与判分规则，而不是提示。', 28, 402, { size: 13, weight: '700', color: INK }));
parts.push(text('数据：GSM8K 测试集（Cobbe et al., 2021），aidoc/experiment-cot-gsm8k.json，temperature 0，串行调用', 28, 440, { size: 11.5, color: MUTED }));

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n<rect width="${W}" height="${H}" fill="#ffffff"/>\n${parts.join('\n')}\n</svg>\n`;

const outDir = path.join(REPO_ROOT, 'aidoc');
await fs.mkdir(outDir, { recursive: true });
const svgPath = path.join(outDir, 'cot-results.svg');
await fs.writeFile(svgPath, svg, 'utf8');

const scratch = path.join(REPO_ROOT, '.cache', 'cot-figure');
await fs.mkdir(scratch, { recursive: true });
const htmlPath = path.join(scratch, 'figure.html');
await fs.writeFile(htmlPath, `<!doctype html><meta charset="utf-8"><style>@page{size:${W}px ${H}px;margin:0}html,body{margin:0;padding:0}svg{display:block}</style><body>${svg}</body>`, 'utf8');
const pdfPath = path.join(outDir, 'cot-results.pdf');
await new Promise((resolve, reject) => {
  const child = spawn(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`], { stdio: ['ignore', 'ignore', 'ignore'] });
  child.once('error', reject);
  child.once('close', resolve);
});
const pngPath = path.join(scratch, 'figure.png');
await new Promise((resolve) => {
  const child = spawn(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', `--screenshot=${pngPath}`, `--window-size=${W},${H}`, '--default-background-color=ffffffff', `file://${htmlPath}`], { stdio: ['ignore', 'ignore', 'ignore'] });
  child.once('close', resolve);
});
await fs.copyFile(pngPath, path.join(outDir, 'cot-results.png'));
await fs.rm(scratch, { recursive: true, force: true });

console.log(`  cot-results.svg  ${(await fs.stat(svgPath)).size} B`);
console.log(`  cot-results.pdf  ${(await fs.stat(pdfPath)).size} B`);
console.log(`  cot-results.png  ${(await fs.stat(path.join(outDir, 'cot-results.png'))).size} B`);
