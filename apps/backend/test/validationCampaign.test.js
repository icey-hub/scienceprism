import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/validation-campaign-tests/', import.meta.url));
await fs.mkdir(cache, { recursive: true });
const data = await fs.mkdtemp(path.join(cache, 'projects-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
process.env.TMPDIR = data;
const { ensureValidationCampaign, executeValidationCampaign, getValidationCampaign, validateCampaignRequest } = await import('../src/services/validationCampaign/index.js');
const { createWorkflowDocument } = await import('../src/services/researchWorkflow/stateMachine.js');
const { writeWorkflowFile, readWorkflowFile } = await import('../src/services/researchWorkflow/repository.js');
const { saveIdeaPlan } = await import('../src/services/researchWorkflow/ideaPlans.js');
const { datasetService } = await import('../src/services/datasets/index.js');
const { createExperimentRun, getExperimentRun, retryExperimentRun, listExperimentRuns } = await import('../src/services/experimentRunner/index.js');
const { startAutomation, getAutomation } = await import('../src/services/researchAutomation/index.js');
const { listHarnessRuns } = await import('../src/services/harnessRuntime/index.js');
const { listValidationCampaigns } = await import('../src/services/validationCampaign/index.js');
after(async () => { await datasetService.shutdown(); await fs.rm(data, { recursive: true, force: true }); });
async function fixture(id, fail = false) {
  const root = path.join(data, id); await fs.mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: 'Controlled arithmetic integration, not a scientific finding' }));
  await fs.writeFile(path.join(root, '.scienceprism/project-constraints.json'), JSON.stringify({ capabilities: ['project.read', 'experiment.execute'], maxConcurrent: 1, allowedPaths: ['run.mjs', 'data', 'results'] }));
  await fs.writeFile(path.join(root, 'run.mjs'), `import {readFile,mkdir,writeFile} from 'node:fs/promises';
const input=JSON.parse(await readFile(process.env.SCIENCEPRISM_EXPERIMENT_INPUT,'utf8'));
const numbers=JSON.parse(await readFile(input.dataset.input.path,'utf8'));
await mkdir('results',{recursive:true});
if(input.parameters.fail) throw new Error('Actual deliberate arithmetic failure');
const mean=numbers.reduce((sum,value)=>sum+value,0)/numbers.length;
await writeFile('results/metrics.json',JSON.stringify({metrics:[{name:'scaled_mean',value:mean*input.parameters.scale}]}));
console.log(JSON.stringify({seed:input.seed,scale:input.parameters.scale}));`);
  const { dataset } = await datasetService.importData(id, { bytes: Buffer.from('[1,2,3]'), filename: 'numbers.json' });
  let workflow = createWorkflowDocument(id); workflow.currentStage = 'ideation';
  const ideation = workflow.stages.find(stage => stage.id === 'ideation'); ideation.status = 'in_progress'; ideation.data.ideas = [{ id: 'idea-scale', title: 'Controlled scaling', selected: true }];
  await writeWorkflowFile(root, workflow);
  const ideaPlan = { expectedRevision: 0, hypothesis: { problem: 'Controlled scaling', prediction: 'Scaling raises the measured mean', priorWork: 'Arithmetic baseline', conditions: 'Fixed three-number input', falsificationCondition: 'Mean does not scale' },
    evaluation: { researchType: 'computational', dataset: dataset.id, datasetVersion: dataset.sha256, seed: '0', split: 'All three fixed values', baselines: ['Scale baseline'], metrics: [{ name: 'scaled_mean', direction: 'increase', threshold: 3 }], repetitions: 1, ablations: [], budget: { maxRuns: 2, maxSeconds: 3 } } };
  await saveIdeaPlan(id, 'idea-scale', ideaPlan);
  workflow = await readWorkflowFile(root, id); workflow.currentStage = 'writing';
  const experiment = workflow.stages.find(stage => stage.id === 'experiment'); experiment.status = 'approved';
  experiment.data = { dataset: dataset.id, datasetVersion: dataset.sha256, protocol: 'Read the fixed input and measure actual scaled arithmetic mean.', execution: { adapter: 'node', entrypoint: 'run.mjs', args: [] },
    parameters: { scale: 2, fail }, seed: '0', codePaths: ['run.mjs'], resources: { timeoutMs: 1000 }, successCriteria: ['Report actual scaled_mean'], artifacts: [{ path: 'results/metrics.json', kind: 'metric' }] };
  await writeWorkflowFile(root, workflow);
  const base = await createExperimentRun(id, { sourceStage: 'experiment', expectedVersion: workflow.version });
  const automationFile = path.join(root, '.scienceprism/research-automation.json');
  const sessionId = `session-${id}`;
  const automation = { schemaVersion: 1, version: 1, policy: { enabled: true, overrides: {}, agentMode: 'specialists' },
    session: { id: sessionId, workflowId: workflow.id, status: 'running', stopRequested: false, currentStage: 'experiment', steps: [{ stage: 'experiment', experimentRunId: base.id }] }, audit: [] };
  await fs.writeFile(automationFile, JSON.stringify(automation));
  const input = { sessionId, ideaId: 'idea-scale', expectedPlanRevision: 1, baseRunId: base.id, seeds: ['0'], variants: [{ id: 'candidate', label: 'Candidate scaling', kind: 'candidate', parameters: { scale: 2 } }, { id: 'baseline', label: 'Scale baseline', kind: 'baseline', parameters: { scale: 1 } }] };
  return { id, root, input, base, automation, automationFile };
}

