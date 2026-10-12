import { HarnessRuntimeError } from '../errors.js';

const METHODS = new Set(['initialize', 'thread/start', 'turn/start', 'turn/interrupt', 'command/exec', 'mcpServerStatus/list']);
const idPresent = (message) => Object.hasOwn(message, 'id');
const error = (code, message, details, retryable = false) => new HarnessRuntimeError(502, code, message, details, { retryable });

export function codexFailure(value = {}) {
  const info = value.codexErrorInfo;
  const code = typeof info === 'string' ? info : Object.keys(info || {})[0];
  const status = typeof info === 'object' && info ? Object.values(info).find((item) => item?.httpStatusCode)?.httpStatusCode : null;
  if (code === 'unauthorized' || status === 401 || status === 403) {
    return new HarnessRuntimeError(401, 'CODEX_AUTH_REQUIRED', 'Codex provider authentication failed. Configure this runtime provider explicitly.');
  }
  if (code === 'sandboxError') return error('CODEX_SANDBOX_UNAVAILABLE', 'Codex could not enforce its sandbox.');
  if (code === 'rateLimitExceeded' || code === 'usageLimitExceeded' || status === 429) {
    return error('CODEX_PROVIDER_LIMIT', 'Codex provider limit reached.', { reason: code || 'http429' }, true);
  }
  // Provider messages can echo credentials or whole prompts. Keep them out of the Run error.
  return error('CODEX_TURN_FAILED', 'Codex turn failed.', { reason: typeof code === 'string' ? code : 'unknown' });
}

