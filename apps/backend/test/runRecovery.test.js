import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRunRecovery } from '../src/services/harnessRuntime/runRecovery.js';
import { createRetainedWorkspace } from '../src/services/harnessRuntime/retainedWorkspace.js';
import { createCurrentToolPolicy } from '../src/services/harnessRuntime/currentToolPolicy.js';
import { createCodexToolReceipts } from '../src/services/harnessRuntime/codexToolReceipts.js';
import { createDshFileBroker } from '../src/services/harnessRuntime/dshFileBroker.js';
import { CODEX_WORKER_TOOLS } from '../src/services/harnessRuntime/adapters/codexWorker.js';
import { CODEX_PROTOCOL_VERSION } from '../src/services/harnessRuntime/adapters/codexAdapter.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const version = { runtime: 'scienceprism-harness-retention-v1', codex: CODEX_PROTOCOL_VERSION, toolsHash: sha(JSON.stringify(CODEX_WORKER_TOOLS)) };
const implementationHash = sha('fixed-fixture-worker');
async function fixture(t, { release = true, resultMissing = false, binary = false, noChild = false } = {}) {
  const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/run-recovery/', import.meta.url));
  await fs.mkdir(cache, { recursive: true }); const root = await fs.mkdtemp(path.join(cache, 'test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'data', 'project'); await fs.mkdir(projectRoot, { recursive: true }); await fs.writeFile(path.join(projectRoot, 'main.tex'), 'old');
  const parent = { id: 'parent', projectId: 'project', adapter: 'deepseek', status: 'running', task: 'draft', attempt: 1,
    capabilities: { granted: ['project.read', 'patch.propose'], allowedPaths: ['main.tex'], networkAllowlist: [] },
    retainedWorkspace: { format: 'scienceprism-harness-retention-v1', attempt: 1 }, skillVersions: { documents: [] }, patches: [], events: [] };
  const owner = await createRetainedWorkspace({ projectRoot, runId: parent.id, attempt: 1, expectedVersions: version });
  await fs.mkdir(path.join(owner.root, 'baseline')); await fs.writeFile(path.join(owner.root, 'baseline', 'main.tex'), 'old');
  await fs.writeFile(path.join(owner.workspace, 'main.tex'), 'old');
  const baseFiles = [{ path: 'main.tex', sha256: sha('old'), bytes: 3 }];
  if (binary) {
    parent.capabilities.allowedPaths = [];
    for (const target of [projectRoot, owner.workspace, path.join(owner.root, 'baseline')]) await fs.writeFile(path.join(target, 'paper.pdf'), Buffer.alloc(1_048_577));
    baseFiles.push({ path: 'paper.pdf', sha256: null, bytes: 0 });
  }
  await owner.update({ status: 'running', baseFiles, runtimeProcess: { pid: null, stopConfirmed: true } });
  const childRoot = path.join(owner.root, 'delegated-test');
  for (const relative of ['workspace', 'baseline', 'controls/codex-worker-test/receipts']) await fs.mkdir(path.join(childRoot, relative), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(childRoot, 'workspace', 'main.tex'), 'old'); await fs.writeFile(path.join(childRoot, 'baseline', 'main.tex'), 'old');
  if (binary) for (const target of ['workspace', 'baseline']) await fs.writeFile(path.join(childRoot, target, 'paper.pdf'), Buffer.alloc(1_048_577));
  let constraints = { capabilities: ['project.read', 'patch.propose'] };
  const runs = new Map([[parent.id, parent]]);
  const getRun = async (projectId, id) => { assert.equal(projectId, 'project'); return structuredClone(runs.get(id)); };
  const updateRun = async (projectId, id, updater) => { const next = await updater(await getRun(projectId, id)); runs.set(id, structuredClone(next)); return structuredClone(next); };
  const policy = await createCurrentToolPolicy({ initialRun: parent, getRun: () => getRun('project', parent.id), readConstraints: async () => constraints, signal: new AbortController().signal })();
  const storage = { format: 'scienceprism-codex-worker-v1', root: 'codex-worker-test', implementationHash, protocolVersion: CODEX_PROTOCOL_VERSION,
    threadId: 'thread', turnId: 'turn', toolsHash: version.toolsHash, pid: null, phase: 'stopped', stopConfirmed: true,
    binding: { projectId: 'project', runId: 'worker', parentRunId: parent.id, role: 'unassigned', task: 'coding-worker', policyVersion: policy.version } };
  const result = { ok: true, finalResponse: 'Recovered coding result', sessionId: 'thread', usage: { totalTokens: 123 }, output: { codex: { threadId: 'thread', turnId: 'turn' } } };
  const child = { id: 'worker', projectId: 'project', kind: 'codex-worker', adapter: 'codex', status: 'failed', attempt: 1, task: 'coding-worker',
    parentRunId: parent.id, parentAttempt: parent.attempt, capabilities: parent.capabilities, limits: { maxTokens: 4096 }, request: { prompt: 'Fix this draft' },
    recovery: { format: 'scienceprism-codex-delegation-v1', root: 'delegated-test', phase: 'handoff-failed', baseFiles }, workerStorage: storage,
    workerResult: resultMissing ? undefined : result, events: [] };
  runs.set(child.id, child);
  const childPolicy = { ...policy, runId: child.id, task: child.task };
  const receiptsConfig = { directory: path.join(childRoot, 'controls', storage.root, 'receipts'), workspace: path.join(childRoot, 'workspace'), readPolicy: async () => childPolicy,
    binding: { projectId: 'project', parentRunId: parent.id, workerRunId: child.id, threadId: storage.threadId, turnId: storage.turnId,
      workerVersion: `${CODEX_PROTOCOL_VERSION}:${implementationHash}`, toolSchemaHash: version.toolsHash, policyVersion: policy.version, role: 'unassigned', task: child.task } };
  const receipts = await createCodexToolReceipts(receiptsConfig);
  const broker = await createDshFileBroker({ workspace: receiptsConfig.workspace, readPolicy: receiptsConfig.readPolicy, signal: new AbortController().signal, onDecision: async () => {} });
  await receipts.execute({ threadId: 'thread', turnId: 'turn', callId: 'proposal', tool: 'project_propose_patch', arguments: { path: 'main.tex', content: 'new', expectedSha256: sha('old') } }, { executeTool: call => broker.execute(call) });
  await broker.close();
  if (!noChild) await owner.update({ children: [{ runId: child.id, parentRunId: parent.id, parentAttempt: 1, workerRoot: 'delegated-test', pid: null, threadId: 'thread', turnId: 'turn', status: 'completed', stopConfirmed: true }] });
  if (release) await owner.release({ status: 'failed', stopConfirmed: true });
  parent.status = 'failed'; let reads = 0;
  const worker = { implementationHash, readResult: async options => { reads++; await options.assertOwnership(); await options.readPolicy();
    await options.onStorage({ ...storage, phase: 'running', stopConfirmed: false }); await options.onStorage(storage); return structuredClone(result); } };
  const create = () => createRunRecovery({ getRun, updateRun, readProjectConstraints: async () => structuredClone(constraints), worker, resolveProjectRoot: async () => projectRoot });
  return { root, projectRoot, owner, childRoot, runs, parent, child, storage, result, worker, getRun, updateRun, create, reads: () => reads,
    setConstraints: value => { constraints = value; }, receiptsFile: path.join(receiptsConfig.directory, 'tool-receipts.json') };
}

test('a stopped parent without delegated children resumes from its fixed workspace instead of requiring a new retry', async t => {
  const f = await fixture(t, { noChild: true });
  const recovered = await f.create()('project', 'parent');
  assert.equal(recovered.status, 'paused'); assert.equal(recovered.recovery.status, 'ready');
  assert.deepEqual(recovered.recovery.children, []); assert.deepEqual(recovered.patches, []);
  assert.equal(await fs.readFile(path.join(f.owner.workspace, 'main.tex'), 'utf8'), 'old');
  assert.equal(f.reads(), 0);
});

async function readOnlyStageFixture(t, { noChild = true } = {}) {
  const f = await fixture(t, { noChild });
  const parent = f.runs.get('parent');
  Object.assign(parent, { kind: 'research-stage', role: 'research-stage-assistant',
    error: { code: 'HARNESS_INTERRUPTED', message: 'Interrupted before the stage result was saved.', retryable: true } });
  parent.capabilities = { ...parent.capabilities, granted: ['project.read'] };
  f.setConstraints({ capabilities: ['project.read'] });
  return f;
}

test('a stopped read-only research stage recovers without patch authority or worker calls', async t => {
  const f = await readOnlyStageFixture(t);
  const previousError = structuredClone(f.runs.get('parent').error);
  const recovered = await f.create()('project', 'parent');
  assert.equal(recovered.id, 'parent'); assert.equal(recovered.attempt, 1);
  assert.equal(recovered.status, 'paused'); assert.equal(recovered.recovery.status, 'ready');
  assert.deepEqual(recovered.capabilities.granted, ['project.read']);
  assert.deepEqual(recovered.recovery.children, []); assert.deepEqual(recovered.patches, []);
  assert.equal(recovered.humanDecision.status, 'none'); assert.equal(recovered.error, null);
  assert.deepEqual(recovered.recovery.previousError, previousError);
  assert.deepEqual(recovered.events, []); assert.equal(f.reads(), 0);
  for (const root of [f.projectRoot, f.owner.workspace, path.join(f.owner.root, 'baseline')]) {
    assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), 'old');
  }
  await assert.rejects(fs.stat(path.join(f.childRoot, 'handoff-receipts')), { code: 'ENOENT' });
  const repeated = await f.create()('project', 'parent');
  assert.equal(repeated.status, 'paused'); assert.equal(repeated.recovery.status, 'ready');
  assert.deepEqual(repeated.patches, []); assert.deepEqual(repeated.recovery.children, []);
  assert.equal(f.reads(), 0);
});

