import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-workflow-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;

const {
  applyApprovalDecision,
  applyRecovery,
  applyStageUpdate,
  createWorkflowDocument
} = await import('../src/services/researchWorkflow/stateMachine.js');
const { getStageReadiness } = await import('../src/services/researchWorkflow/stageContracts.js');
const { migrateStoredWorkflow } = await import('../src/services/researchWorkflow/migrations.js');
const {
  approveResearchWorkflow,
  initializeResearchWorkflow,
  updateResearchWorkflow
} = await import('../src/services/researchWorkflow/commands.js');
const { registerResearchWorkflowRoutes } = await import('../src/routes/researchWorkflow.js');

test('state machine records versioned approval, rejection, and recovery transitions', () => {
  const workflow = createWorkflowDocument('project-a', { now: '2026-01-01T00:00:00.000Z' });
  assert.equal(workflow.version, 1);
  applyStageUpdate(workflow, { data: { researchQuestion: 'How?' }, actor: 'human', now: '2026-01-01T00:01:00.000Z' });
  assert.equal(workflow.version, 2);
  assert.equal(workflow.audit.at(-1).details.previousVersion, 1);

  applyApprovalDecision(workflow, { actor: 'human', now: '2026-01-01T00:02:00.000Z' });
  assert.equal(workflow.currentStage, 'search');
  assert.equal(workflow.stages[0].status, 'approved');
  assert.equal(workflow.version, 3);

  applyApprovalDecision(workflow, { stageId: 'search', decision: 'reject', actor: 'human', note: '补充检索边界', now: '2026-01-01T00:03:00.000Z' });
  assert.equal(workflow.status, 'blocked');
  assert.equal(workflow.stages[1].status, 'rejected');
  applyRecovery(workflow, { actor: 'human', note: '已补充边界', now: '2026-01-01T00:04:00.000Z' });
  assert.equal(workflow.status, 'in_progress');
  assert.equal(workflow.stages[1].status, 'in_progress');
  assert.equal(workflow.audit.at(-1).type, 'workflow.recovered');

  applyStageUpdate(workflow, { stageId: 'search', data: { queries: ['bounded query'] }, actor: 'human' });
  applyApprovalDecision(workflow, { stageId: 'search', actor: 'human' });
  assert.equal(workflow.currentStage, 'selection');
  assert.equal(getStageReadiness(workflow, 'selection').ready, false);
  assert.throws(() => applyApprovalDecision(workflow, { stageId: 'selection', actor: 'human' }), (error) => error.code === 'STAGE_NOT_READY');
});

test('schema migration adds command receipts without dropping stage data', () => {
  const original = createWorkflowDocument('project-b');
  original.schemaVersion = 2;
  delete original.commandReceipts;
  original.stages[0].data = { topic: 'existing direction', unknownField: { keep: true } };
  const result = migrateStoredWorkflow(original, 'project-b');
  assert.equal(result.migrated, true);
  assert.equal(result.workflow.schemaVersion, 3);
  assert.deepEqual(result.workflow.stages[0].data, original.stages[0].data);
  assert.deepEqual(result.workflow.commandReceipts, {});
  assert.equal(result.workflow.audit.at(-1).type, 'workflow.migrated');
});

