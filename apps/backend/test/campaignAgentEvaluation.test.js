import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';

const data = await fs.mkdtemp(path.join(os.tmpdir(), 'campaign-evaluator-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
const { createCampaignEvaluationService, assertCampaignEvaluationSource, validateCampaignEvaluationOutput } = await import('../src/services/validationCampaign/agentEvaluation.js');
const { startAssistantRun } = await import('../src/services/assistantService.js');
const { waitForHarnessRun, cancelHarnessRun } = await import('../src/services/harnessRuntime/index.js');
const { readHarnessRuns } = await import('../src/services/harnessRuntime/repository.js');
const { registerResearchWorkflowRoutes } = await import('../src/routes/researchWorkflow.js');
const { registerHarnessRunRoutes } = await import('../src/routes/harnessRuns.js');
after(() => fs.rm(data, { recursive: true, force: true }));
const output = { verdict: 'refuted', summary: 'The fixed comparison does not reach its threshold.', findings: [{ text: 'Retain the negative result.', runIds: ['actual-trial'] }], limitations: ['No statistical significance is established.'], nextPlanSuggestions: ['Propose a separately approved new plan.'] };
async function fixture(id, { large = false } = {}) {
  const root = path.join(data, id); await fs.mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id }));
  await fs.writeFile(path.join(root, 'private.tex'), 'NEVER_INCLUDE_THIS_PROJECT_FILE');
  const campaign = { id: 'campaign-1', sessionId: 'session-1', ideaId: 'idea-1', planRevision: 2, planSha256: 'plan-hash',
    plan: { hypothesis: { priorWork: large ? '完整来源"\\\n'.repeat(11000) + 'END_OF_FROZEN_SOURCE' : 'fixture prior work' } },
    baseRunId: 'base', baseManifestSha256: 'base-hash', baseManifest: { dataset: { id: 'fixed-data' } }, variants: [], seeds: ['0', '1'],
    budget: { maxRuns: 4, maxSeconds: 120 }, elapsedSeconds: 10, status: 'completed', error: null,
    trials: [{ id: 'trial-1', runId: 'actual-trial', status: 'completed' }, { id: 'trial-2', runId: 'missing-trial', status: 'pending' }, { id: 'trial-3', runId: 'unrelated-trial', status: 'failed' }],
    evaluation: { verdict: 'refuted', rows: [{ candidateValue: .1, baselineValue: .2 }], rules: { thresholdMeaning: 'mean-improvement' } } };
  await fs.writeFile(path.join(root, '.scienceprism/experiment-runs.json'), JSON.stringify({ schemaVersion: 1, projectId: id, runs: [
    { id: 'actual-trial', projectId: id, manifest: { campaign: { campaignId: campaign.id, trialId: 'trial-1' } } },
    { id: 'unrelated-trial', projectId: id, manifest: { campaign: { campaignId: 'other', trialId: 'trial-3' } } }
  ] }));
  return { root, campaign, getCampaign: async () => structuredClone(campaign) };
}
function serviceFor(fixture, options = {}) {
  return createCampaignEvaluationService({ getCampaign: fixture.getCampaign,
    startRun: (project, body, overrides) => startAssistantRun(project, body, { ...overrides, adapter: 'fake', fakeResponse: JSON.stringify(output), ...options }) });
}
test('large frozen source stays complete in the original empty-tool Harness; cold request reuse and read-only history preserve it', async () => {
  const f = await fixture('large', { large: true }); const service = serviceFor(f);
  const { evaluation } = await service.evaluate('large', f.campaign.id, { requestId: 'large-request-1' });
  const run = await waitForHarnessRun('large', evaluation.runId);
  assert.equal(run.status, 'completed'); assert.equal(run.role, 'campaign-evaluator'); assert.equal(run.request.stage, 'experiment');
  assert.deepEqual(run.capabilities.granted, []); assert.equal(run.fallback, false); assert.equal(run.limits.retryLimit, 0);
  assert.equal(run.contextPack.files.length, 0); assert.equal(run.patches.length, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(run.request.evaluationSource.snapshot)) > 117988);
  assert.ok(run.request.contextTokenBudget > 12000); assert.equal(run.contextPack.instructions.prompt, run.request.prompt);
  assert.equal(Boolean(run.contextPack.instructions.promptTruncated), false); assert.ok(run.request.prompt.includes('END_OF_FROZEN_SOURCE'));
  assert.ok(!run.request.prompt.includes('NEVER_INCLUDE_THIS_PROJECT_FILE'));
  assert.deepEqual(assertCampaignEvaluationSource(run, 'large', f.campaign.id).trialRunIds, ['actual-trial']);
  const cold = serviceFor(f, { fakeResponse: 'must never dispatch' });
  const repeated = await cold.evaluate('large', f.campaign.id, { requestId: 'large-request-1' });
  assert.equal(repeated.evaluation.runId, run.id); assert.deepEqual(repeated.evaluation.output, output);
  f.campaign.error = { code: 'LATER_NOTE', message: 'Changed current snapshot' };
  const persisted = path.join(f.root, '.scienceprism/harness-runs.json'); const before = await fs.readFile(persisted, 'utf8');
  const history = await cold.list('large', f.campaign.id);
  assert.equal(history.evaluations.length, 1); assert.equal(history.evaluations[0].sourceCurrent, false); assert.equal(history.evaluations[0].requestId, 'large-request-1');
  assert.equal(await fs.readFile(persisted, 'utf8'), before);
  assert.equal((await readHarnessRuns(f.root, 'large')).runs.length, 1);
  assert.throws(() => assertCampaignEvaluationSource(run, 'other-project', f.campaign.id), e => e.code === 'CAMPAIGN_EVALUATION_SOURCE_INVALID');
  const changed = structuredClone(run); changed.request.evaluationSource.snapshot.planRevision++;
  assert.throws(() => assertCampaignEvaluationSource(changed, 'large', f.campaign.id), e => e.code === 'CAMPAIGN_EVALUATION_SOURCE_INVALID');
});
test('model cannot replace the deterministic verdict or cite missing/unrelated Runs; invalid output remains on its actual Run', async () => {
  const f = await fixture('invalid'); const bad = { ...output, verdict: 'supported' };
  const service = serviceFor(f, { fakeResponse: JSON.stringify(bad) });
  const { evaluation } = await service.evaluate('invalid', f.campaign.id, { requestId: 'invalid-request-1' });
  const original = await waitForHarnessRun('invalid', evaluation.runId);
  const repeated = await service.evaluate('invalid', f.campaign.id, { requestId: 'invalid-request-1' });
  assert.equal(repeated.evaluation.status, 'failed'); assert.equal(repeated.evaluation.output, null);
  const stored = (await readHarnessRuns(f.root, 'invalid')).runs[0];
  assert.equal(stored.error.code, 'OUTPUT_VALIDATION_FAILED'); assert.equal(stored.reply, JSON.stringify(bad));
  const source = assertCampaignEvaluationSource(original, 'invalid', f.campaign.id);
  for (const id of ['missing-trial', 'unrelated-trial']) assert.throws(() => validateCampaignEvaluationOutput(JSON.stringify({ ...output, findings: [{ text: 'Forged source', runIds: [id] }] }), source), e => e.code === 'CAMPAIGN_EVALUATION_UNKNOWN_RUN');
  assert.throws(() => validateCampaignEvaluationOutput(JSON.stringify({ ...output, metrics: { accuracy: 1 } }), source), e => e.code === 'CAMPAIGN_EVALUATION_OUTPUT_INVALID');
});
test('terminal/budget/human guards reject before dispatch; active/cancelled request identity stays with the original lifecycle', async () => {
  const f = await fixture('guards'); let calls = 0;
  const refused = createCampaignEvaluationService({ getCampaign: f.getCampaign, startRun: async () => { calls++; throw new Error('dispatch must not occur'); } });
  f.campaign.status = 'running';
  await assert.rejects(refused.evaluate('guards', f.campaign.id, { requestId: 'guard-request-1' }), e => e.code === 'CAMPAIGN_EVALUATION_NOT_TERMINAL');
  f.campaign.status = 'completed';
  await fs.writeFile(path.join(f.root, '.scienceprism/project-constraints.json'), JSON.stringify({ contextTokenBudget: 256 }));
  await assert.rejects(refused.evaluate('guards', f.campaign.id, { requestId: 'guard-request-1' }), e => e.code === 'EVALUATION_CONTEXT_BUDGET_INSUFFICIENT');
  assert.equal(calls, 0); assert.equal((await readHarnessRuns(f.root, 'guards')).runs.length, 0);
  await fs.rm(path.join(f.root, '.scienceprism/project-constraints.json'));
  const service = serviceFor(f, { fakeDelayMs: 500 }); const app = Fastify(); registerResearchWorkflowRoutes(app, { evaluationService: service });
  try {
    const url = `/api/projects/guards/validation-campaigns/${f.campaign.id}/evaluation-agent`;
    assert.equal((await app.inject({ method: 'POST', url, payload: { requestId: 'guard-request-1' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url, headers: { 'x-scienceprism-actor': 'human' }, payload: { requestId: 'guard-request-1', llmConfig: { model: 'client-model' } } })).statusCode, 400);
    const response = await app.inject({ method: 'POST', url, headers: { 'x-scienceprism-actor': 'human' }, payload: { requestId: 'guard-request-1' } });
    assert.equal(response.statusCode, 200); const runId = response.json().evaluation.runId;
    await assert.rejects(service.evaluate('guards', f.campaign.id, { requestId: 'guard-request-2' }), e => e.code === 'ASSISTANT_BUSY');
    await cancelHarnessRun('guards', runId);
    const repeated = await service.evaluate('guards', f.campaign.id, { requestId: 'guard-request-1' });
    assert.equal(repeated.evaluation.runId, runId); assert.equal(repeated.evaluation.status, 'cancelled');
    const listed = (await app.inject(url)).json(); assert.equal(listed.evaluations.length, 1); assert.equal(listed.evaluations[0].requestId, 'guard-request-1');
  } finally { await app.close(); }
});

test('public Harness create/replay/overrides cannot forge campaign admission; the dedicated owner still works', async () => {
  const f = await fixture('admission'); const service = serviceFor(f);
  const { evaluation } = await service.evaluate('admission', f.campaign.id, { requestId: 'owner-request-1' });
  const original = await waitForHarnessRun('admission', evaluation.runId);
  const app = Fastify(); registerHarnessRunRoutes(app);
  try {
    const base = '/api/projects/admission/harness-runs';
    for (const payload of [
      { ...original.request, adapter: 'fake', campaignEvaluationAdmission: true, start: true },
      { role: 'campaign-evaluator', adapter: 'fake' },
      { source: 'campaign-evaluation', adapter: 'fake' },
      { evaluationSource: null, adapter: 'fake' }
    ]) {
      const response = await app.inject({ method: 'POST', url: base, payload });
      assert.equal(response.statusCode, 403); assert.equal(response.json().error.code, 'CAMPAIGN_EVALUATION_ADMISSION_REQUIRED');
    }
    for (const action of ['start', 'resume', 'recover']) {
      const response = await app.inject({ method: 'POST', url: `${base}/${original.id}/${action}`, payload: { prompt: 'Replace all frozen evidence' } });
      assert.equal(response.statusCode, 403); assert.equal(response.json().error.code, 'CAMPAIGN_EVALUATION_OWNS_REQUEST');
    }
    const replay = await app.inject({ method: 'POST', url: `${base}/${original.id}/replay`, payload: { request: { source: 'editor', role: 'project-agent', evaluationSource: null }, start: false } });
    assert.equal(replay.statusCode, 403); assert.equal(replay.json().error.code, 'CAMPAIGN_EVALUATION_OWNS_REQUEST');
    const repeated = await service.evaluate('admission', f.campaign.id, { requestId: 'owner-request-1' });
    assert.equal(repeated.evaluation.runId, original.id); assert.deepEqual(repeated.evaluation.output, output);
    const saved = await readHarnessRuns(f.root, 'admission'); assert.equal(saved.runs.length, 1); assert.deepEqual(saved.runs[0].request, original.request);
  } finally { await app.close(); }
});