test('a read-only research stage cannot recover delegated children or saved write proposals', async t => {
  for (const delegatedChild of [true, false]) {
    const f = await readOnlyStageFixture(t, { noChild: !delegatedChild });
    if (!delegatedChild) f.runs.get('parent').patches = [{ path: 'main.tex', content: 'unapplied proposal' }];
    await assert.rejects(f.create()('project', 'parent'), { code: 'HARNESS_RECOVERY_POLICY_DENIED' });
    assert.equal(f.runs.get('parent').status, 'failed');
    assert.equal(f.runs.get('parent').recovery, undefined); assert.equal(f.reads(), 0);
    assert.equal(await fs.readFile(path.join(f.projectRoot, 'main.tex'), 'utf8'), 'old');
    assert.equal(await fs.readFile(path.join(f.owner.workspace, 'main.tex'), 'utf8'), 'old');
  }
});

test('read-only recovery refuses changed original, baseline or workspace files without blessing a result', async t => {
  for (const location of ['original', 'baseline', 'workspace', 'outside-scope']) {
    const f = await readOnlyStageFixture(t);
    const root = location === 'original' ? f.projectRoot : location === 'baseline' ? path.join(f.owner.root, 'baseline') : f.owner.workspace;
    const file = path.join(root, location === 'outside-scope' ? 'unexpected.txt' : 'main.tex');
    await fs.writeFile(file, 'changed');
    await assert.rejects(f.create()('project', 'parent'), { code: 'HARNESS_RECOVERY_BASELINE_CONFLICT' });
    assert.equal(f.runs.get('parent').status, 'failed');
    assert.equal(f.runs.get('parent').recovery, undefined); assert.deepEqual(f.runs.get('parent').patches, []);
    assert.equal(f.reads(), 0); assert.equal(await fs.readFile(file, 'utf8'), 'changed');
    if (location !== 'original') assert.equal(await fs.readFile(path.join(f.projectRoot, 'main.tex'), 'utf8'), 'old');
  }
});

