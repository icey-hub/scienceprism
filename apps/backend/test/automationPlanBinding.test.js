import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/automation-plan-binding/', import.meta.url));
await mkdir(cache, { recursive: true });
const data = await mkdtemp(path.join(cache, 'projects-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
process.env.NODE_ENV = 'test';
after(() => rm(data, { recursive: true, force: true }));

const { startAutomation, getAutomation, resumeAutomation } = await import('../src/services/researchAutomation/index.js');
const { readAutomation, saveAutomationPolicy } = await import('../src/services/researchAutomation/policy.js');
const { getExperimentRun, listExperimentRuns } = await import('../src/services/experimentRunner/index.js');
const { listHarnessRuns } = await import('../src/services/harnessRuntime/index.js');
const { registerResearchSourceAdapter } = await import('../src/services/researchSources/index.js');
const { registerResearchWorkflowRoutes } = await import('../src/routes/researchWorkflow.js');
const { getResearchWorkflow } = await import('../src/services/researchWorkflow/queries.js');
const { updateResearchWorkflow } = await import('../src/services/researchWorkflow/commands.js');
let sourceCalls = 0;
registerResearchSourceAdapter({ id: 'arxiv', label: 'Fixed plan-binding source', async search({ beforeRequest }) {
  await beforeRequest?.({ source: 'arxiv', url: 'https://export.arxiv.org/api/query' });
  sourceCalls++;
  return [{ id: 'p1', title: 'Controlled paper', abstract: 'An integration fixture.', authors: ['Fixture Author'], year: 2025,
    url: 'https://arxiv.org/abs/2601.00001', venue: 'Test Conference', publicationType: 'conference', peerReviewed: true, source: 'arxiv' }];
} });

registerResearchSourceAdapter({ id: 'openalex', label: 'Controlled related-work source', async search() { return []; } });

const plan = { dataset: 'data.json', datasetVersion: 'fixture-v1', protocol: 'Calculate the saved sample mean.',
  execution: { adapter: 'node', entrypoint: 'run.mjs', args: [] }, seed: 0, successCriteria: ['Record the actual mean'],
  artifacts: [{ path: 'results/metrics.json', kind: 'metric' }] };
const runtime = { adapter: 'fake', testInput: {
  hypothesis_plan: { fakeResponse: JSON.stringify({"stage":"hypothesis_plan","ideaId":"idea1","hypothesis":{"problem":"Small sample","prediction":"A larger held-out sample may differ","priorWork":"Controlled baseline paper; novelty unverified","conditions":"Independent held-out samples","falsificationCondition":"No repeatable difference"},"evaluation":{"researchType":"empirical","dataset":"","datasetVersion":"","split":"Held-out data required","seed":"0","baselines":["original"],"metrics":[{"name":"mean","direction":"target","threshold":4}],"repetitions":3,"ablations":["original sample"],"budget":{"maxRuns":3,"maxSeconds":60}}}) },
  replication_analysis: { fakeResponse: JSON.stringify({ stage: 'replication_analysis', paperId: 'p1', rows: [{ metricName: 'mean', reportedValue: null, unit: '', referenceLocation: '', reportedText: '', causeHypothesis: 'Source report unavailable; no scientific conclusion.', nextStep: 'Supply the source table.', gapType: 'missing-report', tolerance: null }] }) },
  search: { fakeResponse: JSON.stringify({ stage: 'search_strategy', researchQuestion: 'Question', humanDirection: 'Question', queries: ['Question'], sources: ['arxiv'], rationale: 'Controlled source' }) },
  paper_selection: { fakeResponse: JSON.stringify({ stage: 'paper_selection', paperIds: ['p1'], rationale: 'Relevant fixture' }) },
  reproduction_plan: { fakeResponse: JSON.stringify({ stage: 'reproduction_plan', paperId: 'p1', objective: 'Compute the sample mean.', metrics: ['mean'], expectedOutputs: ['results/metrics.json'], humanApprovalRequired: true }) },
  execution_proposal: { fakeResponse: JSON.stringify({ stage: 'execution_proposal', plan: null, missing: ['Provide the actual execution materials.'] }) }
} };
const file = (id, name) => path.join(data, id, '.scienceprism', name);
const cas = state => ({ expectedSessionId: state.session.id, expectedExecutionPlanVersion: state.session.executionPlanVersion });

async function project(id, overrides = { execution: 'manual' }) {
  const root = path.join(data, id);
  await mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id }));
  await writeFile(file(id, 'project-constraints.json'), JSON.stringify({ capabilities: ['project.read', 'experiment.execute'], maxConcurrent: 1 }));
  await writeFile(path.join(root, 'data.json'), '[2,4,6]');
  await writeFile(path.join(root, 'run.mjs'), `import { readFile, mkdir, writeFile } from 'node:fs/promises';
const sample = JSON.parse(await readFile('data.json', 'utf8'));
await mkdir('results', { recursive: true });
await writeFile('results/metrics.json', JSON.stringify({ metrics: [{ name: 'mean', value: sample.reduce((a,b)=>a+b,0)/sample.length }] }));`);
  await enable(id, overrides);
  return root;
}
async function enable(id, overrides = {}) {
  const state = await readAutomation(id);
  return saveAutomationPolicy(id, { actor: 'human', expectedVersion: state.version, policy: { enabled: true, overrides, agentMode: 'specialists' } });
}
async function settled(id) {
  for (let i = 0; i < 500; i++) {
    const state = await getAutomation(id);
    if (!['queued', 'running', 'stopping'].includes(state.session?.status)) {
      const owner = JSON.parse(await readFile(file(id, 'automation-owner/active/owner.json'), 'utf8'));
      if (owner.released) return state;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('The controlled chain did not finish releasing its owner.');
}
async function prepared(id) {
  await project(id);
  await startAutomation(id, { actor: 'human', question: 'Question', targetStage: 'replication', executionPlan: plan }, runtime);
  const state = await settled(id);
  assert.equal(state.session.status, 'waiting_confirmation', JSON.stringify(state.session));
  assert.equal(state.session.error.details.part, 'execution');
  const step = state.session.steps.find(step => step.stage === 'replication');
  assert.equal(state.session.executionPlanVersion, 1);
  assert.match(state.session.executionPlanSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(step.executionPlanBinding, { version: 1, sha256: state.session.executionPlanSha256 });
  assert.equal((await getExperimentRun(id, step.experimentRunId)).status, 'awaiting_approval');
  return state;
}
async function snapshot(id) {
  return { automation: await readFile(file(id, 'research-automation.json'), 'utf8'),
    harness: await readFile(file(id, 'harness-runs.json'), 'utf8'),
    experiments: await readFile(file(id, 'experiment-runs.json'), 'utf8'), sourceCalls };
}

test('consumed execution materials reject changed parameters, resources and outputs without changing any existing work', async () => {
  const id = 'locked-materials', state = await prepared(id), before = await snapshot(id);
  for (const changed of [{ ...plan, parameters: { variant: 2 } }, { ...plan, resources: { timeoutMs: 1500 } },
    { ...plan, artifacts: [{ path: 'results/replaced.json', kind: 'metric' }] }]) {
    await assert.rejects(() => resumeAutomation(id, { actor: 'human', executionPlan: changed, ...cas(state) }, runtime),
      { statusCode: 409, code: 'AUTOMATION_EXECUTION_PLAN_LOCKED' });
    assert.deepEqual(await snapshot(id), before);
    assert.equal((await readAutomation(id)).session.attempt, state.session.attempt);
  }
  assert.equal((await listExperimentRuns(id)).length, 1);
});

test('same-plan CAS is idempotent and an omitted plan continues the same real Node experiment', async () => {
  const id = 'continue-bound', state = await prepared(id), calls = sourceCalls;
  const runId = state.session.steps.find(step => step.stage === 'replication').experimentRunId;
  const harnessIds = (await listHarnessRuns(id)).map(run => run.id).sort();
  await resumeAutomation(id, { actor: 'human', executionPlan: structuredClone(plan), ...cas(state) }, runtime);
  const again = await settled(id);
  assert.equal(again.session.status, 'waiting_confirmation');
  assert.equal(again.session.executionPlanVersion, 1);
  assert.equal(again.session.executionPlanSha256, state.session.executionPlanSha256);
  assert.equal(again.session.steps.find(step => step.stage === 'replication').experimentRunId, runId);
  assert.equal(sourceCalls, calls);
  assert.deepEqual((await listHarnessRuns(id)).map(run => run.id).sort(), harnessIds);
  await enable(id);
  await resumeAutomation(id, { actor: 'human' }, runtime);
  const done = await settled(id), run = await getExperimentRun(id, runId);
  assert.equal(done.session.status, 'completed', JSON.stringify(done.session));
  assert.equal(done.session.steps.find(step => step.stage === 'replication').experimentRunId, runId);
  assert.equal(run.status, 'completed'); assert.equal(run.metrics[0].value, 4);
  assert.equal(run.approval.actor, 'system');
  assert.equal(run.execution.process.stopConfirmed, true);
  assert.equal((await listExperimentRuns(id)).length, 1);
  assert.equal(sourceCalls, calls);
  assert.equal(await readFile(path.join(data, id, 'data.json'), 'utf8'), '[2,4,6]');
});

test('HTTP forwards plan CAS and rejects stale versions or another session before effects', async t => {
  const id = 'http-plan-cas', state = await prepared(id), before = await snapshot(id);
  const app = Fastify(); registerResearchWorkflowRoutes(app); t.after(() => app.close());
  for (const stale of [{ ...cas(state), expectedExecutionPlanVersion: 0 }, { ...cas(state), expectedSessionId: 'previous-session' }]) {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${id}/research-workflow/automation/resume`,
      payload: { actor: 'human', executionPlan: plan, ...stale } });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'AUTOMATION_EXECUTION_PLAN_CONFLICT');
    assert.deepEqual(await snapshot(id), before);
  }
  const accepted = await app.inject({ method: 'POST', url: `/api/projects/${id}/research-workflow/automation/resume`,
    payload: { actor: 'human', executionPlan: plan, ...cas(state) } });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal((await settled(id)).session.executionPlanVersion, 1);
  assert.equal(sourceCalls, before.sourceCalls);
});

test('a completed missing-materials proposal permits the first plan without repeating searches or prior model calls', async () => {
  const id = 'first-materials'; await project(id, {});
  await startAutomation(id, { actor: 'human', question: 'Question', targetStage: 'replication' }, runtime);
  const blocked = await settled(id);
  assert.equal(blocked.session.status, 'blocked');
  assert.equal(blocked.session.error.code, 'AUTOMATION_MATERIALS_REQUIRED');
  assert.equal(blocked.session.executionPlanVersion, 0);
  const step = blocked.session.steps.find(step => step.stage === 'replication');
  assert.equal(step.executionPlanBinding, undefined); assert.equal(step.calls.length, 1);
  const oldRuns = await listHarnessRuns(id), calls = sourceCalls;
  const proposal = oldRuns.find(run => run.stage === 'replication');
  assert.equal(proposal.status, 'completed'); assert.equal(JSON.parse(proposal.reply).plan, null);
  await resumeAutomation(id, { actor: 'human', executionPlan: plan, ...cas(blocked) }, runtime);
  const done = await settled(id);
  assert.equal(done.session.status, 'completed', JSON.stringify(done.session));
  assert.equal(done.session.executionPlanVersion, 1);
  assert.equal(sourceCalls, calls);
  const runs = await listHarnessRuns(id);
  for (const previous of oldRuns.filter(run => run.kind !== 'research-coordinator')) {
    const retained = runs.find(run => run.id === previous.id);
    assert.equal(retained.attempt, previous.attempt); assert.equal(retained.reply, previous.reply);
  }
  const added = runs.filter(run => !oldRuns.some(previous => previous.id === run.id));
  assert.deepEqual(added.map(run => run.request.task).sort(), ['research:replication_analysis', 'research:reproduction_plan']);
  const experiment = await getExperimentRun(id, done.session.steps.find(step => step.stage === 'replication').experimentRunId);
  assert.equal(experiment.status, 'completed'); assert.equal(experiment.metrics[0].value, 4);
});

test('legacy sessions with an existing Experiment Run cannot replace its materials or create a new Run', async () => {
  const id = 'legacy-bound', state = await prepared(id);
  const legacy = await readAutomation(id);
  delete legacy.session.executionPlanVersion; delete legacy.session.executionPlanSha256; delete legacy.session.executionPlanOrigin;
  for (const step of legacy.session.steps) delete step.executionPlanBinding;
  await writeFile(file(id, 'research-automation.json'), JSON.stringify(legacy));
  const before = await snapshot(id);
  await assert.rejects(() => resumeAutomation(id, { actor: 'human', executionPlan: { ...plan, parameters: { changed: true } },
    expectedSessionId: state.session.id, expectedExecutionPlanVersion: 1 }, runtime),
  { statusCode: 409, code: 'AUTOMATION_EXECUTION_PLAN_LOCKED' });
  assert.deepEqual(await snapshot(id), before);
  assert.equal((await listExperimentRuns(id)).length, 1);
  assert.equal((await listExperimentRuns(id))[0].id, state.session.steps.find(step => step.stage === 'replication').experimentRunId);
});

test('editing actual replication materials cannot hide behind an unchanged saved model input', async () => {
  const variants = [{ parameters: { variant: 2 } }, { resources: { timeoutMs: 1500 } },
    { artifacts: [{ path: 'results/replaced.json', kind: 'metric' }] }];
  for (const [index, change] of variants.entries()) {
    const id = `edited-replication-${index}`, root = await project(id, { replication: 'manual' });
    await writeFile(path.join(root, 'manuscript.tex'), 'Original manuscript.');
    await startAutomation(id, { actor: 'human', question: 'Question', targetStage: 'replication', executionPlan: plan }, runtime);
    const waiting = await settled(id);
    assert.equal(waiting.session.status, 'waiting_confirmation');
    assert.equal(waiting.session.error.details.part, 'replication');
    assert.equal(waiting.session.steps.find(step => step.stage === 'replication').experimentRunId, undefined);
    assert.equal((await listExperimentRuns(id)).length, 0);
    const workflow = await getResearchWorkflow(id), saved = workflow.stages.find(stage => stage.id === 'replication').data;
    const consumed = structuredClone(saved.task.input.plan);
    await updateResearchWorkflow(id, { actor: 'human', stageId: 'replication', expectedVersion: workflow.version,
      data: { executionPlan: { ...saved.executionPlan, ...change } } });
    assert.deepEqual((await getResearchWorkflow(id)).stages.find(stage => stage.id === 'replication').data.task.input.plan, consumed);
    const before = await listHarnessRuns(id), calls = sourceCalls;
    await enable(id);
    await resumeAutomation(id, { actor: 'human' }, runtime);
    const blocked = await settled(id);
    assert.equal(blocked.session.status, 'blocked');
    assert.equal(blocked.session.error.code, 'AUTOMATION_EXECUTION_PLAN_CHANGED');
    assert.equal(blocked.session.steps.find(step => step.stage === 'replication').experimentRunId, undefined);
    assert.equal((await listExperimentRuns(id)).length, 0);
    assert.deepEqual((await listHarnessRuns(id)).map(run => [run.id, run.attempt]).sort(), before.map(run => [run.id, run.attempt]).sort());
    assert.equal(sourceCalls, calls);
    assert.equal(await readFile(path.join(root, 'manuscript.tex'), 'utf8'), 'Original manuscript.');
    assert.equal(await readFile(path.join(root, 'data.json'), 'utf8'), '[2,4,6]');
  }
});

test('nested replication provenance cannot replace the bound dataset, version, protocol or expected outputs', async () => {
  const variants = [{ dataset: 'different-data.json' }, { datasetVersion: 'unbound-version' },
    { note: 'A different experiment protocol.' }, { expectedMetrics: 'results/unbound-output.json' }];
  for (const [index, change] of variants.entries()) {
    const id = `nested-replication-${index}`, root = await project(id, { replication: 'manual' });
    await writeFile(path.join(root, 'manuscript.tex'), 'Original manuscript.');
    await startAutomation(id, { actor: 'human', question: 'Question', targetStage: 'replication', executionPlan: plan }, runtime);
    const waiting = await settled(id);
    assert.equal(waiting.session.status, 'waiting_confirmation');
    assert.equal(waiting.session.error.details.part, 'replication');
    assert.equal((await listExperimentRuns(id)).length, 0);
    const workflow = await getResearchWorkflow(id), saved = workflow.stages.find(stage => stage.id === 'replication').data;
    const originalPlan = structuredClone(saved.executionPlan), originalTask = structuredClone(saved.task);
    await updateResearchWorkflow(id, { actor: 'human', stageId: 'replication', expectedVersion: workflow.version,
      data: { replication: { ...saved.replication, ...change } } });
    const edited = (await getResearchWorkflow(id)).stages.find(stage => stage.id === 'replication').data;
    assert.deepEqual(edited.executionPlan, originalPlan); assert.deepEqual(edited.task, originalTask);
    const before = await listHarnessRuns(id), calls = sourceCalls;
    await enable(id);
    await resumeAutomation(id, { actor: 'human' }, runtime);
    const blocked = await settled(id);
    assert.equal(blocked.session.status, 'blocked');
    assert.equal(blocked.session.error.code, 'AUTOMATION_EXECUTION_PLAN_CHANGED');
    assert.equal(blocked.session.steps.find(step => step.stage === 'replication').experimentRunId, undefined);
    assert.equal((await listExperimentRuns(id)).length, 0);
    assert.deepEqual((await listHarnessRuns(id)).map(run => [run.id, run.attempt]).sort(), before.map(run => [run.id, run.attempt]).sort());
    assert.equal(sourceCalls, calls);
    assert.equal(await readFile(path.join(root, 'manuscript.tex'), 'utf8'), 'Original manuscript.');
    assert.equal(await readFile(path.join(root, 'data.json'), 'utf8'), '[2,4,6]');
  }
});

test('editing actual experiment data refuses a new Run while preserving the completed reproduction', async () => {
  const id = 'edited-experiment', root = await project(id, { experiment: 'manual' });
  await writeFile(path.join(root, 'manuscript.tex'), 'Original manuscript.');
  const fullRuntime = { ...runtime, testInput: { ...runtime.testInput,
    ideation: { fakeResponse: JSON.stringify({ stage: 'innovation_ideas', humanDirection: 'Interpret actual results.', ideas: [{ id: 'idea1', title: 'Hypothesis', problem: 'Small sample', motivation: 'Limited generality', hypothesis: 'A larger sample may differ', novelty: 'Test robustness', relatedPaperIds: ['p1'], validationPlan: ['Use held-out data'], risks: ['Unverified'] }], caveats: ['Controlled fixture only.'] }) },
    method: { fakeResponse: JSON.stringify({ stage: 'method_proposals', selectedIdeaId: 'idea1', proposals: [{ id: 'method1', name: 'Held-out comparison', ideaId: 'idea1', description: 'Compare sample means.', components: ['Mean'], baselines: ['original'], metrics: ['mean'] }], recommendation: 'method1', humanDecisionRequired: true }) },
    experiment_plan: { fakeResponse: JSON.stringify({ stage: 'experiment_plan', methodId: 'method1', datasetIds: ['data.json'], baselineIds: ['original'], metrics: [{ name: 'mean', direction: 'target', target: 4 }], successCriteria: ['Record actual experiment results'], humanApprovalRequired: true }) }
  } };
  await startAutomation(id, { actor: 'human', question: 'Question', targetStage: 'experiment', executionPlan: plan }, fullRuntime);
  const waiting = await settled(id);
  assert.equal(waiting.session.status, 'waiting_confirmation', JSON.stringify(waiting.session));
  assert.equal(waiting.session.error.details.part, 'experiment');
  const original = (await listExperimentRuns(id))[0]; assert.equal(original.status, 'completed');
  const workflow = await getResearchWorkflow(id), saved = workflow.stages.find(stage => stage.id === 'experiment').data;
  const consumed = structuredClone(saved.task.input.plan);
  await updateResearchWorkflow(id, { actor: 'human', stageId: 'experiment', expectedVersion: workflow.version,
    data: { parameters: { changedAfterPreparation: true } } });
  assert.deepEqual((await getResearchWorkflow(id)).stages.find(stage => stage.id === 'experiment').data.task.input.plan, consumed);
  const before = await listHarnessRuns(id), calls = sourceCalls;
  await enable(id);
  await resumeAutomation(id, { actor: 'human' }, fullRuntime);
  const blocked = await settled(id);
  assert.equal(blocked.session.status, 'blocked');
  assert.equal(blocked.session.error.code, 'AUTOMATION_EXECUTION_PLAN_CHANGED');
  assert.equal(blocked.session.steps.find(step => step.stage === 'experiment').experimentRunId, undefined);
  assert.deepEqual(await listExperimentRuns(id), [original]);
  assert.deepEqual((await listHarnessRuns(id)).map(run => [run.id, run.attempt]).sort(), before.map(run => [run.id, run.attempt]).sort());
  assert.equal(sourceCalls, calls);
  assert.equal(await readFile(path.join(root, 'manuscript.tex'), 'utf8'), 'Original manuscript.');
  assert.equal(await readFile(path.join(root, 'data.json'), 'utf8'), '[2,4,6]');
});
