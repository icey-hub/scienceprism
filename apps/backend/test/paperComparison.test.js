import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/paper-comparison-tests/', import.meta.url));
await fs.mkdir(cache, { recursive: true });
const data = await fs.mkdtemp(path.join(cache, 'projects-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
const { createExperimentRun, getExperimentRun, getExperimentPaperComparison, saveExperimentPaperComparison, experimentRunSummary } = await import('../src/services/experimentRunner/index.js');
const { readExperimentRuns, writeExperimentRuns } = await import('../src/services/experimentRunner/repository.js');
const { importPaper } = await import('../src/services/projectHub/paperLibrary.js');
const { registerExperimentRunRoutes } = await import('../src/routes/experimentRuns.js');
after(() => fs.rm(data, { recursive: true, force: true }));

const paper = { id: 'original-paper', title: 'Fixed selected source', doi: '10.1234/fixed', sha256: 'a'.repeat(64) };
const row = (metricName, reportedValue, tolerance = 0.01) => ({ metricName, reportedValue, tolerance, unit: 'score', referenceLocation: 'Table 2, fixed split',
  reportedText: 'Human-transcribed paper value; not independently verified.', causeHypothesis: 'A possible sample coverage difference.', nextStep: 'Check the preserved split.', gapType: 'data-coverage' });
const input = (rows, patch = {}) => ({ expectedRevision: 0, paperId: paper.id, rows, ...patch });

// Authoritative persisted Run fixtures, not new real scientific executions.
async function fixture(id, { status = 'completed', metrics = [], bound = true, trial = false } = {}) {
  const root = path.join(data, id); await fs.mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id }));
  await fs.writeFile(path.join(root, 'run.mjs'), "console.log('Comparison fixture is not executed.');");
  const run = await createExperimentRun(id, { plan: { dataset: { id: 'legacy-dataset', version: 'fixture-v1' }, protocol: 'Stored comparison fixture only.',
    execution: { adapter: 'node', entrypoint: 'run.mjs', args: [] }, seed: 0, codePaths: ['run.mjs'] } });
  const document = await readExperimentRuns(root, id), saved = document.runs[0];
  saved.status = status; saved.metrics = metrics;
  if (bound) saved.manifest.replication = { sourceStage: 'replication', projectId: id, paper: structuredClone(paper) };
  if (trial) { saved.purpose = 'engineering-trial'; saved.manifest.purpose = 'engineering-trial'; saved.manifest.trial = { purpose: 'engineering-trial' }; }
  await writeExperimentRuns(root, document);
  return { id, root, runId: run.id, change: async mutate => { const doc = await readExperimentRuns(root, id); mutate(doc.runs[0]); await writeExperimentRuns(root, doc); } };
}

test('paper comparison computes matches and gaps only from stored finite Run metrics, persists CAS and exposes the same record in summary/API', async () => {
  const f = await fixture('comparison-values', { metrics: [{ name: 'match', value: 0.9, unit: 'score' }, { name: 'different', value: 0.4, unit: 'score' },
    { name: 'unknown-tolerance', value: 2 }, { name: 'missing-paper', value: 7 }, { name: 'zero', value: 0, unit: 'score' }, { name: 'text-metric', value: '0.9' }] });
  const app = Fastify(); registerExperimentRunRoutes(app);
  const url = `/api/projects/${f.id}/experiment-runs/${f.runId}/paper-comparison`;
  assert.deepEqual((await app.inject({ method: 'GET', url })).json(), { ok: true, comparison: null });
  const rows = [row('match', 0.91, 0.02), row('different', 0.9, 0.02), row('unknown-tolerance', 2, null), row('missing-paper', null), row('missing-actual', 3), row('zero', 0, 0), row('text-metric', 0.9)];
  const response = await app.inject({ method: 'PUT', url, headers: { 'x-scienceprism-actor': 'system' }, payload: input(rows) });
  assert.equal(response.statusCode, 200); const saved = response.json().comparison;
  assert.equal(saved.source, 'human'); assert.equal(saved.paperBinding, 'run-bound'); assert.equal(saved.revision, 1);
  assert.deepEqual(saved.rows.map(item => item.status), ['match', 'different', 'unassessed', 'missing-report', 'missing-result', 'match', 'missing-result']);
  assert.equal(saved.rows[0].actualValue, 0.9); assert.equal(saved.rows[2].difference, 0); assert.equal(saved.rows[5].actualValue, 0);
  assert.ok(saved.rows.every(item => item.hypothesisStatus === 'unverified'));
  assert.deepEqual(await getExperimentPaperComparison(f.id, f.runId), saved);
  assert.deepEqual(experimentRunSummary(await getExperimentRun(f.id, f.runId)).paperComparison, saved);
  const stale = await app.inject({ method: 'PUT', url, payload: input(rows) }); assert.equal(stale.statusCode, 409);
  const corrected = await saveExperimentPaperComparison(f.id, f.runId, input([row('match', 0.9)], { expectedRevision: 1 }));
  assert.equal(corrected.revision, 2); assert.equal(corrected.rows[0].status, 'match');
  const forged = await app.inject({ method: 'PUT', url, payload: input([{ ...row('match', 0.9), actualValue: 999 }], { expectedRevision: 2 }) });
  assert.equal(forged.statusCode, 400); assert.equal((await getExperimentPaperComparison(f.id, f.runId)).revision, 2);
  const actorForgery = await app.inject({ method: 'PUT', url, payload: { ...input([], { expectedRevision: 2 }), actor: 'system' } });
  assert.equal(actorForgery.statusCode, 400);
  const unsupportedReport = await app.inject({ method: 'PUT', url, payload: input([{ ...row('match', 0.9), referenceLocation: '' }], { expectedRevision: 2 }) });
  assert.equal(unsupportedReport.statusCode, 400); await app.close();
});

