import { HarnessRuntimeError } from '../errors.js';
import { createHash } from 'node:crypto';
import path from 'node:path';

const METHODS = new Set(['initialize', 'thread/start', 'thread/read', 'thread/turns/list', 'turn/start', 'turn/interrupt', 'command/exec', 'mcpServerStatus/list']);
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

/** Read a saved terminal result without loading/resuming a thread or starting work.
 * The caller initializes/closes the protocol and proves exclusive process ownership.
 * Thread status is only metadata; idle/notLoaded cannot prove an old owner stopped.
 */
export async function readCodexCompletedTurn({ protocol, threadId, turnId, cwd, modelProvider } = {}) {
  const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const invalid = () => { throw error('CODEX_PROTOCOL_INVALID', 'The saved Codex history does not match the verified protocol.'); };
  const fingerprint = value => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
    object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex');
  if (typeof protocol?.request !== 'function' || !identifier(threadId) || !identifier(turnId)
    || typeof cwd !== 'string' || !path.isAbsolute(cwd) || path.resolve(cwd) !== cwd || /[\x00-\x1f\x7f]/.test(cwd)
    || modelProvider !== undefined && !identifier(modelProvider)) throw error('CODEX_RECOVERY_INPUT_INVALID', 'A saved thread, turn and normalized workspace identity are required.');
  let bytes = 0;
  const account = value => {
    let serialized;
    try { serialized = JSON.stringify(value); } catch { invalid(); }
    if (typeof serialized !== 'string') invalid();
    bytes += Buffer.byteLength(serialized);
    if (bytes > 4_194_304) throw error('CODEX_RECOVERY_HISTORY_LIMIT', 'Saved Codex history exceeded its recovery byte limit.');
  };
  const response = await protocol.request('thread/read', { threadId, includeTurns: false });
  account(response);
  const thread = response?.thread;
  if (!object(thread) || !identifier(thread.id) || typeof thread.cwd !== 'string' || typeof thread.modelProvider !== 'string'
    || typeof thread.ephemeral !== 'boolean' || !Array.isArray(thread.turns) || !object(thread.status)
    || !['idle', 'notLoaded', 'active', 'systemError'].includes(thread.status.type)
    || thread.status.type === 'active' && (!Array.isArray(thread.status.activeFlags) || thread.status.activeFlags.some(flag => typeof flag !== 'string'))) invalid();
  if (thread.id !== threadId || thread.cwd !== cwd || thread.ephemeral || modelProvider !== undefined && thread.modelProvider !== modelProvider) {
    throw error('CODEX_RECOVERY_IDENTITY_CONFLICT', 'The saved Codex thread belongs to a different worker identity.');
  }
  const cursors = new Set(), turns = new Map();
  let cursor, saved, totalItems = 0;
  for (let page = 0; page < 32; page++) {
    const history = await protocol.request('thread/turns/list', { threadId, itemsView: 'full', sortDirection: 'asc', limit: 50, ...(cursor ? { cursor } : {}) });
    account(history);
    if (!object(history) || !Array.isArray(history.data) || history.data.length > 50
      || history.nextCursor !== undefined && history.nextCursor !== null && (typeof history.nextCursor !== 'string' || !history.nextCursor || history.nextCursor.length > 2048)) invalid();
    for (const turn of history.data) {
      if (!object(turn) || !identifier(turn.id) || !['completed', 'failed', 'interrupted', 'inProgress'].includes(turn.status)
        || !Array.isArray(turn.items) || !['full', 'summary', 'notLoaded'].includes(turn.itemsView)) invalid();
      const hash = fingerprint(turn), previous = turns.get(turn.id);
      if (previous && previous !== hash) throw error('CODEX_RECOVERY_HISTORY_CONFLICT', 'A saved Codex turn changed across history pages.');
      turns.set(turn.id, hash);
      totalItems += turn.items.length;
      if (totalItems > 4096) throw error('CODEX_RECOVERY_HISTORY_LIMIT', 'Saved Codex history exceeded its item limit.');
      if (turn.id === turnId) saved = turn;
    }
    if (history.nextCursor == null) break;
    if (cursors.has(history.nextCursor)) throw error('CODEX_RECOVERY_HISTORY_CONFLICT', 'Saved Codex history repeated a pagination cursor.');
    cursors.add(history.nextCursor); cursor = history.nextCursor;
    if (page === 31) throw error('CODEX_RECOVERY_HISTORY_LIMIT', 'Saved Codex history exceeded its page limit.');
  }
  if (!saved) throw error('CODEX_RECOVERY_TURN_MISSING', 'The recorded Codex turn is absent; its task will not be restarted.');
  if (saved.status === 'failed') {
    if (!object(saved.error) || typeof saved.error.message !== 'string') invalid();
    const info = saved.error.codexErrorInfo;
    if (typeof info === 'string') {
      if (!['contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'rateLimitExceeded', 'flexUnavailable', 'serverOverloaded',
        'cyberPolicy', 'misalignmentPolicyViolation', 'tooManyDenials', 'internalServerError', 'unauthorized', 'badRequest', 'threadRollbackFailed', 'sandboxError', 'other'].includes(info)) invalid();
    } else if (info != null) {
      if (!object(info) || Object.keys(info).length !== 1 || !['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected',
        'responseTooManyFailedAttempts', 'activeTurnNotSteerable'].includes(Object.keys(info)[0])) invalid();
    }
    throw codexFailure(saved.error);
  }
  if (saved.status === 'interrupted') throw new HarnessRuntimeError(409, 'CODEX_INTERRUPTED', 'The saved Codex turn was interrupted.');
  if (saved.status !== 'completed') throw new HarnessRuntimeError(409, 'CODEX_RECOVERY_NOT_TERMINAL', 'The recorded Codex turn is still in progress; history is not proof that its owner stopped.');
  if (saved.itemsView !== 'full' || saved.error != null) invalid();
  if (saved.items.length > 256) throw error('CODEX_RECOVERY_HISTORY_LIMIT', 'The saved Codex turn exceeded its item limit.');
  const items = new Map(), messages = [];
  let outputBytes = 0;
  for (const item of saved.items) {
    if (!object(item) || !identifier(item.id)) invalid();
    switch (item.type) {
      case 'agentMessage': case 'plan':
        if (typeof item.text !== 'string') invalid();
        break;
      case 'userMessage':
        if (!Array.isArray(item.content) || item.content.some(input => !object(input) || input.type !== 'text' || typeof input.text !== 'string')) invalid();
        break;
      case 'reasoning':
        if (['summary', 'content'].some(key => item[key] !== undefined && (!Array.isArray(item[key]) || item[key].some(line => typeof line !== 'string')))) invalid();
        break;
      case 'dynamicToolCall':
        if (!identifier(item.tool) || !Object.hasOwn(item, 'arguments') || !['completed', 'failed'].includes(item.status)) invalid();
        break;
      case 'functionCallOutput':
        if (!identifier(item.name) || !Object.hasOwn(item, 'output')) invalid();
        break;
      case 'contextCompaction': break;
      default: invalid();
    }
    const hash = fingerprint(item), previous = items.get(item.id);
    if (previous) {
      if (previous !== hash) throw error('CODEX_RECOVERY_HISTORY_CONFLICT', 'A saved Codex item identity has conflicting content.');
      continue;
    }
    items.set(item.id, hash);
    if (item.type === 'agentMessage') {
      outputBytes += Buffer.byteLength(item.text) + (messages.length ? 1 : 0);
      if (outputBytes > 1_048_576) throw error('CODEX_OUTPUT_TOO_LARGE', 'Saved Codex output exceeded its byte limit.');
      messages.push(item.text);
    }
  }
  if (!messages.length) throw error('CODEX_RECOVERY_RESULT_UNAVAILABLE', 'The completed Codex turn has no recoverable agent message.');
  return { ok: true, finalResponse: messages.join('\n'), sessionId: threadId, patches: [], usage: undefined, output: { codex: { threadId, turnId } } };
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
  const toolCalls = new Map();
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
    const bytes = Buffer.byteLength(line);
    if (bytes > maxLineBytes) throw error('CODEX_MESSAGE_TOO_LARGE', 'Codex protocol message exceeds the size limit.');
    if (child.stdin.writableLength + bytes > 4_194_304) throw error('CODEX_TRANSPORT_OVERFLOW', 'Codex input stream exceeded its pending write limit.');
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
        if (toolAbort.signal.aborted || typeof callId !== 'string' || !callId || callId.length > 200 || toolTasks.size >= 8) {
          denyRequest(message);
          for (const listener of listeners) listener({ ...message, sequence, denied: true });
          return;
        }
        // Bind cached results to all original parameters, including thread/turn.
        // JSON key order can change in transit without changing the request.
        const fingerprint = createHash('sha256').update(JSON.stringify(message.params, (_key, value) =>
          value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)).digest('hex');
        const previous = toolCalls.get(callId);
        if (previous ? previous.fingerprint !== fingerprint : toolCalls.size >= 128) {
          denyRequest(message);
          for (const listener of listeners) listener({ ...message, sequence, denied: true });
          return;
        }
        const sourceSequence = sequence;
        const operation = previous?.operation || Promise.resolve().then(async () => {
          try {
            if (toolAbort.signal.aborted) throw new Error('Tool cancelled.');
            const value = await onToolCall(message.params, toolAbort.signal);
            const text = JSON.stringify(value);
            if (toolAbort.signal.aborted || Buffer.byteLength(text) > 262_144) throw new Error('Tool response unavailable.');
            return { success: true, contentItems: [{ type: 'inputText', text }] };
          } catch { return { success: false, contentItems: [{ type: 'inputText', text: 'The project tool request was denied or could not complete.' }] }; }
        });
        if (!previous) toolCalls.set(callId, { fingerprint, operation });
        const task = (async () => {
          const result = await operation;
          if (closed || terminalError || toolAbort.signal.aborted) return;
          send({ id: message.id, result });
          // One execution event; retransmissions only receive its same result.
          if (!previous) for (const listener of listeners) listener({ ...message, sequence: sourceSequence, denied: !result.success });
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
    const started = await protocol.request('thread/start', { cwd: workspace, model: provider.model, modelProvider: provider.id, ...controlled, ephemeral: false, historyMode: 'paginated' });
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
