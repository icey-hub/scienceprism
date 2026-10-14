import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-plan-revision-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
const { datasetService } = await import('../src/services/datasets/index.js');
const { createWorkflowDocument } = await import('../src/services/researchWorkflow/stateMachine.js');
const { writeWorkflowFile } = await import('../src/services/researchWorkflow/repository.js');
const { getResearchWorkflow } = await import('../src/services/researchWorkflow/queries.js');
const { getIdeaPlan, saveIdeaPlan } = await import('../src/services/researchWorkflow/ideaPlans.js');
const { sourceHash } = await import('../src/services/researchAutomation/handoff.js');
const { mutateAutomation } = await import('../src/services/researchAutomation/policy.js');
const { experimentManifestHash } = await import('../src/services/experimentRunner/manifest.js');
const { createCampaignEvaluationService } = await import('../src/services/validationCampaign/agentEvaluation.js');
const { startAssistantRun } = await import('../src/services/assistantService.js');
const { createAutomationCoordinator, recordAutomationCoordinator, getHarnessRun, waitForHarnessRun, listHarnessRuns, createHarnessRun } = await import('../src/services/harnessRuntime/index.js');
const { saveNextIdeaPlan, startIdeaPlanAttempt, getIdeaPlanAttempts } = await import('../src/services/researchWorkflow/ideaPlanRevision.js');
const { generateNextIdeaPlan } = await import('../src/services/researchWorkflow/ideaPlanRevisionGeneration.js');
const { registerResearchWorkflowRoutes } = await import('../src/routes/researchWorkflow.js');
const { getAutomation, stopAutomation } = await import('../src/services/researchAutomation/index.js');
after(async () => { await datasetService.shutdown(); await fs.rm(data, { recursive: true, force: true }); });
async function fixture(projectId) {
  const root = path.join(data, projectId), directory = path.join(root, '.scienceprism'); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id: projectId }));
  await fs.writeFile(path.join(directory, 'project-constraints.json'), JSON.stringify({ contextTokenBudget: 200000, maxTokens: 250000 }));
  const { dataset } = await datasetService.importData(projectId, { bytes: Buffer.from('[1,2,3]'), filename: 'data.json' });
  const plan = { ideaId: 'idea', revision: 1, createdAt: '2026-10-14T00:00:00Z', actor: 'human', hypothesis: { problem: 'Coverage', prediction: 'Baseline improves', priorWork: 'Original related work', conditions: 'Same data', falsificationCondition: 'No improvement' },
    evaluation: { researchType: 'computational', dataset: dataset.id, datasetVersion: dataset.sha256, seed: '0', split: 'Fixed split', baselines: ['baseline'], metrics: [{ name: 'accuracy', direction: 'increase', threshold: .03 }], repetitions: 1, ablations: [], budget: { maxRuns: 2, maxSeconds: 60 } }, readiness: { ready: true, issues: [] }, evidence: null };
  const workflow = createWorkflowDocument(projectId); workflow.currentStage = 'writing'; workflow.status = 'completed';
  for (const stage of workflow.stages) { stage.status = 'approved'; if (['method', 'experiment', 'writing'].includes(stage.id)) stage.data = { original: `${stage.id} material`, task: { originalRunId: `${stage.id}-original` } }; }
  workflow.stages.find(stage => stage.id === 'ideation').data = { ideas: [{ id: 'idea', title: 'Coverage proposal', selected: true }], ideaPlans: { idea: [plan] } };
  await writeWorkflowFile(root, workflow);
  const base = { id: 'base', projectId, command: { adapter: 'node' }, code: {}, environment: {}, resources: {}, protocol: 'Frozen protocol', parameters: {} };
  const campaign = { id: 'batch', projectId, sessionId: 'old-session', ideaId: 'idea', planRevision: 1, planSha256: sourceHash(plan), plan, baseRunId: 'base', baseManifest: base,
    baseManifestSha256: experimentManifestHash(base), status: 'failed', error: { code: 'FIXTURE_MISSING', message: 'Negative and missing records remain' }, elapsedSeconds: 0, budget: { maxRuns: 2, maxSeconds: 60 },
    variants: [{ id: 'c', label: 'Candidate', kind: 'candidate', parameters: {} }, { id: 'b', label: 'baseline', kind: 'baseline', parameters: {} }], seeds: ['0'], trials: [
      { id: 'c0', runId: 'reserved-c', variantId: 'c', seed: '0', status: 'pending' }, { id: 'b0', runId: 'reserved-b', variantId: 'b', seed: '0', status: 'pending' }] };
  await fs.writeFile(path.join(directory, 'validation-campaigns.json'), JSON.stringify({ schemaVersion: 1, projectId, campaigns: [campaign] }));
  await mutateAutomation(projectId, state => { state.session = { id: 'old-session', workflowId: workflow.id, status: 'running', steps: [], stopRequested: false }; });
  const coordinator = await createAutomationCoordinator(projectId, 'old-session', workflow.id);
  await recordAutomationCoordinator(projectId, coordinator.id, { sessionId: 'old-session', status: 'completed' });
  await mutateAutomation(projectId, state => { state.session.status = 'completed'; state.session.coordinatorRunId = coordinator.id; });
  const evaluations = createCampaignEvaluationService({ startRun: (project, input, options) => startAssistantRun(project, input, { ...options, adapter: 'fake', fakeResponse: JSON.stringify({ verdict: 'insufficient', summary: 'All missing pairs remain insufficient', findings: [], limitations: ['Missing real trials'], nextPlanSuggestions: ['Add the missing controls', 'Expand coverage'] }) }) });
  const started = await evaluations.evaluate(projectId, 'batch', { requestId: 'fixture-evaluation' }); await waitForHarnessRun(projectId, started.evaluation.runId);
  await evaluations.evaluate(projectId, 'batch', { requestId: 'fixture-evaluation' });
  const input = { expectedVersion: workflow.version, expectedRevision: 1, campaignId: 'batch', evaluationRunId: started.evaluation.runId, suggestionIndexes: [0], idempotencyKey: 'next-version-request' };
  const proposal = { stage: 'hypothesis_plan', ideaId: 'idea', hypothesis: { ...plan.hypothesis, prediction: 'A controlled revision improves coverage' }, evaluation: plan.evaluation };
  return { projectId, root, directory, workflow, plan, campaign, coordinator, input, proposal };
}
test('manual source-bound version appends once; explicit next attempt archives downstream, preserves completed history and returns frontend stage', async () => {
  const f = await fixture('manual'); const input = { ...f.input, hypothesis: f.proposal.hypothesis, evaluation: f.proposal.evaluation };
  const before = await fs.readFile(path.join(f.directory, 'validation-campaigns.json'), 'utf8');
  const saved = await saveNextIdeaPlan(f.projectId, 'idea', input); assert.equal(saved.plan.revision, 2); assert.equal(saved.plan.actor, 'human');
  assert.equal((await getResearchWorkflow(f.projectId)).status, 'completed'); assert.deepEqual(saved.history[0], f.plan);
  assert.equal(saved.plan.revisionSource.evaluationRunId, f.input.evaluationRunId); assert.deepEqual(saved.plan.revisionSource.suggestions, ['Add the missing controls']);
  assert.equal((await saveNextIdeaPlan(f.projectId, 'idea', input)).plan.revision, 2);
  await assert.rejects(saveNextIdeaPlan(f.projectId, 'idea', { ...input, hypothesis: { ...input.hypothesis, prediction: 'Replace input' } }), e => e.code === 'IDEMPOTENCY_KEY_REUSED');
  await assert.rejects(saveIdeaPlan(f.projectId, 'idea', { expectedRevision: 2, hypothesis: f.proposal.hypothesis, evaluation: f.proposal.evaluation }), e => e.code === 'WORKFLOW_COMPLETED');
  const app = Fastify(); registerResearchWorkflowRoutes(app);
  try {
    const request = { expectedVersion: saved.workflowVersion, idempotencyKey: 'explicit-attempt' }, url = `/api/projects/${f.projectId}/research-workflow/ideas/idea/plan/2/next-attempt`;
    const response = await app.inject({ method: 'POST', url, headers: { 'x-scienceprism-actor': 'human' }, payload: request }); assert.equal(response.statusCode, 200);
    const result = response.json(); assert.equal(result.workflow.currentStage, 'method'); assert.equal(result.workflow.activePlanAttempt.id, result.attempt.id);
    assert.deepEqual(result.attempt.previousStages, f.workflow.stages.filter(stage => ['method', 'experiment', 'writing'].includes(stage.id)));
    assert.equal(result.attempt.previousAutomation.coordinatorRunId, f.coordinator.id);
    const retried = await app.inject({ method: 'POST', url, headers: { 'x-scienceprism-actor': 'human' }, payload: request }); assert.equal(retried.json().attempt.id, result.attempt.id);
    const raw = await getResearchWorkflow(f.projectId); assert.deepEqual(raw.stages.slice(0, 4), f.workflow.stages.slice(0, 4));
    assert.deepEqual(raw.stages.find(stage => stage.id === 'ideation').data.ideas, f.workflow.stages.find(stage => stage.id === 'ideation').data.ideas);
    assert.equal((await getIdeaPlan(f.projectId, 'idea')).history.length, 2); assert.equal((await getIdeaPlanAttempts(f.projectId, 'idea')).activeAttemptId, result.attempt.id);
    assert.equal(raw.stages.find(stage => stage.id === 'experiment').status, 'pending'); assert.equal(raw.stages.find(stage => stage.id === 'writing').status, 'pending');
  } finally { await app.close(); }
  assert.equal(await fs.readFile(path.join(f.directory, 'validation-campaigns.json'), 'utf8'), before);
  assert.equal((await listHarnessRuns(f.projectId)).length, 2, 'Only the old real fake coordinator and evaluator exist; next-attempt did not spawn');
});
test('AI next version uses actual empty-tool Harness and full source once; cold persistence gap reuses the completed producer', async () => {
  const f = await fixture('generation'); let crash = true;
  const rename = fs.rename.bind(fs); fs.rename = async (from, to) => {
    if (crash && String(to).endsWith('research-workflow.json')) { crash = false; throw Object.assign(new Error('Revision save interrupted'), { code: 'EIO' }); }
    return rename(from, to);
  };
  try { await assert.rejects(generateNextIdeaPlan(f.projectId, 'idea', f.input, { adapter: 'fake', fakeResponse: JSON.stringify(f.proposal) }), /Revision save interrupted/); }
  finally { fs.rename = rename; }
  const runs = await listHarnessRuns(f.projectId, { source: 'idea-plan-revision' }); assert.equal(runs.length, 1); assert.equal(runs[0].status, 'completed');
  assert.deepEqual(runs[0].capabilities.granted, []); assert.equal(runs[0].fallback, false); assert.equal(runs[0].contextPack.files.length, 0);
  assert.deepEqual(runs[0].request.input.validationCampaign.trials, f.campaign.trials); assert.equal(runs[0].request.input.validationCampaign.status, 'failed');
  assert.equal(runs[0].contextPack.instructions.prompt, runs[0].request.prompt);
  const saved = await generateNextIdeaPlan(f.projectId, 'idea', f.input, { adapter: 'fake', fakeResponse: 'Must not be called' });
  assert.equal(saved.plan.actor, 'ai'); assert.equal(saved.plan.sourceRunId, runs[0].id); assert.equal(saved.plan.revision, 2); assert.equal(saved.plan.readiness.ready, true);
  assert.equal(saved.plan.revisionSource.idempotencyKey, f.input.idempotencyKey); assert.equal((await generateNextIdeaPlan(f.projectId, 'idea', f.input)).plan.sourceRunId, runs[0].id);
  assert.equal((await getHarnessRun(f.projectId, runs[0].id)).attempt, 1); assert.equal((await listHarnessRuns(f.projectId, { source: 'idea-plan-revision' })).length, 1);
  await assert.rejects(createHarnessRun(f.projectId, { source: 'idea-plan-revision', adapter: 'fake', revisionIdentity: { forged: true } }), e => e.code === 'IDEA_PLAN_REVISION_ADMISSION_REQUIRED');
});
test('source/CAS/activity/explicit context caps fail without new generation or silently overwriting history', async () => {
  const f = await fixture('guards'); const manual = { ...f.input, hypothesis: f.proposal.hypothesis, evaluation: f.proposal.evaluation };
  await assert.rejects(saveNextIdeaPlan(f.projectId, 'idea', { ...manual, expectedVersion: 99 }), e => e.code === 'VERSION_CONFLICT');
  await assert.rejects(saveNextIdeaPlan(f.projectId, 'idea', { ...manual, expectedRevision: 99 }), e => e.code === 'IDEA_PLAN_CONFLICT');
  await assert.rejects(saveNextIdeaPlan(f.projectId, 'idea', { ...manual, source: 'forged' }), e => e.code === 'IDEA_PLAN_REVISION_INPUT_INVALID');
  await assert.rejects(saveNextIdeaPlan(f.projectId, 'idea', manual, { actor: 'ai' }), e => e.code === 'HUMAN_INPUT_REQUIRED');
  await assert.rejects(saveNextIdeaPlan(f.projectId, 'idea', { ...manual, suggestionIndexes: [19] }), e => e.code === 'IDEA_PLAN_REVISION_SOURCE_INVALID');
  await mutateAutomation(f.projectId, state => { state.session.status = 'running'; });
  await assert.rejects(generateNextIdeaPlan(f.projectId, 'idea', f.input, { adapter: 'fake', fakeResponse: JSON.stringify(f.proposal) }), e => e.code === 'IDEA_PLAN_ATTEMPT_ACTIVE');
  await mutateAutomation(f.projectId, state => { state.session.status = 'completed'; });
  await fs.writeFile(path.join(f.directory, 'project-constraints.json'), JSON.stringify({ contextTokenBudget: 256 }));
  await assert.rejects(generateNextIdeaPlan(f.projectId, 'idea', f.input, { adapter: 'fake', fakeResponse: JSON.stringify(f.proposal) }), e => e.code === 'WRITING_CAMPAIGN_CONTEXT_LIMIT');
  assert.equal((await listHarnessRuns(f.projectId, { source: 'idea-plan-revision' })).length, 0);
  assert.equal((await getIdeaPlan(f.projectId, 'idea')).history.length, 1);
  const other = await fixture('other-project');
  await assert.rejects(saveNextIdeaPlan(other.projectId, 'idea', { ...manual, evaluationRunId: f.input.evaluationRunId }), e => e.code === 'HARNESS_RUN_NOT_FOUND');
});

