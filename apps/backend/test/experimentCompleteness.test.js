import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { checkExperimentArtifact } = await import('../../../scripts/lib/experiment-artifacts.mjs');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AIDOC = path.join(REPO_ROOT, 'aidoc');

/** Minimal well-formed artifact: 2 conditions x 3 questions. */
function wellFormed() {
  const conditions = ['a', 'b'];
  const records = [];
  for (const condition of conditions) {
    for (let index = 0; index < 3; index += 1) {
      records.push({ condition, index, error: null, declared: '1', declaredCorrect: true });
    }
  }
  return { conditions, sampledQuestions: 3, records };
}

test('a complete artifact passes', () => {
  const result = checkExperimentArtifact(wellFormed(), 'ok.json');
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.deepEqual(result.checked, { records: 6, cells: 6 });
});

// Each case below is a defect that actually shipped or nearly shipped in this repo.
test('a truncated run is rejected, because its summary still looks plausible', () => {
  const artifact = wellFormed();
  artifact.records = artifact.records.slice(0, 6 - 5); // the 2-question smoke run that overwrote 600 records
  const result = checkExperimentArtifact(artifact, 'truncated.json');
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /1 records but 3 questions x 2 conditions = 6/);
});

test('a transport failure is rejected instead of being read as a wrong answer', () => {
  const artifact = wellFormed();
  artifact.records[2].error = 'HTTP 502';
  artifact.records[2].declared = null;
  artifact.records[2].declaredCorrect = false;
  const result = checkExperimentArtifact(artifact, 'failed.json');
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /failed at the transport layer and must be re-run/);
  assert.match(result.problems.join('; '), /a#2: HTTP 502/);
});

test('a duplicated cell is rejected, because it hides a missing one', () => {
  const artifact = wellFormed();
  artifact.records[5] = { ...artifact.records[4] }; // b#2 becomes a second copy of b#1
  const result = checkExperimentArtifact(artifact, 'duplicate.json');
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /duplicate cell\(s\): b#1/);
  assert.match(result.problems.join('; '), /missing cell\(s\): b#2/);
});

test('a short sampling record is rejected when k is declared', () => {
  const artifact = {
    planned: 2,
    k: 3,
    records: [
      { index: 0, answers: ['1', '1', '1'], gold: '1', error: null },
      { index: 1, answers: ['2'], gold: '2', error: null }
    ]
  };
  const result = checkExperimentArtifact(artifact, 'short.json');
  assert.equal(result.ok, false);
  assert.match(result.problems.join('; '), /fewer than k=3 samples: 1 \(1\/3\)/);
});

test('an empty records array is rejected rather than treated as an empty result', () => {
  assert.equal(checkExperimentArtifact({ records: [] }, 'empty.json').ok, false);
  assert.equal(checkExperimentArtifact({}, 'missing.json').ok, false);
});

// The real deliverables. This is the check that turns the manual "600 records /
// 200 questions" review of iteration 064 into something that cannot be forgotten.
test('every experiment artifact delivered in aidoc/ is complete', async () => {
  const files = (await readdir(AIDOC)).filter((name) => name.startsWith('experiment-') && name.endsWith('.json')).sort();
  const checked = [];

  for (const file of files) {
    const document = JSON.parse(await readFile(path.join(AIDOC, file), 'utf8'));
    if (!Array.isArray(document.records)) continue; // analyses and inventories have no records
    const result = checkExperimentArtifact(document, file);
    checked.push(`${file} (${result.checked.records} records)`);
    assert.equal(result.ok, true, result.problems.join('\n  - '));
  }

  assert.ok(checked.length > 0, `no experiment artifact with records found under ${AIDOC}`);
});

test('the CoT analysis and grading notes agree with the repaired raw run', async () => {
  const [raw, analysis, artifacts] = await Promise.all([
    'experiment-cot-gsm8k.json',
    'experiment-cot-gsm8k-analysis.json',
    'experiment-cot-gsm8k-artifacts.json'
  ].map(async (name) => JSON.parse(await readFile(path.join(AIDOC, name), 'utf8'))));
  assert.deepEqual(analysis.summary, raw.summary);
  assert.equal(artifacts.gradingArtifact.parseFailures, raw.records.filter((record) => record.parseFailed).length);
  for (const condition of raw.conditions) {
    const rows = raw.records.filter((record) => record.condition === condition.id);
    assert.equal(raw.summary[condition.id].errors, rows.filter((record) => record.error).length);
    assert.equal(artifacts.correctedAccuracy[condition.id].strict, raw.summary[condition.id].declaredAccuracy);
  }
});
