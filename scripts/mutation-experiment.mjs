#!/usr/bin/env node
/**
 * Mutation-testing experiment on this repository's own test suite.
 *
 * Real faults in real source, judged by the real suite. No simulation: each
 * mutant is written into the working tree, the suite runs against it, and git
 * restores the file. A mutant the suite fails on is "killed"; one the suite
 * passes is "survived" — a fault the tests cannot see.
 *
 * Safety
 * ------
 * The tree must be clean before this starts, and every mutant is restored with
 * `git checkout -- <file>` in a finally block. The run aborts rather than
 * proceeding if the tree is dirty, and asserts it is clean again at the end.
 * Nothing is committed while it runs.
 *
 * Determinism
 * -----------
 * Candidate mutants are collected in a stable order and sampled with a seeded
 * hash, so the same corpus and the same seed give the same mutant set.
 *
 * Usage:
 *   node scripts/mutation-experiment.mjs [limit] [seed]
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = path.join(REPO_ROOT, 'apps', 'backend', 'src');
const OUT = path.join(REPO_ROOT, 'aidoc', 'mutation-experiment.json');
const LIMIT = Number(process.argv[2]) || 240;
const SEED = process.argv[3] || 'mutation-2026';

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => resolve({ code: -1, stdout, stderr: String(error.message) }));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function walk(dir, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** A stable hash so sampling is reproducible without carrying a PRNG. */
function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// Textual operators. Each maps a token to its negation; the mutant is the first
// occurrence of that token at the recorded offset.
const OPERATORS = [
  { id: 'eq-to-neq', find: '===', replace: '!==' },
  { id: 'neq-to-eq', find: '!==', replace: '===' },
  { id: 'and-to-or', find: '&&', replace: '||' },
  { id: 'lte-to-lt', find: '<=', replace: '<' },
  { id: 'gte-to-gt', find: '>=', replace: '>' }
];

// Only the tree that gets mutated has to be clean. An untracked harness script
// elsewhere is irrelevant, and requiring a pristine repo would block running this
// at all.
const guard = await run('git', ['status', '--porcelain', '--', 'apps/backend/src']);
if (guard.stdout.trim()) {
  console.error('refusing to start: apps/backend/src has uncommitted changes, so git could not restore a mutant');
  console.error(guard.stdout.trim().split('\n').slice(0, 10).join('\n'));
  process.exit(1);
}

// List test files explicitly: node --test does not expand a glob itself, and
// relying on the shell to do it would make the harness shell-dependent.
const TEST_FILES = (await fs.readdir(path.join(REPO_ROOT, 'apps', 'backend', 'test')))
  .filter((name) => name.endsWith('.test.js'))
  .map((name) => path.join('apps', 'backend', 'test', name));

const files = await walk(SRC_ROOT);
const candidates = [];
for (const file of files) {
  const source = await fs.readFile(file, 'utf8');
  const lines = source.split('\n');
  for (const operator of OPERATORS) {
    lines.forEach((line, index) => {
      if (line.includes(operator.find)) {
        candidates.push({
          file: path.relative(REPO_ROOT, file),
          line: index + 1,
          operator: operator.id,
          find: operator.find,
          replace: operator.replace
        });
      }
    });
  }
}

const sampled = candidates
  .map((candidate) => ({ candidate, key: hash(`${SEED}:${candidate.file}:${candidate.line}:${candidate.operator}`) }))
  .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  .slice(0, LIMIT)
  .map((entry) => entry.candidate);

console.log(`candidates: ${candidates.length}  sampled: ${sampled.length}  seed: ${SEED}`);
console.log('running the full backend suite per mutant (~2s each), git restores each file\n');

const results = [];
let index = 0;
for (const mutant of sampled) {
  index += 1;
  const absolute = path.join(REPO_ROOT, mutant.file);
  const original = await fs.readFile(absolute, 'utf8');
  const lines = original.split('\n');
  const target = lines[mutant.line - 1];
  if (!target || !target.includes(mutant.find)) {
    results.push({ ...mutant, outcome: 'invalid', detail: 'token moved' });
    continue;
  }
  lines[mutant.line - 1] = target.replace(mutant.find, mutant.replace);
  const mutated = lines.join('\n');

  let outcome = 'survived';
  let detail = '';
  try {
    await fs.writeFile(absolute, mutated, 'utf8');
    const test = await run('node', ['--test', ...TEST_FILES]);
    if (test.code !== 0) {
      outcome = 'killed';
      const failing = (test.stdout.match(/^✖ (.+?) \(/gm) || []).length;
      detail = `${failing} failing test(s)`;
    }
  } catch (error) {
    outcome = 'error';
    detail = String(error.message || error).slice(0, 120);
  } finally {
    // git is the source of truth for the original bytes.
    await run('git', ['checkout', '--', mutant.file]);
  }

  results.push({ ...mutant, outcome, detail });
  const mark = outcome === 'killed' ? '✗' : outcome === 'survived' ? '·' : '?';
  console.log(`  ${mark} ${String(index).padStart(3)}/${sampled.length}  ${mutant.operator.padEnd(11)} ${mutant.file.replace('apps/backend/src/', '')}:${mutant.line}`);
}

const killed = results.filter((row) => row.outcome === 'killed').length;
const survived = results.filter((row) => row.outcome === 'survived').length;
const invalid = results.filter((row) => row.outcome !== 'killed' && row.outcome !== 'survived').length;
const score = killed + survived ? killed / (killed + survived) : 0;

const byModule = {};
for (const row of results) {
  const module = row.file.replace('apps/backend/src/services/', '').split('/')[0] || row.file.replace('apps/backend/src/', '');
  const bucket = byModule[module] || { killed: 0, survived: 0 };
  if (row.outcome === 'killed') bucket.killed += 1;
  else if (row.outcome === 'survived') bucket.survived += 1;
  byModule[module] = bucket;
}

const byOperator = {};
for (const row of results) {
  const bucket = byOperator[row.operator] || { killed: 0, survived: 0 };
  if (row.outcome === 'killed') bucket.killed += 1;
  else if (row.outcome === 'survived') bucket.survived += 1;
  byOperator[row.operator] = bucket;
}

await fs.writeFile(OUT, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  seed: SEED,
  candidates: candidates.length,
  sampled: sampled.length,
  killed,
  survived,
  invalid,
  mutationScore: Number(score.toFixed(4)),
  byModule,
  byOperator,
  results
}, null, 2)}\n`, 'utf8');

console.log(`\n=== mutation testing ===`);
console.log(`mutants: ${sampled.length}   killed: ${killed}   survived: ${survived}   invalid: ${invalid}`);
console.log(`mutation score: ${(score * 100).toFixed(1)}%`);
console.log('\nweakest modules (>=3 mutants, lowest score):');
for (const [module, bucket] of Object.entries(byModule)
  .filter(([, b]) => b.killed + b.survived >= 3)
  .sort((a, b) => (a[1].killed / (a[1].killed + a[1].survived)) - (b[1].killed / (b[1].killed + b[1].survived)))
  .slice(0, 8)) {
  const total = bucket.killed + bucket.survived;
  console.log(`  ${(bucket.killed / total * 100).toFixed(0).padStart(3)}%  ${module.padEnd(28)} ${bucket.killed}/${total}`);
}
console.log(`\nraw: ${path.relative(REPO_ROOT, OUT)}`);

const after = await run('git', ['status', '--porcelain', '--', 'apps/backend/src']);
console.log(`\ntree clean after run: ${after.stdout.trim() ? 'NO — inspect immediately' : 'yes'}`);
