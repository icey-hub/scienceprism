#!/usr/bin/env node
/**
 * Structure check for a produced paper.
 *
 * Written after a paper went out with an appendix of diagrams that had nothing
 * to do with the study, while carrying no figure of its own results. Every rule
 * here corresponds to something that actually went wrong, rather than to a
 * generic idea of what a paper should look like.
 *
 * Rules:
 *   1. an empirical paper has a Results section
 *   2. the Results section contains at least one figure reference
 *   3. at least one figure is derived from experiment data (not a hand-authored
 *      diagram of the tooling)
 *   4. no appendix of illustrative figures that the paper admits are unrelated
 *   5. every figure has a caption
 *
 * Exits non-zero and prints what is missing, so it can gate a build.
 *
 * Usage: node scripts/check-paper-structure.mjs [manuscript.tex]
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { isDataDerivedFigure, isKnownFigure } = await import('./figure-inventory.mjs');

const target = process.argv[2] || path.join(REPO_ROOT, 'aidoc', 'aidoc-research-document', 'manuscript', 'main.tex');

let source = '';
try {
  source = await fs.readFile(target, 'utf8');
} catch (error) {
  console.error(`cannot read manuscript: ${target}`);
  process.exit(1);
}

/** Sections with the text between each heading and the next. */
function sectionsOf(tex) {
  const lines = tex.split('\n');
  const headings = [];
  lines.forEach((line, index) => {
    const match = line.match(/^\\section\*?\{([^}]*)\}/);
    if (match) headings.push({ title: match[1], line: index });
  });
  return headings.map((heading, index) => ({
    title: heading.title,
    line: heading.line + 1,
    body: lines.slice(heading.line + 1, index + 1 < headings.length ? headings[index + 1].line : lines.length).join('\n')
  }));
}

const sections = sectionsOf(source);
const figures = [...source.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)].map((match) => match[1]);
const figureIds = figures.map((file) => path.basename(file).replace(/\.(pdf|png|svg)$/, ''));
const captions = [...source.matchAll(/\\caption\{/g)].length;

const problems = [];

// Rule 1: a results section.
const results = sections.find((section) => /^Results\b/i.test(section.title));
if (!results) {
  problems.push('no Results section: an empirical paper must report its results');
}

// Rule 2: results carries at least one figure.
if (results && !/\\includegraphics/.test(results.body)) {
  problems.push(`Results section is present but contains no figure reference (line ${results.line})`);
}

// Rule 3: at least one figure comes from experiment data.
const dataDerived = figureIds.filter((id) => isDataDerivedFigure(id));
if (!dataDerived.length) {
  problems.push(
    `no figure derived from experiment data (found: ${figureIds.join(', ') || 'none'}). A results paper needs a figure of its own results, not only diagrams of the tooling.`
  );
}

// Rule 4: no appendix admitting the figures are unrelated.
const unrelatedAppendix = sections.find((section) =>
  /Illustrative Figures/i.test(section.title) || /illustrate the tooling/i.test(section.body)
);
if (unrelatedAppendix) {
  problems.push(
    `section "${unrelatedAppendix.title}" (line ${unrelatedAppendix.line}) is an appendix of figures the paper itself calls unrelated`
  );
}

// Rule 5: captions exist for the figures.
if (figures.length && captions < figures.length) {
  problems.push(`${figures.length} figure(s) but only ${captions} caption(s): every figure needs one`);
}

// Informational: figures the inventory does not know about.
const unknown = figureIds.filter((id) => !isKnownFigure(id));
if (unknown.length) {
  problems.push(`figure(s) not in the inventory, so their provenance is unknown: ${unknown.join(', ')}`);
}

console.log(`manuscript : ${path.relative(REPO_ROOT, target)}`);
console.log(`sections   : ${sections.map((section) => section.title).join(' | ')}`);
console.log(`figures    : ${figureIds.join(', ') || '(none)'}  (${captions} caption(s))`);
console.log(`data-derived: ${dataDerived.join(', ') || '(none)'}`);

if (problems.length) {
  console.log(`\n=== ${problems.length} structure problem(s) ===`);
  for (const problem of problems) console.log(`  ✗ ${problem}`);
  process.exit(1);
}

console.log('\nstructure ok');