test('stopped stored results reconcile real file receipts without provider calls or modifying the original', async t => {
  const f = await fixture(t); const recovered = await f.create()('project', 'parent');
  assert.equal(recovered.status, 'paused'); assert.equal(recovered.recovery.status, 'ready'); assert.equal(f.reads(), 0);
  assert.equal(recovered.patches.length, 1); assert.equal(recovered.patches[0].content, 'new'); assert.equal(recovered.humanDecision.status, 'pending');
  assert.equal(recovered.recovery.children[0].task, 'Fix this draft'); assert.equal(await fs.readFile(path.join(f.projectRoot, 'main.tex'), 'utf8'), 'old');
  assert.equal(await fs.readFile(path.join(f.owner.workspace, 'main.tex'), 'utf8'), 'new');
  const receiptPath = path.join(f.childRoot, 'handoff-receipts', 'tool-receipts.json'); const first = await fs.readFile(receiptPath, 'utf8');
  const repeated = await f.create()('project', 'parent'); assert.equal(repeated.patches.length, 1); assert.equal(f.reads(), 0);
  assert.equal(await fs.readFile(receiptPath, 'utf8'), first); assert.equal(JSON.parse(first).receipts.length, 1);
});

test('missing completed result uses only the controlled readResult path and records its inspection stopping state', async t => {
  const f = await fixture(t, { resultMissing: true }); const result = await f.create()('project', 'parent', { provider: { apiKey: 'fixture-only' } });
  assert.equal(f.reads(), 1); assert.equal(result.recovery.status, 'ready'); assert.equal(f.runs.get('worker').workerStorage.stopConfirmed, true);
  assert.equal(JSON.stringify(result).includes('fixture-only'), false);
});

