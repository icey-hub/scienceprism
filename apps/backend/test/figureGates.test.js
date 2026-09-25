import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.join(here, '..', '..', '..');
const AIDOC = path.join(repoRoot, 'aidoc');
const WORK = path.join(repoRoot, '.cache', 'figure-gates');

/**
 * The figures in this repository are experiment output, so two properties
 * matter and both are checkable:
 *
 *   - reproducibility: regenerating from the recorded data reproduces the
 *     committed figure, so the figure cannot be quietly hand-edited
 *   - data-derived: perturbing the data changes the figure, so the numbers on it
 *     are actually read from the data rather than typed in
 *
 * The second is the one that is easy to skip. A figure whose accuracy labels
 * were hardcoded still passes a byte-comparison against a regeneration from the
 * data that happens to agree with them, so comparing against the real data alone
 * proves nothing about where the numbers came from.
 */
const EXPERIMENT_FIGURES = [
  { id: 'cot-results', script: 'build-cot-figure.mjs', dataFiles: ['experiment-cot-gsm8k.json', 'experiment-cot-gsm8k-analysis.json', 'experiment-cot-gsm8k-artifacts.json'] }
];

/** Perturb every numeric-looking field so any data-derived figure must change. */
function perturb(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value + 0.137;
  if (Array.isArray(value)) return value.map(perturb);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, perturb(item)]));
  }
  return value;
}

test('an experiment figure is reproduced exactly from its recorded data', async () => {
  await fs.mkdir(WORK, { recursive: true });
  for (const figure of EXPERIMENT_FIGURES) {
    const outDir = path.join(WORK, figure.id);
    await fs.mkdir(outDir, { recursive: true });
    await run('node', [path.join(repoRoot, 'scripts', figure.script)], {
      cwd: repoRoot,
      env: { ...process.env, SCIENCEPRISM_FIGURE_DATA: AIDOC, SCIENCEPRISM_FIGURE_OUT: outDir }
    });

    const committed = await fs.readFile(path.join(AIDOC, `${figure.id}.svg`), 'utf8');
    const regenerated = await fs.readFile(path.join(outDir, `${figure.id}.svg`), 'utf8');
    assert.equal(
      regenerated,
      committed,
      `${figure.id}.svg differs from a regeneration from its data: the figure was edited by hand, or the data changed without regenerating it`
    );
  }
});

test('an experiment figure actually reads its data', async () => {
  await fs.mkdir(WORK, { recursive: true });
  for (const figure of EXPERIMENT_FIGURES) {
    // Perturb the data, regenerate, and require a different figure. Hardcoded
    // numbers would survive this unchanged.
    const perturbedDir = path.join(WORK, `${figure.id}-perturbed-data`);
    await fs.mkdir(perturbedDir, { recursive: true });
    for (const file of figure.dataFiles) {
      const parsed = JSON.parse(await fs.readFile(path.join(AIDOC, file), 'utf8'));
      await fs.writeFile(path.join(perturbedDir, file), `${JSON.stringify(perturb(parsed))}\n`, 'utf8');
    }

    const outDir = path.join(WORK, `${figure.id}-perturbed`);
    await fs.mkdir(outDir, { recursive: true });
    await run('node', [path.join(repoRoot, 'scripts', figure.script)], {
      cwd: repoRoot,
      env: { ...process.env, SCIENCEPRISM_FIGURE_DATA: perturbedDir, SCIENCEPRISM_FIGURE_OUT: outDir }
    });

    const committed = await fs.readFile(path.join(AIDOC, `${figure.id}.svg`), 'utf8');
    const fromPerturbed = await fs.readFile(path.join(outDir, `${figure.id}.svg`), 'utf8');
    assert.notEqual(
      fromPerturbed,
      committed,
      `${figure.id}.svg is unchanged by perturbed data: its numbers are hardcoded rather than read from the experiment data`
    );
  }
});

test('every committed figure passes the layout check', async () => {
  // The layout check needs Chrome; it reports that it was skipped so a machine
  // without it does not silently pass.
  // promisify(execFile) resolves to {stdout, stderr} with no exit code: a
  // non-zero exit rejects instead. So success already means the checker passed,
  // and asserting on a code field would compare against undefined.
  try {
    const output = await run('node', [path.join(repoRoot, 'scripts', 'check-diagram-layout.mjs')], {
      cwd: repoRoot,
      env: { ...process.env, SCIENCEPRISM_FIGURE_DATA: AIDOC }
    });
    const stdout = String(output.stdout || '') + String(output.stderr || '');
    assert.match(stdout, /0 layout defect\(s\)/, `the layout checker did not report a clean run:\n${stdout}`);
  } catch (error) {
    const stdout = `${error.stdout || ''}${error.stderr || ''}`;
    if (/skipped: Chrome not found/.test(stdout)) return;
    throw error;
  }
});
