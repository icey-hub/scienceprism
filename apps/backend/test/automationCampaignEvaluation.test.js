import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'automatic-campaign-evaluation-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
const { evaluateAutomationCampaign } = await import('../src/services/researchAutomation/campaignEvaluation.js');
const { createCampaignEvaluationService } = await import('../src/services/validationCampaign/agentEvaluation.js');
const { createAutomationStageHarness } = await import('../src/services/researchAutomation/stageHarness.js');
const { createWorkflowDocument } = await import('../src/services/researchWorkflow/stateMachine.js');
const { writeWorkflowFile } = await import('../src/services/researchWorkflow/repository.js');
const { readAutomation, mutateAutomation } = await import('../src/services/researchAutomation/policy.js');
const { buildAutomationHandoff, sourceHash } = await import('../src/services/researchAutomation/handoff.js');
const { createAutomationCoordinator, getHarnessRun, listHarnessRuns, cancelHarnessRun } = await import('../src/services/harnessRuntime/index.js');
const { readHarnessRuns, writeHarnessRuns } = await import('../src/services/harnessRuntime/repository.js');
after(() => fs.rm(data, { recursive: true, force: true }));
const output = { verdict: 'insufficient', summary: 'The failed and missing planned runs leave insufficient evidence.', findings: [{ text: 'Preserve this failed run.', runIds: ['actual-failed-trial'] }], limitations: ['Incomplete frozen seed set.'], nextPlanSuggestions: ['Review the failed execution before a separately approved campaign.'] };
async function fixture(id) {
  const root = path.join(data, id); await fs.mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id }));
  let workflow = createWorkflowDocument(id); workflow.currentStage = 'writing'; workflow.stages.find(s => s.id === 'experiment').status = 'approved';
  await writeWorkflowFile(root, workflow);
  await mutateAutomation(id, state => { state.policy.enabled = true; state.session = { id: `session-${id}`, workflowId: workflow.id, campaignEvaluationVersion: 1,
    status: 'running', stopRequested: false, attempt: 0, steps: [{ stage: 'experiment', status: 'completed', experimentRunId: 'base-run', campaignId: 'campaign-1', calls: [], runIds: [] }] }; });
  const coordinator = await createAutomationCoordinator(id, `session-${id}`, workflow.id);
  await mutateAutomation(id, state => { state.session.coordinatorRunId = coordinator.id; state.session.steps[0].handoff = buildAutomationHandoff({ projectId: id, workflow, session: state.session, stage: 'experiment', role: 'experiment-agent' }); });
  const campaign = { id: 'campaign-1', sessionId: `session-${id}`, ideaId: 'idea-1', planRevision: 2, planSha256: 'plan-hash', plan: { frozen: 'Whole original plan' },
    baseRunId: 'base-run', baseManifestSha256: 'base-hash', baseManifest: { protocol: 'Original protocol' }, variants: [{ id: 'candidate', kind: 'candidate' }], seeds: ['0', '1'],
    budget: { maxRuns: 2, maxSeconds: 60 }, elapsedSeconds: 4, status: 'failed', error: { code: 'EXPERIMENT_EXIT_NONZERO', message: 'Actual execution failed' },
    trials: [{ id: 'trial-1', runId: 'actual-failed-trial', status: 'failed' }, { id: 'trial-2', runId: 'missing-trial', status: 'pending' }],
    evaluation: { verdict: 'insufficient', rows: [{ seed: '0', dataStatus: 'run-failed' }, { seed: '1', dataStatus: 'missing-result' }], summaries: [] } };
  await fs.writeFile(path.join(root, '.scienceprism/experiment-runs.json'), JSON.stringify({ schemaVersion: 1, projectId: id, runs: [{ id: 'actual-failed-trial', projectId: id, status: 'failed', manifest: { campaign: { campaignId: campaign.id, trialId: 'trial-1' } } }] }));
  const service = () => createCampaignEvaluationService({ getCampaign: async () => structuredClone(campaign) });
  const saveStep = change => mutateAutomation(id, state => { Object.assign(state.session.steps[0], structuredClone(change)); });
  const invoke = async (overrides = {}) => evaluateAutomationCampaign({ projectId: id, session: (await readAutomation(id)).session,
    runtime: { adapter: 'fake', testInput: { campaign_evaluation: { fakeResponse: JSON.stringify(output) } } }, saveStep, evaluationService: service(), ...overrides });
  return { id, root, campaign, saveStep, invoke, service };
}
test('created-before-receipt Run survives cold reconciliation, freezes full negative/missing inputs, and completes only once', async () => {
  const f = await fixture('cold'); let failedSave = false;
  await assert.rejects(f.invoke({ saveStep: async change => {
    if (change.calls && !failedSave) { failedSave = true; throw new Error('Crash after original Run persistence'); }
    return f.saveStep(change);
  } }), /Crash after original Run persistence/);
  let runs = await listHarnessRuns(f.id, { source: 'campaign-evaluation' }); assert.equal(runs.length, 1); const id = runs[0].id;
  assert.equal(runs[0].status, 'created'); assert.equal((await readAutomation(f.id)).session.steps[0].calls.length, 0);
  const document = await readHarnessRuns(f.root, f.id); document.runs.find(r => r.id === id).runtimeInstanceId = 'prior-process'; await writeHarnessRuns(f.root, document);
  assert.equal((await getHarnessRun(f.id, id)).status, 'created');
  const receipt = await f.invoke(); assert.equal(receipt.runId, id); assert.equal(receipt.status, 'completed'); assert.deepEqual(receipt.output, output);
  const run = await getHarnessRun(f.id, id); const session = (await readAutomation(f.id)).session;
  assert.equal(run.parentRunId, session.coordinatorRunId); assert.equal(run.automationSessionId, session.id); assert.equal(run.kind, 'research-stage');
  assert.equal(run.role, 'campaign-evaluator'); assert.deepEqual(run.capabilities.granted, []); assert.equal(run.contextPack.files.length, 0);
  assert.deepEqual(run.request.evaluationSource.snapshot.trials, f.campaign.trials); assert.deepEqual(run.request.evaluationSource.snapshot.error, f.campaign.error);
  assert.deepEqual(run.request.evaluationSource.trialRunIds, ['actual-failed-trial']); assert.equal(run.contextPack.instructions.prompt, run.request.prompt);
  assert.equal(session.steps[0].calls.length, 1); assert.deepEqual(session.steps[0].runIds, [id]);
  const second = await f.invoke(); assert.equal(second.runId, id); assert.equal((await getHarnessRun(f.id, id)).attempt, 1);
  f.campaign.error.message = 'Changed source after the evaluation';
  await assert.rejects(f.invoke(), e => e.code === 'CAMPAIGN_EVALUATION_SOURCE_CHANGED');
  assert.equal((await listHarnessRuns(f.id, { source: 'campaign-evaluation' })).length, 1);
});
test('original evaluation cancellation is terminal and cold reuse cannot silently dispatch a second Run', async () => {
  const f = await fixture('cancel'); const controller = new AbortController(); let prepared;
  const started = new Promise(resolve => { prepared = resolve; });
  const pending = f.invoke({ runtime: { adapter: 'fake', signal: controller.signal, testInput: { campaign_evaluation: { fakeDelayMs: 500, fakeResponse: JSON.stringify(output) } } },
    saveStep: async change => { await f.saveStep(change); if (change.campaignEvaluation?.runId) prepared(change.campaignEvaluation.runId); } });
  const id = await started;
  await cancelHarnessRun(f.id, id, { automationSessionId: `session-${f.id}` });
  await assert.rejects(pending, e => e.code === 'AUTOMATION_CAMPAIGN_EVALUATION_FAILED');
  assert.equal((await getHarnessRun(f.id, id)).status, 'cancelled');
  await assert.rejects(f.invoke(), e => e.code === 'AUTOMATION_RUN_UNRESOLVED');
  assert.equal((await listHarnessRuns(f.id, { source: 'campaign-evaluation' })).length, 1);
});
test('old sessions remain model-free; live policy, coordinator, and frozen receipt changes reject before dispatch', async () => {
  const f = await fixture('guards');
  await mutateAutomation(f.id, state => { delete state.session.campaignEvaluationVersion; });
  assert.equal(await f.invoke(), null); assert.equal((await listHarnessRuns(f.id, { source: 'campaign-evaluation' })).length, 0);
  await mutateAutomation(f.id, state => { state.session.campaignEvaluationVersion = 1; state.policy.enabled = false; });
  await assert.rejects(f.invoke(), e => e.code === 'AUTOMATION_CONFIRMATION_REQUIRED');
  await mutateAutomation(f.id, state => { state.policy.enabled = true; state.session.steps[0].campaignEvaluation = { version: 1, campaignId: 'campaign-1', sourceSha256: sourceHash({ forged: true }) }; });
  await assert.rejects(f.invoke(), e => e.code === 'CAMPAIGN_EVALUATION_SOURCE_CHANGED');
  await mutateAutomation(f.id, state => { delete state.session.steps[0].campaignEvaluation; });
  const document = await readHarnessRuns(f.root, f.id); document.runs[0].request.input.workflowId = 'changed-workflow'; await writeHarnessRuns(f.root, document);
  await assert.rejects(f.invoke(), e => e.code === 'AUTOMATION_EVALUATION_OWNER_CHANGED');
  assert.equal((await listHarnessRuns(f.id, { source: 'campaign-evaluation' })).length, 0);
});
