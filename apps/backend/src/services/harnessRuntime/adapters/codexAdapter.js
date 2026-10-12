import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { HarnessRuntimeError } from '../errors.js';
import { createCodexProtocol } from './codexProtocol.js';

// This is the exact local schema/probe baseline, not a promise about newer CLI releases.
export const CODEX_PROTOCOL_VERSION = '0.162.0-alpha.17.2';
const PROBE_PROVIDER = 'scienceprism_protocol_probe';
const SANDBOX = Object.freeze({ type: 'readOnly', networkAccess: false });

function runtimeError(code, message, details) { return new HarnessRuntimeError(503, code, message, details); }

export function codexEnvironment(root) {
  const environment = {
    HOME: path.join(root, 'home'),
    CODEX_HOME: path.join(root, 'codex-home'),
    TMPDIR: path.join(root, 'tmp'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_DATA_HOME: path.join(root, 'data')
  };
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TZ']) if (process.env[name]) environment[name] = process.env[name];
  return environment;
}

function probeArguments() {
  // No credentials, real model endpoint, inherited MCP servers, or user auth stores.
  const config = [
    `model_provider="${PROBE_PROVIDER}"`, 'model="probe-no-model"',
    `model_providers.${PROBE_PROVIDER}.name="Protocol probe"`,
    `model_providers.${PROBE_PROVIDER}.base_url="http://127.0.0.1:9/v1"`,
    `model_providers.${PROBE_PROVIDER}.wire_api="responses"`,
    `model_providers.${PROBE_PROVIDER}.requires_openai_auth=false`,
    'cli_auth_credentials_store="file"', 'analytics.enabled=false',
    'web_search="disabled"', 'shell_environment_policy.inherit="none"',
    'mcp_servers={}', 'apps._default.enabled=false'
  ];
  return ['app-server', '--stdio', ...config.flatMap((entry) => ['-c', entry])];
}

export async function codexExecutableVersion(spawnProcess, executable, options, signal) {
  return new Promise((resolve, reject) => {
    let output = '';
    let failure;
    const child = spawnProcess(executable, ['--version'], options);
    const stop = () => { failure ||= runtimeError('CODEX_INTERRUPTED', 'Codex probe was interrupted.'); child.kill('SIGKILL'); };
    const timer = setTimeout(() => { failure = runtimeError('CODEX_VERSION_TIMEOUT', 'Codex version probe timed out.'); child.kill('SIGKILL'); }, 5_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; if (output.length > 4096) { failure = runtimeError('CODEX_PROTOCOL_INVALID', 'Codex version output is invalid.'); child.kill('SIGKILL'); } });
    child.stderr?.resume();
    child.on('error', () => { failure = runtimeError('CODEX_PROCESS_UNAVAILABLE', 'Configured Codex executable could not start.'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (failure) reject(failure);
      else if (code !== 0) reject(runtimeError('CODEX_PROCESS_UNAVAILABLE', 'Codex version probe failed.'));
      else {
        const version = output.trim().match(/^codex-cli ([0-9A-Za-z.+-]+)$/)?.[1];
        version ? resolve(version) : reject(runtimeError('CODEX_PROTOCOL_INVALID', 'Codex version output is invalid.'));
      }
    });
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
  });
}

/** Not registered as a runnable engine until A02 enforces the Project policy.
 * spawnProcess is a constructor dependency for deterministic protocol fixtures;
 * it is never accepted from a request, project configuration, or provider input.
 */
export function createCodexAdapter({ executable, expectedVersion = CODEX_PROTOCOL_VERSION, spawnProcess = spawn } = {}) {
  return Object.freeze({
    id: 'codex',
    label: 'Codex App Server (compatibility preview)',
    async probe({ runtimeHome, signal } = {}) {
      const result = {
        runtime: 'codex', available: false, version: null, protocolInitialized: false, modelTurns: 0,
        sandbox: { controlPassed: false, writeDenied: false },
        supportedCapabilities: [], blockers: []
      };
      let root;
      let protocol;
      let abort;
      let stopped = true;
      try {
        if (!executable || !path.isAbsolute(executable)) throw runtimeError('CODEX_EXECUTABLE_REQUIRED', 'Configure an absolute Codex executable path.');
        if (expectedVersion !== CODEX_PROTOCOL_VERSION) throw runtimeError('CODEX_VERSION_UNVERIFIED', 'This Codex protocol version has not been verified.', { expectedVersion });
        if (!runtimeHome || !path.isAbsolute(runtimeHome)) throw runtimeError('CODEX_HOME_REQUIRED', 'Codex probe needs an isolated runtime directory.');
        if (signal?.aborted) throw runtimeError('CODEX_INTERRUPTED', 'Codex probe was interrupted.');
        await mkdir(runtimeHome, { recursive: true });
        root = await mkdtemp(path.join(runtimeHome, 'codex-probe-'));
        const environment = codexEnvironment(root);
        const workspace = path.join(root, 'workspace');
        await Promise.all([workspace, ...Object.entries(environment).filter(([name]) => !['PATH', 'LANG', 'LC_ALL', 'TZ'].includes(name)).map(([, directory]) => directory)].map((directory) => mkdir(directory, { recursive: true })));
        const options = { cwd: workspace, env: environment, stdio: ['pipe', 'pipe', 'pipe'], shell: false };
        result.version = await codexExecutableVersion(spawnProcess, executable, options, signal);
        if (result.version !== expectedVersion) throw runtimeError('CODEX_VERSION_MISMATCH', 'Configured Codex version differs from the verified protocol baseline.', { expectedVersion, actualVersion: result.version });
        protocol = createCodexProtocol(spawnProcess(executable, probeArguments(), options));
        stopped = false;
        abort = () => { void protocol.close().catch(() => {}); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) throw runtimeError('CODEX_INTERRUPTED', 'Codex probe was interrupted.');
        await protocol.request('initialize', { clientInfo: { name: 'scienceprism_runtime_probe', version: '0.1.0' }, capabilities: { experimentalApi: false } });
        protocol.initialized();
        result.protocolInitialized = true;
        const mcp = await protocol.request('mcpServerStatus/list');
        if (!Array.isArray(mcp.data) || mcp.data.length || mcp.nextCursor) throw runtimeError('CODEX_EXTERNAL_TOOLS_ENABLED', 'Codex has external tools enabled in its isolated probe.');
        const thread = await protocol.request('thread/start', { cwd: workspace, model: 'probe-no-model', modelProvider: PROBE_PROVIDER, sandbox: 'read-only', approvalPolicy: 'untrusted', ephemeral: true });
        if (!thread.thread?.id) throw runtimeError('CODEX_PROTOCOL_INVALID', 'Codex did not return a probe thread id.');
        const control = await protocol.request('command/exec', { command: [process.execPath, '-e', 'process.stdout.write("scienceprism-sandbox-control")'], cwd: workspace, sandboxPolicy: SANDBOX, timeoutMs: 3_000 });
        result.sandbox.controlPassed = control.exitCode === 0 && control.stdout === 'scienceprism-sandbox-control';
        if (!result.sandbox.controlPassed) {
          const sandboxApplyDenied = /sandbox-exec: sandbox_apply: Operation not permitted/.test(String(control.stderr || ''));
          throw runtimeError('CODEX_SANDBOX_UNAVAILABLE', 'Codex sandbox control failed; no model turn was started.', { exitCode: control.exitCode, sandboxApplyDenied });
        }
        const deniedFile = path.join(workspace, 'must-not-be-written.txt');
        const denied = await protocol.request('command/exec', { command: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1],"must not exist")', deniedFile], cwd: workspace, sandboxPolicy: SANDBOX, timeoutMs: 3_000 });
        const exists = await readFile(deniedFile).then(() => true, (reason) => { if (reason.code === 'ENOENT') return false; throw reason; });
        result.sandbox.writeDenied = denied.exitCode !== 0 && !exists;
        if (!result.sandbox.writeDenied) throw runtimeError('CODEX_SANDBOX_UNENFORCED', 'Codex read-only sandbox did not deny the write probe.');
        // readOnly only restricts writes/network. It does not restrict reads to
        // contextPack/allowedPaths, and approval callbacks do not broker every tool.
        throw runtimeError('CAPABILITY_POLICY_UNENFORCEABLE', 'Codex needs a verified tool broker before it can enforce project file scope.');
      } catch (failure) {
        if (signal?.aborted || failure.code === 'CODEX_INTERRUPTED') throw runtimeError('CODEX_INTERRUPTED', 'Codex probe was interrupted.');
        result.blockers.push({ code: failure.code || 'CODEX_PROBE_FAILED', message: failure instanceof HarnessRuntimeError ? failure.message : 'Codex compatibility probe failed.', ...(failure.details ? { details: failure.details } : {}) });
      } finally {
        if (abort) signal?.removeEventListener('abort', abort);
        if (protocol) {
          try { await protocol.close(); stopped = true; }
          catch { result.blockers.push({ code: 'CODEX_STOP_FAILED', message: 'Codex did not exit. Its isolated directory was retained.' }); }
        }
        if (root && stopped) await rm(root, { recursive: true, force: true });
      }
      return result;
    },
    async run({ request = {}, capabilities = [], capabilityPolicy, runtimeHome, signal } = {}) {
      const granted = capabilityPolicy?.granted || capabilities;
      if (granted.some((capability) => capability !== 'project.read')) {
        throw new HarnessRuntimeError(403, 'CAPABILITY_POLICY_UNENFORCEABLE', 'Codex search, patch, and experiment tools require a verified broker.');
      }
      if (request.sessionId || request.threadId || request.resume) throw runtimeError('CODEX_RESUME_UNAVAILABLE', 'Codex replay/resume has not been verified; no prompt was replayed.');
      const availability = await this.probe({ runtimeHome, signal });
      const blocker = availability.blockers[0];
      throw runtimeError(blocker?.code || 'CAPABILITY_POLICY_UNENFORCEABLE', blocker?.message || 'Codex project policy enforcement is unavailable.', { availability });
    }
  });
}