test('campaign reuses the real Runner for paired fixed-data arithmetic, stable IDs and completed recovery without rerunning', async () => {
  const f = await fixture('campaign-real'); const campaign = await ensureValidationCampaign(f.id, f.input);
  assert.equal(campaign.trials.length, 2); assert.equal((await ensureValidationCampaign(f.id, f.input)).id, campaign.id);
  let effects = 0; const finished = await executeValidationCampaign(f.id, campaign.id, { beforeEffect: async () => { effects++; } }).catch(async error => { const run = await getExperimentRun(f.id, campaign.trials[0].runId); throw new Error(JSON.stringify({ error: run.error, execution: run.execution, logs: run.logs }), { cause: error }); });
  assert.equal(finished.status, 'completed'); assert.ok(effects > 0);
  const values = [];
  for (const trial of finished.trials) {
    const run = await getExperimentRun(f.id, trial.runId); assert.equal(run.status, 'completed'); assert.equal(run.manifest.command.adapter, 'node');
    assert.equal(run.execution.process.stopConfirmed, true); assert.ok(run.artifacts.length > 0); assert.equal(run.manifest.campaign.campaignId, campaign.id);
    assert.equal(run.executionBinding.parentRunId, campaign.id); assert.equal(run.manifest.seed, '0');
    values.push(run.metrics.find(metric => metric.name === 'scaled_mean').value);
    assert.equal(trial.result.supportsSuccessfulFinding, false);
  }
  assert.deepEqual(values, [4, 2]); assert.equal((await getExperimentRun(f.id, f.base.id)).status, 'awaiting_approval');
  const count = (await listExperimentRuns(f.id)).length; await executeValidationCampaign(f.id, campaign.id);
  assert.equal((await listExperimentRuns(f.id)).length, count); assert.ok(finished.elapsedSeconds <= 3);
  await assert.rejects(ensureValidationCampaign(f.id, { ...f.input, seeds: ['1'] }), { code: 'VALIDATION_CAMPAIGN_CHANGED' });
  await assert.rejects(createExperimentRun(f.id, { campaign: { campaignId: campaign.id } }), { code: 'EXPERIMENT_CAMPAIGN_INTERNAL_ONLY' });
});

