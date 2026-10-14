import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/trial-runner-tests/', import.meta.url));
await fs.mkdir(cache, { recursive: true });
const data = await fs.mkdtemp(path.join(cache, 'projects-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
const runner = await import('../src/services/experimentRunner/index.js');
const { createTrialAuthorization, assertTrialExperiment, assertCompletedTrial } = await import('../src/services/experimentRunner/trialContext.js');
const { experimentManifestHash } = await import('../src/services/experimentRunner/manifest.js');
const { codePreparationService } = await import('../src/services/experimentRunner/codePreparations.js');
const { datasetService } = await import('../src/services/datasets/index.js');
const { createWorkflowDocument } = await import('../src/services/researchWorkflow/stateMachine.js');
const { writeWorkflowFile } = await import('../src/services/researchWorkflow/repository.js');
const { createCodeAuthorization } = await import('../src/services/researchAutomation/codeAuthorization.js');
const { buildAutomationHandoff, sourceHash } = await import('../src/services/researchAutomation/handoff.js');
const { getEvidenceLedger } = await import('../src/services/evidenceLedger/index.js');
after(async () => { await datasetService.shutdown(); await fs.rm(data, { recursive: true, force: true }); });

const code = `import fs from 'node:fs/promises';
const input=JSON.parse(await fs.readFile(process.env.SCIENCEPRISM_EXPERIMENT_INPUT,'utf8'));
const values=(await fs.readFile(input.dataset.input.path,'utf8')).trim().split(/\\s+/).map(Number);
await fs.mkdir('results',{recursive:true});
await fs.writeFile('results/metrics.json',JSON.stringify({metrics:[{name:'mean',value:values.reduce((a,b)=>a+b)/values.length}]}));`;

// Explicit completed producer/CLI provenance fixtures. They do not prove real
// model completion; actual OS Runner persistence, execution and archives do run.
async function fixture(id, { content = code } = {}) {
  const root = path.join(data, id), relative = 'generated/run.mjs';
  await fs.mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id }));
  await fs.writeFile(path.join(root, 'main.tex'), 'original manuscript');
  const constraints = { capabilities: ['project.read', 'patch.propose', 'experiment.execute'], allowedPaths: ['generated', 'data', 'results'], maxConcurrent: 1 };
  await fs.writeFile(path.join(root, '.scienceprism/project-constraints.json'), JSON.stringify(constraints));
  const workflow = createWorkflowDocument(id);
  workflow.currentStage = 'replication';
  workflow.stages.find(stage => stage.id === 'direction').data = { topic: 'fixed engineering protocol' };
  const { dataset } = await datasetService.importData(id, { bytes: Buffer.from('1\n3\n5\n'), filename: 'values.txt' });
  const base = { dataset: dataset.id, datasetVersion: dataset.sha256, protocol: 'Read fixed inputs once. Record their mean; this is engineering evidence only.',
    execution: { adapter: 'node', entrypoint: relative, args: [] }, parameters: {}, seed: 0, successCriteria: ['mean is recorded'],
    resources: { timeoutMs: 5000, maxArtifactBytes: 65536 }, artifacts: [{ path: 'results/metrics.json', kind: 'metric' }], codePaths: [] };
  workflow.stages.find(stage => stage.id === 'replication').data = { executionPlan: structuredClone(base) };
  const session = { id: `${id}-session`, projectId: id, workflowId: workflow.id, coordinatorRunId: `${id}-coordinator`,
    status: 'running', currentStage: 'replication', stopRequested: false, steps: [{ stage: 'replication', calls: [], codePreparations: [] }] };
  const policy = { enabled: true, agentMode: 'specialists', overrides: {}, codeScope: { allowedPaths: ['generated'], maxTokens: 10000, timeoutMs: 10000, maxVersions: 2 } };
  const state = { schemaVersion: 1, version: 1, policy, session, audit: [] };
  const step = session.steps[0];
  step.handoff = buildAutomationHandoff({ projectId: id, workflow, session, stage: 'replication', role: 'replication-specialist' });
  const input = { executionPlan: structuredClone(base), availableFiles: [], codePreparationVersion: 2 };
  const grant = createCodeAuthorization({ projectId: id, session, stage: 'replication', inputSha256: sourceHash(input), policyVersion: 1, policy });
  const patch = { path: relative, content, baseVersion: { exists: false, sha256: null }, deleted: false };
  const parent = { id: `${id}-producer`, projectId: id, kind: 'research-stage', adapter: 'deepseek', attempt: 1, status: 'completed',
    parentRunId: session.coordinatorRunId, automationSessionId: session.id, stage: 'replication', role: 'experiment-code-producer', task: 'research:code-preparation',
    patches: [patch], events: [], request: { input, context: { codeAuthorization: grant, automationHandoff: step.handoff } } };
  const child = { id: `${id}-worker`, projectId: id, kind: 'codex-worker', adapter: 'codex', status: 'completed', parentRunId: parent.id,
    parentAttempt: 1, recovery: { phase: 'handed-off' }, workerStorage: { stopConfirmed: true }, workerResult: { ok: true }, patches: [patch] };
  const coordinator = { id: session.coordinatorRunId, projectId: id, kind: 'research-coordinator', coordinatorSessionId: session.id, status: 'created', adapter: 'fake' };
  const ledger = { schemaVersion: 1, projectId: id, runs: [coordinator, parent, child] };
  await fs.writeFile(path.join(root, '.scienceprism/harness-runs.json'), JSON.stringify(ledger));
  const { preparation } = await codePreparationService.create(id, { sourceRunId: parent.id, paths: [relative] });
  step.calls.push({ runId: parent.id, task: parent.task });
  step.codePreparations.push({ authorization: grant, input, paths: [relative], producerRunId: parent.id,
    preparationId: preparation.id, sha256: preparation.sha256, status: 'completed' });
  const plan = { ...base, execution: { ...base.execution, codePreparationId: preparation.id }, codePaths: [relative] };
  await writeWorkflowFile(root, workflow);
  const saveState = () => fs.writeFile(path.join(root, '.scienceprism/research-automation.json'), JSON.stringify(state));
  await saveState();
  const authorization = await createTrialAuthorization(id, { sessionId: session.id, stage: 'replication', plan });
  const register = async () => { step.codeTrials = [{ authorization, plan: structuredClone(plan), runId: null, status: 'prepared' }]; await saveState(); };
  return { id, root, relative, workflow, state, session, step, plan, authorization, ledger, constraints, saveState, register };
}
async function created(f) { await f.register(); return runner.createTrialExperimentRun(f.id, { authorization: f.authorization, plan: f.plan }); }
async function approved(f) { const run = await created(f); return runner.automaticallyApproveExperiment(f.id, run.id, f.session.id); }
function controls(f, run, patch = {}) { return { wait: true, beforeLaunch: async () => {}, allowedPaths: f.authorization.allowedPaths,
  executionBinding: { parentRunId: f.session.coordinatorRunId, policyVersion: String(f.authorization.policyVersion), manifestSha256: experimentManifestHash(run.manifest) }, ...patch }; }

