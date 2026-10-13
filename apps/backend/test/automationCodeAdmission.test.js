import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/automation-code-admission/', import.meta.url));
await fs.mkdir(cache, { recursive: true });
const base = await fs.realpath(await fs.mkdtemp(path.join(cache, 'case-')));
process.env.SCIENCEPRISM_DATA_DIR = base; process.env.NODE_ENV = 'test';
after(() => fs.rm(base, { recursive: true, force: true }));
const { initializeResearchWorkflow } = await import('../src/services/researchWorkflow/commands.js');
const { readAutomation, mutateAutomation, saveAutomationPolicy } = await import('../src/services/researchAutomation/policy.js');
const { createCodeAuthorization } = await import('../src/services/researchAutomation/codeAuthorization.js');
const { sourceHash } = await import('../src/services/researchAutomation/handoff.js');
const { createAutomationCoordinator, createHarnessRun, getHarnessRun, listHarnessRuns, startHarnessRun } = await import('../src/services/harnessRuntime/index.js');
const codeScope = () => ({ allowedPaths: ['experiments'], maxTokens: 5000, timeoutMs: 30000, maxVersions: 2 });

async function fixture(id, { legacy = false, allowedPaths = ['experiments', 'notes'] } = {}) {
  const root = path.join(base, id); await fs.mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await fs.mkdir(path.join(root, 'notes')); await fs.writeFile(path.join(root, 'project.json'), '{}');
  await fs.writeFile(path.join(root, 'notes/protocol.md'), 'Fixed protocol source');
  await fs.writeFile(path.join(root, '.scienceprism/project-constraints.json'), JSON.stringify({ capabilities: ['project.read', 'patch.propose'], allowedPaths }));
  const workflow = await initializeResearchWorkflow(id, { actor: 'human', data: { topic: 'Fixed code admission fixture' } });
  const policy = { enabled: true, agentMode: 'specialists', overrides: {}, ...(legacy ? {} : { codeScope: codeScope() }) };
  await saveAutomationPolicy(id, { actor: 'human', expectedVersion: (await readAutomation(id)).version, policy });
  await mutateAutomation(id, state => { state.session = { id: `session-${id}`, workflowId: workflow.id, projectId: id, currentStage: 'replication',
    status: 'running', stopRequested: false, steps: [{ stage: 'replication', calls: [], codePreparations: [] }] }; });
  const coordinator = await createAutomationCoordinator(id, `session-${id}`, workflow.id);
  await mutateAutomation(id, state => { state.session.coordinatorRunId = coordinator.id; });
  async function authorize() {
    const state = await readAutomation(id), materials = { protocol: 'Fixed protocol source', dataset: 'fixed-data', seed: 0 };
    const authorization = createCodeAuthorization({ projectId: id, session: state.session, stage: 'replication', inputSha256: sourceHash(materials), policyVersion: state.version, policy: state.policy });
    await mutateAutomation(id, current => { current.session.steps[0].codePreparations = [{ authorization, status: 'requested' }]; });
    return { projectId: id, parentRunId: coordinator.id, delegationTask: 'research:code-preparation', task: 'research:code-preparation',
      stage: 'replication', role: 'experiment-code-producer', adapter: 'deepseek', capabilities: ['project.read', 'patch.propose'],
      input: materials, context: { automationHandoff: { sessionId: state.session.id }, codeAuthorization: authorization },
      limits: { maxTokens: 5000, timeoutMs: 30000, maxConcurrent: 1, retryLimit: 0 }, fallback: false };
  }
  return { id, root, workflow, coordinator, authorize, trusted: { automationSessionId: `session-${id}` } };
}
const reject = code => error => error.code === code;

