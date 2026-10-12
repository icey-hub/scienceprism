import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodexDelegation } from '../src/services/harnessRuntime/codexDelegation.js';
import { createDshFileBroker } from '../src/services/harnessRuntime/dshFileBroker.js';

async function fixture(t, perform) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composition-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'parent');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'main.tex'), 'original');
  const parent = { id: 'parent', projectId: 'p', adapter: 'deepseek', status: 'running', role: 'project-agent', task: 'edit', attempt: 1,
    limits: { maxTokens: 20000, timeoutMs: 10000 }, capabilities: { granted: ['project.read', 'patch.propose'], allowedPaths: ['main.tex'], networkAllowlist: [] }, events: [] };
  const rows = new Map([[parent.id, structuredClone(parent)]]);
  const controller = new AbortController();
  let policy = { projectId: 'p', runId: 'parent', role: parent.role, task: parent.task, version: 'v1', active: true, mode: 'auto', capabilities: parent.capabilities };
  let calls = 0;
  const events = [];
  const delegate = createCodexDelegation({ parent, workspace, runtimeHome: root, skillProjection: { documents: [] }, provider: { model: 'test', apiKey: 'not-persisted' },
    readPolicy: async () => structuredClone(policy), getRun: async id => structuredClone(rows.get(id)),
    updateRun: async (id, fn) => { const next = fn(structuredClone(rows.get(id))); rows.set(id, next); return next; },
    signal: controller.signal, emit: event => events.push(event),
    runChild: async (child, childController, execute) => { rows.set(child.id, child); return execute(); },
    worker: { run: async args => { calls++; await args.onSession({ threadId: 'thread', turnId: null }); await args.onSession({ threadId: 'thread', turnId: 'turn' });
      return perform ? perform(args, { rows, revoke: () => { policy = { ...policy, version: 'v2', capabilities: { ...policy.capabilities, granted: ['project.read'] } }; } }) : propose(args); } } });
  return { root, workspace, rows, controller, delegate, events, calls: () => calls };
}
async function propose(args) {
  const broker = await createDshFileBroker(args);
  try {
    const file = await broker.execute({ tool: 'project_read_file', callId: 'read', arguments: { path: 'main.tex' } });
    await broker.execute({ tool: 'project_propose_patch', callId: 'write', arguments: { path: 'main.tex', content: 'proposed', expectedSha256: file.sha256 } });
    return { ok: true, finalResponse: 'done', usage: { totalTokens: 42 }, output: { codex: { threadId: 'thread', turnId: 'turn' } } };
  } finally { await broker.close(); }
}

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
  assert.equal((await fs.readdir(f.root)).some(name => name.startsWith('delegated-')), false);
  await assert.rejects(f.delegate.run({ task: 'different' }, options), { code: 'DELEGATION_ID_CONFLICT' });
});

test('current parent revocation prevents the worker proposal from reaching the parent copy', async t => {
  const f = await fixture(t, async (args, controls) => { const result = await propose(args); controls.revoke(); return result; });
  await assert.rejects(f.delegate.run({ task: 'edit' }, { callId: 'revoke' }), { code: 'CAPABILITY_DENIED' });
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
  await assert.rejects(f.delegate.run({ task: 'edit' }, { callId: 'conflict' }), { code: 'DSH_FILE_CONFLICT' });
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'new parent text');
});

test('unconfirmed worker termination retains private workspace for recovery', async t => {
  const f = await fixture(t, async () => { throw Object.assign(new Error('process still active'), { code: 'CODEX_STOP_FAILED' }); });
  await assert.rejects(f.delegate.run({ task: 'edit' }, { callId: 'stuck' }), { code: 'CODEX_STOP_FAILED' });
  assert.equal(f.delegate.preserveWorkspace, true);
  assert.equal([...f.rows.values()][1].cleanup.workspaceRetained, true);
  assert.equal((await fs.readdir(f.root)).filter(name => name.startsWith('delegated-')).length, 1);
});
