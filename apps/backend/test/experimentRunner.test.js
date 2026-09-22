import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-phase-eight-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;

const {
  compareExperimentRuns,
  createExperimentRun,
  cancelExperimentRun,
  decideExperimentRun,
  getExperimentRun,
  recordExperimentInterpretation,
  retryExperimentRun,
  startExperimentRun
} = await import('../src/services/experimentRunner/index.js');
const { getEvidenceLedger } = await import('../src/services/evidenceLedger/index.js');
const { listTasks } = await import('../src/services/projectHub/taskCenter.js');
const { registerExperimentRunRoutes } = await import('../src/routes/experimentRuns.js');

async function createProject(projectId, { execute = true } = {}) {
  const root = path.join(dataDir, projectId);
  await mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ id: projectId, name: 'Phase eight test' }));
  await writeFile(path.join(root, '.scienceprism', 'project-constraints.json'), JSON.stringify({ capabilities: execute ? ['project.read', 'experiment.execute'] : ['project.read'], maxConcurrent: 1 }));
  await writeFile(path.join(root, 'run.mjs'), `import { readFile, mkdir, writeFile } from 'node:fs/promises';\nconst input = JSON.parse(await readFile(process.env.SCIENCEPRISM_EXPERIMENT_INPUT, 'utf8'));\nif (input.parameters.waitMs) await new Promise((resolve) => setTimeout(resolve, Number(input.parameters.waitMs)));\nawait mkdir('results', { recursive: true });\nawait writeFile('results/metrics.json', JSON.stringify({ metrics: [{ name: 'accuracy', value: Number(input.parameters.accuracy) }] }));\nconsole.log(JSON.stringify({ runId: input.runId, seed: input.seed }));\n`);
  return root;
}

function plan(accuracy = 0.91) {
  return {
    planId: 'plan-1',
    dataset: { id: 'dataset-1', version: 'snapshot-2026-09-21' },
    protocol: 'Run the controlled evaluation once and emit results/metrics.json.',
    codeVersion: 'git:abc123',
    execution: { adapter: 'node', entrypoint: 'run.mjs', args: [] },
    parameters: { accuracy },
    seed: 7,
    successCriteria: ['accuracy is recorded'],
    artifacts: [{ path: 'results/metrics.json', kind: 'metric', name: 'metrics.json' }]
  };
}

test('Experiment Run requires approval and an explicit execution capability', async () => {
  const projectId = 'experiment-approval';
  await createProject(projectId, { execute: false });
  const run = await createExperimentRun(projectId, { plan: plan() });
  assert.equal(run.status, 'awaiting_approval');
  await assert.rejects(() => startExperimentRun(projectId, run.id, { wait: true }), (error) => error.code === 'EXPERIMENT_APPROVAL_REQUIRED');
  await decideExperimentRun(projectId, run.id, { decision: 'approve', actor: 'researcher' });
  await assert.rejects(() => startExperimentRun(projectId, run.id, { wait: true }), (error) => error.code === 'EXPERIMENT_EXECUTION_DENIED');
});

