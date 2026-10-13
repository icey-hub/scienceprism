import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/automation-dataset-stage/', import.meta.url));
await fs.mkdir(cache, { recursive: true });
const data = await fs.mkdtemp(path.join(cache, 'projects-'));
process.env.SCIENCEPRISM_DATA_DIR = data; process.env.NODE_ENV = 'test';
after(() => fs.rm(data, { recursive: true, force: true }));
const { initializeResearchWorkflow } = await import('../src/services/researchWorkflow/commands.js');
const { getResearchWorkflow } = await import('../src/services/researchWorkflow/queries.js');
const { saveAutomationPolicy, readAutomation } = await import('../src/services/researchAutomation/policy.js');
const { startAutomation, getAutomation, resumeAutomation } = await import('../src/services/researchAutomation/index.js');
const { datasetService } = await import('../src/services/datasets/index.js');
const { listExperimentRuns } = await import('../src/services/experimentRunner/index.js');
const { listHarnessRuns, registerHarnessAdapter } = await import('../src/services/harnessRuntime/index.js');
const { fakeHarnessAdapter } = await import('../src/services/harnessRuntime/adapters/fakeAdapter.js');
const { deepseekHarnessAdapter } = await import('../src/services/harnessRuntime/adapters/deepseekAdapter.js');
const { legacyHarnessAdapter } = await import('../src/services/harnessRuntime/adapters/legacyAdapter.js');
after(() => datasetService.shutdown());