test('draft trials use an internal registered grant and recover the same persisted Runner identity', async () => {
  const f = await fixture('stable-trial');
  await assert.rejects(runner.createTrialExperimentRun(f.id, { authorization: f.authorization, plan: f.plan }), { code: 'EXPERIMENT_TRIAL_REGISTRATION_REQUIRED' });
  const first = await created(f), second = await runner.createTrialExperimentRun(f.id, { authorization: f.authorization, plan: f.plan });
  assert.equal(first.id, second.id); assert.equal(first.createdAt, second.createdAt);
  assert.equal((await runner.listExperimentRuns(f.id)).length, 1);
  assert.equal(first.manifest.purpose, 'engineering-trial');
  assert.deepEqual(first.manifest.trial.authorization.handoff, f.step.handoff);
  assert.equal(first.manifestSummary.purpose, 'engineering-trial');
  assert.equal(f.step.executionPlanBinding, undefined); assert.equal(f.session.executionPlan, undefined);
  f.state.version = 2; await f.saveState();
  assert.deepEqual(await createTrialAuthorization(f.id, { sessionId: f.session.id, stage: 'replication', plan: f.plan }), f.authorization);
});

test('ordinary create/approve/start/retry cannot forge or bypass an engineering trial', async () => {
  const f = await fixture('public-trial'), run = await approved(f);
  for (const input of [{ purpose: 'engineering-trial', plan: f.plan }, { plan: { ...f.plan, trial: run.manifest.trial } }, { authorization: f.authorization }]) {
    await assert.rejects(runner.createExperimentRun(f.id, input), { code: 'EXPERIMENT_TRIAL_INTERNAL_ONLY' });
  }
  await assert.rejects(runner.createExperimentRun(f.id, { sourceStage: 'replication', expectedVersion: f.workflow.version,
    plan: { execution: f.plan.execution } }), { code: 'REPLICATION_PLAN_NOT_APPROVED' });
  await assert.rejects(runner.decideExperimentRun(f.id, run.id, { decision: 'approve' }), { code: 'EXPERIMENT_TRIAL_INTERNAL_ONLY' });
  await assert.rejects(runner.startExperimentRun(f.id, run.id, { wait: true }), { code: 'EXPERIMENT_TRIAL_INTERNAL_ONLY' });
  await assert.rejects(runner.startExperimentRun(f.id, run.id, controls(f, run, { allowedPaths: [] })), { code: 'EXPERIMENT_TRIAL_INTERNAL_ONLY' });
  const wrong = controls(f, run); wrong.executionBinding.parentRunId = 'other-coordinator';
  await assert.rejects(runner.startExperimentRun(f.id, run.id, wrong), { code: 'EXPERIMENT_TRIAL_EXECUTION_OWNER_CHANGED' });
  await assert.rejects(runner.retryExperimentRun(f.id, run.id), { code: 'EXPERIMENT_TRIAL_INTERNAL_ONLY' });
  assert.equal((await runner.getExperimentRun(f.id, run.id)).status, 'approved');
});

