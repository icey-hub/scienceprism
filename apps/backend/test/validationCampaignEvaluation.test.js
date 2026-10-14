import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/campaign-evaluation-tests/', import.meta.url));
await fs.mkdir(cache, { recursive: true }); const data = await fs.mkdtemp(path.join(cache, 'projects-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
const { getValidationCampaign, listValidationCampaigns } = await import('../src/services/validationCampaign/index.js');
const { readValidationCampaignEvaluation } = await import('../src/services/validationCampaign/evaluation.js');
const { sourceHash } = await import('../src/services/researchAutomation/handoff.js');
const { experimentManifestHash } = await import('../src/services/experimentRunner/manifest.js');
after(async () => { await fs.rm(data, { recursive: true, force: true }); });
async function fixture(id) {
  // Explicit persisted Run/source fixtures and real archive bytes, not new scientific executions.
  const root = path.join(data, id); await fs.mkdir(path.join(root, '.scienceprism'), { recursive: true }); await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id }));
  const plan = { ideaId: 'idea-fixed', revision: 1, evaluation: { metrics: [{ name: 'score', direction: 'increase', threshold: 0.03 }, { name: 'loss', direction: 'decrease', threshold: 0.05 }, { name: 'target', direction: 'target', threshold: 0.5 }] } };
  const baseManifest = { code: { version: 'explicit-fixture', snapshotHash: 'c'.repeat(64), paths: ['run.mjs'], files: [] }, dataset: { id: 'dataset-fixed', version: 'a'.repeat(64) },
    environment: { runner: 'fixture-metadata' }, command: { adapter: 'node', entrypoint: 'run.mjs', args: [] }, parameters: {}, protocol: 'Fixed pairing and metric extraction', resources: { timeoutMs: 1000 }, artifacts: [{ path: 'results/metrics.json', kind: 'metric' }], successCriteria: ['Use the frozen metrics'] };
  const researchContext = { projectId: id, workflowId: 'workflow-fixture', sourceStage: 'experiment', stageStatus: 'approved', plan: { protocol: baseManifest.protocol } };
  const campaign = { id: `campaign-${id}`, projectId: id, sessionId: 'session-fixture', ideaId: plan.ideaId, planRevision: 1, planSha256: sourceHash(plan), plan,
    baseRunId: 'base-fixture', baseManifest, baseManifestSha256: experimentManifestHash(baseManifest), researchContext, policyVersion: 1, seeds: ['0', '1'], status: 'completed', variants: [
      { id: 'candidate', label: 'Candidate', kind: 'candidate', parameters: { mode: 'candidate' } }, { id: 'baseline', label: 'Baseline', kind: 'baseline', parameters: { mode: 'baseline' } },
      { id: 'ablation', label: 'Ablation', kind: 'ablation', parameters: { mode: 'ablation' } }], trials: [] };
  const runs = [];
  for (const variant of campaign.variants) for (const seed of campaign.seeds) {
    const runId = `run-${variant.id}-${seed}`, trial = { id: `trial-${runId}`, runId, variantId: variant.id, seed, timeoutMs: 1000, status: 'completed' };
    campaign.trials.push(trial);
    const values = variant.id === 'candidate' ? (seed === '0' ? [0.9, 0.3, 0.4] : [0.1, 0.5, 0.6]) : variant.id === 'baseline' ? [0.5, 0.6, 0.5] : [0.2, 0.6, 0.5];
    const metrics = ['score', 'loss', 'target'].map((name, index) => ({ name, value: values[index], unit: null }));
    const manifest = { ...structuredClone(baseManifest), id: runId, projectId: id, seed, parameters: variant.parameters, researchPlan: researchContext,
      campaign: { campaignId: campaign.id, trialId: trial.id, sessionId: campaign.sessionId, baseRunId: campaign.baseRunId, planSha256: campaign.planSha256, variantId: variant.id } };
    trial.manifestSha256 = experimentManifestHash(manifest);
    const relative = `.scienceprism/experiment-runs/${runId}/artifacts/results/metrics.json`, target = path.join(root, relative), bytes = Buffer.from(JSON.stringify({ metrics }));
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
    runs.push({ id: runId, projectId: id, status: 'completed', manifest, metrics, error: null, execution: { exitCode: 0, signal: null, process: { pid: 12345, stopConfirmed: true } },
      executionBinding: { parentRunId: campaign.id, policyVersion: '1', manifestSha256: trial.manifestSha256 },
      artifacts: [{ id: `artifact-${runId}`, name: 'metrics.json', kind: 'metric', path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] });
  }
  const runFile = path.join(root, '.scienceprism/experiment-runs.json'), campaignFile = path.join(root, '.scienceprism/validation-campaigns.json');
  const persist = async () => { await fs.writeFile(runFile, JSON.stringify({ schemaVersion: 1, projectId: id, version: 1, runs })); await fs.writeFile(campaignFile, JSON.stringify({ schemaVersion: 1, projectId: id, campaigns: [campaign] })); };
  await persist(); return { id, root, campaign, runs, runFile, persist };
}

