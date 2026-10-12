import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDshFileBroker } from './dshFileBroker.js';
import { HarnessRuntimeError } from './errors.js';

export const DSH_VERSION = '0.2.0-rc.2';
export const DSH_PROVIDER = 'scienceprism-configured';
export const DSH_PRODUCT_TOOLS = Object.freeze(['project_read_file', 'project_propose_patch', 'research_delegate_codex']);
const error = (code, message) => new HarnessRuntimeError(503, code, message);

export async function loadVerifiedDshSdk(configuredEntry) {
  let entry;
  try {
    entry = configuredEntry || fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sdk-client'));
    if (!path.isAbsolute(entry)) throw new Error('SDK path must be absolute');
    entry = await realpath(entry);
    let directory = path.dirname(entry);
    let manifest;
    for (let index = 0; index < 5; index += 1) {
      try { manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')); break; } catch { directory = path.dirname(directory); }
    }
    if (manifest?.name !== '@deepseek-ai/dsh-sdk-client' || manifest.version !== DSH_VERSION) throw new Error('SDK version differs');
    const require = createRequire(path.join(directory, 'package.json'));
    const runtimeRequire = createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
    for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-sdk-minimal', '@deepseek-ai/dsh-llm-pi-ai']) {
      const info = JSON.parse(await readFile((name === '@deepseek-ai/dsh' ? require : runtimeRequire).resolve(`${name}/package.json`), 'utf8'));
      if (info.name !== name || info.version !== DSH_VERSION) throw new Error('Runtime package version differs');
    }
    return await import(pathToFileURL(entry).href);
  } catch { throw error('DSH_VERSION_UNAVAILABLE', `Configure the verified DeepSeek SDK/runtime/minimal profile ${DSH_VERSION}.`); }
}

export function delegateArguments(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['task', 'maxTokens', 'timeoutMs'].includes(key))
    || typeof input.task !== 'string' || !input.task.trim() || Buffer.byteLength(input.task) > 65_536
    || input.maxTokens !== undefined && (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 128 || input.maxTokens > 100_000)
    || input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 600_000)) throw error('DSH_ARGUMENTS_INVALID', 'Codex delegation accepts only a bounded task and optional smaller budgets.');
  return { task: input.task, ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }), ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) };
}

/** Private loopback bridge. Three product tools share one execution queue so
 * a delegated child cannot race parent file edits while its result is merged.
 */
