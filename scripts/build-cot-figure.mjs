#!/usr/bin/env node
/**
 * Results figure for the chain-of-thought experiment.
 *
 * Redrawn in English to match the manuscript, and rebuilt around what the panels
 * actually have to show rather than three sets of bars:
 *
 *   (a) accuracy by condition as a dumbbell with 95% Wilson intervals, so the
 *       reader sees both the point estimate and how little the conditions differ
 *   (b) the per-item paired outcome as a 2x2 matrix, because "190 of 200 both
 *       correct, 2 discordant" is a contingency table, not a bar chart
 *   (c) answer versus hidden reasoning as a second matrix, which is where the
 *       asymmetry shows
 *
 * Follows the project's figure rules: at most eight categorical colours, no
 * decorative ink, values printed rather than left to the reader to measure, and
 * a caption line stating what each panel means.
 *
 * Usage: node scripts/build-cot-figure.mjs
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.SCIENCEPRISM_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Overridable so a gate can point the generator at perturbed data and check
// that the figure actually changes: a figure with hardcoded numbers would not.
const DATA_DIR = process.env.SCIENCEPRISM_FIGURE_DATA || path.join(REPO_ROOT, 'aidoc');
const OUT_DIR = process.env.SCIENCEPRISM_FIGURE_OUT || DATA_DIR;
const experiment = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'experiment-cot-gsm8k.json'), 'utf8'));
const analysis = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'experiment-cot-gsm8k-analysis.json'), 'utf8'));
const artifacts = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'experiment-cot-gsm8k-artifacts.json'), 'utf8'));

const FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif';
const INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#d1d5db';
const SERIES_A = '#1d4ed8';
const SERIES_B = '#b45309';
const WARN = '#b91c1c';
const CALM = '#9ca3af';

const W = 1080;
const H = 436;
const parts = [];

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (v, x, y, { size = 12.5, anchor = 'start', color = INK, weight = '500', family = FONT } = {}) =>
  `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${color}">${esc(v)}</text>`;

/** Wilson score interval — the right interval for a proportion near 1. */
function wilson(k, n, z = 1.96) {
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const n = analysis.n;
const CONDITIONS = [
  { id: 'direct', label: 'Direct' },
  { id: 'cot', label: 'Chain-of-thought' },
  { id: 'format', label: 'Explicit format' }
];

parts.push(text(`Prompting barely changes outcomes for a reasoning model (GSM8K, n = ${n} per condition)`, 30, 32, { size: 15.5, weight: '700' }));
parts.push(text(`model ${experiment.model}, temperature 0, ${n * 3} generations`, 30, 50, { size: 11.5, color: MUTED }));

/* ------------------------------------------------------------------ (a) */
{
  const x0 = 30;
  const y0 = 78;
  const plotW = 360;
  const plotH = 200;
  const axisTop = y0 + 24;
  const rowGap = (plotH - 30) / CONDITIONS.length;
  const min = 0.9;
  const max = 1.0;
  const sx = (value) => x0 + 118 + ((value - min) / (max - min)) * (plotW - 118 - 44);

  parts.push(text('(a) Accuracy by condition', x0, y0 + 8, { size: 13, weight: '700' }));
  parts.push(text('95% Wilson interval', x0 + plotW, y0 + 8, { size: 10.5, anchor: 'end', color: MUTED }));

  for (let tick = 0; tick <= 5; tick += 1) {
    const value = min + (tick / 5) * (max - min);
    const x = sx(value);
    parts.push(`<path d="M ${x} ${axisTop - 8} L ${x} ${axisTop + plotH - 34}" stroke="${RULE}" stroke-width="1"/>`);
    parts.push(text(value.toFixed(2), x, axisTop + plotH - 34 + 16, { size: 10.5, anchor: 'middle', color: MUTED }));
  }

  CONDITIONS.forEach((condition, index) => {
    const rowY = axisTop + 16 + index * rowGap;
    const summary = experiment.summary[condition.id];
    const corrected = artifacts.correctedAccuracy[condition.id].numericCorrected;
    const correct = Math.round(summary.declaredAccuracy * n);
    const [low, high] = wilson(correct, n);

    parts.push(text(condition.label, x0 + 108, rowY + 4, { size: 12, anchor: 'end' }));

    // Interval whisker, then the dumbbell between exact-match and corrected.
    parts.push(`<path d="M ${sx(low)} ${rowY} L ${sx(high)} ${rowY}" stroke="${SERIES_A}" stroke-width="2" stroke-linecap="round" opacity="0.55"/>`);
    parts.push(`<path d="M ${sx(low)} ${rowY - 5} L ${sx(low)} ${rowY + 5}" stroke="${SERIES_A}" stroke-width="2" opacity="0.55"/>`);
    parts.push(`<path d="M ${sx(high)} ${rowY - 5} L ${sx(high)} ${rowY + 5}" stroke="${SERIES_A}" stroke-width="2" opacity="0.55"/>`);
    parts.push(`<path d="M ${sx(summary.declaredAccuracy)} ${rowY} L ${sx(corrected)} ${rowY}" stroke="${SERIES_B}" stroke-width="2"/>`);
    parts.push(`<circle cx="${sx(summary.declaredAccuracy)}" cy="${rowY}" r="5" fill="${SERIES_A}"/>`);
    parts.push(`<circle cx="${sx(corrected)}" cy="${rowY}" r="4.5" fill="#ffffff" stroke="${SERIES_B}" stroke-width="2"/>`);
    parts.push(text(summary.declaredAccuracy.toFixed(3), sx(high) + 8, rowY + 4, { size: 11, color: SERIES_A, weight: '700' }));
  });

  const legendY = axisTop + plotH - 34 + 40;
  parts.push(`<circle cx="${x0}" cy="${legendY - 4}" r="5" fill="${SERIES_A}"/>`);
  parts.push(text('exact match', x0 + 12, legendY, { size: 11, color: MUTED }));
  parts.push(`<circle cx="${x0 + 96}" cy="${legendY - 4}" r="4.5" fill="#ffffff" stroke="${SERIES_B}" stroke-width="2"/>`);
  parts.push(text('after numeric correction', x0 + 108, legendY, { size: 11, color: MUTED }));
  parts.push(text('Intervals overlap completely: no condition separates from another.', x0, legendY + 22, { size: 11.5, color: MUTED }));
}

/* ------------------------------------------------------------------ (b) */
/** A 2x2 contingency matrix. Cells are shaded by count so the shape reads first. */
function matrix({ x, y, w, h, title, subtitle, rowLabels, colLabels, cells, highlight, footnote }) {
  const out = [];
  const labelW = 96;
  const headerH = 24;
  const cellW = (w - labelW) / 2;
  const cellH = (h - headerH - 26) / 2;
  const maxValue = Math.max(...cells.flat().map((cell) => cell.value));

  out.push(text(title, x, y + 8, { size: 13, weight: '700' }));
  out.push(text(subtitle, x + w, y + 8, { size: 10.5, anchor: 'end', color: MUTED }));

  colLabels.forEach((label, index) => {
    out.push(text(label, x + labelW + cellW * index + cellW / 2, y + headerH + 14, { size: 11, anchor: 'middle', color: MUTED }));
  });
  rowLabels.forEach((label, index) => {
    out.push(text(label, x + labelW - 8, y + headerH + cellH * index + cellH / 2 + 4, { size: 11, anchor: 'end', color: MUTED }));
  });

  cells.forEach((row, rowIndex) => {
    row.forEach((cell, colIndex) => {
      const cx = x + labelW + cellW * colIndex;
      const cy = y + headerH + 22 + cellH * rowIndex;
      const intensity = maxValue ? cell.value / maxValue : 0;
      const isHighlight = highlight(rowIndex, colIndex);
      const fill = isHighlight ? `rgba(185,28,28,${0.10 + intensity * 0.35})` : `rgba(29,78,216,${0.06 + intensity * 0.32})`;
      out.push(`<rect x="${cx + 2}" y="${cy + 2}" width="${cellW - 4}" height="${cellH - 4}" rx="4" fill="${fill}"/>`);
      out.push(text(String(cell.value), cx + cellW / 2, cy + cellH / 2 + 2, { size: 16, anchor: 'middle', weight: '700', color: isHighlight ? WARN : SERIES_A }));
      out.push(text(cell.label, cx + cellW / 2, cy + cellH / 2 + 18, { size: 10, anchor: 'middle', color: MUTED }));
    });
  });

  String(footnote).split('\n').forEach((line, index) => {
    out.push(text(line, x, y + h + 2 + index * 15, { size: 11, color: MUTED }));
  });
  return out.join('\n');
}

{
  const paired = analysis.paired.direct_vs_cot;
  parts.push(matrix({
    x: 420, y: 78, w: 300, h: 200,
    title: '(b) Per-item outcome, Direct vs CoT',
    subtitle: `${n} items`,
    rowLabels: ['Direct correct', 'Direct wrong'],
    colLabels: ['CoT correct', 'CoT wrong'],
    cells: [
      [{ value: paired.both, label: 'both right' }, { value: paired.onlyA, label: 'only direct' }],
      [{ value: paired.onlyB, label: 'only CoT' }, { value: paired.neither, label: 'both wrong' }]
    ],
    highlight: (row, col) => (row === 1 && col === 0) || (row === 0 && col === 1),
    footnote: `Discordant on ${paired.discordant} of ${n} items; CoT net ${paired.onlyB - paired.onlyA}.`
  }));
}

/* ------------------------------------------------------------------ (c) */
{
  const r = analysis.reasoningVsAnswer;
  parts.push(matrix({
    x: 750, y: 78, w: 300, h: 200,
    title: '(c) Answer vs hidden reasoning',
    subtitle: 'all conditions',
    rowLabels: ['Answer right', 'Answer wrong'],
    colLabels: ['Reasoning right', 'Reasoning wrong'],
    cells: [
      [{ value: r.bothRight, label: 'both right' }, { value: r.ansOnly, label: 'answer only' }],
      [{ value: r.reaOnly, label: 'reasoning only' }, { value: r.bothWrong, label: 'both wrong' }]
    ],
    highlight: (row, col) => row === 0 && col === 1,
    footnote: `Answer right, reasoning wrong: ${r.ansOnly}.\nThe reverse: ${r.reaOnly}.`
  }));
}

parts.push(text(`Grading: exact match under-counts by ${(artifacts.correctedAccuracy.direct.delta * 100).toFixed(1)} points — ${artifacts.gradingArtifact.numericallyEqualButMarkedWrong} responses were numerically equal but textually different (12 vs 12.00), ${artifacts.gradingArtifact.parseFailures} failed to parse.`, 30, 356, { size: 12, color: MUTED }));
parts.push(text(`Item difficulty and the grading rule dominate; the prompt does not. ${analysis.difficulty.allThreeRight} of ${n} items were right in all three conditions and ${analysis.difficulty.allThreeWrong} in none.`, 30, 378, { size: 12.5, weight: '700', color: INK }));
parts.push(text('Data: GSM8K test split (Cobbe et al., 2021). aidoc/experiment-cot-gsm8k.json. Every number recomputed from the stored generations.', 30, 408, { size: 11, color: MUTED }));

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n<rect width="${W}" height="${H}" fill="#ffffff"/>\n${parts.join('\n')}\n</svg>\n`;

const outDir = OUT_DIR;
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
