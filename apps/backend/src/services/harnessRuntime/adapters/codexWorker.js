import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { HarnessRuntimeError } from '../errors.js';
import { createDshFileBroker, DSH_FILE_TOOLS } from '../dshFileBroker.js';
import { CODEX_PROTOCOL_VERSION, codexEnvironment, codexExecutableVersion } from './codexAdapter.js';
import { createCodexProtocol, startCodexTurn, readCodexCompletedTurn } from './codexProtocol.js';
import { createCodexToolReceipts } from '../codexToolReceipts.js';

const PROFILE = 'scienceprism_worker';
const PROVIDER = 'scienceprism_worker_provider';
const IMPLEMENTATION_HASH = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
const error = (code, message) => new HarnessRuntimeError(503, code, message);
const DISABLED = ['apps', 'plugins', 'remote_plugin', 'multi_agent', 'hooks', 'shell_tool', 'unified_exec', 'shell_snapshot', 'code_mode', 'code_mode_host', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'image_generation', 'view_image', 'workspace_dependencies', 'goals', 'sleep_tool', 'skill_search'];

export const CODEX_WORKER_TOOLS = Object.freeze([
  { type: 'function', name: 'project_read_file', description: 'Read up to 1000 lines of a project text file. Returns its SHA256 for a later proposal. A missing file returns exists:false and sha256:null; propose a new file with expectedSha256:null.', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' }, fromLine: { type: 'integer', minimum: 1 }, toLine: { type: 'integer', minimum: 1 } } } },
  { type: 'function', name: 'project_propose_patch', description: 'Propose replacement text in the temporary project copy. Use the SHA256 from project_read_file, or null for a new file. This does not apply the change to the original project.', inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'content', 'expectedSha256'], properties: { path: { type: 'string' }, content: { type: 'string' }, expectedSha256: { type: ['string', 'null'] } } } }
]);

export function codexWorkerConfig({ provider, cwd, controlFile, maxTokens }) {
  let endpoint;
  try { endpoint = new URL(provider?.baseUrl); } catch { throw error('CODEX_PROVIDER_REQUIRED', 'Configure a Responses-compatible provider explicitly.'); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['https:', 'http:'].includes(endpoint.protocol)
    || endpoint.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    || typeof provider?.model !== 'string' || !provider.model.trim() || provider.model.length > 200
    || typeof provider.apiKey !== 'string' || !provider.apiKey) throw error('CODEX_PROVIDER_REQUIRED', 'Configure the model, endpoint and its own API credential explicitly.');
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 128 || maxTokens > 1_000_000) throw error('CODEX_BUDGET_REQUIRED', 'A bounded Codex token budget is required.');
  return [
    `model_provider=${JSON.stringify(PROVIDER)}`, `model=${JSON.stringify(provider.model)}`,
    `model_providers.${PROVIDER}.name="SciencePrism controlled worker"`, `model_providers.${PROVIDER}.base_url=${JSON.stringify(endpoint.href.replace(/\/$/, ''))}`,
    `model_providers.${PROVIDER}.wire_api="responses"`, `model_providers.${PROVIDER}.requires_openai_auth=false`,
    `model_providers.${PROVIDER}.env_key="SCIENCEPRISM_CODEX_WORKER_KEY"`, `model_providers.${PROVIDER}.supports_websockets=false`,
    `model_providers.${PROVIDER}.stream_max_retries=0`, `model_providers.${PROVIDER}.request_max_retries=0`,
    `default_permissions=${JSON.stringify(PROFILE)}`,
    `permissions={${PROFILE}={filesystem={":root"="deny",":minimal"="read",${JSON.stringify(controlFile)}="read"},network={enabled=false}}}`,
    `projects={${JSON.stringify(cwd)}={trust_level="untrusted"}}`, 'project_root_markers=[".scienceprism-worker-root"]',
    'cli_auth_credentials_store="file"', 'analytics.enabled=false', 'web_search="disabled"', 'shell_environment_policy.inherit="none"',
    'mcp_servers={}', 'apps._default.enabled=false', ...DISABLED.map(name => `features.${name}=false`),
    'features.skip_host_skill_discovery=true', 'project_doc_max_bytes=0', 'model_reasoning_effort="low"',
    `features.rollout_budget={enabled=true,limit_tokens=${maxTokens},reminder_at_remaining_tokens=[${Math.floor(maxTokens / 2)}]}`
  ];
}

