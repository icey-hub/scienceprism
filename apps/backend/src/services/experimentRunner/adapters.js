import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ExperimentRunnerError } from './errors.js';

function safeEnvironment(runId, inputPath, workspaceRoot) {
  const environment = {};
  for (const key of ['PATH', 'NODE_PATH']) if (process.env[key]) environment[key] = process.env[key];
  environment.HOME = path.join(workspaceRoot, '.experiment-home');
  environment.TMPDIR = path.join(workspaceRoot, '.experiment-tmp');
  environment.SCIENCEPRISM_EXPERIMENT_RUN_ID = runId;
  environment.SCIENCEPRISM_EXPERIMENT_INPUT = inputPath;
  return environment;
}

function sandboxLiteral(value) {
  return JSON.stringify(value);
}

function sandboxPathFilters(paths) {
  const filters = new Set();
  for (const allowedPath of paths) {
    let current = path.resolve(allowedPath);
    filters.add(`(literal ${sandboxLiteral(current)})`);
    filters.add(`(subpath ${sandboxLiteral(current)})`);
    while (current !== path.dirname(current)) {
      current = path.dirname(current);
      filters.add(`(literal ${sandboxLiteral(current)})`);
    }
  }
  return [...filters];
}

const sandboxExecutable = '/usr/bin/sandbox-exec';
let sandboxApplicability = null;

