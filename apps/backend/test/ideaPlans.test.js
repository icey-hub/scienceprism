import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/idea-plan-tests/', import.meta.url));
await fs.mkdir(cache, { recursive: true }); const data = await fs.mkdtemp(path.join(cache, 'projects-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
const { getIdeaPlan, saveIdeaPlan } = await import('../src/services/researchWorkflow/ideaPlans.js');
const { createWorkflowDocument } = await import('../src/services/researchWorkflow/stateMachine.js');
const { writeWorkflowFile, readWorkflowFile } = await import('../src/services/researchWorkflow/repository.js');
const { updateResearchWorkflow } = await import('../src/services/researchWorkflow/commands.js');
const { registerResearchWorkflowRoutes } = await import('../src/routes/researchWorkflow.js');
const { datasetService } = await import('../src/services/datasets/index.js');
const { runUiAction } = await import('../src/services/researchWorkflow/application.js');
after(async () => { await datasetService.shutdown(); await fs.rm(data, { recursive: true, force: true }); });

async function fixture(id) {
  const root = path.join(data, id); await fs.mkdir(root, { recursive: true }); await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id }));
  const workflow = createWorkflowDocument(id); workflow.currentStage = 'ideation';
  const stage = workflow.stages.find(item => item.id === 'ideation'); stage.status = 'in_progress';
  stage.data = { ideas: [{ id: 'selected-idea', title: 'Selected candidate', selected: true }, { id: 'other-idea', title: 'Unselected candidate', selected: false }], retainedNote: 'Original stage data' };
  await writeWorkflowFile(root, workflow);
  const { dataset } = await datasetService.importData(id, { bytes: Buffer.from('1\n2\n3\n'), filename: 'values.txt' });
  return { id, root, dataset };
}
function body(f, revision = 0) {
  return { expectedRevision: revision, hypothesis: { problem: 'Limited data coverage', prediction: 'Increase held-out score over the fixed baseline', priorWork: 'Existing baseline', conditions: 'Fixed held-out split', falsificationCondition: 'No increase across repeated trials' },
    evaluation: { researchType: 'computational', dataset: f.dataset.id, datasetVersion: f.dataset.sha256, seed: '0', split: 'Fixed train/test grouping', baselines: ['original baseline'],
      metrics: [{ name: 'accuracy', direction: 'increase', threshold: 0.9 }], repetitions: 3, ablations: ['remove new term'], budget: { maxRuns: 3, maxSeconds: 60 } } };
}

