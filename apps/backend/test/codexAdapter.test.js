import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCodexAdapter, CODEX_PROTOCOL_VERSION } from '../src/services/harnessRuntime/adapters/codexAdapter.js';
import { createCodexProtocol, startCodexTurn, readCodexCompletedTurn, codexFailure } from '../src/services/harnessRuntime/adapters/codexProtocol.js';

// A pipe-only fake App Server. No model, executable, network, or user auth is used.
function fakeServer(handler, { linger = false } = {}) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), commands: [], kills: [], exited: false });
  child.end = (code = 0) => { if (child.exited) return; child.exited = true; child.stdout.end(); child.stderr.end(); child.emit('close', code, null); };
  child.kill = (signal) => { child.kills.push(signal); child.end(); };
  child.notify = (method, params) => child.stdout.write(`${JSON.stringify({ method, params })}\n`);
  child.respond = (message, result) => child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
  let buffer = '';
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const offset = buffer.indexOf('\n');
      const message = JSON.parse(buffer.slice(0, offset));
      buffer = buffer.slice(offset + 1);
      child.commands.push(message);
      queueMicrotask(() => { if (!child.exited) handler(message, child); });
    }
  });
  child.stdin.on('end', () => { if (!linger) child.end(); });
  return child;
}

function turnServer(onTurn, options) {
  return fakeServer((message, child) => {
    if (message.method === 'thread/start') child.respond(message, { thread: { id: 'thread-1' } });
    if (message.method === 'turn/start') {
      child.notify('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', items: [] } });
      child.respond(message, { turn: { id: 'turn-1', status: 'inProgress', items: [] } });
      onTurn?.(child);
    }
    if (message.method === 'turn/interrupt') {
      child.respond(message, {});
      child.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted', items: [] } });
    }
  }, options);
}

const turnOptions = (child, extra = {}) => ({
  protocol: createCodexProtocol(child, { requestTimeoutMs: 100, closeTimeoutMs: 10 }),
  workspace: '/isolated/project', provider: { id: 'fixture', model: 'fixture-no-model' },
  request: 'fixture only', onSession: async () => {}, timeoutMs: 250, interruptTimeoutMs: 20, ...extra
});

test('NDJSON supports fragmented frames, duplicate responses, and rejects unsupported methods without sending', async () => {
  const child = fakeServer((message, peer) => {
    const wire = `${JSON.stringify({ id: message.id, result: { label: '中文' } })}\n`;
    const bytes = Buffer.from(wire);
    peer.stdout.write(bytes.subarray(0, bytes.length - 4));
    peer.stdout.write(bytes.subarray(bytes.length - 4));
    peer.respond(message, { ignored: true });
  });
  const protocol = createCodexProtocol(child);
  assert.deepEqual(await protocol.request('initialize'), { label: '中文' });
  await assert.rejects(protocol.request('thread/resume'), { code: 'CODEX_METHOD_UNSUPPORTED' });
  assert.equal(child.commands.length, 1);
  await protocol.close();
  assert.equal(child.exited, true);
});

test('protocol rejects malformed/oversized frames and transport exit, with no implicit request retries', async () => {
  for (const [value, expected] of [['not-json\n', 'CODEX_PROTOCOL_INVALID'], ['x'.repeat(100), 'CODEX_MESSAGE_TOO_LARGE'], [null, 'CODEX_PROCESS_CLOSED']]) {
    const child = fakeServer((message, peer) => value === null ? peer.end(71) : peer.stdout.write(value));
    const protocol = createCodexProtocol(child, { maxLineBytes: 80, requestTimeoutMs: 30 });
    await assert.rejects(protocol.request('initialize'), { code: expected });
    await protocol.close();
    assert.equal(child.commands.length, 1);
  }
  const child = fakeServer(() => {});
  const protocol = createCodexProtocol(child, { requestTimeoutMs: 5 });
  await assert.rejects(protocol.request('initialize'), { code: 'CODEX_REQUEST_TIMEOUT' });
  assert.equal(child.commands.length, 1);
  await protocol.close();
});

