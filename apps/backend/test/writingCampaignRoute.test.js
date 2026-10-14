import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'writing-campaign-http-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
const { registerResearchWorkflowRoutes } = await import('../src/routes/researchWorkflow.js');
const { createWorkflowDocument } = await import('../src/services/researchWorkflow/stateMachine.js');
const { sourceHash } = await import('../src/services/researchAutomation/handoff.js');
const { experimentManifestHash } = await import('../src/services/experimentRunner/manifest.js');
const { readCampaignWritingHandoff } = await import('../src/services/researchWorkflow/campaignWritingHandoff.js');
const { getAutomation } = await import('../src/services/researchAutomation/index.js');
const { readHarnessRuns } = await import('../src/services/harnessRuntime/repository.js');
after(() => fs.rm(data, { recursive: true, force: true }));
test('HTTP writing selection survives session persistence and old ready content cannot bypass full-source preparation', async () => {
  const id = 'writing-http', root = path.join(data, id), directory = path.join(root, '.scienceprism');
  await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id }));
  const workflow = createWorkflowDocument(id); workflow.currentStage = 'writing'; workflow.status = 'in_progress';
  workflow.stages.find(stage => stage.id === 'experiment').status = 'approved';
  workflow.stages.find(stage => stage.id === 'experiment').data.automaticResult = { validationCampaign: { id: 'batch', runIds: ['reserved-c', 'reserved-b'] } };
  workflow.stages.find(stage => stage.id === 'writing').data.ready = true;
  await fs.writeFile(path.join(directory, 'research-workflow.json'), JSON.stringify(workflow));
  const plan = { ideaId: 'idea', revision: 1, evaluation: { metrics: [{ name: 'accuracy', direction: 'increase', threshold: .03 }] } };
  const base = { id: 'base', projectId: id, command: { adapter: 'node' }, code: {}, environment: {}, resources: {}, parameters: {}, protocol: 'Fixed scope' };
  const campaign = { projectId: id, id: 'batch', sessionId: 'previous-session', ideaId: 'idea', planRevision: 1, planSha256: sourceHash(plan), plan,
    baseRunId: 'base', baseManifest: base, baseManifestSha256: experimentManifestHash(base), status: 'failed', error: { code: 'FIXTURE_MISSING', message: 'No actual executions in this fixture' },
    variants: [{ id: 'c', label: 'Candidate', kind: 'candidate', parameters: {} }, { id: 'b', label: 'Baseline', kind: 'baseline', parameters: {} }], seeds: ['0'],
    budget: { maxRuns: 2, maxSeconds: 1 }, elapsedSeconds: 0, trials: [{ id: 'tc', runId: 'reserved-c', variantId: 'c', seed: '0', status: 'pending' }, { id: 'tb', runId: 'reserved-b', variantId: 'b', seed: '0', status: 'pending' }] };
  await fs.writeFile(path.join(directory, 'validation-campaigns.json'), JSON.stringify({ schemaVersion: 1, projectId: id, campaigns: [campaign] }));
  await fs.writeFile(path.join(directory, 'project-constraints.json'), JSON.stringify({ contextTokenBudget: 256 }));
  await fs.writeFile(path.join(directory, 'research-automation.json'), JSON.stringify({ schemaVersion: 1, version: 1, policy: { enabled: true, overrides: {}, agentMode: 'specialists' }, session: null, audit: [] }));
  const expected = await readCampaignWritingHandoff(id, 'batch'); const untouched = await fs.readFile(path.join(directory, 'validation-campaigns.json'), 'utf8');
  const app = Fastify(); registerResearchWorkflowRoutes(app);
  try {
    const url = `/api/projects/${id}/research-workflow/automation/start`;
    const missing = await app.inject({ method: 'POST', url, payload: { actor: 'human', targetStage: 'writing', writingCampaign: { campaignId: 'missing-batch' } } });
    assert.equal(missing.statusCode, 404); assert.equal(missing.json().error.code, 'VALIDATION_CAMPAIGN_NOT_FOUND');
    const forged = await app.inject({ method: 'POST', url, payload: { actor: 'human', targetStage: 'writing', writingCampaign: { campaignId: 'batch', sourceSha256: 'forged' } } });
    assert.equal(forged.statusCode, 400); assert.equal(forged.json().error.code, 'WRITING_CAMPAIGN_INPUT_INVALID');
    const response = await app.inject({ method: 'POST', url, payload: { actor: 'human', targetStage: 'writing', writingCampaign: { campaignId: 'batch' } } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().session.writingCampaignSource, { id: 'batch', actualExperimentRunIds: [], sourceSha256: expected.sourceSha256 });
    assert.deepEqual(response.json().session.steps.map(step => step.stage), ['writing']);
    let state;
    for (let i = 0; i < 100; i++) { state = await getAutomation(id); if (!['running', 'queued'].includes(state.session.status)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(state.session.status, 'blocked'); assert.equal(state.session.error.code, 'WRITING_CAMPAIGN_CONTEXT_LIMIT');
    assert.deepEqual(state.session.writingCampaignSource, response.json().session.writingCampaignSource);
    assert.equal(state.session.steps[0].handoff.inputArtifacts.find(source => source.stage === 'experiment').validationCampaignId, 'batch');
    const runs = (await readHarnessRuns(root, id)).runs;
    assert.equal(runs.length, 1); assert.equal(runs[0].kind, 'research-coordinator'); assert.equal(runs[0].attempt, 0);
    assert.equal(await fs.readFile(path.join(directory, 'validation-campaigns.json'), 'utf8'), untouched);
  } finally { await app.close(); }
});
