import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Fastify from 'fastify';

const cacheDir = fileURLToPath(new URL('../../../.cache/replication-runner-test/', import.meta.url));
await mkdir(cacheDir, { recursive: true });
const dataDir = await mkdtemp(path.join(cacheDir, 'data-'));
process.env.TMPDIR = dataDir;
process.env.SCIENCEPRISM_DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';

const { initializeResearchWorkflow, updateResearchWorkflow, approveResearchWorkflow, resetResearchWorkflow } = await import('../src/services/researchWorkflow/commands.js');
const { getResearchWorkflow } = await import('../src/services/researchWorkflow/index.js');
const {
  cancelExperimentRun,
  createExperimentRun,
  decideExperimentRun,
  getExperimentRun,
  listExperimentRuns,
  retryExperimentRun,
  startExperimentRun
} = await import('../src/services/experimentRunner/index.js');
const { getEvidenceLedger } = await import('../src/services/evidenceLedger/index.js');
const { registerExperimentRunRoutes } = await import('../src/routes/experimentRuns.js');

const preparation = {
  repository: 'https://example.test/research-code',
  environment: 'node 22',
  dataset: 'dataset-recorded',
  codeVersion: 'commit-saved',
  datasetVersion: 'dataset-v3',
  expectedMetrics: 'accuracy >= 0.90',
  gaps: 'GPU unavailable',
  note: 'Human-approved replication preparation.'
};

async function createProject(projectId) {
  const root = path.join(dataDir, projectId);
  await mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ id: projectId }));
  await writeFile(path.join(root, '.scienceprism', 'project-constraints.json'), JSON.stringify({ capabilities: ['project.read', 'experiment.execute'] }));
  await writeFile(path.join(root, 'run.mjs'), 'console.log("replication fixture");\n');
  return root;
}

async function approveStage(projectId, stageId, data) {
  let workflow = await getResearchWorkflow(projectId);
  workflow = await updateResearchWorkflow(projectId, { stageId, data, expectedVersion: workflow.version });
  return approveResearchWorkflow(projectId, { stageId, expectedVersion: workflow.version, actor: 'human' });
}

async function replicationProject(projectId, { plan = preparation, decision = 'approve' } = {}) {
  await createProject(projectId);
  await initializeResearchWorkflow(projectId, { data: { researchQuestion: 'Can the reported result be reproduced?' } });
  await approveStage(projectId, 'direction', { researchQuestion: 'Can the reported result be reproduced?' });
  await approveStage(projectId, 'search', { queries: ['reproduction'] });
  let workflow = await approveStage(projectId, 'selection', { selectedPaperIds: ['paper-1'] });
  if (plan) workflow = await updateResearchWorkflow(projectId, { stageId: 'replication', data: { replication: plan }, expectedVersion: workflow.version });
  if (decision) workflow = await approveResearchWorkflow(projectId, { stageId: 'replication', decision, note: 'Fixture decision', actor: 'human', expectedVersion: workflow.version });
  return workflow;
}

function runInput(workflow, plan = {}) {
  return {
    sourceStage: 'replication',
    expectedVersion: workflow.version,
    plan: { execution: { adapter: 'node', entrypoint: 'run.mjs', args: [] }, ...plan }
  };
}

async function waitForRunStatus(projectId, runId, status, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const run = await getExperimentRun(projectId, runId);
    if (run.status === status) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${projectId}/${runId} to become ${status}.`);
}

async function waitForRunEvidence(projectId, runId, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const run = await getExperimentRun(projectId, runId);
    if (run.evidence?.runId) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${projectId}/${runId} Evidence.`);
}