test('Experiment Run routes expose the approval and start Interface', async () => {
  const projectId = 'experiment-routes';
  await createProject(projectId);
  const app = Fastify();
  registerExperimentRunRoutes(app);
  const created = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/experiment-runs`, payload: { plan: plan(0.86) } });
  assert.equal(created.statusCode, 201);
  const runId = created.json().run.id;
  const approved = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/experiment-runs/${runId}/decision`, payload: { decision: 'approve', actor: 'researcher' } });
  assert.equal(approved.statusCode, 200);
  const started = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/experiment-runs/${runId}/start`, payload: { wait: true } });
  assert.equal(started.statusCode, 200);
  assert.equal(started.json().run.status, 'completed');
  await app.close();
});

test('approved Node Experiment Run archives reproducible artifacts and Evidence', async () => {
  const projectId = 'experiment-complete';
  await createProject(projectId);
  const created = await createExperimentRun(projectId, { plan: plan(0.91) });
  assert.equal(created.manifest.code.version, 'git:abc123');
  assert.equal(created.manifest.dataset.version, 'snapshot-2026-09-21');
  await decideExperimentRun(projectId, created.id, { decision: 'approve', actor: 'researcher', note: '批准本次受控运行。' });
  const completed = await startExperimentRun(projectId, created.id, { wait: true });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.metrics[0].name, 'accuracy');
  assert.equal(completed.metrics[0].value, 0.91);
  assert.ok(completed.artifacts.some((artifact) => artifact.kind === 'metric'));
  assert.ok(completed.evidence.runId);

  const ledger = await getEvidenceLedger(projectId);
  assert.ok(ledger.entries.some((entry) => entry.id === completed.evidence.runId && entry.kind === 'experiment-run'));
  assert.ok(ledger.entries.some((entry) => entry.kind === 'table' && entry.metadata.runId === completed.id));
  assert.ok(ledger.relations.some((relation) => relation.fromId === completed.evidence.runId && relation.type === 'produces'));

  const tasks = await listTasks(projectId, { kind: 'experiment-run' });
  assert.equal(tasks[0].status, 'completed');
  assert.equal(tasks[0].metadata.codeVersion, 'git:abc123');
});

test('Experiment Run refuses to execute when the recorded code snapshot has changed', async () => {
  const projectId = 'experiment-code-changed';
  const root = await createProject(projectId);
  const created = await createExperimentRun(projectId, { plan: plan(0.91) });
  await writeFile(path.join(root, 'run.mjs'), `import { mkdir, writeFile } from 'node:fs/promises';\nawait mkdir('results', { recursive: true });\nawait writeFile('results/metrics.json', JSON.stringify({ metrics: [{ name: 'accuracy', value: 0.01 }] }));\n`);
  await decideExperimentRun(projectId, created.id, { decision: 'approve' });

  const result = await startExperimentRun(projectId, created.id, { wait: true });

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'EXPERIMENT_CODE_CHANGED');
  assert.equal(result.metrics.length, 0);
});

test('Node Experiment Run cannot read host files outside its isolated workspace', async () => {
  const projectId = 'experiment-host-read-denied';
  const root = await createProject(projectId);
  await writeFile(path.join(root, 'host-read.mjs'), `import { readFile } from 'node:fs/promises';\nawait readFile('/etc/hosts', 'utf8');\nconsole.log('HOST_READ_ALLOWED');\n`);
  const created = await createExperimentRun(projectId, {
    plan: {
      ...plan(),
      execution: { adapter: 'node', entrypoint: 'host-read.mjs', args: [] },
      artifacts: []
    }
  });
  await decideExperimentRun(projectId, created.id, { decision: 'approve' });

  const result = await startExperimentRun(projectId, created.id, { wait: true });

  assert.equal(result.status, 'failed');
  assert.doesNotMatch(result.logs.stdout, /HOST_READ_ALLOWED/);
  assert.ok(['EXPERIMENT_EXIT_NONZERO', 'EXPERIMENT_SANDBOX_UNAVAILABLE'].includes(result.error?.code));
});

test('completed Experiment Runs can be compared without inventing metrics', async () => {
  const projectId = 'experiment-compare';
  await createProject(projectId);
  const first = await createExperimentRun(projectId, { plan: plan(0.8) });
  const second = await createExperimentRun(projectId, { plan: plan(0.95) });
  for (const run of [first, second]) {
    await decideExperimentRun(projectId, run.id, { decision: 'approve' });
    await startExperimentRun(projectId, run.id, { wait: true });
  }
  const comparison = await compareExperimentRuns(projectId, [first.id, second.id]);
  assert.deepEqual(comparison.metrics[0].values.map((item) => item.value), [0.8, 0.95]);
  assert.equal(comparison.metrics[0].deltaFromFirst[0].delta, 0.1499999999999999);
});

test('running Experiments can be cancelled, retried, and interpreted only from their Artifacts', async () => {
  const projectId = 'experiment-controls';
  await createProject(projectId);
  const slow = await createExperimentRun(projectId, { plan: { ...plan(0.7), parameters: { accuracy: 0.7, waitMs: 500 } } });
  await decideExperimentRun(projectId, slow.id, { decision: 'approve' });
  await startExperimentRun(projectId, slow.id);
  await cancelExperimentRun(projectId, slow.id);
  assert.equal((await getExperimentRun(projectId, slow.id)).status, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 100));

  const failed = await createExperimentRun(projectId, { plan: { ...plan(0.7), execution: { adapter: 'node', entrypoint: 'missing.mjs', args: [] } } });
  await decideExperimentRun(projectId, failed.id, { decision: 'approve' });
  const failedResult = await startExperimentRun(projectId, failed.id, { wait: true });
  assert.equal(failedResult.status, 'failed');
  await writeFile(path.join(dataDir, projectId, 'missing.mjs'), 'console.log("retry snapshot");\n');
  const retry = await retryExperimentRun(projectId, failed.id);
  assert.equal(retry.status, 'awaiting_approval');
  assert.equal(retry.retryOf, failed.id);
  assert.notEqual(retry.manifest.code.snapshotHash, failed.manifest.code.snapshotHash);

  const completed = await createExperimentRun(projectId, { plan: plan(0.88) });
  await decideExperimentRun(projectId, completed.id, { decision: 'approve' });
  const result = await startExperimentRun(projectId, completed.id, { wait: true });
  await assert.rejects(() => recordExperimentInterpretation(projectId, result.id, { summary: 'Wrong source', sourceArtifactIds: ['other-run-artifact'] }), (error) => error.code === 'INTERPRETATION_SOURCE_REQUIRED');
  const interpreted = await recordExperimentInterpretation(projectId, result.id, { summary: 'Accuracy was recorded by the controlled process.', sourceArtifactIds: [result.artifacts[0].id], metricFindings: [{ metric: 'accuracy', observation: 'A numeric value was persisted.' }] }, { actor: 'human' });
  assert.equal(interpreted.metrics[0].value, 0.88);
  assert.equal(interpreted.interpretation.sourceArtifactIds.length, 1);
});
