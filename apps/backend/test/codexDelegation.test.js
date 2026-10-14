import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexDelegation } from '../src/services/harnessRuntime/codexDelegation.js';
import { createDshFileBroker } from '../src/services/harnessRuntime/dshFileBroker.js';
import { createCodeAuthorization } from '../src/services/researchAutomation/codeAuthorization.js';
import { sourceHash } from '../src/services/researchAutomation/handoff.js';

async function fixture(t, perform) {
  const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/delegation-allocation/', import.meta.url)); await fs.mkdir(cache, { recursive: true });
  const root = await fs.mkdtemp(path.join(cache, 'composition-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'parent');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'main.tex'), 'original');
  const parent = { id: 'parent', projectId: 'p', adapter: 'deepseek', status: 'running', role: 'project-agent', task: 'edit', attempt: 1,
    limits: { maxTokens: 20000, timeoutMs: 10000 }, capabilities: { granted: ['project.read', 'patch.propose'], allowedPaths: ['main.tex'], networkAllowlist: [] }, events: [] };
  const rows = new Map([[parent.id, structuredClone(parent)]]);
  const controller = new AbortController();
  let policy = { projectId: 'p', runId: 'parent', role: parent.role, task: parent.task, version: 'v1', active: true, mode: 'auto', capabilities: parent.capabilities };
  let calls = 0; const workerArgs = [];
  const events = [];
  const config = { parent, workspace, runtimeHome: root, skillProjection: { documents: [] }, provider: { model: 'test', apiKey: 'not-persisted' },
    readPolicy: async () => structuredClone(policy), getRun: async id => structuredClone(rows.get(id)),
    updateRun: async (id, fn) => { const next = fn(structuredClone(rows.get(id))); rows.set(id, next); return next; },
    signal: controller.signal, emit: event => events.push(event),
    runChild: async (child, childController, execute) => { rows.set(child.id, child); return execute(); },
    worker: { run: async args => { calls++; workerArgs.push(args); await args.onSession({ threadId: 'thread', turnId: null }); await args.onSession({ threadId: 'thread', turnId: 'turn' });
      return perform ? perform(args, { rows, revoke: () => { policy = { ...policy, version: 'v2', capabilities: { ...policy.capabilities, granted: ['project.read'] } }; } }) : propose(args); } } };
  const delegate = createCodexDelegation(config);
  return { root, workspace, rows, controller, delegate, config, events, workerArgs, calls: () => calls,
    setPolicy: patch => { policy = { ...policy, ...patch }; } };
}
async function propose(args) {
  const broker = await createDshFileBroker(args);
  try {
    const file = await broker.execute({ tool: 'project_read_file', callId: 'read', arguments: { path: 'main.tex' } });
    await broker.execute({ tool: 'project_propose_patch', callId: 'write', arguments: { path: 'main.tex', content: 'proposed', expectedSha256: file.sha256 } });
    return { ok: true, finalResponse: 'done', usage: { totalTokens: 42 }, output: { codex: { threadId: 'thread', turnId: 'turn' } } };
  } finally { await broker.close(); }
}

function admittedAutomaticProducer(f, { maxTokens = 100000, timeoutMs = 10000 } = {}) {
  const parent = f.config.parent, input = { codePreparationVersion: 2, protocolPath: 'protocol.json' };
  const scope = { allowedPaths: ['code'], maxTokens, timeoutMs, maxVersions: 2 };
  const auth = createCodeAuthorization({ projectId: parent.projectId,
    session: { id: 'auto-session', coordinatorRunId: 'coordinator', status: 'running' }, stage: 'replication', policyVersion: 2,
    policy: { enabled: true, overrides: { code: 'inherit' }, codeScope: scope }, inputSha256: sourceHash(input) });
  Object.assign(parent, { kind: 'research-stage', automationSessionId: auth.sessionId, parentRunId: auth.parentRunId, stage: auth.stage,
    role: 'experiment-code-producer', task: 'research:code-preparation', limits: { maxTokens, timeoutMs },
    request: { input, context: { codeAuthorization: auth, automationHandoff: { sessionId: auth.sessionId } } } });
  parent.capabilities = { ...parent.capabilities, allowedPaths: ['code', 'main.tex'], patchPaths: scope.allowedPaths };
  f.rows.set(parent.id, structuredClone(parent));
  f.setPolicy({ role: parent.role, task: parent.task, capabilities: parent.capabilities });
  return parent;
}
const noPatchResult = (totalTokens = 100) => ({ ok: true, finalResponse: 'Allocation fixture only', usage: { totalTokens }, output: { codex: { threadId: 'thread', turnId: 'turn' } } });

test('DSH delegates once per tool identity, records a child session and merges proposals into its own copy', async t => {
  const f = await fixture(t);
  const input = { task: 'change main.tex' }, options = { callId: 'call-1' };
  const [first, duplicate] = await Promise.all([f.delegate.run(input, options), f.delegate.run(input, options)]);
  assert.deepEqual(duplicate, first);
  assert.equal(f.calls(), 1);
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'proposed');
  const child = f.rows.get(first.runId);
  assert.equal(child.parentRunId, 'parent');
  assert.equal(child.kind, 'codex-worker');
  assert.equal(child.status, 'completed');
  assert.equal(child.output.proposalOwnerRunId, 'parent');
  assert.deepEqual(child.output.codex, { threadId: 'thread', turnId: 'turn' });
  assert.equal(child.patches[0].original, 'original');
  assert.equal(child.humanDecision.status, 'none');
  assert.ok(child.events.some(event => event.decision === 'allow'));
  assert.equal(JSON.stringify([...f.rows.values()]).includes('not-persisted'), false);
  assert.deepEqual(f.delegate.usage, { totalTokens: 42 });
  assert.equal((await fs.readdir(f.root)).filter(name => name.startsWith('delegated-')).length, 1);
  assert.equal(child.recovery.phase, 'handed-off');
  assert.equal(child.workerResult.finalResponse, 'done');
  assert.equal((await fs.stat(path.join(f.root, child.recovery.root, 'baseline', 'main.tex'))).isFile(), true);
  await assert.rejects(f.delegate.run({ task: 'different' }, options), { code: 'DELEGATION_ID_CONFLICT' });
});

test('current parent revocation prevents the worker proposal from reaching the parent copy', async t => {
  const f = await fixture(t, async (args, controls) => { const result = await propose(args); controls.revoke(); return result; });
  await assert.rejects(f.delegate.run({ task: 'edit' }, { callId: 'revoke' }), { code: 'CODEX_RECEIPT_POLICY_DENIED' });
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'original');
  assert.equal([...f.rows.values()][1].status, 'failed');
});

