#!/usr/bin/env node
/**
 * Results figure for the self-consistency ablation.
 *
 * The experiment separates two mechanisms that a single accuracy number
 * conflates: sampling more solutions, and aggregating them by majority vote.
 * The figure has to show both, plus why voting helps or fails:
 *
 *   (a) accuracy for one sample, for the majority vote, and for the oracle that
 *       any sample would have reached, with Wilson intervals
 *   (b) how the k votes split, which is the mechanism behind the vote
 *   (c) what voting did to the items a single sample got wrong
 *
 * Usage: node scripts/build-selfconsistency-figure.mjs
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertExperimentArtifact } from './lib/experiment-artifacts.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.SCIENCEPRISM_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DATA_DIR = process.env.SCIENCEPRISM_FIGURE_DATA || path.join(REPO_ROOT, 'aidoc');
const OUT_DIR = process.env.SCIENCEPRISM_FIGURE_OUT || DATA_DIR;

const experiment = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'experiment-self-consistency.json'), 'utf8'));

// Refuse to draw a figure from a run that lost draws to the transport: the
// percentages would look fine and be wrong.
assertExperimentArtifact(experiment, 'experiment-self-consistency.json');

const FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif';
const INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#d1d5db';
const SERIES = '#1d4ed8';
const ACCENT = '#b45309';
const DEFICIT = '#b91c1c';

const W = 1080;
const H = 440;
const parts = [];

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (v, x, y, { size = 12.5, anchor = 'start', color = INK, weight = '500' } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${color}">${esc(v)}</text>`;

/** Wilson score interval for a proportion. */
function wilson(k, n, z = 1.96) {
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const n = experiment.n;
const k = experiment.k;
const records = experiment.records;

/** How the k draws for one item split: the largest share of identical answers. */
function agreement(record) {
  const counts = new Map();
  for (const answer of record.answers) {
    if (answer === null || answer === undefined) continue;
    counts.set(answer, (counts.get(answer) || 0) + 1);
  }
  if (!counts.size) return 0;
  return Math.max(...counts.values());
}

const correct = (key) => records.filter((record) => record[key]).length;

parts.push(text(`Self-consistency ablation on GSM8K (n = ${n}, k = ${k}, temperature ${experiment.temperature})`, 30, 32, { size: 15.5, weight: '700' }));
parts.push(text(`model ${experiment.model}, ${n * k} generations`, 30, 50, { size: 11.5, color: MUTED }));

/* ------------------------------------------------------------------ (a) */
{
  const x = 30;
  const y = 78;
  const plotW = 330;
  const plotH = 200;
  const points = [
    { label: 'One sample', value: experiment.singleAccuracy, count: correct('singleCorrect'), color: SERIES },
    { label: 'Majority vote', value: experiment.selfconsAccuracy, count: correct('selfconsCorrect'), color: ACCENT },
    { label: 'Any sample right', value: experiment.oracleAccuracy, count: correct('oracleCorrect'), color: MUTED }
  ];
  const min = Math.max(0, Math.min(...points.map((point) => wilson(point.count, n)[0])) - 0.05);
  const max = 1;
  const sx = (value) => x + 128 + ((value - min) / (max - min)) * (plotW - 128 - 52);

  parts.push(text('(a) Accuracy', x, y + 8, { size: 13, weight: '700' }));
  parts.push(text('95% Wilson interval', x + plotW, y + 8, { size: 10.5, anchor: 'end', color: MUTED }));

  for (let tick = 0; tick <= 4; tick += 1) {
    const value = min + (tick / 4) * (max - min);
    const px = sx(value);
    parts.push(`<path d="M ${px} ${y + 22} L ${px} ${y + plotH - 26}" stroke="${RULE}"/>`);
    parts.push(text(value.toFixed(2), px, y + plotH - 10, { size: 10.5, anchor: 'middle', color: MUTED }));
  }

  points.forEach((point, index) => {
    const rowY = y + 44 + index * 44;
    const [low, high] = wilson(point.count, n);
    parts.push(text(point.label, x + 118, rowY + 4, { size: 12, anchor: 'end' }));
    parts.push(`<path d="M ${sx(low)} ${rowY} L ${sx(high)} ${rowY}" stroke="${point.color}" stroke-width="2" opacity="0.5"/>`);
    parts.push(`<path d="M ${sx(low)} ${rowY - 5} L ${sx(low)} ${rowY + 5}" stroke="${point.color}" stroke-width="2" opacity="0.5"/>`);
    parts.push(`<path d="M ${sx(high)} ${rowY - 5} L ${sx(high)} ${rowY + 5}" stroke="${point.color}" stroke-width="2" opacity="0.5"/>`);
    parts.push(`<circle cx="${sx(point.value)}" cy="${rowY}" r="5.5" fill="${point.color}"/>`);
    parts.push(text(point.value.toFixed(3), sx(high) + 8, rowY + 4, { size: 11.5, color: point.color, weight: '700' }));
  });

  const gain = experiment.voteGain;
  const headroom = experiment.searchHeadroom;
  parts.push(text(`Vote gain ${gain >= 0 ? '+' : ''}${gain.toFixed(3)}; headroom left ${headroom.toFixed(3)}.`, x, y + plotH + 14, { size: 11.5, color: MUTED }));
  parts.push(text(`Mean accuracy of a single draw: ${experiment.meanSampleAccuracy}.`, x, y + plotH + 32, { size: 11.5, color: MUTED }));
}

/* ------------------------------------------------------------------ (b) */
{
  const x = 400;
  const y = 78;
  const w = 300;
  const h = 200;
  const plotBottom = y + h - 30;
  const plotTop = y + 40;

  const buckets = [
    { label: `${k} of ${k} agree`, color: SERIES, count: records.filter((record) => agreement(record) === k).length },
    { label: `${k - 1} of ${k} agree`, color: '#60a5fa', count: records.filter((record) => agreement(record) === k - 1).length },
    { label: `≤${k - 2} of ${k} agree`, color: ACCENT, count: records.filter((record) => agreement(record) < k - 1 && agreement(record) > 0).length },
    { label: 'no answer', color: DEFICIT, count: records.filter((record) => agreement(record) === 0).length }
  ];
  const max = Math.max(...buckets.map((bucket) => bucket.count), 1);

  parts.push(text('(b) How the draws split', x, y + 8, { size: 13, weight: '700' }));
  parts.push(text(`${n} items`, x + w, y + 8, { size: 10.5, anchor: 'end', color: MUTED }));
  parts.push(`<path d="M ${x} ${plotBottom} L ${x + w} ${plotBottom}" stroke="${RULE}"/>`);

  const slot = w / buckets.length;
  buckets.forEach((bucket, index) => {
    const cx = x + slot * index + slot / 2;
    const height = (bucket.count / max) * (plotBottom - plotTop);
    if (height > 0) {
      parts.push(`<rect x="${cx - 26}" y="${plotBottom - height}" width="52" height="${height}" rx="3" fill="${bucket.color}"/>`);
    }
    parts.push(text(String(bucket.count), cx, plotBottom - height - 6, { size: 12, anchor: 'middle', weight: '700', color: bucket.color }));
    bucket.label.split(' ').slice(0, 3).forEach((line, lineIndex) => {
      parts.push(text(line, cx, plotBottom + 15 + lineIndex * 12, { size: 10.5, anchor: 'middle', color: MUTED }));
    });
  });
  parts.push(text('Voting only helps where the draws disagree.', x, y + h + 14, { size: 11.5, color: MUTED }));
}

/* ------------------------------------------------------------------ (c) */
{
  const x = 750;
  const y = 78;
  const w = 300;
  const h = 200;
  const plotBottom = y + h - 30;
  const plotTop = y + 40;

  const singleWrong = records.filter((record) => !record.singleCorrect);
  const fixed = singleWrong.filter((record) => record.selfconsCorrect).length;
  const stillWrong = singleWrong.filter((record) => !record.selfconsCorrect).length;
  const broken = records.filter((record) => record.singleCorrect && !record.selfconsCorrect).length;

  const buckets = [
    { label: 'voting fixed', value: fixed, color: SERIES },
    { label: 'voting broke', value: broken, color: DEFICIT },
    { label: 'still wrong', value: stillWrong, color: MUTED }
  ];
  const max = Math.max(...buckets.map((bucket) => bucket.value), 1);

  parts.push(text('(c) What voting did', x, y + 8, { size: 13, weight: '700' }));
  parts.push(text(`${singleWrong.length} single-sample errors`, x + w, y + 8, { size: 10.5, anchor: 'end', color: MUTED }));
  parts.push(`<path d="M ${x} ${plotBottom} L ${x + w} ${plotBottom}" stroke="${RULE}"/>`);

  const slot = w / buckets.length;
  buckets.forEach((bucket, index) => {
    const cx = x + slot * index + slot / 2;
    const height = (bucket.value / max) * (plotBottom - plotTop);
    if (height > 0) {
      parts.push(`<rect x="${cx - 30}" y="${plotBottom - height}" width="60" height="${height}" rx="3" fill="${bucket.color}"/>`);
    }
    parts.push(text(String(bucket.value), cx, plotBottom - height - 6, { size: 12, anchor: 'middle', weight: '700', color: bucket.color }));
    bucket.label.split(' ').forEach((line, lineIndex) => {
      parts.push(text(line, cx, plotBottom + 15 + lineIndex * 12, { size: 10.5, anchor: 'middle', color: MUTED }));
    });
  });
  parts.push(text('A vote can also overrule a correct single draw.', x, y + h + 14, { size: 11.5, color: MUTED }));
}

parts.push(text(`Grading: the last number in the reply. Data: GSM8K test split (Cobbe et al., 2021), aidoc/experiment-self-consistency.json.`, 30, 366, { size: 12, color: MUTED }));
parts.push(text('The gap between any correct sample and a correct vote shows what aggregation missed.', 30, 390, { size: 12.5, weight: '700', color: INK }));
parts.push(text('Every number recomputed from the stored draws.', 30, 418, { size: 11, color: MUTED }));

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n<rect width="${W}" height="${H}" fill="#ffffff"/>\n${parts.join('\n')}\n</svg>\n`;

await fs.mkdir(OUT_DIR, { recursive: true });
const svgPath = path.join(OUT_DIR, 'selfconsistency-results.svg');
await fs.writeFile(svgPath, svg, 'utf8');

const scratch = path.join(REPO_ROOT, '.cache', 'selfcons-figure');
await fs.mkdir(scratch, { recursive: true });
const htmlPath = path.join(scratch, 'figure.html');
await fs.writeFile(htmlPath, `<!doctype html><meta charset="utf-8"><style>@page{size:${W}px ${H}px;margin:0}html,body{margin:0;padding:0}svg{display:block}</style><body>${svg}</body>`, 'utf8');

const pdfPath = path.join(OUT_DIR, 'selfconsistency-results.pdf');
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
await fs.copyFile(pngPath, path.join(OUT_DIR, 'selfconsistency-results.png'));
await fs.rm(scratch, { recursive: true, force: true });

console.log(`  selfconsistency-results.svg  ${(await fs.stat(svgPath)).size} B`);
console.log(`  selfconsistency-results.pdf  ${(await fs.stat(pdfPath)).size} B`);
console.log(`  selfconsistency-results.png  ${(await fs.stat(path.join(OUT_DIR, 'selfconsistency-results.png'))).size} B`);