test('human policy and real coordinator ledger admit a persisted scoped producer without executing a model', async () => {
  const f = await fixture('admitted'), request = await f.authorize(), run = await createHarnessRun(f.id, request, f.trusted);
  const stored = await getHarnessRun(f.id, run.id), ledger = await listHarnessRuns(f.id, { parentRunId: f.coordinator.id });
  assert.equal(f.coordinator.role, 'research-code-coordinator'); assert.deepEqual(f.coordinator.request.input.codeScope, codeScope());
  assert.equal(stored.kind, 'research-stage'); assert.equal(stored.parentRunId, f.coordinator.id); assert.equal(stored.status, 'created');
  assert.deepEqual(stored.capabilities.granted, ['project.read', 'patch.propose']);
  assert.deepEqual(stored.capabilities.patchPaths, ['experiments']); assert.deepEqual(stored.capabilities.allowedPaths, ['experiments', 'notes']);
  assert.equal(stored.capabilities.granted.includes('experiment.execute'), false); assert.equal(stored.role, 'experiment-code-producer');
  assert.equal(stored.fallback, false); assert.ok(ledger.some(item => item.id === run.id));
  assert.deepEqual(stored.request.context.codeAuthorization, request.context.codeAuthorization);
  assert.equal((await readAutomation(f.id)).session.steps[0].codePreparations[0].producerRunId, undefined);
});

test('public producer creation or direct stage controls reject before any model starts', async () => {
  const f = await fixture('public-control'), request = await f.authorize();
  await assert.rejects(createHarnessRun(f.id, request), reject('AUTOMATION_OWNS_STAGE'));
  const run = await createHarnessRun(f.id, request, f.trusted);
  await assert.rejects(startHarnessRun(f.id, run.id), reject('AUTOMATION_OWNS_STAGE'));
  assert.equal((await getHarnessRun(f.id, run.id)).status, 'created'); assert.equal((await getHarnessRun(f.id, run.id)).attempt, 0);
  await assert.rejects(createHarnessRun(f.id, request, { automationSessionId: 'foreign-session' }), reject('AUTOMATION_OWNS_STAGE'));
});

test('the internal code coordinator role cannot be created as a public model Run', async () => {
  const f = await fixture('public-code-coordinator');
  const before = await listHarnessRuns(f.id, { limit: 100 });
  await assert.rejects(createHarnessRun(f.id, { task: 'ordinary-task', role: 'research-code-coordinator', adapter: 'deepseek',
    capabilities: ['project.read', 'patch.propose'], input: { codeScope: codeScope() } }), reject('AUTOMATION_OWNS_COORDINATOR'));
  assert.deepEqual(await listHarnessRuns(f.id, { limit: 100 }), before);
});

test('missing or unpersisted grant and wrong source session cannot admit a real producer', async () => {
  const f = await fixture('grant-required'), request = await f.authorize();
  await assert.rejects(createHarnessRun(f.id, { ...request, context: { automationHandoff: request.context.automationHandoff } }, f.trusted), reject('AUTOMATION_CODE_PRODUCER_INVALID'));
  await assert.rejects(createHarnessRun(f.id, { ...request, context: { ...request.context, automationHandoff: { sessionId: 'foreign' } } }, f.trusted), reject('AUTOMATION_CODE_PRODUCER_INVALID'));
  await mutateAutomation(f.id, state => { state.session.steps[0].codePreparations = []; });
  await assert.rejects(createHarnessRun(f.id, request, f.trusted), reject('AUTOMATION_CODE_PRODUCER_CHANGED'));
  assert.equal((await listHarnessRuns(f.id, { parentRunId: f.coordinator.id })).length, 0);
});

test('producer budget, retry, fallback and persisted version count are enforced at ledger admission', async () => {
  const f = await fixture('bounded'), request = await f.authorize();
  for (const limits of [{ ...request.limits, maxTokens: 5001 }, { ...request.limits, timeoutMs: 30001 },
    { ...request.limits, maxConcurrent: 2 }, { ...request.limits, retryLimit: 1 }]) {
    await assert.rejects(createHarnessRun(f.id, { ...request, limits }, f.trusted), reject('AUTOMATION_CODE_LIMIT_DENIED'));
  }
  await assert.rejects(createHarnessRun(f.id, { ...request, fallback: true }, f.trusted), reject('AUTOMATION_CODE_LIMIT_DENIED'));
  await mutateAutomation(f.id, state => { state.session.steps[0].codePreparations.push(...Array.from({ length: 2 }, () => ({ authorization: structuredClone(request.context.codeAuthorization) }))); });
  await assert.rejects(createHarnessRun(f.id, request, f.trusted), reject('AUTOMATION_CODE_PRODUCER_CHANGED'));
  assert.equal((await listHarnessRuns(f.id, { parentRunId: f.coordinator.id })).length, 0);
});