/** Internal DSH worker. The parent owns Run identity, policy, budget and patches.
 * No public engine registration, user auth store, scheduling or alternate ledger.
 */
export function createCodexWorker({ executable, spawnProcess = spawn } = {}) {
  return Object.freeze({
    implementationHash: IMPLEMENTATION_HASH,
    async run({ provider, task, workspace, runtimeHome, parentRunId, readPolicy, onDecision, onSession, onStorage, onResult, skillProjection, emit = () => {}, signal, timeoutMs = 60_000, maxTokens = 4096 }) {
      if (!executable || !path.isAbsolute(executable)) throw error('CODEX_EXECUTABLE_REQUIRED', 'Configure an absolute Codex executable path.');
      if (typeof task !== 'string' || !task.trim() || Buffer.byteLength(task) > 262_144 || typeof onSession !== 'function'
        || typeof onStorage !== 'function' || typeof onResult !== 'function' || typeof parentRunId !== 'string' || !parentRunId) throw error('CODEX_WORKER_INPUT_INVALID', 'A bounded task, parent and durable worker callbacks are required.');
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) throw error('CODEX_BUDGET_REQUIRED', 'A bounded worker timeout is required.');
      if (!runtimeHome || !path.isAbsolute(runtimeHome)) throw error('CODEX_HOME_REQUIRED', 'A private runtime directory is required.');
      await mkdir(runtimeHome, { recursive: true, mode: 0o700 });
      const [home, project] = await Promise.all([realpath(runtimeHome), realpath(workspace)]);
      if (home !== path.resolve(runtimeHome) || home === project || home.startsWith(`${project}${path.sep}`)) throw error('CODEX_HOME_REQUIRED', 'Worker controls must be outside the model project workspace.');
      const root = await mkdtemp(path.join(home, 'codex-worker-'));
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let broker;
      let protocol;
      let stopped = true;
      let resolveIdentity;
      const identityReady = new Promise(resolve => { resolveIdentity = resolve; });
      let identity;
      let receipts;
      let terminalStatus = 'failed';
      let storage = { format: 'scienceprism-codex-worker-v1', root: path.relative(home, root), implementationHash: IMPLEMENTATION_HASH,
        protocolVersion: CODEX_PROTOCOL_VERSION, historyMode: 'paginated', phase: 'prepared', pid: null, stopConfirmed: false, threadId: null, turnId: null };
      const saveStorage = async patch => { storage = { ...storage, ...patch }; await onStorage(structuredClone(storage)); };
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        if (combined.aborted) throw error('CODEX_INTERRUPTED', 'The worker was cancelled before starting.');
        await saveStorage({});
        const env = codexEnvironment(root);
        const cwd = path.join(root, 'empty');
        await Promise.all([cwd, ...['HOME', 'CODEX_HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME'].map(key => env[key])].map(directory => mkdir(directory, { recursive: true, mode: 0o700 })));
        const controlFile = path.join(root, 'control.txt');
        const excludedFile = path.join(root, 'excluded.txt');
        await Promise.all([writeFile(controlFile, 'scienceprism-worker-control'), writeFile(excludedFile, 'must-not-read'), writeFile(path.join(cwd, '.scienceprism-worker-root'), '')]);
        const config = codexWorkerConfig({ provider, cwd, controlFile, maxTokens });
        env.SCIENCEPRISM_CODEX_WORKER_KEY = provider.apiKey;
        env.NO_PROXY = '127.0.0.1,localhost,::1';
        env.no_proxy = env.NO_PROXY;
        const options = { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false };
        if (await codexExecutableVersion(spawnProcess, executable, options, combined) !== CODEX_PROTOCOL_VERSION) throw error('CODEX_VERSION_MISMATCH', 'Codex differs from the verified worker protocol version.');
        broker = await createDshFileBroker({ workspace: project, readPolicy, onDecision, skillProjection, emit, signal: combined });
        const dynamicTools = CODEX_WORKER_TOOLS.filter(tool => broker.ceiling.capabilities.granted.includes(DSH_FILE_TOOLS[tool.name]));
        const toolSchemaHash = createHash('sha256').update(JSON.stringify(dynamicTools)).digest('hex');
        const child = spawnProcess(executable, ['app-server', '--stdio', '--strict-config', ...config.flatMap(value => ['-c', value])], options);
        stopped = false;
        protocol = createCodexProtocol(child, { onToolCall: async (call, toolSignal) => {
          const abort = () => controller.abort();
          toolSignal.addEventListener('abort', abort, { once: true });
          try {
            if (toolSignal.aborted || combined.aborted) throw error('CODEX_INTERRUPTED', 'The worker was cancelled.');
            let wake;
            try { await Promise.race([identityReady, new Promise(resolve => { wake = resolve; toolSignal.addEventListener('abort', wake, { once: true }); })]); }
            finally { toolSignal.removeEventListener('abort', wake); }
            if (toolSignal.aborted || combined.aborted || !identity || call.threadId !== identity.threadId || call.turnId !== identity.turnId || call.namespace
              || !Object.hasOwn(DSH_FILE_TOOLS, call.tool)) throw error('CODEX_TOOL_DENIED', 'The tool does not belong to this controlled worker.');
            const event = { name: call.tool, callId: call.callId };
            emit({ type: 'tool/start', data: { ...event, arguments: call.arguments } });
            try {
              const result = await receipts.execute({ threadId: call.threadId, turnId: call.turnId, tool: call.tool, callId: call.callId, arguments: call.arguments },
                { signal: combined, executeTool: value => broker.execute({ tool: value.tool, callId: value.callId, arguments: value.arguments }) });
              emit({ type: 'tool/end', data: { ...event, output: result } });
              return result;
            } catch (reason) {
              if (reason instanceof HarnessRuntimeError && reason.code === 'CODEX_RECEIPT_FILE_NOT_FOUND' && call.tool === 'project_read_file'
                && !toolSignal.aborted && !combined.aborted) {
                const result = { path: call.arguments.path, exists: false, sha256: null, code: 'PROJECT_FILE_NOT_FOUND' };
                emit({ type: 'tool/end', data: { ...event, output: result } });
                return result;
              }
              emit({ type: 'tool/error', data: { ...event, error: { code: reason instanceof HarnessRuntimeError ? reason.code : 'CODEX_TOOL_FAILED', message: 'The controlled project tool could not complete.' } } });
              throw reason;
            }
          } finally { toolSignal.removeEventListener('abort', abort); }
        } });
        await saveStorage({ phase: 'running', pid: Number.isSafeInteger(child.pid) ? child.pid : null, toolsHash: toolSchemaHash,
          binding: { projectId: broker.ceiling.projectId, runId: broker.ceiling.runId, parentRunId, role: broker.ceiling.role,
            task: broker.ceiling.task, policyVersion: broker.ceiling.version } });
        await protocol.request('initialize', { clientInfo: { name: 'scienceprism_codex_worker', version: '0.1.0' }, capabilities: { experimentalApi: true } });
        protocol.initialized();
        const mcp = await protocol.request('mcpServerStatus/list');
        if (!Array.isArray(mcp.data) || mcp.data.length || mcp.nextCursor) throw error('CODEX_EXTERNAL_TOOLS_ENABLED', 'Unexpected external tools are configured.');
        for (const [file, allowed] of [[controlFile, true], [excludedFile, false]]) {
          const result = await protocol.request('command/exec', { command: ['/bin/cat', file], cwd, permissionProfile: PROFILE, timeoutMs: 3000 });
          if (allowed ? result.exitCode !== 0 || result.stdout !== 'scienceprism-worker-control' : result.exitCode === 0 || result.stdout) throw error('CODEX_SANDBOX_UNAVAILABLE', 'Codex could not enforce the required read scope.');
        }
        const denied = await protocol.request('command/exec', { command: ['/bin/sh', '-c', 'printf changed > "$1"', 'sh', controlFile], cwd, permissionProfile: PROFILE, timeoutMs: 3000 });
        if (denied.exitCode === 0 || await readFile(controlFile, 'utf8') !== 'scienceprism-worker-control') throw error('CODEX_SANDBOX_UNENFORCED', 'Codex did not enforce read-only controls.');
        // Policy + owner binding are rechecked in the broker for every actual
        // operation. No project files are exposed to Codex's built-in tools.
        emit({ type: 'codex/worker-started', data: { runtime: 'codex', protocolVersion: CODEX_PROTOCOL_VERSION, tools: Object.keys(DSH_FILE_TOOLS) } });
        const result = await startCodexTurn({ protocol, request: task, workspace: cwd, provider: { id: PROVIDER, model: provider.model }, signal: combined, emit, permissions: PROFILE,
          dynamicTools, timeoutMs, maxTokens,
          onSession: async value => {
            await saveStorage(value);
            await onSession(value);
            if (value.turnId) {
              receipts = await createCodexToolReceipts({ directory: path.join(root, 'receipts'), workspace: project, skillProjection, readPolicy, onDecision,
                binding: { projectId: broker.ceiling.projectId, parentRunId, workerRunId: broker.ceiling.runId, ...value,
                  workerVersion: `${CODEX_PROTOCOL_VERSION}:${IMPLEMENTATION_HASH}`, toolSchemaHash, policyVersion: broker.ceiling.version, role: broker.ceiling.role, task: broker.ceiling.task } });
              identity = value; resolveIdentity();
            }
          }
        });
        terminalStatus = 'completed';
        await onResult(result);
        return result;
      } finally {
        clearTimeout(timer);
        const interrupted = signal?.aborted;
        controller.abort();
        resolveIdentity();
        let cleanupError;
        try { if (protocol) await protocol.close(); stopped = true; } catch (reason) { cleanupError = reason; }
        try { if (broker) await broker.close(); } catch (reason) { cleanupError ||= reason; }
        // A storage failure must never hide an unconfirmed process stop.
        try { await saveStorage({ phase: stopped ? 'stopped' : 'stop-unconfirmed', stopConfirmed: stopped,
          terminalStatus: interrupted && terminalStatus !== 'completed' ? 'cancelled' : terminalStatus }); }
        catch (reason) { cleanupError ||= reason; }
        if (cleanupError) throw cleanupError;
      }
    },
    /** Only a current retained-Run owner may inspect an already stopped worker.
     * This path cannot resume a thread, start a turn, or execute project tools. */
    async readResult({ provider, runtimeHome, storage, readPolicy, assertOwnership, onStorage, signal, maxTokens = 4096 }) {
      if (!executable || !path.isAbsolute(executable)) throw error('CODEX_EXECUTABLE_REQUIRED', 'Configure an absolute Codex executable path.');
      if (typeof assertOwnership !== 'function' || typeof onStorage !== 'function' || typeof readPolicy !== 'function') throw error('CODEX_RECOVERY_OWNER_REQUIRED', 'A retained Run owner and current policy are required.');
      await assertOwnership();
      if (!storage || storage.format !== 'scienceprism-codex-worker-v1' || storage.implementationHash !== IMPLEMENTATION_HASH
        || storage.protocolVersion !== CODEX_PROTOCOL_VERSION || !/^codex-worker-[a-zA-Z0-9-]+$/.test(storage.root || '')
        || !storage.threadId || !storage.turnId || storage.stopConfirmed !== true) throw error('CODEX_RECOVERY_INVALID', 'The saved worker version or stopping evidence is invalid.');
      if (storage.pid !== null) {
        if (!Number.isSafeInteger(storage.pid) || storage.pid < 1) throw error('CODEX_RECOVERY_INVALID', 'The saved process identity is invalid.');
        let dead = false; try { process.kill(storage.pid, 0); } catch (reason) { dead = reason.code === 'ESRCH'; }
        if (!dead) throw error('CODEX_RECOVERY_OWNER_ACTIVE', 'The earlier worker process has not been confirmed stopped.');
      }
      const policy = await readPolicy();
      if (!policy?.active || !storage.binding || ['projectId', 'runId', 'role', 'task'].some(key => policy[key] !== storage.binding[key])
        || policy.version !== storage.binding.policyVersion || !policy.capabilities?.granted.includes('project.read')) throw error('CODEX_RECOVERY_POLICY_DENIED', 'The current Run does not permit reading this worker result.');
      const tools = CODEX_WORKER_TOOLS.filter(tool => policy.capabilities.granted.includes(DSH_FILE_TOOLS[tool.name]));
      if (createHash('sha256').update(JSON.stringify(tools)).digest('hex') !== storage.toolsHash) throw error('CODEX_RECOVERY_VERSION_CONFLICT', 'The saved worker tool schema differs from the current scope.');
      const home = await realpath(runtimeHome);
      if (home !== path.resolve(runtimeHome)) throw error('CODEX_RECOVERY_INVALID', 'Worker controls cannot use aliased paths.');
      const root = path.join(home, storage.root), cwd = path.join(root, 'empty'), controlFile = path.join(root, 'control.txt');
      for (const directory of [root, cwd]) {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory || (stat.mode & 0o777) !== 0o700) throw error('CODEX_RECOVERY_INVALID', 'The private worker directories changed.');
      }
      const stat = await lstat(controlFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 27 || await readFile(controlFile, 'utf8') !== 'scienceprism-worker-control') throw error('CODEX_RECOVERY_INVALID', 'The private worker control file changed.');
      const config = codexWorkerConfig({ provider, cwd, controlFile, maxTokens });
      const env = codexEnvironment(root); env.SCIENCEPRISM_CODEX_WORKER_KEY = provider.apiKey; env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost,::1';
      const options = { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false };
      let protocol, stopped = true, inspectionPid = storage.pid;
      const abortInspection = () => { if (protocol) void protocol.close().catch(() => {}); };
      try {
        if (signal?.aborted) throw error('CODEX_INTERRUPTED', 'Worker inspection was cancelled.');
        if (await codexExecutableVersion(spawnProcess, executable, options, signal) !== CODEX_PROTOCOL_VERSION) throw error('CODEX_VERSION_MISMATCH', 'Codex differs from the verified worker protocol version.');
        await assertOwnership();
        const child = spawnProcess(executable, ['app-server', '--stdio', '--strict-config', ...config.flatMap(value => ['-c', value])], options);
        stopped = false; protocol = createCodexProtocol(child); inspectionPid = Number.isSafeInteger(child.pid) ? child.pid : null;
        signal?.addEventListener('abort', abortInspection, { once: true });
        await onStorage({ ...storage, phase: 'running', stopConfirmed: false, pid: inspectionPid });
        await protocol.request('initialize', { clientInfo: { name: 'scienceprism_codex_worker_reader', version: '0.1.0' }, capabilities: { experimentalApi: true } }); protocol.initialized();
        const result = await readCodexCompletedTurn({ protocol, threadId: storage.threadId, turnId: storage.turnId, cwd, modelProvider: PROVIDER });
        if (signal?.aborted) throw error('CODEX_INTERRUPTED', 'Worker inspection was cancelled.');
        await assertOwnership();
        return result;
      } finally {
        signal?.removeEventListener('abort', abortInspection);
        let cleanupError;
        try { if (protocol) await protocol.close(); stopped = true; } catch (reason) { cleanupError = reason; }
        try { await onStorage({ ...storage, pid: inspectionPid, phase: stopped ? 'stopped' : 'stop-unconfirmed', stopConfirmed: stopped }); }
        catch (reason) { cleanupError ||= reason; }
        if (cleanupError) throw cleanupError;
      }
    }
  });
}