test('all server approval, tool, elicitation and unknown requests fail closed', async () => {
  const child = fakeServer(() => {});
  const protocol = createCodexProtocol(child);
  const methods = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/call', 'mcpServer/elicitation/request', 'item/tool/requestUserInput', 'unknown/request'];
  for (const [id, method] of methods.entries()) child.stdout.write(`${JSON.stringify({ id, method, params: { command: 'forbidden' } })}\n`);
  assert.deepEqual(child.commands[0].result, { decision: 'decline' });
  assert.deepEqual(child.commands[1].result, { decision: 'decline' });
  assert.deepEqual(child.commands[2].result, { permissions: {}, scope: 'turn' });
  assert.equal(child.commands[3].result.success, false);
  assert.equal(child.commands[4].result.action, 'decline');
  assert.equal(child.commands[5].error.code, -32601);
  assert.equal(child.commands[6].error.code, -32601);
  await protocol.close();
});

test('explicit dynamic tool handler is awaited once and duplicate call identities cannot execute twice', async () => {
  const child = fakeServer(() => {});
  let calls = 0;
  let release;
  const deferred = new Promise(resolve => { release = resolve; });
  const protocol = createCodexProtocol(child, { onToolCall: async params => { calls += 1; await deferred; return { path: params.arguments.path, content: 'read' }; } });
  const message = { id: 91, method: 'item/tool/call', params: { callId: 'one', tool: 'project_read_file', arguments: { path: 'main.tex' } } };
  child.stdout.write(`${JSON.stringify(message)}\n`);
  child.stdout.write(`${JSON.stringify({ ...message, id: 92 })}\n`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(child.commands.some(command => command.id === 92), false);
  assert.equal(child.commands.some(command => command.id === 91), false);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(child.commands.find(command => command.id === 91).result.success, true);
  assert.deepEqual(child.commands.find(command => command.id === 92).result, child.commands.find(command => command.id === 91).result);
  child.stdout.write(`${JSON.stringify({ ...message, id: 93 })}\n`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.deepEqual(child.commands.find(command => command.id === 93).result, child.commands.find(command => command.id === 91).result);
  await protocol.close();
});

test('duplicate tool results stay scoped to the original thread, turn, tool and arguments', async () => {
  const child = fakeServer(() => {});
  let calls = 0;
  const events = [];
  const protocol = createCodexProtocol(child, { onToolCall: async () => { calls++; return { content: 'scoped result' }; } });
  protocol.subscribe(event => events.push(event));
  const params = { threadId: 'thread', turnId: 'turn', callId: 'same', tool: 'project_read_file', arguments: { path: 'main.tex', fromLine: 1 } };
  const send = (id, value) => child.stdout.write(`${JSON.stringify({ id, method: 'item/tool/call', params: value })}\n`);
  send(1, params);
  await new Promise(resolve => setImmediate(resolve));
  // Object key order is not a change to the tool's arguments.
  send(2, { ...params, arguments: { fromLine: 1, path: 'main.tex' } });
  for (const [index, altered] of [
    { threadId: 'other' }, { turnId: 'other' }, { tool: 'project_propose_patch' },
    { namespace: 'other' }, { arguments: { path: 'other.tex', fromLine: 1 } }
  ].entries()) send(index + 3, { ...params, ...altered });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.deepEqual(child.commands.find(command => command.id === 2).result, child.commands.find(command => command.id === 1).result);
  assert.equal(events.filter(event => !event.denied).length, 1);
  for (let id = 3; id <= 7; id++) {
    assert.equal(child.commands.find(command => command.id === id).result.success, false);
    assert.ok(!JSON.stringify(child.commands.find(command => command.id === id)).includes('scoped result'));
  }
  await protocol.close();
});

test('failed tool calls replay their sanitized failure and closing cannot execute a late request', async () => {
  const child = fakeServer(() => {});
  let calls = 0;
  const events = [];
  const protocol = createCodexProtocol(child, { onToolCall: async () => { calls++; throw new Error('private credential'); } });
  protocol.subscribe(event => events.push(event));
  const request = { id: 1, method: 'item/tool/call', params: { callId: 'failure', tool: 'project_read_file', arguments: { path: 'main.tex' } } };
  child.stdout.write(`${JSON.stringify(request)}\n`);
  await new Promise(resolve => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ ...request, id: 2 })}\n`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.deepEqual(child.commands[0].result, child.commands[1].result);
  assert.equal(events.length, 1);
  assert.ok(!JSON.stringify(child.commands).includes('private credential'));
  await protocol.close();
  const late = fakeServer(() => {}, { linger: true });
  const closing = createCodexProtocol(late, { closeTimeoutMs: 5, onToolCall: async () => { calls++; return {}; } });
  const stopped = closing.close();
  late.stdout.write(`${JSON.stringify(request)}\n`);
  await stopped;
  assert.equal(calls, 1);
});

test('tool replay cache and pending responses remain bounded without evicting execution identities', async () => {
  const child = fakeServer(() => {});
  let calls = 0;
  const protocol = createCodexProtocol(child, { onToolCall: async () => { calls++; return { ok: true }; } });
  const send = (id, callId) => child.stdout.write(`${JSON.stringify({ id, method: 'item/tool/call', params: { callId } })}\n`);
  for (let id = 1; id <= 128; id++) {
    send(id, `call-${id}`);
    await new Promise(resolve => setImmediate(resolve));
  }
  send(129, 'call-129');
  send(130, 'call-1');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 128);
  assert.equal(child.commands.find(command => command.id === 129).result.success, false);
  assert.deepEqual(child.commands.find(command => command.id === 130).result, child.commands[0].result);
  await protocol.close();

  const pending = fakeServer(() => {});
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const bounded = createCodexProtocol(pending, { onToolCall: async () => { calls++; await blocked; return {}; } });
  for (let id = 1; id <= 9; id++) pending.stdout.write(`${JSON.stringify({ id, method: 'item/tool/call', params: { callId: `pending-${id}` } })}\n`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 136);
  assert.equal(pending.commands.find(command => command.id === 9).result.success, false);
  release();
  await new Promise(resolve => setImmediate(resolve));
  await bounded.close();
});

test('a stalled Codex input stream cannot accumulate unlimited retransmitted tool results', async () => {
  const child = fakeServer(() => {}, { linger: true });
  child.stdin.pause();
  let calls = 0;
  const failures = [];
  const protocol = createCodexProtocol(child, { closeTimeoutMs: 5, onToolCall: async () => { calls++; return { content: 'x'.repeat(260_000) }; } });
  protocol.subscribe(() => {}, reason => failures.push(reason));
  for (let id = 1; id <= 100; id++) {
    child.stdout.write(`${JSON.stringify({ id, method: 'item/tool/call', params: { callId: 'stalled' } })}\n`);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(calls, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'CODEX_TRANSPORT_OVERFLOW');
  assert.ok(child.stdin.writableLength <= 4_194_304);
  await protocol.close();
  assert.equal(child.exited, true);
});

test('dynamic tool failure is sanitized and closing aborts and drains an in-flight handler', async () => {
  const child = fakeServer(() => {});
  const notifications = [];
  const protocol = createCodexProtocol(child, { onToolCall: async () => { throw new Error('secret provider content'); } });
  protocol.subscribe(message => notifications.push(message));
  child.stdout.write(`${JSON.stringify({ id: 1, method: 'item/tool/call', params: { callId: 'fail' } })}\n`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(child.commands[0].result.success, false);
  assert.ok(!JSON.stringify(child.commands).includes('secret'));
  assert.equal(notifications[0].denied, true);
  await protocol.close();
  const pending = fakeServer(() => {});
  let aborted = false;
  let started;
  const active = new Promise(resolve => { started = resolve; });
  const controlled = createCodexProtocol(pending, { onToolCall: async (_params, signal) => new Promise(resolve => {
    signal.addEventListener('abort', () => { aborted = true; resolve({ cancelled: true }); }, { once: true });
    started();
  }) });
  pending.stdout.write(`${JSON.stringify({ id: 2, method: 'item/tool/call', params: { callId: 'pending' } })}\n`);
  await active;
  await controlled.close();
  assert.equal(aborted, true);
  assert.equal(pending.commands.length, 0);
});

test('controlled worker turn uses a named permission profile and no built-in environments', async () => {
  const child = turnServer(peer => peer.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }));
  const tools = [{ type: 'function', name: 'project_read_file', inputSchema: { type: 'object' }, description: 'read' }];
  await startCodexTurn(turnOptions(child, { permissions: 'worker', dynamicTools: tools }));
  for (const command of child.commands.filter(command => ['thread/start', 'turn/start'].includes(command.method))) {
    assert.deepEqual(command.params.environments, []);
    assert.equal(command.params.permissions, 'worker');
    assert.equal(command.params.approvalPolicy, 'never');
    assert.equal(command.params.sandboxPolicy, undefined);
    assert.equal(command.params.sandbox, undefined);
  }
  assert.deepEqual(child.commands[0].params.dynamicTools, tools);
  assert.equal(child.commands[0].params.historyMode, 'paginated');
});

test('worker token budget uses cumulative CLI usage and stops instead of relying on model reminders', async () => {
  const child = turnServer(peer => {
    peer.notify('thread/tokenUsage/updated', { threadId: 'thread-1', tokenUsage: { last: { totalTokens: 1 }, total: { totalTokens: 1024 } } });
  });
  await assert.rejects(startCodexTurn(turnOptions(child, { maxTokens: 512 })), { code: 'CODEX_BUDGET_EXHAUSTED' });
  assert.equal(child.exited, true);
});

test('turn persists thread before execution, streams scoped events, and uses authoritative completed item without duplication', async () => {
  const sessions = [];
  const events = [];
  const child = turnServer((peer) => {
    assert.equal(sessions.length, 1);
    peer.notify('item/agentMessage/delta', { threadId: 'thread-elsewhere', turnId: 'turn-1', itemId: 'other', delta: 'ignore' });
    peer.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-elsewhere', itemId: 'other', delta: 'ignore' });
    peer.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer', delta: 'draft' });
    peer.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'answer', type: 'agentMessage', text: 'final answer' } });
    peer.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'answer', type: 'agentMessage', text: 'final answer' } });
    peer.notify('thread/tokenUsage/updated', { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { last: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } } });
    peer.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } });
    peer.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', items: [] } });
  });
  const result = await startCodexTurn(turnOptions(child, { onSession: async (identity) => { sessions.push(identity); }, emit: (event) => events.push(event) }));
  assert.deepEqual(sessions, [{ threadId: 'thread-1', turnId: null }, { threadId: 'thread-1', turnId: 'turn-1' }]);
  assert.equal(result.finalResponse, 'final answer');
  assert.deepEqual(result.output.codex, { threadId: 'thread-1', turnId: 'turn-1' });
  assert.equal(result.usage.totalTokens, 5);
  assert.deepEqual(result.patches, []);
  assert.ok(events.every((event) => event.data.threadId === 'thread-1'));
  assert.ok(events.find((event) => event.data.itemId === 'answer' && event.data.sourceSequence > 0));
  assert.equal(child.exited, true);
});

test('identity persistence failure and early cancellation start no model turn', async () => {
  const child = turnServer(() => assert.fail('must not start'));
  await assert.rejects(startCodexTurn(turnOptions(child, { onSession: async () => { throw new Error('ledger unavailable'); } })), /ledger unavailable/);
  assert.equal(child.commands.some((command) => command.method === 'turn/start'), false);
  const controller = new AbortController();
  controller.abort();
  const cancelled = turnServer(() => assert.fail('must not start'));
  await assert.rejects(startCodexTurn(turnOptions(cancelled, { signal: controller.signal })), { code: 'CODEX_INTERRUPTED' });
  assert.equal(cancelled.commands.length, 0);
});

test('active cancellation sends turn/interrupt and awaits terminal process exit', async () => {
  const controller = new AbortController();
  const child = turnServer(() => queueMicrotask(() => controller.abort()), { linger: true });
  await assert.rejects(startCodexTurn(turnOptions(child, { signal: controller.signal })), { code: 'CODEX_INTERRUPTED' });
  assert.deepEqual(child.commands.find((command) => command.method === 'turn/interrupt').params, { threadId: 'thread-1', turnId: 'turn-1' });
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(child.exited, true);
});

test('authentication, sandbox, provider failures are distinct and do not expose provider secrets', async () => {
  const cases = [['unauthorized', 'CODEX_AUTH_REQUIRED'], ['sandboxError', 'CODEX_SANDBOX_UNAVAILABLE'], ['rateLimitExceeded', 'CODEX_PROVIDER_LIMIT'], ['other', 'CODEX_TURN_FAILED']];
  for (const [info, code] of cases) {
    const child = turnServer((peer) => peer.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', error: { codexErrorInfo: info, message: 'Authorization: Bearer test-secret-should-not-escape' } } }));
    await assert.rejects(startCodexTurn(turnOptions(child)), (reason) => reason.code === code && !JSON.stringify(reason).includes('test-secret'));
    assert.equal(child.exited, true);
  }
  assert.equal(codexFailure({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }).code, 'CODEX_AUTH_REQUIRED');
});

test('tool requests, disconnects, and output overflow fail the turn', async () => {
  const cases = [
    [(peer) => peer.stdout.write(`${JSON.stringify({ id: 'server-call', method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1' } })}\n`), 'CAPABILITY_POLICY_UNENFORCEABLE'],
    [(peer) => peer.end(71), 'CODEX_PROCESS_CLOSED'],
    [(peer) => peer.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'large', text: 'x'.repeat(1_048_577) } }), 'CODEX_MESSAGE_TOO_LARGE']
  ];
  for (const [action, code] of cases) {
    const child = turnServer(action);
    await assert.rejects(startCodexTurn(turnOptions(child)), { code });
    assert.equal(child.exited, true);
  }
});

