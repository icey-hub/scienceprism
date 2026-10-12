import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createCodexWorker } from '../src/services/harnessRuntime/adapters/codexWorker.js';
import { CODEX_PROTOCOL_VERSION } from '../src/services/harnessRuntime/adapters/codexAdapter.js';
import { summarizeEvent } from '../src/services/harnessRuntime/runtimeEvents.js';

// Pipe-only App Server fixture. Real broker reads/writes the temporary project;
// the fixture never launches an executable, a network request or a model.
function spawnFixture(_executable, args, _options, duplicate = false) {
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
    if (message.method === 'turn/start') { reply(message, { turn: { id: 'turn', status: 'inProgress' } }); call(901, 'project_read_file', { path: 'main.tex' }); }
    if (message.id === 901 && message.result?.success) {
      const read = JSON.parse(message.result.contentItems[0].text);
      call(902, 'project_propose_patch', { path: 'main.tex', content: 'new', expectedSha256: read.sha256 });
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

async function fixture(t, revoke = false, duplicate = false) {
  const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/reader/', import.meta.url));
  await fs.mkdir(cache, { recursive: true }); const root = await fs.mkdtemp(path.join(cache, 'codex-events-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'main.tex'), 'old');
  const events = []; const decisions = []; const order = []; let active = true;
  const worker = createCodexWorker({ executable: '/fixture/codex', spawnProcess: (file, args, options) => spawnFixture(file, args, options, duplicate) });
  const options = { provider: { baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture', apiKey: 'fixture-key' }, task: 'Read then propose.', workspace, runtimeHome: path.join(root, 'controls'), timeoutMs: 1000, maxTokens: 512,
    readPolicy: async () => ({ projectId: 'project', runId: 'child', role: 'writer', task: 'draft', version: 'v1', active, mode: 'auto', capabilities: { granted: ['project.read', 'patch.propose'], allowedPaths: ['main.tex'], networkAllowlist: [] } }),
    onSession: async () => {}, onDecision: async event => { decisions.push(event); order.push(`${event.callId}:${event.decision}`); if (revoke && event.tool === 'project_propose_patch' && event.decision === 'allow') active = false; },
    emit: event => { events.push(summarizeEvent(event)); order.push(`${event.data.callId}:${event.type}`); } };
  return { workspace, events, decisions, order, run: () => worker.run(options) };
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
