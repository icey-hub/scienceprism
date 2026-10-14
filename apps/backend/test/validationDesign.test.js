import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/validation-design-tests/', import.meta.url));
await fs.mkdir(cache, { recursive: true }); const data = await fs.mkdtemp(path.join(cache, 'projects-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
const { prepareValidationDesign, validateValidationDesignInput } = await import('../src/services/researchAutomation/validationDesign.js');
const { createWorkflowDocument } = await import('../src/services/researchWorkflow/stateMachine.js');
const { writeWorkflowFile, readWorkflowFile } = await import('../src/services/researchWorkflow/repository.js');
const { saveIdeaPlan } = await import('../src/services/researchWorkflow/ideaPlans.js');
const { datasetService } = await import('../src/services/datasets/index.js');
const { createAutomationCoordinator, getHarnessRun, listHarnessRuns } = await import('../src/services/harnessRuntime/index.js');
after(async () => { await datasetService.shutdown(); await fs.rm(data, { recursive: true, force: true }); });
async function fixture(id) {
  const root = path.join(data, id); await fs.mkdir(root, { recursive: true }); await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id }));
  const { dataset } = await datasetService.importData(id, { bytes: Buffer.from('[1,2,3]'), filename: 'numbers.json' });
  const workflow = createWorkflowDocument(id); workflow.currentStage = 'ideation';
  const ideation = workflow.stages.find(stage => stage.id === 'ideation'); ideation.status = 'in_progress'; ideation.data.ideas = [{ id: 'selected-idea', title: 'Explicit control design', selected: true }];
  await writeWorkflowFile(root, workflow);
  const input = { expectedRevision: 0, hypothesis: { problem: 'Fixed input evaluation', prediction: 'Candidate exceeds baseline threshold', priorWork: 'Known original baseline', conditions: 'Same fixed split', falsificationCondition: 'Held-out result does not increase' },
    evaluation: { researchType: 'computational', dataset: dataset.id, datasetVersion: dataset.sha256, seed: '0', split: 'Same fixed split', baselines: ['Original baseline'],
      metrics: [{ name: 'accuracy', direction: 'increase', threshold: 0.9 }], repetitions: 1, ablations: ['Remove term'], budget: { maxRuns: 3, maxSeconds: 10 } } };
  const { plan } = await saveIdeaPlan(id, 'selected-idea', input);
  const file = path.join(root, '.scienceprism/research-automation.json'), policy = { enabled: true, overrides: {}, agentMode: 'specialists' };
  const session = { id: `session-${id}`, workflowId: workflow.id, status: 'running', stopRequested: false, attempt: 0, currentStage: 'experiment',
    validationCampaignDesign: { ideaId: 'selected-idea', expectedPlanRevision: 1 }, steps: [{ stage: 'experiment', status: 'pending', calls: [] }] };
  const persist = () => fs.writeFile(file, JSON.stringify({ schemaVersion: 1, version: 1, policy, session, audit: [] }));
  await persist(); const coordinator = await createAutomationCoordinator(id, session.id, workflow.id); session.coordinatorRunId = coordinator.id;
  const step = session.steps[0]; step.handoff = { projectId: id, sessionId: session.id, stage: 'experiment', parentRunId: coordinator.id, inputSha256: 'a'.repeat(64) }; await persist();
  const output = { stage: 'validation_design', ideaId: 'selected-idea', seeds: ['0'], variants: [{ id: 'candidate', label: 'Candidate', kind: 'candidate', parameters: { mode: 'candidate' } },
    { id: 'baseline', label: 'Original baseline', kind: 'baseline', parameters: { mode: 'baseline' } }, { id: 'ablation', label: 'Remove term', kind: 'ablation', parameters: { mode: 'ablation' } }],
    implementationNotes: ['Entrypoint must explicitly read mode and implement the candidate, original baseline and removal under the same fixed split; these labels alone do not prove implementation.'], blockers: [] };
  const args = { projectId: id, session, policy, runtime: { adapter: 'fake', testInput: { validation_design: { fakeResponse: JSON.stringify(output) } } }, beforeEffect: async () => {},
    saveStep: async value => { Object.assign(step, structuredClone(value)); await persist(); } };
  return { root, id, session, step, args, output, plan, input };
}