test('evaluation keeps negative seeds, pairs every frozen seed and reports mean improvement/absolute targets without editing Runs', async () => {
  const f = await fixture('evaluation-paired'), original = await fs.readFile(f.runFile, 'utf8');
  const { evaluation } = await getValidationCampaign(f.id, f.campaign.id);
  assert.equal(evaluation.rows.length, 12); assert.equal(evaluation.summaries.length, 6); assert.equal(evaluation.verdict, 'refuted');
  const baseline = name => evaluation.summaries.find(item => item.comparisonKind === 'baseline' && item.metricName === name);
  assert.equal(baseline('score').verdict, 'refuted'); assert.equal(baseline('score').meanImprovement, 0); assert.equal(baseline('score').completeSeeds, 2);
  assert.equal(baseline('loss').verdict, 'supported'); assert.equal(baseline('target').verdict, 'supported'); assert.equal(baseline('target').candidateMean, 0.5);
  assert.deepEqual(evaluation.counts, { supported: 2, refuted: 1, insufficient: 0 });
  assert.ok(evaluation.rows.some(row => row.metricName === 'score' && row.delta < 0)); assert.ok(evaluation.rows.every(row => row.sourceArtifacts.length === 2));
  assert.equal(evaluation.ruleVersion, 'paired-frozen-metrics-v1'); assert.ok(evaluation.limitations.some(item => item.includes('统计显著性')));
  assert.deepEqual((await listValidationCampaigns(f.id))[0].evaluation, evaluation); assert.equal(await fs.readFile(f.runFile, 'utf8'), original);
});

test('one failed or missing seed yields insufficient evidence, retains observed failures and never substitutes ablation for baseline', async () => {
  const f = await fixture('evaluation-missing'); const failed = f.runs.find(run => run.id === 'run-baseline-1'); failed.status = 'failed'; failed.execution.exitCode = 1; failed.error = { code: 'EXPERIMENT_EXIT_NONZERO', message: 'Controlled source fixture failure' };
  await f.persist(); const evaluation = await readValidationCampaignEvaluation(f.id, f.campaign);
  assert.equal(evaluation.verdict, 'insufficient'); const summary = evaluation.summaries.find(item => item.metricName === 'score' && item.comparisonKind === 'baseline');
  assert.equal(summary.completeSeeds, 1); assert.equal(summary.candidateMean, null); assert.equal(summary.meanImprovement, null); assert.equal(summary.verdict, 'insufficient');
  const row = evaluation.rows.find(item => item.metricName === 'score' && item.comparisonKind === 'baseline' && item.seed === '1');
  assert.equal(row.comparisonStatus, 'failed'); assert.equal(row.comparisonValue, 0.5); assert.ok(row.issues.some(item => item.includes('failed')));
  assert.equal(evaluation.summaries.find(item => item.metricName === 'score' && item.comparisonKind === 'ablation').verdict, 'supported');
  f.runs.splice(f.runs.indexOf(failed), 1); await f.persist(); const missing = await readValidationCampaignEvaluation(f.id, f.campaign);
  assert.equal(missing.verdict, 'insufficient'); assert.ok(missing.rows.some(item => item.comparisonValue === null && item.comparisonStatus === 'missing' && item.comparisonRunId === null && item.dataStatus === 'insufficient'));
});

test('archive mutation, wrong ownership and frozen plan mutation are refused as evidence without changing the original source', async () => {
  const f = await fixture('evaluation-provenance'); const changed = f.runs[0];
  await fs.writeFile(path.join(f.root, changed.artifacts[0].path), Buffer.alloc(changed.artifacts[0].bytes, ' '));
  let evaluation = await readValidationCampaignEvaluation(f.id, f.campaign); assert.equal(evaluation.verdict, 'insufficient');
  assert.ok(evaluation.rows.some(item => item.issues.some(issue => issue.includes('SHA'))));
  const g = await fixture('evaluation-owner'); g.runs[0].executionBinding.parentRunId = 'another-campaign'; await g.persist();
  evaluation = await readValidationCampaignEvaluation(g.id, g.campaign); assert.equal(evaluation.verdict, 'insufficient'); assert.ok(evaluation.rows.some(item => item.issues.some(issue => issue.includes('执行绑定'))));
  const units = await fixture('evaluation-units');
  for (const run of units.runs.filter(item => item.manifest.seed === '1')) {
    for (const metric of run.metrics) metric.unit = 'cm';
    const bytes = Buffer.from(JSON.stringify({ metrics: run.metrics })), artifact = run.artifacts[0];
    await fs.writeFile(path.join(units.root, artifact.path), bytes); artifact.bytes = bytes.length; artifact.sha256 = createHash('sha256').update(bytes).digest('hex');
  }
  await units.persist(); evaluation = await readValidationCampaignEvaluation(units.id, units.campaign); assert.equal(evaluation.verdict, 'insufficient');
  assert.ok(evaluation.summaries.every(item => item.issues.some(issue => issue.includes('种子的指标单位'))));
  const ablation = await fixture('evaluation-ablation'); ablation.runs.splice(ablation.runs.findIndex(run => run.id === 'run-ablation-1'), 1); await ablation.persist();
  evaluation = await readValidationCampaignEvaluation(ablation.id, ablation.campaign); assert.equal(evaluation.counts.insufficient, 0); assert.equal(evaluation.verdict, 'insufficient');
  const h = await fixture('evaluation-plan'); h.campaign.plan.evaluation.metrics[0].threshold = -100;
  evaluation = await readValidationCampaignEvaluation(h.id, h.campaign); assert.equal(evaluation.verdict, 'insufficient'); assert.ok(evaluation.summaries.every(item => item.issues.some(issue => issue.includes('冻结方案'))));
});
