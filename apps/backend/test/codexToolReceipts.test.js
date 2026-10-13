import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createCodexToolReceipts } from '../src/services/harnessRuntime/codexToolReceipts.js';
import { createDshFileBroker } from '../src/services/harnessRuntime/dshFileBroker.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const binding = { projectId: 'project', parentRunId: 'parent', workerRunId: 'worker', threadId: 'thread', turnId: 'turn',
  workerVersion: 'fixture-version', toolSchemaHash: sha('schema'), policyVersion: 'v1', role: 'writer', task: 'draft' };
const read = (id = 'read') => ({ threadId: 'thread', turnId: 'turn', callId: id, tool: 'project_read_file', arguments: { path: 'main.tex' } });
const patch = (id = 'patch') => ({ threadId: 'thread', turnId: 'turn', callId: id, tool: 'project_propose_patch', arguments: { path: 'main.tex', content: 'new', expectedSha256: sha('old') } });

async function fixture(t, options = {}) {
  const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/runtime-receipts/', import.meta.url));
  await fs.mkdir(cache, { recursive: true });
  const root = await fs.mkdtemp(path.join(cache, 'test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'main.tex'), 'old');
  let policy = { projectId: 'project', runId: 'worker', role: 'writer', task: 'draft', version: 'v1', active: true, mode: 'auto',
    capabilities: { granted: ['project.read', 'patch.propose'], allowedPaths: ['main.tex'], networkAllowlist: [] } };
  const readPolicy = async () => structuredClone(policy);
  const directory = path.join(root, 'receipts');
  const config = { directory, workspace, binding, readPolicy, ...options };
  const broker = await createDshFileBroker({ workspace, readPolicy, onDecision: async () => {} });
  t.after(() => broker.close());
  let executions = 0;
  const executeTool = async call => { executions++; return broker.execute(call); };
  return { root, directory, workspace, config, broker, executeTool, count: () => executions,
    setPolicy: value => { policy = { ...policy, ...value }; }, create: () => createCodexToolReceipts(config) };
}

test('durable reads and proposals use the real broker once, and reconstruct proven results after reopening', async t => {
  const f = await fixture(t); const receipts = await f.create();
  const original = await receipts.execute(read(), { executeTool: f.executeTool });
  assert.equal(original.content, 'old');
  const reopened = await f.create();
  assert.deepEqual(await reopened.execute(read(), { executeTool: f.executeTool }), original);
  assert.equal(f.count(), 1);
  const proposal = await reopened.execute(patch(), { executeTool: f.executeTool });
  assert.equal(proposal.proposed, true); assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'new');
  assert.deepEqual(await (await f.create()).execute(patch(), { executeTool: f.executeTool }), proposal);
  assert.equal(f.count(), 2);
  await assert.rejects(reopened.execute(read(), { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_RESULT_UNAVAILABLE' });
  assert.equal(f.count(), 2);
  const disk = await fs.readFile(path.join(f.directory, 'tool-receipts.json'), 'utf8');
  assert.ok(!disk.includes('"content":')); assert.ok(!disk.includes('"old"')); assert.ok(!disk.includes('"new"'));
  const stored = JSON.parse(disk); assert.equal(stored.receipts[1].beforeSha256, sha('old'));
  assert.equal(stored.receipts[1].afterSha256, sha('new'));
  assert.equal((await fs.stat(path.join(f.directory, 'tool-receipts.json'))).mode & 0o777, 0o600);
});

test('canonical parameters deduplicate concurrent instances, while changed parameters or binding are denied', async t => {
  const f = await fixture(t); const a = await f.create(); const b = await f.create();
  const expanded = { ...read(), arguments: { toLine: 1000, path: 'main.tex', fromLine: 1 } };
  const results = await Promise.all([a.execute(read(), { executeTool: f.executeTool }), b.execute(expanded, { executeTool: f.executeTool })]);
  assert.deepEqual(results[0], results[1]); assert.equal(f.count(), 1);
  await assert.rejects(a.execute({ ...read(), arguments: { path: 'main.tex', toLine: 1 } }, { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_IDENTITY_CONFLICT' });
  for (const key of ['threadId', 'turnId']) await assert.rejects(a.execute({ ...read(), [key]: 'other' }, { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_IDENTITY_CONFLICT' });
  for (const key of ['parentRunId', 'workerRunId', 'workerVersion', 'toolSchemaHash']) {
    const changed = { ...binding, [key]: key === 'toolSchemaHash' ? sha('other') : 'other' };
    await assert.rejects(async () => (await createCodexToolReceipts({ ...f.config, binding: changed,
      readPolicy: async () => ({ ...(await f.config.readPolicy()), runId: changed.workerRunId }) })).execute(read(), { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_IDENTITY_CONFLICT' });
  }
  assert.equal(f.count(), 1);
});

test('side effect followed by a lost result remains ambiguous and is never reexecuted', async t => {
  const f = await fixture(t); const receipts = await f.create();
  await assert.rejects(receipts.execute(patch(), { executeTool: async call => { await f.executeTool(call); throw new Error('connection lost with private details'); } }));
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'new');
  const disk = JSON.parse(await fs.readFile(path.join(f.directory, 'tool-receipts.json'), 'utf8'));
  assert.equal(disk.receipts[0].status, 'prepared');
  await assert.rejects((await f.create()).execute(patch(), { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_AMBIGUOUS' });
  assert.equal(f.count(), 1);
  assert.ok(!JSON.stringify(disk).includes('private details'));
});

test('revocation, policy changes, inactive ownership and cancellation deny replays without modifying receipts', async t => {
  const f = await fixture(t); const receipts = await f.create();
  await receipts.execute(read(), { executeTool: f.executeTool });
  const file = path.join(f.directory, 'tool-receipts.json'); const original = await fs.readFile(file);
  for (const changed of [{ active: false }, { active: 'true' }, { version: 'v2' }, { runId: 'other' }, { mode: 'manual' },
    { capabilities: { granted: 'project.read', allowedPaths: ['main.tex'], networkAllowlist: [] } },
    { capabilities: { granted: [], allowedPaths: [], networkAllowlist: [] } }]) {
    const restore = { active: true, version: 'v1', runId: 'worker', mode: 'auto', capabilities: { granted: ['project.read', 'patch.propose'], allowedPaths: ['main.tex'], networkAllowlist: [] } };
    f.setPolicy(changed);
    await assert.rejects(receipts.execute(read(), { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_POLICY_DENIED' });
    assert.deepEqual(await fs.readFile(file), original); f.setPolicy(restore);
  }
  await assert.rejects(receipts.execute(read(), { executeTool: f.executeTool, signal: AbortSignal.abort() }), { code: 'CODEX_RECEIPT_CANCELLED' });
  assert.deepEqual(await fs.readFile(file), original); assert.equal(f.count(), 1);
});

test('prepared identity is durable before the broker runs and policy is checked again before dispatch', async t => {
  const f = await fixture(t); let checks = 0;
  const receipts = await createCodexToolReceipts({ ...f.config, readPolicy: async () => {
    checks++;
    return { projectId: 'project', runId: 'worker', role: 'writer', task: 'draft', version: 'v1', active: checks < 2, mode: 'auto', capabilities: { granted: ['project.read', 'patch.propose'], allowedPaths: ['main.tex'], networkAllowlist: [] } };
  } });
  await assert.rejects(receipts.execute(patch(), { executeTool: async () => { assert.fail('revoked operation dispatched'); } }), { code: 'CODEX_RECEIPT_POLICY_DENIED' });
  const disk = JSON.parse(await fs.readFile(path.join(f.directory, 'tool-receipts.json'), 'utf8'));
  assert.equal(disk.receipts[0].status, 'prepared'); assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'old');
});

test('completed results need actual unchanged file evidence and never accept a fabricated broker response', async t => {
  const f = await fixture(t); const receipts = await f.create();
  await assert.rejects(receipts.execute(patch(), { executeTool: async () => ({ path: 'main.tex', sha256: sha('new'), byteLength: 3, proposed: true }) }), { code: 'CODEX_RECEIPT_RESULT_UNAVAILABLE' });
  await assert.rejects((await f.create()).execute(patch(), { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_AMBIGUOUS' });
  assert.equal(f.count(), 0);
});

test('capacity rejects a new identity but retains completed replays', async t => {
  const f = await fixture(t, { maxReceipts: 1 }); const receipts = await f.create();
  await receipts.execute(read(), { executeTool: f.executeTool });
  await assert.rejects(receipts.execute(read('other'), { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_CAPACITY' });
  assert.equal((await receipts.execute(read(), { executeTool: f.executeTool })).content, 'old'); assert.equal(f.count(), 1);
});

test('unsafe arguments and sensitive paths never reach the broker or persist request text', async t => {
  const f = await fixture(t); const receipts = await f.create();
  for (const args of [{ path: '../main.tex' }, { path: '.env' }, { path: 'main.tex', apiKey: 'secret' }, { path: 'main.tex', fromLine: 0 }, { path: 'main.tex', toLine: 1001 }]) {
    await assert.rejects(receipts.execute({ ...read(), arguments: args }, { executeTool: f.executeTool }));
  }
  await assert.rejects(receipts.execute({ ...read(), tool: 'shell' }, { executeTool: f.executeTool }));
  assert.equal(f.count(), 0);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('corrupt, oversize and linked receipt files are preserved and never bypass duplicate guards', async t => {
  for (const kind of ['corrupt', 'oversize', 'symlink', 'hardlink']) {
    const f = await fixture(t); const receipts = await f.create(); const file = path.join(f.directory, 'tool-receipts.json');
    const original = kind === 'oversize' ? ' '.repeat(4_194_305) : '{broken';
    const other = path.join(f.root, 'existing.json'); await fs.writeFile(other, original);
    if (kind === 'symlink') await fs.symlink(other, file);
    else if (kind === 'hardlink') await fs.link(other, file);
    else await fs.writeFile(file, original);
    await assert.rejects(receipts.execute(read(), { executeTool: f.executeTool }));
    assert.equal(await fs.readFile(other, 'utf8'), original); assert.equal(await fs.readFile(file, 'utf8'), original); assert.equal(f.count(), 0);
  }
});

test('cancellation after the real proposal retains its completed fact and later replay never repeats the effect', async t => {
  const f = await fixture(t); const receipts = await f.create(); const controller = new AbortController();
  await assert.rejects(receipts.execute(patch(), { signal: controller.signal, executeTool: async call => {
    const result = await f.executeTool(call); controller.abort(); return result;
  } }), { code: 'CODEX_RECEIPT_CANCELLED' });
  assert.equal(f.count(), 1); assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'new');
  const disk = JSON.parse(await fs.readFile(path.join(f.directory, 'tool-receipts.json'), 'utf8'));
  assert.equal(disk.receipts[0].status, 'completed');
  assert.equal((await (await f.create()).execute(patch(), { executeTool: f.executeTool })).sha256, sha('new'));
  assert.equal(f.count(), 1);
});

test('disk failure after a file effect cannot return success and cannot redispatch', async t => {
  const f = await fixture(t); const receipts = await f.create(); const file = path.join(f.directory, 'tool-receipts.json');
  const retained = path.join(f.root, 'retained-prepared.json');
  await assert.rejects(receipts.execute(patch(), { executeTool: async call => {
    const result = await f.executeTool(call);
    await fs.rename(file, retained); await fs.symlink(retained, file);
    return result;
  } }), { code: 'CODEX_RECEIPT_STORAGE_INVALID' });
  assert.equal(f.count(), 1); assert.equal(JSON.parse(await fs.readFile(retained, 'utf8')).receipts[0].status, 'prepared');
  await fs.unlink(file); await fs.rename(retained, file);
  await assert.rejects((await f.create()).execute(patch(), { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_AMBIGUOUS' });
  assert.equal(f.count(), 1); assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'new');
});

test('selected Skill reads retain fixed hash evidence while unselected or changed documents remain unavailable', async t => {
  const f = await fixture(t); const relative = '.dsh/skills/sample/SKILL.md'; const content = 'Selected skill';
  await fs.mkdir(path.dirname(path.join(f.workspace, relative)), { recursive: true }); await fs.writeFile(path.join(f.workspace, relative), content);
  const projection = { documents: [{ projectionPath: relative, sha256: sha(content), bytes: Buffer.byteLength(content) }] };
  const broker = await createDshFileBroker({ workspace: f.workspace, readPolicy: f.config.readPolicy, onDecision: async () => {}, skillProjection: projection });
  t.after(() => broker.close());
  const receipts = await createCodexToolReceipts({ ...f.config, skillProjection: projection });
  const call = { ...read(), arguments: { path: relative } };
  assert.equal((await receipts.execute(call, { executeTool: call => broker.execute(call) })).content, content);
  const reopened = await createCodexToolReceipts({ ...f.config, skillProjection: projection });
  assert.equal((await reopened.execute(call, { executeTool: () => assert.fail('Skill read redispatched') })).content, content);
  await fs.writeFile(path.join(f.workspace, relative), 'changed');
  await assert.rejects(reopened.execute(call, { executeTool: () => assert.fail('Changed Skill redispatched') }), { code: 'CODEX_RECEIPT_RESULT_UNAVAILABLE' });
  await assert.rejects((await f.create()).execute(call, { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_POLICY_DENIED' });
});

test('a different workspace, link in the controls path or forged receipt path cannot supply another worker result', async t => {
  const f = await fixture(t); const receipts = await f.create();
  await receipts.execute(read(), { executeTool: f.executeTool });
  const other = path.join(f.root, 'other'); await fs.mkdir(other); await fs.writeFile(path.join(other, 'main.tex'), 'old');
  await assert.rejects((await createCodexToolReceipts({ ...f.config, workspace: other })).execute(read(), { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_IDENTITY_CONFLICT' });
  const linked = path.join(f.root, 'linked'); await fs.symlink(f.directory, linked);
  await assert.rejects(createCodexToolReceipts({ ...f.config, directory: path.join(linked, 'private') }), { code: 'CODEX_RECEIPT_STORAGE_INVALID' });
  assert.ok(!(await fs.readdir(f.directory)).includes('private'));
  await fs.writeFile(path.join(f.workspace, 'different.tex'), 'old');
  const file = path.join(f.directory, 'tool-receipts.json'); const disk = JSON.parse(await fs.readFile(file, 'utf8'));
  disk.receipts[0].path = 'different.tex'; disk.receipts[0].result.path = 'different.tex';
  await fs.writeFile(file, JSON.stringify(disk));
  await assert.rejects(receipts.execute(read(), { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_IDENTITY_CONFLICT' });
  assert.equal(f.count(), 1);
});

test('byte capacity stops before dispatch and a throwing policy does not overwrite prior receipts', async t => {
  const f = await fixture(t, { maxBytes: 1024 }); const receipts = await f.create();
  await assert.rejects(receipts.execute(read(), { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_CAPACITY' });
  assert.equal(f.count(), 0); assert.deepEqual(await fs.readdir(f.directory), []);
  const larger = await createCodexToolReceipts({ ...f.config, maxBytes: 4096 });
  await larger.execute(read(), { executeTool: f.executeTool });
  const file = path.join(f.directory, 'tool-receipts.json'); const original = await fs.readFile(file);
  const denied = await createCodexToolReceipts({ ...f.config, maxBytes: 4096, readPolicy: async () => { throw new Error('sensitive policy path'); } });
  await assert.rejects(denied.execute(read(), { executeTool: f.executeTool }), { code: 'CODEX_RECEIPT_POLICY_DENIED' });
  assert.deepEqual(await fs.readFile(file), original); assert.equal(f.count(), 1);
});

for (const tool of ['project_propose_patch', 'project_read_file']) {
  test(`long paths reserve actual ${tool} completion bytes before any real broker operation`, async t => {
    const f = await fixture(t);
    const relative = tool === 'project_propose_patch'
      ? Array.from({ length: 13 }, (_, i) => `segment-${i}-` + 'x'.repeat(43)).join('/') + '/main.tex'
      : Array.from({ length: 13 }, (_, i) => `研究-${i}-"` + '文'.repeat(16)).join('/') + '/main.tex';
    await fs.mkdir(path.dirname(path.join(f.workspace, relative)), { recursive: true });
    await fs.writeFile(path.join(f.workspace, relative), 'old'); f.setPolicy({ capabilities: { granted: ['project.read', 'patch.propose'], allowedPaths: [], networkAllowlist: [] } });
    const broker = await createDshFileBroker({ workspace: f.workspace, readPolicy: f.config.readPolicy, onDecision: async () => {} });
    t.after(() => broker.close());
    const args = tool === 'project_propose_patch' ? { path: relative, content: 'new', expectedSha256: sha('old') } : { path: relative, fromLine: 1, toLine: 1000 };
    const call = { ...read('long-path'), tool, arguments: args };
    const receipt = { callId: call.callId, tool, requestHash: sha(JSON.stringify({ tool, arguments: args })), path: relative,
      beforeSha256: sha('old'), afterSha256: sha(tool === 'project_propose_patch' ? 'new' : 'old'), status: 'prepared', result: null };
    const state = { schemaVersion: 1, workspace: f.workspace, binding, receipts: [receipt] };
    const preparedBytes = Buffer.byteLength(JSON.stringify(state) + '\n');
    const receipts = await createCodexToolReceipts({ ...f.config, maxBytes: preparedBytes + 512 });
    let calls = 0;
    const executeTool = async call => { calls++; return broker.execute(call); };
    await assert.rejects(receipts.execute(call, { executeTool }), { code: 'CODEX_RECEIPT_CAPACITY' });
    assert.equal(calls, 0); assert.equal(await fs.readFile(path.join(f.workspace, relative), 'utf8'), 'old');
    assert.deepEqual(await fs.readdir(f.directory), []);
    const enough = await createCodexToolReceipts({ ...f.config, maxBytes: preparedBytes + Buffer.byteLength(relative) + 512 });
    const result = await enough.execute(call, { executeTool });
    assert.equal(result.sha256, receipt.afterSha256); assert.equal(calls, 1);
    const disk = JSON.parse(await fs.readFile(path.join(f.directory, 'tool-receipts.json'), 'utf8'));
    assert.equal(disk.receipts[0].status, 'completed');
    assert.deepEqual(await (await createCodexToolReceipts({ ...f.config, maxBytes: preparedBytes + Buffer.byteLength(relative) + 512 })).execute(call, { executeTool }), result);
    assert.equal(calls, 1);
  });
}