/** Bounded NDJSON transport. It owns one child, not a Run or a task queue. */
export function createCodexProtocol(child, { requestTimeoutMs = 15_000, closeTimeoutMs = 1_000, maxLineBytes = 1_048_576, onToolCall } = {}) {
  let nextId = 0;
  let sequence = 0;
  let buffer = '';
  let terminalError;
  let closed = false;
  let closing;
  const pending = new Map();
  const listeners = new Set();
  const failures = new Set();
  const toolCalls = new Set();
  const toolTasks = new Set();
  const toolAbort = new AbortController();
  let resolveExit;
  const exit = new Promise((resolve) => { resolveExit = resolve; });

  function fail(reason) {
    if (terminalError) return;
    terminalError = reason;
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(reason); }
    pending.clear();
    for (const listener of failures) listener(reason);
  }

  function send(message) {
    if (closed || terminalError) throw terminalError || error('CODEX_PROCESS_CLOSED', 'Codex process is closed.');
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > maxLineBytes) throw error('CODEX_MESSAGE_TOO_LARGE', 'Codex protocol message exceeds the size limit.');
    child.stdin.write(line, (failure) => { if (failure) fail(error('CODEX_PROCESS_CLOSED', 'Codex input stream closed.')); });
  }

  function denyRequest(message) {
    let result;
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) result = { decision: 'decline' };
    else if (message.method === 'item/permissions/requestApproval') result = { permissions: {}, scope: 'turn' };
    else if (message.method === 'item/tool/call') result = { contentItems: [{ type: 'inputText', text: 'Runtime tool capability is unavailable.' }], success: false };
    else if (message.method === 'mcpServer/elicitation/request') result = { action: 'decline', content: null };
    send(result ? { id: message.id, result } : { id: message.id, error: { code: -32601, message: 'This runtime does not support server requests.' } });
  }

  function receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { fail(error('CODEX_PROTOCOL_INVALID', 'Codex emitted invalid NDJSON.')); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { fail(error('CODEX_PROTOCOL_INVALID', 'Codex emitted an invalid message.')); return; }
    sequence += 1;
    if (idPresent(message) && typeof message.method === 'string') {
      if (message.method === 'item/tool/call' && typeof onToolCall === 'function') {
        const callId = message.params?.callId;
        if (typeof callId !== 'string' || !callId || toolCalls.has(callId) || toolCalls.size >= 128 || toolTasks.size >= 8) {
          denyRequest(message);
          for (const listener of listeners) listener({ ...message, sequence, denied: true });
          return;
        }
        toolCalls.add(callId);
        const sourceSequence = sequence;
        const task = (async () => {
          let result;
          try {
            const value = await onToolCall(message.params, toolAbort.signal);
            const text = JSON.stringify(value);
            if (toolAbort.signal.aborted || Buffer.byteLength(text) > 262_144) throw new Error('Tool response unavailable.');
            result = { success: true, contentItems: [{ type: 'inputText', text }] };
          } catch { result = { success: false, contentItems: [{ type: 'inputText', text: 'The project tool request was denied or could not complete.' }] }; }
          if (closed || terminalError || toolAbort.signal.aborted) return;
          send({ id: message.id, result });
          for (const listener of listeners) listener({ ...message, sequence: sourceSequence, denied: !result.success });
        })();
        toolTasks.add(task);
        void task.catch(reason => fail(reason)).finally(() => toolTasks.delete(task));
        return;
      }
      denyRequest(message);
      for (const listener of listeners) listener({ ...message, sequence, denied: true });
    } else if (idPresent(message)) {
      const call = pending.get(message.id);
      if (!call) return; // Duplicate/stale response: never resend the original command.
      pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) {
        const unsupported = message.error.code === -32601;
        if (message.error.code === 401 || message.error.code === 403 || message.error.data?.codexErrorInfo === 'unauthorized') call.reject(codexFailure({ codexErrorInfo: 'unauthorized' }));
        else call.reject(error(unsupported ? 'CODEX_METHOD_UNSUPPORTED' : 'CODEX_REQUEST_FAILED', `Codex rejected ${call.method}.`, { method: call.method, protocolCode: message.error.code }));
      } else if (Object.hasOwn(message, 'result')) call.resolve(message.result);
      else call.reject(error('CODEX_PROTOCOL_INVALID', 'Codex response lacks a result or error.'));
    } else if (typeof message.method === 'string') {
      for (const listener of listeners) listener({ ...message, sequence });
    } else fail(error('CODEX_PROTOCOL_INVALID', 'Codex message lacks a method or id.'));
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (terminalError) return;
    buffer += chunk;
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > maxLineBytes) { fail(error('CODEX_MESSAGE_TOO_LARGE', 'Codex protocol message exceeds the size limit.')); return; }
      if (line.trim()) {
        try { receive(line); } catch { fail(error('CODEX_PROTOCOL_INVALID', 'Codex message handler failed.')); }
      }
      if (terminalError) return;
    }
    if (Buffer.byteLength(buffer) > maxLineBytes) fail(error('CODEX_MESSAGE_TOO_LARGE', 'Codex protocol message exceeds the size limit.'));
  });
  // Drain diagnostics without retaining possible provider credentials or unlimited stderr.
  child.stderr?.resume();
  child.stdin.on('error', () => fail(error('CODEX_PROCESS_CLOSED', 'Codex input stream closed.')));
  child.on('error', () => fail(error('CODEX_PROCESS_UNAVAILABLE', 'Configured Codex executable could not start.')));
  child.on('close', (exitCode, signal) => {
    closed = true;
    fail(error('CODEX_PROCESS_CLOSED', 'Codex process exited before completion.', { exitCode, signal }));
    resolveExit();
  });

  return {
    request(method, params = {}, { timeoutMs = requestTimeoutMs } = {}) {
      if (!METHODS.has(method)) return Promise.reject(error('CODEX_METHOD_UNSUPPORTED', `Codex method is unsupported: ${method}.`, { method }));
      if (pending.size >= 32) return Promise.reject(error('CODEX_PROTOCOL_BUSY', 'Too many pending Codex protocol requests.'));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(error('CODEX_REQUEST_TIMEOUT', `Codex ${method} timed out.`, { method }, true)); }, Math.max(1, Math.min(timeoutMs, 60_000)));
        pending.set(id, { resolve, reject, timer, method });
        try { send({ id, method, params }); } catch (reason) { clearTimeout(timer); pending.delete(id); reject(reason); }
      });
    },
    initialized() { send({ method: 'initialized', params: {} }); },
    subscribe(listener, onFailure) {
      listeners.add(listener);
      if (onFailure) failures.add(onFailure);
      if (terminalError && onFailure) onFailure(terminalError);
      return () => { listeners.delete(listener); failures.delete(onFailure); };
    },
    close() {
      if (closing) return closing;
      closing = (async () => {
        toolAbort.abort();
        if (!closed) child.stdin.end();
        const wait = async () => {
          let timer;
          const done = await Promise.race([exit.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), closeTimeoutMs); })]);
          clearTimeout(timer);
          return done;
        };
        if (!closed && !(await wait())) {
          child.kill('SIGTERM');
          if (!(await wait())) {
            child.kill('SIGKILL');
            if (!(await wait())) throw error('CODEX_STOP_FAILED', 'Codex process did not exit after termination. Workspace must be retained.');
          }
        }
        let timer;
        const drained = await Promise.race([Promise.allSettled([...toolTasks]).then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), closeTimeoutMs); })]);
        clearTimeout(timer);
        if (!drained) throw error('CODEX_STOP_FAILED', 'A project tool has not stopped. Workspace must be retained.');
      })();
      return closing;
    }
  };
}

/** Protocol state machine only. A caller must enforce isolation before invoking it.
 * The production adapter deliberately cannot enter this path until a broker exists.
 */