test('an old read-only coordinator cannot gain code privileges by enabling policy later', async () => {
  const f = await fixture('old-coordinator', { legacy: true });
  assert.equal(f.coordinator.role, 'research-stage-assistant'); assert.deepEqual(f.coordinator.capabilities.granted, ['project.read']);
  const state = await readAutomation(f.id);
  await saveAutomationPolicy(f.id, { actor: 'human', expectedVersion: state.version, policy: { ...state.policy, codeScope: codeScope() } });
  await assert.rejects(createHarnessRun(f.id, await f.authorize(), f.trusted), reject('DELEGATION_CAPABILITY_DENIED'));
  assert.deepEqual((await getHarnessRun(f.id, f.coordinator.id)).capabilities.granted, ['project.read']);
});

test('later wider code scope cannot exceed the coordinator original ceiling', async () => {
  const f = await fixture('parent-ceiling'), state = await readAutomation(f.id);
  await saveAutomationPolicy(f.id, { actor: 'human', expectedVersion: state.version,
    policy: { ...state.policy, codeScope: { ...codeScope(), allowedPaths: ['experiments', 'notes'] } } });
  await assert.rejects(createHarnessRun(f.id, await f.authorize(), f.trusted), reject('AUTOMATION_CODE_PARENT_SCOPE_DENIED'));
});

test('internal automatic options cannot give a generic project agent code proposal authority', async () => {
  const f = await fixture('generic-automatic'), source = await f.authorize(), before = await listHarnessRuns(f.id, { limit: 100 });
  const request = { ...source, role: 'project-agent', context: { automationHandoff: source.context.automationHandoff } };
  await assert.rejects(createHarnessRun(f.id, request, f.trusted), reject('AUTOMATION_CODE_PRODUCER_INVALID'));
  assert.deepEqual(await listHarnessRuns(f.id, { limit: 100 }), before);
  const manual = await createHarnessRun(f.id, { role: 'project-agent', task: 'ordinary-manual-proposal', adapter: 'deepseek',
    capabilities: ['project.read', 'patch.propose'], input: { prompt: 'Existing manual creation remains available' } });
  assert.equal(manual.status, 'created'); assert.equal(manual.parentRunId, null);
  assert.ok(manual.capabilities.granted.includes('patch.propose'));
});

test('child read scope cannot expand beyond its parent birth scope and disjoint scopes refuse admission', async () => {
  const f = await fixture('parent-read-ceiling', { allowedPaths: ['experiments'] }), request = await f.authorize();
  const file = path.join(f.root, '.scienceprism/project-constraints.json');
  await fs.writeFile(file, JSON.stringify({ capabilities: ['project.read', 'patch.propose'], allowedPaths: ['experiments', 'notes', 'extra'] }));
  const child = await createHarnessRun(f.id, request, f.trusted);
  assert.deepEqual(child.capabilities.allowedPaths, ['experiments']); assert.deepEqual(child.capabilities.patchPaths, ['experiments']);
  assert.deepEqual((await getHarnessRun(f.id, f.coordinator.id)).capabilities.allowedPaths, ['experiments']);
  const before = await listHarnessRuns(f.id, { limit: 100 });
  await fs.writeFile(file, JSON.stringify({ capabilities: ['project.read', 'patch.propose'], allowedPaths: ['notes'] }));
  await assert.rejects(createHarnessRun(f.id, request, f.trusted), reject('DELEGATION_PATH_DENIED'));
  assert.deepEqual(await listHarnessRuns(f.id, { limit: 100 }), before);
});
