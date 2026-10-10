import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const cacheDir = new URL('../../../.cache/writing-experiment-test/', import.meta.url);
await mkdir(cacheDir, { recursive: true });
const dataDir = await mkdtemp(path.join(cacheDir.pathname, 'data-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;
process.env.TMPDIR = dataDir;
process.env.NODE_ENV = 'test';

const { initializeResearchWorkflow, updateResearchWorkflow, approveResearchWorkflow } = await import('../src/services/researchWorkflow/commands.js');
const { getResearchWorkflow } = await import('../src/services/researchWorkflow/index.js');
const { runUiAction } = await import('../src/services/researchWorkflow/application.js');
const { createExperimentRun, decideExperimentRun, startExperimentRun, cancelExperimentRun } = await import('../src/services/experimentRunner/index.js');
const { upsertEvidence } = await import('../src/services/evidenceLedger/index.js');

async function sample(projectId, outcome) {
  const root = path.join(dataDir, projectId);
  await mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ id: projectId }));
  await writeFile(path.join(root, '.scienceprism/project-constraints.json'), JSON.stringify({ capabilities: ['project.read', 'experiment.execute'] }));
  await writeFile(path.join(root, 'run.mjs'), `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('results', { recursive: true });
writeFileSync('results/metrics.json', JSON.stringify({ metrics: [{ name: 'mean', value: (2 + 4 + 6) / 3 }] }));
if (process.argv.includes('--fail')) process.exit(1);
`);
  let workflow = await initializeResearchWorkflow(projectId, { data: { researchQuestion: 'Can the recorded mean be reproduced?' } });
  async function stage(stageId, data) {
    workflow = await updateResearchWorkflow(projectId, { stageId, data, expectedVersion: workflow.version, actor: 'human' });
    workflow = await approveResearchWorkflow(projectId, { stageId, expectedVersion: workflow.version, actor: 'human' });
  }
  await stage('direction', { researchQuestion: 'Can the recorded mean be reproduced?' });
  await stage('search', { queries: ['mean'] });
  await stage('selection', { selectedPaperIds: ['source'] });
  await stage('replication', { replication: { repository: 'local://reference', environment: 'Node CPU', dataset: 'reference-data', datasetVersion: 'v1', codeVersion: 'reference-v1', note: 'Recompute the reference mean.' } });
  const replication = await createExperimentRun(projectId, { sourceStage: 'replication', expectedVersion: workflow.version, plan: { execution: { adapter: 'node', entrypoint: 'run.mjs' }, artifacts: [{ path: 'results/metrics.json', kind: 'metric' }] } });
  await decideExperimentRun(projectId, replication.id, { decision: 'approve', actor: 'human' });
  await startExperimentRun(projectId, replication.id, { wait: true });
  await stage('ideation', { ideas: [{ id: 'idea-mean', selected: true }] });
  await stage('method', { method: { id: 'mean', title: 'Mean', hypothesis: 'Mean is four', baselines: ['reference'], metrics: ['mean'] } });
  await stage('experiment', { dataset: 'experiment-data', datasetVersion: 'v2', protocol: 'Compute the experiment mean.', methodId: 'mean', seed: 0, repetitions: 1, budget: 'CPU 1 second', successCriteria: ['mean equals 4'], execution: { adapter: 'node', entrypoint: 'run.mjs', args: outcome === 'failed' ? ['--fail'] : [] }, artifacts: [{ path: 'results/metrics.json', kind: 'metric' }] });
  let experiment = await createExperimentRun(projectId, { sourceStage: 'experiment', expectedVersion: workflow.version });
  await decideExperimentRun(projectId, experiment.id, { decision: 'approve', actor: 'human' });
  experiment = outcome === 'cancelled' ? await cancelExperimentRun(projectId, experiment.id) : await startExperimentRun(projectId, experiment.id, { wait: true });
  assert.equal(experiment.status, outcome);
  await upsertEvidence(projectId, { id: 'source', kind: 'paper', title: 'Arithmetic sample, not a scientific validation', verificationStatus: 'human-confirmed' }, { actor: 'human' });
  return { root, replication, experiment };
}

function handoff(overrides = {}) {
  return {
    action: 'handoff-writing', adapter: 'fake',
    fakeResponse: JSON.stringify({ stage: 'writing_brief', title: 'Arithmetic review', claims: [{ id: 'claim', text: 'The sample is review material.', evidenceIds: ['source'], confidence: 0.1 }], outline: ['Results'], limitations: ['Pending human verification.'], unsupportedClaims: [] }),
    experiment: { status: 'completed', dataset: 'forged', metrics: [{ name: 'mean', value: 999 }], resultRun: { id: 'forged' } },
    ...overrides
  };
}

for (const outcome of ['completed', 'failed', 'cancelled']) {
  test(`writing retains separate server-owned experiment and replication records for ${outcome} experiments`, async () => {
    const projectId = `writing-experiment-${outcome}`;
    const { root, replication, experiment } = await sample(projectId, outcome);
    for (const includeReplication of [false, true]) {
      const workflow = await runUiAction(projectId, handoff({ experimentRunId: experiment.id, ...(includeReplication ? { replicationRunId: replication.id } : {}) }), 'human');
      const writing = workflow.stages.find(stage => stage.id === 'writing').data;
      assert.equal(writing.task.input.experiment.resultRun.id, experiment.id);
      assert.equal(writing.task.input.experiment.status, outcome);
      assert.equal(writing.task.input.experiment.dataset, 'experiment-data');
      assert.deepEqual(writing.task.input.experiment.metrics, experiment.metrics);
      assert.equal(writing.task.input.experimentRun.id, experiment.id);
      assert.equal(writing.task.input.experimentRun.supportsSuccessfulFinding, false);
      assert.equal(writing.experimentRun.id, experiment.id);
      assert.equal(writing.task.input.replicationRun?.id, includeReplication ? replication.id : undefined);
      const artifact = await readFile(path.join(root, 'research/writing-brief.md'), 'utf8');
      assert.ok(artifact.includes('## Experiment Run Provenance'));
      assert.ok(artifact.includes(`Run ID: \`${experiment.id}\``));
      assert.ok(artifact.includes(`Status: \`${outcome}\``));
      assert.ok(artifact.includes('Supports successful finding: no'));
      assert.equal(artifact.includes(`Run ID: \`${replication.id}\``), includeReplication);
      assert.equal(artifact.includes('999'), false);
    }
  });
}

test('writing rejects missing, foreign, or replication Run IDs supplied as experiment results before changing workflow', async () => {
  const projectId = 'writing-experiment-invalid';
  const { replication } = await sample(projectId, 'completed');
  const other = await sample('writing-experiment-foreign', 'completed');
  const before = await getResearchWorkflow(projectId);
  for (const [experimentRunId, code] of [
    [42, 'INVALID_EXPERIMENT_RUN_ID'], [' ', 'INVALID_EXPERIMENT_RUN_ID'],
    ['missing', 'EXPERIMENT_RUN_NOT_FOUND'], [other.experiment.id, 'EXPERIMENT_RUN_NOT_FOUND'],
    [replication.id, 'EXPERIMENT_RUN_PROVENANCE_INVALID']
  ]) {
    await assert.rejects(() => runUiAction(projectId, handoff({ experimentRunId }), 'human'), { code });
    assert.deepEqual(await getResearchWorkflow(projectId), before);
  }
});