// Existence of sandbox-exec does not mean it can apply a sandbox: under an outer
// sandbox (containers, CI, agent harnesses) sandbox_apply is denied at runtime.
// Probe once per process so the run fails with a diagnosable code instead of exit 71.
function probeSandboxApplicability() {
  if (!sandboxApplicability) {
    sandboxApplicability = new Promise((resolve) => {
      const probe = spawn(sandboxExecutable, ['-p', '(version 1)(allow default)', process.execPath, '-e', ''], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      probe.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      probe.once('error', (error) => resolve({ ok: false, reason: error.message }));
      probe.once('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, reason: stderr.trim().split('\n')[0] || `sandbox-exec exited with code ${code}` }));
    });
  }
  return sandboxApplicability;
}

function isSandboxApplyFailure(stderr) {
  return /^sandbox-exec:|sandbox_apply/m.test(String(stderr || ''));
}

async function macSandboxApplicability() {
  try {
    await fs.access(sandboxExecutable);
  } catch {
    return { ok: false, reason: 'macOS sandbox-exec is unavailable' };
  }
  return probeSandboxApplicability();
}

/**
 * Reports whether an OS-level sandbox can actually be applied on this host, so
 * callers can surface isolation readiness without starting a Run.
 */
export async function isOsSandboxApplicable() {
  if (process.platform !== 'darwin') return { ok: false, reason: `no OS sandbox is implemented for ${process.platform}` };
  return macSandboxApplicability();
}

function supportsNodePermissionModel() {
  return typeof process.allowedNodeEnvironmentFlags?.has === 'function'
    && process.allowedNodeEnvironmentFlags.has('--permission');
}

/**
 * Second isolation strategy: Node's own permission model.
 *
 * macOS sandbox-exec cannot apply inside an outer sandbox (containers, CI,
 * nested agent sandboxes), which made the Experiment Runner unusable there even
 * though the Run was fully approved. The permission model is a weaker boundary
 * than an OS sandbox -- it gates Node's own file, child-process, worker, and
 * network APIs rather than arbitrary native code -- so every Run records which
 * strategy it actually used (`execution.isolation`) instead of treating the two
 * as equivalent.
 *
 * Paths are passed as realpaths: grants match literal paths, so a symlinked
 * ancestor (for example /tmp -> /private/tmp) would otherwise be denied while
 * Node resolves the entrypoint.
 */
export async function nodePermissionCommand(workspaceRoot, entrypoint, args) {
  const workspaceRealPath = await fs.realpath(workspaceRoot);
  const entrypointRealPath = await fs.realpath(entrypoint);
  return {
    executable: process.execPath,
    args: [
      '--permission',
      `--allow-fs-read=${workspaceRealPath}`,
      `--allow-fs-write=${workspaceRealPath}`,
      entrypointRealPath,
      ...args
    ],
    isolation: 'node-permission'
  };
}

async function macSandboxCommand(workspaceRoot, entrypoint, args) {
  const nodeRealPath = await fs.realpath(process.execPath);
  const workspaceRealPath = await fs.realpath(workspaceRoot);
  const nodeRuntimeRoot = path.dirname(path.dirname(nodeRealPath));
  const cellarMarker = `${path.sep}Cellar${path.sep}`;
  const cellarIndex = nodeRealPath.indexOf(cellarMarker);
  const packageManagerPaths = cellarIndex >= 0
    ? [nodeRealPath.slice(0, cellarIndex)]
    : [];
  const readablePaths = [
    workspaceRoot,
    workspaceRealPath,
    nodeRuntimeRoot,
    ...packageManagerPaths,
    '/System/Library',
    '/usr/lib',
    '/usr/share/locale',
    '/private/var/db/timezone',
    '/etc/localtime',
    '/dev/null',
    '/dev/random',
    '/dev/urandom'
  ];
  const readableFilter = `(require-any ${sandboxPathFilters(readablePaths).join(' ')})`;
  const writableFilter = `(require-any ${(workspaceRoot === workspaceRealPath ? [workspaceRoot] : [workspaceRoot, workspaceRealPath]).map((allowedPath) => `(subpath ${sandboxLiteral(allowedPath)})`).join(' ')})`;
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    `(deny file-read* (require-not ${readableFilter}))`,
    `(deny file-write* (require-not ${writableFilter}))`
  ].join('\n');
  return { executable: sandboxExecutable, args: ['-p', profile, process.execPath, entrypoint, ...args], isolation: 'macos-sandbox-exec' };
}

/**
 * Picks the strongest isolation this host can actually enforce, and reports
 * which one it chose. Order matters: the OS sandbox is preferred, the Node
 * permission model is the portable fallback, and an unenforceable request
 * fails closed instead of running without isolation.
 */
export function chooseIsolationStrategy({ platform = process.platform, osSandboxApplicable = false, nodePermissionSupported = false } = {}) {
  if (platform === 'darwin' && osSandboxApplicable) return 'macos-sandbox-exec';
  if (nodePermissionSupported) return 'node-permission';
  return null;
}

async function isolatedCommand(workspaceRoot, entrypoint, args) {
  const applicability = process.platform === 'darwin' ? await macSandboxApplicability() : { ok: false, reason: `no OS sandbox is implemented for ${process.platform}` };
  const strategy = chooseIsolationStrategy({
    osSandboxApplicable: applicability.ok,
    nodePermissionSupported: supportsNodePermissionModel()
  });
  if (strategy === 'macos-sandbox-exec') return macSandboxCommand(workspaceRoot, entrypoint, args);
  if (strategy === 'node-permission') return nodePermissionCommand(workspaceRoot, entrypoint, args);
  throw new ExperimentRunnerError(503, 'EXPERIMENT_SANDBOX_UNAVAILABLE', `No enforceable Experiment Runner sandbox is available (${applicability.reason}; node permission model unsupported); the Experiment Run was not started.`);
}

export async function runNodeExperiment(manifest, { workspaceRoot, inputPath, signal, onOutput } = {}) {
  const entrypoint = path.resolve(workspaceRoot, manifest.command.entrypoint);
  const workspaceRealPath = await fs.realpath(workspaceRoot);
  const entrypointRealPath = await fs.realpath(entrypoint).catch(() => null);
  if (!entrypointRealPath || (entrypointRealPath !== workspaceRealPath && !entrypointRealPath.startsWith(`${workspaceRealPath}${path.sep}`))) {
    throw new ExperimentRunnerError(403, 'EXECUTION_PATH_DENIED', 'The experiment entrypoint must remain inside the isolated workspace.');
  }
  await fs.mkdir(path.join(workspaceRoot, '.experiment-home'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, '.experiment-tmp'), { recursive: true });
  const command = await isolatedCommand(workspaceRoot, entrypoint, manifest.command.args);
  const child = spawn(command.executable, command.args, {
    cwd: workspaceRoot,
    env: safeEnvironment(manifest.id, inputPath, workspaceRoot),
    shell: false,
    windowsHide: true,
    signal
  });
  let stdout = '';
  let stderr = '';
  let bytes = 0;
  const append = (target, chunk) => {
    const value = chunk.toString();
    bytes += Buffer.byteLength(value);
    if (bytes > manifest.resources.maxOutputBytes) {
      child.kill('SIGTERM');
      throw new ExperimentRunnerError(413, 'OUTPUT_LIMIT_EXCEEDED', 'Experiment output exceeded its configured limit.');
    }
    if (target === 'stdout') stdout += value;
    else stderr += value;
    onOutput?.({ stream: target, text: value });
  };
  child.stdout.on('data', (chunk) => {
    try { append('stdout', chunk); } catch (error) { child.emit('error', error); }
  });
  child.stderr.on('data', (chunk) => {
    try { append('stderr', chunk); } catch (error) { child.emit('error', error); }
  });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, closeSignal) => resolve({ exitCode, signal: closeSignal, stdout, stderr }));
  });
  if (result.exitCode !== 0 && isSandboxApplyFailure(result.stderr)) {
    throw new ExperimentRunnerError(503, 'EXPERIMENT_SANDBOX_UNAVAILABLE', `macOS sandbox-exec could not apply the run profile (${String(result.stderr).trim().split('\n')[0]}); the Experiment Run did not execute.`);
  }
  return { ...result, isolation: command.isolation };
}

export async function runFakeExperiment(manifest, { inputPath } = {}) {
  const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  return {
    exitCode: 0,
    signal: null,
    stdout: `fake experiment ${manifest.id}\n`,
    stderr: '',
    isolation: 'in-process',
    metrics: input.fakeMetrics || [{ name: 'completed', value: 1 }]
  };
}

export const experimentAdapters = Object.freeze({ node: runNodeExperiment, fake: runFakeExperiment });
