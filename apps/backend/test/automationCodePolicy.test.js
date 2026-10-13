import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/automation-code-policy/', import.meta.url));
await fs.mkdir(cache, { recursive: true });
const base = await fs.realpath(await fs.mkdtemp(path.join(cache, 'case-')));
process.env.SCIENCEPRISM_DATA_DIR = base; process.env.NODE_ENV = 'test';
after(() => fs.rm(base, { recursive: true, force: true }));
const { initializeResearchWorkflow } = await import('../src/services/researchWorkflow/commands.js');
const { readAutomation, mutateAutomation, saveAutomationPolicy } = await import('../src/services/researchAutomation/policy.js');
const { createCodeAuthorization } = await import('../src/services/researchAutomation/codeAuthorization.js');
const { sourceHash } = await import('../src/services/researchAutomation/handoff.js');
const { createAutomationCoordinator, createHarnessRun, getHarnessRun } = await import('../src/services/harnessRuntime/index.js');
const { createCurrentToolPolicy } = await import('../src/services/harnessRuntime/currentToolPolicy.js');

async function fixture(id) {
  const root = path.join(base, id); await fs.mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await fs.writeFile(path.join(root, 'project.json'), '{}');
  const constraints = { capabilities: ['project.read', 'patch.propose'], allowedPaths: ['experiments', 'notes'] };
  const constraintsFile = path.join(root, '.scienceprism/project-constraints.json'); await fs.writeFile(constraintsFile, JSON.stringify(constraints));
  const workflow = await initializeResearchWorkflow(id, { actor: 'human', data: { topic: 'Fixed tool policy fixture' } });
  await saveAutomationPolicy(id, { actor: 'human', expectedVersion: (await readAutomation(id)).version,
    policy: { enabled: true, agentMode: 'specialists', overrides: {}, codeScope: { allowedPaths: ['experiments'], maxTokens: 5000, timeoutMs: 30000, maxVersions: 2 } } });
  await mutateAutomation(id, state => { state.session = { id: `session-${id}`, projectId: id, workflowId: workflow.id, currentStage: 'replication',
    status: 'running', stopRequested: false, steps: [{ stage: 'replication', calls: [], codePreparations: [] }] }; });
  const coordinator = await createAutomationCoordinator(id, `session-${id}`, workflow.id);
  await mutateAutomation(id, state => { state.session.coordinatorRunId = coordinator.id; });
  const state = await readAutomation(id), materials = { protocol: 'Fixed protocol', seed: 0 };
  const authorization = createCodeAuthorization({ projectId: id, session: state.session, stage: 'replication', inputSha256: sourceHash(materials), policyVersion: state.version, policy: state.policy });
  await mutateAutomation(id, current => { current.session.steps[0].codePreparations.push({ authorization, status: 'requested' }); });
  const request = { projectId: id, parentRunId: coordinator.id, delegationTask: 'research:code-preparation', task: 'research:code-preparation',
    stage: 'replication', role: 'experiment-code-producer', adapter: 'deepseek', capabilities: ['project.read', 'patch.propose'], input: materials,
    context: { automationHandoff: { sessionId: state.session.id }, codeAuthorization: authorization },
    limits: { maxTokens: 5000, timeoutMs: 30000, maxConcurrent: 1, retryLimit: 0 }, fallback: false };
  const created = await createHarnessRun(id, request, { automationSessionId: state.session.id });
  await mutateAutomation(id, current => { current.session.steps[0].codePreparations[0].producerRunId = created.id;
    current.session.steps[0].calls.push({ task: request.task, runId: created.id }); });
  const initial = await getHarnessRun(id, created.id), current = { ...structuredClone(initial), status: 'running' };
  let stateReads = 0;
  const readPolicy = createCurrentToolPolicy({ initialRun: initial, getRun: async () => structuredClone(current),
    readConstraints: async () => JSON.parse(await fs.readFile(constraintsFile, 'utf8')), signal: new AbortController().signal,
    readCodeState: async projectId => { stateReads++; assert.equal(projectId, id); return readAutomation(projectId); } });
  return { id, created, initial, current, readPolicy, stateReads: () => stateReads };
}
const reject = code => error => error.code === code;

test('policy uses actual admitted ledger identity and durable calls link while preserving read scope', async () => {
  const f = await fixture('policy-valid'), policy = await f.readPolicy();
  assert.equal(policy.active, true); assert.equal(policy.runId, f.created.id); assert.equal(policy.mode, 'auto');
  assert.deepEqual(policy.capabilities.allowedPaths, ['experiments', 'notes']); assert.deepEqual(policy.capabilities.patchPaths, ['experiments']);
  assert.deepEqual(policy.capabilities.granted, ['project.read', 'patch.propose']); assert.equal(f.stateReads(), 1);
  assert.equal((await getHarnessRun(f.id, f.created.id)).status, 'created', 'running copy tests policy without starting a model');
});