test('parent cancellation propagates to the worker and prevents merging', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, args => new Promise((resolve, reject) => { started(); args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true }); }));
  const result = f.delegate.run({ task: 'edit' }, { callId: 'cancel' });
  await ready;
  f.controller.abort(new Error('stop'));
  await assert.rejects(result, /stop/);
  assert.equal([...f.rows.values()][1].status, 'cancelled');
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'original');
});

test('worker budget is bounded by remaining parent usage, and exhaustion prevents another call', async t => {
  const f = await fixture(t, async args => { assert.equal(args.maxTokens, 19900); return { ok: true, usage: { totalTokens: 19901 } }; });
  f.rows.get('parent').events = [{ type: 'usage', usage: { totalTokens: 100 } }];
  await assert.rejects(f.delegate.run({ task: 'edit', maxTokens: 30000 }, { callId: 'budget' }), { code: 'HARNESS_BUDGET_EXHAUSTED' });
  await assert.rejects(f.delegate.run({ task: 'retry' }, { callId: 'budget2' }), { code: 'HARNESS_BUDGET_EXHAUSTED' });
  assert.equal(f.calls(), 1);
});

test('worker cannot choose provider or cwd, and concurrent parent changes cause a merge conflict', async t => {
  const f = await fixture(t, async args => { const result = await propose(args); await fs.writeFile(path.join(f.workspace, 'main.tex'), 'new parent text'); return result; });
  await assert.rejects(f.delegate.run({ task: 'edit', cwd: '/outside' }, { callId: 'invalid' }), { code: 'CODEX_WORKER_INPUT_INVALID' });
  assert.equal(f.calls(), 0);
  await assert.rejects(f.delegate.run({ task: 'edit' }, { callId: 'conflict' }), { code: 'CODEX_RECEIPT_INPUT_CONFLICT' });
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'new parent text');
});

