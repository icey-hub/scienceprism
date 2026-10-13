import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDshFileBroker } from '../src/services/harnessRuntime/dshFileBroker.js';
import { createCodexToolReceipts } from '../src/services/harnessRuntime/codexToolReceipts.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const binding = { projectId: 'controlled-code', parentRunId: 'parent', workerRunId: 'worker', threadId: 'thread', turnId: 'turn',
  workerVersion: 'test-worker', toolSchemaHash: hash('tools'), policyVersion: 1, role: 'replication-agent', task: 'code-preparation' };
const protocol = '{"paper":"Fisher","dataset":"fixed"}\n';
const read = { threadId: 'thread', turnId: 'turn', callId: 'read-protocol', tool: 'project_read_file', arguments: { path: 'protocol.json' } };
const proposal = (relative = 'code/experiments/baseline.py') => ({ threadId: 'thread', turnId: 'turn', callId: `patch:${relative}`, tool: 'project_propose_patch', arguments: { path: relative, content: 'print("fixed")\n', expectedSha256: null } });
async function fixture(t, options = {}) {
  const cache = path.resolve('.cache/controlled-code-path-tests'); await fs.mkdir(cache, { recursive: true });
  const root = await fs.mkdtemp(path.join(cache, 'case-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'protocol.json'), protocol); await fs.writeFile(path.join(workspace, 'main.tex'), 'original manuscript');
  const capabilities = { granted: ['project.read', 'patch.propose'], allowedPaths: ['code', 'outside', 'protocol.json', 'main.tex'], networkAllowlist: [] };
  if (!options.legacy) capabilities.patchPaths = Object.hasOwn(options, 'patchPaths') ? options.patchPaths : ['code'];
  let policy = { projectId: binding.projectId, runId: binding.workerRunId, role: binding.role, task: binding.task, active: true, mode: 'auto', version: 1, capabilities };
  const decisions = [], readPolicy = async () => structuredClone(policy);
  const setPatchPaths = value => { const next = { ...policy.capabilities }; if (value === 'remove') delete next.patchPaths; else next.patchPaths = value; policy = { ...policy, capabilities: next }; };
  const onDecision = async event => { decisions.push(event); await options.onDecision?.(event, setPatchPaths); };
  const broker = await createDshFileBroker({ workspace, readPolicy, onDecision }); t.after(() => broker.close());
  const directory = path.join(root, 'receipts'), receipts = await createCodexToolReceipts({ directory, workspace, binding, readPolicy, onDecision });
  const executeTool = call => broker.execute(call);
  return { root, workspace, directory, broker, receipts, executeTool, decisions, setPatchPaths, capabilities };
}

test('controlled producer reads a protocol but proposes only nested source code within its separate patch scope', async t => {
  const f = await fixture(t);
  assert.equal((await f.receipts.execute(read, { executeTool: f.executeTool })).content, protocol);
  const result = await f.receipts.execute(proposal(), { executeTool: f.executeTool }); assert.equal(result.proposed, true);
  assert.equal(await fs.readFile(path.join(f.workspace, proposal().arguments.path), 'utf8'), proposal().arguments.content);
  assert.equal(await fs.readFile(path.join(f.workspace, 'protocol.json'), 'utf8'), protocol);
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'original manuscript');
});

test('readable protocol and manuscript plus out-of-scope code and non-code outputs cannot receive proposals', async t => {
  const f = await fixture(t);
  for (const relative of ['outside/nested/other.py', 'code/new.tex', 'code/new.json', 'protocol.json', 'main.tex']) {
    const call = proposal(relative);
    if (relative === 'protocol.json') call.arguments.expectedSha256 = hash(protocol);
    if (relative === 'main.tex') call.arguments.expectedSha256 = hash('original manuscript');
    await assert.rejects(f.receipts.execute(call, { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_POLICY_DENIED' });
    await assert.rejects(f.broker.execute(call), { code: 'PATH_DENIED' });
  }
  assert.deepEqual((await fs.readdir(f.workspace)).sort(), ['main.tex', 'protocol.json']);
  assert.equal(await fs.readFile(path.join(f.workspace, 'protocol.json'), 'utf8'), protocol); assert.deepEqual(await fs.readdir(f.directory), []);
});

test('empty or invalid patch scopes never become wildcard permission while ordinary protocol reads remain available', async t => {
  for (const patchPaths of [[], [''], ['.'], ['../code'], ['code/../outside'], ['code\\nested'], ['.scienceprism'], null, undefined]) {
    const f = await fixture(t, { patchPaths });
    assert.equal((await f.receipts.execute(read, { executeTool: f.executeTool })).content, protocol);
    await assert.rejects(f.receipts.execute(proposal(), { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_POLICY_DENIED' });
    await assert.rejects(f.broker.execute(proposal()), { code: 'PATH_DENIED' });
    assert.deepEqual((await fs.readdir(f.workspace)).sort(), ['main.tex', 'protocol.json']);
  }
});

test('both receipt and broker retain initial code ceilings when current scopes expand', async t => {
  const f = await fixture(t);
  await f.receipts.execute(read, { executeTool: f.executeTool });
  f.setPatchPaths(['code', 'outside']); f.capabilities.patchPaths.push('outside');
  const call = proposal('outside/expansion.py');
  await assert.rejects(f.receipts.execute(call, { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_POLICY_DENIED' });
  await assert.rejects(f.broker.execute(call), { code: 'PATH_DENIED' });
  assert.deepEqual((await fs.readdir(f.workspace)).sort(), ['main.tex', 'protocol.json']);
});

test('scope revocation during persisted broker audit prevents parent creation and leaves the prepared fact unresolved', async t => {
  const f = await fixture(t, { onDecision: (event, change) => { if (event.tool === 'project_propose_patch' && event.decision === 'allow') change([]); } });
  await assert.rejects(f.receipts.execute(proposal(), { executeTool: f.executeTool }), { code: 'PATH_DENIED' });
  assert.deepEqual((await fs.readdir(f.workspace)).sort(), ['main.tex', 'protocol.json']);
  const record = JSON.parse(await fs.readFile(path.join(f.directory, 'tool-receipts.json'), 'utf8')); assert.equal(record.receipts[0].status, 'prepared');
});

test('removing an established patch scope cannot turn a controlled producer into an unrestricted manual Run', async t => {
  const f = await fixture(t); await f.receipts.execute(read, { executeTool: f.executeTool }); f.setPatchPaths('remove');
  await assert.rejects(f.receipts.execute(proposal(), { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_POLICY_DENIED' });
  await assert.rejects(f.broker.execute(proposal()), { code: 'PATH_DENIED' });
  assert.deepEqual((await fs.readdir(f.workspace)).sort(), ['main.tex', 'protocol.json']);
});

test('a completed code proposal cannot be replayed after its current proposal scope is revoked', async t => {
  const f = await fixture(t); await f.receipts.execute(proposal(), { executeTool: f.executeTool });
  const original = await fs.readFile(path.join(f.directory, 'tool-receipts.json')); f.setPatchPaths([]);
  await assert.rejects(f.receipts.execute(proposal(), { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_POLICY_DENIED' });
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'tool-receipts.json')), original);
  assert.equal(await fs.readFile(path.join(f.workspace, proposal().arguments.path), 'utf8'), proposal().arguments.content);
});

test('ordinary manual Runs without patchPaths retain non-code proposal behavior', async t => {
  const f = await fixture(t, { legacy: true }), call = proposal('main.tex'); call.arguments.expectedSha256 = hash('original manuscript');
  assert.equal((await f.receipts.execute(call, { executeTool: f.executeTool })).proposed, true);
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), call.arguments.content);
});
