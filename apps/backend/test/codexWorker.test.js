import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createCodexWorker } from '../src/services/harnessRuntime/adapters/codexWorker.js';
import { CODEX_PROTOCOL_VERSION } from '../src/services/harnessRuntime/adapters/codexAdapter.js';
import { summarizeEvent } from '../src/services/harnessRuntime/runtimeEvents.js';

// Pipe-only App Server fixture. Real broker reads/writes the temporary project;
// the fixture never launches an executable, a network request or a model.
function spawnFixture(_executable, args, _options, duplicate = false, filePath = 'main.tex') {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exited: false });
  child.close = () => { if (!child.exited) { child.exited = true; child.stdout.end(); child.stderr.end(); child.emit('close', 0); } };
  child.kill = child.close;
  if (args[0] === '--version') { queueMicrotask(() => { child.stdout.write(`codex-cli ${CODEX_PROTOCOL_VERSION}\n`); child.close(); }); return child; }
  const send = value => child.stdout.write(`${JSON.stringify(value)}\n`);
  const reply = (message, result) => send({ id: message.id, result });
  const notify = (method, params) => send({ method, params });
  const call = (id, tool, arguments_) => {
    const message = { id, method: 'item/tool/call', params: { threadId: 'thread', turnId: 'turn', callId: `call-${id}`, tool, arguments: arguments_ } };
    send(message);
    if (duplicate) send({ ...message, id: id + 1000 });
  };
  const handle = message => {
    if (message.method === 'initialize') reply(message, {});
    if (message.method === 'mcpServerStatus/list') reply(message, { data: [] });
    if (message.method === 'command/exec') {
      const command = message.params.command;
      const control = command[0] === '/bin/cat' && command[1].endsWith('/control.txt');
      reply(message, { exitCode: control ? 0 : 1, stdout: control ? 'scienceprism-worker-control' : '', stderr: '' });
    }
    if (message.method === 'thread/start') reply(message, { thread: { id: 'thread' } });
    if (message.method === 'thread/read') reply(message, { thread: { id: 'thread', cwd: _options.cwd, modelProvider: 'scienceprism_worker_provider', ephemeral: false, turns: [], status: { type: 'notLoaded' } } });
    if (message.method === 'thread/turns/list') reply(message, { data: [{ id: 'turn', status: 'completed', itemsView: 'full', items: [{ id: 'reply', type: 'agentMessage', text: 'Worker completed.' }] }], nextCursor: null });
    if (message.method === 'turn/start') { reply(message, { turn: { id: 'turn', status: 'inProgress' } }); call(901, 'project_read_file', { path: filePath }); }
    if (message.id === 901 && message.result?.success) {
      const read = JSON.parse(message.result.contentItems[0].text);
      call(902, 'project_propose_patch', { path: filePath, content: 'new', expectedSha256: read.sha256 });
    }
    if (message.id === 902 && message.result?.success) {
      notify('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'answer', type: 'agentMessage', text: 'Proposed.' } });
      notify('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
    }
    if (message.method === 'turn/interrupt') { reply(message, {}); notify('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } }); }
  };
  let buffer = ''; child.stdin.setEncoding('utf8');
  child.stdin.on('data', chunk => { buffer += chunk; while (buffer.includes('\n')) { const offset = buffer.indexOf('\n'); const message = JSON.parse(buffer.slice(0, offset)); buffer = buffer.slice(offset + 1); queueMicrotask(() => { if (!child.exited) handle(message); }); } });
  child.stdin.on('end', child.close);
  return child;
}

async function fixture(t, revoke = false, duplicate = false, filePath = 'main.tex') {
  const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/reader/', import.meta.url));
  await fs.mkdir(cache, { recursive: true }); const root = await fs.mkdtemp(path.join(cache, 'codex-events-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'main.tex'), 'old');
  const events = []; const decisions = []; const order = []; const storage = [], results = [], outbound = []; let active = true;
  const worker = createCodexWorker({ executable: '/fixture/codex', spawnProcess: (file, args, options) => { const child = spawnFixture(file, args, options, duplicate, filePath); child.stdin.on('data', chunk => { for (const line of String(chunk).trim().split('\n')) { try { const message = JSON.parse(line); if (message.method) outbound.push(message.method); } catch {} } }); return child; } });
  const options = { provider: { baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture', apiKey: 'fixture-key' }, task: 'Read then propose.', workspace, runtimeHome: path.join(root, 'controls'), timeoutMs: 1000, maxTokens: 512,
    readPolicy: async () => ({ projectId: 'project', runId: 'child', role: 'writer', task: 'draft', version: 'v1', active, mode: 'auto', capabilities: { granted: ['project.read', 'patch.propose'], allowedPaths: [filePath], networkAllowlist: [] } }),
    parentRunId: 'parent', onStorage: async value => storage.push(structuredClone(value)), onResult: async value => results.push(structuredClone(value)), onSession: async () => {}, onDecision: async event => { decisions.push(event); order.push(`${event.callId}:${event.decision}`); if (revoke && event.tool === 'project_propose_patch' && event.decision === 'allow') active = false; },
    emit: event => { events.push(summarizeEvent(event)); order.push(`${event.data.callId}:${event.type}`); } };
  return { worker, outbound, workspace, events, decisions, order, storage, results, options, run: () => worker.run(options) };
}

test('Codex controlled reads and proposals emit paired standard graph events after policy audit', async t => {
  const f = await fixture(t); assert.equal((await f.run()).ok, true);
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'new');
  const graphEvents = f.events.filter(event => ['tool/start', 'tool/end', 'tool/error'].includes(event.type));
  assert.deepEqual(graphEvents.map(event => [event.type, event.name, event.callId]), [
    ['tool/start', 'project_read_file', 'call-901'], ['tool/end', 'project_read_file', 'call-901'],
    ['tool/start', 'project_propose_patch', 'call-902'], ['tool/end', 'project_propose_patch', 'call-902']
  ]);
  assert.deepEqual(JSON.parse(graphEvents[0].arguments), { path: 'main.tex' });
  assert.equal(JSON.parse(graphEvents[1].output).sha256, createHash('sha256').update('old').digest('hex'));
  assert.equal(JSON.parse(graphEvents[3].output).proposed, true); assert.equal(graphEvents[3].outcome, 'success');
  for (const callId of ['call-901', 'call-902']) {
    assert.ok(f.order.indexOf(`${callId}:tool/start`) < f.order.indexOf(`${callId}:allow`));
    assert.ok(f.order.indexOf(`${callId}:allow`) < f.order.indexOf(`${callId}:tool/end`));
  }
});

test('Codex rejected proposal emits tool/error paired by call identity and never a success end', async t => {
  const f = await fixture(t, true);
  await assert.rejects(f.run(), { code: 'CAPABILITY_POLICY_UNENFORCEABLE' });
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'old');
  const failed = f.events.find(event => event.type === 'tool/error' && event.callId === 'call-902');
  assert.equal(failed.name, 'project_propose_patch'); assert.equal(failed.outcome, 'error');
  assert.equal(JSON.parse(failed.error).code, 'DSH_RUN_INACTIVE');
  assert.equal(f.events.some(event => event.type === 'tool/end' && event.callId === 'call-902'), false);
  assert.ok(f.decisions.some(event => event.callId === 'call-902' && event.decision === 'deny'));
  assert.equal(f.storage.at(-1).terminalStatus, 'failed', 'Cleanup cancellation must not relabel the actual worker failure.');
});

test('retransmitted Codex read and proposal complete with one actual file operation and graph pair', async t => {
  const f = await fixture(t, false, true);
  assert.equal((await f.run()).ok, true);
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'new');
  assert.equal(f.decisions.filter(event => event.decision === 'allow').length, 2);
  const actual = f.events.filter(event => ['tool/start', 'tool/end', 'tool/error'].includes(event.type));
  assert.deepEqual(actual.map(event => [event.type, event.callId]), [
    ['tool/start', 'call-901'], ['tool/end', 'call-901'], ['tool/start', 'call-902'], ['tool/end', 'call-902']
  ]);
});

test('worker receives a missing-file domain observation then proposes nested code and finishes without duplicate effects', async t => {
  const filePath = 'experiments/nested/missing.py', f = await fixture(t, false, true, filePath), originalEmit = f.options.emit;
  let missingObservation;
  f.options.emit = event => {
    if (event.type === 'tool/end' && event.data.callId === 'call-901') {
      missingObservation = structuredClone(event.data.output);
      assert.equal(existsSync(path.join(f.workspace, 'experiments')), false, 'Missing reads cannot create a directory.');
    }
    originalEmit(event);
  };
  const result = await f.run(); assert.equal(result.ok, true);
  assert.deepEqual(missingObservation, { path: filePath, exists: false, sha256: null, code: 'PROJECT_FILE_NOT_FOUND' });
  assert.equal(await fs.readFile(path.join(f.workspace, filePath), 'utf8'), 'new');
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'old');
  const actual = f.events.filter(event => ['tool/start', 'tool/end', 'tool/error'].includes(event.type));
  assert.deepEqual(actual.map(event => [event.type, event.callId]), [['tool/start', 'call-901'], ['tool/end', 'call-901'], ['tool/start', 'call-902'], ['tool/end', 'call-902']]);
  assert.equal(f.decisions.filter(event => event.decision === 'allow' && event.callId === 'call-901').length, 1);
  assert.ok(f.order.indexOf('call-901:allow') < f.order.indexOf('call-901:tool/end'));
  const root = path.join(f.options.runtimeHome, f.storage[0].root), receipts = JSON.parse(await fs.readFile(path.join(root, 'receipts/tool-receipts.json'), 'utf8'));
  assert.deepEqual(receipts.receipts.map(item => [item.callId, item.beforeSha256, item.status]), [['call-902', null, 'completed']]);
  assert.equal((await fs.lstat(path.join(f.workspace, filePath))).nlink, 1); assert.equal(f.storage.at(-1).stopConfirmed, true);
});

test('worker does not reinterpret lost evidence after a real read as an ordinary missing-file observation', async t => {
  const f = await fixture(t), originalEmit = f.options.emit;
  f.options.emit = event => {
    if (event.type === 'file/read') unlinkSync(path.join(f.workspace, 'main.tex'));
    originalEmit(event);
  };
  await assert.rejects(f.run(), { code: 'CAPABILITY_POLICY_UNENFORCEABLE' });
  const failed = f.events.find(event => event.type === 'tool/error' && event.callId === 'call-901');
  assert.equal(JSON.parse(failed.error).code, 'CODEX_RECEIPT_RESULT_UNAVAILABLE');
  assert.equal(f.events.some(event => event.type === 'tool/end' && event.callId === 'call-901'), false);
  assert.equal(existsSync(path.join(f.workspace, 'main.tex')), false);
  assert.equal(f.decisions.some(event => event.callId === 'call-902'), false);
});

test('worker keeps a missing selected Skill projection fatal and does not manufacture a Skill file', async t => {
  const filePath = '.dsh/skills/reader/SKILL.md', f = await fixture(t, false, false, filePath);
  f.options.skillProjection = { documents: [{ projectionPath: filePath, sha256: createHash('sha256').update('fixed skill').digest('hex'), bytes: 11 }] };
  await assert.rejects(f.run(), { code: 'CAPABILITY_POLICY_UNENFORCEABLE' });
  const failed = f.events.find(event => event.type === 'tool/error' && event.callId === 'call-901');
  assert.equal(JSON.parse(failed.error).code, 'CODEX_RECEIPT_RESULT_UNAVAILABLE');
  assert.equal(existsSync(path.join(f.workspace, '.dsh')), false); assert.equal(f.decisions.some(event => event.callId === 'call-902'), false);
});


test('actual worker retains its controls and durable receipts before returning its result', async t => {
  const f = await fixture(t); const result = await f.run();
  assert.equal(f.results.length, 1); assert.deepEqual(f.results[0], result);
  assert.equal(f.storage[0].phase, 'prepared');
  assert.equal(f.storage.at(-1).phase, 'stopped'); assert.equal(f.storage.at(-1).stopConfirmed, true);
  assert.equal(f.storage.at(-1).threadId, 'thread'); assert.equal(f.storage.at(-1).turnId, 'turn');
  const root = path.join(f.options.runtimeHome, f.storage[0].root);
  const ledger = JSON.parse(await fs.readFile(path.join(root, 'receipts', 'tool-receipts.json'), 'utf8'));
  assert.equal(ledger.binding.parentRunId, 'parent'); assert.equal(ledger.binding.workerRunId, 'child');
  assert.deepEqual(ledger.receipts.map(row => [row.callId, row.status]), [['call-901', 'completed'], ['call-902', 'completed']]);
  assert.equal(JSON.stringify(ledger).includes('new'), false); assert.equal(JSON.stringify(ledger).includes('not-persisted-key'), false);
  assert.equal((await fs.stat(root)).isDirectory(), true);
});

test('worker refuses to start if its recovery location cannot be durably recorded', async t => {
  const f = await fixture(t); f.options.onStorage = async () => { throw new Error('checkpoint unavailable'); };
  await assert.rejects(f.run(), /checkpoint unavailable/);
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'old');
  assert.equal(f.events.some(event => event.type === 'tool/start'), false);
});


test('stopped worker inspection reads the exact saved turn without starting another model task', async t => {
  const f = await fixture(t); await f.run(); const saved = f.storage.at(-1), calls = f.outbound.length;
  const result = await f.worker.readResult({ ...f.options, storage: saved, assertOwnership: async () => {} });
  assert.equal(result.finalResponse, 'Worker completed.'); assert.equal(result.usage, undefined);
  assert.deepEqual(f.outbound.slice(calls), ['initialize', 'initialized', 'thread/read', 'thread/turns/list']);
  assert.equal(f.storage.at(-1).stopConfirmed, true);
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'new');
});