test('unconfirmed worker termination retains private workspace for recovery', async t => {
  const f = await fixture(t, async () => { throw Object.assign(new Error('process still active'), { code: 'CODEX_STOP_FAILED' }); });
  await assert.rejects(f.delegate.run({ task: 'edit' }, { callId: 'stuck' }), { code: 'CODEX_STOP_FAILED' });
  assert.equal(f.delegate.preserveWorkspace, true);
  assert.deepEqual(f.delegate.usage, { totalTokens: 20000, estimated: true, reservedTokens: 20000, reportedTotalTokens: 0 });
  assert.deepEqual(f.rows.get('parent').workerTokenUsage, f.delegate.usage);
  assert.equal([...f.rows.values()][1].cleanup.workspaceRetained, true);
  assert.equal((await fs.readdir(f.root)).filter(name => name.startsWith('delegated-')).length, 1);
});


test('a completed worker result and immutable baseline survive a parent handoff failure', async t => {
  const f = await fixture(t, async args => { const result = await propose(args); await fs.writeFile(path.join(f.workspace, 'main.tex'), 'parent changed'); return result; });
  await assert.rejects(f.delegate.run({ task: 'edit' }, { callId: 'handoff-conflict' }), { code: 'CODEX_RECEIPT_INPUT_CONFLICT' });
  const child = [...f.rows.values()][1];
  assert.equal(child.workerResult.finalResponse, 'done'); assert.equal(child.recovery.phase, 'handoff-failed');
  assert.equal(child.recovery.workerCompleted, true);
  assert.equal(await fs.readFile(path.join(f.root, child.recovery.root, 'baseline', 'main.tex'), 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(f.root, child.recovery.root, 'workspace', 'main.tex'), 'utf8'), 'proposed');
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'parent changed');
});

test('an explicit continuation reuses an already handed-off task without resetting its budget or launching another worker', async t => {
  const f = await fixture(t);
  const first = await f.delegate.run({ task: 'change main.tex' }, { callId: 'original' });
  await f.delegate.close();
  const recovered = createCodexDelegation({ ...f.config, recoveredChildren: [{ runId: first.runId, task: 'change main.tex', reply: first.reply, usage: first.usage }] });
  t.after(() => recovered.close());
  const resumed = await recovered.run({ task: 'change main.tex', maxTokens: 128 }, { callId: 'new-session-call' });
  assert.equal(resumed.recovered, true); assert.equal(resumed.childRunId, first.runId);
  assert.equal(f.calls(), 1); assert.equal(f.rows.size, 2);
  assert.deepEqual(recovered.usage, { totalTokens: 42 });
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'proposed');
  f.rows.get(first.runId).recovery.phase = 'handoff-failed';
  await assert.rejects(recovered.run({ task: 'change main.tex' }, { callId: 'tampered-result' }), { code: 'CODEX_RECOVERY_RESULT_CONFLICT' });
  assert.equal(f.calls(), 1);
});

test('admitted automatic profile v2 allocates actual worker 80 percent tokens and 90 percent time independently of model hints', async t => {
  const f = await fixture(t, async args => { assert.equal(args.maxTokens, 80000); assert.equal(args.timeoutMs, 9000); return noPatchResult(14173); });
  admittedAutomaticProducer(f);
  const result = await f.delegate.run({ task: 'prepare authorized code', maxTokens: 6000, timeoutMs: 1000 }, { callId: 'auto-profile' });
  const child = f.rows.get(result.childRunId); assert.equal(child.limits.maxTokens, 80000); assert.equal(child.limits.timeoutMs, 9000);
  assert.equal(child.limits.retryLimit, 0); assert.equal(child.limits.maxConcurrent, 1); assert.equal(f.calls(), 1);
  assert.equal(child.status, 'completed'); assert.equal(f.delegate.usage.totalTokens, 14173); assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'original');
});

test('explicit larger code scopes reach the worker without the former 100000 token clamp', async t => {
  const f = await fixture(t, async args => { assert.equal(args.maxTokens, 200000); return noPatchResult(120000); });
  admittedAutomaticProducer(f, { maxTokens: 250000 });
  const result = await f.delegate.run({ task: 'prepare within the larger authorized scope', maxTokens: 200000 }, { callId: 'larger-budget' });
  assert.equal(result.status, 'completed');
  assert.equal(f.delegate.usage.totalTokens, 120000);
});