test('turn timeout and missing ledger callback stop the process; request authentication errors stay structured', async () => {
  const timeout = turnServer(() => {});
  await assert.rejects(startCodexTurn(turnOptions(timeout, { timeoutMs: 5 })), { code: 'CODEX_TURN_TIMEOUT' });
  assert.equal(timeout.exited, true);
  const noLedger = turnServer(() => assert.fail('must not start'));
  await assert.rejects(startCodexTurn(turnOptions(noLedger, { onSession: undefined })), { code: 'CODEX_SESSION_PERSISTENCE_REQUIRED' });
  assert.equal(noLedger.exited, true);
  const child = fakeServer((message, peer) => peer.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32000, data: { codexErrorInfo: 'unauthorized' }, message: 'secret' } })}\n`));
  const protocol = createCodexProtocol(child);
  await assert.rejects(protocol.request('initialize'), { code: 'CODEX_AUTH_REQUIRED' });
  await protocol.close();
});

test('unconfirmed process termination fails explicitly so the caller can retain the workspace', async () => {
  const child = fakeServer(() => {}, { linger: true });
  child.kill = (signal) => child.kills.push(signal);
  const protocol = createCodexProtocol(child, { closeTimeoutMs: 5 });
  await assert.rejects(protocol.close(), { code: 'CODEX_STOP_FAILED' });
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
  child.end();
});

function probeSpawner({ version = CODEX_PROTOCOL_VERSION, sandboxWorks = false, externalTools = false } = {}) {
  const children = [];
  const calls = [];
  const spawnProcess = (file, args, options) => {
    calls.push({ file, args, options });
    const child = fakeServer((message, peer) => {
      if (message.method === 'initialize') peer.respond(message, { userAgent: `fixture/${version}` });
      if (message.method === 'mcpServerStatus/list') peer.respond(message, { data: externalTools ? [{ name: 'unexpected' }] : [], nextCursor: null });
      if (message.method === 'thread/start') peer.respond(message, { thread: { id: 'probe-thread' } });
      if (message.method === 'command/exec') {
        const control = message.params.command[2].includes('stdout');
        peer.respond(message, sandboxWorks && control ? { exitCode: 0, stdout: 'scienceprism-sandbox-control', stderr: '' } : { exitCode: 71, stdout: '', stderr: 'sandbox-exec: sandbox_apply: Operation not permitted\n' });
      }
    });
    children.push(child);
    if (args[0] === '--version') queueMicrotask(() => { child.stdout.write(`codex-cli ${version}\n`); child.end(); });
    return child;
  };
  return { spawnProcess, children, calls };
}

test('production probe isolates auth/config and fails before models when sandbox cannot run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-test-'));
  try {
    const fixture = probeSpawner();
    const adapter = createCodexAdapter({ executable: '/fixture/codex', spawnProcess: fixture.spawnProcess });
    const result = await adapter.probe({ runtimeHome: root });
    assert.equal(result.available, false);
    assert.equal(result.protocolInitialized, true);
    assert.equal(result.blockers[0].code, 'CODEX_SANDBOX_UNAVAILABLE');
    assert.equal(result.blockers[0].details.sandboxApplyDenied, true);
    assert.equal(result.modelTurns, 0);
    assert.equal(fixture.children[1].commands.some((command) => command.method === 'turn/start'), false);
    assert.equal(fixture.calls[1].options.shell, false);
    assert.notEqual(fixture.calls[1].options.env.HOME, process.env.HOME);
    assert.deepEqual(Object.keys(fixture.calls[1].options.env).filter((key) => /KEY|TOKEN|PROXY/.test(key)), []);
    assert.equal(fixture.calls[1].args.includes('cli_auth_credentials_store="file"'), true);
    assert.equal(fixture.children.every((child) => child.exited), true);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('working write sandbox still cannot unlock project-scoped model execution without a broker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-policy-test-'));
  try {
    const fixture = probeSpawner({ sandboxWorks: true });
    const adapter = createCodexAdapter({ executable: '/fixture/codex', spawnProcess: fixture.spawnProcess });
    const result = await adapter.probe({ runtimeHome: root });
    assert.deepEqual(result.sandbox, { controlPassed: true, writeDenied: true });
    assert.equal(result.blockers[0].code, 'CAPABILITY_POLICY_UNENFORCEABLE');
    await assert.rejects(adapter.run({ runtimeHome: root, capabilities: ['project.read'], request: { contextPack: { files: [] } } }), { code: 'CAPABILITY_POLICY_UNENFORCEABLE' });
    assert.ok(fixture.children.every((child) => !child.commands.some((command) => command.method === 'turn/start')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing/version-mismatched executable, external tools and unimplemented capabilities fail explicitly', async () => {
  assert.equal((await createCodexAdapter().probe()).blockers[0].code, 'CODEX_EXECUTABLE_REQUIRED');
  const fixture = probeSpawner();
  const adapter = createCodexAdapter({ executable: '/fixture/codex', spawnProcess: fixture.spawnProcess });
  await assert.rejects(adapter.run({ capabilities: ['patch.propose'] }), { code: 'CAPABILITY_POLICY_UNENFORCEABLE' });
  await assert.rejects(adapter.run({ request: { sessionId: 'old-session' } }), { code: 'CODEX_RESUME_UNAVAILABLE' });
  assert.equal(fixture.calls.length, 0);
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-errors-test-'));
  try {
    for (const [settings, code] of [[{ version: '0.163.0' }, 'CODEX_VERSION_MISMATCH'], [{ externalTools: true }, 'CODEX_EXTERNAL_TOOLS_ENABLED']]) {
      const fake = probeSpawner(settings);
      const result = await createCodexAdapter({ executable: '/fixture/codex', spawnProcess: fake.spawnProcess }).probe({ runtimeHome: root });
      assert.equal(result.blockers[0].code, code);
      assert.ok(fake.children.every((child) => child.exited));
      assert.ok(fake.children.every((child) => !child.commands.some((command) => command.method === 'turn/start')));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

const storedThread = () => ({ id: 'stored-thread', cwd: '/isolated/project', modelProvider: 'fixture', ephemeral: false,
  historyMode: 'paginated', status: { type: 'notLoaded' }, turns: [] });
const storedTurn = (extra = {}) => ({ id: 'saved-turn', status: 'completed', itemsView: 'full', error: null,
  items: [{ type: 'agentMessage', id: 'message-1', text: 'Saved answer', phase: 'final_answer' }], ...extra });
function historyServer(pages, thread = storedThread(), options) {
  let page = 0;
  return fakeServer((message, peer) => {
    if (message.method === 'thread/read') peer.respond(message, { thread });
    else if (message.method === 'thread/turns/list') peer.respond(message, typeof pages === 'function' ? pages(page++) : pages[page++]);
    else assert.fail(`Read-only recovery sent ${message.method}`);
  }, options);
}
const historyOptions = (child, transport = {}) => ({ protocol: createCodexProtocol(child, { requestTimeoutMs: 100, closeTimeoutMs: 10, ...transport }),
  threadId: 'stored-thread', turnId: 'saved-turn', cwd: '/isolated/project', modelProvider: 'fixture' });

test('completed turn recovery only reads full paginated history and combines actual agent messages once', async () => {
  const first = { type: 'agentMessage', id: 'commentary', text: 'Earlier explanation', phase: 'commentary' };
  const final = { type: 'agentMessage', id: 'answer', text: 'Final answer', phase: 'final_answer' };
  const turn = storedTurn({ items: [
    { type: 'userMessage', id: 'user', content: [{ type: 'text', text: 'Stored task', text_elements: [] }] },
    { type: 'dynamicToolCall', id: 'tool', namespace: null, tool: 'project_read_file', arguments: { path: 'main.tex' },
      status: 'completed', success: true, contentItems: [{ type: 'inputText', text: 'fixture file result' }], durationMs: 3 },
    first, { ...first }, final
  ] });
  const child = historyServer([{ data: [storedTurn({ id: 'earlier-turn' })], nextCursor: 'next' }, { data: [turn], nextCursor: null }]);
  const options = historyOptions(child);
  try {
    assert.deepEqual(await readCodexCompletedTurn(options), { ok: true, finalResponse: 'Earlier explanation\nFinal answer',
      sessionId: 'stored-thread', patches: [], usage: undefined, output: { codex: { threadId: 'stored-thread', turnId: 'saved-turn' } } });
    assert.deepEqual(child.commands.map(command => command.method), ['thread/read', 'thread/turns/list', 'thread/turns/list']);
    assert.deepEqual(child.commands[0].params, { threadId: 'stored-thread', includeTurns: false });
    assert.equal(child.commands[1].params.itemsView, 'full'); assert.equal(child.commands[1].params.sortDirection, 'asc');
    assert.equal(child.commands[2].params.cursor, 'next'); assert.equal(child.exited, false);
  } finally { await options.protocol.close(); }
});

test('failed, interrupted and in-progress saved turns never become completed results', async () => {
  for (const [status, code] of [['failed', 'CODEX_AUTH_REQUIRED'], ['interrupted', 'CODEX_INTERRUPTED'], ['inProgress', 'CODEX_RECOVERY_NOT_TERMINAL']]) {
    const child = historyServer([{ data: [storedTurn({ status, itemsView: 'notLoaded', error: { codexErrorInfo: 'unauthorized', message: 'private credential detail' } })] }]);
    const options = historyOptions(child);
    try { await assert.rejects(readCodexCompletedTurn(options), reason => reason.code === code && !reason.message.includes('private credential')); }
    finally { await options.protocol.close(); }
    assert.ok(child.commands.every(command => ['thread/read', 'thread/turns/list'].includes(command.method)));
  }
});

test('stored thread, provider and workspace identity mismatches or malformed metadata fail closed', async () => {
  for (const [patch, code] of [[{ id: 'other-thread' }, 'CODEX_RECOVERY_IDENTITY_CONFLICT'], [{ cwd: '/other/project' }, 'CODEX_RECOVERY_IDENTITY_CONFLICT'],
    [{ modelProvider: 'other-provider' }, 'CODEX_RECOVERY_IDENTITY_CONFLICT'], [{ ephemeral: true }, 'CODEX_RECOVERY_IDENTITY_CONFLICT'],
    [{ status: { type: 'future-status' } }, 'CODEX_PROTOCOL_INVALID'], [{ turns: null }, 'CODEX_PROTOCOL_INVALID']]) {
    const child = historyServer([{ data: [storedTurn()] }], { ...storedThread(), ...patch }); const options = historyOptions(child);
    try { await assert.rejects(readCodexCompletedTurn(options), { code }); assert.equal(child.commands.length, 1); }
    finally { await options.protocol.close(); }
  }
  const child = historyServer([{ data: [storedTurn()] }]); const options = historyOptions(child);
  try { await assert.rejects(readCodexCompletedTurn({ ...options, cwd: '/isolated/../project' }), { code: 'CODEX_RECOVERY_INPUT_INVALID' }); assert.equal(child.commands.length, 0); }
  finally { await options.protocol.close(); }
});

test('missing saved turns, schema drift, summary payloads and conflicting duplicate items are unavailable', async () => {
  const cases = [
    [{ data: [storedTurn({ id: 'another-turn' })] }, 'CODEX_RECOVERY_TURN_MISSING'],
    [{ data: [storedTurn({ itemsView: 'summary' })] }, 'CODEX_PROTOCOL_INVALID'],
    [{ data: [storedTurn({ items: [{ type: 'future-message', id: 'new' }] })] }, 'CODEX_PROTOCOL_INVALID'],
    [{ data: [storedTurn({ items: [{ type: 'agentMessage', id: 'answer', text: 10 }] })] }, 'CODEX_PROTOCOL_INVALID'],
    [{ data: [storedTurn({ items: [] })] }, 'CODEX_RECOVERY_RESULT_UNAVAILABLE'],
    [{ data: [storedTurn({ items: [{ type: 'agentMessage', id: 'same', text: 'first' }, { type: 'agentMessage', id: 'same', text: 'changed' }] })] }, 'CODEX_RECOVERY_HISTORY_CONFLICT'],
    [{ data: [storedTurn({ status: 'future-terminal' })] }, 'CODEX_PROTOCOL_INVALID'],
    [{ data: [storedTurn({ status: 'failed', error: { message: 'private provider error', codexErrorInfo: 'private credential detail' } })] }, 'CODEX_PROTOCOL_INVALID'],
    [{ data: 'invalid' }, 'CODEX_PROTOCOL_INVALID']
  ];
  for (const [page, code] of cases) {
    const child = historyServer([page]); const options = historyOptions(child);
    try { await assert.rejects(readCodexCompletedTurn(options), { code }); }
    finally { await options.protocol.close(); }
  }
});

test('repeated cursors, changed duplicate turns and excessive pages cannot authorize recovery', async () => {
  const cases = [
    [[{ data: [storedTurn()], nextCursor: 'same' }, { data: [], nextCursor: 'same' }], 'CODEX_RECOVERY_HISTORY_CONFLICT'],
    [[{ data: [storedTurn()], nextCursor: 'next' }, { data: [storedTurn({ status: 'failed' })] }], 'CODEX_RECOVERY_HISTORY_CONFLICT'],
    [index => ({ data: [], nextCursor: `page-${index}` }), 'CODEX_RECOVERY_HISTORY_LIMIT']
  ];
  for (const [pages, code] of cases) {
    const child = historyServer(pages); const options = historyOptions(child);
    try { await assert.rejects(readCodexCompletedTurn(options), { code }); assert.ok(child.commands.length <= 33); }
    finally { await options.protocol.close(); }
  }
});

test('history recovery bounds UTF-8 agent output, item count and total history payload', async () => {
  const cases = [
    [[{ data: [storedTurn({ items: [{ type: 'agentMessage', id: 'large', text: '文'.repeat(350000) }] })] }], 'CODEX_OUTPUT_TOO_LARGE'],
    [[{ data: [storedTurn({ items: Array.from({ length: 257 }, (_, index) => ({ type: 'agentMessage', id: `item-${index}`, text: '' })) })] }], 'CODEX_RECOVERY_HISTORY_LIMIT'],
    [index => ({ data: [storedTurn({ id: index ? `other-${index}` : 'saved-turn', items: [{ type: 'userMessage', id: 'large', content: [{ type: 'text', text: 'x'.repeat(900000) }] }] })], nextCursor: `page-${index}` }), 'CODEX_RECOVERY_HISTORY_LIMIT']
  ];
  for (const [pages, code] of cases) {
    const child = historyServer(pages); const options = historyOptions(child, { maxLineBytes: 2000000 });
    try { await assert.rejects(readCodexCompletedTurn(options), { code }); }
    finally { await options.protocol.close(); }
  }
});