test('actual engineering Runner executes fixed inputs, archives provenance and can never support a scientific finding', async () => {
  const f = await fixture('executed-trial'), run = await approved(f);
  const done = await runner.startExperimentRun(f.id, run.id, controls(f, run));
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.equal(done.metrics.find(metric => metric.name === 'mean').value, 3);
  assert.equal(done.execution.process.stopConfirmed, true);
  assert.throws(() => process.kill(done.execution.process.pid, 0), { code: 'ESRCH' });
  assert.ok(done.artifacts.some(item => item.name === `inputs/${f.relative}`));
  const manifest = JSON.parse(await fs.readFile(path.join(f.root, done.artifacts.find(item => item.name === 'manifest.json').path)));
  assert.equal(manifest.purpose, 'engineering-trial'); assert.deepEqual(manifest.trial.authorization, f.authorization);
  assert.equal(await fs.readFile(path.join(f.root, 'main.tex'), 'utf8'), 'original manuscript');
  await assert.rejects(fs.stat(path.join(f.root, f.relative)), { code: 'ENOENT' });
  const ledger = await getEvidenceLedger(f.id);
  assert.equal(ledger.entries.find(entry => entry.id === done.evidence.runId).metadata.purpose, 'engineering-trial');
  const confirmed = [done.evidence.runId, ...done.evidence.artifactIds].map(id => ({ id, verificationStatus: 'human-confirmed' }));
  const summary = runner.experimentRunSummary(done, confirmed);
  assert.equal(summary.evidenceConfirmed, true); assert.equal(summary.supportsSuccessfulFinding, false);
  assert.match(summary.verificationNote, /Engineering trial/);
  assert.equal((await runner.createTrialExperimentRun(f.id, { authorization: f.authorization, plan: f.plan })).id, done.id);
  assert.equal((await runner.listExperimentRuns(f.id)).length, 1);
  const { bindAutomationExecutionPlan } = await import('../src/services/researchAutomation/executionPlan.js');
  f.step.codeTrials[0] = { ...f.step.codeTrials[0], runId: done.id, status: 'completed', manifestSha256: experimentManifestHash(done.manifest) };
  Object.assign(f.session, bindAutomationExecutionPlan(f.session, 'replication', f.plan));
  await f.saveState();
  f.workflow.stages.find(stage => stage.id === 'replication').data.aiPlan = { objective: 'Formal planner now has a stopped engineering input.' };
  await writeWorkflowFile(f.root, f.workflow);
  assert.equal((await assertCompletedTrial(f.id, done, { sessionId: f.session.id, stage: 'replication', plan: f.plan })).id, done.id);
  await assert.rejects(runner.createTrialExperimentRun(f.id, { authorization: f.authorization, plan: f.plan }), { code: 'EXPERIMENT_TRIAL_OWNER_CHANGED' });
  f.session.steps[0].executionPlanBinding.sha256 = 'a'.repeat(64); await f.saveState();
  await assert.rejects(assertCompletedTrial(f.id, done, { sessionId: f.session.id, stage: 'replication', plan: f.plan }), { code: 'AUTOMATION_EXECUTION_PLAN_CHANGED' });
});