test('unconfirmed/live worker identity, stale version and current revocation block inspection before spawning', async t => {
  const f = await fixture(t); await f.run(); const saved = f.storage.at(-1), calls = f.outbound.length;
  for (const [patch, code] of [[{stopConfirmed:false}, 'CODEX_RECOVERY_INVALID'], [{pid:process.pid}, 'CODEX_RECOVERY_OWNER_ACTIVE'], [{implementationHash:'0'.repeat(64)}, 'CODEX_RECOVERY_INVALID']]) {
    await assert.rejects(f.worker.readResult({ ...f.options, storage:{...saved,...patch}, assertOwnership:async()=>{} }), {code});
  }
  await assert.rejects(f.worker.readResult({ ...f.options, storage:saved, readPolicy:async()=>({...await f.options.readPolicy(),active:false}), assertOwnership:async()=>{} }), {code:'CODEX_RECOVERY_POLICY_DENIED'});
  assert.equal(f.outbound.length,calls);
});

for (const inspect of [false, true]) {
  test(`an unconfirmed ${inspect ? 'inspection' : 'worker'} stop remains fatal when checkpoint saving also fails`, async t => {
    const f = await fixture(t);
    if (inspect) await f.run();
    const storage = f.storage.at(-1), attempted = [];
    let app;
    const worker = createCodexWorker({ executable: '/fixture/codex', spawnProcess: (file, args, options) => {
      const child = spawnFixture(file, args, options);
      if (args[0] === 'app-server') { app = child; child.stdin.removeAllListeners('end'); child.kill = () => false; }
      return child;
    } });
    t.after(() => { if (app) { app.stdin.destroy(); app.close(); } });
    const options = { ...f.options, storage, assertOwnership: async () => {}, onStorage: async value => {
      attempted.push(structuredClone(value));
      if (value.phase === 'stop-unconfirmed') throw new Error('checkpoint unavailable');
    } };
    await assert.rejects(inspect ? worker.readResult(options) : worker.run(options), { code: 'CODEX_STOP_FAILED' });
    assert.equal(attempted.at(-1).stopConfirmed, false);
  });
}
