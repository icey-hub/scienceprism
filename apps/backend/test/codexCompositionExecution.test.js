import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
await fs.mkdir(path.join(repository, '.cache'), { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(repository, '.cache/codex-composition-execution-'));
const oldData = process.env.SCIENCEPRISM_DATA_DIR;
const oldExecutable = process.env.SCIENCEPRISM_CODEX_EXECUTABLE;
process.env.SCIENCEPRISM_DATA_DIR = dataRoot;
// The executor checks whether composition is configured. The injected worker
// below never launches this path, a CLI, a network request, or a model.
process.env.SCIENCEPRISM_CODEX_EXECUTABLE = '/fixture/not-executed-codex';
const { createRunExecutor } = await import('../src/services/harnessRuntime/execution.js');
const { createDshFileBroker } = await import('../src/services/harnessRuntime/dshFileBroker.js');
const { createRunRecovery } = await import('../src/services/harnessRuntime/runRecovery.js');
after(async () => {
  await fs.rm(dataRoot, { recursive: true, force: true });
  if (oldData === undefined) delete process.env.SCIENCEPRISM_DATA_DIR; else process.env.SCIENCEPRISM_DATA_DIR = oldData;
  if (oldExecutable === undefined) delete process.env.SCIENCEPRISM_CODEX_EXECUTABLE; else process.env.SCIENCEPRISM_CODEX_EXECUTABLE = oldExecutable;
});

async function fixture(id, granted, adapterRun, workerRun, { stopTimeoutMs = 1000 } = {}) {
  const root = path.join(dataRoot, id);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id }));
  await fs.writeFile(path.join(root, 'main.tex'), 'private manuscript must stay in its project');
  const run = { id: `${id}-parent`, projectId: id, adapter: 'deepseek', status: 'running', attempt: 1,
    task: granted.length ? 'custom' : 'skill_recommendation', role: 'project-agent', events: [], patches: [],
    capabilities: { granted, denied: [], allowedPaths: [], networkAllowlist: [] },
    limits: { maxTokens: 1000, timeoutMs: 10000, retryLimit: 0 }, contextPack: { files: [] }, skills: [], fallback: false };
  const rows = new Map([[run.id, structuredClone(run)]]);
  const controller = new AbortController();
  const control = { controller, cancelRequested: false, pauseRequested: false, timeoutError: null, violation: null };
  let workerCalls = 0;
  const execute = createRunExecutor({
    getRun: async (_projectId, runId) => structuredClone(rows.get(runId)),
    updateRun: async (_projectId, runId, update) => { const next = update(structuredClone(rows.get(runId))); rows.set(runId, next); return structuredClone(next); },
    adapterFor: adapter => { assert.equal(adapter, 'deepseek'); return { run: adapterRun }; },
    forgetRequest: () => {}, stopTimeoutMs, readProjectConstraints: async () => ({ capabilities: ['project.read', 'patch.propose'] }),
    runChild: async (child, _controller, work) => { rows.set(child.id, structuredClone(child)); return work(); },
    codexWorker: () => ({ run: async args => {
      workerCalls += 1; await args.onSession({ threadId: 'fixture-thread', turnId: 'fixture-turn' });
      let terminalStatus = 'failed'; let stopConfirmed = true;
      try { const result = await workerRun(args); terminalStatus = 'completed'; await args.onResult(result); return result; }
      catch (error) { if (error.code === 'CODEX_STOP_FAILED') stopConfirmed = false; throw error; }
      finally { await args.onStorage({ pid: null, phase: stopConfirmed ? 'stopped' : 'stop-unconfirmed', stopConfirmed, terminalStatus }); }
    } })
  });
  return { root, rows, controller, control, run: () => execute(id, run.id, { projectId: id, task: run.task, prompt: 'Use only the supplied task.', researchSkills: [],
    llmConfig: { endpoint: 'http://127.0.0.1:9/v1/chat/completions', model: 'fixture-model', apiKey: 'fixture-no-network' } }, control), workerCalls: () => workerCalls };
}

