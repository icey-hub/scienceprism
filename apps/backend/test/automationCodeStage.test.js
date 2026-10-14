import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/automation-code-stage/', import.meta.url));
await fs.mkdir(cache, { recursive: true });
const data = await fs.realpath(await fs.mkdtemp(path.join(cache, 'case-')));
process.env.SCIENCEPRISM_DATA_DIR = data; process.env.NODE_ENV = 'test';
const { initializeResearchWorkflow } = await import('../src/services/researchWorkflow/commands.js');
const { getResearchWorkflow } = await import('../src/services/researchWorkflow/queries.js');
const { saveAutomationPolicy, readAutomation } = await import('../src/services/researchAutomation/policy.js');
const { startAutomation, resumeAutomation, getAutomation } = await import('../src/services/researchAutomation/index.js');
const { getHarnessRun, listHarnessRuns, registerHarnessAdapter } = await import('../src/services/harnessRuntime/index.js');
const { fakeHarnessAdapter } = await import('../src/services/harnessRuntime/adapters/fakeAdapter.js');
const { deepseekHarnessAdapter } = await import('../src/services/harnessRuntime/adapters/deepseekAdapter.js');
const { codePreparationService } = await import('../src/services/experimentRunner/codePreparations.js');
const { environmentService, createEnvironmentService } = await import('../src/services/experimentRunner/environments.js');
const { listExperimentRuns } = await import('../src/services/experimentRunner/index.js');
after(() => fs.rm(data, { recursive: true, force: true }));
const sha = value => createHash('sha256').update(value).digest('hex');
const codeScope = { allowedPaths: ['experiments'], maxTokens: 5000, timeoutMs: 30000, maxVersions: 1 };
const envScope = { allowedPaths: [], maxPackages: 0, maxPrepareMs: 120000, maxOutputBytes: 1024, maxEnvironments: 1 };
async function settled(id) {
  for (let i = 0; i < 400; i++) {
    const value = await getAutomation(id);
    if (!['queued', 'running', 'stopping'].includes(value.session?.status)) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Controlled code stage did not settle.');
}
async function fixture(t, id, { manual = false, scope = true, python = false, env = true, failFreeze = false,
  wrongPath = false, sessionPlan = false, unrelatedPython = false } = {}) {
  const root = path.join(data, id); await fs.mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id }));
  await fs.writeFile(path.join(root, 'main.tex'), 'Original manuscript sentinel.');
  await fs.writeFile(path.join(root, 'data.json'), '[2,4,6]');
  await fs.writeFile(path.join(root, 'protocol.json'), '{"kind":"wiring-fixture","scientificResult":false}');
  if (unrelatedPython) await fs.writeFile(path.join(root, 'obsolete.py'), 'import unavailable_old_dependency\n');
  await fs.writeFile(path.join(root, '.scienceprism/project-constraints.json'), JSON.stringify({
    capabilities: ['project.read', 'patch.propose', 'experiment.execute'], featureFlags: { advancedHarness: true } }));
  const workflow = await initializeResearchWorkflow(id, { actor: 'human', data: { researchQuestion: 'Fixed wiring fixture only' } });
  workflow.currentStage = 'replication';
  for (const s of workflow.stages.filter(s => ['direction', 'search', 'selection'].includes(s.id))) s.status = 'approved';
  workflow.stages.find(s => s.id === 'selection').data = { selectedPapers: [{ id: 'fixed-paper', title: 'Wiring fixture' }] };
  await fs.writeFile(path.join(root, '.scienceprism/research-workflow.json'), JSON.stringify(workflow));
  const entrypoint = wrongPath ? 'outside/run.mjs' : `experiments/run.${python ? 'py' : 'mjs'}`;
  const plan = { dataset: 'data.json', datasetVersion: 'fixed-v1', protocol: 'Read fixed data and report a mean; fixture, not reproduction.',
    execution: { adapter: python ? 'python' : 'node', entrypoint, args: [] }, seed: 0, successCriteria: ['mean'], artifacts: [] };
  const state = await readAutomation(id);
  await saveAutomationPolicy(id, { actor: 'human', expectedVersion: state.version, policy: { enabled: true, agentMode: 'specialists',
    overrides: { replication: 'manual', execution: 'manual', ...(manual ? { code: 'manual' } : {}) }, ...(scope ? { codeScope } : {}),
    ...(python && env ? { environmentScope: envScope } : {}) } });
  const counts = { models: [], freeze: 0, environment: 0 }, frozen = new Map();
  const originalCreate = codePreparationService.create, originalVerify = codePreparationService.verify;
  codePreparationService.create = async (projectId, input) => {
    assert.equal(projectId, id); counts.freeze++;
    const run = await getHarnessRun(id, input.sourceRunId), current = await readAutomation(id);
    const step = current.session.steps.find(s => s.stage === 'replication');
    assert.equal(run.role, 'experiment-code-producer'); assert.equal(run.parentRunId, current.session.coordinatorRunId);
    assert.ok(step.calls.some(call => call.runId === run.id)); assert.equal(step.codePreparations[0].producerRunId, run.id);
    if (failFreeze) throw Object.assign(new Error('Controlled handoff verification failure'), { code: 'CODE_PREPARATION_HANDOFF_MISMATCH' });
    const files = run.patches.map(p => ({ path: p.path, content: p.content, bytes: Buffer.byteLength(p.content), sha256: sha(p.content), baseVersion: p.baseVersion }));
    const digest = sha(JSON.stringify({ sourceRunId: run.id, files })), preparation = { id: `code-preparation-${digest}`, sha256: digest,
      projectId: id, source: { runId: run.id, childRunIds: ['domain-verification-stub'] }, files: files.map(({ content, ...file }) => file) };
    frozen.set(preparation.id, { preparation, files }); return { preparation, cached: false };
  };
  codePreparationService.verify = async (projectId, key, version) => {
    assert.equal(projectId, id); const result = frozen.get(key); assert.ok(result); assert.equal(version, result.preparation.sha256); return result;
  };
  const envService = createEnvironmentService({ resolveProject: async () => root, probe: async () => ({ available: true }), prepare: async o => {
    counts.environment++; await o.beforeLaunch(); await o.onLaunch(); await o.onProcess({ pid: process.pid, stopConfirmed: true });
    await fs.mkdir(path.join(o.directory, 'bin')); await fs.writeFile(path.join(o.directory, 'bin/python'), 'fixed fixture interpreter');
    return { python: { version: '3.fixture', implementation: 'fixture' }, packages: [], isolation: 'fixture', hardware: { platform: 'fixture', arch: 'fixture', cpuCount: 1 } };
  } });
  const originalPrepare = environmentService.prepareAuthorized, originalEnvVerify = environmentService.verify;
  environmentService.prepareAuthorized = envService.prepareAuthorized; environmentService.verify = envService.verify;
  const adapter = adapterId => ({ ...fakeHarnessAdapter, id: adapterId, async run(input) {
    counts.models.push(input.request.task);
    const current = await readAutomation(id);
    if (input.request.task === 'research:code-preparation') {
      const step = current.session.steps.find(s => s.stage === 'replication');
      assert.ok(step.calls.some(call => call.runId === step.codePreparations[0].producerRunId));
      return fakeHarnessAdapter.run({ ...input, request: { ...input.request, fakeResponse: 'Controlled code proposal',
        fakePatches: [{ path: entrypoint, content: python ? 'print("fixture")\n' : 'console.log("fixture");\n' }] } });
    }
    if (unrelatedPython && input.request.task === 'research:environment_proposal') {
      assert.equal(input.request.input.entrypoint, entrypoint);
      assert.equal(input.request.input.preparedCode.files[0].path, entrypoint);
      assert.equal(counts.freeze, 1);
    }
    const output = input.request.task === 'research:execution_proposal' ? { stage: 'execution_proposal', plan, missing: [] }
      : input.request.task === 'research:environment_proposal' ? { stage: 'environment_proposal', packages: [], blockers: [], deferred: [], reason: 'Fixed stdlib fixture' }
        : { stage: 'reproduction_plan', paperId: 'fixed-paper', objective: 'Fixture only', metrics: ['mean'], humanApprovalRequired: true, expectedOutputs: ['mean'], risks: [] };
    return fakeHarnessAdapter.run({ ...input, request: { ...input.request, fakeResponse: JSON.stringify(output) } });
  } });
  registerHarnessAdapter(adapter('fake')); registerHarnessAdapter(adapter('deepseek'));
  t.after(async () => { await envService.shutdown(); codePreparationService.create = originalCreate; codePreparationService.verify = originalVerify;
    environmentService.prepareAuthorized = originalPrepare; environmentService.verify = originalEnvVerify;
    registerHarnessAdapter(fakeHarnessAdapter); registerHarnessAdapter(deepseekHarnessAdapter); });
  await startAutomation(id, { actor: 'human', targetStage: 'replication', ...(sessionPlan ? { executionPlan: plan } : {}) }, { adapter: 'fake' });
  return { root, counts, plan, state: await settled(id) };
}