test('campaign stops on an actual nonzero process failure and does not retry terminal slots', async () => {
  const f = await fixture('campaign-failed', true), campaign = await ensureValidationCampaign(f.id, f.input);
  await assert.rejects(executeValidationCampaign(f.id, campaign.id), { code: 'VALIDATION_CAMPAIGN_FAILED' });
  const failed = await getValidationCampaign(f.id, campaign.id), run = await getExperimentRun(f.id, failed.trials[0].runId);
  assert.equal(failed.status, 'failed'); assert.equal(run.status, 'failed'); assert.ok(run.execution.exitCode > 0); assert.equal(run.execution.process.stopConfirmed, true);
  assert.equal(failed.trials[1].status, 'pending'); assert.ok(run.logs.stderr.includes('Actual deliberate arithmetic failure'));
  await assert.rejects(executeValidationCampaign(f.id, campaign.id), { code: 'VALIDATION_CAMPAIGN_FAILED' });
  await assert.rejects(retryExperimentRun(f.id, run.id), { code: 'EXPERIMENT_CAMPAIGN_INTERNAL_ONLY' });
  assert.equal((await listExperimentRuns(f.id)).length, 2);
});

test('campaign request and frozen plan reject missing controls, invalid parameters, stale revisions and revoked authorization', async () => {
  const f = await fixture('campaign-guards');
  assert.throws(() => validateCampaignRequest({ ...f.input }), { code: 'VALIDATION_CAMPAIGN_INPUT_INVALID' });
  await assert.rejects(ensureValidationCampaign(f.id, { ...f.input, variants: [f.input.variants[0]] }), { code: 'VALIDATION_CAMPAIGN_VARIANT_INVALID' });
  await assert.rejects(ensureValidationCampaign(f.id, { ...f.input, expectedPlanRevision: 2 }), { code: 'VALIDATION_CAMPAIGN_PLAN_NOT_READY' });
  const variants = structuredClone(f.input.variants); variants[1].label = 'Invented baseline';
  await assert.rejects(ensureValidationCampaign(f.id, { ...f.input, variants }), { code: 'VALIDATION_CAMPAIGN_GROUP_MISMATCH' });
  const campaign = await ensureValidationCampaign(f.id, f.input); f.automation.policy.enabled = false; await fs.writeFile(f.automationFile, JSON.stringify(f.automation));
  await assert.rejects(executeValidationCampaign(f.id, campaign.id), { code: 'AUTOMATION_CONFIRMATION_REQUIRED' });
  assert.equal((await listExperimentRuns(f.id)).length, 1);
});

test('AI condition design enters the original automation ledger and runs every fixed-data comparison', async () => {
  const f = await fixture('automatic-campaign');
  f.automation.session = null; await fs.writeFile(f.automationFile, JSON.stringify(f.automation));
  const input = { ideaId: f.input.ideaId, expectedPlanRevision: 1 };
  const output = { stage: 'validation_design', ideaId: input.ideaId, seeds: ['0'], variants: f.input.variants,
    implementationNotes: ['Existing code multiplies the measured input mean by the supplied scale, not a hardcoded result.'], blockers: [] };
  await startAutomation(f.id, { actor: 'human', targetStage: 'experiment', validationCampaignDesign: input },
    { adapter: 'fake', testInput: { validation_design: { fakeResponse: JSON.stringify(output) } } });
  let state;
  for (let i = 0; i < 300; i++) {
    state = await getAutomation(f.id);
    if (!['queued', 'running', 'stopping'].includes(state.session.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(state.session.status, 'completed', JSON.stringify(state.session.error));
  const design = state.session.steps[0].validationDesign;
  const producer = (await listHarnessRuns(f.id)).find(run => run.id === design.sourceRunId);
  assert.equal(producer.request.task, 'research:validation_design');
  assert.equal(producer.automationSessionId, state.session.id);
  const [campaign] = await listValidationCampaigns(f.id);
  assert.equal(campaign.sessionId, state.session.id); assert.equal(campaign.status, 'completed');
  assert.deepEqual(campaign.trials.map(row => row.result.metrics[0].value), [4, 2]);
  assert.equal(state.session.steps[0].result.validationCampaign.runIds.length, 2);
});