test('idea plan endpoint keeps immutable revisions, editable drafts and original candidates, with CAS and generic-history bypass protection', async () => {
  const f = await fixture('plan-history'), app = Fastify(); registerResearchWorkflowRoutes(app);
  const url = `/api/projects/${f.id}/research-workflow/ideas/selected-idea/plan`, headers = { 'x-scienceprism-actor': 'human' };
  assert.deepEqual((await app.inject({ method: 'GET', url })).json(), { ok: true, plan: null, history: [] });
  const draft = body(f); draft.hypothesis.prediction = ''; draft.evaluation.metrics[0].threshold = null;
  const first = await app.inject({ method: 'PUT', url, headers, payload: draft }); assert.equal(first.statusCode, 200);
  assert.equal(first.json().plan.readiness.ready, false);
  const second = await app.inject({ method: 'PUT', url, headers, payload: body(f, 1) }); assert.equal(second.statusCode, 200);
  assert.equal(second.json().plan.readiness.ready, true); assert.equal(second.json().plan.actor, 'human');
  assert.equal(second.json().history[0].hypothesis.prediction, ''); assert.equal(second.json().history.length, 2);
  assert.equal((await app.inject({ method: 'PUT', url, headers, payload: body(f, 1) })).statusCode, 409);
  assert.equal((await app.inject({ method: 'PUT', url, headers: { 'x-scienceprism-actor': 'ai' }, payload: body(f, 2) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PUT', url, headers, payload: { ...body(f, 2), evidence: { forged: true } } })).statusCode, 400);
  assert.throws(() => updateResearchWorkflow(f.id, { actor: 'human', stageId: 'ideation', data: { ideaPlans: {} } }), { code: 'IDEA_PLAN_VERSION_ENDPOINT_REQUIRED' });
  const saved = await readWorkflowFile(f.root, f.id), stage = saved.stages.find(item => item.id === 'ideation');
  assert.equal(stage.data.retainedNote, 'Original stage data'); assert.equal(stage.data.ideas.length, 2);
  const wrong = body(f, 2); wrong.evaluation.datasetVersion = 'wrong'; wrong.evaluation.seed = ''; wrong.evaluation.budget.maxRuns = 1;
  const invalidReady = await saveIdeaPlan(f.id, 'selected-idea', wrong);
  assert.equal(invalidReady.plan.readiness.ready, false); assert.ok(invalidReady.plan.readiness.issues.some(item => item.includes('重复次数')));
  const theory = body(f, 3); theory.evaluation.researchType = 'theoretical';
  const theoretical = await saveIdeaPlan(f.id, 'selected-idea', theory);
  assert.equal(theoretical.plan.readiness.ready, false); assert.ok(theoretical.plan.readiness.issues.some(item => item.includes('Runner')));
  await app.close();
});

test('idea plan evidence comes only from completed project replication comparison and preserves prior snapshots', async () => {
  const f = await fixture('plan-evidence');
  // Explicit persisted Run/comparison provenance fixture, not a real execution.
  const paper = { id: 'paper-source', title: 'Original fixed source', doi: '10.1234/fixed', sha256: 'a'.repeat(64) };
  const comparison = { revision: 1, paper, paperBinding: 'run-bound', source: 'human', updatedAt: '2026-10-14T00:00:00Z', runStatus: 'completed', rows: [{ metricName: 'accuracy', actualValue: 0.8, reportedValue: 0.9, unit: '', referenceLocation: 'Table 1', reportedText: 'Original reported score', causeHypothesis: 'Unverified', nextStep: 'Check sample coverage', gapType: 'data-coverage', tolerance: null, hypothesisStatus: 'unverified' }] };
  const run = { id: 'actual-replication', projectId: f.id, status: 'completed', metrics: [{ name: 'accuracy', value: 0.8 }], manifest: { replication: { projectId: f.id, sourceStage: 'replication', paper } }, paperComparison: comparison };
  const file = path.join(f.root, '.scienceprism/experiment-runs.json');
  const persist = () => fs.writeFile(file, JSON.stringify({ schemaVersion: 1, projectId: f.id, version: 1, runs: [run] }));
  await persist();
  const first = await saveIdeaPlan(f.id, 'selected-idea', { ...body(f), replicationRunId: run.id });
  assert.equal(first.plan.evidence.runId, run.id); assert.equal(first.plan.evidence.comparisonRevision, 1); assert.equal(first.plan.evidence.rows[0].actualValue, 0.8);
  run.paperComparison.revision = 2; run.paperComparison.rows[0].causeHypothesis = 'Human correction'; await persist();
  const retained = await saveIdeaPlan(f.id, 'selected-idea', body(f, 1));
  assert.equal(retained.plan.evidence.comparisonRevision, 1);
  const revised = await saveIdeaPlan(f.id, 'selected-idea', { ...body(f, 2), replicationRunId: run.id });
  assert.equal(revised.plan.evidence.comparisonRevision, 2); assert.equal(revised.history[0].evidence.rows[0].causeHypothesis, 'Unverified');
  run.paperComparison.paper = { ...paper, doi: 'changed-source' }; await persist();
  await assert.rejects(saveIdeaPlan(f.id, 'selected-idea', { ...body(f, 3), replicationRunId: run.id }), { code: 'IDEA_PLAN_SOURCE_CHANGED' });
  run.status = 'failed'; await persist();
  await assert.rejects(saveIdeaPlan(f.id, 'selected-idea', { ...body(f, 3), replicationRunId: run.id }), { code: 'IDEA_PLAN_SOURCE_INVALID' });
  await assert.rejects(saveIdeaPlan(f.id, 'selected-idea', { ...body(f, 3), replicationRunId: 'foreign-or-missing-run' }), { code: 'IDEA_PLAN_SOURCE_INVALID' });
});

test('method generation receives only the latest selected server plan and ignores forged client plans', async () => {
  const f = await fixture('plan-method'); await saveIdeaPlan(f.id, 'selected-idea', body(f));
  const changed = body(f, 1); changed.hypothesis.prediction = 'Latest selected prediction';
  await saveIdeaPlan(f.id, 'selected-idea', changed); await saveIdeaPlan(f.id, 'other-idea', body(f));
  const workflow = await readWorkflowFile(f.root, f.id); workflow.currentStage = 'method'; workflow.stages.find(item => item.id === 'method').status = 'in_progress'; await writeWorkflowFile(f.root, workflow);
  let captured;
  const result = await runUiAction(f.id, { action: 'generate-method', ideaPlans: [{ ideaId: 'forged-client', revision: 999 }] }, 'human', { runStage: async request => {
    captured = request.input; return { ok: true, runId: 'method-fixture', output: { proposals: [{ id: 'method-a', name: 'Method fixture' }] }, validation: { ok: true, errors: [] } };
  } });
  assert.equal(captured.ideaPlans.length, 1); assert.equal(captured.ideaPlans[0].ideaId, 'selected-idea'); assert.equal(captured.ideaPlans[0].revision, 2);
  assert.equal(captured.ideaPlans[0].hypothesis.prediction, 'Latest selected prediction');
  assert.equal(result.stages.find(item => item.id === 'method').data.task.input.ideaPlans[0].revision, 2);
  await assert.rejects(saveIdeaPlan(f.id, 'selected-idea', body(f, 2)), { code: 'STAGE_GATE' });
  assert.equal((await getIdeaPlan(f.id, 'selected-idea')).history.length, 2);
});