test('replication Runs use saved preparation without borrowing future experiment approval', async () => {
  const projectId = 'replication-bound-run';
  const workflow = await replicationProject(projectId);
  assert.equal(workflow.currentStage, 'ideation');
  assert.equal(workflow.stages.find(stage => stage.id === 'experiment').status, 'pending');
  const run = await createExperimentRun(projectId, runInput(workflow));

  assert.equal(run.status, 'awaiting_approval');
  assert.equal(run.approval, null);
  assert.equal(run.manifest.replication.sourceStage, 'replication');
  assert.equal(run.manifest.replication.projectId, projectId);
  assert.equal(run.manifest.replication.workflowVersion, workflow.version);
  assert.equal(run.manifest.replication.workflowId, workflow.id);
  assert.deepEqual(run.manifest.replication.plan, preparation);
  assert.deepEqual(run.manifest.dataset, { id: preparation.dataset, version: preparation.datasetVersion, evidenceId: null });
  assert.equal(run.manifest.protocol, preparation.note);
  assert.equal(run.manifest.code.version, preparation.codeVersion);
  assert.deepEqual(run.manifestSummary.replication, run.manifest.replication);
  assert.deepEqual(await getResearchWorkflow(projectId), workflow, 'creating a Run must not approve or advance research');
});

test('replication creation rejects caller provenance, plan overrides, and stale versions without saving Runs', async () => {
  const projectId = 'replication-forged-input';
  const workflow = await replicationProject(projectId);
  const valid = runInput(workflow);
  for (const input of [
    { ...valid, sourceStage: 'method' },
    { ...valid, sourceStage: 'experiment', plan: { ...valid.plan, replication: { plan: preparation } } },
    { ...valid, sourceStage: undefined, replication: { sourceStage: 'replication', plan: preparation } },
    { ...valid, replication: { projectId: 'another-project', workflowVersion: workflow.version, plan: preparation } }
  ]) {
    await assert.rejects(() => createExperimentRun(projectId, input), error => error.code === 'REPLICATION_SOURCE_REQUIRED');
  }
  for (const plan of [
    { dataset: { id: 'caller-dataset', version: 'caller-version' } },
    { planId: 'caller-forged-plan' },
    { protocol: 'Caller protocol must not replace saved preparation.' },
    { codeVersion: 'forged' },
    { repository: 'https://attacker.test/research' }
  ]) {
    await assert.rejects(() => createExperimentRun(projectId, runInput(workflow, plan)), error => error.code === 'REPLICATION_PLAN_OVERRIDE');
  }
  await assert.rejects(() => createExperimentRun(projectId, { ...valid, expectedVersion: workflow.version - 1 }), error => error.code === 'REPLICATION_PLAN_STALE');
  for (const expectedVersion of [undefined, null, 0, -1, 1.5, String(workflow.version)]) {
    await assert.rejects(() => createExperimentRun(projectId, { ...valid, expectedVersion }), error => error.code === 'REPLICATION_VERSION_REQUIRED');
  }
  assert.deepEqual(await listExperimentRuns(projectId), []);
});

test('rejected and skipped replication preparation cannot create a Run', async () => {
  const rejectedProjectId = 'replication-rejected';
  const rejectedWorkflow = await replicationProject(rejectedProjectId, { decision: 'reject' });
  await assert.rejects(
    () => createExperimentRun(rejectedProjectId, runInput(rejectedWorkflow)),
    (error) => error.code === 'REPLICATION_PLAN_REJECTED'
  );
  assert.deepEqual(await listExperimentRuns(rejectedProjectId), []);

  const skippedProjectId = 'replication-skipped';
  const skippedWorkflow = await replicationProject(skippedProjectId, { plan: null, decision: 'skip' });
  await assert.rejects(
    () => createExperimentRun(skippedProjectId, runInput(skippedWorkflow)),
    (error) => error.code === 'REPLICATION_STAGE_SKIPPED'
  );
  assert.deepEqual(await listExperimentRuns(skippedProjectId), []);
});