test('original stage freezes code and waits for trial execution authority without binding the formal plan', async t => {
  const id = 'frozen-stage', f = await fixture(t, id);
  assert.equal(f.state.session.status, 'waiting_confirmation', JSON.stringify(f.state.session.error));
  assert.equal(f.state.session.error.details.part, 'execution');
  const step = f.state.session.steps.find(s => s.stage === 'replication'), saved = (await getResearchWorkflow(id)).stages.find(s => s.id === 'replication').data;
  assert.equal(step.codePreparations[0].status, 'completed');
  assert.equal(f.state.session.executionPlan, null);
  assert.equal(step.executionPlanBinding, undefined);
  assert.equal(saved.executionPlan, undefined);
  assert.equal(step.codeTrials, undefined);
  assert.deepEqual(f.counts.models, ['research:execution_proposal', 'research:code-preparation']);
  const before = (await listHarnessRuns(id)).map(run => run.id).sort();
  await resumeAutomation(id, { actor: 'human' }, { adapter: 'fake' }); await settled(id);
  assert.deepEqual((await listHarnessRuns(id)).map(run => run.id).sort(), before); assert.equal(f.counts.freeze, 1);
  assert.deepEqual(await listExperimentRuns(id), []);
  assert.equal(await fs.readFile(path.join(f.root, 'main.tex'), 'utf8'), 'Original manuscript sentinel.');
  await assert.rejects(fs.stat(path.join(f.root, 'experiments/run.mjs')), { code: 'ENOENT' });
});
test('new Python code reaches the original environment preparation despite no project Python file', async t => {
  const f = await fixture(t, 'new-python', { python: true });
  assert.equal(f.state.session.status, 'waiting_confirmation', JSON.stringify(f.state.session.error));
  const step = f.state.session.steps.find(s => s.stage === 'replication');
  assert.match(step.environmentPreparations[0].environmentId, /^environment-/);
  assert.equal(f.state.session.executionPlan, null);
  assert.equal(step.executionPlanBinding, undefined);
  assert.equal(f.counts.environment, 1); assert.equal(f.counts.freeze, 1);
  assert.deepEqual(f.counts.models, ['research:execution_proposal', 'research:code-preparation', 'research:environment_proposal']);
});
test('unrelated old Python does not preempt the selected new code or its environment', async t => {
  const f = await fixture(t, 'unrelated-python', { python: true, unrelatedPython: true });
  assert.equal(f.state.session.status, 'waiting_confirmation', JSON.stringify(f.state.session.error));
  assert.equal(f.counts.freeze, 1); assert.equal(f.counts.environment, 1);
  assert.deepEqual(f.counts.models, ['research:execution_proposal', 'research:code-preparation', 'research:environment_proposal']);
});
test('enabling execution resumes pending preparation without approving the manual research stage or repeating its producer', async t => {
  const id = 'resume-pending-trial', f = await fixture(t, id);
  const initial = await readAutomation(id), ids = (await listHarnessRuns(id)).map(run => run.id).sort();
  await saveAutomationPolicy(id, { actor: 'human', expectedVersion: initial.version,
    policy: { ...initial.policy, overrides: { ...initial.policy.overrides, execution: 'auto' } } });
  await resumeAutomation(id, { actor: 'human' }, { adapter: 'fake' });
  const next = await settled(id);
  // This old wiring fixture has a legacy data label rather than a SHA-backed
  // input; reaching that check proves resume did not stop at stage approval.
  assert.equal(next.session.error.code, 'EXPERIMENT_TRIAL_FIXED_DATA_REQUIRED');
  assert.deepEqual((await listHarnessRuns(id)).map(run => run.id).sort(), ids);
  assert.equal(f.counts.freeze, 1);
  assert.equal(next.session.executionPlan, null);
  assert.equal((await getResearchWorkflow(id)).stages.find(s => s.id === 'replication').status, 'pending');
});
for (const [name, options, error] of [
  ['manual code waits before producer', { manual: true }, 'AUTOMATION_CONFIRMATION_REQUIRED'],
  ['old policy grants no code', { scope: false }, 'AUTOMATION_MATERIALS_REQUIRED'],
  ['new entrypoint outside scope is rejected', { wrongPath: true }, 'AUTOMATION_CODE_PATH_DENIED'],
  ['handoff failure cannot bind final materials', { failFreeze: true }, 'CODE_PREPARATION_HANDOFF_MISMATCH'],
  ['new Python without environment authority preserves frozen code and stops', { python: true, env: false }, 'AUTOMATION_ENVIRONMENT_SCOPE_REQUIRED']
]) test(name, async t => {
  const id = name.replaceAll(' ', '-'), f = await fixture(t, id, options);
  assert.equal(f.state.session.error.code, error, JSON.stringify(f.state.session.error));
  assert.deepEqual(await listExperimentRuns(id), []);
  assert.equal(f.state.session.steps.find(s => s.stage === 'replication').executionPlanBinding, undefined);
  if (!options.failFreeze && !options.python) assert.equal(f.counts.freeze, 0);
});

test('user plan prepares scoped code and environment while retaining the exact original until the trial can run', async t => {
  const f = await fixture(t, 'user-materials', { sessionPlan: true, python: true });
  assert.equal(f.state.session.status, 'waiting_confirmation');
  assert.equal(f.state.session.error.details.part, 'execution');
  const step = f.state.session.steps.find(s => s.stage === 'replication');
  assert.equal(step.codePreparations[0].status, 'completed');
  assert.equal(step.environmentPreparations[0].status, 'completed');
  assert.equal(f.state.session.executionPlan.execution.codePreparationId, undefined);
  assert.equal(f.state.session.executionPlan.execution.environmentId, undefined);
  assert.equal(f.state.session.executionPlanVersion, 1);
  assert.equal(step.materialPreparation, undefined); assert.equal(step.executionPlanBinding, undefined);
  assert.deepEqual(f.counts.models, ['research:code-preparation', 'research:environment_proposal']);
  assert.equal(f.counts.freeze, 1); assert.equal(f.counts.environment, 1);
});