test('scientific draft changes and added code scope cannot be laundered into engineering execution', async () => {
  const f = await fixture('protocol-trial');
  for (const patch of [{ protocol: 'easier protocol' }, { seed: 1 }, { successCriteria: ['looser metric'] }, { resources: { timeoutMs: 9000 } }, { datasetVersion: 'different' }]) {
    await assert.rejects(createTrialAuthorization(f.id, { sessionId: f.session.id, stage: 'replication', plan: { ...f.plan, ...patch } }), { code: 'EXPERIMENT_TRIAL_PROTOCOL_CHANGED' });
  }
  await assert.rejects(createTrialAuthorization(f.id, { sessionId: f.session.id, stage: 'replication', plan: { ...f.plan, codePaths: [...f.plan.codePaths, 'main.tex'] } }), { code: 'EXPERIMENT_TRIAL_CODE_PATHS_CHANGED' });
});

test('saved stage or complete handoff source drift blocks approval before any process launch', async () => {
  for (const kind of ['draft', 'handoff']) {
    const f = await fixture(`${kind}-drift`), run = await created(f);
    if (kind === 'draft') f.workflow.stages.find(stage => stage.id === 'replication').data.executionPlan.seed = 99;
    else f.workflow.stages.find(stage => stage.id === 'direction').data.topic = 'changed source';
    await writeWorkflowFile(f.root, f.workflow);
    await assert.rejects(runner.automaticallyApproveExperiment(f.id, run.id, f.session.id), error => ['EXPERIMENT_TRIAL_AUTHORIZATION_CHANGED', 'AUTOMATION_HANDOFF_INPUT_CHANGED'].includes(error.code));
    assert.equal((await runner.getExperimentRun(f.id, run.id)).status, 'awaiting_approval');
  }
});

test('revoked execution/code permissions and producer changes block the original approved trial', async () => {
  for (const kind of ['execution', 'code', 'producer', 'scope', 'consumed']) {
    const f = await fixture(`${kind}-revoked`), run = await approved(f);
    if (kind === 'execution' || kind === 'code') { f.state.policy.overrides[kind] = 'manual'; f.state.version += 1; await f.saveState(); }
    else if (kind === 'producer') { f.ledger.runs[2].workerStorage.stopConfirmed = false; await fs.writeFile(path.join(f.root, '.scienceprism/harness-runs.json'), JSON.stringify(f.ledger)); }
    else if (kind === 'scope') { f.constraints.allowedPaths = ['generated', 'data']; await fs.writeFile(path.join(f.root, '.scienceprism/project-constraints.json'), JSON.stringify(f.constraints)); }
    else { f.step.executionPlanBinding = { version: 1 }; await f.saveState(); }
    await assert.rejects(runner.startExperimentRun(f.id, run.id, controls(f, run)), error => ['AUTOMATION_CONFIRMATION_REQUIRED', 'AUTOMATION_CODE_DISABLED', 'CODE_PREPARATION_CHILD_CHANGED', 'EXPERIMENT_TRIAL_SCOPE_DENIED', 'EXPERIMENT_TRIAL_OWNER_CHANGED'].includes(error.code));
    assert.equal((await runner.getExperimentRun(f.id, run.id)).status, 'approved');
  }
});

test('late revocation after workspace preparation is rechecked internally before spawn', async () => {
  const f = await fixture('late-trial'), run = await approved(f);
  let callbacks = 0;
  const done = await runner.startExperimentRun(f.id, run.id, controls(f, run, { beforeLaunch: async () => {
    callbacks += 1;
    if (callbacks === 1) { f.state.policy.overrides.execution = 'manual'; f.state.version += 1; await f.saveState(); }
  } }));
  assert.equal(done.status, 'failed'); assert.equal(done.execution.process.pid, null); assert.equal(done.execution.process.stopConfirmed, true);
  assert.equal(done.error.code, 'CODE_PREPARATION_AUTHORIZATION_REVOKED');
  assert.equal(done.manifest.purpose, 'engineering-trial');
});