export async function createDshProfile({ workspace, dshHome, provider, readPolicy, onDecision, delegateCodex, skillProjection, emit, signal, timeoutMs = 600_000 }) {
  if (provider) {
    let endpoint;
    try { endpoint = new URL(provider.baseUrl); } catch { throw error('DSH_PROVIDER_INVALID', 'An explicit compatible provider endpoint is required.'); }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['https:', 'http:'].includes(endpoint.protocol)
      || endpoint.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
      || typeof provider.model !== 'string' || !provider.model.trim() || provider.model.length > 200) throw error('DSH_PROVIDER_INVALID', 'The compatible provider endpoint or model is invalid.');
  }
  await mkdir(dshHome, { recursive: true, mode: 0o700 });
  const [home, project] = await Promise.all([realpath(dshHome), realpath(workspace)]);
  if (home === project || home.startsWith(`${project}${path.sep}`)) throw error('DSH_CONTROL_PATH_INVALID', 'DSH control files must be outside the project workspace.');
  const controls = await mkdtemp(path.join(home, 'product-policy-'));
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let broker;
  let queue = Promise.resolve();
  let resolveReady;
  let rejectReady;
  let isReady = false;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  const token = randomBytes(32).toString('hex');
  const sockets = new Set();
  let server;
  let closed;
  try {
    broker = await createDshFileBroker({ workspace: project, readPolicy, onDecision, skillProjection, emit, signal: combined });
    const ceiling = broker.ceiling;
    async function policy() {
      const value = await readPolicy();
      if (!value || ['projectId', 'runId', 'role', 'task'].some(key => value[key] !== ceiling[key]) || !['auto', 'manual'].includes(value.mode)
        || !['string', 'number'].includes(typeof value.version) || !Array.isArray(value.capabilities?.granted)) throw error('DSH_POLICY_UNAVAILABLE', 'The owning Run policy is unavailable.');
      return { ...value, active: value.active === true && ceiling.active && !combined.aborted,
        capabilities: { granted: value.capabilities.granted.filter(capability => ceiling.capabilities.granted.includes(capability)), allowedPaths: value.capabilities.allowedPaths || [], networkAllowlist: value.capabilities.networkAllowlist || [] } };
    }
    const authorizeDelegate = current => {
      if (!current.active || combined.aborted) throw error('DSH_RUN_INACTIVE', 'The owning Run is inactive.');
      if (current.mode !== 'auto' || ceiling.mode !== 'auto') throw error('DSH_APPROVAL_UNAVAILABLE', 'This delegation has no project tool authorization.');
      if (!current.capabilities.granted.includes('patch.propose') || typeof delegateCodex !== 'function') throw error('CAPABILITY_DENIED', 'Codex delegation is unavailable for this Run.');
    };
    async function execute(message) {
      if (message.tool !== 'research_delegate_codex') return broker.execute(message);
      let current;
      const record = (decision, reasonCode) => onDecision({ type: 'tool/policy', projectId: ceiling.projectId, runId: ceiling.runId, tool: message.tool, callId: message.callId,
        capability: 'patch.propose', actor: 'system', policyVersion: current?.version ?? ceiling.version, decision, ...(reasonCode ? { reasonCode } : {}) });
      try {
        const args = delegateArguments(message.arguments);
        current = await policy(); authorizeDelegate(current);
        await record('allow');
        const latest = await policy(); authorizeDelegate(latest);
        if (latest.version !== current.version) throw error('DSH_POLICY_CHANGED', 'The policy changed before Codex delegation.');
        // The parent callback performs the authoritative child-Run transaction
        // and rechecks current permissions immediately before child creation.
        return await delegateCodex(args, { signal: combined, callId: message.callId });
      } catch (reason) { await record('deny', reason.code || 'DSH_DELEGATE_FAILED'); throw reason; }
    }
    server = createServer(async (request, response) => {
      const supplied = Buffer.from(String(request.headers.authorization || ''));
      const expected = Buffer.from(`Bearer ${token}`);
      const reply = (status, value) => { if (!response.destroyed) response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value)); };
      if (request.method !== 'POST' || request.url !== '/bridge' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { request.resume(); reply(403, { error: 'DSH_BRIDGE_DENIED' }); return; }
      try {
        let size = 0;
        const chunks = [];
        for await (const chunk of request) { size += chunk.length; if (size > 2_097_152) throw error('DSH_MESSAGE_TOO_LARGE', 'Tool request is too large.'); chunks.push(chunk); }
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!message || typeof message !== 'object' || Array.isArray(message) || Object.keys(message).some(key => !['method', 'tool', 'callId', 'arguments', 'checks'].includes(key))) throw error('DSH_ARGUMENTS_INVALID', 'Invalid bridge request.');
        if (combined.aborted) throw error('DSH_CANCELLED', 'The Run was cancelled.');
        let result;
        if (message.method === 'ready') {
          if (isReady || JSON.stringify(message.checks) !== JSON.stringify({ version: DSH_VERSION, allowedBodyCalls: 1, denied: 7, tools: DSH_PRODUCT_TOOLS, ...(provider ? { provider: DSH_PROVIDER } : {}) })) throw error('DSH_HANDSHAKE_FAILED', 'DSH tool policy handshake failed.');
          isReady = true; resolveReady(); result = { ready: true };
        } else if (message.method === 'policy') result = await policy();
        else if (message.method === 'execute' && isReady && typeof message.callId === 'string' && message.callId && message.callId.length <= 200 && DSH_PRODUCT_TOOLS.includes(message.tool)) {
          const operation = queue.then(() => execute(message)); queue = operation.catch(() => {}); result = await operation;
        } else throw error('DSH_TOOL_NOT_BOUND', 'This tool is unavailable.');
        if (Buffer.byteLength(JSON.stringify(result)) > 1_048_576) throw error('DSH_OUTPUT_TOO_LARGE', 'Tool result is too large.');
        reply(200, { result });
      } catch (reason) { reply(403, { error: reason instanceof HarnessRuntimeError ? reason.code : 'DSH_BRIDGE_FAILED' }); }
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); if (sockets.size > 16) socket.destroy(); });
    server.headersTimeout = 5000;
    server.requestTimeout = 5000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const configPath = path.join(controls, 'bridge.json');
    await writeFile(configPath, JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}/bridge`, token, timeoutMs, ceiling, ...(provider ? { provider: DSH_PROVIDER } : {}) }), { mode: 0o600 });
    const patchPath = path.join(controls, 'profile.patch.yml');
    const pluginPath = fileURLToPath(new URL('./dshPolicyPlugin.js', import.meta.url));
    await writeFile(patchPath, JSON.stringify([
      ...['persistent-bash', 'persistent-pwsh', 'terminal-bash', 'terminal-pwsh', 'subprocess', 'pty', 'session-log-deepseek', 'plugin-package-inventory-deepseek', ...(provider ? ['llm-deepseek'] : [])].map(id => ({ id, disabled: true })),
      { id: 'sandbox-policy', config: { mode: 'read-only' } }, { id: 'tools', config: { mode: 'native' } },
      { insert: [
        ...(provider ? [{ id: 'scienceprism-compatible-provider', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { [DSH_PROVIDER]: {
          apiKeyEnv: 'SCIENCEPRISM_DSH_KEY', api: 'openai-completions', baseURL: provider.baseUrl, models: [{ id: provider.model, input: ['text'] }],
          compat: { supportsStore: false, supportsDeveloperRole: false }, timeoutMs, retryPolicy: { mode: 'normal', maxRetries: 0 }
        } } } }] : []),
        { id: 'scienceprism-product-policy', name: pluginPath, config: { configPath } }
      ] }
    ]), { mode: 0o600 });
    const abort = () => { rejectReady(error('DSH_CANCELLED', 'The Run was cancelled before readiness.')); for (const socket of sockets) socket.destroy(); };
    combined.addEventListener('abort', abort, { once: true });
    return {
      patchPath,
      async waitReady() {
        let timer;
        try { await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(error('DSH_HANDSHAKE_FAILED', 'DSH policy did not become ready before model execution.')), 15_000); })]); }
        finally { clearTimeout(timer); }
      },
      close() {
        if (closed) return closed;
        closed = (async () => { controller.abort(); await queue; await broker.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); combined.removeEventListener('abort', abort); await rm(controls, { recursive: true, force: true }); })();
        return closed;
      }
    };
  } catch (reason) {
    controller.abort(); for (const socket of sockets) socket.destroy(); if (server?.listening) await new Promise(resolve => server.close(resolve)); if (broker) await broker.close(); await rm(controls, { recursive: true, force: true }); throw reason;
  }
}