test('live ownership and changed project baselines block recovery before inspecting workers', async t => {
  const f = await fixture(t, { release: false });
  await assert.rejects(f.create()('project', 'parent'), error => error.code === 'HARNESS_WORKSPACE_OWNER_ACTIVE');
  await f.owner.release({ status: 'failed', stopConfirmed: true }); await fs.writeFile(path.join(f.projectRoot, 'main.tex'), 'user edit');
  await assert.rejects(f.create()('project', 'parent'), error => error.code === 'HARNESS_RECOVERY_BASELINE_CONFLICT');
  assert.equal(f.reads(), 0); assert.equal(await fs.readFile(path.join(f.owner.workspace, 'main.tex'), 'utf8'), 'old');
});

test('current revoked policy and changed worker implementation cannot bless an old result', async t => {
  const f = await fixture(t); f.setConstraints({ capabilities: ['project.read'] });
  await assert.rejects(f.create()('project', 'parent'), error => error.code === 'HARNESS_RECOVERY_POLICY_DENIED');
  f.setConstraints({ capabilities: ['project.read', 'patch.propose'] }); f.runs.get('worker').workerStorage.implementationHash = sha('other');
  await assert.rejects(f.create()('project', 'parent'), error => error.code === 'HARNESS_RECOVERY_WORKER_CONFLICT');
  assert.equal(f.reads(), 0);
});

