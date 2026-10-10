import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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
const { chooseIsolationStrategy, isOsSandboxApplicable, nodePermissionCommand } = await import('../src/services/experimentRunner/adapters.js');
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

async function approvedResearchPlan(projectId) {
  const { createWorkflowDocument } = await import('../src/services/researchWorkflow/stateMachine.js');
  const { writeWorkflowFile } = await import('../src/services/researchWorkflow/repository.js');
  const root = await createProject(projectId);
  const workflow = createWorkflowDocument(projectId);
  workflow.currentStage = 'writing';
  const stage = workflow.stages.find((item) => item.id === 'experiment');
  stage.status = 'approved';
  stage.data = { ...plan(), dataset: 'dataset-1', datasetVersion: 'snapshot-2026-09-21' };
  await writeWorkflowFile(root, workflow);
  return { root, workflow, savedPlan: stage.data };
}

test('research Experiment Runs bind approved inputs and refuse stale or different plans before saving', async () => {
  const projectId = 'research-plan-binding';
  const { workflow, savedPlan } = await approvedResearchPlan(projectId);
  const { listExperimentRuns } = await import('../src/services/experimentRunner/index.js');
  for (const patch of [
    { parameters: { accuracy: 99 } },
    { execution: { adapter: 'node', entrypoint: 'other.mjs', args: [] } },
    { datasetVersion: 'different' },
    { seed: 42 },
    { codePaths: ['run.mjs'] }
  ]) {
    await assert.rejects(createExperimentRun(projectId, { sourceStage: 'experiment', expectedVersion: workflow.version, plan: { ...savedPlan, ...patch } }), { code: 'EXPERIMENT_PLAN_MISMATCH' });
  }
  await assert.rejects(createExperimentRun(projectId, { sourceStage: 'experiment', expectedVersion: workflow.version + 1 }), { code: 'EXPERIMENT_PLAN_STALE' });
  await assert.rejects(createExperimentRun(projectId, { sourceStage: 'experiment' }), { code: 'EXPERIMENT_VERSION_REQUIRED' });
  assert.equal((await listExperimentRuns(projectId)).length, 0);
  const run = await createExperimentRun(projectId, { sourceStage: 'experiment', expectedVersion: workflow.version, plan: savedPlan });
  assert.equal(run.manifest.researchPlan.workflowId, workflow.id);
  assert.equal(run.manifest.researchPlan.projectId, projectId);
  assert.deepEqual(run.manifest.parameters, savedPlan.parameters);
  await assert.rejects(startExperimentRun(projectId, run.id), { code: 'EXPERIMENT_APPROVAL_REQUIRED' });
  await decideExperimentRun(projectId, run.id, { decision: 'approve' });
  const completed = await startExperimentRun(projectId, run.id, { wait: true });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.metrics[0].value, 0.91);
});

test('research Experiment Runs cannot start after plan drift or workflow reset', async () => {
  const { writeWorkflowFile } = await import('../src/services/researchWorkflow/repository.js');
  const { applyReset } = await import('../src/services/researchWorkflow/stateMachine.js');
  for (const change of ['parameters', 'reset']) {
    const projectId = `research-plan-${change}`;
    const { root, workflow } = await approvedResearchPlan(projectId);
    const run = await createExperimentRun(projectId, { sourceStage: 'experiment', expectedVersion: workflow.version });
    await decideExperimentRun(projectId, run.id, { decision: 'approve' });
    if (change === 'reset') await writeWorkflowFile(root, applyReset(workflow));
    else {
      workflow.stages.find((item) => item.id === 'experiment').data.parameters.accuracy = 99;
      workflow.version += 1;
      await writeWorkflowFile(root, workflow);
    }
    await assert.rejects(startExperimentRun(projectId, run.id), { code: change === 'reset' ? 'EXPERIMENT_PLAN_NOT_APPROVED' : 'EXPERIMENT_PLAN_CHANGED' });
    assert.equal((await getExperimentRun(projectId, run.id)).status, 'approved');
  }
});

test('Experiment Run requires approval and an explicit execution capability', async () => {
  const projectId = 'experiment-approval';
  await createProject(projectId, { execute: false });
  const run = await createExperimentRun(projectId, { plan: plan() });
  assert.equal(run.status, 'awaiting_approval');
  await assert.rejects(() => startExperimentRun(projectId, run.id, { wait: true }), (error) => error.code === 'EXPERIMENT_APPROVAL_REQUIRED');
  await decideExperimentRun(projectId, run.id, { decision: 'approve', actor: 'researcher' });
  await assert.rejects(() => startExperimentRun(projectId, run.id, { wait: true }), (error) => error.code === 'EXPERIMENT_EXECUTION_DENIED');
});

