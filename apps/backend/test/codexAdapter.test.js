import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCodexAdapter, CODEX_PROTOCOL_VERSION } from '../src/services/harnessRuntime/adapters/codexAdapter.js';
import { createCodexProtocol, startCodexTurn, codexFailure } from '../src/services/harnessRuntime/adapters/codexProtocol.js';

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
  assert.equal(calls, 1);
  assert.equal(child.commands.find(command => command.id === 92).result.success, false);
  assert.equal(child.commands.some(command => command.id === 91), false);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(child.commands.find(command => command.id === 91).result.success, true);
  await protocol.close();
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
  const controlled = createCodexProtocol(pending, { onToolCall: async (_params, signal) => new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve({ cancelled: true }); }, { once: true })) });
  pending.stdout.write(`${JSON.stringify({ id: 2, method: 'item/tool/call', params: { callId: 'pending' } })}\n`);
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
