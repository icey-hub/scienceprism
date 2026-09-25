#!/usr/bin/env node
/**
 * Turns the research tool's writing brief into a LaTeX manuscript and compiles a
 * real PDF, using the project's own services.
 *
 * The manuscript is written by the product's LLM service (llmService.js) and the
 * PDF by the product's compile service (compileService.js) — this script is only
 * the driver, the same role scripts/produce-research-document.mjs plays. Nothing
 * here authors content by hand (U-21).
 *
 * The compile service returns the PDF as base64 and deletes its build directory,
 * so nothing would persist; this script writes the result under the document
 * landing directory instead (R-15).
 *
 * Usage:
 *   node scripts/render-brief-pdf.mjs [projectId]
 *
 * Makes exactly one model call and runs it serially: the gateway is shared with
 * the DSH session (U-20).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadDotEnv() {
  let text = '';
  try {
    text = await fs.readFile(path.join(REPO_ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, '');
  }
}
await loadDotEnv();

// R-15: the same landing policy the research driver uses.
const { assertDocumentLandingPath, resolveDocumentLandingDir } = await import('../apps/backend/src/services/researchWorkflow/documentLanding.js');
const LANDING_DIR = resolveDocumentLandingDir(REPO_ROOT, { override: process.env.SCIENCEPRISM_AIDOC_DIR });
process.env.SCIENCEPRISM_DATA_DIR = LANDING_DIR;

const projectId = process.argv[2] || 'aidoc-research-document';
const projectRoot = path.join(LANDING_DIR, projectId);
const briefPath = path.join(projectRoot, 'research', 'writing-brief.md');
const mainFile = 'manuscript/main.tex';
const absoluteTex = path.join(projectRoot, mainFile);

const { callOpenAICompatible } = await import('../apps/backend/src/services/llmService.js');
const { runCompile } = await import('../apps/backend/src/services/compileService.js');

function log(step, detail) {
  console.log(`[${new Date().toISOString()}] ${step}${detail ? ` — ${detail}` : ''}`);
}

const SYSTEM = [
  'You convert a research writing brief into a compilable LaTeX article.',
  'Return ONLY the LaTeX source. No Markdown fences, no commentary before or after.',
  'Preserve the brief exactly: every claim, every Evidence id, every limitation, and every unverified claim must appear.',
  'Do not add results, numbers, citations, or findings that are not in the brief. This is a proposal, not a completed study.',
  'Keep the "Unverified Claims" content visible as an explicit section; never present an unverified claim as established.',
  'Use only these packages, which the local tectonic bundle provides: geometry, amsmath, booktabs, hyperref, enumitem, graphicx, microtype.',
  'Place experiment-results in the Results section as the figure of the results, with a caption that states what the four arms are and what the bars show.',
  'Place sequence-flow and module-graph in the Method section as figures of the pipeline under study.',
  'Include each figure listed below exactly once, inside a figure environment, using the exact \\includegraphics option given for it.',
  'Do not add an appendix of unrelated figures.',
  'Escape LaTeX special characters in prose. Do not use \\citep or a bibliography.',
  'Wrap every long identifier — Evidence ids, claim ids, file paths — in \\path{...} so it can break across lines. A \\texttt{...} box cannot break, and a 26-character id overflows the margin.',
  'The document must compile with no Overfull or Underfull box warnings.'
].join('\n');

// Copy the generated figures next to the manuscript so the document is
// self-contained and \includegraphics resolves during compilation.
// Width per figure, chosen by content density rather than a uniform
// \linewidth: a sparse boxes-and-arrows diagram stretched to the full text
// width leaves most of the frame empty, which is what made the figures look
// the wrong size. The dense illustration earns the full width.
// Only the figures this paper is about. The set used to include a cell
// illustration and a self-assessment chart, which had nothing to do with an
// evidence-gate experiment, while the paper carried no figure of its own results.
const FIGURE_WIDTHS = {
  'experiment-results': '0.98\\linewidth',
  'sequence-flow': '0.86\\linewidth',
  'module-graph': '0.80\\linewidth'
};
const FIGURE_SOURCES = Object.keys(FIGURE_WIDTHS);
const figuresDir = path.join(projectRoot, 'manuscript', 'figures');
await fs.rm(figuresDir, { recursive: true, force: true });
await fs.mkdir(figuresDir, { recursive: true });
const availableFigures = [];
for (const name of FIGURE_SOURCES) {
  const from = name === 'experiment-results'
      ? path.join(REPO_ROOT, 'aidoc', 'experiment-results.pdf')
      : path.join(REPO_ROOT, 'docs', 'agent-governance', 'assets', 'diagrams', `${name}.pdf`);
  try {
    await fs.copyFile(from, path.join(figuresDir, `${name}.pdf`));
    availableFigures.push(name);
  } catch {
    console.warn(`figure not found, skipping: ${name}`);
  }
}
log('figures', `${availableFigures.length} figure(s) copied to manuscript/figures: ${availableFigures.join(', ')}`);

const brief = await fs.readFile(briefPath, 'utf8');
log('brief', `${brief.length} chars from ${path.relative(REPO_ROOT, briefPath)}`);

log('model', 'asking the product LLM service to write the manuscript (1 call, serial)');
const completion = await callOpenAICompatible({
  messages: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Writing brief:\n\n${brief}\n\nFigures available under figures/ (use these exact filenames and widths):\n${availableFigures.map((n) => `- figures/${n}.pdf at width=${FIGURE_WIDTHS[n]}`).join('\n')}` }
  ]
});
if (!completion?.ok) {
  console.error('model call failed:', completion?.error || 'unknown error');
  process.exit(1);
}

let latex = String(completion.content || '').trim();
latex = latex.replace(/^\uFEFF/, '');

// Guarantee the preamble can break long identifiers.
//
// Asking the model to do this in prose was not enough: a run of consecutive
// \path{} identifiers has nowhere to break, and one manuscript came back with 24
// Overfull boxes up to 70pt. Injecting it is deterministic, and [hyphens]{url} is
// what lets \path{} break at the hyphens inside an evidence id.
const REQUIRED_PREAMBLE = [
  '\\usepackage[hyphens]{url}',
  '\\usepackage{microtype}',
  '\\setlength{\\emergencystretch}{3em}'
].join('\n');
if (!/\\setlength\{\\emergencystretch\}/.test(latex)) {
  latex = latex.replace(/(\\documentclass(?:\[[^\]]*\])?\{[^}]+\})/, `$1\n${REQUIRED_PREAMBLE}`);
}
latex = latex.replace(/^```(?:latex|tex)?\s*/i, '').replace(/```\s*$/, '').trim();
if (!latex.startsWith('\\documentclass')) {
  console.error('model did not return a LaTeX document; first 200 chars:', latex.slice(0, 200));
  process.exit(1);
}

await fs.mkdir(path.dirname(absoluteTex), { recursive: true });
await fs.writeFile(absoluteTex, `${latex}\n`, 'utf8');
log('tex', `wrote ${latex.length} chars to ${path.relative(REPO_ROOT, absoluteTex)}`);

log('compile', 'running the product compile service with tectonic');
const compiled = await runCompile({ projectId, mainFile, engine: 'tectonic' });
if (!compiled?.ok) {
  console.error('compile failed:', compiled?.error || 'unknown error');
  console.error((compiled?.log || '').slice(-2000));
  process.exit(1);
}

const absolutePdf = path.join(projectRoot, 'manuscript', 'main.pdf');
const buffer = Buffer.from(compiled.pdf, 'base64');
await fs.writeFile(absolutePdf, buffer);
const relative = assertDocumentLandingPath(absolutePdf, LANDING_DIR);
log('done', `pdf written: ${relative} (${buffer.length} bytes)`);

// The PDF's own visual check. LaTeX already measures every box and reports what
// does not fit, so these warnings are the machine-readable version of "this
// looks wrong".
//
// Calibrated deliberately: an Overfull box means content runs past the margin,
// which is a real defect and fails. An Underfull box means a line is loosely
// stretched — cosmetic, and the expected cost of letting long identifiers break
// with \path — so it is reported but does not fail. Treating both alike would
// make the gate noisy enough to be switched off.
//
// tectonic prefixes these with "warning: file:line:", so matching a line that
// merely starts with "Overfull" silently finds nothing. That mistake is why the
// matched lines are printed rather than only a count.
const layoutLines = (compiled.log || '')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => /\b(Overfull|Underfull)\b/.test(line));

// A sub-point Overfull is a typesetting rounding artifact, not something a
// reader can see: 1pt is about 0.35mm. The defect this check was written for was
// 111.9pt — roughly 3.9cm of text past the margin. The tolerance is stated
// explicitly so nobody has to guess why a 0.55pt warning did not fail the run.
const OVERFULL_TOLERANCE_PT = 1;
const overfullPt = (line) => {
  const match = line.match(/Overfull \\[hv]box \(([\d.]+)pt too wide\)/);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
};

const overfullAll = layoutLines.filter((line) => /\bOverfull\b/.test(line));
const overfullDefects = overfullAll.filter((line) => overfullPt(line) > OVERFULL_TOLERANCE_PT);
const overfullMinor = overfullAll.filter((line) => overfullPt(line) <= OVERFULL_TOLERANCE_PT);
const underfull = layoutLines.filter((line) => /\bUnderfull\b/.test(line));

if (layoutLines.length) {
  console.log('\n=== layout warnings from the compiler ===');
  console.log(`  Overfull beyond the ${OVERFULL_TOLERANCE_PT}pt tolerance (visible): ${overfullDefects.length}`);
  for (const warning of overfullDefects) console.log(`    ${warning}`);
  console.log(`  Overfull within tolerance (invisible): ${overfullMinor.length}`);
  for (const warning of overfullMinor) console.log(`    ${warning}`);
  console.log(`  Underfull (loose lines, cosmetic): ${underfull.length}`);
  for (const warning of underfull.slice(0, 4)) console.log(`    ${warning}`);
}

if (overfullDefects.length) {
  console.log(`  Overfull beyond ${OVERFULL_TOLERANCE_PT}pt is a visible layout defect; fix the manuscript before treating this PDF as final.`);
  process.exitCode = 1;
} else {
  log('layout', `no visible Overfull boxes${underfull.length ? ` (${underfull.length} cosmetic Underfull warning(s))` : ''}`);
}

console.log('\n=== produced by the tool ===');
console.log(`landing dir : ${LANDING_DIR}`);
console.log(`manuscript  : ${mainFile}`);
console.log(`pdf         : ${relative}`);
console.log(`pdf bytes   : ${buffer.length}`);
console.log(`layout      : ${overfullDefects.length ? `${overfullDefects.length} visible Overfull defect(s)` : 'no visible overflow'}`);