async function blockedFixture(id, { missing = false } = {}) {
  const root = path.join(data, id); await fs.mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id }));
  await fs.writeFile(path.join(root, '.scienceprism/project-constraints.json'), JSON.stringify({ capabilities: ['project.read', 'experiment.execute'], maxConcurrent: 1 }));
  await fs.writeFile(path.join(root, 'run.mjs'), 'throw new Error("Private datasets must not reach this entrypoint.");');
  const workflow = await initializeResearchWorkflow(id, { actor: 'human', data: { researchQuestion: 'Controlled input-boundary fixture' } });
  workflow.currentStage = 'replication'; workflow.status = 'in_progress';
  for (const stage of workflow.stages) {
    if (['direction', 'search', 'selection'].includes(stage.id)) stage.status = 'approved';
    if (stage.id === 'search') stage.data = { queries: ['Controlled fixture'] };
    if (stage.id === 'selection') stage.data = { selectedPaperIds: ['paper-fixture'], selectedPapers: [{ id: 'paper-fixture', title: 'Controlled fixture paper', codeUrl: 'project-workspace' }] };
    if (stage.id === 'replication') stage.status = 'in_progress';
  }
  await fs.writeFile(path.join(root, '.scienceprism/research-workflow.json'), JSON.stringify(workflow));
  const bytes = Buffer.from('x,y\n1,2\n'), imported = await datasetService.importData(id, { bytes, filename: 'data.csv', license: 'CC0' });
  assert.equal(imported.dataset.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual((await datasetService.content(id, imported.dataset.id)).bytes, bytes);
  const state = await readAutomation(id);
  await saveAutomationPolicy(id, { actor: 'human', expectedVersion: state.version, policy: { enabled: true, overrides: {}, agentMode: 'specialists',
    datasetScope: { allowedHosts: ['raw.githubusercontent.com'], maxBytes: 1024, maxDatasets: 1 } } });
  const plan = { dataset: imported.dataset.id, datasetVersion: '0'.repeat(64), protocol: 'Read the actual CSV input.',
    execution: { adapter: 'node', entrypoint: 'run.mjs', args: [] }, seed: 0, successCriteria: ['Record actual metrics'], artifacts: [{ path: 'results/metrics.json', kind: 'metric' }] };
  const fakeResponse = JSON.stringify({ stage: 'execution_proposal', plan: missing ? null : plan, missing: missing ? ['Prepare verified accessible input and environment.'] : [] });
  const runtime = { adapter: 'fake', testInput: { replication: { fakeResponse }, execution_proposal: { fakeResponse } } };
  await startAutomation(id, { actor: 'human', targetStage: 'replication' }, runtime);
  let final;
  for (let attempt = 0; attempt < 300; attempt++) {
    final = await getAutomation(id);
    if (!['queued', 'running', 'stopping'].includes(final.session?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(final.session.status, 'blocked', JSON.stringify(final.session));
  assert.equal(final.session.error.code, missing ? 'AUTOMATION_MATERIALS_REQUIRED' : 'AUTOMATION_DATASET_VERSION_CHANGED', JSON.stringify(final.session.error));
  return { root, final, imported, runtime };
}

async function snapshot(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(location);
      else result[path.relative(root, location)] = (await fs.readFile(location)).toString('base64');
    }
  }
  await visit(root); return result;
}

test('wrong acquired dataset SHA from a completed model proposal cannot approve or execute a private blob', async () => {
  const id = 'private-input', { final, imported } = await blockedFixture(id);
  const step = final.session.steps.find(item => item.stage === 'replication');
  assert.equal(step.prepared, undefined); assert.equal(step.approved, undefined); assert.equal(step.result, undefined); assert.equal(step.experimentRunId, undefined);
  assert.notEqual(step.status, 'completed'); assert.equal(final.session.executionPlan, null);
  assert.deepEqual(await listExperimentRuns(id), []);
  const runs = await listHarnessRuns(id), producer = runs.find(run => run.task === 'research:execution_proposal');
  assert.ok(producer); assert.equal(producer.status, 'completed');
  assert.ok(producer.reply.includes(imported.dataset.id)); assert.ok(producer.reply.includes('0'.repeat(64)));
  assert.equal(runs.filter(run => run.task === 'research:reproduction_plan').length, 0);
  const workflow = await getResearchWorkflow(id), replication = workflow.stages.find(stage => stage.id === 'replication');
  assert.equal(workflow.currentStage, 'replication'); assert.equal(replication.status, 'in_progress');
  assert.equal(replication.data.task, undefined); assert.equal(replication.data.replication, undefined);
  assert.equal(imported.dataset.license.verified, false);
});

test('stale human resume without new materials rejects before saving or creating any run', async () => {
  const id = 'stale-resume', { root, final, runtime } = await blockedFixture(id);
  const runIds = (await listHarnessRuns(id)).map(run => run.id).sort(), experiments = await listExperimentRuns(id), before = await snapshot(root);
  await assert.rejects(resumeAutomation(id, { actor: 'human', expectedSessionId: 'wrong' }, runtime), { statusCode: 409, code: 'AUTOMATION_SESSION_CHANGED' });
  assert.deepEqual(await snapshot(root), before);
  assert.deepEqual((await listHarnessRuns(id)).map(run => run.id).sort(), runIds);
  assert.deepEqual(await listExperimentRuns(id), experiments);
  const current = await getAutomation(id); assert.equal(current.session.id, final.session.id); assert.equal(current.session.attempt, final.session.attempt);
});

function countedLocalAdapters(t) {
  const counts = { fake: 0, default: 0 };
  registerHarnessAdapter({ ...fakeHarnessAdapter, async run(input) { counts.fake++; return fakeHarnessAdapter.run(input); } });
  for (const id of ['deepseek', 'legacy']) registerHarnessAdapter({ id, async run() { counts.default++; throw new Error('No real model or network is permitted in this regression fixture.'); } });
  t.after(() => { registerHarnessAdapter(fakeHarnessAdapter); registerHarnessAdapter(deepseekHarnessAdapter); registerHarnessAdapter(legacyHarnessAdapter); });
  return counts;
}
async function settleResume(id) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const state = await getAutomation(id);
    if (!['queued', 'running', 'stopping'].includes(state.session?.status)) return state;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Resumed semantic identity fixture did not settle.');
}

