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

async function macSandboxCommand(workspaceRoot, entrypoint, args) {
  const sandboxExecutable = '/usr/bin/sandbox-exec';
  try {
    await fs.access(sandboxExecutable);
  } catch {
    throw new ExperimentRunnerError(503, 'EXPERIMENT_SANDBOX_UNAVAILABLE', 'macOS sandbox-exec is unavailable; the Experiment Run was not started.');
  }
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
  return { executable: sandboxExecutable, args: ['-p', profile, process.execPath, entrypoint, ...args] };
}

async function isolatedCommand(workspaceRoot, entrypoint, args) {
  if (process.platform === 'darwin') return macSandboxCommand(workspaceRoot, entrypoint, args);
  throw new ExperimentRunnerError(503, 'EXPERIMENT_SANDBOX_UNAVAILABLE', `No supported Experiment Runner sandbox is available on ${process.platform}.`);
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
  return result;
}

export async function runFakeExperiment(manifest, { inputPath } = {}) {
  const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  return {
    exitCode: 0,
    signal: null,
    stdout: `fake experiment ${manifest.id}\n`,
    stderr: '',
    metrics: input.fakeMetrics || [{ name: 'completed', value: 1 }]
  };
}

export const experimentAdapters = Object.freeze({ node: runNodeExperiment, fake: runFakeExperiment });