test('HTTP next attempt start binds both route fields to method/experiment, waits on disabled policy and never repeats that attempt', async () => {
  const f = await fixture('http-attempt');
  const saved = await saveNextIdeaPlan(f.projectId, 'idea', { ...f.input, hypothesis: f.proposal.hypothesis, evaluation: f.proposal.evaluation });
  const { attempt } = await startIdeaPlanAttempt(f.projectId, 'idea', 2, { expectedVersion: saved.workflowVersion, idempotencyKey: 'http-attempt-command' });
  const initialRuns = (await listHarnessRuns(f.projectId)).length;
  const app = Fastify(); registerResearchWorkflowRoutes(app);
  try {
    const url = `/api/projects/${f.projectId}/research-workflow/automation/start`;
    const input = { actor: 'human', targetStage: 'experiment', planAttemptId: attempt.id, validationCampaignDesign: { ideaId: 'idea', expectedPlanRevision: 2 } };
    const response = await app.inject({ method: 'POST', url, payload: input }); assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().session.steps.map(step => step.stage), ['method', 'experiment']);
    assert.equal(response.json().session.planAttempt.id, attempt.id); assert.equal(response.json().session.planAttempt.planSha256, attempt.planSha256);
    assert.deepEqual(response.json().session.validationCampaignDesign, input.validationCampaignDesign);
    let state;
    for (let i = 0; i < 100; i++) { state = await getAutomation(f.projectId); if (!['queued', 'running'].includes(state.session.status)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(state.session.status, 'waiting_confirmation', JSON.stringify(state.session.error));
    await stopAutomation(f.projectId, { actor: 'human', expectedSessionId: state.session.id });
    const stopped = await getAutomation(f.projectId); assert.equal(stopped.session.status, 'stopped');
    const runs = await listHarnessRuns(f.projectId); assert.equal(runs.length, initialRuns + 1);
    const coordinator = runs.find(run => run.id === state.session.coordinatorRunId); assert.equal(coordinator.kind, 'research-coordinator'); assert.equal(coordinator.attempt, 0);
    assert.ok(runs.every(run => run.kind === 'research-coordinator' || run.request.source === 'campaign-evaluation'));
    const repeated = await app.inject({ method: 'POST', url, payload: input }); assert.equal(repeated.statusCode, 409);
    assert.ok(['AUTOMATION_PLAN_ATTEMPT_BOUND', 'AUTOMATION_ACTIVE'].includes(repeated.json().error.code));
    assert.equal((await listHarnessRuns(f.projectId)).length, runs.length);
  } finally { await app.close(); }
});