test('commands enforce optimistic version checks and replay idempotent writes', async () => {
  const projectId = 'project-c';
  const projectRoot = path.join(dataDir, projectId);
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, 'project.json'), '{}\n');

  const initialized = await initializeResearchWorkflow(projectId, { data: { topic: 'topic' }, idempotencyKey: 'init-1' });
  const replayedInitialization = await initializeResearchWorkflow(projectId, { data: { topic: 'topic' }, idempotencyKey: 'init-1' });
  assert.equal(replayedInitialization.version, initialized.version);

  const updated = await updateResearchWorkflow(projectId, {
    stageId: 'direction',
    data: { researchQuestion: 'question' },
    expectedVersion: initialized.version,
    idempotencyKey: 'update-1'
  });
  const replayedUpdate = await updateResearchWorkflow(projectId, {
    stageId: 'direction',
    data: { researchQuestion: 'question' },
    expectedVersion: initialized.version,
    idempotencyKey: 'update-1'
  });
  assert.equal(replayedUpdate.version, updated.version);
  assert.equal(replayedUpdate.audit.length, updated.audit.length);

  await assert.rejects(
    () => updateResearchWorkflow(projectId, { stageId: 'direction', data: { topic: 'stale' }, expectedVersion: initialized.version, idempotencyKey: 'update-2' }),
    (error) => error.code === 'VERSION_CONFLICT'
  );

  await approveResearchWorkflow(projectId, { stageId: 'direction', expectedVersion: updated.version, idempotencyKey: 'approve-1' });
});

test('HTTP routes expose the backend projection and query interfaces', async () => {
  const projectId = 'project-d';
  const projectRoot = path.join(dataDir, projectId);
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, 'project.json'), '{}\n');
  const app = Fastify();
  registerResearchWorkflowRoutes(app);

  const initialized = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/research-workflow`, payload: { data: { topic: 'topic' }, idempotencyKey: 'http-init' } });
  assert.equal(initialized.statusCode, 201);
  const workflow = initialized.json().workflow;
  assert.equal(workflow.currentStage, 'direction');
  assert.equal(workflow.stages.find((stage) => stage.id === 'direction').state, 'active');

  const updated = await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}/research-workflow`, payload: { stage: 'direction', data: { researchQuestion: 'question' }, expectedVersion: workflow.version, idempotencyKey: 'http-update' } });
  assert.equal(updated.statusCode, 200);
  const updatedWorkflow = updated.json().workflow;

  const stale = await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}/research-workflow`, payload: { stage: 'direction', data: { researchQuestion: 'stale' }, expectedVersion: workflow.version, idempotencyKey: 'http-stale' } });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, 'VERSION_CONFLICT');

  const approvals = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/research-workflow/pending-approvals` });
  assert.equal(approvals.statusCode, 200);
  assert.equal(approvals.json().approvals.length, 1);
  const audit = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/research-workflow/audit` });
  assert.equal(audit.statusCode, 200);
  assert.ok(audit.json().events.some((event) => event.type === 'workflow.created'));
  await app.close();
});

test('an unknown Project is rejected instead of resolving to a shared root', async () => {
  await assert.rejects(
    () => updateResearchWorkflow('definitely-not-a-project', { stageId: 'direction', data: { researchQuestion: 'q' }, expectedVersion: 1 }),
    (error) => error.code === 'PROJECT_NOT_FOUND'
  );

  const app = Fastify();
  registerResearchWorkflowRoutes(app);
  const response = await app.inject({ method: 'GET', url: '/api/projects/definitely-not-a-project/research-workflow' });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'PROJECT_NOT_FOUND');
  await app.close();
});

test('the writing gate rejects claims that carry no Evidence even when ready is set directly', () => {
  const workflow = createWorkflowDocument('project-writing-evidence', { now: '2026-01-01T00:00:00.000Z' });
  const stage = workflow.stages.find((item) => item.id === 'writing');

  // A direct PATCH could previously satisfy the writing gate with ready:true
  // alone, bypassing the Evidence check that only the Harness adapter performed.
  stage.data = { ready: true, claims: [{ id: 'claim-1', text: 'Unsupported assertion.', evidenceIds: [] }] };
  const blocked = getStageReadiness(workflow, 'writing');
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.missing, ['claims[].evidenceIds']);

  stage.data = { ready: true, claims: [{ id: 'claim-1', text: 'Supported assertion.', evidenceIds: ['paper-1'] }] };
  assert.equal(getStageReadiness(workflow, 'writing').ready, true);

  // A stage with no claims yet keeps its previous behaviour.
  stage.data = { ready: true, claims: [] };
  assert.equal(getStageReadiness(workflow, 'writing').ready, true);
});