test('replication HTTP routes create, approve, and execute a Run', async () => {
  const projectId = 'replication-http';
  const workflow = await replicationProject(projectId);
  const app = Fastify();
  registerExperimentRunRoutes(app);
  try {
    const created = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/experiment-runs`, payload: runInput(workflow, { execution: { adapter: 'fake' } }) });
    assert.equal(created.statusCode, 201);
    const runId = created.json().run.id;
    assert.equal(created.json().run.status, 'awaiting_approval');

    const approved = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/experiment-runs/${runId}/decision`, payload: { decision: 'approve', actor: 'researcher' } });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().run.status, 'approved');

    const started = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/experiment-runs/${runId}/start`, payload: { wait: true } });
    assert.equal(started.statusCode, 200);
    assert.equal(started.json().run.status, 'completed');
  } finally {
    await app.close();
  }
});

test('replication HTTP errors preserve structured provenance and version codes', async () => {
  const projectId = 'replication-http-errors';
  const workflow = await replicationProject(projectId);
  const app = Fastify();
  registerExperimentRunRoutes(app);
  try {
    const forged = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/experiment-runs`,
      payload: { ...runInput(workflow), replication: { projectId: 'other-project' } }
    });
    assert.equal(forged.statusCode, 400);
    assert.equal(forged.json().ok, false);
    assert.equal(forged.json().error.code, 'REPLICATION_SOURCE_REQUIRED');

    const stale = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/experiment-runs`,
      payload: { ...runInput(workflow), expectedVersion: workflow.version - 1 }
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().ok, false);
    assert.equal(stale.json().error.code, 'REPLICATION_PLAN_STALE');
    assert.equal(stale.json().error.details.actualVersion, workflow.version);
  } finally {
    await app.close();
  }
});

test('replication provenance is isolated to the project workflow', async () => {
  const sourceWorkflow = await replicationProject('replication-source-project', {
    plan: { ...preparation, dataset: 'source-dataset', datasetVersion: 'source-v1' }
  });
  const targetWorkflow = await replicationProject('replication-target-project', {
    plan: { ...preparation, dataset: 'target-dataset', datasetVersion: 'target-v1' }
  });
  const run = await createExperimentRun('replication-target-project', runInput(sourceWorkflow, { execution: { adapter: 'fake' } }));
  assert.equal(run.manifest.replication.projectId, 'replication-target-project');
  assert.equal(run.manifest.replication.workflowId, targetWorkflow.id);
  assert.equal(run.manifest.replication.plan.dataset, 'target-dataset');
  assert.equal(run.manifest.replication.plan.datasetVersion, 'target-v1');
  assert.notEqual(run.manifest.replication.plan.dataset, sourceWorkflow.stages.find((stage) => stage.id === 'replication').data.replication.dataset);
});

test('cancelled replication Runs remain distinct and create only unverified Evidence', async () => {
  const projectId = 'replication-cancelled';
  const workflow = await replicationProject(projectId);
  await writeFile(path.join(dataDir, projectId, 'run.mjs'), 'await new Promise((resolve) => setTimeout(resolve, 500));\nconsole.log("cancelled replication");\n');
  const run = await createExperimentRun(projectId, runInput(workflow));
  await decideExperimentRun(projectId, run.id, { decision: 'approve' });
  await startExperimentRun(projectId, run.id);
  await waitForRunStatus(projectId, run.id, 'running');
  const cancelled = await cancelExperimentRun(projectId, run.id);
  assert.equal(cancelled.status, 'cancelled');
  const finished = await waitForRunEvidence(projectId, run.id);
  assert.equal(finished.status, 'cancelled');
  assert.equal(finished.error.code, 'EXPERIMENT_CANCELLED');

  const ledger = await getEvidenceLedger(projectId);
  const runEvidence = ledger.entries.find((entry) => entry.id === finished.evidence.runId);
  assert.ok(runEvidence);
  assert.equal(runEvidence.verificationStatus, 'unverified');
  assert.equal(runEvidence.metadata.status, 'cancelled');
  assert.ok(ledger.entries.filter((entry) => entry.metadata?.runId === run.id).every((entry) => entry.verificationStatus === 'unverified'));
});

test('approved replication Run executes independently and records provenance on pending Evidence', async () => {
  const projectId = 'replication-evidence';
  const workflow = await replicationProject(projectId);
  const run = await createExperimentRun(projectId, runInput(workflow, { execution: { adapter: 'fake' } }));
  await decideExperimentRun(projectId, run.id, { decision: 'approve', actor: 'researcher' });

  const completed = await startExperimentRun(projectId, run.id, { wait: true });
  assert.equal(completed.status, 'completed');
  assert.ok(completed.artifacts.length > 0);
  assert.ok(completed.evidence.runId);

  const ledger = await getEvidenceLedger(projectId);
  const evidence = ledger.entries.find((entry) => entry.id === completed.evidence.runId);
  assert.ok(evidence);
  assert.equal(evidence.verificationStatus, 'pending');
  assert.deepEqual(evidence.metadata.replication, run.manifest.replication);
  const artifactEvidence = ledger.entries.find((entry) => entry.metadata?.runId === run.id);
  assert.ok(artifactEvidence);
  assert.equal(artifactEvidence.verificationStatus, 'pending');
  assert.deepEqual(artifactEvidence.metadata.replication, run.manifest.replication);
});

test('concurrent replication starts allow only one execution attempt', async () => {
  const projectId = 'replication-concurrent-start';
  const workflow = await replicationProject(projectId);
  const run = await createExperimentRun(projectId, runInput(workflow, { execution: { adapter: 'fake' } }));
  await decideExperimentRun(projectId, run.id, { decision: 'approve' });

  const attempts = await Promise.allSettled([
    startExperimentRun(projectId, run.id, { wait: true }),
    startExperimentRun(projectId, run.id, { wait: true })
  ]);
  const fulfilled = attempts.filter((result) => result.status === 'fulfilled');
  const rejected = attempts.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'EXPERIMENT_RUN_ACTIVE');
  assert.equal((await getExperimentRun(projectId, run.id)).status, 'completed');
});

test('replication start refuses to execute after the approved preparation is reset', async () => {
  const projectId = 'replication-start-drift';
  const workflow = await replicationProject(projectId);
  const run = await createExperimentRun(projectId, runInput(workflow, { execution: { adapter: 'fake' } }));
  await decideExperimentRun(projectId, run.id, { decision: 'approve' });
  await resetResearchWorkflow(projectId, { actor: 'human', expectedVersion: workflow.version, note: 'Reset preparation for revision.' });

  await assert.rejects(
    () => startExperimentRun(projectId, run.id, { wait: true }),
    (error) => error.code === 'REPLICATION_PLAN_NOT_APPROVED'
  );
  assert.equal((await getExperimentRun(projectId, run.id)).status, 'approved');
});

test('replication retry creates a fresh approved Run and preserves old failure provenance', async () => {
  const projectId = 'replication-retry';
  const workflow = await replicationProject(projectId);
  const run = await createExperimentRun(projectId, runInput(workflow, { execution: { adapter: 'fake' } }));
  await writeFile(path.join(dataDir, projectId, 'run.mjs'), 'console.log("changed after manifest creation");\n');
  await decideExperimentRun(projectId, run.id, { decision: 'approve' });
  const failed = await startExperimentRun(projectId, run.id, { wait: true });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'EXPERIMENT_CODE_CHANGED');
  const failureLedger = await getEvidenceLedger(projectId);
  const failedEvidence = failureLedger.entries.find((entry) => entry.id === failed.evidence.runId);
  assert.ok(failedEvidence);
  assert.equal(failedEvidence.verificationStatus, 'unverified');
  assert.equal(failedEvidence.metadata.status, 'failed');

  const retried = await retryExperimentRun(projectId, run.id, { actor: 'researcher' });
  assert.notEqual(retried.id, failed.id);
  assert.equal(retried.retryOf, failed.id);
  assert.equal(retried.status, 'awaiting_approval');
  assert.equal(retried.approval, null);
  assert.deepEqual(retried.manifest.replication.plan, preparation);
  assert.equal((await getExperimentRun(projectId, failed.id)).status, 'failed');

  await decideExperimentRun(projectId, retried.id, { decision: 'approve' });
  const completed = await startExperimentRun(projectId, retried.id, { wait: true });
  assert.equal(completed.status, 'completed');
  const ledger = await getEvidenceLedger(projectId);
  const evidence = ledger.entries.find((entry) => entry.id === completed.evidence.runId);
  assert.deepEqual(evidence.metadata.replication, retried.manifest.replication);
});