export async function startCodexTurn({ protocol, request, workspace, provider, signal, emit = () => {}, onSession, timeoutMs = 60_000, interruptTimeoutMs = 1_000, permissions, dynamicTools, maxTokens }) {
  if (typeof onSession !== 'function') {
    await protocol.close();
    throw error('CODEX_SESSION_PERSISTENCE_REQUIRED', 'A Run identity persistence callback is required.');
  }
  let threadId;
  let turnId;
  let settled = false;
  let interrupting;
  let usage;
  let lastError;
  const messages = new Map();
  let resolveTurn;
  let rejectTurn;
  const terminal = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  terminal.catch(() => {});
  const finish = (reason, value) => { if (settled) return; settled = true; reason ? rejectTurn(reason) : resolveTurn(value); };
  const interrupted = () => new HarnessRuntimeError(409, 'CODEX_INTERRUPTED', 'Codex turn was interrupted.');
  const stop = () => {
    if (interrupting || settled) return;
    interrupting = (async () => {
      if (threadId && turnId) await protocol.request('turn/interrupt', { threadId, turnId }, { timeoutMs: interruptTimeoutMs }).catch(() => {});
      // The protocol acknowledgement is not a terminal Run status.
      let timer;
      await Promise.race([terminal.catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, interruptTimeoutMs); })]);
      clearTimeout(timer);
      finish(interrupted());
      await protocol.close();
    })();
    interrupting.catch((reason) => finish(reason));
  };
  const unsubscribe = protocol.subscribe((message) => {
    const p = message.params || {};
    if (threadId && p.threadId && p.threadId !== threadId) return;
    if (turnId && p.turnId && p.turnId !== turnId) return;
    if (p.turn?.id && turnId && p.turn.id !== turnId) return;
    if (message.method === 'turn/started' && p.turn?.id) turnId ||= p.turn.id;
    const event = { type: 'codex/notification', data: { method: message.method, threadId: p.threadId || threadId, turnId: p.turnId || p.turn?.id || turnId, itemId: p.itemId || p.item?.id, sourceSequence: message.sequence, denied: Boolean(message.denied) } };
    if (message.method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
      const existing = messages.get(p.itemId) || { text: '', complete: false };
      if (!existing.complete) existing.text += p.delta;
      if (existing.text.length > 1_048_576) { finish(error('CODEX_OUTPUT_TOO_LARGE', 'Codex response exceeded the output limit.')); return; }
      messages.set(p.itemId, existing);
      event.data.text = p.delta;
    }
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage') messages.set(p.item.id, { text: String(p.item.text || ''), complete: true });
    if (messages.size > 256 || [...messages.values()].reduce((total, message) => total + message.text.length, 0) > 1_048_576) { finish(error('CODEX_OUTPUT_TOO_LARGE', 'Codex response exceeds the output limit.')); return; }
    if (message.method === 'thread/tokenUsage/updated') {
      usage = p.tokenUsage?.total || p.tokenUsage?.last;
      event.data.usage = usage;
      if (Number.isSafeInteger(maxTokens) && Number(usage?.totalTokens) >= maxTokens) {
        emit(event);
        finish(error('CODEX_BUDGET_EXHAUSTED', 'Codex reached the Run token budget.', { usage }));
        void protocol.close().catch(() => {});
        return;
      }
    }
    if (message.method === 'error') lastError = p.error;
    emit(event);
    if (message.denied) { finish(signal?.aborted ? interrupted() : error('CAPABILITY_POLICY_UNENFORCEABLE', 'Codex requested a tool or approval outside the controlled runtime contract.')); stop(); }
    if (message.method === 'turn/completed') {
      const status = p.turn?.status;
      if (signal?.aborted || status === 'interrupted') finish(interrupted());
      else if (status === 'failed') finish(codexFailure(p.turn.error || lastError));
      else if (status === 'completed') finish(null, p.turn);
      else finish(error('CODEX_PROTOCOL_INVALID', 'Codex reported an invalid terminal turn status.'));
    }
  }, (reason) => finish(reason));
  const timer = setTimeout(() => { finish(error('CODEX_TURN_TIMEOUT', 'Codex turn exceeded the runtime time limit.', undefined, true)); void protocol.close().catch(() => {}); }, timeoutMs);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    if (signal?.aborted) throw interrupted();
    const controlled = permissions ? { permissions, environments: [], dynamicTools: dynamicTools || [], approvalPolicy: 'never' } : { sandbox: 'read-only', approvalPolicy: 'untrusted' };
    const started = await protocol.request('thread/start', { cwd: workspace, model: provider.model, modelProvider: provider.id, ...controlled, ephemeral: false });
    threadId = started.thread?.id;
    if (typeof threadId !== 'string' || !threadId) throw error('CODEX_PROTOCOL_INVALID', 'Codex did not return a thread id.');
    await onSession({ threadId, turnId: null });
    if (signal?.aborted) throw interrupted();
    const turnPolicy = permissions ? { permissions, environments: [], approvalPolicy: 'never' } : { sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'untrusted' };
    const turn = await protocol.request('turn/start', { threadId, input: [{ type: 'text', text: request }], ...turnPolicy });
    turnId ||= turn.turn?.id;
    if (typeof turnId !== 'string' || !turnId) throw error('CODEX_PROTOCOL_INVALID', 'Codex did not return a turn id.');
    await onSession({ threadId, turnId });
    if (signal?.aborted) stop();
    await terminal;
    const finalResponse = [...messages.values()].map((message) => message.text).join('\n');
    return { ok: true, finalResponse, sessionId: threadId, patches: [], usage, output: { codex: { threadId, turnId } } };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    unsubscribe();
    await protocol.close();
    await interrupting;
  }
}