test('explicit fake to default runtime resume reuses completed semantic proposal with zero new adapter calls', async t => {
  const counts = countedLocalAdapters(t), id = 'semantic-default', { final, runtime } = await blockedFixture(id, { missing: true });
  const runs = (await listHarnessRuns(id)).map(run => run.id).sort(), previous = { ...counts };
  assert.equal(final.session.steps[0].calls[0].inputIdentityVersion, 2); assert.equal(counts.fake, 1);
  const { adapter, ...defaultRuntime } = runtime;
  await resumeAutomation(id, { actor: 'human', expectedSessionId: final.session.id }, defaultRuntime);
  const resumed = await settleResume(id);
  assert.equal(resumed.session.status, 'blocked'); assert.equal(resumed.session.error.code, 'AUTOMATION_MATERIALS_REQUIRED');
  assert.deepEqual((await listHarnessRuns(id)).map(run => run.id).sort(), runs); assert.deepEqual(counts, previous);
  assert.equal(resumed.session.steps[0].calls.length, 1); assert.deepEqual(await listExperimentRuns(id), []);
});

test('legacy adapter-sensitive hash resumes from actual semantic request; changed stored input is rejected', async t => {
  const counts = countedLocalAdapters(t), id = 'semantic-legacy', { root, final, runtime } = await blockedFixture(id, { missing: true });
  const harnessFile = path.join(root, '.scienceprism/harness-runs.json'), automationFile = path.join(root, '.scienceprism/research-automation.json');
  const runs = await listHarnessRuns(id), producer = runs.find(run => run.task === 'research:execution_proposal'), request = producer.request;
  const stored = JSON.parse(await fs.readFile(automationFile, 'utf8')), call = stored.session.steps[0].calls[0];
  call.inputHash = createHash('sha256').update(JSON.stringify({ task: request.task, role: request.role, input: request.input, context: request.context,
    prompt: request.prompt, skills: request.researchSkills, adapter: 'fake' })).digest('hex'); call.inputIdentityVersion = 1;
  await fs.writeFile(automationFile, JSON.stringify(stored));
  const previous = { ...counts }, { adapter, ...defaultRuntime } = runtime;
  await resumeAutomation(id, { actor: 'human', expectedSessionId: final.session.id }, defaultRuntime);
  const resumed = await settleResume(id);
  assert.equal(resumed.session.error.code, 'AUTOMATION_MATERIALS_REQUIRED'); assert.deepEqual(counts, previous);
  assert.deepEqual((await listHarnessRuns(id)).map(run => run.id).sort(), runs.map(run => run.id).sort());
  // Use a v2 admission identity for the exact old source, then alter only the
  // source request. A matching saved hash must not authenticate altered input.
  const next = JSON.parse(await fs.readFile(automationFile, 'utf8'));
  next.session.steps[0].calls[0].inputHash = createHash('sha256').update(JSON.stringify({ task: request.task, role: request.role, input: request.input,
    context: request.context, prompt: request.prompt, skills: request.researchSkills })).digest('hex');
  next.session.steps[0].calls[0].inputIdentityVersion = 2; await fs.writeFile(automationFile, JSON.stringify(next));
  const document = JSON.parse(await fs.readFile(harnessFile, 'utf8'));
  document.runs.find(run => run.id === producer.id).request.input.instructions = 'Tampered material request';
  await fs.writeFile(harnessFile, JSON.stringify(document));
  await resumeAutomation(id, { actor: 'human', expectedSessionId: final.session.id }, defaultRuntime);
  const rejected = await settleResume(id);
  assert.equal(rejected.session.status, 'blocked'); assert.equal(rejected.session.error.code, 'AUTOMATION_RUN_INPUT_CHANGED');
  assert.deepEqual(counts, previous); assert.deepEqual((await listHarnessRuns(id)).map(run => run.id).sort(), runs.map(run => run.id).sort());
});