test('failed or cancelled Runs cannot become numeric matches, and later completion refreshes actual values without replacing human text or revision', async () => {
  for (const status of ['failed', 'cancelled', 'approved']) {
    const f = await fixture(`comparison-${status}`, { status, metrics: [{ name: 'score', value: 1 }] });
    const saved = await saveExperimentPaperComparison(f.id, f.runId, input([row('score', 1, 0)]));
    assert.equal(saved.rows[0].status, status === 'failed' ? 'run-failed' : 'run-incomplete'); assert.equal(saved.rows[0].difference, null);
    if (status === 'approved') {
      await f.change(run => { run.status = 'completed'; run.metrics = [{ name: 'score', value: 2 }]; });
      const current = await getExperimentPaperComparison(f.id, f.runId);
      assert.equal(current.rows[0].status, 'different'); assert.equal(current.rows[0].actualValue, 2);
      assert.equal((await getExperimentRun(f.id, f.runId)).paperComparison.rows[0].actualValue, 2);
      assert.equal(current.revision, saved.revision); assert.equal(current.updatedAt, saved.updatedAt); assert.equal(current.rows[0].reportedText, saved.rows[0].reportedText);
    }
  }
  const trial = await fixture('comparison-trial', { trial: true });
  await assert.rejects(saveExperimentPaperComparison(trial.id, trial.runId, input([row('score', 1)])), { code: 'PAPER_COMPARISON_ENGINEERING_TRIAL' });
});

test('legacy unbound Runs link only an explicit project source for analysis without changing the original Manifest or crossing projects', async () => {
  const foreign = await fixture('foreign-paper-project', { bound: false });
  const imported = await importPaper(foreign.id, { id: 'foreign-only-paper', title: 'Foreign project source', doi: '10.1234/foreign' });
  const f = await fixture('legacy-comparison', { bound: false, metrics: [{ name: 'score', value: 0.9 }] });
  const before = (await getExperimentRun(f.id, f.runId)).manifest;
  await assert.rejects(saveExperimentPaperComparison(f.id, f.runId, input([row('score', 1)], { paperId: imported.paper.id })), { code: 'PAPER_COMPARISON_SOURCE_NOT_FOUND' });
  const local = await importPaper(f.id, { id: 'local-source', title: 'Project library source', doi: '10.1234/local' });
  const saved = await saveExperimentPaperComparison(f.id, f.runId, input([row('score', 1)], { paperId: local.paper.id }));
  assert.equal(saved.paperBinding, 'analysis-linked'); assert.equal(saved.paper.id, local.paper.id); assert.match(saved.paper.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual((await getExperimentRun(f.id, f.runId)).manifest, before);
  const bound = await fixture('fixed-paper-comparison');
  await assert.rejects(saveExperimentPaperComparison(bound.id, bound.runId, input([], { paperId: local.paper.id })), { code: 'PAPER_COMPARISON_SOURCE_MISMATCH' });
});

test('AI comparison must name the completed project analysis Run and cannot overwrite a human revision', async () => {
  const f = await fixture('ai-paper-comparison', { metrics: [{ name: 'score', value: 0.9 }] });
  await assert.rejects(saveExperimentPaperComparison(f.id, f.runId, input([row('score', 1)]), { actor: 'system' }), { code: 'PAPER_COMPARISON_ANALYSIS_SOURCE_REQUIRED' });
  const producer = { id: 'analysis-producer', projectId: f.id, status: 'completed', request: { task: 'research:replication_analysis', input: { run: { id: f.runId } } } };
  const file = path.join(f.root, '.scienceprism/harness-runs.json');
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, projectId: f.id, runs: [producer] }));
  const saved = await saveExperimentPaperComparison(f.id, f.runId, input([row('score', 1)]), { actor: 'system', sourceRunId: producer.id });
  assert.equal(saved.source, 'ai'); assert.equal(saved.sourceRunId, producer.id);
  await saveExperimentPaperComparison(f.id, f.runId, input([row('score', 0.9)], { expectedRevision: 1 }), { actor: 'human' });
  await assert.rejects(saveExperimentPaperComparison(f.id, f.runId, input([row('score', 1)], { expectedRevision: 1 }), { actor: 'system', sourceRunId: producer.id }), { code: 'PAPER_COMPARISON_CONFLICT' });
  producer.request.input.run.id = 'another-run'; await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, projectId: f.id, runs: [producer] }));
  await assert.rejects(saveExperimentPaperComparison(f.id, f.runId, input([row('score', 1)], { expectedRevision: 2 }), { actor: 'system', sourceRunId: producer.id }), { code: 'PAPER_COMPARISON_ANALYSIS_SOURCE_CHANGED' });
});