test('prepared worker and parent handoff receipts stay ambiguous and are never redispatched', async t => {
  const f = await fixture(t); const state = JSON.parse(await fs.readFile(f.receiptsFile)); state.receipts[0].status = 'prepared'; state.receipts[0].result = null;
  await fs.writeFile(f.receiptsFile, JSON.stringify(state));
  await assert.rejects(f.create()('project', 'parent'), error => error.code === 'CODEX_RECEIPT_AMBIGUOUS');
  assert.equal(await fs.readFile(path.join(f.owner.workspace, 'main.tex'), 'utf8'), 'old'); assert.equal(f.reads(), 0);
  state.receipts[0].status = 'completed'; state.receipts[0].result = { kind: 'proposal', path: 'main.tex', sha256: sha('new'), byteLength: 3, proposed: true };
  await fs.writeFile(f.receiptsFile, JSON.stringify(state));
  await f.create()('project', 'parent');
  const handoffFile = path.join(f.childRoot, 'handoff-receipts', 'tool-receipts.json'); const handoff = JSON.parse(await fs.readFile(handoffFile));
  handoff.receipts[0].status = 'prepared'; handoff.receipts[0].result = null; await fs.writeFile(handoffFile, JSON.stringify(handoff));
  f.runs.get('parent').recovery = undefined;
  await assert.rejects(f.create()('project', 'parent'), error => error.code === 'CODEX_RECEIPT_AMBIGUOUS');
  assert.equal(await fs.readFile(path.join(f.owner.workspace, 'main.tex'), 'utf8'), 'new');
});

test('child result read failure and cancellation preserve stopped state and do not merge proposals', async t => {
  const f = await fixture(t, { resultMissing: true });
  f.worker.readResult = async () => { throw Object.assign(new Error('fixture failed turn'), { code: 'CODEX_TURN_FAILED' }); };
  await assert.rejects(f.create()('project', 'parent'), error => error.code === 'CODEX_TURN_FAILED');
  assert.equal(await fs.readFile(path.join(f.owner.workspace, 'main.tex'), 'utf8'), 'old');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.create()('project', 'parent', { signal: controller.signal }), error => error.name === 'AbortError');
});

test('child baseline or stored result identity conflicts preserve the original project', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.childRoot, 'baseline', 'main.tex'), 'changed');
  await assert.rejects(f.create()('project', 'parent'), error => error.code === 'HARNESS_RECOVERY_BASELINE_CONFLICT');
  await fs.writeFile(path.join(f.childRoot, 'baseline', 'main.tex'), 'old'); f.runs.get('worker').workerResult.output.codex.turnId = 'other-turn';
  await assert.rejects(f.create()('project', 'parent'), error => error.code === 'HARNESS_RECOVERY_RESULT_CONFLICT');
  assert.equal(await fs.readFile(path.join(f.projectRoot, 'main.tex'), 'utf8'), 'old');
});

test('ready recovery detects later parent-copy edits and never blesses changed file scope', async t => {
  const f = await fixture(t); await f.create()('project', 'parent');
  await fs.writeFile(path.join(f.owner.workspace, 'main.tex'), 'later edit');
  await assert.rejects(f.create()('project', 'parent'), error => error.code === 'HARNESS_RECOVERY_RESULT_CONFLICT');
  await fs.writeFile(path.join(f.owner.workspace, 'main.tex'), 'new'); f.runs.get('worker').capabilities.allowedPaths = ['other.tex'];
  await assert.rejects(f.create()('project', 'parent'), error => error.code === 'HARNESS_RECOVERY_BASELINE_CONFLICT' || error.code === 'HARNESS_RECOVERY_POLICY_DENIED');
});

