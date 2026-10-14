import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/campaign-figure-tests/', import.meta.url));
await fs.mkdir(cache, { recursive: true }); const data = await fs.mkdtemp(path.join(cache, 'projects-'));
process.env.SCIENCEPRISM_DATA_DIR = data; process.env.SCIENCEPRISM_FIGURE_PYTHON = process.execPath;
const { prepareCampaignFigureSource, createCampaignFigure, listCampaignFigures, validateCampaignFigureInput } = await import('../src/services/validationCampaign/figures.js');
const { registerResearchWorkflowRoutes } = await import('../src/routes/researchWorkflow.js');
const { sourceHash } = await import('../src/services/researchAutomation/handoff.js');
const { experimentManifestHash } = await import('../src/services/experimentRunner/manifest.js');
const { ExperimentRunnerError } = await import('../src/services/experimentRunner/errors.js');
after(async () => { await fs.rm(data, { recursive: true, force: true }); });
async function fixture(id) {
  // Explicit source and renderer receipt fixtures, not scientific execution or a real figure render.
  const root = path.join(data, id); await fs.mkdir(path.join(root, '.scienceprism'), { recursive: true }); await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id }));
  await fs.writeFile(path.join(root, '.scienceprism/project-constraints.json'), JSON.stringify({ capabilities: ['project.read', 'experiment.execute'] }));
  const plan = { ideaId: 'idea-source', revision: 1, evaluation: { metrics: [{ name: 'score', direction: 'increase', threshold: 0.03 }] } };
  const base = { code: { version: 'fixture-code', files: [], paths: [] }, dataset: { id: 'data-fixture', version: 'a'.repeat(64) }, environment: {}, command: { adapter: 'node', entrypoint: 'run.mjs', args: [] },
    protocol: 'Same declared metric and seeds', parameters: {}, resources: { timeoutMs: 1000 }, artifacts: [{ path: 'metric.json', kind: 'metric' }], successCriteria: ['Fixed comparison'] };
  const context = { projectId: id, sourceStage: 'experiment' }, campaign = { id: `campaign-${id}`, projectId: id, sessionId: 'session-fixture', ideaId: plan.ideaId, planRevision: 1, planSha256: sourceHash(plan), plan,
    baseRunId: 'base', baseManifest: base, baseManifestSha256: experimentManifestHash(base), researchContext: context, policyVersion: 1, seeds: ['0', '1'], variants: [
      { id: 'candidate', kind: 'candidate', label: '候选方法', parameters: { mode: 'candidate' } }, { id: 'baseline', kind: 'baseline', label: '原始基线', parameters: { mode: 'baseline' } }], trials: [] };
  const runs = [];
  for (const variant of campaign.variants) for (const seed of campaign.seeds) {
    const runId = `run-${variant.id}-${seed}`, trial = { id: `trial-${runId}`, runId, variantId: variant.id, seed, timeoutMs: 1000, status: 'completed' }; campaign.trials.push(trial);
    const manifest = { ...structuredClone(base), id: runId, projectId: id, parameters: variant.parameters, seed, researchPlan: context,
      campaign: { campaignId: campaign.id, trialId: trial.id, sessionId: campaign.sessionId, baseRunId: campaign.baseRunId, planSha256: campaign.planSha256, variantId: variant.id } };
    trial.manifestSha256 = experimentManifestHash(manifest);
    const metrics = [{ name: 'score', value: variant.id === 'candidate' ? seed === '0' ? 0.9 : 0.1 : 0.5, unit: null }], bytes = Buffer.from(JSON.stringify({ metrics }));
    const relative = `.scienceprism/experiment-runs/${runId}/artifacts/metric.json`; await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), bytes);
    runs.push({ id: runId, projectId: id, manifest, metrics, status: 'completed', execution: { exitCode: 0, process: { pid: 12345, stopConfirmed: true } },
      executionBinding: { parentRunId: campaign.id, policyVersion: '1', manifestSha256: trial.manifestSha256 }, artifacts: [{ id: `artifact-${runId}`, kind: 'metric', name: 'metric.json', path: relative, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }] });
  }
  const persist = async () => { await fs.writeFile(path.join(root, '.scienceprism/validation-campaigns.json'), JSON.stringify({ schemaVersion: 1, projectId: id, campaigns: [campaign] })); await fs.writeFile(path.join(root, '.scienceprism/experiment-runs.json'), JSON.stringify({ schemaVersion: 1, projectId: id, version: 1, runs })); };
  await persist(); return { root, id, campaign, runs, persist, input: { candidateVariantId: 'candidate', comparisonVariantId: 'baseline', metricName: 'score' } };
}
function rendererFixture(counter) {
  return async (manifest, options) => {
    counter.count++; assert.equal(manifest.command.entrypoint, 'renderer.py'); assert.deepEqual(manifest.command.args, ['source.json', 'style.json']);
    const source = JSON.parse(await fs.readFile(path.join(options.workspaceRoot, 'source.json'), 'utf8')); assert.equal(source.rows.length, 2); assert.ok(source.rows.some(row => row.delta < 0));
    await fs.writeFile(path.join(options.workspaceRoot, 'figure.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text>Fixture receipt</text><path d="M0 0 L1 1"/></svg>');
    await fs.writeFile(path.join(options.workspaceRoot, 'figure.pdf'), '%PDF-1.4\ncontrolled fixture'); await fs.writeFile(path.join(options.workspaceRoot, 'figure.png'), Buffer.from('controlled PNG receipt'));
    await fs.writeFile(path.join(options.workspaceRoot, 'runtime.json'), JSON.stringify({ pythonVersion: 'fixture', matplotlibVersion: 'fixture', font: { family: 'fixture-font' } }));
    await options.onProcess({ pid: 12345, stopConfirmed: true }); return { exitCode: 0, isolation: 'controlled-test-fixture' };
  };
}

test('fixed figure source includes every negative/positive paired seed and immutable source/style versions reuse existing files', async () => {
  const f = await fixture('figure-version'), counter = { count: 0 }, render = rendererFixture(counter);
  const source = await prepareCampaignFigureSource(f.id, f.campaign.id, f.input); assert.equal(source.statistics.n, 2); assert.equal(source.statistics.errorBars, 'none'); assert.equal(source.source.summary.verdict, 'refuted');
  assert.ok(source.source.rows.some(row => row.delta < 0)); const first = await createCampaignFigure(f.id, f.campaign.id, f.input, { render });
  assert.equal((await createCampaignFigure(f.id, f.campaign.id, f.input, { render })).id, first.id); assert.equal(counter.count, 1);
  const second = await createCampaignFigure(f.id, f.campaign.id, { ...f.input, style: { title: '用户标题', palette: 'grayscale' } }, { render });
  assert.notEqual(first.id, second.id); assert.equal(first.sourceSha256, second.sourceSha256); assert.notEqual(first.styleSha256, second.styleSha256);
  const figures = await listCampaignFigures(f.id, f.campaign.id); assert.equal(figures.length, 2); assert.ok(first.files.png.url.includes('/blob?path='));
  assert.equal(first.files.rendererSource.sha256, first.renderer.sha256); assert.ok(first.files.svg.bytes > 0);
  const app = Fastify(); registerResearchWorkflowRoutes(app); const response = await app.inject({ method: 'GET', url: `/api/projects/${f.id}/validation-campaigns/${f.campaign.id}/figures` });
  assert.equal(response.statusCode, 200); assert.equal(response.json().figures.length, 2); await app.close();
});

test('public input cannot replace values/code; missing pairs block export and isolated renderer errors retain actionable domain status', async () => {
  const f = await fixture('figure-guards'); assert.throws(() => validateCampaignFigureInput({ ...f.input, data: [9] }), { code: 'CAMPAIGN_FIGURE_INPUT_INVALID' });
  assert.throws(() => validateCampaignFigureInput({ ...f.input, style: { plotCode: 'unsafe' } }), { code: 'CAMPAIGN_FIGURE_STYLE_INVALID' });
  assert.throws(() => validateCampaignFigureInput({ ...f.input, style: { title: 'x'.repeat(121) } }), { code: 'CAMPAIGN_FIGURE_STYLE_INVALID' });
  await assert.rejects(createCampaignFigure(f.id, f.campaign.id, f.input, { render: async () => { throw new ExperimentRunnerError(503, 'EXPERIMENT_SANDBOX_UNAVAILABLE', 'Controlled isolation unavailable'); } }), { statusCode: 503, code: 'EXPERIMENT_SANDBOX_UNAVAILABLE' });
  assert.equal((await listCampaignFigures(f.id, f.campaign.id)).length, 0);
  f.runs.splice(1, 1); await f.persist(); await assert.rejects(prepareCampaignFigureSource(f.id, f.campaign.id, f.input), { code: 'CAMPAIGN_FIGURE_DATA_INCOMPLETE' });
});