test('automatic allocation still obeys remaining parent usage and subsequent exhaustion rather than reserving unavailable budget', async t => {
  const f = await fixture(t, async args => { assert.equal(args.maxTokens, 5000); return noPatchResult(5000); });
  admittedAutomaticProducer(f); f.rows.get('parent').events = [{ type: 'usage', usage: { totalTokens: 95000 } }];
  await f.delegate.run({ task: 'remaining only', maxTokens: 100000 }, { callId: 'remaining' });
  await assert.rejects(f.delegate.run({ task: 'no remaining', maxTokens: 100000 }, { callId: 'exhausted' }), { code: 'HARNESS_BUDGET_EXHAUSTED' });
  assert.equal(f.calls(), 1);
});

test('automatic minimum allocation cannot exceed actual remaining tokens or the parent deadline', async t => {
  const f = await fixture(t, async args => { assert.equal(args.maxTokens, 128); assert.equal(args.timeoutMs, 9000); return noPatchResult(128); });
  admittedAutomaticProducer(f, { maxTokens: 128 }); await f.delegate.run({ task: 'small original scope' }, { callId: 'minimum' });
  assert.equal(f.calls(), 1);
  const exhausted = await fixture(t, async () => { assert.fail('remaining budget cannot fund a worker'); });
  admittedAutomaticProducer(exhausted); exhausted.rows.get('parent').events = [{ type: 'usage', usage: { totalTokens: 99873 } }];
  await assert.rejects(exhausted.delegate.run({ task: 'remaining below minimum' }, { callId: 'below-minimum' }), { code: 'HARNESS_BUDGET_EXHAUSTED' });
  assert.equal(exhausted.calls(), 0);
  const expired = await fixture(t, async () => { assert.fail('expired parent cannot start a worker'); }); admittedAutomaticProducer(expired);
  const originalNow = Date.now, instant = originalNow(); let reads = 0;
  Date.now = () => instant + (reads++ ? 10000 : 0);
  try {
    const timed = createCodexDelegation(expired.config);
    await assert.rejects(timed.run({ task: 'expired authorized deadline' }, { callId: 'deadline' }), { code: 'HARNESS_BUDGET_EXHAUSTED' }); assert.equal(expired.calls(), 0);
  } finally { Date.now = originalNow; }
});

test('unknown auth, roles and fake parent metadata cannot enable automatic worker allocation', async t => {
  for (const kind of ['role', 'schema', 'session', 'scope', 'input', 'policy', 'actual-run']) {
    const f = await fixture(t, async args => { assert.equal(args.maxTokens, 6000); assert.equal(args.timeoutMs, 1000); return noPatchResult(); });
    const parent = admittedAutomaticProducer(f);
    if (kind === 'role') { parent.role = 'project-agent'; f.rows.get('parent').role = parent.role; f.setPolicy({ role: parent.role }); }
    if (kind === 'schema') parent.request.context.codeAuthorization.schemaVersion = 99;
    if (kind === 'session') parent.request.context.codeAuthorization.sessionId = 'foreign-session';
    if (kind === 'scope') parent.request.context.codeAuthorization.scope.maxTokens = 1000;
    if (kind === 'input') parent.request.input.codePreparationVersion = 1;
    if (kind === 'policy') f.setPolicy({ runId: 'foreign-run' });
    if (kind === 'actual-run') f.rows.get('parent').kind = 'ordinary-run';
    await f.delegate.run({ task: `legacy allocation ${kind}`, maxTokens: 6000, timeoutMs: 1000 }, { callId: kind }); assert.equal(f.calls(), 1);
  }
});

test('ordinary manual allocation retains explicit worker token and time requests', async t => {
  const f = await fixture(t, async args => { assert.equal(args.maxTokens, 6000); assert.equal(args.timeoutMs, 1000); return noPatchResult(); });
  await f.delegate.run({ task: 'manual explicit smaller worker', maxTokens: 6000, timeoutMs: 1000 }, { callId: 'manual-explicit' });
  assert.equal(f.calls(), 1);
});