test('AI design binds actual original fake Harness Run, frozen I01 plan and concrete groups; normal material preparation and writing reuse it', async () => {
  const f = await fixture('design-original'), design = await prepareValidationDesign(f.args);
  assert.equal(design.planSha256, design.sourceInput.planSha256); assert.deepEqual(design.plan, f.plan); assert.deepEqual(design.sourceInput.plan, f.plan);
  assert.equal(design.variants.length, 3); const producer = await getHarnessRun(f.id, design.sourceRunId);
  assert.equal(producer.status, 'completed'); assert.equal(producer.request.task, 'research:validation_design'); assert.equal(producer.parentRunId, f.session.coordinatorRunId);
  assert.ok(f.step.calls.some(call => call.runId === producer.id)); const count = (await listHarnessRuns(f.id)).length;
  f.session.executionPlan = { dataset: f.plan.evaluation.dataset, datasetVersion: f.plan.evaluation.datasetVersion, execution: { adapter: 'python', entrypoint: 'generated/run.py', codePreparationId: `code-preparation-${'a'.repeat(64)}` } };
  const workflow = await readWorkflowFile(f.root, f.id); workflow.currentStage = 'writing'; workflow.stages.find(stage => stage.id === 'experiment').data.task = { status: 'completed' }; await writeWorkflowFile(f.root, workflow);
  const recovered = await prepareValidationDesign(f.args); assert.equal(recovered.sourceRunId, producer.id); assert.equal((await listHarnessRuns(f.id)).length, count);
  workflow.currentStage = 'ideation'; await writeWorkflowFile(f.root, workflow); await saveIdeaPlan(f.id, 'selected-idea', { ...f.input, expectedRevision: 1 });
  await assert.rejects(prepareValidationDesign(f.args), { code: 'VALIDATION_DESIGN_PLAN_CHANGED' });
});

test('completed producer is recovered after design receipt interruption without model re-dispatch or changed material input', async () => {
  const f = await fixture('design-save-gap'), save = f.args.saveStep; let interrupted = true;
  f.args.saveStep = async value => { if (value.validationDesign && interrupted) { interrupted = false; throw new Error('Controlled design save interruption'); } await save(value); };
  await assert.rejects(prepareValidationDesign(f.args), /Controlled design save interruption/);
  assert.equal(f.step.calls.length, 1); const runId = f.step.calls[0].runId; assert.equal((await getHarnessRun(f.id, runId)).status, 'completed');
  f.session.executionPlan = { newlyPrepared: 'Expected material enrichment' };
  const recovered = await prepareValidationDesign(f.args); assert.equal(recovered.sourceRunId, runId); assert.equal((await listHarnessRuns(f.id)).length, 2);
});

test('strict design validates complete group coverage, budget and explicit blockers without fabricating an executable campaign', async () => {
  assert.throws(() => validateValidationDesignInput({ ideaId: 'idea', expectedPlanRevision: 1, seeds: ['forged'] }), { code: 'VALIDATION_DESIGN_INPUT_INVALID' });
  const invalid = await fixture('design-invalid'); invalid.output.variants.pop(); invalid.args.runtime.testInput.validation_design.fakeResponse = JSON.stringify(invalid.output);
  await assert.rejects(prepareValidationDesign(invalid.args), { code: 'VALIDATION_DESIGN_GROUP_INVALID' }); assert.equal(invalid.step.validationDesign, undefined);
  const blocked = await fixture('design-blocked'); blocked.output.seeds = []; blocked.output.variants = []; blocked.output.blockers = ['The supplied materials do not yet establish executable parameter branches.'];
  blocked.args.runtime.testInput.validation_design.fakeResponse = JSON.stringify(blocked.output);
  const result = await prepareValidationDesign(blocked.args); assert.equal(result.blockers.length, 1); assert.equal(result.variants.length, 0); assert.equal((await getHarnessRun(blocked.id, result.sourceRunId)).status, 'completed');
});