test('a manifest scientific edit is rejected despite a newly supplied manifest hash', async () => {
  const f = await fixture('manifest-trial'), run = await approved(f);
  const file = path.join(f.root, '.scienceprism/experiment-runs.json');
  const doc = JSON.parse(await fs.readFile(file)); doc.runs[0].manifest.seed = '99';
  await fs.writeFile(file, JSON.stringify(doc));
  const changed = await runner.getExperimentRun(f.id, run.id);
  await assert.rejects(assertTrialExperiment(f.id, changed.manifest), { code: 'EXPERIMENT_TRIAL_MANIFEST_CHANGED' });
  await assert.rejects(runner.startExperimentRun(f.id, run.id, controls(f, changed)), { code: 'EXPERIMENT_TRIAL_MANIFEST_CHANGED' });
});

test('a failed actual engineering process retains logs and cannot use the ordinary retry entry', async () => {
  const f = await fixture('failed-trial', { content: "console.error('original engineering failure'); process.exit(7);" }), run = await approved(f);
  const done = await runner.startExperimentRun(f.id, run.id, controls(f, run));
  assert.equal(done.status, 'failed'); assert.equal(done.execution.exitCode, 7); assert.equal(done.execution.process.stopConfirmed, true);
  assert.match(done.logs.stderr, /original engineering failure/);
  assert.ok(done.artifacts.some(item => item.name === 'stderr.log'));
  assert.equal(runner.experimentRunSummary(done).supportsSuccessfulFinding, false);
  await assert.rejects(runner.retryExperimentRun(f.id, done.id), { code: 'EXPERIMENT_TRIAL_INTERNAL_ONLY' });
});

test('declared metric output must contain extractable metrics before trial completion', async () => {
  const f = await fixture('empty-metric-trial', { content: "import fs from 'node:fs/promises'; await fs.mkdir('results',{recursive:true}); await fs.writeFile('results/metrics.json','invalid json');" }), run = await approved(f);
  const done = await runner.startExperimentRun(f.id, run.id, controls(f, run));
  assert.equal(done.status, 'failed'); assert.equal(done.error.code, 'EXPERIMENT_TRIAL_METRICS_REQUIRED');
  assert.ok(done.artifacts.some(item => item.name === 'metrics.json')); assert.equal(done.execution.process.stopConfirmed, true);
});

test('the original parent AbortSignal cancels and archives the actual engineering process before return', async () => {
  const f = await fixture('cancelled-trial', { content: "console.log('engineering started'); await new Promise(resolve=>setTimeout(resolve,4000));" }), run = await approved(f);
  const controller = new AbortController();
  const promise = runner.startExperimentRun(f.id, run.id, controls(f, run, { signal: controller.signal }));
  let pid = null;
  for (let attempt = 0; attempt < 200 && !pid; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
    pid = (await runner.getExperimentRun(f.id, run.id)).execution?.process?.pid;
  }
  assert.ok(pid, 'The actual controlled process was started.');
  controller.abort(new Error('Original research coordinator stopped.'));
  const done = await promise;
  assert.equal(done.status, 'cancelled'); assert.equal(done.execution.process.stopConfirmed, true);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.ok(done.artifacts.some(item => item.name === 'manifest.json'));
  assert.equal((await runner.createTrialExperimentRun(f.id, { authorization: f.authorization, plan: f.plan })).id, done.id);
});

test('trial classification cannot be removed to gain the ordinary execution route', async () => {
  const f = await fixture('classification-trial'), run = await approved(f);
  const file = path.join(f.root, '.scienceprism/experiment-runs.json'), doc = JSON.parse(await fs.readFile(file));
  delete doc.runs[0].manifest.purpose; delete doc.runs[0].manifest.trial; await fs.writeFile(file, JSON.stringify(doc));
  const changed = await runner.getExperimentRun(f.id, run.id);
  await assert.rejects(runner.startExperimentRun(f.id, run.id), { code: 'EXPERIMENT_TRIAL_PROVENANCE_INVALID' });
  assert.equal(runner.experimentRunSummary({ ...changed, status: 'completed' }, [{ id: `experiment-run-${changed.id}`, verificationStatus: 'human-confirmed' }]).supportsSuccessfulFinding, false);
});