test('actual current policy manual switch, scope or budget contraction invalidates an admitted grant', async () => {
  for (const kind of ['manual', 'paths', 'tokens', 'timeout', 'versions']) {
    const f = await fixture(`revoke-${kind}`), state = await readAutomation(f.id), policy = structuredClone(state.policy);
    if (kind === 'manual') policy.overrides.code = 'manual';
    if (kind === 'paths') policy.codeScope.allowedPaths = ['experiments/nested'];
    if (kind === 'tokens') policy.codeScope.maxTokens--;
    if (kind === 'timeout') policy.codeScope.timeoutMs--;
    if (kind === 'versions') policy.codeScope.maxVersions--;
    await saveAutomationPolicy(f.id, { actor: 'human', expectedVersion: state.version, policy });
    await assert.rejects(f.readPolicy(), reject(kind === 'manual' ? 'AUTOMATION_CODE_DISABLED' : 'AUTOMATION_CODE_SCOPE_REVOKED'));
  }
});

test('removed calls, wrong call task, swapped entry producer or grant invalidate tool ownership', async () => {
  for (const kind of ['calls', 'task', 'producer', 'grant']) {
    const f = await fixture(`ownership-${kind}`);
    await mutateAutomation(f.id, state => {
      const step = state.session.steps[0];
      if (kind === 'calls') step.calls = [];
      if (kind === 'task') step.calls[0].task = 'research:code-repair';
      if (kind === 'producer') step.codePreparations[0].producerRunId = 'foreign-run';
      if (kind === 'grant') step.codePreparations[0].authorization.inputSha256 = 'b'.repeat(64);
    });
    await assert.rejects(f.readPolicy(), reject('AUTOMATION_CODE_PRODUCER_CHANGED'));
  }
});

test('mutated input, patch scope and running Run session/project cannot reuse initial admission', async () => {
  for (const kind of ['input', 'paths', 'session', 'project', 'grant']) {
    const f = await fixture(`run-${kind}`);
    if (kind === 'input') f.current.request.input.seed = 99;
    if (kind === 'paths') f.current.capabilities.patchPaths = ['experiments', 'notes'];
    if (kind === 'session') f.current.automationSessionId = 'foreign-session';
    if (kind === 'project') f.current.projectId = 'foreign-project';
    if (kind === 'grant') f.current.request.context.codeAuthorization.scope.maxTokens--;
    await assert.rejects(f.readPolicy(), reject(kind === 'input' ? 'AUTOMATION_CODE_BINDING_CHANGED' : 'AUTOMATION_CODE_PRODUCER_CHANGED'));
  }
});

test('stopped and replaced durable research sessions reject producer tools', async () => {
  for (const kind of ['stopped', 'replaced']) {
    const f = await fixture(`session-${kind}`);
    await mutateAutomation(f.id, state => { if (kind === 'stopped') state.session.stopRequested = true; else state.session.id = 'replacement-session'; });
    await assert.rejects(f.readPolicy(), reject(kind === 'stopped' ? 'AUTOMATION_CODE_INACTIVE' : 'AUTOMATION_CODE_PRODUCER_INVALID'));
  }
});

test('a durable session rebound to a foreign project cannot authorize the original producer', async () => {
  const f = await fixture('session-foreign-project');
  await mutateAutomation(f.id, state => { state.session.projectId = 'foreign-project'; });
  await assert.rejects(f.readPolicy(), reject('AUTOMATION_CODE_IDENTITY_INVALID'));
});

test('moving or removing the current stage revokes the old stage producer', async () => {
  for (const kind of ['moved', 'missing']) {
    const f = await fixture(`stage-${kind}`);
    await mutateAutomation(f.id, state => {
      if (kind === 'moved') state.session.currentStage = 'experiment';
      else delete state.session.currentStage;
    });
    await assert.rejects(f.readPolicy(), reject('AUTOMATION_CODE_PRODUCER_INVALID'));
  }
});

test('later expanded policy keeps the producer original patch scope and limits', async () => {
  const f = await fixture('policy-expanded'), state = await readAutomation(f.id);
  await saveAutomationPolicy(f.id, { actor: 'human', expectedVersion: state.version,
    policy: { ...state.policy, codeScope: { ...state.policy.codeScope, allowedPaths: ['experiments', 'notes'], maxTokens: 100000, timeoutMs: 600000 } } });
  const policy = await f.readPolicy();
  assert.deepEqual(policy.capabilities.patchPaths, ['experiments']);
  assert.deepEqual((await getHarnessRun(f.id, f.created.id)).limits, f.initial.limits);
});
