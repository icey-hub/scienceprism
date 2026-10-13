import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDshFileBroker } from '../src/services/harnessRuntime/dshFileBroker.js';
import { createCodexToolReceipts } from '../src/services/harnessRuntime/codexToolReceipts.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const binding = { projectId: 'nested-project', parentRunId: 'parent', workerRunId: 'parent', threadId: 'thread', turnId: 'turn',
  workerVersion: 'scienceprism-codex-handoff-v1', toolSchemaHash: hash('schema'), policyVersion: 3, role: 'replication-agent', task: 'replication' };
const relative = 'experiments/nested/fisher.py', content = 'print("Fisher")\n';
const proposal = (callId = 'handoff') => ({ threadId: binding.threadId, turnId: binding.turnId, callId, tool: 'project_propose_patch',
  arguments: { path: relative, content, expectedSha256: null } });
async function fixture(t, options = {}) {
  const cache = path.resolve('.cache/nested-code-proposal-tests'); await fs.mkdir(cache, { recursive: true });
  const root = await fs.mkdtemp(path.join(cache, 'case-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), project = path.join(root, 'original'); await fs.mkdir(workspace); await fs.mkdir(project);
  let policy = { projectId: binding.projectId, runId: binding.workerRunId, role: binding.role, task: binding.task, version: binding.policyVersion,
    active: true, mode: 'auto', capabilities: { granted: ['project.read', 'patch.propose'], allowedPaths: ['experiments'], networkAllowlist: [] } };
  const readPolicy = async () => structuredClone(policy);
  const decisions = [], onDecision = async event => { decisions.push(event); await options.onDecision?.(event, value => { policy = { ...policy, ...value }; }); };
  const broker = await createDshFileBroker({ workspace, readPolicy, onDecision });
  t.after(() => broker.close());
  const config = { directory: path.join(root, 'receipts'), workspace, binding, readPolicy, onDecision };
  const receipts = await createCodexToolReceipts(config); let calls = 0;
  const executeTool = call => { calls++; return broker.execute(call); };
  return { root, workspace, project, broker, receipts, executeTool, config, decisions, count: () => calls,
    setPolicy: patch => { policy = { ...policy, ...patch }; } };
}

test('real receipt handoff creates a wholly missing nested suffix once and cold replay reconstructs actual evidence', async t => {
  const f = await fixture(t), first = await f.receipts.execute(proposal(), { executeTool: f.executeTool });
  assert.equal(first.sha256, hash(content)); assert.equal(first.proposed, true);
  assert.equal(await fs.readFile(path.join(f.workspace, relative), 'utf8'), content);
  assert.deepEqual(await fs.readdir(f.project), []);
  const reopened = await createCodexToolReceipts(f.config);
  assert.deepEqual(await reopened.execute(proposal(), { executeTool: f.executeTool }), first); assert.equal(f.count(), 1);
  assert.equal((await fs.lstat(path.join(f.workspace, relative))).nlink, 1);
  assert.deepEqual(await reopened.assertSettled(), { receiptCount: 1, paths: [relative] });
  const persisted = JSON.parse(await fs.readFile(path.join(f.config.directory, 'tool-receipts.json'), 'utf8'));
  assert.equal(persisted.receipts[0].beforeSha256, null); assert.equal(persisted.receipts[0].status, 'completed');
});

test('missing reads and read-only proposals never create parent directories', async t => {
  const f = await fixture(t);
  const read = { threadId: binding.threadId, turnId: binding.turnId, callId: 'missing-read', tool: 'project_read_file', arguments: { path: relative } };
  await assert.rejects(f.receipts.execute(read, { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_FILE_NOT_FOUND' });
  assert.equal(f.decisions[0].decision, 'allow'); assert.equal(f.decisions[0].path, relative);
  assert.deepEqual(await fs.readdir(f.config.directory), []);
  await assert.rejects(f.broker.execute(read), { code: 'DSH_FILE_UNAVAILABLE' });
  f.setPolicy({ capabilities: { granted: ['project.read'], allowedPaths: ['experiments'], networkAllowlist: [] } });
  await assert.rejects(f.receipts.execute(proposal(), { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_POLICY_DENIED' });
  await assert.rejects(f.broker.execute(proposal()), { code: 'CAPABILITY_DENIED' });
  assert.deepEqual(await fs.readdir(f.workspace), []); assert.equal(f.count(), 0);
});

test('only fresh relative absence is recoverable; completed evidence loss and a broken workspace root remain fatal', async t => {
  const f = await fixture(t); await f.receipts.execute(proposal(), { executeTool: f.executeTool });
  const read = { threadId: binding.threadId, turnId: binding.turnId, callId: 'stored-read', tool: 'project_read_file', arguments: { path: relative } };
  await f.receipts.execute(read, { executeTool: f.executeTool });
  await fs.unlink(path.join(f.workspace, relative));
  await assert.rejects(f.receipts.execute(read, { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_RESULT_UNAVAILABLE' });
  assert.equal(f.count(), 2);
  await fs.rename(f.workspace, `${f.workspace}-preserved`);
  await assert.rejects(f.receipts.execute({ ...read, callId: 'fresh-root-missing' }, { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_RESULT_UNAVAILABLE' });
  assert.equal(f.count(), 2);
});

test('missing read audit failure or revocation cannot produce a recoverable observation or create directories', async t => {
  const read = { threadId: binding.threadId, turnId: binding.turnId, callId: 'missing-read', tool: 'project_read_file', arguments: { path: relative } };
  const failed = await fixture(t, { onDecision: () => { throw new Error('disk failure'); } });
  await assert.rejects(failed.receipts.execute(read, { executeTool: failed.executeTool }), { code: 'CODEX_RECEIPT_AUDIT_UNAVAILABLE' });
  const revoked = await fixture(t, { onDecision: (_event, setPolicy) => setPolicy({ active: false }) });
  await assert.rejects(revoked.receipts.execute(read, { executeTool: revoked.executeTool }), { code: 'CODEX_RECEIPT_POLICY_DENIED' });
  for (const f of [failed, revoked]) { assert.deepEqual(await fs.readdir(f.workspace), []); assert.deepEqual(await fs.readdir(f.config.directory), []); assert.equal(f.count(), 0); }
});

test('canonical and actual allowed paths are enforced before nested creation', async t => {
  const f = await fixture(t);
  for (const unsafe of ['other/new.py', '../experiments/new.py', 'experiments/../new.py', 'experiments\\new.py', '.scienceprism/new.py']) {
    const call = { ...proposal(unsafe), arguments: { ...proposal().arguments, path: unsafe } };
    await assert.rejects(f.receipts.execute(call, { executeTool: f.executeTool }));
    await assert.rejects(f.broker.execute(call));
  }
  assert.deepEqual(await fs.readdir(f.workspace), []); assert.deepEqual(await fs.readdir(f.project), []);
});

test('symbolic parents and existing ordinary or hard-linked leaves preserve all existing content', async t => {
  for (const kind of ['parent', 'leaf', 'hard']) {
    const f = await fixture(t), preserved = path.join(f.root, 'preserved'); await fs.mkdir(preserved); await fs.writeFile(path.join(preserved, 'note.py'), 'preserve');
    if (kind === 'parent') await fs.symlink(preserved, path.join(f.workspace, 'experiments'));
    else {
      const target = path.join(f.workspace, relative); await fs.mkdir(path.dirname(target), { recursive: true });
      if (kind === 'leaf') await fs.writeFile(target, 'existing'); else await fs.link(path.join(preserved, 'note.py'), target);
    }
    await assert.rejects(f.receipts.execute(proposal(), { executeTool: f.executeTool }));
    await assert.rejects(f.broker.execute(proposal()));
    assert.equal(await fs.readFile(path.join(preserved, 'note.py'), 'utf8'), 'preserve');
    assert.deepEqual(await fs.readdir(preserved), ['note.py']);
    if (kind !== 'parent') assert.equal(await fs.readFile(path.join(f.workspace, relative), 'utf8'), kind === 'leaf' ? 'existing' : 'preserve');
    assert.deepEqual(await fs.readdir(f.project), []);
  }
});

test('revocation during persisted broker audit stops nested directory creation and retains an ambiguous handoff', async t => {
  const f = await fixture(t, { onDecision: (event, setPolicy) => { if (event.decision === 'allow') setPolicy({ active: false }); } });
  await assert.rejects(f.receipts.execute(proposal(), { executeTool: f.executeTool }), { code: 'DSH_RUN_INACTIVE' });
  assert.deepEqual(await fs.readdir(f.workspace), []); assert.deepEqual(await fs.readdir(f.project), []);
  const state = JSON.parse(await fs.readFile(path.join(f.config.directory, 'tool-receipts.json'), 'utf8'));
  assert.equal(state.receipts.length, 1); assert.equal(state.receipts[0].status, 'prepared');
  f.setPolicy({ active: true });
  await assert.rejects((await createCodexToolReceipts(f.config)).execute(proposal(), { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_AMBIGUOUS' });
  assert.equal(f.count(), 1); assert.deepEqual(await fs.readdir(f.workspace), []);
});