test('missing parent DSH stopping evidence and unconfirmed inspection stop are preserved', async t => {
  const f = await fixture(t, { resultMissing: true });
  const owner = await createRetainedWorkspace({ projectRoot: f.projectRoot, runId: 'parent', attempt: 1, recover: true, expectedVersions: version });
  await owner.update({ runtimeProcess: undefined }); await owner.release({ status: 'failed', stopConfirmed: true });
  await assert.rejects(f.create()('project', 'parent'), error => error.code === 'HARNESS_RECOVERY_PARENT_STOP_UNCONFIRMED');
  const repaired = await createRetainedWorkspace({ projectRoot: f.projectRoot, runId: 'parent', attempt: 1, recover: true, expectedVersions: version });
  await repaired.update({ runtimeProcess: { pid: null, stopConfirmed: true } }); await repaired.release({ status: 'failed', stopConfirmed: true });
  f.worker.readResult = async () => { throw Object.assign(new Error('fixture stop failed'), { code: 'CODEX_STOP_FAILED' }); };
  await assert.rejects(f.create()('project', 'parent'), error => error.code === 'CODEX_STOP_FAILED');
  await assert.rejects(f.create()('project', 'parent'), error => error.code === 'HARNESS_WORKSPACE_OWNER_ACTIVE');
  assert.equal(await fs.readFile(path.join(f.projectRoot, 'main.tex'), 'utf8'), 'old');
});

test('large binary baselines remain excluded, while changing them to bounded text conflicts', async t => {
  const f = await fixture(t, { binary: true }); const recovered = await f.create()('project', 'parent');
  assert.equal(recovered.patches.length, 1); assert.equal(recovered.patches[0].path, 'main.tex');
  await fs.writeFile(path.join(f.projectRoot, 'paper.pdf'), 'unexpected text');
  await assert.rejects(f.create()('project', 'parent'), error => error.code === 'HARNESS_RECOVERY_BASELINE_CONFLICT');
});

test('missing usage consumes the old allocation and over-budget results cannot be recovered as success', async t => {
  const f = await fixture(t); f.runs.get('worker').workerResult.usage = {};
  const recovered = await f.create()('project', 'parent');
  assert.deepEqual(recovered.recovery.children[0].usage, { totalTokens: 4096, estimated: true });
  f.runs.get('worker').workerResult.usage = { totalTokens: 5000, apiKey: 'do-not-copy' };
  await assert.rejects(f.create()('project', 'parent'), error => error.code === 'HARNESS_RECOVERY_BUDGET_EXHAUSTED');
  assert.equal(JSON.stringify(f.runs.get('parent').recovery).includes('do-not-copy'), false);
});

test('OS-confirmed dead saved processes can be reconciled even when their final stop write was lost', async t => {
  const f = await fixture(t, { resultMissing: true });
  const stopped = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', env: {} });
  assert.equal(stopped.status, 0); assert.throws(() => process.kill(stopped.pid, 0), error => error.code === 'ESRCH');
  const owner = await createRetainedWorkspace({ projectRoot: f.projectRoot, runId: 'parent', attempt: 1, recover: true, expectedVersions: version });
  const cp = await owner.read();
  await owner.update({ stopConfirmed: false, runtimeProcess: { pid: stopped.pid, stopConfirmed: false },
    children: cp.children.map(entry => ({ ...entry, pid: stopped.pid, status: 'ambiguous', stopConfirmed: false })) });
  await owner.release({ status: 'failed', stopConfirmed: true });
  f.runs.get('worker').workerStorage = { ...f.storage, pid: stopped.pid, phase: 'stop-unconfirmed', stopConfirmed: false };
  const recovered = await f.create()('project', 'parent');
  assert.equal(recovered.recovery.status, 'ready'); assert.equal(f.reads(), 1);
  assert.equal(f.runs.get('worker').workerStorage.stopConfirmed, true);
});

