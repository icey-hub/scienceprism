#!/usr/bin/env node
/**
 * Checks the generated diagrams for layout defects, using real text metrics.
 *
 * Iteration 021 fixed an overlapping label by looking at the rendered PNG, which
 * means the check depended on a person remembering to look. This makes it
 * automatic: the SVGs are loaded in headless Chrome and every label's actual
 * bounding box is measured with getBBox(), so overlaps are found from the font's
 * real metrics rather than an estimate of character widths.
 *
 * Detects:
 *   - two labels whose boxes intersect (always a defect)
 *   - a label that falls outside the canvas (clipped)
 *   - a leader line crossing a label (the label becomes unreadable)
 *
 * Exit code is non-zero when any figure has a defect, so it can gate a build.
 * If Chrome is not installed the check reports that it was skipped rather than
 * pretending to pass.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.SCIENCEPRISM_CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const { FIGURES, OUTPUT_DIR, buildSvg } = await import(path.join(REPO_ROOT, 'scripts', 'build-diagrams.mjs'));

const WORK_DIR = path.join(REPO_ROOT, '.cache', 'diagram-layout');

/**
 * Runs inside the page. Measures every text node and leader path, then writes
 * the findings as JSON into #layout-report so --dump-dom can carry them out.
 */
const PAGE_SCRIPT = `
(() => {
  const svg = document.querySelector('svg');
  const canvas = { width: svg.viewBox.baseVal.width, height: svg.viewBox.baseVal.height };
  const boxes = [...svg.querySelectorAll('text')].map((node) => {
    const b = node.getBBox();
    return { text: (node.textContent || '').slice(0, 40), x1: b.x, y1: b.y, x2: b.x + b.width, y2: b.y + b.height };
  });
  // Both callout leaders and ordinary arrows: an arrow that runs through its own
  // label is just as unreadable, and checking only data-leader paths missed it.
  const leaders = [...svg.querySelectorAll('path[marker-end], path[data-leader]')].map((node) => {
    const d = node.getAttribute('d') || '';
    const m = d.match(/M\\s*([-\\d.]+)[ ,]+([-\\d.]+)\\s*L\\s*([-\\d.]+)[ ,]+([-\\d.]+)/);
    return m ? { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] } : null;
  }).filter(Boolean);

  const overlapArea = (a, b) =>
    Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) *
    Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));

  // Segment vs axis-aligned box, via the Liang-Barsky clip.
  const crossesBox = (s, box) => {
    const pad = 1;
    const x1 = box.x1 + pad, y1 = box.y1 + pad, x2 = box.x2 - pad, y2 = box.y2 - pad;
    if (x2 <= x1 || y2 <= y1) return false;
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    let t0 = 0, t1 = 1;
    const clip = (p, q) => {
      if (p === 0) return q >= 0;
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
      return true;
    };
    return clip(-dx, s.x1 - x1) && clip(dx, x2 - s.x1) && clip(-dy, s.y1 - y1) && clip(dy, y2 - s.y1);
  };

  const textOverlaps = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const area = overlapArea(boxes[i], boxes[j]);
      if (area > 2) textOverlaps.push({ a: boxes[i].text, b: boxes[j].text, area: Math.round(area) });
    }
  }

  const outside = boxes
    .filter((b) => b.x1 < 0 || b.y1 < 0 || b.x2 > canvas.width || b.y2 > canvas.height)
    .map((b) => b.text);

  const leaderCrossings = [];
  for (const s of leaders) {
    for (const b of boxes) {
      if (crossesBox(s, b)) leaderCrossings.push({ text: b.text, from: [Math.round(s.x1), Math.round(s.y1)], to: [Math.round(s.x2), Math.round(s.y2)] });
    }
  }

  // Two leader lines crossing each other is the other defect a person spots
  // instantly and a per-label check cannot see.
  const cross = (a, b) => {
    const d = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const d1 = d(b, a, { x: a.x2, y: a.y2 }), d2 = d(b, { x: b.x2, y: b.y2 }, a);
    const d3 = d(a, b, { x: b.x2, y: b.y2 }), d4 = d(a, { x: a.x2, y: a.y2 }, b);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  const leaderCrossingsEachOther = [];
  for (let i = 0; i < leaders.length; i += 1) {
    for (let j = i + 1; j < leaders.length; j += 1) {
      if (cross(leaders[i], leaders[j])) leaderCrossingsEachOther.push({ a: [Math.round(leaders[i].x1), Math.round(leaders[i].y1), Math.round(leaders[i].x2), Math.round(leaders[i].y2)], b: [Math.round(leaders[j].x1), Math.round(leaders[j].y1), Math.round(leaders[j].x2), Math.round(leaders[j].y2)] });
    }
  }

  const report = { canvas, labelCount: boxes.length, leaderCount: leaders.length, textOverlaps, outside, leaderCrossings, leaderCrossingsEachOther };
  const pre = document.createElement('pre');
  pre.id = 'layout-report';
  pre.textContent = JSON.stringify(report);
  document.body.appendChild(pre);
})();
`;

function runChrome(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', '--dump-dom', url], {
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.once('error', reject);
    child.once('close', () => resolve(out));
  });
}

async function chromeAvailable() {
  try {
    await fs.access(CHROME);
    return true;
  } catch {
    return false;
  }
}

if (!(await chromeAvailable())) {
  console.log(`diagram layout check skipped: Chrome not found at ${CHROME}`);
  process.exit(0);
}

await fs.mkdir(WORK_DIR, { recursive: true });
let defects = 0;
let checked = 0;

for (const name of Object.keys(FIGURES)) {
  const markup = buildSvg(name);
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0">${markup}<script>${PAGE_SCRIPT}</script></body>`;
  const htmlPath = path.join(WORK_DIR, `${name}.html`);
  await fs.writeFile(htmlPath, html, 'utf8');

  const dom = await runChrome(`file://${htmlPath}`);
  const match = dom.match(/<pre id="layout-report">([\s\S]*?)<\/pre>/);
  if (!match) {
    console.log(`  ${name.padEnd(18)} COULD NOT MEASURE`);
    defects += 1;
    continue;
  }
  const report = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  checked += 1;

  const problems = [];
  for (const overlap of report.textOverlaps) problems.push(`labels overlap (${overlap.area}px²): "${overlap.a}" × "${overlap.b}"`);
  for (const text of report.outside) problems.push(`label outside the canvas: "${text}"`);
  for (const crossing of report.leaderCrossings) problems.push(`connector crosses label "${crossing.text}" (${crossing.from} → ${crossing.to})`);
  for (const pair of report.leaderCrossingsEachOther) problems.push(`connectors cross each other: ${pair.a} × ${pair.b}`);

  if (problems.length) {
    defects += problems.length;
    console.log(`  ${name.padEnd(18)} ${report.labelCount} labels, ${report.leaderCount} leaders — ${problems.length} defect(s)`);
    for (const problem of problems) console.log(`      ${problem}`);
  } else {
    console.log(`  ${name.padEnd(18)} ${report.labelCount} labels, ${report.leaderCount} leaders — clean`);
  }
}

await fs.rm(WORK_DIR, { recursive: true, force: true });

console.log(`\nchecked ${checked} figure(s), ${defects} layout defect(s)`);
process.exit(defects ? 1 : 0);