test('Python Adapter accepts only project Python files and fails closed without a configured runtime', async () => {
  const projectId = 'experiment-python-runtime';
  const root = await createProject(projectId);
  await writeFile(path.join(root, 'run.py'), 'print("python experiment")\n');
  await assert.rejects(() => createExperimentRun(projectId, { plan: { ...plan(), execution: { adapter: 'python', entrypoint: 'run.mjs', args: [] } } }),
    (error) => error.code === 'INVALID_EXECUTION_ENTRYPOINT');
  const previous = process.env.SCIENCEPRISM_EXPERIMENT_PYTHON;
  delete process.env.SCIENCEPRISM_EXPERIMENT_PYTHON;
  try {
    const run = await createExperimentRun(projectId, { plan: { ...plan(), execution: { adapter: 'python', entrypoint: 'run.py', args: [] }, artifacts: [] } });
    await decideExperimentRun(projectId, run.id, { decision: 'approve' });
    const result = await startExperimentRun(projectId, run.id, { wait: true });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'PYTHON_RUNTIME_UNAVAILABLE');
  } finally {
    if (previous === undefined) delete process.env.SCIENCEPRISM_EXPERIMENT_PYTHON;
    else process.env.SCIENCEPRISM_EXPERIMENT_PYTHON = previous;
  }
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
  assert.equal(completed.evidence.runId, `experiment-run-${completed.id}`);
  assert.equal(completed.manifest.code.snapshotHash, created.manifest.code.snapshotHash);

  const ledger = await getEvidenceLedger(projectId);
  assert.ok(ledger.entries.some((entry) => entry.id === completed.evidence.runId && entry.kind === 'experiment-run'));
  assert.ok(ledger.entries.some((entry) => entry.kind === 'table' && entry.metadata.runId === completed.id));
  assert.ok(ledger.relations.some((relation) => relation.fromId === completed.evidence.runId && relation.type === 'produces'));
  const runEvidence = ledger.entries.find((entry) => entry.id === completed.evidence.runId);
  assert.equal(runEvidence.version, completed.manifest.code.snapshotHash);
  assert.deepEqual(runEvidence.metadata.dataset, completed.manifest.dataset);
  for (const artifact of completed.artifacts) {
    const evidenceId = `experiment-artifact-${completed.id}-${artifact.id.split('-').at(-1)}`;
    assert.ok(completed.evidence.artifactIds.includes(evidenceId));
    const entry = ledger.entries.find((item) => item.id === evidenceId);
    assert.equal(entry.version, artifact.sha256);
    assert.equal(entry.sha256, artifact.sha256);
    assert.equal(entry.sourcePath, artifact.path);
    assert.equal(entry.metadata.artifactId, artifact.id);
    assert.ok(ledger.relations.some((relation) => relation.type === 'produces' && relation.fromId === runEvidence.id && relation.toId === evidenceId));
  }
  assert.deepEqual(await getEvidenceLedger(projectId), ledger, 'reading the projection must not rewrite the Ledger');

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
  const cancelled = await cancelExperimentRun(projectId, slow.id);
  assert.ok(cancelled.execution?.finishedAt, 'Cancellation returns after the process and archive have settled.');
  assert.ok(cancelled.artifacts.some(artifact => artifact.name === 'manifest.json'));
  assert.equal(cancelled.error.code, 'EXPERIMENT_CANCELLED');
  assert.equal((await getExperimentRun(projectId, slow.id)).status, 'cancelled');

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

test('cancelling a process that ignores SIGTERM waits for termination and keeps its output', async () => {
  const { runNodeExperiment } = await import('../src/services/experimentRunner/adapters.js');
  const projectId = 'experiment-stubborn-cancel';
  const root = await createProject(projectId);
  await writeFile(path.join(root, 'stubborn.mjs'), 'process.on("SIGTERM", () => {});\nconsole.log("READY_FOR_CANCEL");\nsetTimeout(() => {}, 4000);\n');
  const run = await createExperimentRun(projectId, { plan: { ...plan(0.7), execution: { adapter: 'node', entrypoint: 'stubborn.mjs' } } });
  const controller = new AbortController();
  const started = Date.now();
  const result = await runNodeExperiment(run.manifest, { workspaceRoot: root, inputPath: path.join(root, 'input.json'), signal: controller.signal, onOutput: ({ text }) => { if (text.includes('READY_FOR_CANCEL')) controller.abort(); } });
  assert.equal(result.signal, 'SIGKILL');
  assert.match(result.stdout, /READY_FOR_CANCEL/);
  assert.ok(Date.now() - started < 3500, 'Ignored SIGTERM must be followed by bounded forced termination.');
});

test('timed out Experiments stop an uncooperative process before archiving its available logs', async () => {
  const projectId = 'experiment-stubborn-timeout';
  const root = await createProject(projectId);
  await writeFile(path.join(root, 'stubborn.mjs'), 'process.on("SIGTERM", () => {});\nconsole.log("TIMEOUT_OUTPUT");\nsetTimeout(() => {}, 5000);\n');
  const run = await createExperimentRun(projectId, { plan: { ...plan(0.7), resources: { timeoutMs: 1000 }, execution: { adapter: 'node', entrypoint: 'stubborn.mjs' } } });
  await decideExperimentRun(projectId, run.id, { decision: 'approve' });
  const started = Date.now();
  const result = await startExperimentRun(projectId, run.id, { wait: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'EXPERIMENT_TIMEOUT');
  assert.equal(result.execution.signal, 'SIGKILL');
  assert.match(result.logs.stdout, /TIMEOUT_OUTPUT/);
  assert.ok(Date.now() - started < 3500);
  assert.equal((await getEvidenceLedger(projectId)).entries.find(entry => entry.id === result.evidence.runId).verificationStatus, 'unverified');
});

test('output-limit failures stop execution and preserve logs emitted before the limit', async () => {
  const projectId = 'experiment-output-limit';
  const root = await createProject(projectId);
  await writeFile(path.join(root, 'flood.mjs'), 'console.log("OUTPUT_BEFORE_LIMIT");\nsetTimeout(() => console.log("x".repeat(2048)), 50);\nsetTimeout(() => {}, 5000);\n');
  const run = await createExperimentRun(projectId, { plan: { ...plan(0.7), resources: { maxOutputBytes: 1024 }, execution: { adapter: 'node', entrypoint: 'flood.mjs' } } });
  await decideExperimentRun(projectId, run.id, { decision: 'approve' });
  const result = await startExperimentRun(projectId, run.id, { wait: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'OUTPUT_LIMIT_EXCEEDED');
  assert.match(result.logs.stdout, /OUTPUT_BEFORE_LIMIT/);
});

test('Experiment Runner reports whether an OS sandbox is applicable', async () => {
  const applicability = await isOsSandboxApplicable();
  assert.equal(typeof applicability.ok, 'boolean');
  if (!applicability.ok) assert.equal(typeof applicability.reason, 'string');
});

test('isolation strategy selection prefers the OS sandbox and falls back to the permission model', () => {
  assert.equal(
    chooseIsolationStrategy({ platform: 'darwin', osSandboxApplicable: true, nodePermissionSupported: true }),
    'macos-sandbox-exec'
  );
  assert.equal(
    chooseIsolationStrategy({ platform: 'darwin', osSandboxApplicable: false, nodePermissionSupported: true }),
    'node-permission'
  );
  assert.equal(
    chooseIsolationStrategy({ platform: 'linux', osSandboxApplicable: false, nodePermissionSupported: true }),
    'node-permission'
  );
  assert.equal(
    chooseIsolationStrategy({ platform: 'darwin', osSandboxApplicable: false, nodePermissionSupported: false }),
    null
  );
  assert.equal(
    chooseIsolationStrategy({ platform: 'linux', osSandboxApplicable: false, nodePermissionSupported: false }),
    null
  );
});

test('a completed Experiment Run records which isolation strategy executed it', async () => {
  const projectId = 'experiment-isolation-record';
  await createProject(projectId);
  const created = await createExperimentRun(projectId, { plan: plan(0.77) });
  await decideExperimentRun(projectId, created.id, { decision: 'approve' });
  const completed = await startExperimentRun(projectId, created.id, { wait: true });

  assert.equal(completed.status, 'completed');
  assert.ok(
    ['macos-sandbox-exec', 'node-permission'].includes(completed.execution.isolation),
    `unexpected isolation strategy: ${String(completed.execution.isolation)}`
  );
});

test('the Node permission model fallback permits workspace writes and denies host reads', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-isolation-'));

  async function runWithFallback(entrypoint) {
    const command = await nodePermissionCommand(workspace, entrypoint, []);
    assert.equal(command.isolation, 'node-permission');
    assert.ok(command.args.includes('--permission'));
    assert.ok(command.args.some((argument) => argument.startsWith('--allow-fs-read=')));
    assert.ok(command.args.some((argument) => argument.startsWith('--allow-fs-write=')));
    return new Promise((resolve, reject) => {
      const child = spawn(command.executable, command.args, { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
    });
  }

  const writer = path.join(workspace, 'write.mjs');
  await writeFile(writer, "import { mkdir, writeFile } from 'node:fs/promises';\nawait mkdir('results', { recursive: true });\nawait writeFile('results/ok.txt', 'ok');\nconsole.log('WROTE_OK');\n");
  const wrote = await runWithFallback(writer);
  assert.equal(wrote.exitCode, 0, wrote.stderr);
  assert.match(wrote.stdout, /WROTE_OK/);
  assert.equal(await readFile(path.join(workspace, 'results', 'ok.txt'), 'utf8'), 'ok');

  const reader = path.join(workspace, 'read.mjs');
  await writeFile(reader, "import { readFile } from 'node:fs/promises';\nawait readFile('/etc/hosts', 'utf8');\nconsole.log('HOST_READ_ALLOWED');\n");
  const denied = await runWithFallback(reader);
  assert.notEqual(denied.exitCode, 0);
  assert.doesNotMatch(denied.stdout, /HOST_READ_ALLOWED/);
  assert.match(denied.stderr, /ERR_ACCESS_DENIED/);
});


test('Experiment Run approval requires an explicit human decision and rejects automated actors without changing the Run', async () => {
  const projectId = 'experiment-human-decision';
  await createProject(projectId);
  const run = await createExperimentRun(projectId, { plan: plan() });
  const original = await getExperimentRun(projectId, run.id);
  for (const actor of ['ai', 'system', 'experiment-runner', 'unknown']) {
    await assert.rejects(decideExperimentRun(projectId, run.id, { decision: 'approve', actor }), { code: 'HUMAN_APPROVAL_REQUIRED' });
    assert.deepEqual(await getExperimentRun(projectId, run.id), original);
  }
  const app = Fastify();
  registerExperimentRunRoutes(app);
  try {
    for (const [payload, code] of [
      [{ decision: 'approve' }, 'ACTOR_REQUIRED'],
      [{ decision: 'approve', actor: 'ai' }, 'HUMAN_APPROVAL_REQUIRED'],
      [{ actor: 'human' }, 'INVALID_EXPERIMENT_DECISION']
    ]) {
      const response = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/experiment-runs/${run.id}/decision`, payload });
      assert.ok(response.statusCode >= 400);
      assert.equal(response.json().error.code, code);
      assert.deepEqual(await getExperimentRun(projectId, run.id), original);
    }
    const approved = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/experiment-runs/${run.id}/decision`, payload: { decision: 'approve' }, headers: { 'x-scienceprism-actor': 'human' } });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().run.approval.actor, 'human');
  } finally { await app.close(); }
});


test('new Experiment Runs cannot reuse declared output files from the project as newly produced metrics', async () => {
  const projectId = 'experiment-stale-output';
  const root = await createProject(projectId);
  await mkdir(path.join(root, 'results'), { recursive: true });
  const stale = JSON.stringify({ metrics: [{ name: 'accuracy', value: 0.999 }] });
  await writeFile(path.join(root, 'results/metrics.json'), stale);
  await writeFile(path.join(root, 'run.mjs'), 'console.log("No new metrics produced.");');
  const run = await createExperimentRun(projectId, { plan: plan() });
  await decideExperimentRun(projectId, run.id, { decision: 'approve' });
  const result = await startExperimentRun(projectId, run.id, { wait: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'ARTIFACT_MISSING');
  assert.deepEqual(result.metrics, []);
  assert.ok(result.artifacts.some(artifact => artifact.name === 'stdout.log'));
  assert.ok(result.artifacts.some(artifact => artifact.name === 'manifest.json'));
  assert.equal(await readFile(path.join(root, 'results/metrics.json'), 'utf8'), stale);
  const ledger = await getEvidenceLedger(projectId);
  assert.equal(ledger.entries.find(entry => entry.id === result.evidence.runId).verificationStatus, 'unverified');
});


test('a missing declared artifact keeps the new Run logs and other produced metrics available for review', async () => {
  const projectId = 'experiment-partial-artifacts';
  await createProject(projectId);
  const run = await createExperimentRun(projectId, { plan: { ...plan(0.8), artifacts: [...plan().artifacts, { path: 'results/missing.txt', kind: 'output' }] } });
  await decideExperimentRun(projectId, run.id, { decision: 'approve' });
  const result = await startExperimentRun(projectId, run.id, { wait: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'ARTIFACT_MISSING');
  assert.equal(result.metrics[0].value, 0.8);
  assert.ok(result.artifacts.some(artifact => artifact.name === 'stdout.log'));
  assert.ok(result.artifacts.some(artifact => artifact.name === 'metrics.json'));
  const ledger = await getEvidenceLedger(projectId);
  assert.equal(ledger.entries.find(entry => entry.id === result.evidence.runId).verificationStatus, 'unverified');
});

test('a persisted running experiment without a live executor becomes a retryable interruption', async () => {
  const projectId = 'experiment-crash-recovery';
  const root = await createProject(projectId);
  const run = await createExperimentRun(projectId, { plan: plan(0.8) });
  const { readExperimentRuns, writeExperimentRuns } = await import('../src/services/experimentRunner/repository.js');
  const document = await readExperimentRuns(root, projectId);
  document.runs[0].status = 'running';
  document.runs[0].logs = { stdout: 'LOG_BEFORE_CRASH', stderr: '' };
  await writeExperimentRuns(root, document);
  const recovered = await getExperimentRun(projectId, run.id);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.error.code, 'EXPERIMENT_INTERRUPTED');
  assert.equal(recovered.error.retryable, true);
  assert.match(recovered.logs.stdout, /LOG_BEFORE_CRASH/);
  assert.ok(recovered.execution.finishedAt);
  assert.equal((await retryExperimentRun(projectId, run.id)).retryOf, run.id);
});

test('server shutdown stops active experiments, archives logs, and never records a human cancellation', async () => {
  const { shutdownExperimentRuns } = await import('../src/services/experimentRunner/index.js');
  const { readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const projectId = 'experiment-graceful-restart';
  const root = await createProject(projectId);
  await writeFile(path.join(root, 'run.mjs'), 'import{writeFile}from"node:fs/promises";console.log("SHUTDOWN_OUTPUT");await writeFile("shutdown-ready.txt","ready");setTimeout(() => {}, 4000);');
  const run = await createExperimentRun(projectId, { plan: { ...plan(), artifacts: [] } });
  await decideExperimentRun(projectId, run.id, { decision: 'approve' });
  try {
    await startExperimentRun(projectId, run.id);
    const deadline = Date.now() + 10_000;
    while (true) {
      let launched = false;
      for (const entry of await readdir(tmpdir())) {
        if (!entry.startsWith('scienceprism-experiment-')) continue;
        const workspace = path.join(tmpdir(), entry, 'workspace');
        try {
          const input = JSON.parse(await readFile(path.join(workspace, '.scienceprism-experiment-input.json'), 'utf8'));
          if (input.runId === run.id && await readFile(path.join(workspace, 'shutdown-ready.txt'), 'utf8') === 'ready') launched = true;
        } catch {}
      }
      if (launched) break;
      assert.ok(Date.now() < deadline, 'The actual child must launch before shutdown.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await shutdownExperimentRuns();
    const stopped = await getExperimentRun(projectId, run.id);
    assert.equal(stopped.status, 'failed');
    assert.equal(stopped.error.code, 'EXPERIMENT_INTERRUPTED');
    assert.equal(stopped.error.retryable, true);
    assert.match(stopped.logs.stdout, /SHUTDOWN_OUTPUT/);
    assert.ok(stopped.artifacts.some(artifact => artifact.name === 'stdout.log'));
    assert.ok(stopped.execution.finishedAt);
    assert.equal((await getEvidenceLedger(projectId)).entries.find(entry => entry.id === stopped.evidence.runId).verificationStatus, 'unverified');
    await assert.rejects(startExperimentRun(projectId, run.id), { code: 'EXPERIMENT_RUNNER_STOPPING' });
  } finally { await shutdownExperimentRuns(); }
});