// Reproduces the independent review's real receipt fixture: child one hands
// old -> new to the parent, then child two legitimately hands new -> newer.
async function multiChildFixture(t) {
  const f = await fixture(t); await f.create()('project', 'parent');
  const parent = f.runs.get('parent'); parent.status = 'failed'; parent.recovery = undefined;
  const owner = await createRetainedWorkspace({ projectRoot: f.projectRoot, runId: 'parent', attempt: 1, recover: true, expectedVersions: version });
  const root = path.join(owner.root, 'delegated-second');
  for (const dir of ['baseline', 'workspace', 'controls/codex-worker-second/receipts']) await fs.mkdir(path.join(root, dir), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(root, 'baseline/main.tex'), 'new'); await fs.writeFile(path.join(root, 'workspace/main.tex'), 'new');
  const current = f.runs.get('worker');
  const storage = { ...current.workerStorage, root: 'codex-worker-second', threadId: 'thread-second', turnId: 'turn-second', binding: { ...current.workerStorage.binding, runId: 'worker-second' } };
  const child = { ...structuredClone(current), id: 'worker-second', request: { prompt: 'Improve the revised draft' }, workerStorage: storage,
    recovery: { format: 'scienceprism-codex-delegation-v1', root: 'delegated-second', phase: 'handed-off', workerCompleted: true, baseFiles: [{ path: 'main.tex', sha256: sha('new'), bytes: 3 }] },
    workerResult: { ...f.result, sessionId: storage.threadId, output: { codex: { threadId: storage.threadId, turnId: storage.turnId } } } };
  f.runs.set(child.id, child);
  const childPolicy = { projectId: 'project', runId: child.id, role: 'unassigned', task: 'coding-worker', active: true, mode: 'auto', version: storage.binding.policyVersion, capabilities: parent.capabilities };
  const childBroker = await createDshFileBroker({ workspace: path.join(root, 'workspace'), readPolicy: async () => childPolicy, onDecision: async () => {} });
  const receipts = await createCodexToolReceipts({ directory: path.join(root, 'controls', storage.root, 'receipts'), workspace: path.join(root, 'workspace'), readPolicy: async () => childPolicy,
    binding: { projectId: 'project', parentRunId: 'parent', workerRunId: child.id, threadId: storage.threadId, turnId: storage.turnId, workerVersion: `${CODEX_PROTOCOL_VERSION}:${implementationHash}`, toolSchemaHash: version.toolsHash, policyVersion: childPolicy.version, role: childPolicy.role, task: childPolicy.task } });
  await receipts.execute({ threadId: storage.threadId, turnId: storage.turnId, callId: 'proposal2', tool: 'project_propose_patch', arguments: { path: 'main.tex', content: 'newer', expectedSha256: sha('new') } }, { executeTool: call => childBroker.execute(call) });
  await childBroker.close();
  const parentPolicy = { ...childPolicy, runId: 'parent', task: 'draft' };
  const handoff = await createCodexToolReceipts({ directory: path.join(root, 'handoff-receipts'), workspace: owner.workspace, readPolicy: async () => parentPolicy,
    binding: { projectId: 'project', parentRunId: 'parent', workerRunId: 'parent', threadId: storage.threadId, turnId: storage.turnId, workerVersion: 'scienceprism-codex-handoff-v1', toolSchemaHash: sha('project_propose_patch-v1'), policyVersion: parentPolicy.version, role: parentPolicy.role, task: parentPolicy.task } });
  const broker = await createDshFileBroker({ workspace: owner.workspace, readPolicy: async () => parentPolicy, onDecision: async () => {} });
  await handoff.execute({ threadId: storage.threadId, turnId: storage.turnId, callId: `handoff:${child.id}:${sha('main.tex')}`, tool: 'project_propose_patch', arguments: { path: 'main.tex', content: 'newer', expectedSha256: sha('new') } }, { executeTool: call => broker.execute(call) });
  await broker.close();
  const cp = await owner.read();
  await owner.update({ children: [...cp.children, { runId: child.id, parentRunId: 'parent', parentAttempt: 1, workerRoot: 'delegated-second', pid: null, threadId: storage.threadId, turnId: storage.turnId, status: 'completed', stopConfirmed: true }] });
  await owner.release({ status: 'failed', stopConfirmed: true });
  return { ...f, secondRoot: root, secondChild: child,
    firstHandoff: path.join(f.childRoot, 'handoff-receipts/tool-receipts.json'), secondHandoff: path.join(root, 'handoff-receipts/tool-receipts.json') };
}