test('successful parent execution retains worker history, immutable baselines and handoff receipts without applying the original project', async () => {
  let workspace; let childId;
  const original = 'private manuscript must stay in its project';
  const f = await fixture('retained-success', ['project.read', 'patch.propose'], async args => {
    workspace = args.workspace;
    const result = await args.delegateCodex({ task: 'Propose the bounded edit.', maxTokens: 128 }, { callId: 'retained-success' });
    childId = result.childRunId;
    assert.equal(await fs.readFile(path.join(workspace, 'main.tex'), 'utf8'), 'a proposed manuscript');
    return { ok: true, finalResponse: 'The proposal is ready for review.', usage: { totalTokens: 10 } };
  }, async args => {
    const broker = await createDshFileBroker(args);
    try {
      const file = await broker.execute({ tool: 'project_read_file', callId: 'read', arguments: { path: 'main.tex' } });
      await broker.execute({ tool: 'project_propose_patch', callId: 'write', arguments: { path: 'main.tex', content: 'a proposed manuscript', expectedSha256: file.sha256 } });
      return { ok: true, finalResponse: 'Worker proposal complete.', usage: { totalTokens: 20 }, output: { codex: { threadId: 'fixture-thread', turnId: 'fixture-turn' } } };
    } finally { await broker.close(); }
  });
  const result = await f.run();
  assert.equal(result.status, 'completed'); assert.equal(result.patches.length, 1);
  assert.equal(result.patches[0].original, original); assert.equal(result.patches[0].content, 'a proposed manuscript');
  assert.equal(await fs.readFile(path.join(f.root, 'main.tex'), 'utf8'), original);
  const root = path.dirname(workspace);
  const checkpoint = JSON.parse(await fs.readFile(path.join(root, 'checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.status, 'completed'); assert.equal(checkpoint.stopConfirmed, true);
  assert.equal(checkpoint.children.length, 1); assert.equal(checkpoint.children[0].runId, childId);
  assert.equal(checkpoint.children[0].stopConfirmed, true); assert.equal(checkpoint.children[0].status, 'completed');
  assert.equal(await fs.readFile(path.join(root, 'baseline', 'main.tex'), 'utf8'), original);
  const child = f.rows.get(childId);
  assert.equal(child.workerResult.finalResponse, 'Worker proposal complete.'); assert.equal(child.recovery.phase, 'handed-off');
  const childRoot = path.join(root, child.recovery.root);
  assert.equal(await fs.readFile(path.join(childRoot, 'baseline', 'main.tex'), 'utf8'), original);
  assert.equal(await fs.readFile(path.join(childRoot, 'workspace', 'main.tex'), 'utf8'), 'a proposed manuscript');
  assert.ok((await fs.readdir(path.join(childRoot, 'handoff-receipts'))).length > 0);
});

test('metadata-only DSH execution creates an empty workspace and never copies or reads manuscript files', async t => {
  let inspected = false;
  const f = await fixture('input-only', [], async args => {
    assert.deepEqual(args.capabilities, []);
    assert.deepEqual(await fs.readdir(args.workspace), []);
    assert.equal(args.delegateCodex, undefined);
    assert.deepEqual(args.skillProjection.documents, []);
    inspected = true;
    return { ok: true, finalResponse: 'Compared the supplied candidate metadata.', usage: { totalTokens: 20 } };
  }, () => assert.fail('A metadata-only task must not launch a coding worker'));
  const copies = []; const reads = [];
  const copy = fs.cp.bind(fs); const read = fs.readFile.bind(fs);
  t.mock.method(fs, 'cp', (...args) => { copies.push(String(args[0])); return copy(...args); });
  t.mock.method(fs, 'readFile', (...args) => { reads.push(String(args[0])); return read(...args); });
  const result = await f.run();
  assert.equal(result.status, 'completed'); assert.equal(inspected, true);
  assert.deepEqual(result.patches, []); assert.equal(f.workerCalls(), 0);
  assert.equal(copies.some(source => source === f.root || source.startsWith(`${f.root}${path.sep}`)), false);
  assert.equal(reads.includes(path.join(f.root, 'main.tex')), false);
});

test('parent final usage plus its completed worker cannot mark an over-budget DSH Run completed', async () => {
  let childId;
  const f = await fixture('combined-final-budget', ['project.read', 'patch.propose'], async args => {
    args.emit({ type: 'usage', data: { usage: { totalTokens: 100 } } });
    const child = await args.delegateCodex({ task: 'Inspect the allowed project copy.', maxTokens: 800 }, { callId: 'fixture-final-budget' });
    childId = child.childRunId;
    return { ok: true, finalResponse: 'This exceeds the shared budget.', usage: { totalTokens: 400 } };
  }, async args => {
    assert.equal(args.maxTokens, 800);
    return { ok: true, finalResponse: 'Worker done.', usage: { totalTokens: 800 } };
  });
  const result = await f.run();
  assert.equal(f.workerCalls(), 1);
  assert.equal(f.rows.get(childId).status, 'completed');
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'HARNESS_BUDGET_EXHAUSTED');
  assert.deepEqual(result.error.details, { maxTokens: 1000, parentTokens: 400, workerAccountedTokens: 800 });
  assert.equal(result.reply, undefined);
  assert.deepEqual(result.patches, []);
  assert.equal(await fs.readFile(path.join(f.root, 'main.tex'), 'utf8'), 'private manuscript must stay in its project');
});

test('continuation preserves previously saved final usage when the adapter did not stream usage events', async () => {
  let calls = 0;
  const f = await fixture('saved-parent-budget', ['project.read', 'patch.propose'], async args => {
    calls++;
    if (calls === 2) assert.equal(args.limits.maxTokens, 10, 'The prior 990 tokens must stay charged.');
    return { ok: true, finalResponse: 'Finished.', usage: { totalTokens: calls === 1 ? 990 : 1 } };
  });
  const first = await f.run(); assert.equal(first.status, 'completed'); assert.equal(first.tokenUsage.totalTokens, 990);
  f.rows.get(first.id).status = 'failed';
  const recover = createRunRecovery({ getRun: async (_project, id) => structuredClone(f.rows.get(id)),
    updateRun: async (_project, id, update) => { const row = await update(structuredClone(f.rows.get(id))); f.rows.set(id, row); return structuredClone(row); },
    readProjectConstraints: async () => ({ capabilities: ['project.read', 'patch.propose'] }), resolveProjectRoot: async () => f.root, worker: {} });
  await recover(first.projectId, first.id);
  f.rows.get(first.id).status = 'running'; f.control.controller = new AbortController();
  const continued = await f.run();
  assert.equal(continued.status, 'completed'); assert.equal(continued.attempt, 1);
  assert.equal(continued.tokenUsage.parentTotalTokens, 991); assert.equal(continued.tokenUsage.totalTokens, 991);
});

test('parent usage notifications stop the combined Run as soon as the worker-inclusive budget is exceeded', async () => {
  let notified = false;
  const f = await fixture('combined-stream-budget', ['project.read', 'patch.propose'], async args => {
    args.emit({ type: 'usage', data: { usage: { totalTokens: 100 } } });
    await args.delegateCodex({ task: 'Inspect the allowed copy.', maxTokens: 800 }, { callId: 'fixture-stream-budget' });
    args.emit({ type: 'usage', data: { usage: { totalTokens: 101 } } });
    assert.equal(args.signal.aborted, true);
    assert.equal(args.signal.reason.code, 'HARNESS_BUDGET_EXHAUSTED');
    notified = true;
    args.signal.throwIfAborted();
  }, async () => ({ ok: true, usage: { totalTokens: 800 } }));
  const result = await f.run();
  assert.equal(notified, true); assert.equal(f.workerCalls(), 1);
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'HARNESS_BUDGET_EXHAUSTED');
});

test('cancellation keeps the workspace and executing promise until a slow adapter confirms shutdown', async () => {
  let workspace; let finish; let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture('slow-stop', ['project.read'], args => {
    workspace = args.workspace; entered();
    return new Promise(resolve => { finish = () => resolve({ ok: true, usage: { totalTokens: 10 } }); });
  });
  let settled = false;
  const completion = f.run().finally(() => { settled = true; });
  await ready;
  f.controller.abort(Object.assign(new Error('User requested cancellation.'), { code: 'HARNESS_CANCELLED' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false, 'The executor must wait for adapter shutdown, not just signal delivery.');
  assert.equal((await fs.stat(workspace)).isDirectory(), true);
  finish();
  const result = await completion;
  assert.equal(result.status, 'cancelled');
  assert.notEqual(f.control.stopUnconfirmed, true);
  assert.equal((await fs.stat(workspace)).isDirectory(), true);
  const checkpoint = JSON.parse(await fs.readFile(path.join(path.dirname(workspace), 'checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.status, 'cancelled'); assert.equal(checkpoint.stopConfirmed, true);
});

test('unconfirmed shutdown retains the private workspace and marks its model slot retained', async t => {
  let workspace; let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture('unconfirmed-stop', ['project.read'], args => {
    workspace = args.workspace; entered();
    // A pending fixture promise represents an adapter whose close never settles;
    // no process or model exists, so the test may safely remove its retained files.
    return new Promise(() => {});
  }, undefined, { stopTimeoutMs: 20 });
  const completion = f.run(); await ready;
  t.after(() => fs.rm(path.dirname(workspace), { recursive: true, force: true }));
  f.controller.abort(Object.assign(new Error('User requested cancellation.'), { code: 'HARNESS_CANCELLED' }));
  const result = await completion;
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'HARNESS_STOP_UNCONFIRMED');
  assert.equal(f.control.stopUnconfirmed, true);
  assert.deepEqual(result.cleanup, { status: 'process-stop-unconfirmed', workspaceRetained: true, modelSlotRetained: true });
  assert.equal((await fs.stat(workspace)).isDirectory(), true);
});

test('an unconfirmed worker stop aborts the parent before DSH can continue after a tool error', async t => {
  let workspace; let parentInterrupted = false;
  const f = await fixture('worker-stop-fatal', ['project.read', 'patch.propose'], async args => {
    workspace = args.workspace;
    await assert.rejects(args.delegateCodex({ task: 'Inspect the copy.', maxTokens: 128 }, { callId: 'fixture-worker-stop' }), { code: 'CODEX_STOP_FAILED' });
    // DSH ordinarily observes tool failures and can continue its agent loop.
    // A possibly living worker must instead synchronously abort its parent.
    assert.equal(args.signal.aborted, true);
    assert.equal(args.signal.reason.code, 'HARNESS_STOP_UNCONFIRMED');
    parentInterrupted = true;
    return { ok: true, finalResponse: 'Must never become a completed parent.', usage: { totalTokens: 10 } };
  }, async () => { throw Object.assign(new Error('Fixture process stop was not confirmed.'), { code: 'CODEX_STOP_FAILED' }); });
  t.after(() => workspace && fs.rm(path.dirname(workspace), { recursive: true, force: true }));
  const result = await f.run();
  assert.equal(parentInterrupted, true); assert.equal(f.workerCalls(), 1);
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'HARNESS_STOP_UNCONFIRMED');
  assert.equal(f.control.stopUnconfirmed, true);
  assert.equal(result.cleanup.modelSlotRetained, true);
  assert.equal(result.cleanup.workspaceRetained, true);
});