test('sequential completed children reconcile a shared parent file without replaying obsolete proposals', async t => {
  const f = await multiChildFixture(t);
  const before = await Promise.all([f.firstHandoff, f.secondHandoff].map(file => fs.readFile(file, 'utf8')));
  const eventCount = f.runs.get('parent').events.length;
  const recovered = await f.create()('project', 'parent');
  assert.equal(recovered.recovery.children.length, 2); assert.equal(recovered.patches[0].content, 'newer');
  assert.equal(f.reads(), 0); assert.equal(recovered.events.length, eventCount);
  assert.equal(await fs.readFile(path.join(f.projectRoot, 'main.tex'), 'utf8'), 'old');
  assert.deepEqual(await Promise.all([f.firstHandoff, f.secondHandoff].map(file => fs.readFile(file, 'utf8'))), before);
  const repeated = await f.create()('project', 'parent'); assert.equal(repeated.patches[0].content, 'newer');
  assert.deepEqual(await Promise.all([f.firstHandoff, f.secondHandoff].map(file => fs.readFile(file, 'utf8'))), before);
});

test('a shared-file handoff chain refuses prepared or missing earlier receipts and altered final files', async t => {
  const f = await multiChildFixture(t); const original = await fs.readFile(f.firstHandoff, 'utf8'); const first = JSON.parse(original);
  first.receipts[0].status = 'prepared'; first.receipts[0].result = null; await fs.writeFile(f.firstHandoff, JSON.stringify(first));
  await assert.rejects(f.create()('project', 'parent'), error => error.code === 'CODEX_RECEIPT_AMBIGUOUS');
  first.receipts = []; await fs.writeFile(f.firstHandoff, JSON.stringify(first));
  await assert.rejects(f.create()('project', 'parent'), error => error.code === 'HARNESS_RECOVERY_HANDOFF_CONFLICT');
  await fs.writeFile(f.firstHandoff, original); await fs.writeFile(path.join(f.owner.workspace, 'main.tex'), 'unrelated edit');
  await assert.rejects(f.create()('project', 'parent'), error => error.code === 'HARNESS_RECOVERY_HANDOFF_CONFLICT');
  assert.equal(f.reads(), 0); assert.equal(await fs.readFile(path.join(f.projectRoot, 'main.tex'), 'utf8'), 'old');
  assert.equal(await fs.readFile(path.join(f.owner.workspace, 'main.tex'), 'utf8'), 'unrelated edit');
});

test('individually valid completed receipts still require a continuous shared-file hash chain', async t => {
  const f = await multiChildFixture(t); await fs.writeFile(path.join(f.secondRoot, 'baseline/main.tex'), 'different');
  f.runs.get('worker-second').recovery.baseFiles = [{ path: 'main.tex', sha256: sha('different'), bytes: 9 }];
  const receiptFile = path.join(f.secondRoot, 'controls/codex-worker-second/receipts/tool-receipts.json');
  const workerReceipt = JSON.parse(await fs.readFile(receiptFile)); workerReceipt.receipts[0].beforeSha256 = sha('different');
  await fs.writeFile(receiptFile, JSON.stringify(workerReceipt));
  const second = JSON.parse(await fs.readFile(f.secondHandoff)); second.receipts[0].beforeSha256 = sha('different');
  second.receipts[0].requestHash = sha(JSON.stringify({ tool: 'project_propose_patch', arguments: { path: 'main.tex', content: 'newer', expectedSha256: sha('different') } }));
  await fs.writeFile(f.secondHandoff, JSON.stringify(second));
  await assert.rejects(f.create()('project', 'parent'), error => error.code === 'HARNESS_RECOVERY_HANDOFF_CONFLICT');
  assert.equal(await fs.readFile(path.join(f.owner.workspace, 'main.tex'), 'utf8'), 'newer'); assert.equal(f.reads(), 0);
});
